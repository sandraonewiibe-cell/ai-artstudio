import { PADDLES } from './config.js';
import { labelComponents } from './components.js';

/**
 * Finds the oars in a filled drawing so each can be animated separately.
 *
 * The problem: an oar drawn touching the hull is one connected component with
 * it, so labelling alone cannot separate them.
 *
 * The way through is a morphological opening. Eroding the filled shape by a
 * radius wider than an oar stroke rubs the oars out entirely while barely
 * touching the solid hull; dilating back restores the hull's size. What the
 * filled shape has and the opened one does not is a thin appendage. Judged on
 * elongation and length, the long thin ones are oars.
 *
 * Nothing is reported unless it genuinely looks like an oar, so a drawing
 * without any is unaffected.
 *
 * Oars are looked for in two places, because people draw them both ways:
 *
 *   - **hanging off the hull** - an appendage, found by the opening above;
 *   - **across the hull** - ink lying inside the filled body, which is how a
 *     snake boat is usually drawn and which the opening cannot see at all.
 *
 * @param {Uint8Array} fill filled drawing mask (strokes plus enclosed areas)
 * @param {Uint8Array} strokes drawn ink only, without the fill
 * @param {number} width
 * @param {number} height
 * @returns {{paddles: object[], appendageMask: Uint8Array, interiorMask: Uint8Array}}
 */
export function detectPaddles(fill, strokes, width, height, bounds, hullBounds) {
  const blank = () => new Uint8Array(fill.length);
  const noLabels = () => new Int32Array(fill.length).fill(-1);

  const empty = {
    paddles: [],
    appendageMask: blank(),
    interiorMask: blank(),
    appendageLabels: noLabels(),
    interiorLabels: noLabels(),
  };

  // Morphology only over the drawing itself. Sweeping the whole page costs
  // several times as much for pixels that are known to be blank, and this
  // runs while the visitor is standing there waiting.
  const box = bounds
    ? {
        minX: Math.max(0, bounds.minX - 2),
        minY: Math.max(0, bounds.minY - 2),
        maxX: Math.min(width - 1, bounds.maxX + 2),
        maxY: Math.min(height - 1, bounds.maxY + 2),
      }
    : { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 };

  const radius = Math.max(2, Math.round(Math.min(width, height) * PADDLES.openRadiusRatio));
  const core = open(fill, width, height, radius, box);

  const outer = findOars({
    region: subtract(fill, core),
    core,
    width,
    height,
    limits: PADDLES,
    mode: 'appendage',
  });

  // Ink sitting well inside the filled hull: the outline is excluded by the
  // inset, so what is left is whatever was drawn across the boat.
  const inset = Math.max(
    2,
    Math.round(Math.min(width, height) * PADDLES.interior.insetRatio)
  );
  let filledArea = 0;
  for (let i = 0; i < fill.length; i += 1) if (fill[i]) filledArea += 1;

  const inner = findOars({
    region: intersect(strokes, erode(fill, width, height, inset, box)),
    core: null,
    width,
    height,
    limits: PADDLES.interior,
    mode: 'interior',
    maxArea: filledArea * PADDLES.interior.maxAreaShare,
    // An oar drawn across the boat is, by definition, on the boat. Without this
    // a line of handwriting below the hull qualifies - it is long, thin, and
    // inside the drawing - and gets torn off and rowed on its own, which shows
    // up on the wall as the visitor's name drifting about by itself.
    confineTo: hullBounds,
  });

  const paddles = [...outer.paddles, ...inner.paddles];

  // Too many means the radius is wrong for this drawing and hull texture is
  // being read as oars. Better to animate nothing than to shred the boat.
  if (!paddles.length || paddles.length > PADDLES.maxCount) return empty;

  // Row them in the order they sit along the hull.
  paddles.sort((a, b) => a.pivot.x - b.pivot.x);

  return {
    paddles,
    appendageMask: outer.mask,
    interiorMask: inner.mask,
    appendageLabels: outer.labels,
    interiorLabels: inner.labels,
  };
}

/**
 * Finds the long thin things in a region and measures each one.
 *
 * @returns {{paddles: object[], mask: Uint8Array}}
 */
function findOars({
  region, core, width, height, limits, mode, maxArea = Infinity, confineTo,
}) {
  const mask = new Uint8Array(region.length);

  let any = 0;
  for (let i = 0; i < region.length; i += 1) if (region[i]) any += 1;
  if (!any) {
    return { paddles: [], mask, labels: new Int32Array(region.length).fill(-1) };
  }

  const { components, labels } = labelComponents(region, width, height);
  const diagonal = Math.hypot(width, height);
  const area = width * height;

  const found = components
    .filter((c) => c.area >= area * PADDLES.minAreaRatio && c.area <= maxArea)
    .filter((c) => !confineTo || within(c, confineTo))
    .map((c) => describe(c, labels, core, width, height, mode))
    .filter((c) => c && c.length >= diagonal * limits.minLengthRatio)
    .filter((c) => c.length <= diagonal * limits.maxLengthRatio)
    .filter((c) => c.elongation >= limits.minElongation);

  const chosen = new Set(found.map((c) => c.label));
  for (let i = 0; i < region.length; i += 1) {
    if (region[i] && chosen.has(labels[i])) mask[i] = 1;
  }

  return { paddles: found, mask, labels };
}

/** True if a component sits entirely within a box. */
function within(component, box) {
  return (
    component.minX >= box.minX &&
    component.maxX <= box.maxX &&
    component.minY >= box.minY &&
    component.maxY <= box.maxY
  );
}

function subtract(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) if (a[i] && !b[i]) out[i] = 1;
  return out;
}

function intersect(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i += 1) if (a[i] && b[i]) out[i] = 1;
  return out;
}

/**
 * Measures one appendage: how long and thin it is, where it joins the hull,
 * and where its blade ends.
 */
function describe(component, labels, core, width, height, mode = 'appendage') {
  const { label, minX, maxX, minY, maxY } = component;

  // Second moments give the principal axis, which is what "long and thin"
  // actually means for a stroke drawn at any angle.
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;

  // Pixels touching the solid body are where the oar is held.
  let attachN = 0;
  let attachX = 0;
  let attachY = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const i = y * width + x;
      if (labels[i] !== label) continue;

      n += 1;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;

      if (core && touchesCore(core, x, y, width, height)) {
        attachN += 1;
        attachX += x;
        attachY += y;
      }
    }
  }

  if (n < 4) return null;

  const meanX = sumX / n;
  const meanY = sumY / n;
  const varX = sumXX / n - meanX * meanX;
  const varY = sumYY / n - meanY * meanY;
  const covXY = sumXY / n - meanX * meanY;

  // Eigenvalues of the 2x2 covariance matrix.
  const middle = (varX + varY) / 2;
  const spread = Math.sqrt(Math.max(0, ((varX - varY) / 2) ** 2 + covXY * covXY));
  const major = middle + spread;
  const minor = Math.max(middle - spread, 0.35); // floor: a 1px line has no width

  const length = 4 * Math.sqrt(major);
  const elongation = Math.sqrt(major / minor);

  // Where the oar is held.
  //
  // An appendage is held where it meets the hull. A bar drawn across the boat
  // has no such join, so it is held at its upper end - side-on, an oar reaches
  // down from the gunwale into the water, so the lower end is the blade.
  const axis = 0.5 * Math.atan2(2 * covXY, varX - varY);
  const ends = axisEnds(labels, label, minX, maxX, minY, maxY, width, meanX, meanY, axis);
  if (!ends) return null;

  let pivot;
  if (mode === 'interior') {
    pivot = ends.a.y <= ends.b.y ? ends.a : ends.b;
  } else if (attachN) {
    pivot = { x: attachX / attachN, y: attachY / attachN };
  } else {
    pivot = nearestEnd({ meanX, meanY, major, covXY, varX, varY }, width, height);
  }

  const tip = farthestPixel(labels, label, minX, maxX, minY, maxY, width, pivot);
  if (!tip) return null;

  return {
    label,
    mode,
    length,
    elongation,
    pivot,
    tip,
    bounds: { minX, maxX, minY, maxY },
    area: n,
  };
}

function touchesCore(core, x, y, width, height) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (core[ny * width + nx]) return true;
    }
  }
  return false;
}

/** The two pixels furthest apart along the component's principal axis. */
function axisEnds(labels, label, minX, maxX, minY, maxY, width, meanX, meanY, axis) {
  const dirX = Math.cos(axis);
  const dirY = Math.sin(axis);

  let low = null;
  let high = null;
  let lowT = Infinity;
  let highT = -Infinity;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (labels[y * width + x] !== label) continue;

      const t = (x - meanX) * dirX + (y - meanY) * dirY;
      if (t < lowT) {
        lowT = t;
        low = { x, y };
      }
      if (t > highT) {
        highT = t;
        high = { x, y };
      }
    }
  }

  return low && high ? { a: low, b: high } : null;
}

/** For a detached oar: the end of its axis closer to the middle of the page. */
function nearestEnd(stats, width, height) {
  const angle = 0.5 * Math.atan2(2 * (stats.covXY || 0), stats.varX - stats.varY);
  const half = 2 * Math.sqrt(stats.major);

  const a = { x: stats.meanX - Math.cos(angle) * half, y: stats.meanY - Math.sin(angle) * half };
  const b = { x: stats.meanX + Math.cos(angle) * half, y: stats.meanY + Math.sin(angle) * half };

  const centre = { x: width / 2, y: height / 2 };
  const da = Math.hypot(a.x - centre.x, a.y - centre.y);
  const db = Math.hypot(b.x - centre.x, b.y - centre.y);

  return da <= db ? a : b;
}

/** The blade: the pixel furthest from where the oar is held. */
function farthestPixel(labels, label, minX, maxX, minY, maxY, width, pivot) {
  let best = null;
  let bestDistance = -1;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (labels[y * width + x] !== label) continue;

      const distance = (x - pivot.x) ** 2 + (y - pivot.y) ** 2;
      if (distance > bestDistance) {
        bestDistance = distance;
        best = { x, y };
      }
    }
  }

  return best;
}

/** Erode then dilate - removes anything thinner than 2r, keeps the body. */
function open(mask, width, height, radius, box) {
  return dilate(erode(mask, width, height, radius, box), width, height, radius, box);
}

/**
 * Separable min filter. Doing the two axes in turn costs 2*(2r+1) comparisons
 * per pixel instead of (2r+1)^2, and confining it to the drawing's own box
 * skips the blank margins entirely - together the difference between a
 * noticeable pause and none at all.
 */
function erode(mask, width, height, radius, box) {
  return morph(mask, width, height, radius, false, box);
}

function dilate(mask, width, height, radius, box) {
  return morph(mask, width, height, radius, true, box);
}

function morph(mask, width, height, radius, isDilate, box) {
  const pass = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);

  const minX = box ? box.minX : 0;
  const maxX = box ? box.maxX : width - 1;
  const minY = box ? box.minY : 0;
  const maxY = box ? box.maxY : height - 1;

  // Horizontal
  for (let y = minY; y <= maxY; y += 1) {
    const row = y * width;
    for (let x = minX; x <= maxX; x += 1) {
      let value = isDilate ? 0 : 1;

      for (let d = -radius; d <= radius; d += 1) {
        const nx = x + d;
        // Outside the image counts as background, so the border erodes away.
        const sample = nx < 0 || nx >= width ? 0 : mask[row + nx];
        if (isDilate ? sample : !sample) {
          value = isDilate ? 1 : 0;
          break;
        }
      }

      pass[row + x] = value;
    }
  }

  // Vertical
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let value = isDilate ? 0 : 1;

      for (let d = -radius; d <= radius; d += 1) {
        const ny = y + d;
        const sample = ny < 0 || ny >= height ? 0 : pass[ny * width + x];
        if (isDilate ? sample : !sample) {
          value = isDilate ? 1 : 0;
          break;
        }
      }

      out[y * width + x] = value;
    }
  }

  return out;
}
