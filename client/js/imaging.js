/**
 * Small shared image-analysis helpers used by both the live detector and the
 * capture-time extractor.
 */

/**
 * Rec. 601 luminance, one byte per pixel.
 * @param {ImageData} imageData
 * @returns {Uint8Array}
 */
export function toLuminance(imageData) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height);

  for (let i = 0, p = 0; p < out.length; i += 4, p += 1) {
    out[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }

  return out;
}

/**
 * Otsu's method: the threshold that maximises between-class variance.
 * Also returns the two class means, which tell us how much contrast the scene
 * actually has - a flat scene produces a threshold too, and we need to know
 * not to trust it.
 *
 * @param {Uint8Array} luma
 * @returns {{threshold: number, darkMean: number, brightMean: number}}
 */
export function otsu(luma) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < luma.length; i += 1) histogram[luma[i]] += 1;

  const total = luma.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let threshold = 127;
  let darkMean = 0;
  let brightMean = 0;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;

    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];

    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > best) {
      best = variance;
      threshold = t;
      darkMean = meanBackground;
      brightMean = meanForeground;
    }
  }

  return { threshold, darkMean, brightMean };
}

/**
 * How much the scene actually moved between two frames, 0..255.
 *
 * The global brightness shift is removed before measuring. That matters a lot
 * in practice: placing a white sheet under the camera makes auto-exposure and
 * auto-white-balance hunt for a second or two, and every frame during that
 * differs from the last *everywhere*. A plain mean-absolute-difference reads
 * that as violent motion and keeps restarting the stability timer, so capture
 * waits for the camera to settle rather than for the paper to.
 *
 * Subtracting the mean difference cancels a uniform exposure change while
 * leaving real, localised movement fully visible.
 */
export function motionBetween(a, b) {
  if (!a || !b || a.length !== b.length) return 255;

  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] - b[i];
  const shift = sum / a.length;

  let deviation = 0;
  for (let i = 0; i < a.length; i += 1) deviation += Math.abs(a[i] - b[i] - shift);
  return deviation / a.length;
}

/**
 * Average luminance around each pixel, using an integral image so the cost does
 * not depend on the radius.
 *
 * @param {Uint8Array} luma
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Float32Array}
 */
export function localMean(luma, width, height, radius) {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += luma[y * width + x];
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
    }
  }

  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);

    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);

      const sum =
        integral[(y1 + 1) * stride + (x1 + 1)] -
        integral[y0 * stride + (x1 + 1)] -
        integral[(y1 + 1) * stride + x0] +
        integral[y0 * stride + x0];

      out[y * width + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }

  return out;
}

/**
 * Ink mask by local comparison rather than one threshold for the whole page.
 *
 * This matters more than anything else in the extractor. A single global
 * threshold works only when the page is evenly lit; under a real lamp or a
 * window, Otsu ends up splitting the *lighting gradient* instead of the ink -
 * half the sheet reads as drawing, or a pale pencil vanishes entirely and the
 * page reads as blank. A pixel is ink if it is darker than its own
 * surroundings, which is true regardless of how the light falls.
 *
 * `reference` is the local paper level, and is what the caller should compare
 * against later instead of a fixed number.
 *
 * @returns {{mask: Uint8Array, reference: Float32Array, inkCount: number}}
 */
export function adaptiveInk(luma, width, height, { radius, offset, margin = 0 }) {
  const reference = localMean(luma, width, height, radius);
  const mask = new Uint8Array(width * height);

  let inkCount = 0;

  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const i = y * width + x;
      if (luma[i] <= reference[i] - offset) {
        mask[i] = 1;
        inkCount += 1;
      }
    }
  }

  return { mask, reference, inkCount };
}

/**
 * Creates a detached 2D canvas. `willReadFrequently` matters here: without it
 * browsers keep the canvas on the GPU and every getImageData() stalls.
 *
 * @param {number} width
 * @param {number} height
 */
export function createCanvas(width, height) {
  // Off the main thread there is no document to make an element with, and an
  // OffscreenCanvas is the same thing for every purpose anything here has: it
  // has a 2d context, getImageData and putImageData. This is what lets the
  // extraction run in a worker without a line of it changing.
  if (typeof document === 'undefined') return new OffscreenCanvas(width, height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** @returns {CanvasRenderingContext2D} */
export function context2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}
