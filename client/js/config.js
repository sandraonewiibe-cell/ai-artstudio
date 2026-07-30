/**
 * Tunable constants. These are the knobs worth adjusting on site once the
 * camera, table and lighting are fixed - everything else can stay untouched.
 */

export const DETECTION = {
  /**
   * How the sheet is found.
   *
   * 'paper'   - a plain white sheet against a darker surface. Nothing to print;
   *             the contrast between paper and table is the boundary. Needs a
   *             dark mat, cloth or wooden table under the sheet.
   * 'markers' - the printed template with a QR block at each corner. Works on
   *             any surface including a white table, and corrects perspective
   *             from four exactly-known points.
   */
  mode: 'paper',

  // Frames are analysed at this width; detection does not need full resolution.
  sampleWidth: 192,

  // How long the sheet must hold still before capture. The main dial for how
  // responsive the kiosk feels.
  //
  // It can be this short because the markers do most of the guarding: a hand
  // resting on the sheet almost always covers one of the four corners, and
  // with a marker missing nothing fires at all. The timer is really only
  // waiting out the wobble as the sheet is set down. Raise it if hands are
  // getting into shots.
  stableMs: 300,

  // Per-pixel motion below which the scene counts as "still", after the global
  // brightness shift has been removed - see motionBetween() in imaging.js.
  motionThreshold: 3.2,

  // Corner drift allowed between frames, in sampled pixels.
  cornerJitter: 3.0,

  // Re-arming: the markers must be absent for this many consecutive frames
  // before another capture can happen. This is what stops one visitor's sheet
  // from triggering repeatedly.
  removalFrames: 6,

  // Quiet period after the sheet leaves, before scanning re-arms.
  cooldownMs: 700,

  // Analysis rate. 25fps: the interval is dead time on top of every capture,
  // so it wants to stay well under the stability window.
  analyseIntervalMs: 40,
};

/**
 * The sheet is located by the four QR blocks printed at its corners, not by
 * its brightness. That makes detection independent of the table surface - a
 * white sheet on a white table works fine.
 *
 * Only the markers' positions are used; the codes are never decoded.
 */
export const MARKERS = {
  // Marker size as a fraction of the sampled frame area.
  minAreaRatio: 0.0006,
  maxAreaRatio: 0.06,

  // A marker is roughly square and mostly dark once the frame is downscaled -
  // the QR pattern averages into a near-solid block at analysis resolution, so
  // the fill range has to reach 1.0. Squareness and corner position do the
  // real discriminating; a drawn line or a wide blob fails the skew test.
  minFill: 0.28,
  maxFill: 1,
  maxAspectSkew: 1.8,

  // The four marker centres must span at least this fraction of the frame,
  // otherwise we are looking at four small dark specks somewhere.
  minSpanRatio: 0.3,

  // How far past half a marker the exclusion zone reaches. The rectified page
  // corners sit exactly on the marker centres, so half a marker pokes into the
  // page; 1.6 removes that half plus 60% again for registration marks and
  // print drift.
  maskScale: 1.6,

  // Extra clearance beyond the exclusion zone when cropping, as a fraction of
  // the rectified page. Raise it if marker edges survive the crop.
  cropGapRatio: 0.015,

  // The corners are painted out *before* cropping, over an area this much
  // larger than the crop inset. If the measured marker size is an
  // underestimate and the crop falls short, the paint has still covered it.
  maskOverscan: 1.35,
};

export const PAGE = {
  // Longest edge of the rectified drawing area, in pixels. The other edge
  // follows the sheet's own proportions as measured from the markers.
  longEdge: 1200,
};

export const EXTRACT = {
  // Ignore this fraction of the page edge, where the warp leaves artefacts.
  marginRatio: 0.02,

  // Ink reaching this close to the edge of the usable area is not part of the
  // drawing - it is the table showing past the paper, the paper's own edge, or
  // the shadow it casts. All of those arrive as one long dark band.
  //
  // Dropping them matters more than it looks: such a band rings the page, and a
  // ring blocks the flood that finds enclosed areas, which used to make the
  // *entire sheet* read as enclosed and fill solid.
  // Kept at 1: ink sitting exactly on the clipped boundary was cut off by the
  // margin, so it came from outside the sheet. Anything more starts throwing
  // away drawings that merely reach towards the edge.
  borderSlackPx: 1,

  // Absolute noise floor - below this a component is sensor grain, nothing more.
  // Deliberately low, because the dot of an 'i' and the tail of a 't' are tiny
  // and dropping them mangles handwriting.
  minComponentRatio: 0.000008,

  // What the visitor drew forms one cluster: the boat, the name beneath it, a
  // second line beneath that. Starting from the largest component, anything
  // within this fraction of the page diagonal joins, then anything within
  // reach of *that*, and so on. Whatever never joins is dust.
  //
  // Size is no use here - a speck of dust and the dot of an 'i' are the same
  // size, and a big smudge is still dust. Position is what separates them: the
  // dot has a stem beneath it and the name has the boat above it, while dust
  // sits on its own in the margin.
  clusterReachRatio: 0.12,

  // Last line of defence against a marker surviving the crop: any component
  // lying *entirely* inside one of these corner boxes is discarded.
  //
  // Position rather than shape, deliberately. A whole marker is square, but a
  // sliver of one that survives a slightly-too-tight crop is a thin strip, and
  // a shape test would let it through. The trade-off is that a visitor who
  // writes something wholly inside a corner box loses it - keep the zone small.
  cornerZoneRatio: 0.14,
  markerRemnantMinAreaRatio: 0.00015,

  // Padding around the extracted drawing, as a fraction of its longest edge.
  paddingRatio: 0.04,

  /**
   * Telling ink from paper.
   *
   * Judged locally: a pixel is ink if it is darker than the paper immediately
   * around it. A single threshold for the whole page only works under even
   * light - beyond that it starts thresholding the lighting instead of the ink,
   * which either turns half the sheet into "drawing" or loses a pale pencil
   * completely.
   */
  ink: {
    // Neighbourhood radius, as a fraction of the page's shorter side. Wider
    // than any stroke, narrower than the lighting varies over.
    radiusRatio: 0.05,

    // How much darker than its surroundings a pixel must be. Low enough for
    // pencil, high enough to ignore paper texture and print screening.
    offset: 11,

    // Below this much ink the page is blank and there is nothing to extract.
    minRatio: 0.0004,
  },

  // Ink at the local threshold is solid; the `softness` band above it fades to
  // transparent, which keeps pencil edges from looking cut out.
  softness: 45,

  // Areas enclosed by the boat are filled in, so an outlined hull shows as a
  // solid shape rather than a ring around a transparent hole.
  fill: {
    // An enclosed pixel with this much colour in it is the visitor's own
    // shading and is kept as-is. Chroma rather than brightness, because a pale
    // yellow crayon and white paper are almost the same brightness.
    chromaThreshold: 22,

    // ...as is anything this much darker than the paper around it, which
    // catches a grey wash too faint to count as ink.
    //
    // Measured against the local paper level, not the ink threshold. Those are
    // only `ink.offset` apart, so a margin wider than that would call clean
    // paper "coloured" and leave the inside of an outlined boat unfilled.
    washMargin: 6,

    // Everything else enclosed is blank paper, and takes the drawing's own
    // average ink colour.
    useMeanInk: true,

    // What decides whether an enclosed area gets filled: who encloses it.
    //
    // An area is filled when a component this large - measured against the
    // biggest component in the drawing - forms part of its boundary. The hull
    // qualifies, so every compartment inside the boat fills however small it
    // is, right down to the gaps between the thwarts. A letter is far below
    // the bar, so the counters of O, A, B, e and o stay open.
    //
    // Size of the *hole* is deliberately not used. A compartment between two
    // seats and the counter of an 'o' are the same size, so judging the hole
    // either blanks out the boat or blacks out the name. Judging the boundary
    // separates them cleanly.
    hullShareRatio: 0.15,

    /**
     * How wide a break in an outline still counts as a wall, as a fraction of
     * the page's shorter side.
     *
     * A pencil line photographed on rough paper comes and goes, and a single
     * missing pixel is a doorway: the flood that finds enclosed areas walks
     * straight through it and decides the boat is not enclosed at all, so the
     * hull never fills and arrives as a bare outline.
     *
     * The gap is bridged for the flood only. What actually gets drawn is still
     * decided by the strokes the visitor made, so this closes the doorway
     * without thickening a single line.
     */
    sealGapRatio: 0.002,

    /**
     * Paper kept around writing drawn on the boat, as a fraction of the page's
     * shorter side.
     *
     * A name or a smiley on the hull is written in the same pencil the boat is
     * drawn in, and the hull is filled with the average of that pencil - so
     * without a margin the writing is the exact colour of the surface under it
     * and cannot be read at all. This is how much of the original paper stays
     * around each mark for it to be read against.
     *
     * Small on purpose: enough to separate the letters from the fill, not so
     * much that the boat looks like it has a hole cut in it. Raise it if
     * writing is still hard to read on the wall; lower it if the patches show.
     */
    writingHaloRatio: 0.006,
  },

  /**
   * Areas the visitor coloured in.
   *
   * Crayon and felt-tip do not cover paper evenly. Photographed, a coloured-in
   * hull is not a block of colour but colour with the paper showing through it
   * everywhere - and every one of those specks used to come out as bare boat,
   * so a carefully filled-in boat arrived on the wall looking moth-eaten.
   *
   * The colour is found first, then closed up: the gaps between the strokes are
   * treated as part of what was coloured, and take that area's own colour. What
   * the visitor meant by colouring it in is that the whole area is that colour.
   */
  paint: {
    // How wide a gap in the colour counts as the visitor's hand rather than
    // their intention, as a fraction of the page's shorter side. Wider than the
    // paper showing through a crayon stroke, narrower than a deliberate gap
    // between two differently coloured areas.
    closeRatio: 0.004,

    // Below this share of the page, a patch of colour is a stray mark rather
    // than an area that was coloured in, and is left exactly as it is.
    minAreaRatio: 0.0004,

    /**
     * How many hues are told apart.
     *
     * Areas are found per hue rather than by shape alone. A red hull coloured
     * right up against a blue sail is one connected patch of colour, and
     * averaging it would give both of them the same muddy purple; split by hue
     * first, they are two areas and each keeps its own colour.
     *
     * 12 buckets is 30 degrees each - wide enough that one crayon stays in one
     * bucket as its pressure varies, narrow enough to separate colours anyone
     * would call different. Raise it to tell closer colours apart, at the cost
     * of one crayon sometimes splitting across two buckets (harmless: both
     * halves come out very nearly the same colour).
     */
    hueBuckets: 12,
  },
};

/**
 * Finishing the extracted drawing before it goes to the wall.
 *
 * Everything here is arithmetic over the pixels that were already extracted -
 * no service, no model, no network. That is not a shortcut, it is the only way
 * to meet the brief: a generative model cannot be told to leave a silhouette
 * alone, and a kiosk cannot wait seconds per visitor. This runs in single-digit
 * milliseconds and the boat that comes out is the boat that went in.
 *
 * Set `enabled: false` to send the extraction through untouched.
 */
export const ENHANCE = {
  enabled: true,

  /**
   * Tidying the line work.
   *
   * A pencil line photographed at an angle is ragged and comes and goes. These
   * are all deliberately one or two pixels: enough to mend a stroke that broke
   * over the grain of the paper, not enough to move anything the visitor drew.
   */
  line: {
    // Islands smaller than this are camera grain that survived extraction.
    despeckleArea: 10,

    // Gaps up to twice this close up. 1 mends a broken stroke; 3 starts
    // welding together things that were drawn apart.
    closeRadius: 1,

    // Soften the stair-stepping along edges. Alpha only, and only in the one
    // pixel band where the shape meets the paper.
    smoothEdges: true,

    /**
     * How far a notch may be filled in from the drawing's mirror image.
     *
     * This is the "improve symmetry slightly" dial, and it is small on purpose,
     * because symmetry *is* silhouette - the two cannot both be left alone.
     * A pixel is only added where the mirror has ink AND there is already ink
     * within this many pixels, so it closes a nick in a gunwale and can never
     * grow a second bow. Nothing is ever removed to make the boat symmetric.
     *
     * 0 turns it off entirely.
     */
    symmetryReach: 2,
  },

  /**
   * Making the visitor's own colours read on a wall.
   *
   * Hue is never touched - not shifted, not averaged, not replaced. What
   * changes is only how much of it there is: a pale, patchy, half-finished
   * crayon becomes the same colour laid down properly.
   */
  colour: {
    // How much of the way to full saturation a colour is pushed.
    saturationBoost: 0.38,

    // ...and a floor, so a nearly grey wash still arrives as a colour.
    minSaturation: 0.3,

    // Lightness is pulled into this band. Outside it, colour on a big screen
    // reads as either white or black rather than as paint.
    minLightness: 0.3,
    maxLightness: 0.62,
  },

  /**
   * Wood, light and depth.
   *
   * The grain field is built once, on the first visitor, and reused by every
   * visitor after - it is the one part of this that is worth caching, and it
   * costs nothing to keep.
   */
  material: {
    // Depth of the grain, as a share of lightness. Subtle: this is a boat with
    // a grain, not a plank.
    grainStrength: 0.11,

    // Grain runs along the hull: stretched hard across x, tight down y.
    grainScaleX: 0.011,
    grainScaleY: 0.2,

    // Size of the cached noise field, in cells.
    grainField: 256,

    // Light from above. The top of the hull catches it, the bottom falls away.
    lightTop: 1.13,
    lightBottom: 0.85,

    // Inner shadow: how far in from the edge it reaches, in pixels, and how
    // dark it gets there. This is what stops the boat reading as a flat
    // sticker cut out of the background.
    shadowDepth: 7,
    shadowStrength: 0.28,
  },
};

export const DISPLAY = {
  // How long the boat crosses the display wall.
  holdMs: 15000,

  // How much of that crossing is recorded for the visitor to take away.
  //
  // Kept shorter than the crossing on purpose: a clip this length is quick to
  // upload, quick to download over exhibition wifi, and easy to share. The
  // recording starts as the boat sails in from the left and ends with it near
  // the middle of the screen, so it reads as a complete little scene.
  //
  // Clamped to holdMs at runtime. Set it equal to holdMs to capture the whole
  // crossing instead.
  recordMs: 8000,

  // How long the scanner shows "your boat is sailing" before re-arming.
  sentMs: 4000,

  // How long the "that wasn't a boat" message is shown.
  rejectMs: 4500,

  // How long an error is shown before returning to camera.
  errorMs: 5000,
};

/**
 * Finding a plain white sheet against a darker surface - `mode: 'paper'`.
 *
 * The sheet is the brightest large thing in frame, so what defines its edges is
 * whatever it is lying on. **A dark mat, cloth or wooden table is required.** On
 * a white or pale table the paper does not separate from the background and
 * nothing will be detected - that is the one real cost of not printing markers.
 */
export const PAPER = {
  // Fraction of the frame the sheet must cover to count as present.
  minCoverage: 0.15,
  maxCoverage: 0.9,

  // The sheet's edges must all be inside the frame, with at least this much
  // clear on every side.
  //
  // This is what stops the whole camera view being mistaken for the sheet. On a
  // pale table the only dark thing in shot is the drawing itself, so the bright
  // region becomes the entire frame - and without this check it would be
  // "detected" and cropped as if it were the paper. If the edges are not
  // visible the paper genuinely cannot be located, and declining is correct.
  minFrameMargin: 0.02,

  // Minimum brightness gap between the sheet and what is under it. This is the
  // check that fails on a white table, and the number to look at first if
  // detection never fires.
  minContrast: 30,

  // The bright region must fill this much of its own bounding quad, which is
  // what separates a rectangular sheet from an arbitrary bright blob - a hand,
  // a reflection, a patch of glare.
  minQuadFill: 0.6,

  // Opposite edges of a rectangle stay comparable under perspective.
  minEdgeRatio: 0.55,

  // Trimmed off each edge of the rectified page, as a fraction of it. Enough to
  // lose the paper's own edge, the shadow it casts and any curl at the corners.
  // Anything darker that still gets through is caught by the edge-touching
  // check in extract.js, so this only has to be roughly right.
  cropInsetRatio: 0.05,
};

/**
 * Finding the oars in a drawing, so each one can be rowed separately.
 *
 * Most people draw oars as one continuous stroke touching the hull, so they
 * merge into the hull's connected component and cannot be separated by
 * labelling. The way through is a morphological opening: eroding then dilating
 * the *filled* shape rubs out anything thinner than the brush and leaves the
 * solid body. Whatever the filled shape has that the opened one does not is a
 * thin appendage - an oar, a mast, a flag.
 *
 * Appendages are then judged on elongation and length. Nothing is animated
 * unless it looks like an oar, so a drawing without any behaves exactly as
 * before.
 */
export const PADDLES = {
  // Structuring element, as a fraction of the drawing's shorter side. Must be
  // wider than an oar stroke and narrower than the hull.
  openRadiusRatio: 0.007,

  // How much longer than wide an appendage must be to count as an oar.
  minElongation: 2.4,

  // Oar length as a fraction of the drawing's diagonal.
  minLengthRatio: 0.05,
  maxLengthRatio: 0.6,

  // Ignore specks; an oar is a real mark.
  minAreaRatio: 0.0003,

  // A drawing claiming more oars than this is being misread, so none are used.
  maxCount: 16,

  // Oars are not always drawn sticking out of the hull. On a snake boat they
  // are usually drawn *across* it, which makes them ink lying inside the
  // filled body rather than an appendage hanging off it. Looking only for
  // appendages misses them entirely.
  interior: {
    // How far inside the filled hull to look, as a fraction of its shorter
    // side. Deep enough to skip the outline, shallow enough to keep the bars.
    insetRatio: 0.02,

    // Bars are stricter than appendages: a stroke crossing the hull has to be
    // clearly a line, not a letter or a decorative mark.
    minElongation: 3.2,
    minLengthRatio: 0.04,
    maxLengthRatio: 0.5,

    // No single bar may be more than this share of the drawing's whole filled
    // area. Without it, a hull the visitor coloured in solid is itself ink
    // lying inside the hull - long, thin enough at a glance, and enormous -
    // and the entire boat would be torn off and rowed as one oar.
    maxAreaShare: 0.12,
  },

  /**
   * The rowing stroke - now the rhythm of the water rather than of the oars.
   *
   * The oars themselves do not move. A drawn line cannot be swung without its
   * original staying put behind it, so animating a copy showed two of every
   * oar; they are left where the visitor drew them. What kept the rowing is
   * the water: each blade bites once per stroke on this cycle and throws a
   * splash, and it carries on for as long as the boat is on screen.
   *
   * There is no sweep angle any more, because nothing swings.
   */
  stroke: {
    periodMs: 2200,

    // Oars on opposite sides of the hull pull together; along the hull they
    // lag slightly, which gives the ripple down the boat that rowing has.
    lagPerOar: 0.09,

    // Point in the cycle where the blade is deepest, and a splash is thrown.
    catchPhase: 0.25,
  },

  splash: {
    droplets: 8,
    lifeMs: 650,
    speed: 190,
    gravity: 1100,
    size: 3.4,
  },
};

/**
 * Showing the drawing as a lit 3D solid rather than a flat image.
 *
 * The silhouette is inflated into a mesh and skinned with the drawing itself, so
 * the boat keeps exactly what the visitor drew while gaining depth, shading and
 * perspective. No external service is involved and nothing is generated - the
 * geometry comes from the shape of the drawing.
 *
 * Set `enabled: false` to go back to the flat wave-warped image, which is what
 * happens anyway on a machine without WebGL.
 */
export const MODEL3D = {
  // Off by default. The flat wave-warped boat is the version that has been seen
  // working on the wall; this is the experimental one. Turn it on to try it, but
  // note the two things it gives up, below.
  enabled: false,

  // The silhouette is analysed at this width. Detail beyond it changes the
  // height field very little and costs time on every visitor.
  analysisWidth: 320,

  // Mesh resolution across the drawing's longer edge.
  grid: 88,

  // How far the surface bulges, relative to the model's size. Small: a boat is
  // a shallow thing, and overdoing it looks like a balloon.
  thickness: 0.16,

  // Curve of the bulge. Below 1 rounds off quickly at the edge and flattens
  // across the middle, which reads as a hull rather than a cone.
  profile: 0.65,

  // Turned slightly off square, so the depth is actually visible. Straight-on,
  // a 3D model and a flat image look identical.
  baseYaw: 0.3,

  fieldOfView: 32,
  distance: 3.1,
  scale: 1.35,

  // How much room the model's canvas is given on screen, relative to the boat's
  // flat footprint. Needs slack: rotation and perspective push the corners out
  // beyond where the flat image sat.
  canvasCover: 1.9,

  // A slow nod on top of the wave's roll, so the boat is never rigid.
  nodDegrees: 3.5,
  nodPeriodMs: 7300,

  // Direction the light comes from, and how much fills the shadows.
  light: [0.35, 0.75, 0.85],
  ambient: 0.55,
};

/**
 * The water the boat sits in, on the display wall.
 *
 * This is a simulated wave field, not the waves in the background footage -
 * reading those would mean optical-flow analysis of the video every frame.
 * Tune the numbers below to match whatever footage is in use; the eye accepts
 * an approximation readily as long as the motion is unhurried and irregular.
 */
export const WAVES = {
  // Two overlapping swells. Different lengths and speeds stop the surface
  // looking like a metronome.
  primary: { wavelength: 0.62, amplitude: 0.028, periodMs: 5200 },
  secondary: { wavelength: 0.23, amplitude: 0.011, periodMs: 3100 },

  // How hard the hull pitches with the slope of the water. Slightly over 1
  // reads better than exact - a real hull exaggerates the surface angle.
  tiltGain: 1.35,
  maxTiltDegrees: 9,

  // How much the hull bends to follow the surface rather than staying rigid.
  // 0 is a plank, 1 is a ribbon; a little flex is what sells it as a boat
  // sitting *in* the water rather than on a line.
  flex: 0.35,

  // Vertical slices the drawing is cut into to bend it. More is smoother and
  // costs more; 72 is indistinguishable from 200 at this size.
  slices: 72,

  // Mirrored reflection under the hull - the strongest single cue that the
  // boat is floating on something.
  reflection: {
    opacity: 0.22,
    squash: 0.42,
    wobble: 1.8,
  },
};

export const POLL = {
  // The first check goes out almost immediately, then backs off. A fixed
  // interval meant a job that finished in 300ms still sat there until the
  // next tick came round - pure dead time with a visitor watching.
  firstMs: 90,
  backoff: 1.6,
  maxIntervalMs: 800,
  timeoutMs: 130000,
};

export const CAMERA = {
  constraints: {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      facingMode: 'environment',
    },
    audio: false,
  },

  // Reconnect backoff after a webcam disconnect.
  retryDelayMs: 1500,
  maxRetryDelayMs: 15000,

  // If the video element stops producing frames for this long, restart it.
  stallTimeoutMs: 6000,
};
