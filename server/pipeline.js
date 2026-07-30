const crypto = require('crypto');
const config = require('./config');
const storage = require('./storage');
const { loadProvider } = require('./providers');
const { loadOcr } = require('./ocr');
const { loadClassifier } = require('./classifier');
const { assertResult } = require('./providers/base');
const events = require('./events');

const provider = loadProvider();
const ocr = loadOcr();
const classifier = loadClassifier();

/** @type {Map<string, object>} */
const jobs = new Map();

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.();
  });
}

/**
 * Public view of a job - what the kiosk polls for.
 */
function serialize(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    text: job.text,
    textConfidence: job.textConfidence,
    imageUrl: job.imageUrl,
    transparent: job.transparent,
    standIn: job.standIn,
    layers: job.layers,
    label: job.label,
    reason: job.reason,
    error: job.error,
  };
}

async function run(job, paperBuffer, drawingBuffer, layers) {
  job.status = 'running';

  // 1. Keep the raw capture for later inspection / re-runs.
  job.stage = 'saving';
  const prefix = `${stamp()}-${job.id.slice(0, 8)}`;
  storage.save('uploads', `${prefix}-page.png`, paperBuffer);
  if (drawingBuffer) storage.save('uploads', `${prefix}-drawing.png`, drawingBuffer);

  // 2. OCR the full page. Never fatal - no text is a normal outcome.
  job.stage = 'reading';
  try {
    const result = await ocr.read(paperBuffer);
    job.text = result.text;
    job.textConfidence = result.confidence;
  } catch (err) {
    console.warn('[pipeline] OCR error, continuing without text:', err.message);
  }

  // 3. Is it a boat? Anything else is rejected here, before a generation is
  //    ever paid for. A rejection is a normal outcome, not an error.
  job.stage = 'checking';
  const verdict = await classifier.classify({
    drawing: drawingBuffer,
    paper: paperBuffer,
    text: job.text,
  });

  job.label = verdict.label || null;

  if (!verdict.isBoat) {
    job.reason = verdict.label === 'empty' ? 'no-drawing' : 'not-a-boat';
    job.stage = 'rejected';
    job.status = 'rejected';
    return;
  }

  // 4. Generate the boat.
  job.stage = 'generating';
  const generated = assertResult(
    await provider.generateBoat({
      drawing: drawingBuffer,
      paper: paperBuffer,
      text: job.text,
    }),
    provider.name
  );

  const saved = storage.save('images', `${prefix}-boat.${generated.ext}`, generated.buffer);

  job.imageUrl = saved.url;
  job.transparent = generated.transparent;
  job.standIn = generated.standIn;

  // 5. Oar layers, if the drawing had any.
  //
  // Only attached for a stand-in result. A real provider returns one flat
  // generated boat, and oars cut from the visitor's *drawing* would not line
  // up with it - so animating them would be worse than not. A provider that
  // wants rowing oars has to return its own layers.
  if (layers && generated.standIn) {
    job.layers = saveLayers(prefix, layers);
    if (job.layers) console.log(`[pipeline] ${job.layers.paddles.length} oar layer(s)`);
  }

  job.stage = 'done';
  job.status = 'done';
}

/**
 * Writes the oar images, returning the URLs the display will load.
 *
 * The oars and nothing else. There is no second copy of the drawing here: the
 * display shows the generated image whole and lays these over it, so a hull
 * layer would be an unused duplicate on disk and one more thing that could
 * reach a screen by accident.
 */
function saveLayers(prefix, layers) {
  try {
    const paddles = layers.paddles.map((paddle, index) => ({
      url: storage.save('images', `${prefix}-oar-${index}.png`, paddle.buffer).url,
      rect: paddle.rect,
      pivot: paddle.pivot,
      tip: paddle.tip,
    }));

    return paddles.length ? { paddles } : null;
  } catch (err) {
    // Losing the oars costs an animation, not the session.
    console.warn('[pipeline] could not store oar layers:', err.message);
    return null;
  }
}

/** Decodes the oar images posted by the scanner. */
function decodeLayers(layers) {
  if (!layers || !Array.isArray(layers.paddles) || !layers.paddles.length) return null;

  return {
    paddles: layers.paddles.map((paddle) => ({
      buffer: storage.decodeDataUrl(paddle.data),
      rect: paddle.rect,
      pivot: paddle.pivot,
      tip: paddle.tip,
    })),
  };
}

/**
 * Starts a session. Returns immediately with a job id; the kiosk polls
 * getJob() for progress. Polling rather than one long request keeps the
 * capture endpoint fast and survives slow providers without proxy timeouts.
 *
 * @param {{paper: string, drawing: string|null}} payload data URLs
 */
function createSession(payload) {
  const paperBuffer = storage.decodeDataUrl(payload.paper);
  const drawingBuffer = payload.drawing ? storage.decodeDataUrl(payload.drawing) : null;

  let layers = null;
  try {
    layers = decodeLayers(payload.layers);
  } catch (err) {
    console.warn('[pipeline] ignoring malformed oar layers:', err.message);
  }

  const job = {
    id: crypto.randomUUID(),
    status: 'pending',
    stage: 'queued',
    text: null,
    textConfidence: 0,
    imageUrl: null,
    transparent: false,
    standIn: false,
    layers: null,
    label: null,
    reason: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };

  jobs.set(job.id, job);

  Promise.race([
    run(job, paperBuffer, drawingBuffer, layers),
    timeout(config.jobTimeoutMs, 'Generation'),
  ])
    .catch((err) => {
      console.error('[pipeline] job failed:', err);
      job.status = 'error';
      job.stage = 'error';
      job.error = err.message;
    })
    .finally(() => {
      job.finishedAt = Date.now();

      // Tell the display screen. Only a finished boat is worth showing; a
      // rejection or an error stays on the scanner where the visitor is.
      if (job.status === 'done') {
        events.broadcast('result', { job: serialize(job) });
      }
    });

  return serialize(job);
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? serialize(job) : null;
}

/** Drops old finished jobs so an all-day run does not grow unbounded. */
function sweepJobs() {
  const cutoff = Date.now() - config.jobRetentionMs;
  let removed = 0;

  jobs.forEach((job, id) => {
    if (job.finishedAt && job.finishedAt < cutoff) {
      jobs.delete(id);
      removed += 1;
    }
  });

  return removed;
}

module.exports = {
  createSession,
  getJob,
  sweepJobs,
  info: { provider: provider.name, ocr: ocr.name, classifier: classifier.name },
  warmup: () => (ocr.warmup ? ocr.warmup() : Promise.resolve()),
};
