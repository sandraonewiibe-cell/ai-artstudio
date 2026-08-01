const crypto = require('crypto');
const config = require('./config');
const storage = require('./storage');
const { loadProvider } = require('./providers');
const { loadOcr } = require('./ocr');
const { loadClassifier } = require('./classifier');
const { loadEnhancer } = require('./enhancers');
const { loadModel3D } = require('./models3d');
const pipeline3d = require('./pipeline3d');
const { assertResult } = require('./providers/base');
const { assertEnhanced } = require('./enhancers/base');
const events = require('./events');

const provider = loadProvider();
const ocr = loadOcr();
const classifier = loadClassifier();
const enhancer = loadEnhancer();
const model3d = loadModel3D();

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

    // The 3D model, which arrives after the boat rather than with it.
    model: job.model,
  };
}

/**
 * The 3D pipeline, run after the visitor's boat is already on the wall.
 *
 * Deliberately not awaited by the session. An image-to-3D model takes tens of
 * seconds and a kiosk queue does not have tens of seconds, so the flat boat
 * sails on time and the model catches up - the wall is told separately when one
 * is ready. Nothing here can delay, fail or interrupt a session.
 *
 * The drawing goes in whole. It is not cut into a hull and paddles, or a canopy,
 * or anything else: one picture of what the visitor drew, one object back.
 */
async function sculpt(job, drawing) {
  // Whether anything is expected to produce a model this run.
  //
  // The stages always run - that is how they get exercised on real drawings
  // while depth and mesh are still placeholders - but the job only carries a
  // model status when something could actually finish one. A kiosk with no
  // plugin configured reports no model rather than a permanently pending one,
  // which is what it did before this pipeline existed.
  const expected = model3d.name !== 'none';

  if (expected) job.model = { status: 'working', url: null, provider: model3d.name };

  try {
    // 1. Tidy the sketch, if anything is configured to. The default leaves it
    //    exactly as extracted.
    const enhanced = assertEnhanced(
      await enhancer.enhance({ buffer: drawing, mime: 'image/png' }),
      enhancer.name
    );

    // 2. The same drawing twice is the same model. Worth checking before a
    //    minute of somebody else's GPU: a sheet rescanned because the first
    //    attempt was missed is the common case at a kiosk.
    const fingerprint = crypto.createHash('sha256').update(enhanced.buffer).digest('hex');
    const known = models.get(fingerprint);

    if (known && expected) {
      job.model = { status: 'ready', url: known, provider: model3d.name, cached: true };
      console.log(`[3d] ${job.id.slice(0, 8)} matched a model already made`);
      events.broadcast('model', { id: job.id, model: job.model });
      return;
    }

    const started = Date.now();

    // 3. Through the pipeline: background removal, extraction, depth, mesh,
    //    texture, export. Which of those do anything is the pipeline's business
    //    and not this file's - it is handed a drawing and gives back a model or
    //    says which stage it got to.
    const outcome = await pipeline3d.run(
      { page: drawing, drawing: enhanced.buffer, mime: enhanced.mime || 'image/png' },
      {
        job: job.id,
        text: job.text,
        faces: config.mesh.faces,
        texture: config.mesh.texture,
      }
    );

    const sculpted = outcome.model;

    if (!sculpted) {
      if (expected) {
        job.model = { status: 'off', url: null, provider: model3d.name, stoppedAt: outcome.stoppedAt };
      }

      return;
    }

    const saved = storage.save('models', `${job.prefix}-boat.${sculpted.ext}`, sculpted.buffer);
    remember(fingerprint, saved.url);

    console.log(
      `[3d] ${job.id.slice(0, 8)} modelled in ${Math.round((Date.now() - started) / 1000)}s ` +
        `(${Math.round(sculpted.buffer.length / 1024)}KB) by ${sculpted.by}`
    );

    // Made, and saved, either way. Whether the wall is told is a separate
    // question: announcing a model swaps the display from the boat the browser
    // inflates to the one the server exported, and that is a change to what an
    // exhibition looks like rather than to what this pipeline produces. Asking
    // for a plugin is already that decision; the pipeline's own model waits for
    // MESH_PUBLISH.
    if (!expected && !config.mesh.publish) return;

    job.model = { status: 'ready', url: saved.url, provider: sculpted.by || model3d.name };

    events.broadcast('model', { id: job.id, model: job.model });
  } catch (err) {
    // A model that never arrives costs an animation. The boat is already on the
    // wall and the visitor already has their clip.
    console.warn(`[3d] ${job.id.slice(0, 8)} produced no model:`, err.message);

    if (expected) {
      job.model = { status: 'failed', url: null, provider: model3d.name, error: err.message };
    }
  }
}

/** Fingerprint of a drawing to the model it produced. */
const models = new Map();
const MODEL_CACHE = 200;

function remember(fingerprint, url) {
  models.set(fingerprint, url);

  // Oldest out first; the Map keeps insertion order for us.
  if (models.size > MODEL_CACHE) models.delete(models.keys().next().value);
}

async function run(job, paperBuffer, drawingBuffer, layers) {
  job.status = 'running';

  // 1. Keep the raw capture for later inspection / re-runs.
  job.stage = 'saving';
  const prefix = `${stamp()}-${job.id.slice(0, 8)}`;
  job.prefix = prefix; // the 3D stage names its model after the same session
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

  // 5. Where the oars are, if the drawing had any.
  //
  // Only attached for a stand-in result. A real provider returns its own boat,
  // and blade positions measured from the visitor's *drawing* would not fall
  // where that boat's oars are - so the splashes would come up in the wrong
  // places. A provider that wants them has to return its own.
  if (layers && generated.standIn) {
    job.layers = oarPositions(layers);
    if (job.layers) console.log(`[pipeline] ${job.layers.paddles.length} oar position(s)`);
  }

  job.stage = 'done';
  job.status = 'done';
}

/**
 * Where the oars are, passed through for the display.
 *
 * Nothing is written to disk. There are no oar images any more and no hull
 * layer: the display shows the generated image whole, with the oars already in
 * it, and uses these points only to know where the blades are entering the
 * water. Two coordinates per oar, so there is nothing to store and nothing that
 * could be served up as a loose piece of someone's drawing.
 */
function oarPositions(layers) {
  const paddles = layers.paddles.filter((paddle) => paddle.pivot && paddle.tip);
  return paddles.length ? { paddles } : null;
}

/** Reads the oar positions posted by the scanner. */
function decodeLayers(layers) {
  if (!layers || !Array.isArray(layers.paddles) || !layers.paddles.length) return null;

  return {
    paddles: layers.paddles.map((paddle) => ({
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
    model: null,
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

        // ...and only now, with the boat already on its way to the wall, start
        // the 3D pipeline. Not awaited: the session is over, and whether a
        // model turns up is nothing the visitor is kept waiting for.
        sculpt(job, drawingBuffer || paperBuffer);
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
  info: {
    provider: provider.name,
    ocr: ocr.name,
    classifier: classifier.name,
    enhancer: enhancer.name,
    model3d: model3d.name,
    pipeline3d: pipeline3d.describe(),
  },
  warmup: () => (ocr.warmup ? ocr.warmup() : Promise.resolve()),
};
