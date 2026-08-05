const config = require('../../config');
const { loadModel3D } = require('../../models3d');
const { inspect } = require('../validate');

/**
 * Optional image-to-3D services, hanging off the side of the pipeline.
 *
 * Replicate and Hugging Face Spaces can each turn the whole drawing into a GLB
 * in one call. That is useful and it is not the pipeline: one asks a model
 * somewhere else to make something resembling what a child drew, the other
 * builds a model from the drawing itself. Only the second can promise the
 * colours on the wall are the colours on the paper, which is the promise this
 * project is built on.
 *
 * So a plugin is a bypass. Where one is configured, it stands in for depth,
 * mesh and export together - it returns a finished model, so there is nothing
 * for those stages to do - and background removal and extraction still run in
 * front of it, because whatever is sent away should be the child's drawing and
 * not a photograph of a table.
 *
 * Nothing is configured by default. MODEL3D_PROVIDER=replicate or =huggingface
 * turns one on, and the adapters live where they always did, in server/models3d.
 */

const NONE = 'none';

/**
 * @returns {{name: string, active: boolean, generate: Function}|null}
 */
function loadPlugin() {
  const provider = loadModel3D();
  if (provider.name === NONE) return null;

  return {
    name: provider.name,
    active: true,

    /**
     * Asks the service for a model, more than once if it has to.
     *
     * A free Space is queued, occasionally asleep and sometimes simply having a
     * bad afternoon, and none of those are reasons to give a visitor no boat
     * when asking again would have worked. What is *not* retried is a refusal
     * that will refuse again - no credit, no such model, a malformed request -
     * because trying those twice only makes the visitor wait twice.
     *
     * Whatever comes back is opened and read before it is accepted. A provider
     * that answered is not the same as a provider that answered usefully, and a
     * truncated download or an error page under a .glb name reaches the wall as
     * a boat that never appears.
     *
     * @param {import('../contract').Artwork} artwork
     * @param {import('../contract').Context} context
     * @returns {Promise<import('../contract').Model|null>}
     */
    async generate(artwork, context) {
      const { attempts, backoffMs } = config.plugin;
      const trail = [];

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const started = Date.now();

        try {
          const sculpted = await provider.generate({
            buffer: artwork.buffer,
            mime: artwork.mime,
            text: context.text,
            faces: context.faces,
            texture: context.texture,
          });

          const took = Date.now() - started;

          // Nothing to make, rather than a failure to make it. Asking again
          // would get the same answer.
          if (!sculpted) {
            trail.push({ attempt, ms: took, why: 'the provider had nothing to give' });

            // Not a failure. A provider with no token says this, and so does one
            // that is simply switched off - there is nothing to report as broken.
            return { model: null, trail, quiet: true };
          }

          const seen = inspect(sculpted.buffer);

          if (!seen.ok) {
            trail.push({ attempt, ms: took, why: `unusable: ${seen.why}` });
            context.log(`attempt ${attempt} came back unusable - ${seen.why}`);
            if (attempt < attempts) { await pause(backoffMs * attempt); continue; }
            return { model: null, trail };
          }

          trail.push({
            attempt,
            ms: took,
            why: `${Math.round(seen.bytes / 1024)}KB, ${seen.vertices} vertices, ` +
              `${seen.textured ? 'textured' : 'untextured'}${seen.unlit ? ', unlit' : ''}`,
          });

          return {
            model: { buffer: sculpted.buffer, ext: sculpted.ext || 'glb', by: provider.name },
            inspected: seen,
            trail,
          };
        } catch (err) {
          const took = Date.now() - started;
          trail.push({ attempt, ms: took, why: err.message });

          if (settled(err) || attempt === attempts) {
            context.log(`${provider.name} gave up after ${attempt}: ${err.message}`);
            return { model: null, trail };
          }

          context.log(`attempt ${attempt} failed (${err.message}); trying again`);
          await pause(backoffMs * attempt);
        }
      }

      return { model: null, trail };
    },
  };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether an error is one that asking again will not fix.
 *
 * A queue, a cold Space and a dropped connection are worth another go. An
 * account with no credit, a model that does not exist and a request the service
 * refuses to parse will refuse again, and retrying them only makes a visitor
 * wait three times for the same no.
 */
function settled(err) {
  return /insufficient credit|insufficient balance|quota|no such|not found|404|401|402|403|has no endpoint|nowhere to put/i.test(
    err.message
  );
}

/** What to print at startup, so a misconfigured plugin is visible before a visitor finds it. */
function describePlugin() {
  const name = config.model3d;
  return name === NONE ? 'none (the pipeline builds its own)' : name;
}

module.exports = { loadPlugin, describePlugin };
