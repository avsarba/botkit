// The sound engine: master chain, buses, lake reverb, one-shot dispatch and the per-frame tick.
// createEngine() works on ANY BaseAudioContext, so src/sandbox/audio.js renders the exact same
// graphs through an OfflineAudioContext to measure levels.
//
//   buses (amb / sfx / tackle) --> master gain --> DynamicsCompressor --> destination
//   voice sends ---------------> reverb (convolver, synthesized IR) --> master
import { clamp, makeRng } from '../config.js';
import { lakeImpulse, num, bump } from './dsp.js';
import { MIX } from './levels.js';
import { SFX } from './sfx.js';
import { CREATURES } from './creatures.js';
import { createAmbience } from './ambience.js';
import { createTackleLoops } from './loops.js';

const SOUNDS = { ...SFX, ...CREATURES };
const AMBIENT = new Set(['cluck', 'creak', ...Object.keys(CREATURES)]);
const VOICE_CAP = { high: 48, medium: 32, low: 20 };
// Event sounds that can arrive in bursts (a thrashing fish, a nervous float): minimum spacing (s).
const MIN_GAP = {
  'fish:splash': 0.1,
  'fish:jump': 0.08,
  'fish:swirl': 0.1,
  'fish:nibble': 0.05,
  'lure:twitch': 0.05,
  'lure:landed': 0.1,
  'ui:click': 0.03,
  creak: 0.1,
};

export const SOUND_NAMES = Object.keys(SOUNDS);

export function createEngine(ac, opts = {}) {
  const quality = opts.quality === 'low' || opts.quality === 'medium' ? opts.quality : 'high';
  const rng = makeRng(num(opts.seed, (Math.random() * 4294967295) >>> 0));
  const eng = {
    ac,
    quality,
    rng,
    rr: (a, b) => a + (b - a) * rng(),
    vary: (x, amt) => x * (1 + (rng() * 2 - 1) * amt),
    pick: (arr) => arr[Math.floor(rng() * arr.length) % arr.length],
    voices: new Set(),
    spatial: new Set(),
    // listener: position and horizontal right vector (for panning world sounds)
    L: { x: 0, z: 0, rx: 1, rz: 0 },
    // last known game state (lure id etc.)
    st: { lureId: 'bobber' },
  };

  // ---------------------------------------------------------------- master chain
  const master = ac.createGain();
  master.gain.value = num(opts.volume, MIX.master);
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  master.connect(comp);
  comp.connect(ac.destination);
  const bus = (v, dest = master) => {
    const g = ac.createGain();
    g.gain.value = v;
    g.connect(dest);
    return g;
  };
  eng.master = master;
  eng.comp = comp;
  // ambience bus: a gentle highpass keeps noise skirts from turning into rumble
  const ambHp = ac.createBiquadFilter();
  ambHp.type = 'highpass';
  ambHp.frequency.value = 140;
  ambHp.Q.value = 0.6;
  ambHp.connect(master);
  eng.amb = bus(MIX.amb, ambHp);
  eng.sfx = bus(MIX.sfx);
  eng.tackle = bus(MIX.tackle);

  // ---------------------------------------------------------------- lake reverb
  const revOut = bus(MIX.reverb);
  eng.rev = ac.createGain();
  const revNodes = [eng.rev, revOut];
  if (quality === 'low') {
    // cheap: two damped echoes off the far shore instead of a convolver
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    eng.rev.connect(lp);
    for (const [d, fb, g] of [
      [0.23, 0.32, 0.25],
      [0.41, 0.28, 0.18],
    ]) {
      const dl = ac.createDelay(1);
      dl.delayTime.value = d;
      const f = ac.createGain();
      f.gain.value = fb;
      const o = ac.createGain();
      o.gain.value = g;
      lp.connect(dl);
      dl.connect(f);
      f.connect(dl);
      dl.connect(o);
      o.connect(revOut);
      revNodes.push(dl, f, o);
    }
    revNodes.push(lp);
  } else {
    const conv = ac.createConvolver();
    conv.buffer = lakeImpulse(ac, quality === 'high' ? 2.8 : 2.0);
    eng.rev.connect(conv);
    conv.connect(revOut);
    revNodes.push(conv);
  }

  // ---------------------------------------------------------------- panning / placement
  const panFor = (dx, dz, k) => clamp((dx * eng.L.rx + dz * eng.L.rz) * k, -0.95, 0.95);

  // Output stage for a creature / ambient sound from a world direction (unit dx, dz) and distance.
  // Air absorption rolls off the highs with distance; the far ones get more lake reverb.
  eng.place = (v, dest, dx, dz, dist, o = {}) => {
    const d = Math.max(0.1, num(dist, 30));
    const lp = v.filter('lowpass', clamp(20000 / (1 + d / 35), 1200, 20000), 0.5);
    const g = v.gain(Math.max(0, num(o.gain, 1)));
    const pan = v.panner(0);
    lp.connect(g);
    g.connect(pan);
    pan.connect(dest);
    const send = num(o.send, 0.2);
    if (send > 0) {
      const s = v.gain(send);
      g.connect(s);
      s.connect(eng.rev);
    }
    v.pan = pan;
    v.dx = num(dx, 0);
    v.dz = num(dz, -1);
    v.panScale = clamp(d / 4, 0.25, 1) * 0.9;
    pan.pan.value = panFor(v.dx, v.dz, v.panScale);
    return lp;
  };

  // Output stage for an event sound at a world position (Vector3-like, may be missing).
  eng.at = (v, dest, pos, o = {}) => {
    let dx = eng.L.rz; // default: straight ahead, 12 m out
    let dz = -eng.L.rx;
    let d = 12;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
      const x = pos.x - eng.L.x;
      const z = pos.z - eng.L.z;
      d = Math.hypot(x, z);
      if (d > 1e-3) {
        dx = x / d;
        dz = z / d;
      }
    }
    // gentle distance law normalised to ~8 m (a 40 m cast still reads clearly), plus air absorption
    const g = clamp(Math.pow(10 / (10 + d), 0.8) * 1.6, num(o.minGain, 0.18), 1);
    const lp = v.filter('lowpass', clamp(18000 / (1 + d / 14), 2500, 18000), 0.5);
    const gn = v.gain(g * num(o.gain, 1));
    const pan = v.panner(0);
    lp.connect(gn);
    gn.connect(pan);
    pan.connect(dest);
    const send = num(o.send, 0.1) * clamp(0.5 + d / 40, 0.5, 1.6);
    if (send > 0) {
      const s = v.gain(send);
      gn.connect(s);
      s.connect(eng.rev);
    }
    v.pan = pan;
    v.dx = dx;
    v.dz = dz;
    v.panScale = clamp(d / 4, 0.25, 1) * 0.85;
    pan.pan.value = panFor(dx, dz, v.panScale);
    return lp;
  };

  const isOffline = typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
  // schedule slightly ahead of the (main-thread) clock so attacks are never truncated
  const lead = isOffline ? 0.002 : Math.max(0.02, num(ac.baseLatency, 0));
  eng.canAmbient = () => eng.voices.size < VOICE_CAP[eng.quality] * 0.6;

  // ---------------------------------------------------------------- one-shots
  // play(name, params, when) -> Voice | null. `when` is a context time (defaults to now).
  const lastAt = Object.create(null);
  eng.play = (name, params, when) => {
    const fn = SOUNDS[name];
    if (!fn) return null;
    const cap = VOICE_CAP[eng.quality];
    if (eng.voices.size >= (AMBIENT.has(name) ? cap : cap * 1.5)) return null;
    const t = Math.max(num(when, 0), ac.currentTime + lead);
    const gap = MIN_GAP[name];
    if (gap) {
      const prev = lastAt[name];
      if (prev !== undefined && Math.abs(t - prev) < gap) return null;
      lastAt[name] = t;
    }
    return fn(eng, params || {}, t) || null;
  };

  // ---------------------------------------------------------------- per-frame tick
  const ambience = opts.ambience === false ? null : createAmbience(eng, { only: opts.only });
  const tackle = createTackleLoops(eng);
  let panRx = 1;
  let panRz = 0;
  let panX = 0;
  let panZ = 0;
  let panNow = 0;
  const repan = (v) => v.pan.pan.setTargetAtTime(panFor(v.dx, v.dz, v.panScale), panNow, 0.04);

  // s = { hours, wind, windGiven, reeling, reelSpeed01, slipMps, tension01, lureId, quality,
  //       lx, lz, rx, rz }; snap = jump continuous layers to their levels (first tick / offline tests)
  eng.tick = (s, snap = false) => {
    const now = ac.currentTime;
    const q = s.quality;
    if (q === 'high' || q === 'medium' || q === 'low') eng.quality = q; // voice budget follows live quality
    if (s.lureId) eng.st.lureId = s.lureId;
    const h = ((num(s.hours, 7) % 24) + 24) % 24;
    // wind: the environment's live value when given; otherwise a calm dawn, breezier afternoon
    s.windEff = s.windGiven ? clamp(num(s.wind, 0.25), 0, 1) : 0.25 * (0.55 + 0.9 * bump(h, 8.5, 13, 17, 20.5));
    s.hours = h;
    s.reelSpeed01 = clamp(num(s.reelSpeed01, 0), 0, 1);
    s.slipMps = clamp(num(s.slipMps, 0), 0, 50);
    s.tension01 = clamp(num(s.tension01, 0), 0, 2);

    // listener
    const L = eng.L;
    L.x = num(s.lx, 0);
    L.z = num(s.lz, 0);
    let rx = num(s.rx, 1);
    let rz = num(s.rz, 0);
    const rl = Math.hypot(rx, rz);
    if (rl > 1e-4) {
      rx /= rl;
      rz /= rl;
    } else {
      rx = 1;
      rz = 0;
    }
    L.rx = rx;
    L.rz = rz;
    if (Math.abs(rx - panRx) + Math.abs(rz - panRz) > 0.01 || Math.abs(L.x - panX) + Math.abs(L.z - panZ) > 0.5) {
      panRx = rx;
      panRz = rz;
      panX = L.x;
      panZ = L.z;
      panNow = now;
      eng.spatial.forEach(repan);
    }

    tackle.tick(now, s, snap);
    if (ambience) ambience.tick(now, s, snap);
  };

  eng.setVolume = (v, tau = 0.1) => {
    const now = ac.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.setTargetAtTime(Math.max(0, v), now, tau);
  };

  eng.stats = () => ({
    voices: eng.voices.size,
    spatial: eng.spatial.size,
    loops: {
      water: !!ambience && ambience.layers.water.active,
      wind: !!ambience && ambience.layers.wind.active,
      insects: !!ambience && ambience.layers.insects.active,
      crickets: !!ambience && ambience.layers.crickets.active,
      reel: tackle.layers.reel.active,
      drag: tackle.layers.drag.active,
      hum: tackle.layers.hum.active,
    },
  });

  eng.dispose = () => {
    if (ambience) ambience.dispose();
    tackle.dispose();
    for (const v of [...eng.voices]) v.dispose();
    for (const n of [...revNodes, eng.amb, ambHp, eng.sfx, eng.tackle, master, comp]) {
      try {
        n.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
  };

  return eng;
}
