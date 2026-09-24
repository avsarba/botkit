// Continuous tackle sounds that follow the frame: reel whir, drag zing, line hum + rod creaks.
// Each is a lazily built Loop (no nodes exist until the sound is first needed; torn down when idle).
import { clamp, smoothstep } from '../config.js';
import { Loop, loopKit } from './dsp.js';
import { LV } from './levels.js';

// 6.2:1 spinning reel at ~1.5 handle turns/s at full retrieve -> ~9.3 rotor turns/s.
const ROTOR_HZ_FULL = 9.3;
// Drag clicker: ~0.14 m of line per spool turn, ~20 clicker teeth -> ~140 clicks per metre of line.
const CLICKS_PER_M = 140;

export function createTackleLoops(eng) {
  const reel = new Loop(eng, eng.tackle, (e, t) => {
    const k = loopKit(e, t);
    const mix = k.gain(1);
    const pan = k.panner(0.3); // reel sits under the right hand
    k.chain(mix, pan, k.out);
    // bearing / gear hiss, swelling once per rotor turn
    const n = k.noise('pink');
    const bp = k.filter('bandpass', 1800, 1.3);
    const am = k.gain(0.7);
    const lfo = k.osc('sine', ROTOR_HZ_FULL);
    const lfoG = k.gain(0.18);
    lfo.connect(lfoG);
    lfoG.connect(am.gain);
    const ng = k.gain(0.9);
    k.chain(n, bp, am, ng, mix);
    // gear mesh hum
    const gear = k.osc('sawtooth', 100);
    const gbp = k.filter('bandpass', 650, 1.2);
    const gg = k.gain(0.22);
    k.chain(gear, gbp, gg, mix);
    // faint ticks from the line roller / oscillation gear
    const tick = k.osc('sawtooth', ROTOR_HZ_FULL);
    const thp = k.filter('highpass', 3500, 0.8);
    const tg = k.gain(0.35);
    k.chain(tick, thp, tg, mix);
    Object.assign(k, { bp, lfo, gear, tick });
    return k;
  });

  const drag = new Loop(eng, eng.tackle, (e, t) => {
    const k = loopKit(e, t);
    const pan = k.panner(0.28);
    pan.connect(k.out);
    const saw = k.osc('sawtooth', 60);
    const hp = k.filter('highpass', 1900, 0.7);
    const pk = k.filter('peaking', 3400, 3, 9);
    const g = k.gain(1);
    k.chain(saw, hp, pk, g, pan);
    // line hissing off the spool
    const n = k.noise('white');
    const nbp = k.filter('bandpass', 5500, 0.9);
    const ng = k.gain(0);
    k.chain(n, nbp, ng, pan);
    Object.assign(k, { saw, ng });
    return k;
  });

  const hum = new Loop(eng, eng.tackle, (e, t) => {
    const k = loopKit(e, t);
    const tri = k.osc('triangle', 150);
    const vib = k.osc('sine', 5.5);
    const vg = k.gain(2);
    vib.connect(vg);
    vg.connect(tri.frequency);
    const bp = k.filter('bandpass', 300, 5);
    const pan = k.panner(0.12);
    k.chain(tri, bp, pan, k.out);
    Object.assign(k, { tri, bp });
    return k;
  });

  let lastRotor = -1;
  let lastDragT = -1;
  let lastHumF = -1;
  let creakNext = 0;
  const creakP = { amount: 0 };

  function tick(now, s, snap) {
    // ---- reel whir
    const sp = s.reeling ? clamp(s.reelSpeed01, 0.05, 1) : 0;
    reel.set(sp > 0 ? LV.reel * (0.35 + 0.65 * sp) : 0, now, 0.035, 0.07, snap);
    if (reel.p && sp > 0) {
      const rotor = ROTOR_HZ_FULL * sp;
      if (Math.abs(rotor - lastRotor) > 0.04 * lastRotor + 0.01 || !reel.p.tuned) {
        const p = reel.p;
        p.tuned = true;
        lastRotor = rotor;
        p.lfo.frequency.setTargetAtTime(rotor, now, 0.05);
        p.tick.frequency.setTargetAtTime(rotor, now, 0.05);
        p.gear.frequency.setTargetAtTime(rotor * 11, now, 0.05);
        p.bp.frequency.setTargetAtTime(1300 + 900 * sp, now, 0.05);
      }
    }

    // ---- drag: click rate follows the slip speed; mechanical jitter
    const slip = s.slipMps;
    const on = slip > 0.02;
    drag.set(on ? LV.drag * (0.55 + 0.45 * clamp(slip / 2.5, 0, 1)) : 0, now, 0.012, 0.06, snap);
    if (drag.p && on && (now - lastDragT > 0.03 || now < lastDragT || !drag.p.tuned)) {
      drag.p.tuned = true;
      lastDragT = now;
      const f = clamp(slip * CLICKS_PER_M, 12, 650) * (1 + (eng.rng() - 0.5) * 0.07);
      drag.p.saw.frequency.setTargetAtTime(f, now, 0.02);
      drag.p.ng.gain.setTargetAtTime(0.08 * clamp(slip / 3, 0, 1), now, 0.05);
    }

    // ---- line hum under heavy load, and the rod creaking
    const t01 = s.tension01;
    const hl = smoothstep(0.58, 1, t01);
    hum.set(hl > 0 ? LV.hum * hl : 0, now, 0.15, 0.25, snap);
    if (hum.p && hl > 0) {
      const f = 120 + 280 * clamp((t01 - 0.6) / 0.4, 0, 1);
      if (Math.abs(f - lastHumF) > 3 || !hum.p.tuned) {
        hum.p.tuned = true;
        lastHumF = f;
        hum.p.tri.frequency.setTargetAtTime(f, now, 0.1);
        hum.p.bp.frequency.setTargetAtTime(f * 2, now, 0.1);
      }
    }
    if (t01 > 0.72) {
      if (now >= creakNext) {
        const a = (t01 - 0.72) / 0.28;
        creakP.amount = a;
        if (creakNext > 0) eng.play('creak', creakP, now + 0.01);
        creakNext = now + eng.rr(0.3, 1.6) / (0.5 + 2 * clamp(a, 0, 1));
      }
    } else creakNext = 0;
  }

  function dispose() {
    reel.teardown();
    drag.teardown();
    hum.teardown();
  }

  return { tick, dispose, layers: { reel, drag, hum } };
}
