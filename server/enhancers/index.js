const config = require('../config');
const { assertEnhancer } = require('./base');

/**
 * Loads the enhancer named in config.
 *
 * Falls back to leaving the drawing alone rather than failing a session: a
 * missing or broken enhancer should cost a bit of polish, not the visitor's
 * boat.
 *
 * @returns {import('./base').Enhancer}
 */
function loadEnhancer() {
  const id = config.enhancer;

  try {
    return assertEnhancer(require(`./${id}`), id);
  } catch (err) {
    console.warn(`[enhance] could not load "${id}" (${err.message}); passing the drawing through.`);
    return require('./passthrough');
  }
}

module.exports = { loadEnhancer };
