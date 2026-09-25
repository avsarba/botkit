// Catch showcase: the landed fish held up in front of the camera while the catch card is open.
// It is drawn in its own small scene after the main pass (depth cleared), so it never clips into the
// rod, the dock or the water, and it gets its own soft studio-ish lighting (a key light near the
// camera that works as a headlamp at night) on top of the lake's environment map.
import * as THREE from 'three';
import { clamp, damp } from '../config.js';

export function createShowcase({ renderer, camera, createFishMesh }) {
  const scene = new THREE.Scene();
  scene.name = 'showcase';
  const rig = new THREE.Group(); // follows the camera
  rig.matrixAutoUpdate = false;
  scene.add(rig);
  const holder = new THREE.Group();
  rig.add(holder);

  const key = new THREE.DirectionalLight(0xfff1de, 1);
  key.position.set(-0.7, 0.9, 1.1);
  const keyTarget = new THREE.Object3D();
  keyTarget.position.set(0, 0, -1);
  rig.add(key, keyTarget);
  key.target = keyTarget;
  const rim = new THREE.DirectionalLight(0xd6e6ff, 1);
  rim.position.set(0.9, 0.7, -1.6);
  rig.add(rim);
  rim.target = keyTarget;
  const fill = new THREE.HemisphereLight(0xdfe9f2, 0x3b3426, 1);
  rig.add(fill);

  let fish = null;
  let t = 0;
  let appear = 0;
  let lengthM = 0.3;
  const frameInfo = { ndcX: -0.42, ndcY: 0.02, span: 0.46 };
  const _m = new THREE.Matrix4();

  function layout() {
    const aspect = Math.max(0.2, camera.aspect || 1);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * aspect;
    // desktop / landscape: the card sits on the right, frame the fish in the left ~55 %;
    // portrait phones: the card is a bottom sheet, frame the fish in the top ~35 %
    if (aspect < 0.85) {
      frameInfo.ndcX = 0;
      frameInfo.ndcY = 0.6;
      frameInfo.span = 0.74;
    } else if (aspect < 1.25) {
      frameInfo.ndcX = -0.38;
      frameInfo.ndcY = 0.08;
      frameInfo.span = 0.5;
    } else {
      frameInfo.ndcX = -0.43;
      frameInfo.ndcY = 0.02;
      frameInfo.span = 0.44;
    }
    // distance so the fish's length spans `span` of the screen width (broadside)
    const d = clamp(lengthM / (frameInfo.span * 2 * tanH), 0.22, 4);
    holder.position.set(frameInfo.ndcX * d * tanH, frameInfo.ndcY * d * tanV, -d);
    return d;
  }

  function show(species, lengthCm, opts = {}) {
    hide();
    const handle = createFishMesh(species, lengthCm, { detail: 'high', quality: opts.quality || 'high', seed: opts.seed, girth: opts.girth });
    fish = handle;
    const o = handle.object3d;
    lengthM = (o.userData && o.userData.lengthM) || lengthCm / 100;
    const cz = o.userData && Number.isFinite(o.userData.centerZ) ? o.userData.centerZ : -0.42 * lengthM;
    o.position.set(0, 0, -cz); // pivot about the centre of mass
    o.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = false;
        c.receiveShadow = false;
        c.frustumCulled = false;
      }
    });
    holder.add(o);
    t = 0;
    appear = 0;
    layout();
  }

  function hide() {
    if (!fish) return;
    fish.dispose();
    fish = null;
  }

  // env: the Environment module (for the environment map and exposure).
  function update(dt, env, scene0) {
    if (!fish) return;
    t += dt;
    appear = damp(appear, 1, 5, dt);
    camera.updateMatrixWorld();
    rig.matrix.copy(camera.matrixWorld);
    rig.matrixWorldNeedsUpdate = true;
    layout();
    // head to the left, left flank to the camera, turning slowly back and forth
    holder.rotation.set(0.12 + 0.05 * Math.sin(t * 0.7), -Math.PI / 2 + 0.62 * Math.sin(t * 0.42), 0.04 * Math.sin(t * 0.9));
    const s = 0.92 + 0.08 * appear;
    holder.scale.setScalar(s);
    holder.position.y -= (1 - appear) * 0.06;
    fish.update(dt, 0.05, 0, 0.35);
    // lights: roughly constant on screen at any exposure (a headlamp at night)
    const exposure = renderer.toneMappingExposure || 1;
    const night = env && Number.isFinite(env.nightFactor) ? env.nightFactor : 0;
    key.intensity = (1.7 + 0.6 * night) / exposure;
    key.color.setRGB(1, 0.95 - 0.03 * night, 0.87 + 0.1 * night);
    rim.intensity = 0.9 / exposure;
    fill.intensity = (0.55 + 0.25 * night) / exposure;
    scene.environment = (scene0 && scene0.environment) || (env && env.envMap) || null;
    scene.environmentIntensity = scene0 && Number.isFinite(scene0.environmentIntensity) ? scene0.environmentIntensity : 1;
    void _m;
  }

  function render() {
    if (!fish) return;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, camera);
    renderer.autoClear = auto;
  }

  return {
    show,
    hide,
    update,
    render,
    get active() {
      return !!fish;
    },
    get object() {
      return fish ? fish.object3d : null;
    },
    scene,
  };
}
