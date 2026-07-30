import { DISPLAY } from './js/config.js';
import { Camera } from './js/camera.js';
import { PaperScanner } from './js/detector.js';
import { capturePage } from './js/capture.js';
import { extractDrawing } from './js/extract.js';
import { createSession, waitForSession } from './js/api.js';

/**
 * Screen 1 - the scanner.
 *
 * The camera runs continuously from load. A frame loop feeds the detector;
 * when a sheet has been still long enough it reports 'ready', and this module
 * captures, extracts and sends. The finished boat is shown on the display wall
 * (/display), not here - this screen only confirms the hand-off and goes back
 * to scanning. There is no user input anywhere in the cycle.
 */

const el = {
  preview: document.getElementById('preview'),
  screens: {
    scan: document.getElementById('screen-scan'),
    process: document.getElementById('screen-process'),
    sent: document.getElementById('screen-sent'),
    reject: document.getElementById('screen-reject'),
    error: document.getElementById('screen-error'),
  },
  scanHint: document.getElementById('scanHint'),
  ringValue: document.getElementById('ringValue'),
  processStage: document.getElementById('processStage'),
  processText: document.getElementById('processText'),
  sentText: document.getElementById('sentText'),
  rejectTitle: document.getElementById('rejectTitle'),
  rejectDetail: document.getElementById('rejectDetail'),
  errorDetail: document.getElementById('errorDetail'),
  cameraNotice: document.getElementById('cameraNotice'),
  cameraNoticeDetail: document.getElementById('cameraNoticeDetail'),
  flash: document.getElementById('flash'),
};

const RING_CIRCUMFERENCE = 327;

const STAGE_LABELS = {
  queued: 'Queued',
  saving: 'Saving your drawing',
  reading: 'Reading the page',
  checking: 'Looking at your drawing',
  generating: 'Generating your boat',
  done: 'Ready',
};

const HINTS = {
  idle: 'PLACE YOUR PAPER INSIDE THE FRAME',
  settling: 'HOLD STILL…',
  holding: 'PLEASE TAKE YOUR SHEET',
  cooldown: 'READY IN A MOMENT',
  paused: 'SCANNING PAUSED',
};

const REJECTIONS = {
  'not-a-boat': {
    title: "WE COULDN'T FIND A BOAT",
    detail: 'Draw a boat on the paper and try again.',
  },
  'no-drawing': {
    title: 'NOTHING TO SEE YET',
    detail: 'Draw a boat on the paper, then place it under the camera.',
  },
};

const scanner = new PaperScanner();

const camera = new Camera(el.preview, {
  onStatus: (state, detail) => {
    const lost = state === 'lost';
    el.cameraNotice.hidden = !lost;
    if (detail) el.cameraNoticeDetail.textContent = detail;
    else if (lost) el.cameraNoticeDetail.textContent = 'Reconnecting…';
  },
});

/** 'scanning' | 'busy' - while busy, 'ready' reports are ignored. */
let mode = 'scanning';

/**
 * Automatic scanning is on by default; the A key pauses and resumes it.
 * Pausing leaves the camera running - it only stops the kiosk reacting to what
 * it sees, which is what you want when setting up or clearing the table.
 */
let scanningEnabled = true;

function setScreen(name) {
  Object.entries(el.screens).forEach(([key, node]) => {
    node.classList.toggle('is-active', key === name);
  });
  document.body.dataset.screen = name;
}

function setScanState(state) {
  document.body.dataset.scan = state;
  el.scanHint.textContent = HINTS[state] || HINTS.idle;
}

/** Shows whichever hint matches the current state, paused or not. */
function refreshScanHint() {
  if (!scanningEnabled) {
    document.body.dataset.scan = 'paused';
    el.scanHint.textContent = HINTS.paused;
    return;
  }
  setScanState(scanner.state);
}

function setScanningEnabled(enabled) {
  if (scanningEnabled === enabled) return;

  scanningEnabled = enabled;
  document.body.dataset.scanning = enabled ? 'on' : 'off';

  // Reset either way: resuming must not inherit a half-filled stability timer,
  // and pausing should not leave a progress ring frozen on screen.
  scanner.reset();
  setProgress(0);
  refreshScanHint();

  console.log(`[app] automatic scanning ${enabled ? 'enabled' : 'paused'}`);
}

function setProgress(value) {
  el.ringValue.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - value));
}

function fireFlash() {
  el.flash.classList.remove('is-firing');
  void el.flash.offsetWidth; // restart the animation
  el.flash.classList.add('is-firing');
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// --- main loop --------------------------------------------------------------

function tick(now) {
  requestAnimationFrame(tick);

  // Paused: leave the camera live but stop analysing frames entirely, which
  // also keeps the CPU free while the kiosk is idle.
  if (!scanningEnabled) return;

  // The scanner keeps running while busy: that is how it notices the visitor
  // taking their sheet away, which is what re-arms capture.
  const reading = scanner.update(el.preview, now);

  if (mode === 'scanning') {
    setScanState(reading.state === 'ready' ? 'settling' : reading.state);
    setProgress(reading.progress);

    if (reading.state === 'ready' && reading.quad) {
      runSession(reading.quad, reading.insetRatio);
    }
  }
}

// --- one visitor ------------------------------------------------------------

async function runSession(quad, insetRatio) {
  mode = 'busy';
  scanner.hold(); // no further captures until this sheet leaves the frame

  fireFlash();
  setProgress(0);

  try {
    // Let the flash paint before the synchronous warp/extract work.
    await nextFrame();

    // Timings are logged because capture blocks the page while it runs, and
    // this is the first place to look if the kiosk starts feeling sluggish.
    const t0 = performance.now();

    const sample = { width: scanner.canvas.width, height: scanner.canvas.height };
    const page = capturePage(el.preview, quad, sample, insetRatio);
    if (!page) throw new Error('Could not read the page from the camera.');

    const t1 = performance.now();
    const drawing = extractDrawing(page);
    const t2 = performance.now();

    setScreen('process');
    el.processStage.textContent = STAGE_LABELS.saving;
    showDetectedText(null);

    const payload = {
      paper: page.toDataURL('image/png'),
      drawing: drawing ? drawing.canvas.toDataURL('image/png') : null,
    };

    // Oars, if the drawing had any, travel as separate layers so the display
    // can row them. Absent for a drawing without oars.
    if (drawing && drawing.layers) {
      payload.layers = {
        hull: drawing.layers.hull.toDataURL('image/png'),
        paddles: drawing.layers.paddles.map((paddle) => ({
          data: paddle.canvas.toDataURL('image/png'),
          rect: paddle.rect,
          pivot: paddle.pivot,
          tip: paddle.tip,
        })),
      };
      console.log(`[app] found ${payload.layers.paddles.length} oar(s)`);
    }

    const t3 = performance.now();
    console.log(
      `[app] capture ${Math.round(t3 - t0)}ms ` +
        `(warp ${Math.round(t1 - t0)}, extract ${Math.round(t2 - t1)}, ` +
        `encode ${Math.round(t3 - t2)})`
    );

    const session = await createSession(payload);

    const job = await waitForSession(session.id, (update) => {
      el.processStage.textContent = STAGE_LABELS[update.stage] || update.stage;
      showDetectedText(update.text);
    });

    if (job.status === 'rejected') {
      await showRejection(job.reason);
    } else {
      // The boat itself plays on the display wall; this screen just confirms.
      await showHandoff(job.text);
    }
  } catch (err) {
    console.error('[app] session failed:', err);
    await showError(err.message);
  } finally {
    showDetectedText(null);
    setScreen('scan');
    refreshScanHint();
    setProgress(0);
    mode = 'scanning';
  }
}

/** Shows OCR output verbatim, or hides the line when there is none. */
function showDetectedText(text) {
  el.processText.textContent = text || '';
  el.processText.classList.toggle('is-visible', Boolean(text));
}

/**
 * Confirms the hand-off to the display wall. Held for a few seconds only -
 * the scanner is free again long before the boat finishes its crossing, so
 * the next visitor is not left waiting on the wall.
 */
async function showHandoff(text) {
  el.sentText.textContent = text || '';
  setScreen('sent');
  await new Promise((resolve) => setTimeout(resolve, DISPLAY.sentMs));
}

/** Tells the visitor the drawing was not a boat, then returns to scanning. */
async function showRejection(reason) {
  const copy = REJECTIONS[reason] || REJECTIONS['not-a-boat'];

  el.rejectTitle.textContent = copy.title;
  el.rejectDetail.textContent = copy.detail;
  setScreen('reject');

  await new Promise((resolve) => setTimeout(resolve, DISPLAY.rejectMs));
}

async function showError(message) {
  el.errorDetail.textContent = message;
  setScreen('error');
  await new Promise((resolve) => setTimeout(resolve, DISPLAY.errorMs));
}

// --- kiosk housekeeping -----------------------------------------------------

/** Stops the display sleeping during a quiet spell at the exhibition. */
async function keepAwake() {
  if (!('wakeLock' in navigator)) return;

  try {
    const lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => setTimeout(keepAwake, 1000));
  } catch (err) {
    console.warn('[app] wake lock unavailable:', err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) keepAwake();
});

// A toggles automatic scanning. Modifier combinations are left alone so
// Ctrl+A and friends still behave normally.
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key !== 'a' && event.key !== 'A') return;

  event.preventDefault();
  setScanningEnabled(!scanningEnabled);
});

// --- start ------------------------------------------------------------------

setScreen('scan');
setScanState('idle');
setProgress(0);
document.body.dataset.scanning = 'on';
keepAwake();
camera.start();
requestAnimationFrame(tick);
