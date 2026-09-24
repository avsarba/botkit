// Tackle sandbox: stub environment + stub water, a sky for reflections, and a tiny fake "core"
// that drives states, casts, retrieves and a simulated fight. Views are deterministic: the
// simulation is advanced with fixed 1/60 s steps, then rendered.
//   window.__tackle.setView(name) -> Promise (resolves after the view has rendered)
//   names: idle, charging, cast, water20, retrieve, topwater, fight, snap,
//          lure:bobber, lure:spinner, lure:crankbait, lure:topwater, live
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeSandbox, stubEnvironment, stubWater } from './stubs.js';
import { createTackle } from '../tackle/index.js';
import { STATES, TACKLE } from '../config.js';

const params = new URLSearchParams(location.search);
const quality = params.get('q') || 'high';
const sb = makeSandbox({ quality });
const { renderer, scene, camera, events, frame } = sb;
const env = stubEnvironment(sb.ctx);
const water = stubWater(sb.ctx);

// sandbox-only sky + PMREM environment so metals and clear coats have something to reflect
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
  s2.material.uniforms.turbidity.value = 4;
  s2.material.uniforms.rayleigh.value = 1.4;
  skyScene.add(s2);
  const ground = new THREE.Mesh(new THREE.SphereGeometry(900, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2a3326, side: THREE.BackSide }));
  skyScene.add(ground);
  scene.environment = pm.fromScene(skyScene, 0, 0.1, 2000).texture;
  pm.dispose();
}
renderer.toneMappingExposure = 0.9;
water.mesh.material.color.set(0x21424a);
water.mesh.material.envMapIntensity = 1;
water.mesh.material.roughness = 0.06;

// a dark fish stand-in for the fight view
const fishMarker = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8).scale(0.9, 0.9, 3.2), new THREE.MeshStandardMaterial({ color: 0x3b4028, roughness: 0.5 }));
fishMarker.visible = false;
scene.add(fishMarker);

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
  log.push(`landed onWater=${e.onWater} at ${e.position.x.toFixed(1)},${e.position.z.toFixed(1)} speed ${e.speed.toFixed(1)}`);
  if (frame.state === STATES.CASTING) frame.state = STATES.WAITING;
});
events.on('lure:home', () => {
  log.push('home');
  frame.state = STATES.READY;
});
let twitches = 0;
events.on('lure:twitch', () => twitches++);

const eyeBase = new THREE.Vector3(0, 0.55 + 1.65, 0);
// yaw > 0 turns right (three's rotation.y is positive to the left)
function look(yaw, pitch) {
  camera.position.copy(eyeBase);
  camera.rotation.set(pitch, -yaw, 0, 'YXZ');
  frame.input.aimYaw = yaw;
  frame.input.aimPitch = pitch;
  camera.updateMatrixWorld();
}

let reeling = false;
let fightOn = false;
let ft = 0;
const fishP = new THREE.Vector3();
const tipV = new THREE.Vector3();
const dirV = new THREE.Vector3();
let fixedTension = -1;
function fightStep(dt) {
  ft += dt;
  fishP.set(5 * Math.sin(ft * 0.45), -1.1 + 0.55 * Math.sin(ft * 1.3), -15 + 2.5 * Math.cos(ft * 0.35));
  const T = fixedTension >= 0 ? fixedTension : 25 + 25 * Math.sin(ft * 1.7);
  frame.tensionN = T;
  frame.tension01 = T / TACKLE.lineBreakN;
  frame.hooked = { headShake01: 0.35 + 0.3 * Math.sin(ft * 3) };
  frame.input.rodLift01 = 0.55;
  frame.input.rodSide = 0.5 * Math.sin(ft * 0.5);
  tackle.getRodTip(tipV);
  tackle.setFight(true, { fishPosition: fishP, tensionN: T, lineOutM: tipV.distanceTo(fishP) });
  dirV.subVectors(fishP, tipV).normalize();
  tackle.setRodLoad(T, dirV);
  fishMarker.position.copy(fishP);
  fishMarker.lookAt(tipV.x, fishP.y, tipV.z);
  frame.lineOutM = tipV.distanceTo(fishP);
}

function step(dt) {
  frame.dt = dt;
  frame.time += dt;
  if (reeling) {
    frame.input.reeling = true;
    frame.input.reelSpeed01 = 1;
    tackle.reel(dt, TACKLE.reelRetrieveMps);
  } else {
    frame.input.reeling = false;
    frame.input.reelSpeed01 = 0;
  }
  tackle.update(frame);
  if (fightOn) fightStep(dt);
  frame.lure = tackle.getLure();
  frame.lineOutM = frame.lure.lineOutM;
}
function advance(seconds, each) {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    if (each) each(i / 60);
    step(1 / 60);
  }
}

let live = true;
let pendingResolve = null;
let framesToResolve = 0;
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (live) step(dt);
  renderer.render(scene, camera);
  if (pendingResolve && --framesToResolve <= 0) {
    const r = pendingResolve;
    pendingResolve = null;
    r(info());
  }
});

function info() {
  const l = tackle.getLure();
  return {
    state: frame.state,
    lure: { id: l.id, state: l.state, inWater: l.inWater, depthM: +l.depthM.toFixed(2), speedMps: +l.speedMps.toFixed(2), distanceM: +l.distanceM.toFixed(1), lineOutM: +l.lineOutM.toFixed(2), pausedS: +l.pausedS.toFixed(1), retrieving: l.retrieving, pos: l.position.toArray().map((v) => +v.toFixed(2)) },
    tip: tackle.getRodTip(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)),
    calls: renderer.info.render.calls,
    tris: renderer.info.render.triangles,
    twitches,
    log: log.slice(-6),
  };
}

function resetAll(lureId) {
  fightOn = false;
  reeling = false;
  fishMarker.visible = false;
  frame.hooked = null;
  frame.tensionN = 0;
  frame.tension01 = 0;
  frame.input.charge01 = 0;
  frame.input.rodSide = 0;
  frame.input.rodLift01 = 0;
  tackle.object.visible = true;
  frame.state = STATES.READY;
  tackle.setFight(false);
  tackle.setLure(lureId);
  tackle.resetToHome();
  look(0, -0.12);
  advance(1.2);
}

function castTo(power, yaw = 0) {
  frame.state = STATES.CHARGING;
  advance(0.7, (t) => (frame.input.charge01 = Math.min(1, t / 0.6) * power));
  frame.state = STATES.CASTING;
  frame.input.charge01 = 0;
  tackle.cast(power, new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw)));
}

function showLure(id) {
  live = false;
  resetAll(id === 'worm' ? 'bobber' : id);
  tackle.object.visible = false;
  tackle.debug.rope.line.visible = false;
  const worm = id === 'worm';
  if (worm) id = 'bobber';
  const m = tackle.debug.models[id];
  const C = new THREE.Vector3(0.4, 1.3, -2.2);
  const toSun = new THREE.Vector3(env.sunDirection.x, 0, env.sunDirection.z).normalize();
  // stand with the sun behind the camera (camera on the sun side), lure broadside
  const camDir = toSun.clone();
  const dist = worm ? 0.1 : id === 'bobber' ? 0.24 : id === 'topwater' ? 0.17 : 0.12;
  camera.position.copy(C).addScaledVector(camDir, dist).add(new THREE.Vector3(0, 0.05, 0));
  if (worm) camera.position.y -= 0.07;
  camera.lookAt(C.x, C.y - (worm ? 0.085 : id === 'bobber' ? 0.04 : 0), C.z);
  camera.updateMatrixWorld();
  m.object.visible = true;
  m.object.scale.setScalar(1);
  m.object.position.copy(C);
  if (id === 'bobber') {
    m.object.position.y += 0.03;
    m.object.quaternion.identity();
    m.bait.visible = true;
    m.bait.position.set(C.x, C.y - 0.07, C.z);
    m.bait.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(camDir.x, camDir.z) + Math.PI / 2);
    m.shot.visible = true;
    m.shot.position.set(C.x, C.y - 0.035, C.z);
    for (let i = 0; i < 30; i++) m.update({ dt: 1 / 30, inWater: true, speed: 0, active: true });
  } else {
    // broadside to the camera, nose to the right
    const yaw = Math.atan2(camDir.x, camDir.z) - Math.PI / 2;
    m.object.rotation.set(0.05, yaw, 0, 'YXZ');
    for (let i = 0; i < 5; i++) m.update({ dt: 1 / 60, inWater: true, speed: 0.7, flying: false, sinking: false });
  }
  m.object.updateMatrixWorld(true);
}

const views = {
  idle() {
    resetAll('spinner');
  },
  charging() {
    resetAll('crankbait');
    frame.state = STATES.CHARGING;
    advance(0.8, (t) => (frame.input.charge01 = Math.min(0.75, t)));
  },
  cast() {
    resetAll('crankbait');
    castTo(0.85);
    advance(0.75);
  },
  water20() {
    resetAll('bobber');
    castTo(0.75, 0.12);
    for (let i = 0; i < 400 && frame.state === STATES.CASTING; i++) step(1 / 60);
    advance(5);
    look(0.04, -0.1);
    advance(0.4);
  },
  retrieve() {
    resetAll('crankbait');
    castTo(0.7, -0.1);
    for (let i = 0; i < 400 && frame.state === STATES.CASTING; i++) step(1 / 60);
    advance(1.5);
    reeling = true;
    advance(9);
  },
  topwater() {
    resetAll('topwater');
    castTo(0.45, 0.05);
    for (let i = 0; i < 400 && frame.state === STATES.CASTING; i++) step(1 / 60);
    advance(1.5);
    reeling = true;
    advance(3.1);
  },
  fight() {
    resetAll('spinner');
    castTo(0.5);
    for (let i = 0; i < 400 && frame.state === STATES.CASTING; i++) step(1 / 60);
    advance(0.5);
    frame.state = STATES.FIGHTING;
    fightOn = true;
    fishMarker.visible = true;
    ft = 0;
    advance(2.2, () => {
      tackle.getRodTip(tipV);
      const yaw = Math.atan2(fishP.x - eyeBase.x, -(fishP.z - eyeBase.z));
      look(yaw * 0.8, -0.1);
    });
  },
  fight53() {
    fixedTension = TACKLE.lineBreakN;
    views.fight();
    fixedTension = -1;
  },
  bite() {
    resetAll('bobber');
    castTo(0.55, 0.0);
    for (let i = 0; i < 400 && frame.state === STATES.CASTING; i++) step(1 / 60);
    advance(4);
    tackle.nibble(0.8);
    advance(0.5);
    frame.state = STATES.STRIKE;
    tackle.biteDown();
    advance(0.45);
  },
  snap() {
    views.fight();
    fightOn = false;
    frame.state = STATES.SNAPPED;
    tackle.snap();
    advance(0.22);
  },
  home() {
    resetAll('spinner');
    castTo(0.25);
    for (let i = 0; i < 400 && frame.state === STATES.CASTING; i++) step(1 / 60);
    reeling = true;
    for (let i = 0; i < 60 * 30 && frame.state !== STATES.READY; i++) step(1 / 60);
    reeling = false;
    advance(0.6);
  },
};

window.__tackle = {
  tackle,
  frame,
  step,
  advance,
  info,
  setLive(v) {
    live = v;
  },
  setView(name) {
    live = false;
    if (name.startsWith('lure:')) showLure(name.slice(5));
    else if (name === 'worm') showLure('worm');
    else if (name === 'live') {
      resetAll('spinner');
      live = true;
    } else views[name]();
    framesToResolve = 2;
    return new Promise((r) => (pendingResolve = r));
  },
};
window.__game = {
  debug: {
    stats: () => ({ drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, ...info() }),
  },
};
