// XR HUD sandbox: the DOM title (with the Enter VR button when navigator.xr offers immersive-vr) and a
// small lake scene whose world-space panels are driven through every HUD state inside an emulated headset.
// Build WITH the template (the panels read the DOM tokens, the title is the real one):
//   node build.mjs --entry src/sandbox/xr-hud.js --out dist/xr-hud.html
//   node tools/harness.mjs --xr --file dist/xr-hud.html --scenario out/xr-hud/states.mjs --out out/xr-hud/states --size 960x540
// Page API: window.__xrhud (enter(), pose(name), go(state), aim(role, panel, buttonId), ...).
import * as THREE from 'three';
import { createEmitter, DOCK, STATES, TACKLE } from '../config.js';
import { createUI } from '../ui/index.js';
import { createXRHud } from '../xr/hud.js';
import { SPECIES, createFishMesh } from '../fish/index.js';
import { stubEnvironment, stubWater } from './stubs.js';

const DEG = Math.PI / 180;
const log = [];
const note = (name, ...args) => log.push([name, ...args]);

// ---------------- DOM UI: the title with Enter VR ----------------
const events = createEmitter();
const records = [
  { id: 1, speciesId: 'yellow_perch', speciesName: 'Yellow Perch', weightKg: 0.21, lengthCm: 22.4, lureId: 'bobber', hours: 6.4, caughtAt: '2026-09-20T06:24:00Z', kept: false },
  { id: 2, speciesId: 'largemouth_bass', speciesName: 'Largemouth Bass', weightKg: 1.62, lengthCm: 44.1, lureId: 'topwater', hours: 19.8, caughtAt: '2026-09-21T19:48:00Z', kept: true },
  { id: 3, speciesId: 'bluegill', speciesName: 'Bluegill', weightKg: 0.18, lengthCm: 17.2, lureId: 'bobber', hours: 7.1, caughtAt: '2026-09-22T07:06:00Z', kept: false },
  { id: 4, speciesId: 'smallmouth_bass', speciesName: 'Smallmouth Bass', weightKg: 1.31, lengthCm: 39.6, lureId: 'crankbait', hours: 8.2, caughtAt: '2026-09-24T08:12:00Z', kept: false },
];
const handlers = {};
for (const k of ['onStart', 'onLure', 'onDrag', 'onTimePreset', 'onMute', 'onUnits', 'onPause', 'onActionDown', 'onActionUp', 'onQuality', 'onKeep', 'onRelease', 'onJournal', 'onSlow', 'onEnterVR', 'onExitVR', 'onRodHand']) {
  handlers[k] = (...a) => note(k, ...a);
}
const ui = createUI({ events, handlers, config: { units: 'imperial', records }, species: SPECIES });
ui.showTitle({ records });
let xrAvailable = false;
try {
  if (navigator.xr && typeof navigator.xr.isSessionSupported === 'function') {
    navigator.xr.isSessionSupported('immersive-vr').then(
      (ok) => {
        xrAvailable = !!ok;
        if (typeof ui.setXRAvailable === 'function') ui.setXRAvailable(xrAvailable);
      },
      () => {}
    );
  }
} catch {
  /* no WebXR: the button stays hidden */
}

// ---------------- 3D: a lake, the dock, a rig with two controllers ----------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
(document.getElementById('stage') || document.body).appendChild(renderer.domElement);
const scene = new THREE.Scene();
stubEnvironment({ scene, renderer });
stubWater({ scene });
scene.fog = new THREE.Fog(0xbfcad2, 60, 700);
scene.background = new THREE.Color(0x9fb4c4);
// far shore treeline
{
  const g = new THREE.CylinderGeometry(320, 320, 26, 64, 1, true);
  const m = new THREE.MeshBasicMaterial({ color: 0x2c3a33, side: THREE.BackSide, fog: true });
  const shore = new THREE.Mesh(g, m);
  shore.position.y = 8;
  scene.add(shore);
}

const rig = new THREE.Group();
rig.name = 'rig';
rig.position.set(0, DOCK.deckY, 0);
scene.add(rig);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 2500);
camera.position.set(0, 1.65, 0);
rig.add(camera);
addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return; // the XR framebuffer has its own size
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// stand-ins for the controllers / gloves, a forearm (to judge the wrist gauge) and the rod
const skin = new THREE.MeshStandardMaterial({ color: 0x3a3f3a, roughness: 0.8 });
const sleeve = new THREE.MeshStandardMaterial({ color: 0x52604f, roughness: 0.95 });
const blank = new THREE.MeshStandardMaterial({ color: 0x1b1e1c, roughness: 0.4, metalness: 0.2 });
const cork = new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.9 });
function handModel(withRod) {
  const pointer = new THREE.Group();
  pointer.rotation.x = -45 * DEG; // grip space -> the controller's pointing frame
  const fist = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.1), skin);
  fist.position.set(0, -0.01, 0.01);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.042, 0.3, 12).rotateX(Math.PI / 2), sleeve);
  arm.position.set(0, -0.035, 0.2);
  pointer.add(fist, arm);
  if (withRod) {
    const rod = new THREE.Group();
    rod.rotation.x = 25 * DEG;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.36, 10).rotateX(Math.PI / 2), cork);
    handle.position.z = -0.02;
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.007, 1.8, 8).rotateX(Math.PI / 2), blank);
    b.position.z = -1.05;
    rod.add(handle, b);
    pointer.add(rod);
  }
  return pointer;
}
const ctrls = [0, 1].map((i) => {
  const ray = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  rig.add(ray, grip);
  const c = { ray, grip, hand: null, model: null };
  ray.addEventListener('connected', (e) => {
    c.hand = e.data && e.data.handedness;
  });
  ray.addEventListener('disconnected', () => {
    c.hand = null;
  });
  return c;
});

// ---------------- the HUD under test ----------------
let frozenAt = null;
const clock = () => (frozenAt != null ? frozenAt : performance.now());
const hud = createXRHud({ renderer, scene, camera, events, handlers, species: SPECIES, config: { units: 'imperial', records }, now: clock });
const H = {
  state: STATES.READY,
  tension01: 0,
  tensionN: 0,
  dragN: TACKLE.dragMinN + 0.45 * (TACKLE.dragMaxN - TACKLE.dragMinN),
  drag01: 0.45,
  lineOutM: 0,
  castPower01: 0,
  hours: 6.2,
  lureId: 'bobber',
  units: 'imperial',
  muted: false,
  catches: records,
  fishOn: false,
  fishDistanceM: NaN,
  prompt: null,
  promptKind: 'info',
  paused: false,
  slow: false,
  quality: 'high',
  fishStamina01: NaN,
  rodLift01: 0.4,
  rodSide: 0,
  rodStiff01: 0,
  slackLine: false,
};
const frame = { state: STATES.READY, dt: 0, time: 0 };
const xin = { rodHand: 'right' };
let rodHand = 'right';
let frames = 0;
let active = false;
let fish = null;

function refs() {
  const by = (h) => ctrls.find((c) => c.hand === h);
  const rod = by(rodHand);
  const reel = by(rodHand === 'right' ? 'left' : 'right');
  return { rodGrip: rod && rod.grip, reelGrip: reel && reel.grip, rodRay: rod && rod.ray, reelRay: reel && reel.ray, rig };
}
function dressHands() {
  for (const c of ctrls) {
    if (c.model) c.model.removeFromParent();
    c.model = handModel(c.hand === rodHand);
    c.grip.add(c.model);
  }
}

const trace = { on: false, rows: [] };
renderer.setAnimationLoop(() => {
  frames++;
  frame.state = H.state;
  if (active) hud.update(H, frame, xin);
  if (trace.on && active) trace.rows.push([Math.round(performance.now()), hud.status().stripYawDeg]);
  if (fish) fish.update(1 / 60, 0.1, 0, 0.6);
  renderer.render(scene, camera);
});

// ---------------- page API for scenarios ----------------
const dev = () => window.__xrDevice;
function setPose(obj, p, yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
  obj.position.set(p[0], p[1], p[2]);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, 'YXZ'));
  obj.quaternion.set(q.x, q.y, q.z, q.w);
}
const POSES = {
  // standing at the end of the dock, looking out at the float, rod up in the right hand, reel hand low
  fishing: { head: [[0, 1.65, 0], 0, -14], right: [[0.2, 1.18, -0.32], -4, 28], left: [[-0.02, 1.02, -0.26], 12, -8, 12] },
  // glancing down at the reel hand's wrist
  glance: { head: [[0, 1.65, 0], 4, -42], right: [[0.22, 1.2, -0.32], -4, 28], left: [[-0.05, 1.2, -0.3], 8, 0, 18] },
  // wrist raised toward the eyes (the watch check)
  watch: { head: [[0, 1.65, 0], 6, -52], right: [[0.24, 1.2, -0.3], -4, 24], left: [[-0.04, 1.3, -0.24], 14, 4, 22] },
  // holding the catch up in the left hand
  catch: { head: [[0, 1.65, 0], 6, -12], right: [[0.24, 1.15, -0.28], -4, 10], left: [[-0.1, 1.46, -0.44], 10, 10, 0] },
  // level head for the menu / journal
  menu: { head: [[0, 1.65, 0], 0, -6], right: [[0.18, 1.28, -0.28], 0, 0], left: [[-0.2, 1.1, -0.3], 0, -20] },
};
function pose(name) {
  const d = dev();
  const p = POSES[name];
  if (!d || !p) return false;
  setPose(d, ...p.head);
  setPose(d.controllers.right, ...p.right);
  setPose(d.controllers.left, ...p.left);
  return true;
}

window.__xrhud = {
  hud,
  ui,
  log,
  H,
  get frames() {
    return frames;
  },
  get xrAvailable() {
    return xrAvailable;
  },
  get presenting() {
    return renderer.xr.isPresenting;
  },
  status: () => hud.status(),
  async enter() {
    const session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'], optionalFeatures: ['bounded-floor', 'hand-tracking'] });
    await renderer.xr.setSession(session);
    session.addEventListener('end', () => {
      active = false;
      hud.setActive(false);
    });
    // wait for both controllers
    for (let i = 0; i < 400 && !(ctrls[0].hand && ctrls[1].hand); i++) await new Promise((r) => setTimeout(r, 25));
    dressHands();
    hud.setActive(true, refs());
    active = true;
    return { presenting: renderer.xr.isPresenting, hands: ctrls.map((c) => c.hand) };
  },
  async exit() {
    const s = renderer.xr.getSession();
    if (s) await s.end();
    return !renderer.xr.isPresenting;
  },
  pose,
  trace(on) {
    if (on) trace.rows = [];
    trace.on = !!on;
    return trace.rows;
  },
  head(yawDeg, pitchDeg = 0) {
    const d = dev();
    if (!d) return false;
    setPose(d, [d.position.x, d.position.y, d.position.z], yawDeg, pitchDeg);
    return true;
  },
  fovy(deg) {
    const d = dev();
    if (d) d.fovy = deg * DEG;
    return deg;
  },
  stereo(on) {
    const d = dev();
    if (d) d.stereoEnabled = !!on;
    return !!on;
  },
  set(patch) {
    Object.assign(H, patch);
    return true;
  },
  freeze(ms) {
    frozenAt = ms == null ? null : ms;
    return frozenAt;
  },
  now: () => performance.now(),
  setRodHand(hand) {
    rodHand = hand;
    xin.rodHand = hand;
    dressHands();
    hud.setActive(true, refs());
    return hand;
  },
  // scripted HUD states
  go(name, opt = {}) {
    const t = (x) => ({ tension01: x, tensionN: x * TACKLE.lineBreakN });
    const base = { prompt: null, promptKind: 'info', fishOn: false, fishDistanceM: NaN, slackLine: false, fishStamina01: NaN, paused: false, ...t(0) };
    if (name !== 'journal') hud.closeJournal();
    if (name !== 'menu' && name !== 'journal') hud.closeMenu();
    if (fish && name !== 'caught') {
      fish.object3d.removeFromParent();
      fish.dispose();
      fish = null;
      hud.hideCatch();
    }
    switch (name) {
      case 'ready':
        Object.assign(H, base, { state: STATES.READY, lineOutM: 0 });
        break;
      case 'charging':
        Object.assign(H, base, { state: STATES.CHARGING, lineOutM: 0 });
        break;
      case 'waiting':
        // core's desktop wording is reworded for the controllers
        Object.assign(H, base, { state: STATES.WAITING, lineOutM: 17.8, prompt: 'Watch the float · click when it goes under · hold to reel in', ...t(0.02) });
        if (opt.toast) hud.toast(opt.toast, opt.kind || 'info');
        break;
      case 'strike':
        Object.assign(H, base, { state: STATES.STRIKE, lineOutM: 17.8, ...t(0.06) });
        hud.strikeCue({ reelSet: !!opt.reelSet });
        break;
      case 'fighting': {
        const x = opt.tension ?? 0.3;
        Object.assign(H, base, { state: STATES.FIGHTING, lineOutM: 22.4, fishOn: true, fishDistanceM: 15.2, fishStamina01: 0.7, ...t(x) });
        if (opt.prompt !== undefined) Object.assign(H, { prompt: opt.prompt, promptKind: opt.promptKind || 'warn' });
        if (opt.drag != null) Object.assign(H, { drag01: opt.drag, dragN: TACKLE.dragMinN + opt.drag * (TACKLE.dragMaxN - TACKLE.dragMinN) });
        break;
      }
      case 'caught': {
        Object.assign(H, base, { state: STATES.CAUGHT, lineOutM: 0 });
        const sp = SPECIES.find((s) => s.id === 'smallmouth_bass') || SPECIES[0];
        if (!fish) {
          fish = createFishMesh(sp, 41, { detail: 'medium', quality: 'low' });
          // held by the lower jaw: snout up, body hanging, side toward the player
          const holder = new THREE.Group();
          holder.rotation.x = -45 * DEG; // the controller's pointing frame: +Y up
          const hang = new THREE.Group();
          hang.rotation.set(0, 90 * DEG, 0); // side toward the player
          fish.object3d.rotation.set(-90 * DEG, 0, 0); // snout up, body hanging
          fish.object3d.position.set(0, -0.03, -0.02);
          hang.add(fish.object3d);
          holder.add(hang);
          const r = refs();
          if (r.reelGrip) r.reelGrip.add(holder);
          fish.holder = holder;
          const od = fish.dispose;
          fish.dispose = () => {
            holder.removeFromParent();
            od();
          };
        }
        const rec = { id: 5, speciesId: sp.id, speciesName: sp.name, latin: sp.latin, weightKg: 1.18, lengthCm: 41.2, lureId: 'crankbait', hours: 7.35, caughtAt: '2026-09-25T07:21:00Z', kept: false };
        hud.showCatch(rec, { isPersonalBest: opt.pb ?? true, isNewSpecies: opt.newSpecies ?? false });
        break;
      }
      case 'menu':
        Object.assign(H, base, { state: STATES.READY, paused: true });
        hud.openMenu({ lureId: H.lureId, hours: H.hours, muted: H.muted, units: H.units, rodHand });
        break;
      case 'journal':
        Object.assign(H, base, { state: STATES.READY, paused: true });
        hud.openMenu({});
        hud.openJournal(records);
        break;
      default:
        return false;
    }
    return name;
  },
  // Point a controller's ray at the centre of a panel button (world -> reference space -> IWER pose).
  aim(role, panelName, buttonId) {
    const P = hud.debugPanels;
    const panel = P && P[panelName];
    const d = dev();
    if (!panel || !d) return 'no panel';
    const b = panel.buttons.find((x) => x.id === buttonId);
    if (!b) return `no button ${buttonId} (${panel.buttons.map((x) => x.id).join(',')})`;
    const u = (b.x + b.w / 2) / panel.W;
    const v = 1 - (b.y + b.h / 2) / panel.usedH;
    const local = new THREE.Vector3((u - 0.5) * panel.widthM, (v - 0.5) * panel.heightM, 0); // mesh space (its scale crops)
    panel.mesh.updateWorldMatrix(true, false);
    const world = local.clone().applyMatrix4(panel.mesh.matrixWorld);
    const target = rig.worldToLocal(world.clone()); // IWER's local-floor space is the rig's space
    const hand = role === 'rod' ? rodHand : rodHand === 'right' ? 'left' : 'right';
    const c = d.controllers[hand];
    const from = new THREE.Vector3(c.position.x, c.position.y, c.position.z);
    const dir = target.sub(from).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
    c.quaternion.set(q.x, q.y, q.z, q.w);
    return { hand, target: world.toArray().map((x) => +x.toFixed(3)) };
  },
  press(hand) {
    return hud.select(hand);
  },
  // which controller the wrist gauge is mounted on ('left' | 'right' | null)
  wristHand() {
    const P = hud.debugPanels;
    const mount = P && P.wrist.object.parent;
    const c = ctrls.find((x) => mount && mount.parent === x.grip);
    return c ? c.hand : null;
  },
  // xr-hud objects in the scene (leak check across enter / exit)
  countXR() {
    let n = 0;
    scene.traverse((o) => {
      if (/^xr-/.test(o.name)) n++;
    });
    return n;
  },
  // Turn the emulated head toward a panel (detail shots); keeps the head position.
  look(panelName) {
    const P = hud.debugPanels;
    const panel = P && P[panelName];
    const d = dev();
    if (!panel || !d) return false;
    panel.mesh.updateWorldMatrix(true, false);
    const target = rig.worldToLocal(new THREE.Vector3().setFromMatrixPosition(panel.mesh.matrixWorld));
    const from = new THREE.Vector3(d.position.x, d.position.y, d.position.z);
    const dir = target.sub(from).normalize();
    const yaw = Math.atan2(-dir.x, -dir.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    d.quaternion.set(q.x, q.y, q.z, q.w);
    return true;
  },
};
