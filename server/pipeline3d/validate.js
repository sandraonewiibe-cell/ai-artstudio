/**
 * Is this GLB something a display can actually show?
 *
 * A provider that answers at all is not the same as a provider that answered
 * usefully. An image-to-3D service can return a truncated download, an error
 * page with a .glb name on it, a file whose chunks disagree with its header, or
 * a perfectly valid model with no geometry in it - and every one of those
 * reaches the wall as a boat that never appears, with nothing in the log to say
 * why.
 *
 * So the file is opened and read before it is kept. This is not a full glTF
 * validator and does not try to be: it answers the question the exhibition
 * actually has, which is whether there is a mesh in here with vertices and a
 * material, described by a header that matches the bytes underneath it.
 */

const MAGIC = 0x46546c67; // 'glTF', little-endian
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/**
 * @param {Buffer} buffer
 * @returns {{ok: true, meshes: number, vertices: number, images: number, unlit: boolean,
 *            textured: boolean, bytes: number} | {ok: false, why: string}}
 */
function inspect(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) {
    return { ok: false, why: `only ${buffer ? buffer.length : 0} bytes - not a model` };
  }

  if (buffer.readUInt32LE(0) !== MAGIC) {
    // The usual disappointment: an HTML error page saved under a .glb name.
    const start = buffer.subarray(0, 40).toString('utf8').replace(/\s+/g, ' ').trim();
    return { ok: false, why: `not a GLB - it begins "${start.slice(0, 30)}"` };
  }

  if (buffer.readUInt32LE(4) !== 2) {
    return { ok: false, why: `glTF version ${buffer.readUInt32LE(4)}, and this reads version 2` };
  }

  const declared = buffer.readUInt32LE(8);
  if (declared !== buffer.length) {
    // A truncated download is the common cause, and it is worth naming, because
    // the file looks fine until something tries to read past the end of it.
    return { ok: false, why: `header says ${declared} bytes, the file is ${buffer.length} - truncated` };
  }

  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== JSON_CHUNK) {
    return { ok: false, why: 'the first chunk is not JSON' };
  }

  if (20 + jsonLength > buffer.length) {
    return { ok: false, why: 'the JSON chunk runs past the end of the file' };
  }

  let gltf;
  try {
    gltf = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength));
  } catch (err) {
    return { ok: false, why: `the JSON chunk will not parse: ${err.message}` };
  }

  const meshes = gltf.meshes || [];
  if (!meshes.length) return { ok: false, why: 'no meshes in it' };

  const primitives = meshes.flatMap((mesh) => mesh.primitives || []);
  if (!primitives.length) return { ok: false, why: 'a mesh with no primitives' };

  const accessors = gltf.accessors || [];
  let vertices = 0;

  for (const primitive of primitives) {
    const position = primitive.attributes && primitive.attributes.POSITION;
    if (position === undefined) return { ok: false, why: 'a primitive with no POSITION' };

    const accessor = accessors[position];
    if (!accessor || !accessor.count) return { ok: false, why: 'a POSITION accessor with no vertices' };

    vertices += accessor.count;
  }

  if (!vertices) return { ok: false, why: 'no vertices anywhere in it' };

  // The binary chunk has to be there if anything points into it.
  const needsBinary = (gltf.bufferViews || []).length > 0;
  if (needsBinary) {
    const at = 20 + jsonLength;
    if (at + 8 > buffer.length) return { ok: false, why: 'there is no binary chunk, and it is needed' };
    if (buffer.readUInt32LE(at + 4) !== BIN_CHUNK) return { ok: false, why: 'the second chunk is not BIN' };

    const binLength = buffer.readUInt32LE(at);
    if (at + 8 + binLength > buffer.length) {
      return { ok: false, why: 'the binary chunk runs past the end of the file' };
    }
  }

  // A buffer with a uri points at a file that is not in here, which for a kiosk
  // clip on somebody's phone means a model that arrives without its geometry.
  const external = (gltf.buffers || []).filter((b) => b.uri && !b.uri.startsWith('data:'));
  if (external.length) {
    return { ok: false, why: `it refers to ${external.length} file(s) outside itself` };
  }

  const materials = gltf.materials || [];

  return {
    ok: true,
    bytes: buffer.length,
    meshes: meshes.length,
    vertices,
    images: (gltf.images || []).length,
    textured: primitives.some((p) => {
      const material = materials[p.material];
      return Boolean(material && material.pbrMetallicRoughness
        && material.pbrMetallicRoughness.baseColorTexture);
    }),
    unlit: materials.some((m) => m.extensions && m.extensions.KHR_materials_unlit),
  };
}

module.exports = { inspect };
