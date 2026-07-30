/**
 * Connected-component labelling, shared by the live marker detector and the
 * capture-time drawing extractor.
 */

/**
 * 8-connected labelling with an explicit stack (recursion would blow the call
 * stack on a page-sized region).
 *
 * @param {Uint8Array} mask 1 where the pixel is foreground
 * @param {number} width
 * @param {number} height
 * @returns {{components: object[], labels: Int32Array}}
 */
export function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const components = [];
  const stack = new Int32Array(width * height);

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start] !== -1) continue;

    const label = components.length;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;

    while (top > 0) {
      const index = stack[--top];
      const x = index % width;
      const y = (index - x) / width;

      area += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;

          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const n = ny * width + nx;
          if (mask[n] && labels[n] === -1) {
            labels[n] = label;
            stack[top++] = n;
          }
        }
      }
    }

    components.push({
      label,
      area,
      minX,
      maxX,
      minY,
      maxY,
      centroid: { x: sumX / area, y: sumY / area },
      boxWidth: maxX - minX + 1,
      boxHeight: maxY - minY + 1,
    });
  }

  return { components, labels };
}
