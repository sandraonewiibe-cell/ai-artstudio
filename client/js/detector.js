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
    this.hands = false;
    this.heldStillSince = 0;
    this.capturedSignature = null;
  }

  /** Called after a capture, to lock out further captures until the sheet leaves. */
  hold() {
    this.state = 'holding';
    this.absentFrames = 0;
    this.stableSince = 0;
    this.heldStillSince = 0;
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
      return { ...blank, progress: this.progress(now), hands: this.hands };
    }
    this.lastAnalysedAt = now;
    this.hands = false;

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
        this.heldStillSince = 0;
        if (this.absentFrames >= this.config.removalFrames) {
          this.state = 'cooldown';
          this.cooldownUntil = now + this.config.cooldownMs;
        }
        return { ...blank, state: this.state, found: false };
      }
      this.absentFrames = 0;

      // A notebook never leaves the camera: the visitor turns the page, or
      // draws the next sketch with it still there. So the sheet coming back
      // to rest showing something different from what was captured re-arms
      // capture too. Only once it is settled - still, and no hand on it - so
      // a hand passing over the same drawing does not photograph it twice.
      const hands = handsOnSheet(luma, frame.data, width, height, sheet.quad, this.config.hands);
      this.hands = hands;
      if (hands || motion >= this.config.motionThreshold) {
        this.heldStillSince = 0;
        return { ...blank, state: 'holding', found: true, hands };
      }

      if (!this.heldStillSince) this.heldStillSince = now;
      if (
        now - this.heldStillSince >= this.config.stableMs &&
        changedShare(sheetSignature(luma, width, sheet.quad), this.capturedSignature) >=
          this.config.newContentShare
      ) {
        this.state = 'ready';
        this.capturedSignature = sheetSignature(luma, width, sheet.quad);
        return { quad: sheet.quad, insetRatio: sheet.insetRatio, found: true, state: 'ready', progress: 1 };
      }

      return { ...blank, state: 'holding', found: true };
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

    // A hand on the sheet - holding it down, smoothing it, still letting go -
    // can be perfectly still, so stillness alone would photograph it. Nothing
    // fires while one is there, and the timer starts again once it has gone.
    if (handsOnSheet(luma, frame.data, width, height, sheet.quad, this.config.hands)) {
      this.state = 'settling';
      this.stableSince = 0;
      this.hands = true;
      return { ...reading, state: 'settling', progress: 0, hands: true };
    }

    if (!still) {
      this.state = 'settling';
      this.stableSince = 0;
      return { ...reading, state: 'settling', progress: 0 };
    }

    if (!this.stableSince) this.stableSince = now;

    const held = now - this.stableSince;
    if (held >= this.config.stableMs) {
      this.state = 'ready';
      // What a later page is compared against.
      this.capturedSignature = sheetSignature(luma, width, sheet.quad);
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

    // The sheet may run off the frame on a side or two - a notebook held close
    // to the camera does - but not all round. A pale table makes the bright
    // region the whole view, and the entire camera frame would be cropped as
    // though it were the paper; that is still refused here, and by the contrast
    // and coverage checks above.
    const marginX = width * PAPER.minFrameMargin;
    const marginY = height * PAPER.minFrameMargin;
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);

    const offFrame =
      Number(Math.min(...xs) < marginX) +
      Number(Math.max(...xs) > width - 1 - marginX) +
      Number(Math.min(...ys) < marginY) +
      Number(Math.max(...ys) > height - 1 - marginY);
    if (offFrame > PAPER.maxSidesOffFrame) return null;

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
 * Whether something solid is reaching onto the sheet from outside it.
 *
 * A hand reads as a large, solid patch much darker than the paper that comes
 * in across the sheet's edge. What the visitor drew does not: at analysis
 * resolution a pen line is a pixel wide and disappears when the patch is
 * eroded, and a coloured-in area sits inside the drawing rather than reaching
 * in from the border.
 *
 * @param {Uint8Array} luma the analysed frame
 * @param {Uint8ClampedArray} rgba the same frame in colour
 * @param {{x:number,y:number}[]} quad the sheet, ordered [tl, tr, br, bl]
 */
function handsOnSheet(luma, rgba, width, height, quad, cfg) {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));

  // The paper's own brightness, from the sheet itself: lighting varies too
  // much from one setup to the next for a fixed level.
  //
  // Skin is also warm where paper is close to grey, which matters: under dim
  // or grey light a hand is barely darker than the sheet it rests on.
  const histogram = new Uint32Array(256);
  const warmth = new Uint32Array(256);
  let inside = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (!inQuad(quad, x, y)) continue;
      const i = y * width + x;
      histogram[luma[i]] += 1;
      warmth[warmthOf(rgba, i)] += 1;
      inside += 1;
    }
  }
  if (!inside) return false;

  const paper = percentile(histogram, inside, 0.6);
  const paperWarmth = percentile(warmth, inside, 0.5);

  const dark = paper - cfg.darkerBy;
  const warm = paperWarmth + cfg.warmerBy;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const foreign = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (!inQuad(quad, x, y)) continue;
      const i = y * width + x;
      if (luma[i] < dark || warmthOf(rgba, i) > warm) foreign[(y - y0) * w + (x - x0)] = 1;
    }
  }

  // Eroded once: whatever survives is at least three pixels thick, which no
  // pen line is at this resolution.
  const solid = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!foreign[(y + dy) * w + (x + dx)]) {
            all = 0;
            break;
          }
        }
      }
      solid[y * w + x] = all;
    }
  }

  // Only patches that reach the border band of the sheet - that came in from
  // outside it.
  const centre = {
    x: quad.reduce((s, p) => s + p.x, 0) / 4,
    y: quad.reduce((s, p) => s + p.y, 0) / 4,
  };
  const inner = quad.map((p) => ({
    x: centre.x + (p.x - centre.x) * (1 - cfg.borderBand),
    y: centre.y + (p.y - centre.y) * (1 - cfg.borderBand),
  }));

  const seenPx = new Uint8Array(w * h);
  const stack = [];
  const limit = inside * cfg.minAreaRatio;

  for (let start = 0; start < solid.length; start += 1) {
    if (!solid[start] || seenPx[start]) continue;

    let area = 0;
    let atBorder = false;
    let rim = 0;
    let rimOnPaper = 0;
    seenPx[start] = 1;
    stack.push(start);

    while (stack.length) {
      const p = stack.pop();
      area += 1;
      const px = p % w;
      const py = (p - px) / w;

      // The patch's outline, and how much of it is up against paper.
      if (onRim(solid, w, h, px, py)) {
        rim += 1;
        if (meetsPaper(foreign, w, h, px, py, x0, y0, quad)) rimOnPaper += 1;
      }
      if (!atBorder && !inQuad(inner, px + x0, py + y0)) atBorder = true;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (solid[n] && !seenPx[n]) {
            seenPx[n] = 1;
            stack.push(n);
          }
        }
      }
    }

    if (!atBorder || area < limit) continue;

    // Table showing past the paper meets it along the paper's own edge, which
    // is straight. A hand meets it along fingers. Colour cannot tell them
    // apart - skin and a wooden table measured the same hue on a real kiosk -
    // but the shape of that boundary can.
    // A hand lies on the paper, so paper surrounds most of its outline - all
    // but where the arm comes in. Table showing past the paper's edge borders
    // the paper on one side only; the rest of its outline is the edge of the
    // sheet's outline. Colour cannot tell them apart - skin and a wooden table
    // measured the same hue on the real kiosk - but this can.
    if (!rim || rimOnPaper / rim < cfg.minPaperShare) continue;

    return true;
  }

  return false;
}

/** A patch pixel with paper within two pixels of it, inside the sheet. */
function meetsPaper(foreign, w, h, px, py, x0, y0, quad) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!foreign[ny * w + nx] && inQuad(quad, nx + x0, ny + y0)) return true;
    }
  }
  return false;
}

/** A patch pixel on its own outline: a 4-neighbour is not in the patch. */
function onRim(solid, w, h, px, py) {
  if (px === 0 || py === 0 || px === w - 1 || py === h - 1) return true;
  const i = py * w + px;
  return !solid[i - 1] || !solid[i + 1] || !solid[i - w] || !solid[i + w];
}

/** How much redder than blue a pixel is, 0..255. Skin is; paper is not. */
function warmthOf(rgba, i) {
  return Math.max(0, rgba[i * 4] - rgba[i * 4 + 2]);
}

/** The value below which `share` of a histogram's count lies. */
function percentile(histogram, total, share) {
  let seen = 0;
  for (let v = 0; v < 256; v += 1) {
    seen += histogram[v];
    if (seen >= total * share) return v;
  }
  return 255;
}

/** Grid the sheet's contents are summarised on, across and down. */
const SIGNATURE_GRID = [24, 18];

/**
 * What is on the sheet, as the average brightness of a grid of cells laid out
 * in the sheet's own coordinates, with the overall level taken out.
 *
 * In the sheet's coordinates rather than the camera's, so a notebook nudged or
 * turned slightly between scans still lines up with itself, and the paper's
 * edge moving across the table does not read as a new drawing.
 */
function sheetSignature(luma, width, quad) {
  const [gx, gy] = SIGNATURE_GRID;
  const inset = 0.06;
  const [tl, tr, br, bl] = quad;
  const height = luma.length / width;
  const cells = new Float32Array(gx * gy);

  for (let cy = 0; cy < gy; cy += 1) {
    for (let cx = 0; cx < gx; cx += 1) {
      let sum = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const u = inset + ((cx + (sx + 0.5) / 3) / gx) * (1 - 2 * inset);
          const v = inset + ((cy + (sy + 0.5) / 3) / gy) * (1 - 2 * inset);
          const x = (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x);
          const y = (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y);
          const px = Math.min(width - 1, Math.max(0, Math.round(x)));
          const py = Math.min(height - 1, Math.max(0, Math.round(y)));
          sum += luma[py * width + px];
        }
      }
      cells[cy * gx + cx] = sum / 9;
    }
  }

  const sorted = Array.from(cells).sort((a, b) => a - b);
  const level = sorted[sorted.length >> 1];
  for (let i = 0; i < cells.length; i += 1) cells[i] -= level;
  return cells;
}

/** Share of the sheet's cells that now look different from the captured ones. */
function changedShare(now, before) {
  if (!before || before.length !== now.length) return 1;
  let changed = 0;
  for (let i = 0; i < now.length; i += 1) {
    if (Math.abs(now[i] - before[i]) > CELL_CHANGE) changed += 1;
  }
  return changed / now.length;
}

/** Brightness difference, out of 255, at which one cell counts as changed. */
const CELL_CHANGE = 10;

/** Point inside a convex quad, either winding. */
function inQuad(quad, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
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

// Exposed for checking the scanner against recorded scans.
export { sheetSignature, changedShare };
