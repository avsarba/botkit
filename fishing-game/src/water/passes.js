// Off-screen passes the water needs each frame:
//  - planar reflection: the scene seen from the camera mirrored in y = 0 with an
//    oblique near plane on the water plane (everything below the surface is
//    clipped and culled), rendered at reduced resolution into a half-float target.
//  - depth pre-pass: only LAYERS.UNDERWATER objects (lake bed, fish, lures,
//    pilings, timber), untextured, depth only, at reduced resolution. The water
//    shader turns it into the true water thickness in front of each pixel.
import * as THREE from 'three';
import { LAYERS, WATER_LEVEL } from '../config.js';

export function createPasses(renderer) {
  // ---- reflection ----------------------------------------------------------
  const reflCam = new THREE.PerspectiveCamera();
  reflCam.name = 'water-reflection-camera';
  const textureMatrix = new THREE.Matrix4();
  let reflRT = null;

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

  function ensureReflection(w, h) {
    if (!reflRT) {
      // Mipmapped so rough water can sample a blurred mirror image; the depth
      // texture gives the distance to the reflected object (distortion scale).
      const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      dt.name = 'water-reflection-depth';
      reflRT = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
        depthBuffer: true,
        depthTexture: dt,
        samples: 0,
      });
      reflRT.texture.name = 'water-reflection';
    } else if (reflRT.width !== w || reflRT.height !== h) {
      reflRT.setSize(w, h);
    }
    return reflRT;
  }

  // Returns false (and leaves the previous image) when the camera is under water.
  function renderReflection(scene, camera, hidden, w, h) {
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
    reflCam.layers.mask = camera.layers.mask;

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
      renderInto(rt, scene, reflCam);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    }
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

  function renderDepth(scene, camera, hidden, w, h) {
    const rt = ensureDepth(w, h);
    depthCam.matrixWorld.copy(camera.matrixWorld);
    depthCam.matrixWorldInverse.copy(camera.matrixWorldInverse);
    depthCam.projectionMatrix.copy(camera.projectionMatrix);
    depthCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    depthCam.near = camera.near;
    depthCam.far = camera.far;
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
    return rt;
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
      return reflRT ? reflRT.depthTexture : null;
    },
    reflectionProjectionInverse: reflCam.projectionMatrixInverse,
    get depthTexture() {
      return depthRT ? depthRT.depthTexture : null;
    },
    releaseReflection() {
      if (reflRT) {
        reflRT.depthTexture.dispose();
        reflRT.dispose();
      }
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
    },
  };
}
