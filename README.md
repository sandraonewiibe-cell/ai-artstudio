# AI ART STUDIO — Version 1

## The three screens

| URL | Screen | Runs on |
| --- | --- | --- |
| `/` | **Scanner** — camera, detection, capture | the machine by the table |
| `/display` | **LED wall** — background video, then the boat | the big screen |
| `/qr` | **Download** — QR for the last recording | a small screen beside the exit |

They stay in step over Server-Sent Events (`/api/events`). Open each URL in its own browser window; all three can run on one machine or on separate ones, as long as they reach the same server.

The server prints all three addresses on startup, using the machine's LAN address rather than `localhost` so the other screens and visitors' phones can reach it.

**A session, across the screens:** the scanner detects a sheet, captures, and posts it. The server generates the boat and broadcasts a `result`. The display picks it up, plays the boat across the wall for 15 seconds while recording its own canvas, and posts the recording back. The server broadcasts a `recording`, and the QR screen swaps to a code for it. Meanwhile the scanner has already returned to scanning — it does not wait for the wall.


A touch-free kiosk. A visitor draws a boat inside the printed frame on a marker sheet and places it under an overhead webcam. The application finds the sheet by its four corner markers, waits for it to be still, captures it automatically, corrects the perspective, crops to the drawing area, extracts the drawing, reads any handwriting, checks that a boat was actually drawn, sends it to an image provider, and shows the result over a looping background video for 15 seconds before returning to the camera.

There are no buttons anywhere in the experience.

## Requirements

- Node.js 18 or newer
- A webcam, ideally mounted overhead looking down at a table
- Plain white paper, and **something dark for it to lie on** — a wooden table, a mat or a cloth. (Or printed copies of [assets/page.png](assets/page.png) if you switch to marker mode.)

## Getting started

```bash
npm install
npm start
```

Open http://localhost:3000. The camera starts immediately.

Camera access needs a secure context. `http://localhost` qualifies; serving over plain `http://` to another machine does not, so use HTTPS or a tunnel for a remote display.

## The paper

Two ways of finding the sheet, chosen with `DETECTION.mode` in [client/js/config.js](client/js/config.js).

### `'paper'` — plain white paper (the default)

Nothing to print. The sheet is the brightest large region in frame, so **whatever the paper is lying on is the border**.

**This requires a dark surface under the paper** — a wooden table, a dark mat, a cloth. That is the one real cost of not printing markers: on a white or pale table the paper does not separate from the background and nothing is detected.

- Put the paper **fully inside the camera view**, with a visible gap all the way round. All four edges have to be visible; paper running out of frame cannot be located.
- Avoid a hard shadow across the sheet, and glare from a window or lamp.
- 3.5% is trimmed off each edge after correction, which loses the paper's own edge, the shadow it casts and any curl at the corners. Keep the drawing inside that.

One guard worth knowing about: on a pale table the only dark thing in shot is the drawing itself, which makes the bright region the *entire frame*. Without a check, that whole frame would be "detected" and cropped as though it were the paper — a plausible-looking but completely wrong result. Requiring a clear margin on all four sides (`PAPER.minFrameMargin`) makes it decline instead, which is the right outcome: if the edges cannot be seen, the paper cannot be found.

### `'markers'` — the printed template

[assets/page.png](assets/page.png) carries a QR block at each corner. **Their positions only; the codes are never decoded.** This mode works on any surface including a white table, and corrects perspective from four exactly-known points, so it is the sturdier of the two for an unattended all-day run.

- **Print at 100% scale, not "fit to page."** Scaling is tolerated (the crop is measured from the markers themselves), but clipping is not.
- The markers sit flush to the page edge in the source file, and most printers cannot print to the edge. Check all four survive — a clipped marker will not be recognised.
- All four must be in frame. Three markers is not a sheet, and detection correctly refuses to fire.

### Which to use

Plain paper if you would rather not print anything and can put something dark under the sheet. Markers if the surface is pale, the lighting is awkward, or you want the most robust option. Everything downstream — extraction, fill, oars, layers, recording — is identical either way.

## Configuration

All optional, set as environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `IMAGE_PROVIDER` | `mock` | Which provider in `server/providers/` to load |
| `CLASSIFIER` | `mock` | Which classifier in `server/classifier/` to load |
| `OCR_ENGINE` | `tesseract` | `tesseract` or `none` |
| `JOB_TIMEOUT_MS` | `120000` | Generation gives up after this and returns to camera |
| `FILE_RETENTION_HOURS` | `48` | Captures and renders older than this are swept |
| `MOCK_DELAY_MS` | `2500` | Simulated provider latency |
| `MOCK_CLASSIFIER` | `accept` | `accept`, `reject`, or `alternate` — exercises both outcomes |
| `OCR_MIN_CONFIDENCE` | `70` | Words below this confidence are discarded |
| `OCR_MIN_WORD_LENGTH` | `3` | Shorter recognised words are treated as noise |
| `PUBLIC_HOST` | auto | Address the QR code points at; auto-detected from the LAN |

## Project structure

```
ai-artstudio/
├── client/
│   ├── index.html          # screen 1: scanner
│   ├── app.js
│   ├── display.html        # screen 2: LED wall
│   ├── display.js
│   ├── qr.html             # screen 3: download QR
│   ├── qr.js
│   ├── style.css           # shared by all three
│   └── js/
│       ├── config.js       # all tunable constants
│       ├── camera.js       # webcam lifecycle + auto-recovery
│       ├── detector.js     # marker detection, stability, duplicate lockout
│       ├── components.js   # connected-component labelling (shared)
│       ├── geometry.js     # homography solve + perspective warp
│       ├── capture.js      # full-res grab -> rectified drawing area
│       ├── extract.js      # ink thresholding + drawing isolation
│       ├── imaging.js      # luminance, Otsu, motion, canvas helpers
│       ├── api.js          # session create + poll
│       ├── bus.js          # SSE client, shared by display and qr
│       ├── stage.js        # canvas renderer for the wall
│       └── recorder.js     # canvas capture -> webm
├── server/
│   ├── server.js           # Express app, routes, kiosk housekeeping
│   ├── config.js
│   ├── pipeline.js         # OCR -> classify -> generate -> store
│   ├── events.js           # SSE broadcaster
│   ├── recordings.js       # recording storage + QR rendering
│   ├── network.js          # LAN address detection
│   ├── storage.js          # data URL decode, file writes, retention sweep
│   ├── providers/          # ImageProvider abstraction + mock
│   ├── classifier/         # boat check abstraction + mock
│   └── ocr/                # OCR abstraction + tesseract / none
├── assets/page.png         # the printable marker sheet
├── uploads/  generated/images/  generated/videos/
├── package.json
└── README.md
```

## How a session runs

1. **Scan** — each frame is downscaled and thresholded. In `paper` mode the bright region is the sheet, and coverage, contrast, frame-margin, quad-fill and edge-ratio checks reject anything bright that is not sheet-shaped — a hand, glare, a patch of pale table. In `markers` mode connected components that are roughly square and the right size are marker candidates, and the four furthest towards each corner are selected.
2. **Settle** — the sheet must hold still for 500ms (low frame-to-frame motion *and* low corner drift). A progress ring fills while it settles; movement resets it. See [Scanning speed](#scanning-speed).
3. **Capture** — a full-resolution frame is grabbed and warped flat from the detected quad. Output keeps the sheet's own proportions rather than assuming a paper size.
4. **Mask and crop** — the border is painted to paper white and then trimmed off: the darker table beyond a plain sheet, or the QR blocks on a printed one. The detector reports how much to trim, so one code path serves both modes. See [Border exclusion](#border-exclusion) below.
5. **Extract** — the drawing area is thresholded into ink and paper and components are labelled. **The hand-drawn boat and any handwritten text are both kept**, while isolated specks (see [Specks vs. the dot of an 'i'](#specks-vs-the-dot-of-an-i)) and anything lying wholly inside a corner box are discarded. Enclosed areas are then filled (see [Filling the drawing](#filling-the-drawing)). The result is a cropped PNG with a transparent background and soft alpha edges.
6. **OCR** — Tesseract reads the whole drawing area separately. Whatever survives filtering is shown verbatim; no text is a normal outcome and the session continues. See [Keeping OCR noise off the screen](#keeping-ocr-noise-off-the-screen).
7. **Check** — the classifier decides whether a boat was actually drawn. If not, the visitor sees a short message and the kiosk returns to scanning. **This happens before generation, so a doodle never costs a provider call.**
8. **Generate** — the drawing, the page and the detected text go to the `ImageProvider`.
9. **Hand off** — the scanner confirms with "YOUR BOAT IS SAILING" for 4 seconds, then re-arms. It does not wait out the wall, so a queue keeps moving.
10. **Display** — on `/display`: the looping background video from `assets/background/bg.mp4`, with the boat on top **sailing across to the right-hand border** while it rides the water. See [Riding the waves](#riding-the-waves). Ripples sit directly beneath it and the detected text below. The crossing is timed to the 15-second hold, so the boat arrives at the border exactly as the screen ends.
11. **Record and offer** — the display records its own canvas throughout and posts the clip back; the QR screen swaps to a code for it. See [Recording and download](#recording-and-download).
12. **Reset** — the wall returns to background video, ready for the next boat.

### Border exclusion

Whatever forms the border — the darker table around a plain sheet, or the printed QR blocks — is used **only** to find the sheet, correct perspective and establish the boundaries. None of it may reach the display or the AI input, so three independent layers stand between them and the output.

1. **Paint out** ([capture.js](client/js/capture.js)) — the border of the rectified page is filled with paper white before anything else happens. This runs first, so the page handed to **OCR and to the provider** is clean, not just the extracted drawing.
2. **Crop** ([capture.js](client/js/capture.js)) — the page is then cropped strictly inside the painted region. The paint is deliberately `maskOverscan` (1.35×) larger than the crop, so if the inset turns out to be an underestimate the paint has still covered what the crop misses.
3. **Discard** ([extract.js](client/js/extract.js)) — any ink component lying *entirely* inside one of the four corner boxes is dropped before extraction.

Layer 3 is positional, not shape-based, and that is deliberate: a whole marker is square, but a **sliver** left by a slightly-too-tight crop is a thin strip that a squareness test would wave straight through. The trade-off is that anything a visitor draws wholly inside a corner box is treated as a remnant and lost — which is why `EXTRACT.cornerZoneRatio` is kept small (0.14).

The test suite drives a synthetic camera frame through detection, capture and extraction, and asserts zero border ink in the captured page corners, plus correct disposal of both a whole marker and a thin sliver.

### Scanning speed

Two things decide how quickly capture fires once the paper is down.

**The stability window** (`DETECTION.stableMs`, 500ms). This exists so a hand still resting on the sheet is not photographed. Shortening it makes the kiosk feel snappier but raises the chance of capturing fingers; lengthening it is the fix if hands are getting into shots.

**Auto-exposure, which used to dominate.** Placing a white sheet under the camera makes auto-exposure and auto-white-balance hunt for a second or two, and during that every frame differs from the last *across the whole image*. The original motion metric — a plain mean absolute difference — read that as violent movement and restarted the stability timer on every frame, so capture waited for the *camera* to settle rather than for the paper. On a camera with slow auto-exposure that could add several seconds, and in bad lighting it could stall indefinitely.

`motionBetween()` in [client/js/imaging.js](client/js/imaging.js) now subtracts the global brightness shift before measuring, which cancels a uniform exposure change while leaving real, localised movement fully visible. A sheet that is genuinely still now reads as still immediately, whatever the camera is doing.

Analysis also runs at 20fps rather than 15, giving the timer finer resolution, and the re-arm delay between visitors is down to roughly a second.

Both behaviours are covered by tests: a sequence with the sheet perfectly still but brightness swinging ±15 must still fire, and a sheet sliding a few pixels per frame must never fire.

### Pausing the scanner

Automatic scanning is on from the moment the page loads. Pressing **`A`** pauses it, and pressing `A` again resumes.

While paused the camera stays live — only the reaction to what it sees stops, which is what you want while setting up the table, changing the lighting or clearing up. Frame analysis stops entirely too, so a paused kiosk is idle rather than burning CPU. The hint line turns amber and reads `SCANNING PAUSED — PRESS A TO RESUME`.

Resuming resets the detector, so a half-filled stability timer is never inherited across a pause. Modifier combinations are ignored, so `Ctrl+A` still behaves normally. A session already generating when you pause runs to completion and displays; the pause takes effect for the next visitor.

### Duplicate prevention

After a capture the scanner enters a `holding` state and cannot fire again until the markers leave the frame — absent for 8 consecutive frames, then a short cooldown. A visitor adjusting their drawing under the camera cannot trigger a second session.

## Adding a real image provider

Create `server/providers/<name>.js`:

```js
module.exports = {
  name: 'my-provider',

  // drawing: transparent PNG of the boat, paper: drawing area PNG, text: OCR string or null
  async generateBoat({ drawing, paper, text }) {
    const buffer = await callYourService(drawing, text);
    return { buffer, ext: 'png', transparent: true };
  },
};
```

Run with `IMAGE_PROVIDER=my-provider`. Nothing else changes — `pipeline.js` never references a specific service, and `base.js` validates the contract at startup and every result.

Set `transparent: false` if the service returns a solid background; the display still centres it on black and a later version can key it out.

## Adding a real boat classifier

Create `server/classifier/<name>.js`:

```js
module.exports = {
  name: 'my-classifier',

  async classify({ drawing, paper, text }) {
    const result = await askVisionModel(drawing);
    return { isBoat: result.isBoat, confidence: result.score, label: result.label };
  },
};
```

Run with `CLASSIFIER=my-classifier`.

**`MockClassifier` cannot actually tell a boat from a bicycle** — that needs a vision model. What it does is exercise both outcomes so the kiosk's behaviour can be tested now: `MOCK_CLASSIFIER=reject` fails every drawing, `alternate` flips on each visitor. It always rejects an empty page, which is real behaviour.

If a classifier fails to load, the loader falls back to `accept-all`, so a misconfiguration shows every drawing rather than rejecting every visitor.

## Specks vs. the dot of an 'i'

Dust on the paper and the dot of an `i` are the same size, so a single size threshold either keeps both — leaving stray dots floating on the display — or drops both, which cuts letters out of the name. Neither is acceptable, so the test is **company**, not size:

- **Above `EXTRACT.substantialRatio`** → kept unconditionally.
- **Between the noise floor and that** → kept only if a substantial component sits within `EXTRACT.speckleReachRatio` (2% of the page diagonal).
- **Below `EXTRACT.minComponentRatio`** → sensor grain, always dropped.

The dot of an `i` has a stem directly beneath it and stays; a speck of dust has nothing near it and goes. This also keeps stray marks out of the crop bounds, which otherwise stretch the frame and shrink the boat on screen.

`result.specks` reports how many were discarded, which is the number to watch if letters start disappearing.

## Keeping OCR noise off the screen

A drawing is not text, but Tesseract will still try to read it — hull curves and mast lines come back as strings like `~|/\_` or `Ss`, which then appear on the loading screen under the title. Three filters in [server/ocr/tesseract.js](server/ocr/tesseract.js) stop that:

1. **A character whitelist** — letters, digits, space, and `. ' - &`. Symbols are never emitted at all, which removes most of the noise at source.
2. **A confidence floor** (`OCR_MIN_CONFIDENCE`, default 70) — stroke noise usually scores low, so this does most of the remaining work.
3. **A plausibility test** — a word must be at least 2 characters and at least 60% letters and digits, and the whole result must contain at least 2 alphanumerics or it is discarded entirely.

If junk still gets through, raise `OCR_MIN_CONFIDENCE`. If real names are being dropped, lower it. Fundamentally Tesseract is a printed-text engine being asked to read handwriting next to a drawing; a hosted vision model in the same slot would do markedly better.

## Rowing the oars

If the drawing has oars in it, each one is animated separately: it swings about the point where it meets the hull, and throws a splash as the blade bites.

### Finding them

The hard part, and people draw oars two different ways — both are handled.

**Hanging off the hull.** Most people draw an oar as one continuous stroke touching the hull, so it shares the hull's connected component and labelling cannot separate them. The way through is a **morphological opening** on the *filled* drawing: eroding by a radius wider than an oar stroke rubs the oars out entirely while barely touching the solid hull, and dilating back restores the hull's size. Whatever the filled shape has that the opened one does not is a thin appendage. Where it touches the solid body is where it is held, so that becomes the pivot; the furthest pixel is the blade.

**Drawn across the hull.** A snake boat is usually drawn with its oars laid *across* the boat, which makes them ink lying inside the filled body rather than an appendage hanging off it — the opening cannot see them at all. So a second pass looks at ink sitting well inside the filled hull, past its outline. A bar found this way has no join to pivot on, so it is held at its upper end: seen side-on, an oar reaches down from the gunwale into the water, making the lower end the blade.

Either way, each candidate is measured by its **second moments** — the principal axis is what "long and thin" means for a stroke drawn at any angle — and only the long thin ones are kept.

An oar hanging off the hull is cut away from the hull layer entirely. One drawn across it cannot be: removing it would punch a bar-shaped hole through the boat. It stays in the hull layer but is painted over in the hull's own colour, and the moving copy is drawn on top.

### Rowing them

Oars are rigid, so they swing rather than bend — drawn inside the hull's transform but not through its slicing. A small lag down the line (`PADDLES.stroke.lagPerOar`) stops them moving as one block. Once per stroke the blade reaches its catch and throws a handful of droplets, which arc under gravity and fade.

### When it does not apply

- **No oars in the drawing** → no layers are produced and the display shows the single flat image, exactly as before. This is the common case and costs nothing.
- **More than `PADDLES.maxCount` appendages** → the opening radius is wrong for that drawing and it is reading hull texture as oars, so none are used. Better to animate nothing than to shred the boat.
- **A hull coloured in solid** → the whole body is then ink lying inside the hull: long, thin enough at a glance, and enormous. `PADDLES.interior.maxAreaShare` caps any single bar at 12% of the drawing's filled area, so the boat cannot be torn off and rowed as one giant oar.
- **A real image provider is configured** → oar layers are cut from the visitor's *drawing*, but a real provider returns one flat generated boat, and the two would not line up. Layers are therefore attached only for a stand-in result. **A provider that wants rowing oars has to return its own layers.** This is the main limitation to be aware of when moving off `MockProvider`.

## Riding the waves

The boat is a flat drawing made to behave like a hull on water. Three effects, all in [client/js/stage.js](client/js/stage.js):

**The hull rides a wave field.** Two overlapping swells of different lengths and speeds give a surface that never repeats obviously. The hull rests on the water **at its two ends**, so its height is the midpoint of bow and stern and its pitch is the chord between them — physically how a boat sits. As the swell passes, the bow lifts while the stern drops and then the reverse, which is the tip-to-tip motion you get on real water.

Measuring the slope at a *point* instead looked right on paper but pinned the boat at its tilt limit: the sampling baseline was comparable to the shorter swell's wavelength, so it aliased. The chord fixed it — pitch now peaks around 6° against a 9° safety clamp.

**The hull flexes.** After the rigid pitch is applied, each of 72 vertical slices is nudged by however much the real surface departs from that straight line. `WAVES.flex` controls it: 0 is a rigid plank, 1 is a ribbon, and a little flex is what makes it read as sitting *in* the water rather than on a line.

**A reflection wobbles underneath.** Squashed, faded and distorted more strongly than the hull, phase-shifted so it breaks up the way a reflection does on a moving surface. This is the single strongest cue that the boat is floating.

### Two honest limits

**This is not 3D geometry.** It is a flat image bent convincingly. Real 3D would need depth estimation from an image-to-3D model — a provider-level feature, not something canvas rendering can do.

**The waves are simulated, not read from the video.** Matching the actual footage would mean optical-flow analysis every frame: expensive and fragile. The numbers in `WAVES` are there to be tuned by eye against whatever background is in use — the eye accepts an approximation readily, provided the motion is unhurried and irregular. If you change `bg.mp4` for footage with a different swell, adjust `wavelength` and `periodMs` to suit.

## Recording and download

The display screen is drawn on a **canvas**, not with DOM elements and CSS, for one specific reason: `canvas.captureStream()` records exactly what is on screen with **no permission prompt**. Screen capture (`getDisplayMedia`) would pop a window-picker dialogue for every recording, and an unattended kiosk has nobody to answer it. Everything the CSS version did — the crossing, the float, the rock, the ripples, the name — is reproduced in [client/js/stage.js](client/js/stage.js) at the same proportions.

The canvas is a fixed 1920×1080 and scaled to fit whatever it is shown on, so recordings are the same size wherever the wall runs.

**The clip is 8 seconds, shorter than the 15-second crossing** (`DISPLAY.recordMs`, clamped to `holdMs`). Recording starts as the boat sails in from the left and stops with it near the middle of the screen, which reads as a complete little scene while staying quick to upload, quick to download over exhibition wifi, and easy to share. The boat carries on across the wall after the recorder has stopped. Set `recordMs` equal to `holdMs` to capture the whole crossing instead.

`MediaRecorder` emits every second rather than only at the end, so a crash mid-session still leaves usable data. The clip is posted to `/api/recordings`, stored under `generated/videos/`, and announced to the QR screen.

**The QR encodes the machine's LAN address**, not `localhost` — a visitor's phone is a different device and cannot reach `localhost`. The address is detected from the network interfaces, preferring real adapters over virtual ones (WSL, Docker, VirtualBox). Set `PUBLIC_HOST` to override, which is what you want behind a tunnel or reverse proxy.

For a phone to actually download the file it must be on the same network as the server, and the server's port must not be blocked by the firewall. Worth testing on the day: scan the QR with a phone before visitors arrive.

If the browser cannot record (no `MediaRecorder`, or no supported codec), the display logs a warning and plays the boat anyway — the exhibition continues, that visitor just gets no download.

## Telling ink from paper

**Locally, not with one threshold for the whole page.** A pixel is ink if it is darker than the paper immediately around it (`EXTRACT.ink`), computed with an integral image so the cost does not depend on the radius.

This is the single most important thing in the extractor, because a global threshold fails badly under real light. Measured on a page with a lamp falling across it:

| Page | One global threshold calls this "ink" | Local comparison |
| --- | --- | --- |
| Thin pen, even light | 0.5% | 0.52% |
| Thin pen, strong shading | **47.7%** | 0.52% |
| Pale pencil, strong shading | **49.4%** | 0.52% |
| Pale pencil, gentle shading | **48.2%** | 0.52% |

Otsu's method assumes two clean populations. On a sheet that is 99% paper with a gradient across it, the biggest split in the histogram is the *lighting*, not the ink — so half the page becomes "drawing". That produced two visible failures which looked unrelated:

- **The whole sheet floating on the water.** Half the page read as ink, that ink ringed the border, a ring blocks the flood-fill that finds enclosed areas, and so the entire page filled solid.
- **"Nothing to see yet" on every scan.** With a pale pencil the split landed inside the paper distribution, the contrast gate saw 14.7 and gave up, extraction returned nothing, and the classifier was handed an empty drawing.

Both went away with local thresholding. It costs about 48ms per capture, which is worth it.

Two knock-on details, since everything downstream compared against that one number:

- The alpha ramp and the pale-wash test now compare against the **local paper level**. The wash margin has to stay below `ink.offset`, or clean paper reads as a faint colour and the inside of an outlined boat is left unfilled.
- Ink reaching the page edge is still rejected as border, but **never if that would empty the page**. On a photograph the shading near the paper's edge can join up with the drawing, and discarding that leaves nothing to extract — which is the "no drawing" rejection all over again.

## Filling the drawing

An outlined boat would otherwise show as a ring around a transparent hole, so enclosed areas are filled and the shape reads as solid.

The fill works by flooding the *background* inward from the page border: anything the flood cannot reach is walled in and is therefore inside the boat. The flood uses four-connectivity, so a diagonal pencil line still counts as a seal.

**What decides whether an enclosed area is filled: who encloses it.** An area fills when a component at least `EXTRACT.fill.hullShareRatio` (15%) the size of the biggest one forms part of its boundary. The hull qualifies, so every compartment inside the boat fills — right down to the gaps between the thwarts. A letter is far below the bar, so the counters of **O, A, B, e, o** stay open.

"Part of its boundary" rather than "most of it", deliberately: a gap between two seats is bounded partly by the hull and partly by the thin seat strokes, and requiring a majority leaves those pockets blank.

**Size of the hole is not used, and that took two tries to get right.** Judging holes by size stops letter counters filling — but a compartment between two seats and the counter of an 'o' are *the same size*, so a size threshold either blanks out the inside of a snake boat or blacks out the name. Only the boundary separates them cleanly.

Colour for an enclosed pixel is chosen per pixel:

- **The visitor coloured it in** → their colour is kept exactly. Detected by **chroma**, not brightness, because a pale yellow crayon and white paper are nearly identical in brightness but nothing alike in colour.
- **It is blank paper** → it takes the drawing's own average ink colour, so an outline drawn in blue fills blue, not black.

Strokes and everything they enclose are fully opaque — no semi-transparent gaps inside the shape. Only the fringe immediately outside the outline keeps a soft alpha, which is what stops pencil edges looking cut out.

Tuning lives in `EXTRACT.fill` in [client/js/config.js](client/js/config.js).

## Colour and the background video

**The visitor's colours are shown exactly as they appear on the paper.** The extractor copies each pixel's original RGB and varies only the alpha, and the display applies no filter, tint or inversion.

One consequence worth knowing: a drawing made in graphite pencil is dark, and against a dark background video it will read faintly. Colour pens and markers show far better. If that turns out to be a problem on the day, the fix is a background choice or a subtle glow behind the boat — not a colour filter, which would break the exactness above.

The background is `assets/background/bg.mp4`, played muted and looping, restarted from the top for each visitor and paused between sessions. Autoplay works because it is muted. If the file is missing or fails to decode, the screen falls back to black and the boat still shows.

To change it, replace that file — the path is in [client/index.html](client/index.html).

## Kiosk operation

- **Camera recovery** — a dropped webcam is detected three ways: the track ending, the video element delivering no new frames for 6s, and the OS device list changing. Reconnection retries with backoff to 15s, showing an on-screen notice meanwhile.
- **Screen sleep** — the Wake Lock API is held and re-acquired if released.
- **Failure handling** — any error shows a message for 5 seconds and returns to scanning. The server logs unhandled errors rather than exiting.
- **Disk** — uploads and renders older than `FILE_RETENTION_HOURS` are swept hourly.
- **Fullscreen** — a browser cannot enter fullscreen without a user gesture, so launch in kiosk mode, e.g. `chrome --kiosk --app=http://localhost:3000`.

## Tuning on site

Everything worth adjusting for your table, camera height and lighting is in [client/js/config.js](client/js/config.js) — marker size bounds, fill and squareness tolerances, stability duration, motion thresholds, re-arm behaviour and extraction sensitivity. Nothing else should need editing.

**If capture never fires in `paper` mode**, the first thing to check is that the surface under the paper is genuinely darker than the paper — that single fact carries the whole mode. Then confirm all four paper edges are inside the frame with a gap around them. After that, lower `PAPER.minContrast` and `PAPER.minQuadFill`.

**If capture never fires in `markers` mode**, check all four markers are in frame and in focus, then widen `MARKERS.minAreaRatio` / `maxAreaRatio` and relax `MARKERS.minFill`.

**If the border survives into the drawing**, raise `PAPER.cropInsetRatio` (or `MARKERS.cropGapRatio`).

## Status

Version 1 is complete: marker detection, capture, perspective correction, drawing-area crop, extraction, OCR, boat check, provider abstraction and the presentation screen. No video generation yet.
