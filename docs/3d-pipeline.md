# The 3D pipeline

How a child's drawing becomes a model, and what each part of it is allowed to do.

```
  sketch on paper
        |
        v
  [ scan ]                  browser   client/js/camera.js, capture.js
        |
        v
  [ background removal ]    browser   client/js/extract.js
        |                   server    server/pipeline3d/stages/background.js
        v
  [ line & colour ]         browser   client/js/extract.js
        |                   server    server/pipeline3d/stages/artwork.js
        v
  [ depth ]                 server    stages/depth.js
        |
        v
  [ mesh ]                  server    stages/mesh.js
        |
        v
  [ texture ]               server    stages/texture.js
        |
        v
  [ GLB export ]            server    stages/glb.js
        |
        v
  [ renderer ]              browser   client/js/boatgl.js (GLB)
                                      client/js/boat3d.js (built in the browser)
```

## The rule that outranks the others

The drawing passes through untouched. Every stage may measure it; none may
repaint it. White paper stays white, handwriting stays handwriting, the wobble
in a hand-drawn line stays where the hand put it, and no stage invents a shape,
a shadow or a colour that was not on the page.

Two of the assertions in `contract.js` exist only to enforce this, and they are
checked by the runner rather than by the stages, so a stage cannot decline to be
checked:

- the artwork that comes out of extraction must be byte-identical to what went
  into it while it reports `exact`
- the texture handed to the exporter must be the artwork itself, not a copy that
  has been resampled or recompressed on the way

## Why some stages run in the browser

Scanning, background removal and extraction happen in `client/js/extract.js`.
That is not an accident of history. The kiosk has to put the boat on the wall in
the time a child takes to look up, and a round trip to the server before anything
appeared would be felt in the room. The browser extracts; the server receives the
result.

The server-side `background` and `artwork` stages therefore verify rather than
repeat. `background` records whether the image carries a silhouette in its alpha
channel; `artwork` asserts the pixels are exactly as drawn.

Recording rather than insisting, because the alpha requirement is not everyone's.
`depth` cannot work without it — a height field built from an opaque rectangle
would model the rectangle — so `depth` is where the requirement lives. A plugin
sending the image to an image-to-3D service does not need alpha, and a session
that produced no separate extraction falls back to the photograph of the page,
which never has any. Refusing early would take both of those down for a rule that
belongs to one stage.

If that work ever needs to move to the server — a headless batch run, say — it
moves into those two files, behind the same interface, and nothing downstream
changes.

## What background removal actually removes

Extraction happens in the browser and mostly works. Measured across the scans on
disk, two things survive it, and those two are what the server-side stage clears:

- **Printed corner markers.** Three near-identical dark blocks of about 147x105
  pixels in three corners of a 1080x744 page - together an eighth of everything
  opaque in the image. The scanner discards a piece lying wholly inside its corner
  zone at 0.14 of the page; these overshoot it by around twenty pixels and come
  through. The server repeats the rule a little wider, at 0.2.
- **Specks.** Dust and grain that survived as their own tiny pieces.

Nothing else. There is no fold remover and no border remover, because no scan
showed either - the adaptive threshold upstream judges ink against the paper
immediately around it, which is what a fold's soft shadow fails, and no piece in
any scan reaches the image border. A filter written against a fault nobody has
seen is how a child's drawing gets deleted.

Three things keep it safe:

- **The largest piece is never removed**, whatever else is true of it. A child who
  draws small, in a corner, has drawn a picture that is wholly inside a corner.
- **Wholly** is the word doing the work. A drawing that merely reaches towards a
  corner has a bounding box that leaves it again. On one real sketch a 17x45 strip
  remains in a corner zone: it carries on into the page, and it is drawing.
- **Only alpha is touched.** Every surviving pixel keeps exactly the RGB it came
  in with - verified across five real sketches, zero recoloured. A page with
  nothing to remove is not even re-encoded; the exact bytes off the scanner are
  passed on.

Removed: 10.2% and 9.1% of the opaque area on the two marker-bearing scans, 0.0
to 0.6% on the rest.

## The interfaces

Written out in full, with types, in `server/pipeline3d/contract.js`.

| Type | Made by | What it is |
|---|---|---|
| `Sheet` | the scanner | the photograph, background and all |
| `Cutout` | `background` | the drawing, with a silhouette in its alpha |
| `Artwork` | `artwork` | lines, colours and handwriting, exactly as drawn |
| `DepthField` | `depth` | how far each point stands off the page |
| `Mesh` | `mesh` | geometry, with UVs indexing the artwork |
| `Texture` | `texture` | the artwork prepared as a texture |
| `Model` | `glb` | a finished GLB |

Every stage exports the same shape:

```js
module.exports = {
  name: 'depth',
  takes: 'Artwork',        // the type it needs
  gives: 'DepthField',     // the type it returns
  placeholder: true,       // while it is architecture only (only `glb` now)
  async run(input, context) { /* ... */ },
};
```

A stage knows nothing about who calls it or what runs next. `index.js` is the
only file that knows the order.

## Returning nothing is a normal answer

A stage that returns `null` has said "not this time". Every placeholder does it,
which is what lets the pipeline be wired up and run end to end before depth or
mesh generation exist.

Stages are matched by what they *take*, not run in a blind sequence. A stage runs
when the thing it needs exists; where it does not, the stage is skipped and the
reason is recorded — which is what let the pipeline run end to end while depth
and mesh were still unwritten, and what keeps it running if a stage ever returns
nothing again.

Every stage is now built, so a run ends with a GLB. Where one does not, the run
says which stage it stopped at and the kiosk carries on with the boat the browser
already built. Returning null is never an error. Throwing is, and a throw is not
swallowed: it is logged with the stage that raised it and re-thrown.

The exporter is the one stage that needs two things at once — geometry and a
texture — and a stage is handed only what it declares. It reads the texture from
`context.made`, which is the runner's own record of what exists so far.

## Depth and mesh

`depth` is a distance transform. For each pixel inside the silhouette, how far is
the nearest pixel outside it — so the middle of a shape stands proudest and the
rim lies flat on the page. It asks only "how far in is this", which every drawing
can answer, so a boat, a flower, a house and a dog all inflate sensibly without
any of them having been recognised first. A chamfer approximation, two passes,
within about two percent of the true distance.

`mesh` turns that into a closed solid: a surface over the front, the same
mirrored behind, and a band of quads round the outline joining them.

The band is the part worth knowing about. Welding the two sheets to a single line
of vertices at the rim looks simpler and is wrong — two rim vertices can be
neighbours across an edge that is on nobody's boundary, and welding hands that
edge two front triangles and two back ones. Four triangles to an edge is not a
surface. With a band, every edge in the mesh belongs to exactly two triangles in
opposite directions, which is what watertight means and what the tests measure:
closed, manifold, and consistently wound, on five different shapes.

Proportions come from the drawing. The model spans what was *drawn*, not the page
it was drawn on, and the scale is the same in both directions — a 400×110 shape
on a 400×200 page gives a model 3.7:1, not 2:1. It is then translated so its own
middle is the origin, which is a rigid move and changes no distance or ratio.

Resolution is `MESH_GRID` (default 128, along the longer edge), with `MESH_FACES`
as a ceiling over it: where the two disagree the budget wins.

## Texture and export

The texture is the scan, byte for byte, embedded whole in the GLB. Not resampled
to a power of two, not recompressed smaller, not flattened onto white. Each of
those is defensible and each loses something — a pencil stroke thinned, a faint
green shifted, paper turned grey at the edge of a letter. `contract.js` checks
the bytes going in are the bytes extraction produced, so it cannot quietly stop
being true.

The material is **unlit** (`KHR_materials_unlit`), listed in
`extensionsRequired` rather than only `extensionsUsed`. A lit material hands
whatever opens the file permission to shade a child's colours, and a viewer that
cannot honour the extension should refuse to open the file rather than open it
wrong. `baseColorFactor` is white so nothing multiplies the drawing, the material
is double-sided, and `alphaMode` is `MASK` so the outline stays crisp.

Measured with a sheet of known colours put through the whole pipeline and read
back out of the rendered GLB — with a red ambient light and a blue lamp shining
on it, to prove the lighting cannot reach:

| on the paper | in the rendered GLB |
|---|---|
| `rgb(255, 255, 255)` white paper | `rgb(255, 255, 255)` |
| `rgb(200, 214, 202)` light green | `rgb(200, 214, 202)` |
| `rgb(201, 210, 226)` light blue | `rgb(201, 210, 226)` |
| `rgb(230, 205, 212)` light pink | `rgb(230, 205, 212)` |
| `rgb(30, 30, 34)` ink | `rgb(30, 30, 34)` |

Every one off by zero.

### Two things the comparison caught

**UV origin.** glTF puts the origin of a texture at its *top left*, the same way
an image counts rows. The mesh was emitting `v = 1 - y/h`, which renders the
drawing upside down in anything that loads the GLB. It was invisible until then
because a viewer that builds geometry by hand usually flips textures on the way
in and quietly puts it back. Alignment against the artwork went from 55% to
98.6% when it was corrected.

**Which cells to emit.** A cell used to need all four corners inside the
silhouette, which shrinks the model by up to a cell all round. A wide shape
barely notices; a thin one does not survive — on a real scan the paddle shaft
disappeared and a drawing measuring 1.50:1 came back as a model measuring 3.01:1,
because only the hull was left. A cell is now emitted if *any* corner is inside.
Erring outward is safe precisely because the alpha cutout draws the outline: the
geometry can reach past the drawing and be trimmed back exactly, whereas geometry
that falls short takes part of the drawing with it. Aspect error 100% → 0.5%.

## Looking at it

`/preview` shows the drawing beside the model made from it. The model is the
exported GLB loaded back through `GLTFLoader` — not the geometry the server still
has in memory — so what is on screen is what a phone would get, including anything
the export got wrong. Development only: it does real work on request and lists
what visitors have drawn.

Both panels sit on white, because the paper is white and that is the honest
background for judging it. **Face on** squares the model to the camera so the two
can be read against each other without foreshortening in the way.

The wireframe is drawn without depth testing on purpose. Seeing the grid on the
near face proves nothing; it is the far face sliding the other way behind it that
says there are two surfaces with a thickness between them.

Measured on a real 915×631 scan: 9,304 triangles, a 915×631 texture, a 376 KB GLB
exported in 1–2 ms, 160 ms end to end. Turned edge-on the model is 0.219 wide
against 0.868 face-on — a flat sheet would vanish. Against the artwork: **98.6%
of the solidly drawn area lines up**, mean channel difference **3.19**, and of the
1,350 pixels that differ by more than 40, all but 10 are on a hard edge where a
cutout is entitled to land either side.

## Plugins are a bypass, not the pipeline

Replicate and Hugging Face Spaces can each turn a drawing into a GLB in one call.
That is useful and it is not this pipeline. One asks a model somewhere else to
make something resembling what a child drew; the other builds a model from the
drawing itself. Only the second can promise the colours on the wall are the
colours on the paper.

Where a plugin is configured it stands in for `depth`, `mesh` and `glb` together,
and those three are skipped. Background removal and extraction still run in front
of it, so what gets sent away is the drawing and not a photograph of a table.

```
MODEL3D_PROVIDER=replicate      # or huggingface; unset means the pipeline's own
```

The adapters live where they always did, in `server/models3d/`. Nothing is
configured by default.

## Running it

Nothing here is on a visitor's path. The boat reaches the wall from the browser
before the pipeline starts, so a slow stage costs a late arrival and a broken one
costs an animation — never a session.

Every stage logs a line:

```
[3d] a1b2c3d4 background: 915x631, silhouette in alpha (0ms)
[3d] a1b2c3d4 artwork: lines, colours and handwriting exactly as drawn (0ms)
[3d] a1b2c3d4 depth: 915x631, 19% drawn, deepest point 90px in (85ms)
[3d] a1b2c3d4 mesh: 5852 triangles from a 115x79 grid (11ms)
[3d] a1b2c3d4 texture: the drawing itself, 915x631, 119KB (0ms)
[3d] a1b2c3d4 glb: placeholder - nothing to export yet
```

and the startup log says what is wired up:

```
  3D pipeline:    6 stages (background -> artwork -> depth -> mesh -> texture -> glb),
                  glb not built yet - plugin: none
```

## What is deliberately not here

Animation, and putting the exported model on the wall.

Every GLB the pipeline builds is written to `generated/models/`, but the display
is only *told* about one when `MESH_PUBLISH=true`. Announcing a model swaps the
wall from the boat the browser inflates to the one the server exported, and that
is a change to what an exhibition looks like rather than to what this pipeline
produces — it should be turned on deliberately, after somebody has looked at the
two side by side. A configured plugin is announced either way, since asking for
one is already that decision.

There is also a second, older answer to depth still in the tree.
`client/js/inflate.js` builds a height field in the browser and is what the wall
shows today. The two are not connected, and that is deliberate for now: the
browser one puts a boat on the wall in the time a child looks up, and the server
one buys a GLB that can be downloaded and kept. Merging them is a decision for
whenever the exporter lands.
