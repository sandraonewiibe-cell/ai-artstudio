/**
 * No 3D generation. The default.
 *
 * The kiosk runs exactly as it did before this pipeline existed: the boat is
 * extracted, generated and sailed as a flat drawing on the wall. Set MODEL3D to
 * a provider to turn generation on.
 */
module.exports = {
  name: 'none',

  async generate() {
    return null;
  },
};
