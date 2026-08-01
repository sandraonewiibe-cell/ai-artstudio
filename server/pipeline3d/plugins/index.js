const config = require('../../config');
const { loadModel3D } = require('../../models3d');

/**
 * Optional image-to-3D services, hanging off the side of the pipeline.
 *
 * Replicate and Hugging Face Spaces can each turn the whole drawing into a GLB
 * in one call. That is useful and it is not the pipeline: one asks a model
 * somewhere else to make something resembling what a child drew, the other
 * builds a model from the drawing itself. Only the second can promise the
 * colours on the wall are the colours on the paper, which is the promise this
 * project is built on.
 *
 * So a plugin is a bypass. Where one is configured, it stands in for depth,
 * mesh and export together - it returns a finished model, so there is nothing
 * for those stages to do - and background removal and extraction still run in
 * front of it, because whatever is sent away should be the child's drawing and
 * not a photograph of a table.
 *
 * Nothing is configured by default. MODEL3D_PROVIDER=replicate or =huggingface
 * turns one on, and the adapters live where they always did, in server/models3d.
 */

const NONE = 'none';

/**
 * @returns {{name: string, active: boolean, generate: Function}|null}
 */
function loadPlugin() {
  const provider = loadModel3D();
  if (provider.name === NONE) return null;

  return {
    name: provider.name,
    active: true,

    /**
     * @param {import('../contract').Artwork} artwork
     * @param {import('../contract').Context} context
     * @returns {Promise<import('../contract').Model|null>}
     */
    async generate(artwork, context) {
      const sculpted = await provider.generate({
        buffer: artwork.buffer,
        mime: artwork.mime,
        text: context.text,
        faces: context.faces,
        texture: context.texture,
      });

      if (!sculpted) return null;

      return { buffer: sculpted.buffer, ext: sculpted.ext || 'glb', by: provider.name };
    },
  };
}

/** What to print at startup, so a misconfigured plugin is visible before a visitor finds it. */
function describePlugin() {
  const name = config.model3d;
  return name === NONE ? 'none (the pipeline builds its own)' : name;
}

module.exports = { loadPlugin, describePlugin };
