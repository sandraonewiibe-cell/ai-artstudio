/**
 * Fallback classifier: treats every drawing as a boat.
 *
 * Used when the configured classifier cannot be loaded, so a misconfiguration
 * degrades to "show everything" rather than rejecting every visitor.
 */
module.exports = {
  name: 'accept-all',

  async classify() {
    return { isBoat: true, confidence: 0, label: 'unchecked' };
  },
};
