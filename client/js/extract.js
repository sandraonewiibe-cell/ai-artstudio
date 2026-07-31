import { EXTRACT } from './config.js';
import { toLuminance, adaptiveInk, createCanvas, context2d } from './imaging.js';
import { labelComponents } from './components.js';
import { detectPaddles, erode, dilate } from './paddles.js';

/**
 * Isolates the visitor's work from the cropped drawing area and returns it as
 * a PNG with a transparent background.
 *
 * What is kept: the hand-drawn boat and any handwritten text, together, with
 * enclosed areas filled in so an outlined shape reads as solid rather than as
 * a ring around a hole.
 *
 * What is dropped: speckle noise, and anything lying entirely inside a corner
 * box - the last line of defence in case a QR marker survived the crop in
 * capture.js. The page border and the markers themselves are already gone by
 * the time this runs.
 *
 * @param {HTMLCanvasElement} pageCanvas cropped, perspective-corrected drawing area
 * @returns {{canvas: HTMLCanvasElement, bounds: object, inkRatio: number, dropped: number,
 *            filled: number}|null}
 */
export function extractDrawing(pageCanvas) {
  const width = pageCanvas.width;
  const height = pageCanvas.height;
  const page = context2d(pageCanvas).getImageData(0, 0, width, height);

  // The paper is white. Where the camera disagrees, every colour on the sheet
  // is being read through that error, so it is corrected before anything else
  // measures anything from it.
  balanceToPaper(page);

  const luma = toLuminance(page);

  const margin = Math.round(Math.min(width, height) * EXTRACT.marginRatio);
  const radius = Math.max(4, Math.round(Math.min(width, height) * EXTRACT.ink.radiusRatio));

  // Ink is whatever is darker than the paper immediately around it, so uneven
  // lighting across the sheet does not become part of the drawing.
  const { mask, reference, inkCount } = adaptiveInk(luma, width, height, {
    radius,
    offset: EXTRACT.ink.offset,
    margin,
  });

  // Nothing drawn on it.
  if (inkCount < width * height * EXTRACT.ink.minRatio) return null;

  const { components, labels } = labelComponents(mask, width, height);
  if (!components.length) return null;

  // The table past the paper, the paper's edge and its shadow all arrive as a
  // dark band hugging the page edge. None of it is the drawing.
  const inside = components.filter((c) => !touchesEdge(c, width, height, margin));

  // ...but never at the cost of the whole drawing. On a real photograph the
  // shading near the paper's edge can join up with what was drawn, leaving one
  // component that happens to reach the border. Discarding that leaves nothing
  // to extract and the visitor is told there was no drawing - so if excluding
  // the edge would empty the page, keep everything and carry on.
  let usable = inside;
  if (!usable.length) {
    console.warn('[extract] everything reaches the page edge; keeping it anyway');
    usable = components;
  }

  const withCompany = keepDrawingCluster(usable, width, height);
  if (!withCompany.length) return null;

  const kept = withCompany.filter((c) => !isMarkerRemnant(c, width, height));
  if (!kept.length) return null;

  const selected = new Set(kept.map((c) => c.label));
  const strokes = buildStrokeMask(labels, selected, width, height);

  // Anything the visitor drew *on* the boat rather than as part of it - a name
  // across the hull, a heart, a smiley. It is separated first, because both of
  // the decisions below would otherwise get it wrong.
  const writingLabels = selectWritingLabels(kept);

  // Which components are big enough to count as the boat. Only areas these
  // help enclose get filled, so every compartment inside the hull fills while
  // the counters of O, A, B and e stay open.
  const hullLabels = selectHullLabels(kept, writingLabels);
  const walls = buildStrokeMask(labels, hullLabels, width, height);

  const hullBounds = unionBounds(kept.filter((c) => hullLabels.has(c.label)));

  const { fill, filled, preserve } = fillEnclosedAreas(
    strokes,
    labels,
    hullLabels,
    writingLabels,
    hullBounds,
    width,
    height
  );

  const drawingBounds = unionBounds(kept);
  const rect = cropRect(drawingBounds, width, height);

  // Areas the visitor coloured in, closed up so the paper showing through the
  // crayon is treated as coloured too. These count as part of the drawing
  // whether or not the boat encloses them - somebody who colours past the
  // outline still coloured it.
  const paint = paintedRegions(page, width, height, drawingBounds);
  for (let i = 0; i < fill.length; i += 1) if (paint.mask[i]) fill[i] = 1;

  const base = { page, luma, strokes, width, height, reference };

  const rendered = renderLayer({ ...base, fill, preserve, paint, rect });
  if (!rendered) return null;

  return {
    ...rendered,
    dropped: withCompany.length - kept.length,
    specks: components.length - withCompany.length,
    filled,
    // Oars are confined to the single biggest component - the hull itself, not
    // the group of hull-sized things. A solid line of writing can rival a thin
    // outline for area, so it lands in the group and then passes a check based
    // on the group's box; against the hull alone it does not.
    layers: splitLayers(base, fill, rect, drawingBounds, boxOf(largestOf(kept))),
  };
}

/**
 * Finds where the oars are, so the water can react to them.
 *
 * Nothing here changes what is shown, and nothing here is ever shown. The
 * drawing goes to the wall exactly as it was scanned, in one piece, oars
 * included and where the visitor put them. This only works out where each
 * blade enters the water, so the display can throw a splash from it.
 *
 * No layer is produced any more - not of the hull, not of an oar. The masks and
 * the labelling live for the length of this call and are then gone; two points
 * per oar are all that leave the browser.
 *
 * Returns null when the drawing has no oars in it, in which case the boat
 * sails on the swell with no splashes.
 *
 * @returns {{paddles: {pivot: object, tip: object}[]}|null}
 */
function splitLayers(base, fill, rect, drawingBounds, hullBounds) {
  const { width, height, strokes } = base;
  const detected = detectPaddles(
    fill,
    strokes,
    width,
    height,
    drawingBounds,
    hullBounds
  );
  const { paddles } = detected;
  if (!paddles.length) return null;

  const cropW = rect.x1 - rect.x0 + 1;
  const cropH = rect.y1 - rect.y0 + 1;

  // Positions travel as fractions of the drawing, so the display can scale the
  // boat to any size and the oars stay where they were drawn.
  const relative = (point) => ({
    x: (point.x - rect.x0) / cropW,
    y: (point.y - rect.y0) / cropH,
  });

  // Two points per oar, and nothing else.
  //
  // No image of an oar is cut out, because none is needed: the oars are drawn
  // where the visitor drew them and they stay there. All the display wants is
  // where each blade meets the water, so it can throw a splash from it. With no
  // oar image in existence there is nothing that could be shown as a loose
  // piece, by this or by any later change.
  const measured = paddles.map((paddle) => ({
    pivot: relative(paddle.pivot),
    tip: relative(paddle.tip),
  }));

  if (!measured.length) return null;

  return { paddles: measured };
}

/**
 * The areas the visitor coloured in, and what colour each of them is.
 *
 * Colour is found by chroma rather than by darkness, the same test used
 * elsewhere: a pale yellow crayon and white paper are almost identical in
 * brightness and nothing alike in colour.
 *
 * The part that matters is what happens next. Raw, a coloured-in area is not a
 * region - it is thousands of specks of colour with paper between them, because
 * crayon sits on the tooth of the paper and misses the pits. Closing it -
 * growing the colour by a few pixels and then shrinking it back - swallows
 * those pits while leaving the outline of the area where the visitor put it.
 * The area then gets one colour, averaged over the pixels that actually had
 * colour in them, so the pits take the colour of the crayon around them
 * instead of staying bare.
 *
 * @returns {{mask: Uint8Array, region: Int32Array, colours: {r,g,b}[]}}
 *   mask   1 where a pixel belongs to a coloured-in area
 *   region which area, or -1
 *   colours the colour of each area
 */
function paintedRegions(page, width, height, bounds) {
  const { chromaThreshold } = EXTRACT.fill;
  const { closeRatio, minAreaRatio, hueBuckets } = EXTRACT.paint;

  const empty = {
    mask: new Uint8Array(width * height),
    region: new Int32Array(width * height).fill(-1),
    colours: [],
  };

  const radius = Math.max(1, Math.round(Math.min(width, height) * closeRatio));

  // Room for the closing to work in without the box edge eroding the result.
  const pad = radius + 2;
  const box = {
    minX: Math.max(0, bounds.minX - pad),
    minY: Math.max(0, bounds.minY - pad),
    maxX: Math.min(width - 1, bounds.maxX + pad),
    maxY: Math.min(height - 1, bounds.maxY + pad),
  };

  // Sorted by hue first. Two colours side by side are one connected patch of
  // colour, and closing them together would hand both the average of the two.
  const bucketOf = new Int16Array(width * height).fill(-1);
  const tally = new Array(hueBuckets).fill(0);
  const extent = new Array(hueBuckets).fill(null);

  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const i = y * width + x;
      const r = page.data[i * 4];
      const g = page.data[i * 4 + 1];
      const b = page.data[i * 4 + 2];

      if (Math.max(r, g, b) - Math.min(r, g, b) <= chromaThreshold) continue;

      const k = hueBucket(r, g, b, hueBuckets);
      bucketOf[i] = k;
      tally[k] += 1;
      extent[k] = extend(extent[k], x, y);
    }
  }

  const floor = width * height * minAreaRatio;
  const region = new Int32Array(width * height).fill(-1);
  const mask = new Uint8Array(width * height);
  const colours = [];

  for (let k = 0; k < hueBuckets; k += 1) {
    // Not enough of this hue anywhere on the page to be an area at all.
    if (tally[k] < floor) continue;

    // Confined to where this hue actually is. Closing the whole page once per
    // hue would be several times the work for pixels known to be blank, and
    // this runs while the visitor is standing there.
    const work = padBox(extent[k], radius + 2, width, height);

    const seed = new Uint8Array(width * height);
    for (let y = work.minY; y <= work.maxY; y += 1) {
      for (let x = work.minX; x <= work.maxX; x += 1) {
        const i = y * width + x;
        if (bucketOf[i] === k) seed[i] = 1;
      }
    }

    const closed = erode(dilate(seed, width, height, radius, work), width, height, radius, work);
    const { components, labels } = labelComponents(closed, width, height);

    components
      .filter((c) => c.area >= floor)
      .forEach((c) => {
        const index = colours.length;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        let claimed = 0;

        for (let y = c.minY; y <= c.maxY; y += 1) {
          for (let x = c.minX; x <= c.maxX; x += 1) {
            const i = y * width + x;
            if (labels[i] !== c.label) continue;

            // Where two hues overlap after closing, the first one keeps it.
            if (region[i] !== -1) continue;

            region[i] = index;
            mask[i] = 1;
            claimed += 1;

            // Averaged over the crayon only. Including the pits would drag
            // every colour towards the paper and come out washed out.
            if (bucketOf[i] === k) {
              r += page.data[i * 4];
              g += page.data[i * 4 + 1];
              b += page.data[i * 4 + 2];
              n += 1;
            }
          }
        }

        if (!claimed) return;

        // Averaged, then given its saturation back. Done once here rather than
        // per pixel: the area is one flat colour by this point, so there is one
        // conversion per area instead of a hundred thousand.
        colours.push(
          n
            ? vivid(Math.round(r / n), Math.round(g / n), Math.round(b / n))
            : { r: 0, g: 0, b: 0 }
        );
      });
  }

  if (!colours.length) return empty;

  // Enough passes to close a pit rather than only its rim. A hole wider than a
  // pixel fills from the outside in - the middle of a three-by-three gap has no
  // coloured neighbours at all on the first pass, four on the second, and only
  // joins on the third - so a fixed pass or two leaves a white speck sitting in
  // the middle of a coloured area, which is the one thing this exists to stop.
  //
  // Overshooting is free: the pass loop stops the moment nothing joins, and the
  // five-of-eight rule means open paper can never be joined at all, so this
  // converges on the pits and cannot spread past them.
  closeEdgePits(region, mask, colours.length, width, height, box, Math.max(8, radius));

  return { mask, region, colours };
}

/**
 * Pits the closing could not reach.
 *
 * Growing the colour and shrinking it back covers the pits in the middle of an
 * area, but one within a stroke's width of the edge gets uncovered again by the
 * shrink, and comes out as a speck of boat in the middle of the colour.
 *
 * A gap with colour on nearly every side belongs to that colour. The threshold
 * is what keeps this from running away: five of eight neighbours means it is
 * surrounded, and a pixel of open paper alongside the area has colour on three
 * sides at most, so the fill cannot escape across the page.
 */
function closeEdgePits(region, mask, count, width, height, box, rounds) {
  const votes = new Int32Array(count);

  for (let pass = 0; pass < rounds; pass += 1) {
    const joined = [];

    for (let y = Math.max(1, box.minY); y < Math.min(height - 1, box.maxY); y += 1) {
      for (let x = Math.max(1, box.minX); x < Math.min(width - 1, box.maxX); x += 1) {
        const i = y * width + x;
        if (region[i] !== -1) continue;

        let neighbours = 0;
        let best = -1;
        let bestVotes = 0;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (!dx && !dy) continue;

            const r = region[(y + dy) * width + (x + dx)];
            if (r === -1) continue;

            neighbours += 1;
            votes[r] += 1;
            if (votes[r] > bestVotes) {
              bestVotes = votes[r];
              best = r;
            }
          }
        }

        if (neighbours >= 5) joined.push(i, best);

        // Only the entries touched need clearing.
        if (neighbours) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (!dx && !dy) continue;
              const r = region[(y + dy) * width + (x + dx)];
              if (r !== -1) votes[r] = 0;
            }
          }
        }
      }
    }

    if (!joined.length) return;

    for (let j = 0; j < joined.length; j += 2) {
      region[joined[j]] = joined[j + 1];
      mask[joined[j]] = 1;
    }
  }
}

/**
 * Which hue a colour belongs to, as a bucket index.
 *
 * Hue rather than the raw channels, so that the same crayon pressed lightly
 * and heavily lands in one place. Only ever asked about pixels that already
 * have real colour in them, so the hue is meaningful.
 */
function hueBucket(r, g, b, buckets) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (!chroma) return 0;

  let hue;
  if (max === r) hue = (g - b) / chroma;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;

  hue = ((hue % 6) + 6) % 6; // 0..6, the six sectors of the colour wheel

  return Math.min(buckets - 1, Math.floor((hue / 6) * buckets));
}

function extend(bounds, x, y) {
  if (!bounds) return { minX: x, maxX: x, minY: y, maxY: y };

  if (x < bounds.minX) bounds.minX = x;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (y > bounds.maxY) bounds.maxY = y;

  return bounds;
}

function padBox(bounds, by, width, height) {
  return {
    minX: Math.max(0, bounds.minX - by),
    minY: Math.max(0, bounds.minY - by),
    maxX: Math.min(width - 1, bounds.maxX + by),
    maxY: Math.min(height - 1, bounds.maxY + by),
  };
}

/** Crop box for a set of bounds, with breathing room, clamped to the page. */
function cropRect(bounds, width, height) {
  const pad = Math.round(
    Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * EXTRACT.paddingRatio
  );

  return {
    x0: Math.max(0, bounds.minX - pad),
    y0: Math.max(0, bounds.minY - pad),
    x1: Math.min(width - 1, bounds.maxX + pad),
    y1: Math.min(height - 1, bounds.maxY + pad),
  };
}

/**
 * Keeps the single cluster of marks the visitor actually drew, and discards
 * anything stranded away from it - dust, smudges, a pen test in the margin.
 *
 * Grows outward from the largest component: the boat pulls in the name written
 * below it, the name pulls in the line below that, a stem pulls in its own
 * dot. Nothing that never joins the chain is drawn.
 *
 * Size is not used, deliberately. A speck of dust and the dot of an 'i' are
 * the same size, and a large smudge is still a smudge - the earlier size-based
 * version kept exactly those. Position is what actually separates them.
 */
function keepDrawingCluster(components, width, height) {
  const floor = Math.max(6, width * height * EXTRACT.minComponentRatio);
  const candidates = components.filter((c) => c.area >= floor);
  if (!candidates.length) return [];

  const reach = Math.hypot(width, height) * EXTRACT.clusterReachRatio;
  const sorted = [...candidates].sort((a, b) => b.area - a.area);

  const cluster = new Set([sorted[0]]);
  let changed = true;

  // Repeat until nothing new joins: a component that has just joined can bring
  // others within reach, which is what lets a chain of text lines hang
  // together.
  while (changed) {
    changed = false;

    for (const candidate of sorted) {
      if (cluster.has(candidate)) continue;

      for (const member of cluster) {
        if (boxDistance(boxOf(candidate), boxOf(member)) <= reach) {
          cluster.add(candidate);
          changed = true;
          break;
        }
      }
    }
  }

  return [...cluster];
}

/** 1 where the pixel belongs to a component we are keeping. */
function buildStrokeMask(labels, selected, width, height) {
  const strokes = new Uint8Array(width * height);

  for (let i = 0; i < strokes.length; i += 1) {
    if (selected.has(labels[i])) strokes[i] = 1;
  }

  return strokes;
}

/**
 * True if a component reaches the edge of the usable area.
 *
 * Everything the visitor drew sits comfortably inside the paper, because the
 * page was cropped inside the paper's edge before this ran. So anything
 * arriving at the boundary came from outside the sheet, not from the drawing.
 */
function touchesEdge(component, width, height, margin) {
  const slack = margin + EXTRACT.borderSlackPx;

  return (
    component.minX <= slack ||
    component.minY <= slack ||
    component.maxX >= width - 1 - slack ||
    component.maxY >= height - 1 - slack
  );
}

function largestOf(components) {
  return components.reduce((a, b) => (b.area > a.area ? b : a));
}

/**
 * What the visitor wrote or drew *on* the boat, as opposed to the boat itself.
 *
 * A mark that sits inside the boat's own extent without joining it is on the
 * boat rather than part of it - a name across the hull, a heart, a smiley
 * face. Anything drawn as part of the boat is continuous with it and comes
 * back as the same component; anything alongside it, like the name written
 * underneath, falls outside its box.
 *
 * Size is deliberately not the test. It was, in effect, and that is what went
 * wrong: a big letter or the ring of a smiley clears the bar that decides what
 * counts as the boat, and from there its middle gets filled in solid like a
 * compartment of the hull. A letter is a letter at any size.
 */
function selectWritingLabels(components) {
  if (components.length < 2) return new Set();

  const boat = largestOf(components);
  const hull = boxOf(boat);

  return new Set(
    components
      .filter((c) => c.label !== boat.label)
      .filter((c) => within(c, hull))
      .map((c) => c.label)
  );
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

/**
 * The components big enough to count as the boat rather than an annotation.
 *
 * Writing is excluded whatever its size: what this set decides is which marks
 * may enclose an area that then gets filled solid, and the inside of an O is
 * not a compartment of the boat.
 */
function selectHullLabels(components, writingLabels = new Set()) {
  const largest = largestOf(components);
  const threshold = largest.area * EXTRACT.fill.hullShareRatio;

  return new Set(
    components
      .filter((c) => !writingLabels.has(c.label))
      .filter((c) => c.area >= threshold)
      .map((c) => c.label)
  );
}

/**
 * Marks every pixel enclosed by the boat, so an outlined hull comes out solid
 * and every compartment inside it fills too.
 *
 * Works by flooding the *background* inward from the page border: anything the
 * flood cannot reach is walled in. Four-connectivity for the flood, so a
 * diagonal pencil line still counts as a seal.
 *
 * An enclosed area is then filled only if one of its walls is a hull-sized
 * component. That is what separates the gap between two thwarts - small, but
 * bounded by the hull - from the counter of an 'o', which is the same size but
 * bounded only by the letter itself. Judging the *hole* by its size cannot
 * tell those apart; judging its boundary can.
 *
 * Writing on the boat is handled apart from both. The area inside an O is
 * enclosed, and it is inside the boat, so leaving it out would punch a
 * see-through hole in the hull - but filling it with the boat's colour like a
 * compartment would blot the letter out. It is filled, so there is no hole,
 * and marked to be *preserved*: rendered from the photograph instead of
 * painted, so what shows through the letter is the paper that was behind it.
 *
 * @param {Uint8Array} strokes every kept component, boat and text alike
 * @param {Int32Array} labels component label per pixel
 * @param {Set<number>} hullLabels components counting as the boat
 * @param {Set<number>} writingLabels components written on the boat
 * @param {{minX:number,maxX:number,minY:number,maxY:number}} bounds hull extent
 * @returns {{fill: Uint8Array, filled: number, preserve: Uint8Array}}
 */
function fillEnclosedAreas(strokes, labels, hullLabels, writingLabels, bounds, width, height) {
  const outside = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;

  const push = (i) => {
    if (!strokes[i] && !outside[i]) {
      outside[i] = 1;
      stack[top++] = i;
    }
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    const y = (i - x) / width;

    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }

  // Safety valve. If the flood barely got anywhere, the page border is walled
  // off by ink and "enclosed" has stopped meaning anything - filling on that
  // basis would paint the whole sheet solid. Strokes only, and say so.
  let reached = 0;
  for (let i = 0; i < outside.length; i += 1) if (outside[i]) reached += 1;

  if (reached < outside.length * 0.05) {
    console.warn('[extract] page border is enclosed by ink; skipping the fill');
    return { fill: strokes.slice(), filled: 0, preserve: new Uint8Array(width * height) };
  }

  // Candidate holes: unreachable, not a stroke, and inside the hull's extent.
  const enclosed = new Uint8Array(width * height);

  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const i = y * width + x;
      if (!outside[i] && !strokes[i]) enclosed[i] = 1;
    }
  }

  const { labels: holeLabels } = labelComponents(enclosed, width, height);

  const fillable = holesTouchingHull(enclosed, holeLabels, strokes, labels, hullLabels, width, height);
  const inWriting = holesTouchingHull(enclosed, holeLabels, strokes, labels, writingLabels, width, height);

  const fill = new Uint8Array(width * height);
  const preserve = new Uint8Array(width * height);
  let filled = 0;

  for (let i = 0; i < fill.length; i += 1) {
    // A hole belongs to the letter that made it unless the boat is also one of
    // its walls - writing that touches the hull is not a counter, it is a
    // compartment, and it fills like one.
    const counter = enclosed[i] && inWriting.has(holeLabels[i]) && !fillable.has(holeLabels[i]);

    if (strokes[i]) {
      fill[i] = 1;
    } else if (enclosed[i] && (fillable.has(holeLabels[i]) || counter)) {
      fill[i] = 1;
      filled += 1;
    }

    if (counter) preserve[i] = 1;
  }

  // The writing itself, and a little of the paper around it.
  //
  // The ink is kept verbatim by renderLayer already; what it needed was
  // somewhere to be read against. Without this margin a letter is drawn in the
  // visitor's own pencil directly onto a hull filled with the average of that
  // same pencil, and disappears into it. The margin is what "the paper behind
  // it" means - the boat closes back up a few pixels out.
  const halo = Math.max(
    2,
    Math.round(Math.min(width, height) * EXTRACT.fill.writingHaloRatio)
  );
  const writingMask = buildStrokeMask(labels, writingLabels, width, height);
  const around = growBy(writingMask, width, height, halo);

  for (let i = 0; i < preserve.length; i += 1) if (around[i]) preserve[i] = 1;

  return { fill, filled, preserve };
}

/**
 * Which enclosed areas have one of the given components as a wall.
 *
 * "One of" rather than "most of" on purpose: a compartment between two thwarts
 * is bounded partly by the hull and partly by the thin seat strokes, and
 * requiring a majority would leave those gaps blank.
 *
 * Asked twice, with two different sets: once for the boat, to find the
 * compartments, and once for the writing, to find the insides of letters.
 */
function holesTouchingHull(enclosed, holeLabels, strokes, labels, hullLabels, width, height) {
  const fillable = new Set();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!enclosed[i] || fillable.has(holeLabels[i])) continue;

      // Any stroke pixel next door that belongs to the boat qualifies the
      // whole enclosed region.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const n = ny * width + nx;
          if (strokes[n] && hullLabels.has(labels[n])) {
            fillable.add(holeLabels[i]);
            dy = 2;
            break;
          }
        }
      }
    }
  }

  return fillable;
}

/** Gap between two boxes; 0 when they overlap. */
function boxDistance(a, b) {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

/**
 * True if a component lies entirely inside one of the four corner boxes.
 *
 * This is the backstop for a marker the crop in capture.js failed to remove.
 * The test is positional rather than shape-based on purpose: a whole marker is
 * square, but a sliver left by a slightly-too-tight crop is a thin strip, and
 * a squareness test would wave it through.
 *
 * "Entirely inside" matters - a boat drawn towards one corner still extends
 * out of the box and is kept.
 */
function isMarkerRemnant(c, width, height) {
  if (c.area / (width * height) < EXTRACT.markerRemnantMinAreaRatio) return false;

  const zoneX = width * EXTRACT.cornerZoneRatio;
  const zoneY = height * EXTRACT.cornerZoneRatio;

  const inCornerX = c.maxX < zoneX || c.minX > width - zoneX;
  const inCornerY = c.maxY < zoneY || c.minY > height - zoneY;

  return inCornerX && inCornerY;
}

function boxOf(c) {
  return { minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY };
}

function mergeBox(a, b) {
  return {
    minX: Math.min(a.minX, b.minX),
    maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function unionBounds(components) {
  return components.map(boxOf).reduce(mergeBox);
}

/**
 * Draws one layer into a cropped canvas.
 *
 * `fill` selects which pixels belong to this layer - all of the drawing for
 * the flat image, the hull alone, or a single oar. Every layer that shares a
 * `rect` comes out the same size and overlays exactly.
 *
 * Strokes and everything they enclose are fully opaque, so no blank gaps are
 * left inside the drawing. Only the fringe immediately outside the shape uses
 * a soft alpha, which keeps pencil edges from looking cut out.
 *
 * Nothing is ever subtracted or painted over here. A layer is only ever a
 * selection of pixels drawn as they were photographed.
 *
 * `preserve` marks the pixels that must come from the photograph even where
 * they would otherwise be painted with the boat's colour - the writing on the
 * hull, and the paper immediately around and inside it.
 */
function renderLayer({
  page, luma, strokes, fill, width, height, reference, rect, preserve, paint,
}) {
  const { x0, y0, x1, y1 } = rect;

  const outW = x1 - x0 + 1;
  const outH = y1 - y0 + 1;
  if (outW < 8 || outH < 8) return null;

  const out = new ImageData(outW, outH);
  const src = page.data;
  const dst = out.data;
  const softness = EXTRACT.softness;
  const { chromaThreshold, washMargin } = EXTRACT.fill;

  let inkPixels = 0;

  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const sx = x0 + x;
      const sy = y0 + y;
      const si = sy * width + sx;
      const di = (y * outW + x) * 4;

      if (fill[si]) {
        const r = src[si * 4];
        const g = src[si * 4 + 1];
        const b = src[si * 4 + 2];

        // Strokes always keep their own colour. Enclosed pixels keep theirs
        // too if the visitor coloured them in - detected by chroma, since pale
        // crayon and white paper differ in colour far more than in brightness.
        //
        // ...and so does anything marked to be preserved, blank or not. That
        // is what makes writing on the boat come out as written: the letters
        // in their own ink, on the paper they were written on.
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);

        // A coloured-in area comes out as one solid colour, across the whole of
        // it. Photographed crayon is never one colour - it is darker where the
        // hand pressed, lighter where it skipped, and bare paper in the pits of
        // the grain - and reproducing all that faithfully is what made a
        // filled-in boat look grubby rather than filled in. The visitor's
        // meaning was "this part is red", so it is that red throughout.
        const area = paint ? paint.region[si] : -1;
        const painted = area >= 0 ? paint.colours[area] : null;

        // A line drawn over the top still shows. Pencil and pen have almost no
        // chroma, so they are told from the crayon by colour rather than by
        // darkness - which matters, because a heavy crayon is darker than a
        // light pencil and darkness alone would keep the wrong one.
        const drawnOver = strokes[si] && chroma <= chromaThreshold;
        const keepOwn = (preserve && preserve[si]) || drawnOver;

        const own =
          keepOwn ||
          strokes[si] ||
          chroma > chromaThreshold ||
          luma[si] < reference[si] - washMargin;

        // Pencil rather than crayon: no colour to speak of, and darker than the
        // paper around it. That is the outline, and it is also the handwriting -
        // they are the same substance and want the same treatment.
        const isInk = chroma <= chromaThreshold && luma[si] < reference[si] - washMargin;

        if (!keepOwn && painted) {
          dst[di] = painted.r;
          dst[di + 1] = painted.g;
          dst[di + 2] = painted.b;
        } else if (own) {
          const ink = isInk ? deepen(r, g, b) : null;
          dst[di] = ink ? ink.r : r;
          dst[di + 1] = ink ? ink.g : g;
          dst[di + 2] = ink ? ink.b : b;
        } else {
          // Blank paper inside the hull - no stroke, no colour, no darker than
          // the sheet around it. It used to be filled with the average of the
          // boat's ink, which made a solid body of it, and made a dark one out
          // of empty white space the child never coloured in.
          //
          // It is paper, so it is shown as paper. Nothing on the wall is a
          // colour that was not on the page.
          dst[di] = r;
          dst[di + 1] = g;
          dst[di + 2] = b;
        }

        dst[di + 3] = 255;

        inkPixels += 1;
        continue;
      }

      // Outside the shape: taper the antialiased fringe rather than ending
      // abruptly. Anything further out stays fully transparent.
      if (!isNearFill(fill, sx, sy, width, height)) continue;

      // Solid at the local ink threshold, fading to nothing `softness` above it.
      const local = reference[si] - EXTRACT.ink.offset;
      const alpha = Math.max(0, Math.min(1, (local + softness - luma[si]) / softness));
      if (alpha <= 0.02) continue;

      // The soft edge of a stroke is still that stroke, so it is deepened with
      // it - otherwise every line would come out with a pale rim and the
      // outline would look softer after being sharpened.
      const edge = deepen(src[si * 4], src[si * 4 + 1], src[si * 4 + 2]);

      dst[di] = edge.r;
      dst[di + 1] = edge.g;
      dst[di + 2] = edge.b;
      dst[di + 3] = Math.round(alpha * 255);

      inkPixels += 1;
    }
  }

  const canvas = createCanvas(outW, outH);
  context2d(canvas).putImageData(out, 0, 0);

  return {
    canvas,
    bounds: { x: x0, y: y0, width: outW, height: outH },
    inkRatio: inkPixels / (outW * outH),
  };
}

/**
 * A mask grown outward by `radius`.
 *
 * Walked from the set pixels rather than swept over the page: writing is a
 * small part of a drawing, and this runs while the visitor is standing there.
 */
function growBy(mask, width, height, radius) {
  const out = mask.slice();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;

      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);

      for (let ny = y0; ny <= y1; ny += 1) {
        for (let nx = x0; nx <= x1; nx += 1) out[ny * width + nx] = 1;
      }
    }
  }

  return out;
}

/**
 * Gives a colour its saturation back, without changing which colour it is.
 *
 * Hue goes through untouched - the number that says "red" is carried across
 * exactly. What moves is saturation, and lightness only far enough to sit in a
 * band that reads on a wall. A crayon that photographed as a pale wash comes
 * out as the colour the visitor was reaching for.
 */
function vivid(r, g, b) {
  const { saturation, minSaturation, minLightness, maxLightness } = EXTRACT.boost;
  if (!saturation && !minSaturation) return { r, g, b };

  const [hue, sat, light] = toHsl(r, g, b);
  if (!sat) return { r, g, b }; // a grey has no colour to deepen

  const richer = Math.max(minSaturation, sat + (1 - sat) * saturation);
  const level = Math.min(maxLightness, Math.max(minLightness, light));

  return toRgb(hue, richer, level);
}

/**
 * Darkens ink, so an outline and a line of handwriting both carry.
 *
 * Pencil on white paper photographs grey. Deepening is only a change of
 * strength - no pixel moves, no stroke thickens, and the shape of every letter
 * and every line is exactly what was drawn. The floor stops a soft pencil
 * becoming a printed rule.
 */
/**
 * Corrects the scan against the one thing on the page whose colour is known.
 *
 * A kiosk camera under hall lighting does not photograph white paper as white.
 * On the scans this was built against it came out rgb(183, 187, 202): three
 * quarters of the brightness it should have, with a blue cast on top. Every
 * colour on that sheet is then wrong by the same amount, and a light green
 * pencil lands as a dark neutral - which the ink test, quite correctly by its
 * own rule, calls pencil rather than colour and renders as a grey stroke.
 *
 * So the paper is used as what it is: a reference white, lying in plain sight
 * on every page. Scaling each channel until the paper reads white puts the rest
 * of the sheet back where it belongs. That is a correction, not a preference -
 * no colour is chosen here, and a sheet photographed correctly is left alone.
 *
 * It cannot recover what was never recorded. A drawing lit so poorly that the
 * colour is gone from the file stays gone; this restores what the camera
 * flattened, not what it missed.
 */
function balanceToPaper(page) {
  const { enabled, target, percentile, maxGain } = EXTRACT.whiteBalance;
  if (!enabled) return null;

  // The bright end of each channel is the paper. Taken as a percentile rather
  // than a maximum, so one specular glare off a biro line cannot define it.
  const white = [0, 1, 2].map((channel) => brightEnd(page.data, channel, percentile));
  const gain = white.map((value) => (value > 0 ? Math.min(maxGain, target / value) : 1));

  // Already white. A scan that needs nothing is given nothing.
  if (gain.every((g) => g > 0.98 && g < 1.02)) return null;

  const data = page.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] *= gain[0];
    data[i + 1] *= gain[1];
    data[i + 2] *= gain[2];
  }

  return { white, gain };
}

/** Where the brightest q of a channel begins. */
function brightEnd(data, channel, q) {
  const histogram = new Uint32Array(256);
  let count = 0;

  for (let i = channel; i < data.length; i += 4) {
    histogram[data[i]] += 1;
    count += 1;
  }

  let seen = 0;
  for (let value = 255; value >= 0; value -= 1) {
    seen += histogram[value];
    if (seen >= count * (1 - q)) return value;
  }

  return 255;
}

function deepen(r, g, b) {
  const { inkDepth, inkFloor } = EXTRACT.boost;
  if (!inkDepth) return { r, g, b };

  const [hue, sat, light] = toHsl(r, g, b);

  // Never lighter than it was drawn. The floor exists to stop a soft pencil
  // being crushed to a printed rule, so it has no business raising ink that was
  // already darker than it - black ink is meant to stay black.
  const darker = Math.min(light, Math.max(inkFloor, light * (1 - inkDepth)));

  return toRgb(hue, sat, darker);
}

function toHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const light = (max + min) / 2;
  const chroma = max - min;

  if (!chroma) return [0, 0, light];

  const sat = light > 0.5 ? chroma / (2 - max - min) : chroma / (max + min);

  let hue;
  if (max === rn) hue = (gn - bn) / chroma + (gn < bn ? 6 : 0);
  else if (max === gn) hue = (bn - rn) / chroma + 2;
  else hue = (rn - gn) / chroma + 4;

  return [hue / 6, sat, light];
}

function toRgb(hue, sat, light) {
  if (!sat) {
    const flat = Math.round(light * 255);
    return { r: flat, g: flat, b: flat };
  }

  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;

  return {
    r: Math.round(channel(p, q, hue + 1 / 3) * 255),
    g: Math.round(channel(p, q, hue) * 255),
    b: Math.round(channel(p, q, hue - 1 / 3) * 255),
  };
}

function channel(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;

  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

/** True if any of the 8 neighbours is part of the filled shape. */
function isNearFill(fill, x, y, width, height) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (fill[ny * width + nx]) return true;
    }
  }
  return false;
}
