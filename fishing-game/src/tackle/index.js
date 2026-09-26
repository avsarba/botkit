// Tackle: first-person rod + spinning reel view model, verlet fishing line, terminal tackle models
// and their physics (casting flight, retrieve behaviour per lure, float rig, fight, line break).
// See CONTRACT.md "Tackle". World units are meters; the lake surface is y = 0.
// VR (XR.md): setXRMode(true, { rodGrip, reelGrip, rodHand }) moves the rod from the camera-attached half-scale
// view model onto the rod-hand controller grip at full scale (gloves without forearms on both hands); the bend,
// guides, line, tip, bail and handle then run from the grip pose, the swing itself loads the blank, the reel
// hand can turn the handle, and cast(power01, direction, { pitchRad }) takes the swing's launch elevation.
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { TACKLE, LURES, STATES, LAYERS, DOCK, G, clamp, lerp, damp, smoothstep, makeRng } from '../config.js';
import { createRod, ROD } from './rod.js';
import { createLureModels } from './lures.js';
import { createRope, enhanceLineMaterial } from './rope.js';
import { createHand } from './hand.js';

// The view model is drawn at half scale around the eye: identical on screen (projection is
// scale-invariant about the camera), but it can never intersect the dock, posts or terrain.
const VM_SCALE = 0.5;
const HOME_LEN = 0.3; // line hanging below the tip-top with a lure tied on (m)
const FLOAT_HOME_MAIN = 0.32; // tip-top to the float when the float rig is reeled up
const HOME_RADIUS = 1.2; // lure:home when this close (horizontally) to the rod tip
const GEAR = 6.2; // spinning reel gear ratio
const TURNS_PER_S = TACKLE.reelTurnsPerS; // handle turns per second at full retrieve
const LAUNCH_ELEV = 0.52; // ~30 deg launch angle
const LINE_DRAG = 0.06; // 1/s, spool friction + drag of the line paying out
const WIND_MPS = 7; // env.windStrength 1 -> 7 m/s
const LEADER_SEGS = 10;
const WALK_PERIOD = 0.4; // topwater walk-the-dog cadence while reeling (s)
const FLOAT_RIDE = 0.003; // float center above the surface at rest (m)
// line segment lengths grow away from the rod tip (far segment = 1 + SEG_GROW times the first):
// resolution where the line is close to the eye, and new line in flight is not all added at the tip
const SEG_GROW = 3;
const TIP_SEGS = 6; // in flight the first few segments off the tip-top stay short ...
const TIP_REST = 0.1; // ... at most this long (m), so paid-out line cannot fold up under the tip
// VR (WebXR, see XR.md): the real rod rides the rod-hand controller grip at full scale
const XR_TILT = THREE.MathUtils.degToRad(20); // blank tilted this far above the grip's forward (-Z) axis
const XR_SEAT = new THREE.Vector3(0, 0, 0.006); // reel seat from the grip origin (rod-local: axis through the palm)
const XR_LINE_PX = 1.5; // line width per eye in the headset (device px)
const XR_TIP_MASS = 0.055; // kg: tip section + tackle lagging a swung rod (inertial bend)
const XR_ACC_DEAD = 6; // m/s^2 of tip acceleration ignored (tracking jitter)
const PITCH_MIN = THREE.MathUtils.degToRad(8); // cast({ pitchRad }) launch elevation range
const PITCH_MAX = THREE.MathUtils.degToRad(55);

const PHYS = {
  // pxSize: characteristic silhouette size used for the screen-space minimum size (m)
  bobber: { drag: 0.032, massKg: 0.012, retrieveN: 0.45, minPx: 8, pxSize: 0.03, radius: 0.015 },
  spinner: { drag: 0.011, massKg: 0.007, retrieveN: 0.9, minPx: 4, pxSize: 0.035, radius: 0.004, sink: 0.33 },
  crankbait: { drag: 0.01, massKg: 0.014, retrieveN: 2.2, minPx: 4, pxSize: 0.04, radius: 0.011, rise: 0.13, maxDepth: 2.4 },
  topwater: { drag: 0.009, massKg: 0.012, retrieveN: 0.55, minPx: 5, pxSize: 0.05, radius: 0.0095 },
};

const EMPTY_INPUT = Object.freeze({ aimYaw: 0, aimPitch: 0, charge01: 0, reeling: false, reelSpeed01: 0, rodSide: 0, rodLift01: 0 });
const UP = new THREE.Vector3(0, 1, 0);
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);

// ---- casting range calibration (same integrator as the flight) ----
const RANGE_TABLES = new Map();
function rangeFor(v0, k) {
  let x = 0;
  let y = 3.0;
  let vx = v0 * Math.cos(LAUNCH_ELEV);
  let vy = v0 * Math.sin(LAUNCH_ELEV);
  const h = 1 / 240;
  for (let i = 0; i < 6000; i++) {
    const sp = Math.hypot(vx, vy);
    vx += (-k * sp * vx - LINE_DRAG * vx) * h;
    vy += (-G - k * sp * vy - LINE_DRAG * vy) * h;
    x += vx * h;
    y += vy * h;
    if (y <= 0) return x;
  }
  return x;
}
function speedForRange(k, R) {
  let t = RANGE_TABLES.get(k);
  if (!t) {
    const vs = [];
    const rs = [];
    for (let v = 0.5; v <= 70; v += 0.5) {
      vs.push(v);
      rs.push(rangeFor(v, k));
    }
    t = { vs, rs };
    RANGE_TABLES.set(k, t);
  }
  const { vs, rs } = t;
  if (R <= rs[0]) return vs[0];
  for (let i = 1; i < vs.length; i++) {
    if (rs[i] >= R) {
      const f = (R - rs[i - 1]) / Math.max(1e-6, rs[i] - rs[i - 1]);
      return vs[i - 1] + (vs[i] - vs[i - 1]) * f;
    }
  }
  return vs[vs.length - 1];
}

const finite = (v, fb) => (Number.isFinite(v) ? v : fb);
const vfinite = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

export function createTackle(ctx) {
  const { renderer, scene, camera, events, env, water } = ctx;
  const quality = ctx.quality || 'high';
  const rng = makeRng(0x7ac1e);

  // ------------------------------------------------------------------ scratch
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _q3 = new THREE.Quaternion();
  const _f = new THREE.Vector3();
  const _size = new THREE.Vector2();
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _n = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const camScale = new THREE.Vector3();
  const vmQuat = new THREE.Quaternion();
  const wind = new THREE.Vector3();

  // ------------------------------------------------------------------ rod view model
  const rod = createRod({ quality });
  const vmRoot = new THREE.Group();
  vmRoot.name = 'tackle-viewmodel';
  vmRoot.scale.setScalar(VM_SCALE);
  vmRoot.add(rod.object);
  scene.add(vmRoot);
  const hand = createHand({ quality });
  rod.object.add(hand.object);

  // VR: mounts that ride the controller grips (children of the grips while presenting). Rod-local +Y (the
  // blank) -> the grip's forward axis tilted XR_TILT up; rod-local -Z (reel side) hangs below the hand.
  const xrRodMount = new THREE.Group();
  xrRodMount.name = 'tackle-xr-rod';
  xrRodMount.quaternion.setFromAxisAngle(AX_X, XR_TILT - Math.PI / 2);
  const xrReelMount = new THREE.Group(); // reel-hand glove, closed round the controller handle (grip -Z)
  xrReelMount.name = 'tackle-xr-reel-hand';
  xrReelMount.quaternion.setFromAxisAngle(AX_X, -Math.PI / 2);
  let xrHands = null; // gloves without the forearm, built on first use (share the desktop glove materials)
  let xrOn = false;
  let xrRodGrip = null;
  let xrReelGrip = null;
  let xrRodHand = 'right';
  let xrTracked = false; // rod grip pose valid this frame
  let xrHadPose = false; // ... at least once since entering VR
  let xrJump = false; // the tip jumps (mode switch): treat as a teleport
  // rigid (unbent) tip kinematics of the swung rod, smoothed: velocity ~20 ms, acceleration ~30 ms
  const xrTipP = new THREE.Vector3();
  const xrTipV = new THREE.Vector3();
  const xrTipA = new THREE.Vector3();
  let xrKinInit = false;
  const _xm = new THREE.Vector3();
  const _xs = new THREE.Vector3();

  // ------------------------------------------------------------------ line
  // Colours are per point (rope tints, linear RGB); the material only carries the lighting.
  const LINE_COLOR = new THREE.Color('#cce366'); // hi-vis yellow-green 12 lb mono
  const LEADER_COLOR = new THREE.Color('#8c9e94'); // clear fluorocarbon leader under the float
  const LINE_ALPHA = 0.92;
  const LEADER_ALPHA = 0.45;
  const lineMat = new LineMaterial({
    color: 0xffffff,
    linewidth: 1.2, // CSS px (Line2 sizes against the CSS viewport)
    worldUnits: false,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    fog: true,
  });
  const lineLook = enhanceLineMaterial(lineMat);
  const nPts = quality === 'high' ? 64 : quality === 'medium' ? 56 : 44;
  const iterations = quality === 'high' ? 18 : quality === 'medium' ? 14 : 10;
  const rope = createRope(nPts, lineMat, { subdiv: quality === 'low' ? 2 : 3 });
  rope.line.name = 'fishing-line';
  scene.add(rope.line);
  const F1 = nPts - LEADER_SEGS - 2; // float top clip
  const F2 = F1 + 1; // float bottom clip
  const tail = createRope(12, lineMat, { subdiv: 2 });
  tail.line.name = 'fishing-line-tail';
  tail.line.visible = false;
  scene.add(tail.line);
  const inRod = createRope(8, lineMat, { renderOrder: 13 });
  inRod.line.name = 'fishing-line-guides';
  rod.object.add(inRod.line);
  rope.setTint(0, nPts - 1, LINE_COLOR, LINE_ALPHA);
  tail.setTint(0, tail.n - 1, LINE_COLOR, LINE_ALPHA);
  inRod.setTint(0, inRod.n - 1, LINE_COLOR, 1);
  // Line2 sizes its width against renderer.getViewport(), which spans BOTH eyes while presenting (twice the
  // eye's aspect: the line would come out skewed and too thin). Each eye's sub-camera carries its own
  // viewport; size the line per eye from it. Off the headset this is the stock behaviour.
  function perEyeLine(line) {
    const stock = line.onBeforeRender;
    line.onBeforeRender = function (r, s, cam, geo, mat, grp) {
      const vp = cam && cam.viewport;
      if (vp && vp.z > 0 && vp.w > 0 && r && r.xr && r.xr.isPresenting) {
        const u = this.material && this.material.uniforms;
        if (u && u.resolution) u.resolution.value.set(vp.z, vp.w);
        return;
      }
      stock.call(this, r, s, cam, geo, mat, grp);
    };
  }
  perEyeLine(rope.line);
  perEyeLine(tail.line);
  perEyeLine(inRod.line);

  vmRoot.traverse((o) => {
    o.layers.enable(LAYERS.NO_REFLECT);
    if (o.isMesh || o.isLine2) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    }
  });
  rope.line.layers.enable(LAYERS.NO_REFLECT);
  tail.line.layers.enable(LAYERS.NO_REFLECT);

  // ------------------------------------------------------------------ terminal tackle models
  const lureSet = createLureModels({ quality });
  const models = lureSet.models;
  for (const m of Object.values(models)) {
    for (const o of [m.object, m.bait, m.shot]) {
      if (!o) continue;
      o.visible = false;
      scene.add(o);
      o.traverse((c) => {
        c.layers.enable(LAYERS.UNDERWATER);
        if (c.isMesh) {
          c.castShadow = false;
          c.receiveShadow = false;
        }
      });
    }
  }

  // ------------------------------------------------------------------ state
  let lureIdx = 0;
  let lureId = LURES[0].id;
  let model = models[lureId] || models.spinner;
  let ph = PHYS[lureId] || PHYS.spinner;
  let isBobber = lureId === 'bobber';
  let leader = isBobber ? finite(LURES[0].depthM, 1.5) : 0;

  let mode = 'home'; // home | launch | flying | water | land | fish | lost
  let lost = false;
  let lineOut = HOME_LEN;
  let autoWind = false;
  const L = new THREE.Vector3(); // lure / hook (bait) position
  const Lprev = new THREE.Vector3(); // verlet previous (home pendulum, bait)
  const LV = new THREE.Vector3(); // explicit velocity (flight, water skid)
  const Lframe = new THREE.Vector3(); // position at the previous frame (speed)
  const Lvel = new THREE.Vector3(); // measured velocity (snapshot)
  const F = new THREE.Vector3(); // float center (bobber rig)
  const Fprev = new THREE.Vector3();
  const FV = new THREE.Vector3();
  const Fframe = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const tipPrev = new THREE.Vector3();
  const tipVel = new THREE.Vector3();
  let tipInit = false;
  const fishPos = new THREE.Vector3();
  let fightTension = 0;
  let fightLineOut = 5;
  let castT = 99;
  let castPower = 0.5;
  let castPitch = LAUNCH_ELEV; // launch elevation of the current cast (cast({ pitchRad }) in VR)
  const castDir = new THREE.Vector3(0, 0, -1);
  let flightT = 0;
  let landT = 0;
  let reelT = 99;
  let reelSpeed = 0;
  let speedS = 0;
  let pausedS = 0;
  let taut = false;
  let retrieveTension = 0;
  let surfAtLure = 0;
  let walkTimer = 0;
  let walkSide = 1;
  let walkLat = 0;
  let walkLatPrev = 0;
  let biteHold = false;
  let biteT = 99;
  let biteLoadT = 99;
  const biteDir = new THREE.Vector3(1, 0, 0);
  let lastNibbleT = -1;
  let lastBiteT = -1;
  let snapT = 99;
  let lostT = 0;
  let time = 0;
  let lastState = null;
  let frameState = STATES.READY;
  let lastTension01 = 0;
  let headShake = 0;
  let floatHang = 0;
  let lureYaw = 0;
  let lurePitch = 0;
  let floatLostVisible = false;
  let tipCap01 = 0; // 1 while the line pays out in flight (short segments just off the tip)
  let dipT = 99; // seconds since the last nibble (display dip of the float)
  let dipAmp = 0;
  const dipDir = new THREE.Vector3(1, 0, 0);
  let rigHidden = false; // CAUGHT: line and terminal tackle are out of the picture

  // reel animation
  let handleAngle = 2.4;
  let handleOmega = 0;
  let bail01 = 0;
  let bailTarget = 0;
  let spoolSpin = 0;
  let lineSpin = 0;

  // rod load (rod-local spring)
  const Feff = new THREE.Vector3();
  const FeffV = new THREE.Vector3();
  const Ftarget = new THREE.Vector3();
  const extDir = new THREE.Vector3(0, -1, 0);
  let extN = 0;
  let extAge = 99;

  // pose: [hx, hy, hz, pitch, yaw, roll] in camera space (meters, radians)
  const NP = 7; // [hx, hy, hz, pitch, yaw, roll, lean]
  const pose = new Float64Array(NP);
  const poseV = new Float64Array(NP);
  const tgt = new Float64Array(NP);
  let tgtOmega = 8;
  let tgtZeta = 0.92;
  const base = new Float64Array(NP);
  let lastAspect = -1;
  let lastFov = -1;
  let poseInit = false;
  let vmInit = false;

  // snapshot (reused)
  const bobberPos = new THREE.Vector3();
  const snapshot = {
    id: lureId,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    state: 'home',
    inWater: false,
    depthM: 0,
    speedMps: 0,
    retrieving: false,
    pausedS: 0,
    distanceM: 0,
    lineOutM: HOME_LEN,
    bobberPosition: null,
    lost: false,
  };

  // ------------------------------------------------------------------ helpers
  const homeMain = () => (isBobber ? FLOAT_HOME_MAIN : HOME_LEN);
  const homeLine = () => (isBobber ? FLOAT_HOME_MAIN + leader : HOME_LEN);
  const inDeckXZ = (p) => p.x > -DOCK.width / 2 && p.x < DOCK.width / 2 && p.z > DOCK.endZ && p.z < DOCK.shoreZ;

  function updateWind() {
    const s = finite(env.windStrength, 0.25);
    const d = env.windDirection;
    if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) wind.set(d.x, 0, d.y).multiplyScalar(s * WIND_MPS);
    else wind.set(0, 0, 0);
  }

  function computeBasePose() {
    const aspect = clamp(camera.aspect || 16 / 9, 0.25, 4);
    const fov = camera.fov || 60;
    lastAspect = aspect;
    lastFov = fov;
    const tanV = Math.tan(THREE.MathUtils.degToRad(fov) * 0.5);
    const tanH = tanV * aspect;
    const portrait = clamp((1.3 - aspect) / (1.3 - 0.46), 0, 1);
    const hd = lerp(0.6, 0.56, portrait);
    const hnx = lerp(0.56, 0.5, portrait);
    const hny = lerp(-0.64, -0.5, portrait);
    const tnx = lerp(0.06, 0.08, portrait);
    const tny = lerp(0.68, 0.5, portrait);
    const Hx = hnx * hd * tanH;
    const Hy = hny * hd * tanV;
    const Hz = -hd;
    let rx = tnx * tanH;
    let ry = tny * tanV;
    let rz = -1;
    const rl = Math.hypot(rx, ry, rz);
    rx /= rl;
    ry /= rl;
    rz /= rl;
    const Lr = ROD.tipY;
    const rH = rx * Hx + ry * Hy + rz * Hz;
    const HH = Hx * Hx + Hy * Hy + Hz * Hz;
    const t = rH + Math.sqrt(Math.max(0, rH * rH - HH + Lr * Lr));
    const dx = rx * t - Hx;
    const dy = ry * t - Hy;
    const dz = rz * t - Hz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    base[0] = Hx;
    base[1] = Hy;
    base[2] = Hz;
    base[3] = Math.asin(clamp(dy / dl, -1, 1));
    base[4] = Math.atan2(dx / dl, -dz / dl);
    base[5] = lerp(0.1, 0.04, portrait);
    base[6] = 0;
  }

  function lureBearing() {
    // horizontal angle of the lure relative to the camera forward (+ = right)
    _v.copy(mode === 'fish' ? fishPos : isBobber ? F : L).sub(camPos);
    _q.copy(camQuat).invert();
    _v.applyQuaternion(_q);
    return Math.atan2(_v.x, -_v.z);
  }

  function setTargets(state, input) {
    for (let i = 0; i < NP; i++) tgt[i] = base[i];
    tgtOmega = 8;
    tgtZeta = 0.92;
    const reeling = !!input.reeling || reelT < 0.12;
    if (castT < 0.6) {
      if (castT < 0.2) {
        tgt[3] = base[3] - 0.62;
        tgt[2] = base[2] - 0.08;
        tgt[1] = base[1] - 0.02;
        tgtOmega = 30;
        tgtZeta = 0.6;
      } else {
        tgt[3] = base[3] - 0.42;
        tgt[2] = base[2] - 0.06;
        tgtOmega = 6;
        tgtZeta = 1;
      }
      return;
    }
    switch (state) {
      case STATES.CHARGING: {
        const c = smoothstep(0, 1, clamp(finite(input.charge01, 0), 0, 1));
        tgt[3] = lerp(base[3] + 0.12, 1.85, c);
        tgt[4] = base[4] + 0.12 * c;
        tgt[5] = base[5] + 0.25 * c;
        tgt[6] = 0.42 * c; // leans back over the right shoulder
        tgt[0] = base[0] + 0.08 * c;
        tgt[1] = base[1] + 0.16 * c;
        tgt[2] = base[2] + 0.12 * c;
        tgtOmega = 9;
        tgtZeta = 0.85;
        break;
      }
      case STATES.CASTING:
        tgt[3] = base[3] - 0.4;
        tgt[2] = base[2] - 0.05;
        tgtOmega = 5;
        tgtZeta = 1;
        break;
      case STATES.WAITING:
      case STATES.STRIKE: {
        const b = clamp(lureBearing(), -0.6, 0.6);
        tgt[3] = base[3] - (reeling ? 0.3 : 0.06);
        tgt[4] = base[4] + b * 0.3 + (reeling ? 0.16 : 0);
        tgt[6] = reeling ? 0.1 : 0;
        tgt[2] = base[2] - (reeling ? 0.03 : 0);
        tgtOmega = 5;
        tgtZeta = 1;
        break;
      }
      case STATES.FIGHTING:
      case STATES.LANDING: {
        const lift = state === STATES.LANDING ? 0.85 : clamp(finite(input.rodLift01, 0.35), 0, 1);
        const side = state === STATES.LANDING ? 0 : clamp(finite(input.rodSide, 0), -1, 1);
        tgt[3] = lerp(base[3] - 0.08, base[3] + 0.62, lift) - Math.abs(side) * 0.32;
        tgt[4] = base[4] + side * 0.52;
        tgt[5] = base[5] + side * 0.45;
        tgt[6] = side * 0.3;
        tgt[0] = base[0] + side * 0.1;
        tgt[1] = base[1] + lift * 0.1 - Math.abs(side) * 0.04;
        tgt[2] = base[2] + lift * 0.05;
        tgtOmega = 6.5;
        tgtZeta = 0.85;
        break;
      }
      case STATES.CAUGHT:
        tgt[3] = base[3] - 0.5;
        tgt[4] = base[4] + 0.36;
        tgt[0] = base[0] + 0.12;
        tgt[1] = base[1] - 0.16;
        tgt[2] = base[2] + 0.06;
        tgtOmega = 4;
        tgtZeta = 1;
        break;
      default:
        break;
    }
  }

  function updatePose(dt, state, input) {
    if (camera.aspect !== lastAspect || camera.fov !== lastFov) computeBasePose();
    setTargets(state, input);
    if (!poseInit) {
      for (let i = 0; i < NP; i++) pose[i] = tgt[i];
      poseInit = true;
    }
    const n = Math.max(1, Math.ceil(dt / 0.006));
    const h = dt / n;
    const w2 = tgtOmega * tgtOmega;
    const c = 2 * tgtZeta * tgtOmega;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < NP; i++) {
        const a = w2 * (tgt[i] - pose[i]) - c * poseV[i];
        poseV[i] += a * h;
        pose[i] += poseV[i] * h;
      }
    }
    for (let i = 0; i < NP; i++) {
      if (!Number.isFinite(pose[i]) || !Number.isFinite(poseV[i])) {
        pose[i] = tgt[i];
        poseV[i] = 0;
      }
    }
  }

  function applyPose(state) {
    const t = time;
    const calm = state === STATES.FIGHTING || state === STATES.LANDING || castT < 0.8 ? 0.35 : 1;
    let dP = calm * (0.0075 * Math.sin(t * 1.32) + 0.0028 * Math.sin(t * 3.58 + 1.3));
    let dY = calm * 0.0055 * Math.sin(t * 1.0 + 0.4);
    const dHy = calm * 0.0035 * Math.sin(t * 1.32 + 0.8);
    if (handleOmega > 0.5) {
      dP += 0.0032 * Math.sin(handleAngle);
      dY += 0.0022 * Math.cos(handleAngle);
    }
    if (state === STATES.FIGHTING) {
      const tr = lastTension01;
      dP += tr * (0.006 * Math.sin(t * 37) + 0.004 * Math.sin(t * 23 + 1));
      dY += tr * 0.004 * Math.sin(t * 29 + 2);
    }
    rod.object.position.set(pose[0], pose[1] + dHy, pose[2]);
    _q.setFromAxisAngle(AX_Z, -pose[6]);
    _q2.setFromAxisAngle(AX_Y, -(pose[4] + dY));
    _q.multiply(_q2);
    _q2.setFromAxisAngle(AX_X, pose[3] + dP);
    _q.multiply(_q2);
    _q2.setFromAxisAngle(AX_X, -Math.PI / 2);
    _q.multiply(_q2);
    _q2.setFromAxisAngle(AX_Y, pose[5]);
    _q.multiply(_q2);
    rod.object.quaternion.copy(_q);
  }

  function followCamera(dt) {
    camera.updateMatrixWorld();
    camera.matrixWorld.decompose(camPos, camQuat, camScale);
    if (!vmInit) {
      vmQuat.copy(camQuat);
      vmInit = true;
    } else {
      vmQuat.slerp(camQuat, 1 - Math.exp(-15 * dt));
      const ang = vmQuat.angleTo(camQuat);
      if (ang > 0.14) vmQuat.rotateTowards(camQuat, ang - 0.14);
    }
    vmRoot.position.copy(camPos);
    vmRoot.quaternion.copy(vmQuat);
    vmRoot.updateMatrixWorld(true);
  }

  // VR: no view model. The head pose (camera, kept in sync with the headset by three) still feeds the
  // screen-space sizes and line lighting; the rod rides the grip, whose pose three set for this frame.
  function followGrip(dt) {
    xrTracked = !!xrRodGrip && xrRodGrip.visible !== false && xrRodMount.parent === xrRodGrip;
    xrRodMount.updateWorldMatrix(true, true); // rig -> grip -> mount -> rod, as posed for this frame
    if (xrReelMount.parent) xrReelMount.updateWorldMatrix(true, true);
    camera.updateWorldMatrix(true, false); // (after a snap turn the rig moved this frame)
    camera.matrixWorld.decompose(camPos, camQuat, camScale);
    if (xrTracked) xrHadPose = true;
    // rigid tip kinematics (the bend is driven by them, so they must not see it)
    _xm.set(0, ROD.tipY, 0).applyMatrix4(rod.object.matrixWorld);
    const jump = !xrTracked || xrJump || !xrKinInit || !(dt > 1e-5) || _xm.distanceTo(xrTipP) > Math.max(0.45, 30 * dt);
    if (jump) {
      xrTipP.copy(_xm);
      xrTipV.set(0, 0, 0);
      xrTipA.set(0, 0, 0);
      xrKinInit = xrTracked;
      return;
    }
    _xs.subVectors(_xm, xrTipP).multiplyScalar(1 / dt); // raw velocity
    xrTipP.copy(_xm);
    _v2.copy(xrTipV);
    xrTipV.lerp(_xs, 1 - Math.exp(-dt / 0.02));
    _xs.subVectors(xrTipV, _v2).multiplyScalar(1 / dt); // acceleration of the smoothed velocity
    xrTipA.lerp(_xs, 1 - Math.exp(-dt / 0.03));
    if (!vfinite(xrTipV) || !vfinite(xrTipA)) {
      xrTipV.set(0, 0, 0);
      xrTipA.set(0, 0, 0);
    }
  }

  // World rotation of the rod frame (rod-local <-> world for loads and taps).
  function rodWorldQuat(out) {
    if (xrOn) {
      rod.object.matrixWorld.decompose(_xm, out, _xs);
      return out;
    }
    return out.copy(vmQuat).multiply(rod.object.quaternion);
  }

  // Bring a point from the half-scale view model to true scale about the eye (the view model is drawn at
  // VM_SCALE around the camera); identity in VR, where the rod is the real size in the hand.
  function trueScale(p) {
    if (!xrOn) p.sub(camPos).multiplyScalar(1 / VM_SCALE).add(camPos);
    return p;
  }

  function computeTip(dt) {
    if (xrOn) {
      if (xrTracked) tip.copy(rod.tipLocal).applyMatrix4(rod.object.matrixWorld);
      else if (!xrHadPose) tip.copy(restTipLocal).applyQuaternion(camQuat).add(camPos); // not tracked yet
      // (tracking lost: the tip stays where it was)
    } else {
      _v.copy(rod.tipLocal).applyMatrix4(rod.object.matrixWorld);
      tip.copy(_v).sub(camPos).multiplyScalar(1 / VM_SCALE).add(camPos);
    }
    if (!tipInit) {
      tipPrev.copy(tip);
      tipInit = true;
    }
    // a hand-held tip moves fast but never 30 m/s: a snap turn or a mode switch is a teleport
    if (xrOn) teleported = xrJump || tip.distanceTo(tipPrev) > Math.max(0.45, 30 * dt);
    else teleported = xrJump || tip.distanceToSquared(tipPrev) > 1.5 * 1.5;
    xrJump = false;
    if (teleported) tipJump.subVectors(tip, tipPrev);
    if (dt > 1e-5) tipVel.subVectors(tip, tipPrev).multiplyScalar(1 / dt);
    tipPrev.copy(tip);
  }
  let teleported = false;
  const tipJump = new THREE.Vector3();

  // ------------------------------------------------------------------ reel
  function animateReel(dt, input, frame) {
    const sp01 = input.reeling ? clamp(finite(input.reelSpeed01, 1), 0, 1) : 0;
    const cmd = reelT < 0.12 ? clamp(reelSpeed / TACKLE.reelRetrieveMps, 0, 1.5) : 0;
    const rate = Math.max(sp01, cmd) * TURNS_PER_S * Math.PI * 2;
    const handTurn = xrOn && crankByHand(dt, rate);
    if (!handTurn) handleOmega = damp(handleOmega, rate, 14, dt);
    if (handleOmega > 1 && bailTarget > 0.5 && mode !== 'flying' && mode !== 'launch' && frameState !== STATES.CHARGING) bailTarget = 0;
    if (!handTurn) handleAngle = (handleAngle + handleOmega * dt) % (Math.PI * 2000);
    const bailRate = bailTarget > bail01 ? 9 : 6;
    bail01 = bail01 < bailTarget ? Math.min(bailTarget, bail01 + bailRate * dt) : Math.max(bailTarget, bail01 - bailRate * dt);
    const slip = Math.max(0, finite(frame && frame.slipMps, 0));
    spoolSpin = (spoolSpin - (slip / 0.022) * dt) % (Math.PI * 2000);
    if (mode === 'flying') lineSpin += dt * 70;
    const fill01 = 1 - clamp(lineOut / TACKLE.spoolCapacityM, 0, 1);
    rod.animateReel(handleAngle, handleAngle * GEAR, bail01, 0.0026 * Math.sin(handleAngle * 0.5), spoolSpin, fill01);
  }

  // VR: the reel hand circling the handle knob turns it. The handle follows the hand's angle about the crank
  // axis, forward only (anti-reverse: turning back just lets go), and never slower than the retrieve the
  // game commands (trigger reeling spins it too). Returns true while the hand drives the handle.
  let crankLock = false;
  let crankHandInit = false;
  let crankHandPrev = 0; // hand angle about the crank axis last frame (wrapped)
  let crankHandU = 0; // ... unwrapped
  let crankHandW = 0; // smoothed hand angular speed (rad/s, + = reeling direction)
  let crankOffset = 0; // handleAngle - hand angle while locked
  let crankSlowT = 0;
  const KNOB_R = 0.0465; // crank arm (knob circle radius)
  function crankByHand(dt, rate) {
    if (!xrReelGrip || xrReelGrip.visible === false || !xrReelMount.parent || !xrTracked || !(dt > 1e-5)) {
      crankLock = false;
      crankHandInit = false;
      return false;
    }
    // reel hand in the reel's frame, relative to the crank pivot (the knob sits at (0, R sin h, R cos h))
    _xs.setFromMatrixPosition(xrReelGrip.matrixWorld);
    rod.reel.worldToLocal(_xs).sub(rod.crank.position);
    const th = Math.atan2(_xs.y, _xs.z);
    const r = Math.hypot(_xs.y, _xs.z);
    const kx = rod.crank.scale.x * rod.knobLocal.x;
    const dKnob = Math.hypot(_xs.x - kx, _xs.y - KNOB_R * Math.sin(handleAngle), _xs.z - KNOB_R * Math.cos(handleAngle));
    const inZone = r > 0.012 && r < 0.2 && Math.abs(_xs.x - kx) < 0.16;
    if (!crankHandInit) {
      crankHandInit = true;
      crankHandPrev = th;
      crankHandU = th;
      crankHandW = 0;
    }
    let d = th - crankHandPrev;
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    crankHandPrev = th;
    crankHandU += d;
    crankHandW = damp(crankHandW, clamp(d / dt, -60, 60), 12, dt);
    if (!crankLock) {
      if (!(inZone && dKnob < 0.16 && crankHandW > 2)) return false;
      crankLock = true;
      crankSlowT = 0;
      crankOffset = handleAngle - crankHandU;
    } else {
      crankSlowT = crankHandW < 0.5 ? crankSlowT + dt : 0;
      if (!inZone || dKnob > 0.25 || crankSlowT > 0.35) {
        crankLock = false;
        return false;
      }
    }
    const target = crankHandU + crankOffset;
    const byRate = handleAngle + rate * dt;
    let next = Math.min(Math.max(byRate, target), handleAngle + 7 * Math.PI * 2 * dt); // cap at 7 turns/s
    if (next < handleAngle) next = handleAngle;
    if (target < next) crankOffset = next - crankHandU; // anti-reverse / the retrieve got ahead: re-anchor
    handleOmega = damp(handleOmega, (next - handleAngle) / dt, 20, dt);
    handleAngle = next;
    const wrap = Math.PI * 2000;
    if (handleAngle >= wrap) {
      handleAngle -= wrap;
      crankOffset -= wrap;
    }
    return true;
  }

  // ------------------------------------------------------------------ rod load / bend
  function lineDirAtTip(out) {
    rope.getPoint(1, out).sub(tip);
    const l = out.length();
    if (l < 1e-6) return out.set(0, -1, 0);
    return out.multiplyScalar(1 / l);
  }

  function updateRodLoad(dt, state, frame) {
    Ftarget.set(0, 0, 0);
    // internal load from the terminal tackle
    lineDirAtTip(_v3);
    if (mode === 'home' || mode === 'launch') {
      const m = ph.massKg + (isBobber ? 0.003 : 0);
      _v.copy(isBobber ? F : L).sub(tip);
      const len = Math.max(0.05, _v.length());
      _v.multiplyScalar(1 / len);
      Ftarget.addScaledVector(_v, clamp(m * G * 1.3, 0, 3));
      if (state === STATES.CHARGING && !xrOn) Ftarget.addScaledVector(_v, clamp(finite(frame.input && frame.input.charge01, 0), 0, 1) * 1.4);
    } else if (mode === 'flying') {
      Ftarget.addScaledVector(_v3, 0.12);
    } else if (mode === 'water' || mode === 'land') {
      Ftarget.addScaledVector(_v3, taut ? retrieveTension : 0.02);
    }
    if (biteLoadT < 0.4) Ftarget.addScaledVector(_v3, 4.5 * (1 - biteLoadT / 0.4));
    if (biteHold && isBobber && mode === 'water') Ftarget.addScaledVector(_v3, 0.9);
    // external (core fight model)
    extAge += dt;
    if (extAge > 0.3) extN = damp(extN, 0, 5, dt);
    if (extN > 0 && mode !== 'lost') Ftarget.addScaledVector(extDir, extN);
    else if (mode === 'fish' && extAge > 0.3) Ftarget.addScaledVector(_v3, fightTension);
    if (xrOn) {
      // the real swing: the tip section and the tackle lag behind the stroke (d'Alembert load -m a)
      const a = xrTipA.length();
      if (a > XR_ACC_DEAD && Number.isFinite(a)) Ftarget.addScaledVector(xrTipA, (-XR_TIP_MASS * Math.min(a - XR_ACC_DEAD, 300)) / a);
    } else if (castT < 0.2) {
      // scripted inertial load during the forward cast stroke: tip lags behind the stroke
      const pulse = Math.sin(clamp(castT / 0.2, 0, 1) * Math.PI);
      _v.set(0, 0.35, 1).normalize().applyQuaternion(vmQuat);
      Ftarget.addScaledVector(_v, pulse * (2 + castPower * 6));
    }
    // world -> rod-local
    rodWorldQuat(_q).invert();
    _f.copy(Ftarget).applyQuaternion(_q);
    // head shakes: random taps on the tip
    if (state === STATES.FIGHTING && headShake > 0.05 && rng() < headShake * dt * 12) {
      const k = 40 * headShake * (0.5 + rng());
      FeffV.x += (rng() - 0.5) * k;
      FeffV.z += (rng() - 0.5) * k;
      FeffV.addScaledVector(_f.lengthSq() > 1e-6 ? _v.copy(_f).normalize() : _v.set(0, 0, -1), (rng() - 0.3) * k);
    }
    const omega = 17;
    const zeta = snapT < 1.6 ? 0.09 : 0.5;
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      FeffV.x += (omega * omega * (_f.x - Feff.x) - 2 * zeta * omega * FeffV.x) * h;
      FeffV.y += (omega * omega * (_f.y - Feff.y) - 2 * zeta * omega * FeffV.y) * h;
      FeffV.z += (omega * omega * (_f.z - Feff.z) - 2 * zeta * omega * FeffV.z) * h;
      Feff.addScaledVector(FeffV, h);
    }
    if (!vfinite(Feff) || !vfinite(FeffV)) {
      Feff.set(0, 0, 0);
      FeffV.set(0, 0, 0);
    }
    if (Feff.lengthSq() > 200 * 200) Feff.setLength(200);
    rod.setLoad(Feff);
  }

  // rod-local impulse along the current line direction (tip tap)
  function tapTip(strength) {
    lineDirAtTip(_v);
    rodWorldQuat(_q).invert();
    _v.applyQuaternion(_q);
    FeffV.addScaledVector(_v, strength);
  }

  // ------------------------------------------------------------------ terminal physics
  function pendulum(p, pp, anchor, len, dt, dragK) {
    const n = dt > 1 / 70 ? 3 : 2;
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      let vx = p.x - pp.x;
      let vy = p.y - pp.y;
      let vz = p.z - pp.z;
      pp.copy(p);
      const surf = p.y < 0.6 ? water.getHeight(p.x, p.z) : -1e3;
      const wet = p.y < surf;
      let k;
      if (wet) k = Math.exp(-12 * h);
      else {
        const sp = Math.hypot(vx, vy, vz);
        // quadratic air drag + the damping of a stretchy line and a soft rod tip
        k = Math.max(0.5, 1 - dragK * sp) * Math.exp(-1.6 * h);
      }
      vx *= k;
      vy *= k;
      vz *= k;
      p.x += vx;
      p.y += vy - G * h * h * (wet ? 0.25 : 1);
      p.z += vz;
      _v.subVectors(p, anchor);
      const d = _v.length();
      if (d > len && d > 1e-9) p.copy(anchor).addScaledVector(_v, len / d);
      // do not sink into the deck or ground
      if (inDeckXZ(p) && p.y < DOCK.deckY + 0.01 && p.y > DOCK.deckY - 0.3) p.y = DOCK.deckY + 0.01;
    }
  }

  function floatClipWorld(which, out) {
    // clip positions follow the float's display transform (min-size scaling)
    const m = models.bobber;
    out.copy(which === 'top' ? m.topClip : m.bottomClip);
    return m.object.localToWorld(out);
  }

  function updateHome(dt) {
    if (autoWind) {
      lineOut = damp(lineOut, homeLine(), 3.2, dt);
      if (Math.abs(lineOut - homeLine()) < 0.01) {
        lineOut = homeLine();
        autoWind = false;
      }
    }
    if (isBobber) {
      const main = Math.max(0.05, lineOut - leader);
      pendulum(F, Fprev, tip, main + models.bobber.topClip.length(), dt, 0.06);
      _v2.copy(F);
      _v2.y -= models.bobber.radius * 1.2;
      pendulum(L, Lprev, _v2, leader, dt, 0.4);
    } else {
      pendulum(L, Lprev, tip, lineOut + model.tieLocal.length(), dt, ph.drag * 2);
    }
  }

  function launch() {
    const cfg = LURES[lureIdx];
    const R = lerp(2.4, finite(cfg.maxCastM, TACKLE.maxCastM), castPower);
    const v0 = speedForRange(ph.drag, R);
    mode = 'flying';
    flightT = 0;
    const head = isBobber ? F : L;
    head.copy(tip).addScaledVector(castDir, 0.06);
    head.y -= 0.05;
    LV.copy(castDir).multiplyScalar(v0 * Math.cos(castPitch));
    LV.y = v0 * Math.sin(castPitch);
    if (isBobber) {
      Fprev.copy(F);
      // bait trails a little behind the float with the same velocity
      L.copy(F).addScaledVector(castDir, -0.25);
      L.y -= 0.35;
      Lprev.copy(L).addScaledVector(LV, -1 / 60);
    } else {
      Lprev.copy(L);
    }
    lineOut = Math.max(lineOut, head.distanceTo(tip) + 0.05);
    bailTarget = 1;
    bail01 = Math.max(bail01, 0.99);
    ropeNeedsLay = true; // line leaves the tip straight toward the released lure
  }

  function landOn(onWater, surfY) {
    const head = isBobber ? F : L;
    const speed = LV.length();
    mode = onWater ? 'water' : 'land';
    bailTarget = 0;
    landT = 0;
    pausedS = 0;
    walkLat = 0;
    walkLatPrev = 0;
    walkTimer = 0;
    taut = false;
    if (onWater) {
      head.y = isBobber ? surfY : lureId === 'spinner' ? surfY - 0.04 : surfY - 0.002;
      LV.set(LV.x * 0.16, 0, LV.z * 0.16);
      FV.set(LV.x, -0.45 * clamp(speed / 14, 0.2, 1), LV.z);
      if (isBobber) FV.y = -0.5 * clamp(speed / 14, 0.2, 1);
    } else {
      LV.set(0, 0, 0);
      FV.set(0, 0, 0);
    }
    if (isBobber) Fprev.copy(F);
    else Lprev.copy(L);
    writeSnapshot();
    events.emit('lure:landed', { position: head.clone(), lureId, onWater, speed });
  }

  function checkLanding() {
    const head = isBobber ? F : L;
    if (inDeckXZ(head) && head.y <= DOCK.deckY + ph.radius && head.y > DOCK.deckY - 0.3) {
      head.y = DOCK.deckY + ph.radius;
      landOn(false, 0);
      return true;
    }
    if (env.isWater(head.x, head.z)) {
      const s = water.getHeight(head.x, head.z);
      if (head.y <= s) {
        landOn(true, s);
        return true;
      }
    } else {
      const g = env.getTerrainHeight(head.x, head.z);
      if (head.y <= g + ph.radius) {
        head.y = g + ph.radius;
        landOn(false, 0);
        return true;
      }
    }
    return false;
  }

  function updateFlight(dt) {
    flightT += dt;
    const head = isBobber ? F : L;
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    const k = ph.drag;
    for (let s = 0; s < n; s++) {
      const rx = LV.x - wind.x;
      const ry = LV.y - wind.y;
      const rz = LV.z - wind.z;
      const sp = Math.hypot(rx, ry, rz);
      LV.x += (-k * sp * rx - LINE_DRAG * LV.x) * h;
      LV.y += (-G - k * sp * ry - LINE_DRAG * LV.y) * h;
      LV.z += (-k * sp * rz - LINE_DRAG * LV.z) * h;
      head.addScaledVector(LV, h);
      if (head.y < 1.6 && checkLanding()) return;
    }
    if (isBobber) {
      Fprev.copy(F);
      pendulum(L, Lprev, F, leader, dt, 0.4);
    }
    lineOut = clamp(Math.max(lineOut, head.distanceTo(tip) * 1.08 + 0.3 + leader), 0, TACKLE.spoolCapacityM);
    if (flightT > 10 || !vfinite(head)) {
      // should never happen: drop it where it is
      if (!vfinite(head)) head.copy(tip);
      head.y = Math.min(head.y, 0);
      landOn(env.isWater(head.x, head.z), water.getHeight(head.x, head.z));
    }
  }

  // Keep |tip - q| <= len by pulling q horizontally toward the tip (or up when directly below).
  function lineConstraint(q, len) {
    const dx = tip.x - q.x;
    const dy = tip.y - q.y;
    const dz = tip.z - q.z;
    const dh = Math.hypot(dx, dz);
    const d = Math.hypot(dh, dy);
    if (d <= len) return false;
    const dh2 = len * len - dy * dy;
    let newDh = 0;
    if (dh2 <= 0) q.y = tip.y - len;
    else newDh = Math.sqrt(dh2);
    if (dh > 1e-6) {
      const k = (dh - newDh) / dh;
      q.x += dx * k;
      q.z += dz * k;
    }
    return true;
  }

  function goHome(emitEvent) {
    mode = 'home';
    autoWind = true;
    biteHold = false;
    taut = false;
    walkLat = 0;
    walkLatPrev = 0;
    Lprev.copy(L);
    Fprev.copy(F);
    bailTarget = 0;
    if (emitEvent) {
      writeSnapshot();
      events.emit('lure:home', {});
    }
  }

  function updateWaterLure(dt) {
    const retrieving = reelT < 0.15;
    landT += dt;
    const surfY = water.getHeight(L.x, L.z);
    const bedY = env.getTerrainHeight(L.x, L.z);
    surfAtLure = surfY;
    const waterDepth = Math.max(0.03, surfY - bedY);
    const decay = Math.exp(-3.2 * dt);
    LV.x *= decay;
    LV.z *= decay;
    L.x += LV.x * dt;
    L.z += LV.z * dt;
    let depth = surfY - L.y;
    const dh = Math.hypot(tip.x - L.x, tip.z - L.z);
    const moving = taut && speedS > 0.1;
    if (depth < -0.01) {
      // dropped off the deck / lifted: fall back to the surface
      LV.y -= G * dt;
      depth = Math.max(-5, depth - LV.y * dt);
    } else {
      LV.y = 0;
      if (lureId === 'spinner') {
        if (moving) depth = damp(depth, lerp(1.0, 0.5, clamp(speedS / 0.9, 0, 1)), 1.4, dt);
        else depth += (ph.sink || 0.33) * dt;
      } else if (lureId === 'crankbait') {
        if (moving) depth += 0.34 * speedS * Math.max(0, 1 - depth / (ph.maxDepth || 2.4)) * dt;
        else depth -= (ph.rise || 0.13) * dt;
      } else if (lureId === 'topwater') {
        depth = 0.004;
      } else {
        depth += 0.3 * dt;
      }
      if (lureId !== 'topwater') {
        if (taut) depth = Math.min(depth, Math.max(0, (dh - 0.6) * 0.45));
        depth = clamp(depth, 0, Math.max(0, waterDepth - 0.03));
      }
    }
    L.y = surfY - depth;
    const len = lineOut;
    taut = lineConstraint(L, len);
    if (lureId === 'topwater') walkTheDog(dt, retrieving);
    const sp = speedS;
    retrieveTension = clamp(ph.retrieveN * (sp / TACKLE.reelRetrieveMps) * (sp / TACKLE.reelRetrieveMps), 0, 6);
    if (lureId === 'crankbait') retrieveTension *= 1 + 0.16 * Math.sin(time * 2 * Math.PI * 9.5);
    else if (lureId === 'spinner') retrieveTension *= 1 + 0.08 * Math.sin(time * 2 * Math.PI * 13);
    if (depth < 0.18 && sp > 0.05) {
      _v.subVectors(L, Lframe);
      const hl = Math.hypot(_v.x, _v.z);
      if (hl > 1e-5) water.wake(L.x, L.z, _v.x / hl, _v.z / hl, sp);
    }
    if (retrieving && dh < HOME_RADIUS) goHome(true);
    else if (L.y > surfY + 0.06 && dh < 2.5 && retrieving) goHome(true);
  }

  function walkTheDog(dt, retrieving) {
    const active = retrieving && taut;
    if (active) {
      walkTimer += dt;
      if (walkTimer >= WALK_PERIOD) {
        walkTimer = 0;
        walkSide = -walkSide;
        poseV[3] -= 1.3; // rod tip twitch that makes the lure pop
        tapTip(-18);
        writeSnapshot();
        events.emit('lure:twitch', { position: L.clone() });
      }
    } else {
      walkTimer = Math.min(walkTimer, WALK_PERIOD * 0.7);
    }
    walkLat = damp(walkLat, active ? walkSide * 0.085 : walkLat * 0.5, active ? 7 : 1.5, dt);
    const dl = walkLat - walkLatPrev;
    walkLatPrev = walkLat;
    const dx = tip.x - L.x;
    const dz = tip.z - L.z;
    const dh = Math.hypot(dx, dz);
    if (dh > 1e-4) {
      L.x += (-dz / dh) * dl;
      L.z += (dx / dh) * dl;
    }
  }

  function updateWaterFloat(dt, state) {
    const retrieving = reelT < 0.15;
    landT += dt;
    const surfF = water.getHeight(F.x, F.z);
    // horizontal: water drag, slow wind drift; a biting fish swims off with it
    FV.x = damp(FV.x, wind.x * 0.012, 1.4, dt);
    FV.z = damp(FV.z, wind.z * 0.012, 1.4, dt);
    if (biteHold) {
      biteT += dt;
      FV.x = damp(FV.x, biteDir.x * 0.3, 3, dt);
      FV.z = damp(FV.z, biteDir.z * 0.3, 3, dt);
      if ((state !== STATES.STRIKE && state !== STATES.FIGHTING && biteT > 0.35) || biteT > 6) biteHold = false;
    }
    F.x += FV.x * dt;
    F.z += FV.z * dt;
    // vertical: buoyancy spring (bobs on nibbles), pulled under by a bite
    const target = biteHold ? surfF - 0.3 : surfF + FLOAT_RIDE;
    const w = biteHold ? 10 : 26;
    const z = biteHold ? 0.95 : 0.3;
    const n = 3;
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      FV.y += (w * w * (target - F.y) - 2 * z * w * FV.y) * h;
      F.y += FV.y * h;
    }
    const main = Math.max(0.05, lineOut - leader);
    taut = lineConstraint(F, main);
    // bait hangs under the float (verlet with water drag), rests on the bottom if shallow
    _v2.copy(F);
    _v2.y -= models.bobber.radius;
    const bedB = env.getTerrainHeight(L.x, L.z);
    const nb = 2;
    const hb = dt / nb;
    for (let s = 0; s < nb; s++) {
      const vx = L.x - Lprev.x;
      const vy = L.y - Lprev.y;
      const vz = L.z - Lprev.z;
      Lprev.copy(L);
      const wet = L.y < surfF;
      const k = wet ? Math.exp(-8.5 * hb) : 0.995;
      L.x += vx * k;
      L.y += vy * k - (wet ? 2.6 : G) * hb * hb;
      L.z += vz * k;
      _v.subVectors(L, _v2);
      const d = _v.length();
      if (d > leader && d > 1e-9) L.copy(_v2).addScaledVector(_v, leader / d);
      if (L.y < bedB + 0.012) L.y = bedB + 0.012;
    }
    surfAtLure = water.getHeight(L.x, L.z);
    floatHang = clamp((_v2.y - L.y) / Math.max(0.1, leader), 0, 1);
    retrieveTension = taut ? clamp(ph.retrieveN * (speedS / TACKLE.reelRetrieveMps) ** 2, 0, 3) : 0;
    const hs = Math.hypot(F.x - Fframe.x, F.z - Fframe.z) / Math.max(dt, 1e-4);
    if (hs > 0.04 && F.y > surfF - 0.05) {
      _v.subVectors(F, Fframe);
      const hl = Math.hypot(_v.x, _v.z);
      if (hl > 1e-6) water.wake(F.x, F.z, _v.x / hl, _v.z / hl, hs);
    }
    const dh = Math.hypot(tip.x - F.x, tip.z - F.z);
    if (retrieving && dh < HOME_RADIUS) goHome(true);
    else if (retrieving && F.y > surfF + 0.08 && dh < 2.5) goHome(true);
  }

  function updateLand(dt) {
    const retrieving = reelT < 0.15;
    const head = isBobber ? F : L;
    const onDeck = inDeckXZ(head) && head.y > DOCK.deckY - 0.25;
    const gy = onDeck ? DOCK.deckY : env.getTerrainHeight(head.x, head.z);
    const r = isBobber ? models.bobber.radius : ph.radius;
    head.y = Math.max(head.y - 2 * dt, gy + r);
    taut = lineConstraint(head, isBobber ? Math.max(0.05, lineOut - leader) : lineOut);
    head.y = Math.max(head.y, gy + r);
    if (isBobber) {
      _v2.copy(F);
      _v2.y -= models.bobber.radius;
      pendulum(L, Lprev, _v2, leader, dt, 0.4);
      const gb = inDeckXZ(L) && L.y > DOCK.deckY - 0.25 ? DOCK.deckY : env.getTerrainHeight(L.x, L.z);
      if (L.y < gb + 0.004 && !env.isWater(L.x, L.z)) L.y = gb + 0.004;
    }
    retrieveTension = taut ? 0.6 : 0;
    surfAtLure = water.getHeight(L.x, L.z);
    if (!onDeck && env.isWater(head.x, head.z)) {
      mode = 'water';
      LV.set(0, 0, 0);
      FV.set(0, 0, 0);
      if (!isBobber) Lprev.copy(L);
      return;
    }
    const dh = Math.hypot(tip.x - head.x, tip.z - head.z);
    if (retrieving && dh < HOME_RADIUS) goHome(true);
  }

  function updateFish(dt) {
    if (vfinite(fishPos)) L.copy(fishPos);
    lineOut = Math.max(0.3, fightLineOut);
    surfAtLure = water.getHeight(L.x, L.z);
    if (isBobber) {
      // the float rides the line about one leader length up the line from the fish
      const fishDepth = surfAtLure - L.y;
      _v.set(tip.x - L.x, 0, tip.z - L.z);
      const hl = _v.length();
      if (hl > 1e-5) _v.multiplyScalar(1 / hl);
      else _v.set(0, 0, 1);
      const lead = leader * 0.95;
      if (fishDepth >= lead) {
        F.set(L.x + _v.x * 0.05, L.y + lead, L.z + _v.z * 0.05);
      } else {
        const hd = Math.min(hl, Math.sqrt(Math.max(0, lead * lead - fishDepth * fishDepth)));
        F.set(L.x + _v.x * hd, 0, L.z + _v.z * hd);
        F.y = water.getHeight(F.x, F.z) + FLOAT_RIDE;
        if (L.y > surfAtLure + 0.05) F.y = Math.max(F.y, L.y + 0.2); // fish in the air: float swings up too
      }
      Fprev.copy(F);
    }
  }

  function updateLost(dt) {
    lostT += dt;
    if (isBobber && floatLostVisible) {
      const s = water.getHeight(F.x, F.z);
      F.y = damp(F.y, s + FLOAT_RIDE, 4, dt);
      F.x += wind.x * 0.01 * dt;
      F.z += wind.z * 0.01 * dt;
      if (lostT > 3.5) floatLostVisible = false;
    }
  }

  function updateTerminal(dt, state) {
    switch (mode) {
      case 'home':
        updateHome(dt);
        break;
      case 'launch':
        updateHome(dt);
        // desktop: the scripted forward stroke releases the lure; VR: the real swing already happened
        if (xrOn || pose[3] < base[3] + 0.3 || castT > 0.2) launch();
        break;
      case 'flying':
        updateFlight(dt);
        break;
      case 'water':
        if (isBobber) updateWaterFloat(dt, state);
        else updateWaterLure(dt);
        break;
      case 'land':
        updateLand(dt);
        break;
      case 'fish':
        updateFish(dt);
        break;
      case 'lost':
        updateLost(dt);
        break;
      default:
        mode = 'home';
    }
    if (!vfinite(L) || !vfinite(F)) {
      // never propagate NaN: re-tie at the rod
      resetToHome();
    }
    const head = isBobber && mode !== 'fish' ? F : L;
    const hf = isBobber && mode !== 'fish' ? Fframe : Lframe;
    const inst = dt > 1e-5 ? (isBobber ? Math.hypot(head.x - hf.x, head.z - hf.z) : head.distanceTo(hf)) / dt : 0;
    speedS = damp(speedS, Math.min(inst, 40), 10, dt);
    if (mode === 'water' || mode === 'land') pausedS = speedS < 0.06 ? pausedS + dt : 0;
    else pausedS = 0;
    if (dt > 1e-5) Lvel.subVectors(L, Lframe).multiplyScalar(1 / dt);
    Lframe.copy(L);
    Fframe.copy(F);
  }

  // ------------------------------------------------------------------ line update
  let tintedBobber = null;
  function configureRope() {
    // pins + rest lengths for the current mode
    const n = nPts;
    rope.clearPins();
    rope.sinks.fill(0);
    if (mode === 'lost') return;
    if (tintedBobber !== isBobber) {
      // hi-vis main line; the float rig's leader is clear fluorocarbon (reads faintly, as it should)
      tintedBobber = isBobber;
      rope.setTint(0, n - 1, LINE_COLOR, LINE_ALPHA);
      if (isBobber) rope.setTint(F2, n - 1, LEADER_COLOR, LEADER_ALPHA);
    }
    rope.setPinned(0, true);
    rope.setPinned(n - 1, true);
    if (isBobber) {
      rope.setPinned(F1, true);
      rope.setPinned(F2, true);
      for (let i = F2 + 1; i < n; i++) rope.sinks[i] = 1;
    }
  }

  // Rest lengths of `count` segments from index `from` (0 = at the rod tip) totalling `total`:
  // they grow linearly away from the tip; in flight the first TIP_SEGS are capped (tipCap01).
  function spread(r, from, count, total) {
    if (count <= 0) return;
    if (count === 1) {
      r[from] = total;
      return;
    }
    const wsum = count * (1 + SEG_GROW / 2);
    for (let j = 0; j < count; j++) r[from + j] = (total * (1 + (SEG_GROW * j) / (count - 1))) / wsum;
    if (tipCap01 > 0.001 && count > TIP_SEGS + 2) {
      let excess = 0;
      for (let j = 0; j < TIP_SEGS; j++) {
        const v = lerp(r[from + j], Math.min(r[from + j], TIP_REST), tipCap01);
        excess += r[from + j] - v;
        r[from + j] = v;
      }
      if (excess > 0) {
        let rem = 0;
        for (let j = TIP_SEGS; j < count; j++) rem += r[from + j];
        const k = rem > 1e-9 ? 1 + excess / rem : 1;
        for (let j = TIP_SEGS; j < count; j++) r[from + j] *= k;
      }
    }
  }

  function setRest(dt) {
    const n = nPts;
    const r = rope.rest;
    // flight pays line out through the tip-top: keep the stretch next to the tip short; ease back after
    tipCap01 = mode === 'flying' || mode === 'launch' ? 1 : damp(tipCap01, 0, 2.5, dt);
    if (mode === 'fish') {
      const chord = isBobber ? tip.distanceTo(F) : tip.distanceTo(L);
      const target = isBobber ? Math.max(0.05, lineOut - leader) : lineOut;
      const slackMax = Math.min(Math.max(0, target - chord), chord * 0.12);
      const slack = slackMax * (1 - smoothstep(0.4, 3, fightTension));
      const main = chord + slack;
      if (isBobber) {
        spread(r, 0, F1, main);
        r[F1] = models.bobber.topClip.distanceTo(models.bobber.bottomClip) * models.bobber.object.scale.x;
        const leadLen = Math.max(0.05, F.distanceTo(L) * 1.02);
        for (let i = F2; i < n - 1; i++) r[i] = leadLen / (n - 1 - F2);
      } else {
        spread(r, 0, n - 1, main);
      }
      return;
    }
    if (isBobber) {
      const main = Math.max(0.03, lineOut - leader);
      spread(r, 0, F1, main);
      r[F1] = models.bobber.topClip.distanceTo(models.bobber.bottomClip) * models.bobber.object.scale.x;
      for (let i = F2; i < n - 1; i++) r[i] = leader / (n - 1 - F2);
    } else {
      spread(r, 0, n - 1, lineOut);
    }
    // deep lure: the last stretch of line follows it under the surface
    if (!isBobber && mode === 'water') {
      const d = Math.max(0, surfAtLure - L.y);
      if (d > 0.05) {
        const sinkLen = d * 1.6 + 0.4;
        let acc = 0;
        for (let i = n - 1; i > 0 && acc < sinkLen; i--) {
          rope.sinks[i] = 1;
          acc += r[i - 1];
        }
      }
    }
  }

  const _tie = new THREE.Vector3();
  function pinRope() {
    const n = nPts;
    rope.pin(0, tip);
    if (isBobber) {
      rope.pin(F1, floatClipWorld('top', _v));
      rope.pin(F2, floatClipWorld('bottom', _v));
      _tie.copy(models.bobber.tieLocal);
      models.bobber.bait.localToWorld(_tie);
      rope.pin(n - 1, mode === 'fish' ? L : _tie);
    } else if (mode === 'fish') {
      rope.pin(n - 1, L);
    } else {
      _tie.copy(model.tieLocal);
      model.object.localToWorld(_tie);
      rope.pin(n - 1, _tie);
    }
  }

  let ropeNeedsLay = true;
  const ropeOpts = { wind, water, env, iterations, airDrag: 2.2 };
  const lostOpts = { wind, water, env, iterations: 8, airDrag: 3 };
  const tailOpts = { wind, water, env, iterations: 8, airDrag: 4 };
  function updateLine(dt, state) {
    if (mode === 'lost') {
      if (lostT < 2.2) {
        rope.line.visible = true;
        rope.step(dt, lostOpts);
        rope.write();
      } else rope.line.visible = false;
      tail.line.visible = true;
      tail.pin(0, tip);
      tail.step(dt, tailOpts);
      tail.write();
    } else {
      rope.line.visible = true;
      tail.line.visible = false;
      configureRope();
      setRest(dt);
      pinRope();
      if (ropeNeedsLay) {
        rope.layStraight();
        ropeNeedsLay = false;
      }
      rope.step(dt, ropeOpts);
      // tension straightens the line
      let t = 0;
      if (mode === 'home' || mode === 'launch') t = 0.35;
      else if (mode === 'flying') t = 0.09;
      else if (mode === 'water' || mode === 'land') t = taut ? smoothstep(0.08, 1.4, retrieveTension) * 0.9 : 0;
      else if (mode === 'fish') t = smoothstep(0.4, 3.5, fightTension);
      if (biteHold && mode === 'water') t = Math.max(t, 0.6);
      if (isBobber) {
        rope.straighten(0, F1, t);
        rope.straighten(F2, nPts - 1, mode === 'fish' ? t : 0.25);
      } else rope.straighten(0, nPts - 1, t);
      if (mode === 'flying') {
        // line streaming out through the tip-top leaves it under spool/guide drag, heading for the
        // lure: the first stretch runs straight instead of folding up under the tip (the verlet
        // points do not carry the along-line flow of real line)
        rope.straighten(0, isBobber ? F1 : nPts - 1, 1 - Math.exp(-30 * dt), 0.3);
      }
      if (rope.hasNaN()) ropeNeedsLay = true;
      rope.write();
    }
    // line from the spool through the guides to the tip-top (rod-local)
    rod.lineExitLocal(_v, bail01, lineSpin);
    inRod.setPoint(0, _v.x, _v.y, _v.z);
    const gl = rod.guideLocal;
    for (let i = 0; i < gl.length && i < 7; i++) inRod.setPoint(i + 1, gl[i].x, gl[i].y, gl[i].z);
    inRod.write(false);
  }

  // ------------------------------------------------------------------ models
  // The first eye's sub-camera while presenting (projection + viewport in framebuffer px), or null.
  function xrEye() {
    const xc = renderer.xr.getCamera ? renderer.xr.getCamera() : null;
    const c = xc && xc.cameras && xc.cameras[0];
    if (!c || !c.viewport || !(c.viewport.w > 0)) return null;
    const p5 = c.projectionMatrix.elements[5];
    return Number.isFinite(p5) && p5 > 0.05 ? c : null;
  }
  function minSizeScale(p, sizeM, minPx) {
    const D = Math.max(0.05, camPos.distanceTo(p));
    // headset: one eye's projection and viewport (renderer.getSize spans both eyes, camera.fov is the union)
    const eye = renderer.xr && renderer.xr.isPresenting ? xrEye() : null;
    if (eye) {
      const pxXR = (sizeM * eye.viewport.w * eye.projectionMatrix.elements[5]) / (2 * D);
      return clamp(minPx / Math.max(pxXR, 1e-4), 1, 30);
    }
    renderer.getSize(_size);
    const H = _size.y || 540;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov || 60) * 0.5);
    const px = (sizeM * H) / (2 * D * tanHalf);
    return clamp(minPx / Math.max(px, 1e-4), 1, 30);
  }

  const modelInfo = { dt: 0, inWater: false, speed: 0, active: false, flying: false, sinking: false };
  const modelList = Object.values(models);
  function updateModels(dt) {
    for (let i = 0; i < modelList.length; i++) {
      const m = modelList[i];
      if (m !== model) {
        m.object.visible = false;
        if (m.bait) m.bait.visible = false;
        if (m.shot) m.shot.visible = false;
      }
    }
    const inWater = mode === 'water';
    if (isBobber) {
      const m = models.bobber;
      const fv = mode !== 'lost' || floatLostVisible;
      m.object.visible = fv;
      m.bait.visible = mode !== 'fish' && mode !== 'lost';
      m.shot.visible = m.bait.visible;
      // float
      m.object.position.copy(F);
      if (mode === 'home' || mode === 'launch' || mode === 'flying' || (mode === 'water' && F.y > surfAtLure + 0.1)) {
        _v.subVectors(tip, F).normalize();
        if (mode === 'flying') _v.lerp(UP, 0.3).normalize();
        m.object.quaternion.setFromUnitVectors(UP, _v);
      } else {
        // floating: stands up as the bait's weight comes onto it, rocks on the waves
        water.getNormal(F.x, F.z, _n);
        if (!vfinite(_n) || _n.lengthSq() < 1e-6) _n.set(0, 1, 0);
        const hang = mode === 'fish' ? 1 : floatHang;
        _v.subVectors(tip, F);
        _v.y = 0;
        if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1);
        _v.normalize();
        _v.lerp(_n, smoothstep(0.15, 0.85, hang) * 0.9 + 0.1).normalize();
        if (mode === 'fish') _v.subVectors(tip, F).normalize().lerp(_n, 0.6).normalize();
        m.object.quaternion.setFromUnitVectors(UP, _v);
      }
      const sc = mode === 'home' || mode === 'launch' ? 1 : minSizeScale(F, ph.pxSize, ph.minPx);
      m.object.scale.setScalar(sc);
      if (sc > 1 && (mode === 'water' || mode === 'fish' || mode === 'lost')) {
        // keep the same waterline on an upscaled (distant) float; once it is pulled under (a bite, a
        // fish below it) sink the drawn float by its extra size so it disappears like the real one
        const sF = water.getHeight(F.x, F.z);
        const under = smoothstep(-0.004, -0.06, F.y - sF);
        m.object.position.y += FLOAT_RIDE * (sc - 1) * (1 - under) - m.radius * 1.4 * (sc - 1) * under;
      }
      if (mode === 'water' && dipT < 0.9) {
        // nibble: drawn dip + a small sideways jiggle, scaled with the drawn size
        const e = floatDip(dipT);
        const D = 2 * m.radius * Math.max(0.4, sc - 0.6);
        m.object.position.y -= dipAmp * D * e;
        const lat = dipAmp * D * 0.2 * Math.max(0, e) * Math.sin(dipT * 40);
        m.object.position.x += dipDir.x * lat;
        m.object.position.z += dipDir.z * lat;
      }
      m.object.updateMatrixWorld();
      // bait hangs from the leader; the worm turns slowly
      if (m.bait.visible) {
        m.bait.position.copy(L);
        rope.getPoint(nPts - 3, _v).sub(L);
        if (_v.lengthSq() < 1e-8) _v.set(0, 1, 0);
        _v.normalize();
        _q.setFromUnitVectors(UP, _v);
        _q2.setFromAxisAngle(UP, time * 0.35);
        m.bait.quaternion.copy(_q).multiply(_q2);
        m.bait.updateMatrixWorld();
        rope.getPoint(nPts - 2, _v);
        m.shot.position.lerpVectors(_v, rope.getPoint(nPts - 3, _v2), 0.4);
        modelInfo.dt = dt;
        modelInfo.inWater = inWater && L.y < surfAtLure;
        modelInfo.speed = speedS;
        modelInfo.active = camPos.distanceTo(L) < 7;
        modelInfo.flying = false;
        modelInfo.sinking = false;
        m.update(modelInfo);
      }
    } else {
      const m = model;
      const vis = mode !== 'fish' && mode !== 'lost';
      m.object.visible = vis;
      if (!vis) return;
      m.object.position.copy(L);
      let roll = 0;
      if (mode === 'home' || mode === 'launch') {
        // hangs from its line tie, nose toward the tip
        _v.subVectors(tip, L).normalize();
        _q.setFromUnitVectors(AX_Z, _v);
        m.object.quaternion.copy(_q);
      } else if (mode === 'flying') {
        // lures fly tail first: the trailing line drags the nose back
        _v.copy(LV).negate();
        if (_v.lengthSq() < 1e-8) _v.set(0, 0, 1);
        _v.normalize();
        _q.setFromUnitVectors(AX_Z, _v);
        m.object.quaternion.copy(_q);
      } else {
        // swimming toward the rod tip
        const dx = tip.x - L.x;
        const dz = tip.z - L.z;
        const moving = speedS > 0.08 && taut;
        if (moving || mode === 'land') lureYaw = dampAngle(lureYaw, Math.atan2(dx, dz), 6, dt);
        let yaw = lureYaw;
        let pitch = 0;
        const s01 = clamp(speedS / 0.8, 0, 1.2);
        if (lureId === 'crankbait') {
          pitch = moving ? 0.1 + 0.32 * s01 * (1 - clamp((surfAtLure - L.y) / 2.4, 0, 1) * 0.5) : -0.12;
          roll = Math.sin(time * 2 * Math.PI * 9.5) * 0.4 * s01;
          yaw += Math.sin(time * 2 * Math.PI * 9.5 + 1.2) * 0.07 * s01;
        } else if (lureId === 'topwater') {
          pitch = moving ? -0.12 : -0.3;
          yaw += (walkLat / 0.085) * 0.85;
          roll = (walkLat / 0.085) * 0.18;
        } else if (lureId === 'spinner') {
          pitch = moving ? 0.02 : 0.35;
        }
        if (mode === 'land') pitch = 0;
        lurePitch = damp(lurePitch, pitch, 8, dt);
        _euler.set(lurePitch, yaw, roll, 'YXZ');
        m.object.quaternion.setFromEuler(_euler);
        if (lureId === 'topwater' && mode === 'water') {
          water.getNormal(L.x, L.z, _n);
          if (vfinite(_n)) {
            _q.setFromUnitVectors(UP, _n);
            m.object.quaternion.premultiply(_q);
          }
        }
      }
      const depth = surfAtLure - L.y;
      const minPx = mode === 'flying' || mode === 'land' || depth < 0.1 ? ph.minPx : mode === 'water' ? 1 : 0;
      const sc = mode === 'home' || mode === 'launch' ? 1 : minSizeScale(L, ph.pxSize, minPx);
      m.object.scale.setScalar(sc);
      m.object.updateMatrixWorld();
      modelInfo.dt = dt;
      modelInfo.inWater = inWater;
      modelInfo.speed = speedS;
      modelInfo.active = true;
      modelInfo.flying = mode === 'flying';
      modelInfo.sinking = inWater && !taut && lureId === 'spinner' && depth > 0.02;
      m.update(modelInfo);
    }
  }
  // nibble dip envelope: quick pull down (60 ms), spring back with a small overshoot, gone by 0.9 s
  function floatDip(t) {
    if (!(t >= 0) || t >= 0.9) return 0;
    if (t < 0.06) return Math.sin((t / 0.06) * Math.PI * 0.5);
    const u = t - 0.06;
    return Math.exp(-u * 7) * Math.cos(u * 12);
  }
  function dampAngle(a, b, lambda, dt) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * (1 - Math.exp(-lambda * dt));
  }

  // ------------------------------------------------------------------ snapshot
  function writeSnapshot() {
    snapshot.id = lureId;
    snapshot.position.copy(L);
    snapshot.velocity.copy(Lvel);
    snapshot.state = mode === 'launch' ? 'flying' : mode === 'lost' ? 'home' : mode;
    const inWater = mode === 'water' && L.y < surfAtLure + 0.03;
    snapshot.inWater = inWater;
    snapshot.depthM = inWater || mode === 'fish' ? Math.max(0, surfAtLure - L.y) : 0;
    snapshot.speedMps = speedS;
    snapshot.retrieving = reelT < 0.15 && (mode === 'water' || mode === 'land');
    snapshot.pausedS = pausedS;
    snapshot.distanceM = Math.hypot(L.x - tip.x, L.z - tip.z);
    snapshot.lineOutM = lineOut;
    snapshot.bobberPosition = isBobber && (mode !== 'lost' || floatLostVisible) ? bobberPos.copy(F) : null;
    snapshot.lost = lost;
  }

  // ------------------------------------------------------------------ env map / line light
  let lastEnvTex;
  let lastRodTex;
  function syncEnvMap() {
    // The rod always carries the sky map itself (same PMREM, same programs) so its reflection strength
    // is its own: scene.environmentIntensity doubles the sky light at night, which left the glossy
    // clear-coated blank with a bright moonlit edge; the rod keeps well under that.
    const rodTex = env.envMap || scene.environment || null;
    if (rodTex !== lastRodTex) {
      lastRodTex = rodTex;
      rod.setEnvMap(rodTex);
    }
    const night = clamp(finite(env.nightFactor, 0), 0, 1);
    rod.setEnvIntensity(finite(scene.environmentIntensity, 1) * lerp(1, 0.4, night));
    const tex = scene.environment ? null : env.envMap || null;
    if (tex === lastEnvTex) return;
    lastEnvTex = tex;
    for (const m of hand.materials) {
      m.envMap = tex;
      m.needsUpdate = true;
    }
    for (const m of Object.values(lureSet.materials)) {
      m.envMap = tex;
      m.needsUpdate = true;
    }
  }

  // The line is lit in scene-referred units like everything else (the renderer's exposure and tone
  // mapping do the rest): the key light (sun, or the moon at night) by the angle between it and each
  // segment, plus sky fill. Night comes out ~16x darker than noon instead of glowing.
  const LN_K_SUN = 0.28; // thin cylinder: ~0.64/pi of the key light, averaged over sin(angle)
  const LN_K_SKY = 0.6;
  const LN_K_GLINT = 0.5;
  const _lnSunDir = new THREE.Vector3();
  const _lnSunCol = new THREE.Color();
  const _lnSky = new THREE.Color();
  function updateLineLight(state) {
    const u = lineLook.uniforms;
    const sd = env.sunDirection;
    const sdOk = vfinite(sd);
    const sunY = sdOk ? sd.y : 0.5;
    const sl = env.sunLight;
    // sunLight / sunIntensity carry the live key intensity (moon at night; env folds in how much of
    // the disc clears the hills and treeline, env.sunVisibility)
    const sunI = Math.max(0, sl && Number.isFinite(sl.intensity) ? sl.intensity : finite(env.sunIntensity, 2.2));
    const up = smoothstep(-0.03, 0.05, sunY);
    const sc = sl && sl.color ? sl.color : env.sunColor;
    if (sc && Number.isFinite(sc.r)) _lnSunCol.copy(sc);
    else _lnSunCol.setRGB(1, 1, 1);
    const sky = env.skyRadiance;
    if (sky && Number.isFinite(sky.r) && Number.isFinite(sky.g) && Number.isFinite(sky.b)) _lnSky.copy(sky);
    else _lnSky.setRGB(0.25, 0.3, 0.38);
    u.uLnAmb.value.copy(_lnSky).multiplyScalar(LN_K_SKY);
    u.uLnAmb.value.r += 0.004;
    u.uLnAmb.value.g += 0.004;
    u.uLnAmb.value.b += 0.004;
    u.uLnSun.value.copy(_lnSunCol).multiplyScalar(LN_K_SUN * sunI * up);
    u.uLnGlint.value.copy(_lnSunCol).multiplyScalar(LN_K_GLINT * sunI * up);
    u.uLnGlintA.value = clamp((sunI * up) / 1.5, 0, 1) * 0.85;
    if (sdOk) _lnSunDir.copy(sd).transformDirection(camera.matrixWorldInverse);
    else _lnSunDir.set(0, 1, 0);
    u.uLnSunDir.value.copy(_lnSunDir);
    // fades toward a faint thread with distance; a little more presence while a fish is on
    const fightish = state === STATES.FIGHTING || state === STATES.LANDING;
    u.uLnFade.value.set(4.5, fightish ? 0.35 : 0.22);
    // ~1.2 CSS px, never under ~1 device pixel (thinner lines break up into dots)
    const dpr = renderer.getPixelRatio ? finite(renderer.getPixelRatio(), 1) : 1;
    // in the headset: per-eye device px (perEyeLine), a touch wider for the denser, moving view
    if (renderer.xr && renderer.xr.isPresenting) lineMat.linewidth = XR_LINE_PX;
    else lineMat.linewidth = Math.max(1.2, 1.05 / Math.max(0.25, dpr));
    if (lineLook.patched) lineMat.color.setRGB(1, 1, 1);
    else {
      // unpatched fallback: average lighting through the material colour
      lineMat.color.copy(u.uLnAmb.value).add(_lnSunCol.multiplyScalar(LN_K_SUN * sunI * up * 0.785));
    }
  }

  function hideRig() {
    rope.line.visible = false;
    tail.line.visible = false;
    for (let i = 0; i < modelList.length; i++) {
      const m = modelList[i];
      m.object.visible = false;
      if (m.bait) m.bait.visible = false;
      if (m.shot) m.shot.visible = false;
    }
  }

  // ------------------------------------------------------------------ cast preview
  // Where the tip-top sits in the READY pose, in camera space (the forward stroke releases about there).
  const restTipLocal = new THREE.Vector3(0.28, 0.72, -1.75);
  function updateRestTip(state) {
    if (xrOn || mode !== 'home' || castT < 1.5 || !(state === STATES.READY || state === STATES.TITLE)) return;
    _v.subVectors(tip, camPos).applyQuaternion(_q.copy(camQuat).invert());
    if (vfinite(_v) && _v.lengthSq() < 16) restTipLocal.lerp(_v, 0.2);
  }

  // Predicted landing point of a cast with this power along `direction` (horizontal; default the
  // view direction): same launch speed calibration, air drag and wind as the real flight.
  // Returns `target` (world position where the lure/float would come down) or null.
  const _pp = new THREE.Vector3();
  const _pv = new THREE.Vector3();
  const _pd = new THREE.Vector3();
  // opts.pitchRad: launch elevation as in cast() (default the desktop calibration angle). In VR the
  // flight starts at the real tip and the default direction is where the rod points.
  function predictLanding(power01, direction, target, opts) {
    const out = target || new THREE.Vector3();
    const cfg = LURES[lureIdx];
    const R = lerp(2.4, finite(cfg.maxCastM, TACKLE.maxCastM), clamp(finite(power01, 0.5), 0, 1));
    const v0 = speedForRange(ph.drag, R);
    if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.z)) _pd.set(direction.x, 0, direction.z);
    else if (xrOn) rodHeading(_pd);
    else _pd.set(0, 0, -1).applyQuaternion(camQuat).setY(0);
    if (_pd.lengthSq() < 1e-8) return null;
    _pd.normalize();
    if (xrOn) _pp.copy(tip).addScaledVector(_pd, 0.06);
    else _pp.copy(restTipLocal).applyQuaternion(camQuat).add(camPos).addScaledVector(_pd, 0.06);
    _pp.y -= 0.05;
    const pitch = launchPitch(opts);
    _pv.copy(_pd).multiplyScalar(v0 * Math.cos(pitch));
    _pv.y = v0 * Math.sin(pitch);
    const h = 1 / 240;
    const k = ph.drag;
    for (let i = 0; i < 2400; i++) {
      const rx = _pv.x - wind.x;
      const ry = _pv.y - wind.y;
      const rz = _pv.z - wind.z;
      const sp = Math.hypot(rx, ry, rz);
      _pv.x += (-k * sp * rx - LINE_DRAG * _pv.x) * h;
      _pv.y += (-G - k * sp * ry - LINE_DRAG * _pv.y) * h;
      _pv.z += (-k * sp * rz - LINE_DRAG * _pv.z) * h;
      _pp.addScaledVector(_pv, h);
      if (_pp.y < 1.6 && _pv.y < 0) {
        if (env.isWater(_pp.x, _pp.z)) {
          if (_pp.y <= 0.02) return out.set(_pp.x, water.getHeight(_pp.x, _pp.z), _pp.z);
        } else {
          const g = env.getTerrainHeight(_pp.x, _pp.z);
          if (_pp.y <= g + ph.radius) return out.set(_pp.x, g, _pp.z);
        }
      }
    }
    return vfinite(_pp) ? out.copy(_pp) : null;
  }

  function launchPitch(opts) {
    return opts && Number.isFinite(opts.pitchRad) ? clamp(opts.pitchRad, PITCH_MIN, PITCH_MAX) : LAUNCH_ELEV;
  }

  // Horizontal pointing direction of the rod (VR; falls back to the view direction when it points straight up).
  function rodHeading(out) {
    out.set(0, 1, 0).transformDirection(rod.object.matrixWorld).setY(0);
    if (out.lengthSq() < 1e-4) out.set(0, 0, -1).applyQuaternion(camQuat).setY(0);
    if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
    return out.normalize();
  }

  // ------------------------------------------------------------------ casting aid
  // While the cast charges: a faint hairline ring on the water where it would come down (predictLanding),
  // fading in with the charge. Screen-space width (Line2), so it reads as a thin ring at any distance;
  // its radius grows with distance so the far ellipse doesn't collapse to a dash.
  const AIM_SEGS = 48;
  const aimPts = new Float32Array((AIM_SEGS + 1) * 3);
  for (let i = 0; i <= AIM_SEGS; i++) {
    const a = (i / AIM_SEGS) * Math.PI * 2;
    aimPts[i * 3] = Math.cos(a);
    aimPts[i * 3 + 2] = Math.sin(a);
  }
  const aimGeom = new LineGeometry();
  aimGeom.setPositions(aimPts);
  const aimMat = new LineMaterial({ color: 0xffffff, linewidth: 1.3, worldUnits: false, transparent: true, opacity: 0, depthWrite: false, fog: true });
  const aimRing = new Line2(aimGeom, aimMat);
  aimRing.name = 'cast-aim-ring';
  aimRing.renderOrder = 12; // after the water (which writes no depth)
  aimRing.frustumCulled = false;
  aimRing.visible = false;
  aimRing.layers.enable(LAYERS.NO_REFLECT);
  perEyeLine(aimRing);
  scene.add(aimRing);
  const AIM_TINT = new THREE.Color(0.95, 0.93, 0.86);
  const _aimP = new THREE.Vector3();
  let aimA = 0;
  function updateAimRing(dt, state, input) {
    // desktop only: in VR the cast comes from the real swing, which a charge-based preview cannot follow
    const charging = !xrOn && state === STATES.CHARGING && mode === 'home' && !lost;
    let want = 0;
    if (charging) {
      const c = clamp(finite(input.charge01, 0), 0, 1);
      const p = predictLanding(c, null, _aimP);
      if (p && env.isWater(p.x, p.z)) {
        const d = Math.hypot(p.x - camPos.x, p.z - camPos.z);
        const r = clamp(0.035 * d, 0.3, 1.5);
        aimRing.position.set(p.x, p.y + 0.02, p.z);
        aimRing.scale.set(r, 1, r);
        aimRing.updateMatrixWorld();
        want = smoothstep(0.06, 0.5, c);
      }
    }
    aimA = charging ? damp(aimA, want, 9, dt) : 0;
    aimRing.visible = aimA > 0.01;
    if (!aimRing.visible) return;
    // a soft off-white that sits a little above the water's brightness by day and stays dim at night
    const exposure = Math.max(0.2, finite(renderer.toneMappingExposure, 1));
    const night = clamp(finite(env.nightFactor, 0), 0, 1);
    aimMat.color.copy(AIM_TINT).multiplyScalar((0.85 / exposure) * lerp(1, 0.3, night));
    aimMat.opacity = 0.42 * aimA;
  }

  // ------------------------------------------------------------------ public API
  function update(frame) {
    const dt = clamp(finite(frame && frame.dt, 1 / 60), 0, 0.05);
    time += dt;
    castT += dt;
    reelT += dt;
    snapT += dt;
    biteLoadT += dt;
    dipT += dt;
    const state = (frame && frame.state) || STATES.READY;
    const input = (frame && frame.input) || EMPTY_INPUT;
    frameState = state;
    lastTension01 = clamp(finite(frame && frame.tension01, 0), 0, 1.2);
    headShake = frame && frame.hooked ? clamp(finite(frame.hooked.headShake01, 0), 0, 1) : 0;
    if (state !== lastState) onStateChange(state, lastState);
    lastState = state;
    syncEnvMap();
    updateWind();
    if (xrOn) followGrip(dt);
    else {
      updatePose(dt, state, input);
      applyPose(state);
      followCamera(dt);
    }
    animateReel(dt, input, frame);
    updateRodLoad(dt, state, frame || {});
    computeTip(dt);
    if (teleported && mode === 'home') {
      resetToHome();
      if (xrOn && state === STATES.CHARGING) bailTarget = 1; // a snap turn with the trigger held: bail stays open
    } else if (teleported && xrOn && mode !== 'lost' && !ropeNeedsLay && vfinite(tipJump)) {
      // VR snap turn with line out: the stretch near the tip moves with it instead of being flung
      rope.shiftNearStart(tipJump.x, tipJump.y, tipJump.z, 3);
    }
    updateTerminal(dt, state);
    updateModels(dt);
    updateLine(dt, state);
    updateLineLight(state);
    // the catch is in the angler's hands: no line, float or lure hanging in front of the showcase
    rigHidden = state === STATES.CAUGHT;
    if (rigHidden) hideRig();
    updateRestTip(state);
    updateAimRing(dt, state, input);
    writeSnapshot();
  }

  function onStateChange(to, from) {
    if (to === STATES.CHARGING) bailTarget = 1;
    if ((to === STATES.READY || to === STATES.TITLE) && (mode === 'home' || mode === 'lost')) bailTarget = 0;
    if (from === STATES.CHARGING && to !== STATES.CASTING && mode === 'home' && castT > 1) bailTarget = 0;
    if (from === STATES.STRIKE && to !== STATES.FIGHTING) biteHold = false;
    if ((to === STATES.CAUGHT || to === STATES.READY) && mode === 'fish') {
      L.copy(tip);
      L.y -= homeMain();
      F.copy(L);
      goHome(false);
      ropeNeedsLay = true;
    }
  }

  function resetToHome() {
    mode = 'home';
    lost = false;
    autoWind = false;
    biteHold = false;
    taut = false;
    walkLat = 0;
    walkLatPrev = 0;
    floatLostVisible = false;
    tipCap01 = 0;
    dipT = 99;
    lineOut = homeLine();
    if (!tipInit) {
      if (xrOn) followGrip(0);
      else {
        updatePose(0, STATES.READY, EMPTY_INPUT);
        applyPose(STATES.READY);
        followCamera(0);
      }
      rod.setLoad(Feff);
      computeTip(0);
    }
    if (isBobber) {
      F.copy(tip);
      F.y -= FLOAT_HOME_MAIN;
      Fprev.copy(F);
      L.copy(F);
      L.y -= leader + models.bobber.radius;
      Lprev.copy(L);
    } else {
      L.copy(tip);
      L.y -= HOME_LEN;
      Lprev.copy(L);
    }
    LV.set(0, 0, 0);
    FV.set(0, 0, 0);
    Lframe.copy(L);
    Fframe.copy(F);
    speedS = 0;
    pausedS = 0;
    bailTarget = 0;
    tail.line.visible = false;
    ropeNeedsLay = true;
    configureRope();
    setRest(0);
    updateModels(0);
    pinRope();
    rope.layStraight();
    ropeNeedsLay = false;
    rope.write();
    if (rigHidden) hideRig();
    writeSnapshot();
  }

  function setLure(id) {
    const idx = LURES.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const changed = idx !== lureIdx;
    lureIdx = idx;
    lureId = LURES[idx].id;
    model = models[lureId] || models.spinner;
    ph = PHYS[lureId] || PHYS.spinner;
    isBobber = lureId === 'bobber';
    leader = isBobber ? finite(LURES[idx].depthM, 1.5) : 0;
    if (changed && mode !== 'lost') resetToHome();
    else writeSnapshot();
  }

  // opts.pitchRad (optional, VR): launch elevation, clamped to 8..55 deg; the launch speed for a given power is
  // the same as on desktop (calibrated at ~30 deg), so a flatter or steeper swing lands shorter / higher.
  function cast(power01, direction, opts) {
    if (mode !== 'home' || lost) resetToHome();
    castPower = clamp(finite(power01, 0.5), 0, 1);
    castPitch = launchPitch(opts);
    if (direction && Number.isFinite(direction.x) && Number.isFinite(direction.z)) castDir.set(direction.x, 0, direction.z);
    else if (xrOn) rodHeading(castDir);
    else castDir.set(0, 0, -1).applyQuaternion(camQuat).setY(0);
    if (castDir.lengthSq() < 1e-8) castDir.set(0, 0, -1).applyQuaternion(camQuat).setY(0);
    if (castDir.lengthSq() < 1e-8) castDir.set(0, 0, -1);
    castDir.normalize();
    mode = 'launch';
    castT = 0;
    autoWind = false;
    bailTarget = 1;
    writeSnapshot();
    snapshot.state = 'flying';
  }

  function reel(dt, speedMps) {
    if (!(dt > 0)) return;
    const sp = clamp(finite(speedMps, TACKLE.reelRetrieveMps), 0, 3);
    reelT = 0;
    reelSpeed = sp;
    if (mode === 'water' || mode === 'land') lineOut = Math.max(0.25, lineOut - sp * Math.min(dt, 0.1));
  }

  const _fishPrev = new THREE.Vector3();
  function setFight(active, o = {}) {
    if (!active) {
      if (mode === 'fish') {
        if (frameState === STATES.CAUGHT || frameState === STATES.LANDING || frameState === STATES.READY) {
          L.copy(tip);
          L.y -= homeMain();
          F.copy(L);
          goHome(false);
          ropeNeedsLay = true;
          // netted -> CAUGHT this frame: take the rig out of the picture before it renders
          if (frameState === STATES.LANDING || frameState === STATES.CAUGHT) hideRig();
        } else {
          // fish came off: the lure is free in the water where the fish was
          const s = water.getHeight(L.x, L.z);
          if (env.isWater(L.x, L.z)) {
            mode = 'water';
            L.y = Math.min(L.y, s - 0.05);
          } else mode = 'land';
          LV.set(0, 0, 0);
          FV.set(0, 0, 0);
          Lprev.copy(L);
          if (isBobber) {
            F.y = water.getHeight(F.x, F.z) + FLOAT_RIDE;
            Fprev.copy(F);
          }
          lineOut = Math.max(lineOut, tip.distanceTo(isBobber ? F : L) + (isBobber ? leader : 0));
        }
        writeSnapshot();
      }
      return;
    }
    if (mode === 'lost' || frameState === STATES.CAUGHT) return;
    if (mode !== 'fish') {
      mode = 'fish';
      biteHold = false;
      taut = true;
      fishPos.copy(o && vfinite(o.fishPosition) ? o.fishPosition : L);
    }
    if (o && vfinite(o.fishPosition)) {
      _fishPrev.copy(fishPos);
      fishPos.copy(o.fishPosition);
      // same-frame correction: the fish moved after tackle.update, drag the line end with it
      if (tipInit && !ropeNeedsLay) {
        rope.shiftTowardEnd(fishPos.x - _fishPrev.x, fishPos.y - _fishPrev.y, fishPos.z - _fishPrev.z);
        rope.pin(nPts - 1, fishPos);
        rope.write();
      }
      L.copy(fishPos);
    }
    if (o && Number.isFinite(o.tensionN)) fightTension = Math.max(0, o.tensionN);
    if (o && Number.isFinite(o.lineOutM)) fightLineOut = Math.max(0.3, o.lineOutM);
    lineOut = fightLineOut;
    writeSnapshot();
  }

  function setRodLoad(tensionN, towardWorld) {
    extN = clamp(finite(tensionN, 0), 0, 250);
    extAge = 0;
    if (vfinite(towardWorld)) {
      const l = towardWorld.length();
      if (Math.abs(l - 1) < 0.05) extDir.copy(towardWorld).multiplyScalar(1 / l);
      else {
        extDir.subVectors(towardWorld, tip);
        const d = extDir.length();
        if (d > 1e-5) extDir.multiplyScalar(1 / d);
        else lineDirAtTip(extDir);
      }
    } else lineDirAtTip(extDir);
  }

  function nibble(strength01) {
    if (time - lastNibbleT < 0.08) return;
    lastNibbleT = time;
    const s = clamp(finite(strength01, 0.5), 0, 1);
    if (isBobber && mode === 'water') {
      FV.y -= 0.12 + 0.3 * s;
      FV.x += (rng() - 0.5) * 0.06 * s;
      FV.z += (rng() - 0.5) * 0.06 * s;
      tapTip(4 + 6 * s);
      // the physical dip is a few mm; the drawn float (min-size scaled) dips by a share of its own
      // drawn height so a tap reads at any distance (see floatDip in updateModels)
      dipT = 0;
      dipAmp = 0.28 + 0.2 * s;
      const a = rng() * Math.PI * 2;
      dipDir.set(Math.cos(a), 0, Math.sin(a));
    } else if (mode === 'water') {
      tapTip(10 + 22 * s);
      LV.x += (rng() - 0.5) * 0.1;
      LV.z += (rng() - 0.5) * 0.1;
    }
  }

  function biteDown() {
    if (time - lastBiteT < 0.25) return;
    lastBiteT = time;
    if (mode !== 'water') return;
    if (isBobber) {
      biteHold = true;
      biteT = 0;
      const a = rng() * Math.PI * 2;
      biteDir.set(Math.cos(a), 0, Math.sin(a));
      FV.y -= 0.4;
      tapTip(12);
    } else {
      biteLoadT = 0;
      tapTip(45);
    }
  }

  const _d = new THREE.Vector3();
  function snap() {
    if (mode === 'lost') return;
    const wasFish = mode === 'fish';
    const far = isBobber && !wasFish ? F : L;
    _d.subVectors(far, tip);
    const dl = _d.length();
    if (dl > 1e-5) _d.multiplyScalar(1 / dl);
    else _d.set(0, 0, -1);
    mode = 'lost';
    lost = true;
    lostT = 0;
    biteHold = false;
    floatLostVisible = isBobber;
    if (isBobber && F.y < water.getHeight(F.x, F.z) - 0.02) F.y = water.getHeight(F.x, F.z);
    // the long part stays with the fish; its broken end recoils a little and falls to the water
    rope.clearPins();
    rope.setPinned(nPts - 1, true);
    for (let i = 0; i < nPts; i++) {
      const o = i * 3;
      const w = Math.pow(1 - i / nPts, 2);
      rope.prev[o] = rope.pos[o] - _d.x * 0.022 * w;
      rope.prev[o + 1] = rope.pos[o + 1] - _d.y * 0.022 * w - 0.006 * w;
      rope.prev[o + 2] = rope.pos[o + 2] - _d.z * 0.022 * w;
    }
    // short end left on the rod whips back and flutters down
    const tn = tail.n;
    tail.clearPins();
    tail.setPinned(0, true);
    const segLen = 0.6 / (tn - 1);
    for (let i = 0; i < tn - 1; i++) tail.rest[i] = segLen;
    _v.set(0, 0, 1).applyQuaternion(camQuat);
    for (let i = 0; i < tn; i++) {
      const s = i * segLen;
      tail.setPoint(i, tip.x + _d.x * s, tip.y + _d.y * s, tip.z + _d.z * s);
      const w = i / (tn - 1);
      const o = i * 3;
      tail.prev[o] -= (_v.x * 2.4 - _d.x * 0.5) * w / 60;
      tail.prev[o + 1] -= 2.2 * w / 60;
      tail.prev[o + 2] -= (_v.z * 2.4 - _d.z * 0.5) * w / 60;
    }
    tail.line.visible = true;
    tail.write();
    extN = 0;
    snapT = 0;
    poseV[3] += 1.1;
    lineOut = 0;
    writeSnapshot();
  }

  // ------------------------------------------------------------------ VR mode
  function ensureXRHands() {
    if (xrHands) return xrHands;
    const h = createHand({ quality, arm: false, materials: hand.materials });
    const rodGlove = h.object;
    rodGlove.name = 'hand-xr-rod';
    rodGlove.visible = false;
    rod.object.add(rodGlove);
    const reelGlove = new THREE.Mesh(h.object.geometry, h.object.material);
    reelGlove.name = 'hand-xr-reel';
    reelGlove.position.copy(XR_SEAT);
    xrReelMount.add(reelGlove);
    for (const o of [rodGlove, reelGlove]) {
      o.layers.enable(LAYERS.NO_REFLECT);
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    }
    xrHands = { h, rodGlove, reelGlove };
    return xrHands;
  }

  // setXRMode(true, { rodGrip, reelGrip, rodHand }) puts the rod (full scale) in the rod-hand controller grip:
  // the reel seat in the palm, the blank along the grip's forward (-Z) axis tilted XR_TILT up, the gloved hand
  // on it, and a second glove in the reel-hand grip. rodHand: 'right' (default) | 'left' (mirrors the gloves,
  // the reel handle moves to the right side); also read from rodGrip.userData.handedness. Call again to switch
  // grips or hands. setXRMode(false) restores the camera-attached half-scale desktop view model.
  // Returns whether VR mode is on.
  function setXRMode(on, opts) {
    const o = opts || {};
    if (on) {
      const rodGrip = o.rodGrip && o.rodGrip.isObject3D ? o.rodGrip : null;
      if (!rodGrip) return xrOn; // nothing to hold the rod: stay as we are
      const reelGrip = o.reelGrip && o.reelGrip.isObject3D && o.reelGrip !== rodGrip ? o.reelGrip : null;
      const side = o.rodHand || o.hand || (rodGrip.userData && rodGrip.userData.handedness) || (/(^|[^a-z])left([^a-z]|$)/i.test(rodGrip.name || '') ? 'left' : 'right');
      const left = side === 'left';
      // idempotent: calling it again with the same grips and hand changes nothing (no teleport, no re-hang)
      const same = xrOn && rodGrip === xrRodGrip && reelGrip === xrReelGrip && (left ? 'left' : 'right') === xrRodHand;
      if (same && xrRodMount.parent === rodGrip && rod.object.parent === xrRodMount && (!reelGrip || xrReelMount.parent === reelGrip)) return true;
      const hs = ensureXRHands();
      if (xrRodMount.parent !== rodGrip) rodGrip.add(xrRodMount);
      if (reelGrip) {
        if (xrReelMount.parent !== reelGrip) reelGrip.add(xrReelMount);
      } else if (xrReelMount.parent) xrReelMount.parent.remove(xrReelMount);
      if (rod.object.parent !== xrRodMount) xrRodMount.add(rod.object);
      rod.object.position.copy(XR_SEAT);
      rod.object.quaternion.identity();
      rod.object.scale.setScalar(1);
      hand.object.visible = false;
      hs.rodGlove.visible = true;
      hs.rodGlove.scale.set(left ? -1 : 1, 1, 1); // the model is a right hand
      hs.reelGlove.scale.set(left ? 1 : -1, 1, 1);
      rod.setCrankSide(left ? 'right' : 'left');
      vmRoot.visible = false;
      aimA = 0;
      aimRing.visible = false;
      if (!xrOn) xrHadPose = false;
      xrKinInit = false;
      crankLock = false;
      crankHandInit = false;
      xrOn = true;
      xrRodGrip = rodGrip;
      xrReelGrip = reelGrip;
      xrRodHand = left ? 'left' : 'right';
      xrJump = true;
      return true;
    }
    if (xrRodMount.parent) xrRodMount.parent.remove(xrRodMount);
    if (xrReelMount.parent) xrReelMount.parent.remove(xrReelMount);
    if (!xrOn) return false;
    xrOn = false;
    xrRodGrip = null;
    xrReelGrip = null;
    crankLock = false;
    vmRoot.add(rod.object);
    rod.object.scale.setScalar(1);
    hand.object.visible = true;
    if (xrHands) xrHands.rodGlove.visible = false;
    rod.setCrankSide('left');
    vmRoot.visible = true;
    // back to the camera-space pose, snapped there (no swing-in from where the hand was)
    poseInit = false;
    vmInit = false;
    poseV.fill(0);
    computeBasePose();
    updatePose(0, frameState, EMPTY_INPUT);
    applyPose(frameState);
    followCamera(0);
    xrJump = true;
    return false;
  }

  // World position of the reel seat (rod butt end of the fore grip), true scale.
  function getRodBase(target) {
    const out = target || new THREE.Vector3();
    rod.object.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(rod.object.matrixWorld);
    return trueScale(out);
  }

  // World position of the reel handle knob (moves as the handle turns), true scale.
  function getReelHandle(target) {
    const out = target || new THREE.Vector3();
    rod.crank.updateWorldMatrix(true, false);
    out.copy(rod.knobLocal);
    rod.crank.localToWorld(out);
    return trueScale(out);
  }

  // hookset sweep on every strike attempt
  const offs = [];
  if (events && events.on) {
    offs.push(
      events.on('strike', () => {
        poseV[3] += 6.5;
        poseV[1] += 0.4;
        tapTip(30);
      })
    );
    // Robust to either wiring: core may call nibble()/biteDown() itself; duplicates are ignored.
    offs.push(events.on('fish:nibble', (p) => nibble(p && p.strength01)));
    offs.push(events.on('fish:bite', () => biteDown()));
    offs.push(
      events.on('fish:missed', () => {
        biteHold = false;
      })
    );
  }

  for (const k in PHYS) speedForRange(PHYS[k].drag, 10);

  // initial placement
  computeBasePose();
  resetToHome();

  return {
    update,
    setLure,
    getLure: () => snapshot,
    getRodTip: (target) => (target || new THREE.Vector3()).copy(tip),
    cast,
    reel,
    setFight,
    setRodLoad,
    nibble,
    biteDown,
    snap,
    resetToHome,
    predictLanding, // extra (not in the contract): cast preview for an aim ring
    // VR (XR.md)
    setXRMode,
    getRodBase,
    getReelHandle,
    get xrMode() {
      return xrOn;
    },
    object: vmRoot,
    dispose() {
      for (const off of offs) if (typeof off === 'function') off();
      if (xrRodMount.parent) xrRodMount.parent.remove(xrRodMount);
      if (xrReelMount.parent) xrReelMount.parent.remove(xrReelMount);
      if (xrHands) xrHands.h.dispose();
      scene.remove(vmRoot, rope.line, tail.line, aimRing);
      aimGeom.dispose();
      aimMat.dispose();
      for (const m of Object.values(models)) for (const o of [m.object, m.bait, m.shot]) if (o) scene.remove(o);
      rope.dispose();
      tail.dispose();
      inRod.dispose();
      lineMat.dispose();
      rod.dispose();
      hand.dispose();
      lureSet.dispose();
    },
    // for sandboxes / debugging (not part of the contract)
    debug: {
      rod, rope, models, pose, base, Feff, Ftarget,
      get extN() { return extN; }, get mode() { return mode; }, get tip() { return tip; }, get camPos() { return camPos; },
      get handleAngle() { return handleAngle; }, get bail01() { return bail01; },
      xr: {
        rodMount: xrRodMount, reelMount: xrReelMount,
        get on() { return xrOn; }, get hands() { return xrHands; }, get tracked() { return xrTracked; },
        get rodHand() { return xrRodHand; }, get tipVel() { return xrTipV; }, get tipAcc() { return xrTipA; },
        get crankLock() { return crankLock; }, get castPitch() { return castPitch; },
      },
    },
  };
}
