import { extractDrawing } from './extract.js';
import { createCanvas, context2d } from './imaging.js';

/**
 * Runs the extraction without stopping the kiosk while it happens.
 *
 * The extraction itself is untouched and is the same code either way. What this
 * decides is only *where* it runs: in a worker if the browser has one, and on
 * the main thread if it does not, or if the worker fails for any reason.
 *
 * Why it is worth the trouble: measured in the browser on a real scan of a
 * 1080x744 page, the extraction takes 1202ms while encoding both images to PNG
 * takes 63ms. All of that second was spent on the thread that draws the screen,
 * so on every single scan the camera preview froze, the flash stopped
 * mid-animation and the progress ring stuck - and it looked, correctly, like the
 * kiosk had hung.
 *
 * Moving it does not make it faster. It makes it happen somewhere the visitor
 * cannot see, with the screen still alive in front of them.
 *
 * Every way this can go wrong ends with the drawing still being extracted. No
 * worker support, no OffscreenCanvas, a module that will not load, a thrown
 * error, a worker that never answers: all of them fall back to running it here,
 * exactly as before.
 */

/** How long to wait for the worker before giving up on it and doing it here. */
const PATIENCE_MS = 20000;

let worker = null;
let unusable = false;

/**
 * @param {HTMLCanvasElement} pageCanvas the rectified page
 * @returns {Promise<object|null>} what extractDrawing returns, with `canvas`
 *   being a canvas on this thread
 */
export async function extract(pageCanvas) {
  const offThread = await tryWorker(pageCanvas);
  if (offThread !== undefined) return offThread;

  // Here, then - and the kiosk holds still for a second, which is what it did
  // before any of this.
  return extractDrawing(pageCanvas);
}

/**
 * Hands the page to the worker.
 *
 * Returns `undefined` - not null - when the worker could not be used at all, so
 * that "there was no drawing on the page" and "the worker did not work" stay
 * different answers.
 */
async function tryWorker(pageCanvas) {
  const running = start();
  if (!running) return undefined;

  const { width, height } = pageCanvas;
  const page = context2d(pageCanvas).getImageData(0, 0, width, height);

  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not answer')), PATIENCE_MS);

      const done = (value) => {
        clearTimeout(timer);
        running.removeEventListener('message', onMessage);
        running.removeEventListener('error', onError);
        resolve(value);
      };

      const onMessage = (event) => done(event.data);
      const onError = (event) => {
        clearTimeout(timer);
        running.removeEventListener('message', onMessage);
        running.removeEventListener('error', onError);
        reject(new Error(event.message || 'worker failed'));
      };

      running.addEventListener('message', onMessage);
      running.addEventListener('error', onError);

      // Transferred, not copied: the page's pixels are handed over rather than
      // duplicated, so a two-megabyte image costs nothing to send.
      running.postMessage(
        { width, height, buffer: page.data.buffer },
        [page.data.buffer]
      );
    });

    if (!reply || !reply.ok) throw new Error(reply ? reply.error : 'no reply');
    if (!reply.drawing) return null;

    return { ...reply.drawing, canvas: toCanvas(reply.drawing) };
  } catch (err) {
    console.warn(`[extractor] worker unavailable, extracting on the page: ${err.message}`);
    stop();
    return undefined;
  }
}

/** The worker, made on the first extraction and kept for the ones after it. */
function start() {
  if (unusable) return null;
  if (worker) return worker;

  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    unusable = true;
    console.warn('[extractor] no worker or no OffscreenCanvas; extracting on the page');
    return null;
  }

  try {
    worker = new Worker(new URL('./extract.worker.js', import.meta.url), { type: 'module' });
    return worker;
  } catch (err) {
    unusable = true;
    console.warn(`[extractor] could not start the worker: ${err.message}`);
    return null;
  }
}

/** Gives up on the worker for the rest of the session. */
function stop() {
  if (worker) worker.terminate();
  worker = null;
  unusable = true;
}

/** The returned pixels, put back onto a canvas this thread can encode. */
function toCanvas({ width, height, buffer }) {
  const canvas = createCanvas(width, height);
  context2d(canvas).putImageData(
    new ImageData(new Uint8ClampedArray(buffer), width, height),
    0,
    0
  );
  return canvas;
}
