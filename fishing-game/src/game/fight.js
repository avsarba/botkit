// Fight model (core): the line between the rod tip and the hooked fish, integrated at a fixed 120 Hz.
//
//   T = k_eff * max(0, |fishMouth - rodTip| - lineOut) + c * d(stretch)/dt
//
// k_eff (40..90 N/m) is the combined spring of rod + line: the rod flexes (soft) when it is held at an
// angle to the line and stops cushioning when it points straight at the fish (stiff). The spool drag
// holds until the tension breaks it away (1.08 x the setting, with a ~50 ms lag), then pays out line so
// the tension relaxes toward the setting; cranking the handle against a slipping drag adds rotor
// friction (+12 %). That lag and the crank penalty are what let a big fish snap 12 lb line when the
// drag is locked down and the angler reels through its runs. Reeling only gains line while the drag
// holds. Slack line plus head shakes can throw the hook; side pressure and a high rod tire the fish.
import * as THREE from 'three';
import { TACKLE, G, clamp, makeRng } from '../config.js';

export const FIGHT = Object.freeze({
  hz: 120,
  kMin: 40, // N/m, rod bent well away from the line (lots of cushion)
  kMax: 90, // N/m, rod pointed straight down the line
  damping: 3, // N*s/m on the stretch rate
  breakaway: 1.08, // static drag friction over the setting
  slipLagS: 0.05, // spool reaction lag
  crankBoost: 1.12, // cranking against a slipping drag
  snapHoldS: 0.12, // over the line's break strength this long -> snap
  slackN: 1, // below this the line is slack
  slackThrowS: 2.5, // slack this long + a head shake can throw the hook
  slackLongS: 5.5, // slack this long and the hook just falls out
  minLineM: 1.0, // the fish can be reeled up to about a metre below the tip-top
  landLineM: 3.2,
  landDistM: 4.5,
  landStamina: 0.3,
  landStaminaSmall: 0.5, // panfish under this weight can be swung in a little fresher
  smallFishKg: 0.5,
});

const _d = new THREE.Vector3();
const _pull = new THREE.Vector3();

export function createFightModel(opts = {}) {
  const rng = makeRng(opts.seed ?? ((Math.random() * 1e9) | 0));
  const s = {
    active: false,
    lineOut: 10,
    tensionN: 0,
    slipMps: 0,
    slipping: false,
    overT: 0,
    slackT: 0,
    peakN: 0,
    k: 60,
    stretch: 0,
    prevStretch: 0,
    hasPrev: false,
    distM: 0,
    acc: 0,
    t: 0,
  };
  const stepInput = { tensionN: 0, pullDir: _pull, rodTip: new THREE.Vector3(), lineOutM: 10 };

  function begin(hooked, rodTip, lineOutM) {
    s.active = true;
    const d = hooked.position.distanceTo(rodTip);
    s.lineOut = clamp(Number.isFinite(lineOutM) ? lineOutM : d, FIGHT.minLineM, TACKLE.spoolCapacityM);
    s.tensionN = 0;
    s.slipMps = 0;
    s.slipping = false;
    s.overT = 0;
    s.slackT = 0;
    s.peakN = 0;
    s.hasPrev = false;
    s.acc = 0;
    s.t = 0;
    s.distM = d;
  }

  function end() {
    s.active = false;
    s.tensionN = 0;
    s.slipMps = 0;
    s.slipping = false;
  }

  // Rod stiffness from the angle between the rod (butt -> tip) and the line (tip -> fish).
  function stiffness(rodDir, lineDir) {
    const c = clamp(rodDir.dot(lineDir), 0, 1);
    return FIGHT.kMin + (FIGHT.kMax - FIGHT.kMin) * c;
  }

  // One fixed substep. inp = { hooked, rodTip, rodDir, dragN, reeling, reelMps, rodSide, rodLift01, rightX, rightZ }
  // Returns null or an outcome { type: 'snap', tensionN } | { type: 'escape', reason } | { type: 'spooled' }.
  function substep(h, inp) {
    const f = inp.hooked;
    const tip = inp.rodTip;
    // 1) the fish moves under the tension of the previous substep
    _pull.subVectors(tip, f.position);
    const pl = _pull.length();
    if (pl > 1e-6) _pull.multiplyScalar(1 / pl);
    else _pull.set(0, 1, 0);
    stepInput.tensionN = s.tensionN;
    stepInput.rodTip.copy(tip);
    stepInput.lineOutM = s.lineOut;
    f.step(h, stepInput);

    // 2) line geometry and tension
    _d.subVectors(f.position, tip);
    const d = _d.length();
    s.distM = d;
    if (d > 1e-6) _d.multiplyScalar(1 / d);
    s.k = stiffness(inp.rodDir, _d);
    const stretch = d - s.lineOut;
    const rate = s.hasPrev ? (stretch - s.prevStretch) / h : 0;
    s.prevStretch = stretch;
    s.hasPrev = true;
    let T = stretch > 0 ? Math.max(0, s.k * stretch + FIGHT.damping * rate) : 0;
    if (!Number.isFinite(T)) T = 0;

    // 3) drag: breaks away a little above the setting after a short lag, then pays out line so the
    //    excess stretch relaxes (first order, ~50 ms); cranking against it adds rotor friction
    const dragN = inp.dragN;
    const cranking = !!inp.reeling;
    const effDrag = dragN * (cranking && s.slipping ? FIGHT.crankBoost : 1);
    const lag = 1 - Math.exp(-h / FIGHT.slipLagS);
    const breakaway = s.slipping ? effDrag : dragN * FIGHT.breakaway;
    let paid = 0;
    if (T > breakaway) {
      s.slipping = true;
      paid = Math.max(0, ((T - effDrag) / s.k) * lag);
      s.lineOut += paid;
    } else if (T < dragN * 0.92) s.slipping = false;
    s.slipMps += (paid / h - s.slipMps) * (1 - Math.exp(-h / 0.06));
    if (s.slipMps < 1e-3) s.slipMps = 0;

    // 4) reeling gains line only while the drag holds
    if (cranking && !s.slipping && T < dragN) s.lineOut = Math.max(FIGHT.minLineM, s.lineOut - Math.max(0, inp.reelMps) * h);

    s.tensionN = T;
    if (T > s.peakN) s.peakN = T;
    s.t += h;

    // 5) side pressure against the fish's run and a raised rod wear it down faster
    const mg = Math.max(0.05, f.weightKg) * G;
    const tRel = Math.min(T / mg, 4);
    if (tRel > 0.02 && !f.isJumping) {
      const lat = f.velocity.x * inp.rightX + f.velocity.z * inp.rightZ; // + = fish moving right
      const oppose = clamp(-clamp(inp.rodSide, -1, 1) * Math.sign(lat) * Math.min(1, Math.abs(lat) / 0.6), 0, 1);
      const lift = clamp(inp.rodLift01, 0, 1);
      const cap = Number.isFinite(f._cap) && f._cap > 0 ? f._cap : 10;
      const effort = Number.isFinite(f.effort) ? f.effort : 0.5;
      const bonus = (0.12 * tRel * (0.7 * oppose + 0.3 * lift) * (0.4 + effort)) / cap;
      f.stamina01 = clamp(f.stamina01 - bonus * h, 0, 1);
    }

    // 6) outcomes
    if (T > TACKLE.lineBreakN) {
      s.overT += h;
      if (s.overT > FIGHT.snapHoldS) return { type: 'snap', tensionN: T };
    } else if (T < TACKLE.lineBreakN * 0.97) s.overT = 0;
    if (s.lineOut > TACKLE.spoolCapacityM) return { type: 'spooled', tensionN: T };
    // slack: the line carries (almost) nothing; a small panfish is towed in on a fraction of a newton
    if (T < Math.min(FIGHT.slackN, 0.1 * mg)) s.slackT += h;
    else s.slackT = Math.max(0, s.slackT - 3 * h);
    if (s.slackT > FIGHT.slackThrowS) {
      const shake = (f.headShake01 || 0) + (f.isJumping ? 0.6 : 0);
      if (shake > 0.3 && rng() < h * 2.2 * (shake - 0.3)) return { type: 'escape', reason: 'headshake' };
    }
    if (s.slackT > FIGHT.slackLongS) return { type: 'escape', reason: 'slack' };
    return null;
  }

  // Integrate dt of game time in fixed substeps. Returns the first outcome (or null).
  function advance(dt, inp) {
    if (!s.active) return null;
    s.acc += dt;
    const step = 1 / FIGHT.hz;
    let guard = 0;
    while (s.acc >= step && guard++ < 64) {
      s.acc -= step;
      const out = substep(step, inp);
      if (out) {
        s.acc = 0;
        return out;
      }
    }
    return null;
  }

  // Landing: short line, fish close to the dock and tired.
  function canLand(hooked, eye) {
    const dx = hooked.position.x - eye.x;
    const dz = hooked.position.z - eye.z;
    const tired = hooked.stamina01 < (hooked.weightKg < FIGHT.smallFishKg ? FIGHT.landStaminaSmall : FIGHT.landStamina);
    return s.lineOut < FIGHT.landLineM && Math.hypot(dx, dz) < FIGHT.landDistM && tired;
  }

  return {
    state: s,
    begin,
    end,
    advance,
    canLand,
    addSlack(m) {
      s.lineOut = clamp(s.lineOut + Math.max(0, m), FIGHT.minLineM, TACKLE.spoolCapacityM);
    },
    get tensionN() {
      return s.tensionN;
    },
    get lineOutM() {
      return s.lineOut;
    },
    get slipMps() {
      return s.slipMps;
    },
  };
}
