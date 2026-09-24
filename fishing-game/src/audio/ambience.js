// Lake ambience driven by the time of day: water lapping at the dock pilings, wind in the pines,
// cicadas at midday, crickets at night (continuous Loops, built lazily, crossfaded), plus scheduled
// wildlife (dawn chorus, loons, peepers, green frogs, barred owl, water clucks).
// Scheduling uses the context clock with a short lookahead, so it works identically in a live
// AudioContext and in an OfflineAudioContext driven by suspend()/resume() in the sandbox.
import { clamp } from '../config.js';
import { Loop, loopKit, bump, pulseWave, hit } from './dsp.js';
import { LV } from './levels.js';

const LOOK = 0.3; // seconds of lookahead for scheduled events

// Time-of-day profiles, 0..1 (loon: calls per second).
export const PROFILE = {
  dawn: (h) => bump(h, 4.2, 5.2, 7.5, 10),
  day: (h) => bump(h, 8, 10, 17, 19),
  eve: (h) => bump(h, 18.3, 19.3, 20.6, 21.5),
  loon: (h) => (1.6 * bump(h, 4.2, 5, 7, 8.5) + 1.5 * bump(h, 19, 20, 22.5, 23.5) + 0.7 * bump(h, 22.5, 23.5, 27.8, 28.6) + 0.12) / 60,
  insects: (h) => bump(h, 9.5, 12, 16.5, 19.5),
  crickets: (h) => bump(h, 18.6, 20.6, 27.5, 29.5),
  peepers: (h) => bump(h, 19.2, 20.6, 22.5, 24.8),
  frogs: (h) => bump(h, 18.5, 20, 23.5, 25.5),
  owl: (h) => bump(h, 21.5, 23, 27.5, 28.8),
};

// Songbirds: relative singing weight at dawn / day / evening, individuals, distance range (m).
const BIRDS = [
  { name: 'bird:whitethroat', dawn: 1.0, day: 0.35, eve: 0.55, n: 2, d: [30, 110] },
  { name: 'bird:robin', dawn: 1.0, day: 0.2, eve: 0.7, n: 2, d: [25, 90] },
  { name: 'bird:chickadee', dawn: 0.45, day: 0.5, eve: 0.1, n: 2, d: [15, 60] },
  { name: 'bird:trill', dawn: 0.7, day: 0.45, eve: 0.15, n: 2, d: [20, 80] },
  { name: 'bird:vireo', dawn: 0.35, day: 1.0, eve: 0.2, n: 1, d: [30, 90] },
  { name: 'bird:thrush', dawn: 0.35, day: 0.03, eve: 1.0, n: 1, d: [50, 140] },
];

// opts.only: optional list of layer names to keep (sandbox solo renders):
// water, wind, insects, crickets, birds, loons, peepers, frogs, owl.
export function createAmbience(eng, opts = {}) {
  const { rng, rr } = eng;
  const only = Array.isArray(opts.only) ? opts.only : null;
  const on = (n) => (!only || only.includes(n) ? 1 : 0);
  const ON = { water: on('water'), wind: on('wind'), insects: on('insects'), crickets: on('crickets'), birds: on('birds'), loons: on('loons'), peepers: on('peepers'), frogs: on('frogs'), owl: on('owl') };
  const hq = eng.quality === 'high';
  const lq = eng.quality === 'low';
  const density = hq ? 1 : lq ? 0.55 : 0.8;
  const maxBirds = hq ? 5 : lq ? 2 : 4;

  // --------------------------------------------------------------- individuals (fixed in the world)
  // Direction angle a: 0 = +X (right at yaw 0), PI/2 = +Z (behind, the shore), PI = -X (left).
  const at = (a, dist) => ({ dx: Math.cos(a), dz: Math.sin(a), dist, level: 1, pitch: 1, variant: rng(), busy: 0 });
  const landInd = (d) => {
    const i = at(rr(-0.35, Math.PI + 0.35), rr(d[0], d[1]));
    i.level = clamp(Math.pow(40 / i.dist, 0.6), 0.35, 1.25);
    i.pitch = rr(0.95, 1.05);
    return i;
  };
  const birds = BIRDS.map((b) => ({ ...b, w: 0, inds: Array.from({ length: b.n }, () => landInd(b.d)) }));
  const loons = [at(rr(3.6, 4.4), rr(220, 380)), at(rr(4.9, 5.8), rr(160, 420))];
  for (const l of loons) l.pitch = rr(0.95, 1.05);
  const peepers = Array.from({ length: hq ? 7 : lq ? 3 : 5 }, () => {
    const p = at(rr(Math.PI * 0.55, Math.PI * 1.12), rr(18, 80)); // the weedy cove on the left, and behind
    p.freq = rr(2700, 3150);
    p.period = rr(0.85, 1.4);
    p.base = clamp(Math.pow(30 / p.dist, 0.7), 0.3, 1.2);
    p.next = 0;
    return p;
  });
  const frog = at(rr(Math.PI * 0.85, Math.PI * 1.08), rr(15, 45));
  frog.pitch = rr(0.9, 1.1);
  const owlInd = at(rr(0.3, Math.PI - 0.3), rr(150, 320));
  const piling = at(0, 1.5);

  // --------------------------------------------------------------- continuous layers
  // Water against the dock: every small wind wavelet makes a slap on a post, a short wash along the
  // planks and a sparkle as it drains back; now and then a hollow gurgle (a cluck voice).
  // Two noise sources shared by both sides keep the node count low.
  const water = new Loop(eng, eng.amb, (e, t) => {
    const k = loopKit(e, t);
    const pink = k.noise('pink');
    const white = k.noise('white');
    const bedBp = k.filter('bandpass', 520, 0.8);
    const bed = k.gain(0.1);
    k.chain(pink, bedBp, bed, k.out);
    k.sides = (lq ? [0] : [-1, 1]).map((side) => {
      const pan = k.panner(side * 0.6);
      pan.connect(k.out);
      const wlp = k.filter('bandpass', 600, 0.8);
      const wash = k.gain(0);
      k.chain(pink, wlp, wash, pan);
      const sbp = k.filter('bandpass', 900, 1.1);
      const slap = k.gain(0);
      k.chain(pink, sbp, slap, pan);
      const tbp = k.filter('bandpass', 3200, 0.9);
      const tr = k.gain(0);
      k.chain(white, tbp, tr, pan);
      return { wlp, wash, sbp, slap, tr, next: t + rng() * 1.2 };
    });
    return k;
  });

  // Wind in the pines: two decorrelated broad bands (left / right) that swell with slow gusts, plus
  // the higher hiss of needles that only comes up in the stronger gusts.
  const wind = new Loop(eng, eng.amb, (e, t) => {
    const k = loopKit(e, t);
    k.bands = (lq ? [0] : [-1, 1]).map((side) => {
      const src = k.noise('pink');
      const bp = k.filter('bandpass', 700, 0.6);
      const g = k.gain(0.3);
      const pan = k.panner(side * 0.7);
      k.chain(src, bp, g, pan, k.out);
      const nbp = k.filter('bandpass', 3800, 0.7);
      const ng = k.gain(0.02);
      k.chain(src, nbp, ng, pan);
      return { bp, g, ng };
    });
    k.next = t;
    return k;
  });

  const insects = new Loop(eng, eng.amb, (e, t) => {
    const k = loopKit(e, t);
    const specs = [
      [4400, 118, -0.55],
      [5150, 141, 0.5],
    ].slice(0, hq ? 2 : 1);
    k.voices = specs.map(([f, am, p]) => {
      const src = k.noise('white');
      const bp = k.filter('bandpass', f, 9);
      const amg = k.gain(0.6);
      const lfo = k.osc('sine', am * rr(0.97, 1.03));
      const lfoG = k.gain(0.4);
      lfo.connect(lfoG);
      lfoG.connect(amg.gain);
      const swell = k.gain(0);
      const pan = k.panner(p);
      k.chain(src, bp, amg, swell, pan, k.out);
      return { bp, swell, f, next: t + rng() * 2 };
    });
    // faint high meadow hiss (grasshoppers, distant insects)
    const bed = k.noise('white');
    const bbp = k.filter('bandpass', 6800, 1.2);
    const bg = k.gain(0.06);
    k.chain(bed, bbp, bg, k.out);
    return k;
  });

  const crickets = new Loop(eng, eng.amb, (e, t) => {
    const k = loopKit(e, t);
    const specs = [
      { f: 4650, pulse: 29, pDuty: 0.45, chirp: 2.4, cDuty: 0.3, pan: -0.45, lvl: 1 }, // field cricket
      { f: 2950, pulse: 46, pDuty: 0.5, chirp: 2.05, cDuty: 0.42, pan: 0.5, lvl: 0.65 }, // snowy tree crickets
      { f: 4380, pulse: 27, pDuty: 0.45, chirp: 3.1, cDuty: 0.26, pan: 0.15, lvl: 0.45 }, // a distant one
    ].slice(0, hq ? 3 : lq ? 1 : 2);
    for (const s of specs) {
      const car = k.osc('sine', s.f * rr(0.985, 1.015));
      const pw = pulseWave(e.ac, s.pDuty, 16);
      const cw = pulseWave(e.ac, s.cDuty, 24);
      const pg = k.gain(pw.mean);
      const pl = k.osc('custom', s.pulse * rr(0.95, 1.05), pw.wave);
      pl.connect(pg.gain);
      const cg = k.gain(cw.mean);
      const cl = k.osc('custom', s.chirp * rr(0.95, 1.05), cw.wave);
      cl.connect(cg.gain);
      const lg = k.gain(s.lvl);
      const pan = k.panner(s.pan);
      k.chain(car, pg, cg, lg, pan, k.out);
    }
    return k;
  });

  // --------------------------------------------------------------- schedulers
  const gen = { bird: 0, birdRate: 0, loon: 0, loonRate: 0, frog: 0, owl: 0, cluck: 0, answerT: -1, answerName: '', answerInd: null };
  let lastLevels = -1;
  let lastRates = -1;
  let first = true;

  // exponential waiting time for a Poisson process of `rate` events/s (1 s re-check when silent)
  const wait = (rate, lo, hi) => (rate > 1e-4 ? clamp(-Math.log(1 - rng() * 0.999) / rate, lo, hi) : 1);

  function schedWater(now, w) {
    const p = water.p;
    if (!p) return;
    for (const s of p.sides) {
      while (s.next < now + LOOK) {
        const tn = Math.max(s.next, now + 0.02);
        const P = rr(1.2, 2.6) / (0.75 + 0.6 * w); // small wind-chop period
        const A = rr(0.25, 1);
        s.sbp.frequency.setValueAtTime(rr(600, 1300), tn);
        hit(s.slap.gain, tn, A, rr(0.006, 0.02), rr(0.05, 0.12));
        if (rng() < 0.3) hit(s.slap.gain, tn + rr(0.12, 0.25), A * rr(0.3, 0.6), 0.008, 0.06);
        s.wash.gain.setTargetAtTime(A * 0.55, tn + 0.02, 0.09);
        s.wash.gain.setTargetAtTime(0.06, tn + 0.3, rr(0.25, 0.5));
        s.wlp.frequency.setTargetAtTime(550 + 700 * A, tn, 0.05);
        s.wlp.frequency.setTargetAtTime(420, tn + 0.3, 0.3);
        hit(s.tr.gain, tn + rr(0.08, 0.2), A * A * 0.3, 0.02, rr(0.08, 0.2));
        if (rng() < 0.55 * A && eng.canAmbient()) {
          piling.dx = rr(-1, 1);
          piling.dz = rr(-0.6, 1);
          piling.dist = rr(0.8, 2.5);
          piling.amp = A * rr(0.5, 1);
          piling.kind = null;
          eng.play('cluck', piling, tn + rr(0.1, 0.5));
        }
        s.next = tn + P;
      }
    }
  }

  function schedWind(now) {
    const p = wind.p;
    if (!p) return;
    while (p.next < now + LOOK) {
      const tn = Math.max(p.next, now + 0.02);
      const base = Math.pow(rng(), 1.3); // mostly gentle, now and then a real gust
      const tau = rr(1.2, 3);
      for (let i = 0; i < p.bands.length; i++) {
        const b = p.bands[i];
        const gg = clamp(0.3 + 0.7 * base + rr(-0.1, 0.1), 0.1, 1);
        const ti = tn + i * rr(0, 0.6);
        b.g.gain.setTargetAtTime(gg, ti, tau);
        b.bp.frequency.setTargetAtTime(380 + 900 * gg, ti, tau * 1.2);
        b.ng.gain.setTargetAtTime(0.25 * gg * gg, ti, tau);
      }
      p.next = tn + rr(2.5, 7);
    }
  }

  function schedInsects(now) {
    const p = insects.p;
    if (!p) return;
    for (const c of p.voices) {
      while (c.next < now + LOOK) {
        // one dog-day cicada call: a slow swell, a whining hold, a fade
        const tn = Math.max(c.next, now + 0.02);
        const rise = rr(2, 4);
        const hold = rr(3, 8);
        const fall = rr(2, 3.5);
        const A = rr(0.45, 1);
        c.swell.gain.setTargetAtTime(A, tn, rise / 3);
        c.swell.gain.setTargetAtTime(A * 0.8, tn + rise, hold / 2);
        c.swell.gain.setTargetAtTime(0, tn + rise + hold, fall / 3);
        c.bp.frequency.setTargetAtTime(c.f * 1.03, tn, rise / 2);
        c.bp.frequency.setTargetAtTime(c.f * 0.96, tn + rise + hold, fall / 2);
        c.next = tn + rise + hold + fall + rr(3, 14);
      }
    }
  }

  function singBird(tn, dW, yW, eW) {
    let busy = 0;
    for (const b of birds) for (const i of b.inds) if (i.busy > tn) busy++;
    if (busy >= maxBirds) return;
    let total = 0;
    for (const b of birds) {
      let free = false;
      for (const i of b.inds) if (i.busy <= tn) free = true;
      b.w = free ? b.dawn * dW + b.day * yW + b.eve * eW : 0;
      total += b.w;
    }
    if (total <= 0) return;
    let r = rng() * total;
    let pick = birds[0];
    for (const b of birds) {
      pick = b;
      if ((r -= b.w) <= 0) break;
    }
    for (const i of pick.inds) {
      if (i.busy > tn) continue;
      const v = eng.play(pick.name, i, tn);
      if (v) i.busy = v.end + rr(0.5, 3);
      return;
    }
  }

  function tick(now, s, snap) {
    const h = s.hours;
    const w = s.windEff;
    if (snap || now - lastLevels > 0.1 || now < lastLevels) {
      lastLevels = now;
      water.set(ON.water * LV.water * (0.35 + 0.9 * w), now, 1.2, 1.2, snap);
      wind.set(ON.wind * LV.wind * clamp(0.08 + 1.4 * w, 0, 1.6), now, 1.2, 1.2, snap);
      insects.set(ON.insects * LV.insects * PROFILE.insects(h), now, 2, 2, snap);
      crickets.set(ON.crickets * LV.crickets * PROFILE.crickets(h), now, 2, 2, snap);
    }
    schedWater(now, w);
    schedWind(now);
    schedInsects(now);

    const dW = PROFILE.dawn(h);
    const yW = PROFILE.day(h);
    const eW = PROFILE.eve(h);
    const bRate = ON.birds * (0.85 * dW + 0.13 * yW + 0.28 * eW) * density;
    const lRate = ON.loons * PROFILE.loon(h);
    if (first) {
      first = false;
      gen.bird = now + rr(0.2, 1.2);
      gen.birdRate = bRate;
      gen.loon = lRate * 60 >= 0.5 ? now + rr(2.5, 6) : now + wait(lRate, 5, 400);
      gen.loonRate = lRate;
      gen.frog = now + rr(1, 6);
      gen.owl = now + rr(15, 40);
      gen.cluck = now + rr(0.2, 1);
      for (const p of peepers) p.next = now + rng() * p.period;
    }
    // when the clock jumps to a busier time (time presets), pull the next event in
    if (now - lastRates > 0.5 || now < lastRates) {
      lastRates = now;
      if (bRate > gen.birdRate * 1.5 + 0.01) gen.bird = Math.min(gen.bird, now + wait(bRate, 0.2, 10));
      gen.birdRate = bRate;
      if (lRate > gen.loonRate * 1.5 + 0.001) gen.loon = Math.min(gen.loon, now + wait(lRate, 2, 60));
      gen.loonRate = lRate;
    }

    // songbirds
    while (gen.bird < now + LOOK) {
      const tn = Math.max(gen.bird, now + 0.02);
      if (bRate > 1e-3 && eng.canAmbient()) singBird(tn, dW, yW, eW);
      gen.bird = tn + wait(bRate, 0.35, 45);
    }

    // loons (a pair out on the lake; the other one often answers)
    while (gen.loon < now + LOOK) {
      const tn = Math.max(gen.loon, now + 0.02);
      let dur = 0;
      if (lRate > 1e-4 && eng.canAmbient()) {
        const i = rng() < 0.5 ? 0 : 1;
        const wailP = yW > 0.5 ? 0.15 : 0.6;
        const name = rng() < wailP ? 'loon:wail' : 'loon:tremolo';
        const v = eng.play(name, loons[i], tn);
        if (v) {
          dur = v.end - tn;
          if (rng() < 0.45 && gen.answerT < 0) {
            gen.answerT = v.end + rr(1.5, 5);
            gen.answerName = rng() < 0.6 ? name : name === 'loon:wail' ? 'loon:tremolo' : 'loon:wail';
            gen.answerInd = loons[1 - i];
          }
        }
      }
      gen.loon = tn + dur + wait(lRate, 8, 400);
    }
    if (gen.answerT >= 0 && gen.answerT < now + LOOK) {
      if (eng.canAmbient()) eng.play(gen.answerName, gen.answerInd, Math.max(gen.answerT, now + 0.02));
      gen.answerT = -1;
    }

    // spring peepers: each individual keeps its own rhythm; more of them join as dusk deepens
    const pw = ON.peepers * PROFILE.peepers(h);
    const nAct = pw * peepers.length;
    for (let i = 0; i < peepers.length; i++) {
      const p = peepers[i];
      if (i >= nAct) {
        if (p.next < now) p.next = now + rng() * p.period;
        continue;
      }
      while (p.next < now + LOOK) {
        const tn = Math.max(p.next, now + 0.01);
        p.level = p.base * (0.35 + 0.65 * pw);
        if (eng.canAmbient()) eng.play('peeper', p, tn);
        p.next = tn + p.period * rr(0.85, 1.2);
      }
    }

    // green frog, barred owl, stray water clucks
    const fr = (ON.frogs * PROFILE.frogs(h)) / 10;
    while (gen.frog < now + LOOK) {
      const tn = Math.max(gen.frog, now + 0.02);
      if (fr > 1e-4 && eng.canAmbient()) eng.play('frog:green', frog, tn);
      gen.frog = tn + wait(fr, 2, 60);
    }
    const ow = (ON.owl * PROFILE.owl(h)) / 100;
    while (gen.owl < now + LOOK) {
      const tn = Math.max(gen.owl, now + 0.02);
      if (ow > 1e-4 && eng.canAmbient()) eng.play('owl', owlInd, tn);
      gen.owl = tn + wait(ow, 20, 600);
    }
    const cr = 0.2 + 0.3 * w;
    while (gen.cluck < now + LOOK) {
      const tn = Math.max(gen.cluck, now + 0.02);
      if (water.active && eng.canAmbient()) {
        piling.dx = rr(-1, 1);
        piling.dz = rr(-0.6, 1);
        piling.dist = rr(0.8, 3);
        piling.amp = rr(0.2, 0.7);
        piling.kind = null;
        eng.play('cluck', piling, tn);
      }
      gen.cluck = tn + wait(cr, 0.25, 8);
    }
  }

  function dispose() {
    water.teardown();
    wind.teardown();
    insects.teardown();
    crickets.teardown();
  }

  return {
    tick,
    dispose,
    layers: { water, wind, insects, crickets },
  };
}
