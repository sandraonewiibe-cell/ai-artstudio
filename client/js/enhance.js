import { ENHANCE } from './config.js';
import { labelComponents } from './components.js';
import { erode, dilate } from './paddles.js';

/**
 * Finishing the extracted drawing: tidy the lines, deepen the colours the
 * visitor used, and light it so it reads as an object rather than a scan.
 *
 * The whole of it is arithmetic over the pixels already extracted. There is no
 * service behind this and nothing is generated: a model cannot be instructed to
 * leave a silhouette alone, and this brief asks for the silhouette to be left
 * alone. So every pass here either mends something by a pixel or two, or
 * changes only *how* an existing pixel is coloured - never what shape the boat
 * is or which colours are in it.
 *
 * It runs in single-digit milliseconds on a visitor's drawing, which is what
 * makes it usable at a kiosk where somebody is standing there waiting.
 */

/** What a pixel of the extraction is, so each part can be finished differently. */
export const KIND = {
  NONE: 0,     // paper, or the soft fringe outside the shape
  STROKE: 1,   // drawn ink - left alone but for the tidying
  PAINT: 2,    // an area the visitor coloured in
  BODY: 3,     // hull the fill closed up, in the drawing's own ink colour
  WRITING: 4,  // writing on the boat - never touched at all
};

/** Pixels this opaque count as part of the drawing rather than its fringe. */
const SOLID = 160;

/**
 * @param {ImageData} image the rendered drawing, modified in place
 * @param {Uint8Array} kinds one KIND per pixel, same dimensions
 * @returns {{applied: boolean, ms: number, mended: number, removed: number}}
 */
export function enhance(image, kinds) {
  if (!ENHANCE.enabled) return { applied: false, ms: 0, mended: 0, removed: 0 };

  const started = performance.now();
  const { width: w, height: h, data } = image;

  const original = solidMask(data, w, h);
  let shape = original;

  shape = closeGaps(shape, w, h);
  shape = despeckle(shape, w, h);
  shape = evenUp(shape, original, w, h);

  const { mended, removed } = applyShape(data, kinds, original, shape, w, h);
  if (ENHANCE.line.smoothEdges) smoothEdges(data, shape, w, h);

  enrich(data, kinds, w, h);
  giveItSubstance(data, kinds, shape, w, h);

  return { applied: true, ms: performance.now() - started, mended, removed };
}

// --- the shape ---------------------------------------------------------------

function solidMask(data, w, h) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i += 1) if (data[i * 4 + 3] >= SOLID) mask[i] = 1;
  return mask;
}

/** Mends strokes that broke over the grain of the paper. */
function closeGaps(mask, w, h) {
  const r = ENHANCE.line.closeRadius;
  if (r < 1) return mask;

  const box = { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 };
  return erode(dilate(mask, w, h, r, box), w, h, r, box);
}

/** Drops islands too small to be anything the visitor meant to draw. */
function despeckle(mask, w, h) {
  const floor = ENHANCE.line.despeckleArea;
  if (floor < 1) return mask;

  const { components, labels } = labelComponents(mask, w, h);
  const specks = new Set(components.filter((c) => c.area < floor).map((c) => c.label));
  if (!specks.size) return mask;

  const out = mask.slice();
  for (let i = 0; i < out.length; i += 1) if (specks.has(labels[i])) out[i] = 0;
  return out;
}

/**
 * Evens up a lopsided outline, barely.
 *
 * A pixel is added only where the drawing's mirror image has ink *and* there is
 * already ink close by, so a nick out of one gunwale fills from the other side
 * while a bow on the left can never grow a matching bow on the right. Nothing
 * is ever taken away to make the boat symmetric - that would be redrawing it.
 */
function evenUp(mask, original, w, h) {
  const reach = ENHANCE.line.symmetryReach;
  if (reach < 1) return mask;

  // Mirror about the drawing's own centre, not the canvas's.
  let minX = w;
  let maxX = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (maxX < minX) return mask;

  const axis = minX + maxX;
  const box = { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 };
  const near = dilate(mask, w, h, reach, box);

  const out = mask.slice();
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (out[i] || !near[i]) continue;

      const mx = axis - x;
      if (mx < 0 || mx >= w) continue;
      if (mask[y * w + mx]) out[i] = 1;
    }
  }

  return out;
}

/**
 * Writes the tidied shape back into the picture.
 *
 * A pixel that has just been mended has no colour of its own - it was a gap -
 * so it takes the average of the drawing around it, which is the ink of the
 * stroke it belongs to.
 */
function applyShape(data, kinds, original, shape, w, h) {
  let mended = 0;
  let removed = 0;

  for (let i = 0; i < shape.length; i += 1) {
    if (shape[i] && !original[i]) mended += 1;
    else if (!shape[i] && original[i]) {
      removed += 1;
      data[i * 4 + 3] = 0;
      kinds[i] = KIND.NONE;
    }
  }

  if (!mended) return { mended, removed };

  // Two passes is plenty: a mended gap is only ever a pixel or two across.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        if (!shape[i] || original[i] || data[i * 4 + 3] >= SOLID) continue;

        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        let kind = KIND.BODY;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;

            const q = ny * w + nx;
            if (data[q * 4 + 3] < SOLID) continue;

            r += data[q * 4];
            g += data[q * 4 + 1];
            b += data[q * 4 + 2];
            n += 1;
            if (kinds[q] !== KIND.NONE) kind = kinds[q];
          }
        }

        if (!n) continue;

        data[i * 4] = Math.round(r / n);
        data[i * 4 + 1] = Math.round(g / n);
        data[i * 4 + 2] = Math.round(b / n);
        data[i * 4 + 3] = 255;
        kinds[i] = kind;
      }
    }
  }

  return { mended, removed };
}

/** Softens the stair-stepping where the shape meets the paper. Alpha only. */
function smoothEdges(data, shape, w, h) {
  const alpha = new Uint8Array(shape.length);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3];

  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;

      // Only on the boundary itself - blurring the interior would fog the
      // writing and the ink lines for no gain.
      let inside = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) inside += shape[(y + dy) * w + (x + dx)];
      }
      if (inside === 0 || inside === 9) continue;

      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) sum += alpha[(y + dy) * w + (x + dx)];
      }
      data[i * 4 + 3] = Math.round(sum / 9);
    }
  }
}

// --- the colours -------------------------------------------------------------

/**
 * Deepens the colours the visitor used, and invents none.
 *
 * Hue is carried through untouched - the same number goes out as came in. Only
 * saturation and lightness move, which is the difference between a pale patchy
 * crayon and the same crayon laid down properly. A red boat stays exactly as
 * red as it was drawn; it just stops looking washed out on a wall.
 *
 * Cached per colour. A coloured-in area is one flat colour by this point, so
 * there are a handful of distinct values in the whole picture and the
 * conversion runs a handful of times rather than a hundred thousand.
 */
function enrich(data, kinds, w, h) {
  const { saturationBoost, minSaturation, minLightness, maxLightness } = ENHANCE.colour;
  const seen = new Map();

  for (let i = 0; i < w * h; i += 1) {
    if (kinds[i] !== KIND.PAINT) continue;

    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    let rich = seen.get(key);

    if (!rich) {
      const [hue, sat, light] = toHsl(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);

      const deeper = Math.max(minSaturation, sat + (1 - sat) * saturationBoost);
      const level = Math.min(maxLightness, Math.max(minLightness, light));

      rich = toRgb(hue, deeper, level);
      seen.set(key, rich);
    }

    data[i * 4] = rich[0];
    data[i * 4 + 1] = rich[1];
    data[i * 4 + 2] = rich[2];
  }
}

// --- wood, light and depth ---------------------------------------------------

/** Built once, on the first visitor, and reused by every visitor after. */
let grainField = null;

function grain() {
  if (grainField) return grainField;

  const size = ENHANCE.material.grainField;
  const data = new Float32Array(size * size);

  // Value noise over three octaves. Deterministic - the same field every run,
  // so a drawing rescanned looks the same as it did the first time.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let value = 0;
      let amplitude = 0.5;
      let frequency = 1;

      for (let octave = 0; octave < 3; octave += 1) {
        value += amplitude * lattice(x * frequency, y * frequency, size);
        amplitude *= 0.5;
        frequency *= 2;
      }

      data[y * size + x] = value;
    }
  }

  grainField = { size, data };
  return grainField;
}

function lattice(x, y, size) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);

  const a = hash(x0, y0, size);
  const b = hash(x0 + 1, y0, size);
  const c = hash(x0, y0 + 1, size);
  const d = hash(x0 + 1, y0 + 1, size);

  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function hash(x, y, size) {
  const wrapped = (((x % size) + size) % size) * 374761393 + (((y % size) + size) % size) * 668265263;
  let n = wrapped | 0;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Gives the boat a material: wood grain through the colour, light from above,
 * and shadow gathering under the edges.
 *
 * All three are multipliers on the lightness of a pixel that is already there.
 * Nothing is drawn, no pixel moves, and outside the drawing nothing happens at
 * all - so whatever the visitor made is still exactly the shape it was, now
 * lit. Ink lines and writing are skipped: shading a pencil stroke just makes it
 * look smudged.
 */
function giveItSubstance(data, kinds, shape, w, h) {
  const {
    grainStrength, grainScaleX, grainScaleY, lightTop, lightBottom,
    shadowDepth, shadowStrength,
  } = ENHANCE.material;

  const field = grain();
  const depth = depthFromEdge(shape, w, h, shadowDepth);

  // Only things with some bulk to them. A hull has an inside; a pen stroke is
  // all edge, and lighting one just makes it look grubby - the inner shadow
  // alone would darken a thin coloured line along its whole length.
  const bodies = withSubstance(shape, depth, shadowDepth, w, h);

  // Light runs top to bottom of the drawing itself, wherever it sits.
  let top = h;
  let bottom = -1;
  for (let i = 0; i < shape.length; i += 1) {
    if (!shape[i]) continue;
    const y = (i / w) | 0;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (bottom < top) return;

  const span = Math.max(1, bottom - top);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const kind = kinds[i];
      if (kind !== KIND.PAINT && kind !== KIND.BODY) continue;
      if (!bodies[i] || data[i * 4 + 3] < SOLID) continue;

      // Grain: stretched along the hull, tight across it, so it reads as
      // planking rather than as noise.
      const noise = sample(field, x * grainScaleX, y * grainScaleY);
      const wood = 1 + (noise - 0.5) * 2 * grainStrength;

      // Light from above.
      const down = (y - top) / span;
      const lit = lightTop + (lightBottom - lightTop) * down;

      // Shadow gathering under the edge.
      const d = depth[i];
      const shade = d >= shadowDepth ? 1 : 1 - shadowStrength * (1 - d / shadowDepth);

      const factor = wood * lit * shade;

      data[i * 4] = clamp255(data[i * 4] * factor);
      data[i * 4 + 1] = clamp255(data[i * 4 + 1] * factor);
      data[i * 4 + 2] = clamp255(data[i * 4 + 2] * factor);
    }
  }
}

/**
 * The parts of the drawing that have an inside.
 *
 * A shape is a body if any pixel of it survives being peeled all the way down -
 * that is, if it is at least twice `depth` thick somewhere. A hull qualifies, a
 * drawn line does not, and the whole of a shape is judged together so the thin
 * end of a hull is still hull.
 */
function withSubstance(shape, depth, limit, w, h) {
  const { labels } = labelComponents(shape, w, h);
  const solid = new Set();

  for (let i = 0; i < shape.length; i += 1) {
    if (shape[i] && depth[i] >= limit) solid.add(labels[i]);
  }

  const mask = new Uint8Array(shape.length);
  if (!solid.size) return mask;

  for (let i = 0; i < mask.length; i += 1) if (shape[i] && solid.has(labels[i])) mask[i] = 1;
  return mask;
}

/**
 * How far each pixel sits from the edge of the shape, up to `limit`.
 *
 * A two-pass chamfer distance: one sweep down and right carrying the nearest
 * edge found so far, one back up and left. Two passes over the picture, whatever
 * the depth.
 *
 * The obvious way to write this is to peel the shape a pixel at a time and
 * count how many peels each pixel survives, which is a handful of lines. It is
 * also the single most expensive thing in this file by a wide margin -
 * measured at 128ms of a 153ms pass, because each peel is another sweep. This
 * is the same answer in about 5ms.
 *
 * Costs of 3 and 4 approximate a step of 1 and a diagonal of root two; the
 * distance comes back divided by 3.
 */
function depthFromEdge(shape, w, h, limit) {
  const STRAIGHT = 3;
  const DIAGONAL = 4;
  const FAR = 0x7fff;

  const d = new Int32Array(shape.length);
  for (let i = 0; i < d.length; i += 1) d[i] = shape[i] ? FAR : 0;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!d[i]) continue;

      let best = d[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, d[i - w - 1] + DIAGONAL);
        best = Math.min(best, d[i - w] + STRAIGHT);
        if (x < w - 1) best = Math.min(best, d[i - w + 1] + DIAGONAL);
      }
      if (x > 0) best = Math.min(best, d[i - 1] + STRAIGHT);
      d[i] = best;
    }
  }

  const depth = new Uint8Array(shape.length);

  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;

      if (d[i]) {
        let best = d[i];
        if (y < h - 1) {
          if (x < w - 1) best = Math.min(best, d[i + w + 1] + DIAGONAL);
          best = Math.min(best, d[i + w] + STRAIGHT);
          if (x > 0) best = Math.min(best, d[i + w - 1] + DIAGONAL);
        }
        if (x < w - 1) best = Math.min(best, d[i + 1] + STRAIGHT);
        d[i] = best;
      }

      // Back to pixels, with the boundary itself sitting at zero.
      const steps = Math.round(d[i] / STRAIGHT) - 1;
      depth[i] = steps <= 0 ? 0 : steps >= limit ? limit : steps;
    }
  }

  return depth;
}

function sample(field, u, v) {
  const { size, data } = field;
  const x = ((u % size) + size) % size;
  const y = ((v % size) + size) % size;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % size;
  const y1 = (y0 + 1) % size;
  const fx = x - x0;
  const fy = y - y0;

  const a = data[y0 * size + x0];
  const b = data[y0 * size + x1];
  const c = data[y1 * size + x0];
  const d = data[y1 * size + x1];

  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function clamp255(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

// --- colour space ------------------------------------------------------------

function toHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const light = (max + min) / 2;
  const chroma = max - min;

  if (!chroma) return [0, 0, light];

  const sat = light > 0.5 ? chroma / (2 - max - min) : chroma / (max + min);

  let hue;
  if (max === rn) hue = (gn - bn) / chroma + (gn < bn ? 6 : 0);
  else if (max === gn) hue = (bn - rn) / chroma + 2;
  else hue = (rn - gn) / chroma + 4;

  return [hue / 6, sat, light];
}

function toRgb(hue, sat, light) {
  if (!sat) {
    const flat = Math.round(light * 255);
    return [flat, flat, flat];
  }

  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;

  return [
    Math.round(channel(p, q, hue + 1 / 3) * 255),
    Math.round(channel(p, q, hue) * 255),
    Math.round(channel(p, q, hue - 1 / 3) * 255),
  ];
}

function channel(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;

  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}
