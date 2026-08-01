const config = require('../../config');
const { decode } = require('../png');

/**
 * Stage 3 - depth.
 *
 * How far every point of the drawing stands off the page, worked out from the
 * shape the child drew and nothing else.
 *
 * The method is a distance transform. For each pixel inside the silhouette,
 * find how far it is from the nearest point outside it; the middle of a shape is
 * far from any edge and stands proudest, the rim is at zero and lies flat on the
 * page. That is the whole idea, and it is worth saying why it is the right one
 * here: it asks only "how far in is this", which every drawing can answer. A
 * boat, a flower, a house and a dog all inflate sensibly under it, because none
 * of them had to be recognised first.
 *
 * Deterministic, and deliberately so. The same drawing gives the same field
 * every time, there is no model and no network, and the only thing the geometry
 * can be traced back to is the outline on the paper. Nothing here reads meaning
 * out of the drawing - no deciding this shape is a hull and that one a sail -
 * because a pipeline that starts recognising boats starts drawing boats, and the
 * drawing is the child's.
 *
 * The exact distance is not needed and is expensive; a chamfer approximation is
 * two passes over the image and is within about two percent of the truth, which
 * is far below the point at which a height field looks any different.
 */

// Chamfer weights: 3 for a step along an axis, 4 for a diagonal. The pair
// approximates the ratio of 1 to root two, which is the reason for the odd
// numbers - the field is divided back down by 3 at the end.
const ORTHOGONAL = 3;
const DIAGONAL = 4;

module.exports = {
  name: 'depth',
  takes: 'Artwork',
  gives: 'DepthField',

  /**
   * @param {import('../contract').Artwork} artwork
   * @param {import('../contract').Context} context
   * @returns {Promise<import('../contract').DepthField|null>}
   */
  async run(artwork, context) {
    // Alpha is what says where the drawing ends; without it there is no
    // silhouette to raise, and a height field built from an opaque rectangle
    // would model the rectangle. Background removal records the fact and passes
    // it on rather than refusing - a plugin does not need alpha, and neither
    // does a session that fell back to the photograph of the page.
    if (!artwork.hasAlpha) {
      context.log('no silhouette in the drawing - there would be nothing to raise');
      return null;
    }

    const { alphaThreshold, profile, thickness, maxWidth } = config.depth;

    // Background removal has already decoded this PNG. Decoding it again would
    // be a tenth of a second spent arriving at the same pixels.
    const image = artwork.pixels
      ? { width: artwork.width, height: artwork.height, data: artwork.pixels }
      : decode(artwork.buffer);
    const { mask, width, height, step } = silhouette(image, alphaThreshold, maxWidth);

    const inside = mask.reduce((n, v) => n + v, 0);
    if (!inside) {
      context.log('the drawing is entirely transparent');
      return null;
    }

    const distance = chamfer(mask, width, height);

    // The deepest point of the shape sets the scale, so a thin drawing and a
    // round one both come out the thickness they were asked for rather than the
    // thin one coming out flat.
    let deepest = 0;
    for (let i = 0; i < distance.length; i += 1) if (distance[i] > deepest) deepest = distance[i];

    if (!deepest) {
      context.log('the silhouette is too thin to have an inside');
      return null;
    }

    // Normalised, then curved. An exponent below one rounds off quickly at the
    // rim and flattens across the middle, which reads as a solid with a soft
    // edge rather than a cone or a tent.
    const values = new Float32Array(distance.length);
    for (let i = 0; i < distance.length; i += 1) {
      values[i] = distance[i] > 0 ? Math.pow(distance[i] / deepest, profile) : 0;
    }

    context.log(
      `${width}x${height}${step > 1 ? ` (1 in ${step} of ${image.width}x${image.height})` : ''}, ` +
        `${Math.round((inside / (width * height)) * 100)}% drawn, deepest point ${(deepest / ORTHOGONAL).toFixed(0)}px in`
    );

    return { values, width, height, scale: thickness };
  },
};

/**
 * The silhouette, as a 0/1 mask, at a size worth working at.
 *
 * A scan can be several megapixels and the height field gains nothing from the
 * last of them - the mesh samples it on a far coarser grid anyway - so a big
 * drawing is stepped down by a whole number. A whole number rather than a
 * resample: taking every nth pixel cannot invent a boundary that was not there,
 * and the silhouette is the one thing that must not shift.
 */
function silhouette(image, alphaThreshold, maxWidth) {
  const step = Math.max(1, Math.ceil(image.width / maxWidth));
  const width = Math.floor(image.width / step);
  const height = Math.floor(image.height / step);
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((y * step) * image.width + x * step) * 4;
      mask[y * width + x] = image.data[from + 3] >= alphaThreshold ? 1 : 0;
    }
  }

  return { mask, width, height, step };
}

/**
 * Distance from each pixel inside the shape to the nearest one outside it.
 *
 * Two passes, forwards then backwards. Every pixel takes the cheapest route to
 * the outside through a neighbour already settled, which after both directions
 * is the cheapest route there is.
 *
 * Off the edge of the image counts as outside. A drawing that runs to the border
 * would otherwise be treated as continuing past it and would inflate as though
 * it were the middle of something larger.
 */
function chamfer(mask, width, height) {
  const far = 0x7fffffff;
  const distance = new Int32Array(width * height);

  for (let i = 0; i < distance.length; i += 1) distance[i] = mask[i] ? far : 0;

  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : distance[y * width + x]);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;

      const best = Math.min(
        distance[i],
        at(x - 1, y) + ORTHOGONAL,
        at(x, y - 1) + ORTHOGONAL,
        at(x - 1, y - 1) + DIAGONAL,
        at(x + 1, y - 1) + DIAGONAL
      );

      distance[i] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (!mask[i]) continue;

      const best = Math.min(
        distance[i],
        at(x + 1, y) + ORTHOGONAL,
        at(x, y + 1) + ORTHOGONAL,
        at(x + 1, y + 1) + DIAGONAL,
        at(x - 1, y + 1) + DIAGONAL
      );

      distance[i] = best;
    }
  }

  return distance;
}
