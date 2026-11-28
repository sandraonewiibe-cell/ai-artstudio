import { SWIM } from './config.js';

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

  /** Readies a new fish: which way it faces, and where its mouth is. */
  begin(drawing) {
    const head = findHead(drawing);
    this.facing = head.facing;
    this.mouth = head.mouth;
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
    const scale = Math.min((w * cfg.fishWidth) / drawing.width, (h * cfg.fishHeight) / drawing.height);
    const fishW = drawing.width * scale;
    const fishH = drawing.height * scale;

    const pose = poseAt(elapsed, this.facing, fishW, w, h);

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
 * Where the fish is and how it is tilted, a moment into its swim.
 *
 * In from behind its tail, across the wall with a gentle up-and-down, a dive
 * in the middle - nose down, deep, nose up and back - and out the far side.
 */
function poseAt(elapsed, facing, fishW, w, h) {
  const cfg = SWIM;
  const p = Math.min(1, elapsed / cfg.swimMs);

  // A little faster in the middle, easing at the ends.
  const travel = p - Math.sin(p * Math.PI * 2) * 0.03;
  // Just out of sight at each end, so it is on the wall for the whole show.
  const from = -fishW * 0.55;
  const to = w + fishW * 0.55;
  const along = from + (to - from) * travel;
  const x = facing > 0 ? along : w - along;

  const wave = Math.sin((elapsed / 1000) * 1.7) * h * 0.035;
  const diveP = (p - cfg.dive.from) / (cfg.dive.to - cfg.dive.from);
  const dive = diveP > 0 && diveP < 1 ? Math.sin(diveP * Math.PI) * h * cfg.dive.depth : 0;
  const y = h * cfg.cruiseY + wave + dive;

  // Nose follows the way it is going: down into the dive, up out of it.
  const dt = 30;
  const p2 = Math.min(1, (elapsed + dt) / cfg.swimMs);
  const dP2 = (p2 - cfg.dive.from) / (cfg.dive.to - cfg.dive.from);
  const dive2 = dP2 > 0 && dP2 < 1 ? Math.sin(dP2 * Math.PI) * h * cfg.dive.depth : 0;
  const y2 = h * cfg.cruiseY + Math.sin(((elapsed + dt) / 1000) * 1.7) * h * 0.035 + dive2;
  const dx = ((to - from) / cfg.swimMs) * dt;
  const tilt = Math.max(-0.6, Math.min(0.6, Math.atan2(y2 - y, dx)));

  return { x, y, angle: tilt * facing };
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

  // How pronounced a waist is in the outer part of one side.
  const waist = (from, to, step) => {
    let narrowest = Infinity;
    let at = -1;
    for (let x = from; x !== to; x += step) {
      if (heights[x] > 0 && heights[x] < narrowest) {
        narrowest = heights[x];
        at = x;
      }
    }
    if (at < 0) return 0;
    // Widest beyond the waist, towards the end.
    let beyond = 0;
    for (let x = at; x >= 0 && x < w; x += step) beyond = Math.max(beyond, heights[x]);
    return beyond > narrowest * 1.4 ? (beyond - narrowest) / body : 0;
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
    Object.entries(SWIM.sprites).map(async ([name, { file, width }]) => {
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
          frames.push(
            await createImageBitmap(image, { resizeWidth: width, resizeHeight: Math.round(width / aspect) })
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
