/**
 * Stage 5 - texture mapping.
 *
 * The child's drawing is the texture. Not a colour sampled from it, not a
 * palette built out of it, not a repaint of it at a size that suited the mesh -
 * the scan itself, byte for byte, with its strokes and its grain and its
 * handwriting still in it.
 *
 * Which makes this stage short, and that is the point. Every plausible thing it
 * could do instead - resample to a power of two, recompress smaller, flatten
 * the alpha onto white - would lose something of the drawing, and the pipeline
 * is not allowed to lose anything of the drawing. So it takes the artwork,
 * describes it, and hands it on. contract.js checks the buffer that comes out
 * is the buffer that went in.
 *
 * Fitting the texture to the geometry is the mesh's job, through its UVs, and
 * belongs there: the mesh knows which pixel of the drawing each vertex came
 * from, and inverting that here would be the same knowledge kept twice.
 *
 * Alpha is left unpremultiplied. glTF wants straight alpha, and the renderer
 * discards fragments below the silhouette rather than blending them, so
 * premultiplying would darken the edge of every stroke for nothing.
 */
module.exports = {
  name: 'texture',
  takes: 'Artwork',
  gives: 'Texture',

  /**
   * @param {import('../contract').Artwork} artwork
   * @param {import('../contract').Context} context
   * @returns {Promise<import('../contract').Texture|null>}
   */
  async run(artwork, context) {
    if (!context.texture) {
      context.log('a textured model was not asked for');
      return null;
    }

    context.log(`the drawing itself, ${artwork.width}x${artwork.height}, ${Math.round(artwork.buffer.length / 1024)}KB`);

    return {
      buffer: artwork.buffer,
      mime: artwork.mime,
      width: artwork.width,
      height: artwork.height,
      premultiplied: false,
    };
  },
};
