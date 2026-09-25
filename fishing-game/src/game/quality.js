// Adaptive quality. In auto mode the frame rate is measured over ~2 s windows, and the pixel ratio (cheap)
// and then the quality level (high -> medium -> low) follow it, in both directions:
//  - Stalls are not throughput. A frame longer than STALL_S (a shader compile, a texture upload, a
//    throttled tab or iframe) is left out of the window's median; only when long frames ARE the frame
//    rate (most of the window) does the window count as slow.
//  - Windows are judged on their MEDIAN frame time, and it takes SLOW_WINDOWS slow windows in a row to act.
//  - Before stepping down, a short probe renders ~1 s at a very low pixel ratio. If that is no faster, the
//    frame rate is capped by something detail can't fix (a 30 Hz vsync / power-saving cap, a busy CPU):
//    nothing is lowered and the manager leaves that frame rate alone instead of walking the game down to
//    its floor. If it is faster the GPU is the bottleneck and the manager steps down (pixel ratio, then
//    level) for as long as frames stay slow, without re-probing for a while.
//  - After a few fast windows the pixel ratio climbs back (up to the level's cap); after longer the level
//    itself climbs back, up to the device's default level. A step up that makes frames slow is undone at
//    once and not retried this session, so the manager can't oscillate.
//  - Level changes rebuild shader variants and can hitch, so they wait for a calm moment
//    (`canChangeLevel()`, set by the game: not mid-fight). Pixel-ratio steps happen any time.
//  - The automatic level is remembered (localStorage) so the next visit on the same machine starts there.
// A quality picked in the pause menu (setManual) switches all of this off and applies that level fully
// (with its full pixel ratio); setAuto(true) turns it back on.
const LEVELS = ['high', 'medium', 'low'];
const PR_CAP = { high: 1.75, medium: 1.5, low: 1.25 }; // manual choice / the most auto climbs to
const PR_START = { high: 1.5, medium: 1.25, low: 1 }; // auto starts here and climbs while fast
const PR_FLOOR = 0.75;
const PROBE_PR = 0.5;
const WINDOW_S = 2;
const PROBE_WINDOW_S = 1;
const LOW_FPS = 40; // median below this: slow window
const SOFT_FPS = 50; // ...or below this while the pixel ratio is above 1 (hi-DPI pixels are the first to go)
const HIGH_FPS = 56; // median at or above this: fast window
const OK_FPS = 55; // a step up that drops the median below this (and noticeably) is undone
const STALL_S = 0.25;
const PAUSE_S = 2; // a lone frame longer than this is a pause (throttled iframe, debugger), not a frame rate
const SLOW_WINDOWS = 2;
const UP_WINDOWS_PR = 3;
const UP_WINDOWS_LEVEL = 5;
const GAIN = 0.9; // the probe must cut the median frame time by at least 10 % to show a GPU bottleneck
const GPU_BOUND_S = 45; // how long a positive probe is trusted
const UP_COOLDOWN_S = 12; // after a step down, wait this long before trying to step up
const FLAP_S = 30; // a step down this soon after a step up locks that ceiling for a while
const HEADROOM_X = 1.3; // before a level up, ~1 s at this x the pixel ratio (1.7x the pixels) must stay fast
const LOCK_S = 300; // a failed climb blocks further climbs this long (doubling with each failure)
const STORE_CEIL_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const STORE_KEY = 'loonlake.quality.v1';
const STORE_MAX_AGE_MS = 21 * 24 * 3600 * 1000;

// The level a device starts at without history: phones and small tablets medium, the rest high.
export function deviceQuality() {
  let coarse = false;
  try {
    coarse = window.matchMedia('(pointer: coarse)').matches;
  } catch {
    /* ignore */
  }
  const small = Math.min(window.screen?.width || 1920, window.screen?.height || 1080) < 820;
  return coarse && small ? 'medium' : 'high';
}

// The level auto mode settled on last time (null when unknown or stale).
export function loadAutoQuality() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !LEVELS.includes(d.level) || !(Date.now() - (d.t || 0) < STORE_MAX_AGE_MS)) return null;
    return d.level;
  } catch {
    return null;
  }
}
// The highest level auto may climb to, after a climb failed on this machine (null = no limit known).
function loadAutoCeiling() {
  try {
    const d = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null');
    return d && LEVELS.includes(d.ceil) && Date.now() - (d.t || 0) < STORE_CEIL_MAX_AGE_MS ? d.ceil : null;
  } catch {
    return null;
  }
}
function saveAutoQuality(level, ceil = null) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ level, ceil, t: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function createQualityManager({ renderer, initial = 'high', auto = true, onQuality, ceiling = null, canChangeLevel = null }) {
  const dpr = () => Math.max(0.5, window.devicePixelRatio || 1);
  let quality = LEVELS.includes(initial) ? initial : 'high';
  let autoMode = !!auto;
  let pr = Math.min(dpr(), (autoMode ? PR_START : PR_CAP)[quality]);
  // highest level auto may climb back to: the device default, or the level auto was switched on at
  const ceilingOf = () => Math.min(LEVELS.indexOf(LEVELS.includes(ceiling) ? ceiling : deviceQuality()), LEVELS.indexOf(quality));
  let baseCeil = ceilingOf();
  let levelCeil = baseCeil;
  // a failed climb lowers levelCeil until lockUntil (sampled seconds); remembered for the next visit
  let lockUntil = -1;
  let failures = 0;
  if (autoMode) {
    const c = loadAutoCeiling();
    if (c && LEVELS.indexOf(c) > levelCeil) {
      levelCeil = LEVELS.indexOf(c);
      lockUntil = LOCK_S;
      failures = 1;
    }
  }
  // measurement window
  const times = new Float32Array(1024);
  const sorted = new Float32Array(1024);
  let n = 0;
  let winTime = 0;
  let longCount = 0;
  let longTime = 0;
  let clock = 0; // seconds of sampled time
  let lastHuge = false;
  let skipUntil = 1; // ignore frames until then (boot, after changes: compiles, uploads, resizes)
  let fps = 60;
  let slowStreak = 0;
  let fastStreak = 0;
  let probe = null; // { kind: 'probe' | 'up-pr' | 'headroom' | 'up-level', beforeMed, prBefore, from }
  let capMed = 0; // median frame time of a detected frame-rate cap (0 = none)
  let gpuUntil = -1; // a probe showed the GPU is the bottleneck: step without probing until then
  let pending = null; // level change waiting for a calm moment: { level, up }
  let lastDownAt = -1e9;
  let lastPrUpAt = -1e9;
  let lastLevelUpAt = -1e9;
  let lastLevelDownAt = -1e9;
  const prCeil = { ...PR_CAP }; // lowered for a while (prLockUntil) when a step up had to be undone
  let prLockUntil = -1;
  const lowerPrCeil = (q, v) => {
    prCeil[q] = Math.min(prCeil[q], v);
    prLockUntil = clock + LOCK_S;
  };
  renderer.setPixelRatio(pr);
  const save = () => saveAutoQuality(quality, lockUntil > clock ? LEVELS[levelCeil] : null);
  function lockCeil(idx) {
    levelCeil = Math.max(levelCeil, idx);
    failures++;
    lockUntil = clock + LOCK_S * 2 ** Math.min(4, failures - 1);
    save();
  }

  // (mgr is the returned object; the game may replace mgr.canChangeLevel at any time)
  const calm = () => {
    try {
      return !mgr.canChangeLevel || !!mgr.canChangeLevel();
    } catch {
      return true;
    }
  };

  // While a VR session presents, three.js owns the drawing buffer (framebuffer scale, not pixel ratio): the manager
  // never resizes it then, and its level only follows the XR profile / XR adaptive quality (see enterXR).
  let xrSaved = null;

  function applyPR(next) {
    if (xrSaved) return false;
    next = Math.round(next * 1000) / 1000;
    if (Math.abs(next - pr) < 0.005) return false;
    pr = next;
    renderer.setPixelRatio(pr);
    // setPixelRatio resizes the drawing buffer to the current CSS size
    const c = renderer.domElement;
    renderer.setSize(c.clientWidth || window.innerWidth, c.clientHeight || window.innerHeight, false);
    return true;
  }

  function setLevel(q) {
    if (!LEVELS.includes(q) || q === quality) return false;
    quality = q;
    const cap = Math.min(dpr(), PR_CAP[q]);
    if (pr > cap + 0.005) applyPR(cap);
    if (typeof onQuality === 'function') onQuality(q);
    return true;
  }

  function clearWindow() {
    n = 0;
    winTime = 0;
    longCount = 0;
    longTime = 0;
  }
  const skip = (s) => {
    skipUntil = Math.max(skipUntil, clock + s);
    clearWindow();
  };

  // ---- steps
  function stepDown() {
    const floor = Math.min(1, dpr());
    let did = false;
    if (pr > floor + 0.01) did = applyPR(Math.max(floor, pr - 0.25));
    else if (LEVELS.indexOf(quality) < LEVELS.length - 1) {
      pending = { level: LEVELS[LEVELS.indexOf(quality) + 1], up: false };
      return true; // applied at the next calm moment
    } else if (pr > PR_FLOOR + 0.01) did = applyPR(Math.max(PR_FLOOR, pr - 0.125));
    if (did) {
      // stepped down soon after climbing: this pixel ratio is the most this machine takes
      if (clock - lastPrUpAt < FLAP_S) lowerPrCeil(quality, pr);
      lastDownAt = clock;
      skip(0.5);
    }
    return did;
  }

  function startProbe(med) {
    const before = pr;
    if (!applyPR(Math.min(PROBE_PR, pr))) return false;
    probe = { kind: 'probe', beforeMed: med, prBefore: before };
    skip(0.3);
    return true;
  }

  function stepUp(med) {
    if (prLockUntil >= 0 && clock > prLockUntil) {
      for (const k of LEVELS) prCeil[k] = PR_CAP[k];
      prLockUntil = -1;
    }
    const cap = Math.min(dpr(), PR_CAP[quality], prCeil[quality]);
    if (pr < cap - 0.01) {
      const before = pr;
      applyPR(Math.min(cap, pr + 0.25));
      probe = { kind: 'up-pr', beforeMed: med, prBefore: before };
      lastPrUpAt = clock;
      skip(0.5);
      return true;
    }
    // A level up only when this level runs fine at its full pixel ratio (a lowered pr ceiling says the
    // GPU has no headroom), and after a ~1 s headroom probe at a higher pixel ratio stays fast: a level
    // change recompiles shaders, so it should not have to be undone.
    if (lockUntil >= 0 && clock > lockUntil) {
      levelCeil = baseCeil;
      lockUntil = -1;
    }
    const i = LEVELS.indexOf(quality);
    const headroom = prCeil[quality] >= Math.min(dpr(), PR_CAP[quality]) - 0.01;
    if (fastStreak >= UP_WINDOWS_LEVEL && i > levelCeil && headroom && clock - lastLevelDownAt > FLAP_S) {
      const before = pr;
      if (applyPR(Math.min(2, pr * HEADROOM_X))) {
        probe = { kind: 'headroom', beforeMed: med, prBefore: before, from: i };
        skip(0.3);
      } else pending = { level: LEVELS[i - 1], up: true, med };
      return true;
    }
    return false;
  }

  function applyPending() {
    if (!pending || !calm()) return;
    const { level, up, med } = pending;
    pending = null;
    const from = LEVELS.indexOf(quality);
    if (!setLevel(level)) return;
    const to = LEVELS.indexOf(quality);
    if (up) {
      lastLevelUpAt = clock;
      probe = { kind: 'up-level', beforeMed: med || 1 / 60, prBefore: pr, from };
    } else {
      // stepped down soon after climbing: that level is too much for this machine, stop retrying it
      if (clock - lastLevelUpAt < FLAP_S && !(lockUntil > clock)) lockCeil(to);
      lastLevelDownAt = lastDownAt = clock;
    }
    if (autoMode) save();
    skip(1.5);
    slowStreak = fastStreak = 0;
  }

  const tooSlowAfterUp = (f, p) => f < Math.min(OK_FPS, 0.93 / p.beforeMed);
  function judgeProbe(p, med) {
    const f = 1 / med;
    switch (p.kind) {
      case 'probe':
        applyPR(p.prBefore);
        skip(0.3);
        if (med <= p.beforeMed * GAIN) {
          gpuUntil = clock + GPU_BOUND_S;
          stepDown();
        } else capMed = p.beforeMed; // no faster with a quarter of the pixels: capped
        break;
      case 'up-pr':
        if (tooSlowAfterUp(f, p)) {
          applyPR(p.prBefore);
          lowerPrCeil(quality, p.prBefore);
          lastDownAt = clock;
          skip(0.5);
        }
        break;
      case 'headroom':
        applyPR(p.prBefore);
        skip(0.3);
        if (!tooSlowAfterUp(f, p)) pending = { level: LEVELS[p.from - 1], up: true, med: p.beforeMed };
        else lockCeil(p.from);
        break;
      case 'up-level':
        if (tooSlowAfterUp(f, p)) {
          lockCeil(p.from);
          pending = { level: LEVELS[p.from], up: false };
        }
        break;
      default:
        break;
    }
  }

  function judge(med) {
    const f = 1 / med;
    // a detected cap lifts when frames get fast again, or much slower (real load: stepping may help)
    if (capMed && (f >= 50 || med > capMed * 1.25)) capMed = 0;
    if (f < (pr > Math.min(1, dpr()) + 0.01 ? SOFT_FPS : LOW_FPS)) {
      slowStreak++;
      fastStreak = 0;
      if (pending && pending.up) pending = null;
    } else {
      slowStreak = 0;
      if (pending && !pending.up) pending = null; // recovered before a calm moment came
      fastStreak = f >= HIGH_FPS ? fastStreak + 1 : 0;
    }
    if (slowStreak >= SLOW_WINDOWS) {
      if (capMed || pending) return;
      slowStreak = 0;
      if (clock < gpuUntil || !startProbe(med)) stepDown();
      return;
    }
    if (fastStreak >= UP_WINDOWS_PR && clock - lastDownAt > UP_COOLDOWN_S && !pending && stepUp(med) && probe) fastStreak = 0;
  }

  function closeWindow() {
    const total = winTime + longTime;
    const sustained = longTime >= 0.5 * total && (longCount >= 3 || n < 8);
    let med = 0;
    if (sustained) med = total / Math.max(1, n + longCount);
    else if (n >= 8) {
      sorted.set(times.subarray(0, n));
      med = sorted.subarray(0, n).sort()[n >> 1];
    }
    clearWindow();
    if (!(med > 0)) return; // inconclusive (a lone stall in a short window)
    fps = 1 / med;
    if (!autoMode) return;
    if (probe) {
      const p = probe;
      probe = null;
      judgeProbe(p, med);
      return;
    }
    judge(med);
  }

  // Call once per rendered frame with the real (unclamped) frame time in seconds.
  function sample(realDt) {
    if (!(realDt > 0) || xrSaved) return;
    clock += Math.min(realDt, 5);
    if (autoMode && pending) applyPending();
    if (clock < skipUntil) return;
    // one very long frame is a pause and says nothing; a run of them is the frame rate (< 0.5 fps)
    const huge = realDt > PAUSE_S;
    const isolated = huge && !lastHuge;
    lastHuge = huge;
    if (isolated) return;
    if (realDt > STALL_S) {
      longCount++;
      longTime += Math.min(realDt, 10);
    } else {
      if (n < times.length) times[n++] = realDt;
      winTime += realDt;
    }
    const quick = probe && (probe.kind === 'probe' || probe.kind === 'headroom');
    if (winTime + longTime >= (quick ? PROBE_WINDOW_S : WINDOW_S)) closeWindow();
  }

  // After a pause / resume: start a fresh window (a running probe is abandoned and undone).
  function reset() {
    if (probe && (probe.kind === 'probe' || probe.kind === 'headroom')) applyPR(probe.prBefore);
    probe = null;
    slowStreak = 0;
    fastStreak = 0;
    skip(1);
  }

  const mgr = {
    // () => bool: may the level change right now? (null = any time)
    canChangeLevel: typeof canChangeLevel === 'function' ? canChangeLevel : null,
    sample,
    reset,
    // UI / debug choice: that level with its full pixel ratio; automatic mode off.
    setManual(q) {
      if (!LEVELS.includes(q)) return;
      if (xrSaved) {
        // in VR: takes effect now for the scene; the desktop gets it (with its pixel ratio) after the session
        xrSaved.quality = q;
        xrSaved.auto = false;
        autoMode = false;
        setLevel(q);
        return;
      }
      if (probe && (probe.kind === 'probe' || probe.kind === 'headroom')) applyPR(probe.prBefore);
      autoMode = false;
      pending = null;
      probe = null;
      capMed = 0;
      setLevel(q);
      applyPR(Math.min(dpr(), PR_CAP[q]));
      reset();
    },
    setAuto(on) {
      if (xrSaved) {
        xrSaved.auto = !!on;
        autoMode = !!on;
        return;
      }
      const was = autoMode;
      autoMode = !!on;
      if (autoMode && !was) {
        pending = null;
        probe = null;
        capMed = 0;
        gpuUntil = -1;
        levelCeil = baseCeil = ceilingOf();
        lockUntil = -1;
        failures = 0;
        for (const k of LEVELS) prCeil[k] = PR_CAP[k];
        prLockUntil = -1;
        save();
      }
      reset();
    },
    setPixelRatio(p) {
      applyPR(Math.max(0.5, Math.min(p, 2)));
    },
    // ---- VR: the scene level follows the XR profile while presenting; the desktop level, mode and pixel ratio
    // come back afterwards (three.js restores the drawing buffer size itself when the session ends).
    enterXR(level) {
      if (xrSaved) return;
      if (probe && (probe.kind === 'probe' || probe.kind === 'headroom')) applyPR(probe.prBefore);
      probe = null;
      pending = null;
      xrSaved = { quality, auto: autoMode };
      setLevel(LEVELS.includes(level) ? level : quality);
    },
    setXRLevel(q) {
      return !!xrSaved && setLevel(q);
    },
    exitXR() {
      if (!xrSaved) return;
      const s = xrSaved;
      xrSaved = null;
      autoMode = s.auto;
      setLevel(s.quality);
      const cap = Math.min(dpr(), PR_CAP[quality]);
      if (!autoMode) applyPR(cap); // a level picked meanwhile comes with its full pixel ratio
      else if (pr > cap + 0.005) applyPR(cap);
      reset();
    },
    get inXR() {
      return !!xrSaved;
    },
    get quality() {
      return quality;
    },
    get pixelRatio() {
      return pr;
    },
    get fps() {
      return fps;
    },
    get auto() {
      return autoMode;
    },
    // debugging: what the manager is doing
    get status() {
      return {
        quality,
        pr,
        auto: autoMode,
        fps: Math.round(fps * 10) / 10,
        capFps: capMed ? Math.round(10 / capMed) / 10 : 0,
        gpuBound: clock < gpuUntil,
        probe: probe ? probe.kind : null,
        pending: pending ? pending.level : null,
        ceiling: LEVELS[levelCeil],
        lockedS: lockUntil > clock ? Math.round(lockUntil - clock) : 0,
        prCeil: prCeil[quality],
      };
    },
  };
  return mgr;
}

// ---------------------------------------------------------------- WebXR (VR) quality (XR.md "Rendering while presenting")
// A profile is a scene level plus the XR layer's framebuffer scale and fixed foveation. The framebuffer scale is fixed
// for a session (it sizes the layer); foveation and the scene level adapt to the XR frame time.
export const XR_PROFILES = Object.freeze({
  high: Object.freeze({ framebufferScale: 1.0, foveation: 0.5 }),
  medium: Object.freeze({ framebufferScale: 0.9, foveation: 0.8 }),
  low: Object.freeze({ framebufferScale: 0.75, foveation: 1.0 }),
});

// Standalone headsets (Quest, Pico and other mobile-GPU VR browsers) render on a phone-class GPU.
export function isStandaloneHeadset(ua) {
  let s = ua;
  if (typeof s !== 'string') {
    try {
      s = navigator.userAgent || '';
    } catch {
      s = '';
    }
  }
  return /OculusBrowser|Quest|Pico|Mobile VR/i.test(s);
}

// The XR profile when the player hasn't picked a level: 'low' on standalone headsets, 'medium' otherwise.
export function defaultXRLevel(ua) {
  return isStandaloneHeadset(ua) ? 'low' : 'medium';
}

const XR_WINDOW_S = 2;
const XR_STALL_S = 0.25; // longer frames are hitches (compiles, uploads, the system menu), not the frame rate
const XR_SLOW_X = 1.2; // median frame time above this many display periods: slow window
const XR_FAST_X = 1.06; // ...below this: fast window
const XR_SLOW_WINDOWS = 2;
const XR_FAST_WINDOWS = 6;
const XR_UP_COOLDOWN_S = 15;
const XR_FLAP_S = 20; // a level-up that is slow this soon is undone and not retried for XR_LOCK_S
const XR_LOCK_S = 120;

// Adaptive quality inside a VR session: slow frames first raise fixed foveation to 1, then step the scene level down
// (at a calm moment, like the desktop manager); sustained headroom climbs back up to the profile, never above it.
export function createXRAdaptive({ qm, renderer, getFrameRate }) {
  let profile = 'medium';
  let foveation = XR_PROFILES.medium.foveation;
  let framebufferScale = XR_PROFILES.medium.framebufferScale;
  let on = false;
  const times = new Float32Array(2048);
  let n = 0;
  let winT = 0;
  let clock = 0;
  let slow = 0;
  let fast = 0;
  let fps = 0;
  let lastDownAt = -1e9;
  let lastUpAt = -1e9;
  let lockUntil = -1;
  let pending = null; // level waiting for a calm moment
  const calm = () => {
    try {
      return !qm.canChangeLevel || !!qm.canChangeLevel();
    } catch {
      return true;
    }
  };
  const setFov = (f) => {
    foveation = Math.max(0, Math.min(1, f));
    try {
      renderer.xr.setFoveation(foveation);
    } catch {
      /* ignore */
    }
  };

  function start(level) {
    profile = XR_PROFILES[level] ? level : 'medium';
    foveation = XR_PROFILES[profile].foveation;
    framebufferScale = XR_PROFILES[profile].framebufferScale;
    on = true;
    n = 0;
    winT = 0;
    slow = fast = 0;
    pending = null;
    lastDownAt = lastUpAt = -1e9;
    lockUntil = -1;
    return { level: profile, framebufferScale, foveation };
  }
  function stop() {
    on = false;
    pending = null;
  }

  const LV = ['high', 'medium', 'low'];
  function stepDown() {
    if (foveation < 1 - 1e-3) {
      setFov(1);
      return true;
    }
    const i = LV.indexOf(qm.quality);
    if (i < LV.length - 1) {
      pending = LV[i + 1];
      return true;
    }
    return false;
  }
  function stepUp() {
    const i = LV.indexOf(qm.quality);
    const pi = LV.indexOf(profile);
    if (i > pi && !(lockUntil > clock)) {
      pending = LV[i - 1];
      return true;
    }
    if (i <= pi && foveation > XR_PROFILES[profile].foveation + 1e-3) {
      setFov(XR_PROFILES[profile].foveation);
      return true;
    }
    return false;
  }

  function closeWindow() {
    if (n < 8) {
      n = 0;
      winT = 0;
      return;
    }
    const med = times.subarray(0, n).sort()[n >> 1];
    n = 0;
    winT = 0;
    fps = 1 / med;
    const period = 1 / Math.max(30, getFrameRate() || 72);
    if (med > period * XR_SLOW_X) {
      fast = 0;
      if (pending && LV.indexOf(pending) < LV.indexOf(qm.quality)) pending = null;
      if (clock - lastUpAt < XR_FLAP_S) lockUntil = clock + XR_LOCK_S;
      if (++slow >= XR_SLOW_WINDOWS) {
        slow = 0;
        if (stepDown()) lastDownAt = clock;
      }
    } else {
      slow = 0;
      fast = med < period * XR_FAST_X ? fast + 1 : 0;
      if (fast >= XR_FAST_WINDOWS && clock - lastDownAt > XR_UP_COOLDOWN_S) {
        fast = 0;
        if (stepUp()) lastUpAt = clock;
      }
    }
  }

  // once per XR frame, with the real frame time (s)
  function sample(realDt) {
    if (!on || !(realDt > 0)) return;
    clock += Math.min(realDt, 5);
    if (pending && calm()) {
      qm.setXRLevel(pending);
      pending = null;
      n = 0;
      winT = 0;
    }
    if (!qm.auto) return; // a level picked by hand stays put
    if (realDt > XR_STALL_S) return;
    if (n < times.length) times[n++] = realDt;
    winT += realDt;
    if (winT >= XR_WINDOW_S) closeWindow();
  }

  return {
    start,
    stop,
    sample,
    get status() {
      return { profile, level: qm.quality, framebufferScale, foveation, fps: Math.round(fps * 10) / 10, targetFps: getFrameRate(), pending, auto: qm.auto };
    },
    get profile() {
      return profile;
    },
    get foveation() {
      return foveation;
    },
    get framebufferScale() {
      return framebufferScale;
    },
  };
}
