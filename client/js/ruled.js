import { EXTRACT } from './config.js';
import { labelComponents } from './components.js';

/**
 * Removes the printed rules of lined or squared paper from an ink mask.
 *
 * Notebook lines are darker than the paper around them, so they pass the ink
 * test like any pen stroke. Every stroke of a drawing crosses them, which
 * joined the whole drawing and every rule into one shape spanning the page.
 * That shape reached the page edge and was discarded as the paper's border,
 * and all that survived was a scrap that happened not to touch a rule.
 *
 * A rule is told apart from a drawn line by its length: it runs nearly the
 * whole way across the page, nearly straight. Nothing a visitor draws does.
 * Where a pen stroke crosses a rule, the pixels in between are put back, so an
 * outline cut by the rules stays closed and its inside still fills.
 *
 * Changes the mask in place.
 *
 * @param {Uint8Array} mask 1 where there is ink
 * @returns {number} how many ink pixels were removed
 */
export function removeRuledLines(mask, width, height) {
  const { minSpanRatio, gapPx, bridgePx } = EXTRACT.rules;

  const vertical = longLines(mask, width, height, true, Math.round(height * minSpanRatio), gapPx);
  const horizontal = longLines(mask, width, height, false, Math.round(width * minSpanRatio), gapPx);

  const rule = new Uint8Array(width * height);
  let found = 0;
  for (let i = 0; i < rule.length; i += 1) {
    if (vertical[i] || horizontal[i]) {
      rule[i] = 1;
      found += 1;
    }
  }
  if (!found) return 0;

  let removed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!rule[i]) continue;

      // A stroke crossing a vertical rule has ink to its left and right; one
      // crossing a horizontal rule has ink above and below.
      const bridged = vertical[i]
        ? strokeOnBothSides(mask, rule, width, height, x, y, 1, 0, bridgePx)
        : strokeOnBothSides(mask, rule, width, height, x, y, 0, 1, bridgePx);

      if (!bridged) {
        mask[i] = 0;
        removed += 1;
      }
    }
  }

  return removed + dropRemnants(mask, rule, width, height);
}

/**
 * Small bits of a rule that the test above missed - its stub at the page edge,
 * a faint stretch - lie up against the rule that was removed. A stroke that
 * merely crosses a rule mostly does not.
 */
function dropRemnants(mask, rule, width, height) {
  const { remnantMaxRatio, remnantNearShare } = EXTRACT.rules;
  const maxArea = width * height * remnantMaxRatio;
  const { components, labels } = labelComponents(mask, width, height);

  const near = new Int32Array(components.length);
  const area = new Int32Array(components.length);
  const index = new Map(components.map((c, k) => [c.label, k]));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const label = labels[y * width + x];
      if (label < 0 || !index.has(label)) continue;
      const k = index.get(label);
      area[k] += 1;

      let touching = false;
      for (let dy = -2; dy <= 2 && !touching; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px >= 0 && py >= 0 && px < width && py < height && rule[py * width + px] && !mask[py * width + px]) {
            touching = true;
            break;
          }
        }
      }
      if (touching) near[k] += 1;
    }
  }

  const drop = new Set();
  components.forEach((c, k) => {
    if (area[k] && area[k] <= maxArea && near[k] / area[k] >= remnantNearShare) drop.add(c.label);
  });
  if (!drop.size) return 0;

  let dropped = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] && drop.has(labels[i])) {
      mask[i] = 0;
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * Marks ink lying on a long, nearly straight run in one direction.
 *
 * For every ink pixel, how far the run through it reaches each way. A step
 * may skip up to `gap` pixels, for a rule that prints faintly in places, and
 * may move at most one pixel sideways, so a rule bowed by a curling page still
 * counts while a sloping pen stroke does not.
 */
function longLines(mask, width, height, vertical, minSpan, gap) {
  const along = vertical ? height : width;
  const across = vertical ? width : height;
  const at = vertical ? (a, c) => a * width + c : (a, c) => c * width + a;

  const forward = new Int32Array(width * height);
  const backward = new Int32Array(width * height);

  for (let a = along - 1; a >= 0; a -= 1) {
    for (let c = 0; c < across; c += 1) {
      const i = at(a, c);
      if (!mask[i]) continue;

      let reach = a;
      for (let step = 1; step <= gap && a + step < along; step += 1) {
        for (let side = -1; side <= 1; side += 1) {
          const n = c + side;
          if (n < 0 || n >= across) continue;
          const j = at(a + step, n);
          if (mask[j] && forward[j] > reach) reach = forward[j];
        }
      }
      forward[i] = reach;
    }
  }

  for (let a = 0; a < along; a += 1) {
    for (let c = 0; c < across; c += 1) {
      const i = at(a, c);
      if (!mask[i]) continue;

      let reach = a;
      for (let step = 1; step <= gap && a - step >= 0; step += 1) {
        for (let side = -1; side <= 1; side += 1) {
          const n = c + side;
          if (n < 0 || n >= across) continue;
          const j = at(a - step, n);
          if (mask[j] && backward[j] < reach) reach = backward[j];
        }
      }
      backward[i] = reach;
    }
  }

  const marked = new Uint8Array(width * height);
  for (let a = 0; a < along; a += 1) {
    for (let c = 0; c < across; c += 1) {
      const i = at(a, c);
      if (!mask[i] || forward[i] - backward[i] + 1 < minSpan) continue;

      // Reaching a rule is not enough: a sloping stroke that runs into one
      // inherits the rule's whole length. A rule also has to stay on its own
      // line nearby, which the end of a hull drawn at a slant does not.
      if (straightHere(mask, at, along, across, a, c, 1) || straightHere(mask, at, along, across, a, c, -1)) {
        marked[i] = 1;
      }
    }
  }
  return marked;
}

/** How far ahead to look, and how far sideways a rule may drift by then. */
const STRAIGHT_PROBES = [15, 30, 45];
// One pixel sideways per this many along. Loose enough for a rule bowed by a
// curling page, still tight enough to reject the slanted end of a hull.
const STRAIGHT_DRIFT = 12;

/** Ink continues the same line at each probe distance in one direction. */
function straightHere(mask, at, along, across, a, c, sign) {
  for (const k of STRAIGHT_PROBES) {
    const drift = 1 + Math.floor(k / STRAIGHT_DRIFT);
    let seen = false;

    for (let slack = -2; slack <= 2 && !seen; slack += 1) {
      const p = a + sign * (k + slack);
      if (p < 0 || p >= along) continue;
      for (let s = -drift; s <= drift; s += 1) {
        const n = c + s;
        if (n >= 0 && n < across && mask[at(p, n)]) {
          seen = true;
          break;
        }
      }
    }

    if (!seen) return false;
  }
  return true;
}

/** Ink that is not itself a rule, within `reach` on both sides of (x, y). */
function strokeOnBothSides(mask, rule, width, height, x, y, dx, dy, reach) {
  const hit = (sign) => {
    for (let k = 1; k <= reach; k += 1) {
      const px = x + sign * dx * k;
      const py = y + sign * dy * k;
      if (px < 0 || py < 0 || px >= width || py >= height) return false;

      // The row either side as well, so a stroke meeting the rule at a slant
      // still counts.
      for (let off = -1; off <= 1; off += 1) {
        const qx = px + dy * off;
        const qy = py + dx * off;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const j = qy * width + qx;
        if (mask[j] && !rule[j]) return true;
      }
    }
    return false;
  };

  return hit(1) && hit(-1);
}
