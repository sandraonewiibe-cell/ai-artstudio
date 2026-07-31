const config = require('../config');

/**
 * Hunyuan3D, TRELLIS or anything else running as a Hugging Face Space.
 *
 * A Space is a Gradio app, and Gradio speaks a fixed four-step protocol however
 * different the app on top of it looks: upload the file, open a call, listen on
 * an event stream until it finishes, then fetch what it produced. That is the
 * whole of it, and it is why this file does not know or care whether the Space
 * behind it is Hunyuan3D or TRELLIS.
 *
 * Which endpoint to call is asked for rather than assumed. Every Space
 * publishes its own API schema, so instead of hardcoding "/generate" and
 * breaking the day a Space renames it, this reads the schema and picks the
 * endpoint that takes a picture and returns a model. Set HF_SPACE_API to
 * override that when a Space has several and the wrong one is chosen.
 *
 * Free, which is the point of it, and unreliable for the same reason: a public
 * Space sleeps when idle, queues behind everyone else using it, and is under no
 * obligation to stay up. So every failure here is a plain throw. The pipeline
 * catches it, the wall never hears about a model, and the boat the visitor is
 * already watching - built in their own browser from their own drawing - simply
 * stays. A Space that is down costs nothing that anyone in the room can see.
 */

const ACCEPTED = ['.glb', '.gltf'];

// Gradio components that will accept a drawing. Names come back lowercased.
const TAKES_AN_IMAGE = ['image', 'imageeditor', 'imagemask', 'file', 'uploadbutton', 'gallery'];

// ...and the ones that hand back a mesh.
const GIVES_A_MODEL = ['model3d', 'file', 'downloadbutton'];

module.exports = {
  name: 'huggingface',

  /**
   * @param {import('./base').SculptInput} input
   * @returns {Promise<import('./base').Sculpted|null>}
   */
  async generate(input) {
    const { space, token, api, timeoutMs } = config.huggingface;

    if (!space) {
      console.warn('[3d] HF_SPACE_URL is not set; skipping generation.');
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    const base = space.replace(/\/+$/, '');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    // 1. What can this Space do?
    const { prefix, endpoints } = await describe({ base, headers, deadline });
    const route = choose(endpoints, api);

    console.log(`[3d] ${base} -> ${route.name}`);

    // 2. Hand it the drawing.
    const file = await upload({ base, prefix, headers, input, deadline });

    // 3. Open the call, and wait it out.
    const eventId = await open({ base, prefix, headers, route, file, input, deadline });
    const output = await settle({ base, prefix, headers, route, eventId, deadline });

    // 4. Collect the mesh.
    const url = pickModel(output, base, prefix);
    if (!url) {
      console.warn('[3d] the Space finished without returning a model file.');
      return null;
    }

    const response = await fetch(url, { headers, signal: until(deadline) });
    if (!response.ok) throw new Error(`Could not fetch the model (${response.status}).`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = url.toLowerCase().split('?')[0].endsWith('.gltf') ? 'gltf' : 'glb';

    return { buffer, ext };
  },
};

/**
 * Reads the Space's API schema.
 *
 * Also settles which route prefix this Space uses. Gradio 4 and 5 put
 * everything under /gradio_api; Gradio 3 puts it at the root. Asking costs one
 * request and saves guessing wrong on every one after it.
 *
 * @returns {Promise<{prefix: string, endpoints: object}>}
 */
async function describe({ base, headers, deadline }) {
  const tried = [];

  for (const prefix of ['/gradio_api', '']) {
    const url = `${base}${prefix}/info`;

    let response;
    try {
      response = await fetch(url, { headers, signal: until(deadline) });
    } catch (err) {
      tried.push(`${url} (${err.message})`);
      continue;
    }

    if (!response.ok) {
      tried.push(`${url} (${response.status})`);
      continue;
    }

    // A sleeping or crashed Space answers 200 with its holding page, so the
    // status alone is not enough to go on.
    const schema = await response.json().catch(() => null);
    if (!schema || !schema.named_endpoints) {
      tried.push(`${url} (no API schema - the Space may be asleep or still building)`);
      continue;
    }

    return { prefix, endpoints: schema.named_endpoints };
  }

  throw new Error(`No Gradio API at ${base}: ${tried.join('; ')}`);
}

/**
 * Picks the endpoint to call.
 *
 * Configuration wins outright. Failing that, the wanted endpoint is the one
 * that takes a picture and gives back a model - which is a description of this
 * whole pipeline, and is enough to identify it on every Space tried.
 */
function choose(endpoints, wanted) {
  const names = Object.keys(endpoints);

  if (wanted) {
    const name = wanted.startsWith('/') ? wanted : `/${wanted}`;
    if (!endpoints[name]) {
      throw new Error(`The Space has no endpoint "${name}". It has: ${names.join(', ') || 'none'}`);
    }

    return { name, ...endpoints[name] };
  }

  const fits = names.filter((name) => {
    const { parameters = [], returns = [] } = endpoints[name];
    return parameters.some(takesAnImage) && returns.some(givesAModel);
  });

  if (!fits.length) {
    throw new Error(
      `No endpoint on this Space takes an image and returns a 3D model. ` +
        `It has: ${names.join(', ') || 'none'}. Set HF_SPACE_API to choose one by hand.`
    );
  }

  // More than one is normal - Hunyuan3D publishes shape-only and shape-plus-
  // texture routes. The later one is the fuller one on every Space seen, and a
  // textured boat is the whole point of sending the child's drawing.
  const name = fits[fits.length - 1];
  return { name, ...endpoints[name] };
}

const componentOf = (slot) => String(slot.component || slot.type || '').toLowerCase();
const takesAnImage = (slot) => TAKES_AN_IMAGE.includes(componentOf(slot));
const givesAModel = (slot) => GIVES_A_MODEL.includes(componentOf(slot));

/**
 * Puts the drawing on the Space and returns a reference to it.
 *
 * Gradio wants files uploaded separately and then referred to by path, rather
 * than inlined into the call, so this is its own step.
 */
async function upload({ base, prefix, headers, input, deadline }) {
  const form = new FormData();
  const name = `drawing.${(input.mime || 'image/png').split('/')[1] || 'png'}`;

  form.append('files', new Blob([input.buffer], { type: input.mime }), name);

  const response = await fetch(`${base}${prefix}/upload`, {
    method: 'POST',
    headers,
    body: form,
    signal: until(deadline),
  });

  if (!response.ok) throw new Error(`The Space refused the upload (${response.status}).`);

  const paths = await response.json().catch(() => null);
  if (!Array.isArray(paths) || !paths.length) {
    throw new Error('The Space accepted the upload but returned no path for it.');
  }

  return {
    path: paths[0],
    url: `${base}${prefix}/file=${paths[0]}`,
    orig_name: name,
    mime_type: input.mime,
    meta: { _type: 'gradio.FileData' },
  };
}

/**
 * Opens the call and returns the event id to follow.
 *
 * The argument list has to match the endpoint's signature positionally, so it
 * is built from the schema: the drawing goes in the image slot, and every other
 * slot gets the default the Space itself declares. Guessing what a Space's
 * "octree resolution" or "guidance scale" should be would be worse than letting
 * it use the value its own author chose.
 */
async function open({ base, prefix, headers, route, file, input, deadline }) {
  const parameters = route.parameters || [];
  let placed = false;

  const data = parameters.map((slot) => {
    if (!placed && takesAnImage(slot)) {
      placed = true;
      // A Gallery takes a list of images. TRELLIS-style Spaces use one.
      return componentOf(slot) === 'gallery' ? [file] : file;
    }

    return defaultFor(slot, input);
  });

  if (!placed) throw new Error(`Endpoint "${route.name}" has nowhere to put the drawing.`);

  const response = await fetch(`${base}${prefix}/call${route.name}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: until(deadline),
  });

  const opened = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(opened.detail || opened.error || `The Space refused the call (${response.status}).`);
  }

  const eventId = opened.event_id || (opened.data && opened.data.event_id);
  if (!eventId) throw new Error('The Space opened no event to follow.');

  return eventId;
}

/**
 * What to send for a slot that is not the drawing.
 *
 * The face budget is the one exception. It is a real constraint from this
 * application - the mesh has to be small enough for a browser on a kiosk - so
 * where a Space exposes it, it is worth setting rather than defaulting.
 */
function defaultFor(slot, input) {
  const name = String(slot.parameter_name || slot.label || '').toLowerCase();

  if (input.faces && /face|poly|triangle/.test(name) && !/texture/.test(name)) {
    return input.faces;
  }

  if (slot.parameter_has_default) return slot.parameter_default;
  if (slot.example_input !== undefined) return slot.example_input;

  return null;
}

/**
 * Follows the event stream until the call finishes.
 *
 * Gradio reports progress as server-sent events, so this reads the stream as it
 * arrives rather than waiting for a complete body: a Space that queues for
 * three minutes and then dies should be given up on at the deadline, not held
 * onto until it decides to close the connection.
 */
async function settle({ base, prefix, headers, route, eventId, deadline }) {
  const response = await fetch(`${base}${prefix}/call${route.name}/${eventId}`, {
    headers,
    signal: until(deadline),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Could not follow the Space's progress (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffered += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; anything after the last one is a
      // partial event and stays buffered for the next read.
      const chunks = buffered.split(/\n\n/);
      buffered = chunks.pop();

      for (const chunk of chunks) {
        const event = parseEvent(chunk);
        if (!event) continue;

        if (event.name === 'complete') return event.data;

        if (event.name === 'error') {
          throw new Error(messageFrom(event.data) || 'The Space reported an error.');
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  throw new Error('The Space closed the connection before finishing.');
}

/** One `event:`/`data:` pair out of the stream. */
function parseEvent(chunk) {
  let name = 'message';
  const payload = [];

  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) payload.push(line.slice(5).trim());
  }

  if (!payload.length) return null;

  const raw = payload.join('\n');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }

  return { name, data };
}

/** Whatever a Space chose to call its error message this week. */
function messageFrom(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.map(messageFrom).find(Boolean) || '';
  if (data && typeof data === 'object') return data.message || data.error || data.detail || '';
  return '';
}

/**
 * Finds the model file in whatever shape the output came back as.
 *
 * Gradio returns files as objects carrying a path and usually a url, but a
 * Space that returns several outputs nests them, and one that returns a bare
 * string is not unheard of, so all of it is walked rather than assumed.
 */
function pickModel(output, base, prefix) {
  const found = walk(output);
  if (!found) return null;

  if (/^https?:\/\//i.test(found)) return found;

  // A path with no url of its own is served off the Space it came from. The
  // path keeps its leading slash: Gradio serves /file=/tmp/gradio/... and 404s
  // on the same path without it.
  return `${base}${prefix}/file=${found}`;
}

function walk(value) {
  const isModel = (text) =>
    typeof text === 'string' && ACCEPTED.some((ext) => text.toLowerCase().split('?')[0].endsWith(ext));

  if (isModel(value)) return value;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walk(item);
      if (found) return found;
    }

    return null;
  }

  if (value && typeof value === 'object') {
    // A Gradio file object: the url is already fetchable, the path needs
    // building, so the url is worth preferring where there is one.
    if (isModel(value.url)) return value.url;
    if (isModel(value.path)) return value.path;

    for (const item of Object.values(value)) {
      const found = walk(item);
      if (found) return found;
    }
  }

  return null;
}

/**
 * An abort signal that fires at the shared deadline.
 *
 * Every request in one generation answers to the same clock, so a Space that
 * spends the whole budget queueing cannot then spend another five minutes
 * uploading.
 */
function until(deadline) {
  return AbortSignal.timeout(Math.max(1, deadline - Date.now()));
}
