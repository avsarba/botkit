// Game core: state machine over STATES, the per-frame pipeline, input -> actions, the fight, the
// catch flow, persistence, pause, adaptive quality and the window.__game debug API.
// VR (WebXR, XR.md): src/xr/ owns the session, rig, controllers and haptics; here the controller snapshot
// becomes casts, reeling, hooksets and menu actions (xrActions / processInput), the view is bypassed while the
// headset presents, and UI calls also go to the XR HUD.
//
// Frame order (CONTRACT.md): input -> hours -> env.setTimeOfDay/update -> scenery.update ->
// tackle.update -> fish.update -> fight substeps -> tackle.setFight/setRodLoad -> water.update ->
// audio.update -> ui.update -> render.
import * as THREE from 'three';
import { STATES, LURES, TACKLE, DAY, DOCK, clamp, damp, formatWeight } from '../config.js';
import { createFightModel, FIGHT } from './fight.js';
import { makeRecord, catchFlags, writeSave, loadSave, sanitizeRecords, mergeRecords, SAVE_KEY } from './records.js';
import { createShowcase } from './showcase.js';
import { createInput } from './input.js';
import { createView, DEFAULT_PITCH } from './view.js';
import { createQualityManager, defaultXRLevel } from './quality.js';
import { createXR } from '../xr/index.js';

const DEG = Math.PI / 180;
const LURE_BY_ID = Object.fromEntries(LURES.map((l) => [l.id, l]));
const QUALITIES = ['high', 'medium', 'low'];
// A click this soon after a nibble on the float is an early strike (the bait is yanked away).
const EARLY_STRIKE_S = 0.6;
// A lure hit while the angler keeps reeling sets itself after this long (a "reel set").
const REEL_SET_S = 0.12;
// The game clock only runs while the angler is fishing (not while netting, admiring a catch,
// re-tying or watching a fish swim off); pause and the journal stop the whole simulation.
const CLOCK_STATES = new Set([STATES.READY, STATES.CHARGING, STATES.CASTING, STATES.WAITING, STATES.STRIKE, STATES.FIGHTING]);
// Coaching prompts during the angler's first few fights.
const HINT_FIGHTS = 3;
// Retrieve advice per lure while it is in the water: [mouse / keyboard, touch with Slow off, touch with
// Slow on]. The slow retrieve is Shift on a keyboard and the Slow toggle beside the big button on touch.
const LURE_PROMPTS = {
  spinner: ['Steady, medium retrieve: hold Shift and reel', 'Tap Slow, then hold Reel for a steady retrieve', 'Hold Reel for a steady retrieve \u00b7 pause now and then'],
  crankbait: ['Hold to crank it down \u00b7 pause now and then', 'Hold to crank it down \u00b7 pause now and then', 'Hold to crank it down \u00b7 pause now and then'],
  topwater: ['Shift + hold for a slow walk \u00b7 pause now and then', 'Tap Slow, then hold Reel to walk it \u00b7 pause now and then', 'Hold Reel to walk it \u00b7 pause now and then'],
};
const LOGGED_EVENTS = [
  'cast', 'lure:landed', 'lure:home', 'fish:interest', 'fish:nibble', 'fish:bite', 'fish:swirl', 'fish:missed',
  'fish:spooked', 'fish:jump', 'strike', 'hooked', 'tackle:snap', 'escaped', 'catch', 'state',
];
const wrap24 = (h) => ((h % 24) + 24) % 24;
const normUnits = (u) => (u === 'metric' || u === 'kg' || u === 'cm' || u === 'si' ? 'metric' : 'imperial');
const dragNFor = (d01) => TACKLE.dragMinN + clamp(d01, 0, 1) * (TACKLE.dragMaxN - TACKLE.dragMinN);

export function createGame(opts) {
  const { renderer, scene, camera, events } = opts;
  const canvas = renderer.domElement;
  const saved = opts.save || {};
  const hot = opts.hotData || {};
  const settings = saved.settings && typeof saved.settings === 'object' ? saved.settings : {};

  // ---------------------------------------------------------------- persistent state
  let records = sanitizeRecords(Array.isArray(hot.records) ? hot.records : saved.records);
  let units = normUnits(hot.units ?? settings.units);
  let muted = typeof hot.muted === 'boolean' ? hot.muted : !!settings.muted;
  let lureId = LURE_BY_ID[hot.lureId] ? hot.lureId : LURE_BY_ID[settings.lureId] ? settings.lureId : LURES[0].id;
  let drag01 = Number.isFinite(settings.drag01) ? clamp(settings.drag01, 0, 1) : TACKLE.dragDefault01;
  let hours = Number.isFinite(hot.hours) ? wrap24(hot.hours) : DAY.startHours;
  let manualQuality = QUALITIES.includes(settings.quality) ? settings.quality : null;
  // fights started so far (all sessions): the first few get coaching prompts
  let fightsSeen = Number.isFinite(settings.fights) ? Math.max(0, Math.floor(settings.fights)) : 0;
  // VR: which hand holds the rod (the other reels)
  let rodHand = settings.rodHand === 'left' ? 'left' : 'right';

  // Another tab of the same artifact may have logged catches since this one loaded: merge the stored
  // log in before every write so neither tab's catches are lost (last writer no longer wins).
  function mergeStored() {
    const stored = loadSave();
    const merged = mergeRecords(records, sanitizeRecords(stored.records));
    if (merged !== records) records = merged;
  }
  let persistTimer = 0;
  function persist() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    mergeStored();
    writeSave({ v: 1, records, settings: { units, muted, lureId, drag01, quality: manualQuality, fights: fightsSeen, rodHand } });
  }
  // Settings changes (a drag step per wheel tick, lure, mute, units) are debounced: one write after
  // the last change instead of re-serialising the whole log on every step.
  function persistSoon() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persist();
    }, 400);
  }
  function flushPersist() {
    if (persistTimer) persist();
  }
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('storage', (e) => {
    if (e.key !== SAVE_KEY || !e.newValue) return;
    let data = null;
    try {
      data = JSON.parse(e.newValue);
    } catch {
      return;
    }
    const merged = mergeRecords(records, sanitizeRecords(data && data.records));
    if (merged !== records) records = merged; // the HUD / journal pick it up on the next update
  });

  // ---------------------------------------------------------------- modules (attached after the staged build)
  let ui = null;
  let env = null;
  let scenery = null;
  let water = null;
  let fish = null;
  let tackle = null;
  let audio = null;
  let showcase = null;
  let ready = false;
  const readyWaiters = [];

  const view = createView(camera);
  const fight = createFightModel();
  const qm = createQualityManager({
    renderer,
    initial: manualQuality || opts.quality || 'high',
    auto: !manualQuality,
    onQuality: (q) => {
      frame.quality = q;
    },
  });
  const xr = createXR({
    renderer,
    scene,
    camera,
    events,
    qm,
    species: opts.species || [],
    getHandlers: () => handlers,
    getModules: () => ({ tackle, showcase, ui, audio }),
    getConfig: () => ({ units, muted, quality: qm.auto ? 'auto' : qm.quality, records, rodHand, lureId, hours }),
    hooks: {
      onStart: (info) => onXRStart(info),
      onCameraRestored: () => restoreDesktopView(),
      onEnd: () => onXREnd(),
      onVisibility: (v) => onXRVisibility(v),
      onAvailability: (ok) => announceXR(ok),
    },
  });
  xr.setRodHand(rodHand);

  // ---------------------------------------------------------------- frame (CONTRACT.md "Frame object")
  const frame = {
    dt: 0,
    time: 0,
    hours,
    camera,
    state: STATES.TITLE,
    quality: qm.quality,
    input: { aimYaw: 0, aimPitch: DEFAULT_PITCH, charge01: 0, reeling: false, reelSpeed01: 0, rodSide: 0, rodLift01: 0.4 },
    lure: null,
    hooked: null,
    tensionN: 0,
    tension01: 0,
    dragN: dragNFor(drag01),
    lineOutM: 0,
    slipMps: 0,
  };

  // ---------------------------------------------------------------- run-time state
  let state = STATES.TITLE;
  let stateT = 0;
  let titleT = 0;
  const held = new Set();
  let debugReel = false;
  let debugRod = null;
  let chargeT = 0;
  let charge = 0;
  let reel01 = 0;
  let lastNibbleT = -99;
  let lastJumpT = -99;
  let fightHints = false; // coach this fight (one of the angler's first few)
  let bite = null;
  let catchRec = null;
  let userPaused = false;
  let journalOpen = false;
  let slowToggle = false; // touch: the Slow chip (Shift on a keyboard)
  let timeScale = 1;
  let lastNow = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fps = 0;
  let lastCalls = 0;
  let lastTris = 0;
  let needsRender = false;
  let xrCharge = false; // CHARGING was entered with the rod-hand trigger (VR)
  let xrReelWas = false; // the reel hand was reeling last frame (VR reel-set release)
  let lastFlags = null; // the catch card's flags (the VR card is shown again when a session starts on it)
  const pendingCasts = [];
  const eventLog = [];
  const _tip = new THREE.Vector3();
  const _butt = new THREE.Vector3();
  const _rodDir = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _steer = { x: 0, y: 0 };
  const _keys = { x: 0, y: 0 };
  const _touch = { x: 0, y: 0 };
  const fightInp = { hooked: null, rodTip: _tip, rodDir: _rodDir, dragN: 0, reeling: false, reelMps: 0, rodSide: 0, rodLift01: 0.4, rightX: 1, rightZ: 0 };

  for (const t of LOGGED_EVENTS) {
    events.on(t, (p) => {
      eventLog.push({ t: +frame.time.toFixed(2), type: t, reason: p && p.reason, to: p && p.to, speciesId: p && p.speciesId });
      if (eventLog.length > 300) eventLog.shift();
    });
  }

  // ---------------------------------------------------------------- state machine
  function setState(to) {
    if (to === state) return;
    const from = state;
    state = to;
    frame.state = to;
    stateT = 0;
    // after a fight the view drifts back to the resting look out over the water
    if (to === STATES.READY && (from === STATES.SNAPPED || from === STATES.CAUGHT || from === STATES.FIGHTING || from === STATES.LANDING)) view.set(NaN, DEFAULT_PITCH);
    if (ui) ui.setState(to);
    events.emit('state', { from, to });
  }

  function lure() {
    return tackle ? tackle.getLure() : null;
  }

  function toast(text, kind = 'info') {
    if (ui) ui.toast(text, kind);
    xr.hudCall('toast', text, kind);
  }

  function startGame() {
    if (!ready || state !== STATES.TITLE) return;
    if (audio) {
      try {
        audio.start();
      } catch (err) {
        console.warn('[core] audio start failed', err);
      }
    }
    if (ui) ui.hideTitle();
    input.disarm();
    view.set(view.v.yaw * 0.3, DEFAULT_PITCH);
    qm.reset();
    setState(STATES.READY);
  }

  // ---- actions (mouse button / Space / the touch button / debug)
  function actionDown(source) {
    if (!ready || state === STATES.TITLE || userPaused || journalOpen) return;
    if (held.has(source)) return;
    held.add(source);
    switch (state) {
      case STATES.READY:
        chargeT = 0;
        charge = 0;
        setState(STATES.CHARGING);
        break;
      case STATES.WAITING: {
        // a strike right on top of a nibble yanks the bait away from the fish
        const L = lure();
        if (L && LURE_BY_ID[L.id] && LURE_BY_ID[L.id].kind === 'bait' && L.inWater && frame.time - lastNibbleT < EARLY_STRIKE_S) earlyStrike();
        break;
      }
      case STATES.STRIKE:
        hookset();
        break;
      default:
        break;
    }
  }

  function actionUp(source, cancel = false) {
    if (!held.delete(source)) return;
    // a lure hit while the angler was reeling: letting go of the reel and sweeping the rod sets the hook
    if (state === STATES.STRIKE && bite && bite.reelSet && !cancel && held.size === 0) {
      hookset();
      return;
    }
    if (held.size > 0 || state !== STATES.CHARGING) return;
    if (cancel || userPaused || chargeT < 0.12) {
      setState(STATES.READY); // a click, or the window lost focus mid-charge: no cast
      return;
    }
    doCast(charge);
  }

  // dir: horizontal unit Vector3 (default: where the view aims); opts: { pitchRad } (VR launch pitch)
  function doCast(power01, dir = null, opts = null) {
    const p = clamp(power01, 0, 1);
    if (dir) _dir.copy(dir);
    else view.aimDir(_dir);
    if (opts) tackle.cast(p, _dir, opts);
    else tackle.cast(p, _dir);
    events.emit('cast', { power01: p, lureId });
    setState(STATES.CASTING);
  }

  function earlyStrike() {
    events.emit('strike', { success: false, early: true });
    const hit = fish.missBite(null, 'early');
    toast(hit ? 'Too early! Wait for the float to go under' : 'Nothing there yet', 'info');
  }

  function hookset() {
    if (state !== STATES.STRIKE) return;
    const hf = bite ? fish.hookBite(bite.biteId) : null;
    bite = null;
    if (hf) {
      events.emit('strike', { success: true, early: false });
      const L = lure();
      beginFight(hf, L ? L.lineOutM : NaN);
    } else {
      events.emit('strike', { success: false, early: false });
      events.emit('escaped', { reason: 'missed' });
      toast('Missed it', 'info');
      setState(STATES.WAITING);
    }
  }

  function beginFight(hf, lineOutM) {
    tackle.getRodTip(_tip);
    const d = hf.position.distanceTo(_tip);
    const lo = Number.isFinite(lineOutM) ? clamp(lineOutM, d - 0.5, d + 0.3) : d;
    fight.begin(hf, _tip, lo);
    frame.hooked = hf;
    fightHints = fightsSeen < HINT_FIGHTS;
    fightsSeen++;
    persistSoon();
    setState(STATES.FIGHTING);
    events.emit('hooked', { fish: hf });
    tackle.setFight(true, { fishPosition: hf.position, tensionN: 0, lineOutM: fight.lineOutM });
  }

  function endFightSnap(tensionN, spooled) {
    tackle.snap(); // while the tackle is still in 'fish' mode: the long end stays with the fish
    fish.releaseHooked('snapped');
    fight.end();
    frame.hooked = null;
    events.emit('tackle:snap', { tensionN });
    toast(spooled ? 'Spooled! The fish took every yard of line' : `Snap! The line parted at ${formatWeight(tensionN / 9.80665, units)} of pull`, 'bad');
    setState(STATES.SNAPPED);
  }

  function endFightEscape(reason, pulled = false) {
    fish.releaseHooked('escaped');
    fight.end();
    frame.hooked = null;
    tackle.setFight(false);
    events.emit('escaped', { reason });
    let msg = 'Slack line. The hook fell out';
    if (pulled) msg = 'The hook pulled out. Keep the rod up to cushion head shakes and jumps';
    else if (reason === 'headshake') msg = 'It shook its head on a slack line and threw the hook';
    toast(msg, 'bad');
    setState(STATES.ESCAPED);
  }

  const landTarget = new THREE.Vector3();
  function startLanding() {
    const hf = fish.getHooked();
    if (!hf) return;
    const side = hf.position.x >= 0 ? 1 : -1;
    landTarget.set(side * 0.45, -0.07, DOCK.endZ - 0.75);
    hf.toLanding(landTarget, 1.4);
    setState(STATES.LANDING);
  }

  function enterCaught() {
    const hf = fish.getHooked();
    if (!hf) {
      setState(STATES.READY);
      return;
    }
    fight.end();
    const rec = makeRecord({ species: hf.species, weightKg: hf.weightKg, lengthCm: hf.lengthCm, lureId, hours });
    const flags = catchFlags(records, rec);
    records = records.concat([rec]);
    persist();
    catchRec = rec;
    if (hf.object3d) hf.object3d.visible = false; // in the angler's hands now
    tackle.setFight(false);
    const girth = hf.weightKg > 0 ? clamp(Math.sqrt(hf.weightKg / Math.max(1e-4, (hf.species.lw.a * Math.pow(hf.lengthCm, hf.species.lw.b)) / 1000)), 0.85, 1.2) : 1;
    lastFlags = flags;
    try {
      showcase.show(hf.species, hf.lengthCm, { quality: frame.quality, seed: hf.id * 7919, girth });
    } catch (err) {
      console.warn('[core] showcase failed', err);
    }
    setState(STATES.CAUGHT);
    if (ui) ui.showCatch(rec, flags);
    xr.hudCall('showCatch', rec, flags);
    events.emit('catch', { record: rec });
    // (personal best / new species: the catch card stamps them, no toast on top)
  }

  function finishCatch(kept) {
    if (state !== STATES.CAUGHT) return;
    if (catchRec) {
      catchRec.kept = !!kept;
      records = records.slice();
      persist();
    }
    const hf = fish.getHooked();
    if (kept) fish.releaseHooked('landed');
    else {
      if (hf && hf.object3d) hf.object3d.visible = true;
      fish.releaseHooked('released');
    }
    frame.hooked = null;
    showcase.hide();
    if (ui) ui.hideCatch(); // no-op when the card's own button already closed it
    xr.hudCall('hideCatch');
    tackle.resetToHome();
    catchRec = null;
    input.disarm();
    setState(STATES.READY);
  }

  // Bring everything back to "lure at the rod tip" (debug helpers, lure changes).
  function resetToReady() {
    if (state === STATES.CAUGHT) finishCatch(false);
    if (fish.getHooked()) fish.releaseHooked('escaped');
    fight.end();
    frame.hooked = null;
    bite = null;
    showcase.hide();
    tackle.resetToHome();
    setState(STATES.READY);
  }

  // ---------------------------------------------------------------- settings
  function setLure(id, force = false) {
    if (!LURE_BY_ID[id]) return false;
    if (state !== STATES.READY && state !== STATES.TITLE && !force) {
      toast('Reel in before you change lures', 'info');
      return false;
    }
    if (force && state !== STATES.READY && state !== STATES.TITLE) resetToReady();
    lureId = id;
    tackle.setLure(id);
    persistSoon();
    return true;
  }
  function setDrag(d01) {
    drag01 = Math.round(clamp(d01, 0, 1) * 1000) / 1000;
    frame.dragN = dragNFor(drag01);
    persistSoon();
  }
  function setMuted(m) {
    muted = !!m;
    if (audio) audio.setMuted(muted);
    persistSoon();
  }
  function setUnits(u) {
    units = normUnits(u);
    persistSoon();
  }
  function setHours(h) {
    if (!Number.isFinite(h)) return;
    hours = wrap24(h);
    frame.hours = hours;
    if (env) {
      env.setTimeOfDay(hours);
      if (typeof env.bakeEnvironment === 'function') env.bakeEnvironment();
    }
    needsRender = true;
  }
  function setQualityManual(q) {
    if (q === 'auto') {
      // back to adaptive quality (it starts from the current level and may climb back up)
      manualQuality = null;
      qm.setAuto(true);
    } else {
      if (!QUALITIES.includes(q)) return;
      manualQuality = q;
      qm.setManual(q);
    }
    frame.quality = qm.quality;
    persistSoon();
    needsRender = true;
  }
  function setUserPause(p) {
    p = !!p && state !== STATES.TITLE && ready;
    if (p === userPaused) return;
    userPaused = p;
    if (ui) ui.setPaused(p);
    if (p) xr.hudCall('openMenu', menuState());
    else xr.hudCall('closeMenu');
    if (p) {
      input.releaseAll();
      held.clear();
      if (state === STATES.CHARGING) setState(STATES.READY);
    } else {
      input.disarm();
      lastNow = 0;
      qm.reset();
    }
  }
  function openJournal() {
    if (!ui) return;
    journalOpen = true;
    input.releaseAll();
    held.clear();
    if (state === STATES.CHARGING) setState(STATES.READY);
    ui.openJournal(records);
    xr.hudCall('openJournal', records);
  }
  function closeJournal() {
    if (ui) ui.closeJournal();
    xr.hudCall('closeJournal');
    journalOpen = false;
    input.disarm();
  }
  // what the VR menu shows (the HUD snapshot plus the VR-only settings)
  function menuState() {
    return { state, lureId, units, muted: audio ? !!audio.muted : muted, hours, quality: qm.auto ? 'auto' : qm.quality, rodHand, paused: userPaused, records };
  }
  function setRodHand(h) {
    rodHand = h === 'left' ? 'left' : 'right';
    xr.setRodHand(rodHand);
    persistSoon();
    return rodHand;
  }

  // ---------------------------------------------------------------- UI handlers (CONTRACT.md "UI")
  const handlers = {
    onStart: () => startGame(),
    onLure: (id) => setLure(id),
    onDrag: (d01) => setDrag(d01),
    onTimePreset: (h) => setHours(h),
    onMute: (m) => setMuted(m),
    onUnits: (u) => setUnits(u),
    onPause: (p) => setUserPause(p),
    onActionDown: () => actionDown('touch'),
    onActionUp: () => actionUp('touch'),
    onQuality: (q) => setQualityManual(q),
    onSlow: (on) => {
      slowToggle = !!on;
    },
    onKeep: () => finishCatch(true),
    onRelease: () => finishCatch(false),
    onJournal: (open) => {
      if (open) openJournal();
      else {
        // (the DOM journal closed itself, or the VR one did: close the other too; both are no-ops when shut)
        if (ui) ui.closeJournal();
        xr.hudCall('closeJournal');
        journalOpen = false;
        input.disarm();
      }
    },
    // VR (XR.md): the Enter VR buttons (title, pause menu), the VR menu's Exit VR and Rod hand
    onEnterVR: () => enterVR(),
    onExitVR: () => xr.exit(),
    onRodHand: (h) => setRodHand(h),
  };

  // ---------------------------------------------------------------- input
  const input = createInput({
    canvas,
    handlers: {
      actionDown: (src) => actionDown(src),
      actionUp: (src, cancel) => actionUp(src, cancel),
      isModalOpen: () => !!(ui && ui.isModalOpen()),
      dragStep: (s) => {
        if (state !== STATES.TITLE && !(ui && ui.isModalOpen())) setDrag(drag01 + s * 0.05);
      },
      touchStart: () => {
        if (state === STATES.STRIKE) hookset(); // any tap sets the hook on touch screens
      },
      touchEnd: () => {},
      key: onKey,
    },
  });

  function onKey(code) {
    if (!ready || state === STATES.TITLE) return;
    const modal = !!(ui && ui.isModalOpen());
    if (code === 'KeyJ') {
      if (journalOpen) closeJournal();
      else if (!modal) openJournal();
      return;
    }
    if (modal) return;
    switch (code) {
      case 'Escape':
      case 'KeyP':
        setUserPause(true);
        break;
      case 'KeyM':
        setMuted(!muted);
        break;
      case 'KeyU':
        setUnits(units === 'metric' ? 'imperial' : 'metric');
        break;
      case 'BracketLeft':
      case 'Minus':
      case 'NumpadSubtract':
        setDrag(drag01 - 0.05);
        break;
      case 'BracketRight':
      case 'Equal':
      case 'NumpadAdd':
        setDrag(drag01 + 0.05);
        break;
      default: {
        const m = /^(?:Digit|Numpad)([1-4])$/.exec(code);
        if (m) setLure(LURES[Number(m[1]) - 1].id);
      }
    }
  }

  // ---------------------------------------------------------------- events from the modules
  events.on('lure:landed', (e) => {
    if (state === STATES.CASTING) setState(STATES.WAITING);
    while (pendingCasts.length) pendingCasts.shift().resolve({ onWater: !!(e && e.onWater), x: e && e.position ? +e.position.x.toFixed(2) : null, z: e && e.position ? +e.position.z.toFixed(2) : null });
  });
  events.on('lure:home', () => {
    if (state === STATES.WAITING || state === STATES.ESCAPED) setState(STATES.READY);
  });
  events.on('fish:nibble', () => {
    lastNibbleT = frame.time;
  });
  events.on('fish:bite', (e) => {
    if (!e) return;
    // The fish system opens bites whenever the lure is in the water. That includes ESCAPED (the lure
    // drops back in after a fish throws the hook): take those too. Any other state can't take a bite:
    // close it (after the other listeners ran) so the fish, the float and the sound agree.
    if (state !== STATES.WAITING && state !== STATES.ESCAPED) {
      const id = e.biteId;
      if (fish && state !== STATES.STRIKE) queueMicrotask(() => fish.missBite(id, 'ignored'));
      return;
    }
    if (timeScale > 1) timeScale = 1; // debug fast-forward: drop to real time so a hookset can land
    const L = lure();
    const def = LURE_BY_ID[(L && L.id) || lureId];
    // a moving lure hit while the angler is reeling: keep reeling (a reel set) or let go to set the
    // hook. The float rig always needs a strike (a fresh click / tap).
    const reelSet = reelHeld() && !!def && def.kind === 'lure';
    bite = { biteId: e.biteId, windowS: e.windowS || 1, t: 0, reelSet };
    setState(STATES.STRIKE);
    if (ui) ui.strikeCue({ reelSet });
    xr.hudCall('strikeCue', { reelSet });
  });
  events.on('fish:jump', () => {
    if (state === STATES.FIGHTING) lastJumpT = frame.time;
  });
  events.on('fish:missed', (e) => {
    if (state !== STATES.STRIKE) return;
    bite = null;
    setState(STATES.WAITING);
    if (e && e.reason === 'dropped') toast('It let go. Set the hook faster', 'info');
  });

  // ---------------------------------------------------------------- VR (XR.md)
  // the angler is reeling: a held action (mouse / Space / touch) or, in VR, the reel hand (trigger or crank)
  function reelHeld() {
    return held.size > 0 || (xr.presenting && xr.xin.reelSpeed01 > 0);
  }

  // Must run inside the Enter VR click: requestSession is called synchronously down this path.
  function enterVR() {
    if (!ready) return Promise.resolve(false);
    if (xr.presenting) return Promise.resolve(true);
    if (audio) {
      try {
        audio.start();
      } catch (err) {
        console.warn('[core] audio start failed', err);
      }
    }
    return xr.enter({ level: manualQuality || defaultXRLevel() });
  }

  // The rig, camera and grips are in place (src/xr did that); now the game side.
  function onXRStart({ level }) {
    input.suspend(true);
    held.clear();
    xrCharge = false;
    xrReelWas = false;
    view.setBypass(true);
    qm.enterXR(level);
    frame.quality = qm.quality;
    if (journalOpen) closeJournal();
    if (userPaused) setUserPause(false);
    if (state === STATES.TITLE) startGame();
    else if (state === STATES.CHARGING) setState(STATES.READY);
    // (a fish on the card moves into the reel hand by itself: showcase.setXR re-shows it in the new mode)
    if (state === STATES.CAUGHT && catchRec) xr.hudCall('showCatch', catchRec, lastFlags || {});
    lastNow = 0;
    needsRender = true;
  }

  // Back to the desktop in the current state, the camera at the dock eye looking where the headset looked.
  function onXREnd() {
    input.suspend(false);
    input.disarm();
    xrCharge = false;
    xrReelWas = false;
    if (state === STATES.CHARGING) setState(STATES.READY);
    qm.exitXR();
    frame.quality = qm.quality;
    restoreDesktopView();
    resize();
    lastNow = 0;
    needsRender = true;
  }

  // the dock eye, looking where the headset last looked (runs before the tackle rebuilds its desktop view model)
  function restoreDesktopView() {
    if (!view.bypass) return;
    view.setBypass(false);
    view.set(xr.xin.head.yaw, DEFAULT_PITCH, true);
    view.apply();
  }

  // the headset's system menu / taking it off: a fish on waits for the angler (like a window blur)
  function onXRVisibility(v) {
    if (v !== 'visible' && ready && (state === STATES.STRIKE || state === STATES.FIGHTING || state === STATES.LANDING)) setUserPause(true);
  }

  function announceXR(ok) {
    if (ui && typeof ui.setXRAvailable === 'function') {
      try {
        ui.setXRAvailable(!!ok);
      } catch (err) {
        console.warn('[core] setXRAvailable failed', err);
      }
    }
  }

  function cycleLure(step) {
    const i = Math.max(0, LURES.findIndex((l) => l.id === lureId));
    const next = LURES[(i + step + LURES.length) % LURES.length].id;
    if (setLure(next)) xr.hudCall('toast', LURE_BY_ID[next].name, 'info');
  }

  // Trigger released mid-swing: power / direction / launch pitch from the rod-tip velocity (XR.md).
  function xrCast() {
    xrCharge = false;
    const c = xr.castFromRelease();
    xr.setLastCast({
      t: +frame.time.toFixed(2),
      power01: +c.power01.toFixed(3),
      speedMps: +c.speed.toFixed(2),
      yawDeg: +((Math.atan2(c.direction.x, -c.direction.z) * 180) / Math.PI).toFixed(1), // + = right of the lake axis
      pitchDeg: +((c.pitchRad * 180) / Math.PI).toFixed(1),
      lob: c.lob,
      behind: c.behind,
    });
    if (c.behind) {
      setState(STATES.READY);
      toast('Cast out over the water', 'info');
      return;
    }
    doCast(c.power01, c.direction, { pitchRad: c.pitchRad });
  }

  // One controller snapshot per XR frame -> game actions (the continuous parts are in processInput).
  function xrActions(x) {
    if (!x || !ready) return;
    if (state !== STATES.CHARGING) xrCharge = false;
    // reel-hand thumbstick click: the VR menu (pause); it also closes an open journal
    if (x.menu) {
      if (journalOpen) closeJournal();
      else setUserPause(!userPaused);
    }
    if (userPaused || journalOpen) {
      xrReelWas = false;
      return;
    }
    if (x.dragStep && state !== STATES.TITLE) setDrag(drag01 + 0.05 * x.dragStep);
    if (x.lureStep) {
      if (state === STATES.READY) cycleLure(x.lureStep);
      else toast('Reel in before you change lures', 'info');
    }
    const reelNow = x.reelSpeed01 > 0;
    switch (state) {
      case STATES.READY:
        if (x.rod.triggerDown) {
          chargeT = 0;
          charge = 0;
          xrCharge = true;
          setState(STATES.CHARGING); // bail open, finger on the line
          xr.haptics.fire('rod', 'bail');
        }
        break;
      case STATES.CHARGING:
        if (xrCharge && !x.rod.triggerHeld) {
          if (x.rod.present) xrCast();
          else {
            // the rod controller went away mid-swing (not just a tracking blip): no cast
            xrCharge = false;
            setState(STATES.READY);
          }
        }
        break;
      case STATES.WAITING: {
        // a sweep right on top of a nibble yanks the bait away, as a click does on the desktop
        const L = lure();
        if ((x.hookGesture || x.rod.primaryDown) && L && LURE_BY_ID[L.id] && LURE_BY_ID[L.id].kind === 'bait' && L.inWater && frame.time - lastNibbleT < EARLY_STRIKE_S) earlyStrike();
        break;
      }
      case STATES.STRIKE:
        if (x.hookGesture || x.rod.primaryDown) hookset();
        // a reel set: letting go of the reel sets it too (like releasing the button on the desktop)
        else if (bite && bite.reelSet && xrReelWas && !reelNow && held.size === 0) hookset();
        break;
      case STATES.CAUGHT:
        if (x.rod.primaryDown) finishCatch(true);
        else if (x.rod.secondaryDown) finishCatch(false);
        break;
      default:
        break;
    }
    xrReelWas = reelNow;
  }

  // ---------------------------------------------------------------- per-frame pieces
  function processInput(dt) {
    const inp = frame.input;
    const w = Math.max(1, canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight);
    const xrOn = xr.presenting;
    if (xrOn) {
      // VR: the real rod. Lift = its elevation, side = its offset from the line toward the fish (or lure).
      const x = xr.xin;
      const hf = frame.hooked;
      const L = lure();
      let side = 0;
      let lift = x.rod.connected ? x.rod.lift01 : inp.rodLift01;
      if (hf && (state === STATES.FIGHTING || state === STATES.LANDING)) side = xr.sideToward(hf.position);
      else if (L && (L.state === 'water' || L.state === 'land')) side = xr.sideToward(L.bobberPosition || L.position);
      if (debugRod) {
        side = debugRod.side;
        lift = debugRod.lift;
      }
      inp.rodSide = damp(inp.rodSide, side, 16, dt);
      inp.rodLift01 = damp(inp.rodLift01, lift, 16, dt);
      inp.aimYaw = x.head.yaw;
      inp.aimPitch = x.head.pitch;
      input.takeTouchDelta(_touch);
    } else if (state === STATES.TITLE) {
      titleT += dt;
      view.set(0.16 * Math.sin(titleT * 0.045) + 0.05 * Math.sin(titleT * 0.11 + 1), -0.035 + 0.018 * Math.sin(titleT * 0.07));
      view.update(dt, 1.5);
      input.takeTouchDelta(_touch);
    } else if (state === STATES.FIGHTING && frame.hooked) {
      let side = 0;
      let lift = 0.42;
      const p = input.pointer;
      if (debugRod) {
        side = debugRod.side;
        lift = debugRod.lift;
      } else if (input.touchActive) {
        side = clamp((input.touch.x - input.touch.sx) / (0.28 * w), -1, 1);
        lift = clamp(0.42 - (input.touch.y - input.touch.sy) / (0.3 * h), 0, 1);
      } else if (input.lastType === 'mouse' && p.inside) {
        const sx = Math.abs(p.nx) < 0.08 ? 0 : p.nx - Math.sign(p.nx) * 0.08;
        side = clamp(sx * 1.45, -1, 1);
        lift = clamp(0.42 - p.ny * 0.9, 0, 1);
      } else {
        side = inp.rodSide;
        lift = inp.rodLift01;
      }
      input.keyAxis(_keys);
      if (_keys.x) side = _keys.x;
      if (_keys.y) lift = _keys.y < 0 ? 1 : 0;
      inp.rodSide = damp(inp.rodSide, side, 8, dt);
      inp.rodLift01 = damp(inp.rodLift01, lift, 6, dt);
      const hp = frame.hooked.position;
      _v.set(hp.x, Math.max(hp.y, -0.4), hp.z);
      view.aimAt(_v, 0.7, 0.03);
      // don't stare straight down at a fish under the dock: the rod follows the view and would
      // point down the line (no cushion, no lift)
      if (view.v.tPitch < -0.42) view.v.tPitch = -0.42;
      view.update(dt, 2.2);
      input.takeTouchDelta(_touch);
    } else if (state === STATES.LANDING && frame.hooked) {
      inp.rodSide = damp(inp.rodSide, 0, 6, dt);
      inp.rodLift01 = damp(inp.rodLift01, 0.85, 6, dt);
      view.aimAt(frame.hooked.position, 0.85, 0.06);
      view.update(dt, 3);
      input.takeTouchDelta(_touch);
    } else if (state === STATES.CAUGHT) {
      view.set(NaN, -0.1);
      view.update(dt, 3);
      input.takeTouchDelta(_touch);
    } else {
      inp.rodSide = damp(inp.rodSide, 0, 6, dt);
      inp.rodLift01 = damp(inp.rodLift01, 0.4, 6, dt);
      const modal = !!(ui && ui.isModalOpen());
      if (modal) {
        _steer.x = _steer.y = 0;
      } else {
        input.mouseSteer(_steer);
        input.keyAxis(_keys);
        _steer.x = clamp(_steer.x + _keys.x, -1, 1);
        _steer.y = clamp(_steer.y + _keys.y, -1, 1);
      }
      const k = state === STATES.CHARGING ? 0.55 : 1;
      view.steer(dt, _steer.x, _steer.y, 80 * DEG * k, 48 * DEG * k);
      input.takeTouchDelta(_touch);
      if (!modal && (_touch.x || _touch.y)) view.nudge((-_touch.x / w) * 115 * DEG, (-_touch.y / h) * 70 * DEG);
      view.update(dt, 12);
    }
    if (!xrOn) {
      inp.aimYaw = view.v.yaw;
      inp.aimPitch = view.v.pitch;
    }

    // cast charge
    if (state === STATES.CHARGING) {
      chargeT += dt;
      const c = Math.min(1, chargeT / 1.3);
      charge = c * (2 - c);
    }
    // (VR: the live power of the swing, for the aim ring / HUD)
    inp.charge01 = state === STATES.CHARGING ? (xrOn ? xr.xin.castPower01 : charge) : 0;

    // reel
    // (a lure hit mid-retrieve keeps coming while the angler reels through the strike)
    const canReel = state === STATES.WAITING || state === STATES.FIGHTING || state === STATES.ESCAPED || (state === STATES.STRIKE && !!bite && bite.reelSet);
    const xrReel = xrOn ? xr.xin.reelSpeed01 : 0; // VR: analog trigger or turning the handle
    const wantReel = canReel && (held.size > 0 || debugReel || xrReel > 0);
    let target = 0;
    if (wantReel) target = xrOn ? Math.max(xrReel, held.size > 0 || debugReel ? 1 : 0) : (input.shift || slowToggle) && state !== STATES.FIGHTING ? 0.5 : 1;
    reel01 = damp(reel01, target, xrOn ? 14 : 10, dt);
    if (!wantReel && reel01 < 0.03) reel01 = 0;
    inp.reeling = wantReel;
    inp.reelSpeed01 = reel01;
  }

  function stepFight(dt) {
    const hf = frame.hooked;
    if (!hf) return;
    tackle.getRodTip(_tip);
    if (xr.presenting && xr.xin.rod.connected) {
      // VR: the real rod (the unbent blank as the angler holds it)
      xr.getRodBase(_butt);
      _rodDir.copy(xr.xin.rod.dir);
    } else {
      // the rod butt is at the angler's hands (camera space ~ right, down, forward)
      _butt.set(0.3, -0.28, -0.45).applyMatrix4(camera.matrixWorld);
      _rodDir.subVectors(_tip, _butt);
    }
    if (_rodDir.lengthSq() < 1e-6) _rodDir.set(0, 0.7, -0.7);
    _rodDir.normalize();
    let lx = hf.position.x - view.eye.x;
    let lz = hf.position.z - view.eye.z;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll;
    lz /= ll;
    fightInp.hooked = hf;
    fightInp.dragN = frame.dragN;
    fightInp.reeling = frame.input.reeling;
    fightInp.reelMps = frame.input.reelSpeed01 * TACKLE.reelRetrieveMps;
    fightInp.rodSide = frame.input.rodSide;
    fightInp.rodLift01 = frame.input.rodLift01;
    fightInp.rightX = -lz;
    fightInp.rightZ = lx;
    const out = fight.advance(dt, fightInp);
    if (out) {
      if (out.type === 'snap' || out.type === 'spooled') endFightSnap(out.tensionN || TACKLE.lineBreakN, out.type === 'spooled');
      else if (out.type === 'escape') endFightEscape(out.reason, !!out.pulled);
      return;
    }
    if (fight.canLand(hf, view.eye)) startLanding();
  }

  function simulate(dt) {
    frame.dt = dt;
    frame.time += dt;
    stateT += dt;
    frame.quality = qm.quality;
    frame.dragN = dragNFor(drag01);

    // input (camera, rod, reel)
    processInput(dt);

    // hours (the clock stands still while netting, on the catch card, re-tying, after an escape)
    if (CLOCK_STATES.has(state)) hours = wrap24(hours + (dt * DAY.gameMinutesPerSecond) / 60);
    frame.hours = hours;
    env.setTimeOfDay(hours);
    env.update(frame);
    scenery.update(frame);

    // tackle (reel first so the retrieve lands in this frame's lure physics)
    if (frame.input.reeling && state !== STATES.FIGHTING && reel01 > 0.01) tackle.reel(dt, reel01 * TACKLE.reelRetrieveMps);
    frame.hooked = fish.getHooked();
    tackle.update(frame);
    fish.update(frame);
    frame.hooked = fish.getHooked();

    // fight substeps
    if (state === STATES.FIGHTING) stepFight(dt);
    const hf = frame.hooked;
    if (state === STATES.FIGHTING && hf) {
      tackle.setFight(true, { fishPosition: hf.position, tensionN: fight.tensionN, lineOutM: fight.lineOutM });
      tackle.setRodLoad(fight.tensionN, hf.position);
    } else if (state === STATES.LANDING && hf) {
      tackle.getRodTip(_tip);
      const d = hf.position.distanceTo(_tip);
      const T = Math.max(0, damp(frame.tensionN, 4, 3, dt));
      tackle.setFight(true, { fishPosition: hf.position, tensionN: T, lineOutM: d });
      tackle.setRodLoad(T, hf.position);
    }

    // frame numbers
    if (state === STATES.FIGHTING) {
      frame.tensionN = fight.tensionN;
      frame.lineOutM = fight.lineOutM;
      frame.slipMps = fight.slipMps;
    } else if (state === STATES.LANDING) {
      frame.tensionN = damp(frame.tensionN, 4, 3, dt);
      frame.lineOutM = Math.min(frame.lineOutM, 3.2);
      frame.slipMps = 0;
    } else {
      frame.tensionN = 0;
      frame.slipMps = 0;
      const L = lure();
      frame.lineOutM = L && !L.lost ? L.lineOutM : 0;
    }
    frame.tension01 = frame.tensionN / TACKLE.lineBreakN;

    // timers
    while (pendingCasts.length && (frame.time - pendingCasts[0].t0 > 20 || (state !== STATES.CASTING && state !== STATES.CHARGING))) pendingCasts.shift().resolve(false);
    const L = lure();
    switch (state) {
      case STATES.CASTING:
        if (stateT > 12) {
          if (L && (L.state === 'water' || L.state === 'land')) setState(STATES.WAITING);
          else {
            tackle.resetToHome();
            setState(STATES.READY);
          }
        }
        break;
      case STATES.WAITING:
        if (L && L.state === 'home' && stateT > 0.5) setState(STATES.READY);
        break;
      case STATES.STRIKE:
        if (bite) {
          bite.t += dt;
          // reel set: the angler kept cranking through the hit and the fish loaded the rod
          if (bite.reelSet && reelHeld() && bite.t >= REEL_SET_S) {
            hookset();
            break;
          }
          if (bite.t > bite.windowS + 1.5) {
            bite = null;
            setState(STATES.WAITING);
          }
        }
        break;
      case STATES.LANDING:
        if (stateT > 1.7 || (hf && hf.landedAtTarget && stateT > 1.2)) enterCaught();
        break;
      case STATES.SNAPPED:
        if (stateT > 1.5) {
          tackle.resetToHome();
          setState(STATES.READY);
          toast(`Tied on a new ${LURE_BY_ID[lureId].short.toLowerCase()}`, 'info');
        }
        break;
      case STATES.ESCAPED:
        if (stateT > 2.2) {
          if (L && (L.state === 'water' || L.state === 'land')) setState(STATES.WAITING);
          else setState(STATES.READY);
        }
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- HUD
  const hud = {
    state: STATES.TITLE,
    tension01: 0,
    tensionN: 0,
    dragN: 0,
    drag01: 0,
    lineOutM: 0,
    castPower01: 0,
    hours: 0,
    lureId,
    units,
    muted,
    catches: records,
    fishOn: false,
    fishDistanceM: NaN,
    prompt: null,
    promptKind: 'info',
    paused: false,
    slow: false, // touch Slow toggle (slow retrieve)
    quality: 'high',
    fishStamina01: NaN,
    // rod handling during a fight (for an optional rod-angle indicator): lift / side as the angler holds
    // it, and how little cushion it gives (0 = well bent, 1 = pointed straight at the fish)
    rodLift01: 0.4,
    rodSide: 0,
    rodStiff01: 0,
    slackLine: false, // a fish on and the line hanging slack (the fight model's judgement)
  };
  function updateHud() {
    const L = lure();
    const hf = frame.hooked;
    hud.state = state;
    hud.tension01 = frame.tension01;
    hud.tensionN = frame.tensionN;
    hud.dragN = frame.dragN;
    hud.drag01 = drag01;
    hud.lineOutM = frame.lineOutM;
    hud.castPower01 = frame.input.charge01;
    hud.hours = hours;
    hud.lureId = lureId;
    hud.units = units;
    hud.muted = audio ? !!audio.muted : muted;
    hud.catches = records;
    hud.fishOn = (state === STATES.FIGHTING || state === STATES.LANDING) && !!hf;
    hud.fishDistanceM = hud.fishOn ? Math.hypot(hf.position.x - view.eye.x, hf.position.z - view.eye.z) : NaN;
    hud.fishStamina01 = hf ? hf.stamina01 : NaN;
    hud.rodLift01 = frame.input.rodLift01;
    hud.rodSide = frame.input.rodSide;
    hud.rodStiff01 = state === STATES.FIGHTING ? fight.state.stiff01 : 0;
    hud.slackLine = state === STATES.FIGHTING && fight.state.slackT > 0.3;
    hud.paused = userPaused;
    hud.slow = slowToggle;
    hud.quality = qm.auto ? 'auto' : qm.quality; // the pause menu shows the setting
    // prompts the UI can't derive on its own (null = let the UI derive them)
    const touch = input.lastType === 'touch';
    let prompt = null;
    let kind = 'info';
    if (xr.presenting) {
      const p = xrPrompt(L, hf);
      prompt = p[0];
      kind = p[1];
    } else if (state === STATES.WAITING && L) {
      const def = LURE_BY_ID[L.id];
      if (L.state === 'land') prompt = 'On the bank. Hold to reel it in';
      else if (def && def.kind === 'bait') {
        if (L.state === 'water') {
          if (frame.time - lastNibbleT < 1.2) prompt = 'Nibble\u2026 wait for it';
          else prompt = touch ? 'Watch the float \u00b7 tap when it goes under \u00b7 hold to reel in' : 'Watch the float \u00b7 click when it goes under \u00b7 hold to reel in';
        }
      } else if (def && def.kind === 'lure') prompt = LURE_PROMPTS[def.id] ? LURE_PROMPTS[def.id][touch ? (slowToggle ? 2 : 1) : 0] : touch ? 'Hold to reel. Pause now and then' : 'Hold to reel \u00b7 Shift for a slow retrieve';
    } else if (state === STATES.STRIKE && bite && bite.reelSet) {
      prompt = 'Keep reeling!';
      kind = 'danger';
    } else if (state === STATES.FIGHTING && hf) {
      const fp = fightPrompt(hf, touch);
      prompt = fp[0];
      kind = fp[1];
    }
    hud.prompt = prompt;
    hud.promptKind = kind;
    if (ui) ui.update(hud);
    if (xr.presenting) xr.hudCall('update', hud, frame, xr.xin);
  }

  // Prompts in the headset: controller wording (rod hand: trigger to cast, sweep to strike; reel hand: trigger / crank).
  const _xp = [null, 'info'];
  const XR_LURE_PROMPTS = {
    spinner: 'Steady retrieve: half-pull the reel trigger, or turn the reel',
    crankbait: 'Pull the reel trigger to crank it down \u00b7 pause now and then',
    topwater: 'Light reel-trigger pulls walk it \u00b7 pause now and then',
  };
  function xrPrompt(L, hf) {
    _xp[0] = null;
    _xp[1] = 'info';
    const say = (text, kind = 'info') => {
      _xp[0] = text;
      _xp[1] = kind;
      return _xp;
    };
    const keep = rodHand === 'left' ? 'X' : 'A';
    const rel = rodHand === 'left' ? 'Y' : 'B';
    switch (state) {
      case STATES.READY:
        return say('Hold the trigger, swing the rod forward and let go to cast');
      case STATES.CHARGING:
        return say('Swing forward and let go of the trigger');
      case STATES.WAITING: {
        if (!L) return _xp;
        const def = LURE_BY_ID[L.id];
        if (L.state === 'land') return say('On the bank. Pull the reel trigger to reel it in');
        if (def && def.kind === 'bait') {
          if (L.state !== 'water') return _xp;
          if (frame.time - lastNibbleT < 1.2) return say('Nibble\u2026 wait for it');
          return say('Watch the float \u00b7 sweep the rod up when it goes under');
        }
        return say(XR_LURE_PROMPTS[L.id] || 'Pull the reel trigger to reel \u00b7 pause now and then');
      }
      case STATES.STRIKE:
        if (bite && bite.reelSet) return say('Keep reeling!', 'danger');
        return say('Sweep the rod up!', 'danger');
      case STATES.FIGHTING:
        if (hf) {
          const fp = fightPrompt(hf, false, true);
          return say(fp[0], fp[1]);
        }
        return _xp;
      case STATES.CAUGHT:
        return say(`${keep} keeps it \u00b7 ${rel} lets it go`);
      default:
        return _xp;
    }
  }

  // Fight prompts, most urgent first. null leaves the UI's own tension / tiring / "Fish on" prompts.
  const _fp = [null, 'info'];
  function fightPrompt(hf, touch, vr = false) {
    const fs = fight.state;
    const t01 = frame.tension01;
    const reeling = frame.input.reeling;
    _fp[0] = null;
    _fp[1] = 'info';
    const say = (text, kind = 'warn') => {
      _fp[0] = text;
      _fp[1] = kind;
      return _fp;
    };
    if (t01 >= 0.85) return _fp; // UI: "Too much tension!"
    if (fs.exposed01 > 0.3) return say(hf.isJumping || frame.time - lastJumpT < 0.8 ? 'Jump! Rod up, cushion it' : 'Head shakes! Lift the rod to cushion them', 'danger');
    if (fs.twist > FIGHT.twistWarn && reeling && fs.slipping) return say('Line twisting! Stop cranking while it runs');
    if (t01 >= 0.7) return _fp; // UI: "Heavy load. Ease the drag"
    if (fs.slackT > 0.8 && !fs.slipping) return say('Slack line! Reel and lift the rod');
    if (frame.time - lastJumpT < 1.2) return say('Jump! Keep it tight');
    if (fs.slipping && reeling && frame.slipMps > 0.25) return say('Drag is slipping. Let it run');
    if (fs.stiff01 > 0.6 && hf.weightKg >= FIGHT.smallFishKg) return say(vr ? 'Rod pointed at the fish: lift the rod' : touch ? 'Rod pointed at the fish: drag up to lift it' : 'Rod pointed at the fish: mouse up to lift it');
    if (!fightHints) return _fp;
    // coaching for the angler's first few fights
    const ft = fs.t;
    if (ft < 4) return say(vr ? 'Fish on! Reel with the trigger \u00b7 keep the rod up' : touch ? 'Fish on! Hold to reel \u00b7 drag up to lift the rod' : 'Fish on! Hold to reel \u00b7 mouse up lifts the rod', 'good');
    const lat = hf.velocity.x * fightInp.rightX + hf.velocity.z * fightInp.rightZ; // + = running right
    if (Math.abs(lat) > 0.6 && frame.input.rodSide * Math.sign(lat) > -0.3) {
      const dir = lat > 0 ? 'left' : 'right';
      const run = lat > 0 ? 'right' : 'left';
      if (vr) return say(`Running ${run}: sweep the rod ${dir} for side pressure`, 'info');
      return say(touch ? `Running ${run}: drag ${dir} for side pressure` : `Running ${run}: mouse ${dir} (${lat > 0 ? 'A' : 'D'}) for side pressure`, 'info');
    }
    if (ft > 8 && ft < 13) return say('Pump it: lift the rod, then reel as you lower it', 'info');
    if (ft > 16 && ft < 21) return say(vr ? 'Rod thumbstick up / down sets the drag \u00b7 keep it out of the red' : touch ? 'The \u2212 / + buttons set the drag' : 'Scroll or [ ] sets the drag \u00b7 keep it out of the red', 'info');
    return _fp;
  }

  // ---------------------------------------------------------------- render
  const passInfo = { waterCalls: 0, waterTris: 0, mainCalls: 0, mainTris: 0 };
  function renderFrame(dt) {
    const info = renderer.info;
    info.reset(); // once per frame: the water's depth / reflection passes count too
    water.update(frame);
    passInfo.waterCalls = info.render.calls;
    passInfo.waterTris = info.render.triangles;
    if (audio) audio.update(frame);
    updateHud();
    showcase.update(dt, env, scene);
    renderer.render(scene, camera);
    passInfo.mainCalls = info.render.calls - passInfo.waterCalls;
    passInfo.mainTris = info.render.triangles - passInfo.waterTris;
    if (!xr.presenting) showcase.render(); // (in VR the fish is in the reel hand, in the main scene)
    lastCalls = info.render.calls;
    lastTris = info.render.triangles;
  }

  const xrCtx = { dt: 0, frame: null, lineTarget: null, allowSticks: true, allowTurn: true };
  function loop(now, xrFrame) {
    const realDt = lastNow ? Math.max(0, (now - lastNow) / 1000) : 1 / 60;
    lastNow = now;
    if (!ready) return;
    fpsAcc += realDt;
    fpsFrames++;
    if (fpsAcc >= 1) {
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
    }
    // VR: poses, controllers, panel presses, snap turns, haptics -> game actions, once per XR frame
    const xrOn = xr.presenting;
    if (xrOn) {
      const halted = userPaused || journalOpen;
      const L = lure();
      const hf = frame.hooked;
      xrCtx.dt = Math.min(0.05, realDt);
      xrCtx.frame = halted ? null : frame;
      xrCtx.lineTarget = hf ? hf.position : L && L.state !== 'home' && L.state !== 'flying' ? L.bobberPosition || L.position : null;
      xrCtx.allowSticks = xrCtx.allowTurn = !halted;
      xrActions(xr.beginFrame(xrFrame, xrCtx));
    }
    // (in VR every frame renders, paused or not: the headset needs a frame and the menu lives in the scene)
    if (userPaused || journalOpen || (document.hidden && !xrOn)) {
      updateHud();
      if (needsRender || xrOn) {
        needsRender = false;
        frame.dt = 0;
        renderFrame(0);
      }
      return;
    }
    // Adaptive quality samples BEFORE this frame renders: a pixel-ratio step resizes (and so clears) the
    // drawing buffer, which has to happen before the draw, not after it, or the browser would present a
    // blank frame (a black flash) each time auto quality adjusts. In VR the XR frame time drives it.
    if (xrOn) xr.sampleQuality(realDt);
    else if (state !== STATES.TITLE || qm.auto) qm.sample(realDt);
    const dt = Math.min(0.05, realDt);
    for (let i = 0; i < timeScale; i++) simulate(dt);
    renderFrame(dt);
    needsRender = false;
  }

  // ---------------------------------------------------------------- resize / visibility
  function resize() {
    if (xr.presenting) return; // three.js owns the drawing buffer while the headset presents (resized on exit)
    const stage = canvas.parentElement;
    const w = Math.max(1, (stage && stage.clientWidth) || window.innerWidth);
    const h = Math.max(1, (stage && stage.clientHeight) || window.innerHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  window.addEventListener('resize', resize);
  if (typeof ResizeObserver === 'function' && canvas.parentElement) new ResizeObserver(resize).observe(canvas.parentElement);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && ready && state !== STATES.TITLE && !xr.presenting) setUserPause(true);
    if (document.hidden) flushPersist();
    lastNow = 0;
  });
  // Clicking outside the game (e.g. the chat beside the artifact) releases every hold; with a fish
  // on, pause so it isn't lost while the angler is looking elsewhere. (Idle states keep running.)
  window.addEventListener('blur', () => {
    // (in VR the session's own visibility decides: the page may lose focus when the headset takes over)
    if (ready && !xr.presenting && (state === STATES.STRIKE || state === STATES.FIGHTING || state === STATES.LANDING)) setUserPause(true);
  });

  // ---------------------------------------------------------------- hot reload snapshot
  try {
    const h = window.claude && window.claude.hot;
    if (h && typeof h.snapshot === 'function') h.snapshot(() => ({ records, hours, units, lureId, muted }));
  } catch {
    /* ignore */
  }

  // ---------------------------------------------------------------- attach modules / go
  function attach(mods) {
    ({ env, scenery, water, fish, tackle, audio } = mods);
    showcase = createShowcase({ renderer, camera, createFishMesh: mods.createFishMesh });
    tackle.setLure(lureId);
    frame.lure = tackle.getLure();
    if (audio && muted) audio.setMuted(true);
  }

  function setUI(u) {
    ui = u;
  }

  function goLive() {
    ready = true;
    frame.hours = hours;
    renderer.setAnimationLoop(loop);
    while (readyWaiters.length) readyWaiters.shift()();
    // VR: the Enter VR buttons appear only when immersive-vr is really on offer (never throws)
    xr.detect().then(announceXR);
  }

  function whenReady() {
    return ready ? Promise.resolve() : new Promise((r) => readyWaiters.push(r));
  }

  // ---------------------------------------------------------------- debug API (CONTRACT.md "Debug hooks")
  const r2 = (v) => Math.round(v * 100) / 100;
  const vec = (p) => (p ? [r2(p.x), r2(p.y), r2(p.z)] : null);
  const debug = {
    async skipTitle() {
      await whenReady();
      startGame();
      return state;
    },
    setTime(h) {
      setHours(Number(h));
      return hours;
    },
    setQuality(q) {
      setQualityManual(q);
      return qm.quality;
    },
    look(yawDeg = 0, pitchDeg = DEFAULT_PITCH / DEG) {
      view.set(-Number(yawDeg) * DEG, Number(pitchDeg) * DEG, true);
      view.apply();
      // an instant view jump would leave the rig at the tip swinging: hang it again
      const L = lure();
      if (tackle && L && L.state === 'home' && !L.lost && (state === STATES.READY || state === STATES.TITLE)) {
        const f = { ...frame, dt: 0.05 };
        for (let i = 0; i < 16; i++) tackle.update(f); // let the view model settle on the new view
        tackle.resetToHome();
      }
      needsRender = true;
      return [yawDeg, pitchDeg];
    },
    cast(power01 = 0.8, yawDeg = 0) {
      if (!ready) return Promise.resolve(false);
      if (state === STATES.TITLE) startGame();
      if (state !== STATES.READY) resetToReady();
      view.set(-Number(yawDeg) * DEG, NaN, true);
      view.apply();
      setState(STATES.CHARGING);
      chargeT = 1;
      charge = clamp(Number(power01), 0, 1);
      // resolves when the lure lands, or false if it has not landed within 20 s of GAME time (real time
      // would be wrong under a slow software renderer, where a single frame can take seconds)
      const p = new Promise((resolve) => pendingCasts.push({ resolve, t0: frame.time }));
      doCast(charge);
      return p;
    },
    setReeling(b) {
      debugReel = !!b;
      return debugReel;
    },
    setDrag(d01) {
      setDrag(Number(d01));
      return drag01;
    },
    setLure(id) {
      if (!ready) return null;
      return setLure(id, true) ? lureId : null;
    },
    forceBite(speciesId) {
      if (!ready) return null;
      fish.debugForceBite(speciesId);
      return true;
    },
    strike() {
      if (!ready) return null;
      if (state === STATES.STRIKE) hookset();
      else if (state === STATES.WAITING) earlyStrike();
      return state;
    },
    hookFish(speciesId = 'largemouth_bass', weightKg) {
      if (!ready) return null;
      if (state === STATES.TITLE) startGame();
      if (state === STATES.CAUGHT) finishCatch(false);
      if (fish.getHooked()) {
        fish.releaseHooked('escaped');
        fight.end();
      }
      bite = null;
      const L = lure();
      const inWater = !!(L && L.inWater);
      const hf = fish.debugHook(speciesId, Number(weightKg), inWater ? L.position : undefined);
      if (!hf) return null;
      if (!inWater) tackle.resetToHome();
      beginFight(hf, inWater ? L.lineOutM : NaN);
      return { speciesId: hf.speciesId, weightKg: r2(hf.weightKg), lengthCm: r2(hf.lengthCm) };
    },
    landNow() {
      if (!ready) return null;
      const hf = fish.getHooked();
      if (!hf) return false;
      if (state !== STATES.LANDING) {
        const side = hf.position.x >= 0 ? 1 : -1;
        landTarget.set(side * 0.45, -0.07, DOCK.endZ - 0.75);
        hf.toLanding(landTarget, 0.2);
      }
      enterCaught();
      // straight from FIGHTING the tackle still thinks a fish is on and would leave the bait in the
      // lake behind the catch card (real play always nets through LANDING, which reels the rig home)
      if (state === STATES.CAUGHT && tackle && tackle.getLure().state !== 'home') tackle.resetToHome();
      return state;
    },
    stats() {
      const L = lure();
      const hf = frame.hooked;
      const mem = renderer.info.memory;
      return {
        fps: r2(fps),
        drawCalls: lastCalls,
        triangles: lastTris,
        geometries: mem.geometries,
        textures: mem.textures,
        programs: renderer.info.programs ? renderer.info.programs.length : 0,
        passes: { ...passInfo },
        state,
        hours: r2(hours),
        time: r2(frame.time),
        quality: qm.quality,
        autoQuality: qm.auto,
        pixelRatio: qm.pixelRatio,
        lineOutM: r2(frame.lineOutM),
        tensionN: r2(frame.tensionN),
        slipMps: r2(frame.slipMps),
        dragN: r2(frame.dragN),
        paused: userPaused,
        records: records.length,
        lure: L
          ? { id: L.id, state: L.state, inWater: L.inWater, position: vec(L.position), depthM: r2(L.depthM), speedMps: r2(L.speedMps), distanceM: r2(L.distanceM), lineOutM: r2(L.lineOutM), lost: !!L.lost, bobber: vec(L.bobberPosition) }
          : null,
        hooked: hf
          ? { speciesId: hf.speciesId, weightKg: r2(hf.weightKg), lengthCm: r2(hf.lengthCm), stamina01: r2(hf.stamina01), position: vec(hf.position), mode: hf.mode, isJumping: !!hf.isJumping, distanceM: r2(Math.hypot(hf.position.x - view.eye.x, hf.position.z - view.eye.z)) }
          : null,
        view: { yawDeg: r2(-view.v.yaw / DEG), pitchDeg: r2(view.v.pitch / DEG) },
        input: { ...frame.input },
        xr: xr.presenting,
      };
    },
    // VR (XR.md "Debug hooks"): available() resolves the feature detection; enter() starts a session the way the
    // Enter VR button does (a real browser wants a click for it; the harness' emulator does not); status() is JSON.
    xr: {
      available: () => xr.detect(),
      enter: () => (ready ? enterVR() : whenReady().then(() => enterVR())),
      exit: () => xr.exit(),
      status: () => ({ ...xr.status(), state, paused: userPaused, rodLift01: r2(frame.input.rodLift01), rodSide: r2(frame.input.rodSide), reelSpeed01: r2(frame.input.reelSpeed01), quality: qm.quality }),
      // extras for scenarios
      waitFrames: (n = 1) => xr.waitFrames(n),
      // fn(frameCount) after each XR frame's controller read, until it returns false (drive poses frame-exactly)
      everyFrame: (fn) => xr.onFrame(fn),
      setRodHand: (h) => setRodHand(h),
    },
    // extras for scenarios
    setTimeScale(k) {
      timeScale = clamp(Math.round(Number(k) || 1), 1, 60);
      return timeScale;
    },
    setPixelRatio(p) {
      qm.setAuto(false);
      qm.setPixelRatio(Number(p) || 1);
      needsRender = true;
      return qm.pixelRatio;
    },
    setAutoQuality(on) {
      qm.setAuto(!!on);
      return qm.auto;
    },
    setRod(side, lift) {
      debugRod = side == null ? null : { side: clamp(Number(side), -1, 1), lift: clamp(Number(lift ?? 0.4), 0, 1) };
      return debugRod;
    },
    slack(m = 10) {
      fight.addSlack(Number(m));
      return r2(fight.lineOutM);
    },
    pause(p) {
      setUserPause(p);
      return userPaused;
    },
    action(down) {
      if (down) actionDown('debug');
      else actionUp('debug');
      return state;
    },
    keep() {
      finishCatch(true);
      return state;
    },
    release() {
      finishCatch(false);
      return state;
    },
    events(since = 0) {
      return eventLog.filter((e) => e.t >= since);
    },
    records() {
      return records.slice();
    },
    get fight() {
      return { ...fight.state };
    },
    modules: () => ({ env, scenery, water, fish, tackle, audio, ui, showcase, view, qm, renderer, scene, camera }),
    render() {
      needsRender = true;
    },
  };

  const api = {
    get state() {
      return state;
    },
    get frame() {
      return frame;
    },
    debug,
  };

  return { api, handlers, attach, setUI, goLive, resize, frame, view, qm, renderFrame, get records() { return records; }, get units() { return units; }, get muted() { return muted; }, get hours() { return hours; }, get lureId() { return lureId; }, get quality() { return qm.quality; } };
}
