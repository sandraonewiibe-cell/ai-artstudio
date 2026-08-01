const config = require('../../config');
const { readHeader, decode, encode } = require('../png');

/**
 * Stage 1 - background removal.
 *
 * The table, the shadow under the paper and the edge of the sheet are not the
 * drawing. Most of that is already gone by the time the server sees the image:
 * the scanner extracts in the browser, because the kiosk has to put a boat on
 * the wall in the time a child takes to look up and a round trip first would be
 * felt in the room.
 *
 * What is left over is what this stage removes, and it is worth naming exactly,
 * because "clean it up" is otherwise an invitation to start deleting drawings.
 * Measured across the scans on disk, two things survive extraction:
 *
 *   - the printed corner markers. Three near-identical dark blocks of about
 *     147x105 pixels sitting in three corners of a 1080x744 page, together an
 *     eighth of everything opaque in the image. The scanner already discards a
 *     component that lies wholly inside its corner zone; these overshoot it by
 *     twenty pixels or so and come through.
 *   - specks. Dust and sensor grain that survived as their own tiny pieces.
 *
 * Nothing else was found, so nothing else is removed. There is no fold remover
 * here and no border remover: the adaptive threshold upstream already judges ink
 * against the paper immediately around it, which is what a fold's soft shadow
 * fails, and no piece in any scan on disk reaches the image border. Writing
 * either would be writing a filter against a fault nobody has seen, and the way
 * to lose a child's drawing is to remove something for a reason that was never
 * checked.
 *
 * Only alpha is touched. A pixel is either part of the drawing or it is not, and
 * nothing here rewrites a colour - white paper inside the hull is as much the
 * drawing as the outline round it, and stays exactly as it was.
 */
module.exports = {
  name: 'background',
  takes: 'Sheet',
  gives: 'Cutout',

  /**
   * @param {import('../contract').Sheet} sheet
   * @param {import('../contract').Context} context
   * @returns {Promise<import('../contract').Cutout|null>}
   */
  async run(sheet, context) {
    if (!sheet || !Buffer.isBuffer(sheet.drawing) || !sheet.drawing.length) {
      context.log('no extracted drawing came with the scan');
      return null;
    }

    const header = readHeader(sheet.drawing);

    // Whether a silhouette came with it is recorded rather than insisted on.
    //
    // Alpha is what marks where the drawing ends, and the stages that build
    // geometry cannot work without it - a drawing on an opaque white rectangle
    // would model the rectangle. But this stage is not the only customer. A
    // plugin sending the image to an image-to-3D service does not need alpha,
    // and a session that produced no separate extraction falls back to the
    // photograph of the page, which never has any. Refusing here would take
    // both of those paths down for a requirement that is not theirs.
    if (!header.hasAlpha) {
      context.log(`${header.width}x${header.height}, NO alpha - nothing marks where the drawing ends`);

      return {
        buffer: sheet.drawing,
        mime: sheet.mime || 'image/png',
        width: header.width,
        height: header.height,
        hasAlpha: false,
      };
    }

    const image = decode(sheet.drawing);
    await new Promise((resolve) => setImmediate(resolve));

    const swept = sweep(image, config.cleanup);

    if (!swept.removed) {
      // Nothing to take out, so nothing is re-encoded. The drawing carries on as
      // the exact bytes that came off the scanner.
      context.log(`${header.width}x${header.height}, silhouette in alpha, nothing to remove`);

      return {
        buffer: sheet.drawing,
        mime: sheet.mime || 'image/png',
        width: header.width,
        height: header.height,
        hasAlpha: true,
        pixels: image.data,
      };
    }

    await new Promise((resolve) => setImmediate(resolve));
    const buffer = encode(image.width, image.height, image.data);

    context.log(
      `${header.width}x${header.height}, removed ${swept.corners} corner marker${swept.corners === 1 ? '' : 's'} ` +
        `and ${swept.specks} speck${swept.specks === 1 ? '' : 's'} - ` +
        `${((swept.removed / swept.opaque) * 100).toFixed(1)}% of what was opaque`
    );

    return {
      buffer,
      mime: 'image/png',
      width: image.width,
      height: image.height,
      hasAlpha: true,
      pixels: image.data,
    };
  },
};

/**
 * Clears the pieces that are not the drawing.
 *
 * Works on the decoded pixels in place, and only on their alpha.
 */
function sweep(image, settings) {
  const { width, height, data } = image;
  const { alphaThreshold, cornerRatio, minAreaRatio } = settings;

  const solid = new Uint8Array(width * height);
  let opaque = 0;

  for (let i = 0; i < width * height; i += 1) {
    if (data[i * 4 + 3] >= alphaThreshold) {
      solid[i] = 1;
      opaque += 1;
    }
  }

  if (!opaque) return { removed: 0, opaque: 0, corners: 0, specks: 0 };

  const cornerW = width * cornerRatio;
  const cornerH = height * cornerRatio;
  const floor = width * height * minAreaRatio;

  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);

  let removed = 0;
  let corners = 0;
  let specks = 0;

  // Every piece is found first, then judged, so that the largest can be spared
  // whatever else is true of it. A child who draws small, in a corner, has drawn
  // a picture that is wholly inside a corner - and losing the whole drawing to a
  // rule about corners is the one failure this must not have.
  const pieces = [];
  let largest = 0;

  for (let start = 0; start < solid.length; start += 1) {
    if (!solid[start] || seen[start]) continue;

    // One piece, and where it sits.
    let top = 0;
    stack[top] = start;
    top += 1;
    seen[start] = 1;

    const piece = [];
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    while (top > 0) {
      top -= 1;
      const i = stack[top];
      const x = i % width;
      const y = (i - x) / width;

      piece.push(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }

    function push(j) {
      if (!solid[j] || seen[j]) return;
      seen[j] = 1;
      stack[top] = j;
      top += 1;
    }

    // In a corner of the page, and wholly so. A drawing that merely reaches
    // towards a corner has a bounding box that leaves it again.
    const inCorner =
      (maxX < cornerW || minX > width - cornerW) && (maxY < cornerH || minY > height - cornerH);

    pieces.push({ piece, inCorner, speck: piece.length < floor });
    if (piece.length > largest) largest = piece.length;
  }

  for (const entry of pieces) {
    if (!entry.inCorner && !entry.speck) continue;

    // The biggest thing in the picture is the picture.
    if (entry.piece.length === largest) continue;

    for (const i of entry.piece) data[i * 4 + 3] = 0;

    removed += entry.piece.length;
    if (entry.inCorner) corners += 1;
    else specks += 1;
  }

  return { removed, opaque, corners, specks };
}
