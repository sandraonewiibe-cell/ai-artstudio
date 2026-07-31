const config = require('../config');
const { assertModel3D } = require('./base');

/**
 * Loads the image-to-3D provider named in config.
 *
 * To add one: create server/models3d/<name>.js exporting
 * { name, async generate({ buffer, mime, text, faces, texture }) }, then run
 * with MODEL3D=<name>. Nothing else in the application changes - the pipeline
 * only knows this interface.
 *
 * A provider that cannot be loaded falls back to none, because a misconfigured
 * 3D stage must not cost a visitor their boat.
 */
function loadModel3D() {
  const id = config.model3d;

  try {
    return assertModel3D(require(`./${id}`), id);
  } catch (err) {
    console.warn(`[3d] could not load provider "${id}" (${err.message}); generation is off.`);
    return require('./none');
  }
}

module.exports = { loadModel3D };
