// Low-level WebAudio building blocks for the audio module.
// Everything here works on any BaseAudioContext (a live AudioContext or an OfflineAudioContext),
// so the sandbox can render exactly the same graphs offline and measure them.
import { clamp, smoothstep, makeRng } from '../config.js';

export const dbToGain = (d) => Math.pow(10, d / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// Smooth window on the 24 h clock: 0 before a, rises to 1 at b, stays until c, falls to 0 at d.
// a..d may run past 24 (e.g. 22..28 for a window that ends at 4:00).
export function bump(h, a, b, c, d) {
  let best = 0;
  for (let k = -24; k <= 24; k += 24) {
    const x = h + k;
    const v = smoothstep(a, b, x) * (1 - smoothstep(c, d, x));
    if (v > best) best = v;
  }
  return best;
}

// ---------------------------------------------------------------- shared buffers / waves
const stores = new WeakMap(); // BaseAudioContext -> cache object
function store(ac) {
  let s = stores.get(ac);
  if (!s) stores.set(ac, (s = {}));
  return s;
}

// Looping noise buffers (4 s, seamless loop point, RMS normalized to 0.3 so levels are comparable).
export function noiseBuffer(ac, kind = 'white') {
  const s = store(ac);
  const key = 'noise_' + kind;
  if (s[key]) return s[key];
  const sr = ac.sampleRate;
  const len = Math.floor(sr * 4);
  const fade = Math.floor(sr * 0.05);
  const raw = new Float32Array(len + fade);
  const rng = makeRng(kind === 'white' ? 1013 : kind === 'pink' ? 2027 : 3041);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = rng() * 2 - 1;
    if (kind === 'pink') {
      // Paul Kellet's refined pink filter
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else if (kind === 'brown') {
      br = (br + 0.02 * w) / 1.02;
      raw[i] = br;
    } else raw[i] = w;
  }
  // remove DC, crossfade the tail into the head so the loop point is seamless
  let mean = 0;
  for (let i = 0; i < raw.length; i++) mean += raw[i];
  mean /= raw.length;
  const buf = ac.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = raw[i] - mean;
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    d[i] = d[i] * w + (raw[len + i] - mean) * (1 - w);
  }
  let ss = 0;
  for (let i = 0; i < len; i++) ss += d[i] * d[i];
  const k = 0.3 / Math.sqrt(ss / len || 1);
  for (let i = 0; i < len; i++) d[i] = clamp(d[i] * k, -1, 1);
  s[key] = buf;
  return buf;
}

// Outdoor lake impulse response: short pre-delay, soft build-up, a few discrete echoes off the
// tree line / far shore, then a long diffuse tail that darkens as it decays (air + foliage absorption).
export function lakeImpulse(ac, seconds = 3) {
  const s = store(ac);
  const key = 'ir_' + seconds;
  if (s[key]) return s[key];
  const sr = ac.sampleRate;
  const len = Math.max(1, Math.floor(sr * seconds));
  const buf = ac.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const rng = makeRng(7001 + ch * 131);
    const d = buf.getChannelData(ch);
    const pre = Math.floor(sr * (0.022 + ch * 0.005));
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const build = 1 - Math.exp(-t / 0.06);
      const decay = Math.exp((-6.9 * t) / seconds);
      const x = (rng() * 2 - 1) * build * decay;
      const fc = 5200 * Math.exp(-t * 1.6) + 650;
      lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * (x - lp);
      d[i] = lp;
    }
    // discrete reflections: dock/boathouse, tree line, far shore
    const echoes = [
      [0.09, 0.35],
      [0.23, 0.5],
      [0.52, 0.34],
      [0.91, 0.22],
      [1.46, 0.12],
    ];
    for (const [et, ea] of echoes) {
      const start = Math.floor(sr * (et * (1 + (rng() - 0.5) * 0.12) + ch * 0.007));
      const blen = Math.floor(sr * 0.045);
      let e = 0;
      for (let j = 0; j < blen && start + j < len; j++) {
        const w = Math.sin((Math.PI * j) / blen);
        e += 0.25 * ((rng() * 2 - 1) - e);
        d[start + j] += e * ea * w * 1.6;
      }
    }
  }
  s[key] = buf;
  return buf;
}

// PeriodicWave from harmonic amplitudes (sine phase).
export function harmonicWave(ac, name, amps) {
  const s = store(ac);
  const key = 'wave_' + name;
  if (s[key]) return s[key];
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  for (let i = 0; i < amps.length; i++) imag[i + 1] = amps[i];
  s[key] = ac.createPeriodicWave(real, imag);
  return s[key];
}

// Unnormalized periodic wave of a Hann-shaped pulse (duty 0..1) MINUS its mean value.
// Feed it into an AudioParam whose base value is `mean` to get a 0..1 pulse train.
export function pulseWave(ac, duty, harmonics = 24) {
  const s = store(ac);
  const key = 'pulse_' + duty.toFixed(3) + '_' + harmonics;
  if (s[key]) return s[key];
  const N = 2048;
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  let mean = 0;
  const p = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const ph = i / N;
    p[i] = ph < duty ? 0.5 - 0.5 * Math.cos((2 * Math.PI * ph) / duty) : 0;
    mean += p[i];
  }
  mean /= N;
  for (let k = 1; k <= harmonics; k++) {
    let a = 0, b = 0;
    for (let i = 0; i < N; i++) {
      const w = (2 * Math.PI * k * i) / N;
      a += p[i] * Math.cos(w);
      b += p[i] * Math.sin(w);
    }
    real[k] = (2 * a) / N;
    imag[k] = (2 * b) / N;
  }
  const wave = ac.createPeriodicWave(real, imag, { disableNormalization: true });
  s[key] = { wave, mean };
  return s[key];
}

// ---------------------------------------------------------------- envelopes
// All envelope helpers only schedule events at or after `t` and chain safely with each other.

// Attack/decay: 0 -> peak (linear, `a` seconds) -> exponential decay with time constant `tau`.
export function ad(param, t, a, peak, tau) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(0, t + a, tau);
  return t + a + tau * 8;
}

// Chainable hit on a shared param (several hits in a row on one gain): exponential approach up, then down.
export function hit(param, t, peak, attackTau, decayTau) {
  param.setTargetAtTime(peak, t, attackTau);
  param.setTargetAtTime(0, t + attackTau * 3, decayTau);
  return t + attackTau * 3 + decayTau * 8;
}

// Attack, hold, release (linear ramps; release ends exactly at the returned time).
export function ahr(param, t, a, peak, hold, r) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setValueAtTime(peak, t + a + hold);
  param.linearRampToValueAtTime(0, t + a + hold + r);
  return t + a + hold + r;
}

// ---------------------------------------------------------------- one-shot voices
// A Voice owns every node of one short sound. run(end) starts the sources and, once the last one
// has ended, disconnects every node so nothing leaks.
export class Voice {
  constructor(eng, t) {
    this.eng = eng;
    this.ac = eng.ac;
    this.t = t;
    this.nodes = [];
    this.srcs = [];
    this.pending = 0;
    this.done = false;
    this.pan = null; // StereoPanner for world-placed voices
    this.dx = 0;
    this.dz = 0;
    this.panScale = 0;
  }
  gain(v = 0) {
    const g = this.ac.createGain();
    g.gain.value = v;
    this.nodes.push(g);
    return g;
  }
  filter(type, freq, q = 0.707, gainDb = 0) {
    const f = this.ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    this.nodes.push(f);
    return f;
  }
  panner(p = 0) {
    const n = this.ac.createStereoPanner();
    n.pan.value = clamp(p, -1, 1);
    this.nodes.push(n);
    return n;
  }
  osc(type, freq, wave = null, t0 = this.t) {
    const o = this.ac.createOscillator();
    if (wave) o.setPeriodicWave(wave);
    else o.type = type;
    o.frequency.value = freq;
    o._t0 = t0;
    this.nodes.push(o);
    this.srcs.push(o);
    return o;
  }
  noise(kind = 'white', rate = 1, t0 = this.t) {
    const b = this.ac.createBufferSource();
    b.buffer = noiseBuffer(this.ac, kind);
    b.loop = true;
    b.playbackRate.value = rate;
    b._t0 = t0;
    b._off = this.eng.rng() * 3.5;
    this.nodes.push(b);
    this.srcs.push(b);
    return b;
  }
  // Pipe helper: a.connect(b).connect(c) ...
  chain(...n) {
    for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]);
    return n[n.length - 1];
  }
  run(end) {
    const ac = this.ac;
    const stopAt = Math.max(end, this.t + 0.02);
    const onEnd = () => {
      if (--this.pending <= 0) this.dispose();
    };
    for (const s of this.srcs) {
      s.onended = onEnd;
      const t0 = Math.max(s._t0, ac.currentTime);
      if (s._off !== undefined) s.start(t0, s._off);
      else s.start(t0);
      s.stop(Math.max(stopAt, t0 + 0.01));
      this.pending++;
    }
    this.end = stopAt;
    this.eng.voices.add(this);
    if (this.pan) this.eng.spatial.add(this);
    return this;
  }
  dispose() {
    if (this.done) return;
    this.done = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch (e) {
        /* already disconnected */
      }
    }
    this.nodes.length = 0;
    this.srcs.length = 0;
    this.eng.voices.delete(this);
    this.eng.spatial.delete(this);
  }
}

// ---------------------------------------------------------------- continuous loops
// A Loop is a continuous graph (wind, reel whir ...) that is built lazily the first time its level
// goes above zero and torn down after it has been silent for a while, so idle layers cost no CPU.
export class Loop {
  constructor(eng, bus, build, linger = 3) {
    this.eng = eng;
    this.bus = bus;
    this.build = build;
    this.linger = linger;
    this.p = null;
    this.level = 0;
    this.silentAt = 0;
  }
  // level: target gain; tauUp/tauDown: smoothing time constants; snap: jump there immediately.
  set(level, now, tauUp = 0.5, tauDown = tauUp, snap = false) {
    const on = level > 1e-4;
    if (on && !this.p) {
      this.p = this.build(this.eng, now);
      this.p.out.gain.value = 0;
      this.p.out.connect(this.bus);
      this.level = 0;
    }
    if (!this.p) return;
    const d = level - this.level;
    if (snap) {
      this.p.out.gain.cancelScheduledValues(now);
      this.p.out.gain.setValueAtTime(level, now);
      this.level = level;
    } else if (Math.abs(d) > Math.max(1e-4, this.level * 0.02) || (level === 0 && this.level !== 0)) {
      this.p.out.gain.setTargetAtTime(level, now, d > 0 ? tauUp : tauDown);
      this.level = level;
    }
    if (on) this.silentAt = 0;
    else if (!this.silentAt) this.silentAt = now + tauDown * 8 + this.linger;
    else if (now > this.silentAt) this.teardown();
  }
  get active() {
    return !!this.p;
  }
  teardown() {
    const p = this.p;
    if (!p) return;
    this.p = null;
    this.level = 0;
    this.silentAt = 0;
    for (const s of p.srcs) {
      try {
        s.stop();
      } catch (e) {
        /* not started */
      }
    }
    for (const n of p.nodes) {
      try {
        n.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      p.out.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}

// Node factory for Loops (tracks nodes/sources for teardown).
export function loopKit(eng, t) {
  const ac = eng.ac;
  const kit = {
    nodes: [],
    srcs: [],
    out: ac.createGain(),
    gain(v = 0) {
      const g = ac.createGain();
      g.gain.value = v;
      kit.nodes.push(g);
      return g;
    },
    filter(type, freq, q = 0.707, gainDb = 0) {
      const f = ac.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      if (gainDb) f.gain.value = gainDb;
      kit.nodes.push(f);
      return f;
    },
    panner(p = 0) {
      const n = ac.createStereoPanner();
      n.pan.value = p;
      kit.nodes.push(n);
      return n;
    },
    osc(type, freq, wave = null) {
      const o = ac.createOscillator();
      if (wave) o.setPeriodicWave(wave);
      else o.type = type;
      o.frequency.value = freq;
      o.start(t);
      kit.nodes.push(o);
      kit.srcs.push(o);
      return o;
    },
    noise(kind = 'white', rate = 1) {
      const b = ac.createBufferSource();
      b.buffer = noiseBuffer(ac, kind);
      b.loop = true;
      b.playbackRate.value = rate;
      b.start(t, eng.rng() * 3.5);
      kit.nodes.push(b);
      kit.srcs.push(b);
      return b;
    },
    chain(...n) {
      for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]);
      return n[n.length - 1];
    },
  };
  return kit;
}
