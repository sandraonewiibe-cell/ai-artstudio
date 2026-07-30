import { DISPLAY, WAVES, PADDLES, MODEL3D } from './config.js';
import { Boat3D } from './boat3d.js';

/**
 * The LED screen, drawn on a canvas.
 *
 * Canvas rather than DOM+CSS for one reason: the page has to record itself, and
 * `canvas.captureStream()` gives an exact copy of what is on screen with no
 * permission prompt. Screen capture would need a picker dialogue every time,
 * which an unattended kiosk has nobody to answer.
 *
 * The boat is a flat drawing made to behave like a hull on water. It is cut
 * into vertical slices and each slice is displaced by the height of a
 * simulated wave at that point, so the bow and the stern sit on different
 * parts of the swell and rise and fall independently. On top of that the whole
 * hull pitches with the slope of the surface, and a squashed mirror image
 * wobbles underneath it.
 *
 * This is not geometry - it is a flat image being bent convincingly. Real 3D
 * would need depth estimation from an image-to-3D model.
 */

const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

const MOTION = {
  // Fractions of the canvas width the boat travels between, left to right.
  driftFrom: -0.27,
  driftTo: 0.27,

  boatMaxWidth: 0.42, // of canvas width
  boatMaxHeight: 0.48, // of canvas height

  // Where the waterline sits on the canvas.
  waterlineY: 0.52,
};

const RIPPLE = {
  count: 3,
  periodMs: 3800,
  widthOfBoat: 0.46,
  flatten: 0.3,
  lineWidth: 2,
};

export class Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement} background looping background video
   */
  constructor(canvas, background) {
    this.canvas = canvas;
    this.canvas.width = BASE_WIDTH;
    this.canvas.height = BASE_HEIGHT;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.background = background;

    this.boat = null;
    this.paddles = [];
    this.splashes = [];
    this.text = null;
    this.startedAt = 0;
    this.lastFrameAt = 0;
    this.running = false;

    // Built once and reused. Creating a WebGL context per visitor would leak
    // contexts until the browser started refusing them.
    this.model = MODEL3D.enabled ? Boat3D.create(1024, 1024) : null;
    this.modelReady = false;
  }

  start() {
    if (this.running) return;
    this.running = true;

    const loop = () => {
      if (!this.running) return;
      this.draw(performance.now());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  /**
   * Loads a result and begins its crossing. Resolves once the image is ready,
   * so the caller can start recording knowing the first frame will have a boat
   * in it.
   *
   * @param {{imageUrl: string, text: string|null}} job
   */
  async show(job) {
    const image = await loadImage(job.imageUrl);

    this.boat = image;
    this.paddles = [];
    this.splashes = [];

    // `this.boat` is the only image on screen, ever. The scan as it arrived,
    // in one piece, with nothing taken out of it and nothing laid on top of it.
    //
    // The oars are not drawn a second time and do not move. A drawn line cannot
    // be made to swing without its original staying put behind it, so rowing a
    // copy showed two of every oar - which is what looked like the drawing had
    // been cut apart. They are left exactly where the visitor drew them.
    //
    // What arrives here is only where each blade is. No images, no copies -
    // positions, so the water knows where the oars are entering it.
    if (job.layers && job.layers.paddles && job.layers.paddles.length) {
      this.paddles = job.layers.paddles.map((paddle) => ({ ...paddle, lastPhase: 0 }));
      console.log(`[stage] ${this.paddles.length} oar(s) working the water`);
    }

    // Inflate the drawing into a solid. Built from the whole drawing, oars
    // included: separate oars cannot be made to line up with a rotated hull, so
    // in 3D they are part of the model rather than animated on top.
    this.modelReady = false;
    if (this.model) {
      try {
        this.modelReady = this.model.build(this.boat);
      } catch (err) {
        console.warn('[stage] 3D build failed, showing the flat boat:', err.message);
        this.modelReady = false;
      }
    }

    this.text = job.text || null;
    this.startedAt = performance.now();
    this.lastFrameAt = this.startedAt;
  }

  /** Back to background only. */
  clear() {
    this.boat = null;
    this.paddles = [];
    this.splashes = [];
    this.text = null;
    this.startedAt = 0;
  }

  get hasResult() {
    return Boolean(this.boat);
  }

  /**
   * Height of the water surface at a point, in pixels above the waterline.
   * Two overlapping swells travelling at different speeds.
   */
  waveAt(x, elapsed) {
    const h = this.canvas.height;
    const w = this.canvas.width;
    const { primary, secondary } = WAVES;

    const k1 = (Math.PI * 2) / (primary.wavelength * w);
    const k2 = (Math.PI * 2) / (secondary.wavelength * w);
    const w1 = (Math.PI * 2) / primary.periodMs;
    const w2 = (Math.PI * 2) / secondary.periodMs;

    return (
      primary.amplitude * h * Math.sin(k1 * x - w1 * elapsed) +
      secondary.amplitude * h * Math.sin(k2 * x - w2 * elapsed + 1.7)
    );
  }

  draw(now) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    this.drawBackground(w, h);

    if (!this.boat) return;

    const elapsed = now - this.startedAt;
    const progress = Math.max(0, Math.min(1, elapsed / DISPLAY.holdMs));

    // Scale the boat into its box, preserving aspect.
    const scale = Math.min(
      (w * MOTION.boatMaxWidth) / this.boat.width,
      (h * MOTION.boatMaxHeight) / this.boat.height
    );
    const boatW = this.boat.width * scale;
    const boatH = this.boat.height * scale;

    const driftX =
      (MOTION.driftFrom + (MOTION.driftTo - MOTION.driftFrom) * progress) * w;
    const centreX = w / 2 + driftX;

    // The hull rests on the water at its two ends, so its attitude is the
    // chord between bow and stern - not the slope at a point. Sampling a short
    // baseline instead would alias against the shorter of the two swells and
    // peg the boat at its tilt limit.
    const bow = this.waveAt(centreX - boatW / 2, elapsed);
    const stern = this.waveAt(centreX + boatW / 2, elapsed);

    const lift = (bow + stern) / 2;
    const slope = (stern - bow) / boatW;

    const maxTilt = (WAVES.maxTiltDegrees * Math.PI) / 180;
    const tilt = clamp(Math.atan(slope * WAVES.tiltGain), -maxTilt, maxTilt);

    const centreY = h * MOTION.waterlineY + lift - boatH * 0.25;
    const waterline = centreY + boatH / 2;

    const delta = Math.max(0, Math.min(100, now - this.lastFrameAt));
    this.lastFrameAt = now;

    // The reflection mirrors the flat drawing, so it only belongs with the flat
    // boat. Against the 3D model it showed as a second, differently-posed copy.
    if (!this.modelReady) {
      this.drawReflection(centreX, waterline, boatW, boatH, tilt, elapsed);
    }

    this.drawRipples(centreX, waterline, boatW, elapsed);

    if (this.modelReady) {
      this.drawModel(centreX, centreY, boatW, boatH, tilt, elapsed);
    } else {
      this.drawHull(centreX, centreY, boatW, boatH, tilt, lift, slope, elapsed);

      // Nothing is drawn for the oars - they are already in the hull image,
      // where they were drawn. This only works out where their blades are and
      // lets the water react to them.
      if (this.paddles.length) {
        this.workTheWater(centreX, centreY, boatW, boatH, tilt, lift, elapsed);
      }
    }

    this.updateSplashes(delta);
    this.drawSplashes();

    if (this.text) this.drawName(w, h);
  }

  /**
   * The water working around the blades. Draws nothing.
   *
   * The oars themselves are part of the hull image and stay where they were
   * drawn. What is still on a rhythm is the water: each blade bites once per
   * stroke and throws, and the oars lag slightly down the line, so the splashes
   * ripple along the boat the way they would if it were being rowed hard.
   *
   * The rhythm is the one the oars used to swing on - same period, same
   * stagger, same point in the cycle - so the boat reads as being rowed even
   * though nothing about the drawing moves. It runs for as long as the boat is
   * on screen; there is no stroke count and nothing winds down.
   *
   * The splash comes off the water, not off the drawing. The oar says *where*
   * along the boat it enters - that is all the scan is used for - and the
   * height comes from the surface itself, so the droplets break at the
   * waterline the way spray does. Taking the height from the drawing instead
   * put the splash wherever the visitor happened to end their pencil stroke,
   * which was usually somewhere up in the air on the hull.
   */
  workTheWater(centreX, centreY, boatW, boatH, tilt, lift, elapsed) {
    const { periodMs, lagPerOar, catchPhase } = PADDLES.stroke;

    // Where this boat is sitting in the water, the same line the ripples use.
    const waterline = centreY + boatH / 2;

    this.paddles.forEach((paddle, index) => {
      const phase = wrap(elapsed / periodMs - index * lagPerOar);

      if (crossed(paddle.lastPhase, phase, catchPhase)) {
        // Local frame: the drawing's box runs from -boatW/2 to +boatW/2. Only
        // the horizontal position is taken from the oar.
        const tipX = -boatW / 2 + paddle.tip.x * boatW;
        const tipY = -boatH / 2 + paddle.tip.y * boatH;
        const bladeX = centreX + tipX * Math.cos(tilt) - tipY * Math.sin(tilt);

        // ...and the surface of the sea at that point provides the rest: the
        // boat's waterline, plus however far the swell departs from it here.
        const surfaceY = waterline + (this.waveAt(bladeX, elapsed) - lift);

        this.spawnSplash(bladeX, surfaceY);
      }

      paddle.lastPhase = phase;
    });
  }

  /** A handful of droplets thrown up where a blade entered the water. */
  spawnSplash(x, y) {
    const { droplets, lifeMs, speed, size } = PADDLES.splash;

    for (let i = 0; i < droplets; i += 1) {
      // Fan upward and outward, weighted forward along the boat's travel.
      const angle = -Math.PI / 2 + (i / (droplets - 1) - 0.5) * 1.5;
      const power = speed * (0.55 + 0.45 * ((i * 37) % 11) / 10);

      this.splashes.push({
        x,
        y,
        vx: Math.cos(angle) * power,
        vy: Math.sin(angle) * power,
        life: lifeMs,
        maxLife: lifeMs,
        size: size * (0.6 + 0.8 * (((i * 17) % 7) / 7)),
      });
    }
  }

  updateSplashes(deltaMs) {
    if (!this.splashes.length) return;

    const seconds = deltaMs / 1000;
    const { gravity } = PADDLES.splash;

    this.splashes = this.splashes.filter((drop) => {
      drop.life -= deltaMs;
      if (drop.life <= 0) return false;

      drop.vy += gravity * seconds;
      drop.x += drop.vx * seconds;
      drop.y += drop.vy * seconds;
      return true;
    });
  }

  drawSplashes() {
    if (!this.splashes.length) return;

    const { ctx } = this;
    ctx.save();

    this.splashes.forEach((drop) => {
      const fade = drop.life / drop.maxLife;
      ctx.fillStyle = `rgba(255, 255, 255, ${(fade * 0.75).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(drop.x, drop.y, drop.size * (0.4 + fade * 0.6), 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.restore();
  }

  drawBackground(w, h) {
    const video = this.background;
    if (!video || !video.videoWidth || video.readyState < 2) return;

    // Cover: fill the canvas, crop the overflow.
    const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
    const drawW = video.videoWidth * scale;
    const drawH = video.videoHeight * scale;

    this.ctx.drawImage(video, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
  }

  /**
   * The hull, cut into vertical slices and bent onto the water.
   *
   * The rigid pitch is applied as a rotation, then each slice is nudged by
   * whatever the surface does *beyond* that straight line. That residual is
   * what makes the bow and stern lift over a crest independently instead of
   * the whole drawing tilting like a signboard.
   */
  /**
   * The inflated 3D model, riding the same water as the flat version.
   *
   * The boat is seen broadside, so the wave's tilt becomes roll - the bow lifting
   * as the stern drops - and a slow nod is added on top so it is never rigid.
   * The model renders to its own transparent canvas and is composited here,
   * which keeps the 2D stage (ripples, reflection, name) untouched and means the
   * recording still captures everything.
   */
  drawModel(centreX, centreY, boatW, boatH, tilt, elapsed) {
    const nod =
      Math.sin((elapsed / MODEL3D.nodPeriodMs) * Math.PI * 2) *
      ((MODEL3D.nodDegrees * Math.PI) / 180);

    this.model.render({ roll: tilt, pitch: nod, yaw: 0 });

    // Square, and generous: rotation and perspective push the model's corners
    // out past where the flat image sat.
    const size = Math.max(boatW, boatH) * MODEL3D.canvasCover;
    this.ctx.drawImage(
      this.model.canvas,
      centreX - size / 2,
      centreY - size / 2,
      size,
      size
    );
  }

  drawHull(centreX, centreY, boatW, boatH, tilt, lift, slope, elapsed) {
    const { ctx } = this;

    // The scan itself, whole. The slicing below bends it; it never removes any
    // of it, so no part of the drawing can go missing here.
    const image = this.boat;

    const slices = WAVES.slices;
    const sliceSrc = image.width / slices;
    const sliceDst = boatW / slices;

    ctx.save();
    ctx.translate(centreX, centreY);
    ctx.rotate(tilt);

    for (let i = 0; i < slices; i += 1) {
      const offset = -boatW / 2 + i * sliceDst;
      const worldX = centreX + offset + sliceDst / 2;

      // How far the real surface departs from the straight line the hull is
      // already sitting on.
      const residual = this.waveAt(worldX, elapsed) - (lift + slope * (offset + sliceDst / 2));

      ctx.drawImage(
        image,
        i * sliceSrc,
        0,
        sliceSrc,
        image.height,
        offset,
        -boatH / 2 + residual * WAVES.flex,
        sliceDst + 1, // overlap by a pixel so no seams show
        boatH
      );
    }

    ctx.restore();
  }

  /**
   * Squashed, faded mirror image below the waterline, distorted more strongly
   * than the hull. The single most convincing cue that the boat is on water.
   */
  drawReflection(centreX, waterline, boatW, boatH, tilt, elapsed) {
    const { ctx } = this;
    const { opacity, squash, wobble } = WAVES.reflection;

    // The same scan the hull is drawn from, so the reflection is a mirror of
    // what is actually on the water and not of some other version of it.
    const image = this.boat;

    const slices = WAVES.slices;
    const sliceSrc = image.width / slices;
    const sliceDst = boatW / slices;
    const height = boatH * squash;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(centreX, waterline);
    ctx.rotate(-tilt);
    ctx.scale(1, -1); // mirror

    for (let i = 0; i < slices; i += 1) {
      const offset = -boatW / 2 + i * sliceDst;
      const worldX = centreX + offset;

      // Exaggerated and phase-shifted, the way a reflection breaks up on a
      // moving surface.
      const shimmer = this.waveAt(worldX * 1.6, elapsed * 1.4) * wobble;

      ctx.drawImage(
        image,
        i * sliceSrc,
        0,
        sliceSrc,
        image.height,
        offset + shimmer * 0.08,
        shimmer * 0.15,
        sliceDst + 1,
        height
      );
    }

    ctx.restore();
  }

  /** Flattened rings spreading out directly beneath the hull. */
  drawRipples(centreX, baseY, boatW, elapsed) {
    const { ctx } = this;
    const maxW = boatW * RIPPLE.widthOfBoat;

    ctx.save();
    ctx.lineWidth = RIPPLE.lineWidth;

    for (let i = 0; i < RIPPLE.count; i += 1) {
      const offset = (RIPPLE.periodMs / RIPPLE.count) * i;
      const phase =
        ((((elapsed + offset) % RIPPLE.periodMs) + RIPPLE.periodMs) % RIPPLE.periodMs) /
        RIPPLE.periodMs;

      // Widen faster than they grow tall, so the rings lie flat on the water.
      const rx = maxW * (0.22 + 1.08 * phase) * 0.5;
      const ry = rx * RIPPLE.flatten * (0.55 + 0.45 * phase);

      // Fade in quickly, then out across the rest of the cycle.
      const alpha = phase < 0.18 ? phase / 0.18 : 1 - (phase - 0.18) / 0.82;

      ctx.strokeStyle = `rgba(255, 255, 255, ${Math.max(0, alpha) * 0.42})`;
      ctx.beginPath();
      ctx.ellipse(centreX, baseY + ry * 0.4, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** The detected name, centred below the boat. */
  drawName(w, h) {
    const { ctx } = this;
    let size = Math.round(h * 0.048);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Shrink rather than overflow if the name is long.
    do {
      ctx.font = `600 ${size}px "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
      if (ctx.measureText(this.text).width <= w * 0.8) break;
      size -= 4;
    } while (size > 16);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = h * 0.02;
    ctx.fillStyle = 'rgba(244, 244, 246, 0.94)';
    ctx.fillText(this.text, w / 2, h * 0.86);
    ctx.restore();
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Fractional part, always positive. */
function wrap(value) {
  return ((value % 1) + 1) % 1;
}

/** True if the cycle passed `mark` between two samples, wrap included. */
function crossed(previous, current, mark) {
  if (previous === current) return false;
  return previous < current
    ? previous < mark && current >= mark
    : previous < mark || current >= mark; // wrapped past 1
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}
