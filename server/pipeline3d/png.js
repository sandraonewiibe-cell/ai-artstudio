/**
 * Just enough PNG: how big is it, does it carry alpha, and what are its pixels.
 *
 * Written out rather than vendored. A PNG from a canvas is a zlib stream of
 * filtered scanlines, zlib is in Node already, and the whole decoder is the
 * hundred lines below - against a dependency that would arrive with a hundred
 * files to cover formats this pipeline will never be handed.
 *
 * Interlaced images are refused rather than guessed at. Every drawing here
 * comes from canvas.toBlob, which does not interlace, and a half-right Adam7
 * pass would corrupt a silhouette quietly instead of loudly.
 */

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// How many samples per pixel each colour type carries.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

// PNG colour types that carry alpha: 4 is grey+alpha, 6 is RGB+alpha.
const WITH_ALPHA = [4, 6];

/**
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, hasAlpha: boolean, bitDepth: number}}
 */
function readHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) {
    throw new Error('Not a PNG: too short to hold a header.');
  }

  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('Not a PNG: the signature does not match.');
  }

  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Not a PNG: the first chunk is not IHDR.');
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colourType = buffer[25];

  if (!width || !height) throw new Error('PNG header gives the image no size.');

  return {
    width,
    height,
    bitDepth,
    // A palette image can carry transparency in a tRNS chunk rather than in its
    // colour type, so that counts too.
    hasAlpha: WITH_ALPHA.includes(colourType) || hasTransparencyChunk(buffer),
  };
}

/** Whether a tRNS chunk is present, which is how paletted PNGs carry alpha. */
function hasTransparencyChunk(buffer) {
  let at = 8;

  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);

    if (type === 'tRNS') return true;
    if (type === 'IDAT' || type === 'IEND') return false; // past the header block

    at += 12 + length;
  }

  return false;
}

/**
 * The pixels, as straight RGBA.
 *
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
function decode(buffer) {
  const { width, height, bitDepth } = readHeader(buffer);
  const colourType = buffer[25];
  const interlaced = buffer[28];

  if (bitDepth !== 8) {
    throw new Error(`This PNG is ${bitDepth} bits per sample; only 8 is supported.`);
  }

  if (interlaced) {
    throw new Error('This PNG is interlaced, which is not supported.');
  }

  const channels = CHANNELS[colourType];
  if (!channels) {
    throw new Error(`PNG colour type ${colourType} is not supported (palettes are not decoded).`);
  }

  const raw = zlib.inflateSync(Buffer.concat(collect(buffer, 'IDAT')));
  const stride = width * channels;

  if (raw.length < (stride + 1) * height) {
    throw new Error('PNG data is shorter than its header says it should be.');
  }

  // Undo the per-scanline filter. Each line names its own filter and is
  // predicted from the pixel to its left and the line above, so this has to run
  // in order and in place.
  const line = Buffer.alloc(stride);
  let previous = Buffer.alloc(stride);
  const out = new Uint8ClampedArray(width * height * 4);
  let at = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    raw.copy(line, 0, at, at + stride);
    at += stride;

    unfilter(line, previous, filter, channels, stride);

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;

      if (channels >= 3) {
        out[to] = line[from];
        out[to + 1] = line[from + 1];
        out[to + 2] = line[from + 2];
        out[to + 3] = channels === 4 ? line[from + 3] : 255;
      } else {
        // Greyscale, with or without alpha.
        out[to] = line[from];
        out[to + 1] = line[from];
        out[to + 2] = line[from];
        out[to + 3] = channels === 2 ? line[from + 1] : 255;
      }
    }

    previous = Buffer.from(line);
  }

  return { width, height, data: out };
}

/** Every chunk of a type, in order. IDAT is routinely split across several. */
function collect(buffer, want) {
  const found = [];
  let at = 8;

  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);

    if (type === want) found.push(buffer.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;

    at += 12 + length;
  }

  if (!found.length) throw new Error(`This PNG has no ${want} data.`);

  return found;
}

/** One scanline, in place. */
function unfilter(line, previous, filter, channels, stride) {
  if (filter === 0) return;

  for (let i = 0; i < stride; i += 1) {
    const a = i >= channels ? line[i - channels] : 0; // the pixel to the left
    const b = previous[i]; // the pixel above
    const c = i >= channels ? previous[i - channels] : 0; // above-left

    switch (filter) {
      case 1: line[i] = (line[i] + a) & 0xff; break;
      case 2: line[i] = (line[i] + b) & 0xff; break;
      case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
      case 4: {
        // Paeth: whichever of left, above and above-left the gradient is nearest.
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        break;
      }
      default:
        throw new Error(`PNG scanline filter ${filter} is not one of the five in the spec.`);
    }
  }
}

/**
 * RGBA back to a PNG.
 *
 * No filtering - every scanline is written raw and left to zlib. A filter would
 * compress a photograph better, and this is a drawing on transparent ground:
 * mostly identical pixels, which deflate handles well on its own. Simpler code
 * for a few percent of a file nobody pays for twice.
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray} rgba
 * @returns {Buffer}
 */
function encode(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let i = 0; i < stride; i += 1) {
      raw[y * (stride + 1) + 1 + i] = rgba[y * stride + i];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // not interlaced

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One PNG chunk: length, type, body, CRC. */
function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), body])), body.length + 8);
  return out;
}

let CRC_TABLE = null;

function crc(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }

  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) | 0;
}

module.exports = { readHeader, decode, encode };
