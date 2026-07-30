/**
 * Turns a flat drawing into a height field, so it can be rendered as a solid.
 *
 * This is the classic sketch-inflation idea: measure how far each pixel is from
 * the edge of the shape, and push it out by that much. The middle of the hull is
 * furthest from any edge so it bulges most, the outline stays at zero, and the
 * result is a rounded form that follows whatever was drawn.
 *
 * It is a real mesh - it can be rotated, lit and seen in perspective - but it is
 * derived from the silhouette, not understood. It cannot know a hull is hollow
 * or that a mast is thin. For a boat seen broadside that is a fair trade; for a
 * shape needing genuine structure it is not, and that is what an image-to-3D
 * model would be for.
 */

/**
 * @param {ImageData} image the extracted drawing, transparent outside the shape
 * @param {{alphaThreshold?: number, profile?: number}} options
 * @returns {{width: number, height: number, mask: Uint8Array, heights: Float32Array,
 *            peak: number}}
 */
export function buildHeightField(image, options = {}) {
  const alphaThreshold = options.alphaThreshold ?? 40;
  const profile = options.profile ?? 0.65;

  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);

  for (let i = 0; i < mask.length; i += 1) {
    if (data[i * 4 + 3] >= alphaThreshold) mask[i] = 1;
  }

  const distance = distanceTransform(mask, width, height);

  let peak = 0;
  for (let i = 0; i < distance.length; i += 1) {
    if (distance[i] > peak) peak = distance[i];
  }

  const heights = new Float32Array(width * height);
  if (peak > 0) {
    for (let i = 0; i < heights.length; i += 1) {
      if (!mask[i]) continue;
      // Raised to a power below 1, so the surface rounds off quickly near the
      // edge and flattens across the middle - a hull, rather than a cone.
      heights[i] = Math.pow(distance[i] / peak, profile);
    }
  }

  return { width, height, mask, heights, peak };
}

/**
 * Distance from each filled pixel to the nearest empty one.
 *
 * Two-pass chamfer: one sweep forward accumulating distances from above and
 * left, one back from below and right. Exact Euclidean distance would need more
 * work for no visible difference at this scale, and this is O(n).
 *
 * @returns {Float32Array}
 */
export function distanceTransform(mask, width, height) {
  const INF = 1e9;
  const d = new Float32Array(width * height);
  const diagonal = Math.SQRT2;

  for (let i = 0; i < d.length; i += 1) d[i] = mask[i] ? INF : 0;

  const consider = (index, from, cost) => {
    const candidate = d[from] + cost;
    if (candidate < d[index]) d[index] = candidate;
  };

  // Forward: above-left, above, above-right, left.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;

      if (y > 0) {
        if (x > 0) consider(i, i - width - 1, diagonal);
        consider(i, i - width, 1);
        if (x < width - 1) consider(i, i - width + 1, diagonal);
      }
      if (x > 0) consider(i, i - 1, 1);
    }
  }

  // Backward: below-right, below, below-left, right.
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (!mask[i]) continue;

      if (y < height - 1) {
        if (x < width - 1) consider(i, i + width + 1, diagonal);
        consider(i, i + width, 1);
        if (x > 0) consider(i, i + width - 1, diagonal);
      }
      if (x < width - 1) consider(i, i + 1, 1);
    }
  }

  return d;
}

/**
 * Builds a triangle mesh from the height field.
 *
 * Two shells - one pushed towards the viewer, one away - joined at the
 * silhouette, which makes the drawing a closed solid rather than a curved sheet.
 * Texture coordinates map straight onto the drawing, so the boat is skinned with
 * exactly what the visitor drew, colours and all.
 *
 * @param {{width:number, height:number, mask:Uint8Array, heights:Float32Array}} field
 * @param {{grid?: number, thickness?: number}} options
 * @returns {{positions: Float32Array, normals: Float32Array, uvs: Float32Array,
 *            indices: Uint32Array, triangles: number}}
 */
export function buildMesh(field, options = {}) {
  const grid = Math.max(8, options.grid ?? 88);
  const thickness = options.thickness ?? 0.16;

  const { width, height, mask, heights } = field;

  // The mesh spans the drawing's own aspect, centred on the origin, sized to
  // fit a 1x1 box on its longer edge.
  const aspect = width / height;
  const spanX = aspect >= 1 ? 1 : aspect;
  const spanY = aspect >= 1 ? 1 / aspect : 1;

  const cols = grid;
  const rows = Math.max(8, Math.round(grid / aspect));

  const sample = (buffer, gx, gy) => {
    const x = Math.min(width - 1, Math.round((gx / cols) * (width - 1)));
    const y = Math.min(height - 1, Math.round((gy / rows) * (height - 1)));
    return buffer[y * width + x];
  };

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // Front shell is +z, back shell -z. Vertex index per (row, col, side).
  const indexOf = new Int32Array((cols + 1) * (rows + 1) * 2).fill(-1);
  const key = (gx, gy, side) => (gy * (cols + 1) + gx) * 2 + side;

  // Which grid points land on the drawing. Vertices are made everywhere so a
  // cell can be kept when only some of its corners are on the shape.
  const inside = new Uint8Array((cols + 1) * (rows + 1));
  for (let gy = 0; gy <= rows; gy += 1) {
    for (let gx = 0; gx <= cols; gx += 1) {
      inside[gy * (cols + 1) + gx] = sample(mask, gx, gy) ? 1 : 0;
    }
  }

  for (let side = 0; side < 2; side += 1) {
    const sign = side === 0 ? 1 : -1;

    for (let gy = 0; gy <= rows; gy += 1) {
      for (let gx = 0; gx <= cols; gx += 1) {
        const h = sample(heights, gx, gy) * thickness * sign;

        const u = gx / cols;
        const v = gy / rows;

        indexOf[key(gx, gy, side)] = positions.length / 3;

        positions.push((u - 0.5) * spanX * 2, (0.5 - v) * spanY * 2, h);
        uvs.push(u, v);

        // Normal from the slope of the height field, which is what gives the
        // surface its shading.
        const dx =
          (sample(heights, Math.min(cols, gx + 1), gy) -
            sample(heights, Math.max(0, gx - 1), gy)) *
          thickness *
          sign;
        const dy =
          (sample(heights, gx, Math.min(rows, gy + 1)) -
            sample(heights, gx, Math.max(0, gy - 1))) *
          thickness *
          sign;

        const nx = -dx * cols * 0.5;
        const ny = dy * rows * 0.5;
        const nz = sign;
        const length = Math.hypot(nx, ny, nz) || 1;
        normals.push(nx / length, ny / length, nz / length);
      }
    }
  }

  for (let side = 0; side < 2; side += 1) {
    for (let gy = 0; gy < rows; gy += 1) {
      for (let gx = 0; gx < cols; gx += 1) {
        const a = indexOf[key(gx, gy, side)];
        const b = indexOf[key(gx + 1, gy, side)];
        const c = indexOf[key(gx + 1, gy + 1, side)];
        const d = indexOf[key(gx, gy + 1, side)];

        if (a < 0 || b < 0 || c < 0 || d < 0) continue;

        // A cell is kept if *any* corner is on the drawing, not all four.
        //
        // Requiring all four looked tidier but shredded thin drawings: a pen
        // outline is narrower than a grid cell, so nearly every cell straddled
        // it and was dropped, leaving a sparse skeleton with the grid showing
        // through. The exact silhouette comes from the texture's alpha being
        // discarded in the shader, not from the tessellation - so an oversized
        // mesh costs nothing, and a holed one costs everything.
        const onShape =
          inside[gy * (cols + 1) + gx] ||
          inside[gy * (cols + 1) + gx + 1] ||
          inside[(gy + 1) * (cols + 1) + gx] ||
          inside[(gy + 1) * (cols + 1) + gx + 1];

        if (!onShape) continue;

        // Wind the back shell the other way so both face outwards.
        if (side === 0) indices.push(a, b, c, a, c, d);
        else indices.push(a, c, b, a, d, c);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    triangles: indices.length / 3,
  };
}
