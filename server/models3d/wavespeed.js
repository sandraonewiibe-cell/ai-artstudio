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
      dump('outputs', {
        url: 'n/a',
        method: 'n/a',
        status: finished.status,
        raw: JSON.stringify(finished.outputs),
      });
      console.warn('[3d] wavespeed finished with no model file in its outputs.');
      return null;
    }

    say(`downloading ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      dump('download', { url, method: 'GET', status: response.status, raw: await response.text().catch(() => '') });
      throw new Error(`Could not fetch the model (${response.status}).`);
    }

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
  const url = `${base}/media/upload/binary`;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'image/png' }), 'drawing.png');

  say(`uploading ${Math.round(buffer.length / 1024)}KB to ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const raw = await response.text();
  const body = parse(raw);

  if (!response.ok) {
    dump('upload', {
      url,
      body: `multipart/form-data; file=drawing.png (${buffer.length} bytes, ${mime || 'image/png'})`,
      status: response.status,
      raw,
    });
    throw new Error(reason(body, response.status, 'WaveSpeed refused the upload'));
  }

  const link = body && body.data && body.data.download_url;
  if (!link) {
    dump('upload', { url, status: response.status, raw });
    throw new Error('WaveSpeed accepted the upload but gave no URL back.');
  }

  say(`uploaded, available at ${link}`);
  return link;
}

/** JSON if it is JSON, and nothing if it is an error page. */
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  const url = `${base}/${model}`;
  const body = {
    image: imageUrl,
    face_count: input.faces,
    ...extra,
  };

  say(`submitting to ${url} with ${JSON.stringify(body)}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const payload = parse(raw);

  if (!response.ok) {
    dump('submit', { url, body, status: response.status, raw });
    throw new Error(reason(payload, response.status, 'WaveSpeed refused the request'));
  }

  const data = payload && payload.data;
  if (!data || !data.id) {
    dump('submit', { url, body, status: response.status, raw });
    throw new Error('WaveSpeed accepted the request but started no prediction.');
  }

  say(`submitted as ${data.id}, status ${data.status || 'unknown'}`);
  return data;
}

/** Polls until the prediction finishes, or the deadline passes. */
async function settle({ apiKey, prediction, pollMs, deadline, say }) {
  const url = (prediction.urls && prediction.urls.get) ||
    `${config.wavespeed.base}/predictions/${prediction.id}/result`;

  let current = prediction;
  let polls = 0;
  const waiting = Date.now();

  while (!['completed', 'failed'].includes(current.status)) {
    if (Date.now() > deadline) {
      dump('poll', { url, method: 'GET', status: 'timeout', raw: `last status "${current.status}" after ${polls} polls` });
      throw new Error('WaveSpeed took too long.');
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
    polls += 1;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const raw = await response.text();
    const payload = parse(raw);

    if (!response.ok) {
      dump('poll', { url, method: 'GET', status: response.status, raw });
      throw new Error(reason(payload, response.status, 'Could not read the prediction'));
    }

    const was = current.status;
    current = (payload && payload.data) || {};

    // Only when something changes, and a heartbeat now and then. A model takes
    // minutes, so saying "processing" every two seconds buries the two lines
    // that matter under fifty that do not.
    if (current.status !== was || polls % 15 === 0) {
      say(`${Math.round((Date.now() - waiting) / 1000)}s, poll ${polls}: ${current.status || 'unknown'}`);
    }
  }

  if (current.status === 'failed') {
    dump('poll', { url, method: 'GET', status: 'failed', raw: JSON.stringify(current) });
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
 * Everything about a call that did not work, printed in full.
 *
 * A one-line summary is enough to fall back on and not enough to fix anything.
 * When a service refuses, what is actually wanted is the address it was asked
 * at, what it was asked, and what it said back - verbatim, because the useful
 * part is usually a field name nobody expected or a sentence the summary threw
 * away.
 *
 * The key never appears. It is the one thing here that must not end up in a log
 * an exhibition might mail somebody.
 */
function dump(what, { url, method = 'POST', body, status, raw }) {
  const lines = [
    `[3d] wavespeed FAILED at ${what}`,
    `      ${method} ${url}`,
    `      authorization: Bearer <key withheld>`,
  ];

  if (body !== undefined) {
    const shown = typeof body === 'string' ? body : JSON.stringify(body);
    lines.push(`      request: ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}`);
  }

  if (status !== undefined) lines.push(`      status: ${status}`);

  if (raw !== undefined) {
    const shown = String(raw);
    lines.push(`      response: ${shown.length > 900 ? `${shown.slice(0, 900)}…` : shown}`);
  }

  console.error(lines.join('\n'));
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
