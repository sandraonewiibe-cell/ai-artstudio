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
const link = document.getElementById('link');
const linkDetail = document.getElementById('linkDetail');

const stage = new Stage(canvas, backgroundSource);
const recorder = new Recorder(canvas, { fps: 30 });

// The organiser's logos and advertisements, in front of the canvas rather than
// painted into it - so they are never in the clip the visitor takes home, and
// the boat's own drawing code is untouched by any of it.
//
// The rotation runs on its own clock and pays no attention to what the wall is
// doing, so advertisements keep their turn whether or not a boat is crossing.
const overlay = createOverlay();

/** One session at a time; a result arriving mid-playback waits its turn. */
let busy = false;
const queue = [];

function showNotice(visible, detail) {
  link.hidden = !visible;
  if (detail) linkDetail.textContent = detail;
}

/** Recording covers the opening of the crossing, never more than all of it. */
const RECORD_MS = Math.min(DISPLAY.recordMs, DISPLAY.holdMs);

async function play(job) {
  busy = true;

  try {
    await stage.show(job);

    const recording = recorder.start();
    if (!recording) console.warn('[display] continuing without a recording');

    // The clip is shorter than the crossing, so the recorder stops partway
    // through while the boat sails on. Both timers run from the same moment.
    const clip = recording ? captureClip(job) : Promise.resolve();

    await wait(DISPLAY.holdMs);
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

/** Stops the recorder after RECORD_MS and posts what it captured. */
async function captureClip(job) {
  await wait(RECORD_MS);

  try {
    const blob = await recorder.stop();
    if (!blob) {
      console.warn('[display] recorder produced nothing');
      return;
    }

    console.log(`[display] captured ${(RECORD_MS / 1000).toFixed(1)}s, ` +
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

    overlay.apply(await response.json());
  } catch (err) {
    // The wall keeps working without them; they are decoration, not the show.
    console.warn('[display] could not load display settings:', err.message);
  }
}

loadSettings();

// Autoplay is allowed because the video is muted; without it the canvas would
// draw a still first frame forever.
backgroundSource.play().catch((err) => {
  console.warn('[display] background video did not start:', err.message);
});

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
