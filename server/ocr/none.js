/**
 * Null OCR engine. Always reports "no text found", which the pipeline treats
 * as a normal outcome. Use OCR_ENGINE=none to run the kiosk without OCR.
 */
module.exports = {
  name: 'none',
  async warmup() {},
  async read() {
    return { text: null, confidence: 0 };
  },
};
