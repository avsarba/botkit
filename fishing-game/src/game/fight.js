// Fight model (core): the line between the rod tip and the hooked fish, integrated at a fixed 120 Hz.
//
//   T = k_eff * max(0, |fishMouth - rodTip| - lineOut) + c * d(stretch)/dt
//
// k_eff (40..90 N/m) is the combined spring of rod + line: the rod flexes (soft) when it is held at an
// angle to the line and stops cushioning when it points straight at the fish (stiff). The spool drag
// holds until the tension breaks it away (1.08 x the setting, with a ~50 ms lag), then pays out line so
// the tension relaxes toward the setting; cranking the handle against a slipping drag adds rotor
// friction (+12 %) and twists the line, which weakens it. That lag, the crank penalty and the twist are
// what let a big fish snap 12 lb line when the drag is locked down and the angler reels through its runs.
// Reeling only gains line while the drag holds.
//
// Rod handling matters:
//  - a rod held low or pointed straight down the line has no cushion: a head shake or a jump on a tight
//    line can tear the hook out (panfish excepted);
//  - "pump and wind": winding while lowering the rod after a lift gains line faster, while winching
//    with the rod pointed at a pulling fish gains less;
//  - side pressure against a lateral run and a high rod tire the fish faster.
// Slack line plus head shakes can throw the hook.
import * as THREE from 'three';
import { TACKLE, G, clamp, smoothstep, makeRng } from '../config.js';

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
  slackLooseM: 0.25, // ... where slack means the line also hangs this much (+ slackLooseFrac of the line out)
  slackLooseFrac: 0.02, //     longer than the rod tip -> fish distance, not just carries nothing
  minLineM: 1.0, // the fish can be reeled up to about a metre below the tip-top
  landLineM: 3.2,
  landDistM: 4.5,
  landStamina: 0.3,
  landStaminaSmall: 0.5, // panfish under this weight can be swung in a little fresher
  smallFishKg: 0.5,
  // --- rod handling ---
  stiffDot0: 0.86, // rod . line cosine where the rod starts to lose its cushion ...
  stiffDot1: 0.97, // ... and where it is pointed straight at the fish
  lowRod0: 0.06, // rodLift01 at which the rod is fully "low" (pointed down the line) ...
  lowRod1: 0.24, // ... and above which a low rod no longer costs cushion
  tearRate: 1.1, // hook-hold wear per second at full stiffness, a full head shake and a hard spike
  holdMin: 0.7, // hook hold after the hookset: 0.7 .. 1 (how well the hook went in); 0 = it pulls out
  tearSpike0: 0.16, // tension (fraction of line test) where a spike starts to threaten the hook hold ...
  tearSpike1: 0.46, // ... and where it is at its worst
  tearSlipping: 0.35, // a slipping drag absorbs part of the jerk
  pumpBoost: 0.9, // extra retrieve per unit of rod-lowering speed (rodLift01 per second) ...
  pumpMax: 0.9, // ... capped at +90 % of the reel speed
  stiffReel: 0.4, // retrieve lost when winching a pulling fish with the rod pointed at it
  sideW: 2.1, // stamina bonus weight: side pressure against a lateral run (was 0.7)
  liftW: 0.6, // stamina bonus weight: a high rod (was 0.3)
  // --- line twist: cranking against a slipping drag twists the line and weakens it ---
  twistFrom: 8, // metres of line cranked against the drag before it starts to weaken ...
  twistFull: 30, // ... and where it has lost twistLoss of its strength
  twistLoss: 0.35,
  twistRelax: 0.25, // m/s the twist relaxes while the angler stops cranking through runs
  twistWarn: 5, // the HUD starts warning here
});

// How easily the hook wears loose, by species (1 = typical). Trout and walleye have soft mouths;
// pike and musky bony jaws that hold a well-set hook; a catfish's tough, rubbery mouth rarely tears.
const HOOK_WEAR = Object.freeze({
  yellow_perch: 1,
  rainbow_trout: 1.25,
  smallmouth_bass: 1,
  largemouth_bass: 0.9,
  walleye: 1.25,
  channel_catfish: 0.3,
  northern_pike: 0.35,
  muskellunge: 0.35,
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
    // rod handling (read by core for the HUD)
    rodDot: 0, // cos(angle) between the rod (butt -> tip) and the line (tip -> fish)
    stiff01: 0, // 0 = rod bent well away from the line, 1 = pointed straight at the fish / held low
    exposed01: 0, // stiff rod x head shake / jump: the hook hold is at risk
    liftVel: 0, // rodLift01 per second (smoothed); < 0 while the rod is being lowered
    prevLift: NaN,
    pumping: false, // winding on the drop right now
    twist: 0, // metres of line cranked against a slipping drag (line twist)
    breakN: TACKLE.lineBreakN, // current break strength (line twist lowers it)
    hookHold: 1, // 1 = well set; head shakes on a stiff rod wear it down, 0 = the hook pulls out
    lastOut: null, // the last outcome, for tests
  };
  const stepInput = { tensionN: 0, pullDir: _pull, rodTip: new THREE.Vector3(), lineOutM: 10 };

  let wear = 1;
  function begin(hooked, rodTip, lineOutM) {
    s.active = true;
    const sp = hooked.species || {};
    wear = Number.isFinite(sp.hookWear) ? sp.hookWear : HOOK_WEAR[hooked.speciesId || sp.id] ?? 1;
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
    s.rodDot = 0;
    s.stiff01 = 0;
    s.exposed01 = 0;
    s.liftVel = 0;
    s.prevLift = NaN;
    s.pumping = false;
    s.twist = 0;
    s.breakN = TACKLE.lineBreakN;
    s.hookHold = FIGHT.holdMin + (1 - FIGHT.holdMin) * rng();
    s.lastOut = null;
  }

  function end() {
    s.active = false;
    s.tensionN = 0;
    s.slipMps = 0;
    s.slipping = false;
    s.exposed01 = 0;
    s.pumping = false;
  }

  // Rod stiffness from the angle between the rod (butt -> tip) and the line (tip -> fish).
  function stiffness(rodDir, lineDir) {
    const c = clamp(rodDir.dot(lineDir), 0, 1);
    return FIGHT.kMin + (FIGHT.kMax - FIGHT.kMin) * c;
  }

  // One fixed substep. inp = { hooked, rodTip, rodDir, dragN, reeling, reelMps, rodSide, rodLift01, rightX, rightZ }
  // Returns null or an outcome { type: 'snap', tensionN } | { type: 'escape', reason, pulled? } | { type: 'spooled' }.
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

    // rod cushion: pointed straight down the line, or held low, the rod no longer absorbs jerks
    const dot = clamp(inp.rodDir.dot(_d), -1, 1);
    const lift = clamp(Number.isFinite(inp.rodLift01) ? inp.rodLift01 : 0.4, 0, 1);
    s.rodDot = dot;
    const stiff = Math.max(smoothstep(FIGHT.stiffDot0, FIGHT.stiffDot1, dot), 1 - smoothstep(FIGHT.lowRod0, FIGHT.lowRod1, lift));
    s.stiff01 = stiff;

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

    // line twist: every metre the spool gives while the handle turns puts twist in the line
    if (cranking && s.slipping) s.twist += (s.slipMps + 0.5 * Math.max(0, inp.reelMps)) * h;
    else if (!cranking) s.twist = Math.max(0, s.twist - FIGHT.twistRelax * h);
    s.breakN = TACKLE.lineBreakN * (1 - FIGHT.twistLoss * smoothstep(FIGHT.twistFrom, FIGHT.twistFull, s.twist));

    // 4) reeling gains line only while the drag holds. Winching a pulling fish with the rod pointed at
    //    it gains less; winding while lowering the rod after a lift ("pump and wind") gains more.
    s.pumping = false;
    if (cranking && !s.slipping && T < dragN) {
      let gain = Math.max(0, inp.reelMps);
      const load = smoothstep(0.15, 0.6, T / Math.max(1, dragN));
      gain *= 1 - FIGHT.stiffReel * stiff * load;
      if (s.liftVel < -0.15) {
        gain *= 1 + Math.min(FIGHT.pumpMax, -s.liftVel * FIGHT.pumpBoost);
        s.pumping = true;
      }
      s.lineOut = Math.max(FIGHT.minLineM, s.lineOut - gain * h);
    }

    s.tensionN = T;
    if (T > s.peakN) s.peakN = T;
    s.t += h;

    // 5) side pressure against the fish's run and a raised rod wear it down faster
    const mg = Math.max(0.05, f.weightKg) * G;
    const tRel = Math.min(T / mg, 4);
    if (tRel > 0.02 && !f.isJumping) {
      const lat = f.velocity.x * inp.rightX + f.velocity.z * inp.rightZ; // + = fish moving right
      // only while the rod is swept to the side opposite the run
      const oppose = clamp(-clamp(inp.rodSide, -1, 1) * Math.sign(lat) * Math.min(1, Math.abs(lat) / 0.6), 0, 1);
      const cap = Number.isFinite(f._cap) && f._cap > 0 ? f._cap : 10;
      const effort = Number.isFinite(f.effort) ? f.effort : 0.5;
      const bonus = (0.12 * tRel * (FIGHT.sideW * oppose + FIGHT.liftW * lift * (1 - stiff)) * (0.4 + effort)) / cap;
      f.stamina01 = clamp(f.stamina01 - bonus * h, 0, 1);
    }

    // 6) outcomes
    if (T > s.breakN) {
      s.overT += h;
      if (s.overT > FIGHT.snapHoldS) return { type: 'snap', tensionN: T };
    } else if (T < s.breakN * 0.97) s.overT = 0;
    if (s.lineOut > TACKLE.spoolCapacityM) return { type: 'spooled', tensionN: T };

    // hook pull-out: head shakes and jumps on a tight line with no rod cushion work the hook loose
    // (the hole wears and never heals); a big enough jerk on a worn hold tears it free
    const shake = f.isJumping ? 1 : clamp(f.headShake01 || 0, 0, 1);
    s.exposed01 = f.weightKg >= FIGHT.smallFishKg ? stiff * smoothstep(0.3, 0.75, shake) : 0;
    if (s.exposed01 > 0.02) {
      const spike = smoothstep(FIGHT.tearSpike0, FIGHT.tearSpike1, T / TACKLE.lineBreakN);
      s.hookHold -= FIGHT.tearRate * wear * s.exposed01 * spike * (s.slipping ? FIGHT.tearSlipping : 1) * h;
      if (s.hookHold <= 0) return { type: 'escape', reason: 'headshake', pulled: true };
    }

    // slack: the line carries (almost) nothing AND hangs loose. A small panfish towed in on a steady
    // retrieve bounces along a nearly taut line (a tug, then a few cm of give, on a fraction of a newton):
    // that is not slack and must not throw the hook or call for "reel!" while the angler is reeling.
    if (T < Math.min(FIGHT.slackN, 0.1 * mg) && stretch < -(FIGHT.slackLooseM + FIGHT.slackLooseFrac * s.lineOut)) s.slackT += h;
    else s.slackT = Math.max(0, s.slackT - 3 * h);
    if (s.slackT > FIGHT.slackThrowS) {
      const loose = (f.headShake01 || 0) + (f.isJumping ? 0.6 : 0);
      if (loose > 0.3 && rng() < h * 2.2 * (loose - 0.3)) return { type: 'escape', reason: 'headshake' };
    }
    if (s.slackT > FIGHT.slackLongS) return { type: 'escape', reason: 'slack' };
    return null;
  }

  // Integrate dt of game time in fixed substeps. Returns the first outcome (or null).
  function advance(dt, inp) {
    if (!s.active) return null;
    // how fast the rod is being raised / lowered (per frame, smoothed): drives "pump and wind"
    const lift = clamp(Number.isFinite(inp.rodLift01) ? inp.rodLift01 : 0.4, 0, 1);
    if (Number.isFinite(s.prevLift) && dt > 1e-4) s.liftVel += ((lift - s.prevLift) / dt - s.liftVel) * (1 - Math.exp(-dt * 12));
    else s.liftVel = 0;
    s.prevLift = lift;
    s.acc += dt;
    const step = 1 / FIGHT.hz;
    let guard = 0;
    while (s.acc >= step && guard++ < 64) {
      s.acc -= step;
      const out = substep(step, inp);
      if (out) {
        s.acc = 0;
        s.lastOut = out;
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
