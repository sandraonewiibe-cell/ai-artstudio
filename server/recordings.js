const QRCode = require('qrcode');

const config = require('./config');
const storage = require('./storage');
const events = require('./events');
const { publicBase } = require('./network');

/**
 * Screen recordings of the display page.
 *
 * The display records its own canvas while the boat is on screen and posts the
 * result here. The QR page then offers the newest one for download.
 */

/** @type {object|null} */
let latest = null;

/** Recent recordings, newest first, so a visitor is not rushed off the QR. */
const history = [];
const HISTORY_LIMIT = 20;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Saves a recording posted by the display page.
 *
 * @param {{jobId?: string, text?: string|null, data: string}} payload
 * @returns {object} the stored record
 */
function save(payload) {
  const { buffer, mime, ext } = storage.decodeMediaDataUrl(payload.data);

  if (!buffer.length) throw new Error('Recording was empty.');

  const id = `${stamp()}-${(payload.jobId || 'session').slice(0, 8)}`;
  const saved = storage.save('videos', `${id}.${ext}`, buffer);

  const record = {
    id,
    url: saved.url,
    mime,
    bytes: buffer.length,
    text: payload.text || null,
    createdAt: Date.now(),
  };

  latest = record;
  history.unshift(record);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;

  events.broadcast('recording', { recording: present(record) });

  console.log(`[recordings] saved ${record.id} (${Math.round(record.bytes / 1024)}KB)`);

  return present(record);
}

/**
 * Adds the download link, worked out now rather than when the file was saved.
 *
 * It has to be late-bound: a tunnel can come up, drop or change its address
 * after a recording exists, and a link baked in at save time would still point
 * at whatever was true then - usually a LAN address the phone cannot reach.
 */
function present(record) {
  if (!record) return null;
  return { ...record, downloadUrl: `${publicBase(config.port)}${record.url}` };
}

function getLatest() {
  return present(latest);
}

function get(id) {
  return present(history.find((r) => r.id === id) || null);
}

/**
 * QR code for a URL, as a PNG buffer. Rendered server-side so the QR page
 * needs no library of its own.
 *
 * @param {string} text
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
function qrPng(text, size = 640) {
  return QRCode.toBuffer(text, {
    type: 'png',
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
}

module.exports = { save, getLatest, get, qrPng };
