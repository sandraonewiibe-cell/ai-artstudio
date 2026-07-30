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

  paths: {
    root: ROOT,
    client: path.join(ROOT, 'client'),
    assets: path.join(ROOT, 'assets'),
    uploads: path.join(ROOT, 'uploads'),
    images: path.join(ROOT, 'generated', 'images'),
    videos: path.join(ROOT, 'generated', 'videos'), // reserved for a later version
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
  },
};
