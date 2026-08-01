/**
 * Stage 6 - GLB export.
 *
 * One binary glTF: the geometry, and the child's drawing embedded in it as the
 * PNG that came off the scanner. A file that can be downloaded to a phone and
 * still be the drawing when it gets there.
 *
 * Written out rather than vendored. A GLB is a header, a chunk of JSON and a
 * chunk of binary, which is the file below; an exporter from npm would want a
 * scene graph this pipeline does not have and would arrive with a dependency
 * tree to match.
 *
 * Two decisions in here are the whole point of the phase.
 *
 * The material is unlit - KHR_materials_unlit. A lit material hands whatever
 * opens the file permission to apply its own shading to a child's colours, and
 * this project has already spent a long time chasing a grey boat that turned out
 * to be exactly that: a lighting model darkening a drawing nobody had asked it to
 * touch. Unlit means the colour in the file is the colour on the paper, in every
 * viewer, under every light. Nothing to get wrong later.
 *
 * The texture is the scan, byte for byte, embedded whole. Not resampled to a
 * power of two, not recompressed smaller, not flattened onto a white background.
 * Each of those would be defensible on its own and each would lose something -
 * a pencil stroke thinned, a faint green shifted, paper turned grey at the edge
 * of a letter. contract.js checks the bytes that go in are the bytes that came
 * out of extraction, so this cannot quietly stop being true.
 */

// glTF component types.
const FLOAT = 5126;
const UNSIGNED_INT = 5125;

// Buffer view targets.
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

// Sampler filters and wrapping.
const LINEAR = 9729;
const CLAMP_TO_EDGE = 33071;

module.exports = {
  name: 'glb',
  takes: 'Mesh',
  gives: 'Model',

  /**
   * @param {import('../contract').Mesh} mesh
   * @param {import('../contract').Context} context
   * @returns {Promise<import('../contract').Model|null>}
   */
  async run(mesh, context) {
    const texture = context.made && context.made.Texture;

    if (!texture) {
      // Geometry with no drawing on it would be a grey blob, which is the one
      // thing this pipeline exists not to produce.
      context.log('no texture to embed');
      return null;
    }

    const parts = [];
    const views = [];

    // Everything goes in one buffer, each piece aligned to four bytes because
    // that is what the accessors' component types need.
    const add = (data, target) => {
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const offset = pad(parts);

      parts.push(bytes);

      const view = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
      if (target) view.target = target;

      views.push(view);
      return views.length - 1;
    };

    const positions = add(mesh.positions, ARRAY_BUFFER);
    const normals = add(mesh.normals, ARRAY_BUFFER);
    const uvs = add(mesh.uvs, ARRAY_BUFFER);
    const indices = add(mesh.indices, ELEMENT_ARRAY_BUFFER);

    // The image has no target: it is not vertex data, and a viewer that binds it
    // as such would be doing something odd.
    const image = add(texture.buffer, null);

    const vertices = mesh.positions.length / 3;
    const bounds = extent(mesh.positions);

    const json = {
      asset: { version: '2.0', generator: 'AI ART STUDIO' },

      extensionsUsed: ['KHR_materials_unlit'],

      // Required, not merely used. A viewer that cannot honour it would light
      // the drawing, and a drawing that arrives lit is the fault this is here to
      // prevent - better to refuse to open than to open wrong.
      extensionsRequired: ['KHR_materials_unlit'],

      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: 'drawing' }],

      meshes: [
        {
          name: 'drawing',
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
              indices: 3,
              material: 0,
            },
          ],
        },
      ],

      materials: [
        {
          name: 'sketch',
          pbrMetallicRoughness: {
            // White and untinted: the texture is the colour, and a base colour
            // factor of anything else would multiply the child's drawing by it.
            baseColorFactor: [1, 1, 1, 1],
            baseColorTexture: { index: 0, texCoord: 0 },
            metallicFactor: 0,
            roughnessFactor: 1,
          },

          // Both sides. The back of the model is as much the drawing as the
          // front, and a single-sided material would show a hole through it.
          doubleSided: true,

          // The silhouette lives in the texture's alpha. MASK rather than BLEND
          // so the outline stays crisp and the model needs no sorting.
          alphaMode: 'MASK',
          alphaCutoff: 0.5,

          extensions: { KHR_materials_unlit: {} },
        },
      ],

      textures: [{ sampler: 0, source: 0 }],
      images: [{ bufferView: image, mimeType: texture.mime || 'image/png' }],

      samplers: [
        {
          // No mipmaps. A drawing is rarely a power of two, and a minifying
          // filter that wants mip levels is the usual reason a texture arrives
          // black in one viewer and fine in another.
          magFilter: LINEAR,
          minFilter: LINEAR,
          wrapS: CLAMP_TO_EDGE,
          wrapT: CLAMP_TO_EDGE,
        },
      ],

      accessors: [
        {
          bufferView: positions,
          componentType: FLOAT,
          count: vertices,
          type: 'VEC3',
          // Required by the spec for POSITION, and what lets a viewer frame the
          // model without walking every vertex first.
          min: bounds.min,
          max: bounds.max,
        },
        { bufferView: normals, componentType: FLOAT, count: vertices, type: 'VEC3' },
        { bufferView: uvs, componentType: FLOAT, count: vertices, type: 'VEC2' },
        {
          bufferView: indices,
          componentType: UNSIGNED_INT,
          count: mesh.indices.length,
          type: 'SCALAR',
        },
      ],

      bufferViews: views,
      buffers: [{ byteLength: pad(parts) }],
    };

    const binary = Buffer.concat(padded(parts));
    const buffer = wrap(json, binary);

    context.log(
      `${Math.round(buffer.length / 1024)}KB - ${mesh.triangles} triangles, ` +
        `${texture.width}x${texture.height} texture embedded, unlit`
    );

    return { buffer, ext: 'glb', by: 'glb' };
  },
};

/** Where the next piece starts, once everything before it is aligned to four. */
function pad(parts) {
  return parts.reduce((total, part) => total + align(part.length), 0);
}

const align = (length) => length + ((4 - (length % 4)) % 4);

/** The pieces, each grown to a multiple of four bytes. */
function padded(parts) {
  const out = [];

  for (const part of parts) {
    out.push(part);
    const slack = align(part.length) - part.length;
    if (slack) out.push(Buffer.alloc(slack));
  }

  return out;
}

/** The corners of the model, which POSITION accessors are required to carry. */
function extent(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }

  return { min, max };
}

/**
 * Header, JSON chunk, binary chunk.
 *
 * The JSON is padded with spaces and the binary with zeroes, which is what the
 * spec asks for - a parser is allowed to hand the JSON chunk straight to a JSON
 * reader, and trailing nulls would choke one.
 */
function wrap(json, binary) {
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([text, Buffer.alloc(align(text.length) - text.length, 0x20)]);
  const binChunk = Buffer.concat([binary, Buffer.alloc(align(binary.length) - binary.length, 0)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.write('JSON', 4, 'ascii');

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.write('BIN\0', 4, 'ascii');

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}
