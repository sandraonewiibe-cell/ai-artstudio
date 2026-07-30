import { EXTRACT } from './config.js';
import { toLuminance, adaptiveInk, createCanvas, context2d } from './imaging.js';
import { labelComponents } from './components.js';
import { detectPaddles } from './paddles.js';

/**
 * Isolates the visitor's work from the cropped drawing area and returns it as
 * a PNG with a transparent background.
 *
 * What is kept: the hand-drawn boat and any handwritten text, together, with
 * enclosed areas filled in so an outlined shape reads as solid rather than as
 * a ring around a hole.
 *
 * What is dropped: speckle noise, and anything lying entirely inside a corner
 * box - the last line of defence in case a QR marker survived the crop in
 * capture.js. The page border and the markers themselves are already gone by
 * the time this runs.
 *
 * @param {HTMLCanvasElement} pageCanvas cropped, perspective-corrected drawing area
 * @returns {{canvas: HTMLCanvasElement, bounds: object, inkRatio: number, dropped: number,
 *            filled: number}|null}
 */
export function extractDrawing(pageCanvas) {
  const width = pageCanvas.width;
  const height = pageCanvas.height;
  const page = context2d(pageCanvas).getImageData(0, 0, width, height);
  const luma = toLuminance(page);

  const margin = Math.round(Math.min(width, height) * EXTRACT.marginRatio);
  const radius = Math.max(4, Math.round(Math.min(width, height) * EXTRACT.ink.radiusRatio));

  // Ink is whatever is darker than the paper immediately around it, so uneven
  // lighting across the sheet does not become part of the drawing.
  const { mask, reference, inkCount } = adaptiveInk(luma, width, height, {
    radius,
    offset: EXTRACT.ink.offset,
    margin,
  });

  // Nothing drawn on it.
  if (inkCount < width * height * EXTRACT.ink.minRatio) return null;

  const { components, labels } = labelComponents(mask, width, height);
  if (!components.length) return null;

  // The table past the paper, the paper's edge and its shadow all arrive as a
  // dark band hugging the page edge. None of it is the drawing.
  const inside = components.filter((c) => !touchesEdge(c, width, height, margin));

  // ...but never at the cost of the whole drawing. On a real photograph the
  // shading near the paper's edge can join up with what was drawn, leaving one
  // component that happens to reach the border. Discarding that leaves nothing
  // to extract and the visitor is told there was no drawing - so if excluding
  // the edge would empty the page, keep everything and carry on.
  let usable = inside;
  if (!usable.length) {
    console.warn('[extract] everything reaches the page edge; keeping it anyway');
    usable = components;
  }

  const withCompany = keepDrawingCluster(usable, width, height);
  if (!withCompany.length) return null;

  const kept = withCompany.filter((c) => !isMarkerRemnant(c, width, height));
  if (!kept.length) return null;

  const selected = new Set(kept.map((c) => c.label));
  const strokes = buildStrokeMask(labels, selected, width, height);

  // Which components are big enough to count as the boat. Only areas these
  // help enclose get filled, so every compartment inside the hull fills while
  // the counters of O, A, B and e stay open.
  const hullLabels = selectHullLabels(kept);
  const walls = buildStrokeMask(labels, hullLabels, width, height);

  const hullBounds = unionBounds(kept.filter((c) => hullLabels.has(c.label)));

  const { fill, filled } = fillEnclosedAreas(
    strokes,
    labels,
    hullLabels,
    hullBounds,
    width,
    height
  );

  // Blank enclosed paper takes the boat's colour, not an average that the
  // handwriting has been mixed into.
  const meanInk = meanInkColour(page, walls);
  const drawingBounds = unionBounds(kept);
  const rect = cropRect(drawingBounds, width, height);

  const base = { page, luma, strokes, width, height, reference, meanInk };

  const rendered = renderLayer({ ...base, fill, rect });
  if (!rendered) return null;

  return {
    ...rendered,
    dropped: withCompany.length - kept.length,
    specks: components.length - withCompany.length,
    filled,
    // Oars are confined to the single biggest component - the hull itself, not
    // the group of hull-sized things. A solid line of writing can rival a thin
    // outline for area, so it lands in the group and then passes a check based
    // on the group's box; against the hull alone it does not.
    layers: splitLayers(base, fill, rect, drawingBounds, boxOf(largestOf(kept))),
  };
}

/**
 * Separates the oars from the hull so each can be rowed on the display.
 *
 * Returns null when the drawing has no oars in it, and the display then shows
 * the single flat image exactly as before.
 *
 * @returns {{hull: HTMLCanvasElement, paddles: object[]}|null}
 */
function splitLayers(base, fill, rect, drawingBounds, hullBounds) {
  const { width, height, strokes } = base;
  const detected = detectPaddles(
    fill,
    strokes,
    width,
    height,
    drawingBounds,
    hullBounds
  );
  const { paddles, appendageMask, interiorMask } = detected;
  if (!paddles.length) return null;

  // An oar hanging off the hull is cut away entirely. One drawn *across* the
  // hull cannot be: removing it would punch a bar-shaped hole through the
  // boat. It stays in the hull layer but is painted over in the hull's own
  // colour, and the moving copy is drawn on top.
  const hullMask = new Uint8Array(fill.length);
  for (let i = 0; i < fill.length; i += 1) {
    if (fill[i] && !appendageMask[i]) hullMask[i] = 1;
  }

  const hull = renderLayer({ ...base, fill: hullMask, recolour: interiorMask, rect });
  if (!hull) return null;

  const cropW = rect.x1 - rect.x0 + 1;
  const cropH = rect.y1 - rect.y0 + 1;

  // Positions travel as fractions of the drawing, so the display can scale the
  // boat to any size and the oars stay where they were drawn.
  const relative = (point) => ({
    x: (point.x - rect.x0) / cropW,
    y: (point.y - rect.y0) / cropH,
  });

  const rendered = paddles
    .map((paddle) => {
      const interior = paddle.mode === 'interior';
      const region = interior ? interiorMask : appendageMask;
      const source = interior ? detected.interiorLabels : detected.appendageLabels;

      const mask = new Uint8Array(fill.length);
      for (let i = 0; i < fill.length; i += 1) {
        if (region[i] && source[i] === paddle.label) mask[i] = 1;
      }

      const oarRect = cropRect(paddle.bounds, width, height);
      const layer = renderLayer({ ...base, fill: mask, rect: oarRect });
      if (!layer) return null;

      return {
        canvas: layer.canvas,
        rect: {
          x: (oarRect.x0 - rect.x0) / cropW,
          y: (oarRect.y0 - rect.y0) / cropH,
          width: (oarRect.x1 - oarRect.x0 + 1) / cropW,
          height: (oarRect.y1 - oarRect.y0 + 1) / cropH,
        },
        pivot: relative(paddle.pivot),
        tip: relative(paddle.tip),
      };
    })
    .filter(Boolean);

  if (!rendered.length) return null;

  return { hull: hull.canvas, paddles: rendered };
}

/** Crop box for a set of bounds, with breathing room, clamped to the page. */
function cropRect(bounds, width, height) {
  const pad = Math.round(
    Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * EXTRACT.paddingRatio
  );

  return {
    x0: Math.max(0, bounds.minX - pad),
    y0: Math.max(0, bounds.minY - pad),
    x1: Math.min(width - 1, bounds.maxX + pad),
    y1: Math.min(height - 1, bounds.maxY + pad),
  };
}

/**
 * Keeps the single cluster of marks the visitor actually drew, and discards
 * anything stranded away from it - dust, smudges, a pen test in the margin.
 *
 * Grows outward from the largest component: the boat pulls in the name written
 * below it, the name pulls in the line below that, a stem pulls in its own
 * dot. Nothing that never joins the chain is drawn.
 *
 * Size is not used, deliberately. A speck of dust and the dot of an 'i' are
 * the same size, and a large smudge is still a smudge - the earlier size-based
 * version kept exactly those. Position is what actually separates them.
 */
function keepDrawingCluster(components, width, height) {
  const floor = Math.max(6, width * height * EXTRACT.minComponentRatio);
  const candidates = components.filter((c) => c.area >= floor);
  if (!candidates.length) return [];

  const reach = Math.hypot(width, height) * EXTRACT.clusterReachRatio;
  const sorted = [...candidates].sort((a, b) => b.area - a.area);

  const cluster = new Set([sorted[0]]);
  let changed = true;

  // Repeat until nothing new joins: a component that has just joined can bring
  // others within reach, which is what lets a chain of text lines hang
  // together.
  while (changed) {
    changed = false;

    for (const candidate of sorted) {
      if (cluster.has(candidate)) continue;

      for (const member of cluster) {
        if (boxDistance(boxOf(candidate), boxOf(member)) <= reach) {
          cluster.add(candidate);
          changed = true;
          break;
        }
      }
    }
  }

  return [...cluster];
}

/** 1 where the pixel belongs to a component we are keeping. */
function buildStrokeMask(labels, selected, width, height) {
  const strokes = new Uint8Array(width * height);

  for (let i = 0; i < strokes.length; i += 1) {
    if (selected.has(labels[i])) strokes[i] = 1;
  }

  return strokes;
}

/**
 * True if a component reaches the edge of the usable area.
 *
 * Everything the visitor drew sits comfortably inside the paper, because the
 * page was cropped inside the paper's edge before this ran. So anything
 * arriving at the boundary came from outside the sheet, not from the drawing.
 */
function touchesEdge(component, width, height, margin) {
  const slack = margin + EXTRACT.borderSlackPx;

  return (
    component.minX <= slack ||
    component.minY <= slack ||
    component.maxX >= width - 1 - slack ||
    component.maxY >= height - 1 - slack
  );
}

function largestOf(components) {
  return components.reduce((a, b) => (b.area > a.area ? b : a));
}

/** The components big enough to count as the boat rather than an annotation. */
function selectHullLabels(components) {
  const largest = largestOf(components);
  const threshold = largest.area * EXTRACT.fill.hullShareRatio;

  return new Set(
    components.filter((c) => c.area >= threshold).map((c) => c.label)
  );
}

/**
 * Marks every pixel enclosed by the boat, so an outlined hull comes out solid
 * and every compartment inside it fills too.
 *
 * Works by flooding the *background* inward from the page border: anything the
 * flood cannot reach is walled in. Four-connectivity for the flood, so a
 * diagonal pencil line still counts as a seal.
 *
 * An enclosed area is then filled only if one of its walls is a hull-sized
 * component. That is what separates the gap between two thwarts - small, but
 * bounded by the hull - from the counter of an 'o', which is the same size but
 * bounded only by the letter itself. Judging the *hole* by its size cannot
 * tell those apart; judging its boundary can.
 *
 * @param {Uint8Array} strokes every kept component, boat and text alike
 * @param {Int32Array} labels component label per pixel
 * @param {Set<number>} hullLabels components counting as the boat
 * @param {{minX:number,maxX:number,minY:number,maxY:number}} bounds hull extent
 * @returns {{fill: Uint8Array, filled: number}} fill = strokes plus enclosed areas
 */
function fillEnclosedAreas(strokes, labels, hullLabels, bounds, width, height) {
  const outside = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;

  const push = (i) => {
    if (!strokes[i] && !outside[i]) {
      outside[i] = 1;
      stack[top++] = i;
    }
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    const y = (i - x) / width;

    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }

  // Safety valve. If the flood barely got anywhere, the page border is walled
  // off by ink and "enclosed" has stopped meaning anything - filling on that
  // basis would paint the whole sheet solid. Strokes only, and say so.
  let reached = 0;
  for (let i = 0; i < outside.length; i += 1) if (outside[i]) reached += 1;

  if (reached < outside.length * 0.05) {
    console.warn('[extract] page border is enclosed by ink; skipping the fill');
    return { fill: strokes.slice(), filled: 0 };
  }

  // Candidate holes: unreachable, not a stroke, and inside the hull's extent.
  const enclosed = new Uint8Array(width * height);

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const i = y * width + x;
      if (!outside[i] && !strokes[i]) enclosed[i] = 1;
    }
  }

  const { labels: holeLabels } = labelComponents(enclosed, width, height);
  const fillable = holesTouchingHull(enclosed, holeLabels, strokes, labels, hullLabels, width, height);

  const fill = new Uint8Array(width * height);
  let filled = 0;

  for (let i = 0; i < fill.length; i += 1) {
    if (strokes[i]) {
      fill[i] = 1;
    } else if (enclosed[i] && fillable.has(holeLabels[i])) {
      fill[i] = 1;
      filled += 1;
    }
  }

  return { fill, filled };
}

/**
 * Which enclosed areas have a hull-sized component as one of their walls.
 *
 * "One of" rather than "most of" on purpose: a compartment between two thwarts
 * is bounded partly by the hull and partly by the thin seat strokes, and
 * requiring a majority would leave those gaps blank.
 */
function holesTouchingHull(enclosed, holeLabels, strokes, labels, hullLabels, width, height) {
  const fillable = new Set();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!enclosed[i] || fillable.has(holeLabels[i])) continue;

      // Any stroke pixel next door that belongs to the boat qualifies the
      // whole enclosed region.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const n = ny * width + nx;
          if (strokes[n] && hullLabels.has(labels[n])) {
            fillable.add(holeLabels[i]);
            dy = 2;
            break;
          }
        }
      }
    }
  }

  return fillable;
}

/** Gap between two boxes; 0 when they overlap. */
function boxDistance(a, b) {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

/** Average colour of the boat's strokes, used to fill blank enclosed paper. */
function meanInkColour(page, mask) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;

  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    r += page.data[i * 4];
    g += page.data[i * 4 + 1];
    b += page.data[i * 4 + 2];
    n += 1;
  }

  if (!n) return { r: 20, g: 20, b: 20 };
  return { r: r / n, g: g / n, b: b / n };
}

/**
 * True if a component lies entirely inside one of the four corner boxes.
 *
 * This is the backstop for a marker the crop in capture.js failed to remove.
 * The test is positional rather than shape-based on purpose: a whole marker is
 * square, but a sliver left by a slightly-too-tight crop is a thin strip, and
 * a squareness test would wave it through.
 *
 * "Entirely inside" matters - a boat drawn towards one corner still extends
 * out of the box and is kept.
 */
function isMarkerRemnant(c, width, height) {
  if (c.area / (width * height) < EXTRACT.markerRemnantMinAreaRatio) return false;

  const zoneX = width * EXTRACT.cornerZoneRatio;
  const zoneY = height * EXTRACT.cornerZoneRatio;

  const inCornerX = c.maxX < zoneX || c.minX > width - zoneX;
  const inCornerY = c.maxY < zoneY || c.minY > height - zoneY;

  return inCornerX && inCornerY;
}

function boxOf(c) {
  return { minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY };
}

function mergeBox(a, b) {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function unionBounds(components) {
  return components.map(boxOf).reduce(mergeBox);
}

/**
 * Draws one layer into a cropped canvas.
 *
 * `fill` selects which pixels belong to this layer - all of the drawing for
 * the flat image, the hull alone, or a single oar. Every layer that shares a
 * `rect` comes out the same size and overlays exactly.
 *
 * Strokes and everything they enclose are fully opaque, so no blank gaps are
 * left inside the drawing. Only the fringe immediately outside the shape uses
 * a soft alpha, which keeps pencil edges from looking cut out.
 */
function renderLayer({
  page, luma, strokes, fill, width, height, reference, meanInk, rect, recolour,
}) {
  const { x0, y0, x1, y1 } = rect;

  const outW = x1 - x0 + 1;
  const outH = y1 - y0 + 1;
  if (outW < 8 || outH < 8) return null;

  const out = new ImageData(outW, outH);
  const src = page.data;
  const dst = out.data;
  const softness = EXTRACT.softness;
  const { chromaThreshold, washMargin } = EXTRACT.fill;

  let inkPixels = 0;

  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const sx = x0 + x;
      const sy = y0 + y;
      const si = sy * width + sx;
      const di = (y * outW + x) * 4;

      if (fill[si]) {
        const r = src[si * 4];
        const g = src[si * 4 + 1];
        const b = src[si * 4 + 2];

        // Strokes always keep their own colour. Enclosed pixels keep theirs
        // too if the visitor coloured them in - detected by chroma, since pale
        // crayon and white paper differ in colour far more than in brightness.
        //
        // `recolour` overrides both: those pixels are an oar being painted out
        // of the hull, and must take the hull's colour however dark they are.
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        const coloured =
          !(recolour && recolour[si]) &&
          (strokes[si] || chroma > chromaThreshold || luma[si] < reference[si] - washMargin);

        dst[di] = coloured ? r : meanInk.r;
        dst[di + 1] = coloured ? g : meanInk.g;
        dst[di + 2] = coloured ? b : meanInk.b;
        dst[di + 3] = 255;

        inkPixels += 1;
        continue;
      }

      // Outside the shape: taper the antialiased fringe rather than ending
      // abruptly. Anything further out stays fully transparent.
      if (!isNearFill(fill, sx, sy, width, height)) continue;

      // Solid at the local ink threshold, fading to nothing `softness` above it.
      const local = reference[si] - EXTRACT.ink.offset;
      const alpha = Math.max(0, Math.min(1, (local + softness - luma[si]) / softness));
      if (alpha <= 0.02) continue;

      dst[di] = src[si * 4];
      dst[di + 1] = src[si * 4 + 1];
      dst[di + 2] = src[si * 4 + 2];
      dst[di + 3] = Math.round(alpha * 255);

      inkPixels += 1;
    }
  }

  const canvas = createCanvas(outW, outH);
  context2d(canvas).putImageData(out, 0, 0);

  return {
    canvas,
    bounds: { x: x0, y: y0, width: outW, height: outH },
    inkRatio: inkPixels / (outW * outH),
  };
}

/** True if any of the 8 neighbours is part of the filled shape. */
function isNearFill(fill, x, y, width, height) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (fill[ny * width + nx]) return true;
    }
  }
  return false;
}
