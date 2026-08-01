const config = require('../../config');

/**
 * Stage 4 - mesh generation.
 *
 * The height field becomes a closed solid: a surface over the front of the
 * drawing, the same surface mirrored behind it, and a band of quads round the
 * outline joining the two.
 *
 * The band is what makes it closed, and it is worth saying why it is there
 * rather than the obvious alternative. Welding the two sheets to a single line
 * of vertices at the rim looks simpler and is wrong: two rim vertices can be
 * neighbours across an edge that is on nobody's boundary, and welding them hands
 * that edge two front triangles and two back ones. Four triangles to an edge is
 * not a surface. A band gives every boundary edge exactly one triangle from the
 * front sheet, one from the band, and the same again behind - so every edge in
 * the mesh belongs to exactly two triangles, in opposite directions, which is
 * what watertight means and what the test measures.
 *
 * The silhouette is the child's line. Nothing here smooths a corner they drew or
 * fairs a lopsided outline into a tidier one. Proportions come straight from the
 * artwork - the model's width and height are in the same ratio as the drawing's,
 * to the pixel - and the one thing this stage invents is the third dimension,
 * because there is nothing on the paper to contradict it.
 *
 * Nothing about it is particular to boats. It reads a silhouette and a height,
 * so a flower, a house, a dog and a car all come through the same way.
 */

module.exports = {
  name: 'mesh',
  takes: 'DepthField',
  gives: 'Mesh',

  /**
   * @param {import('../contract').DepthField} depth
   * @param {import('../contract').Context} context
   * @returns {Promise<import('../contract').Mesh|null>}
   */
  async run(depth, context) {
    const grid = resolution(depth, context.faces, config.mesh);
    const sheet = sample(depth, grid);

    const cells = emit(sheet, grid);
    const kept = repairPinches(cells, grid);

    if (!kept.count) {
      context.log('the silhouette is too thin to hold a single cell of the mesh');
      return null;
    }

    const mesh = build(depth, sheet, kept.cells, grid);

    context.log(
      `${mesh.triangles} triangles from a ${grid.width}x${grid.height} grid` +
        `${kept.dropped ? `, ${kept.dropped} pinch${kept.dropped === 1 ? '' : 'es'} opened` : ''}`
    );

    return mesh;
  },
};

/**
 * How fine to make the grid.
 *
 * `grid` is the resolution along the drawing's longer edge and is the dial to
 * turn. The face budget is a ceiling over it rather than a second opinion: a
 * model that has to reach a phone over an exhibition wifi has a size it must
 * come in under, whatever resolution looked good on a desk.
 */
function resolution(depth, faces, settings) {
  const aspect = depth.width / depth.height;
  let long = Math.max(8, settings.grid);

  // Four triangles per cell: two on the front, two on the back.
  const budget = Math.max(64, Math.floor(faces / 4));

  for (;;) {
    const width = aspect >= 1 ? long : Math.max(8, Math.round(long * aspect));
    const height = aspect >= 1 ? Math.max(8, Math.round(long / aspect)) : long;

    if ((width - 1) * (height - 1) <= budget || long <= 8) {
      return { width, height };
    }

    long = Math.floor(long * 0.9);
  }
}

/**
 * The height field read onto the grid.
 *
 * Nearest sample rather than an average of the neighbourhood. Averaging across
 * the boundary would put a fraction of the drawing's height outside its own
 * outline and blur the silhouette by a pixel or two - and the silhouette is the
 * part that is not ours to move.
 */
function sample(depth, grid) {
  const heights = new Float32Array(grid.width * grid.height);
  const inside = new Uint8Array(grid.width * grid.height);

  for (let y = 0; y < grid.height; y += 1) {
    const sy = Math.min(depth.height - 1, Math.round((y / (grid.height - 1)) * (depth.height - 1)));

    for (let x = 0; x < grid.width; x += 1) {
      const sx = Math.min(depth.width - 1, Math.round((x / (grid.width - 1)) * (depth.width - 1)));
      const value = depth.values[sy * depth.width + sx];

      const i = y * grid.width + x;
      heights[i] = value;
      inside[i] = value > 0 ? 1 : 0;
    }
  }

  return { heights, inside };
}

/**
 * A cell is part of the model when any of its corners is in the drawing.
 *
 * Any rather than all, and the difference matters more than it sounds. Requiring
 * all four shrinks the model by up to a cell all the way round, which a wide
 * shape barely notices and a thin one does not survive: on a real scan the
 * paddle shaft disappeared outright and a drawing measuring 1.5 to 1 came back
 * as a model measuring 3.7 to 1, because only the hull was left.
 *
 * Erring the other way is safe here, and it is safe for a specific reason. The
 * geometry does not draw the outline - the texture's alpha does, through an
 * alphaMode of MASK - so geometry that reaches a little past the drawing is
 * trimmed back to the exact line by the alpha, while geometry that falls short
 * takes part of the drawing with it and nothing can put it back.
 *
 * So the rule is: cover everything that was drawn, and let the alpha decide
 * where the drawing ends.
 */
function emit(sheet, grid) {
  const wide = grid.width - 1;
  const tall = grid.height - 1;
  const cells = new Uint8Array(wide * tall);

  for (let y = 0; y < tall; y += 1) {
    for (let x = 0; x < wide; x += 1) {
      const a = y * grid.width + x;
      cells[y * wide + x] =
        sheet.inside[a] || sheet.inside[a + 1] || sheet.inside[a + grid.width] || sheet.inside[a + grid.width + 1]
          ? 1
          : 0;
    }
  }

  return cells;
}

/**
 * Opens the places where the model would touch itself at a single point.
 *
 * Two cells meeting only at a corner - one north-west of a vertex, the other
 * south-east of it, and nothing either side - make that vertex belong to two
 * separate pieces of surface at once. The mesh is still closed, but it is not a
 * manifold, and a pinch like that breaks anything that later wants to subdivide,
 * smooth or unwrap it.
 *
 * It happens where a drawn line runs diagonally and thin: at the grid's
 * resolution the shape narrows to a single point. Dropping one of the two cells
 * parts them. That costs one cell of a thin diagonal - well under the size of
 * the grid square it sits in - and no part of the silhouette that the eye could
 * find.
 */
function repairPinches(cells, grid) {
  const wide = grid.width - 1;
  const tall = grid.height - 1;
  const on = (x, y) => (x < 0 || y < 0 || x >= wide || y >= tall ? 0 : cells[y * wide + x]);

  let dropped = 0;

  // Interior vertices only: a vertex on the border of the grid has no four
  // cells around it to pinch between.
  for (let y = 1; y < tall; y += 1) {
    for (let x = 1; x < wide; x += 1) {
      const nw = on(x - 1, y - 1);
      const ne = on(x, y - 1);
      const sw = on(x - 1, y);
      const se = on(x, y);

      if (nw && se && !ne && !sw) { cells[(y - 1) * wide + (x - 1)] = 0; dropped += 1; }
      else if (ne && sw && !nw && !se) { cells[(y - 1) * wide + x] = 0; dropped += 1; }
    }
  }

  let count = 0;
  for (let i = 0; i < cells.length; i += 1) count += cells[i];

  return { cells, count, dropped };
}

/**
 * Vertices, normals, UVs and triangles.
 *
 * Every vertex of the model gets two copies, one on each sheet, and the band
 * round the outline joins them.
 */
function build(depth, sheet, cells, grid) {
  const wide = grid.width - 1;
  const tall = grid.height - 1;
  const on = (x, y) => (x < 0 || y < 0 || x >= wide || y >= tall ? 0 : cells[y * wide + x]);

  // Proportions come from the drawing. The longer side is one unit and the
  // shorter follows from the aspect, so the model is the shape of the sketch.
  const aspect = depth.width / depth.height;
  const spanX = aspect >= 1 ? 1 : aspect;
  const spanY = aspect >= 1 ? 1 / aspect : 1;
  const half = depth.scale / 2;

  const front = new Int32Array(grid.width * grid.height).fill(-1);
  const back = new Int32Array(grid.width * grid.height).fill(-1);

  const positions = [];
  const uvs = [];

  const place = (x, y, z) => {
    positions.push((x / (grid.width - 1) - 0.5) * spanX, -(y / (grid.height - 1) - 0.5) * spanY, z);

    // Straight off the grid, so every vertex knows which pixel of the drawing it
    // came from and the texture cannot slide against the geometry.
    //
    // v counts downwards, not up. glTF puts the origin of a texture at its top
    // left corner, the same way an image counts its rows - so no flip belongs
    // here. Flipping it renders the drawing upside down in anything that loads
    // the GLB, which is easy to miss because a viewer building geometry by hand
    // usually flips textures on the way in and quietly puts it back.
    uvs.push(x / (grid.width - 1), y / (grid.height - 1));

    return positions.length / 3 - 1;
  };

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      if (!(on(x - 1, y - 1) + on(x, y - 1) + on(x - 1, y) + on(x, y))) continue;

      const i = y * grid.width + x;
      const height = sheet.heights[i] * half;

      front[i] = place(x, y, height);
      back[i] = place(x, y, -height);
    }
  }

  const indices = [];

  for (let y = 0; y < tall; y += 1) {
    for (let x = 0; x < wide; x += 1) {
      if (!cells[y * wide + x]) continue;

      const a = y * grid.width + x;
      const b = a + 1;
      const c = a + grid.width;
      const d = c + 1;

      // Facing the viewer, counter-clockwise.
      indices.push(front[a], front[c], front[b], front[b], front[c], front[d]);

      // ...and the same cell behind, wound the other way so it faces away.
      indices.push(back[a], back[b], back[c], back[b], back[d], back[c]);

      // Where a neighbouring cell is missing, this cell's edge is on the
      // outline of the model and needs the band. Each edge is taken in the
      // direction opposite to the front sheet's use of it, so the whole surface
      // ends up wound the same way round.
      if (!on(x, y - 1)) band(indices, front, back, a, b);
      if (!on(x + 1, y)) band(indices, front, back, b, d);
      if (!on(x, y + 1)) band(indices, front, back, d, c);
      if (!on(x - 1, y)) band(indices, front, back, c, a);
    }
  }

  const position = new Float32Array(positions);
  const index = new Uint32Array(indices);

  // Centred on the drawing rather than on the sheet it was drawn on.
  //
  // A child rarely draws in the middle of the page, and a model centred on the
  // page rather than on itself swings round a point outside it. This is a
  // translation and nothing else: every distance and every ratio is exactly
  // what it was, and the UVs, which say where each vertex came from, are
  // untouched.
  centre(position);

  return {
    positions: position,
    normals: normals(position, index),
    uvs: new Float32Array(uvs),
    indices: index,
    triangles: index.length / 3,
  };
}

/**
 * One quad of the band, joining the front sheet to the back along an edge of
 * the outline.
 */
/** Moves the model so its own middle sits on the origin. */
function centre(positions) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
      if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
    }
  }

  const middle = lo.map((low, k) => (low + hi[k]) / 2);

  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= middle[0];
    positions[i + 1] -= middle[1];
    positions[i + 2] -= middle[2];
  }
}

function band(indices, front, back, p, q) {
  indices.push(front[p], front[q], back[q]);
  indices.push(front[p], back[q], back[p]);
}

/**
 * Vertex normals, from the faces that meet at each one.
 *
 * Area-weighted, because the cross product of two edges is already twice the
 * triangle's area - so a large face pulls a shared normal further than a sliver
 * does, which is what makes a rim between big cells and small ones look even.
 */
function normals(positions, indices) {
  const out = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];

    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];

    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }

  for (let i = 0; i < out.length; i += 3) {
    const length = Math.hypot(out[i], out[i + 1], out[i + 2]);

    if (length > 1e-8) {
      out[i] /= length;
      out[i + 1] /= length;
      out[i + 2] /= length;
    } else {
      // A vertex on the rim between two sheets that cancel exactly. It has no
      // meaningful normal of its own; pointing it at the viewer is as good an
      // answer as any and keeps the array free of zeroes.
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 1;
    }
  }

  return out;
}
