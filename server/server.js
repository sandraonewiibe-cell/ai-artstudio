const path = require('path');
const express = require('express');

const config = require('./config');
const storage = require('./storage');
const pipeline = require('./pipeline');
const events = require('./events');
const recordings = require('./recordings');
const { publicBase, candidates } = require('./network');

const app = express();

app.use(express.json({ limit: config.maxUploadSize }));

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

app.use(express.static(config.paths.client));

// Static asset / output folders
app.use('/assets', express.static(config.paths.assets));
app.use('/uploads', express.static(config.paths.uploads));
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
    networks: candidates(),
  });
});

/** Live channel that keeps the three screens in step. */
app.get('/api/events', (req, res) => {
  events.addClient(req, res);
});

/** Start a session from a capture. Returns a job id to poll. */
app.post('/api/sessions', (req, res) => {
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
app.post('/api/recordings', (req, res) => {
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
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: 'Internal error.' });
});

// Make sure output folders exist before the first visitor.
['uploads', 'images', 'videos'].forEach((kind) => storage.ensureDir(config.paths[kind]));

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
