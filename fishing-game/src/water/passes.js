// Off-screen passes the water needs each frame:
//  - planar reflection: the scene seen from the camera mirrored in y = 0 with an
//    oblique near plane on the water plane (everything below the surface is
//    clipped and culled), rendered at reduced resolution into a half-float target.
//    It draws layer 0 plus LAYERS.REFLECTION (cheap stand-ins such as a coarse
//    terrain proxy that only the mirror sees); the caller hides NO_REFLECT objects.
//    The raw image is then copied into the mipmapped target through a sanitising
//    pass (NaN -> neighbours, Inf -> a large finite value) BEFORE the mip chain is
//    built: a single broken texel otherwise spreads into a block at every mip level
//    (NaN on most GPUs, zero/black on some), which no lookup-side test can undo.
//  - depth pre-pass: only LAYERS.UNDERWATER objects (lake bed, fish, lures,
//    pilings, timber), untextured, depth only, at reduced resolution, and only
//    out to a limited range (its far plane culls distant lake-bed chunks). The
//    water shader turns it into the true water thickness in front of each pixel.
import * as THREE from 'three';
import { LAYERS, WATER_LEVEL } from '../config.js';

export function createPasses(renderer) {
  // ---- reflection ----------------------------------------------------------
  const reflCam = new THREE.PerspectiveCamera();
  reflCam.name = 'water-reflection-camera';
  const textureMatrix = new THREE.Matrix4();
  // x / y terms of the mirror projection (e0, e5, e8, e9; the oblique clip only
  // changes the z row): with reflCam.matrixWorld the water shader turns a mirror
  // texel back into its world ray.
  const reflProjXY = new THREE.Vector4(1, 1, 0, 0);
  let reflRT = null; // sanitised, mipmapped: what the water samples
  let rawRT = null; // the mirror render itself (+ its depth texture)

  const normal = new THREE.Vector3(0, 1, 0);
  const planePos = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const rot = new THREE.Matrix4();
  const lookAt = new THREE.Vector3();
  const target = new THREE.Vector3();
  const view = new THREE.Vector3();
  const plane = new THREE.Plane();
  const clip = new THREE.Vector4();
  const q = new THREE.Vector4();
  const REFLECTION_LAYER = 1 << LAYERS.REFLECTION;

  function ensureReflection(w, h) {
    if (!reflRT) {
      // The raw mirror render; its depth texture gives the distance to the
      // reflected object (distortion scale) and marks texels where nothing was drawn.
      const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      dt.name = 'water-reflection-depth';
      rawRT = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
        depthBuffer: true,
        depthTexture: dt,
        samples: 0,
      });
      rawRT.texture.name = 'water-reflection-raw';
      // Mipmapped so rough water can sample a blurred mirror image.
      reflRT = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
        depthBuffer: false,
        samples: 0,
      });
      reflRT.texture.name = 'water-reflection';
    } else if (reflRT.width !== w || reflRT.height !== h) {
      rawRT.setSize(w, h);
      reflRT.setSize(w, h);
    }
    return reflRT;
  }

  // Full-screen copy raw -> reflRT that replaces non-finite texels (bit tests: a
  // fast-math compiler may fold isnan() away). NaN takes the mean of its finite
  // neighbours (else the horizon colour), +Inf a large finite value, negatives 0.
  const sanitizeMat = new THREE.ShaderMaterial({
    name: 'WaterReflSanitize',
    uniforms: { tSrc: { value: null }, uFallback: { value: new THREE.Vector3(0.5, 0.55, 0.6) } },
    vertexShader: /* glsl */ `
      void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tSrc;
      uniform vec3 uFallback;
      bool nanBits(float x) {
        uint u = floatBitsToUint(x);
        return (u & 0x7f800000u) == 0x7f800000u && (u & 0x007fffffu) != 0u;
      }
      bool anyNaN(vec3 c) { return nanBits(c.r) || nanBits(c.g) || nanBits(c.b); }
      float fin(float x) {
        uint u = floatBitsToUint(x);
        if ((u & 0x7f800000u) == 0x7f800000u) return (u >> 31u) != 0u ? 0.0 : 60000.0;
        return clamp(x, 0.0, 60000.0);
      }
      vec3 fin(vec3 c) { return vec3(fin(c.r), fin(c.g), fin(c.b)); }
      void main() {
        ivec2 size = textureSize(tSrc, 0);
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec3 c = texelFetch(tSrc, p, 0).rgb;
        if (anyNaN(c)) {
          vec3 acc = vec3(0.0);
          float n = 0.0;
          for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
              vec3 q = texelFetch(tSrc, clamp(p + ivec2(i, j), ivec2(0), size - 1), 0).rgb;
              if (!anyNaN(q)) { acc += fin(q); n += 1.0; }
            }
          }
          c = n > 0.0 ? acc / n : uFallback;
        }
        gl_FragColor = vec4(fin(c), 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
  });
  const sanitizeGeo = new THREE.BufferGeometry();
  sanitizeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const sanitizeQuad = new THREE.Mesh(sanitizeGeo, sanitizeMat);
  sanitizeQuad.frustumCulled = false;
  const sanitizeScene = new THREE.Scene();
  sanitizeScene.add(sanitizeQuad);
  const sanitizeCam = new THREE.Camera();
  // compile it up front so a runtime switch to a reflecting quality level adds no program
  try {
    renderer.compile(sanitizeScene, sanitizeCam);
  } catch (e) {
    /* compiled on first use instead */
  }

  // Returns false (and leaves the previous image) when the camera is under water.
  function renderReflection(scene, camera, hidden, w, h, fallback = null) {
    camPos.setFromMatrixPosition(camera.matrixWorld);
    planePos.set(camPos.x, WATER_LEVEL, camPos.z);
    view.subVectors(planePos, camPos);
    if (view.dot(normal) > -1e-4) return false;
    const rt = ensureReflection(w, h);

    view.reflect(normal).negate().add(planePos);
    rot.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    target.subVectors(planePos, lookAt).reflect(normal).negate().add(planePos);

    reflCam.position.copy(view);
    reflCam.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    reflCam.lookAt(target);
    reflCam.near = camera.near;
    reflCam.far = camera.far;
    reflCam.updateMatrixWorld();
    reflCam.projectionMatrix.copy(camera.projectionMatrix);
    reflCam.layers.mask = camera.layers.mask | REFLECTION_LAYER;

    const pe = reflCam.projectionMatrix.elements;
    reflProjXY.set(pe[0], pe[5], pe[8], pe[9]);
    textureMatrix.set(0.5, 0.0, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0);
    textureMatrix.multiply(reflCam.projectionMatrix);
    textureMatrix.multiply(reflCam.matrixWorldInverse);

    // Oblique near plane (Lengyel) on the water surface.
    plane.setFromNormalAndCoplanarPoint(normal, planePos);
    plane.applyMatrix4(reflCam.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = reflCam.projectionMatrix;
    q.x = (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    clip.multiplyScalar(2.0 / clip.dot(q));
    pm.elements[2] = clip.x;
    pm.elements[6] = clip.y;
    pm.elements[10] = clip.z + 1.0;
    pm.elements[14] = clip.w;
    reflCam.projectionMatrixInverse.copy(pm).invert();

    for (let i = 0; i < hidden.length; i++) hidden[i].visible = false;
    try {
      renderInto(rawRT, scene, reflCam);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    }
    sanitizeMat.uniforms.tSrc.value = rawRT.texture;
    if (fallback) sanitizeMat.uniforms.uFallback.value.copy(fallback);
    renderInto(rt, sanitizeScene, sanitizeCam); // three builds rt's mip chain afterwards
    return true;
  }

  // ---- depth pre-pass --------------------------------------------------------
  const depthCam = new THREE.PerspectiveCamera();
  depthCam.name = 'water-depth-camera';
  depthCam.matrixAutoUpdate = false;
  depthCam.matrixWorldAutoUpdate = false;
  depthCam.layers.set(LAYERS.UNDERWATER);
  const depthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, fog: false });
  depthMaterial.name = 'water-depth-prepass';
  let depthRT = null;

  function ensureDepth(w, h) {
    if (!depthRT) {
      const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      depthRT = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RedFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        generateMipmaps: false,
        depthBuffer: true,
        depthTexture: dt,
      });
      depthRT.texture.name = 'water-depth-color';
      dt.name = 'water-depth';
    } else if (depthRT.width !== w || depthRT.height !== h) {
      depthRT.setSize(w, h);
    }
    return depthRT;
  }

  const range = { near: 0.1, far: 2500 };
  // Returns { near, far } of the projection the depth texture was written with.
  function renderDepth(scene, camera, hidden, w, h, maxRange = Infinity) {
    const rt = ensureDepth(w, h);
    depthCam.matrixWorld.copy(camera.matrixWorld);
    depthCam.matrixWorldInverse.copy(camera.matrixWorldInverse);
    depthCam.projectionMatrix.copy(camera.projectionMatrix);
    const near = camera.near;
    let far = camera.far;
    if (maxRange > near * 4 && maxRange < far && camera.isPerspectiveCamera) {
      // pull the far plane in (same frustum otherwise, view offsets included):
      // three culls every object beyond it, the rest is clipped per pixel
      far = maxRange;
      const e = depthCam.projectionMatrix.elements;
      e[10] = -(far + near) / (far - near);
      e[14] = (-2 * far * near) / (far - near);
      depthCam.projectionMatrixInverse.copy(depthCam.projectionMatrix).invert();
    } else {
      depthCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    }
    depthCam.near = near;
    depthCam.far = far;
    range.near = near;
    range.far = far;
    const bg = scene.background;
    const ov = scene.overrideMaterial;
    scene.background = null; // the background box would bypass the layer test
    scene.overrideMaterial = depthMaterial;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = false;
    try {
      renderInto(rt, scene, depthCam);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      scene.overrideMaterial = ov;
      scene.background = bg;
    }
    return range;
  }

  // ---- shared render helper ----------------------------------------------------
  function renderInto(rt, scene, cam) {
    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false; // reuse the main pass's shadow maps
    renderer.shadowMap.needsUpdate = false;
    try {
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      if (renderer.autoClear === false) renderer.clear(true, true, true);
      renderer.render(scene, cam);
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.shadowMap.needsUpdate = prevShadowNeeds;
    }
  }

  return {
    textureMatrix,
    renderReflection,
    renderDepth,
    get reflectionTexture() {
      return reflRT ? reflRT.texture : null;
    },
    get reflectionDepth() {
      return rawRT ? rawRT.depthTexture : null;
    },
    reflectionProjectionInverse: reflCam.projectionMatrixInverse,
    reflectionCameraWorld: reflCam.matrixWorld,
    reflectionProjXY: reflProjXY,
    get depthTexture() {
      return depthRT ? depthRT.depthTexture : null;
    },
    releaseReflection() {
      if (rawRT) {
        rawRT.depthTexture.dispose();
        rawRT.dispose();
      }
      if (reflRT) reflRT.dispose();
      rawRT = null;
      reflRT = null;
    },
    releaseDepth() {
      if (depthRT) {
        depthRT.depthTexture.dispose();
        depthRT.dispose();
      }
      depthRT = null;
    },
    dispose() {
      this.releaseReflection();
      this.releaseDepth();
      depthMaterial.dispose();
      sanitizeMat.dispose();
      sanitizeGeo.dispose();
    },
  };
}
