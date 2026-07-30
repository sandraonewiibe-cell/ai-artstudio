const config = require('../config');
const { assertProvider } = require('./base');

/**
 * Loads the image provider named in config.
 *
 * To add a real one: create `server/providers/<name>.js` exporting
 * { name, async generateBoat({ drawing, paper, text }) }, then run with
 * IMAGE_PROVIDER=<name>. No other file needs to change.
 *
 * @returns {import('./base').ImageProvider}
 */
function loadProvider() {
  const id = config.provider;

  let mod;
  try {
    mod = require(`./${id}`);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(`./${id}`)) {
      throw new Error(
        `Unknown image provider "${id}". Expected server/providers/${id}.js to exist.`
      );
    }
    throw err;
  }

  return assertProvider(mod, id);
}

module.exports = { loadProvider };
