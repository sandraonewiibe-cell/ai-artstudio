import { FLOAT } from './config.js';
import { labelComponents } from './components.js';

/**
 * Where the water crosses the drawing.
 *
 * A boat has to sit *in* the water, not on top of it, and how deep it sits is a
 * fact about the boat rather than about the picture it arrived in. This works
 * that out from the drawing itself, so every visitor's boat floats correctly
 * with nothing positioned by hand.
 *
 * The measurement is of the hull, not of the picture. Those are not the same
 * thing and the difference is the whole point of this file. The extraction
 * crops tightly, so the *silhouette* of every drawing runs from about 0.02 to
 * about 0.98 of the image whatever was drawn - measured across nine real scans,
 * the waterline that follows from it is 0.74 every single time, which is a
 * constant wearing a measurement's clothes. Meanwhile the hull itself finishes
 * anywhere between 0.60 and 0.99, because a boat is usually drawn with things
 * around it: lily pads, motion lines, a stray dot, a signature. Take the picture
 * for the boat and a hull that stops at 0.60 is asked to float at 0.74, which
 * hangs it a quarter of an image-height clear of the water.
 *
 * So the hull is found as the largest connected mass of the drawing. That is
 * what a boat is in every one of these scans - the outline and everything it
 * encloses, arriving as one solid body of 90% or more of all the ink - while the
 * things drawn around it are small and separate. Nothing is recognised or
 * understood here; the biggest thing is simply taken to be the boat, which for a
 * drawing of a boat is true.
 */

/**
 * Alpha at or above which a pixel is part of the drawing.
 *
 * The same floor `seal.js` and `inflate.js` use, so every stage of the display
 * agrees on where the boat ends and the page began.
 */
const ALPHA_FLOOR = 40;

/**
 * Width the silhouette is measured at.
 *
 * A waterline is a coarse quantity - one horizontal line across a boat - and
 * finding it does not need every pixel of a thousand-wide scan. Sampling down
 * keeps the labelling to a fraction of the work for an answer that moves by less
 * than a pixel on the wall.
 */
const SAMPLE_WIDTH = 400;

/**
 * @param {HTMLImageElement|HTMLCanvasElement} image the extracted drawing
 * @returns {{top: number, bottom: number, waterline: number, draft: number}|null}
 *   all as fractions of the image's height, or null if nothing was drawn:
 *   `top` and `bottom` are the hull's own extent, `waterline` is where the
 *   surface crosses it, and `draft` is how much of the hull is under.
 */
export function measureHull(image) {
  const source = readAlpha(image);
  if (!source) return null;

  const { mask, width, height } = source;

  const { components, labels } = labelComponents(mask, width, height);
  if (!components.length) return null;

  // The boat. Everything else in the picture was drawn around it.
  const hull = components.reduce((a, b) => (b.area > a.area ? b : a));

  // Rows are inclusive, so a hull one row tall is one row tall rather than
  // nothing at all - which would put the waterline on top of itself.
  const top = hull.minY / height;
  const bottom = (hull.maxY + 1) / height;

  const draft = clamp(FLOAT.draft, 0, 0.9);
  const waterline = bottom - draft * (bottom - top);

  return {
    top,
    bottom,
    draft,
    waterline,
    beam: beamAt(waterline, hull, labels, width, height),
  };
}

/**
 * How wide the boat is where it meets the water.
 *
 * Its beam at the waterline, not the width of the picture and not the widest
 * the hull ever gets. This is the footprint the boat actually rests on, which is
 * what anything sitting on the surface under it has to follow - a shadow cast
 * straight down, or the water pushed aside as it goes.
 *
 * A few rows either side of the waterline are taken together rather than the one
 * row exactly on it. A hand-drawn hull can be pinched to nothing at the very
 * row the waterline falls on, or have a gap in its outline there, and a beam
 * measured off that one row would flicker as the boat rides up and down.
 *
 * @returns {{left: number, right: number}} fractions of the image's width
 */
function beamAt(waterline, hull, labels, width, height) {
  const centre = Math.round(waterline * height);
  const reach = Math.max(1, Math.round(height * 0.02));

  let min = width;
  let max = -1;

  for (let y = centre - reach; y <= centre + reach; y += 1) {
    if (y < 0 || y >= height) continue;

    for (let x = 0; x < width; x += 1) {
      if (labels[y * width + x] !== hull.label) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }

  // Nothing of the hull at the waterline at all - an outline open at the bottom,
  // or a boat drawn as a thin crescent. Its full width is the honest answer.
  if (max < min) return { left: hull.minX / width, right: (hull.maxX + 1) / width };

  return { left: min / width, right: (max + 1) / width };
}

/**
 * The drawing's silhouette as a 1-bit mask, sampled down.
 *
 * Returns null when the image has no size yet, which happens if this is reached
 * before the picture has loaded.
 */
function readAlpha(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return null;

  const scale = Math.min(1, SAMPLE_WIDTH / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);

  let solid = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (data[i * 4 + 3] >= ALPHA_FLOOR) {
      mask[i] = 1;
      solid += 1;
    }
  }

  return solid ? { mask, width: w, height: h } : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
