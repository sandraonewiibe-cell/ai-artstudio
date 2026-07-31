const config = require('../config');

/**
 * Hunyuan3D, TRELLIS or anything else on Replicate.
 *
 * Replicate runs a model as a "prediction": you post the input, you get an id,
 * you poll it until it is finished, and the finished prediction points at the
 * files it produced. That is the whole of the protocol, and it is why this file
 * is short - which model is behind it is a configuration detail, so swapping
 * Hunyuan3D for TRELLIS is an environment variable rather than a code change.
 *
 * The drawing is sent as a data URL rather than a link. A kiosk on a table has
 * no address the outside world can fetch from, so anything that requires the
 * image to be hosted publicly first cannot work here.
 *
 * Nothing about this is on the visitor's path. It runs after their boat is
 * already on the wall, so a slow model costs a late arrival, never a wait.
 */

const ACCEPTED = ['.glb', '.gltf'];

module.exports = {
  name: 'replicate',

  /**
   * @param {import('./base').SculptInput} input
   * @returns {Promise<import('./base').Sculpted|null>}
   */
  async generate(input) {
    const { token, base, model, version, pollMs, timeoutMs } = config.replicate;

    if (!token) {
      console.warn('[3d] REPLICATE_API_TOKEN is not set; skipping generation.');
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    const image = `data:${input.mime};base64,${input.buffer.toString('base64')}`;

    const prediction = await start({ token, base, model, version, image, input });
    const finished = await settle({ token, base, prediction, pollMs, deadline });

    if (finished.status !== 'succeeded') {
      throw new Error(finished.error || `Replicate returned "${finished.status}".`);
    }

    const url = pickModel(finished.output);
    if (!url) {
      console.warn('[3d] the prediction finished with no model file in its output.');
      return null;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not fetch the model (${response.status}).`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = url.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';

    return { buffer, ext };
  },
};

/**
 * Opens the prediction.
 *
 * Official models are addressed by name and community ones by version, so both
 * are supported: whichever is configured decides which endpoint is used.
 */
async function start({ token, base, model, version, image, input }) {
  const endpoint = version
    ? `${base}/predictions`
    : `${base}/models/${model}/predictions`;

  const body = {
    input: {
      image,

      // Asked for at generation time rather than trimmed afterwards. A mesh
      // that arrives at the right size costs nothing to optimise, and there is
      // no geometry library on this server to decimate one that does not.
      texture: input.texture,
      face_count: input.faces,
      num_faces: input.faces,
    },
  };

  if (version) body.version = version;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const prediction = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(prediction.detail || `Replicate refused the request (${response.status}).`);
  }

  return prediction;
}

/** Polls until the prediction is finished, or the deadline passes. */
async function settle({ token, base, prediction, pollMs, deadline }) {
  const url = (prediction.urls && prediction.urls.get) || `${base}/predictions/${prediction.id}`;
  let current = prediction;

  while (!['succeeded', 'failed', 'canceled'].includes(current.status)) {
    if (Date.now() > deadline) throw new Error('Replicate took too long.');

    await new Promise((resolve) => setTimeout(resolve, pollMs));

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Could not read the prediction (${response.status}).`);

    current = await response.json();
  }

  return current;
}

/**
 * Finds the model file in whatever shape the output came back as.
 *
 * Every model on Replicate answers differently - a bare URL, a list of them, or
 * an object with the mesh under one of several names - and the point of this
 * adapter is that swapping models does not mean editing code, so it copes with
 * all of them rather than insisting on one.
 */
function pickModel(output) {
  const isModel = (value) =>
    typeof value === 'string' && ACCEPTED.some((ext) => value.toLowerCase().split('?')[0].endsWith(ext));

  if (isModel(output)) return output;

  if (Array.isArray(output)) return output.find(isModel) || null;

  if (output && typeof output === 'object') {
    const named = ['mesh', 'model', 'model_file', 'glb', 'output', 'file'];
    for (const key of named) {
      if (isModel(output[key])) return output[key];
    }

    // ...and failing that, anything at all that looks like one.
    const found = Object.values(output).find(isModel);
    if (found) return found;
  }

  return null;
}
