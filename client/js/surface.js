import { FLOAT } from './config.js';
import { createCanvas, context2d } from './imaging.js';

/**
 * Finding the water in whatever is playing behind the boat.
 *
 * The wall used to put the surface at a fixed height - 0.52 of the screen -
 * which is not a fact about anything. It was right for the footage the kiosk
 * ships with and wrong for any other: put a lake with a shoreline across the top
 * behind it and the boat floats in the hills.
 *
 * What is actually being asked is where the water begins, and the answer is in
 * the footage. Water moves and the rest of a landscape does not. A lake ripples
 * every frame; the sky above it, the far shore, the palms and the hills behind
 * are still, because the camera is on a tripod. So the scene is watched for a
 * moment and each row of it asked how much it is moving. Where the moving part
 * starts is where the water starts.
 *
 * Nothing here is about colour, which matters because colour is exactly what
 * cannot be relied on. Backwaters are brown, a lake under cloud is grey, the
 * footage this shipped with is turquoise, and a sunset is orange - while all of
 * them ripple. Movement is the one thing every body of water has in common and
 * no sky has.
 *
 * The honest answer is sometimes "all of it". The kiosk's own footage is open
 * water from corner to corner with no horizon in it at all, and a detector that
 * insisted on finding a shoreline would invent one. Measured on it, every row
 * moves and moves by much the same amount, so the whole frame is water - which
 * is the right answer and the one this gives.
 */

/**
 * How much of the frame's strongest movement a row must have to count as water.
 *
 * A share of what is actually there rather than a fixed amount, because how much
 * a lake moves on screen depends on the lens, the wind and the size of the
 * frame. Measured on the shipped footage, the quietest row of open water still
 * moves 0.61 of the busiest, so anything below that separates water from itself;
 * a static sky sits near zero. A third leaves room on both sides.
 */
const WATER_SHARE = 0.35;

/**
 * Below this there is no movement anywhere worth calling water, in grey levels
 * per frame. A frozen video, a still image, a covered lens: nothing can be told
 * from them and nothing is claimed.
 */
const STILL = 0.9;

/**
 * How long a still stretch has to be before it counts as the end of the water,
 * as a fraction of the frame's height.
 *
 * Some slack, because a gull, a moored boat, a post standing out of the lake or
 * a patch of glare are still rows in the middle of moving ones, and none of them
 * means the water has stopped. A shoreline is not a few rows deep.
 */
const BANK_RATIO = 0.035;

/** Frames taken, and how far apart. Together, about two thirds of a second. */
const FRAMES = 8;
const GAP_MS = 90;

/** Width the scene is watched at. A horizon is a coarse thing to look for. */
const SAMPLE_WIDTH = 160;

/**
 * Watches the background for a moment and works out where its water is.
 *
 * @param {HTMLVideoElement} video
 * @returns {Promise<{top: number, waterline: number, moving: boolean}|null>}
 *   `top` is where the water starts and `waterline` is where the boat should sit
 *   in it, both as fractions of the frame's height. Null if there was nothing to
 *   look at.
 */
export async function surveyWater(video) {
  const shots = await sample(video);
  if (!shots) return null;

  const { rows, height } = shots;
  return readWater(rows, height);
}

/**
 * Takes a run of frames and reduces each to how much every row of it moved.
 *
 * Sampled from the video as it plays rather than by seeking, so what is measured
 * is the movement the wall will actually be showing.
 */
async function sample(video) {
  if (!video || !video.videoWidth || !video.videoHeight) return null;

  const width = SAMPLE_WIDTH;
  const height = Math.max(8, Math.round((width * video.videoHeight) / video.videoWidth));

  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);

  const frames = [];
  for (let i = 0; i < FRAMES; i += 1) {
    ctx.drawImage(video, 0, 0, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const luma = new Float32Array(width * height);
    for (let p = 0; p < luma.length; p += 1) {
      luma[p] = (data[p * 4] * 299 + data[p * 4 + 1] * 587 + data[p * 4 + 2] * 114) / 1000;
    }
    frames.push(luma);

    if (i < FRAMES - 1) await wait(GAP_MS);
  }

  const rows = new Float32Array(height);

  for (let k = 1; k < frames.length; k += 1) {
    // The whole-frame brightness change is taken out first. Without it, a
    // camera adjusting its exposure reads as the entire scene moving at once,
    // sky included - the same correction the scanner makes for the same reason.
    let shift = 0;
    for (let p = 0; p < frames[k].length; p += 1) shift += frames[k][p] - frames[k - 1][p];
    shift /= frames[k].length;

    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        sum += Math.abs(frames[k][p] - frames[k - 1][p] - shift);
      }
      rows[y] += sum / width;
    }
  }

  for (let y = 0; y < height; y += 1) rows[y] /= frames.length - 1;

  return { rows, height };
}

/**
 * Where the water starts, from how much each row moved.
 *
 * Kept apart from the sampling so it can be handed a made-up scene and checked
 * against a known answer.
 *
 * @param {Float32Array} rows movement per row, top to bottom
 * @param {number} height
 */
export function readWater(rows, height) {
  const smooth = smoothed(rows, Math.max(1, Math.round(height * 0.03)));

  let peak = 0;
  for (let y = 0; y < height; y += 1) if (smooth[y] > peak) peak = smooth[y];

  const sit = clamp(FLOAT.surface.sit, 0, 1);

  // Nothing is moving anywhere. A still image, a frozen video, a covered lens -
  // there is no way to tell water from anything else, and guessing at a
  // shoreline would be worse than not having looked.
  if (peak < STILL) return { top: 0, waterline: sit, moving: false };

  const wet = new Uint8Array(height);
  for (let y = 0; y < height; y += 1) wet[y] = smooth[y] >= peak * WATER_SHARE ? 1 : 0;

  // Walked upwards from the bottom of the frame until the movement stops for
  // long enough to be a bank. Upwards, because the water is the stretch nearest
  // the viewer - a moving cloud in the top corner is not the lake, and the still
  // sky between the two ends the walk long before it is reached.
  const bank = Math.max(2, Math.round(height * BANK_RATIO));

  let top = height;
  let still = 0;

  for (let y = height - 1; y >= 0; y -= 1) {
    if (wet[y]) {
      still = 0;
      top = y;
      continue;
    }

    still += 1;
    if (still >= bank) break;
  }

  // Water found, but only a sliver of it at the very bottom. More likely the
  // movement is something crossing the shot than a lake, and floating a boat in
  // the last few rows of the wall would be worse than treating the whole frame
  // as water the way the fixed height did.
  if (top > height * 0.85) return { top: 0, waterline: sit, moving: true };

  const from = top / height;

  return {
    top: from,
    // Placed a set way down the water rather than a set way down the screen.
    // Where in it is a matter of composition and is the same for any lake; where
    // the water is is a matter of fact and is different for every one.
    waterline: from + sit * (1 - from),
    moving: true,
  };
}

/** A box blur along the rows, so one noisy line cannot decide anything. */
function smoothed(rows, radius) {
  const out = new Float32Array(rows.length);

  for (let y = 0; y < rows.length; y += 1) {
    let sum = 0;
    let n = 0;
    for (let d = -radius; d <= radius; d += 1) {
      const i = y + d;
      if (i < 0 || i >= rows.length) continue;
      sum += rows[i];
      n += 1;
    }
    out[y] = sum / n;
  }

  return out;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
