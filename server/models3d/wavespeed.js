const config = require('../config');

/**
 * WaveSpeed AI - Hunyuan3D, Tripo, Meshy, Rodin or anything else hosted there.
 *
 * Optional, and off unless MODEL3D_PROVIDER=wavespeed and a key is set. With no
 * key it declines quietly, which the pipeline reads as "no model this time" and
 * builds its own - so a kiosk that has never heard of WaveSpeed runs exactly as
 * it did before this file existed.
 *
 * The protocol is upload, submit, poll, download:
 *
 *   1. the drawing is uploaded and comes back as a URL;
 *   2. that URL is submitted to the model, which answers with a prediction id;
 *   3. the prediction is polled until it completes or the deadline passes;
 *   4. the GLB it points at is fetched.
 *
 * Step one is not optional and is the difference from the Replicate adapter,
 * which takes the image inline as a data URL. WaveSpeed's models take an image
 * *address*, and a kiosk on a table has no address the outside world can fetch
 * from - so the drawing is put somewhere WaveSpeed can reach using WaveSpeed's
 * own upload endpoint, which needs nothing of the kiosk's network.
 *
 * What is sent is the extracted drawing and nothing else. Not the photograph of
 * the page, not the table, not the marker corners: the pipeline runs background
 * removal and extraction in front of any plugin, and what arrives here is the
 * transparent PNG of what the visitor drew. Which model is behind the endpoint
 * is a configuration detail, so swapping Hunyuan3D for Tripo is an environment
 * variable rather than a code change.
 *
 * Nothing about this is on the visitor's path. It runs after their boat is
 * already sailing on the wall, so a slow model costs a late arrival, never a
 * wait, and a broken one costs nothing at all.
 */

const ACCEPTED = ['.glb', '.gltf'];

module.exports = {
  name: 'wavespeed',

  /**
   * @param {import('./base').SculptInput} input
   * @returns {Promise<import('./base').Sculpted|null>}
   */
  async generate(input) {
    const { apiKey, base, model, pollMs, timeoutMs, extra, log } = config.wavespeed;

    if (!apiKey) {
      console.warn('[3d] WAVESPEED_API_KEY is not set; skipping generation.');
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    const say = (message) => { if (log) console.log(`[3d] wavespeed: ${message}`); };

    // 1. Somewhere WaveSpeed can fetch the drawing from.
    const imageUrl = await upload({ apiKey, base, buffer: input.buffer, mime: input.mime, say });

    // 2. Ask for the model.
    const prediction = await submit({ apiKey, base, model, imageUrl, input, extra, say });

    // 3. Wait for it, but not for ever.
    const finished = await settle({ apiKey, prediction, pollMs, deadline, say });

    if (finished.status !== 'completed') {
      throw new Error(finished.error || `WaveSpeed returned "${finished.status}".`);
    }

    // 4. Fetch what it made.
    const url = pickModel(finished.outputs);
    if (!url) {
      console.warn('[3d] wavespeed finished with no model file in its outputs.');
      return null;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not fetch the model (${response.status}).`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = url.toLowerCase().split('?')[0].endsWith('.gltf') ? 'gltf' : 'glb';

    say(`fetched ${Math.round(buffer.length / 1024)}KB of ${ext}`);

    return { buffer, ext };
  },
};

/**
 * Puts the drawing where the model can see it.
 *
 * WaveSpeed's own store, so nothing has to be true of the kiosk's network: no
 * public address, no tunnel, no bucket to configure. The drawing is a hundred
 * kilobytes or so and goes up in one request.
 */
async function upload({ apiKey, base, buffer, mime, say }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'image/png' }), 'drawing.png');

  const response = await fetch(`${base}/media/upload/binary`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(reason(body, response.status, 'WaveSpeed refused the upload'));
  }

  const url = body && body.data && body.data.download_url;
  if (!url) throw new Error('WaveSpeed accepted the upload but gave no URL back.');

  say(`uploaded ${Math.round(buffer.length / 1024)}KB`);
  return url;
}

/**
 * Opens the prediction.
 *
 * The face budget is asked for at generation time rather than trimmed
 * afterwards: a mesh that arrives at the right size costs nothing to optimise,
 * and there is no geometry library on this server to decimate one that does not.
 *
 * Anything else a particular model wants goes in through `extra`, so pointing
 * this at Tripo or Meshy instead - each of which names its options differently -
 * is a setting rather than an edit.
 */
async function submit({ apiKey, base, model, imageUrl, input, extra, say }) {
  const body = {
    image: imageUrl,
    face_count: input.faces,
    ...extra,
  };

  const response = await fetch(`${base}/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(reason(payload, response.status, `WaveSpeed refused the request`));
  }

  const data = payload && payload.data;
  if (!data || !data.id) throw new Error('WaveSpeed accepted the request but started no prediction.');

  say(`submitted to ${model} as ${data.id}`);
  return data;
}

/** Polls until the prediction finishes, or the deadline passes. */
async function settle({ apiKey, prediction, pollMs, deadline, say }) {
  const url = (prediction.urls && prediction.urls.get) ||
    `${config.wavespeed.base}/predictions/${prediction.id}/result`;

  let current = prediction;

  while (!['completed', 'failed'].includes(current.status)) {
    if (Date.now() > deadline) throw new Error('WaveSpeed took too long.');

    await new Promise((resolve) => setTimeout(resolve, pollMs));

    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(reason(payload, response.status, 'Could not read the prediction'));
    }

    current = (payload && payload.data) || {};
    say(`${current.status || 'unknown'}`);
  }

  return current;
}

/**
 * What went wrong, in a sentence that says whether asking again is worth it.
 *
 * The HTTP status is kept in the message on purpose. The plugin runner decides
 * whether to retry by reading these, and a 401 or a 402 is a refusal that will
 * refuse again - no key, no credit - while a 500 or a timeout is worth a second
 * go. Losing the status here would turn every failure into three of them.
 */
function reason(body, status, what) {
  const said = (body && (body.message || body.error || body.detail)) || '';
  return `${what} (${status})${said ? `: ${said}` : ''}`;
}

/**
 * Finds the model file among the outputs.
 *
 * Tolerant of shape for the same reason the Replicate adapter is: which model
 * is behind the endpoint is meant to be a setting, and they do not all answer
 * alike. A list of URLs is the documented shape; a bare string and an object
 * with the mesh under some name of its own are both things that happen.
 */
function pickModel(outputs) {
  const isModel = (value) =>
    typeof value === 'string' &&
    ACCEPTED.some((ext) => value.toLowerCase().split('?')[0].endsWith(ext));

  if (isModel(outputs)) return outputs;

  if (Array.isArray(outputs)) {
    return outputs.find(isModel) || outputs.find((v) => typeof v === 'string') || null;
  }

  if (outputs && typeof outputs === 'object') {
    const found = Object.values(outputs).find(isModel);
    if (found) return found;
  }

  return null;
}
