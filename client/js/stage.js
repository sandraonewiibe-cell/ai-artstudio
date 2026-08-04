import { DISPLAY, WAVES, PADDLES, MODEL3D, GLB, ANIMATE, FLOAT } from './config.js';
import { Boat3D } from './boat3d.js';
import { sealHoles } from './seal.js';
import { measureHull } from './waterline.js';
import { surveyWater } from './surface.js';

/**
 * Three.js, fetched the first time a model actually needs it.
 *
 * Deliberately not imported at the top. The library and its loader are the best
 * part of a megabyte, and a kiosk with the 3D pipeline switched off - which is
 * the default - should not be downloading it on every display boot to render
 * nothing. Nothing is fetched until a GLB exists to put in it.
 */
let gl = null;
function boatgl() {
  if (!gl) gl = import('./boatgl.js');
  return gl;
}

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

};

/**
 * Where the water crosses a drawing, when it cannot be measured.
 *
 * Only reached if the picture has no silhouette to measure, which means there is
 * nothing to float either. It is the figure the old hard-coded placement worked
 * out to, kept so that path behaves exactly as it always did.
 */
const FALLBACK_WATERLINE = 0.75;

/**
 * Where the organiser's things sit, as fractions of the wall.
 *
 * These are the numbers the stylesheet used when logos and advertisements were
 * laid over the canvas rather than painted into it, so the wall looks as it did
 * - only now the recording looks the same way too.
 */
const OVERLAY = {
  marginRatio: 0.03,   // logos, in from the top and the side
  stripRatio: 0.22,    // how much of the wall a strip advertisement takes
  featherStart: 0.62,  // where its inner edge starts fading out
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

    /**
     * Logos and advertisements, if the display has set any up.
     *
     * Painted into this canvas rather than laid over it, so what the visitor
     * downloads is what was on the wall - the same logos, the same
     * advertisement, at the same moment.
     */
    this.overlay = null;

    /** Scratch canvas for feathering an advertisement's edge. Built on demand. */
    this.adBuffer = null;

    /** Scratch canvas for the water drawn in front of the submerged hull. */
    this.waterBuffer = null;

    /** Where the water crosses this boat, measured from its own silhouette. */
    this.hull = null;

    /**
     * Where the water is in the background, measured from the footage.
     *
     * Until the survey has run - and if it can never run, because nothing is
     * moving to be found - the whole frame is taken to be water, which is what
     * the shipped footage actually is and what the fixed height assumed.
     */
    this.water = { top: 0, waterline: FLOAT.surface.sit, moving: false };

    /** Which background the survey was of, so a new one is surveyed again. */
    this.surveyed = null;

    // Built once and reused. Creating a WebGL context per visitor would leak
    // contexts until the browser started refusing them.
    this.model = MODEL3D.enabled ? Boat3D.create(1024, 1024) : null;
    this.modelReady = false;

    /**
     * The renderer for a generated GLB, when the pipeline has made one.
     *
     * Built lazily, on the first model that actually arrives - a kiosk running
     * without the 3D pipeline should never make a WebGL context it has nothing
     * to put in. Null means the flat boat, which is also what happens if WebGL
     * is unavailable or a file will not parse.
     */
    this.gl = null;
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

    // A hull the visitor shaded faintly can arrive with see-through patches in
    // the middle of it, and the wall would show the lake through them. Closed
    // up here, with the colour that surrounds each gap, before anything is
    // drawn or built from it - so the flat boat, its reflection and the model
    // all get the same sealed drawing. Nothing outside the sketch is touched.
    this.boat = sealHoles(image);
    this.paddles = [];
    this.splashes = [];

    // How deep this particular boat floats, read off its own silhouette. Done
    // once, here, rather than per frame: it is a property of the drawing and the
    // drawing does not change while it is on the wall.
    this.hull = measureHull(this.boat);
    if (this.hull) {
      console.log(
        `[stage] hull spans ${this.hull.top.toFixed(3)}-${this.hull.bottom.toFixed(3)} ` +
        `of the drawing; water crosses it at ${this.hull.waterline.toFixed(3)}`
      );
    } else {
      console.warn('[stage] no silhouette to measure; floating the drawing as it comes');
    }

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

  /**
   * Shows a generated model instead of the flat drawing, from now on.
   *
   * Called when one finishes - which is usually after the boat is already
   * crossing, so it takes over mid-flight.
   *
   * Every way this can fail ends in the flat boat carrying on: no WebGL, a file
   * that will not parse, a library that will not load. The drawing is always
   * there to fall back to, and it is never taken away first.
   *
   * @param {string|null} url
   * @returns {Promise<boolean>} whether the model is now on the wall
   */
  async sculpt(url) {
    if (!url || !GLB.enabled) {
      if (this.gl) this.gl.clear();
      return false;
    }

    try {
      const { BoatGL, loadModel } = await boatgl();

      const scene = await loadModel(url);
      if (!scene) {
        console.warn('[3d] falling back to the flat boat: nothing parsed');
        return false;
      }

      if (!this.gl) this.gl = BoatGL.create();
      if (!this.gl) {
        console.warn('[3d] falling back to the flat boat: no renderer');
        return false;
      }

      this.gl.show(scene);

      if (!this.sculpted) {
        console.warn('[3d] falling back to the flat boat: the model went in but is not ready');
        return false;
      }

      console.log('[3d] shown - the model has replaced the flat boat');
      return true;
    } catch (err) {
      console.error(`[3d] FAILED at display: ${err.message}`);
      return false;
    }
  }

  /**
   * Fetches, parses, rigs and compiles a model now, so showing it later costs
   * nothing.
   *
   * All of it - including making the WebGL context, which is not cheap either -
   * happens while the model is still only an announcement. By the time it goes
   * on the wall there is nothing left to do but draw it.
   */
  async preloadModel(url) {
    if (!url || !GLB.enabled) return;

    try {
      const { BoatGL, preload } = await boatgl();

      const scene = await preload(url);
      if (!scene) return;

      if (!this.gl) this.gl = BoatGL.create();
      if (this.gl) this.gl.warm(scene);
    } catch (err) {
      console.warn('[stage] could not preload the model:', err.message);
    }
  }

  /** True when there is a model to draw instead of the drawing. */
  get sculpted() {
    return Boolean(this.gl && this.gl.ready);
  }

  /**
   * Where the surface of the water sits on the wall, for this boat.
   *
   * The survey says where the water is in the footage, and that is the answer
   * nearly always. The two things this adds are the bounds of the wall itself.
   *
   * A boat hangs a reflection below itself about as long as the part of it that
   * is out of the water, so a waterline found low in the frame - a lake seen
   * over a near bank, say - can be far enough down that the mirror runs off the
   * bottom of the screen. So the surface is lifted as far as it needs to be for
   * the reflection to fit, and no further.
   *
   * ...but never up onto the bank. If the boat cannot fit below the water's own
   * top edge, it stays in the water and the reflection is the thing that gets
   * cut - a boat sitting on a hillside is a mistake anyone can see, and a
   * reflection running off the bottom of the wall is one nobody will.
   */
  surfaceY(h, boatH, crossing) {
    const wanted = h * this.water.waterline;

    // How far the mirror will hang below the surface: the part of the boat that
    // is out of the water, foreshortened.
    const top = this.hull ? this.hull.top : 0;
    const mirror = Math.max(0, crossing - top) * boatH * WAVES.reflection.squash;

    const lowest = h - mirror - h * 0.02;
    const highest = h * this.water.top + boatH * 0.1;

    return Math.max(highest, Math.min(wanted, lowest));
  }

  /**
   * Works out where the water is in whatever the background is now showing.
   *
   * Called when the wall starts and again whenever the background is changed
   * from the panel. It is of the footage, not of the boat, so it does not have
   * to be redone for every visitor - and it takes about two thirds of a second,
   * which is time there is between backgrounds and time there is not while
   * somebody is watching their boat.
   *
   * Runs to itself. If it cannot be done - the video is not ready, nothing in
   * the scene is moving, the footage will not decode - the wall carries on with
   * the whole frame taken as water, which is what it always used to assume.
   *
   * @returns {Promise<object|null>} what was found, for whoever wants to log it
   */
  async surveyBackground() {
    const video = this.background;
    const source = video && (video.currentSrc || video.src);
    if (!video) return null;

    try {
      const found = await surveyWater(video);
      if (!found) return null;

      this.water = found;
      this.surveyed = source;

      console.log(
        found.moving
          ? `[stage] water starts at ${found.top.toFixed(3)} of the background; ` +
            `the boat floats at ${found.waterline.toFixed(3)}`
          : '[stage] nothing in the background is moving; taking all of it for water'
      );

      return found;
    } catch (err) {
      console.warn('[stage] could not survey the background:', err.message);
      return null;
    }
  }

  /**
   * Surveys the background if it has changed since the last one.
   *
   * The panel can swap the footage at any moment, and a wall left running for a
   * week would otherwise be floating boats at a waterline measured off a video
   * that is no longer playing.
   */
  resurveyIfChanged() {
    const video = this.background;
    const source = video && (video.currentSrc || video.src);
    if (!source || source === this.surveyed) return;

    this.surveyed = source;
    this.surveyBackground();
  }

  /** Back to background only. */
  clear() {
    this.boat = null;
    this.hull = null;
    if (this.gl) this.gl.clear();
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

    if (this.boat) this.drawScene(now, w, h);

    // Last, so it sits over everything - and *into* the canvas rather than in
    // front of it, which is what puts the logos and advertisements into the
    // recording as well as on the wall. Outside the boat's branch, so they are
    // there between visitors too.
    if (this.overlay) this.drawOverlay(now, w, h);
  }

  /** The boat and its water. Only runs when there is one. */
  drawScene(now, w, h) {
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

    // The water, and where it crosses this boat.
    //
    // The drawing is hung so that its own waterline lands on the surface,
    // whatever the crop happened to take in above or below the hull. What used
    // to be here placed the boat a quarter of its *picture* above the water and
    // called the bottom edge of the picture the waterline - which is a fact
    // about the crop rectangle, not about the boat. Extraction crops tightly, so
    // that came to 0.75 of the image every time whatever was drawn; a hull that
    // finishes at 0.60 because the visitor drew lily pads under it was then hung
    // a sixth of the picture clear of the water, and nothing was ever submerged.
    const crossing = this.hull ? this.hull.waterline : FALLBACK_WATERLINE;
    const waterline = this.surfaceY(h, boatH, crossing) + lift;
    const centreY = waterline - (crossing - 0.5) * boatH;

    const delta = Math.max(0, Math.min(100, now - this.lastFrameAt));
    this.lastFrameAt = now;

    // A generated model takes over from the drawing when there is one. Each of
    // the three ways of showing a boat reflects differently, so the reflection
    // is chosen with the boat rather than assumed.
    const sculpted = this.sculpted;

    // Where the bottom of the hull is on the wall. The shadow hangs off it, and
    // the deepest water the boat displaces is there rather than at the surface.
    const keelY = centreY - boatH / 2 + (this.hull ? this.hull.bottom : 1) * boatH;
    const shadow = { centreX, boatW, tilt, keelY };

    // Everything that happens to the water because the boat is in it, laid on
    // the lake before the boat goes on top.
    //
    // Before, because these fall on the water and not on the boat. Drawn
    // afterwards they worked over the hull as well and altered the visitor's own
    // drawing, which is the one thing on the wall that may never be touched.
    // Under the boat they are hidden by the boat, and what shows is what reaches
    // past it - which is all any of them ever is.
    this.drawWaterMarks(this.ctx, { ...shadow, waterline, elapsed }, 0);

    if (sculpted) this.renderSculpt(lift, tilt, elapsed);

    // The trail the boat has left. Behind it, so it belongs under the ripples
    // that are directly beneath the hull.
    if (sculpted) this.drawWake(centreX, waterline, boatW, elapsed, progress);

    // The rings that used to spread out from under the hull are not drawn.
    //
    // They were meant to read as ripples and did not. On a photographed lake
    // they came out as a hard white ellipse sitting on the water beside the
    // boat - a drawn circle, plainly not part of either the sketch or the
    // scene, and the first thing the eye went to. The wake astern does the job
    // they were there for.
    //
    // drawRipples() is left in place: the shape was never the problem, the
    // white stroke on a bright background was, and it wants rebuilding as a
    // distortion of the water rather than a line drawn over it.

    if (sculpted) {
      this.drawSculpt(centreX, centreY, boatW, boatH);
    } else if (this.modelReady) {
      this.drawModel(centreX, centreY, boatW, boatH, tilt, elapsed);
    } else {
      this.drawHull(centreX, centreY, boatW, boatH, tilt, lift, slope, elapsed);
    }

    // The water, in front of the part of the boat that is in it.
    //
    // This is what makes the draft something you can see. Without it the hull is
    // drawn opaque from top to bottom and sits on the surface like a sticker,
    // however carefully it was placed. The boat is not altered to achieve it -
    // nothing is cut off, faded or repainted - the water is simply drawn over
    // the part of it that is under the water, which is what being in the water
    // looks like.
    this.submerge(waterline, centreY + boatH / 2, w, h, { ...shadow, waterline, elapsed });

    // The reflection lies *on* the surface, so it goes over the water rather
    // than under it - after the veil, not before. It used to be drawn first, and
    // was then partly covered by the hull it was supposed to be a reflection of.
    //
    // Whatever drew the boat this frame is what gets reflected, so every way of
    // showing a boat reflects, and reflects the boat that is actually there.
    this.drawReflection(this.mirrorSource(boatW, boatH), centreX, centreY, waterline, tilt, elapsed);

    // The water reacts to the blades whichever boat is on it. The positions
    // came off the visitor's drawing and the model was made from that same
    // drawing, so they still fall along the boat.
    if (this.paddles.length && !this.modelReady) {
      this.workTheWater(centreX, centreY, boatW, boatH, tilt, lift, elapsed);
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
    this.paintBackground(this.ctx, w, h);
  }

  /**
   * The background, drawn into any context at the size it covers the wall.
   *
   * Shared, because the water has to be painted twice: once behind everything,
   * and again in front of whatever is under it. Both have to be the same frame
   * at the same scale, or the surface would appear to jump at the waterline.
   *
   * @returns {boolean} whether there was a frame to draw
   */
  paintBackground(ctx, w, h) {
    const video = this.background;
    if (!video || !video.videoWidth || video.readyState < 2) return false;

    // Cover: fill the canvas, crop the overflow.
    const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
    const drawW = video.videoWidth * scale;
    const drawH = video.videoHeight * scale;

    ctx.drawImage(video, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
    return true;
  }

  /**
   * Puts the water back in front of everything below the waterline.
   *
   * A boat floats because part of it is under the surface, and something under
   * the surface is seen through water. So the same frame of the lake that is
   * behind the boat is drawn again over the part of it that is in the water,
   * fading in from nothing at the waterline to `FLOAT.veil` at the deepest
   * point.
   *
   * Doing it with the water itself rather than a wash of colour is what keeps
   * this working on any background: nothing here knows or assumes what colour
   * the lake is, and a hull under a green lake goes green while the same hull
   * under a grey one goes grey. It also means the water's own movement plays
   * over the submerged part, which is most of why it reads as being *in*
   * something rather than behind a pane of glass.
   *
   * The drawing is untouched. Above the waterline it is exactly the scan; below
   * it, it is the scan with water in front of it. Nothing is cut away, so there
   * is no edge to go hard - the veil starts at zero, and the boat simply goes
   * into the lake.
   *
   * The band runs the full width of the wall. Away from the boat that redraws
   * the water over itself, which changes nothing and costs one composite, and it
   * saves having to work out how far a rolling, pitching hull reaches sideways.
   */
  submerge(waterline, bottomY, w, h, marks) {
    const top = Math.max(0, Math.floor(waterline));
    const depth = Math.ceil(Math.min(h, bottomY) - top);
    if (depth < 2) return;

    const buffer = this.bufferFor(w, depth, 'waterBuffer');
    const bctx = buffer.getContext('2d');

    bctx.clearRect(0, 0, w, depth);
    bctx.save();
    bctx.translate(0, -top);
    const painted = this.paintBackground(bctx, w, h);
    bctx.restore();
    if (!painted) return;

    // The water carries the boat's shadow here too. This band is drawn over
    // ground the shadow has already been laid on, so without it the water in
    // front of the hull would be the one patch of lake with no shadow in it -
    // a bright stripe cut across the middle of it at the waterline.
    // The water carries what the boat does to it here too. This band is drawn
    // over ground those marks have already been laid on, so without them the
    // water in front of the hull would be the one patch of lake with none - a
    // clean stripe cut across the middle of it at the waterline.
    if (marks) this.drawWaterMarks(bctx, marks, -top);

    // Rubbed away at the top and left almost whole at the bottom, so the water
    // thickens with depth instead of arriving all at once along a line.
    const fade = bctx.createLinearGradient(0, 0, 0, depth);
    fade.addColorStop(0, 'rgba(0, 0, 0, 1)');
    fade.addColorStop(1, `rgba(0, 0, 0, ${(1 - FLOAT.veil).toFixed(3)})`);

    bctx.save();
    bctx.globalCompositeOperation = 'destination-out';
    bctx.fillStyle = fade;
    bctx.fillRect(0, 0, w, depth);
    bctx.restore();

    this.ctx.drawImage(buffer, 0, top);
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
  /**
   * Poses the generated model on the water and renders it once.
   *
   * The same numbers that bend the flat drawing drive this: how far the surface
   * has lifted under the hull, and how it is sloping. Rendered once per frame,
   * then blitted twice - right way up, and upside down for the reflection - so
   * the mirror costs a copy rather than a second pass over the mesh.
   */
  renderSculpt(lift, tilt, elapsed) {
    this.gl.render({
      heave: (lift / this.canvas.height) * GLB.heave,
      roll: tilt,
      elapsed,
    });
  }

  drawSculpt(centreX, centreY, boatW, boatH) {
    const size = Math.max(boatW, boatH) * GLB.cover;
    this.ctx.drawImage(this.gl.canvas, centreX - size / 2, centreY - size / 2, size, size);
  }

  /**
   * Everything the boat does to the water it is sitting in.
   *
   * Gathered into one call because they all want the same two things: to be
   * drawn on the lake and not on the boat, and to be drawn twice - once on the
   * open water, and again into the band of water that goes in front of the
   * submerged hull, which would otherwise come out clean where everything around
   * it is not.
   */
  drawWaterMarks(ctx, marks, offsetY) {
    this.drawContactShadow(ctx, marks, offsetY);
    this.drawRipples(ctx, marks, offsetY);
  }

  /**
   * The rings spreading out from under the hull.
   *
   * These were drawn once before and taken off the wall, and the note left
   * behind said why: they came out as a hard white ellipse sitting on the water
   * beside the boat - a drawn circle, plainly part of neither the sketch nor the
   * scene, and the first thing the eye went to. It also said what to do about
   * it, which was to rebuild them as a disturbance of the water rather than a
   * line laid over it. That is what this is.
   *
   * Nothing white is drawn. Each ring is a pair of soft strokes, one lighter and
   * one darker, a hair apart - the near face of a ripple catching the sky and
   * the far face falling away from it - and they are blended into the lake
   * rather than painted onto it, so what changes is how bright the water already
   * there is. On a pale lake they lift and dip it slightly; on a dark one they
   * do the same to a dark surface. No colour is introduced at any point, which
   * is what keeps this working on footage nobody has chosen yet.
   *
   * They start at the boat's beam and spread outward, flattened hard, because a
   * ring on water seen at this angle is a very shallow ellipse. Each fades in as
   * it leaves the hull and out as it goes, so there is nothing to see arriving
   * or leaving.
   */
  drawRipples(ctx, { centreX, boatW, waterline, elapsed }, offsetY) {
    if (!this.hull || !FLOAT.ripples.opacity) return;

    const { count, periodMs, spread, flatten, opacity, blurPx, thickness } = FLOAT.ripples;

    const { left, right } = this.hull.beam;
    const beam = Math.max(0, right - left) * boatW;
    if (beam < 8) return;

    const cx = centreX + ((left + right) / 2 - 0.5) * boatW;
    const cy = waterline + offsetY;

    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.filter = `blur(${blurPx.toFixed(1)}px)`;

    for (let i = 0; i < count; i += 1) {
      // Evenly spaced through one cycle, so a ring is always on its way out.
      const age = (((elapsed / periodMs) + i / count) % 1 + 1) % 1;

      const rx = (beam / 2) * (0.55 + spread * age);
      const ry = Math.max(1, rx * flatten);

      // Up quickly as it leaves the hull, then away across the rest of it.
      const strength = (age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85) * opacity;
      if (strength <= 0.004) continue;

      const lw = Math.max(1, ry * thickness);
      ctx.lineWidth = lw;

      // The face turned towards the sky, and the one turned away from it.
      ctx.strokeStyle = `rgba(255, 255, 255, ${strength.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy - lw * 0.45, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(0, 0, 0, ${(strength * 0.85).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy + lw * 0.45, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * The shadow the boat casts on the water immediately under it.
   *
   * Small and dark and soft, and hardly noticed - which is the point. Without
   * one a boat and the water it is on are two pictures that happen to overlap;
   * with one they are in the same place. It is the cheapest cue there is that
   * something is resting on something else, and the eye reads it without ever
   * looking at it.
   *
   * It follows the boat's beam - how wide the hull is where it meets the water,
   * measured from the drawing - rather than the width of the picture, so a
   * narrow canoe gets a narrow shadow and a broad one a broad shadow, and the
   * lily pads a visitor drew out to the edges of the page do not stretch it
   * across the lake.
   *
   * Multiplied onto the water rather than painted over it, so what shows is the
   * lake going darker. Painting grey over it would put a grey shape on the water
   * that stays grey however bright or dark the footage under it is, and a
   * background nobody has seen yet is exactly the case this has to survive.
   *
   * Softened at both ends: a gradient that never reaches its own edge, and a
   * blur over the top of that. A contact shadow with an edge anywhere on it is
   * an ellipse drawn on a lake, which is the same mistake the old ripples made.
   */
  drawContactShadow(ctx, { centreX, boatW, tilt, keelY }, offsetY) {
    if (!this.hull || !FLOAT.shadow.opacity) return;

    const { opacity, widthOfBeam, height: heightRatio, blurPx, dropRatio } = FLOAT.shadow;

    const { left, right } = this.hull.beam;
    const beam = Math.max(0, right - left) * boatW;
    if (beam < 8) return;

    // The beam's own centre, which is not the middle of the picture: a boat
    // drawn towards one side of the page casts its shadow under itself.
    const offset = ((left + right) / 2 - 0.5) * boatW;

    const rx = (beam * widthOfBeam) / 2;
    const ry = Math.max(2, rx * heightRatio);

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
    ctx.translate(centreX + offset, keelY + ry * dropRatio + offsetY);
    ctx.rotate(tilt);
    ctx.scale(1, ry / rx);

    // Darkest under the middle of the hull and gone before the edge, so there is
    // no rim anywhere.
    const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    shade.addColorStop(0, `rgba(0, 0, 0, ${opacity})`);
    shade.addColorStop(0.55, `rgba(0, 0, 0, ${(opacity * 0.55).toFixed(3)})`);
    shade.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * The picture the water reflects: the visitor's sketch, always.
   *
   * The same drawing that is on the wall, mirrored - which is what a reflection
   * on water is. Not a re-render, not a second version of the boat, not the
   * lit and yawed model: the sketch, as scanned, upside down in the lake.
   *
   * That it does not depend on which of the three renderers drew the boat is
   * the point twice over. It is the same picture the visitor is looking at, and
   * it works whichever way the boat is being shown - where before there was one
   * reflection for a generated model, one for the flat drawing, and none at all
   * for the inflated one, which is the path the wall actually runs.
   *
   * The box is the flat boat's, because that is the room the boat occupies
   * however it is drawn - the model is built from this drawing and rendered to
   * very nearly the same footprint.
   */
  mirrorSource(boatW, boatH) {
    return { image: this.boat, width: boatW, height: boatH };
  }

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
   * The boat, mirrored in the water under it.
   *
   * Built a row at a time into a buffer and then composited, rather than drawn
   * straight onto the wall, because every part of what makes a reflection read
   * as one needs the finished mirror to work on.
   *
   * Mirrored about the surface. The old version put it on the wrong side of the
   * line: it drew into a flipped frame starting at zero, which lands the image
   * *above* the waterline with the top of the boat nearest the water. Measured
   * on a real scan it occupied rows 327-528 against a waterline at 557 - wholly
   * above it, entirely behind the opaque hull, which is why it read as a smudge
   * under the drawing rather than as a reflection. Here row zero of the buffer
   * is the waterline and depth increases away from it, so the boat hangs
   * downwards from the surface with its own waterline against the line.
   *
   * Only what is above the water is reflected, because only that is above the
   * water to be reflected. The submerged quarter is already accounted for by the
   * water drawn in front of it.
   *
   * Distorted by the water it is lying on. Each row is shifted sideways by the
   * swell, sampled further along with depth so the distortion travels, and by
   * more the further from the boat it gets - which is the shape a real
   * reflection breaks into. The displacement comes from the same wave field the
   * hull is riding, so the reflection wanders in step with the water rather than
   * to a rhythm of its own.
   *
   * Blurred by how much the water is moving. The surface's steepness under the
   * boat is measured each frame and sets the blur, so the mirror sharpens as the
   * lake flattens and smears when a swell runs through.
   *
   * Faded with distance, in two passes. The near half is drawn sharp and the far
   * half blurred, each under its own gradient, so the reflection is crisp where
   * it leaves the hull and dissolves as it goes down - with no band or edge
   * anywhere, because both passes are smooth and simply add.
   */
  drawReflection({ image, width: drawW, height: drawH }, centreX, centreY, waterline, tilt, elapsed) {
    if (!image || !drawW || !drawH) return;

    const { ctx } = this;
    const { opacity, squash, wobble, blurPx, blurGain, sharpShare } = WAVES.reflection;

    // How much of the boat is out of the water: that is all there is to mirror.
    const boxTop = centreY - drawH / 2;
    const above = waterline - boxTop;
    if (above < 4) return;

    const bufW = Math.ceil(drawW);
    const bufH = Math.ceil(above * squash);
    if (bufH < 4 || bufW < 4) return;

    const srcW = image.naturalWidth || image.width;
    const srcH = image.naturalHeight || image.height;
    if (!srcW || !srcH) return;

    // Room either side for a row to wander without running off its own buffer.
    const margin = Math.ceil(Math.abs(wobble) * 24 + blurPx * 3);
    const buffer = this.bufferFor(bufW + margin * 2, bufH, 'mirrorBuffer');
    const bctx = buffer.getContext('2d');
    bctx.clearRect(0, 0, buffer.width, buffer.height);

    // One row of source per row of buffer, sampled upwards from the waterline
    // and nudged sideways by the water.
    const perRow = (srcH / drawH) / squash;

    for (let y = 0; y < bufH; y += 1) {
      const depth = y / bufH;

      // Where on the boat this row of the reflection comes from: the waterline
      // at depth 0, the top of the boat at the far end.
      const srcY = ((waterline - y / squash) - boxTop) * (srcH / drawH);
      if (srcY < 0 || srcY >= srcH) continue;

      const shift = this.waveAt(centreX + y * 6, elapsed * 1.4) * wobble * (0.25 + depth);

      bctx.drawImage(
        image,
        0, srcY, srcW, Math.max(1, perRow),
        margin + shift, y, bufW, 1
      );
    }

    // How hard the water is working, measured as the slope of the surface
    // across the boat. A flat lake gives a sharp mirror; a swell smears it.
    const span = Math.max(24, drawW * 0.25);
    const steepness = Math.abs(
      this.waveAt(centreX + span, elapsed) - this.waveAt(centreX - span, elapsed)
    ) / span;

    const blur = blurPx + blurGain * steepness;

    ctx.save();
    ctx.translate(centreX, waterline);
    ctx.rotate(-tilt);

    const left = -bufW / 2 - margin;

    // Near: sharp, strongest at the surface, gone by the middle.
    ctx.globalAlpha = opacity;
    ctx.drawImage(this.fadedMirror(buffer, bufH, 0, sharpShare), left, 0);

    // Far: blurred, absent at the surface and fading out at the end. The two
    // overlap through the middle, so neither shows an edge.
    ctx.globalAlpha = opacity * 0.85;
    ctx.filter = `blur(${blur.toFixed(2)}px)`;
    ctx.drawImage(this.fadedMirror(buffer, bufH, sharpShare, 1), left, 0);
    ctx.filter = 'none';

    ctx.restore();
  }

  /**
   * A copy of the mirror, present only across one band of depth.
   *
   * A copy rather than the buffer itself, because the mirror is wanted twice -
   * once sharp and once blurred - and fading it where it stands would leave the
   * second pass working on what the first had already rubbed out.
   *
   * Within the band it runs from full strength at the near edge to nothing at
   * the far one; outside it there is nothing at all. Two bands drawn one over
   * the other therefore sum to a single fade from the waterline to nothing, with
   * no seam between them.
   */
  fadedMirror(mirror, bufH, from, to) {
    const copy = this.bufferFor(mirror.width, mirror.height, 'fadeBuffer');
    const cctx = copy.getContext('2d');

    cctx.clearRect(0, 0, copy.width, copy.height);
    cctx.drawImage(mirror, 0, 0);

    // Opaque means "erase this". Nothing is taken from the near edge of the
    // band, everything from the far edge, and all of what lies outside it.
    const gradient = cctx.createLinearGradient(0, from * bufH, 0, to * bufH);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,1)');

    cctx.save();
    cctx.globalCompositeOperation = 'destination-out';

    // Everything nearer the surface than the band.
    if (from > 0) {
      cctx.fillStyle = 'rgba(0,0,0,1)';
      cctx.fillRect(0, 0, copy.width, from * bufH);
    }

    // ...and, across the band itself, more of it the deeper it goes. Past the
    // far edge the gradient's own last stop carries on erasing.
    cctx.fillStyle = gradient;
    cctx.fillRect(0, from * bufH, copy.width, copy.height - from * bufH);
    cctx.restore();

    return copy;
  }

  /**
   * The wake: the water the boat has already been through.
   *
   * Arcs shed behind the hull, widening and fading as they fall astern. They
   * trail towards where the boat came from, which is the left - the crossing
   * runs left to right - so the boat always looks like it is going somewhere
   * rather than sitting on a moving background.
   *
   * Nothing is simulated. Each arc is a function of how long ago it was shed,
   * which costs a few ellipses a frame and reads correctly at the back of a
   * hall.
   */
  drawWake(centreX, baseY, boatW, elapsed, progress) {
    const { ctx } = this;
    const { count, periodMs, spread, opacity, lineWidth } = ANIMATE.wake;

    // Nothing to leave behind until the boat has actually moved.
    const travelled = Math.min(1, progress * 4);
    if (travelled <= 0.01) return;

    ctx.save();
    ctx.lineWidth = lineWidth;

    for (let i = 0; i < count; i += 1) {
      const age = (((elapsed / periodMs) + i / count) % 1 + 1) % 1;

      // Astern, and further with every moment.
      const behind = boatW * (0.35 + spread * age);
      const rx = boatW * (0.18 + 0.5 * age);
      const ry = rx * 0.22;

      const fade = (1 - age) * opacity * travelled;
      if (fade <= 0.01) continue;

      ctx.strokeStyle = `rgba(255, 255, 255, ${fade.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(centreX - behind, baseY + ry * 0.5, rx, ry, 0, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * The organiser's logos and advertisement, painted onto the wall.
   *
   * The overlay decides *what* is showing and how far through its fade it is;
   * this only puts it on the canvas. Keeping the two apart means the schedule
   * is not tangled up in the drawing, and keeping the drawing here means there
   * is one picture rather than two - the wall and the recording cannot drift
   * apart, because they are the same pixels.
   */
  drawOverlay(now, w, h) {
    const frame = this.overlay.frame(now);
    if (!frame) return;

    if (frame.ad) this.drawAd(frame.ad, w, h);

    // Logos over the advertisement: they are the venue's, and a full-screen
    // advertisement should not be able to cover them.
    frame.logos.forEach((logo) => this.drawLogo(logo, w, h));
  }

  drawLogo({ side, image, size }, w, h) {
    const height = (h * size) / 100;
    const width = (image.naturalWidth / image.naturalHeight) * height;
    if (!Number.isFinite(width) || width <= 0) return;

    const margin = h * OVERLAY.marginRatio;
    const x = side === 'left' ? margin : w - margin - width;

    this.ctx.drawImage(image, x, margin, width, height);
  }

  drawAd({ media, placement, opacity }, w, h) {
    const { ctx } = this;

    const [rx, ry, rw, rh] = adRect(placement, w, h);
    if (rw < 2 || rh < 2) return;

    const mw = media.videoWidth || media.naturalWidth;
    const mh = media.videoHeight || media.naturalHeight;
    if (!mw || !mh) return;

    // Fitted inside its area whole, never cropped - the same as the panel's
    // preview and the same as `object-fit: contain` did before.
    const fit = Math.min(rw / mw, rh / mh);
    const dw = mw * fit;
    const dh = mh * fit;
    const dx = (rw - dw) / 2;
    const dy = (rh - dh) / 2;

    const buffer = this.bufferFor(rw, rh);
    const bctx = buffer.getContext('2d');

    bctx.clearRect(0, 0, rw, rh);
    bctx.drawImage(media, dx, dy, dw, dh);

    // The edge that faces into the scene is faded out, so the advertisement
    // melts into the water instead of ending on a straight line. A full-screen
    // one has no such edge - all four sit on the border of the wall.
    const feather = featherFor(placement, bctx, rw, rh);
    if (feather) {
      bctx.save();
      bctx.globalCompositeOperation = 'destination-out';
      bctx.fillStyle = feather;
      bctx.fillRect(0, 0, rw, rh);
      bctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.drawImage(buffer, rx, ry);
    ctx.restore();
  }

  /**
   * A scratch canvas of a given size, reused between frames.
   *
   * Kept per purpose - `slot` names which one - because the water band and an
   * advertisement are different shapes and are both wanted every frame. One
   * shared buffer would be thrown away and rebuilt twice a frame.
   */
  bufferFor(width, height, slot = 'adBuffer') {
    const w = Math.ceil(width);
    const h = Math.ceil(height);

    if (!this[slot] || this[slot].width !== w || this[slot].height !== h) {
      this[slot] = document.createElement('canvas');
      this[slot].width = w;
      this[slot].height = h;
    }

    return this[slot];
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

/** The area an advertisement occupies, by placement. */
function adRect(placement, w, h) {
  const strip = OVERLAY.stripRatio;

  switch (placement) {
    case 'top': return [0, 0, w, h * strip];
    case 'bottom': return [0, h * (1 - strip), w, h * strip];
    case 'left': return [0, 0, w * strip, h];
    case 'right': return [w * (1 - strip), 0, w * strip, h];
    default: return [0, 0, w, h]; // fullscreen
  }
}

/**
 * A gradient that erases the edge facing into the scene, and nothing else.
 *
 * Used with `destination-out`, so opaque here means "rub this away". It runs
 * from nothing at `featherStart` to fully gone at the inner edge; the other
 * three edges of a strip lie along the border of the wall, where there is
 * nothing to blend with.
 */
function featherFor(placement, ctx, w, h) {
  const ends = {
    top: [0, 0, 0, h],
    bottom: [0, h, 0, 0],
    left: [0, 0, w, 0],
    right: [w, 0, 0, 0],
  }[placement];

  if (!ends) return null; // fullscreen

  const gradient = ctx.createLinearGradient(...ends);
  gradient.addColorStop(OVERLAY.featherStart, 'rgba(0, 0, 0, 0)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 1)');

  return gradient;
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
