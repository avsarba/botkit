// Event one-shots: every builder is (eng, params, t) and schedules one short Voice that starts at `t`.
// Physical models, loosely: splashes = impact transient + cavity "plop" (rising bubble resonance) +
// spray noise + falling droplets; rod sounds = swept band-passed noise; reel/drag = band-limited
// sawtooth clicks through a highpass (each ramp reset is one click).
import { clamp, lerp } from '../config.js';
import { Voice, ad, hit, num } from './dsp.js';
import { LV } from './levels.js';

const LURE_SIZE = { bobber: 0.5, spinner: 0.3, crankbait: 0.62, topwater: 0.7 };

// A handful of tiny droplet / bubble "plinks" spread over [t0, t1] on (at most) two oscillators.
function bubbles(v, dest, t0, t1, n, fLo, fHi, aLo, aHi) {
  const eng = v.eng;
  if (n <= 0) return;
  const k = Math.min(2, n);
  const os = [];
  const gs = [];
  for (let i = 0; i < k; i++) {
    const o = v.osc('sine', fLo);
    const g = v.gain(0);
    o.connect(g);
    g.connect(dest);
    os.push(o);
    gs.push(g);
  }
  const step = (t1 - t0) / n;
  for (let i = 0; i < n; i++) {
    const tt = t0 + step * i + eng.rng() * step * 0.85;
    const o = os[i % k];
    const g = gs[i % k];
    const f = eng.rr(fLo, fHi);
    const d = eng.rr(0.012, 0.03);
    o.frequency.setValueAtTime(f, tt);
    o.frequency.exponentialRampToValueAtTime(f * eng.rr(1.2, 1.5), tt + d);
    hit(g.gain, tt, eng.rr(aLo, aHi), 0.001, d * 0.45);
  }
}

function noiseBand(v, kind, type, f, q, dest) {
  const n = v.noise(kind);
  const fl = v.filter(type, f, q);
  const g = v.gain(0);
  n.connect(fl);
  fl.connect(g);
  g.connect(dest);
  return { n, f: fl, g };
}

// Close to the player (rod, reel, hands): fixed pan, straight into a bus.
function nearOut(v, bus, pan, level) {
  const p = v.panner(pan);
  const g = v.gain(level);
  g.connect(p);
  p.connect(bus);
  return g;
}

// ------------------------------------------------------------------ the rod and the cast
function cast(eng, p, t) {
  const pw = clamp(num(p.power01, 0.7), 0, 1);
  const v = new Voice(eng, t);
  const pan = v.panner(0.3);
  pan.pan.setValueAtTime(0.32, t);
  pan.pan.linearRampToValueAtTime(-0.06, t + 0.34);
  pan.connect(eng.sfx);
  const out = v.gain(LV.cast);
  out.connect(pan);

  // rod swish: band-passed noise swept up and back down as the blank loads and unloads
  const tPk = t + eng.vary(0.15, 0.12);
  const sw = noiseBand(v, 'white', 'bandpass', 420, 1.4, out);
  sw.f.frequency.setValueAtTime(eng.vary(380, 0.1), t);
  sw.f.frequency.exponentialRampToValueAtTime(eng.vary(1150 + 1400 * pw, 0.08), tPk);
  sw.f.frequency.exponentialRampToValueAtTime(eng.vary(520, 0.1), tPk + 0.24);
  sw.g.gain.setValueAtTime(0, t);
  sw.g.gain.linearRampToValueAtTime(0.9 * (0.45 + 0.55 * pw), tPk);
  sw.g.gain.setTargetAtTime(0, tPk, 0.055);

  // low push of air
  const air = noiseBand(v, 'pink', 'lowpass', 320, 0.7, out);
  ad(air.g.gain, tPk - 0.06, 0.06, 0.04 + 0.1 * pw, 0.045);

  // line peeling off the spool: fluttering hiss that slows as the lure loses speed
  const T = 0.6 + 1.6 * pw;
  const t2 = tPk - 0.02;
  const n3 = v.noise('white');
  const hp = v.filter('highpass', 2800, 0.7);
  const bp = v.filter('bandpass', 6200, 0.8);
  const flutter = v.gain(0.7);
  const lfo = v.osc('sine', 50);
  const lfoG = v.gain(0.3);
  lfo.frequency.setValueAtTime(eng.vary(58, 0.1), t2);
  lfo.frequency.exponentialRampToValueAtTime(14, t2 + T);
  lfo.connect(lfoG);
  lfoG.connect(flutter.gain);
  const g3 = v.gain(0);
  g3.gain.setValueAtTime(0, t2);
  g3.gain.linearRampToValueAtTime(0.2 * (0.5 + 0.5 * pw), t2 + 0.03);
  g3.gain.setTargetAtTime(0, t2 + 0.06, T / 3.2);
  v.chain(n3, hp, bp, flutter, g3, out);
  return v.run(t2 + 0.06 + T * 1.6 + 0.1);
}

function strike(eng, p, t) {
  const v = new Voice(eng, t);
  const out = nearOut(v, eng.sfx, 0.18, LV.strike);
  const sw = noiseBand(v, 'white', 'bandpass', 450, 2.2, out);
  sw.f.frequency.setValueAtTime(eng.vary(450, 0.1), t);
  sw.f.frequency.exponentialRampToValueAtTime(eng.vary(2900, 0.08), t + 0.085);
  sw.f.frequency.exponentialRampToValueAtTime(800, t + 0.21);
  sw.g.gain.setValueAtTime(0, t);
  sw.g.gain.linearRampToValueAtTime(0.75, t + 0.065);
  sw.g.gain.setTargetAtTime(0, t + 0.07, 0.03);
  const low = noiseBand(v, 'pink', 'lowpass', 420, 0.7, out);
  ad(low.g.gain, t + 0.02, 0.035, 0.25, 0.035);
  if (p.success !== false && !p.early) {
    const zip = noiseBand(v, 'white', 'highpass', 2600, 0.7, out);
    ad(zip.g.gain, t + 0.07, 0.004, 0.1, 0.05);
  }
  return v.run(t + 0.5);
}

// Short burst of the drag giving line as the hook goes home.
function hooked(eng, p, t) {
  const v = new Voice(eng, t);
  const out = nearOut(v, eng.tackle, 0.25, LV.hooked);
  const saw = v.osc('sawtooth', 80);
  saw.frequency.setValueAtTime(eng.rr(70, 95), t);
  saw.frequency.exponentialRampToValueAtTime(eng.rr(28, 38), t + 0.24);
  const hp = v.filter('highpass', 2200, 0.7);
  const pk = v.filter('peaking', 3500, 3, 8);
  const g = v.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.4, t + 0.008);
  g.gain.setValueAtTime(0.4, t + 0.12);
  g.gain.linearRampToValueAtTime(0, t + 0.26);
  v.chain(saw, hp, pk, g, out);
  return v.run(t + 0.3);
}

function snap(eng, p, t) {
  const v = new Voice(eng, t);
  const out = nearOut(v, eng.sfx, 0.1, LV.snap);
  // the crack of taut mono parting
  const cr = noiseBand(v, 'white', 'highpass', 1800, 0.7, out);
  hit(cr.g.gain, t, 1.0, 0.0002, 0.0055);
  const p1 = v.osc('sine', eng.vary(2600, 0.05));
  const g1 = v.gain(0);
  ad(g1.gain, t, 0.0005, 0.12, 0.022);
  v.chain(p1, g1, out);
  const p2 = v.osc('sine', eng.vary(4150, 0.05));
  const g2 = v.gain(0);
  ad(g2.gain, t, 0.0005, 0.07, 0.013);
  v.chain(p2, g2, out);
  // recoil: the freed rod tip whips back
  const wh = noiseBand(v, 'white', 'bandpass', 3600, 1.6, out);
  wh.f.frequency.setValueAtTime(3600, t + 0.01);
  wh.f.frequency.exponentialRampToValueAtTime(620, t + 0.28);
  wh.g.gain.setValueAtTime(0, t + 0.01);
  wh.g.gain.linearRampToValueAtTime(0.5, t + 0.045);
  wh.g.gain.setTargetAtTime(0, t + 0.05, 0.08);
  // rod butt thump + guides rattling
  const th = v.osc('sine', 120);
  th.frequency.setValueAtTime(120, t + 0.02);
  th.frequency.exponentialRampToValueAtTime(70, t + 0.2);
  const thg = v.gain(0);
  ad(thg.gain, t + 0.02, 0.003, 0.15, 0.035);
  v.chain(th, thg, out);
  const ra = noiseBand(v, 'white', 'highpass', 4500, 0.7, out);
  hit(ra.g.gain, t + 0.09, 0.07, 0.0003, 0.005);
  hit(ra.g.gain, t + 0.14, 0.05, 0.0003, 0.005);
  hit(ra.g.gain, t + 0.21, 0.035, 0.0003, 0.005);
  return v.run(t + 0.8);
}

// Slack line: a limp swish and the line settling on the water. Deliberately subdued.
function escaped(eng, p, t) {
  const v = new Voice(eng, t);
  const out = nearOut(v, eng.sfx, 0.05, LV.escaped);
  const sw = noiseBand(v, 'pink', 'bandpass', 380, 0.9, out);
  sw.g.gain.setValueAtTime(0, t);
  sw.g.gain.linearRampToValueAtTime(0.22, t + 0.09);
  sw.g.gain.setTargetAtTime(0, t + 0.09, 0.12);
  const sl = noiseBand(v, 'white', 'lowpass', 1700, 0.7, out);
  hit(sl.g.gain, t + eng.rr(0.2, 0.3), 0.14, 0.0015, 0.02);
  return v.run(t + 0.9);
}

// Warm, wooden, three-note marimba cue (not a fanfare).
const MOTIFS = [
  [392.0, 493.88, 587.33],
  [293.66, 392.0, 493.88],
  [440.0, 554.37, 659.26],
  [349.23, 440.0, 523.25],
];
function catchCue(eng, p, t) {
  const v = new Voice(eng, t);
  const lp = v.filter('lowpass', 4800, 0.6);
  const out = v.gain(LV.catch);
  const pan = v.panner(0);
  lp.connect(out);
  out.connect(pan);
  pan.connect(eng.sfx);
  const send = v.gain(0.18);
  out.connect(send);
  send.connect(eng.rev);
  const mallet = noiseBand(v, 'white', 'bandpass', 2400, 0.8, lp);
  const motif = eng.pick(MOTIFS);
  const gap = eng.rr(0.13, 0.16);
  let end = t;
  const note = (f, tt, amp) => {
    const tau = 0.12 + 0.18 * (330 / f);
    const parts = [
      [1, amp, 0.002, tau],
      [3.93, amp * 0.2, 0.001, tau * 0.22],
      [9.2, amp * 0.05, 0.0005, 0.012],
    ];
    for (const [m, a, at, dt] of parts) {
      const o = v.osc('sine', f * m);
      const g = v.gain(0);
      end = Math.max(end, ad(g.gain, tt, at, a, dt));
      o.connect(g);
      g.connect(lp);
    }
    hit(mallet.g.gain, tt, amp * 0.25, 0.0003, 0.004);
  };
  let tn = t;
  for (let i = 0; i < 3; i++) {
    tn = t + i * gap * eng.vary(1, 0.08);
    note(motif[i] * eng.vary(1, 0.003), tn, i === 2 ? 0.95 : 0.75);
  }
  note(motif[2] / 2, tn + 0.004, 0.25); // soft octave below under the last note
  return v.run(Math.min(end, t + 4));
}

function uiClick(eng, p, t) {
  const v = new Voice(eng, t);
  const out = nearOut(v, eng.sfx, 0, LV.ui);
  const n = noiseBand(v, 'white', 'bandpass', 3200, 1.2, out);
  hit(n.g.gain, t, 0.12, 0.0003, 0.0025);
  const o = v.osc('sine', 1500);
  const g = v.gain(0);
  ad(g.gain, t, 0.0005, 0.03, 0.006);
  v.chain(o, g, out);
  return v.run(t + 0.06);
}

// Rod blank / cork creaking under heavy load: stick-slip micro pulses through a resonance.
function creak(eng, p, t) {
  const s = clamp(num(p.amount, 0.5), 0, 1);
  const v = new Voice(eng, t);
  const out = nearOut(v, eng.tackle, 0.3, LV.creak);
  const n = noiseBand(v, 'white', 'bandpass', eng.rr(500, 1100), eng.rr(5, 8), out);
  const k = 3 + Math.floor(eng.rng() * 5);
  let tt = t;
  for (let i = 0; i < k; i++) {
    hit(n.g.gain, tt, eng.rr(0.3, 1) * 0.35 * (0.4 + 0.6 * s), 0.0008, 0.006);
    tt += eng.rr(0.012, 0.028);
  }
  return v.run(tt + 0.1);
}

// ------------------------------------------------------------------ water
function plop(eng, p, t) {
  if (p.onWater === false) return thud(eng, p, t);
  const id = p.lureId || eng.st.lureId;
  let s = LURE_SIZE[id] ?? 0.5;
  s = clamp(s * clamp(0.75 + num(p.speed, 8) / 40, 0.75, 1.15), 0.2, 1);
  const v = new Voice(eng, t);
  const inp = eng.at(v, eng.sfx, p.position, { send: 0.045 });
  const out = v.gain(LV.plop);
  out.connect(inp);
  // impact transient
  const im = noiseBand(v, 'white', 'highpass', 1100, 0.7, out);
  hit(im.g.gain, t, 0.35 * s + 0.08, 0.0004, 0.01);
  // cavity collapse: the rising "plop" resonance
  const f0 = eng.vary(lerp(900, 380, s), 0.08);
  const tb = t + 0.012 + 0.01 * s;
  const o = v.osc('sine', f0 * 0.7);
  o.frequency.setValueAtTime(f0 * 0.7, tb);
  o.frequency.exponentialRampToValueAtTime(f0 * 1.3, tb + 0.06);
  const og = v.gain(0);
  ad(og.gain, tb, 0.004, 0.5 * (0.55 + 0.45 * s), 0.028 + 0.025 * s);
  v.chain(o, og, out);
  // spray + drops falling back
  const sp = noiseBand(v, 'white', 'bandpass', 2600, 0.8, out);
  ad(sp.g.gain, t + 0.004, 0.012, 0.14 * s + 0.03, 0.05 + 0.08 * s);
  bubbles(v, out, t + 0.06, t + 0.3 + 0.2 * s, 2 + Math.round(3 * s), 1100, 2600, 0.02, 0.06);
  if (id === 'topwater') {
    const sl = noiseBand(v, 'pink', 'lowpass', 1800, 0.7, out);
    ad(sl.g.gain, t, 0.0015, 0.35, 0.018);
  } else if (id === 'bobber') {
    // the worm and split shot land a beat apart from the float
    const t3 = t + eng.rr(0.05, 0.11);
    const o2 = v.osc('sine', f0 * 1.5);
    o2.frequency.setValueAtTime(f0 * 1.05, t3);
    o2.frequency.exponentialRampToValueAtTime(f0 * 1.9, t3 + 0.04);
    const g2 = v.gain(0);
    ad(g2.gain, t3, 0.003, 0.22, 0.02);
    v.chain(o2, g2, out);
  }
  return v.run(t + 0.7 + 0.3 * s);
}

function thud(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = eng.at(v, eng.sfx, p.position, { send: 0.015 });
  const out = v.gain(LV.thud);
  out.connect(inp);
  const lo = noiseBand(v, 'brown', 'lowpass', 260, 0.7, out);
  ad(lo.g.gain, t, 0.002, 0.5, 0.03);
  const o = v.osc('sine', 95);
  o.frequency.setValueAtTime(95, t);
  o.frequency.exponentialRampToValueAtTime(58, t + 0.08);
  const og = v.gain(0);
  ad(og.gain, t, 0.001, 0.35, 0.028);
  v.chain(o, og, out);
  const gr = noiseBand(v, 'white', 'bandpass', 2800, 0.8, out);
  ad(gr.g.gain, t, 0.004, 0.06, 0.05);
  return v.run(t + 0.35);
}

function twitch(eng, p, t) {
  const v = new Voice(eng, t);
  const inp = eng.at(v, eng.sfx, p.position, { send: 0.035 });
  const out = v.gain(LV.twitch);
  out.connect(inp);
  const ch = noiseBand(v, 'pink', 'bandpass', 900, 1.2, out);
  ad(ch.g.gain, t, 0.004, 0.3, 0.03);
  const f = eng.rr(380, 520);
  const o = v.osc('sine', f);
  o.frequency.setValueAtTime(f, t + 0.006);
  o.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.05);
  const og = v.gain(0);
  ad(og.gain, t + 0.006, 0.003, 0.3, 0.024);
  v.chain(o, og, out);
  const sp = noiseBand(v, 'white', 'bandpass', 3000, 1, out);
  ad(sp.g.gain, t + 0.005, 0.008, 0.08, 0.04);
  const ra = noiseBand(v, 'white', 'bandpass', 5200, 3, out); // rattle chamber
  hit(ra.g.gain, t + 0.012, 0.1, 0.0004, 0.006);
  hit(ra.g.gain, t + 0.05, 0.07, 0.0004, 0.006);
  return v.run(t + 0.35);
}

function nibble(eng, p, t) {
  const s = clamp(num(p.strength01, 0.5), 0, 1);
  const v = new Voice(eng, t);
  const out = nearOut(v, eng.sfx, 0.22, LV.nibble);
  const n = noiseBand(v, 'white', 'bandpass', eng.vary(3800, 0.08), 1.6, out);
  hit(n.g.gain, t, 0.12 + 0.22 * s, 0.0003, 0.004);
  const o = v.osc('sine', eng.vary(1100, 0.06));
  const g = v.gain(0);
  ad(g.gain, t, 0.0008, 0.05 + 0.05 * s, 0.012);
  v.chain(o, g, out);
  return v.run(t + 0.12);
}

function bite(eng, p, t) {
  const lure = p.lureId || eng.st.lureId;
  const v = new Voice(eng, t);
  if (lure === 'bobber') {
    // the float is yanked under: hollow plunk + a few bubbles coming back up
    const inp = eng.at(v, eng.sfx, p.position, { send: 0.045, minGain: 0.55 });
    const out = v.gain(LV.plunk);
    out.connect(inp);
    const f0 = eng.rr(210, 290);
    const o = v.osc('sine', f0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.9, t + 0.085);
    const og = v.gain(0);
    ad(og.gain, t, 0.004, 0.55, 0.055);
    v.chain(o, og, out);
    const th = noiseBand(v, 'brown', 'lowpass', 380, 0.7, out);
    ad(th.g.gain, t, 0.003, 0.4, 0.045);
    const sp = noiseBand(v, 'white', 'bandpass', 2000, 0.9, out);
    ad(sp.g.gain, t + 0.004, 0.01, 0.08, 0.05);
    bubbles(v, out, t + 0.1, t + 0.4, 3, 500, 1100, 0.04, 0.09);
    return v.run(t + 0.65);
  }
  // a lure: sharp "tock" transmitted up the line into the blank
  const out = nearOut(v, eng.sfx, 0.2, LV.tap);
  const t2 = t + eng.rr(0.07, 0.12);
  const o = v.osc('sine', 180);
  o.frequency.setValueAtTime(185, t);
  o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
  o.frequency.setValueAtTime(175, t2);
  o.frequency.exponentialRampToValueAtTime(135, t2 + 0.06);
  const og = v.gain(0);
  hit(og.gain, t, 0.45, 0.0005, 0.02);
  hit(og.gain, t2, 0.28, 0.0005, 0.018);
  v.chain(o, og, out);
  const n = noiseBand(v, 'pink', 'bandpass', 1000, 2, out);
  hit(n.g.gain, t, 0.5, 0.0004, 0.012);
  hit(n.g.gain, t2, 0.3, 0.0004, 0.01);
  return v.run(t2 + 0.25);
}

function swirl(eng, p, t) {
  const s = clamp(num(p.size01, 0.5), 0.05, 1);
  const v = new Voice(eng, t);
  const inp = eng.at(v, eng.sfx, p.position, { send: 0.06 });
  const out = v.gain(LV.swirl);
  out.connect(inp);
  // the boil: a swell of low, dark water noise
  const bo = noiseBand(v, 'brown', 'lowpass', 350 + 900 * s, 0.7, out);
  bo.g.gain.setValueAtTime(0, t);
  bo.g.gain.linearRampToValueAtTime(0.55 * (0.4 + 0.6 * s), t + 0.05);
  bo.g.gain.setTargetAtTime(0, t + 0.05, 0.1 + 0.2 * s);
  // the suck of the take
  const f = eng.vary(260, 0.1) * (1 - 0.3 * s);
  const o = v.osc('sine', f);
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.1);
  const og = v.gain(0);
  ad(og.gain, t, 0.006, 0.35 * (0.5 + 0.5 * s), 0.045);
  v.chain(o, og, out);
  const sp = noiseBand(v, 'white', 'bandpass', 2400, 0.7, out);
  ad(sp.g.gain, t + 0.01, 0.02, 0.16 * s + 0.04, 0.07 + 0.1 * s);
  bubbles(v, out, t + 0.05, t + 0.45 + 0.2 * s, 3 + Math.round(4 * s), 450, 1500, 0.03, 0.08);
  return v.run(t + 0.9 + 0.5 * s);
}

function splash(eng, p, t, jump) {
  const s = clamp(num(p.size01, 0.5), 0.05, 1);
  const v = new Voice(eng, t);
  const inp = eng.at(v, eng.sfx, p.position, { send: 0.07 });
  const out = v.gain(LV.splash);
  out.connect(inp);
  const im = noiseBand(v, 'white', 'highpass', 700, 0.7, out);
  const body = noiseBand(v, 'pink', 'bandpass', 1800, 0.9, out);
  const wh = noiseBand(v, 'brown', 'lowpass', 240, 0.7, out);
  const nImp = jump ? 1 : 2 + (eng.rng() < s ? 1 : 0);
  let tt = t;
  for (let i = 0; i < nImp; i++) {
    const k = i === 0 ? 1 : eng.rr(0.45, 0.75);
    hit(im.g.gain, tt, (0.45 + 0.3 * s) * k, 0.0005, 0.018 + 0.02 * s);
    body.f.frequency.setTargetAtTime(2400, tt, 0.004);
    body.f.frequency.setTargetAtTime(650, tt + 0.015, 0.1 + 0.1 * s);
    hit(body.g.gain, tt, 0.5 * (0.5 + 0.5 * s) * k, 0.003, 0.07 + 0.18 * s * (jump ? 1 : 0.6));
    hit(wh.g.gain, tt, 0.5 * s * k, 0.003, 0.05 + 0.07 * s);
    if (i < nImp - 1) tt += eng.rr(0.09, 0.16);
  }
  bubbles(v, out, t + 0.05, tt + 0.35 + 0.5 * s, jump ? 5 + Math.round(10 * s) : 3 + Math.round(6 * s), 650, 2400, 0.025, 0.07 + 0.04 * s);
  const tail = noiseBand(v, 'white', 'bandpass', 4200, 0.6, out);
  tail.g.gain.setTargetAtTime(0.05 + 0.08 * s, t + 0.04, 0.05);
  tail.g.gain.setTargetAtTime(0, t + 0.2, 0.12 + 0.2 * s);
  return v.run(tt + 1.2 + 0.5 * s);
}

// Little water sounds under the dock: hollow clucks against the pilings, bubbles, small sloshes.
function cluck(eng, p, t) {
  const kind = p.kind || eng.pick(['cluck', 'cluck', 'blup', 'slosh']);
  const v = new Voice(eng, t);
  const dx = num(p.dx, eng.rr(-1, 1));
  const dz = num(p.dz, eng.rr(-1, 1));
  const inv = 1 / (Math.hypot(dx, dz) || 1);
  const inp = eng.place(v, eng.amb, dx * inv, dz * inv, num(p.dist, 1.5), { send: 0.05, gain: LV.cluck * num(p.amp, 0.6) });
  if (kind === 'blup') {
    const f = eng.rr(320, 650);
    const o = v.osc('sine', f);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.45, t + 0.04);
    const g = v.gain(0);
    ad(g.gain, t, 0.004, 0.6, 0.028);
    v.chain(o, g, inp);
    return v.run(t + 0.3);
  }
  if (kind === 'slosh') {
    const n = noiseBand(v, 'pink', 'lowpass', eng.rr(700, 1300), 0.7, inp);
    n.g.gain.setValueAtTime(0, t);
    n.g.gain.linearRampToValueAtTime(0.7, t + 0.05);
    n.g.gain.setTargetAtTime(0, t + 0.05, 0.08);
    return v.run(t + 0.8);
  }
  const f = eng.rr(230, 520);
  const n = noiseBand(v, 'white', 'bandpass', f, eng.rr(5, 9), inp);
  hit(n.g.gain, t, 1.0, 0.002, eng.rr(0.025, 0.05));
  const o = v.osc('sine', f);
  o.frequency.setValueAtTime(f * eng.rr(0.95, 1.1), t);
  o.frequency.exponentialRampToValueAtTime(f * 0.8, t + 0.06);
  const g = v.gain(0);
  ad(g.gain, t, 0.003, 0.35, 0.03);
  v.chain(o, g, inp);
  return v.run(t + 0.5);
}

export const SFX = {
  cast,
  strike,
  hooked,
  'tackle:snap': snap,
  escaped,
  catch: catchCue,
  'ui:click': uiClick,
  creak,
  'lure:landed': plop,
  plop,
  thud,
  'lure:twitch': twitch,
  'fish:nibble': nibble,
  'fish:bite': bite,
  'fish:swirl': swirl,
  'fish:jump': (eng, p, t) => splash(eng, p, t, true),
  'fish:splash': (eng, p, t) => splash(eng, p, t, false),
  cluck,
};
