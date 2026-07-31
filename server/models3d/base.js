/**
 * What an image-to-3D provider has to look like.
 *
 * Step two: one picture of the visitor's whole drawing in, one GLB out. The
 * drawing is never taken apart for this - no hull, no paddles, no canopy, no
 * pieces of any kind. The model is given the sketch as the visitor made it and
 * asked for one object back.
 *
 * Returning null is a normal answer meaning "no model this time". It is what
 * the default does, and what a provider should do rather than throw when it is
 * simply not configured.
 *
 * @typedef {object} SculptInput
 * @property {Buffer} buffer  the whole drawing
 * @property {string} mime
 * @property {string|null} text  the name read off the page, if any
 * @property {number} faces  face budget for the mesh
 * @property {boolean} texture  whether to ask for a textured model
 *
 * @typedef {object} Sculpted
 * @property {Buffer} buffer
 * @property {string} ext
 *
 * @typedef {object} Model3D
 * @property {string} name
 * @property {(input: SculptInput) => Promise<Sculpted|null>} generate
 */

/** @param {Model3D} mod */
function assertModel3D(mod, id) {
  if (!mod || typeof mod.generate !== 'function') {
    throw new Error(`3D provider "${id}" must export generate().`);
  }

  return mod;
}

/** @param {Sculpted|null} result */
function assertSculpted(result, id) {
  if (result === null) return null;

  if (!result || !Buffer.isBuffer(result.buffer) || !result.buffer.length) {
    throw new Error(`3D provider "${id}" returned no model.`);
  }

  return { buffer: result.buffer, ext: result.ext || 'glb' };
}

module.exports = { assertModel3D, assertSculpted };
