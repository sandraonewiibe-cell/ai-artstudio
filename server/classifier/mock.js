/**
 * MockClassifier - development stand-in.
 *
 * It cannot actually tell a boat from a bicycle; that needs a vision model.
 * What it does is exercise the accept and reject paths so the kiosk's
 * behaviour on both can be tested before a real classifier is plugged in.
 *
 * Set MOCK_CLASSIFIER=reject to make every drawing fail the check, or
 * MOCK_CLASSIFIER=alternate to flip on each visitor.
 */

const MODE = process.env.MOCK_CLASSIFIER || 'accept';

let counter = 0;

module.exports = {
  name: 'mock',

  async classify({ drawing }) {
    counter += 1;

    // Nothing was extracted from the page - there is no drawing to judge.
    if (!drawing || !drawing.length) {
      return { isBoat: false, confidence: 1, label: 'empty' };
    }

    if (MODE === 'reject') {
      return { isBoat: false, confidence: 0.9, label: 'not-a-boat' };
    }

    if (MODE === 'alternate') {
      const isBoat = counter % 2 === 1;
      return { isBoat, confidence: 0.9, label: isBoat ? 'boat' : 'not-a-boat' };
    }

    return { isBoat: true, confidence: 0.5, label: 'boat' };
  },
};
