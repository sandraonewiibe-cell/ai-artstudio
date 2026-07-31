import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { GLB, PADDLES } from './config.js';
import { rig, pose } from './animate.js';

/**
 * Renders the GLB the 3D pipeline made from the visitor's sketch.
 *
 * It draws to its own canvas, never to the page. The stage composites that
 * canvas into the 2D one it already uses for everything else, which is what
 * keeps a single picture: the wall, the recording the visitor downloads, the
 * ripples, the splashes, the logos and the advertisements all stay in one
 * frame, and none of the code that draws them had to learn about WebGL.
 *
 * Nothing here touches the model's materials. The whole point of the pipeline
 * is that the boat is the visitor's drawing, so whatever texture, colour and
 * lettering came back on the mesh is what gets shown - this only lights it.
 *
 * One renderer for the life of the page. Building a WebGL context per visitor
 * leaks them until the browser starts refusing to make more.
 */

/** Parsed models, by URL. A rescan or a second showing costs nothing. */
const cache = new Map();
const loading = new Map();
const CACHE_LIMIT = 8;

let loader = null;

export class BoatGL {
  /**
   * @returns {BoatGL|null} null when WebGL is unavailable, which is a normal
   *   answer - the wall falls back to the flat boat.
   */
  static create() {
    if (!GLB.enabled) return null;

    try {
      return new BoatGL();
    } catch (err) {
      console.error(`[3d] FAILED at renderer: WebGL unavailable - ${err.message}`);
      return null;
    }
  }

  constructor() {
    const size = GLB.size;

    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });

    // Fixed size and pixel ratio: this canvas is composited into a 1920x1080
    // stage, so the screen's own density is irrelevant and following it would
    // quadruple the fill rate on a retina laptop for nothing.
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.setClearAlpha(0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = GLB.exposure;

    this.scene = new THREE.Scene();

    // Reflections come from an environment map rather than from rendering the
    // scene twice. Generated once at startup and kept.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = GLB.envIntensity;
    pmrem.dispose();

    const sun = new THREE.DirectionalLight(0xffffff, GLB.sunIntensity);
    sun.position.set(...GLB.sun);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    this.camera = new THREE.PerspectiveCamera(GLB.fieldOfView, 1, 0.1, 100);
    this.camera.position.set(0, 0, GLB.distance);
    this.camera.lookAt(0, 0, 0);

    // Everything is hung off this, so posing the boat is three numbers rather
    // than a walk over the model's own hierarchy.
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.model = null;
  }

  /** True once there is something to draw. */
  get ready() {
    return Boolean(this.model);
  }

  /**
   * Puts a loaded model on the pivot, taking the previous one off.
   *
   * The model is not disposed - it is in the cache, and a visitor rescanning
   * their sheet should not pay to parse it again.
   */
  show(scene) {
    if (this.model === scene) return;

    if (this.model) this.pivot.remove(this.model);
    this.model = scene || null;
    this.rigging = null;

    if (!this.model) return;

    this.pivot.add(this.model);

    // Rigged the first time it is shown and remembered after that. If it cannot
    // be rigged, it is simply shown still - the model is on the wall either way.
    this.rigging = rig(this.model);
  }

  clear() {
    this.show(null);
  }

  /**
   * Gets a model ready without showing it.
   *
   * Rigs it and compiles its shaders now, while it is still only an
   * announcement, rather than at the moment it goes on the wall. Measured: the
   * first frame of a model cost 35ms against 0.4ms for every frame after it -
   * a stutter, and precisely at the moment somebody is looking at the swap.
   */
  warm(scene) {
    if (!scene) return;

    this.pivot.add(scene);
    rig(scene);

    try {
      this.renderer.compile(this.scene, this.camera);

      // ...and then actually draw it once, into a canvas nobody is looking at.
      //
      // Compiling the shaders is not the expensive part. Measured, the first
      // render of a model costs about 35ms and every one after it costs 0.4ms -
      // the driver uploading textures and setting up buffers on first use, none
      // of which compile() does. Spending it here, while the model is still an
      // announcement, is the difference between a stutter as the boat changes
      // and no stutter at all.
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      // Nothing to do about it here; showing it will simply pay the cost.
      console.warn('[glb] could not warm the model up:', err.message);
    }

    this.pivot.remove(scene);
  }

  /**
   * Rides the water.
   *
   * The stage has already worked out what the surface is doing under the hull -
   * how far it has lifted and how it is sloping - so the same numbers that bend
   * the flat boat pose this one. Heave up and down, roll with the slope, and a
   * slow nod on top so it is never rigid.
   */
  render({ heave, roll, elapsed }) {
    if (!this.model) return;

    const nod =
      Math.sin((elapsed / GLB.nodPeriodMs) * Math.PI * 2) * ((GLB.nodDegrees * Math.PI) / 180);

    this.pivot.position.y = heave;
    this.pivot.rotation.set(nod, GLB.baseYaw, roll * GLB.roll);

    // The paddles run on the same clock as the splashes, so a blade is entering
    // the water at the moment the water answers it.
    pose(this.rigging, {
      stroke: (elapsed / PADDLES.stroke.periodMs) * Math.PI * 2,
      elapsed,
    });

    this.renderer.render(this.scene, this.camera);
  }

  /** Where the water meets this model, as the rigging measured it. */
  get waterline() {
    return this.rigging ? this.rigging.waterline : 0;
  }
}

/**
 * Fetches and parses a GLB, or hands back the one already parsed.
 *
 * Loading is shared: two callers asking for the same model at the same moment -
 * the preload when it is announced, and the show when it plays - wait on one
 * parse rather than starting two.
 *
 * @param {string} url
 * @returns {Promise<THREE.Object3D|null>} null if it could not be used, which
 *   the caller treats as "no model" rather than as a failure.
 */
export async function loadModel(url) {
  if (!url || !GLB.enabled) return null;
  if (cache.has(url)) return cache.get(url);
  if (loading.has(url)) return loading.get(url);

  if (!loader) loader = new GLTFLoader();

  console.log(`[3d] downloading ${url}`);
  const started = performance.now();

  const parse = loader
    .loadAsync(url)
    .then((gltf) => {
      const model = frame(gltf.scene);
      remember(url, model);

      let meshes = 0;
      let triangles = 0;
      model.traverse((node) => {
        if (!node.isMesh || !node.geometry) return;
        meshes += 1;
        const index = node.geometry.index;
        const position = node.geometry.attributes.position;
        triangles += (index ? index.count : position ? position.count : 0) / 3;
      });

      console.log(
        `[3d] parsed ${url} in ${Math.round(performance.now() - started)}ms ` +
          `(${meshes} mesh(es), ${Math.round(triangles)} triangles)`
      );

      return model;
    })
    .catch((err) => {
      console.error(`[3d] FAILED at parse: ${url} - ${err.message}`);
      return null;
    });

  // A load that never settles is worse than one that fails: the caller is left
  // awaiting it forever, and on an unattended wall nobody is going to notice.
  // Whatever the loader is doing, this answers.
  const work = Promise.race([parse, after(GLB.loadTimeoutMs, url)]).finally(() =>
    loading.delete(url)
  );

  loading.set(url, work);
  return work;
}

/** Loads it now so that showing it later is instant. */
export function preload(url) {
  return loadModel(url);
}

/** Gives up after a while, with "no model" rather than with nothing. */
function after(ms, url) {
  return new Promise((resolve) => {
    setTimeout(() => {
      console.warn(`[glb] gave up waiting for ${url} after ${Math.round(ms / 1000)}s`);
      resolve(null);
    }, ms);
  });
}

/**
 * Centres a model on the origin and scales it to a known size.
 *
 * A generated mesh arrives at whatever scale and offset the model felt like, so
 * without this the boat is as likely to be a speck as to fill the screen. The
 * shape itself is untouched - it is moved and scaled as one, so what the
 * visitor drew keeps its proportions exactly.
 */
function frame(scene) {
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return scene;

  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z) || 1;

  scene.position.sub(centre);

  const holder = new THREE.Group();
  holder.add(scene);
  holder.scale.setScalar(1 / largest);

  return holder;
}

function remember(url, model) {
  cache.set(url, model);

  // An exhibition runs all day; the parsed meshes of every visitor since
  // opening are not worth the memory.
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    dispose(cache.get(oldest));
    cache.delete(oldest);
  }
}

/** Gives a model's geometry and textures back to the GPU. */
function dispose(model) {
  if (!model) return;

  model.traverse((node) => {
    if (node.geometry) node.geometry.dispose();

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.filter(Boolean).forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value && value.isTexture) value.dispose();
      });
      material.dispose();
    });
  });
}
