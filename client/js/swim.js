import { SWIM } from './config.js';
import { sampleSpline } from './launch.js';

/**
 * Fish in the ocean, for when the wall is showing an underwater picture.
 *
 * The visitor's drawing is the fish. It swims in from behind its tail, wiggles
 * along, dives deep and comes back up, and swims off the other side - nose
 * first, whichever way it was drawn facing. Its back half swishes like a tail
 * the whole way, and it puffs bubbles from its mouth now and then.
 *
 * Around it the ocean is alive whether or not a drawing is up: real animated
 * fish from assets/ocean swim past, a dolphin dives, plants sway on the seabed
 * with fish darting through them, and bubbles rise from the bottom.
 *
 * The drawing itself is never redrawn - it is cut into thin upright strips and
 * each strip is moved up or down, which is all a swishing tail needs.
 */
export class Swim {
  constructor() {
    this.bubbles = [];
    this.facing = 1;
    this.mouth = { x: 1, y: 0.45 };
    this.lastPuff = 0;
    this.nextPuff = 0;
    this.lastAmbient = 0;
    this.sprites = {};
    this.loading = loadSprites().then((sprites) => {
      this.sprites = sprites;
    });
  }

  /**
   * Readies a new fish: which way it faces, and where its mouth is. A fish
   * drawn standing on its tail is turned to lie along its swim first.
   *
   * @returns the drawing to swim - turned, if it had to be
   */
  begin(drawing) {
    drawing = lieDown(drawing);
    const head = findHead(drawing);

    // Every fish swims left to right. One drawn facing left is mirrored - not
    // turned over - so it faces right and is still the right way up.
    if (head.facing < 0) {
      drawing = mirror(drawing);
      head.mouth = { x: 1 - head.mouth.x, y: head.mouth.y };
    }
    this.drawing = drawing;
    this.facing = 1;
    this.mouth = head.mouth;
    this.path = null;
    this.trail = 0;
    this.nextPuff = 400 + Math.random() * 600;
  }

  /**
   * The ocean's own life: what swims and grows there with or without a
   * drawing. Drawn behind the visitor's fish.
   *
   * @param {number} now performance.now()
   */
  drawAmbient(ctx, now, delta, w, h) {
    const t = now / 1000;

    // Plants and the fish that live in them, on the seabed at the left.
    const scenery = this.sprites.scenery;
    if (scenery) {
      const sh = h * SWIM.scenery.height;
      const sw = sh * scenery.aspect;
      drawFrame(ctx, scenery, now, w * 0.02, h - sh, sw, sh, false);
    }

    // A pair of little fish circling each other, drifting across the middle.
    const pair = this.sprites.pair;
    if (pair) {
      const ph = h * SWIM.pair.height;
      const pw = ph * pair.aspect;
      const span = w + pw * 2;
      const x = ((t * w * SWIM.pair.speed) % span) - pw;
      const y = h * 0.28 + Math.sin(t * 0.7) * h * 0.03;
      drawFrame(ctx, pair, now, x, y, pw, ph, false);
    }

    // The dolphin, diving through its own arc, crossing the other way lower down.
    const dolphin = this.sprites.dolphin;
    if (dolphin) {
      const dh = h * SWIM.dolphin.height;
      const dw = dh * dolphin.aspect;
      const span = w + dw * 2;
      const x = w + dw - ((t * w * SWIM.dolphin.speed + span * 0.5) % span);
      drawFrame(ctx, dolphin, now, x, h * 0.55, dw, dh, true);
    }

    // Bubbles from the seabed, now and then.
    this.lastAmbient += delta;
    if (this.lastAmbient > SWIM.bubbles.seabedEveryMs * (0.5 + Math.random())) {
      this.lastAmbient = 0;
      const x = w * (0.1 + Math.random() * 0.8);
      const count = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i += 1) this.addBubble(x + (Math.random() - 0.5) * 30, h + 10, h, 0.6);
    }

    this.updateBubbles(delta, h);
  }

  /**
   * The visitor's fish, one frame of its swim.
   *
   * @param {number} elapsed ms since the swim began
   */
  draw(ctx, drawing, elapsed, delta, w, h) {
    const cfg = SWIM;
    // The turned copy, if begin() had to turn it.
    if (this.drawing) drawing = this.drawing;
    const scale = Math.min((w * cfg.fishWidth) / drawing.width, (h * cfg.fishHeight) / drawing.height);
    const fishW = drawing.width * scale;
    const fishH = drawing.height * scale;

    if (!this.path) this.path = buildDive(this.facing, fishW, w, h);
    const pose = poseAt(this.path, elapsed, this.facing);

    // A stream of bubbles off a fish plunging downwards, as in the dolphin's
    // dive - more the steeper it goes.
    const steep = Math.max(pose.sinking, pose.rising);
    if (steep > 0.3) {
      const rate = pose.rising > pose.sinking ? SWIM.bubbles.risePerSecond : SWIM.bubbles.divePerSecond;
      this.trail += (delta / 1000) * rate * steep;
      while (this.trail >= 1) {
        this.trail -= 1;
        this.addBubble(pose.x + (Math.random() - 0.5) * fishW * 0.3, pose.y - fishH * 0.2, h, 1);
      }
    }

    // Bubbles from the mouth, in little bursts at random moments.
    this.lastPuff += delta;
    if (this.lastPuff >= this.nextPuff) {
      this.lastPuff = 0;
      this.nextPuff = cfg.bubbles.mouthEveryMs * (0.6 + Math.random() * 0.9);
      const mx = (this.mouth.x - 0.5) * fishW;
      const my = (this.mouth.y - 0.5) * fishH;
      const cos = Math.cos(pose.angle);
      const sin = Math.sin(pose.angle);
      const x = pose.x + mx * cos - my * sin;
      const y = pose.y + mx * sin + my * cos;
      const count = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i += 1) this.addBubble(x, y - i * fishH * 0.05, h, 1, i * 90);
    }

    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);
    drawWiggling(ctx, drawing, fishW, fishH, this.facing, elapsed);
    ctx.restore();
  }

  /** Bubbles go over everything, fish included. */
  drawBubbles(ctx) {
    ctx.save();
    for (const b of this.bubbles) {
      if (b.delay > 0) continue;
      const k = b.age / b.life;
      const alpha = Math.min(1, k * 6) * (1 - Math.max(0, (k - 0.8) / 0.2));
      if (alpha <= 0.01) continue;
      const r = b.r * (1 + k * 0.6);

      ctx.globalAlpha = alpha * b.strength;
      ctx.strokeStyle = 'rgba(235, 250, 255, 0.9)';
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.fillStyle = 'rgba(200, 235, 255, 0.18)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // The glint that makes a circle read as a bubble.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(b.x - r * 0.35, b.y - r * 0.35, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  addBubble(x, y, h, strength, delay = 0) {
    if (this.bubbles.length >= SWIM.bubbles.max) return;
    this.bubbles.push({
      x,
      y,
      r: h * (0.006 + Math.random() * 0.012),
      vy: -h * (0.08 + Math.random() * 0.08),
      wobble: Math.random() * Math.PI * 2,
      age: 0,
      life: 2200 + Math.random() * 2200,
      strength,
      delay,
    });
  }

  updateBubbles(delta, h) {
    const dt = delta / 1000;
    for (const b of this.bubbles) {
      if (b.delay > 0) {
        b.delay -= delta;
        continue;
      }
      b.age += delta;
      b.wobble += dt * 5;
      b.y += b.vy * dt;
      b.x += Math.sin(b.wobble) * h * 0.012 * dt * 4;
    }
    this.bubbles = this.bubbles.filter((b) => b.age < b.life && b.y > -h * 0.05);
  }

  /** Clears the visitor's bubbles; the ocean's own keep rising. */
  clear() {
    this.bubbles = this.bubbles.filter((b) => b.strength < 1);
  }
}

/**
 * The swim, left to right: in from the left, a dive - nose down, deep, almost
 * to the seabed - a turn along the bottom, then up: climbing away towards the
 * surface and out of the top of the wall, trailing bubbles all the way.
 */
function buildDive(facing, fishW, w, h) {
  const { from, depth, rise } = SWIM.dive;
  const cruise = h * SWIM.cruiseY;
  const deep = h * depth;

  const points = [
    { x: -fishW * 0.55, y: cruise },
    { x: w * (from - 0.1), y: cruise + h * 0.02 },
    // The dive.
    { x: w * from, y: cruise + h * 0.08 },
    { x: w * (from + 0.08), y: (cruise + deep) / 2 + h * 0.04 },
    { x: w * (from + 0.16), y: deep },
    // Along the bottom, turning.
    { x: w * (from + 0.26), y: deep + h * 0.02 },
    { x: w * (from + 0.34), y: deep - h * 0.06 },
    // And up, away to the surface.
    { x: w * rise.x, y: h * 0.45 },
    { x: w * (rise.x + 0.08), y: h * 0.18 },
    { x: w * (rise.x + 0.13), y: -h * 0.3 },
  ];

  return sampleSpline(points);
}

/**
 * Where the fish is on its path, and which way it points.
 *
 * It tilts with the path - nose up into the leap, nose down into the plunge -
 * but is held short of rolling over, so it is always the right way up.
 * `sinking` is how steeply it is heading down, 0 to 1, for the bubble trail.
 */
function poseAt(path, elapsed, facing) {
  const p = Math.min(1, elapsed / SWIM.swimMs);
  // A touch quicker through the dives, easier at the ends.
  const s = (p - Math.sin(p * Math.PI * 2) * 0.025) * path.length;
  const here = path.at(s);
  const ahead = path.at(Math.min(path.length, s + 8));
  const before = path.at(Math.max(0, s - 8));
  const dx = ahead.x - before.x;
  const dy = ahead.y - before.y;
  const heading = Math.atan2(dy, dx);

  // The drawing's nose points right (facing 1) or left (facing -1); turn it so
  // the nose points along the path.
  // Tilted to follow the path but never past nose-straight-up or down, so the
  // fish is never shown upside down.
  const limit = (SWIM.maxTiltDegrees * Math.PI) / 180;
  const level = heading;
  const wrapped = Math.atan2(Math.sin(level), Math.cos(level));
  const angle = Math.max(-limit, Math.min(limit, wrapped));
  const speed = Math.hypot(dx, dy) || 1;
  return { x: here.x, y: here.y, angle, sinking: Math.max(0, dy / speed), rising: Math.max(0, -dy / speed) };
}

/**
 * The drawing, with its tail swishing.
 *
 * Cut into thin upright strips; each is moved up or down by a wave that is
 * nothing at the head and strongest at the tail, travelling backwards along
 * the body - which is how a fish's tail moves.
 */
function drawWiggling(ctx, drawing, fishW, fishH, facing, elapsed) {
  const strips = SWIM.tail.strips;
  const phase = (elapsed / 1000) * SWIM.tail.speed;
  const amplitude = fishH * SWIM.tail.amplitude;

  for (let i = 0; i < strips; i += 1) {
    const sx = (drawing.width * i) / strips;
    const sw = drawing.width / strips + 1;
    const dx = -fishW / 2 + (fishW * i) / strips;
    const dw = fishW / strips + 1;

    // 0 at the head, 1 at the tip of the tail.
    const centre = (i + 0.5) / strips;
    const fromHead = facing > 0 ? 1 - centre : centre;
    const swish = fromHead > 0.35 ? ((fromHead - 0.35) / 0.65) ** 1.6 : 0;
    const offset = Math.sin(phase - fromHead * 3.2) * amplitude * swish;

    ctx.drawImage(drawing, sx, 0, sw, drawing.height, dx, -fishH / 2 + offset, dw, fishH);
  }
}

/**
 * Which way a drawn fish faces, and where its mouth is.
 *
 * A fish narrows sharply just before its tail and opens out again into the tail
 * fin; its head narrows smoothly to the nose. So the end with a waist near it -
 * a column much thinner than the body, with a wider one beyond it - is the
 * tail. Drawn as a plain oval with no waist either end, it is taken to face
 * right, which is how most children draw one.
 */
/** The drawing flipped left to right. */
function mirror(drawing) {
  const canvas = document.createElement('canvas');
  canvas.width = drawing.width;
  canvas.height = drawing.height;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(drawing, 0, 0);
  return canvas;
}

/**
 * Lays a fish flat, whatever way it was drawn on the page - standing up,
 * diving, at a slant.
 *
 * The long axis of the drawn shape is measured from its silhouette (the
 * moments of everything drawn, as OpenCV would) and the drawing is turned so
 * that axis runs level. Turned the shortest way, never more than a quarter
 * turn, so a fish drawn level stays exactly as it was. Nearly round shapes are
 * left alone: they have no long axis to go by.
 */
function lieDown(drawing) {
  if (!drawing || !drawing.width || !drawing.height) return drawing;
  const axis = longAxis(drawing);
  if (!axis || axis.elongation < SWIM.minElongation) return drawing;

  // Shortest turn that brings the axis level.
  let turn = -axis.angle;
  if (turn > Math.PI / 2) turn -= Math.PI;
  if (turn < -Math.PI / 2) turn += Math.PI;
  if (Math.abs(turn) < (SWIM.levelWithinDegrees * Math.PI) / 180) return drawing;

  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(drawing.width * cos + drawing.height * sin);
  canvas.height = Math.ceil(drawing.width * sin + drawing.height * cos);
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(turn);
  ctx.drawImage(drawing, -drawing.width / 2, -drawing.height / 2);
  return trimToContent(canvas);
}

/** The direction the drawn shape is longest in, and how much longer it is. */
function longAxis(drawing) {
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

  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > 40) {
        n += 1;
        sx += x;
        sy += y;
      }
    }
  }
  if (n < 20) return null;
  const mx = sx / n;
  const my = sy / n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3] > 40) {
        xx += (x - mx) ** 2;
        yy += (y - my) ** 2;
        xy += (x - mx) * (y - my);
      }
    }
  }
  xx /= n;
  yy /= n;
  xy /= n;
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const half = (xx + yy) / 2;
  const spread = Math.sqrt(Math.max(0, half * half - (xx * yy - xy * xy)));
  const major = half + spread;
  const minor = Math.max(1e-6, half - spread);
  return { angle, elongation: Math.sqrt(major / minor) };
}

/** A turned drawing cut down to what is on it. */
function trimToContent(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const { data } = ctx.getImageData(0, 0, width, height);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return canvas;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function findHead(drawing) {
  const fallback = { facing: 1, mouth: { x: 0.98, y: 0.45 } };
  const w = Math.max(1, Math.min(240, drawing.width));
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
    return fallback;
  }

  // Height of the silhouette in each column, top to bottom.
  const heights = new Array(w).fill(0);
  const middles = new Array(w).fill(h / 2);
  for (let x = 0; x < w; x += 1) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < h; y += 1) {
      if (data[(y * w + x) * 4 + 3] > 40) {
        if (top < 0) top = y;
        bottom = y;
      }
    }
    if (top >= 0) {
      heights[x] = bottom - top + 1;
      middles[x] = (top + bottom) / 2;
    }
  }

  const body = Math.max(...heights);
  if (!body) return fallback;

  // How pronounced a waist is in the outer part of one side: the deepest dip
  // that has something wider beyond it, towards that end. Not simply the
  // narrowest column - the very tip of a tail fin, or of a nose, is narrow too,
  // and has nothing beyond it.
  const waist = (from, to, step) => {
    let deepest = 0;
    let beyond = 0;
    // Walk in from the end, keeping the widest column seen so far beyond.
    for (let x = to - step; x !== from - step; x -= step) {
      if (x < 0 || x >= w) continue;
      if (heights[x] > 0 && beyond > heights[x] * 1.4) {
        deepest = Math.max(deepest, (beyond - heights[x]) / body);
      }
      beyond = Math.max(beyond, heights[x]);
    }
    return deepest;
  };

  const leftWaist = waist(Math.round(w * 0.4), -1, -1);
  const rightWaist = waist(Math.round(w * 0.6), w, 1);

  // The tail is the end with the waist; the head is the other one.
  const facing = rightWaist > leftWaist + 0.08 ? -1 : 1;

  const noseX = facing > 0 ? lastFilled(heights, w, -1) : lastFilled(heights, w, 1);
  const mouthX = facing > 0 ? Math.max(0, noseX - Math.round(w * 0.04)) : Math.min(w - 1, noseX + Math.round(w * 0.04));
  return { facing, mouth: { x: mouthX / w, y: middles[mouthX] / h } };
}

function lastFilled(heights, w, direction) {
  if (direction < 0) {
    for (let x = w - 1; x >= 0; x -= 1) if (heights[x] > 0) return x;
    return w - 1;
  }
  for (let x = 0; x < w; x += 1) if (heights[x] > 0) return x;
  return 0;
}

/** The frame of an animated sprite to show now, drawn at a place and size. */
function drawFrame(ctx, sprite, now, x, y, w, h, mirror) {
  const frame = sprite.frameAt(now);
  if (!frame) return;
  if (mirror) {
    ctx.save();
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(frame, 0, 0, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(frame, x, y, w, h);
  }
}

/**
 * A frame with everything but the animal taken out.
 *
 * The dolphin animation has a bird in it, flying across the top with a hoop
 * for the dolphin to jump through. On a wall that is meant to be underwater a
 * bird does not belong, so each frame is cleaned as it is decoded: the bird -
 * dark, and brown to orange - and the blue of its hoop are cleared by colour,
 * then any small or thin piece left over (the paler side of the hoop, a fleck
 * of splash) by size. The dolphin is grey and large, and keeps every pixel.
 */
function keepOnlyTheAnimal(image) {
  const w = image.displayWidth;
  const h = image.displayHeight;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const frame = ctx.getImageData(0, 0, w, h);
  const d = frame.data;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 10) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const luma = r * 0.299 + g * 0.587 + b * 0.114;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const bird = r > b + 25 || luma < 70;
    const hoop = b > r + 45 && chroma > 50;
    if (bird || hoop) d[i + 3] = 0;
  }

  // Whatever is left that is small is not the dolphin.
  const seen = new Uint8Array(w * h);
  const minArea = w * h * 0.004;
  const stack = [];
  for (let start = 0; start < w * h; start += 1) {
    if (seen[start] || d[start * 4 + 3] < 10) continue;
    const piece = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      piece.push(p);
      const x = p % w;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const n = p + dy * w + dx;
          if (nx < 0 || nx >= w || n < 0 || n >= w * h) continue;
          if (!seen[n] && d[n * 4 + 3] >= 10) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (piece.length < minArea) for (const p of piece) d[p * 4 + 3] = 0;
  }

  ctx.putImageData(frame, 0, 0);
  return canvas;
}

/**
 * The animated fish from assets/ocean, decoded into frames once.
 *
 * Only the ones with see-through backgrounds can swim over the wall; the rest
 * of that folder is reference for how the drawing should move. Without the
 * browser's GIF decoder the ocean is simply quieter: the visitor's fish still
 * swims.
 */
async function loadSprites() {
  const sprites = {};
  if (typeof ImageDecoder === 'undefined') {
    console.warn('[swim] no GIF decoder in this browser; the ocean will have no extra fish');
    return sprites;
  }

  await Promise.all(
    Object.entries(SWIM.sprites).map(async ([name, { file, width, onlyTheAnimal }]) => {
      try {
        const response = await fetch(`/assets/ocean/${file}`);
        if (!response.ok) throw new Error(`${response.status}`);
        const decoder = new ImageDecoder({ data: await response.arrayBuffer(), type: 'image/gif' });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack.frameCount;

        const frames = [];
        const ends = [];
        let total = 0;
        for (let i = 0; i < count; i += 1) {
          const { image } = await decoder.decode({ frameIndex: i });
          const aspect = image.displayWidth / image.displayHeight;
          const source = onlyTheAnimal ? keepOnlyTheAnimal(image) : image;
          frames.push(
            await createImageBitmap(source, { resizeWidth: width, resizeHeight: Math.round(width / aspect) })
          );
          total += Math.max(20, (image.duration || 100000) / 1000);
          ends.push(total);
          image.close();
        }
        decoder.close();

        const aspect = frames[0].width / frames[0].height;
        sprites[name] = {
          aspect,
          frameAt(now) {
            const t = now % total;
            let i = 0;
            while (i < ends.length - 1 && ends[i] <= t) i += 1;
            return frames[i];
          },
        };
      } catch (err) {
        console.warn(`[swim] could not load ${file}: ${err.message}`);
      }
    })
  );

  return sprites;
}
