import { PAGE, MARKERS } from './config.js';
import { createCanvas, context2d } from './imaging.js';
import { warpToRect, distance } from './geometry.js';

// Never trim more than this off an edge, whatever the detector asks for.
const MAX_INSET = 0.3;

/**
 * Grabs a full-resolution frame, flattens the sheet into a straight-on
 * rectangle, and removes the marker border so only the drawing area remains.
 *
 * The quad joins the four marker *centres*, which form a true rectangle on the
 * printed sheet, so the warp is exact and each rectified page corner lands
 * precisely on a marker centre. That means exactly half a marker pokes into
 * the page at each corner, and the size of that intrusion is known from the
 * measured marker size rather than guessed.
 *
 * Two independent steps guarantee the markers never survive:
 *   1. the four corners are painted out, over a generous area;
 *   2. the page is then cropped inside that painted area.
 *
 * Step 1 is deliberately larger than step 2, so if the measured marker size is
 * an underestimate and the crop falls short, the paint has still covered it.
 * A third check lives in extract.js, which discards marker-shaped components.
 *
 * @param {HTMLVideoElement} video
 * @param {{x:number,y:number}[]} quad ordered [tl, tr, br, bl], sampled coords
 * @param {{width:number, height:number}} sampleSize dimensions of the sampled frame
 * @param {{x:number, y:number}} insetRatio fraction to trim off each edge
 * @returns {HTMLCanvasElement|null} the drawing area, perspective corrected
 */
export function capturePage(video, quad, sampleSize, insetRatio) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const frameCanvas = createCanvas(width, height);
  const frameCtx = context2d(frameCanvas);
  frameCtx.drawImage(video, 0, 0, width, height);
  const frame = frameCtx.getImageData(0, 0, width, height);

  const scaleX = width / sampleSize.width;
  const scaleY = height / sampleSize.height;
  const scaled = quad.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));

  // Centre-to-centre spans, in full-resolution pixels.
  const horizontal = (distance(scaled[0], scaled[1]) + distance(scaled[3], scaled[2])) / 2;
  const vertical = (distance(scaled[0], scaled[3]) + distance(scaled[1], scaled[2])) / 2;
  if (horizontal < 1 || vertical < 1) return null;

  // Output keeps the sheet's own proportions rather than assuming a paper size.
  const landscape = horizontal >= vertical;
  const outW = landscape ? PAGE.longEdge : Math.round(PAGE.longEdge * (horizontal / vertical));
  const outH = landscape ? Math.round(PAGE.longEdge * (vertical / horizontal)) : PAGE.longEdge;

  const warped = warpToRect(frame, scaled, outW, outH);
  if (!warped) return null;

  const pageCanvas = createCanvas(outW, outH);
  context2d(pageCanvas).putImageData(warped, 0, 0);

  const inset = {
    x: outW * Math.min(insetRatio?.x ?? 0, MAX_INSET),
    y: outH * Math.min(insetRatio?.y ?? 0, MAX_INSET),
  };

  maskBorder(pageCanvas, inset);

  return cropToDrawingArea(pageCanvas, inset);
}

/**
 * Paints the border to paper white before the crop, so the page handed to OCR
 * and to the provider is clean even if the crop below turns out to be too
 * tight. That covers the darker table beyond a plain sheet, and the QR blocks
 * on a printed one.
 *
 * Deliberately larger than the crop by `maskOverscan`: if the inset is an
 * underestimate, the paint has still covered what the crop will miss.
 */
function maskBorder(canvas, inset) {
  const ctx = context2d(canvas);
  const w = Math.ceil(inset.x * MARKERS.maskOverscan);
  const h = Math.ceil(inset.y * MARKERS.maskOverscan);
  if (w <= 0 && h <= 0) return;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, h);
  ctx.fillRect(0, canvas.height - h, canvas.width, h);
  ctx.fillRect(0, 0, w, canvas.height);
  ctx.fillRect(canvas.width - w, 0, w, canvas.height);
  ctx.restore();
}

/**
 * Trims the marker border off the rectified page, leaving only the drawing
 * area. The inset is measured from the markers themselves, so reprinting the
 * template at a different size needs no config change. Insetting after the
 * warp is geometrically correct - the perspective is already gone.
 */
function cropToDrawingArea(pageCanvas, inset) {
  const cropX = Math.round(inset.x);
  const cropY = Math.round(inset.y);

  const outW = pageCanvas.width - cropX * 2;
  const outH = pageCanvas.height - cropY * 2;
  if (outW < 32 || outH < 32) return pageCanvas;

  const cropped = createCanvas(outW, outH);
  context2d(cropped).drawImage(pageCanvas, -cropX, -cropY);

  return cropped;
}
