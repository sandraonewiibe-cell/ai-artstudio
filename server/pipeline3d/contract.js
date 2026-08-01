/**
 * What passes between the stages of the 3D pipeline.
 *
 * Every stage takes one of these and returns the next. Nothing reaches around a
 * stage to the one before it, and no stage knows who calls it - which is the
 * whole point of writing them down here rather than letting each pair of
 * neighbours agree privately on what they pass.
 *
 * A stage returning null is a normal answer meaning "not this time". The
 * placeholder stages all do it, so the pipeline can be wired up and run end to
 * end before depth or mesh generation exist. The runner stops there, says which
 * stage stopped it and why, and the kiosk carries on with the boat it already
 * has. Returning null is never an error; throwing is.
 *
 * One rule outranks the rest. The child's drawing passes through untouched:
 * every stage may measure it, and none may repaint it. The assertions below
 * enforce that where they can.
 */

/**
 * The sheet, as the camera saw it.
 *
 * @typedef {object} Sheet
 * @property {Buffer} page      the whole photograph, background and all
 * @property {string} mime
 * @property {string|null} text the name read off the page, if any
 */

/**
 * The drawing with the table, the shadow and the edge of the paper taken off.
 *
 * Alpha carries the silhouette: opaque is drawing, transparent is everything
 * that was never part of it. White paper *inside* the drawing stays white and
 * opaque - it is part of what the child made, and is not background.
 *
 * @typedef {object} Cutout
 * @property {Buffer} buffer
 * @property {string} mime
 * @property {number} width
 * @property {number} height
 * @property {boolean} hasAlpha whether a silhouette came with it
 */

/**
 * The artwork: lines, colours and handwriting exactly as drawn.
 *
 * Byte-identical to the Cutout it came from unless a stage is configured to
 * change it, which nothing in this pipeline currently is. It is a separate type
 * because it means something different - background removal answers "what is
 * the drawing", this answers "what is in it".
 *
 * @typedef {object} Artwork
 * @property {Buffer} buffer
 * @property {string} mime
 * @property {number} width
 * @property {number} height
 * @property {boolean} exact   true when nothing has been repainted
 */

/**
 * How far every point of the drawing stands off the page.
 *
 * A single channel the size of the artwork, in the artwork's own pixel grid, so
 * a depth sample and a texel are the same place. Values run 0 (flat on the
 * page) to 1 (the highest point), with `scale` saying what 1 means in the
 * model's units.
 *
 * @typedef {object} DepthField
 * @property {Float32Array} values
 * @property {number} width
 * @property {number} height
 * @property {number} scale
 */

/**
 * Geometry, in the renderer's units, centred on the origin.
 *
 * UVs index the artwork directly, so whatever the mesh does the texture stays
 * pinned to the drawing that produced it.
 *
 * @typedef {object} Mesh
 * @property {Float32Array} positions
 * @property {Float32Array} normals
 * @property {Float32Array} uvs
 * @property {Uint32Array} indices
 * @property {number} triangles
 */

/**
 * The artwork prepared as a texture, and how the mesh should read it.
 *
 * @typedef {object} Texture
 * @property {Buffer} buffer
 * @property {string} mime
 * @property {number} width
 * @property {number} height
 * @property {boolean} premultiplied
 */

/**
 * A finished model, ready to be written to disk and served.
 *
 * @typedef {object} Model
 * @property {Buffer} buffer
 * @property {string} ext
 * @property {string} by   which stage or plugin made it
 */

/**
 * What every stage looks like.
 *
 * @typedef {object} Stage
 * @property {string} name
 * @property {string} takes     the type it accepts, for the log and the docs
 * @property {string} gives     the type it returns
 * @property {boolean} [placeholder] true while a stage is architecture only
 * @property {(input: any, context: Context) => Promise<any|null>} run
 */

/**
 * What a stage is told about the run it is part of.
 *
 * @typedef {object} Context
 * @property {string} job      the session id, for logging
 * @property {string|null} text
 * @property {number} faces    face budget for the mesh
 * @property {boolean} texture whether a textured model is wanted
 * @property {object} made everything produced so far, by type - for the one
 *   stage that needs two things at once
 * @property {(message: string) => void} log
 */

/** @param {Stage} stage */
function assertStage(stage, id) {
  if (!stage || typeof stage.run !== 'function') {
    throw new Error(`Pipeline stage "${id}" must export run().`);
  }

  if (!stage.name) throw new Error(`Pipeline stage "${id}" must have a name.`);

  return stage;
}

/** @param {Cutout|null} cutout */
function assertCutout(cutout, by) {
  if (cutout === null) return null;

  if (!cutout || !Buffer.isBuffer(cutout.buffer) || !cutout.buffer.length) {
    throw new Error(`"${by}" returned no image.`);
  }

  if (!cutout.width || !cutout.height) {
    throw new Error(`"${by}" returned an image of no size.`);
  }

  return cutout;
}

/**
 * @param {Artwork|null} artwork
 * @param {Cutout} from the image it was made from
 */
function assertArtwork(artwork, from, by) {
  if (artwork === null) return null;
  assertCutout(artwork, by);

  // The promise this pipeline makes. A stage may say it changed the artwork,
  // but it may not change it quietly - and nothing here is allowed to change it
  // at all yet, so a difference is a bug rather than a decision.
  if (artwork.exact && !artwork.buffer.equals(from.buffer)) {
    throw new Error(`"${by}" reported the artwork was untouched, but it is not.`);
  }

  return artwork;
}

/** @param {DepthField|null} depth */
function assertDepth(depth, artwork, by) {
  if (depth === null) return null;

  if (!depth || !(depth.values instanceof Float32Array)) {
    throw new Error(`"${by}" returned no depth values.`);
  }

  if (depth.values.length !== depth.width * depth.height) {
    throw new Error(
      `"${by}" returned ${depth.values.length} depth values for a ${depth.width}x${depth.height} field.`
    );
  }

  return depth;
}

/** @param {Mesh|null} mesh */
function assertMesh(mesh, by) {
  if (mesh === null) return null;

  if (!mesh || !(mesh.positions instanceof Float32Array) || !mesh.positions.length) {
    throw new Error(`"${by}" returned no geometry.`);
  }

  if (mesh.indices.length % 3) {
    throw new Error(`"${by}" returned ${mesh.indices.length} indices, which is not whole triangles.`);
  }

  if (mesh.uvs.length / 2 !== mesh.positions.length / 3) {
    throw new Error(`"${by}" returned ${mesh.uvs.length / 2} UVs for ${mesh.positions.length / 3} vertices.`);
  }

  return mesh;
}

/**
 * @param {Texture|null} texture
 * @param {Artwork} artwork
 */
function assertTexture(texture, artwork, by) {
  if (texture === null) return null;

  if (!texture || !Buffer.isBuffer(texture.buffer) || !texture.buffer.length) {
    throw new Error(`"${by}" returned no texture.`);
  }

  // The texture is the child's drawing. If it ever stops being byte-identical,
  // something has resampled or recompressed the artwork on the way to the
  // model, and the colours on the wall are no longer the colours on the paper.
  if (!texture.buffer.equals(artwork.buffer)) {
    throw new Error(`"${by}" returned a texture that is not the artwork itself.`);
  }

  return texture;
}

/** @param {Model|null} model */
function assertModel(model, by) {
  if (model === null) return null;

  if (!model || !Buffer.isBuffer(model.buffer) || !model.buffer.length) {
    throw new Error(`"${by}" returned no model.`);
  }

  return { buffer: model.buffer, ext: model.ext || 'glb', by: model.by || by };
}

module.exports = {
  assertStage,
  assertCutout,
  assertArtwork,
  assertDepth,
  assertMesh,
  assertTexture,
  assertModel,
};
