import { CAMERA } from './config.js';

/**
 * Owns the webcam for the lifetime of the kiosk.
 *
 * An exhibition machine runs unattended all day, so a dropped USB camera must
 * not end the session. This class watches for three failure signals - the
 * track ending, the element stalling, and the device list changing - and keeps
 * retrying with backoff until the camera comes back.
 */
export class Camera {
  /**
   * @param {HTMLVideoElement} video
   * @param {{onStatus?: (state: 'starting'|'live'|'lost', detail?: string) => void}} handlers
   */
  constructor(video, handlers = {}) {
    this.video = video;
    this.onStatus = handlers.onStatus || (() => {});
    this.stream = null;
    this.retryDelay = CAMERA.retryDelayMs;
    this.retryTimer = null;
    this.watchdog = null;
    this.lastFrameAt = 0;
    this.lastTime = -1;
    this.stopped = false;

    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (!this.isLive()) this.scheduleRetry('device list changed');
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !this.isLive()) this.scheduleRetry('page became visible');
    });
  }

  isLive() {
    const track = this.stream?.getVideoTracks?.()[0];
    return Boolean(track && track.readyState === 'live' && this.video.videoWidth > 0);
  }

  async start() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.onStatus('lost', 'This browser cannot access a camera.');
      return;
    }

    this.onStatus('starting');

    try {
      this.releaseStream();
      this.stream = await navigator.mediaDevices.getUserMedia(CAMERA.constraints);
      this.video.srcObject = this.stream;
      await this.video.play();

      this.stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => this.scheduleRetry('camera disconnected'));
      });

      this.retryDelay = CAMERA.retryDelayMs;
      this.lastFrameAt = performance.now();
      this.startWatchdog();
      this.onStatus('live');
    } catch (err) {
      this.onStatus('lost', describeError(err));
      this.scheduleRetry(err.name || 'error');
    }
  }

  /**
   * Restarts after a delay that grows with consecutive failures, so a camera
   * that is unplugged for an hour does not spin the CPU.
   */
  scheduleRetry(reason) {
    if (this.stopped || this.retryTimer) return;

    console.warn(`[camera] restarting: ${reason} (retry in ${this.retryDelay}ms)`);
    this.onStatus('lost');

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, CAMERA.maxRetryDelayMs);
      this.start();
    }, this.retryDelay);
  }

  /**
   * A camera can stay "live" while silently delivering no frames. Watching
   * video.currentTime catches that, which track events do not.
   */
  startWatchdog() {
    clearInterval(this.watchdog);

    this.watchdog = setInterval(() => {
      if (this.stopped) return;

      if (this.video.currentTime !== this.lastTime) {
        this.lastTime = this.video.currentTime;
        this.lastFrameAt = performance.now();
        return;
      }

      if (performance.now() - this.lastFrameAt > CAMERA.stallTimeoutMs) {
        this.scheduleRetry('no frames');
      }
    }, 1000);
  }

  releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    this.releaseStream();
  }

  /** Dimensions of the live frame, or null if not ready. */
  size() {
    if (!this.video.videoWidth) return null;
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }
}

function describeError(err) {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Camera permission denied. Allow access and reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found. Connect the webcam.';
    case 'NotReadableError':
      return 'Camera is in use by another application.';
    default:
      return `Camera error: ${err.message}`;
  }
}
