/**
 * The enhancer that changes nothing.
 *
 * The brief for this pipeline asks for the drawing to be cleaned up and for a
 * hundred per cent of the design, the colours, the handwriting and the
 * silhouette to survive. Those are not both possible, and between them it is
 * the visitor's drawing that matters - so the default is to touch nothing and
 * let the extraction's own output go forward as it is.
 *
 * Swap it with ENHANCER=<name> once there is something worth running here. Any
 * replacement gets the whole drawing and must return the whole drawing.
 */
module.exports = {
  name: 'passthrough',

  /**
   * @param {import('./base').Enhanced} input
   * @returns {Promise<import('./base').Enhanced>}
   */
  async enhance(input) {
    return input;
  },
};
