import * as THREE from 'three';

import { ANIMATE, PADDLES } from './config.js';

/**
 * Makes a generated boat move, without taking it apart.
 *
 * The mesh is left exactly as it arrived - one object, one set of materials,
 * every triangle where the file put it. What moves is the *drawing* of it: each
 * material's vertex shader is given a few lines that displace vertices as they
 * are drawn. Nothing is cut, nothing is separated, and reading the geometry back
 * would find it unchanged.
 *
 * There are two motions. Vertices far out from the centreline sweep fore and
 * aft, opposite sides opposite ways, which is what an oar does; and the whole
 * hull bends gently along its length, which is what a boat does in a swell.
 * Both are driven from the same stroke clock the splashes use, so a blade is
 * entering the water at the moment the water answers.
 *
 * All of it is on the GPU. A generated boat is on the order of a hundred
 * thousand vertices, and moving them from JavaScript sixty times a second would
 * cost more than the rest of the frame put together. Here the per-frame cost is
 * setting half a dozen numbers.
 */

/** Rigged models, so a rescan or a second crossing pays nothing. */
const rigged = new WeakMap();

const CHUNK = `
  uniform float uStroke;
  uniform float uFlexPhase;
  uniform vec3  uForward;
  uniform vec3  uSide;
  uniform float uHalfLength;
  uniform float uHalfWidth;
  uniform float uSwingStart;
  uniform float uSweep;
  uniform float uDip;
  uniform float uSideLag;
  uniform float uFlex;
  uniform float uCatch;
  uniform float uWaterline;
  uniform float uReach;
  uniform mat4  uBoatFromLocal;
  uniform mat4  uLocalFromBoat;
`;

const BODY = `
  vec3 boat = (uBoatFromLocal * vec4(position, 1.0)).xyz;

  float along   = clamp(dot(boat, uForward) / uHalfLength, -1.0, 1.0);
  float lateral = dot(boat, uSide) / uHalfWidth;

  // How much of a paddle this vertex is. Two things have to be true: it has to
  // be well out from the centreline, and it has to be down near the water.
  //
  // The second matters more than it sounds. A snake boat's stern rises twenty
  // feet, and a canopy stands well clear of the water - without a height test
  // both of them are "out from the centre" and both would paddle. The waterline
  // was already being measured for exactly this and was not being used.
  float outboard = smoothstep(uSwingStart, 1.0, abs(lateral));
  float above = max(0.0, (boat.y - uWaterline) / uHalfLength);
  float atTheWater = 1.0 - smoothstep(0.0, uReach, above);

  float blade = outboard * atTheWater;

  // The crew stroke together. On a chundan vallam every paddler pulls on the
  // same beat - the whole point of the vanchipattu is that they do - so the two
  // sides are in unison unless someone sets uSideLag deliberately.
  float phase = uStroke + (lateral < 0.0 ? uSideLag : 0.0) - uCatch;

  // Quadrature, so the blade travels an ellipse: down and back through the
  // water, up and forward on the recovery. Offset by uCatch so the deepest
  // point of that ellipse is the instant the splash is thrown - they were a
  // quarter of a stroke apart, and the water answered a paddle that was
  // already on its way back up.
  boat += uForward * (sin(phase) * uSweep * uHalfLength * blade);
  boat.y -= cos(phase) * uDip * uHalfLength * blade;

  // The hull working: the ends rise and fall against the middle.
  boat.y += sin(uFlexPhase + along * 3.14159265) * uFlex * uHalfLength;

  vec3 transformed = (uLocalFromBoat * vec4(boat, 1.0)).xyz;
`;

/**
 * Works out which way the boat faces and where it sits in the water, then
 * patches its materials so it moves.
 *
 * @param {THREE.Object3D} model
 * @returns {{uniforms: object, forward: THREE.Vector3, waterline: number}|null}
 *   null when the model cannot be rigged, which the caller treats as "show it
 *   as it is" rather than as a failure.
 */
export function rig(model) {
  if (!ANIMATE.enabled || !model) return null;
  if (rigged.has(model)) return rigged.get(model);

  try {
    const shape = measure(model);
    if (!shape) return null;

    const uniforms = {
      uStroke: { value: 0 },
      uFlexPhase: { value: 0 },
      uForward: { value: shape.forward },
      uSide: { value: shape.side },
      uHalfLength: { value: shape.halfLength },
      uHalfWidth: { value: shape.halfWidth },
      uSwingStart: { value: ANIMATE.swingStart },
      uSweep: { value: ANIMATE.sweep },
      uDip: { value: ANIMATE.dip },
      uSideLag: { value: ANIMATE.sideLag },
      uFlex: { value: ANIMATE.flex },

      // Where in the stroke the blade is deepest. The same number the splash
      // fires on, so the two cannot drift apart.
      uCatch: { value: PADDLES.stroke.catchPhase * Math.PI * 2 },

      uWaterline: { value: shape.waterline },
      uReach: { value: ANIMATE.reachAboveWater },
    };

    let patched = 0;
    model.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      patched += patch(node, model, uniforms);
    });

    if (!patched) return null;

    const result = { uniforms, forward: shape.forward, waterline: shape.waterline, meshes: patched };
    rigged.set(model, result);

    console.log(
      `[animate] rigged ${patched} mesh(es); length axis ${shape.axis}, ` +
        `waterline ${shape.waterline.toFixed(3)}`
    );

    return result;
  } catch (err) {
    console.warn('[animate] could not rig the model, showing it still:', err.message);
    return null;
  }
}

/** Advances the clocks. Called once a frame; costs nothing. */
export function pose(rigging, { stroke, elapsed }) {
  if (!rigging) return;

  rigging.uniforms.uStroke.value = stroke;
  rigging.uniforms.uFlexPhase.value = (elapsed / ANIMATE.flexPeriodMs) * Math.PI * 2;
}

/**
 * Which way is along the boat, how wide it is, and where the water meets it.
 *
 * The obvious test - whichever horizontal side of the bounding box is longer -
 * is wrong on exactly the boat this is for. A rowing boat with its oars out is
 * wider across the oars than it is long, so the box says the beam is the
 * length and the whole thing rows sideways.
 *
 * The hull is asked instead of the box. Oars are a few vertices reaching a long
 * way; the hull is most of the vertices in the model. Throwing away the
 * outermost few per cent at each end therefore throws away the oars and leaves
 * the hull, and the hull is longer than it is wide - which is the thing that
 * was true all along.
 *
 * It assumes vertices are spread fairly evenly over the surface, which is what
 * comes out of the marching-cubes step in every image-to-3D model of this kind.
 */
function measure(model) {
  model.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return null;

  const points = sample(model);
  if (!points.length) return null;

  const hullX = middleSpread(points, 0);
  const hullZ = middleSpread(points, 2);
  const lengthwiseX = hullX >= hullZ;

  const size = box.getSize(new THREE.Vector3());

  const forward = lengthwiseX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  const side = lengthwiseX ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);

  // Measured off the whole model, not the trimmed hull: the sweep has to reach
  // the actual tips of the actual oars.
  const halfLength = Math.max(1e-4, (lengthwiseX ? size.x : size.z) / 2);
  const halfWidth = Math.max(1e-4, (lengthwiseX ? size.z : size.x) / 2);

  return {
    forward,
    side,
    halfLength,
    halfWidth,
    axis: lengthwiseX ? 'x' : 'z',
    hullLength: lengthwiseX ? hullX : hullZ,
    waterline: widest(points, side, size.y, box.min.y),
  };
}

/**
 * A few thousand vertices in the model's own frame.
 *
 * Sampled rather than exhaustive - a few thousand find the shape as well as a
 * hundred thousand - and taken once, because both the direction and the
 * waterline are read off the same points. Runs while a model is being prepared,
 * never while one is on screen.
 *
 * @returns {Float32Array} x, y, z, x, y, z...
 */
function sample(model) {
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const point = new THREE.Vector3();

  const meshes = [];
  model.traverse((node) => {
    if (node.isMesh && node.geometry && node.geometry.attributes.position) meshes.push(node);
  });

  const total = meshes.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  if (!total) return new Float32Array(0);

  const stride = Math.max(1, Math.floor(total / ANIMATE.waterlineSamples));
  const out = [];

  meshes.forEach((mesh) => {
    local.multiplyMatrices(toModel, mesh.matrixWorld);
    const positions = mesh.geometry.attributes.position;

    for (let i = 0; i < positions.count; i += stride) {
      point.fromBufferAttribute(positions, i).applyMatrix4(local);
      out.push(point.x, point.y, point.z);
    }
  });

  return Float32Array.from(out);
}

/**
 * How far the bulk of the model reaches along one axis.
 *
 * The outermost few per cent at each end are dropped, which is what removes an
 * oar, a bowsprit or a flagpole from the reckoning and leaves the body of the
 * boat.
 */
function middleSpread(points, offset) {
  const values = new Float64Array(points.length / 3);
  for (let i = 0, at = offset; i < values.length; i += 1, at += 3) values[i] = points[at];

  values.sort();

  const trim = Math.floor(values.length * 0.05);
  const low = values[trim];
  const high = values[values.length - 1 - trim];

  return Math.abs(high - low);
}

/**
 * The height at which the hull is widest.
 *
 * On any boat shape that is at or near the sheer, which is where the water
 * meets it. Where several heights are equally wide - a barge, or a hull drawn
 * with straight sides - the middle of that band is taken rather than the first
 * of them, so a flat-sided boat does not end up with its waterline on the keel.
 */
function widest(points, side, height, floor) {
  const BINS = 24;
  const spread = new Float32Array(BINS);
  const point = new THREE.Vector3();

  for (let i = 0; i < points.length; i += 3) {
    point.set(points[i], points[i + 1], points[i + 2]);

    const bin = Math.min(BINS - 1, Math.max(0, Math.floor(((point.y - floor) / height) * BINS)));
    const out = Math.abs(point.dot(side));
    if (out > spread[bin]) spread[bin] = out;
  }

  let widestSpread = 0;
  for (let i = 0; i < BINS; i += 1) if (spread[i] > widestSpread) widestSpread = spread[i];
  if (!widestSpread) return floor + height / 2;

  // Every band within a whisker of the widest counts as the same band.
  let first = -1;
  let last = -1;
  for (let i = 0; i < BINS; i += 1) {
    if (spread[i] < widestSpread * 0.98) continue;
    if (first < 0) first = i;
    last = i;
  }

  return floor + (((first + last) / 2 + 0.5) / BINS) * height;
}

/**
 * Threads the animation into one mesh's materials.
 *
 * Each mesh sits somewhere of its own inside the model, so it is given the pair
 * of matrices that take its vertices into the boat's frame and back again. The
 * displacement is worked out in the boat's frame, where "along" and "outboard"
 * mean something, and the result is handed back in the mesh's own.
 *
 * @returns {number} 1 if anything was patched
 */
function patch(mesh, model, uniforms) {
  const boatFromLocal = new THREE.Matrix4()
    .copy(model.matrixWorld)
    .invert()
    .multiply(mesh.matrixWorld);

  const localFromBoat = new THREE.Matrix4().copy(boatFromLocal).invert();

  const shared = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const own = shared.filter(Boolean).map((material) => {
    /**
     * One material per mesh, even where the file shares them.
     *
     * The displacement is worked out in the boat's frame, and the matrices that
     * get there are different for every mesh. A material shared between the
     * hull and the oars can only hold one pair of them, so whichever mesh was
     * patched first would impose its own frame on all the others and the oars
     * would sweep from the wrong place - which is exactly what a generated boat
     * does, because an exporter gives the whole model one material.
     *
     * Cloning shares the textures, so this costs a material rather than a copy
     * of the visitor's drawing, and the program is shared too because the cache
     * key below is the same for all of them.
     */
    const mine = material.userData.boatRigged ? material.clone() : material;
    mine.userData.boatRigged = true;

    mine.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, {
        uBoatFromLocal: { value: boatFromLocal },
        uLocalFromBoat: { value: localFromBoat },
      });

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${CHUNK}`)
        .replace('#include <begin_vertex>', BODY);
    };

    // Without this, three reuses a compiled program from an unpatched material
    // with the same settings and none of the above ever runs.
    mine.customProgramCacheKey = () => 'ai-art-studio/rowing';
    mine.needsUpdate = true;

    return mine;
  });

  if (!own.length) return 0;

  mesh.material = Array.isArray(mesh.material) ? own : own[0];
  return 1;
}
