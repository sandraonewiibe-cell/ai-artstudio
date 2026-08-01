const config = require('../config');
const contract = require('./contract');
const { loadPlugin, describePlugin } = require('./plugins');

/**
 * The 3D pipeline.
 *
 *   Sheet -> background removal -> artwork -> depth -> mesh -> texture -> GLB
 *
 * Each stage is its own file under stages/, takes one thing and gives back
 * another, and knows nothing about who calls it or what runs next. This file is
 * the only place that knows the order.
 *
 * Stages are matched by what they take rather than run in a blind sequence. A
 * stage runs when the thing it needs exists; where it does not, the stage is
 * skipped and the reason is recorded. That is what lets a pipeline with two
 * placeholders in the middle of it still be run end to end and still do useful
 * work: depth returns nothing, so mesh and export are skipped for want of one,
 * and the texture mapper - which only ever needed the artwork - runs anyway and
 * is exercised on every visitor rather than waiting for a phase that has not
 * happened.
 *
 * Nothing here is on a visitor's path. The boat reaches the wall from the
 * browser before this starts, so a slow stage costs a late arrival and a broken
 * one costs an animation. Never a session.
 */

const STAGES = [
  require('./stages/background'),
  require('./stages/artwork'),
  require('./stages/depth'),
  require('./stages/mesh'),
  require('./stages/texture'),
  require('./stages/glb'),
].map((stage, i) => contract.assertStage(stage, stage && stage.name ? stage.name : `#${i}`));

// Which assertion guards each stage's output. Keeping them here rather than
// inside the stages means a stage cannot decline to be checked.
const GUARDS = {
  Cutout: (value, made, by) => contract.assertCutout(value, by),
  Artwork: (value, made, by) => contract.assertArtwork(value, made.Cutout, by),
  DepthField: (value, made, by) => contract.assertDepth(value, made.Artwork, by),
  Mesh: (value, made, by) => contract.assertMesh(value, by),
  Texture: (value, made, by) => contract.assertTexture(value, made.Artwork, by),
  Model: (value, made, by) => contract.assertModel(value, by),
};

/**
 * Runs the drawing through the pipeline.
 *
 * @param {{page: Buffer, drawing: Buffer, mime: string}} sheet
 * @param {{job: string, text: string|null, faces?: number, texture?: boolean}} options
 * @returns {Promise<{model: import('./contract').Model|null, mesh: import('./contract').Mesh|null, stages: object[], stoppedAt: string|null}>}
 */
async function run(sheet, options = {}) {
  const job = (options.job || '????????').slice(0, 8);
  const report = [];

  /** Everything made so far, by type. A stage's input is looked up here. */
  const made = { Sheet: sheet };

  const context = {
    job,
    text: options.text || null,
    faces: options.faces || config.mesh.faces,
    texture: options.texture !== undefined ? options.texture : config.mesh.texture,

    // Everything made so far, for the one stage that genuinely needs two things
    // at once: the exporter wants geometry and a texture, and a stage is handed
    // only what it declares. It is the same object the runner is filling in, so
    // a stage sees exactly what exists when it runs and nothing that does not.
    made,

    log: () => {},
  };

  const plugin = loadPlugin();

  for (const stage of STAGES) {
    const input = made[stage.takes];

    // The thing this stage needs was never made. Not an error: it is what
    // happens downstream of a placeholder, and saying so plainly is more use
    // than calling a stage that cannot work.
    if (input === undefined || input === null) {
      report.push({ stage: stage.name, skipped: true, why: `no ${stage.takes}` });
      console.log(`[3d] ${job} ${stage.name}: skipped, no ${stage.takes}`);
      continue;
    }

    // A plugin stands in for the middle of the pipeline. Where one is
    // configured, the stages that would have built the model are stood down in
    // favour of it - but background removal and extraction still run first, so
    // what gets sent away is the drawing rather than the photograph.
    if (plugin && ['depth', 'mesh', 'glb'].includes(stage.name)) {
      report.push({ stage: stage.name, skipped: true, why: `the ${plugin.name} plugin is doing this` });
      continue;
    }

    // Let go of the event loop before each stage.
    //
    // Every stage here is synchronous from start to finish - decoding a PNG,
    // walking a distance transform, building a mesh, deflating a texture - and
    // synchronous work on a single-threaded server is time nobody else gets.
    // Run back to back they were a third of a second in which the kiosk could
    // not be answered, arriving in the moment right after a scan, which is
    // exactly when the scanner is busiest.
    //
    // This does not make the work cheaper. It breaks it into pieces the loop can
    // get between, so a request waits for one stage rather than all six.
    await new Promise((resolve) => setImmediate(resolve));

    const started = Date.now();
    let said = '';
    context.log = (message) => { said = message; };

    let output;
    try {
      output = await stage.run(input, context);
      output = (GUARDS[stage.gives] || ((v) => v))(output, made, stage.name);
    } catch (err) {
      // Loudly. A stage that fails has found something wrong with the drawing
      // or with itself, and swallowing it here would leave a silent gap in a
      // pipeline whose whole job is to be inspectable.
      report.push({ stage: stage.name, failed: true, why: err.message });
      console.warn(`[3d] ${job} ${stage.name}: ${err.message}`);
      throw err;
    }

    const took = Date.now() - started;

    if (output === null) {
      report.push({ stage: stage.name, empty: true, placeholder: Boolean(stage.placeholder), why: said, ms: took });
      console.log(`[3d] ${job} ${stage.name}: ${stage.placeholder ? 'placeholder' : 'nothing'} - ${said}`);
      continue;
    }

    made[stage.gives] = output;
    report.push({ stage: stage.name, gave: stage.gives, why: said, ms: took });
    console.log(`[3d] ${job} ${stage.name}: ${said} (${took}ms)`);
  }

  // The plugin runs where the stages it replaced would have.
  if (plugin && made.Artwork) {
    const started = Date.now();

    const model = contract.assertModel(await plugin.generate(made.Artwork, context), plugin.name);
    const took = Date.now() - started;

    if (model) made.Model = model;
    report.push({ stage: `plugin:${plugin.name}`, gave: model ? 'Model' : null, ms: took });
    console.log(`[3d] ${job} plugin ${plugin.name}: ${model ? `${Math.round(model.buffer.length / 1024)}KB` : 'nothing'} (${took}ms)`);
  }

  const stoppedAt = made.Model ? null : firstGap(report);

  return {
    model: made.Model || null,
    mesh: made.Mesh || null,
    texture: made.Texture || null,
    stages: report,
    stoppedAt,
  };
}

/** The first stage that had nothing to give, which is why there is no model. */
function firstGap(report) {
  const gap = report.find((entry) => entry.empty || entry.failed);
  return gap ? gap.stage : null;
}

/** One line for the startup log. */
function describe() {
  const placeholders = STAGES.filter((s) => s.placeholder).map((s) => s.name);

  return (
    `${STAGES.length} stages (${STAGES.map((s) => s.name).join(' -> ')})` +
    `${placeholders.length ? `, ${placeholders.join(' and ')} not built yet` : ''}` +
    ` - plugin: ${describePlugin()}`
  );
}

module.exports = { run, describe, STAGES };
