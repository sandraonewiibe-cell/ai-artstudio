import { LAUNCH } from './config.js';

/**
 * A rocket's five-second show, for when the wall is showing space.
 *
 * The visitor's drawing is the rocket. It flies in from the left, loops round
 * the biggest planet in the picture - passing behind it on the far side of the
 * orbit - swings round the next one, sweeps across the sky, dives low, turns
 * nose-up and launches straight up and off the top of the wall.
 *
 * Its nose always points the way it is going. Under it a flame flickers -
 * orange, yellow, white at the core - and pale smoke trails behind it, with a
 * burst at the launch. The drawing itself is never changed: it is turned and
 * moved, nothing else. The flame comes out of the bottom of whatever was drawn,
 * found from its own silhouette.
 *
 * The planets are found in the background picture itself (see findPlanets), so
 * the loops go round whatever planets the organiser's picture has. With none,
 * the rocket loops round the middle of the sky instead.
 */
export class Launch {
  constructor() {
    this.puffs = [];
    this.nozzle = null;
    this.sprite = makePuffSprite(128);
    this.emitted = 0;
    this.path = null;
    this.planets = [];
    this.planetsKey = null;
  }

  /** Readies a new rocket: where its exhaust comes out, and a clean sky. */
  begin(drawing) {
    this.puffs = [];
    this.emitted = 0;
    this.path = null;
    this.nozzle = findNozzle(drawing);
  }

  /**
   * The planets in the background, found once per picture.
   *
   * @param {CanvasImageSource|null} background what the wall is drawing behind
   * @param {string} key changes when the background does
   */
  usePlanets(background, key, w, h) {
    if (key === this.planetsKey) return;
    this.planetsKey = key;
    this.planets = background ? findPlanets(background, w, h) : [];
    this.path = null;
    if (this.planets.length) {
      console.log(
        `[launch] ${this.planets.length} planet(s) in the background: ` +
          this.planets.map((p) => `(${Math.round(p.x)}, ${Math.round(p.y)}) r${Math.round(p.r)}`).join(' ')
      );
    }
  }

  /**
   * Draws one frame of the show.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {CanvasImageSource & {width:number,height:number}} drawing
   * @param {number} elapsed ms since the show began
   * @param {number} delta ms since the last frame
   * @param {(ctx: CanvasRenderingContext2D) => void} repaintBackground draws
   *   the background again - used to put a planet back in front of the rocket
   */
  draw(ctx, drawing, elapsed, delta, w, h, repaintBackground) {
    const cfg = LAUNCH;

    const scale = Math.min((h * cfg.rocketHeight) / drawing.height, (w * cfg.rocketWidth) / drawing.width);
    const rocketW = drawing.width * scale;
    const rocketH = drawing.height * scale;

    if (!this.path) this.path = buildTour(this.planets, w, h, rocketH);
    const pose = this.poseAt(elapsed, w, h, rocketH);

    // Where the exhaust leaves the rocket, turned with it.
    const nozzle = this.nozzle || { x: 0.5, width: 0.3, bottom: 1 };
    const local = { x: (nozzle.x - 0.5) * rocketW, y: nozzle.bottom * rocketH - rocketH / 2 };
    const cos = Math.cos(pose.angle);
    const sin = Math.sin(pose.angle);
    const exhaust = {
      x: pose.x + local.x * cos - local.y * sin,
      y: pose.y + local.x * sin + local.y * cos,
    };
    const nozzleW = Math.max(rocketW * nozzle.width, rocketW * 0.14);

    this.emit(delta, exhaust, pose, nozzleW, h);
    this.update(delta);
    this.drawSmoke(ctx);

    if (pose.visible) {
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.rotate(pose.angle);
      this.drawGlow(ctx, local.x, local.y, nozzleW, pose.thrust, elapsed);
      this.drawFlame(ctx, local.x, local.y, nozzleW, rocketH, pose.thrust, elapsed);
      ctx.drawImage(drawing, -rocketW / 2, -rocketH / 2, rocketW, rocketH);
      ctx.restore();

      // On the far side of an orbit the planet is in front: the background is
      // painted back over the rocket, inside the planet's circle only.
      if (pose.behind && repaintBackground) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(pose.behind.x, pose.behind.y, pose.behind.r, 0, Math.PI * 2);
        ctx.clip();
        repaintBackground(ctx);
        ctx.restore();
      }
    }
  }

  /**
   * Where the rocket is, which way it points, and how hard the engine is
   * working, at a moment in the show.
   */
  poseAt(elapsed, w, h, rocketH) {
    const cfg = LAUNCH;
    const path = this.path;

    if (elapsed <= cfg.tourMs) {
      const s = (elapsed / cfg.tourMs) * path.length;
      const here = path.at(s);
      const ahead = path.at(Math.min(path.length, s + 6));
      const before = path.at(Math.max(0, s - 6));
      const angle = Math.atan2(ahead.y - before.y, ahead.x - before.x) + Math.PI / 2;
      return { x: here.x, y: here.y, angle, behind: here.behind, thrust: 0.85, visible: true };
    }

    // The launch: straight up from where the tour left it, at the speed it was
    // going and faster every moment, until it is gone off the top.
    const end = path.at(path.length);
    const t = (elapsed - cfg.tourMs) / 1000;
    const v0 = (path.length / cfg.tourMs) * 1000;
    const acceleration = v0 * cfg.launchBoost;
    const y = end.y - (v0 * t + 0.5 * acceleration * t * t);
    return {
      x: end.x,
      y,
      angle: 0,
      behind: null,
      thrust: 1.25,
      visible: y > -rocketH,
    };
  }

  /** Smoke from the engine: a steady trail on the tour, a burst at the launch. */
  emit(delta, at, pose, width, h) {
    const cfg = LAUNCH.smoke;
    if (!pose.visible) return;

    const launching = pose.angle === 0 && pose.thrust > 1;
    this.emitted += (delta / 1000) * (launching ? cfg.launchPerSecond : cfg.trailPerSecond);

    while (this.emitted >= 1 && this.puffs.length < cfg.max) {
      this.emitted -= 1;

      // Out of the back of the rocket, spreading a little.
      const back = pose.angle + Math.PI / 2;
      const spread = (Math.random() - 0.5) * (launching ? 1.4 : 0.6);
      const speed = h * cfg.speed * (0.4 + Math.random() * 0.8);

      this.puffs.push({
        x: at.x + (Math.random() - 0.5) * width * 0.5,
        y: at.y + (Math.random() - 0.5) * width * 0.5,
        vx: Math.cos(back + spread) * speed,
        vy: Math.sin(back + spread) * speed,
        r: width * (0.3 + Math.random() * 0.25),
        grow: width * (launching ? 1.5 : 0.9) * (0.7 + Math.random() * 0.6),
        age: 0,
        life: cfg.lifeMs * (0.7 + Math.random() * 0.6),
      });
    }

    if (this.emitted > 1) this.emitted = 1;
  }

  update(delta) {
    const dt = delta / 1000;
    for (const puff of this.puffs) {
      puff.age += delta;
      puff.x += puff.vx * dt;
      puff.y += puff.vy * dt;
      puff.vx *= 1 - Math.min(1, 2.2 * dt);
      puff.vy *= 1 - Math.min(1, 2.2 * dt);
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
      const alpha = cfg.opacity * (k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9);
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = alpha;
      ctx.drawImage(this.sprite, puff.x - radius, puff.y - radius, radius * 2, radius * 2);
    }
    ctx.restore();
  }

  /** The light the engine throws, in the rocket's own frame. */
  drawGlow(ctx, x, y, width, thrust, elapsed) {
    const flicker = 0.85 + 0.15 * Math.sin(elapsed / 37) * Math.sin(elapsed / 23);
    const radius = width * 2.6 * Math.min(1.3, thrust) * flicker;
    if (radius < 1) return;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const cy = y + width * 0.6;
    const glow = ctx.createRadialGradient(x, cy, 0, x, cy, radius);
    glow.addColorStop(0, 'rgba(255, 170, 70, 0.45)');
    glow.addColorStop(0.4, 'rgba(255, 110, 40, 0.18)');
    glow.addColorStop(1, 'rgba(255, 90, 30, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  /**
   * The flame: a teardrop hanging from the nozzle, flickering in length, in the
   * rocket's own frame so it always comes out of the back.
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
 * The tour: in from the left, a loop round each planet from left to right,
 * then on into a turn nose-up at a spot clear of the planets, where the
 * straight launch takes over. With only one planet it also sweeps round the
 * sky before coming down, so the rocket still goes all round the wall.
 *
 * Every loop is joined at its bottom, heading right - the way the rocket is
 * already going - so the path flows instead of doubling back. Orbits are
 * flattened ellipses, so the loop reads as going round the planet, and the
 * part above the planet's middle is the far side, where it goes behind.
 *
 * @returns {{length: number, at: (s: number) => {x:number,y:number,behind:object|null}}}
 */
function buildTour(planets, w, h, rocketH) {
  const gap = rocketH * LAUNCH.orbitGap;
  const sky = (planets.length ? planets : [{ x: w * 0.4, y: h * 0.5, r: h * 0.08, stand: true }])
    .slice()
    .sort((a, b) => a.x - b.x);

  // Somewhere clear of the planets for the launch, right of the last loop.
  const lastX = sky[sky.length - 1].x;
  const launchX = [0.5, 0.62, 0.72, 0.82, 0.4, 0.3]
    .map((f) => f * w)
    .sort((a, b) => score(b) - score(a))[0];
  function score(x) {
    return Math.min(clearance(x, sky), w * 0.25) + (x > lastX ? w * 0.05 : 0);
  }

  const shape = (planet) => {
    // Squashed for depth, and kept on the wall on every side.
    const rx = Math.max(
      planet.r * 1.05,
      Math.min(planet.r + gap, planet.x - w * 0.04, w * 0.96 - planet.x, w * 0.28)
    );
    const ry = Math.max(planet.r * 0.55, Math.min(rx * 0.5, planet.y - h * 0.06, h * 0.94 - planet.y));
    return { rx, ry };
  };

  const shapes = sky.map(shape);
  const points = [{ x: -rocketH * 1.5, y: sky[0].y + shapes[0].ry }];

  sky.forEach((planet, index) => {
    const { rx, ry } = shapes[index];

    // A lead-in level with the bottom of the loop, so the rocket eases into
    // it heading right rather than cutting in at an angle.
    if (index > 0) points.push({ x: planet.x - rx * 0.9, y: planet.y + ry * 1.05 });
    const sweep = Math.PI * 2;
    const steps = 24;
    for (let i = 0; i <= steps; i += 1) {
      // From the bottom, heading right, up the far side and over the top.
      const a = Math.PI / 2 - (sweep * i) / steps;
      const y = planet.y + ry * Math.sin(a);
      points.push({
        x: planet.x + rx * Math.cos(a),
        y,
        behind: planet.stand ? null : y < planet.y - ry * 0.15 ? planet : null,
      });
    }
  });

  // One planet: a sweep round the sky too, so it still goes all round.
  if (sky.length === 1) {
    points.push({ x: w * 0.7, y: h * 0.2 }, { x: w * 0.9, y: h * 0.45 });
  }

  // Down low and up - the turn into the launch.
  points.push(
    { x: launchX - w * 0.06, y: h * 0.9 },
    { x: launchX, y: h * 0.86 },
    { x: launchX, y: h * 0.7 }
  );

  return sampleSpline(points);
}

/** How far a point on the bottom of the wall is from the nearest planet's edge. */
function clearance(x, planets) {
  return Math.min(...planets.map((p) => Math.abs(p.x - x) - p.r));
}

/** A smooth curve through the points, measured so it can be walked at speed. */
function sampleSpline(points) {
  const dense = [];
  const pt = (i) => points[Math.max(0, Math.min(points.length - 1, i))];

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = pt(i - 1);
    const p1 = pt(i);
    const p2 = pt(i + 1);
    const p3 = pt(i + 2);
    const behind = p1.behind && p2.behind ? p1.behind : null;
    for (let k = 0; k < 12; k += 1) {
      const t = k / 12;
      const t2 = t * t;
      const t3 = t2 * t;
      dense.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        behind,
      });
    }
  }
  const last = points[points.length - 1];
  dense.push({ x: last.x, y: last.y, behind: null });

  const lengths = [0];
  for (let i = 1; i < dense.length; i += 1) {
    lengths.push(lengths[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].y - dense[i - 1].y));
  }
  const length = lengths[lengths.length - 1];

  const at = (s) => {
    if (s <= 0) return dense[0];
    if (s >= length) return dense[dense.length - 1];
    let lo = 0;
    let hi = lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = (s - lengths[lo]) / (lengths[hi] - lengths[lo] || 1);
    return {
      x: dense[lo].x + (dense[hi].x - dense[lo].x) * f,
      y: dense[lo].y + (dense[hi].y - dense[lo].y) * f,
      behind: dense[lo].behind,
    };
  };

  return { length, at };
}

/**
 * Planets in a background picture: large, round, bright, colourful shapes.
 *
 * Stars are too small, comets too long and thin, and the night sky too dark to
 * count. Positions come back in wall pixels, through the same cover-fit the
 * wall draws the background with.
 */
export function findPlanets(source, w, h) {
  const iw = source.naturalWidth || source.videoWidth || source.width;
  const ih = source.naturalHeight || source.videoHeight || source.height;
  if (!iw || !ih) return [];

  const sw = 160;
  const sh = Math.max(1, Math.round((ih / iw) * sw));
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let data;
  try {
    ctx.drawImage(source, 0, 0, sw, sh);
    data = ctx.getImageData(0, 0, sw, sh).data;
  } catch {
    return [];
  }

  const { minLuma, minSaturation, minAreaRatio, minRoundness } = LAUNCH.planets;
  const mask = new Uint8Array(sw * sh);
  for (let i = 0; i < mask.length; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = r * 0.299 + g * 0.587 + b * 0.114;
    if (luma >= minLuma && max > 0 && (max - min) / max >= minSaturation) mask[i] = 1;
  }

  const seen = new Uint8Array(sw * sh);
  const found = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;

    const stack = [start];
    seen[start] = 1;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let x0 = sw;
    let x1 = 0;
    let y0 = sh;
    let y1 = 0;

    while (stack.length) {
      const p = stack.pop();
      const x = p % sw;
      const y = (p - x) / sw;
      area += 1;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const n of [p - 1, p + 1, p - sw, p + sw]) {
        if (n < 0 || n >= mask.length) continue;
        if ((n === p - 1 && x === 0) || (n === p + 1 && x === sw - 1)) continue;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }

    if (area < sw * sh * minAreaRatio) continue;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const r = Math.sqrt(area / Math.PI);
    // A disc fills its box; a comet or a streak of stars does not.
    const roundness = area / (Math.PI * (Math.max(bw, bh) / 2) ** 2);
    if (roundness < minRoundness || bw / bh > 2.8 || bh / bw > 2.8) continue;

    found.push({ x: sx / area, y: sy / area, r });
  }

  // Into wall pixels, through the cover-fit.
  const scale = Math.max(w / iw, h / ih);
  const ox = (w - iw * scale) / 2;
  const oy = (h - ih * scale) / 2;
  const k = (iw / sw) * scale;

  return found
    .map((p) => ({ x: ox + p.x * k, y: oy + p.y * k, r: p.r * k }))
    .filter((p) => p.x > w * 0.05 && p.x < w * 0.95 && p.y > h * 0.06 && p.y < h * 0.94)
    .sort((a, b) => b.r - a.r)
    .slice(0, 2);
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
