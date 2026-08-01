const fs = require('fs');
const path = require('path');
const config = require('../config');
const pipeline3d = require('./index');

/**
 * Building a mesh from a drawing already on disk, for looking at.
 *
 * Phase 2 produces geometry and no file - there is no exporter yet - so the only
 * way to see whether a mesh is a real solid rather than a convincing sheet is to
 * hand it to a renderer and turn it round. This is what /preview asks.
 *
 * Off in production, for two reasons. It builds a mesh on request, so anyone who
 * could reach it could make the kiosk do real work on demand; and it lists what
 * is in the uploads directory. The files there are already reachable one by one
 * over /uploads, but a listing is a different thing from a file - it turns
 * "guess a visitor's session id" into "read them all" - and an exhibition tool
 * has no business handing that out.
 */

// A name and nothing else. No slashes, no dots leading anywhere, no traversal.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;

/**
 * The last few exports, so the page can fetch the GLB it was just told about.
 *
 * In memory rather than on disk. A preview is somebody looking at a drawing that
 * is already saved, and writing a file for every look would fill generated/ with
 * models nobody asked to keep.
 */
const recent = new Map();
const KEEP = 8;

function available() {
  return !config.isProduction;
}

/** The drawings that can be previewed, newest first. */
function list() {
  const dir = config.paths.uploads;
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('-drawing.png') && SAFE.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs, size: fs.statSync(path.join(dir, name)).size }))
    .filter((entry) => entry.size > 1000)
    .sort((a, b) => b.at - a.at)
    .slice(0, 60)
    .map((entry) => ({ name: entry.name, size: entry.size }));
}

/**
 * Runs one drawing through the pipeline and returns its mesh as plain JSON.
 *
 * @param {string} name a file in uploads/
 */
async function build(name) {
  if (!SAFE.test(name)) throw new Error('That is not a drawing this can open.');

  const file = path.join(config.paths.uploads, name);
  if (!fs.existsSync(file)) throw new Error('No such drawing.');

  const buffer = fs.readFileSync(file);
  const started = Date.now();

  const outcome = await pipeline3d.run(
    { page: buffer, drawing: buffer, mime: 'image/png' },
    { job: 'preview0-0000', text: null, faces: config.mesh.faces, texture: true }
  );

  if (!outcome.mesh) {
    const stopped = outcome.stages.find((s) => s.stage === 'depth' || s.stage === 'mesh');
    throw new Error(`No mesh: ${stopped ? `${stopped.stage} - ${stopped.why}` : 'the pipeline produced none'}`);
  }

  const mesh = outcome.mesh;

  // Kept in memory rather than written out. A preview is somebody looking, not
  // a visitor's model, and the uploads it builds from are already on disk.
  // The cleaned artwork is kept alongside the export, because that is what the
  // model is textured with - comparing the render against the raw scan would
  // count the corner markers the cleanup removed as differences.
  recent.set(name, {
    glb: outcome.model ? outcome.model.buffer : null,
    texture: outcome.texture ? outcome.texture.buffer : null,
  });
  if (recent.size > KEEP) recent.delete(recent.keys().next().value);

  const exported = outcome.stages.find((s) => s.stage === 'glb');

  return {
    drawing: `/api/preview/drawing/${encodeURIComponent(name)}`,
    glb: outcome.model ? `/api/preview/glb/${encodeURIComponent(name)}` : null,
    stats: {
      vertices: mesh.positions.length / 3,
      triangles: mesh.triangles,
      totalMs: Date.now() - started,
      stages: outcome.stages
        .filter((s) => s.ms !== undefined)
        .map((s) => ({ stage: s.stage, ms: s.ms, why: s.why })),
      grid: config.mesh.grid,
      faceBudget: config.mesh.faces,
      textureWidth: outcome.texture ? outcome.texture.width : null,
      textureHeight: outcome.texture ? outcome.texture.height : null,
      glbBytes: outcome.model ? outcome.model.buffer.length : 0,
      exportMs: exported ? exported.ms : null,
    },

    // Plain arrays: this crosses JSON, and a typed array would arrive as an
    // object with numbered keys.
    positions: Array.from(mesh.positions),
    normals: Array.from(mesh.normals),
    uvs: Array.from(mesh.uvs),
    indices: Array.from(mesh.indices),
  };
}

/**
 * The artwork the model was textured with, so the preview compares like with
 * like. That is the cleaned drawing where one has been built, and the file on
 * disk before then.
 */
function drawing(name) {
  if (!SAFE.test(name)) throw new Error('That is not a drawing this can open.');

  const held = recent.get(name);
  if (held && held.texture) return held.texture;

  const file = path.join(config.paths.uploads, name);
  if (!fs.existsSync(file)) throw new Error('No such drawing.');

  return fs.readFileSync(file);
}

/** The GLB from the most recent build of a drawing. */
function glb(name) {
  if (!SAFE.test(name)) throw new Error("That is not a drawing this can open.");

  const held = recent.get(name);
  if (!held || !held.glb) throw new Error("No export for that drawing yet - build it first.");

  return held.glb;
}

module.exports = { available, list, build, drawing, glb };
