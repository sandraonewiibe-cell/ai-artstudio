const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Reads a numeric setting, treating unset and empty as "not configured".
 *
 * `Number(x) || fallback` would be wrong here: several of these settings use 0
 * to mean "off", and 0 is falsy, so an explicit 0 would silently become the
 * default it was meant to override.
 */
function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** '40mb' and the like, as a number. */
function bytes(size) {
  const match = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*$/i.exec(String(size));
  if (!match) return 0;

  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(Number(match[1]) * (units[(match[2] || 'b').toLowerCase()] || 1));
}

/**
 * The largest file the panel can actually put through an upload endpoint.
 *
 * Not the same as the limit itself. The panel sends a file as a base64 data
 * URL, and base64 is four bytes on the wire for every three of file, so a 40mb
 * ceiling on the request accepts a file of about 30MB. Worked out here rather
 * than left for somebody to discover when a 35MB video is rejected by a limit
 * that says 40.
 */
function largestFile(size) {
  const envelope = 512; // the JSON around it, and the data URL preamble
  return Math.max(0, Math.floor(((bytes(size) - envelope) * 3) / 4));
}

module.exports = {
  // A host assigns the port and passes it in; 3000 when running locally.
  port: Number(process.env.PORT) || 3000,

  /**
   * Whether this is a deployment rather than the kiosk machine.
   *
   * Only used to decide what the server is willing to say about itself: on a
   * public URL, diagnostics that are helpful next to the table become detail
   * about the host handed to anyone who asks.
   */
  isProduction: IS_PRODUCTION,

  /**
   * How many reverse proxies sit in front of this server.
   *
   * A deployment is reached through its host's router, so every request arrives
   * from the same internal address and the real client is named in
   * X-Forwarded-For. Without this, rate limiting sees one caller and would
   * throttle every visitor together.
   *
   * It is off locally because there is no proxy there, and trusting the header
   * when nothing sets it would let a caller pick their own identity and walk
   * around the limit.
   */
  trustProxy: num(process.env.TRUST_PROXY, IS_PRODUCTION ? 1 : 0),

  /**
   * Rate limits, per client address, per window.
   *
   * A public URL means the two POST endpoints can be called by anyone, not just
   * the screen by the table. The ceilings are set well above what a kiosk does
   * - one visitor produces one session and one recording every couple of
   * minutes - so they bite only on abuse, not on use. 0 disables a limit.
   */
  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
    sessions: num(process.env.RATE_LIMIT_SESSIONS, 12),
    recordings: num(process.env.RATE_LIMIT_RECORDINGS, 20),

    // The panel is one person clicking save, so this is generous for them and
    // still a ceiling on anyone who finds the upload endpoint.
    admin: num(process.env.RATE_LIMIT_ADMIN, 60),
  },

  /**
   * Which address to bind to.
   *
   * 0.0.0.0 means every interface, which is what a hosted container needs - its
   * router reaches the process from outside, so a server bound to 127.0.0.1
   * would look dead and fail the health check. It is also what makes the kiosk
   * reachable from a phone on the LAN, so the same default serves both.
   *
   * Set HOST=127.0.0.1 to keep a local run off the network entirely.
   */
  host: process.env.HOST || '0.0.0.0',

  // Which image provider to load from server/providers/.
  // 'mock' during development; swap for a real one without touching pipeline code.
  provider: process.env.IMAGE_PROVIDER || 'mock',

  // Which OCR engine to load from server/ocr/. 'tesseract' | 'none'.
  ocr: process.env.OCR_ENGINE || 'tesseract',

  /**
   * Tunnel provider, making the kiosk reachable from outside its own network so
   * a QR code works from a phone on mobile data. Empty for LAN only.
   *
   * 'ssh'         - localhost.run over the built-in OpenSSH client. Nothing to
   *                 install; free relays are not guaranteed to stay up.
   * 'cloudflared' - needs the cloudflared binary, and is what to use for a real
   *                 all-day exhibition.
   */
  tunnel: process.env.TUNNEL || '',

  /**
   * What the outside world may touch when a tunnel is open.
   *
   * A tunnel exposes the whole server, scanner and API included, to anyone with
   * the address. 'downloads' narrows that to reading the finished clips, which
   * is all a visitor's phone needs.
   */
  publicAccess: process.env.PUBLIC_ACCESS || 'downloads',

  // Which drawing classifier to load from server/classifier/.
  // Decides whether the visitor drew a boat; only boats reach the provider.
  classifier: process.env.CLASSIFIER || 'mock',

  /**
   * Password for /admin, if there is to be one.
   *
   * Unset means the panel is open, which is right on a kiosk on a table with
   * nobody else on the network. Set it the moment the kiosk is reachable from
   * outside: the panel writes files to disk, and an upload endpoint anyone can
   * reach is an upload endpoint anyone will find.
   *
   * Reading the settings is never gated - the display screen needs them.
   */
  adminToken: process.env.ADMIN_TOKEN || '',

  paths: {
    root: ROOT,
    client: path.join(ROOT, 'client'),
    assets: path.join(ROOT, 'assets'),
    uploads: path.join(ROOT, 'uploads'),
    images: path.join(ROOT, 'generated', 'images'),
    videos: path.join(ROOT, 'generated', 'videos'), // reserved for a later version

    // Logos and advertisements, and the settings that point at them. Both sit
    // outside the folders the retention sweep clears: a visitor's capture is a
    // leftover after a day, an organiser's logo is not.
    media: path.join(ROOT, 'media'),
    data: path.join(ROOT, 'data'),
  },

  // A visitor's generation must finish inside this window or the job fails and
  // the kiosk returns to scanning rather than hanging.
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS) || 120000,

  // Finished jobs are dropped from memory after this long.
  jobRetentionMs: Number(process.env.JOB_RETENTION_MS) || 30 * 60 * 1000,

  // Files older than this are deleted on a periodic sweep, so an all-day
  // exhibition does not fill the disk. 0 disables the sweep.
  fileRetentionHours: Number(process.env.FILE_RETENTION_HOURS) || 48,

  /**
   * Largest accepted payload, per endpoint (base64 PNGs and video are bulky).
   *
   * Split in two so the body parser can be mounted on the two routes that read
   * a body rather than on everything. A limit that applies to every path is
   * also an invitation to send that much to any path, including ones that do
   * not exist.
   *
   * Both keep the previous 30mb default, so nothing that worked stops working;
   * MAX_UPLOAD_SIZE still sets both at once.
   */
  uploads: {
    session:
      process.env.MAX_SESSION_UPLOAD_SIZE || process.env.MAX_UPLOAD_SIZE || '30mb',
    recording:
      process.env.MAX_RECORDING_UPLOAD_SIZE || process.env.MAX_UPLOAD_SIZE || '30mb',

    // A logo is small; an advertisement or a background can be a video.
    media: process.env.MAX_MEDIA_UPLOAD_SIZE || '40mb',

    // The settings themselves are a few hundred bytes of JSON. Nothing that
    // arrives at that endpoint has any business being larger.
    settings: '256kb',
  },

  /**
   * The largest file the panel can upload, in bytes.
   *
   * Told to the panel so it can say so up front and turn a file away with a
   * useful message, rather than sending thirty megabytes to be met with a 413.
   */
  largestUpload: largestFile(process.env.MAX_MEDIA_UPLOAD_SIZE || '40mb'),
};
