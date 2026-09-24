// Fish-behavior sandbox.
//  1. Visual: fish cruising near the dock over shallow water from the player's eye, a bobber
//     that draws a school in, and an overhead inset of the whole population (dots by species).
//  2. Logic suite (fixed-dt, runs time-sliced in the background, logs to the console and to
//     window.__fishai.results): first-bite waits per lure / hour / spot, weight distributions
//     vs the length-weight curve, and fight simulations against a simple core-like line model.
// The suite functions are plain JS so they can also run under node (no DOM needed).
import * as THREE from 'three';
import { makeSandbox, stubEnvironment } from './stubs.js';
import { SPECIES, SPECIES_BY_ID, rollFish, lengthFromWeight } from '../fish/species.js';
import { createFishSystem } from '../fish/system.js';
import { createFishMesh } from '../fish/mesh.js';
import { createEmitter, LURES, TACKLE, WATER_LEVEL, LAYERS, makeRng, clamp, lerp, smoothstep } from '../config.js';

// =====================================================================================
// A contract-shaped lake (CONTRACT.md "Coordinates and the lake") for sandboxing.
// =====================================================================================
function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
export function makeLakeField() {
  const prof = [
    [0, 0],
    [4, 0.35],
    [16, 1.6],
    [28, 3.0],
    [46, 5.0],
    [76, 9.0],
    [110, 10.5],
    [600, 11],
  ];
  function profile(out) {
    if (out <= 0) return out * 0.09; // land rises behind the shore
    for (let i = 1; i < prof.length; i++) {
      if (out <= prof[i][0]) {
        const t = (out - prof[i - 1][0]) / (prof[i][0] - prof[i - 1][0]);
        return lerp(prof[i - 1][1], prof[i][1], t * t * (3 - 2 * t));
      }
    }
    return 11;
  }
  const shoreZ = (x) => (x < -52 ? 16 - (-52 - x) * 0.85 : x > 50 ? 16 - (x - 50) * 0.75 : 16 + 1.2 * Math.sin(x * 0.07));
  const out = { depth: 0, weeds: 0, rocks: 0, wood: 0 };
  function field(x, z) {
    let d = profile(shoreZ(x) - z);
    // far shore (irregular ellipse ~250-380 m away)
    const r = Math.hypot(x / (300 + 30 * Math.sin(z * 0.013)), (z + 150) / 185);
    if (r > 0.94) d = Math.min(d, lerp(d, -3, smoothstep(0.94, 1.02, r)));
    // weedy cove to the left
    const cw = smoothstep(-50, -42, x) * (1 - smoothstep(-18, -11, x)) * smoothstep(-16, -9, z) * (1 - smoothstep(12, 17, z));
    if (cw > 0) {
      const coveD = 0.4 + 1.6 * smoothstep(14, -12, z) * (0.75 + 0.25 * smoothstep(-45, -25, x));
      d = lerp(d, coveD, cw);
    }
    // rocky point / drop-off to the right
    const pr = Math.hypot(x - 43, z + 5) / 27;
    const pw = smoothstep(12, 20, x) * (1 - smoothstep(-36, -28, -z) * 0) * (1 - smoothstep(1.0, 1.25, pr));
    if (pw > 0 && d > 0) {
      const pd = 0.9 + 6.4 * smoothstep(0.3, 0.95, pr);
      d = lerp(d, Math.min(d + 1.5, pd), pw);
    }
    // sunken timber patch
    const tr = Math.hypot(x + 10, z + 22);
    if (tr < 9) d = lerp(d, 3.5, (1 - smoothstep(4, 9, tr)) * 0.8);
    // gentle bed texture
    if (d > 0.2) d += (vnoise(x * 0.12, z * 0.12) - 0.5) * 0.35 * Math.min(1, d / 2);
    out.depth = d;
    // habitat
    const wn = vnoise(x * 0.18 + 7, z * 0.18 - 3);
    const inWeedDepth = smoothstep(0.3, 0.7, d) * (1 - smoothstep(2.4, 3.4, d));
    out.weeds = clamp(cw * (0.5 + 0.5 * wn) * (1 - smoothstep(-19, -13, x) * 0.6) + inWeedDepth * 0.35 * smoothstep(0.45, 0.8, wn), 0, 1) * inWeedDepth;
    out.rocks = clamp(pw * (0.55 + 0.45 * vnoise(x * 0.3, z * 0.3)) * (1 - smoothstep(0.9, 1.2, pr)), 0, 1);
    out.wood = clamp(1 - smoothstep(2, 8, tr), 0, 1);
    return out;
  }
  const env = {
    getTerrainHeight: (x, z) => WATER_LEVEL - field(x, z).depth,
    getDepth: (x, z) => Math.max(0, field(x, z).depth),
    isWater: (x, z) => field(x, z).depth > 0.05,
    getHabitat: (x, z) => {
      const f = field(x, z);
      return { depth: Math.max(0, f.depth), weeds: f.weeds, rocks: f.rocks, wood: f.wood };
    },
    field,
  };
  return env;
}

// =====================================================================================
// Tackle stand-in: a lure / bobber that can be cast, retrieved and paused.
// =====================================================================================
const ROD_TIP = new THREE.Vector3(0.25, 2.7, -1.7);
export function createSimLure(events, env) {
  const snap = {
    id: 'bobber',
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    state: 'home',
    inWater: false,
    depthM: 0,
    speedMps: 0,
    retrieving: false,
    pausedS: 0,
    distanceM: 0,
    lineOutM: 0,
    bobberPosition: null,
  };
  const bob = new THREE.Vector3();
  let reeled = 0;
  function cast(lureId, x, z) {
    const def = LURES.find((l) => l.id === lureId) || LURES[0];
    snap.id = def.id;
    snap.state = 'water';
    snap.inWater = true;
    const depth = env.getDepth(x, z);
    snap.depthM = def.id === 'bobber' ? Math.min(def.depthM, depth - 0.2) : def.id === 'spinner' ? 0.15 : 0.02;
    snap.position.set(x, -Math.max(0.02, snap.depthM), z);
    snap.velocity.set(0, 0, 0);
    snap.speedMps = 0;
    snap.pausedS = 0;
    snap.retrieving = false;
    reeled = 0;
    snap.bobberPosition = def.id === 'bobber' ? bob.set(x, 0, z) : null;
    events.emit('lure:landed', { position: new THREE.Vector3(x, 0, z), lureId: def.id, onWater: true, speed: 11 });
  }
  function step(dt, reel01) {
    if (snap.state !== 'water') return;
    const p = snap.position;
    const isBait = snap.id === 'bobber';
    const speed = reel01 > 0 ? TACKLE.reelRetrieveMps * reel01 : 0;
    const dx = ROD_TIP.x - p.x;
    const dz = ROD_TIP.z - p.z;
    const dh = Math.hypot(dx, dz) || 1;
    const depthHere = env.getDepth(p.x, p.z);
    if (speed > 0) {
      const mv = Math.min(speed * dt, dh);
      p.x += (dx / dh) * mv;
      p.z += (dz / dh) * mv;
      reeled += mv;
      snap.velocity.set((dx / dh) * speed, 0, (dz / dh) * speed);
      snap.speedMps = speed;
      snap.pausedS = 0;
      snap.retrieving = true;
      let targetD = 0;
      if (snap.id === 'spinner') targetD = 0.8;
      else if (snap.id === 'crankbait') targetD = Math.min(2.4, 0.3 + reeled * 0.16);
      else if (isBait) targetD = Math.min(1.5, depthHere - 0.2);
      targetD = Math.min(targetD, Math.max(0.05, depthHere - 0.15));
      snap.depthM += (targetD - snap.depthM) * Math.min(1, dt * 1.5);
    } else {
      snap.velocity.set(0, 0, 0);
      snap.speedMps = 0;
      snap.pausedS += dt;
      snap.retrieving = false;
      if (snap.id === 'crankbait') snap.depthM = Math.max(0.02, snap.depthM - 0.12 * dt);
      else if (snap.id === 'spinner') snap.depthM = Math.min(depthHere - 0.08, snap.depthM + 0.15 * dt);
      else if (isBait) snap.depthM = Math.min(1.5, depthHere - 0.2);
    }
    p.y = -Math.max(0.02, snap.depthM);
    snap.distanceM = Math.hypot(p.x - ROD_TIP.x, p.z - ROD_TIP.z);
    snap.lineOutM = Math.hypot(snap.distanceM, ROD_TIP.y - p.y);
    if (snap.bobberPosition) snap.bobberPosition.set(p.x, 0, p.z);
    if (snap.distanceM < 1.6) {
      snap.state = 'home';
      snap.inWater = false;
      events.emit('lure:home', {});
    }
  }
  function home() {
    snap.state = 'home';
    snap.inWater = false;
  }
  return { snap, cast, step, home };
}

// Retrieve patterns -> reel01 at time t (seconds since the cast landed).
function retrieve(pattern, t, events, lurePos) {
  switch (pattern) {
    case 'sit':
      return 0;
    case 'steady':
      return t < 1 ? 0 : 1;
    case 'slow':
      return t < 1 ? 0 : 0.45;
    case 'walk': {
      // topwater: short pulls with pauses, a pop on each pull
      if (t < 2) return 0;
      const c = (t - 2) % 1.6;
      if (c < 0.05 && events) events.emit('lure:twitch', { position: lurePos });
      return c < 0.55 ? 0.9 : 0;
    }
    case 'stopgo':
    default: {
      if (t < 1) return 0;
      const c = (t - 1) % 3.2;
      return c < 2.1 ? 0.85 : 0;
    }
  }
}

// =====================================================================================
// Logic suites (generators: yield to let the browser breathe)
// =====================================================================================
const SPOTS = {
  dock: [-2.5, -6],
  coveEdge: [-15, -3],
  cove: [-26, 2],
  point: [25, -19],
  timber: [-10, -21],
  open: [2, -34],
};
const HOURS = { dawn: 5.75, morning: 9, noon: 12.5, dusk: 19.67, night: 22.5 };
const PATTERN = { bobber: 'sit', spinner: 'stopgo', crankbait: 'stopgo', topwater: 'walk' };

function makeLogicSystem(seed, quality = 'high') {
  const events = createEmitter();
  const env = makeLakeEnv();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2500);
  camera.position.set(0, 2.2, 0);
  camera.updateMatrixWorld(true);
  const sys = createFishSystem({ events, env, water: null, camera, quality, seed, renderFish: false });
  return { sys, events, env, camera };
}
let _lakeEnv = null;
function makeLakeEnv() {
  if (!_lakeEnv) _lakeEnv = makeLakeField();
  return _lakeEnv;
}

// Time to first bite from one cast position (recasting lures when they come home).
function* firstBiteTrial(opts, out) {
  const { lureId, hours, spot, seed, cap = 180, pattern = PATTERN[lureId], quality } = opts;
  const { sys, events, env, camera } = makeLogicSystem(seed, quality);
  const rng = makeRng(seed * 7 + 3);
  const lure = createSimLure(events, env);
  let bite = null;
  let nibbles = 0;
  let interest = 0;
  events.on('fish:bite', (e) => {
    if (!bite) bite = e;
  });
  events.on('fish:nibble', () => nibbles++);
  events.on('fish:interest', () => interest++);
  const frame = { dt: 1 / 20, time: 0, hours, camera, state: 'waiting', quality: 'high', input: {}, lure: lure.snap, hooked: null };
  // settle
  for (let i = 0; i < 200; i++) {
    frame.time += frame.dt;
    sys.update(frame);
  }
  const doCast = () => {
    const a = rng() * Math.PI * 2;
    const r = rng() * 1.5;
    lure.cast(lureId, spot[0] + Math.sin(a) * r, spot[1] + Math.cos(a) * r);
  };
  doCast();
  let t = 0;
  let tc = 0;
  let casts = 1;
  let n = 0;
  while (t < cap && !bite) {
    const reel = retrieve(pattern, tc, events, lure.snap.position);
    lure.step(frame.dt, reel);
    if (lure.snap.state === 'home') {
      doCast();
      casts++;
      tc = 0;
    }
    frame.time += frame.dt;
    frame.hours = hours + t / 3600;
    sys.update(frame);
    t += frame.dt;
    tc += frame.dt;
    if (++n % 400 === 0) yield;
  }
  out.push({ t: bite ? t : cap, bit: !!bite, species: bite ? bite.speciesId : null, weightKg: bite ? bite.weightKg : 0, casts, nibbles, interest, counters: { ...sys.counters } });
}

// A longer session: every bite is hooked and landed at once, recast right away.
function* sessionTrial(opts, out) {
  const { lureId, hours, spot, seed, minutes = 6, pattern = PATTERN[lureId] } = opts;
  const { sys, events, env, camera } = makeLogicSystem(seed);
  const rng = makeRng(seed * 13 + 1);
  const lure = createSimLure(events, env);
  const caught = [];
  let pendingBite = null;
  events.on('fish:bite', (e) => (pendingBite = e));
  const frame = { dt: 1 / 20, time: 0, hours, camera, state: 'waiting', quality: 'high', input: {}, lure: lure.snap, hooked: null };
  for (let i = 0; i < 200; i++) {
    frame.time += frame.dt;
    sys.update(frame);
  }
  const doCast = () => {
    const a = rng() * Math.PI * 2;
    const r = rng() * 2;
    lure.cast(lureId, spot[0] + Math.sin(a) * r, spot[1] + Math.cos(a) * r);
  };
  doCast();
  let t = 0;
  let tc = 0;
  let n = 0;
  let reactT = -1;
  let fishT = 0; // time with a line in the water (excludes fights / unhooking)
  while (t < minutes * 60) {
    const reel = retrieve(pattern, tc, events, lure.snap.position);
    lure.step(frame.dt, reel);
    if (lure.snap.state === 'home') {
      doCast();
      tc = 0;
    }
    frame.time += frame.dt;
    sys.update(frame);
    if (pendingBite && reactT < 0) reactT = 0.35 + rng() * 0.3; // human reaction
    if (reactT >= 0) {
      reactT -= frame.dt;
      if (reactT < 0 && pendingBite) {
        const hf = sys.hookBite(pendingBite.biteId);
        if (hf) {
          caught.push({ species: hf.speciesId, kg: hf.weightKg, t });
          sys.releaseHooked('landed');
          // a fight + unhooking takes a while: skip ahead ~45 s of lake time without a lure
          lure.home();
          for (let i = 0; i < 45 * 20; i++) {
            frame.time += frame.dt;
            sys.update(frame);
          }
          t += 45;
        }
        pendingBite = null;
        doCast();
        tc = 0;
      }
    }
    t += frame.dt;
    tc += frame.dt;
    fishT += frame.dt;
    if (++n % 400 === 0) yield;
  }
  out.push({ caught, minutes, fishingMinutes: fishT / 60, counters: { ...sys.counters } });
}

// ---- core-like fight model (CONTRACT.md "Fight model (core)") ----
const FIGHT_START = {
  bluegill: [-3, -1.0, -8],
  yellow_perch: [-4, -2.2, -14],
  rainbow_trout: [4, -3.0, -32],
  smallmouth_bass: [22, -2.2, -17],
  largemouth_bass: [-12, -1.0, -8],
  walleye: [24, -3.5, -23],
  channel_catfish: [-10, -3.0, -21],
  northern_pike: [-15, -1.0, -4],
  muskellunge: [-16, -1.2, -12],
};
export const POLICIES = {
  careful: { drag01: 0.45, reel: 'careful' }, // reel only when the drag isn't slipping, back off drag on big runs
  steady: { drag01: 0.45, reel: 'always' }, // default drag, cranks the whole time
  cranked: { drag01: 1.0, reel: 'always' }, // drag locked down, cranks through runs
  loose: { drag01: 0.15, reel: 'always' },
};
export function simulateFight(sys, speciesId, weightKg, policyName, seed, capS = 300) {
  const pol = POLICIES[policyName];
  const rng = makeRng(seed);
  const s0 = FIGHT_START[speciesId] || [0, -1.5, -15];
  const start = new THREE.Vector3(s0[0] + (rng() - 0.5) * 4, s0[1], s0[2] + (rng() - 0.5) * 4);
  const hf = sys.debugHook(speciesId, weightKg, start);
  if (!hf) return null;
  const tip = ROD_TIP.clone();
  const dt = 1 / 120;
  const k = 60;
  const c = 3;
  let drag01 = pol.drag01;
  let dragN = lerp(TACKLE.dragMinN, TACKLE.dragMaxN, drag01);
  let lineOut = hf.position.distanceTo(tip) - 0.05;
  let prevStretch = hf.position.distanceTo(tip) - lineOut;
  let slipping = false;
  let overT = 0;
  let slackT = 0;
  let maxT = 0;
  let t = 0;
  let outcome = 'timeout';
  let maxLine = lineOut;
  let jumps = 0;
  let dragChanges = 0;
  let lowDragT = 0;
  let slipTotal = 0;
  const pull = new THREE.Vector3();
  const unsub = sys.__events ? null : null;
  void unsub;
  while (t < capS) {
    const d = hf.position.distanceTo(tip);
    const stretch = d - lineOut;
    const rate = (stretch - prevStretch) / dt;
    prevStretch = stretch;
    let T = stretch > 0 ? Math.max(0, k * stretch + c * rate) : 0;
    // drag: breaks away a little above the setting, then pays out line with a short lag;
    // cranking the handle against a slipping drag adds rotor friction (+12%)
    const cranking = pol.reel === 'always' || (pol.reel === 'careful' && !slipping && T < dragN * 0.8);
    const effDrag = dragN * (cranking && slipping ? 1.12 : 1);
    const breakaway = slipping ? effDrag : dragN * 1.08;
    if (T > breakaway) {
      slipping = true;
      const excess = (T - effDrag) / k;
      const slip = excess * (1 - Math.exp(-dt / 0.05));
      lineOut += slip;
      slipTotal += slip;
    } else if (T < dragN * 0.92) slipping = false;
    // the player
    let reeling = false;
    if (pol.reel === 'always') reeling = true;
    else {
      // careful angler: pump and reel between runs; ease the drag a notch if the line gets
      // dangerously tight (heavy drag / short line), put it back once things calm down
      reeling = !slipping && T < dragN * 0.8;
      if (T > 40 && drag01 > 0.25 && lowDragT <= 0) {
        drag01 = Math.max(0.25, drag01 - 0.1);
        dragChanges++;
        lowDragT = 4;
      }
      lowDragT -= dt;
      if (lowDragT < -5 && drag01 < pol.drag01 && T < dragN * 0.6) {
        drag01 = Math.min(pol.drag01, drag01 + 0.1);
        dragChanges++;
        lowDragT = 0;
      }
      dragN = lerp(TACKLE.dragMinN, TACKLE.dragMaxN, drag01);
    }
    if (reeling && T < dragN) lineOut = Math.max(2.5, lineOut - TACKLE.reelRetrieveMps * dt);
    maxLine = Math.max(maxLine, lineOut);
    maxT = Math.max(maxT, T);
    if (T > TACKLE.lineBreakN) overT += dt;
    else overT = 0;
    if (overT > 0.12) {
      outcome = 'snapped';
      break;
    }
    if (lineOut > TACKLE.spoolCapacityM) {
      outcome = 'spooled';
      break;
    }
    if (T < 1) slackT += dt;
    else slackT = 0;
    if (slackT > 2.5 && hf.headShake01 > 0.5 && rng() < dt * 1.5) {
      outcome = 'threw hook';
      break;
    }
    pull.subVectors(tip, hf.position);
    if (pull.lengthSq() > 1e-9) pull.normalize();
    const wasJ = hf.isJumping;
    hf.step(dt, { tensionN: T, pullDir: pull, rodTip: tip, lineOutM: lineOut });
    if (!wasJ && hf.isJumping) jumps++;
    t += dt;
    const hd = Math.hypot(hf.position.x - tip.x, hf.position.z - tip.z);
    if (lineOut < 3.2 && hd < 4.5 && hf.stamina01 < 0.3) {
      outcome = 'landed';
      break;
    }
    const p = hf.position;
    if (!Number.isFinite(p.x + p.y + p.z)) {
      outcome = 'NaN';
      break;
    }
  }
  const res = { outcome, t, maxT, maxLine, jumps, stamina: hf.stamina01, dragChanges, slip: slipTotal };
  sys.releaseHooked(outcome === 'landed' ? 'landed' : outcome === 'snapped' ? 'snapped' : 'escaped');
  return res;
}

export function* fightSuite(out, trials = 12, cap = 300, only = null) {
  const { sys } = makeLogicSystem(99);
  let seed = 1000;
  for (const sp of SPECIES) {
    if (only && !only.includes(sp.id)) continue;
    const wTyp = sp.weightKg.typical * 1.1;
    const wBig = Math.min(sp.weightKg.max * 0.72, sp.weightKg.typical * 3.2);
    for (const [label, kg] of [
      ['typ', wTyp],
      ['big', wBig],
    ]) {
      for (const pol of Object.keys(POLICIES)) {
        const rs = [];
        for (let i = 0; i < trials; i++) {
          const r = simulateFight(sys, sp.id, kg, pol, seed++, cap);
          if (r) rs.push(r);
          yield;
        }
        const landed = rs.filter((r) => r.outcome === 'landed');
        const times = landed.map((r) => r.t).sort((a, b) => a - b);
        out.push({
          species: sp.id,
          size: label,
          kg: +kg.toFixed(2),
          policy: pol,
          n: rs.length,
          landed: landed.length,
          snapped: rs.filter((r) => r.outcome === 'snapped').length,
          threw: rs.filter((r) => r.outcome === 'threw hook').length,
          timeout: rs.filter((r) => r.outcome === 'timeout' || r.outcome === 'spooled').length,
          nan: rs.filter((r) => r.outcome === 'NaN').length,
          medianS: times.length ? +times[Math.floor(times.length / 2)].toFixed(1) : null,
          maxT: +Math.max(...rs.map((r) => r.maxT)).toFixed(1),
          medMaxT: +rs.map((r) => r.maxT).sort((a, b) => a - b)[Math.floor(rs.length / 2)].toFixed(1),
          maxLine: +Math.max(...rs.map((r) => r.maxLine)).toFixed(1),
          jumps: +(rs.reduce((a, r) => a + r.jumps, 0) / rs.length).toFixed(1),
        });
      }
    }
  }
}

export function weightSuite(out, n = 3000) {
  const rng = makeRng(4242);
  for (const sp of SPECIES) {
    const ws = [];
    const ls = [];
    for (let i = 0; i < n; i++) {
      const f = rollFish(sp.id, rng);
      ws.push(f.weightKg);
      ls.push(f.lengthCm);
    }
    ws.sort((a, b) => a - b);
    ls.sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
    out.push({
      species: sp.id,
      expect: sp.weightKg,
      p10: +q(ws, 0.1).toFixed(3),
      p50: +q(ws, 0.5).toFixed(3),
      p90: +q(ws, 0.9).toFixed(3),
      p99: +q(ws, 0.99).toFixed(3),
      max: +ws[ws.length - 1].toFixed(3),
      overMax: ws.filter((w) => w > sp.weightKg.max).length,
      lenP50: +q(ls, 0.5).toFixed(1),
      lenAtTypical: +lengthFromWeight(sp, sp.weightKg.typical).toFixed(1),
    });
  }
}

export function* biteSuite(out, { trials = 6, combos = null, cap = 180 } = {}) {
  const list =
    combos ||
    [
      ['bobber', 'dock'],
      ['bobber', 'timber'],
      ['spinner', 'coveEdge'],
      ['spinner', 'open'],
      ['crankbait', 'point'],
      ['crankbait', 'coveEdge'],
      ['topwater', 'coveEdge'],
      ['topwater', 'dock'],
    ];
  let seed = 1;
  for (const [lureId, spotName] of list) {
    for (const hName of Object.keys(HOURS)) {
      const rs = [];
      for (let i = 0; i < trials; i++) {
        yield* firstBiteTrial({ lureId, hours: HOURS[hName], spot: SPOTS[spotName], seed: seed++, cap }, rs);
      }
      const ts = rs.map((r) => r.t).sort((a, b) => a - b);
      const sp = {};
      for (const r of rs) if (r.species) sp[r.species] = (sp[r.species] || 0) + 1;
      out.push({
        lure: lureId,
        spot: spotName,
        hour: hName,
        n: rs.length,
        bit: rs.filter((r) => r.bit).length,
        medianS: +ts[Math.floor(ts.length / 2)].toFixed(1),
        meanS: +(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(1),
        species: sp,
        nibbles: +(rs.reduce((a, r) => a + r.nibbles, 0) / rs.length).toFixed(1),
        follows: +(rs.reduce((a, r) => a + r.counters.follows, 0) / rs.length).toFixed(1),
        dockTurn: rs.reduce((a, r) => a + r.counters.dockTurnaways, 0),
        spooked: rs.reduce((a, r) => a + r.counters.spooked, 0),
        recycled: +(rs.reduce((a, r) => a + r.counters.recycled, 0) / rs.length).toFixed(1),
      });
    }
  }
}

export function* sessionSuite(out, { minutes = 8, combos = null } = {}) {
  const list = combos || [
    ['bobber', 'dock', 'morning'],
    ['bobber', 'timber', 'night'],
    ['spinner', 'coveEdge', 'dawn'],
    ['crankbait', 'point', 'dusk'],
    ['topwater', 'coveEdge', 'dusk'],
    ['spinner', 'coveEdge', 'noon'],
  ];
  let seed = 500;
  for (const [lureId, spotName, hName] of list) {
    const rs = [];
    yield* sessionTrial({ lureId, hours: HOURS[hName], spot: SPOTS[spotName], seed: seed++, minutes }, rs);
    const r = rs[0];
    const sp = {};
    for (const c of r.caught) sp[c.species] = (sp[c.species] || 0) + 1;
    out.push({ lure: lureId, spot: spotName, hour: hName, bitesPerMin: +(r.caught.length / Math.max(0.05, r.fishingMinutes)).toFixed(2), caught: r.caught.length, species: sp, maxKg: +Math.max(0, ...r.caught.map((c) => c.kg)).toFixed(2) });
  }
}

// Runs everything; `slice(fn)` is called between chunks so a browser can keep rendering.
export async function runSuite({ log = console.log, slice = null, quick = false } = {}) {
  const results = { weights: [], bites: [], sessions: [], fights: [] };
  const drive = async (gen) => {
    let t0 = performance.now();
    for (const _ of gen) {
      void _;
      if (slice && performance.now() - t0 > 30) {
        await slice();
        t0 = performance.now();
      }
    }
  };
  const T0 = performance.now();
  weightSuite(results.weights);
  log('[fishai] weights (kg): species p10 / p50 / p90 / p99 / max | expected typical / max | median length cm');
  for (const w of results.weights) log(`[fishai]   ${w.species.padEnd(16)} ${w.p10} / ${w.p50} / ${w.p90} / ${w.p99} / ${w.max} | ${w.expect.typical} / ${w.expect.max} (over max: ${w.overMax}) | L50 ${w.lenP50} cm`);
  await drive(biteSuite(results.bites, quick ? { trials: 3 } : {}));
  log('[fishai] first-bite wait (s): lure @ spot, hour -> median / mean (bit n/N) species');
  for (const b of results.bites) log(`[fishai]   ${(b.lure + ' @ ' + b.spot).padEnd(22)} ${b.hour.padEnd(8)} ${String(b.medianS).padStart(6)} / ${String(b.meanS).padStart(6)}  (${b.bit}/${b.n})  nib ${b.nibbles} fol ${b.follows} dockTurn ${b.dockTurn} spook ${b.spooked} recyc ${b.recycled}  ${JSON.stringify(b.species)}`);
  await drive(sessionSuite(results.sessions, quick ? { minutes: 4 } : {}));
  log('[fishai] sessions (bites per fishing minute, instant landing):');
  for (const s of results.sessions) log(`[fishai]   ${(s.lure + ' @ ' + s.spot).padEnd(22)} ${s.hour.padEnd(8)} ${s.bitesPerMin}/min  caught ${s.caught} max ${s.maxKg} kg ${JSON.stringify(s.species)}`);
  await drive(fightSuite(results.fights, quick ? 4 : 10));
  log('[fishai] fights: species size kg policy -> landed/snapped/threw/timeout of n, median landing s, max tension N (median max), max line m, jumps');
  for (const f of results.fights) log(`[fishai]   ${f.species.padEnd(16)} ${f.size} ${String(f.kg).padStart(6)} ${f.policy.padEnd(8)} L${f.landed} S${f.snapped} H${f.threw} T${f.timeout}${f.nan ? ' NaN' + f.nan : ''} /${f.n}  ${String(f.medianS).padStart(6)} s  Tmax ${f.maxT} (${f.medMaxT})  line ${f.maxLine}  jumps ${f.jumps}`);
  log(`[fishai] suite done in ${((performance.now() - T0) / 1000).toFixed(1)} s`);
  return results;
}

// =====================================================================================
// Browser: visual check + background suite
// =====================================================================================
function buildLakeScene(scene, lake) {
  // lake bed + shore around the dock, vertex-colored by depth and habitat
  const W = 240;
  const D = 200;
  const g = new THREE.PlaneGeometry(W, D, 160, 134).rotateX(-Math.PI / 2);
  g.translate(-10, 0, -40);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const mud = new THREE.Color(0x7a6f52);
  const sand = new THREE.Color(0xb3a27c);
  const weed = new THREE.Color(0x4a5a2a);
  const rock = new THREE.Color(0x8a867a);
  const grass = new THREE.Color(0x56643a);
  const deep = new THREE.Color(0x1f3a3a);
  const wood = new THREE.Color(0x4a3a2a);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const f = lake.field(x, z);
    pos.setY(i, -f.depth);
    const n = hash2(Math.floor(x * 3), Math.floor(z * 3));
    if (f.depth < 0.05) c.copy(grass).lerp(sand, smoothstep(-1.2, 0.05, f.depth));
    else {
      c.copy(sand).lerp(mud, smoothstep(0.2, 1.6, f.depth));
      c.lerp(weed, f.weeds * 0.85);
      c.lerp(rock, f.rocks * 0.8);
      c.lerp(wood, f.wood * 0.5);
      // baked absorption: the bed fades to green-blue with depth (clarity ~3 m)
      c.lerp(deep, 1 - Math.exp(-f.depth / 2.6));
    }
    c.multiplyScalar(0.88 + 0.24 * n);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const bed = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  bed.layers.enable(LAYERS.UNDERWATER);
  scene.add(bed);

  // boulders on the point, a few sunken logs
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d6b64, roughness: 0.9 });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 40);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const rr = makeRng(5);
  let k = 0;
  for (let i = 0; i < 400 && k < 40; i++) {
    const x = 14 + rr() * 36;
    const z = -32 + rr() * 30;
    const f = lake.field(x, z);
    if (f.rocks < 0.35) continue;
    const sc = 0.3 + rr() * 0.9;
    s.set(sc * (0.8 + rr() * 0.5), sc * (0.5 + rr() * 0.4), sc * (0.8 + rr() * 0.5));
    q.setFromEuler(new THREE.Euler(rr(), rr() * 6, rr()));
    p.set(x, -f.depth + sc * 0.25, z);
    m.compose(p, q, s);
    rocks.setMatrixAt(k++, m);
  }
  rocks.count = k;
  rocks.layers.enable(LAYERS.UNDERWATER);
  scene.add(rocks);
  const logMat = new THREE.MeshStandardMaterial({ color: 0x3b3024, roughness: 1 });
  for (let i = 0; i < 6; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 5 + rr() * 4, 8), logMat);
    const x = -10 + (rr() - 0.5) * 8;
    const z = -22 + (rr() - 0.5) * 8;
    log.position.set(x, -lake.field(x, z).depth + 0.2, z);
    log.rotation.set(Math.PI / 2 + (rr() - 0.5) * 0.4, rr() * 6, 0);
    log.layers.enable(LAYERS.UNDERWATER);
    scene.add(log);
  }
  // dock pilings
  const pileMat = new THREE.MeshStandardMaterial({ color: 0x4a3b2c, roughness: 0.9 });
  for (let z = -0.8; z < 16; z += 2.4) {
    for (const x of [-0.85, 0.85]) {
      const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 3.5, 8), pileMat);
      pile.position.set(x, -1.2, z);
      pile.layers.enable(LAYERS.UNDERWATER);
      scene.add(pile);
    }
  }
  // clear-ish lake water: tinted, mostly transparent near the dock
  const wmat = new THREE.MeshStandardMaterial({ color: 0x2f5550, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.22, depthWrite: false });
  const waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), wmat);
  waterMesh.renderOrder = 10;
  scene.add(waterMesh);
  return { bed, waterMesh };
}

// Capsule-ish stand-in used only if the real fish mesh module throws.
function standInMesh(species, lengthCm) {
  const L = lengthCm / 100;
  const h = (species.bodyDepth || 0.25) * L;
  const g = new THREE.SphereGeometry(0.5, 16, 10);
  g.scale(h * 0.9, h, L);
  const mat = new THREE.MeshStandardMaterial({ color: 0x6b6a48, roughness: 0.5 });
  const mesh = new THREE.Mesh(g, mat);
  const o = new THREE.Group();
  o.add(mesh);
  return { object3d: o, update() {}, dispose() { g.dispose(); mat.dispose(); } };
}

async function main() {
  const quality = 'high';
  const { renderer, scene, camera, events, ctx } = makeSandbox({ quality });
  const env = stubEnvironment({ scene, renderer });
  // replace the stub's bowl with the contract-shaped lake
  for (const ch of [...scene.children]) if (ch.isMesh && ch.geometry && ch.geometry.type === 'PlaneGeometry') scene.remove(ch);
  const lake = makeLakeField();
  Object.assign(env, { getTerrainHeight: lake.getTerrainHeight, getDepth: lake.getDepth, isWater: lake.isWater, getHabitat: lake.getHabitat });
  scene.fog = new THREE.Fog(env.horizonColor.getHex(), 60, 700);
  // mid-morning sun (~45 deg) with shadows around the dock, so fish shadows show on the sand
  scene.traverse((o) => {
    if (o.isDirectionalLight) {
      o.position.set(18, 30, -22);
      o.intensity = 2.8;
      o.castShadow = true;
      o.shadow.mapSize.set(1024, 1024);
      Object.assign(o.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 90 });
      o.shadow.bias = -0.0005;
      o.target.position.set(0, 0, -4);
      scene.add(o.target);
    }
    if (o.isHemisphereLight) o.intensity = 1.1;
  });
  const lakeMeshes = buildLakeScene(scene, lake);
  lakeMeshes.bed.receiveShadow = true;
  const water = {
    update() {},
    getHeight: () => WATER_LEVEL,
    getNormal: (x, z, t = new THREE.Vector3()) => t.set(0, 1, 0),
    addRipple() {},
    splash() {},
    wake() {},
    clarityM: 3,
  };
  // the real fish meshes (mesh.js); the capsule stand-in only if that module is missing its export
  const override = typeof createFishMesh === 'function' ? null : standInMesh;
  const sys = createFishSystem({ ...ctx, env, water, quality, seed: 20260924, hours: 9.2, ...(override ? { createFishMesh: override } : {}) });
  const simLure = createSimLure(events, lake);
  // a red-and-white float so the bobber is visible
  const floatG = new THREE.Group();
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xb8231d, roughness: 0.4 }));
  const bot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.4 }));
  floatG.add(top, bot);
  floatG.visible = false;
  scene.add(floatG);

  // overhead inset: dots per fish, colored by species
  const SPC = { bluegill: 0x3aa0ff, yellow_perch: 0xffd23a, rainbow_trout: 0xff7ab8, smallmouth_bass: 0xc08a3a, largemouth_bass: 0x4ccf4c, walleye: 0xe0e070, channel_catfish: 0x8a8a8a, northern_pike: 0x2f8f5f, muskellunge: 0xff4020 };
  const MAXP = 64;
  const dotGeo = new THREE.BufferGeometry();
  const dotPos = new Float32Array(MAXP * 3);
  const dotCol = new Float32Array(MAXP * 3);
  dotGeo.setAttribute('position', new THREE.BufferAttribute(dotPos, 3));
  dotGeo.setAttribute('color', new THREE.BufferAttribute(dotCol, 3));
  const dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, depthTest: false }));
  dots.renderOrder = 100;
  dots.frustumCulled = false;
  dots.layers.set(2);
  scene.add(dots);
  const topCam = new THREE.OrthographicCamera(-60, 60, 40, -40, 1, 400);
  topCam.position.set(-5, 150, -14);
  topCam.up.set(0, 0, -1);
  topCam.lookAt(-5, 0, -14);
  topCam.layers.enable(0);
  topCam.layers.enable(2);

  const frame = { dt: 0, time: 0, hours: 9.2, camera, state: 'waiting', quality, input: { aimYaw: 0, aimPitch: 0 }, lure: simLure.snap, hooked: null, tensionN: 0, tension01: 0 };
  const view = { yaw: -0.5, pitch: -0.62 };
  // start by looking at the school cruising nearest the dock (player's eye, no cheating on position)
  {
    let best = null;
    let bd = 1e9;
    for (const sc of sys.schools) {
      const m = sc.members.filter((f) => !f.removed);
      if (!m.length) continue;
      const cx = m.reduce((a, f) => a + f.pos.x, 0) / m.length;
      const cy = m.reduce((a, f) => a + f.pos.y, 0) / m.length;
      const cz = m.reduce((a, f) => a + f.pos.z, 0) / m.length;
      const d = Math.hypot(cx, cz + 1);
      if (d < bd) {
        bd = d;
        best = [cx, cy, cz];
      }
    }
    if (best && bd < 14) {
      const dx = best[0] - camera.position.x;
      const dy = best[1] - camera.position.y;
      const dz = best[2] - camera.position.z;
      view.yaw = Math.atan2(-dx, -dz);
      view.pitch = Math.atan2(dy, Math.hypot(dx, dz)) + 0.12;
    }
  }
  camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
  const log = (...a) => console.log(...a);
  const api = {
    sys,
    frame,
    results: null,
    done: false,
    setView(yawDeg, pitchDeg) {
      view.yaw = (yawDeg * Math.PI) / 180;
      view.pitch = (pitchDeg * Math.PI) / 180;
    },
    setHours(h) {
      frame.hours = h;
    },
    cast(lureId = 'bobber', x = -2.5, z = -5.5) {
      simLure.cast(lureId, x, z);
    },
    forceBite(id) {
      sys.debugForceBite(id);
    },
    stats: () => sys.stats(),
    // run the simulation forward without rendering (SwiftShader renders only a few fps)
    ff(sec, dt = 1 / 30) {
      for (let t = 0; t < sec; t += dt) simStep(dt);
      return sys.stats();
    },
    near(x = 0, z = -3, r = 10) {
      return sys.population
        .filter((f) => Math.hypot(f.pos.x - x, f.pos.z - z) < r)
        .map((f) => ({ id: f.id, sp: f.speciesId, cm: f.lengthCm, x: +f.pos.x.toFixed(1), y: +f.pos.y.toFixed(2), z: +f.pos.z.toFixed(1), st: f.state, mesh: !!(f.mesh && f.mesh.handle.object3d.visible) }));
    },
    setCam(x, y, z, yawDeg, pitchDeg) {
      camera.position.set(x, y, z);
      view.yaw = (yawDeg * Math.PI) / 180;
      view.pitch = (pitchDeg * Math.PI) / 180;
    },
    // debug camera hovering over one fish (id), `h` meters above it, looking down at `pitchDeg`
    watch(id, h = 1.6, back = 1.2, pitchDeg = -55) {
      watchId = id;
      watchCfg = { h, back, pitch: (pitchDeg * Math.PI) / 180 };
    },
    unwatch() {
      watchId = 0;
      camera.position.set(0, 2.2, 0);
    },
    hideInset(b = true) {
      inset = !b;
    },
  };
  window.__fishai = api;
  for (const ev of ['fish:interest', 'fish:nibble', 'fish:bite', 'fish:missed', 'fish:spooked', 'fish:swirl', 'fish:jump', 'fish:splash']) {
    events.on(ev, (e) => console.log(`[fishai] t=${frame.time.toFixed(1)} ${ev} ${JSON.stringify({ ...e, position: e.position ? [+e.position.x.toFixed(1), +e.position.y.toFixed(2), +e.position.z.toFixed(1)] : undefined })}`));
  }
  window.__game = { debug: { stats: () => ({ ...sys.stats(), draws: renderer.info.render.calls, tris: renderer.info.render.triangles }) } };

  let last = performance.now();
  let castDone = false;
  let inset = true;
  let reel = 0;
  let watchId = 0;
  let watchCfg = null;
  api.reel = (v) => (reel = v);
  api.autoCast = true;
  function simStep(dt) {
    frame.dt = dt;
    frame.time += dt;
    if (api.autoCast && !castDone && frame.time > 1.2) {
      castDone = true;
      api.cast('bobber', -2.6, -5.2);
    }
    simLure.step(dt, reel);
    floatG.visible = simLure.snap.inWater && !!simLure.snap.bobberPosition;
    if (simLure.snap.bobberPosition) floatG.position.set(simLure.snap.position.x, 0.004, simLure.snap.position.z);
    const wf = watchId ? sys.population.find((f) => f.id === watchId) : null;
    if (wf) {
      // chase-cam: behind and above the fish, looking the way it swims
      const yaw = wf.yaw;
      camera.position.set(wf.pos.x - Math.sin(yaw) * watchCfg.back, Math.max(0.35, wf.pos.y + watchCfg.h), wf.pos.z - Math.cos(yaw) * watchCfg.back);
      view.yaw = yaw + Math.PI;
      view.pitch = watchCfg.pitch;
    }
    camera.rotation.set(view.pitch, view.yaw, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    sys.update(frame);
  }
  let paused = false;
  function loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (paused) {
      requestAnimationFrame(loop);
      return;
    }
    simStep(dt);
    // overhead dots
    let n = 0;
    const c = new THREE.Color();
    for (const f of sys.population) {
      if (n >= MAXP) break;
      dotPos[n * 3] = f.pos.x;
      dotPos[n * 3 + 1] = 1;
      dotPos[n * 3 + 2] = f.pos.z;
      c.setHex(SPC[f.speciesId] || 0xffffff);
      dotCol[n * 3] = c.r;
      dotCol[n * 3 + 1] = c.g;
      dotCol[n * 3 + 2] = c.b;
      n++;
    }
    dotGeo.setDrawRange(0, n);
    dotGeo.attributes.position.needsUpdate = true;
    dotGeo.attributes.color.needsUpdate = true;
    const W = renderer.domElement.clientWidth;
    const H = renderer.domElement.clientHeight;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.render(scene, camera);
    if (!inset) {
      requestAnimationFrame(loop);
      return;
    }
    const iw = Math.round(W * 0.3);
    const ih = Math.round(iw * (80 / 120));
    renderer.setScissorTest(true);
    renderer.setScissor(W - iw - 8, H - ih - 8, iw, ih);
    renderer.setViewport(W - iw - 8, H - ih - 8, iw, ih);
    renderer.render(scene, topCam);
    renderer.setScissorTest(false);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Suite only when asked (?suite or #suite, or window.__fishai.runSuite()).
  api.runSuite = async (opts = {}) => {
    paused = true; // SwiftShader rendering would starve the suite
    try {
      const res = await runSuite({ log, slice: () => new Promise((r) => setTimeout(r, 0)), ...opts });
      api.results = res;
      api.done = true;
      return res;
    } finally {
      paused = false;
    }
  };
  if (/suite/.test(location.hash + location.search)) api.runSuite();
  log('[fishai] sandbox ready', JSON.stringify(sys.stats()));
}

// Runs as the page entry; set window.__FISHAI_NO_MAIN before importing to reuse the helpers only.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__FISHAI_NO_MAIN) main();
