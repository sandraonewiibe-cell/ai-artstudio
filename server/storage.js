const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_URL_RE = /^data:(image\/[a-z+]+);base64,(.+)$/i;
const MEDIA_URL_RE = /^data:((?:image|video)\/[a-z0-9.+-]+)(?:;[^;,]*)*;base64,(.+)$/i;

/**
 * Decodes a `data:image/png;base64,...` string into a Buffer.
 * @returns {Buffer}
 */
function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('Expected a data URL string.');
  }

  const match = dataUrl.match(DATA_URL_RE);
  if (!match) {
    throw new Error('Malformed image data URL.');
  }

  return Buffer.from(match[2], 'base64');
}

/**
 * Same, but also accepts video - MediaRecorder produces types like
 * `video/webm;codecs=vp9`, so the parameters have to be tolerated.
 *
 * @returns {{buffer: Buffer, mime: string, ext: string}}
 */
function decodeMediaDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('Expected a data URL string.');
  }

  const match = dataUrl.match(MEDIA_URL_RE);
  if (!match) {
    throw new Error('Malformed media data URL.');
  }

  const mime = match[1].toLowerCase();
  const ext = mime.split('/')[1].replace(/[^a-z0-9]/g, '') || 'bin';

  return { buffer: Buffer.from(match[2], 'base64'), mime, ext };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Writes a buffer and returns both the absolute path and the URL the client
 * can fetch it from.
 *
 * @param {'uploads'|'images'|'videos'|'media'} kind
 * @param {string} filename
 * @param {Buffer} buffer
 */
function save(kind, filename, buffer) {
  const dir = config.paths[kind];
  if (!dir) throw new Error(`Unknown storage kind "${kind}".`);

  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);

  const urlBase = URL_BASE[kind] || `/generated/${kind}`;
  return { path: filePath, url: `${urlBase}/${filename}` };
}

/** Where each kind is served from. Anything else lives under /generated. */
const URL_BASE = {
  uploads: '/uploads',
  media: '/media',
};

/**
 * Deletes files older than the configured retention window. An exhibition
 * running all day produces a capture plus two renders per visitor, so without
 * this the disk fills quietly.
 */
function sweepOldFiles() {
  const hours = config.fileRetentionHours;
  if (!hours) return 0;

  const cutoff = Date.now() - hours * 3600 * 1000;
  let removed = 0;

  ['uploads', 'images', 'videos'].forEach((kind) => {
    const dir = config.paths[kind];
    if (!fs.existsSync(dir)) return;

    fs.readdirSync(dir).forEach((entry) => {
      if (entry === '.gitkeep') return;

      const filePath = path.join(dir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed += 1;
        }
      } catch {
        /* file vanished between readdir and stat - ignore */
      }
    });
  });

  if (removed) console.log(`[storage] swept ${removed} file(s) older than ${hours}h.`);
  return removed;
}

module.exports = { decodeDataUrl, decodeMediaDataUrl, save, sweepOldFiles, ensureDir };
