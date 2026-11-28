/* global cv, importScripts */

/**
 * OpenCV, off the page.
 *
 * opencv.js is ten megabytes with its engine packed inside, and unpacking and
 * compiling that takes the thread it runs on for seconds. On the scanner page
 * that was the page itself, and the browser offered to kill it. Here it has a
 * thread of its own: the scanner keeps watching the camera while this loads,
 * and while it cuts.
 *
 * The page sends the pixels of the sheet and of what the extraction kept, and
 * gets back the objects alone. See objects.js for what the cut does and why.
 *
 * A classic worker rather than a module one, because opencv.js puts itself on
 * the global scope through importScripts.
 */

let ready = null;

function start(script) {
  if (ready) return ready;
  ready = (async () => {
    importScripts(script);
    const lib = self.cv;
    if (!lib) throw new Error('opencv.js did not define cv');

    // Never `await` the module itself: OpenCV's emscripten build has a `then`
    // that hands back the module, which is itself a thenable, so awaiting it
    // never ends. That loop is what froze the scanner page. Wait for the
    // runtime's own signal instead, or for cv.Mat to appear, whichever first.
    if (!lib.Mat) {
      await new Promise((done) => {
        lib.onRuntimeInitialized = done;
        const check = setInterval(() => {
          if (lib.Mat) {
            clearInterval(check);
            done();
          }
        }, 50);
      });
    }
    // Nothing returned: an async function that returns the module waits on its
    // `then` in the same endless way. Everything uses the global `cv`.
  })();
  return ready;
}

self.onmessage = async (event) => {
  const message = event.data;

  if (message.type === 'start') {
    try {
      await start(message.script);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'failed', error: err.message });
    }
    return;
  }

  if (message.type !== 'cut') return;

  try {
    await start(message.script);
    const rgba = cut(message);
    self.postMessage({ type: 'cut', id: message.id, ok: Boolean(rgba), buffer: rgba && rgba.buffer, kept: cut.kept }, rgba ? [rgba.buffer] : []);
  } catch (err) {
    self.postMessage({ type: 'cut', id: message.id, ok: false, error: err.message });
  }
};

/**
 * The cut itself. Returns the objects as RGBA pixels the size of the drawing,
 * or null if there was nothing to keep.
 */
function cut({ width, height, page, drawing, paper, cfg }) {
  const pageData = new Uint8ClampedArray(page);
  const drawData = new Uint8ClampedArray(drawing);
  const mats = [];
  const keep = (m) => {
    mats.push(m);
    return m;
  };

  try {
    // 1. Evidence: kept by the extraction, and plainly not paper.
    const evidence = keep(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0)));
    const ev = evidence.data;
    const notPaper = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
      if (!isPaper(pageData[i * 4], pageData[i * 4 + 1], pageData[i * 4 + 2], paper, cfg)) notPaper[i] = 1;
      if (drawData[i * 4 + 3] > 40 && notPaper[i]) ev[i] = 255;
    }

    // 2. Shapes: closed up so an outline is one edge, then filled from outside.
    const size = Math.max(3, Math.round(Math.min(width, height) * cfg.closeRatio) | 1);
    const kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size)));
    const closed = keep(new cv.Mat());
    cv.morphologyEx(evidence, closed, cv.MORPH_CLOSE, kernel);

    const contours = keep(new cv.MatVector());
    const hierarchy = keep(new cv.Mat());
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // 3. Objects, not specks.
    let largest = 0;
    const areas = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const area = cv.contourArea(contours.get(i));
      areas.push(area);
      largest = Math.max(largest, area);
    }
    const minArea = Math.max(width * height * cfg.minAreaRatio, largest * cfg.minShareOfLargest);

    const solid = keep(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0)));
    let kept = 0;
    for (let i = 0; i < contours.size(); i += 1) {
      if (areas[i] < minArea) continue;
      cv.drawContours(solid, contours, i, new cv.Scalar(255), cv.FILLED);
      kept += 1;
    }
    cut.kept = kept;
    if (!kept) return null;

    // 4. The rim: only what is not paper, so no sheet shows round the outside.
    const rimSize = Math.max(3, Math.round(Math.min(width, height) * cfg.rimRatio) | 1);
    const rimKernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(rimSize, rimSize)));
    const inner = keep(new cv.Mat());
    cv.erode(solid, inner, rimKernel);

    const out = new Uint8ClampedArray(width * height * 4);
    const sd = solid.data;
    const id = inner.data;
    const alpha = keep(new cv.Mat(height, width, cv.CV_8UC1, new cv.Scalar(0)));
    for (let i = 0; i < width * height; i += 1) {
      if (!sd[i]) continue;
      if (!id[i] && !notPaper[i]) continue;
      const src = drawData[i * 4 + 3] > 40 ? drawData : pageData;
      out[i * 4] = src[i * 4];
      out[i * 4 + 1] = src[i * 4 + 1];
      out[i * 4 + 2] = src[i * 4 + 2];
      out[i * 4 + 3] = 255;
      alpha.data[i] = 255;
    }

    // A pixel of softening on the cut.
    const soft = keep(new cv.Mat());
    cv.GaussianBlur(alpha, soft, new cv.Size(3, 3), 0);
    for (let i = 0; i < width * height; i += 1) {
      if (out[i * 4 + 3]) out[i * 4 + 3] = Math.max(soft.data[i], 160);
    }
    return out;
  } finally {
    mats.forEach((m) => {
      try {
        m.delete();
      } catch {
        // already gone
      }
    });
  }
}

/**
 * Paper, as lit anywhere on the page: about as bright as the paper or a little
 * darker in shade, and close to its colour once brightness is set aside.
 */
function isPaper(r, g, b, paper, cfg) {
  const luma = r * 0.299 + g * 0.587 + b * 0.114;
  if (luma < paper.darkest - cfg.paperShade) return false;

  const sum = r + g + b || 1;
  const psum = paper.r + paper.g + paper.b || 1;
  const dr = r / sum - paper.r / psum;
  const dg = g / sum - paper.g / psum;
  const db = b / sum - paper.b / psum;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const paperChroma = Math.max(paper.r, paper.g, paper.b) - Math.min(paper.r, paper.g, paper.b);

  return Math.hypot(dr, dg, db) * 255 < cfg.paperTint && chroma < paperChroma + cfg.paperTint * 1.5;
}
