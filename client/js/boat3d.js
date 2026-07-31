import { MODEL3D } from './config.js';
import { buildHeightField, buildMesh } from './inflate.js';

/**
 * Renders the inflated drawing as a lit 3D solid.
 *
 * Raw WebGL rather than a library: the whole job is one textured mesh with one
 * light, which is a couple of hundred lines and no dependency to vendor.
 *
 * It draws to its own canvas with a transparent background, which the display
 * then composites over the background video. That keeps the 2D stage - ripples,
 * name, reflection - exactly as it was, and means the recording still captures
 * everything, since it records the 2D canvas.
 *
 * Returns null from create() when WebGL is unavailable, and the display falls
 * back to the flat wave-warped drawing.
 */

const VERTEX_SHADER = `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  attribute vec2 aUv;

  uniform mat4 uModel;
  uniform mat4 uProjection;

  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    vUv = aUv;
    // No non-uniform scaling, so the model matrix serves for normals too.
    vNormal = normalize(mat3(uModel) * aNormal);
    gl_Position = uProjection * uModel * vec4(aPosition, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;

  uniform sampler2D uTexture;
  uniform vec3 uLight;
  uniform float uRelief;

  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    vec4 colour = texture2D(uTexture, vUv);

    // The drawing is transparent outside the shape; drop those fragments so the
    // silhouette stays exactly as drawn and the depth buffer stays honest.
    if (colour.a < 0.5) discard;

    // Two-sided: the far shell is lit by the same lamp from behind.
    vec3 normal = gl_FrontFacing ? vNormal : -vNormal;
    float diffuse = max(dot(normal, normalize(uLight)), 0.0);

    // Shading sits either side of the drawing rather than underneath it.
    //
    // This used to be a plain multiply by an ambient-to-one term, which meant
    // every fragment facing away from the lamp was scaled towards black: white
    // paper came out mid grey and a light green pencil came out slate. The
    // child's colour was being darkened by the lighting model, not by anything
    // on the page.
    //
    // The lamp can only lift, never darken. Nothing the lighting does may make
    // a colour darker than the child drew it - that is the whole fault this
    // replaced - so the drawing is the floor, and a lit face rises off it
    // towards the light. A face turned away is simply the drawing, untouched.
    //
    // Form comes from the gradient between the two, from the silhouette, and
    // from the whole hull rocking on the water. None of that needs the artwork
    // painted over to work.
    //
    // Towards white rather than up in value, so a bright area cannot clip to a
    // flat highlight and lose the pencil texture in it.
    vec3 shaded = mix(colour.rgb, vec3(1.0), uRelief * diffuse);

    gl_FragColor = vec4(shaded, colour.a);
  }
`;

export class Boat3D {
  /**
   * @param {number} width canvas size, matched to the area the boat occupies
   * @param {number} height
   */
  static create(width, height) {
    // Everything here is wrapped: no WebGL, a refused context, a driver that
    // will not compile the shaders - none of it should take the display down.
    // The flat wave-warped boat is a perfectly good fallback.
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const gl = canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: true,
        depth: true,
      });

      if (!gl) {
        console.warn('[boat3d] WebGL unavailable; showing the flat boat');
        return null;
      }

      return new Boat3D(canvas, gl);
    } catch (err) {
      console.warn('[boat3d] could not start WebGL; showing the flat boat:', err.message);
      return null;
    }
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;

    this.program = buildProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);

    this.attributes = {
      position: gl.getAttribLocation(this.program, 'aPosition'),
      normal: gl.getAttribLocation(this.program, 'aNormal'),
      uv: gl.getAttribLocation(this.program, 'aUv'),
    };

    this.uniforms = {
      model: gl.getUniformLocation(this.program, 'uModel'),
      projection: gl.getUniformLocation(this.program, 'uProjection'),
      texture: gl.getUniformLocation(this.program, 'uTexture'),
      light: gl.getUniformLocation(this.program, 'uLight'),
      relief: gl.getUniformLocation(this.program, 'uRelief'),
    };

    this.buffers = {
      position: gl.createBuffer(),
      normal: gl.createBuffer(),
      uv: gl.createBuffer(),
      index: gl.createBuffer(),
    };

    this.texture = gl.createTexture();
    this.mesh = null;

    /**
     * Whether this context will accept 32-bit indices.
     *
     * WebGL1 will not, unless asked. Without this line the mesh uploads, the
     * draw call is made, no error is reported and nothing whatsoever appears -
     * which is exactly how this renderer behaved, and why it sat switched off.
     *
     * Where the extension is missing the indices are narrowed to 16-bit, which
     * every context supports and which is wide enough for any mesh this grid
     * produces.
     */
    this.wideIndices = Boolean(gl.getExtension('OES_element_index_uint'));
    this.indexType = this.wideIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Builds the model from a drawing. Slow enough to be worth doing once per
   * visitor rather than per frame - a few tens of milliseconds.
   *
   * @param {HTMLImageElement} image the extracted drawing
   * @returns {boolean} false if the drawing yielded no usable geometry
   */
  build(image) {
    const { gl } = this;

    // Read the drawing's alpha to find the silhouette.
    const reader = document.createElement('canvas');
    const scale = Math.min(1, MODEL3D.analysisWidth / image.width);
    reader.width = Math.max(8, Math.round(image.width * scale));
    reader.height = Math.max(8, Math.round(image.height * scale));

    const ctx = reader.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, reader.width, reader.height);

    const field = buildHeightField(ctx.getImageData(0, 0, reader.width, reader.height), {
      profile: MODEL3D.profile,
      hull: MODEL3D.hull,
    });

    if (!field.peak) return false;

    const mesh = buildMesh(field, {
      grid: MODEL3D.grid,
      thickness: MODEL3D.thickness,
    });

    if (!mesh.triangles) return false;
    this.mesh = mesh;

    upload(gl, this.buffers.position, mesh.positions);
    upload(gl, this.buffers.normal, mesh.normals);
    upload(gl, this.buffers.uv, mesh.uvs);

    // Narrowed where the context cannot take 32-bit indices. A vertex count
    // past what 16 bits can address would have to be refused rather than drawn
    // wrongly, but the grid does not produce meshes near that size.
    const vertices = mesh.positions.length / 3;
    if (!this.wideIndices && vertices > 65535) {
      console.warn(`[boat3d] ${vertices} vertices needs 32-bit indices, which this context lacks`);
      return false;
    }

    const indices = this.wideIndices ? mesh.indices : new Uint16Array(mesh.indices);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    // The drawing itself is the skin, so the boat keeps exactly what was drawn.
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.aspect = image.width / image.height;

    console.log(`[boat3d] ${mesh.triangles} triangles from a ${reader.width}x${reader.height} silhouette`);
    return true;
  }

  /**
   * Draws the model at a given attitude. Angles are radians.
   *
   * @param {{pitch?: number, roll?: number, yaw?: number}} pose
   */
  render(pose = {}) {
    const { gl, mesh } = this;
    if (!mesh) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);

    bind(gl, this.buffers.position, this.attributes.position, 3);
    bind(gl, this.buffers.normal, this.attributes.normal, 3);
    bind(gl, this.buffers.uv, this.attributes.uv, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.index);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.texture, 0);

    gl.uniform3fv(this.uniforms.light, MODEL3D.light);
    gl.uniform1f(this.uniforms.relief, MODEL3D.relief);

    const model = modelMatrix({
      pitch: pose.pitch || 0,
      roll: pose.roll || 0,
      yaw: (pose.yaw || 0) + MODEL3D.baseYaw,
      scale: MODEL3D.scale,
      z: -MODEL3D.distance,
    });

    const projection = perspective(
      MODEL3D.fieldOfView,
      this.canvas.width / this.canvas.height,
      0.1,
      100
    );

    gl.uniformMatrix4fv(this.uniforms.model, false, model);
    gl.uniformMatrix4fv(this.uniforms.projection, false, projection);

    gl.drawElements(gl.TRIANGLES, mesh.indices.length, this.indexType, 0);
  }

  dispose() {
    const { gl } = this;
    Object.values(this.buffers).forEach((buffer) => gl.deleteBuffer(buffer));
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
    this.mesh = null;
  }
}

// --- plumbing ---------------------------------------------------------------

function buildProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'shader link failed');
  }

  return program;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
  }

  return shader;
}

function upload(gl, buffer, data) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
}

function bind(gl, buffer, location, size) {
  if (location < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

/** Column-major 4x4: yaw, then pitch, then roll, scaled and pushed back. */
function modelMatrix({ pitch, roll, yaw, scale, z }) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);

  // R = Rz(roll) * Rx(pitch) * Ry(yaw)
  const m00 = cr * cy + sr * sp * sy;
  const m01 = sr * cp;
  const m02 = -cr * sy + sr * sp * cy;

  const m10 = -sr * cy + cr * sp * sy;
  const m11 = cr * cp;
  const m12 = sr * sy + cr * sp * cy;

  const m20 = cp * sy;
  const m21 = -sp;
  const m22 = cp * cy;

  return new Float32Array([
    m00 * scale, m10 * scale, m20 * scale, 0,
    m01 * scale, m11 * scale, m21 * scale, 0,
    m02 * scale, m12 * scale, m22 * scale, 0,
    0, 0, z, 1,
  ]);
}

function perspective(fovDegrees, aspect, near, far) {
  const f = 1 / Math.tan((fovDegrees * Math.PI) / 360);
  const range = 1 / (near - far);

  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (near + far) * range, -1,
    0, 0, near * far * range * 2, 0,
  ]);
}
