import { OBJECTS } from './config.js';

/**
 * Cutting out exactly what was drawn, with OpenCV.
 *
 * The extraction before this finds the ink and the colour on the page, and
 * gets most of it right. What it cannot always tell is paper that the camera
 * saw slightly tinted - blue in the shade, warm under a lamp - from crayon. A
 * patch of that would come through as part of the drawing, and the wall would
 * show a grey corner of the sheet beside the fish.
 *
 * So the objects are found again, the way OpenCV finds objects:
 *
 *  1. Evidence. Every pixel the extraction kept that is clearly *not* paper -
 *     darker than it, or a different colour from it. Paper, however lit, is
 *     left out, because it looks like the paper round the edge of the sheet.
 *  2. Shapes. The evidence is closed up (morphologyEx) so a drawn outline
 *     becomes one unbroken edge, and its outside contours are found
 *     (findContours) and filled (drawContours). Each filled contour is one
 *     object, whole: a fish with a pale belly comes out as a fish, not a ring.
 *  3. Keep the objects, drop the specks, by size.
 *  4. The edge. Nothing of the paper may show round the outside, so the rim of
 *     each shape keeps only pixels that are not paper, and the cut is softened
 *     by a pixel.
 *
 * All of it runs in objects.worker.js, on a thread of its own. OpenCV is ten
 * megabytes and takes seconds to start; on the scanner page itself that froze
 * the page. Here the page only hands over pixels and gets the cut back, and if
 * anything goes wrong - no worker, too slow, an error - the extraction is used
 * as it was, and the visitor's scan still goes through.
 */

let worker = null;
let unusable = false;
let warming = null;
let nextId = 1;

/** Starts OpenCV loading in its worker, now, while nobody is waiting. */
export function loadOpenCV() {
  const running = start();
  if (!running) return Promise.resolve(false);
  if (!warming) {
    warming = new Promise((resolve) => {
      // A worker that dies, or never answers, must not leave this waiting.
      const giveUp = setTimeout(() => {
        console.warn('[objects] OpenCV is taking too long to start; scans go ahead without it');
        resolve(false);
      }, OBJECTS.startPatienceMs);
      running.addEventListener('error', () => {
        clearTimeout(giveUp);
        resolve(false);
      });
      const onMessage = (event) => {
        if (event.data.type === 'ready' || event.data.type === 'failed') {
          clearTimeout(giveUp);
          running.removeEventListener('message', onMessage);
          if (event.data.type === 'failed') console.warn('[objects] OpenCV did not start:', event.data.error);
          else console.log('[objects] OpenCV ready');
          resolve(event.data.type === 'ready');
        }
      };
      running.addEventListener('message', onMessage);
      running.postMessage({ type: 'start', script: OBJECTS.script });
    });
  }
  return warming;
}

/**
 * Cuts the drawn objects out of the page.
 *
 * @param {{canvas: HTMLCanvasElement, bounds: {x:number,y:number,width:number,height:number}}} drawing
 *   what the extraction found, and where on the page it was
 * @param {HTMLCanvasElement} page the flattened photo of the sheet
 * @returns {Promise<HTMLCanvasElement>} the objects alone, on transparency -
 *   or the extraction unchanged, if the cut could not be made
 */
export async function cutObjects(drawing, page) {
  if (!drawing || !drawing.canvas) return drawing && drawing.canvas;
  const running = start();
  if (!running || !drawing.bounds) return drawing.canvas;

  const { x, y, width, height } = drawing.bounds;
  if (!width || !height) return drawing.canvas;

  try {
    const pageCtx = page.getContext('2d', { willReadFrequently: true });
    const pagePixels = pageCtx.getImageData(x, y, width, height);
    const drawPixels = drawing.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
    const paper = paperColour(pageCtx, page.width, page.height);

    const id = nextId++;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        running.removeEventListener('message', onMessage);
        reject(new Error('OpenCV took too long'));
      }, OBJECTS.patienceMs);
      const onMessage = (event) => {
        if (event.data.type !== 'cut' || event.data.id !== id) return;
        clearTimeout(timer);
        running.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      running.addEventListener('message', onMessage);
      running.postMessage(
        {
          type: 'cut',
          id,
          script: OBJECTS.script,
          width,
          height,
          page: pagePixels.data.buffer,
          drawing: drawPixels.data.buffer,
          paper,
          cfg: {
            closeRatio: OBJECTS.closeRatio,
            minAreaRatio: OBJECTS.minAreaRatio,
            minShareOfLargest: OBJECTS.minShareOfLargest,
            rimRatio: OBJECTS.rimRatio,
            paperShade: OBJECTS.paperShade,
            paperTint: OBJECTS.paperTint,
          },
        },
        [pagePixels.data.buffer, drawPixels.data.buffer]
      );
    });

    if (!reply.ok) {
      if (reply.error) console.warn('[objects] cut-out failed, using the extraction as it is:', reply.error);
      return drawing.canvas;
    }

    // Same size and place as the extraction's picture, so anything measured
    // against it - where a boat's oars are - still lines up.
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(reply.buffer), width, height), 0, 0);
    console.log(`[objects] ${reply.kept} object(s) cut out`);
    return out;
  } catch (err) {
    console.warn('[objects] cut-out skipped, using the extraction as it is:', err.message);
    return drawing.canvas;
  }
}

/** The worker, made once and kept. */
function start() {
  if (unusable) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined') {
    unusable = true;
    return null;
  }
  try {
    worker = new Worker(new URL('./objects.worker.js', import.meta.url));
    worker.addEventListener('error', (event) => {
      console.warn('[objects] OpenCV worker failed:', event.message);
      unusable = true;
    });
    return worker;
  } catch (err) {
    console.warn('[objects] could not start the OpenCV worker:', err.message);
    unusable = true;
    return null;
  }
}

/**
 * The paper's colour, from the page round the edges, where nothing is drawn.
 * Read on the page because it needs the whole sheet; it samples, so it is
 * cheap.
 */
function paperColour(ctx, w, h) {
  const band = Math.max(4, Math.round(Math.min(w, h) * 0.06));
  const samples = [
    ctx.getImageData(0, 0, w, band),
    ctx.getImageData(0, h - band, w, band),
    ctx.getImageData(0, 0, band, h),
    ctx.getImageData(w - band, 0, band, h),
  ];

  const pixels = [];
  for (const { data } of samples) {
    for (let i = 0; i < data.length; i += 16) {
      pixels.push([data[i], data[i + 1], data[i + 2], data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114]);
    }
  }

  // The bright majority is paper; ink, shadow and the odd stroke are not.
  const lumas = pixels.map((p) => p[3]).sort((a, b) => a - b);
  const cut = lumas[Math.floor(lumas.length * 0.4)];
  const paper = pixels.filter((p) => p[3] >= cut);

  const mean = [0, 1, 2].map((c) => paper.reduce((s, p) => s + p[c], 0) / Math.max(1, paper.length));
  const darkest = paper.reduce((m, p) => Math.min(m, p[3]), 255);
  return { r: mean[0], g: mean[1], b: mean[2], darkest };
}
