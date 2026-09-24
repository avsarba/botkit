// Audio: 100% procedural WebAudio for Loon Lake Angler (no samples).
//
//   const audio = createAudio({ events, quality });
//   startButton.onclick = () => audio.start();   // creates / resumes the AudioContext (safe to call twice)
//   loop: audio.update(frame);                     // ambience by frame.hours + reel / drag / line sounds
//   audio.setMuted(true);  audio.muted;            // smooth fade, then the context is suspended
//   audio.play('fish:jump', { position, size01 }); // any event sound (or ambience voice) directly
//
// Nothing is created before start(). Event one-shots are driven by ctx.events (see CONTRACT.md).
import { clamp } from '../config.js';
import { createEngine, SOUND_NAMES } from './engine.js';
import { MIX } from './levels.js';
import { num } from './dsp.js';

export { createEngine, SOUND_NAMES };

// Events this module turns into sounds (payloads per CONTRACT.md).
export const EVENT_SOUNDS = [
  'cast',
  'lure:landed',
  'lure:twitch',
  'fish:nibble',
  'fish:bite',
  'fish:swirl',
  'fish:jump',
  'fish:splash',
  'strike',
  'hooked',
  'tackle:snap',
  'escaped',
  'catch',
  'ui:click',
];

const EMPTY = Object.freeze({});
const noop = () => {};

export function createAudio(ctx = {}) {
  const events = ctx.events || null;
  const quality = ctx.quality || 'high';
  let ac = null;
  let eng = null;
  let started = false;
  let muted = false;
  let failed = false;
  let firstTick = true;
  let suspendTimer = 0;
  let idleTimer = 0;
  let lastUpdateMs = 0;
  let warned = false;

  // Reused every frame (no per-frame allocation).
  const st = {
    hours: 7,
    wind: 0.25,
    windGiven: false,
    windEff: 0.25,
    reeling: false,
    reelSpeed01: 0,
    slipMps: 0,
    tension01: 0,
    lureId: 'bobber',
    quality,
    lx: 0,
    lz: 0,
    rx: 1,
    rz: 0,
  };

  const isHidden = () => typeof document !== 'undefined' && document.hidden === true;
  const wantRunning = () => started && !muted && !isHidden();
  const running = () => !!ac && ac.state === 'running';

  function applyVolume(tau) {
    if (eng) eng.setVolume(wantRunning() ? MIX.master : 0, tau);
  }

  // Keep the context running only while it can be heard: suspended when muted (after the fade)
  // or when the tab is hidden, resumed when both clear.
  function sync() {
    if (!ac || ac.state === 'closed') return;
    clearTimeout(suspendTimer);
    suspendTimer = 0;
    if (wantRunning()) {
      if (ac.state !== 'running') ac.resume().catch(noop);
    } else if (started) {
      suspendTimer = setTimeout(() => {
        suspendTimer = 0;
        if (!wantRunning() && ac && ac.state === 'running') ac.suspend().catch(noop);
      }, muted && !isHidden() ? 700 : 200);
    }
  }

  function onVisibility() {
    applyVolume(isHidden() ? 0.03 : 0.25);
    sync();
  }

  // Browsers may suspend the context on their own (autoplay policy, iOS interruptions):
  // any later user gesture brings it back.
  function kick() {
    if (wantRunning() && ac && ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(noop);
  }

  // If the game loop stops calling update() (paused, journal open), fade the tackle sounds out
  // and keep the ambience scheduler ticking.
  function idleCheck() {
    if (!running() || typeof performance === 'undefined') return;
    if (performance.now() - lastUpdateMs < 400) return;
    st.reeling = false;
    st.reelSpeed01 = 0;
    st.slipMps = 0;
    st.tension01 = 0;
    tick();
  }

  function tick() {
    try {
      eng.tick(st, firstTick);
      firstTick = false;
    } catch (e) {
      warn(e);
    }
  }

  function warn(e) {
    if (warned) return;
    warned = true;
    console.warn('[audio] disabled part of the mix after an error:', e);
  }

  const api = {
    // Call from the Start button's click handler.
    start() {
      if (failed) return false;
      if (!ac) {
        const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
        if (!AC) {
          failed = true;
          return false;
        }
        try {
          ac = new AC({ latencyHint: 'interactive' });
        } catch (e) {
          try {
            ac = new AC();
          } catch (e2) {
            failed = true;
            return false;
          }
        }
        try {
          eng = createEngine(ac, { quality, volume: 0 });
        } catch (e) {
          warn(e);
          failed = true;
          try {
            ac.close();
          } catch (e3) {
            /* ignore */
          }
          ac = null;
          return false;
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        if (typeof window !== 'undefined') {
          window.addEventListener('pointerdown', kick, { capture: true, passive: true });
          window.addEventListener('keydown', kick, { capture: true, passive: true });
          window.addEventListener('touchend', kick, { capture: true, passive: true });
        }
        idleTimer = setInterval(idleCheck, 250);
        started = true;
        sync();
        applyVolume(0.6); // ~2 s fade-in
        return true;
      }
      started = true;
      sync();
      applyVolume(0.25);
      return true;
    },

    setMuted(m) {
      muted = !!m;
      applyVolume(muted ? 0.08 : 0.15);
      sync();
    },

    get muted() {
      return muted;
    },
    set muted(m) {
      api.setMuted(m);
    },

    get started() {
      return started && !failed;
    },

    // The AudioContext (null before start()).
    get context() {
      return ac;
    },

    update(frame) {
      if (!eng || !frame || !running()) return;
      if (typeof performance !== 'undefined') lastUpdateMs = performance.now();
      const inp = frame.input || EMPTY;
      st.hours = num(frame.hours, st.hours);
      st.reeling = !!inp.reeling;
      st.reelSpeed01 = clamp(num(inp.reelSpeed01, st.reeling ? 1 : 0), 0, 1);
      st.slipMps = Math.max(0, num(frame.slipMps, 0));
      st.tension01 = clamp(num(frame.tension01, 0), 0, 2);
      let w = frame.windStrength;
      if (typeof w !== 'number') w = frame.env ? frame.env.windStrength : undefined;
      if (typeof w !== 'number') w = ctx.env ? ctx.env.windStrength : undefined;
      st.windGiven = typeof w === 'number' && Number.isFinite(w);
      st.wind = st.windGiven ? w : 0.25;
      if (frame.lure && frame.lure.id) st.lureId = frame.lure.id;
      st.quality = frame.quality || quality;
      const cam = frame.camera;
      if (cam && cam.matrixWorld) {
        const e = cam.matrixWorld.elements;
        st.rx = e[0];
        st.rz = e[2];
        st.lx = e[12];
        st.lz = e[14];
      } else if (Number.isFinite(inp.aimYaw)) {
        st.rx = Math.cos(inp.aimYaw);
        st.rz = -Math.sin(inp.aimYaw);
      }
      tick();
    },

    // Play any sound by name: every event name above, plus ambience voices
    // ('loon:wail', 'loon:tremolo', 'bird:whitethroat', 'bird:robin', 'bird:chickadee', 'bird:trill',
    //  'bird:vireo', 'bird:thrush', 'owl', 'frog:green', 'peeper', 'cluck', 'creak', 'plop', 'thud').
    play(name, params) {
      if (!eng || !running()) return false;
      try {
        return !!eng.play(name, params || EMPTY);
      } catch (e) {
        warn(e);
        return false;
      }
    },

    stats() {
      return eng ? { state: ac.state, muted, ...eng.stats() } : { state: 'not-started', muted };
    },

    dispose() {
      for (const fn of unsubs) fn();
      unsubs.length = 0;
      clearTimeout(suspendTimer);
      clearInterval(idleTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', kick, { capture: true });
        window.removeEventListener('keydown', kick, { capture: true });
        window.removeEventListener('touchend', kick, { capture: true });
      }
      if (eng) eng.dispose();
      if (ac) ac.close().catch(noop);
      eng = null;
      ac = null;
      started = false;
    },
  };

  const unsubs = [];
  if (events && typeof events.on === 'function') {
    for (const name of EVENT_SOUNDS) {
      const off = events.on(name, (payload) => api.play(name, payload));
      if (typeof off === 'function') unsubs.push(off);
    }
  }

  return api;
}
