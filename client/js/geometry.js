/**
 * Perspective correction: quad ordering, homography solving and warping.
 * No dependencies - this is a small amount of linear algebra rather than a
 * reason to pull OpenCV into the project.
 */

/**
 * Orders four points as [topLeft, topRight, bottomRight, bottomLeft].
 * Uses the standard sum/difference trick: the top-left has the smallest
 * x+y, the bottom-right the largest, and the other two split on x-y.
 *
 * @param {{x:number,y:number}[]} points
 */
export function orderCorners(points) {
  const sum = points.map((p) => p.x + p.y);
  const diff = points.map((p) => p.x - p.y);

  const at = (arr, pick) => points[arr.indexOf(pick(...arr))];

  return [
    at(sum, Math.min),   // top-left
    at(diff, Math.max),  // top-right
    at(sum, Math.max),   // bottom-right
    at(diff, Math.min),  // bottom-left
  ];
}

/**
 * Solves the 3x3 homography H such that H * src[i] ~= dst[i], with h33 fixed
 * at 1. Returns the 9 coefficients row-major, or null if the system is
 * degenerate (three collinear corners, for instance).
 *
 * @param {{x:number,y:number}[]} src four points
 * @param {{x:number,y:number}[]} dst four points
 * @returns {number[]|null}
 */
export function solveHomography(src, dst) {
  const a = [];
  const b = [];

  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];

    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const h = solveLinearSystem(a, b);
  if (!h) return null;

  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Gaussian elimination with partial pivoting. `a` is n x n, `b` is length n.
 * @returns {number[]|null}
 */
function solveLinearSystem(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }

    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      if (!factor) continue;
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }

  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Warps the quad region of `source` into a flat rectangle.
 *
 * Works by inverse mapping: for every output pixel we solve back to a source
 * coordinate and sample it bilinearly, which avoids the holes a forward map
 * would leave.
 *
 * @param {ImageData} source full-resolution frame
 * @param {{x:number,y:number}[]} quad ordered [tl, tr, br, bl] in source pixels
 * @param {number} outW
 * @param {number} outH
 * @returns {ImageData|null}
 */
export function warpToRect(source, quad, outW, outH) {
  const dst = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];

  // Output -> source, so we can walk output pixels.
  const h = solveHomography(dst, quad);
  if (!h) return null;

  const out = new ImageData(outW, outH);
  const src = source.data;
  const dstData = out.data;
  const sw = source.width;
  const sh = source.height;

  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const w = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / w;
      const sy = (h[3] * x + h[4] * y + h[5]) / w;

      const o = (y * outW + x) * 4;

      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        dstData[o + 3] = 255; // outside the frame: opaque black
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      for (let c = 0; c < 3; c += 1) {
        const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
        const bottom = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
        dstData[o + c] = top * (1 - fy) + bottom * fy;
      }
      dstData[o + 3] = 255;
    }
  }

  return out;
}

/** Euclidean distance between two points. */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shoelace area of an ordered polygon. */
export function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    area += p.x * q.y - q.x * p.y;
  }
  return Math.abs(area) / 2;
}
