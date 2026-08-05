const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Settings from a .env file, if there is one.
 *
 * A kiosk is set up by whoever is running the exhibition, on the machine, once.
 * Asking them to export variables into the shell that happens to start the
 * server is a good way to have the kiosk come back after a reboot missing its
 * API key. A file next to the application is harder to lose.
 *
 * Anything already in the environment wins, so a host that injects its own
 * configuration - Render does - is unaffected. The file is gitignored, because
 * it is where the secrets go.
 */
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env, or a Node without it. Neither is a problem.
}

/**
 * Reads a numeric setting, treating unset and empty as "not configured".
 *
 * `Number(x) || fallback` would be wrong here: several of these settings use 0
 * to mean "off", and 0 is falsy, so an explicit 0 would silently become the
 * default it was meant to override.
 */
function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * A JSON setting, or the default if it is missing or malformed.
 *
 * Malformed rather than fatal on purpose: a mistyped provider option should
 * cost that option and not stop the kiosk starting. It says so, loudly, so the
 * mistake is findable.
 */
function json(value, fallback) {
  if (!value) return fallback;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    console.warn(`[config] ignoring malformed JSON setting: ${err.message}`);
    return fallback;
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** '40mb' and the like, as a number. */
function bytes(size) {
  const match = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*$/i.exec(String(size));
  if (!match) return 0;

  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(Number(match[1]) * (units[(match[2] || 'b').toLowerCase()] || 1));
}

/**
 * The largest file the panel can actually put through an upload endpoint.
 *
 * Not the same as the limit itself. The panel sends a file as a base64 data
 * URL, and base64 is four bytes on the wire for every three of file, so a 40mb
 * ceiling on the request accepts a file of about 30MB. Worked out here rather
 * than left for somebody to discover when a 35MB video is rejected by a limit
 * that says 40.
 */
function largestFile(size) {
  const envelope = 512; // the JSON around it, and the data URL preamble
  return Math.max(0, Math.floor(((bytes(size) - envelope) * 3) / 4));
}

module.exports = {
  // A host assigns the port and passes it in; 3000 when running locally.
  port: Number(process.env.PORT) || 3000,

  /**
   * Whether this is a deployment rather than the kiosk machine.
   *
   * Only used to decide what the server is willing to say about itself: on a
   * public URL, diagnostics that are helpful next to the table become detail
   * about the host handed to anyone who asks.
   */
  isProduction: IS_PRODUCTION,

  /**
   * How many reverse proxies sit in front of this server.
   *
   * A deployment is reached through its host's router, so every request arrives
   * from the same internal address and the real client is named in
   * X-Forwarded-For. Without this, rate limiting sees one caller and would
   * throttle every visitor together.
   *
   * It is off locally because there is no proxy there, and trusting the header
   * when nothing sets it would let a caller pick their own identity and walk
   * around the limit.
   */
  trustProxy: num(process.env.TRUST_PROXY, IS_PRODUCTION ? 1 : 0),

  /**
   * Rate limits, per client address, per window.
   *
   * A public URL means the two POST endpoints can be called by anyone, not just
   * the screen by the table. The ceilings are set well above what a kiosk does
   * - one visitor produces one session and one recording every couple of
   * minutes - so they bite only on abuse, not on use. 0 disables a limit.
   */
  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
    sessions: num(process.env.RATE_LIMIT_SESSIONS, 12),
    recordings: num(process.env.RATE_LIMIT_RECORDINGS, 20),

    // The panel is one person clicking save, so this is generous for them and
    // still a ceiling on anyone who finds the upload endpoint.
    admin: num(process.env.RATE_LIMIT_ADMIN, 60),
  },

  /**
   * Which address to bind to.
   *
   * 0.0.0.0 means every interface, which is what a hosted container needs - its
   * router reaches the process from outside, so a server bound to 127.0.0.1
   * would look dead and fail the health check. It is also what makes the kiosk
   * reachable from a phone on the LAN, so the same default serves both.
   *
   * Set HOST=127.0.0.1 to keep a local run off the network entirely.
   */
  host: process.env.HOST || '0.0.0.0',

  // Which image provider to load from server/providers/.
  // 'mock' during development; swap for a real one without touching pipeline code.
  provider: process.env.IMAGE_PROVIDER || 'mock',

  // Which OCR engine to load from server/ocr/. 'tesseract' | 'none'.
  ocr: process.env.OCR_ENGINE || 'tesseract',

  /**
   * Tunnel provider, making the kiosk reachable from outside its own network so
   * a QR code works from a phone on mobile data. Empty for LAN only.
   *
   * 'ssh'         - localhost.run over the built-in OpenSSH client. Nothing to
   *                 install; free relays are not guaranteed to stay up.
   * 'cloudflared' - needs the cloudflared binary, and is what to use for a real
   *                 all-day exhibition.
   */
  tunnel: process.env.TUNNEL || '',

  /**
   * What the outside world may touch when a tunnel is open.
   *
   * A tunnel exposes the whole server, scanner and API included, to anyone with
   * the address. 'downloads' narrows that to reading the finished clips, which
   * is all a visitor's phone needs.
   */
  publicAccess: process.env.PUBLIC_ACCESS || 'downloads',

  // Which drawing classifier to load from server/classifier/.
  // Decides whether the visitor drew a boat; only boats reach the provider.
  classifier: process.env.CLASSIFIER || 'mock',

  /**
   * The 3D pipeline: tidy the sketch, then turn it into a model.
   *
   * Both stages are swappable by name, the same way the image provider, the OCR
   * engine and the classifier are. Neither is on the visitor's path - the boat
   * reaches the wall first and a model, if one is being made, arrives after -
   * so a slow or missing provider costs an animation, never a session.
   */

  // Which enhancer to load from server/enhancers/. 'passthrough' leaves the
  // drawing exactly as extracted, which is the default and the safe answer.
  enhancer: process.env.ENHANCER || 'passthrough',

  // Which image-to-3D provider to load from server/models3d/. 'none' is off.
  //
  // MODEL3D_PROVIDER is the name to use; MODEL3D is the older spelling of the
  // same setting and still works, so an existing .env keeps running untouched.
  model3d: process.env.MODEL3D_PROVIDER || process.env.MODEL3D || 'none',

  /** Everything the Replicate provider needs. Ignored by the others. */
  replicate: {
    token: process.env.REPLICATE_API_TOKEN || '',
    base: process.env.REPLICATE_API_BASE || 'https://api.replicate.com/v1',

    // An official model is addressed by name; a community one by version.
    // Setting a version switches to the versioned endpoint.
    model: process.env.MODEL3D_MODEL || 'tencent/hunyuan3d-2',
    version: process.env.MODEL3D_VERSION || '',

    pollMs: num(process.env.MODEL3D_POLL_MS, 2000),

    // Generous, because nobody is waiting on it. Long enough for a queue on a
    // busy afternoon, short enough that a wedged prediction is eventually let
    // go rather than held forever.
    timeoutMs: num(process.env.MODEL3D_TIMEOUT_MS, 90 * 1000),
  },

  /**
   * Everything the WaveSpeed AI provider needs. Ignored by the others.
   *
   * Off unless MODEL3D_PROVIDER=wavespeed and a key is set. With no key the
   * provider declines quietly and the pipeline builds the model itself, so
   * setting none of this leaves the kiosk exactly as it was.
   */
  wavespeed: {
    apiKey: process.env.WAVESPEED_API_KEY || '',
    base: process.env.WAVESPEED_API_BASE || 'https://api.wavespeed.ai/api/v3',

    /**
     * Which model to ask, as the path after the base.
     *
     * A setting rather than a constant, so pointing this at Tripo, Meshy or
     * Rodin instead is an environment variable and not an edit. Whatever is
     * named here has to take an `image` and give back a GLB.
     */
    model: process.env.WAVESPEED_MODEL || 'wavespeed-ai/hunyuan3d-v3/image-to-3d',

    pollMs: num(process.env.WAVESPEED_POLL_MS, 2000),

    /**
     * Generous, because nobody is waiting on it - the boat is already sailing.
     *
     * Five minutes, measured rather than guessed: at two it was still
     * "processing" on a real drawing and was cut off mid-generation, which reads
     * as the service failing when it was working perfectly well. An image-to-3D
     * model reconstructs geometry and then bakes a texture onto it, and a minute
     * or two of that is normal.
     *
     * Long enough for a queue on a busy afternoon, short enough that a wedged
     * prediction is eventually let go rather than held for ever.
     */
    timeoutMs: num(process.env.WAVESPEED_TIMEOUT_MS, 300 * 1000),

    /**
     * Anything else the chosen model wants, as JSON.
     *
     * Each of these models names its options differently - enable_pbr and
     * polygon_type on Hunyuan3D, other things elsewhere - and this is what keeps
     * that out of the code. e.g. WAVESPEED_INPUT='{"enable_pbr":false}'
     *
     * Bad JSON is ignored rather than fatal: a mistyped option should cost the
     * option, not the exhibition.
     */
    extra: json(process.env.WAVESPEED_INPUT, {}),

    // One line per step - upload, submit, each poll, download. On by default:
    // this runs unattended, and a provider that fails quietly at an exhibition
    // is a provider nobody can fix.
    log: process.env.WAVESPEED_LOG !== 'false',
  },

  /**
   * Everything the Tripo AI provider needs. Ignored by the others.
   *
   * Off unless MODEL3D_PROVIDER=tripo and a key is set. With no key the provider
   * declines quietly and the pipeline builds the model itself, so setting none
   * of this leaves the kiosk exactly as it was.
   */
  tripo: {
    apiKey: process.env.TRIPO_API_KEY || '',
    base: process.env.TRIPO_API_BASE || 'https://api.tripo3d.ai/v2/openapi',

    /**
     * Which version of the model to ask for, e.g. v2.5-20250123.
     *
     * Left empty by default, which lets Tripo pick its current one - the right
     * behaviour for a kiosk nobody is maintaining week to week.
     */
    version: process.env.TRIPO_MODEL_VERSION || '',

    pollMs: num(process.env.TRIPO_POLL_MS, 2000),

    /**
     * Generous, because nobody is waiting on it - the boat is already sailing.
     * The same five minutes the other service needed: reconstructing geometry
     * and baking a texture onto it takes a minute or two, and cutting that off
     * reads as a failure when it was working.
     */
    timeoutMs: num(process.env.TRIPO_TIMEOUT_MS, 300 * 1000),

    /**
     * Anything else to send with the task, as JSON. e.g. texture_quality,
     * style, face_limit. Keeps one version's option names out of the code.
     *
     * Bad JSON is ignored rather than fatal: a mistyped option should cost the
     * option, not the exhibition.
     */
    extra: json(process.env.TRIPO_INPUT, {}),

    // One line per stage - upload, submit, each change of status, download.
    log: process.env.TRIPO_LOG !== 'false',
  },

  /** Everything the Hugging Face Space provider needs. Ignored by the others. */
  huggingface: {
    // The Space's address, e.g. https://tencent-hunyuan3d-2.hf.space
    space: process.env.HF_SPACE_URL || '',

    // Optional. A public Space needs no token; a private or gated one does, and
    // a token also lifts the anonymous rate limit on a busy afternoon.
    token: process.env.HF_TOKEN || '',

    // Optional. Which named endpoint to call, e.g. /generation_all. Left unset,
    // the provider reads the Space's own API schema and picks the endpoint that
    // takes an image and returns a model, which is right on every Space tried.
    api: process.env.HF_SPACE_API || '',

    // Shared with Replicate, because it is the same question: how long to give
    // a queue before letting go. Nobody is waiting on it either way.
    timeoutMs: num(process.env.MODEL3D_TIMEOUT_MS, 90 * 1000),
  },

  /**
   * What to ask the model for.
   *
   * The face budget is asked for up front rather than trimmed afterwards: a
   * mesh that arrives the right size costs nothing to optimise, and there is no
   * geometry library on this server to decimate one that does not.
   */
  mesh: {
    faces: num(process.env.MESH_FACES, 40000),
    texture: process.env.MESH_TEXTURE !== 'false',

    /**
     * Grid resolution along the drawing's longer edge.
     *
     * The dial to turn for detail. The shorter edge follows from the drawing's
     * own proportions, so this never changes the shape of anything - only how
     * finely it is divided. The face budget above is a ceiling over it: where
     * the two disagree the budget wins, because a model that has to reach a
     * phone over exhibition wifi has a size it must come in under whatever
     * looked good on a desk.
     */
    grid: num(process.env.MESH_GRID, 128),

    /**
     * Whether the wall is told about a model the pipeline built itself.
     *
     * Off. The exporter works and every model it makes is written to disk, but
     * announcing one swaps the display from the boat the browser inflates to the
     * GLB the server exports - and that is a change to what an exhibition looks
     * like, not a change to what this pipeline produces. It should be turned on
     * deliberately, after somebody has looked at the two side by side.
     *
     * A configured plugin is announced either way: asking for one is already the
     * decision this setting is about.
     */
    publish: process.env.MESH_PUBLISH === 'true',
  },

  /**
   * Asking an image-to-3D service, and what to do when it does not answer.
   */
  plugin: {
    // How many times to ask. A free Space is queued and occasionally asleep,
    // and neither of those is a reason to give a visitor no boat.
    attempts: num(process.env.PLUGIN_ATTEMPTS, 2),

    // Multiplied by the attempt number, so a second try waits longer than the
    // first. Nobody is waiting on this: the boat is already on the wall.
    backoffMs: num(process.env.PLUGIN_BACKOFF_MS, 4000),

    /**
     * Whether a service that fails is allowed to be covered for.
     *
     * Off by default, which is the exhibition setting: the pipeline builds a
     * model of its own and the visitor never knows there was a service at all.
     * The reason is reported either way - it now travels to the wall with the
     * model rather than staying in a log - so "falling back" is no longer the
     * same thing as "saying nothing".
     *
     * On, no local model is shown when the service fails: the wall says what
     * went wrong instead. That is what you want while finding out why a service
     * is not answering, and it is not what you want with visitors in the room.
     */
    strict: process.env.MODEL3D_STRICT === 'true',
  },

  /**
   * What the scanner leaves behind.
   *
   * Background removal happens in the browser, and mostly works. These two
   * settings clear what measurably survives it, and nothing else - there is no
   * fold or border rule here, because no scan on disk showed either, and a
   * filter written against a fault nobody has seen is how a child's drawing gets
   * deleted.
   */
  cleanup: {
    // How opaque a pixel must be to count as part of the drawing.
    alphaThreshold: num(process.env.CLEANUP_ALPHA, 128),

    /**
     * How far into the page a corner reaches.
     *
     * A piece lying *wholly* inside a corner this size is a printed marker or
     * the corner of the sheet. The scanner already does this at 0.14 of the page
     * and the markers overshoot it by around twenty pixels, so this is a little
     * wider - and wholly is the word that keeps it safe: a drawing that merely
     * reaches towards a corner has a bounding box that leaves it again.
     */
    cornerRatio: Number(process.env.CLEANUP_CORNER || 0.2),

    // Below this share of the frame a piece is dust rather than a drawn mark.
    // Low: the dot of an 'i' is tiny and losing it mangles handwriting.
    minAreaRatio: Number(process.env.CLEANUP_MIN_AREA || 0.00004),
  },

  /**
   * Turning the silhouette into a height.
   *
   * A distance transform: how far each point of the drawing is from the nearest
   * point outside it. The middle of a shape stands proudest and the rim lies
   * flat on the page. It asks only "how far in is this", which is a question
   * every drawing can answer - so a boat, a flower, a house and a dog all
   * inflate sensibly, none of them having had to be recognised first.
   */
  depth: {
    // How opaque a pixel must be to count as part of the drawing.
    alphaThreshold: num(process.env.DEPTH_ALPHA, 128),

    /**
     * The curve of the bulge.
     *
     * Below one rounds off quickly at the rim and flattens across the middle,
     * which reads as a solid with a soft edge. At one the shape comes to a
     * ridge along its centre like a tent.
     */
    profile: Number(process.env.DEPTH_PROFILE || 0.65),

    // Total thickness at the deepest point, against a model one unit across.
    thickness: Number(process.env.DEPTH_THICKNESS || 0.22),

    /**
     * How far in from the outline the surface is still climbing.
     *
     * The wall. Past it the surface falls away towards the floor, which on a
     * drawn hull is the difference between gunwales with an interior and a
     * solid lozenge. As a fraction of the shape's own deepest point, so a big
     * hull gets a proportionate wall.
     */
    wallRatio: Number(process.env.DEPTH_WALL_RATIO || 0.28),

    /**
     * ...but never thinner than this, in pixels of the analysed field.
     *
     * This is what keeps a thin shape solid. A paddle blade never reaches the
     * far side of its own wall, so it never hollows out - it just comes out
     * thinner than the hull, which is what it is.
     */
    minWallPx: num(process.env.DEPTH_MIN_WALL_PX, 14),

    // How far the inside drops below the rim. 1 would be no hollow at all.
    interiorFloor: Number(process.env.DEPTH_INTERIOR_FLOOR || 0.38),

    // Nothing drawn is left with no thickness. A single pencil line is still
    // something the child put on the page.
    thinFloor: Number(process.env.DEPTH_THIN_FLOOR || 0.1),

    /**
     * The widest the height field is worked out at.
     *
     * A scan can be several megapixels and the field gains nothing from the last
     * of them, since the mesh samples it far more coarsely anyway. Anything
     * bigger is stepped down by a whole number - a whole number rather than a
     * resample, because taking every nth pixel cannot invent a boundary that was
     * not there, and the silhouette is the one thing that must not shift.
     */
    maxWidth: num(process.env.DEPTH_MAX_WIDTH, 1024),
  },

  /**
   * Password for /admin, if there is to be one.
   *
   * Unset means the panel is open, which is right on a kiosk on a table with
   * nobody else on the network. Set it the moment the kiosk is reachable from
   * outside: the panel writes files to disk, and an upload endpoint anyone can
   * reach is an upload endpoint anyone will find.
   *
   * Reading the settings is never gated - the display screen needs them.
   */
  adminToken: process.env.ADMIN_TOKEN || '',

  paths: {
    root: ROOT,
    client: path.join(ROOT, 'client'),
    assets: path.join(ROOT, 'assets'),
    uploads: path.join(ROOT, 'uploads'),
    images: path.join(ROOT, 'generated', 'images'),
    videos: path.join(ROOT, 'generated', 'videos'), // reserved for a later version
    models: path.join(ROOT, 'generated', 'models'), // GLBs from the 3D pipeline

    // Logos and advertisements, and the settings that point at them. Both sit
    // outside the folders the retention sweep clears: a visitor's capture is a
    // leftover after a day, an organiser's logo is not.
    media: path.join(ROOT, 'media'),
    data: path.join(ROOT, 'data'),
  },

  // A visitor's generation must finish inside this window or the job fails and
  // the kiosk returns to scanning rather than hanging.
  jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS) || 120000,

  // Finished jobs are dropped from memory after this long.
  jobRetentionMs: Number(process.env.JOB_RETENTION_MS) || 30 * 60 * 1000,

  // Files older than this are deleted on a periodic sweep, so an all-day
  // exhibition does not fill the disk. 0 disables the sweep.
  fileRetentionHours: Number(process.env.FILE_RETENTION_HOURS) || 48,

  /**
   * Largest accepted payload, per endpoint (base64 PNGs and video are bulky).
   *
   * Split in two so the body parser can be mounted on the two routes that read
   * a body rather than on everything. A limit that applies to every path is
   * also an invitation to send that much to any path, including ones that do
   * not exist.
   *
   * Both keep the previous 30mb default, so nothing that worked stops working;
   * MAX_UPLOAD_SIZE still sets both at once.
   */
  uploads: {
    session:
      process.env.MAX_SESSION_UPLOAD_SIZE || process.env.MAX_UPLOAD_SIZE || '30mb',
    recording:
      process.env.MAX_RECORDING_UPLOAD_SIZE || process.env.MAX_UPLOAD_SIZE || '30mb',

    // A logo is small; an advertisement or a background can be a video.
    media: process.env.MAX_MEDIA_UPLOAD_SIZE || '40mb',

    // The settings themselves are a few hundred bytes of JSON. Nothing that
    // arrives at that endpoint has any business being larger.
    settings: '256kb',
  },

  /**
   * The largest file the panel can upload, in bytes.
   *
   * Told to the panel so it can say so up front and turn a file away with a
   * useful message, rather than sending thirty megabytes to be met with a 413.
   */
  largestUpload: largestFile(process.env.MAX_MEDIA_UPLOAD_SIZE || '40mb'),
};
