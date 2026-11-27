const path = require('path');
const express = require('express');

const config = require('./config');
const storage = require('./storage');
const pipeline = require('./pipeline');
const events = require('./events');
const recordings = require('./recordings');
const ratelimit = require('./ratelimit');
const settings = require('./settings');
const { publicBase, candidates } = require('./network');

const app = express();

// Behind a host's router the connection comes from the proxy, not the visitor.
// Rate limiting needs to tell callers apart, so the forwarded address has to be
// trusted - but only where a proxy is actually in front. See config.trustProxy.
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

// Express advertises itself in a header on every response. Nothing needs to
// know which server software this is, or that there is an Express version here
// worth looking up.
app.disable('x-powered-by');

/**
 * Body parsing and rate limiting, mounted per route rather than globally.
 *
 * Only two endpoints read a body, and both accept a large one. Parsing that
 * generously on every path would let any URL - including ones with no handler -
 * be used to push megabytes at the process.
 *
 * The limiter runs *before* the parser on each route, so a caller past their
 * ceiling is turned away without the payload being read into memory first.
 */
const sessionBody = express.json({ limit: config.uploads.session });
const recordingBody = express.json({ limit: config.uploads.recording });

const sessionLimit = ratelimit.limit({
  name: 'sessions',
  max: config.rateLimit.sessions,
  windowMs: config.rateLimit.windowMs,
});

const recordingLimit = ratelimit.limit({
  name: 'recordings',
  max: config.rateLimit.recordings,
  windowMs: config.rateLimit.windowMs,
});

const settingsBody = express.json({ limit: config.uploads.settings });
const mediaBody = express.json({ limit: config.uploads.media });

const adminLimit = ratelimit.limit({
  name: 'admin',
  max: config.rateLimit.admin,
  windowMs: config.rateLimit.windowMs,
});

/**
 * Guards the endpoints that write.
 *
 * Open when no token is configured, which is what a kiosk on its own table
 * wants - there is nobody to type a password and nobody who could reach it.
 * The moment ADMIN_TOKEN is set, saving settings and uploading media need it.
 * Reading is never gated: the display screen has to be able to fetch what it
 * is meant to show.
 */
function adminOnly(req, res, next) {
  if (!config.adminToken) return next();

  const given = req.get('X-Admin-Token');
  if (given === config.adminToken) return next();

  return res.status(401).json({ error: 'Admin token required.' });
}

// --- pages ------------------------------------------------------------------
// Three screens, three URLs:
//   /         scanner   - the camera, on the machine by the table
//   /display  LED wall  - background video, and the boat when one arrives
//   /qr       QR code   - download the last recording

app.get('/display', (req, res) => {
  res.sendFile(path.join(config.paths.client, 'display.html'));
});

app.get('/qr', (req, res) => {
  res.sendFile(path.join(config.paths.client, 'qr.html'));
});

// ...and a fourth for whoever is running the exhibition, which no visitor sees.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(config.paths.client, 'admin.html'));
});

app.use(express.static(config.paths.client));

// Static asset / output folders
app.use('/assets', express.static(config.paths.assets));
app.use('/uploads', express.static(config.paths.uploads));
app.use('/media', express.static(config.paths.media));
app.use('/generated', express.static(path.join(config.paths.root, 'generated')));

// --- api --------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'AI ART STUDIO',
    ...pipeline.info,
    screens: events.clientCount(),
    publicBase: publicBase(config.port),

    // Every address a phone might reach, so a timeout can be diagnosed without
    // going to the machine.
    //
    // Left out of a deployment: there the addresses describe the inside of the
    // host's network rather than anything a visitor could use, and health is a
    // public endpoint, so it would be telling every caller about the host for
    // no one's benefit.
    ...(config.isProduction ? {} : { networks: candidates() }),
  });
});

/** Live channel that keeps the three screens in step. */
app.get('/api/events', (req, res) => {
  events.addClient(req, res);
});

/** Start a session from a capture. Returns a job id to poll. */
app.post('/api/sessions', sessionLimit, sessionBody, (req, res) => {
  try {
    if (!req.body || !req.body.paper) {
      return res.status(400).json({ error: 'Missing "paper" image.' });
    }

    const job = pipeline.createSession({
      paper: req.body.paper,
      drawing: req.body.drawing || null,
      layers: req.body.layers || null,
    });

    return res.status(202).json(job);
  } catch (err) {
    console.error('[server] session error:', err);
    return res.status(400).json({ error: err.message });
  }
});

/** Poll a session. */
app.get('/api/sessions/:id', (req, res) => {
  const job = pipeline.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown session.' });
  return res.json(job);
});

/** The display screen posts its recording here when playback finishes. */
app.post('/api/recordings', recordingLimit, recordingBody, (req, res) => {
  try {
    if (!req.body || !req.body.data) {
      return res.status(400).json({ error: 'Missing recording data.' });
    }

    return res.status(201).json(recordings.save(req.body));
  } catch (err) {
    console.error('[server] recording error:', err);
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/recordings/latest', (req, res) => {
  const record = recordings.getLatest();
  if (!record) return res.status(404).json({ error: 'No recording yet.' });
  return res.json(record);
});

// --- admin ------------------------------------------------------------------
// The logos on the wall and the advertisements between boats. None of this
// touches a session: the scanner, the reading, the generation and the QR run
// exactly as they did whether these are set or not.

/**
 * What the display should be showing. Read by the wall, so never gated.
 *
 * `limits` rides along for the panel's benefit - it caps the advertisement
 * list, and a cap nobody is told about is one that looks like a bug the first
 * time it silently drops somebody's twelfth upload. Saving ignores it.
 */
app.get('/api/settings', (req, res) => {
  res.json({
    ...settings.get(),
    limits: { ads: settings.MAX_ADS, uploadBytes: config.largestUpload },
  });
});

/**
 * Replaces the settings, and tells the screens at once.
 *
 * The broadcast is what makes the panel live: the display is already holding an
 * event stream open for boats, so a settings change reaches it on the same
 * connection and takes effect on the next frame. Nothing restarts.
 */
app.put('/api/settings', adminLimit, adminOnly, settingsBody, (req, res) => {
  try {
    const saved = settings.save(req.body);
    events.broadcast('settings', { settings: saved });

    console.log(
      `[admin] settings saved: logos ${describeLogos(saved)}, ` +
        `ads ${saved.ads.enabled ? `${saved.ads.items.length} item(s)` : 'off'}`
    );

    return res.json(saved);
  } catch (err) {
    console.error('[admin] could not save settings:', err);
    return res.status(500).json({ error: 'Could not save settings.' });
  }
});

/** Takes a logo or an advertisement and returns the URL to point at it. */
app.post('/api/media', adminLimit, adminOnly, mediaBody, (req, res) => {
  try {
    if (!req.body || !req.body.data) {
      return res.status(400).json({ error: 'Missing "data".' });
    }

    const { buffer, mime, ext } = storage.decodeMediaDataUrl(req.body.data);
    if (!buffer.length) return res.status(400).json({ error: 'That file was empty.' });

    // The name is ours, not the browser's: a filename from outside is a path
    // waiting to escape the folder it was meant for.
    const kinds = ['logo', 'ad', 'background'];
    const kind = kinds.includes(req.body.kind) ? req.body.kind : 'ad';
    const name = `${kind}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.${ext}`;

    const saved = storage.save('media', name, buffer);
    console.log(`[admin] stored ${name} (${Math.round(buffer.length / 1024)}KB)`);

    return res.status(201).json({
      url: saved.url,
      type: mime.startsWith('video/') ? 'video' : 'image',
      bytes: buffer.length,
    });
  } catch (err) {
    console.error('[admin] upload failed:', err);
    return res.status(400).json({ error: err.message });
  }
});

function describeLogos(saved) {
  const on = ['left', 'right'].filter((side) => saved.logos[side].enabled);
  return on.length ? on.join(' + ') : 'off';
}

/** QR code as a PNG, rendered server-side so the QR page needs no library. */
app.get('/api/qr', async (req, res) => {
  const text = req.query.data;
  if (!text) return res.status(400).json({ error: 'Missing "data".' });

  try {
    const size = Math.min(1200, Math.max(160, Number(req.query.size) || 640));
    const png = await recordings.qrPng(String(text), size);

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    return res.send(png);
  } catch (err) {
    console.error('[server] qr error:', err);
    return res.status(500).json({ error: 'Could not render QR code.' });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // A payload over the limit, or one that is not JSON at all, is the caller's
  // mistake and has to be answered as such. Reporting it as 500 would both
  // mislead the client and, under a flood, fill the log with stack traces for
  // something the server handled correctly.
  if (err.type === 'entity.too.large') {
    console.warn(`[server] rejected oversized ${req.method} ${req.path} (limit ${err.limit})`);
    return res.status(413).json({ error: 'Upload too large.' });
  }

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    console.warn(`[server] rejected malformed body on ${req.method} ${req.path}`);
    return res.status(400).json({ error: 'Malformed request body.' });
  }

  console.error('[server] unhandled error:', err);
  return res.status(500).json({ error: 'Internal error.' });
});

// Make sure output folders exist before the first visitor.
['uploads', 'images', 'videos', 'media', 'data'].forEach((kind) =>
  storage.ensureDir(config.paths[kind])
);

// Read the organiser's settings once at boot; saves keep it current after that.
settings.load();

const server = app.listen(config.port, config.host, () => {
  const base = publicBase(config.port);
  const configured = Boolean(process.env.PUBLIC_BASE_URL);

  console.log(`AI ART STUDIO listening on http://${config.host}:${config.port}`);
  console.log(`  environment:    ${process.env.NODE_ENV || 'development'}`);
  console.log(`  port:           ${config.port}`);
  console.log(`  base url:       ${base}  (${configured ? 'PUBLIC_BASE_URL' : 'detected'})`);
  console.log(`  qr target:      ${base}/generated/videos/<recording>`);
  console.log(`  scanner screen: ${base}/`);
  console.log(`  display screen: ${base}/display`);
  console.log(`  qr screen:      ${base}/qr`);
  console.log(`  image provider: ${pipeline.info.provider}`);
  console.log(`  ocr engine:     ${pipeline.info.ocr}`);
  console.log(`  classifier:     ${pipeline.info.classifier}`);

  // The QR code carries the first of these. If a phone cannot reach it, it is
  // on one of the others - set PUBLIC_HOST to whichever matches the network the
  // phones are on.
  //
  // None of it applies once PUBLIC_BASE_URL is set: the address is no longer
  // being guessed from this machine's interfaces, so printing them would only
  // point at the wrong thing.
  const reachable = configured ? [] : candidates();
  if (reachable.length > 1) {
    console.log('\n  this machine is on more than one network:');
    reachable.forEach((c, i) => {
      const tag = i === 0 ? '<- the QR code uses this' : '';
      console.log(`    ${c.address.padEnd(16)} ${c.interface.padEnd(22)} ${tag}`);
    });
    console.log('  if a phone times out, try:  set PUBLIC_HOST=<other address>');
  } else if (!configured && !reachable.length) {
    console.log('\n  no network address found - the QR code will not work from a phone');
  }

  pipeline.warmup();
  storage.sweepOldFiles();
});

// A recording arrives as one large request; give it room.
server.requestTimeout = 0;
server.headersTimeout = 0;

// Housekeeping for an unattended all-day run.
const sweeper = setInterval(() => {
  pipeline.sweepJobs();
  storage.sweepOldFiles();
}, 60 * 60 * 1000);
sweeper.unref();

// Keep the kiosk alive: log and carry on rather than exiting on a stray error.
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));

function shutdown() {
  console.log('\nShutting down.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
