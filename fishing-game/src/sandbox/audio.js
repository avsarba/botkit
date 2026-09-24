// Audio sandbox. Renders every one-shot, the continuous tackle sounds, each wildlife voice and 8 s of
// ambience at 6:00 / 12:00 / 20:00 / 23:00 through OfflineAudioContext using the SAME engine code as the
// game, logs peak / RMS / NaN / duration for each, and draws waveform + log-frequency spectrogram.
// Also exposes a live mode (Start button -> createAudio) for scenario tests: window.__audioTest.
//
//   node build.mjs --entry src/sandbox/audio.js --out dist/sandbox-audio.html --template none
//   node tools/harness.mjs --file dist/sandbox-audio.html --out out/audio --scenario <scenario.mjs>
import { createAudio, createEngine, EVENT_SOUNDS } from '../audio/index.js';
import { createEmitter } from '../config.js';

const SR = 44100;
const W = 1280;

// ------------------------------------------------------------------ test list
const P = (x, z) => ({ x, y: 0, z });
const ONE_SHOTS = [
  ['cast (0.9)', 'cast', { power01: 0.9, lureId: 'crankbait' }, 3.4],
  ['cast (0.3)', 'cast', { power01: 0.3, lureId: 'bobber' }, 2.4],
  ['landed bobber 18m', 'lure:landed', { lureId: 'bobber', onWater: true, speed: 9, position: P(1, -18) }, 1.2],
  ['landed crank 32m', 'lure:landed', { lureId: 'crankbait', onWater: true, speed: 12, position: P(-3, -32) }, 1.2],
  ['landed topwater 14m', 'lure:landed', { lureId: 'topwater', onWater: true, speed: 10, position: P(4, -13) }, 1.2],
  ['landed on land (thud)', 'lure:landed', { lureId: 'spinner', onWater: false, speed: 7, position: P(22, 8) }, 0.8],
  ['lure:twitch', 'lure:twitch', { position: P(0, -15) }, 0.6],
  ['fish:nibble', 'fish:nibble', { strength01: 0.6 }, 0.3],
  ['fish:bite (float)', 'fish:bite', { lureId: 'bobber', position: P(0, -14) }, 1.0],
  ['fish:bite (lure tap)', 'fish:bite', { lureId: 'crankbait' }, 0.7],
  ['fish:swirl 0.7', 'fish:swirl', { size01: 0.7, position: P(3, -16) }, 1.8],
  ['fish:jump 0.9', 'fish:jump', { size01: 0.9, position: P(-4, -10) }, 2.6],
  ['fish:splash 0.5', 'fish:splash', { size01: 0.5, position: P(-2, -6) }, 2.2],
  ['strike', 'strike', { success: true, early: false }, 0.6],
  ['hooked', 'hooked', {}, 0.5],
  ['tackle:snap', 'tackle:snap', { tensionN: 60 }, 1.0],
  ['escaped', 'escaped', { reason: 'slack' }, 1.0],
  ['catch', 'catch', { record: {} }, 2.4],
  ['ui:click', 'ui:click', {}, 0.2],
  ['creak', 'creak', { amount: 0.8 }, 0.4],
];
const CREATURE_SHOTS = [
  ['loon:wail', 'loon:wail', { dx: -0.3, dz: -0.95, dist: 280 }, 7.5],
  ['loon:tremolo', 'loon:tremolo', { dx: 0.5, dz: -0.86, dist: 220 }, 3.5],
  ['white-throated sparrow', 'bird:whitethroat', { dx: 1, dz: 0.2, dist: 45, variant: 0.2 }, 4.2],
  ['robin', 'bird:robin', { dx: -1, dz: 0.3, dist: 40 }, 7],
  ['chickadee', 'bird:chickadee', { dx: 0.2, dz: 1, dist: 25 }, 9],
  ['trill (junco/chipping)', 'bird:trill', { dx: 0.8, dz: 0.6, dist: 40 }, 3],
  ['red-eyed vireo', 'bird:vireo', { dx: -0.6, dz: 0.8, dist: 40 }, 10],
  ['hermit thrush', 'bird:thrush', { dx: -0.9, dz: 0.4, dist: 80 }, 8],
  ['barred owl', 'owl', { dx: 0.3, dz: 1, dist: 200 }, 5],
  ['green frog', 'frog:green', { dx: -1, dz: -0.1, dist: 25 }, 2.5],
  ['peeper', 'peeper', { dx: -1, dz: 0.2, dist: 30 }, 0.4],
  ['water cluck', 'cluck', { dx: 0.5, dz: -0.5, dist: 1.5, amp: 0.8, kind: 'cluck' }, 0.6],
];
const TACKLE_LOOPS = [
  ['reel whir (0 -> full -> stop)', 3.5, (t, s) => {
    s.reeling = t > 0.3 && t < 2.8;
    s.reelSpeed01 = Math.min(1, (t - 0.3) / 1.2);
  }],
  ['drag zing (slip 0.2 -> 3 m/s)', 3.5, (t, s) => {
    s.slipMps = t > 0.3 && t < 3.0 ? 0.2 + (2.8 * (t - 0.3)) / 2.7 : 0;
  }],
  ['line hum + creaks (tension 0.5 -> 1)', 4, (t, s) => {
    s.tension01 = t < 0.3 ? 0 : Math.min(1, 0.5 + (0.5 * (t - 0.3)) / 2.5);
    if (t > 3.5) s.tension01 = 0;
  }],
];
const AMBIENCE = [6, 12, 20, 23];
// solo renders of single ambience layers: [label, hours, layers, seconds, state overrides]
const SOLO = [
  ['water only (wind 0.25)', 12, ['water'], 6, { wind: 0.25, windGiven: true }],
  ['wind only (wind 0.25)', 12, ['wind'], 6, { wind: 0.25, windGiven: true }],
  ['wind only (wind 0.8)', 12, ['wind'], 6, { wind: 0.8, windGiven: true }],
  ['insects only (13:00)', 13, ['insects'], 8, {}],
  ['crickets only (22:00)', 22, ['crickets'], 4, {}],
  ['peepers only (21:30)', 21.5, ['peepers'], 4, {}],
];

// ------------------------------------------------------------------ helpers
const toDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const fmtDb = (d) => (Number.isFinite(d) ? d.toFixed(1) : '-inf');

function baseState(hours) {
  return {
    hours,
    wind: 0.25,
    windGiven: false,
    windEff: 0.25,
    reeling: false,
    reelSpeed01: 0,
    slipMps: 0,
    tension01: 0,
    lureId: 'bobber',
    quality: 'high',
    lx: 0,
    lz: 0,
    rx: 1,
    rz: 0,
  };
}

async function render(dur, { seed = 7, quality = 'high', ambience = true, only, setup, tick }) {
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  const eng = createEngine(ctx, { quality, seed, ambience, only });
  if (setup) setup(eng, ctx);
  if (tick) {
    const q = 128 / SR;
    for (let t = 0.05; t < dur - 0.05; t += 0.05) {
      const ts = Math.round(t / q) * q;
      ctx.suspend(ts).then(() => {
        tick(eng, ctx.currentTime);
        ctx.resume();
      });
    }
  }
  const buf = await ctx.startRendering();
  return { buf, stats: eng.stats() };
}

function analyze(buf) {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const n = L.length;
  let peak = 0;
  let ss = 0;
  let nan = 0;
  let first = -1;
  let last = -1;
  const thr = Math.pow(10, -60 / 20);
  const win = Math.floor(SR * 0.1);
  let wss = 0;
  let stMax = 0;
  let dc = 0;
  for (let i = 0; i < n; i++) {
    let a = L[i];
    let b = R[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      nan++;
      a = 0;
      b = 0;
    }
    const m = Math.max(Math.abs(a), Math.abs(b));
    if (m > peak) peak = m;
    const e = (a * a + b * b) * 0.5;
    ss += e;
    dc += (a + b) * 0.5;
    wss += e;
    if (i >= win) {
      const a2 = L[i - win] || 0;
      const b2 = R[i - win] || 0;
      wss -= (a2 * a2 + b2 * b2) * 0.5;
    }
    if (i >= win && wss > stMax) stMax = wss;
    if (m > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const active = last > first ? last - first + 1 : 1;
  // average power spectrum -> energy per band (dB relative to the total)
  const N = 4096;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const pw = new Float64Array(N / 2);
  for (let off = 0; off + N <= n; off += N) {
    for (let i = 0; i < N; i++) {
      re[i] = ((L[off + i] + R[off + i]) * 0.5) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < N / 2; b++) pw[b] += re[b] * re[b] + im[b] * im[b];
  }
  const edges = [0, 150, 600, 2400, 8000, SR / 2];
  const band = [0, 0, 0, 0, 0];
  let tot = 0;
  for (let b = 1; b < N / 2; b++) {
    const f = (b * SR) / N;
    let k = 0;
    while (k < 4 && f >= edges[k + 1]) k++;
    band[k] += pw[b];
    tot += pw[b];
  }
  const bandsDb = band.map((e) => (tot > 0 ? +(10 * Math.log10(e / tot + 1e-12)).toFixed(1) : -120));
  let tss = 0;
  const t0i = Math.floor(n * 0.75);
  for (let i = t0i; i < n; i++) tss += (L[i] * L[i] + R[i] * R[i]) * 0.5;
  const tailDb = toDb(Math.sqrt(tss / Math.max(1, n - t0i)));
  return {
    tailDb,
    bandsDb,
    peakDb: toDb(peak),
    rmsDb: toDb(Math.sqrt(ss / n)),
    activeRmsDb: toDb(Math.sqrt(ss / active)),
    maxRms100Db: toDb(Math.sqrt(Math.max(0, stMax) / win)),
    nan,
    dcOffset: dc / n,
    startS: first >= 0 ? first / SR : 0,
    endS: last >= 0 ? (last + 1) / SR : 0,
    lenS: n / SR,
  };
}

// ------------------------------------------------------------------ drawing
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar;
        im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar;
        im[i + j] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function inferno(x) {
  x = Math.max(0, Math.min(1, x));
  const r = Math.min(255, 255 * (1.6 * x + 0.05 * Math.sin(x * 9)));
  const g = Math.min(255, 255 * Math.max(0, x * x * 1.1 - 0.05));
  const b = Math.min(255, 255 * Math.max(0, 0.5 * Math.sin(Math.PI * x * 1.1) + (x > 0.85 ? (x - 0.85) * 4 : 0)));
  return [r | 0, g | 0, b | 0];
}

function drawCell(ctx2d, x, y, w, h, label, buf, a) {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const n = L.length;
  ctx2d.fillStyle = '#16181b';
  ctx2d.fillRect(x, y, w, h);
  ctx2d.fillStyle = '#e8e4da';
  ctx2d.font = '12px system-ui, sans-serif';
  ctx2d.fillText(label, x + 6, y + 14);
  ctx2d.fillStyle = a.peakDb > -3 ? '#ff6b5a' : '#9fb6a6';
  ctx2d.font = '11px ui-monospace, monospace';
  ctx2d.fillText(`pk ${fmtDb(a.peakDb)}  rms ${fmtDb(a.activeRmsDb)}  st ${fmtDb(a.maxRms100Db)}  ${a.endS.toFixed(2)}s${a.nan ? '  NaN!' : ''}`, x + 6, y + 28);
  // waveform
  const wy = y + 34;
  const wh = Math.floor((h - 38) * 0.42);
  ctx2d.fillStyle = '#0d0e10';
  ctx2d.fillRect(x + 4, wy, w - 8, wh);
  const mid = wy + wh / 2;
  ctx2d.strokeStyle = 'rgba(255,170,60,0.45)';
  ctx2d.beginPath();
  ctx2d.moveTo(x + 4, mid - (wh / 2) * 0.5);
  ctx2d.lineTo(x + w - 4, mid - (wh / 2) * 0.5);
  ctx2d.moveTo(x + 4, mid + (wh / 2) * 0.5);
  ctx2d.lineTo(x + w - 4, mid + (wh / 2) * 0.5);
  ctx2d.stroke();
  ctx2d.strokeStyle = '#cfd8d0';
  ctx2d.beginPath();
  const cols = w - 8;
  for (let c = 0; c < cols; c++) {
    const i0 = Math.floor((c / cols) * n);
    const i1 = Math.floor(((c + 1) / cols) * n);
    let lo = 0;
    let hi = 0;
    for (let i = i0; i < i1; i++) {
      const v = (L[i] + R[i]) * 0.5;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    ctx2d.moveTo(x + 4 + c + 0.5, mid - hi * (wh / 2));
    ctx2d.lineTo(x + 4 + c + 0.5, mid - lo * (wh / 2) + 0.5);
  }
  ctx2d.stroke();
  // spectrogram (log frequency 40 Hz .. 16 kHz)
  const sy = wy + wh + 4;
  const sh = h - (sy - y) - 4;
  const N = 1024;
  const img = ctx2d.createImageData(cols, sh);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const mag = new Float64Array(N / 2);
  const fLo = 40;
  const fHi = 16000;
  for (let c = 0; c < cols; c++) {
    const center = Math.floor(((c + 0.5) / cols) * n);
    for (let i = 0; i < N; i++) {
      const k = center - N / 2 + i;
      re[i] = k >= 0 && k < n ? ((L[k] + R[k]) * 0.5) * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < N / 2; b++) mag[b] = Math.hypot(re[b], im[b]) / (N / 4);
    for (let r = 0; r < sh; r++) {
      const f = fLo * Math.pow(fHi / fLo, 1 - r / (sh - 1));
      const b = Math.min(N / 2 - 1, Math.max(1, Math.round((f / SR) * N)));
      const d = toDb(mag[b] + 1e-12);
      const [cr, cg, cb] = inferno((d + 100) / 80);
      const o = (r * cols + c) * 4;
      img.data[o] = cr;
      img.data[o + 1] = cg;
      img.data[o + 2] = cb;
      img.data[o + 3] = 255;
    }
  }
  ctx2d.putImageData(img, x + 4, sy);
  // frequency ticks
  ctx2d.fillStyle = 'rgba(255,255,255,0.55)';
  ctx2d.font = '9px ui-monospace, monospace';
  for (const f of [100, 1000, 4000, 10000]) {
    const r = (1 - Math.log(f / fLo) / Math.log(fHi / fLo)) * (sh - 1);
    ctx2d.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 6, sy + r + 3);
  }
}

// ------------------------------------------------------------------ page
document.documentElement.style.overflow = 'auto';
document.body.style.cssText = 'margin:0;background:#0b0c0d;color:#e8e4da;font:13px system-ui,sans-serif;overflow:auto;height:auto';
const bar = document.createElement('div');
bar.style.cssText = 'position:sticky;top:0;z-index:2;display:flex;gap:10px;align-items:center;padding:8px 12px;background:#15171a;border-bottom:1px solid #2a2d31';
bar.innerHTML = '<button id="start" style="font:inherit;padding:6px 14px">Start audio (live)</button><span id="status">offline renders running...</span>';
document.body.appendChild(bar);
const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.appendChild(canvas);
const statusEl = bar.querySelector('#status');

async function runOffline() {
  const results = [];
  const sections = [];
  const t0 = performance.now();
  for (const [label, name, params, dur] of ONE_SHOTS) {
    const { buf } = await render(dur, { seed: 11 + results.length, setup: (eng) => eng.play(name, params, 0.05) });
    results.push({ section: 'one-shots', label, buf, a: analyze(buf) });
  }
  for (const [label, name, params, dur] of CREATURE_SHOTS) {
    const { buf } = await render(dur, { seed: 21 + results.length, setup: (eng) => eng.play(name, params, 0.05) });
    results.push({ section: 'wildlife voices', label, buf, a: analyze(buf) });
  }
  for (const [label, dur, fn] of TACKLE_LOOPS) {
    const s = baseState(12);
    let started = false;
    const { buf } = await render(dur, {
      seed: 31 + results.length,
      ambience: false,
      setup: (eng) => {
        fn(0, s);
        eng.tick(s, false);
      },
      tick: (eng, t) => {
        fn(t, s);
        eng.tick(s, false);
        started = true;
      },
    });
    results.push({ section: 'tackle loops', label, buf, a: analyze(buf), started });
  }
  for (const h of AMBIENCE) {
    const s = baseState(h);
    const { buf, stats } = await render(8, {
      seed: 41 + h,
      setup: (eng) => eng.tick(s, true),
      tick: (eng) => eng.tick(s, false),
    });
    results.push({ section: 'ambience 8 s', label: `ambience ${String(h).padStart(2, '0')}:00  (loops: ${Object.entries(stats.loops).filter(([, v]) => v).map(([k]) => k).join(', ')})`, buf, a: analyze(buf) });
  }
  for (const [label, h, only, dur, over] of SOLO) {
    const s = Object.assign(baseState(h), over);
    const { buf } = await render(dur, {
      seed: 61 + results.length,
      only,
      setup: (eng) => eng.tick(s, true),
      tick: (eng) => eng.tick(s, false),
    });
    results.push({ section: 'ambience layers solo', label, buf, a: analyze(buf) });
  }
  for (const q of ['medium', 'low']) {
    const s = baseState(6);
    const { buf } = await render(8, { seed: 81, quality: q, setup: (eng) => eng.tick(s, true), tick: (eng) => eng.tick(s, false) });
    results.push({ section: 'quality variants', label: `ambience 06:00 quality=${q}`, buf, a: analyze(buf) });
    const r2 = await render(6, { seed: 82, quality: q, setup: (eng) => eng.play('loon:wail', { dx: 0, dz: -1, dist: 300 }, 0.05) });
    results.push({ section: 'quality variants', label: `loon:wail quality=${q}`, buf: r2.buf, a: analyze(r2.buf) });
  }
  const ms = performance.now() - t0;

  // layout
  const gridCols = { 'one-shots': 4, 'wildlife voices': 4, 'tackle loops': 3, 'ambience 8 s': 1, 'ambience layers solo': 3, 'quality variants': 2 };
  const cellH = { 'one-shots': 170, 'wildlife voices': 190, 'tackle loops': 190, 'ambience 8 s': 210, 'ambience layers solo': 200, 'quality variants': 200 };
  let y = 0;
  const order = ['one-shots', 'wildlife voices', 'tackle loops', 'ambience 8 s', 'ambience layers solo', 'quality variants'];
  const layout = [];
  for (const sec of order) {
    const items = results.filter((r) => r.section === sec);
    const cols = gridCols[sec];
    const cw = Math.floor((W - 8) / cols);
    const top = y;
    y += 24;
    items.forEach((r, i) => {
      layout.push({ r, x: 4 + (i % cols) * cw, y: y + Math.floor(i / cols) * cellH[sec], w: cw - 4, h: cellH[sec] - 4, sec });
    });
    y += Math.ceil(items.length / cols) * cellH[sec] + 6;
    sections.push({ name: sec, y: top, h: y - top });
  }
  canvas.width = W;
  canvas.height = y;
  const g = canvas.getContext('2d');
  g.fillStyle = '#0b0c0d';
  g.fillRect(0, 0, W, y);
  for (const s of sections) {
    g.fillStyle = '#e8e4da';
    g.font = '600 14px system-ui, sans-serif';
    g.fillText(s.name.toUpperCase(), 8, s.y + 17);
  }
  for (const c of layout) drawCell(g, c.x, c.y, c.w, c.h, c.r.label, c.r.buf, c.r.a);

  // report
  const rows = results.map((r) => ({
    section: r.section,
    name: r.label,
    peakDb: +r.a.peakDb.toFixed(1),
    activeRmsDb: +r.a.activeRmsDb.toFixed(1),
    maxRms100msDb: +r.a.maxRms100Db.toFixed(1),
    nan: r.a.nan,
    endS: +r.a.endS.toFixed(2),
    dc: +r.a.dcOffset.toFixed(5),
    bandsDb: r.a.bandsDb,
    tailDb: +r.a.tailDb.toFixed(1),
  }));
  console.log(`[audio-offline] rendered ${results.length} clips in ${ms.toFixed(0)} ms`);
  for (const r of rows) {
    console.log(`[audio-offline] ${r.section.padEnd(16)} ${r.name.slice(0, 44).padEnd(44)} peak ${String(r.peakDb).padStart(6)} dBFS  rms ${String(r.activeRmsDb).padStart(6)}  max100ms ${String(r.maxRms100msDb).padStart(6)}  end ${r.endS}s  tail ${r.tailDb}  nan ${r.nan}  dc ${r.dc}  bands<150|600|2.4k|8k|> ${r.bandsDb.join(' ')}`);
    if (r.nan) console.error(`[audio-offline] NaN samples in ${r.name}`);
    if (r.peakDb > -1) console.warn(`[audio-offline] ${r.name} is close to clipping (${r.peakDb} dBFS)`);
  }
  window.__audioReport = rows;
  window.__audioSections = sections.map((s) => ({ ...s, y: s.y + bar.offsetHeight }));
  statusEl.textContent = `offline: ${results.length} clips in ${(ms / 1000).toFixed(1)} s`;
}

// ------------------------------------------------------------------ live mode
const events = createEmitter();
const audio = createAudio({ events, quality: 'high' });
const frame = {
  dt: 0.016,
  time: 0,
  hours: 6,
  state: 'waiting',
  quality: 'high',
  camera: null,
  input: { aimYaw: 0, aimPitch: 0, charge01: 0, reeling: false, reelSpeed01: 0, rodSide: 0, rodLift01: 0 },
  lure: { id: 'bobber', position: { x: 0, y: 0, z: -15 }, inWater: true },
  hooked: null,
  tensionN: 0,
  tension01: 0,
  dragN: 20,
  lineOutM: 15,
  slipMps: 0,
};
let raf = 0;
let last = 0;
function loop(ts) {
  raf = requestAnimationFrame(loop);
  const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
  last = ts;
  frame.dt = dt;
  frame.time += dt;
  frame.input.aimYaw = Math.sin(frame.time * 0.3) * 0.8;
  audio.update(frame);
}
bar.querySelector('#start').addEventListener('click', () => {
  audio.start();
  events.emit('ui:click', {});
  if (!raf) raf = requestAnimationFrame(loop);
});
window.__audioTest = {
  audio,
  events,
  frame,
  EVENT_SOUNDS,
  payloads: {
    cast: { power01: 0.8, lureId: 'bobber' },
    'lure:landed': { position: { x: 0, y: 0, z: -20 }, lureId: 'bobber', onWater: true, speed: 10 },
    'lure:twitch': { position: { x: 0, y: 0, z: -12 } },
    'fish:nibble': { fishId: 1, strength01: 0.5 },
    'fish:bite': { fishId: 1, biteId: 1, speciesId: 'bluegill', weightKg: 0.3, lengthCm: 20, windowS: 1, position: { x: 0, y: -1, z: -20 } },
    'fish:swirl': { position: { x: 2, y: 0, z: -18 }, size01: 0.6 },
    'fish:jump': { position: { x: -3, y: 0.5, z: -12 }, size01: 0.8 },
    'fish:splash': { position: { x: -2, y: 0, z: -8 }, size01: 0.5 },
    strike: { success: true, early: false },
    hooked: { fish: {} },
    'tackle:snap': { tensionN: 58 },
    escaped: { reason: 'slack' },
    catch: { record: { speciesId: 'walleye' } },
    'ui:click': {},
  },
};

runOffline().then(
  () => {
    window.__offlineDone = true;
  },
  (e) => {
    console.error('[audio-offline] failed', e);
    window.__offlineDone = true;
  }
);
