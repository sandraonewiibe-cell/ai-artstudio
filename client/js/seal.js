/**
 * Closing the holes a faint pencil leaves inside a boat.
 *
 * Nothing here is extraction. The drawing arrives already extracted and is not
 * re-judged: no pixel changes colour, no edge moves, and nothing outside the
 * sketch is touched. What this does is narrower - where the sketch has shut an
 * area in and that area came through see-through, the wall would show the lake
 * through the middle of somebody's hull. Those gaps are closed, and closed with
 * the colour that surrounds them, so what fills a gap is the artist's own
 * shading rather than a colour of ours.
 *
 * "Shut in" is the whole test. The transparent background is flooded inward
 * from the edge of the picture; anything the flood reaches is outside the
 * sketch and stays exactly as transparent as it arrived. Only what the flood
 * cannot reach is inside, and only that is filled.
 */

// Below this the pixel is see-through as far as the wall is concerned. The same
// floor the height field uses to find the silhouette, so the two agree on what
// counts as part of the boat.
const ALPHA_FLOOR = 40;

/**
 * @param {HTMLImageElement|HTMLCanvasElement} image the extracted drawing
 * @returns {HTMLCanvasElement|HTMLImageElement} the drawing with its inside
 *   closed up, or the original if there was nothing to close
 */
export function sealHoles(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return image;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);

  const picture = ctx.getImageData(0, 0, width, height);
  const filled = sealInPlace(picture, width, height);
  if (!filled) return image;

  ctx.putImageData(picture, 0, 0);
  console.log(`[seal] closed ${filled} see-through pixel(s) inside the drawing`);

  return canvas;
}

/**
 * Closes the enclosed gaps of an ImageData, in place.
 *
 * Split out from the canvas work so it can be run and measured on its own.
 *
 * @returns {number} how many pixels were filled
 */
export function sealInPlace(picture, width, height) {
  const data = picture.data;
  const solid = new Uint8Array(width * height);

  for (let i = 0; i < solid.length; i += 1) {
    if (data[i * 4 + 3] >= ALPHA_FLOOR) solid[i] = 1;
  }

  // The page around the drawing, flooded in from the edge of the picture. Four
  // connectivity, so a diagonal line of pencil still counts as a seal - the
  // same rule the drawing was extracted under.
  const outside = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;

  const push = (i) => {
    if (!solid[i] && !outside[i]) {
      outside[i] = 1;
      stack[top++] = i;
    }
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    const y = (i - x) / width;

    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }

  let remaining = 0;
  const hole = new Uint8Array(width * height);
  for (let i = 0; i < hole.length; i += 1) {
    if (!solid[i] && !outside[i]) {
      hole[i] = 1;
      remaining += 1;
    }
  }

  if (!remaining) return 0;

  const filled = remaining;

  // Grown in from the edges of each gap, a ring of pixels at a time, each new
  // pixel taking the average of the drawn pixels it touches. Colour spreads
  // inward from all sides at once rather than being smeared across from one, so
  // a gap between two shades comes out as the two shades meeting rather than as
  // a streak of whichever side happened to be visited first.
  while (remaining) {
    const ring = [];

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (!hole[i]) continue;

        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;

            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

            const j = ny * width + nx;
            if (!solid[j]) continue;

            r += data[j * 4];
            g += data[j * 4 + 1];
            b += data[j * 4 + 2];
            n += 1;
          }
        }

        if (n) ring.push(i, Math.round(r / n), Math.round(g / n), Math.round(b / n));
      }
    }

    // A gap with no drawn pixel anywhere around it cannot happen - it was found
    // by being enclosed - but a loop that cannot make progress must still end.
    if (!ring.length) break;

    for (let k = 0; k < ring.length; k += 4) {
      const i = ring[k];
      data[i * 4] = ring[k + 1];
      data[i * 4 + 1] = ring[k + 2];
      data[i * 4 + 2] = ring[k + 3];
      data[i * 4 + 3] = 255;
      solid[i] = 1;
      hole[i] = 0;
      remaining -= 1;
    }
  }

  return filled;
}
