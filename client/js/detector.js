import { DETECTION, MARKERS, PAPER } from './config.js';
import { toLuminance, otsu, motionBetween, createCanvas, context2d } from './imaging.js';
import { labelComponents } from './components.js';
import { orderCorners, polygonArea, distance } from './geometry.js';

/**
 * Watches the live camera for the printed sheet and decides when it has been
 * still long enough to capture.
 *
 * The sheet is found by the four QR blocks at its corners rather than by its
 * brightness, so it works on any table surface, including a white one. The
 * codes are never decoded - only their positions matter.
 *
 * States:
 *   idle      - no sheet under the camera
 *   settling  - sheet seen, waiting for it to stop moving
 *   ready     - fire a capture (the caller then calls hold())
 *   holding   - captured; waiting for the sheet to be taken away
 *   cooldown  - sheet gone, brief pause before re-arming
 *
 * The holding state is what prevents duplicate captures: once a sheet has been
 * photographed, nothing else can trigger until it leaves the frame.
 */
export class PaperScanner {
  constructor(config = DETECTION, markerConfig = MARKERS) {
    this.config = config;
    this.markers = markerConfig;
    this.canvas = null;
    this.ctx = null;
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.previousLuma = null;
    this.previousCorners = null;
    this.stableSince = 0;
    this.absentFrames = 0;
    this.cooldownUntil = 0;
    this.lastAnalysedAt = 0;
  }

  /** Called after a capture, to lock out further captures until the sheet leaves. */
  hold() {
    this.state = 'holding';
    this.absentFrames = 0;
    this.stableSince = 0;
  }

  ensureCanvas(video) {
    const width = this.config.sampleWidth;
    const height = Math.max(
      1,
      Math.round((video.videoHeight / video.videoWidth) * width) || Math.round(width * 0.5625)
    );

    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = createCanvas(width, height);
      this.ctx = context2d(this.canvas);
      this.previousLuma = null;
    }
  }

  /**
   * Analyses one frame.
   *
   * @param {HTMLVideoElement} video
   * @param {number} now performance.now()
   * @returns {{state: string, progress: number, quad: object[]|null,
   *            insetRatio: {x:number,y:number}|null, found: boolean}}
   */
  update(video, now) {
    const blank = {
      state: this.state,
      progress: 0,
      quad: null,
      insetRatio: null,
      found: false,
    };

    if (!video.videoWidth || !video.videoHeight) return blank;

    // Rate-limit analysis; the render loop runs faster than we need to think.
    if (now - this.lastAnalysedAt < this.config.analyseIntervalMs) {
      return { ...blank, progress: this.progress(now) };
    }
    this.lastAnalysedAt = now;

    this.ensureCanvas(video);

    const { width, height } = this.canvas;
    this.ctx.drawImage(video, 0, 0, width, height);
    const frame = this.ctx.getImageData(0, 0, width, height);
    const luma = toLuminance(frame);

    const sheet = this.findSheet(luma, width, height);
    const motion = motionBetween(luma, this.previousLuma);
    this.previousLuma = luma;

    // --- post-capture lockout -------------------------------------------------
    if (this.state === 'holding') {
      if (!sheet) {
        this.absentFrames += 1;
        if (this.absentFrames >= this.config.removalFrames) {
          this.state = 'cooldown';
          this.cooldownUntil = now + this.config.cooldownMs;
        }
      } else {
        this.absentFrames = 0;
      }
      return { ...blank, state: this.state, found: Boolean(sheet) };
    }

    if (this.state === 'cooldown') {
      if (now >= this.cooldownUntil) {
        this.state = 'idle';
        this.previousCorners = null;
      }
      return { ...blank, state: this.state, found: Boolean(sheet) };
    }

    // --- scanning -------------------------------------------------------------
    if (!sheet) {
      this.state = 'idle';
      this.stableSince = 0;
      this.previousCorners = null;
      return { ...blank, state: 'idle' };
    }

    const drift = this.previousCorners
      ? Math.max(...sheet.quad.map((c, i) => distance(c, this.previousCorners[i])))
      : Infinity;
    this.previousCorners = sheet.quad;

    const still = motion < this.config.motionThreshold && drift < this.config.cornerJitter;

    const reading = {
      quad: sheet.quad,
      insetRatio: sheet.insetRatio,
      found: true,
    };

    if (!still) {
      this.state = 'settling';
      this.stableSince = 0;
      return { ...reading, state: 'settling', progress: 0 };
    }

    if (!this.stableSince) this.stableSince = now;

    const held = now - this.stableSince;
    if (held >= this.config.stableMs) {
      this.state = 'ready';
      return { ...reading, state: 'ready', progress: 1 };
    }

    this.state = 'settling';
    return { ...reading, state: 'settling', progress: held / this.config.stableMs };
  }

  progress(now) {
    if (this.state !== 'settling' || !this.stableSince) return 0;
    return Math.min(1, (now - this.stableSince) / this.config.stableMs);
  }

  /**
   * Locates the sheet and returns its corners as an ordered quad, plus how much
   * of the rectified page to trim off each edge. Null when nothing is there.
   */
  findSheet(luma, width, height) {
    return this.config.mode === 'markers'
      ? this.findByMarkers(luma, width, height)
      : this.findByPaper(luma, width, height);
  }

  /**
   * A plain white sheet against a darker surface.
   *
   * The paper is the brightest large region in frame, so its own edges are the
   * boundary - which is why something dark has to be under it. Corners come
   * from the extreme points of the bright region, and the checks below reject
   * anything that is bright but not sheet-shaped: a hand, glare, a light patch
   * of table.
   */
  findByPaper(luma, width, height) {
    const { threshold, darkMean, brightMean } = otsu(luma);

    // Not enough separation between sheet and surface. On a pale table this is
    // where detection stops, every time.
    if (brightMean - darkMean < PAPER.minContrast) return null;

    let brightCount = 0;
    const points = [];

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (luma[y * width + x] > threshold) {
          brightCount += 1;
          points.push({ x, y });
        }
      }
    }

    const coverage = brightCount / (width * height);
    if (coverage < PAPER.minCoverage || coverage > PAPER.maxCoverage) return null;
    if (points.length < 4) return null;

    const quad = cornersOf(points);
    if (!quad) return null;

    // Every edge of the sheet has to be inside the frame. Without this, a pale
    // table makes the bright region the whole view, and the entire camera
    // frame gets cropped as though it were the paper.
    const marginX = width * PAPER.minFrameMargin;
    const marginY = height * PAPER.minFrameMargin;
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);

    if (Math.min(...xs) < marginX || Math.max(...xs) > width - 1 - marginX) return null;
    if (Math.min(...ys) < marginY || Math.max(...ys) > height - 1 - marginY) return null;

    // A sheet fills its own bounding quad; an irregular bright blob does not.
    const area = polygonArea(quad);
    if (area <= 0 || brightCount / area < PAPER.minQuadFill) return null;
    if (!edgesLookRectangular(quad, PAPER.minEdgeRatio)) return null;

    return {
      quad,
      // A fixed trim: enough to lose the paper's edge, its shadow and any curl.
      insetRatio: { x: PAPER.cropInsetRatio, y: PAPER.cropInsetRatio },
    };
  }

  /**
   * The printed template: four QR blocks, one at each corner. Their centres
   * form a true rectangle on the sheet, so the correction is exact.
   */
  findByMarkers(luma, width, height) {
    const cfg = this.markers;
    const { threshold, darkMean, brightMean } = otsu(luma);

    // A flat scene (covered lens, blank table) produces a threshold too;
    // without real contrast there is nothing to find.
    if (brightMean - darkMean < 25) return null;

    const mask = new Uint8Array(width * height);
    for (let i = 0; i < luma.length; i += 1) {
      if (luma[i] <= threshold) mask[i] = 1;
    }

    const { components } = labelComponents(mask, width, height);
    const frameArea = width * height;

    const candidates = components.filter((c) => {
      const areaRatio = c.area / frameArea;
      if (areaRatio < cfg.minAreaRatio || areaRatio > cfg.maxAreaRatio) return false;

      // Roughly square.
      const skew = c.boxWidth / c.boxHeight;
      if (skew > cfg.maxAspectSkew || skew < 1 / cfg.maxAspectSkew) return false;

      // Roughly half filled - a QR block, not a solid blob or a thin stroke.
      const fill = c.area / (c.boxWidth * c.boxHeight);
      return fill >= cfg.minFill && fill <= cfg.maxFill;
    });

    if (candidates.length < 4) return null;

    const chosen = pickCornerMarkers(candidates);
    if (!chosen) return null;

    const quad = orderCorners(chosen.map((c) => c.centroid));

    // The markers must actually span the sheet, not cluster in one spot.
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const spanX = (Math.max(...xs) - Math.min(...xs)) / width;
    const spanY = (Math.max(...ys) - Math.min(...ys)) / height;
    if (spanX < cfg.minSpanRatio || spanY < cfg.minSpanRatio) return null;

    // Opposite edges of a rectangle stay comparable under perspective.
    const top = distance(quad[0], quad[1]);
    const bottom = distance(quad[3], quad[2]);
    const left = distance(quad[0], quad[3]);
    const right = distance(quad[1], quad[2]);
    if (Math.min(top, bottom) / Math.max(top, bottom) < 0.55) return null;
    if (Math.min(left, right) / Math.max(left, right) < 0.55) return null;

    // Reject a collapsed quad: the four centres should enclose real area.
    const area = polygonArea(quad);
    const bboxArea = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (!bboxArea || area / bboxArea < 0.5) return null;

    const markerSize =
      chosen.reduce((sum, c) => sum + Math.max(c.boxWidth, c.boxHeight), 0) / chosen.length;

    // The page corners land on the marker centres, so exactly half a marker
    // pokes in at each corner. Expressed as a fraction of each axis, that is
    // how much has to be trimmed to be rid of them.
    const horizontal = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
    const vertical = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;

    return {
      quad,
      insetRatio: {
        x: (0.5 * markerSize) / horizontal * MARKERS.maskScale + MARKERS.cropGapRatio,
        y: (0.5 * markerSize) / vertical * MARKERS.maskScale + MARKERS.cropGapRatio,
      },
    };
  }
}

/**
 * Corners of a point cloud as [topLeft, topRight, bottomRight, bottomLeft].
 * The extremes of x+y and x-y pick out the corners of a quadrilateral.
 */
function cornersOf(points) {
  let minSum = points[0];
  let maxSum = points[0];
  let minDiff = points[0];
  let maxDiff = points[0];

  for (const p of points) {
    if (p.x + p.y < minSum.x + minSum.y) minSum = p;
    if (p.x + p.y > maxSum.x + maxSum.y) maxSum = p;
    if (p.x - p.y < minDiff.x - minDiff.y) minDiff = p;
    if (p.x - p.y > maxDiff.x - maxDiff.y) maxDiff = p;
  }

  const corners = orderCorners([minSum, maxDiff, maxSum, minDiff]);
  const unique = new Set(corners.map((c) => `${c.x},${c.y}`));

  // Fewer than four distinct corners means the region is a line, not a sheet.
  return unique.size === 4 ? corners : null;
}

/** Opposite edges of a rectangle stay comparable in length under perspective. */
function edgesLookRectangular(quad, minRatio) {
  const top = distance(quad[0], quad[1]);
  const bottom = distance(quad[3], quad[2]);
  const left = distance(quad[0], quad[3]);
  const right = distance(quad[1], quad[2]);

  if (Math.min(top, bottom) / Math.max(top, bottom) < minRatio) return false;
  return Math.min(left, right) / Math.max(left, right) >= minRatio;
}

/**
 * Picks the four candidates furthest towards each corner of the group. Returns
 * null if the same component wins more than one corner, which means the
 * candidates are not arranged as a rectangle.
 */
function pickCornerMarkers(candidates) {
  const score = {
    tl: (p) => p.x + p.y,
    br: (p) => -(p.x + p.y),
    tr: (p) => p.y - p.x,
    bl: (p) => p.x - p.y,
  };

  const chosen = Object.values(score).map((fn) =>
    candidates.reduce((best, c) => (fn(c.centroid) < fn(best.centroid) ? c : best))
  );

  const unique = new Set(chosen.map((c) => c.label));
  return unique.size === 4 ? chosen : null;
}
