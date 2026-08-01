/**
 * Stage 2 - exact line and colour extraction.
 *
 * What is in the drawing: the outline, the handwriting, the crayon, the grain
 * of the pencil, the wobble of a hand that has not drawn many boats. All of it
 * is already settled by the time the server sees it, in client/js/extract.js,
 * which white-balances the page against the paper, tells ink from colour, keeps
 * the child's own strokes and leaves blank paper blank.
 *
 * So this stage adds nothing to the pixels. It exists because the pipeline has
 * to be able to say, at this point, that the artwork is exactly what was drawn
 * - and to be the one place that changes if that ever stops being true. A stage
 * that hands its input straight on is not a stage doing nothing; it is a stage
 * asserting something, and the assertion is checked in contract.js.
 *
 * If a future phase wants to sharpen a line or lift a colour, it happens here,
 * it sets `exact` false, and the change is visible in one file rather than
 * spread through whatever happened to be handling the buffer at the time.
 */
module.exports = {
  name: 'artwork',
  takes: 'Cutout',
  gives: 'Artwork',

  /**
   * @param {import('../contract').Cutout} cutout
   * @param {import('../contract').Context} context
   * @returns {Promise<import('../contract').Artwork|null>}
   */
  async run(cutout, context) {
    context.log('lines, colours and handwriting exactly as drawn');

    return {
      buffer: cutout.buffer,
      mime: cutout.mime,
      width: cutout.width,
      height: cutout.height,
      hasAlpha: cutout.hasAlpha,
      pixels: cutout.pixels,

      // Nothing here repaints the drawing. The contract checks it rather than
      // taking this word for it.
      exact: true,
    };
  },
};
