/**
 * ImageProvider interface for AI ART STUDIO.
 *
 * A provider is a plain object exposing `name` and `generateBoat()`. Nothing
 * outside server/providers/ may talk to an AI service directly - the pipeline
 * only ever sees this shape, so plugging in OpenAI, Replicate, Gemini, Runway
 * or anything else means adding one file and changing IMAGE_PROVIDER.
 *
 * Payloads are Buffers in, Buffer out. Providers never touch the filesystem;
 * storage.js owns that.
 *
 * @typedef {Object} GenerateInput
 * @property {Buffer} drawing   Transparent PNG of the extracted boat drawing (ink only).
 * @property {Buffer} paper     PNG of the full perspective-corrected sheet.
 * @property {string|null} text Text OCR read from the page, or null.
 *
 * @typedef {Object} GenerateResult
 * @property {Buffer} buffer
 * @property {string} ext          File extension without the dot, e.g. 'png'.
 * @property {boolean} transparent True if the background is genuinely transparent.
 *                                 False means the provider returned a solid
 *                                 background that a later version can key out.
 * @property {boolean} [standIn]   True if this is a development placeholder
 *                                 rather than a generated boat. Reported to
 *                                 the client for diagnostics only - the
 *                                 display renders every result identically,
 *                                 with no filtering, so the visitor's colours
 *                                 are shown exactly as drawn.
 *
 * @typedef {Object} ImageProvider
 * @property {string} name
 * @property {(input: GenerateInput) => Promise<GenerateResult>} generateBoat
 */

/**
 * Throws if an object does not satisfy the contract. Called at startup so a
 * misconfigured provider fails immediately rather than on the first visitor.
 *
 * @param {*} provider
 * @param {string} id
 * @returns {ImageProvider}
 */
function assertProvider(provider, id) {
  if (!provider || typeof provider !== 'object') {
    throw new Error(`Image provider "${id}" did not export an object.`);
  }

  if (typeof provider.generateBoat !== 'function') {
    throw new Error(`Image provider "${id}" is missing required method generateBoat().`);
  }

  return provider;
}

/**
 * Normalises whatever a provider returned, so a sloppy implementation cannot
 * break the pipeline downstream.
 *
 * @param {*} result
 * @param {string} id
 * @returns {GenerateResult}
 */
function assertResult(result, id) {
  if (!result || !Buffer.isBuffer(result.buffer) || result.buffer.length === 0) {
    throw new Error(`Image provider "${id}" returned no image data.`);
  }

  return {
    buffer: result.buffer,
    ext: result.ext || 'png',
    transparent: result.transparent === true,
    standIn: result.standIn === true,
  };
}

module.exports = { assertProvider, assertResult };
