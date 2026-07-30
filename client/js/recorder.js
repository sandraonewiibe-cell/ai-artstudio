/**
 * Records the display canvas while a boat is on screen.
 *
 * Recording the canvas rather than the screen is what makes this work
 * unattended: `captureStream()` needs no permission and no picker dialogue,
 * and what it captures is exactly what the visitor saw.
 */

// Best first. Browsers vary in what they will actually encode.
const CANDIDATE_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export class Recorder {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{fps?: number}} options
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.fps = options.fps || 30;
    this.recorder = null;
    this.chunks = [];
    this.stream = null;
  }

  static get supported() {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
  }

  static pickType() {
    if (typeof MediaRecorder === 'undefined') return null;
    return CANDIDATE_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
  }

  get recording() {
    return Boolean(this.recorder && this.recorder.state === 'recording');
  }

  /** @returns {boolean} whether recording actually started */
  start() {
    if (!Recorder.supported || this.recording) return false;

    const mimeType = Recorder.pickType();
    if (!mimeType) {
      console.warn('[recorder] no supported recording format; skipping');
      return false;
    }

    try {
      this.stream = this.canvas.captureStream(this.fps);
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream, { mimeType });

      this.recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) this.chunks.push(event.data);
      };

      // Emit periodically rather than only at the end, so a crash mid-session
      // still leaves usable data behind.
      this.recorder.start(1000);
      return true;
    } catch (err) {
      console.warn('[recorder] could not start:', err.message);
      this.recorder = null;
      return false;
    }
  }

  /**
   * Stops and returns what was captured.
   * @returns {Promise<Blob|null>}
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        this.release();
        resolve(null);
        return;
      }

      const mimeType = this.recorder.mimeType || 'video/webm';

      this.recorder.onstop = () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: mimeType }) : null;
        this.chunks = [];
        this.release();
        resolve(blob);
      };

      try {
        this.recorder.stop();
      } catch (err) {
        console.warn('[recorder] stop failed:', err.message);
        this.release();
        resolve(null);
      }
    });
  }

  release() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.recorder = null;
  }
}

/** Reads a Blob as a data URL, which is how it is posted to the server. */
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the recording.'));
    reader.readAsDataURL(blob);
  });
}
