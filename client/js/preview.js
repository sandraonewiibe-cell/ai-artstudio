import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The drawing beside the model made from it.
 *
 * The GLB is loaded back through GLTFLoader rather than built from the geometry
 * the server still has in memory. That matters: what is on screen is then what a
 * phone would get, including anything the export got wrong. A preview built from
 * the in-memory mesh would happily show a model whose exported file was broken.
 *
 * Nothing in this scene lights the model. The material is unlit, so the colours
 * on screen are the colours in the file - which is the whole claim being made,
 * and it would be a poor way to test it if the viewer could tint the answer.
 */

const stage = document.getElementById('stage');
const pick = document.getElementById('pick');
const status = document.getElementById('status');
const stats = document.getElementById('stats');
const timing = document.getElementById('timing');
const source = document.getElementById('source');

const buttons = {
  wire: document.getElementById('wire'),
  spin: document.getElementById('spin'),
  flat: document.getElementById('flat'),
};

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;

const group = new THREE.Group();
scene.add(group);

let wireframe = null;
let spinning = true;

function resize() {
  const { clientWidth: w, clientHeight: h } = stage;
  if (!w || !h) return;

  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(stage);

const loader = new GLTFLoader();

/** Loads the exported file and puts it on screen. */
async function showGlb(url) {
  const gltf = await loader.loadAsync(url);

  group.clear();
  wireframe = null;

  group.add(gltf.scene);

  // The grid over the top, for checking the geometry is still a solid. Not depth
  // tested, so the far side of it shows through the near side.
  gltf.scene.traverse((child) => {
    if (!child.isMesh || wireframe) return;

    wireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(child.geometry),
      new THREE.LineBasicMaterial({ color: 0x1b7fd0, transparent: true, opacity: 0.3, depthTest: false })
    );

    child.add(wireframe);
  });

  frame(gltf.scene);
  apply();

  return gltf;
}

/** Puts the camera where the whole model is in shot. */
function frame(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y) / 2;

  const distance = (radius * 1.25) / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(0, 0, distance);
  camera.near = distance / 100;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();
}

function apply() {
  if (wireframe) wireframe.visible = buttons.wire.getAttribute('aria-pressed') === 'true';
  spinning = buttons.spin.getAttribute('aria-pressed') === 'true';

  // Face on: square to the camera, so the render can be read against the
  // drawing next to it without any foreshortening in the way.
  if (buttons.flat.getAttribute('aria-pressed') === 'true') {
    buttons.spin.setAttribute('aria-pressed', 'false');
    spinning = false;
    group.rotation.set(0, 0, 0);
    camera.position.set(0, 0, camera.position.length());
    controls.target.set(0, 0, 0);
    controls.update();
  }
}

Object.values(buttons).forEach((button) => {
  button.addEventListener('click', () => {
    button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    apply();
  });
});

const number = (value) => value.toLocaleString('en-GB');

function report(data) {
  stats.innerHTML = '';
  timing.innerHTML = '';

  const rows = [
    ['Texture', `${data.stats.textureWidth} x ${data.stats.textureHeight}`],
    ['Vertices', number(data.stats.vertices)],
    ['Triangles', number(data.stats.triangles)],
    ['GLB size', `${Math.round(data.stats.glbBytes / 1024)} KB`],
    ['Export', `${data.stats.exportMs} ms`],
    ['Total', `${data.stats.totalMs} ms`],
    ['Grid', String(data.stats.grid)],
  ];

  for (const [name, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = value;
    stats.append(dt, dd);
  }

  for (const entry of data.stats.stages) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = entry.stage;
    const ms = document.createElement('span');
    ms.textContent = `${entry.ms} ms`;
    li.append(name, ms);
    timing.appendChild(li);
  }
}

async function load(name) {
  status.textContent = 'building...';
  status.classList.remove('error');

  try {
    const response = await fetch(`/api/preview/mesh/${encodeURIComponent(name)}`);
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (!data.glb) throw new Error('the pipeline built a mesh but exported no GLB');

    source.src = data.drawing;
    report(data);
    await showGlb(data.glb);

    status.textContent =
      `${Math.round(data.stats.glbBytes / 1024)}KB GLB, ` +
      `${number(data.stats.triangles)} triangles, ${data.stats.totalMs}ms`;
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('error');
  }
}

async function start() {
  resize();

  const response = await fetch('/api/preview/drawings');
  const { drawings } = await response.json();

  if (!drawings || !drawings.length) {
    status.textContent = 'No scanned drawings on disk yet - scan one and come back.';
    status.classList.add('error');
    return;
  }

  for (const drawing of drawings) {
    const option = document.createElement('option');
    option.value = drawing.name;
    option.textContent = `${drawing.name.slice(0, 24)}  (${Math.round(drawing.size / 1024)}KB)`;
    pick.appendChild(option);
  }

  pick.addEventListener('change', () => load(pick.value));
  await load(drawings[0].name);
}

renderer.setAnimationLoop(() => {
  if (spinning) group.rotation.y += 0.006;
  controls.update();
  renderer.render(scene, camera);
});

start();
