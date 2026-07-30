const config = require('../config');

/**
 * Loads the drawing classifier named in config. Classifiers expose:
 *   { name, classify({drawing, paper, text}): Promise<{isBoat, confidence, label}> }
 *
 * The classifier decides whether the visitor actually drew a boat. Only boats
 * reach the image provider, so a doodle never costs a generation.
 */
function loadClassifier() {
  const id = config.classifier;

  try {
    const mod = require(`./${id}`);
    if (typeof mod.classify !== 'function') {
      throw new Error(`Classifier "${id}" is missing classify().`);
    }
    return mod;
  } catch (err) {
    console.warn(`[classifier] could not load "${id}" (${err.message}); accepting everything.`);
    return require('./accept-all');
  }
}

module.exports = { loadClassifier };
