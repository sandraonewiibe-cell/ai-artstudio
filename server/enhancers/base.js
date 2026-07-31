/**
 * What an image enhancer has to look like.
 *
 * Step one of the 3D pipeline: tidy the scan before it is handed to a model.
 * It takes the visitor's drawing whole and returns an image of the same scene -
 * it is not allowed to crop it, cut parts out of it, or return anything but a
 * picture of the same drawing.
 *
 * The default does nothing at all, which is the honest default: "clean it up"
 * and "preserve every pixel of what they drew" pull in opposite directions, and
 * of the two, keeping the visitor's drawing is the one that matters here.
 *
 * @typedef {object} Enhanced
 * @property {Buffer} buffer
 * @property {string} mime
 *
 * @typedef {object} Enhancer
 * @property {string} name
 * @property {(input: Enhanced) => Promise<Enhanced>} enhance
 */

/** @param {Enhancer} mod */
function assertEnhancer(mod, id) {
  if (!mod || typeof mod.enhance !== 'function') {
    throw new Error(`Enhancer "${id}" must export enhance().`);
  }

  return mod;
}

/** @param {Enhanced} result */
function assertEnhanced(result, id) {
  if (!result || !Buffer.isBuffer(result.buffer) || !result.buffer.length) {
    throw new Error(`Enhancer "${id}" returned no image.`);
  }

  return result;
}

module.exports = { assertEnhancer, assertEnhanced };
