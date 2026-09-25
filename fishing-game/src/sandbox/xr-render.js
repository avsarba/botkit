// XR rendering sandbox: the real environment + scenery + water (+ a couple of fish under the surface and
// the catch showcase) rendered on the desktop and through a WebXR session (IWER in the harness), to check
// XR.md "Rendering while presenting": off-screen passes, water without reflection / depth pre-pass, domes
// on the viewer, shadow cap, per-eye consistency, and the fish held in the hand.
//   node build.mjs --entry src/sandbox/xr-render.js --out dist/xr-render.html --template none
//   node tools/harness.mjs --xr --file dist/xr-render.html --scenario out/xr-render/scn.mjs --out out/xr-render --size 960x540
// Page API: window.__sb (see bottom). Stands in for xr-core: rig, camera re-parenting, grips.
import * as THREE from 'three';
import { createEmitter, DOCK, PLAYER, STATES } from '../config.js';
import { createEnvironment } from '../environment/index.js';
import { createScenery } from '../scenery/index.js';
import { createWater } from '../water/index.js';
import { SPECIES, createFishMesh } from '../fish/index.js';
import * as FishMesh from '../fish/mesh.js';
import { createShowcase, setShowcaseStandIn } from '../game/showcase.js';

const params = new URLSearchParams(location.search);
const quality = params.get('q') || globalThis.__XR_Q || 'high';

// ---- renderer / scene / camera (as main.js) + XR on (XR.md "Session")
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;
renderer.xr.enabled = true;
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2500);
camera.rotation.order = 'YXZ';
const EYE = new THREE.Vector3(0, DOCK.deckY + PLAYER.eyeHeight, 0);
camera.position.copy(EYE);
scene.add(camera);
addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// the player rig (xr-core's): deck level at the dock end, facing -Z
const rig = new THREE.Group();
rig.name = 'xr-rig';
rig.position.set(0, DOCK.deckY, 0);
scene.add(rig);
const grips = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
const hands = { left: null, right: null };
const gloveMat = new THREE.MeshStandardMaterial({ color: 0x3a3226, roughness: 0.8 });
grips.forEach((g, i) => {
  rig.add(g);
  // stand-in glove (xr-tackle owns the real ones): a fist around the grip origin, forward = -Z
  const fist = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.06, 4, 10).rotateX(Math.PI / 2), gloveMat);
  fist.castShadow = true;
  g.add(fist);
  const ctl = renderer.xr.getController(i);
  ctl.addEventListener('connected', (e) => {
    const h = e.data && e.data.handedness;
    if (h === 'left' || h === 'right') hands[h] = g;
    // the reel hand is known now: hold the catch there (re-shows a fish that is already up)
    if (h === 'left' && session) showcase.setXR(true, { holdGrip: g });
  });
  rig.add(ctl);
});

// ---- the modules under test
const events = createEmitter();
const ctx = { renderer, scene, camera, events, quality };
const t0 = performance.now();
const env = createEnvironment(ctx);
const scenery = createScenery({ ...ctx, env });
const water = createWater({ ...ctx, env });
if (typeof scenery.attachWater === 'function') scenery.attachWater(water);
const buildMs = Math.round(performance.now() - t0);

// two fish finning in the shallows in front of the dock (visible through the surface)
const byId = (id) => SPECIES.find((s) => s.id === id) || SPECIES[0];
const swimmers = [
  { h: createFishMesh(byId('smallmouth_bass'), 38, { detail: 'medium', quality, seed: 3, castShadow: false }), p: new THREE.Vector3(-0.7, -0.75, -3.4), yaw: 0.9 },
  { h: createFishMesh(byId('yellow_perch'), 24, { detail: 'medium', quality, seed: 9, castShadow: false }), p: new THREE.Vector3(0.8, -0.6, -4.3), yaw: -2.2 },
];
for (const s of swimmers) {
  s.h.object3d.position.copy(s.p);
  s.h.object3d.rotation.y = s.yaw;
  scene.add(s.h.object3d);
}

// the catch showcase (desktop overlay / VR hand)
const showcase = createShowcase({ renderer, camera, createFishMesh });
setShowcaseStandIn(() => FishMesh.createFishProgramKeeper({ quality, castShadow: false }));

// ---- frame loop (the core's order: env -> scenery -> ... -> water -> showcase -> render)
const frame = {
  dt: 0,
  time: 0,
  hours: 6.1,
  camera,
  state: STATES.READY,
  quality,
  lure: null,
  hooked: null,
  tension01: 0,
  input: { aimYaw: 0, aimPitch: 0, reeling: false, charge01: 0 },
};
let frames = 0;
let xrFrames = 0;
let lastNow = 0;
let lastXrFrame = null;
let frozen = false; // hold the clock (screenshots)
let loopError = null;
const frameWaiters = [];
const views = { count: 0, viewports: [] };
function loop(now, xrFrame) {
  try {
    const dt = lastNow ? Math.min(0.05, Math.max(0, (now - lastNow) / 1000)) : 1 / 60;
    lastNow = now;
    frame.dt = frozen ? 0 : dt;
    frame.time += frame.dt;
    lastXrFrame = xrFrame || null;
    env.setTimeOfDay(frame.hours);
    env.update(frame);
    scenery.update(frame);
    for (const s of swimmers) s.h.update(frame.dt, 0.08, 0.1 * Math.sin(frame.time * 0.4), 0);
    renderer.info.reset();
    water.update(frame);
    showcase.update(frame.dt, env, scene);
    renderer.render(scene, camera);
    showcase.render();
    frames++;
    if (xrFrame) {
      xrFrames++;
      const cams = renderer.xr.getCamera().cameras;
      views.count = cams.length;
      views.viewports = cams.map((c) => (c.viewport ? c.viewport.toArray() : null));
    }
  } catch (err) {
    if (!loopError) console.error('[xr-render] frame failed', err);
    loopError = String((err && err.stack) || err);
  }
  while (frameWaiters.length && frameWaiters[0].at <= frames) frameWaiters.shift().resolve(frames);
}
renderer.setAnimationLoop(loop);

// ---- session (the xr-core stand-in)
let session = null;
let refSpace = null;
function onSessionEnd() {
  session = null;
  scene.add(camera);
  camera.position.copy(EYE);
  camera.rotation.set(-0.12, 0, 0);
  camera.fov = 60;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  showcase.setXR(false);
}
async function enterXR() {
  if (session) return true;
  if (!navigator.xr) return false;
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!ok) return false;
  let s;
  try {
    s = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'], optionalFeatures: ['bounded-floor', 'hand-tracking', 'layers'] });
    refSpace = 'local-floor';
  } catch {
    s = await navigator.xr.requestSession('immersive-vr');
    refSpace = 'local';
  }
  renderer.xr.setReferenceSpaceType(refSpace);
  await renderer.xr.setSession(s);
  session = s;
  s.addEventListener('end', onSessionEnd);
  rig.add(camera);
  camera.position.set(0, refSpace === 'local' ? 1.6 : 0, 0);
  camera.rotation.set(0, 0, 0);
  // until the controllers report their handedness the fish would hang in front of the camera
  showcase.setXR(true, { holdGrip: hands.left });
  return true;
}

// ---- helpers for scenarios
const waitFrames = (n = 1) => new Promise((resolve) => frameWaiters.push({ at: frames + Math.max(1, n), resolve }));
function programNames() {
  return (renderer.info.programs || []).map((p) => p.name + ':' + p.cacheKey.length);
}
// program ids of the water, sky, clouds and terrain materials: unchanged across enter / exit = no recompile
function programIds() {
  const pid = (m) => {
    const p = m && renderer.properties.get(m).currentProgram;
    return p ? p.id : null;
  };
  const o = (n) => scene.getObjectByName(n);
  return {
    waterAdd: pid(water.mesh.material),
    waterMul: pid(water.mesh.children[0] && water.mesh.children[0].material),
    sky: pid(o('env-sky-dome') && o('env-sky-dome').material),
    clouds: pid(o('env-clouds') && o('env-clouds').material),
    terrain: pid(o('env-terrain-0.00') && o('env-terrain-0.00').material),
  };
}
const r3 = (v) => Math.round(v * 1000) / 1000;
const V = (v) => (v ? [r3(v.x), r3(v.y), r3(v.z)] : null);

window.__sb = {
  renderer,
  scene,
  camera,
  env,
  water,
  scenery,
  showcase,
  rig,
  grips,
  hands,
  waitFrames,
  enterXR,
  async exitXR() {
    if (!session) return false;
    const s = session;
    await s.end();
    await waitFrames(2);
    return !renderer.xr.isPresenting;
  },
  setTime(h) {
    frame.hours = h;
    env.setTimeOfDay(h);
    env.bakeEnvironment();
    return env.hours;
  },
  freeze(on = true) {
    frozen = !!on;
  },
  look(yawDeg = 0, pitchDeg = -7, fov = 60) {
    if (renderer.xr.isPresenting) return false;
    camera.position.copy(EYE);
    camera.rotation.set(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    return true;
  },
  setQuality(q) {
    frame.quality = q;
  },
  showFish(id = 'largemouth_bass', cm = 46) {
    showcase.show(byId(id), cm, { quality: frame.quality, seed: 7919, girth: 1.05 });
    return showcase.framing;
  },
  hideFish() {
    showcase.hide();
  },
  programs: programNames,
  programIds,
  status() {
    const u = water.mesh.material.uniforms;
    const sl = env.sunLight;
    const cams = renderer.xr.getCamera().cameras;
    return {
      buildMs,
      frames,
      xrFrames,
      presenting: renderer.xr.isPresenting,
      xrEnabled: renderer.xr.enabled,
      refSpace,
      loopError,
      renderTarget: renderer.getRenderTarget() ? (renderer.getRenderTarget().isXRRenderTarget ? 'xr' : 'offscreen') : null,
      views: { count: views.count, viewports: views.viewports },
      eyes: cams.map((c) => V(new THREE.Vector3().setFromMatrixPosition(c.matrixWorld))),
      camera: V(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)),
      cameraLocal: V(camera.position),
      water: { useRefl: u.uUseRefl.value, useDepth: u.uUseDepth.value, refl: !!u.tRefl.value, depth: !!u.tSceneDepth.value, meshAt: V(water.mesh.position) },
      shadowMap: sl.shadow.mapSize.x,
      skyAt: V(env.terrain && scene.getObjectByName('env-sky-dome') ? scene.getObjectByName('env-sky-dome').position : null),
      hours: r3(env.hours),
      envBakes: env.stats.envBakes,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs.length,
      showcase: showcase.active ? showcase.framing : null,
      showcaseXR: showcase.xr,
      hands: { left: !!hands.left, right: !!hands.right, leftAt: hands.left ? V(new THREE.Vector3().setFromMatrixPosition(hands.left.matrixWorld)) : null },
    };
  },
};
// the harness prints debug.stats() at the end
window.__game = { debug: { stats: () => window.__sb.status() } };
console.log('[xr-render] ready', JSON.stringify({ quality, buildMs }));
