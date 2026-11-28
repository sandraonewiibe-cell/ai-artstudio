import { DISPLAY } from './js/config.js';
import { Stage } from './js/stage.js';
import { Recorder, blobToDataUrl } from './js/recorder.js';
import { connect } from './js/bus.js';
import { createOverlay } from './js/overlay.js';

/**
 * Screen 2 - the LED wall.
 *
 * Shows the background video on its own until the scanner produces a boat.
 * Then it plays the boat across the screen for the hold time, recording the
 * canvas as it goes, and posts the recording back so the QR screen can offer
 * it for download.
 */

const canvas = document.getElementById('stage');
const backgroundSource = document.getElementById('backgroundSource');
const backgroundImage = document.getElementById('backgroundImage');
const link = document.getElementById('link');
const linkDetail = document.getElementById('linkDetail');

const stage = new Stage(canvas, backgroundSource);
const recorder = new Recorder(canvas, { fps: 30 });

// The organiser's logos and advertisements. The overlay keeps the schedule and
// holds the pictures off-screen; the stage paints them into the canvas, which
// is what puts them into the recording the visitor scans for as well as onto
// the wall.
//
// The rotation runs on its own clock and pays no attention to what the wall is
// doing, so advertisements keep their turn whether or not a boat is crossing.
const overlay = createOverlay();
stage.overlay = overlay;

/** One session at a time; a result arriving mid-playback waits its turn. */
let busy = false;
const queue = [];

function showNotice(visible, detail) {
  link.hidden = !visible;
  if (detail) linkDetail.textContent = detail;
}

/**
 * Recording covers the opening of the turn, never more than all of it: most of
 * a boat's crossing, or the whole of a rocket's five-second show. Worked out
 * per turn, because the scene can change between them.
 */
function recordMsFor(holdMs) {
  return Math.min(DISPLAY.recordMs, holdMs);
}

async function play(job) {
  busy = true;

  try {
    await stage.show(job);

    const recording = recorder.start();
    if (!recording) console.warn('[display] continuing without a recording');

    // The clip is shorter than the crossing, so the recorder stops partway
    // through while the boat sails on. Both timers run from the same moment.
    // A boat's crossing, or a rocket's show - the stage knows which.
    const holdMs = stage.holdMs;
    const clip = recording ? captureClip(job, recordMsFor(holdMs)) : Promise.resolve();

    await wait(holdMs);
    stage.clear();

    // Let the recorder finish releasing before the next visitor starts one.
    await clip;
  } catch (err) {
    console.error('[display] playback failed:', err);
    stage.clear();
    if (recorder.recording) await recorder.stop();
  } finally {
    busy = false;
    const next = queue.shift();
    if (next) play(next);
  }
}

/** Stops the recorder after `ms` and posts what it captured. */
async function captureClip(job, ms) {
  await wait(ms);

  try {
    const blob = await recorder.stop();
    if (!blob) {
      console.warn('[display] recorder produced nothing');
      return;
    }

    console.log(`[display] captured ${(ms / 1000).toFixed(1)}s, ` +
      `${Math.round(blob.size / 1024)}KB`);
    await upload(blob, job);
  } catch (err) {
    console.error('[display] recording failed:', err);
  }
}

async function upload(blob, job) {
  try {
    const data = await blobToDataUrl(blob);

    const response = await fetch('/api/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, text: job.text || null, data }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Server returned ${response.status}`);
    }

    const record = await response.json();
    console.log(`[display] recording stored: ${record.url}`);
  } catch (err) {
    // A failed upload costs this visitor their download, not the exhibition.
    console.error('[display] could not store the recording:', err);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- wiring -----------------------------------------------------------------

connect(
  (event) => {
    // Saved in the admin panel: applied here on the spot, on the connection
    // that is already open for boats. Nothing restarts and nothing reloads.
    if (event.type === 'settings' && event.settings) {
      applyBackground(event.settings);
      overlay.apply(event.settings);
      return;
    }

    if (event.type !== 'result' || !event.job) return;

    if (busy) queue.push(event.job);
    else play(event.job);
  },
  {
    onOpen: () => {
      showNotice(false);
      // Also on reconnect, in case the panel was saved while this wall was
      // away - the event that carried it would have been missed.
      loadSettings();
    },
    onDown: () => showNotice(true, 'Reconnecting to the scanner…'),
  }
);

/** What to show, at startup and after any reconnect. */
async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error(`Server returned ${response.status}`);

    const settings = await response.json();
    applyBackground(settings);
    overlay.apply(settings);
  } catch (err) {
    // The wall keeps working without them; they are decoration, not the show.
    console.warn('[display] could not load display settings:', err.message);
  }
}

loadSettings();

/** The video the kiosk ships with, and what it falls back to. */
const DEFAULT_BACKGROUND = '/assets/background/bg.mp4';

/**
 * Swaps what is behind everything, if the panel has been given something: a
 * video, or a still picture.
 *
 * The original file is never touched, so clearing it in the panel puts the
 * kiosk's own video back. The canvas skips a frame or two while the new one
 * loads - `paintBackground` waits for it to have something to show - which is
 * a moment of black on a change somebody made deliberately.
 */
function applyBackground(settings) {
  const chosen = settings.background || {};

  // Boats on water or rockets in space - the next drawing to arrive goes up the
  // way the panel says, and one already up switches over on the spot.
  // Automatic waits for the picture and looks at it; see sceneFor().
  stage.setScene(['space', 'ocean'].includes(chosen.scene) ? chosen.scene : 'water');
  const wanted = chosen.url || DEFAULT_BACKGROUND;
  // The panel saves which kind it was. A server that has not been restarted
  // since pictures were allowed drops that on save, so the file's own name is
  // asked as well - a PNG sent to the video player would leave the old one up.
  const isImage =
    Boolean(chosen.url) &&
    (chosen.type === 'image' ||
      (chosen.type !== 'video' && /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(chosen.url)));

  if (isImage) {
    if (backgroundImage.getAttribute('src') !== wanted) backgroundImage.src = wanted;

    // Nothing to play while a picture is up; it would only cost decoding.
    backgroundSource.pause();
    stage.setBackground(backgroundImage);

    if (!['water', 'space', 'ocean'].includes(chosen.scene)) {
      sceneFor(backgroundImage).then((scene) => {
        // Only if the picture is still the one up when the answer comes back.
        if (backgroundImage.getAttribute('src') !== wanted) return;
        stage.setScene(scene);
        console.log(`[display] scene: ${scene} (automatic, from the background)`);
      });
    }
    console.log(`[display] background is now the picture ${wanted}`);
    return;
  }

  stage.setBackground(backgroundSource);

  const current = backgroundSource.getAttribute('src');
  if (current !== wanted) {
    backgroundSource.src = wanted;
    backgroundSource.load();
  }
  startBackground();

  // Where the water is in this footage is a different question from where it was
  // in the last, so it is asked again. Nothing waits on the answer: the wall
  // keeps drawing, and the surface moves to where it was found when the survey
  // comes back a moment later.
  surveyWhenPlaying();

  // A video can be underwater or a night sky as well as a lake: Automatic
  // looks at a frame of it once it is playing.
  if (!['water', 'space', 'ocean'].includes(chosen.scene)) {
    whenPlaying(() => {
      if (backgroundSource.getAttribute('src') !== wanted) return;
      const scene = sceneOf(backgroundSource, backgroundSource.videoWidth, backgroundSource.videoHeight);
      stage.setScene(scene);
      console.log(`[display] scene: ${scene} (automatic, from the background video)`);
    });
  }

  console.log(`[display] background is now ${wanted}`);
}

/** Runs once the background video is playing, checking a few times a second. */
function whenPlaying(then) {
  let tries = 0;
  const attempt = () => {
    tries += 1;
    if (backgroundSource.readyState >= 2 && !backgroundSource.paused && backgroundSource.videoWidth) {
      then();
      return;
    }
    if (tries <= 40) setTimeout(attempt, 250);
  };
  attempt();
}

/**
 * Boats, rockets or fish, decided by looking at the picture. A night sky is dark
 * all over; underwater is blue or sea-green nearly everywhere and not dark;
 * anything else is a surface to float a boat on. Measured on a small copy, once
 * per picture.
 *
 * A picture that cannot be read is water, which is what the wall always was.
 */
async function sceneFor(image) {
  try {
    await image.decode();
    return sceneOf(image, image.naturalWidth, image.naturalHeight);
  } catch {
    return 'water';
  }
}

/**
 * The scene a picture or a video frame shows, measured on a small copy.
 *
 * Underwater is told two ways. Mostly clearly-blue-not-red; or, failing that,
 * mostly bluish with the light coming down from above - bright at the top, dark
 * at the bottom, which is how the sea looks from inside it. A lake or a sea
 * seen from above is lit evenly top to bottom. Measured on the kiosk's own
 * footage: an ocean video 0.80 blue and 72 brighter at the top; the lake video
 * that ships with it 0.55-0.59 blue and 1-2.
 */
function sceneOf(source, sourceW, sourceH) {
  try {
    const w = 64;
    const h = Math.max(1, Math.round((sourceH / sourceW) * w));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    let dark = 0;
    let sea = 0;
    let bluish = 0;
    let top = 0;
    let bottom = 0;
    const band = Math.max(1, Math.floor(h / 4));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      const row = Math.floor(i / 4 / w);
      if (row < band) top += luma;
      if (row >= h - band) bottom += luma;
      if (b > r + 15) bluish += 1;
      if (luma < NIGHT_SKY.darkBelow) dark += 1;
      else if (b > r + UNDERWATER.blueOverRed && b + g > r * 2 + UNDERWATER.blueOverRed) sea += 1;
    }
    const total = w * h;
    const fall = (top - bottom) / (band * w);
    if (dark / total >= NIGHT_SKY.darkShare) return 'space';
    if (sea / total >= UNDERWATER.share) return 'ocean';
    if (bluish / total >= UNDERWATER.bluishShare && fall >= UNDERWATER.lightFall) return 'ocean';
    return 'water';
  } catch {
    return 'water';
  }
}

/**
 * What counts as a night sky. The kiosk's space picture is about nine tenths
 * dark by this measure; daytime water and sky are almost none.
 */
const NIGHT_SKY = { darkBelow: 70, darkShare: 0.6 };

/**
 * What counts as underwater: most of the picture clearly bluer than it is red,
 * and not dark - the sea seen from inside it. A boat picture has sky, shore or
 * a bright surface in it and falls short of this.
 */
const UNDERWATER = { blueOverRed: 30, share: 0.7, bluishShare: 0.8, lightFall: 35 };

// Autoplay is allowed because the video is muted; without it the canvas would
// draw a still first frame forever.
function startBackground() {
  backgroundSource.play().catch((err) => {
    console.warn('[display] background video did not start:', err.message);
  });
}

/**
 * Measures where the water is, once the footage is actually running.
 *
 * It has to be playing, because what is being looked for is movement: surveyed
 * on a paused video every row is equally still and the answer is "no water
 * anywhere". So the survey waits for frames to be arriving, and gives up
 * quietly if they never do - the wall then treats the whole frame as water,
 * which is what it did before any of this.
 */
function surveyWhenPlaying() {
  let tries = 0;

  const attempt = () => {
    tries += 1;

    if (backgroundSource.readyState >= 2 && !backgroundSource.paused) {
      stage.surveyBackground();
      return;
    }

    if (tries > 20) {
      console.warn('[display] background never started playing; not surveying it');
      return;
    }

    setTimeout(attempt, 250);
  };

  attempt();
}

startBackground();
surveyWhenPlaying();

stage.start();

// Keep the wall awake through quiet spells.
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;

  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => setTimeout(keepAwake, 1000));
  } catch (err) {
    console.warn('[display] wake lock unavailable:', err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) keepAwake();
});

keepAwake();
