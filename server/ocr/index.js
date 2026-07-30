const config = require('../config');

/**
 * Loads the OCR engine named in config. Engines expose:
 *   { name, warmup(): Promise<void>, read(buffer): Promise<{text, confidence}> }
 *
 * OCR never blocks a session: if an engine fails to load, we fall back to the
 * null engine and the pipeline carries on with no text.
 */
function loadOcr() {
  const id = config.ocr;

  try {
    const mod = require(`./${id}`);
    if (typeof mod.read !== 'function') {
      throw new Error(`OCR engine "${id}" is missing read().`);
    }
    return mod;
  } catch (err) {
    console.warn(`[ocr] could not load engine "${id}" (${err.message}); using none.`);
    return require('./none');
  }
}

module.exports = { loadOcr };
