// XR tackle sandbox (run the harness with --xr): the real rod in a controller grip under IWER, on a stub lake,
// driven by a tiny fake core. Grips are plain rig children posed from the XR frame (like src/xr/input.js does);
// scripted motion poses them directly per simulation step (and IWER's controllers to match, so the rendered
// frame agrees). The simulation advances in fixed steps; rendering only shows the result.
//   window.__xrt: { enter(), exit(), setHead(p, yawDeg, pitchDeg), setRay(hand, p, yawDeg, pitchDeg, rollDeg),
//                   stereo(on), view(name) -> Promise(info), info(), frames(n) -> Promise }
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeSandbox, stubEnvironment, stubWater } from './stubs.js';
import { createTackle } from '../tackle/index.js';
import { STATES, TACKLE, DOCK, clamp } from '../config.js';

const sb = makeSandbox({ quality: 'high' });
const { renderer, scene, camera, events, frame } = sb;
renderer.xr.enabled = true;
const env = stubEnvironment(sb.ctx);
const water = stubWater(sb.ctx);

// sky + PMREM so metals and clear coats reflect something (as in the tackle sandbox)
const sky = new Sky();
sky.scale.setScalar(2000);
const su = sky.material.uniforms;
su.turbidity.value = 4;
su.rayleigh.value = 1.4;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.82;
su.sunPosition.value.copy(env.sunDirection).multiplyScalar(1000);
scene.add(sky);
{
  const pm = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene();
  const s2 = new Sky();
  s2.scale.setScalar(1000);
  s2.material.uniforms.sunPosition.value.copy(su.sunPosition.value);
  skyScene.add(s2);
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(900, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2a3326, side: THREE.BackSide })));
  scene.environment = pm.fromScene(skyScene, 0, 0.1, 2000).texture;
  pm.dispose();
}
renderer.toneMappingExposure = 0.9;
water.mesh.material.color.set(0x21424a);
water.mesh.material.roughness = 0.06;

const fishMarker = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8).scale(0.9, 0.9, 3.2), new THREE.MeshStandardMaterial({ color: 0x3b4028, roughness: 0.5 }));
fishMarker.visible = false;
scene.add(fishMarker);

// ---- rig + grips (xr-core owns these in the game)
const rig = new THREE.Group();
rig.name = 'rig';
rig.position.set(0, DOCK.deckY, 0);
scene.add(rig);
function makeGrip(h) {
  const g = new THREE.Group();
  g.name = `xr-grip-${h}`;
  g.matrixAutoUpdate = false;
  g.visible = false;
  rig.add(g);
  return g;
}
const grips = { left: makeGrip('left'), right: makeGrip('right') };
// debug: small axes on the grips (off by default)
const gripAxes = [];
for (const h of ['left', 'right']) {
  const a = new THREE.AxesHelper(0.08);
  a.visible = false;
  grips[h].add(a);
  gripAxes.push(a);
}

const tackle = createTackle({ ...sb.ctx, env, water });
frame.input = { aimYaw: 0, aimPitch: -0.12, charge01: 0, reeling: false, reelSpeed01: 0, rodSide: 0, rodLift01: 0 };
frame.tensionN = 0;
frame.tension01 = 0;
frame.dragN = 20;
frame.lineOutM = 0;
frame.slipMps = 0;
frame.hooked = null;
frame.lure = tackle.getLure();

const log = [];
events.on('lure:landed', (e) => {
  log.push({ ev: 'landed', onWater: e.onWater, x: +e.position.x.toFixed(2), z: +e.position.z.toFixed(2), speed: +e.speed.toFixed(1) });
  landedAt = e.position.clone();
  if (frame.state === STATES.CASTING) frame.state = STATES.WAITING;
});
events.on('lure:home', () => {
  log.push({ ev: 'home' });
  frame.state = STATES.READY;
});
let landedAt = null;

// ---- IWER poses
const dev = () => window.__xrDevice;
const DEG = Math.PI / 180;
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
// yaw > 0 turns right, pitch > 0 looks up
function quatFrom(yawDeg, pitchDeg, rollDeg = 0) {
  _e.set(pitchDeg * DEG, -yawDeg * DEG, rollDeg * DEG, 'YXZ');
  return _q.setFromEuler(_e);
}
function setHead(p, yawDeg = 0, pitchDeg = 0) {
  const d = dev();
  const q = quatFrom(yawDeg, pitchDeg);
  d.position.set(p[0], p[1], p[2]);
  d.quaternion.set(q.x, q.y, q.z, q.w);
}
const gripOffset = { left: new THREE.Matrix4(), right: new THREE.Matrix4() };
function loadGripOffsets() {
  try {
    const L = window.__IWER.metaQuest3.controllerConfig.layout;
    for (const h of ['left', 'right']) if (L[h].gripOffsetMatrix) gripOffset[h].fromArray(L[h].gripOffsetMatrix);
  } catch (e) {
    console.warn('[xr-tackle] no IWER grip offsets', e && e.message);
  }
}
// Pose a controller's target ray (reference space = rig space) and its grip to match, right now.
function setRay(hand, p, yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
  const q = quatFrom(yawDeg, pitchDeg, rollDeg);
  const c = dev() && dev().controllers[hand];
  if (c) {
    c.position.set(p[0], p[1], p[2]);
    c.quaternion.set(q.x, q.y, q.z, q.w);
  }
  _m.compose(_p.set(p[0], p[1], p[2]), q, _one);
  _m2.multiplyMatrices(_m, gripOffset[hand]);
  const g = grips[hand];
  g.matrix.copy(_m2);
  g.matrix.decompose(g.position, g.quaternion, g.scale);
  g.visible = true;
  g.matrixWorldNeedsUpdate = true;
}

// Pose a controller so that its GRIP origin lands at p (rig space), with the ray orientation given.
const _t = new THREE.Vector3();
function setGrip(hand, p, yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
  const q = quatFrom(yawDeg, pitchDeg, rollDeg).clone();
  _t.setFromMatrixPosition(gripOffset[hand]).applyQuaternion(q);
  setRay(hand, [p[0] - _t.x, p[1] - _t.y, p[2] - _t.z], yawDeg, pitchDeg, rollDeg);
}

// ---- XR session
let session = null;
let refSpace = null;
let lastGripFromFrame = null;
async function enter() {
  loadGripOffsets();
  const s = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'], optionalFeatures: ['bounded-floor', 'hand-tracking'] });
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(s);
  session = s;
  refSpace = renderer.xr.getReferenceSpace();
  rig.add(camera);
  camera.position.set(0, 0, 0);
  camera.quaternion.identity();
  s.addEventListener('end', onEnd);
  return { presenting: renderer.xr.isPresenting };
}
function onEnd() {
  session = null;
  refSpace = null;
  for (const g of Object.values(grips)) g.visible = false;
  scene.add(camera);
  look(0, -0.12);
  camera.fov = 60;
  camera.zoom = 1;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  tackle.setXRMode(false);
}
async function exit() {
  if (session) await session.end();
  return { presenting: renderer.xr.isPresenting, xrMode: tackle.xrMode };
}
function readGrips(xf) {
  if (!refSpace || !xf) return;
  for (const src of xf.session.inputSources) {
    const g = grips[src.handedness];
    if (!g || !src.gripSpace) continue;
    const pose = xf.getPose(src.gripSpace, refSpace);
    if (pose) {
      g.matrix.fromArray(pose.transform.matrix);
      g.matrix.decompose(g.position, g.quaternion, g.scale);
      g.matrixWorldNeedsUpdate = true;
      g.visible = true;
      if (src.handedness === 'right') lastGripFromFrame = g.matrix.elements.slice(12, 15).map((v) => +v.toFixed(3));
    } else g.visible = false;
  }
}

// ---- fake core
const eyeBase = new THREE.Vector3(0, DOCK.deckY + 1.65, 0);
function look(yaw, pitch) {
  camera.position.copy(eyeBase);
  camera.rotation.set(pitch, -yaw, 0, 'YXZ');
  frame.input.aimYaw = yaw;
  frame.input.aimPitch = pitch;
  camera.updateMatrixWorld();
}
look(0, -0.12);

let reeling = false;
let fightOn = false;
let ft = 0;
let fixedTension = -1;
const fishP = new THREE.Vector3();
const tipV = new THREE.Vector3();
const dirV = new THREE.Vector3();
let fishBase = new THREE.Vector3(3, -1.0, -12);
function fightStep(dt) {
  ft += dt;
  fishP.copy(fishBase).add(_p.set(0.6 * Math.sin(ft * 0.7), 0.2 * Math.sin(ft * 1.3), 0.5 * Math.cos(ft * 0.5)));
  const T = fixedTension >= 0 ? fixedTension : 25 + 15 * Math.sin(ft * 1.7);
  frame.tensionN = T;
  frame.tension01 = T / TACKLE.lineBreakN;
  frame.hooked = { headShake01: 0.2 };
  tackle.getRodTip(tipV);
  tackle.setFight(true, { fishPosition: fishP, tensionN: T, lineOutM: tipV.distanceTo(fishP) });
  dirV.subVectors(fishP, tipV).normalize();
  tackle.setRodLoad(T, dirV);
  fishMarker.position.copy(fishP);
  fishMarker.lookAt(tipV.x, fishP.y, tipV.z);
}

let script = null; // (simT) => void: poses grips before each step
let simT = 0;
let spamXR = false; // call setXRMode(true, same grips) before every step (must be a no-op)
function step(dt) {
  simT += dt;
  if (script) script(simT);
  if (spamXR) tackle.setXRMode(true, { rodGrip: grips.right, reelGrip: grips.left, rodHand: 'right' });
  frame.dt = dt;
  frame.time += dt;
  frame.input.reeling = reeling;
  frame.input.reelSpeed01 = reeling ? 1 : 0;
  if (reeling) tackle.reel(dt, TACKLE.reelRetrieveMps);
  tackle.update(frame);
  if (fightOn) fightStep(dt);
  frame.lure = tackle.getLure();
  frame.lineOutM = frame.lure.lineOutM;
}
function advance(seconds, each, h = 1 / 72) {
  const n = Math.round(seconds / h);
  for (let i = 0; i < n; i++) {
    if (each) each(i * h);
    step(h);
  }
}

// ---- render loop
let live = false;
let pending = [];
let frameCount = 0;
renderer.setAnimationLoop((t, xf) => {
  frameCount++;
  if (xf) readGrips(xf);
  if (live) step(1 / 72);
  renderer.render(scene, camera);
  if (pending.length) {
    const keep = [];
    for (const p of pending) if (--p.n <= 0) p.resolve(info());
    else keep.push(p);
    pending = keep;
  }
});
const frames = (n = 2) => new Promise((resolve) => pending.push({ n, resolve }));

const _b = new THREE.Vector3();
const _h = new THREE.Vector3();
function info() {
  const l = tackle.getLure();
  const tip = tackle.getRodTip(new THREE.Vector3());
  const base = tackle.getRodBase ? tackle.getRodBase(_b) : null;
  const knob = tackle.getReelHandle ? tackle.getReelHandle(_h) : null;
  const rd = base ? tip.clone().sub(base) : null;
  const x = tackle.debug.xr;
  return {
    presenting: renderer.xr.isPresenting,
    xrMode: tackle.xrMode,
    state: frame.state,
    lure: { id: l.id, state: l.state, inWater: l.inWater, lineOutM: +l.lineOutM.toFixed(2), distanceM: +l.distanceM.toFixed(2), pos: l.position.toArray().map((v) => +v.toFixed(2)) },
    tip: tip.toArray().map((v) => +v.toFixed(3)),
    base: base && base.toArray().map((v) => +v.toFixed(3)),
    knob: knob && knob.toArray().map((v) => +v.toFixed(3)),
    rodLen: rd && +rd.length().toFixed(3),
    rodElevDeg: rd && +((Math.asin(clamp(rd.y / rd.length(), -1, 1)) * 180) / Math.PI).toFixed(1),
    handleAngle: +tackle.debug.handleAngle.toFixed(3),
    bail01: +tackle.debug.bail01.toFixed(2),
    crankLock: x.crankLock,
    castPitchDeg: +((x.castPitch * 180) / Math.PI).toFixed(1),
    tipAcc: +x.tipAcc.length().toFixed(1),
    tipVel: x.tipVel.toArray().map((v) => +v.toFixed(2)),
    Feff: tackle.debug.Feff.toArray().map((v) => +v.toFixed(2)),
    lineWidth: tackle.debug.rope.line.material.linewidth,
    lineRes: tackle.debug.rope.line.material.resolution.toArray(),
    floatScale: +tackle.debug.models.bobber.object.scale.x.toFixed(2),
    gripFromFrame: lastGripFromFrame,
    gripSet: grips.right.matrix.elements.slice(12, 15).map((v) => +v.toFixed(3)),
    aimRingVisible: !!(scene.getObjectByName('cast-aim-ring') || {}).visible,
    landedAt: landedAt && landedAt.toArray().map((v) => +v.toFixed(2)),
    log: log.slice(-6),
    calls: renderer.info.render.calls,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    sceneChildren: scene.children.length,
    rigChildren: rig.children.length,
    gripChildren: [grips.left.children.length, grips.right.children.length],
  };
}

function resetAll(lureId = 'spinner') {
  script = null;
  fightOn = false;
  reeling = false;
  fishMarker.visible = false;
  frame.hooked = null;
  frame.tensionN = 0;
  frame.tension01 = 0;
  frame.input.charge01 = 0;
  frame.state = STATES.READY;
  tackle.setFight(false);
  tackle.setLure(lureId);
  tackle.resetToHome();
  landedAt = null;
}

// natural rest: right hand in front of the right hip, ray pointing forward-down (rod ~25 deg up);
// left hand low, near the reel
const REST_R = [0.2, 1.05, -0.32];
const REST_L = [-0.12, 1.0, -0.28];
function restPose(rodHand = 'right') {
  if (rodHand === 'right') {
    setRay('right', REST_R, 4, -40);
    setRay('left', REST_L, 10, -20, 20);
  } else {
    setRay('left', [-REST_R[0], REST_R[1], REST_R[2]], -4, -40);
    setRay('right', [-REST_L[0], REST_L[1], REST_L[2]], -10, -20, -20);
  }
}

// swing: the ray pitches from back over the shoulder to forward, the hand moving forward ~0.35 m
function swingPose(u, dirYaw = 0) {
  const e = u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u);
  const pitch = 60 - 110 * e; // ray pitch: +60 (rod pointing back past vertical) .. -50
  const y = 1.3 + 0.1 * Math.sin(e * Math.PI);
  const z = -0.1 - 0.35 * e;
  setRay('right', [0.22, y, z], dirYaw, pitch);
}

// cast mapping from XR.md "Hands and input" (tip velocity smoothed over ~60 ms at release)
function castFromTip(vel) {
  const speed = vel.length();
  const power01 = clamp((speed - 1.2) / 10.0, 0.08, 1);
  const horiz = new THREE.Vector3(vel.x, 0, vel.z);
  const dir = horiz.length() >= 1 ? horiz.normalize() : new THREE.Vector3(0, 0, -1);
  const pitchRad = clamp(Math.atan2(vel.y, Math.hypot(vel.x, vel.z)), 8 * DEG, 55 * DEG);
  return { speed, power01, dir, pitchRad };
}

const views = {
  desktop() {
    resetAll('spinner');
    look(0, -0.12);
    advance(1.2, null, 1 / 60);
  },
  hold() {
    resetAll('spinner');
    restPose('right');
    setHead([0, 1.65, 0], 8, -18);
    advance(1.5);
  },
  inspectSide(o = {}) {
    // look at the rod hand from outside it (right side for a right-hand rod)
    const sx = o.left ? -1 : 1;
    setHead([0.2 + sx * 0.38, 1.12, -0.3], sx * -90, -8);
    advance(0.2);
  },
  inspectFront(o = {}) {
    const sx = o.left ? -1 : 1;
    setHead([sx * 0.12, 1.2, -0.78], 180, -14);
    advance(0.2);
  },
  inspectReel(o = {}) {
    // the reel from the handle side (left of a right-hand rod), a little below
    const sx = o.left ? -1 : 1;
    setHead([sx * -0.12, 1.0, -0.38], sx * 90, 12);
    advance(0.2);
  },
  peek(o = {}) {
    // camera only: the simulation does not advance
    setHead(o.p || [0, 1.65, 0], o.yaw || 0, o.pitch || 0);
  },
  lookDown(o = {}) {
    setHead([0, 1.65, 0], o.yaw !== undefined ? o.yaw : 6, o.pitch !== undefined ? o.pitch : -48);
    advance(0.2);
  },
  rotate() {
    // rod swept to the left and raised, hand higher
    setRay('right', [0.1, 1.25, -0.4], -35, -5, -10);
    setRay('left', REST_L, 10, -20, 20);
    setHead([0, 1.65, 0], -15, -5);
    advance(1.0);
  },
  bend() {
    resetAll('spinner');
    tackle.cast(0.45, new THREE.Vector3(0.15, 0, -1).normalize());
    frame.state = STATES.CASTING;
    for (let i = 0; i < 72 * 6 && frame.state === STATES.CASTING; i++) step(1 / 72);
    advance(0.5);
    frame.state = STATES.FIGHTING;
    fightOn = true;
    ft = 0;
    fishBase = new THREE.Vector3(2.5, -1.0, -11);
    fishMarker.visible = true;
    fixedTension = 32;
    setRay('right', [0.24, 1.2, -0.3], 6, -10); // rod ~55 deg up
    setRay('left', [-0.08, 1.05, -0.3], 10, -25, 20);
    setHead([0, 1.65, 0], 10, -2);
    advance(1.8);
    fixedTension = -1;
  },
  swingMid() {
    resetAll('spinner');
    frame.state = STATES.CHARGING; // trigger held: bail open
    setHead([0, 1.65, 0], 5, 5);
    swingPose(0);
    advance(0.6);
    // forward stroke over 0.3 s; stop at 45 % (rod loaded)
    const T = 0.3;
    script = (t) => swingPose((t - t0) / T);
    const t0 = simT;
    advance(T * 0.45);
    script = null;
  },
  swingCast(opts = {}) {
    resetAll(opts.lure || 'spinner');
    frame.state = STATES.CHARGING;
    setHead([0, 1.65, 0], 5, -2);
    swingPose(0);
    advance(0.6);
    const T = opts.T || 0.3;
    const t0 = simT;
    script = (t) => swingPose((t - t0) / T);
    // release at 70 % of the stroke: tip velocity over the last ~60 ms
    const hist = [];
    const n = Math.round((T * (opts.release || 0.7)) / (1 / 72));
    for (let i = 0; i < n; i++) {
      step(1 / 72);
      hist.push({ t: simT, p: tackle.getRodTip(new THREE.Vector3()) });
    }
    const a = hist[Math.max(0, hist.length - 1 - 4)];
    const b = hist[hist.length - 1];
    const vel = b.p.clone().sub(a.p).multiplyScalar(1 / Math.max(1e-4, b.t - a.t));
    const c = castFromTip(vel);
    const pitchRad = opts.pitchRad !== undefined ? opts.pitchRad : c.pitchRad;
    const power01 = opts.power01 !== undefined ? opts.power01 : c.power01;
    tackle.cast(power01, c.dir, { pitchRad });
    frame.state = STATES.CASTING;
    const release = { speed: +c.speed.toFixed(2), power01: +power01.toFixed(3), pitchDeg: +((pitchRad * 180) / Math.PI).toFixed(1), dir: c.dir.toArray().map((v) => +v.toFixed(2)) };
    // follow-through, then flight
    advance(T * 0.3);
    script = null;
    if (opts.stopAfter) {
      advance(opts.stopAfter);
      return release;
    }
    for (let i = 0; i < 72 * 8 && frame.state === STATES.CASTING; i++) step(1 / 72);
    advance(1.0);
    return release;
  },
  reel() {
    // lure out, retrieving: handle turns, bail closed
    resetAll('crankbait');
    restPose('right');
    tackle.cast(0.35, new THREE.Vector3(0, 0, -1));
    frame.state = STATES.CASTING;
    for (let i = 0; i < 72 * 6 && frame.state === STATES.CASTING; i++) step(1 / 72);
    advance(0.5);
    reeling = true;
    advance(0.9);
    reeling = false;
    advance(0.05);
  },
  crank(opts = {}) {
    // the reel hand circles the handle knob: the handle follows it (forward), then the hand turns back
    reeling = false;
    const knob = tackle.getReelHandle(new THREE.Vector3());
    const base = tackle.getRodBase(new THREE.Vector3());
    // crank axis ~ the rod's sideways axis: find the circle plane from the rod direction
    const tip = tackle.getRodTip(new THREE.Vector3());
    const fwd = tip.clone().sub(base).normalize();
    const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(side, fwd).normalize();
    // pivot: knob minus the arm (knob sits at R (sin h fwd + cos h up)-ish from the pivot); circle the hand
    // (grip origin) around the pivot at a slightly larger radius, outboard of the knob
    const h0 = tackle.debug.handleAngle;
    const R = 0.0465;
    const pivot = knob.clone().addScaledVector(fwd, -R * Math.sin(h0)).addScaledVector(up, -R * Math.cos(h0));
    const rig0 = rig.position;
    const turns = opts.turns || 1.25;
    const dur = opts.dur || 1.0;
    const sgn = opts.backward ? -1 : 1;
    const start = simT;
    const hand0 = h0 + 0.35;
    script = (t) => {
      const u = Math.min(1, (t - start) / dur);
      const a = hand0 + sgn * u * turns * Math.PI * 2;
      const p = pivot.clone().addScaledVector(fwd, 0.07 * Math.sin(a)).addScaledVector(up, 0.07 * Math.cos(a)).addScaledVector(side, -0.05);
      p.sub(rig0);
      setGrip('left', [p.x, p.y, p.z], 20, -30, 30);
    };
    const angles = [];
    const n = Math.round(dur / (1 / 72));
    for (let i = 0; i < n; i++) {
      step(1 / 72);
      if (i % 12 === 0) angles.push(+tackle.debug.handleAngle.toFixed(2));
    }
    script = null;
    return { h0: +h0.toFixed(2), h1: +tackle.debug.handleAngle.toFixed(2), angles, lock: tackle.debug.xr.crankLock };
  },
  bobber() {
    resetAll('bobber');
    restPose('right');
    tackle.cast(0.55, new THREE.Vector3(0.1, 0, -1).normalize(), { pitchRad: 30 * DEG });
    frame.state = STATES.CASTING;
    for (let i = 0; i < 72 * 8 && frame.state === STATES.CASTING; i++) step(1 / 72);
    advance(2.5);
    setHead([0, 1.65, 0], 5, -12);
    advance(0.1);
  },
  snapTurn(o = {}) {
    // the rig turns 30 deg about the head (xr-core's snap turn) with the lure home or out in the water
    resetAll(o.lure || 'spinner');
    restPose('right');
    setHead([0, 1.65, 0], 5, -12);
    rig.rotation.y = 0;
    advance(0.5);
    if (o.out) {
      tackle.cast(0.3, new THREE.Vector3(0, 0, -1));
      frame.state = STATES.CASTING;
      for (let i = 0; i < 72 * 6 && frame.state === STATES.CASTING; i++) step(1 / 72);
      advance(0.5);
    }
    const before = tackle.getLure().position.clone();
    rig.rotation.y = o.noTurn ? 0 : (-30 * Math.PI) / 180;
    rig.updateMatrixWorld(true);
    step(1 / 72);
    const after1 = tackle.getLure().position.clone();
    advance(0.5);
    const r = { mode: tackle.debug.mode, lureMoved: +before.distanceTo(after1).toFixed(3), tipAcc: +tackle.debug.xr.tipAcc.length().toFixed(1), Feff: tackle.debug.Feff.length().toFixed(2) };
    rig.rotation.y = 0;
    rig.updateMatrixWorld(true);
    advance(0.3);
    return r;
  },
  lostTracking() {
    resetAll('spinner');
    restPose('right');
    advance(0.3);
    const t0 = tackle.getRodTip(new THREE.Vector3());
    grips.right.visible = false; // three / xr-core hide a grip with no pose
    // (the grip matrix is garbage while untracked)
    grips.right.matrix.makeTranslation(0, -5, 0);
    step(1 / 72);
    const t1 = tackle.getRodTip(new THREE.Vector3());
    const tracked = tackle.debug.xr.tracked;
    setRay('right', REST_R, 4, -40);
    advance(0.3);
    const t2 = tackle.getRodTip(new THREE.Vector3());
    return { tracked, held: +t0.distanceTo(t1).toFixed(4), back: +t0.distanceTo(t2).toFixed(4) };
  },
  left() {
    tackle.setXRMode(true, { rodGrip: grips.left, reelGrip: grips.right, rodHand: 'left' });
    resetAll('spinner');
    restPose('left');
    setHead([0, 1.65, 0], -8, -18);
    advance(1.2);
  },
  right() {
    tackle.setXRMode(true, { rodGrip: grips.right, reelGrip: grips.left, rodHand: 'right' });
    resetAll('spinner');
    restPose('right');
    advance(0.5);
  },
};

// Landing distance of a cast (from the rod tip at release, horizontal), desktop or VR, same code path.
function castRange(power01, pitchRad, lure = 'spinner') {
  resetAll(lure);
  if (tackle.xrMode) restPose('right');
  advance(0.3);
  const tip0 = tackle.getRodTip(new THREE.Vector3());
  tackle.cast(power01, new THREE.Vector3(0, 0, -1), pitchRad === undefined ? undefined : { pitchRad });
  frame.state = STATES.CASTING;
  for (let i = 0; i < 72 * 10 && frame.state === STATES.CASTING; i++) step(1 / 72);
  const p = landedAt;
  const pred = tackle.predictLanding(power01, new THREE.Vector3(0, 0, -1), new THREE.Vector3(), pitchRad === undefined ? undefined : { pitchRad });
  return { power01, pitchDeg: pitchRad === undefined ? 'default' : +((pitchRad * 180) / Math.PI).toFixed(1), range: p ? +Math.hypot(p.x - tip0.x, p.z - tip0.z).toFixed(2) : null, landedZ: p ? +p.z.toFixed(2) : null, predictedZ: pred ? +pred.z.toFixed(2) : null };
}

window.__xrt = {
  tackle,
  grips,
  rig,
  frame,
  step,
  advance,
  info,
  enter,
  exit,
  setHead,
  setRay,
  setGrip,
  restPose,
  castRange,
  frames,
  setSpam(on) {
    spamXR = !!on;
  },
  gripAxes(on) {
    for (const a of gripAxes) a.visible = on;
  },
  stereo(on) {
    dev().stereoEnabled = !!on;
  },
  setXRMode: (on, hand = 'right') =>
    tackle.setXRMode(on, hand === 'left' ? { rodGrip: grips.left, reelGrip: grips.right, rodHand: 'left' } : { rodGrip: grips.right, reelGrip: grips.left, rodHand: 'right' }),
  async view(name, opts) {
    const r = views[name](opts);
    const i = await frames(2);
    return { ...i, result: r };
  },
};
window.__game = { debug: { stats: () => ({ frames: frameCount, ...info() }) } };
