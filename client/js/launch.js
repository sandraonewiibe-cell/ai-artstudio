import { LAUNCH } from './config.js';

/**
 * A rocket launch, for when the wall is showing space rather than water.
 *
 * The visitor's drawing is the rocket. It stands on the pad, shakes while the
 * engine lights, then lifts off and accelerates up and off the top of the wall.
 * Under it a flame flickers - orange outside, yellow inside, white at the core -
 * and smoke billows out at ignition and trails behind it as it climbs.
 *
 * Nothing about the drawing is changed or redrawn. The flame and the smoke come
 * out of the bottom of whatever was drawn, found from its own silhouette, so a
 * fat rocket gets a wide flame and a thin one a narrow flame.
 */
export class Launch {
  constructor() {
    this.puffs = [];
    this.nozzle = null;
    this.sprite = makePuffSprite(128);
    this.lastEmit = 0;
  }

  /** Readies a new rocket: where its exhaust comes out, and a clean sky. */
  begin(drawing) {
    this.puffs = [];
    this.lastEmit = 0;
    this.nozzle = findNozzle(drawing);
  }

  /**
   * Draws one frame of the launch.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {CanvasImageSource & {width:number,height:number}} drawing
   * @param {number} elapsed ms since this rocket went up
   * @param {number} delta ms since the last frame
   */
  draw(ctx, drawing, elapsed, delta, w, h) {
    const cfg = LAUNCH;

    const scale = Math.min((w * cfg.maxWidth) / drawing.width, (h * cfg.maxHeight) / drawing.height);
    const rocketW = drawing.width * scale;
    const rocketH = drawing.height * scale;

    // Where the bottom of the rocket is: on the pad until ignition is over, then
    // climbing, faster and faster, until it is well off the top of the wall.
    const padY = h * cfg.padY;
    const climb = Math.max(0, elapsed - cfg.igniteMs) / 1000;
    const distance = padY + rocketH + h * 0.15;
    const acceleration = (2 * distance) / (cfg.ascentSeconds * cfg.ascentSeconds);
    const lift = 0.5 * acceleration * climb * climb;
    const bottomY = padY - lift;

    // Shake on the pad, settling into a gentle sway once it is flying.
    const t = elapsed / 1000;
    const igniting = elapsed < cfg.igniteMs;
    const shake = igniting
      ? (elapsed / cfg.igniteMs) * h * cfg.shake * Math.sin(t * 71) * Math.sin(t * 53)
      : 0;
    const sway = climb > 0 ? Math.sin(t * 1.3) * w * cfg.sway : 0;
    const tilt = climb > 0 ? Math.sin(t * 1.3 + 0.6) * ((cfg.tiltDegrees * Math.PI) / 180) : 0;

    const centreX = w / 2 + sway + shake;
    const topY = bottomY - rocketH;

    // Where the exhaust leaves the rocket, on the wall.
    const nozzle = this.nozzle || { x: 0.5, width: 0.3, bottom: 1 };
    const nozzleX = centreX + (nozzle.x - 0.5) * rocketW;
    const nozzleY = topY + nozzle.bottom * rocketH;
    const nozzleW = Math.max(rocketW * nozzle.width, rocketW * 0.12);

    // Engine strength: building up through ignition, then full.
    const thrust = igniting ? Math.min(1, elapsed / cfg.igniteMs) : 1;

    this.emit(elapsed, delta, nozzleX, nozzleY, nozzleW, thrust, climb > 0, h, padY);
    this.update(delta, h, padY);

    // Smoke first, so the rocket climbs out of it rather than behind it.
    this.drawSmoke(ctx);
    this.drawGlow(ctx, nozzleX, nozzleY, nozzleW, thrust, elapsed);

    ctx.save();
    ctx.translate(nozzleX, nozzleY);
    ctx.rotate(tilt);
    ctx.translate(-nozzleX, -nozzleY);
    this.drawFlame(ctx, nozzleX, nozzleY, nozzleW, rocketH, thrust, elapsed);
    ctx.drawImage(drawing, centreX - rocketW / 2, topY, rocketW, rocketH);
    ctx.restore();
  }

  /** New smoke from the engine: a burst on the pad, a trail once airborne. */
  emit(elapsed, delta, x, y, width, thrust, flying, h, padY) {
    const cfg = LAUNCH.smoke;
    const rate = flying ? cfg.trailPerSecond : cfg.padPerSecond * thrust;
    this.lastEmit += (delta / 1000) * rate;

    while (this.lastEmit >= 1 && this.puffs.length < cfg.max) {
      this.lastEmit -= 1;

      const onPad = !flying || y > padY - h * 0.05;
      const spread = onPad ? 1 : 0.35;
      const side = Math.random() * 2 - 1;

      this.puffs.push({
        x: x + side * width * 0.4,
        y: y + h * 0.01,
        // On the pad the smoke rolls out sideways along the ground; in flight it
        // hangs behind the rocket and drifts a little.
        vx: side * h * cfg.speed * spread * (0.6 + Math.random() * 0.8),
        vy: onPad ? h * cfg.speed * (0.05 + Math.random() * 0.25) : h * cfg.speed * 0.15 * Math.random(),
        r: width * (0.35 + Math.random() * 0.3),
        grow: width * (onPad ? 1.6 : 0.9) * (0.7 + Math.random() * 0.6),
        age: 0,
        life: cfg.lifeMs * (0.7 + Math.random() * 0.6),
        spin: Math.random() * Math.PI * 2,
      });
    }

    if (this.lastEmit > 1) this.lastEmit = 1;
  }

  update(delta, h, padY) {
    const dt = delta / 1000;
    for (const puff of this.puffs) {
      puff.age += delta;
      puff.x += puff.vx * dt;
      puff.y += puff.vy * dt;
      // Smoke slows as it spreads, and does not sink through the pad.
      puff.vx *= 1 - Math.min(1, 1.6 * dt);
      puff.vy *= 1 - Math.min(1, 1.6 * dt);
      if (puff.y > padY + h * 0.04) puff.y = padY + h * 0.04;
    }
    this.puffs = this.puffs.filter((puff) => puff.age < puff.life);
  }

  drawSmoke(ctx) {
    const cfg = LAUNCH.smoke;
    ctx.save();
    for (const puff of this.puffs) {
      const k = puff.age / puff.life;
      // Swells fast, fades slow - the billow in the reference, then the drift.
      const radius = puff.r + puff.grow * Math.sqrt(k);
      const alpha = cfg.opacity * (k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88);
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = alpha;
      ctx.drawImage(this.sprite, puff.x - radius, puff.y - radius, radius * 2, radius * 2);
    }
    ctx.restore();
  }

  /** The light the engine throws on its own smoke. */
  drawGlow(ctx, x, y, width, thrust, elapsed) {
    const flicker = 0.85 + 0.15 * Math.sin(elapsed / 37) * Math.sin(elapsed / 23);
    const radius = width * 3.2 * thrust * flicker;
    if (radius < 1) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(x, y + width * 0.6, 0, x, y + width * 0.6, radius);
    glow.addColorStop(0, `rgba(255, 170, 70, ${0.45 * thrust})`);
    glow.addColorStop(0.4, `rgba(255, 110, 40, ${0.18 * thrust})`);
    glow.addColorStop(1, 'rgba(255, 90, 30, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - radius, y + width * 0.6 - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  /**
   * The flame: a teardrop hanging from the nozzle, flickering in length.
   * Three layers, outside in - orange, yellow, white - as in the reference.
   */
  drawFlame(ctx, x, y, width, rocketH, thrust, elapsed) {
    const flicker =
      0.78 + 0.22 * (0.5 + 0.5 * Math.sin(elapsed / 29)) * (0.6 + 0.4 * Math.sin(elapsed / 47 + 1));
    const length = rocketH * LAUNCH.flameLength * thrust * flicker;
    if (length < 2) return;

    const layers = [
      { w: 1, l: 1, colour: ['rgba(255, 120, 30, 0.95)', 'rgba(255, 70, 20, 0)'] },
      { w: 0.62, l: 0.72, colour: ['rgba(255, 214, 80, 1)', 'rgba(255, 170, 40, 0)'] },
      { w: 0.3, l: 0.42, colour: ['rgba(255, 255, 235, 1)', 'rgba(255, 240, 180, 0)'] },
    ];

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const layer of layers) {
      const half = (width * layer.w) / 2;
      const len = length * layer.l;
      const gradient = ctx.createLinearGradient(x, y, x, y + len);
      gradient.addColorStop(0, layer.colour[0]);
      gradient.addColorStop(1, layer.colour[1]);
      ctx.fillStyle = gradient;

      ctx.beginPath();
      ctx.moveTo(x - half, y);
      ctx.quadraticCurveTo(x - half * 0.9, y + len * 0.45, x, y + len);
      ctx.quadraticCurveTo(x + half * 0.9, y + len * 0.45, x + half, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * Where the exhaust should come out of a drawing: the middle of its lowest
 * part, and how wide that part is - all as fractions of the drawing.
 *
 * Read from the silhouette, so a rocket drawn with fins comes out of its body
 * between them rather than out of a fin tip: the bottom band is taken a little
 * way up, where the body still is, and its widest solid run is used.
 */
function findNozzle(drawing) {
  const w = Math.max(1, Math.min(200, drawing.width));
  const h = Math.max(1, Math.round((drawing.height / drawing.width) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(drawing, 0, 0, w, h);

  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }

  const opaque = (x, y) => data[(y * w + x) * 4 + 3] > 40;

  let bottom = -1;
  for (let y = h - 1; y >= 0 && bottom < 0; y -= 1) {
    for (let x = 0; x < w; x += 1) {
      if (opaque(x, y)) {
        bottom = y;
        break;
      }
    }
  }
  if (bottom < 0) return null;

  // A few rows above the very bottom, so fin tips and stray marks do not decide it.
  const band = Math.max(0, bottom - Math.round(h * 0.06));
  let best = { start: 0, length: 0 };
  for (let y = band; y <= bottom; y += 1) {
    let start = -1;
    for (let x = 0; x <= w; x += 1) {
      const on = x < w && opaque(x, y);
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start > best.length) best = { start, length: x - start };
        start = -1;
      }
    }
  }

  if (!best.length) return null;
  return {
    x: (best.start + best.length / 2) / w,
    width: Math.min(0.6, best.length / w),
    bottom: (bottom + 1) / h,
  };
}

/** One soft, pale puff, drawn once and scaled for every bit of smoke. */
function makePuffSprite(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size / 2;

  // A few overlapping blobs, so it reads as a cloud and not a disc.
  const blobs = [
    [0.5, 0.55, 0.42],
    [0.36, 0.5, 0.3],
    [0.64, 0.48, 0.3],
    [0.5, 0.38, 0.28],
  ];
  for (const [bx, by, br] of blobs) {
    const g = ctx.createRadialGradient(bx * size, by * size, 0, bx * size, by * size, br * size);
    g.addColorStop(0, 'rgba(250, 232, 226, 0.9)');
    g.addColorStop(0.6, 'rgba(238, 214, 210, 0.45)');
    g.addColorStop(1, 'rgba(230, 205, 205, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx * size, by * size, br * size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Keep it inside its square.
  ctx.globalCompositeOperation = 'destination-in';
  const mask = ctx.createRadialGradient(r, r, r * 0.6, r, r, r);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, size, size);

  return canvas;
}
