// Wildlife voices for the ambience: songbirds of a northern (MN / ON) lake shore, the common loon,
// barred owl, green frog, spring peeper. Each builder is (eng, params, t) and schedules ONE phrase.
// params (all optional): { dx, dz } unit world direction from the listener, dist (m), level, pitch,
// variant (0..1, stable per individual). Pitch contours are synthesized with AudioParam automation on
// a single oscillator per voice, so a whole song costs only a handful of nodes.
import { Voice, hit, num, harmonicWave } from './dsp.js';
import { LV } from './levels.js';

const TAU = Math.PI * 2;

// World direction + distance for a creature. Land birds sit on the shore (right, behind, left);
// loons are out on the lake (in front).
function spot(eng, p, defDist, onLake) {
  let dx = num(p.dx, NaN);
  let dz = num(p.dz, NaN);
  if (!Number.isFinite(dx) || !Number.isFinite(dz) || (dx === 0 && dz === 0)) {
    const a = onLake ? eng.rr(Math.PI + 0.35, TAU - 0.35) : eng.rr(-0.35, Math.PI + 0.35);
    dx = Math.cos(a);
    dz = Math.sin(a);
  }
  const inv = 1 / Math.hypot(dx, dz);
  return { dx: dx * inv, dz: dz * inv, dist: Math.max(1, num(p.dist, defDist)) };
}

function out(eng, v, p, defDist, onLake, send, level) {
  const s = spot(eng, p, defDist, onLake);
  return eng.place(v, eng.amb, s.dx, s.dz, s.dist, { send, gain: level * Math.max(0, num(p.level, 1)) });
}

function vibrato(v, o, rate, depthHz) {
  const l = v.osc('sine', rate);
  const g = v.gain(depthHz);
  l.connect(g);
  g.connect(o.frequency);
  return g;
}

const randInt = (eng, lo, hi) => lo + Math.floor(eng.rng() * (hi - lo + 1));

// ------------------------------------------------------------------ songbirds

// White-throated sparrow: "Old Sam Peabody-Peabody-Peabody" (or "Oh sweet Canada").
// Two long pure whistles, a jump, then 2-4 triplets on the second pitch.
function whitethroat(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, 60, false, 0.3, LV.bird);
  const pitch = num(p.pitch, 1);
  const o = v.osc('sine', 3000);
  const g = v.gain(0);
  v.chain(o, g, inp);
  vibrato(v, o, eng.rr(5, 7), 5);
  const f1 = 3150 * pitch * eng.vary(1, 0.02);
  const f2 = num(p.variant, eng.rng()) < 0.72 ? f1 * eng.rr(1.2, 1.27) : f1 * eng.rr(0.82, 0.86);
  let tt = t;
  const note = (f, dur, amp) => {
    const a = Math.min(0.035, dur * 0.3);
    o.frequency.setValueAtTime(f * 0.985, tt);
    o.frequency.linearRampToValueAtTime(f, tt + a);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(amp, tt + a);
    g.gain.linearRampToValueAtTime(amp * 0.88, tt + dur - a);
    g.gain.linearRampToValueAtTime(0, tt + dur);
    tt += dur;
  };
  note(f1, eng.rr(0.45, 0.62), 0.8);
  tt += 0.06;
  note(f2, eng.rr(0.4, 0.55), 1);
  tt += 0.08;
  const n = randInt(eng, 2, 4);
  for (let i = 0; i < n; i++) {
    const fd = f2 * (1 - 0.006 * i);
    note(fd, 0.13, 0.85);
    tt += 0.02;
    note(fd, 0.085, 0.7);
    tt += 0.018;
    note(fd, 0.085, 0.7);
    tt += 0.05;
  }
  return v.run(tt + 0.1);
}

// Black-capped chickadee "fee-bee(-ee)", sung 1-3 times.
function chickadee(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, 35, false, 0.25, LV.bird);
  const o = v.osc('sine', 4000);
  const g = v.gain(0);
  v.chain(o, g, inp);
  const f = 4000 * num(p.pitch, 1) * eng.vary(1, 0.015);
  let tt = t;
  const reps = randInt(eng, 1, 3);
  for (let r = 0; r < reps; r++) {
    const d1 = eng.rr(0.3, 0.42);
    o.frequency.setValueAtTime(f * 1.012, tt);
    o.frequency.linearRampToValueAtTime(f * 0.985, tt + d1);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(0.9, tt + 0.04);
    g.gain.linearRampToValueAtTime(0.8, tt + d1 - 0.04);
    g.gain.linearRampToValueAtTime(0, tt + d1);
    tt += d1 + eng.rr(0.05, 0.1);
    const d2 = eng.rr(0.28, 0.38);
    const f2 = f * eng.rr(0.82, 0.87);
    o.frequency.setValueAtTime(f2 * 1.005, tt);
    o.frequency.linearRampToValueAtTime(f2 * 0.99, tt + d2);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(0.8, tt + 0.035);
    g.gain.linearRampToValueAtTime(0.45, tt + d2 * 0.45);
    g.gain.linearRampToValueAtTime(0.75, tt + d2 * 0.6);
    g.gain.linearRampToValueAtTime(0, tt + d2);
    tt += d2;
    if (r < reps - 1) tt += eng.rr(2.2, 3.5);
  }
  return v.run(tt + 0.1);
}

// Caroling songs built from slurred syllables (robin, red-eyed vireo).
function carol(eng, p, t, c) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, c.dist, false, c.send, LV.bird * c.level);
  const pitch = num(p.pitch, 1);
  const o = v.osc('custom', 2000, harmonicWave(eng.ac, 'bird', [1, 0.1, 0.035]));
  const g = v.gain(0);
  v.chain(o, g, inp);
  if (c.vib) vibrato(v, o, eng.rr(c.vib[0], c.vib[1]), c.vib[2]);
  let tt = t;
  const np = randInt(eng, c.phrases[0], c.phrases[1]);
  for (let ph = 0; ph < np; ph++) {
    const ns = randInt(eng, c.syl[0], c.syl[1]);
    for (let s = 0; s < ns; s++) {
      const d = eng.rr(c.dur[0], c.dur[1]);
      const f0 = eng.rr(c.f0[0], c.f0[1]) * pitch;
      const fp = f0 * eng.rr(c.peak[0], c.peak[1]);
      const fe = eng.rr(c.end[0], c.end[1]) * pitch;
      const amp = eng.rr(0.7, 1);
      o.frequency.setValueAtTime(f0, tt);
      o.frequency.linearRampToValueAtTime(fp, tt + d * 0.3);
      o.frequency.linearRampToValueAtTime(fe, tt + d);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(amp, tt + 0.018);
      g.gain.linearRampToValueAtTime(amp * 0.7, tt + d * 0.75);
      g.gain.linearRampToValueAtTime(0, tt + d);
      tt += d + eng.rr(c.gap[0], c.gap[1]);
    }
    if (ph < np - 1) tt += eng.rr(c.phraseGap[0], c.phraseGap[1]);
  }
  return v.run(tt + 0.1);
}

const ROBIN = {
  dist: 50, send: 0.3, level: 0.9,
  f0: [1900, 2500], peak: [1.08, 1.35], end: [1800, 2900],
  syl: [2, 4], dur: [0.12, 0.24], gap: [0.05, 0.11], phrases: [2, 4], phraseGap: [0.7, 1.5],
  vib: [26, 36, 22],
};
const VIREO = {
  dist: 45, send: 0.3, level: 0.7,
  f0: [2600, 3600], peak: [0.8, 1.45], end: [2300, 4600],
  syl: [2, 3], dur: [0.06, 0.12], gap: [0.03, 0.06], phrases: [3, 6], phraseGap: [0.9, 1.7],
  vib: null,
};

// Dry trill: chipping sparrow (fast, high) or dark-eyed junco (slower, more musical).
function trill(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, 45, false, 0.3, LV.bird * 0.75);
  const pitch = num(p.pitch, 1);
  const junco = num(p.variant, eng.rng()) < 0.5;
  const rate = junco ? eng.rr(10, 13) : eng.rr(13, 17);
  const n = Math.floor(eng.rr(1.4, 2.4) * rate);
  const fHi = (junco ? eng.rr(4200, 5000) : eng.rr(6000, 6800)) * pitch;
  const fLo = fHi * (junco ? eng.rr(0.62, 0.72) : eng.rr(0.6, 0.68));
  const o = v.osc('sine', fHi);
  const g = v.gain(0);
  v.chain(o, g, inp);
  const per = 1 / rate;
  const len = per * (junco ? 0.7 : 0.55);
  for (let i = 0; i < n; i++) {
    const tn = t + i * per;
    const amp = Math.min(1, 0.45 + i / (n * 0.25)) * (i > n - 4 ? 0.8 : 1);
    o.frequency.setValueAtTime(fHi, tn);
    o.frequency.exponentialRampToValueAtTime(fLo, tn + len);
    hit(g.gain, tn, amp, 0.0025, len * 0.3);
  }
  return v.run(t + n * per + 0.2);
}

// Hermit thrush: a pure intro whistle then a flute-like two-voiced cascade; phrases change pitch.
const THRUSH_BASES = [1850, 2150, 2500, 2900, 3300];
function thrush(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, 90, false, 0.5, LV.bird * 0.9);
  const pitch = num(p.pitch, 1);
  const wave = harmonicWave(eng.ac, 'flute', [1, 0.06, 0.02]);
  const oA = v.osc('custom', 2000, wave);
  const gA = v.gain(0);
  const oB = v.osc('sine', 3000);
  const gB = v.gain(0);
  v.chain(oA, gA, inp);
  v.chain(oB, gB, inp);
  let tt = t;
  const np = eng.rng() < 0.6 ? 2 : 1;
  let last = -1;
  for (let ph = 0; ph < np; ph++) {
    let bi = Math.floor(eng.rng() * THRUSH_BASES.length);
    if (bi === last) bi = (bi + 2) % THRUSH_BASES.length;
    last = bi;
    const f0 = THRUSH_BASES[bi] * pitch * eng.vary(1, 0.01);
    const d0 = eng.rr(0.26, 0.36);
    oA.frequency.setValueAtTime(f0, tt);
    oA.frequency.linearRampToValueAtTime(f0 * 1.005, tt + d0);
    gA.gain.setValueAtTime(0, tt);
    gA.gain.linearRampToValueAtTime(0.85, tt + 0.05);
    gA.gain.linearRampToValueAtTime(0.7, tt + d0 - 0.03);
    gA.gain.linearRampToValueAtTime(0, tt + d0);
    tt += d0 + 0.015;
    const n = randInt(eng, 6, 10);
    let f = f0 * eng.rr(1.15, 1.3);
    for (let i = 0; i < n; i++) {
      const d = eng.rr(0.035, 0.05);
      f *= i % 2 ? eng.rr(0.9, 0.97) : eng.rr(1.08, 1.18);
      oA.frequency.setValueAtTime(f, tt);
      oA.frequency.linearRampToValueAtTime(f * 1.02, tt + d);
      oB.frequency.setValueAtTime(f * 1.5, tt);
      const a = 0.6 * (1 - i / (n * 1.4));
      hit(gA.gain, tt, a, 0.003, d * 0.35);
      hit(gB.gain, tt, a * 0.4, 0.003, d * 0.3);
      tt += d + 0.008;
    }
    if (ph < np - 1) tt += eng.rr(2.2, 3.4);
  }
  return v.run(tt + 0.3);
}

// ------------------------------------------------------------------ the common loon

function loonVoice(eng, v, p) {
  const inp = out(eng, v, p, 300, true, 1.0, LV.loon * 0.55);
  const o = v.osc('custom', 800, harmonicWave(eng.ac, 'loon', [1, 0.34, 0.16, 0.07, 0.03, 0.015]));
  const form = v.filter('peaking', eng.rr(1400, 1800), 1.1, 3);
  return { inp, o, form };
}

// Wail: a long mournful glide up to a held note, a break up to a higher note, sometimes a third.
function loonWail(eng, p, t) {
  const v = new Voice(eng, t);
  const { inp, o, form } = loonVoice(eng, v, p);
  const g = v.gain(0);
  v.chain(o, form, g, inp);
  const vibO = v.osc('sine', eng.rr(4.2, 5.4));
  const vibG = v.gain(0);
  vibO.connect(vibG);
  vibG.connect(o.frequency);
  const pitch = num(p.pitch, 1);
  const f1 = eng.rr(760, 880) * pitch;
  const f2 = f1 * eng.rr(1.3, 1.45);
  const h1 = eng.rr(0.9, 1.5);
  const h2 = eng.rr(1.3, 2.1);
  o.frequency.setValueAtTime(f1 * 0.88, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.32);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.75, t + 0.3);
  const tj = t + 0.32 + h1;
  o.frequency.linearRampToValueAtTime(f1 * 1.01, tj);
  g.gain.linearRampToValueAtTime(0.9, tj);
  const t2 = tj + 0.14;
  o.frequency.exponentialRampToValueAtTime(f2, t2);
  g.gain.linearRampToValueAtTime(0.68, tj + 0.06);
  g.gain.linearRampToValueAtTime(1, tj + 0.25);
  o.frequency.linearRampToValueAtTime(f2 * 1.012, t2 + h2 * 0.6);
  o.frequency.linearRampToValueAtTime(f2 * 0.97, t2 + h2);
  g.gain.linearRampToValueAtTime(0.95, t2 + h2 * 0.7);
  let end = t2 + h2;
  if (eng.rng() < 0.35) {
    const h3 = eng.rr(0.6, 0.95);
    const f3 = f2 * eng.rr(0.88, 0.93);
    o.frequency.exponentialRampToValueAtTime(f3, end + 0.16);
    g.gain.linearRampToValueAtTime(0.75, end + 0.08);
    g.gain.linearRampToValueAtTime(0.85, end + 0.25);
    o.frequency.linearRampToValueAtTime(f3 * 0.97, end + 0.16 + h3);
    end += 0.16 + h3;
  }
  g.gain.linearRampToValueAtTime(0.8, end - 0.05);
  g.gain.linearRampToValueAtTime(0, end + 0.4);
  vibG.gain.setValueAtTime(f1 * 0.003, t);
  vibG.gain.linearRampToValueAtTime(f1 * 0.012, end);
  return v.run(end + 0.5);
}

// Tremolo ("laughing" call): rapid, wavering notes; FM and AM from one shared LFO.
function loonTremolo(eng, p, t) {
  const v = new Voice(eng, t);
  const { inp, o, form } = loonVoice(eng, v, p);
  const pitch = num(p.pitch, 1);
  const f = eng.rr(950, 1150) * pitch;
  const dur = eng.rr(1.0, 1.8);
  const rate = eng.rr(7.5, 9.5);
  o.frequency.setValueAtTime(f * 0.95, t);
  o.frequency.linearRampToValueAtTime(f * 1.05, t + dur);
  const lfo = v.osc('sine', rate);
  const fm = v.gain(f * 0.07);
  lfo.connect(fm);
  fm.connect(o.frequency);
  const trem = v.gain(0.55);
  const am = v.gain(0.45);
  lfo.connect(am);
  am.connect(trem.gain);
  const env = v.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.85, t + 0.12);
  env.gain.linearRampToValueAtTime(0.75, t + dur);
  env.gain.linearRampToValueAtTime(0, t + dur + 0.25);
  v.chain(o, trem, form, env, inp);
  return v.run(t + dur + 0.35);
}

// ------------------------------------------------------------------ night / evening

// Barred owl: "who-cooks-for-you, who-cooks-for-you-all".
function owl(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, 180, false, 0.7, LV.owl);
  const o = v.osc('custom', 360, harmonicWave(eng.ac, 'hoot', [1, 0.3, 0.12, 0.05]));
  const lp = v.filter('lowpass', 1100, 0.7);
  const g = v.gain(0);
  v.chain(o, lp, g, inp);
  const f = eng.rr(330, 400) * num(p.pitch, 1);
  let tt = t;
  const hoot = (dur, k, gap) => {
    o.frequency.setValueAtTime(f * k * 0.96, tt);
    o.frequency.linearRampToValueAtTime(f * k, tt + dur * 0.3);
    o.frequency.linearRampToValueAtTime(f * k * 0.95, tt + dur);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(1, tt + 0.04);
    g.gain.linearRampToValueAtTime(0.8, tt + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, tt + dur);
    tt += dur + gap;
  };
  const down = (dur) => {
    o.frequency.setValueAtTime(f * 1.12, tt);
    o.frequency.linearRampToValueAtTime(f * 1.15, tt + dur * 0.25);
    o.frequency.exponentialRampToValueAtTime(f * 0.78, tt + dur);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(1, tt + 0.05);
    g.gain.linearRampToValueAtTime(0.85, tt + dur * 0.6);
    g.gain.linearRampToValueAtTime(0, tt + dur);
    tt += dur;
  };
  const phrase = (last) => {
    hoot(0.2, 1, 0.07);
    hoot(0.12, 1.05, 0.05);
    hoot(0.22, 1.1, 0.12);
    hoot(0.12, 1.0, 0.05);
    down(last);
  };
  phrase(0.5);
  if (eng.rng() < 0.7) {
    tt += eng.rr(0.5, 0.8);
    phrase(0.75);
  }
  return v.run(tt + 0.2);
}

// Green frog: a loose-banjo-string "gunk", 1-3 times.
function greenFrog(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, 25, false, 0.2, LV.frog);
  const o = v.osc('custom', 170, harmonicWave(eng.ac, 'twang', [0.6, 1, 0.8, 0.55, 0.35, 0.2, 0.12, 0.07]));
  const lp = v.filter('lowpass', 1600, 0.7);
  const g = v.gain(0);
  v.chain(o, lp, g, inp);
  const f = eng.rr(150, 190) * num(p.pitch, 1);
  let tt = t;
  const n = randInt(eng, 1, 3);
  for (let i = 0; i < n; i++) {
    o.frequency.setValueAtTime(f * 1.06, tt);
    o.frequency.exponentialRampToValueAtTime(f * 0.93, tt + 0.12);
    g.gain.setValueAtTime(0, tt);
    g.gain.linearRampToValueAtTime(i ? 0.8 : 1, tt + 0.004);
    g.gain.setTargetAtTime(0, tt + 0.004, 0.05);
    tt += eng.rr(0.3, 0.6);
  }
  return v.run(tt + 0.3);
}

// Spring peeper: one short up-slurred "peep".
function peeper(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = out(eng, v, p, 40, false, 0.15, LV.peeper);
  const f0 = num(p.freq, eng.rr(2750, 3150));
  const dur = eng.rr(0.08, 0.12);
  const o = v.osc('sine', f0);
  o.frequency.setValueAtTime(f0 * 0.9, t);
  o.frequency.exponentialRampToValueAtTime(f0 * 1.03, t + dur);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + 0.018);
  g.gain.linearRampToValueAtTime(0.85, t + dur - 0.025);
  g.gain.linearRampToValueAtTime(0, t + dur);
  v.chain(o, g, inp);
  return v.run(t + dur + 0.02);
}

export const CREATURES = {
  'bird:whitethroat': whitethroat,
  'bird:chickadee': chickadee,
  'bird:robin': (eng, p, t) => carol(eng, p, t, ROBIN),
  'bird:vireo': (eng, p, t) => carol(eng, p, t, VIREO),
  'bird:trill': trill,
  'bird:thrush': thrush,
  'loon:wail': loonWail,
  'loon:tremolo': loonTremolo,
  owl,
  'frog:green': greenFrog,
  peeper,
};

