const config = require('../config');

/**
 * Tripo AI.
 *
 * Optional, and off unless MODEL3D_PROVIDER=tripo and a key is set. With no key
 * it declines quietly, which the pipeline reads as "no model this time" and
 * builds its own - so a kiosk that has never heard of Tripo runs exactly as it
 * did before this file existed.
 *
 * The shape is the same as the WaveSpeed adapter beside it, because the problem
 * is the same one: upload, submit, poll, download. Tripo takes an uploaded
 * file's *token* rather than a URL, which suits a kiosk even better - there is
 * nothing to host and nothing for the outside world to reach.
 *
 * What is sent is the extracted drawing and nothing else. Background removal and
 * extraction run in front of any plugin, so what leaves the building is the
 * transparent PNG of what the visitor drew - never the photograph of the page,
 * the table, or the printed corners.
 *
 * Nothing about this is on the visitor's path. It runs after their boat is
 * already sailing, so a slow model costs a late arrival, never a wait.
 */

/** Tripo answers 200 with a non-zero `code` when it is unhappy. */
const OK = 0;

/**
 * Which of the model files to prefer.
 *
 * A textured model first, because the whole point is that the boat looks like
 * the drawing. `base_model` is the bare geometry and is the last resort.
 */
const OUTPUTS = ['pbr_model', 'model', 'base_model'];

module.exports = {
  name: 'tripo',

  /**
   * @param {import('./base').SculptInput} input
   * @returns {Promise<import('./base').Sculpted|null>}
   */
  async generate(input) {
    const { apiKey, base, version, pollMs, timeoutMs, extra, log } = config.tripo;

    if (!apiKey) {
      console.warn('[3d] TRIPO_API_KEY is not set; skipping generation.');
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    const say = (message) => { if (log) console.log(`[3d] tripo: ${message}`); };

    // 1. The drawing, as a token Tripo can refer to.
    const token = await upload({ apiKey, base, buffer: input.buffer, mime: input.mime, say });

    // 2. Ask for the model.
    const task = await submit({ apiKey, base, version, token, input, extra, say });

    // 3. Wait for it, but not for ever.
    const finished = await settle({ apiKey, base, task, pollMs, deadline, say });

    // 4. Fetch what it made.
    const url = pickModel(finished.output);
    if (!url) {
      dump('outputs', { url: `${base}/task/${task}`, method: 'GET', status: finished.status, raw: JSON.stringify(finished.output) });
      console.warn('[3d] tripo finished with no model file in its output.');
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
 * Hands the drawing over and gets back a token for it.
 *
 * A token rather than an address, which is the one way this differs from the
 * WaveSpeed adapter and the way that suits a kiosk better: nothing is hosted,
 * nothing has to be reachable, and the drawing is referred to by a name only
 * Tripo and this machine know.
 */
async function upload({ apiKey, base, buffer, mime, say }) {
  const url = `${base}/upload`;
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

  if (!response.ok || (body && body.code !== undefined && body.code !== OK)) {
    dump('upload', {
      url,
      body: `multipart/form-data; file=drawing.png (${buffer.length} bytes, ${mime || 'image/png'})`,
      status: response.status,
      raw,
    });
    throw new Error(reason(body, response.status, 'Tripo refused the upload'));
  }

  // Called image_token in the older documentation and file_token in the SDK.
  // Both are accepted rather than guessed at, because which one arrives is not
  // worth a failed exhibition.
  const data = (body && body.data) || {};
  const token = data.image_token || data.file_token || data.token;

  if (!token) {
    dump('upload', { url, status: response.status, raw });
    throw new Error('Tripo accepted the upload but gave no file token back.');
  }

  say(`uploaded, token ${String(token).slice(0, 12)}…`);
  return token;
}

/**
 * Opens the task.
 *
 * The model version and anything else a particular one wants go in through
 * settings, so moving between Tripo's versions is a line in .env rather than an
 * edit here.
 */
async function submit({ apiKey, base, version, token, input, extra, say }) {
  const url = `${base}/task`;

  const body = {
    type: 'image_to_model',
    file: { type: 'png', file_token: token },

    // Textured, because the whole point is that the boat looks like the drawing.
    texture: input.texture !== false,
    pbr: input.texture !== false,

    ...(version ? { model_version: version } : {}),
    ...extra,
  };

  say(`submitting to ${url} with ${JSON.stringify({ ...body, file: { type: 'png', file_token: '<token>' } })}`);

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

  if (!response.ok || (payload && payload.code !== undefined && payload.code !== OK)) {
    dump('submit', { url, body, status: response.status, raw });
    throw new Error(reason(payload, response.status, 'Tripo refused the request'));
  }

  const id = payload && payload.data && payload.data.task_id;
  if (!id) {
    dump('submit', { url, body, status: response.status, raw });
    throw new Error('Tripo accepted the request but started no task.');
  }

  say(`submitted as ${id}`);
  return id;
}

/**
 * Polls until the task finishes, or the deadline passes.
 *
 * The status is compared in lower case throughout. Tripo's own documentation
 * gives it three different ways - "success", "SUCCESS" and "Success" - and
 * which one arrives is not something worth losing a boat over.
 */
async function settle({ apiKey, base, task, pollMs, deadline, say }) {
  const url = `${base}/task/${task}`;
  const done = ['success', 'failed', 'cancelled', 'banned', 'expired'];

  let current = { status: 'queued' };
  let polls = 0;
  const waiting = Date.now();

  while (!done.includes(String(current.status).toLowerCase())) {
    if (Date.now() > deadline) {
      dump('poll', { url, method: 'GET', status: 'timeout', raw: `last status "${current.status}" after ${polls} polls` });
      throw new Error('Tripo took too long.');
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
    polls += 1;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const raw = await response.text();
    const payload = parse(raw);

    if (!response.ok || (payload && payload.code !== undefined && payload.code !== OK)) {
      dump('poll', { url, method: 'GET', status: response.status, raw });
      throw new Error(reason(payload, response.status, 'Could not read the task'));
    }

    const was = current.status;
    current = (payload && payload.data) || {};

    // Only when something changes, and a heartbeat now and then. A model takes
    // minutes, so saying "running" every two seconds buries the lines that
    // matter under dozens that do not.
    if (current.status !== was || polls % 15 === 0) {
      const progress = current.progress !== undefined ? ` ${current.progress}%` : '';
      say(`${Math.round((Date.now() - waiting) / 1000)}s, poll ${polls}: ${current.status || 'unknown'}${progress}`);
    }
  }

  if (String(current.status).toLowerCase() !== 'success') {
    dump('poll', { url, method: 'GET', status: current.status, raw: JSON.stringify(current) });
    throw new Error(`Tripo returned "${current.status}".`);
  }

  return current;
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
 * What went wrong, in a sentence that says whether asking again is worth it.
 *
 * The HTTP status stays in the message because the plugin runner decides
 * whether to retry by reading these: a 401 or a 402 will refuse again, while a
 * 500 or a dropped connection is worth another go.
 */
function reason(body, status, what) {
  const said = (body && (body.message || body.error || body.suggestion || body.detail)) || '';
  const code = body && body.code !== undefined && body.code !== OK ? ` code=${body.code}` : '';
  return `${what} (${status}${code})${said ? `: ${said}` : ''}`;
}

/**
 * Everything about a call that did not work, printed in full.
 *
 * A one-line summary is enough to fall back on and not enough to fix anything.
 * The key never appears - it is the one thing here that must not end up in a log
 * an exhibition might mail somebody.
 */
function dump(what, { url, method = 'POST', body, status, raw }) {
  const lines = [
    `[3d] tripo FAILED at ${what}`,
    `      ${method} ${url}`,
    '      authorization: Bearer <key withheld>',
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
 * Finds the model file in the output.
 *
 * Textured first: the whole point is that the boat looks like what was drawn,
 * and the bare geometry is the last resort rather than the answer. Tolerant of
 * shape for the same reason the other adapters are - the version behind the
 * endpoint is meant to be a setting, and they do not all answer alike.
 */
function pickModel(output) {
  if (!output) return null;

  if (typeof output === 'string') return output;

  for (const key of OUTPUTS) {
    const value = output[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value.url === 'string' && value.url) return value.url;
  }

  const found = Object.values(output).find((v) => typeof v === 'string' && /^https?:\/\//.test(v));
  return found || null;
}
