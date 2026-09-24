// Fish population AI, lure response and hooked-fish fight physics (fish-behavior module).
// See CONTRACT.md "Fish". Meters, +Y up, water surface at y = 0, player on the dock at the origin
// facing -Z. Fish positions in this module are the MOUTH (hook point); meshes from mesh.js face +Z
// locally and are offset back along the body so the snout sits on that point.
import * as THREE from 'three';
import { WATER_LEVEL, DOCK, TACKLE, LURES, LAYERS, G, clamp, lerp, smoothstep, damp, makeRng } from '../config.js';
import { SPECIES, SPECIES_BY_ID, rollFish, lightLevel, lowLightLevel, weightFromLength } from './species.js';
import * as FishMesh from './mesh.js';

const createFishMesh = FishMesh.createFishMesh;

const TAU = Math.PI * 2;
const LURE_BY_ID = Object.fromEntries(LURES.map((l) => [l.id, l]));

// Population by quality (sums: 48 / 36 / 24). Schools are split from the panfish counts.
const COMPOSITION = {
  high: { bluegill: 12, yellow_perch: 10, largemouth_bass: 6, smallmouth_bass: 4, walleye: 5, northern_pike: 4, rainbow_trout: 3, channel_catfish: 3, muskellunge: 1 },
  medium: { bluegill: 9, yellow_perch: 7, largemouth_bass: 5, smallmouth_bass: 3, walleye: 4, northern_pike: 3, rainbow_trout: 2, channel_catfish: 2, muskellunge: 1 },
  low: { bluegill: 6, yellow_perch: 4, largemouth_bass: 3, smallmouth_bass: 2, walleye: 3, northern_pike: 2, rainbow_trout: 1, channel_catfish: 2, muskellunge: 1 },
};
const MAX_RENDERED = { high: 18, medium: 12, low: 8 };
const RENDER_DIST = 70;
const MESH_CREATES_PER_FRAME = 2;

// Where each species likes to live, from the lake layout in CONTRACT.md: [x, z, radius].
// Placement samples around these and scores every candidate with env.getHabitat + depth.
const ANCHORS = {
  bluegill: [[2.5, -2.5, 4], [-27, 2, 10], [-19, -5, 6], [-2.5, 4, 3]],
  yellow_perch: [[1, -7, 5], [-18, -9, 7], [-10, -19, 6], [-4, -13, 6]],
  largemouth_bass: [[1.8, 4, 4], [-16, -3, 7], [-10, -22, 5], [-5, -10, 7]],
  smallmouth_bass: [[29, -14, 9], [22, -25, 7], [16, -8, 6]],
  walleye: [[28, -24, 8], [37, -20, 7], [16, -28, 9]],
  northern_pike: [[-15, 5, 5], [-16, -7, 6], [-23, -14, 6]],
  muskellunge: [[-15, -2, 10]],
  rainbow_trout: [[0, -42, 16], [16, -48, 14], [-16, -46, 14]],
  channel_catfish: [[-10, -22, 5], [3, -38, 12]],
};
// The musky patrols the outside weed edge of the cove.
const MUSKY_PATROL = [[-13.5, 8], [-14, -2], [-17, -12], [-25, -17], [-36, -16], [-26, -15], [-17, -9], [-14, 1]];

// Lure tuning. detectR: base detection radius in good conditions. optMps / sigma: plausible retrieve
// speed (log-normal window); `sense`: what the fish detects (scent, flash, vibration, surface).
const LURE_TUNING = {
  bobber: { detectR: 4.2, sense: 'scent', optMps: 0, sigma: 1 },
  spinner: { detectR: 8.0, sense: 'flash', optMps: 0.45, sigma: 0.6 },
  crankbait: { detectR: 8.0, sense: 'vibration', optMps: 0.55, sigma: 0.55 },
  topwater: { detectR: 12.5, sense: 'surface', optMps: 0.3, sigma: 0.65 },
};

// ---------- small helpers ----------
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
function wrapAngle(a) {
  a = fin(a);
  if (a >= -Math.PI && a <= Math.PI) return a;
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}
function size01(weightKg) {
  return clamp(Math.log(Math.max(weightKg, 0.01) / 0.08) / Math.log(20 / 0.08), 0.05, 1);
}
function randRange(rng, a, b) {
  return a + (b - a) * rng();
}
function randInt(rng, a, b) {
  return a + Math.floor(rng() * (b - a + 1));
}

// Scratch objects (never allocate in per-frame paths).
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _box = new THREE.Box3();

// =====================================================================================
// HookedFish: one fish on the line. core calls step() at a fixed 120 Hz.
// =====================================================================================
export class HookedFish {
  constructor(sys, rec, opts = {}) {
    this._sys = sys;
    this._rec = rec;
    this.id = rec.id;
    this.species = rec.species;
    this.speciesId = rec.speciesId;
    this.weightKg = rec.weightKg;
    this.lengthCm = rec.lengthCm;
    this.position = new THREE.Vector3().copy(rec.pos);
    this.velocity = new THREE.Vector3(Math.sin(rec.yaw) * 0.4, 0, Math.cos(rec.yaw) * 0.4);
    this.stamina01 = 1;
    this.headShake01 = 0;
    this.isJumping = false;
    this.object3d = null; // set by the system (mesh handle)
    this.landing = false;
    this.landed = false;
    this.mode = 'run';
    this.effort = 0;

    const sp = this.species;
    const m = Math.max(0.02, this.weightKg);
    const L = Math.max(0.08, this.lengthCm / 100);
    this._m = m;
    this._mEff = m * 1.22; // + entrained (added) water mass
    this._L = L;
    this._bodyH = L * (sp.bodyDepth || 0.25);
    // Burst swim force: g * m * (0.9 .. 2.2) by species strength (CONTRACT.md).
    this._Fburst = G * m * (0.9 + 1.3 * sp.strength);
    // Top swim speed (m/s) from body length, a bit more for strong species: ~1.3 (bluegill) .. ~4 (musky).
    this._vTop = (0.5 + 2.9 * Math.pow(L, 0.7)) * (0.85 + 0.3 * sp.strength);
    // Quadratic hydrodynamic drag: 0.5 * rho * Cd * A with A = body cross-section.
    const A = 0.785 * this._bodyH * this._bodyH * (sp.bodyWidth || 0.5);
    this._cDrag = 0.5 * 1000 * 0.2 * A + 0.04 * m; // streamlined body + fins, hook and a little line
    // Stamina capacity in "full-effort seconds": bigger individuals of a species last longer.
    const rel = m / sp.weightKg.typical;
    this._cap = (4 + 10 * sp.stamina) * Math.pow(rel, 0.25);
    this._peak = 0;
    this._rng = sys._rng;
    this._t = 0;
    this._modeT = 0;
    this._modeDur = 0;
    this._swim = new THREE.Vector3(0, 0, -1);
    this._yTarget = this.position.y;
    this._shakeT = 0;
    this._shakeEnv = 0;
    this._shakePhase = 0;
    this._nextShake = 0.5 + this._rng() * 2;
    this._splashT = 0;
    this._jumpH = 0;
    this._jumps = 0;
    this._surged = false;
    this._probeT = 0;
    this._lastValid = new THREE.Vector3().copy(this.position);
    this._fwd = new THREE.Vector3(Math.sin(rec.yaw), 0, Math.cos(rec.yaw));
    this._yaw = rec.yaw;
    this._pitch = 0;
    this._roll = 0;
    this._rollPhase = 0;
    this._landFrom = new THREE.Vector3();
    this._landTo = new THREE.Vector3();
    this._landT = 0;
    this._landDur = 1;
    this._rodTip = new THREE.Vector3(0, 2.6, -1.6);
    this._tension = 0;
    this._lineOut = 20;
    this._pull = new THREE.Vector3(0, 0, 1);
    this._spent = false;
    this._pull.subVectors(this._rodTip, this.position);
    if (this._pull.lengthSq() > 1e-8) this._pull.normalize();
    else this._pull.set(0, 0, 1);

    // First reaction to the hookset: bolt, jump, dive or thrash depending on species.
    this._startMode(this._firstMode(opts));
  }

  get exhaustion01() {
    return 1 - this.stamina01;
  }

  _firstMode() {
    const sp = this.species;
    const r = this._rng();
    const depth = -this.position.y;
    if (sp.jumpiness > 0.5 && depth < 3 && r < 0.35 * sp.jumpiness) return 'jumpPrep';
    if (sp.fight.thrash > 0.5 && depth < 2.5 && r < 0.4) return 'thrash';
    if (sp.fight.dive > 0.8 && r < 0.6) return 'dive';
    return 'run';
  }

  _chooseMode() {
    const sp = this.species;
    const st = this.stamina01;
    if (st < 0.07) return 'spent';
    const depth = -this.position.y;
    const wasActive = this.mode !== 'rest' && this.mode !== 'spent';
    const f = sp.fight;
    const w = {
      run: (0.35 + f.run) * (0.3 + st),
      dive: f.dive * (0.3 + st) * 0.8,
      thrash: f.thrash * (depth < 2.5 ? 1 : 0.25) * (0.2 + st) * 0.7,
      jumpPrep: st > 0.22 && this._jumps < 5 ? Math.pow(sp.jumpiness, 1.5) * (depth < 3 ? 1.0 : 0.35) * (0.3 + st) : 0,
      circle: f.circle * 0.6,
      rest: (wasActive ? 1.6 : 0.4) * (1.3 - st),
    };
    // Near the dock with some fight left: the classic last surge.
    if (!this._surged && this._lineOut < 7 && st > 0.18 && this._rng() < 0.55) {
      this._surged = true;
      return 'run';
    }
    let sum = 0;
    for (const k in w) sum += w[k];
    let r = this._rng() * sum;
    for (const k in w) {
      r -= w[k];
      if (r <= 0) return k;
    }
    return 'rest';
  }

  _startMode(mode) {
    const sp = this.species;
    const rng = this._rng;
    const st = this.stamina01;
    const vigor = 0.2 + 0.8 * Math.pow(Math.max(st, 0), 0.6);
    this.mode = mode;
    this._modeT = 0;
    const sys = this._sys;
    const bottomY = sys._terrainY(this.position.x, this.position.z);
    const depth = Math.max(0.3, -bottomY);
    switch (mode) {
      case 'run': {
        this._modeDur = randRange(rng, 1.5, 2.2 + 3.8 * sp.stamina * st) * (0.6 + 0.4 * st);
        this._peak = randRange(rng, 0.7, 1.0) * vigor;
        this.effort = this._peak;
        this._pickRunDir();
        this._yTarget = -depth * clamp(sp.column + randRange(rng, -0.2, 0.1), 0.25, 0.85);
        break;
      }
      case 'dive': {
        this._modeDur = randRange(rng, 2, 5.5) * (0.6 + 0.4 * st);
        this._peak = randRange(rng, 0.55, 0.85) * vigor;
        this.effort = this._peak;
        this._pickRunDir(true);
        this._yTarget = bottomY + 0.2 + this._bodyH;
        break;
      }
      case 'thrash': {
        this._modeDur = randRange(rng, 1.0, 2.4);
        this.effort = 0.55 * vigor;
        this._yTarget = -0.08;
        this._swim.set(-this._pull.x, 0, -this._pull.z);
        if (this._swim.lengthSq() < 1e-6) this._swim.set(0, 0, -1);
        this._swim.normalize();
        break;
      }
      case 'jumpPrep': {
        this._modeDur = 2.2;
        this.effort = 1.0 * vigor;
        // Apex of the body 0.3 .. 1.2 m above the water: bigger jumpers go higher, tired fish lower.
        this._jumpH = clamp(randRange(rng, 0.3, 0.55) + 0.55 * sp.jumpiness * st * rng() + 0.25 * Math.min(1, this._L / 0.6) * rng(), 0.3, 1.2);
        this._pickRunDir();
        this._yTarget = 0.4;
        break;
      }
      case 'circle': {
        this._modeDur = randRange(rng, 1.5, 4);
        this.effort = randRange(rng, 0.35, 0.65) * vigor;
        const s = rng() < 0.5 ? 1 : -1;
        this._swim.set(-this._pull.z * s, 0, this._pull.x * s);
        if (this._swim.lengthSq() < 1e-6) this._swim.set(1, 0, 0);
        this._swim.normalize();
        this._yTarget = this.position.y;
        break;
      }
      case 'spent': {
        this._modeDur = randRange(rng, 3, 7);
        this.effort = 0.05;
        this._yTarget = this.position.y;
        break;
      }
      default: {
        // rest: hold against the line, shake the head now and then
        this.mode = 'rest';
        this._modeDur = randRange(rng, 1.2, 2.8) * (1.6 - 0.6 * st);
        // a resting fish only fins against the line: ~3-10% of its weight, whatever its size
        this.effort = (randRange(rng, 0.03, 0.1) * G * this._m * vigor) / this._Fburst;
        this._swim.set(-this._pull.x, 0, -this._pull.z);
        if (this._swim.lengthSq() < 1e-6) this._swim.set(0, 0, -1);
        this._swim.normalize();
        this._yTarget = this.position.y;
      }
    }
  }

  // Direction for a run: away from the angler toward open/deep water or cover (species dependent).
  _pickRunDir(preferDeep = false) {
    const sys = this._sys;
    const sp = this.species;
    const p = this.position;
    let awayX = p.x - this._rodTip.x;
    let awayZ = p.z - this._rodTip.z;
    const al = Math.hypot(awayX, awayZ) || 1;
    awayX /= al;
    awayZ /= al;
    const base = Math.atan2(awayX, awayZ);
    let bestS = -1e9;
    let bestA = base;
    const deepW = preferDeep ? 1.2 : sp.fight.dive * 0.6 + (sp.id === 'rainbow_trout' ? 0.5 : 0);
    const coverW = sp.fight.cover;
    for (let i = 0; i < 10; i++) {
      const a = base + (i / 10) * TAU + (this._rng() - 0.5) * 0.4;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      const d6 = sys._depthAt(p.x + dx * 6, p.z + dz * 6);
      const d12 = sys._depthAt(p.x + dx * 12, p.z + dz * 12);
      if (d6 < 0.5) continue;
      const away = dx * awayX + dz * awayZ; // -1 .. 1
      let s = away * 1.1 + deepW * clamp((d12 - p.y * -1) / 4, -1, 1);
      if (coverW > 0.2) {
        const h = sys._habitat(p.x + dx * 8, p.z + dz * 8);
        s += coverW * (sp.habitat.weeds * h.weeds + sp.habitat.wood * h.wood + sp.habitat.rocks * h.rocks);
      }
      if (d12 < 0.6) s -= 1.5;
      s += this._rng() * 0.8;
      if (s > bestS) {
        bestS = s;
        bestA = a;
      }
    }
    this._swim.set(Math.sin(bestA), 0, Math.cos(bestA));
  }

  // Keep the swim direction pointing at water deep enough (re-probe a few times per second).
  _avoidShallow() {
    const sys = this._sys;
    const p = this.position;
    const hx = this._swim.x;
    const hz = this._swim.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-4) return;
    const probe = 2.5 + this.velocity.length() * 0.8;
    const d = sys._depthAt(p.x + (hx / hl) * probe, p.z + (hz / hl) * probe);
    if (d > 0.55 + this._bodyH) return;
    // Turn toward the deepest of a fan of directions, preferring small turns.
    let best = -1;
    let bestA = 0;
    const a0 = Math.atan2(hx, hz);
    for (let i = 1; i <= 8; i++) {
      const a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.55;
      const dd = sys._depthAt(p.x + Math.sin(a) * probe, p.z + Math.cos(a) * probe) - Math.ceil(i / 2) * 0.05;
      if (dd > best) {
        best = dd;
        bestA = a;
      }
    }
    this._swim.x = Math.sin(bestA);
    this._swim.z = Math.cos(bestA);
  }

  // One fixed physics substep. input = { tensionN, pullDir, rodTip, lineOutM }
  step(dt, input = {}) {
    if (!(dt > 0) || this.landed) return;
    dt = Math.min(dt, 0.05);
    if (this.landing) return; // the landing slide is animated from the system's update(frame)
    const sys = this._sys;
    const sp = this.species;
    const rng = this._rng;
    const p = this.position;
    const v = this.velocity;
    this._t += dt;
    this._modeT += dt;

    // --- inputs (sanitized) ---
    const T = Math.max(0, fin(input.tensionN, 0));
    this._tension = T;
    if (input.rodTip && Number.isFinite(input.rodTip.x)) this._rodTip.copy(input.rodTip);
    this._lineOut = fin(input.lineOutM, this._lineOut);
    const pd = input.pullDir;
    if (pd && Number.isFinite(pd.x) && Number.isFinite(pd.y) && Number.isFinite(pd.z) && pd.x * pd.x + pd.y * pd.y + pd.z * pd.z > 1e-8) {
      this._pull.copy(pd).normalize();
    } else {
      this._pull.subVectors(this._rodTip, p);
      if (this._pull.lengthSq() > 1e-8) this._pull.normalize();
      else this._pull.set(0, 0, 1);
    }
    const pull = this._pull;

    const surfY = sys._surfaceY(p.x, p.z);
    const bottomY = sys._terrainY(p.x, p.z);

    // --- behavior ---
    if (!this.isJumping) {
      if (this._modeT >= this._modeDur) this._startMode(this._chooseMode());
      if (this.mode === 'spent' && this.stamina01 > 0.16 && rng() < dt * 0.3) this._startMode('run');
      if (this.mode === 'run' || this.mode === 'dive') {
        // the first surge is the strongest; then the fish settles into a steady pull
        const tau = 1.0 + 1.6 * sp.stamina;
        this.effort = this._peak * (0.3 + 0.7 * Math.exp(-this._modeT / tau));
      }
      this._probeT -= dt;
      if (this._probeT <= 0 && (this.mode === 'run' || this.mode === 'dive' || this.mode === 'jumpPrep' || this.mode === 'circle')) {
        this._probeT = 0.2;
        this._avoidShallow();
      }
      if (this.mode === 'rest' || this.mode === 'spent') {
        // hold against the line: face away from the pull
        this._swim.x = damp(this._swim.x, -pull.x, 2, dt);
        this._swim.z = damp(this._swim.z, -pull.z, 2, dt);
      }
      if (this.mode === 'circle') {
        // keep swimming across the line (bluegill "circle" and use their flat side)
        const s = this._swim.x * pull.z - this._swim.z * pull.x >= 0 ? 1 : -1;
        this._swim.x = damp(this._swim.x, pull.z * s, 1.5, dt);
        this._swim.z = damp(this._swim.z, -pull.x * s, 1.5, dt);
      }
    }

    // --- head shakes (0..1 envelope) ---
    this._nextShake -= dt;
    if (this._nextShake <= 0 && !this.isJumping) {
      this._shakeT = randRange(rng, 0.35, 1.1);
      this._nextShake = randRange(rng, 1.5, 6) / (0.25 + sp.headshake);
    }
    let shakeTarget = 0;
    if (this._shakeT > 0) {
      this._shakeT -= dt;
      shakeTarget = sp.headshake * (0.5 + 0.5 * this.stamina01);
    }
    if (this.mode === 'thrash') shakeTarget = Math.max(shakeTarget, 0.75 + 0.25 * sp.headshake);
    if (this.isJumping) shakeTarget = 1;
    if (this.mode === 'spent') shakeTarget *= 0.2;
    this._shakeEnv = damp(this._shakeEnv, shakeTarget, 10, dt);
    this.headShake01 = clamp(this._shakeEnv, 0, 1);
    this._shakePhase += dt * TAU * (4.5 + 2.5 * (1 - size01(this.weightKg)));

    const m = this._m;
    if (this.isJumping) {
      // --- ballistic flight, the line still pulls ---
      v.y -= G * dt;
      v.addScaledVector(pull, (T / m) * dt);
      v.multiplyScalar(1 - 0.08 * dt);
      p.addScaledVector(v, dt);
      if (p.y <= surfY && v.y < 0) {
        this.isJumping = false;
        p.y = surfY - 0.05;
        v.multiplyScalar(0.3);
        v.y = Math.max(v.y, -1.2);
        sys._emitAt('fish:jump', p, size01(this.weightKg), surfY);
        this._startMode(rng() < 0.5 ? 'run' : 'rest');
      }
    } else {
      // --- swim force (thrust falls off toward top speed) ---
      const vig = this.effort;
      // vertical intent: blend in the depth target
      let yT = this._yTarget;
      yT = clamp(yT, bottomY + 0.12 + this._bodyH * 0.5, surfY - 0.04);
      if (this.mode === 'jumpPrep') yT = surfY + 0.5;
      const vyWant = clamp((yT - p.y) * 1.2, -1, 1);
      _v1.set(this._swim.x, 0, this._swim.z);
      if (_v1.lengthSq() < 1e-8) _v1.set(-pull.x, 0, -pull.z);
      if (_v1.lengthSq() < 1e-8) _v1.set(0, 0, -1);
      _v1.normalize();
      const horizW = this.mode === 'jumpPrep' ? 0.35 : 1;
      _v1.multiplyScalar(horizW);
      _v1.y = this.mode === 'jumpPrep' ? 1 : vyWant;
      _v1.normalize();
      const vAlong = v.dot(_v1);
      const thrust = vig * this._Fburst * Math.max(0.12, 1 - Math.max(0, vAlong) / this._vTop);
      // acceleration
      _v2.copy(_v1).multiplyScalar(thrust);
      // head shakes: lateral + along-line jerks (the rod tip bounces, tension spikes)
      if (this.headShake01 > 0.02) {
        const sh = Math.sin(this._shakePhase);
        const amp = this.headShake01 * this._Fburst * 0.3;
        _v3.set(-pull.z, 0, pull.x);
        if (_v3.lengthSq() < 1e-8) _v3.set(1, 0, 0);
        _v3.normalize();
        _v2.addScaledVector(_v3, sh * amp);
        _v2.addScaledVector(pull, -Math.abs(sh) * amp * 0.6);
      }
      // line tension
      _v2.addScaledVector(pull, T);
      // quadratic water drag
      const sp2 = v.length();
      _v2.addScaledVector(v, -this._cDrag * sp2);
      v.addScaledVector(_v2, dt / this._mEff);
      const vmax = this._vTop * 1.6;
      const vl = v.length();
      if (vl > vmax) v.multiplyScalar(vmax / vl);
      p.addScaledVector(v, dt);

      // --- constraints: surface, bottom, shore ---
      const top = surfY - 0.04;
      if (p.y > top) {
        if (this.mode === 'jumpPrep' && v.y > 0.8) {
          // launch: enough vertical speed for the planned apex (mouth apex ~ jumpH + half a body)
          const want = Math.sqrt(2 * G * (this._jumpH + this._L * 0.35));
          v.y = Math.max(v.y, want);
          const hs = Math.hypot(v.x, v.z);
          const hmax = 2.2;
          if (hs > hmax) {
            v.x *= hmax / hs;
            v.z *= hmax / hs;
          }
          this.isJumping = true;
          this._jumps++;
          this.mode = 'air';
          p.y = surfY + 0.01;
          sys._emitAt('fish:jump', p, size01(this.weightKg), surfY);
        } else {
          p.y = top;
          if (v.y > 0) v.y = 0;
        }
      }
      if (!this.isJumping) {
        const by = sys._terrainY(p.x, p.z);
        const minY = by + 0.08 + this._bodyH * 0.5;
        if (p.y < minY) {
          p.y = minY;
          if (v.y < 0) v.y = 0;
        }
        const depthHere = WATER_LEVEL - by;
        const minDepth = Math.max(0.25, this._bodyH * 0.9 + 0.08);
        if (depthHere < minDepth) {
          // never onto land: step back and bounce off the shallows
          p.x = this._lastValid.x;
          p.z = this._lastValid.z;
          v.x *= -0.25;
          v.z *= -0.25;
          this._avoidShallow();
          if (p.y < by + 0.05) p.y = Math.min(this._lastValid.y, top);
        }
      }
      if (this.mode === 'jumpPrep' && this._modeT > this._modeDur) this._startMode('run');
    }

    // --- surface thrashing / splashes ---
    if (!this.isJumping && p.y > surfY - 0.35) {
      this._splashT -= dt;
      const thrashing = this.mode === 'thrash' || (this.headShake01 > 0.55 && this.effort > 0.3);
      if (thrashing && this._splashT <= 0) {
        this._splashT = randRange(rng, 0.3, 0.7);
        sys._emitAt('fish:splash', p, size01(this.weightKg) * (0.55 + 0.45 * this.headShake01), surfY);
      }
    }

    // --- stamina ---
    const mg = m * G;
    const tRel = T / mg;
    // side pressure: pulling across the fish's swim direction tires it faster
    const sx = this._swim.x;
    const sz = this._swim.z;
    const sl = Math.hypot(sx, sz) || 1;
    const pl = Math.hypot(pull.x, pull.z) || 1;
    const lateral = 1 - Math.abs((sx * pull.x + sz * pull.z) / (sl * pl));
    const effortCost = Math.pow(this.effort, 1.6);
    const tensionCost = 0.12 * Math.min(tRel, 4) * (1 + 0.8 * lateral) * (0.4 + this.effort);
    let dS = -(effortCost + tensionCost) / this._cap;
    // only an unpressured fish (slack line) gets its wind back
    const slackN = Math.max(1.5, 0.05 * mg);
    if (this.effort < 0.3 && T < slackN && !this.isJumping) dS += (0.006 + 0.01 * sp.stamina) * (1 - T / slackN);
    this.stamina01 = clamp(this.stamina01 + dS * dt, 0, 1);
    if (this.stamina01 < 0.07 && this.mode !== 'spent' && !this.isJumping) this._startMode('spent');

    // --- NaN guard ---
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z) || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      p.copy(this._lastValid);
      v.set(0, 0, 0);
    } else if (!this.isJumping) {
      this._lastValid.copy(p);
    }

    this._orient(dt);
    sys._placeHookedMesh(this);
  }

  // Heading: where it swims when it is winning, head toward the angler when the line wins.
  _orient(dt) {
    const p = this.position;
    const v = this.velocity;
    const pull = this._pull;
    let fx;
    let fy;
    let fz;
    if (this.isJumping || this.landing) {
      const vl = v.length();
      if (vl > 0.05) {
        fx = v.x / vl;
        fy = v.y / vl;
        fz = v.z / vl;
      } else {
        fx = this._fwd.x;
        fy = this._fwd.y;
        fz = this._fwd.z;
      }
      if (this.landing) {
        fx = -pull.x;
        fy = 0.25;
        fz = -pull.z;
      }
    } else {
      const swimF = this.effort * this._Fburst;
      const w = clamp(swimF / (swimF + this._tension + 1e-3), 0, 1);
      fx = lerp(pull.x, this._swim.x, w);
      fz = lerp(pull.z, this._swim.z, w);
      fy = lerp(clamp(pull.y, -0.5, 0.6), clamp(v.y * 0.5, -0.5, 0.5), w);
      const l = Math.hypot(fx, fy, fz);
      if (l < 1e-4) {
        fx = this._fwd.x;
        fy = this._fwd.y;
        fz = this._fwd.z;
      } else {
        fx /= l;
        fy /= l;
        fz /= l;
      }
    }
    const yawT = Math.atan2(fx, fz);
    const pitchT = Math.asin(clamp(fy, -0.95, 0.95));
    const rate = this.isJumping ? 14 : 6;
    this._yaw += wrapAngle(yawT - this._yaw) * (1 - Math.exp(-rate * dt));
    this._yaw = wrapAngle(this._yaw);
    this._pitch = damp(this._pitch, clamp(pitchT, -0.8, this.isJumping ? 1.2 : 0.7), rate, dt);
    // tired fish roll onto their side; head shakes wiggle
    this._rollPhase += dt * 9;
    // (the mesh rolls an exhausted fish onto its side from exhaustion01; this is just the head-shake wiggle)
    const rollT = this.headShake01 * 0.3 * Math.sin(this._rollPhase);
    this._roll = damp(this._roll, rollT, 4, dt);
    this._fwd.set(Math.sin(this._yaw) * Math.cos(this._pitch), Math.sin(this._pitch), Math.cos(this._yaw) * Math.cos(this._pitch));
    if (!Number.isFinite(this._yaw)) this._yaw = 0;
    if (!Number.isFinite(this._pitch)) this._pitch = 0;
    void p;
  }

  // core calls this when netting starts: slide the tired fish to the surface beside the dock.
  toLanding(targetPos, durationS = 1.5) {
    this.landing = true;
    this.isJumping = false;
    this.mode = 'landing';
    this.effort = 0;
    this.stamina01 = Math.min(this.stamina01, 0.05);
    this._landFrom.copy(this.position);
    if (targetPos && Number.isFinite(targetPos.x) && Number.isFinite(targetPos.y) && Number.isFinite(targetPos.z)) this._landTo.copy(targetPos);
    else this._landTo.set(0.9, -0.05, -1.3);
    // keep the target in the water, just under the surface
    const surf = this._sys._surfaceY(this._landTo.x, this._landTo.z);
    this._landTo.y = Math.min(this._landTo.y, surf - 0.03);
    this._landT = 0;
    this._landDur = Math.max(0.2, fin(durationS, 1.5));
  }

  _updateLanding(dt) {
    if (!this.landing || this.landed) return;
    this._landT += dt;
    const t = clamp(this._landT / this._landDur, 0, 1);
    const e = t * t * (3 - 2 * t);
    const p = this.position;
    const px = p.x;
    const py = p.y;
    const pz = p.z;
    p.lerpVectors(this._landFrom, this._landTo, e);
    // a weak kick or two on the way
    const wob = Math.sin(this._landT * 7) * 0.05 * (1 - t);
    p.x += -this._pull.z * wob;
    p.z += this._pull.x * wob;
    if (dt > 0) this.velocity.set((p.x - px) / dt, (p.y - py) / dt, (p.z - pz) / dt);
    this.headShake01 = damp(this.headShake01, 0.05, 5, dt);
    this._pull.subVectors(this._landTo, this._landFrom).setY(0);
    if (this._pull.lengthSq() > 1e-6) this._pull.normalize().negate();
    else this._pull.set(0, 0, 1);
    this._orient(dt);
    this._sys._placeHookedMesh(this);
    if (t >= 1) this.landedAtTarget = true;
  }
}

// =====================================================================================
// createFishSystem
// =====================================================================================
export function createFishSystem(ctx = {}) {
  const scene = ctx.scene || null;
  const events = ctx.events || { emit() {}, on() {} };
  const env = ctx.env;
  const water = ctx.water || null;
  const camera0 = ctx.camera || null;
  let quality = ctx.quality || 'high';
  const renderFish = ctx.renderFish !== false && !!scene;
  const meshFactory = typeof ctx.createFishMesh === 'function' ? ctx.createFishMesh : createFishMesh;
  const rng = makeRng(fin(ctx.seed, (Math.random() * 4294967295) >>> 0));
  let time = 0;
  let hours = fin(ctx.hours, 7);
  let light = lightLevel(hours);
  let lowLight = lowLightLevel(hours);
  let clarity = 1;

  // ---------- environment queries (guarded) ----------
  function terrainY(x, z) {
    const h = env && env.getTerrainHeight ? env.getTerrainHeight(x, z) : -3;
    return Number.isFinite(h) ? h : 0.5;
  }
  function depthAt(x, z) {
    return Math.max(0, WATER_LEVEL - terrainY(x, z));
  }
  function surfaceY(x, z) {
    if (water && water.getHeight) {
      const y = water.getHeight(x, z);
      if (Number.isFinite(y)) return clamp(y, WATER_LEVEL - 0.5, WATER_LEVEL + 0.5);
    }
    return WATER_LEVEL;
  }
  const _hab = { depth: 0, weeds: 0, rocks: 0, wood: 0 };
  function habitat(x, z) {
    const h = env && env.getHabitat ? env.getHabitat(x, z) : null;
    _hab.depth = h ? fin(h.depth, depthAt(x, z)) : depthAt(x, z);
    _hab.weeds = h ? clamp(fin(h.weeds), 0, 1) : 0;
    _hab.rocks = h ? clamp(fin(h.rocks), 0, 1) : 0;
    _hab.wood = h ? clamp(fin(h.wood), 0, 1) : 0;
    // The dock itself is cover (shade + pilings) for panfish and bass.
    const ddx = Math.max(0, Math.abs(x) - DOCK.width * 0.5);
    const ddz = Math.max(0, DOCK.endZ - z, z - 16);
    const dd = Math.hypot(ddx, ddz);
    _hab.wood = Math.max(_hab.wood, 0.75 * (1 - smoothstep(0.5, 5, dd)));
    return _hab;
  }

  // ---------- camera helpers ----------
  const camPos = new THREE.Vector3(0, 2.2, 0);
  const camFwd = new THREE.Vector3(0, 0, -1);
  function readCamera(cam) {
    if (!cam) return;
    const e = cam.matrixWorld.elements;
    camPos.set(e[12], e[13], e[14]);
    camFwd.set(-e[8], -e[9], -e[10]);
    if (camFwd.lengthSq() < 1e-8) camFwd.set(0, 0, -1);
    camFwd.normalize();
  }
  // Could the player see a fish here? (close, shallow enough and in front of the camera)
  function inView(x, y, z) {
    const dx = x - camPos.x;
    const dz = z - camPos.z;
    const d = Math.hypot(dx, dz);
    if (d > 45) return false;
    if (-y > 2.6 && d > 6) return false;
    if (light < 0.3 && -y > 0.6 && d > 4) return false; // dark water hides everything below the film
    const dot = (dx * camFwd.x + dz * camFwd.z) / (d || 1);
    return dot > 0.25 || d < 6;
  }

  // ---------- habitat scoring & placement ----------
  function habitatScore(sp, x, z) {
    const d = depthAt(x, z);
    if (d < Math.max(0.4, sp.depthM[0] * 0.75)) return 0;
    const h = habitat(x, z);
    const cover = sp.habitat.weeds * h.weeds + sp.habitat.rocks * h.rocks + sp.habitat.wood * h.wood;
    const openness = 1 - Math.max(h.weeds, h.rocks, h.wood);
    let s = 0.04 + cover + sp.habitat.open * openness * smoothstep(1.2, 5, d);
    if (sp.id === 'northern_pike' || sp.id === 'muskellunge' || sp.id === 'largemouth_bass') {
      // weed edges: some weeds, not a solid mat, and enough water
      s += 2.4 * h.weeds * (1 - h.weeds) * smoothstep(1.0, 2.2, d);
    }
    if (sp.id === 'rainbow_trout') s *= smoothstep(3.5, 7, d); // cool water lives deep
    if (sp.id === 'walleye' || sp.id === 'smallmouth_bass') s *= 0.35 + smoothstep(1.8, 4, d); // drop-off, not the flat
    const [dMin, dMax] = sp.depthM;
    if (d > dMax) s *= Math.exp(-(d - dMax) / 3);
    if (d < dMin) s *= 0.4;
    return s;
  }
  function reachWeight(x, z) {
    const d = Math.hypot(x, z + 1);
    return d < 38 ? 1 : Math.exp(-(d - 38) / 18);
  }
  // Pick a spot for a species. near: {x, z, rMin, rMax} or null. hidden: avoid places the player can see.
  function pickSpot(sp, near, hidden, out, anchorIndex = -1) {
    let bestS = 0;
    let found = false;
    const anchors = ANCHORS[sp.id];
    for (let i = 0; i < 24; i++) {
      let x;
      let z;
      if (near) {
        const a = rng() * TAU;
        const r = lerp(near.rMin, near.rMax, Math.sqrt(rng()));
        x = near.x + Math.sin(a) * r;
        z = near.z + Math.cos(a) * r;
      } else if (anchors && (anchorIndex >= 0 ? i < 20 : rng() < 0.7)) {
        const an = anchors[anchorIndex >= 0 ? anchorIndex % anchors.length : Math.floor(rng() * anchors.length)];
        const a = rng() * TAU;
        const r = an[2] * Math.sqrt(rng());
        x = an[0] + Math.sin(a) * r;
        z = an[1] + Math.cos(a) * r;
      } else {
        x = -70 + rng() * 140;
        z = -85 + rng() * 98;
      }
      let s = habitatScore(sp, x, z) * (near ? 1 : reachWeight(x, z)) * (0.55 + 0.9 * rng());
      if (s <= 0) continue;
      if (hidden) {
        const y = -Math.min(depthAt(x, z) * 0.7, 3);
        if (inView(x, y, z)) s *= 0.02;
      }
      if (s > bestS) {
        bestS = s;
        out.x = x;
        out.z = z;
        found = true;
      }
    }
    return found;
  }

  // ---------- population ----------
  const population = [];
  const schools = [];
  let nextId = 1;
  let biteCounter = 0;
  const spot = { x: 0, z: 0 };

  function preferredY(f, bottomY) {
    const sp = f.species;
    const depth = Math.max(0.2, WATER_LEVEL - bottomY);
    const col = clamp(sp.column + f.columnJit + 0.06 * Math.sin(f.bobPhase), 0.05, 0.98);
    let y = -depth * col;
    y = Math.max(y, -sp.depthM[1]);
    const top = -(Math.min(sp.depthM[0] * 0.45, 0.8) + f.bodyH * 0.5 + 0.1);
    const bot = bottomY + 0.1 + f.bodyH * 0.6;
    y = Math.min(y, top);
    y = Math.max(y, bot);
    return Math.min(y, -0.08);
  }

  function makeFish(speciesId, x, z, school) {
    const roll = rollFish(speciesId, rng);
    const sp = roll.species;
    const L = roll.lengthCm / 100;
    const f = {
      id: nextId++,
      speciesId: sp.id,
      species: sp,
      weightKg: roll.weightKg,
      lengthCm: roll.lengthCm,
      lengthM: L,
      bodyH: L * (sp.bodyDepth || 0.25),
      pos: new THREE.Vector3(x, -1, z),
      position: null,
      yaw: rng() * TAU,
      pitch: 0,
      roll: 0,
      speed: sp.cruiseMps * 0.5,
      targetSpeed: sp.cruiseMps,
      vy: 0,
      turnRate: 0,
      yawVel: 0,
      homeX: x,
      homeZ: z,
      homeR: speciesHomeR(sp),
      homeT: randRange(rng, 20, 80),
      patrol: sp.id === 'muskellunge' ? Math.floor(rng() * MUSKY_PATROL.length) : -1,
      school,
      state: 'cruise',
      stateT: 0,
      stateDur: 0,
      wander: rng() * TAU,
      wanderVel: 0,
      columnJit: (rng() - 0.5) * 0.2,
      bobPhase: rng() * TAU,
      hunger: randRange(rng, 0.65, 1.25),
      cooldown: randRange(rng, 0, 3),
      wary: 0,
      senseT: rng() * 0.1,
      bottomY: terrainY(x, z),
      avoidX: 0,
      avoidZ: 0,
      avoidT: 0,
      sepX: 0,
      sepZ: 0,
      threatX: 0,
      threatZ: 0,
      fleeSpeed: 0,
      follows: 0,
      gap: 0.5,
      nibblesLeft: 0,
      nextNibble: 0,
      biteId: 0,
      biteT: 0,
      windowS: 0,
      finalDecided: false,
      forced: false,
      mesh: null,
      ownMesh: null,
      exhaustion: 0,
      removed: false,
      hooked: null,
      removeT: 0,
      curious: 0,
      slot: (nextId % 5) - 2, // -2..2: lateral slot when several fish crowd one lure
      _score: Infinity,
      _want: false,
    };
    f.position = f.pos;
    f.pos.y = preferredY(f, f.bottomY);
    return f;
  }
  function speciesHomeR(sp) {
    switch (sp.id) {
      case 'bluegill':
        return 6;
      case 'yellow_perch':
        return 8;
      case 'rainbow_trout':
        return 18;
      case 'northern_pike':
        return 5;
      case 'muskellunge':
        return 6;
      case 'walleye':
        return 9;
      case 'channel_catfish':
        return 8;
      default:
        return 7;
    }
  }

  function addSpecies(id, count) {
    const sp = SPECIES_BY_ID[id];
    if (!sp || count <= 0) return;
    if (sp.school) {
      const maxS = sp.school[1];
      const nSchools = Math.max(1, Math.ceil(count / maxS));
      let left = count;
      for (let s = 0; s < nSchools; s++) {
        const n = Math.round(left / (nSchools - s));
        left -= n;
        if (!pickSpot(sp, null, false, spot, s)) {
          spot.x = -6;
          spot.z = -8;
        }
        const school = { id: schools.length + 1, speciesId: id, members: [], homeX: spot.x, homeZ: spot.z, homeR: speciesHomeR(sp), homeT: randRange(rng, 15, 40), cx: spot.x, cy: -1, cz: spot.z, ax: 0, az: 0, n: 0, excited: 0 };
        schools.push(school);
        const baseYaw = rng() * TAU;
        for (let i = 0; i < n; i++) {
          const a = rng() * TAU;
          const r = Math.sqrt(rng()) * 1.6;
          const f = makeFish(id, spot.x + Math.sin(a) * r, spot.z + Math.cos(a) * r, school);
          f.yaw = baseYaw + (rng() - 0.5) * 0.6;
          f.homeX = spot.x;
          f.homeZ = spot.z;
          school.members.push(f);
          population.push(f);
        }
      }
    } else {
      for (let i = 0; i < count; i++) {
        if (id === 'muskellunge') {
          const w = MUSKY_PATROL[Math.floor(rng() * MUSKY_PATROL.length)];
          spot.x = w[0];
          spot.z = w[1];
        } else if (!pickSpot(sp, null, false, spot, i)) {
          spot.x = (rng() - 0.5) * 30;
          spot.z = -10 - rng() * 30;
        }
        population.push(makeFish(id, spot.x, spot.z, null));
      }
    }
  }

  const comp = COMPOSITION[quality] || COMPOSITION.high;
  for (const id of Object.keys(comp)) addSpecies(id, comp[id]);
  // Make sure fish never start on land (e.g. terrain differs from the contract layout).
  for (const f of population) {
    if (depthAt(f.pos.x, f.pos.z) < Math.max(0.4, f.bodyH + 0.3)) {
      if (pickSpot(f.species, null, false, spot)) {
        f.pos.x = spot.x;
        f.pos.z = spot.z;
        f.homeX = spot.x;
        f.homeZ = spot.z;
      }
    }
    f.bottomY = terrainY(f.pos.x, f.pos.z);
    f.pos.y = preferredY(f, f.bottomY);
  }

  // ---------- lure tracking ----------
  const lureCtx = {
    active: false,
    id: 'bobber',
    def: LURE_BY_ID.bobber,
    tune: LURE_TUNING.bobber,
    isBait: true,
    pos: new THREE.Vector3(),
    dirX: 0,
    dirZ: 1,
    speed: 0,
    moving: false,
    movedFor: 0,
    lastMoveDur: 0,
    pausedS: 0,
    pauseTrigger: false,
    alive: 0,
    speedFactor: 1,
    sfEMA: 0.7,
    detectR: 4,
    distanceM: 20,
    lastTwitch: -99,
    inWaterFor: 0,
    prevX: 0,
    prevZ: 0,
    hasPrev: false,
    timeFactor: 1,
  };
  let engaged = null; // the fish nibbling / biting (only one at a time)
  let activeBite = null; // { id, fish, windowS, t, closed }
  let forced = null; // { speciesId, t }
  let hooked = null; // HookedFish
  let hookedRec = null;
  let recycleT = 3;
  let recycledThisCast = 0;
  const respawnQueue = [];
  const counters = { interest: 0, follows: 0, dockTurnaways: 0, dockStrikes: 0, shortStrikes: 0, nibbles: 0, bites: 0, missed: 0, spooked: 0, recycled: 0 };

  function updateLure(frame, dt) {
    const L = frame.lure;
    const active = !!(L && L.inWater && L.position && (!L.state || L.state === 'water'));
    if (!active) {
      lureCtx.active = false;
      lureCtx.inWaterFor = 0;
      lureCtx.hasPrev = false;
      lureCtx.movedFor = 0;
      return;
    }
    const id = LURE_BY_ID[L.id] ? L.id : 'bobber';
    lureCtx.active = true;
    lureCtx.id = id;
    lureCtx.def = LURE_BY_ID[id];
    lureCtx.tune = LURE_TUNING[id];
    lureCtx.isBait = lureCtx.def.kind === 'bait';
    lureCtx.pos.set(fin(L.position.x), fin(L.position.y, -0.5), fin(L.position.z));
    lureCtx.inWaterFor += dt;
    // speed (prefer the tackle's number, fall back to our own finite difference)
    let spd = L.speedMps;
    if (!Number.isFinite(spd)) {
      spd = lureCtx.hasPrev && dt > 0 ? Math.hypot(lureCtx.pos.x - lureCtx.prevX, lureCtx.pos.z - lureCtx.prevZ) / dt : 0;
    }
    lureCtx.speed = Math.max(0, spd);
    // direction of travel (toward the rod when not moving)
    let dx = 0;
    let dz = 0;
    if (L.velocity && Number.isFinite(L.velocity.x) && Math.hypot(L.velocity.x, L.velocity.z) > 0.05) {
      dx = L.velocity.x;
      dz = L.velocity.z;
    } else if (lureCtx.hasPrev && lureCtx.speed > 0.05) {
      dx = lureCtx.pos.x - lureCtx.prevX;
      dz = lureCtx.pos.z - lureCtx.prevZ;
    } else {
      dx = -lureCtx.pos.x;
      dz = -1.5 - lureCtx.pos.z;
    }
    const dl = Math.hypot(dx, dz) || 1;
    lureCtx.dirX = dx / dl;
    lureCtx.dirZ = dz / dl;
    lureCtx.prevX = lureCtx.pos.x;
    lureCtx.prevZ = lureCtx.pos.z;
    lureCtx.hasPrev = true;
    lureCtx.distanceM = Number.isFinite(L.distanceM) ? L.distanceM : Math.hypot(lureCtx.pos.x, lureCtx.pos.z + 1.5);

    const moving = lureCtx.speed > 0.07;
    if (moving) {
      lureCtx.movedFor += dt;
      lureCtx.pausedS = 0;
    } else {
      if (lureCtx.moving) lureCtx.lastMoveDur = lureCtx.movedFor;
      lureCtx.movedFor = 0;
      lureCtx.pausedS += dt;
    }
    if (Number.isFinite(L.pausedS) && !moving) lureCtx.pausedS = Math.max(0, L.pausedS);
    lureCtx.moving = moving;
    const tune = lureCtx.tune;
    if (lureCtx.isBait) {
      // a worm should sit still or crawl; dragging it fast looks wrong to fish
      lureCtx.speedFactor = lureCtx.speed < 0.25 ? 1 : clamp(1 - (lureCtx.speed - 0.25) * 1.3, 0.25, 1);
      lureCtx.alive = 1;
      lureCtx.pauseTrigger = false;
    } else {
      if (moving) {
        const x = Math.log(Math.max(lureCtx.speed, 0.02) / tune.optMps) / tune.sigma;
        const sf = Math.exp(-0.5 * x * x);
        lureCtx.sfEMA = damp(lureCtx.sfEMA, sf, 3, dt);
      }
      lureCtx.speedFactor = lureCtx.sfEMA;
      const ps = lureCtx.pausedS;
      const hadMoved = lureCtx.lastMoveDur > 0.5 || lureCtx.movedFor > 0;
      if (moving) lureCtx.alive = 1;
      else if (id === 'topwater') lureCtx.alive = hadMoved ? (ps < 4 ? 0.85 : ps < 8 ? 0.4 : 0.12) : 0.35;
      else lureCtx.alive = hadMoved ? (ps < 2.5 ? 0.8 : ps < 5 ? 0.3 : 0.08) : 0.15;
      lureCtx.pauseTrigger = !moving && ps > 0.15 && ps < 1.8 && lureCtx.lastMoveDur > 0.6;
    }
    // detection range by the sense each lure works on
    let R = tune.detectR;
    if (tune.sense === 'scent') R = 3 + 2 * smoothstep(0, 25, lureCtx.inWaterFor); // the scent cloud spreads
    else if (tune.sense === 'flash') R *= (0.6 + 0.4 * light) * clarity;
    else if (tune.sense === 'surface') R *= 0.8 + 0.2 * light;
    else if (tune.sense === 'vibration') R *= moving ? 1 : 0.35;
    lureCtx.detectR = R;
    // topwater is a low-light lure; flash needs light
    lureCtx.timeFactor = id === 'topwater' ? 0.28 + 0.72 * lowLight : id === 'spinner' ? 0.65 + 0.35 * light : 1;
  }

  // How keen a fish is on the current lure right now (0..~1.3).
  function motivation(f) {
    if (f.cooldown > 0) return 0;
    const sp = f.species;
    const pref = sp.lures[lureCtx.id] || 0;
    return pref * Math.pow(sp.activity(hours), 1.4) * f.hunger * (1 - 0.7 * f.wary) * lureCtx.alive * lureCtx.speedFactor * lureCtx.timeFactor;
  }
  // Depth-weighted distance from a fish's mouth to the lure (fish look up at surface lures).
  function lureDist(f) {
    const dx = f.pos.x - lureCtx.pos.x;
    const dz = f.pos.z - lureCtx.pos.z;
    const dy = (f.pos.y - lureCtx.pos.y) * (lureCtx.id === 'topwater' ? 0.55 : 1.25);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // ---------- state transitions ----------
  function setState(f, s, dur = 0) {
    f.state = s;
    f.stateT = 0;
    f.stateDur = dur;
  }
  function disengage(f, cooldown, flee = false, threatX = f.pos.x - Math.sin(f.yaw), threatZ = f.pos.z - Math.cos(f.yaw)) {
    if (engaged === f) engaged = null;
    f.finalDecided = false;
    f.forced = false;
    f.cooldown = Math.max(f.cooldown, cooldown);
    if (flee) {
      f.threatX = threatX;
      f.threatZ = threatZ;
      f.fleeSpeed = clamp(0.9 + 2.6 * f.lengthM, 1.1, 3.2);
      setState(f, 'flee', randRange(rng, 1.8, 4));
    } else {
      setState(f, 'cruise');
    }
  }
  function startFlee(f, threatX, threatZ, strength = 1) {
    if (f.state === 'hooked' || f.state === 'release') return;
    if (activeBite && activeBite.fish === f) closeBite('spooked');
    if (engaged === f) engaged = null;
    f.threatX = threatX;
    f.threatZ = threatZ;
    f.fleeSpeed = clamp(0.9 + 2.6 * f.lengthM, 1.1, 3.2) * (0.7 + 0.3 * strength);
    f.cooldown = Math.max(f.cooldown, randRange(rng, 20, 50) * strength);
    f.wary = 1;
    f.finalDecided = false;
    setState(f, 'flee', randRange(rng, 2, 4.5));
  }

  function openBite(f) {
    if (activeBite && !activeBite.closed) return;
    const sp = f.species;
    const id = ++biteCounter;
    const windowS = clamp(sp.hookWindowS * randRange(rng, 0.85, 1.15), 0.5, 1.6);
    activeBite = { id, fish: f, windowS, t: 0, closed: false };
    counters.bites++;
    f.biteId = id;
    f.biteT = 0;
    f.windowS = windowS;
    engaged = f;
    setState(f, 'bite');
    const pos = lureCtx.pos.clone();
    if (lureCtx.id === 'topwater' || lureCtx.pos.y > -0.6) {
      _v1.set(lureCtx.pos.x, surfaceY(lureCtx.pos.x, lureCtx.pos.z), lureCtx.pos.z);
      events.emit('fish:swirl', { position: _v1.clone(), size01: size01(f.weightKg) });
    }
    events.emit('fish:bite', { fishId: f.id, biteId: id, speciesId: f.speciesId, weightKg: f.weightKg, lengthCm: f.lengthCm, windowS, position: pos });
  }
  function closeBite(reason) {
    if (!activeBite || activeBite.closed) return;
    activeBite.closed = true;
    const f = activeBite.fish;
    f.biteId = 0;
    counters.missed++;
    events.emit('fish:missed', { fishId: f.id, reason });
    if (f.state === 'bite') {
      const spooky = reason === 'early' || reason === 'late' || reason === 'strike' || reason === 'spooked';
      // a fish that simply let go may come back later; one that felt the hook is gone
      disengage(f, spooky ? randRange(rng, 45, 90) : randRange(rng, 8, 20), true, lureCtx.pos.x, lureCtx.pos.z);
      if (!spooky) f.fleeSpeed *= 0.55;
    }
    if (engaged === f) engaged = null;
  }

  // ---------- spooking ----------
  function spookAt(x, y, z, radius, strength = 1) {
    let count = 0;
    for (const f of population) {
      if (f.removed || f.state === 'hooked' || f.state === 'release') continue;
      const dx = f.pos.x - x;
      const dz = f.pos.z - z;
      const dy = (f.pos.y - y) * 0.6;
      const r = radius * (0.75 + 0.5 * (f.species.spookiness ?? 0.5)); // trout and walleye are skittish, catfish not
      if (dx * dx + dy * dy + dz * dz > r * r) continue;
      startFlee(f, x, z, strength);
      count++;
      // the whole school goes with it
      if (f.school) {
        for (const g of f.school.members) {
          if (g !== f && !g.removed && g.state !== 'flee' && g.state !== 'hooked' && g.state !== 'release') {
            startFlee(g, x, z, strength * 0.8);
            count++;
          }
        }
      }
    }
    return count;
  }

  function onLureLanded(e) {
    if (!e || !e.position || e.onWater === false) return;
    const p = e.position;
    const lure = LURE_BY_ID[e.lureId] || LURE_BY_ID.bobber;
    const shallow = depthAt(p.x, p.z) < 2;
    const r = (1.25 + 0.022 * lure.castMassG) * (shallow ? 1.3 : 1);
    const n = spookAt(p.x, fin(p.y, 0), p.z, r, 1);
    if (n > 0) {
      counters.spooked += n;
      events.emit('fish:spooked', { position: new THREE.Vector3(p.x, 0, p.z), count: n });
      const shallowFish = population.find((f) => f.state === 'flee' && -f.pos.y < 0.8 && Math.hypot(f.pos.x - p.x, f.pos.z - p.z) < r + 0.5);
      if (shallowFish) events.emit('fish:swirl', { position: new THREE.Vector3(shallowFish.pos.x, 0, shallowFish.pos.z), size01: size01(shallowFish.weightKg) * 0.5 });
    }
    // nearby fish in the shallows get wary; a soft plop draws predators from a little further
    for (const f of population) {
      if (f.removed || f.state !== 'cruise' && f.state !== 'hold') continue;
      const d = Math.hypot(f.pos.x - p.x, f.pos.z - p.z);
      if (d < r + 3 && shallow) f.wary = Math.max(f.wary, 0.6);
      else if (d < 9 && f.species.boldness > 0.5 && (lure.id === 'topwater' || lure.id === 'bobber') && f.cooldown <= 0 && rng() < 0.2 * f.species.activity(hours)) {
        f.curious = 1;
      }
    }
    recycledThisCast = 0;
    recycleT = 1.5; // look for prospects shortly after the lure lands
  }
  function onTwitch(e) {
    lureCtx.lastTwitch = time;
    void e;
  }
  const unsub = [];
  if (events.on) {
    unsub.push(events.on('lure:landed', onLureLanded));
    unsub.push(events.on('lure:twitch', onTwitch));
  }

  // ---------- recycling: keep a few catchable fish around the lure (always out of view) ----------
  function prospectScore(sp) {
    return (sp.lures[lureCtx.id] || 0) * sp.activity(hours) * lureCtx.timeFactor;
  }
  function ensureProspects() {
    if (!lureCtx.active || hooked) return;
    const R = Math.max(lureCtx.detectR, 3.5);
    let prospects = 0;
    for (const f of population) {
      if (f.removed || f.state === 'hooked' || f.state === 'release' || f.cooldown > 5) continue;
      const d = Math.hypot(f.pos.x - lureCtx.pos.x, f.pos.z - lureCtx.pos.z);
      if (d < R * 2.2 && prospectScore(f.species) > 0.12) prospects++;
    }
    const want = 3;
    if (prospects >= want || recycledThisCast >= 2) return;
    // choose a species that fits the lure, the spot and the hour
    const lx = lureCtx.pos.x;
    const lz = lureCtx.pos.z;
    let sum = 0;
    const weights = _speciesW;
    for (let i = 0; i < SPECIES.length; i++) {
      const sp = SPECIES[i];
      const hs = habitatScore(sp, lx, lz);
      const w = sp.abundance * prospectScore(sp) * Math.min(hs, 1.5);
      weights[i] = w > 0.002 ? w : 0;
      sum += weights[i];
    }
    if (sum <= 0) return;
    let r = rng() * sum;
    let pick = SPECIES[0];
    for (let i = 0; i < SPECIES.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        pick = SPECIES[i];
        break;
      }
    }
    // donor: a fish of that species far away from the lure and the player, not visible
    let donor = null;
    let donorD = 0;
    for (const f of population) {
      if (f.speciesId !== pick.id || f.removed || f.state === 'hooked' || f.state === 'release' || f.state === 'bite' || f === engaged) continue;
      if (isSeen(f)) continue;
      if (f.school && f.school.members.some(isSeen)) continue; // the whole school moves
      const d = Math.hypot(f.pos.x - lx, f.pos.z - lz);
      if (d < R * 2.5) continue;
      if (d > donorD) {
        donorD = d;
        donor = f;
      }
    }
    if (!donor) return;
    // new home near the lure, just inside or around the detection range, never where the player
    // could see it appear; if the water near the lure is in plain view, start it further out
    // (deeper / off to the side) and let it swim in on its own.
    _near.x = lx;
    _near.z = lz;
    _near.rMin = Math.max(1.8, R * 0.55);
    _near.rMax = Math.max(4, R * 1.25);
    let ok = pickSpot(pick, _near, true, spot) && !inView(spot.x, -Math.min(depthAt(spot.x, spot.z) * 0.7, 3), spot.z);
    let swimIn = false;
    if (!ok) {
      _near.rMin = Math.max(6, R * 1.3);
      _near.rMax = Math.max(18, R * 3);
      ok = pickSpot(pick, _near, true, spot) && !inView(spot.x, -Math.min(depthAt(spot.x, spot.z) * 0.7, 3), spot.z);
      swimIn = true;
    }
    if (!ok) return;
    relocate(donor, spot.x, spot.z);
    if (swimIn) {
      // head for the lure's neighbourhood
      const members = donor.school ? donor.school.members : null;
      if (donor.school) {
        donor.school.homeX = lx;
        donor.school.homeZ = lz;
      } else {
        donor.homeX = lx;
        donor.homeZ = lz;
      }
      if (members) for (const g of members) g.curious = 1;
      else donor.curious = 1;
    }
    counters.recycled++;
    recycledThisCast++;
  }
  const isSeen = (f) => !!(f.mesh && f.mesh.handle.object3d.visible && inView(f.pos.x, f.pos.y, f.pos.z));
  const _speciesW = new Float32Array(SPECIES.length);
  const _near = { x: 0, z: 0, rMin: 0, rMax: 0 };
  function relocate(f, x, z) {
    const group = f.school ? f.school.members : null;
    if (group) {
      f.school.homeX = x;
      f.school.homeZ = z;
      f.school.homeT = randRange(rng, 25, 50);
      for (const g of group) {
        if (g.removed || g.state === 'hooked' || g.state === 'release') continue;
        const a = rng() * TAU;
        const r = Math.sqrt(rng()) * 1.5;
        placeFishAt(g, x + Math.sin(a) * r, z + Math.cos(a) * r);
      }
    } else {
      placeFishAt(f, x, z);
      f.homeX = x;
      f.homeZ = z;
      f.homeT = randRange(rng, 40, 90);
    }
  }
  function placeFishAt(f, x, z) {
    if (depthAt(x, z) < Math.max(0.4, f.bodyH + 0.3)) return;
    f.pos.x = x;
    f.pos.z = z;
    f.bottomY = terrainY(x, z);
    f.pos.y = preferredY(f, f.bottomY);
    f.speed = f.species.cruiseMps * 0.6;
    f.vy = 0;
    f.cooldown = Math.min(f.cooldown, 1);
    f.wary = 0;
    if (f.state !== 'hooked') setState(f, 'cruise');
    releaseMesh(f);
  }

  // ---------- per-fish sensing (10 Hz) ----------
  function sense(f) {
    const sp = f.species;
    f.bottomY = terrainY(f.pos.x, f.pos.z);
    // look ahead for shallows / shore
    const hx = Math.sin(f.yaw);
    const hz = Math.cos(f.yaw);
    const probe = 1.6 + f.speed * 2.2 + f.lengthM;
    const minComfort = Math.max(0.35 + f.bodyH, sp.depthM[0] * 0.7);
    const dAhead = depthAt(f.pos.x + hx * probe, f.pos.z + hz * probe);
    if (dAhead < minComfort) {
      const aL = f.yaw + 0.9;
      const aR = f.yaw - 0.9;
      const dL = depthAt(f.pos.x + Math.sin(aL) * probe, f.pos.z + Math.cos(aL) * probe);
      const dR = depthAt(f.pos.x + Math.sin(aR) * probe, f.pos.z + Math.cos(aR) * probe);
      let a;
      if (dL < minComfort && dR < minComfort) a = f.yaw + Math.PI;
      else a = dL > dR ? aL + 0.4 : aR - 0.4;
      f.avoidX = Math.sin(a);
      f.avoidZ = Math.cos(a);
      f.avoidT = 1.2;
    }
    // separation from neighbours
    let sx = 0;
    let sz = 0;
    for (const g of population) {
      if (g === f || g.removed || g.state === 'hooked') continue;
      const dx = f.pos.x - g.pos.x;
      const dz = f.pos.z - g.pos.z;
      const lim = 0.25 + 0.6 * (f.lengthM + g.lengthM);
      const d2 = dx * dx + dz * dz;
      if (d2 > lim * lim || d2 < 1e-6) continue;
      if (Math.abs(f.pos.y - g.pos.y) > lim) continue;
      const d = Math.sqrt(d2);
      const w = (lim - d) / lim;
      sx += (dx / d) * w;
      sz += (dz / d) * w;
    }
    f.sepX = sx;
    f.sepZ = sz;

    // notice the lure?
    if (!lureCtx.active || hooked) return;
    if (f.state !== 'cruise' && f.state !== 'hold') return;
    if (f.cooldown > 0) return;
    const d = lureDist(f);
    let R = lureCtx.detectR * (0.85 + 0.3 * f.hunger - 0.15);
    if (f.curious) R *= 1.4;
    if (d > R) return;
    const mot = motivation(f);
    if (mot <= 0.01) return;
    // bait scent spreads over the first ~20 s; lures are seen / felt right away
    const base = lureCtx.isBait ? 0.3 * (0.3 + 0.7 * smoothstep(2, 22, lureCtx.inWaterFor)) : 0.6;
    let rate = base * mot * Math.sqrt(Math.max(0, 1 - d / R));
    if (time - lureCtx.lastTwitch < 0.6 && d < R) rate *= 1.8;
    if (f.curious) rate *= 2;
    // a school notices together
    if (f.school && f.school.excited > 0) rate *= 3;
    if (rng() < 1 - Math.exp(-rate * 0.1)) {
      f.curious = 0;
      setState(f, 'notice', randRange(rng, 0.3, 0.9));
      if (f.school) f.school.excited = 4;
    }
  }

  // ---------- per-fish behavior + locomotion ----------
  function thinkAndMove(f, dt) {
    const sp = f.species;
    f.stateT += dt;
    if (f.cooldown > 0) f.cooldown -= dt;
    if (f.wary > 0) f.wary = Math.max(0, f.wary - dt / 25);
    f.bobPhase += dt * 0.25;
    const act = sp.activity(hours);
    let desX = 0;
    let desZ = 0;
    let wantSpeed = sp.cruiseMps * (0.55 + 0.6 * act) * (0.8 + 0.25 * Math.sin(f.bobPhase * 1.7));
    let wantY = preferredY(f, f.bottomY);
    let maxTurn = 1.2 + 0.9 / Math.sqrt(Math.max(f.lengthM, 0.1));
    let accel = 1.2;
    let vyMax = 0.22;
    let kinematic = false;
    const lp = lureCtx.pos;

    // lure gone (reeled out, recast, fish on): anyone interested loses it
    const interested = f.state === 'notice' || f.state === 'approach' || f.state === 'follow' || f.state === 'inspect';
    if (interested && (!lureCtx.active || hooked)) disengage(f, randRange(rng, 3, 8));

    switch (f.state) {
      case 'hold': {
        wantSpeed = 0.03;
        desX = Math.sin(f.yaw);
        desZ = Math.cos(f.yaw);
        if (f.stateT > f.stateDur) setState(f, 'cruise');
        break;
      }
      case 'notice': {
        // stop and turn to face it
        _v1.set(lp.x - f.pos.x, 0, lp.z - f.pos.z);
        desX = _v1.x;
        desZ = _v1.z;
        wantSpeed = 0.08;
        maxTurn *= 1.8;
        if (f.stateT > f.stateDur) {
          setState(f, 'approach', 0);
          f.finalDecided = false;
          counters.interest++;
          events.emit('fish:interest', { fishId: f.id, speciesId: f.speciesId, position: f.pos.clone() });
        }
        break;
      }
      case 'approach': {
        const isBait = lureCtx.isBait;
        const gap = isBait ? 0.35 : 0.3 + 0.35 * f.lengthM;
        // each fish aims for its own slot so a crowd doesn't stack up on one point
        const side = f.forced ? 0 : f.slot * (0.12 + 0.3 * f.lengthM);
        const tx = lp.x - lureCtx.dirX * gap - lureCtx.dirZ * side;
        const tz = lp.z - lureCtx.dirZ * gap + lureCtx.dirX * side;
        const dx = tx - f.pos.x;
        const dz = tz - f.pos.z;
        const dh = Math.hypot(dx, dz);
        desX = dx;
        desZ = dz;
        wantSpeed = Math.max(clamp(sp.cruiseMps * 2.2 + f.lengthM * 0.7, 0.35, 1.3), lureCtx.speed + 0.3) * (f.forced ? 1.8 : 1);
        if (dh < 1.2) wantSpeed = Math.max(lureCtx.speed, wantSpeed * (0.35 + 0.55 * dh));
        wantY = clamp(lp.y - (lureCtx.id === 'topwater' ? 0.3 : 0.05), f.bottomY + 0.1 + f.bodyH * 0.6, -0.08);
        vyMax = 0.6;
        maxTurn *= 1.6;
        accel = 2.5;
        const d3 = Math.hypot(dh, wantY - f.pos.y) + Math.abs(side) * 0.8;
        if (f.forced) {
          if (d3 < 0.6 && (!activeBite || activeBite.closed)) openBite(f);
          if (f.state !== 'approach') break;
        }
        if (isBait && d3 < 0.5) {
          setState(f, 'inspect', 0);
          const [a, b] = sp.nibbles;
          f.nibblesLeft = f.forced ? 0 : randInt(rng, a, b);
          f.nextNibble = randRange(rng, 0.4, 1.4);
          if (!engaged && !(activeBite && !activeBite.closed)) engaged = f;
        } else if (!isBait && d3 < 1.0 + gap) {
          setState(f, 'follow', randRange(rng, 3, 12));
          counters.follows++;
          f.gap = gap;
        }
        if (f.stateT > 12 || lureDist(f) > lureCtx.detectR * 1.9 + 2) disengage(f, randRange(rng, 6, 14));
        if (!isBait && lureCtx.alive < 0.2 && rng() < dt * 0.8) disengage(f, randRange(rng, 6, 14));
        break;
      }
      case 'follow': {
        // trail the lure, close in when it pauses
        const paused = !lureCtx.moving;
        f.gap = damp(f.gap, paused ? 0.14 + 0.1 * f.lengthM : 0.3 + 0.35 * f.lengthM, paused ? 1.5 : 3, dt);
        const side = f.slot * (0.1 + 0.25 * f.lengthM) * (paused ? 0.4 : 1);
        const tx = lp.x - lureCtx.dirX * f.gap - lureCtx.dirZ * side;
        const tz = lp.z - lureCtx.dirZ * f.gap + lureCtx.dirX * side;
        const dx = tx - f.pos.x;
        const dz = tz - f.pos.z;
        const dh = Math.hypot(dx, dz);
        desX = dx + lureCtx.dirX * 0.3;
        desZ = dz + lureCtx.dirZ * 0.3;
        wantSpeed = clamp(lureCtx.speed + dh * 1.4 - 0.1, 0, 2.2);
        wantY = clamp(lp.y - (lureCtx.id === 'topwater' ? 0.22 : 0.04), f.bottomY + 0.1 + f.bodyH * 0.6, -0.06);
        vyMax = 0.5;
        maxTurn *= 2;
        accel = 3;
        // decide: strike, keep following, lose interest
        const canBite = !activeBite || activeBite.closed;
        const mot = motivation(f);
        let hz = 0.42 * mot * sp.boldness * (lureCtx.pauseTrigger ? 3.5 : 1) * (time - lureCtx.lastTwitch < 0.5 ? 2 : 1);
        if (f.forced) hz = 50;
        const nearDock = lureCtx.distanceM < 3.4 || depthAt(tx, tz) < Math.max(0.45, f.bodyH + 0.3);
        if (nearDock && !f.finalDecided && !f.forced) {
          // the last-second decision at the dock: most turn away, a few smash it
          f.finalDecided = true;
          const pFinal = 0.34 * sp.boldness * (lureCtx.pauseTrigger ? 1.8 : 1) * clamp(mot + 0.3, 0.3, 1.2);
          if (canBite && rng() < pFinal) {
            counters.dockStrikes++;
            openBite(f);
          } else {
            counters.dockTurnaways++;
            if (-f.pos.y < 0.7) events.emit('fish:swirl', { position: new THREE.Vector3(f.pos.x, 0, f.pos.z), size01: size01(f.weightKg) * 0.35 });
            disengage(f, randRange(rng, 20, 45), true, lp.x, lp.z);
            f.fleeSpeed *= 0.6;
          }
          break;
        }
        if (canBite && dh < 0.8 && rng() < 1 - Math.exp(-hz * dt)) {
          if (lureCtx.id === 'topwater' && !f.forced && rng() < 0.3) {
            // short strike: blows up on it and misses
            events.emit('fish:swirl', { position: new THREE.Vector3(lp.x, 0, lp.z), size01: size01(f.weightKg) * 0.8 });
            counters.shortStrikes++;
            f.cooldown = 0;
            setState(f, 'follow', randRange(rng, 2, 6));
            f.gap = 0.8;
          } else {
            openBite(f);
          }
          break;
        }
        const giveUp = 0.08 + (lureCtx.alive < 0.3 ? 0.6 : 0) + (lureCtx.speedFactor < 0.3 ? 0.25 : 0);
        if (f.stateT > f.stateDur || rng() < giveUp * dt) {
          disengage(f, randRange(rng, 12, 30), true, lp.x, lp.z);
          f.fleeSpeed *= 0.45;
        }
        break;
      }
      case 'inspect': {
        // hover nose-to-bait, dart in to peck at it, then take it
        kinematic = true;
        const mine = engaged === f || !engaged;
        const reach = mine ? (f.nextNibble < 0.18 && f.nibblesLeft > 0 ? 0.02 : 0.12 + 0.12 * f.lengthM) : 0.3 + 0.45 * f.lengthM + 0.08 * Math.abs(f.slot);
        _v1.set(f.pos.x - lp.x, 0, f.pos.z - lp.z);
        if (_v1.lengthSq() < 1e-6) _v1.set(Math.sin(f.yaw + Math.PI), 0, Math.cos(f.yaw + Math.PI));
        _v1.normalize();
        // waiting fish fan out around the bait
        const fan = mine ? 0 : f.slot * 0.45 * dt;
        const cx = _v1.x * Math.cos(fan) - _v1.z * Math.sin(fan);
        const cz = _v1.x * Math.sin(fan) + _v1.z * Math.cos(fan);
        const gx = lp.x + cx * reach + f.sepX * 0.25;
        const gz = lp.z + cz * reach + f.sepZ * 0.25;
        const ox = f.pos.x;
        const oz = f.pos.z;
        f.pos.x = damp(f.pos.x, gx, 4, dt);
        f.pos.z = damp(f.pos.z, gz, 4, dt);
        const gy = clamp(lp.y - 0.02, f.bottomY + 0.1 + f.bodyH * 0.6, -0.06);
        f.pos.y = damp(f.pos.y, gy, 3, dt);
        desX = lp.x - f.pos.x;
        desZ = lp.z - f.pos.z;
        wantSpeed = Math.hypot(f.pos.x - ox, f.pos.z - oz) / dt + 0.05;
        maxTurn *= 2.5;
        accel = 8;
        if (lureCtx.speed > 0.6) {
          disengage(f, randRange(rng, 4, 10));
          break;
        }
        const canBite = !activeBite || activeBite.closed;
        if (!engaged && canBite) engaged = f;
        if (engaged !== f) {
          // another fish has it: hang around a moment, then give up
          if (f.stateT > 4) disengage(f, randRange(rng, 3, 8));
          break;
        }
        f.nextNibble -= dt;
        if (f.nextNibble <= 0) {
          if (f.nibblesLeft > 0) {
            f.nibblesLeft--;
            f.nextNibble = randRange(rng, 0.6, 1.9);
            counters.nibbles++;
            events.emit('fish:nibble', { fishId: f.id, strength01: clamp(0.18 + 0.55 * size01(f.weightKg) + 0.15 * rng(), 0.1, 1) });
            // panfish sometimes just steal a nip and swim off
            if (f.nibblesLeft === 0 && rng() < 0.12 && !f.forced) {
              disengage(f, randRange(rng, 5, 15));
              break;
            }
            if (f.nibblesLeft === 0) f.nextNibble = randRange(rng, 0.4, 1.2);
          } else if (canBite) {
            openBite(f);
          }
        }
        if (f.stateT > 20) disengage(f, randRange(rng, 5, 10));
        break;
      }
      case 'bite': {
        // mouth on the lure/bait until the window closes
        kinematic = true;
        desX = lp.x - f.pos.x + Math.sin(f.yaw) * 0.05;
        desZ = lp.z - f.pos.z + Math.cos(f.yaw) * 0.05;
        f.pos.x = damp(f.pos.x, lp.x, 18, dt);
        f.pos.z = damp(f.pos.z, lp.z, 18, dt);
        wantY = clamp(lp.y, f.bottomY + 0.1 + f.bodyH * 0.5, -0.03);
        f.pos.y = damp(f.pos.y, wantY, 12, dt);
        wantSpeed = lureCtx.isBait ? 0.25 : lureCtx.speed;
        maxTurn *= 2;
        accel = 4;
        vyMax = 1;
        if (activeBite && activeBite.fish === f && !activeBite.closed) {
          activeBite.t += dt;
          if (activeBite.t > activeBite.windowS + 0.25) closeBite('dropped');
        } else {
          disengage(f, 10);
        }
        break;
      }
      case 'flee': {
        const ax = f.pos.x - f.threatX;
        const az = f.pos.z - f.threatZ;
        desX = ax;
        desZ = az;
        const k = clamp(f.stateT / Math.max(f.stateDur, 0.1), 0, 1);
        wantSpeed = f.fleeSpeed * (1 - 0.6 * k);
        wantY = Math.max(f.bottomY + 0.12 + f.bodyH * 0.6, Math.min(wantY - 0.8, -0.3));
        maxTurn *= 3;
        accel = 6;
        vyMax = 0.8;
        if (f.stateT > f.stateDur) setState(f, 'cruise');
        break;
      }
      case 'release': {
        // released: a moment to recover beside the dock, then a kick down and away
        const k = f.stateT;
        wantSpeed = k < 1.2 ? 0.05 : clamp(0.4 + (k - 1.2) * 0.6, 0.4, 1.4);
        desX = f.threatX;
        desZ = f.threatZ;
        wantY = k < 1.2 ? f.pos.y : Math.max(f.bottomY + 0.15 + f.bodyH * 0.6, -3);
        vyMax = 0.35;
        f.exhaustion = Math.max(0, 1 - k / 3);
        if (k > 9) removeFish(f, true);
        break;
      }
      default: {
        // cruise: wander around home, school, hold on cover now and then
        if (f.state !== 'cruise') setState(f, 'cruise');
        f.wanderVel += ((rng() - 0.5) * 1.6 - f.wanderVel * 0.8) * dt;
        f.wander += f.wanderVel * dt;
        desX = Math.sin(f.wander);
        desZ = Math.cos(f.wander);
        let hx = f.homeX;
        let hz = f.homeZ;
        let R = f.homeR;
        if (f.school) {
          hx = f.school.homeX;
          hz = f.school.homeZ;
          R = f.school.homeR;
        }
        const tx = hx - f.pos.x;
        const tz = hz - f.pos.z;
        const td = Math.hypot(tx, tz);
        if (td > 1e-3) {
          const w = smoothstep(0.35 * R, 1.25 * R, td) * 2.2;
          desX += (tx / td) * w;
          desZ += (tz / td) * w;
        }
        if (f.school) {
          const s = f.school;
          const cx = s.cx - f.pos.x;
          const cz = s.cz - f.pos.z;
          const cd = Math.hypot(cx, cz);
          if (cd > 1e-3) {
            const w = smoothstep(0.6, 2.8, cd) * 1.6;
            desX += (cx / cd) * w;
            desZ += (cz / cd) * w;
          }
          desX += s.ax * 1.6;
          desZ += s.az * 1.6;
          wantY = lerp(wantY, s.cy, 0.5);
        }
        // ambushers hold still on cover a lot
        if (!f.school && f.stateT > 4 && td < R * 0.7) {
          const holdy = sp.id === 'northern_pike' ? 0.5 : sp.id === 'largemouth_bass' || sp.id === 'walleye' || sp.id === 'channel_catfish' ? 0.18 : 0.04;
          if (rng() < holdy * dt * (1.3 - act)) setState(f, 'hold', randRange(rng, 5, 22));
        }
        if (f.school && f.school.excited > 0 && lureCtx.active && f.cooldown <= 0) {
          // a schoolmate found something: the school drifts over
          const lx = lp.x - f.pos.x;
          const lz = lp.z - f.pos.z;
          const ld = Math.hypot(lx, lz) || 1;
          desX += (lx / ld) * 1.6;
          desZ += (lz / ld) * 1.6;
        }
        if (f.curious) {
          // heard a plop: drift toward it
          if (lureCtx.active) {
            desX += (lp.x - f.pos.x) * 0.3;
            desZ += (lp.z - f.pos.z) * 0.3;
          } else f.curious = 0;
        }
      }
    }

    // avoidance + separation on top of the state's intent
    if (f.avoidT > 0) {
      f.avoidT -= dt;
      const w = 3.5 * Math.min(1, f.avoidT / 0.4);
      const dl = Math.hypot(desX, desZ) || 1;
      desX = desX / dl + f.avoidX * w;
      desZ = desZ / dl + f.avoidZ * w;
      f.wander = Math.atan2(f.avoidX, f.avoidZ);
    }
    if (f.state === 'cruise' || f.state === 'hold' || f.state === 'flee' || f.state === 'approach' || f.state === 'follow') {
      const w = f.state === 'approach' || f.state === 'follow' ? 0.7 : 1.4;
      const dl = Math.hypot(desX, desZ) || 1;
      desX = desX / dl + f.sepX * w;
      desZ = desZ / dl + f.sepZ * w;
    }

    // turn toward the desired heading with a limited, smoothed yaw rate
    if (desX * desX + desZ * desZ > 1e-8) {
      const desYaw = Math.atan2(desX, desZ);
      const dyaw = wrapAngle(desYaw - f.yaw);
      const want = clamp(dyaw * 2.2, -maxTurn, maxTurn);
      f.yawVel = damp(f.yawVel, want, 5, dt);
    } else {
      f.yawVel = damp(f.yawVel, 0, 3, dt);
    }
    // fish barely turn when they hardly move (except when orienting on purpose)
    f.yaw = wrapAngle(f.yaw + f.yawVel * dt);
    f.turnRate = f.yawVel;
    f.speed = damp(f.speed, Math.max(0, wantSpeed), accel, dt);

    // vertical
    const vyWant = clamp((wantY - f.pos.y) * 0.9, -vyMax, vyMax);
    f.vy = damp(f.vy, vyWant, 3, dt);

    // integrate (the bite / inspect states place the mouth themselves)
    const ox = f.pos.x;
    const oz = f.pos.z;
    if (!kinematic) {
      f.pos.x += Math.sin(f.yaw) * f.speed * dt;
      f.pos.z += Math.cos(f.yaw) * f.speed * dt;
      f.pos.y += f.vy * dt;
    } else {
      f.vy = 0;
    }
    // hard constraints: water deep enough, above the bed, below the surface
    const by = terrainY(f.pos.x, f.pos.z);
    const minD = Math.max(0.3, f.bodyH + 0.18);
    if (WATER_LEVEL - by < minD && !kinematic) {
      f.pos.x = ox;
      f.pos.z = oz;
      f.avoidX = -Math.sin(f.yaw);
      f.avoidZ = -Math.cos(f.yaw);
      f.avoidT = 1;
      f.speed *= 0.5;
    } else {
      f.bottomY = by;
    }
    const minY = f.bottomY + 0.06 + f.bodyH * 0.5;
    if (f.pos.y < minY) {
      f.pos.y = minY;
      if (f.vy < 0) f.vy = 0;
    }
    const maxY = -(0.03 + f.bodyH * 0.35);
    if (f.pos.y > maxY) {
      f.pos.y = maxY;
      if (f.vy > 0) f.vy = 0;
    }
    f.pitch = damp(f.pitch, clamp(Math.atan2(f.vy, Math.max(f.speed, 0.08)), -0.5, 0.5), 4, dt);
    if (!Number.isFinite(f.pos.x) || !Number.isFinite(f.pos.y) || !Number.isFinite(f.pos.z)) {
      f.pos.set(f.homeX, -1.5, f.homeZ);
      f.speed = 0;
      f.vy = 0;
    }
    if (!Number.isFinite(f.yaw)) f.yaw = 0;
  }

  // ---------- meshes (pooled, only near the camera) ----------
  const pools = new Map(); // speciesId -> [handle]
  let meshCount = 0;
  let createdThisFrame = 0;
  function makeHandle(sp, lengthCm, detail, extra = null) {
    let mh;
    try {
      // population fish cast shadows on the sand in the shallows (high quality only)
      mh = meshFactory(sp, lengthCm, extra ? { detail, quality, ...extra } : { detail, quality, seed: (rng() * 1e9) | 0, castShadow: quality === 'high' });
    } catch (err) {
      console.warn('[fish] createFishMesh failed', err);
      return null;
    }
    if (!mh || !mh.object3d) return null;
    const o = mh.object3d;
    o.traverse((c) => {
      c.layers.enable(LAYERS.UNDERWATER);
    });
    o.rotation.order = 'YXZ';
    // measure where the snout is (mesh faces +Z) so the mouth lands on the hook point
    o.position.set(0, 0, 0);
    o.rotation.set(0, 0, 0);
    o.scale.set(1, 1, 1);
    o.updateMatrixWorld(true);
    _box.makeEmpty();
    try {
      _box.setFromObject(o);
    } catch {
      _box.makeEmpty();
    }
    // mesh.js puts the origin on the snout (mouth ~ z 0); a centred mesh would give ~ +L/2
    const L = lengthCm / 100;
    let mouth = _box.isEmpty() ? 0 : _box.max.z;
    if (!(mouth > -0.1 * L && mouth < 1.1 * L)) mouth = 0;
    return { handle: mh, speciesId: sp.id, baseLenCm: lengthCm, mouth, inUse: false };
  }
  function acquireMesh(f) {
    if (!renderFish) return null;
    let list = pools.get(f.speciesId);
    if (!list) pools.set(f.speciesId, (list = []));
    let best = null;
    let bestR = 1e9;
    for (const h of list) {
      if (h.inUse) continue;
      const r = Math.abs(Math.log(f.lengthCm / h.baseLenCm));
      if (r < bestR) {
        bestR = r;
        best = h;
      }
    }
    const poolCap = (MAX_RENDERED[quality] || 18) * 2 + 8;
    if ((!best || bestR > 0.5) && createdThisFrame < MESH_CREATES_PER_FRAME && meshCount < poolCap) {
      const h = makeHandle(f.species, f.lengthCm, 'low');
      if (h) {
        createdThisFrame++;
        meshCount++;
        list.push(h);
        scene.add(h.handle.object3d);
        best = h;
      }
    }
    if (!best) return null;
    best.inUse = true;
    best.handle.object3d.visible = true;
    return best;
  }
  function releaseMesh(f) {
    if (f.mesh && f.mesh !== f.ownMesh) {
      f.mesh.inUse = false;
      f.mesh.handle.object3d.visible = false;
    }
    f.mesh = null;
    if (f.ownMesh) f.ownMesh.handle.object3d.visible = false;
  }
  function disposeHandle(h) {
    if (!h) return;
    const o = h.handle.object3d;
    if (o.parent) o.parent.remove(o);
    try {
      h.handle.dispose && h.handle.dispose();
    } catch (err) {
      console.warn('[fish] dispose failed', err);
    }
  }
  function placeMesh(h, pos, yaw, pitch, roll, lengthCm) {
    const o = h.handle.object3d;
    const s = lengthCm / h.baseLenCm;
    o.scale.setScalar(s);
    const cp = Math.cos(pitch);
    const off = h.mouth * s;
    o.position.set(pos.x - Math.sin(yaw) * cp * off, pos.y - Math.sin(pitch) * off, pos.z - Math.cos(yaw) * cp * off);
    o.rotation.set(-pitch, yaw, roll, 'YXZ');
  }

  const renderList = [];
  let renderEvalT = 0;
  function evaluateRendering() {
    const cap = MAX_RENDERED[quality] || MAX_RENDERED.high;
    renderList.length = 0;
    for (const f of population) {
      if (f.removed || f.state === 'hooked') continue;
      const dx = f.pos.x - camPos.x;
      const dz = f.pos.z - camPos.z;
      const d = Math.hypot(dx, dz);
      if (d > RENDER_DIST) {
        f._score = Infinity;
        continue;
      }
      const depth = Math.max(0, -f.pos.y);
      const ahead = (dx * camFwd.x + dz * camFwd.z) / (d || 1);
      f._score = d + Math.max(0, depth - 0.8) * 7 + (ahead < 0.2 && d > 5 ? 40 : 0) + (f.ownMesh ? -20 : 0) + (f.mesh ? -2 : 0);
      renderList.push(f);
    }
    renderList.sort((a, b) => a._score - b._score);
    for (let i = 0; i < renderList.length; i++) renderList[i]._want = i < cap;
    for (const f of population) {
      if (f.state === 'hooked') continue;
      const want = f._want && f._score !== Infinity && !f.removed;
      f._want = false;
      if (!want) {
        if (f.ownMesh && (f._score === Infinity || f.removed)) {
          disposeHandle(f.ownMesh);
          f.ownMesh = null;
        }
        releaseMesh(f);
      } else if (f.ownMesh) {
        f.mesh = f.ownMesh;
        f.mesh.handle.object3d.visible = true;
      } else if (!f.mesh) {
        f.mesh = acquireMesh(f);
      }
    }
  }

  // ---------- hooked fish ----------
  function placeHookedMesh(hf) {
    const h = hf._handle;
    if (!h) return;
    placeMesh(h, hf.position, hf._yaw, hf._pitch, hf._roll, hf.lengthCm);
  }

  function makeHooked(f) {
    const hf = new HookedFish(sysInternal, f);
    // high-detail mesh for the fight (it comes right up to the camera)
    if (renderFish) {
      let h = null;
      const detail = quality === 'low' ? 'medium' : 'high';
      const std = weightFromLength(f.species, f.lengthCm);
      const girth = clamp(Math.sqrt(f.weightKg / Math.max(std, 1e-4)), 0.85, 1.2);
      h = makeHandle(f.species, f.lengthCm, detail, { seed: f.id * 7919, girth, castShadow: quality !== 'low' });
      if (h) {
        h.inUse = true;
        scene.add(h.handle.object3d);
      }
      releaseMesh(f);
      if (f.ownMesh && f.ownMesh !== h) {
        disposeHandle(f.ownMesh);
        f.ownMesh = null;
      }
      f.mesh = null;
      hf._handle = h;
      hf.object3d = h ? h.handle.object3d : null;
      if (hf.object3d) hf.object3d.visible = true;
    }
    hf._yaw = f.yaw;
    placeHookedMesh(hf);
    return hf;
  }

  function hookBite(biteId) {
    if (hooked) return hooked;
    let f = null;
    if (activeBite && activeBite.id === biteId) f = activeBite.fish;
    else if (activeBite && biteId == null && !activeBite.closed) f = activeBite.fish;
    if (!f || f.removed || activeBite.closed) return null;
    activeBite.closed = true;
    if (engaged === f) engaged = null;
    f.state = 'hooked';
    f.biteId = 0;
    // everyone else interested backs off
    for (const g of population) {
      if (g !== f && (g.state === 'approach' || g.state === 'follow' || g.state === 'inspect' || g.state === 'notice')) disengage(g, randRange(rng, 4, 10));
    }
    hooked = makeHooked(f);
    hookedRec = f;
    f.hooked = hooked;
    return hooked;
  }

  function missBite(biteId, reason = 'missed') {
    if (activeBite && !activeBite.closed && (activeBite.id === biteId || biteId == null)) {
      closeBite(reason || 'missed');
      return true;
    }
    // a strike during nibbles pulls the bait away from the fish
    if (biteId == null && engaged && engaged.state === 'inspect') {
      const f = engaged;
      disengage(f, randRange(rng, 20, 40), true, lureCtx.pos.x, lureCtx.pos.z);
      events.emit('fish:missed', { fishId: f.id, reason: reason || 'missed' });
      return true;
    }
    return false;
  }

  function removeFish(f, respawn) {
    if (f.removed) return;
    f.removed = true;
    if (f.mesh && f.mesh !== f.ownMesh) releaseMesh(f);
    if (f.ownMesh) {
      disposeHandle(f.ownMesh);
      f.ownMesh = null;
    }
    f.mesh = null;
    const i = population.indexOf(f);
    if (i >= 0) population.splice(i, 1);
    if (f.school) {
      const j = f.school.members.indexOf(f);
      if (j >= 0) f.school.members.splice(j, 1);
    }
    if (engaged === f) engaged = null;
    if (respawn && !f.debug) respawnQueue.push({ speciesId: f.speciesId, school: f.school, t: randRange(rng, 20, 45) });
  }

  function releaseHooked(outcome = 'escaped') {
    const hf = hooked;
    const f = hookedRec;
    hooked = null;
    hookedRec = null;
    if (!hf || !f) return;
    f.hooked = null;
    const h = hf._handle;
    hf._released = true;
    const inScene = h && hf.object3d && hf.object3d.parent === scene;
    if (outcome === 'landed') {
      // kept: gone from the lake. If core re-parented the mesh (showcase), core owns it now.
      if (inScene) disposeHandle(h);
      hf._handle = null;
      removeFish(f, true);
      return;
    }
    // back into the water where the hooked fish is (or beside the dock after a release)
    f.pos.copy(hf.position);
    if (!Number.isFinite(f.pos.x) || depthAt(f.pos.x, f.pos.z) < 0.3) f.pos.set(0.9 + 0.3, -0.3, -1.4);
    f.pos.y = Math.min(f.pos.y, -0.06);
    f.yaw = hf._yaw;
    f.speed = 0.3;
    f.vy = 0;
    f.bottomY = terrainY(f.pos.x, f.pos.z);
    if (inScene) {
      f.ownMesh = h;
      f.mesh = h;
    } else {
      // core took the mesh: give the fish a fresh one on the next render pass
      f.ownMesh = null;
      f.mesh = null;
    }
    hf._handle = null;
    if (outcome === 'released') {
      f.state = 'release';
      f.stateT = 0;
      // swim away from the dock toward deeper water (threatX/Z hold the heading here)
      f.threatX = f.pos.x >= 0 ? 0.45 : -0.45;
      f.threatZ = -1;
      f.exhaustion = 1;
      f.cooldown = 1e9;
      return;
    }
    // escaped / snapped: bolts, sulks, won't bite again for a while
    f.exhaustion = 1 - hf.stamina01;
    f.state = 'cruise';
    startFlee(f, f.pos.x - hf.velocity.x, f.pos.z - hf.velocity.z, 1.2);
    f.cooldown = randRange(rng, 90, 180);
  }

  function spook(position, radiusM = 3) {
    if (!position) return 0;
    const n = spookAt(fin(position.x), fin(position.y, 0), fin(position.z), Math.max(0.1, fin(radiusM, 3)), 1);
    if (n > 0) events.emit('fish:spooked', { position: new THREE.Vector3(fin(position.x), 0, fin(position.z)), count: n });
    return n;
  }

  function debugForceBite(speciesId) {
    forced = { speciesId: SPECIES_BY_ID[speciesId] ? speciesId : null, t: 0 };
  }

  function handleForced(dt) {
    if (!forced) return;
    forced.t += dt;
    if (forced.t > 120) {
      forced = null;
      return;
    }
    if (!lureCtx.active || hooked || (activeBite && !activeBite.closed)) return;
    let id = forced.speciesId;
    if (!id) {
      // best species for this lure, spot and hour
      let best = 0;
      for (const sp of SPECIES) {
        const s = prospectScore(sp) * sp.abundance * (0.4 + Math.min(1, habitatScore(sp, lureCtx.pos.x, lureCtx.pos.z))) * (0.5 + rng());
        if (s > best) {
          best = s;
          id = sp.id;
        }
      }
      id = id || 'bluegill';
    }
    // nearest fish of that species; else convert a far-away fish
    let f = null;
    let fd = 1e9;
    for (const g of population) {
      if (g.removed || g.state === 'hooked' || g.state === 'release' || g.speciesId !== id) continue;
      const d = Math.hypot(g.pos.x - lureCtx.pos.x, g.pos.z - lureCtx.pos.z);
      if (d < fd) {
        fd = d;
        f = g;
      }
    }
    if (!f) {
      for (const g of population) {
        if (g.removed || g.state === 'hooked' || g.state === 'release' || g.school) continue;
        const d = Math.hypot(g.pos.x - camPos.x, g.pos.z - camPos.z);
        if (!f || d > fd) {
          fd = d;
          f = g;
        }
      }
      if (!f) return;
      const roll = rollFish(id, rng);
      releaseMesh(f);
      if (f.ownMesh) {
        disposeHandle(f.ownMesh);
        f.ownMesh = null;
      }
      f.mesh = null;
      f.species = roll.species;
      f.speciesId = id;
      f.weightKg = roll.weightKg;
      f.lengthCm = roll.lengthCm;
      f.lengthM = roll.lengthCm / 100;
      f.bodyH = f.lengthM * (roll.species.bodyDepth || 0.25);
      fd = 1e9;
    }
    for (const g of population) {
      if (g !== f && g !== engaged && (g.state === 'inspect' || g.state === 'follow' || g.state === 'approach')) disengage(g, 5);
    }
    if (engaged && engaged !== f) disengage(engaged, 5);
    if (fd > 1.5) {
      // bring it in close behind the lure (rarely visible: this is a debug hook)
      const gap = 1.3;
      const x = lureCtx.pos.x - lureCtx.dirX * gap;
      const z = lureCtx.pos.z - lureCtx.dirZ * gap;
      f.pos.set(x, clamp(lureCtx.pos.y - 0.1, terrainY(x, z) + 0.1 + f.bodyH * 0.5, -0.06), z);
      f.yaw = Math.atan2(lureCtx.dirX, lureCtx.dirZ);
      f.bottomY = terrainY(x, z);
    }
    f.forced = true;
    f.cooldown = 0;
    f.finalDecided = true;
    setState(f, 'approach', 0);
    events.emit('fish:interest', { fishId: f.id, speciesId: f.speciesId, position: f.pos.clone() });
    forced = null;
  }

  // Debug: put a specific fish on the line right away (core's debug.hookFish).
  function debugHook(speciesId, weightKg, position) {
    if (hooked) releaseHooked('escaped');
    const sp = SPECIES_BY_ID[speciesId] || SPECIES[4];
    const p = position && Number.isFinite(position.x) ? position : lureCtx.active ? lureCtx.pos : new THREE.Vector3(0, -1.2, -14);
    const f = makeFish(sp.id, p.x, p.z, null);
    if (Number.isFinite(weightKg) && weightKg > 0) {
      f.weightKg = Math.min(weightKg, sp.weightKg.record);
      f.lengthCm = Math.round(Math.pow((f.weightKg * 1000) / sp.lw.a, 1 / sp.lw.b) * 10) / 10;
      f.lengthM = f.lengthCm / 100;
      f.bodyH = f.lengthM * (sp.bodyDepth || 0.25);
    }
    f.bottomY = terrainY(p.x, p.z);
    f.pos.set(p.x, clamp(fin(p.y, -1), f.bottomY + 0.1 + f.bodyH * 0.5, -0.06), p.z);
    f.yaw = Math.atan2(p.x, p.z + 1);
    f.debug = true; // extra fish: not replaced when it leaves the lake
    population.push(f);
    if (activeBite && !activeBite.closed) closeBite('debug');
    activeBite = { id: ++biteCounter, fish: f, windowS: 1, t: 0, closed: false };
    return hookBite(activeBite.id);
  }

  // ---------- main update ----------
  function update(frame = {}) {
    let dt = fin(frame.dt, 0);
    if (dt <= 0) return;
    dt = Math.min(dt, 0.05);
    time += dt;
    if (frame.quality && MAX_RENDERED[frame.quality]) quality = frame.quality;
    hours = fin(frame.hours, hours);
    light = lightLevel(hours);
    lowLight = lowLightLevel(hours);
    clarity = clamp(fin(water && water.clarityM, 3) / 3, 0.6, 1.3);
    readCamera(frame.camera || camera0);
    createdThisFrame = 0;

    updateLure(frame, dt);
    handleForced(dt);

    // school centroids / headings
    for (const s of schools) {
      s.cx = 0;
      s.cy = 0;
      s.cz = 0;
      s.ax = 0;
      s.az = 0;
      s.n = 0;
      if (s.excited > 0) s.excited -= dt;
      for (const f of s.members) {
        if (f.removed || f.state === 'hooked' || f.state === 'release') continue;
        s.cx += f.pos.x;
        s.cy += f.pos.y;
        s.cz += f.pos.z;
        s.ax += Math.sin(f.yaw);
        s.az += Math.cos(f.yaw);
        s.n++;
      }
      if (s.n > 0) {
        s.cx /= s.n;
        s.cy /= s.n;
        s.cz /= s.n;
        const al = Math.hypot(s.ax, s.az) || 1;
        s.ax /= al;
        s.az /= al;
      }
      s.homeT -= dt;
      if (s.homeT <= 0) {
        s.homeT = randRange(rng, 20, 50);
        const sp = SPECIES_BY_ID[s.speciesId];
        if (pickSpot(sp, { x: s.homeX, z: s.homeZ, rMin: 3, rMax: 12 }, false, spot)) {
          s.homeX = spot.x;
          s.homeZ = spot.z;
        }
      }
    }

    for (let i = 0; i < population.length; i++) {
      const f = population[i];
      if (f.removed || f.state === 'hooked') continue;
      f.senseT -= dt;
      if (f.senseT <= 0) {
        f.senseT += 0.1;
        if (f.senseT < 0) f.senseT = 0.1;
        sense(f);
      }
      // home drift / musky patrol
      if (!f.school) {
        if (f.patrol >= 0) {
          const w = MUSKY_PATROL[f.patrol];
          f.homeX = w[0];
          f.homeZ = w[1];
          if (Math.hypot(f.pos.x - w[0], f.pos.z - w[1]) < 4) f.patrol = (f.patrol + 1) % MUSKY_PATROL.length;
        } else {
          f.homeT -= dt;
          if (f.homeT <= 0) {
            f.homeT = randRange(rng, 30, 90);
            if (pickSpot(f.species, { x: f.homeX, z: f.homeZ, rMin: 2, rMax: f.homeR * 1.6 }, false, spot)) {
              f.homeX = spot.x;
              f.homeZ = spot.z;
            }
          }
        }
      }
      thinkAndMove(f, dt);
    }
    // the population array may shrink during the loop (released fish removed); that's fine

    // bite window bookkeeping when the biter was removed mid-bite
    if (activeBite && !activeBite.closed && activeBite.fish.removed) closeBite('gone');

    // recycle fish toward the lure every few seconds while it is in the water
    if (lureCtx.active && !hooked) {
      recycleT -= dt;
      if (recycleT <= 0) {
        recycleT = 6;
        ensureProspects();
      }
    }
    // respawns (always out of view)
    for (let i = respawnQueue.length - 1; i >= 0; i--) {
      const r = respawnQueue[i];
      r.t -= dt;
      if (r.t > 0) continue;
      const sp = SPECIES_BY_ID[r.speciesId];
      if (pickSpot(sp, null, true, spot)) {
        const school = r.school && r.school.members.length > 0 ? r.school : null;
        const x = school ? school.homeX : spot.x;
        const z = school ? school.homeZ : spot.z;
        const y = -Math.min(depthAt(x, z) * 0.7, 3);
        if (!school || !inView(x, y, z)) {
          const f = makeFish(r.speciesId, school ? x : spot.x, school ? z : spot.z, school);
          if (school) school.members.push(f);
          population.push(f);
          respawnQueue.splice(i, 1);
          continue;
        }
      }
      r.t = 5;
    }

    // hooked fish: landing slide, wake at the surface
    if (hooked) {
      if (hooked.landing) hooked._updateLanding(dt);
      const hp = hooked.position;
      const sy = surfaceY(hp.x, hp.z);
      const hs = Math.hypot(hooked.velocity.x, hooked.velocity.z);
      if (water && water.wake && !hooked.isJumping && hp.y > sy - 0.3 && hs > 0.35) {
        water.wake(hp.x, hp.z, hooked.velocity.x / hs, hooked.velocity.z / hs, hs);
      }
    }

    // meshes
    if (renderFish) {
      renderEvalT -= dt;
      if (renderEvalT <= 0) {
        renderEvalT = 0.25;
        evaluateRendering();
      }
      let wakes = 0;
      for (const f of population) {
        if (f.state === 'hooked') continue;
        const h = f.mesh;
        if (!h) continue;
        f.roll = damp(f.roll, -f.turnRate * 0.05, 3, dt); // slight bank into turns
        placeMesh(h, f.pos, f.yaw, f.pitch, f.roll, f.lengthCm);
        h.handle.update(dt, f.speed, f.turnRate, f.state === 'release' ? f.exhaustion : 0);
        if (wakes < 2 && water && water.wake && f.pos.y > -0.25 && f.speed > 0.4) {
          water.wake(f.pos.x, f.pos.z, Math.sin(f.yaw), Math.cos(f.yaw), f.speed);
          wakes++;
        }
      }
      if (hooked && hooked._handle) {
        placeHookedMesh(hooked);
        const sp = Math.hypot(hooked.velocity.x, hooked.velocity.y, hooked.velocity.z);
        const turn = 0;
        hooked._handle.handle.update(dt, hooked.isJumping ? 0.2 : Math.max(sp, hooked.effort * 1.5), turn + hooked.headShake01 * Math.sin(hooked._shakePhase) * 3, 1 - hooked.stamina01);
      }
    }
  }

  function dispose() {
    for (const u of unsub) if (typeof u === 'function') u();
    for (const list of pools.values()) for (const h of list) disposeHandle(h);
    pools.clear();
    for (const f of population) if (f.ownMesh) disposeHandle(f.ownMesh);
    if (hooked && hooked._handle) disposeHandle(hooked._handle);
  }

  // what HookedFish needs from the system
  const sysInternal = {
    _rng: rng,
    _terrainY: terrainY,
    _depthAt: depthAt,
    _surfaceY: surfaceY,
    _habitat: habitat,
    _emitAt(type, p, size, surfY) {
      events.emit(type, { position: new THREE.Vector3(p.x, fin(surfY, 0), p.z), size01: clamp(size, 0.05, 1) });
    },
    _placeHookedMesh: placeHookedMesh,
  };

  // initial meshes for what the player can see right away (at load time, not during play)
  if (renderFish && meshFactory === createFishMesh && typeof FishMesh.prewarmFishMeshes === 'function') {
    try {
      FishMesh.prewarmFishMeshes(Object.keys(comp), { detail: 'low', quality });
    } catch (err) {
      console.warn('[fish] prewarm failed', err);
    }
  }
  if (renderFish) {
    readCamera(camera0);
    const saved = MESH_CREATES_PER_FRAME;
    createdThisFrame = -999; // allow creating the initial set in one go
    evaluateRendering();
    createdThisFrame = 0;
    void saved;
  }

  return {
    update,
    getHooked: () => hooked,
    hookBite,
    missBite,
    releaseHooked,
    spook,
    debugForceBite,
    population,
    // extras (not in the contract, safe to ignore)
    debugHook,
    dispose,
    get activeBite() {
      return activeBite && !activeBite.closed ? { biteId: activeBite.id, fishId: activeBite.fish.id, speciesId: activeBite.fish.speciesId, windowS: activeBite.windowS, t: activeBite.t } : null;
    },
    stats() {
      let rendered = 0;
      const states = {};
      for (const f of population) {
        if (f.mesh && f.mesh.handle.object3d.visible) rendered++;
        states[f.state] = (states[f.state] || 0) + 1;
      }
      return { fish: population.length, rendered, meshes: meshCount, states, hooked: hooked ? hooked.speciesId : null };
    },
    schools,
    counters,
  };
}
