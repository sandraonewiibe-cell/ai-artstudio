/**
 * MockProvider - development stand-in for a real image service.
 *
 * It returns the visitor's extracted drawing unchanged, as a transparent PNG,
 * which is exactly the shape a real provider is expected to return. It also
 * imitates the latency of a real service (a few seconds) so the loading screen
 * and the job timeout get exercised during development rather than on the day.
 */

// Small on purpose. This existed to imitate a real service so the loading
// screen got exercised, but it is pure dead time for a visitor standing at the
// kiosk. Raise it when you want to rehearse how a slow provider feels.
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 150);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  name: 'mock',

  /**
   * @param {import('./base').GenerateInput} input
   * @returns {Promise<import('./base').GenerateResult>}
   */
  async generateBoat({ drawing, paper }) {
    await delay(DELAY_MS);

    // The extracted drawing already has a transparent background, so it drops
    // straight onto the black display screen the way a real result would.
    if (drawing && drawing.length) {
      return { buffer: drawing, ext: 'png', transparent: true, standIn: true };
    }

    return { buffer: paper, ext: 'png', transparent: false, standIn: true };
  },
};
