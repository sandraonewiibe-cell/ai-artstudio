/**
 * Tesseract OCR engine.
 *
 * Runs locally with no API key. Note that Tesseract is trained on printed
 * text - it reads block capitals reasonably and cursive handwriting poorly.
 * Swapping in a hosted vision model later means adding one file here.
 *
 * The worker is created once and reused; the first call downloads the English
 * traineddata (~15MB), so warmup() is called at server start to get that out
 * of the way before the first visitor.
 *
 * A drawing is not text, but Tesseract will still try to read it, and hull
 * curves and mast lines come back as strings like `~|/\_` or `Ss`. Three
 * filters keep that noise off the screen:
 *   1. a character whitelist, so symbols are never emitted at all;
 *   2. a per-word confidence floor;
 *   3. a plausibility test that drops words which are mostly punctuation.
 */

// Letters, digits, and the handful of marks a boat name might genuinely use.
const CHAR_WHITELIST =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .'-&";

// Discard words the engine is not reasonably sure about. Stroke noise usually
// scores low, so this does most of the work.
const MIN_WORD_CONFIDENCE = Number(process.env.OCR_MIN_CONFIDENCE) || 70;

// Short fragments are almost always a piece of the drawing, or the first two
// letters of a word the engine gave up on - "Ka" out of "Kawlath". Showing a
// truncated name is worse than showing none, so the floor is three.
const MIN_WORD_LENGTH = Number(process.env.OCR_MIN_WORD_LENGTH) || 3;

// A real word is mostly letters and digits, not slashes and pipes.
const MIN_ALNUM_RATIO = 0.6;

// Reject the whole result if there is barely anything left.
const MIN_TOTAL_ALNUM = 3;

let workerPromise = null;
let disabled = false;

async function getWorker() {
  if (disabled) return null;

  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      const worker = await createWorker('eng');

      // Symbols the whitelist excludes are never produced, which removes most
      // of the drawing-as-text noise at source.
      await worker.setParameters({ tessedit_char_whitelist: CHAR_WHITELIST });

      return worker;
    })().catch((err) => {
      console.warn('[ocr] Tesseract unavailable, continuing without OCR:', err.message);
      disabled = true;
      workerPromise = null;
      return null;
    });
  }

  return workerPromise;
}

/** True if a recognised word looks like writing rather than stroke noise. */
function isPlausibleWord(word) {
  const text = (word.text || '').trim();
  if (text.length < MIN_WORD_LENGTH) return false;

  const alnum = (text.match(/[A-Za-z0-9]/g) || []).length;
  if (alnum === 0) return false;

  return alnum / text.length >= MIN_ALNUM_RATIO;
}

module.exports = {
  name: 'tesseract',

  async warmup() {
    const worker = await getWorker();
    if (worker) console.log('[ocr] Tesseract ready.');
  },

  /**
   * @param {Buffer} buffer PNG of the drawing area.
   * @returns {Promise<{text: string|null, confidence: number}>}
   */
  async read(buffer) {
    const worker = await getWorker();
    if (!worker) return { text: null, confidence: 0 };

    try {
      const { data } = await worker.recognize(buffer);

      const words = (data.words || [])
        .filter((w) => w.confidence >= MIN_WORD_CONFIDENCE)
        .filter(isPlausibleWord);

      if (!words.length) return { text: null, confidence: 0 };

      // Preserve what was recognised verbatim; only collapse whitespace so it
      // fits on one line of the display screen.
      const text = words.map((w) => w.text.trim()).join(' ').replace(/\s+/g, ' ').trim();

      const alnum = (text.match(/[A-Za-z0-9]/g) || []).length;
      if (alnum < MIN_TOTAL_ALNUM) return { text: null, confidence: 0 };

      const confidence =
        words.reduce((sum, w) => sum + w.confidence, 0) / words.length / 100;

      return { text, confidence };
    } catch (err) {
      console.warn('[ocr] recognition failed:', err.message);
      return { text: null, confidence: 0 };
    }
  },
};
