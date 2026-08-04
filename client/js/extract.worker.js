import { extractDrawing } from './extract.js';
import { createCanvas, context2d } from './imaging.js';

/**
 * The extraction, run off the main thread.
 *
 * Nothing about the extraction changes here and nothing is reimplemented: this
 * is the same `extractDrawing` the page used to call directly, called from
 * somewhere that is not the thread drawing the screen. It takes a second on a
 * real scan, and a second spent on the main thread is a second with no camera
 * preview, no flash and no progress ring - the kiosk simply stops.
 *
 * The page arrives as raw pixels rather than as a canvas, because a canvas
 * cannot cross a thread. They are put back into an OffscreenCanvas here, which
 * is what `createCanvas` makes when there is no document, so the extraction is
 * handed exactly the sort of thing it has always been handed.
 *
 * The finished drawing goes back the same way - as pixels, with the buffer
 * transferred rather than copied, so a two-megabyte image costs nothing to
 * return.
 */
self.onmessage = (event) => {
  const { width, height, buffer } = event.data;

  try {
    const page = createCanvas(width, height);
    context2d(page).putImageData(
      new ImageData(new Uint8ClampedArray(buffer), width, height),
      0,
      0
    );

    const drawing = extractDrawing(page);
    if (!drawing) {
      self.postMessage({ ok: true, drawing: null });
      return;
    }

    const canvas = drawing.canvas;
    const out = context2d(canvas).getImageData(0, 0, canvas.width, canvas.height);

    self.postMessage(
      {
        ok: true,
        drawing: {
          width: out.width,
          height: out.height,
          buffer: out.data.buffer,
          bounds: drawing.bounds,
          inkRatio: drawing.inkRatio,
          dropped: drawing.dropped,
          specks: drawing.specks,
          filled: drawing.filled,
          layers: drawing.layers,
        },
      },
      [out.data.buffer]
    );
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
