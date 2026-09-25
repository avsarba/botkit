// UI overlay for Loon Lake Angler: title, HUD (clock, tools, lures, tension dial, power, prompts),
// strike cue, toasts, catch card, journal and pause. The static DOM and all CSS live in
// src/index.template.html; this module binds it, fills the data-driven parts and keeps it in sync.
// update(hud) runs every frame and only writes to the DOM when a displayed value changes.
import {
  LURES,
  STATES,
  TACKLE,
  DAY,
  G,
  KG_PER_LB,
  M_PER_FT,
  SPECIES_IDS,
  formatWeight,
  formatLength,
  formatDistance,
  formatClock,
  clamp,
} from '../config.js';
import { LURE_ICONS } from './icons.js';
import { createGauge, lineTestIn } from './gauge.js';
import { FIELD_GUIDE } from './fieldguide.js';
import { renderJournalBody, summarize, lureName } from './journal.js';

export const TIME_PRESETS = Object.freeze([
  { id: 'dawn', label: 'Dawn', hours: 5.75 },
  { id: 'morning', label: 'Morning', hours: 9.0 },
  { id: 'noon', label: 'Noon', hours: 12.5 },
  { id: 'dusk', label: 'Dusk', hours: 19 + 40 / 60 },
  { id: 'night', label: 'Night', hours: 22.5 },
]);

const N_PER_LBF = G * KG_PER_LB;
const LURE_BY_ID = Object.freeze(Object.fromEntries(LURES.map((l) => [l.id, l])));
const DRAG_STEP = 0.05; // of the 0..1 drag range, ~0.45 lb per click
const PROMPT_KINDS = new Set(['info', 'ready', 'good', 'warn', 'danger']);
const QUALITIES = ['auto', 'high', 'medium', 'low']; // 'auto': core's adaptive quality (hud.quality reports the setting)
const GUT = 16; // --gut in the template
// Prompt band (see .center in the template): between the lure panel and the gauge when that gap is
// at least BAND_MIN_W wide, else just above the bottom controls.
const BAND_MIN_W = 250;
const BAND_MAX_W = 440;
const QUIET_AFTER_MS = 4000; // steady waiting / fighting hints fade after this long
const SLACK_PULSE_MS = 800; // slack line with a fish on for this long -> the dial pulses

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const normUnits = (u) => (u === 'metric' || u === 'kg' || u === 'cm' || u === 'si' ? 'metric' : 'imperial');
const normKind = (k) => (k === 'bad' ? 'danger' : k === 'warning' ? 'warn' : PROMPT_KINDS.has(k) ? k : 'info');

// Force in display units: pounds-force or kilograms-force, one decimal.
function forceValue(n, units) {
  return units === 'metric' ? n / G : n / N_PER_LBF;
}

// Touch-button label per state: [mode, main, sub, aria-label]
const ACTIONS = {
  [STATES.TITLE]: ['idle', 'Cast', '', 'Cast'],
  [STATES.READY]: ['ready', 'Cast', 'Hold', 'Hold to cast'],
  [STATES.CHARGING]: ['ready', 'Let go', 'to cast', 'Let go to cast'],
  [STATES.CASTING]: ['idle', 'Cast', '', 'Casting'],
  [STATES.WAITING]: ['ready', 'Reel', 'Hold', 'Hold to reel'],
  [STATES.STRIKE]: ['strike', 'Strike', 'Tap', 'Tap to set the hook'],
  [STATES.FIGHTING]: ['ready', 'Reel', 'Hold', 'Hold to reel'],
  [STATES.LANDING]: ['idle', 'Net', '', 'Netting the fish'],
  [STATES.CAUGHT]: ['idle', '', '', 'Fish landed'],
  [STATES.SNAPPED]: ['idle', 'Re-tie', '', 'Re-tying'],
  [STATES.ESCAPED]: ['idle', 'Reel', '', 'Fish escaped'],
};

function nullUI() {
  const noop = () => {};
  return {
    showTitle: noop, hideTitle: noop, setState: noop, update: noop, strikeCue: noop,
    showCatch: noop, hideCatch: noop, toast: noop, openJournal: noop, closeJournal: noop,
    setLoading: noop, setPaused: noop, isModalOpen: () => false, getCatchRect: () => null, dispose: noop,
  };
}

export function createUI(ctx = {}) {
  const events = ctx.events || null;
  const handlers = ctx.handlers || {};
  const config = ctx.config || {};
  const doc = typeof document !== 'undefined' ? document : null;
  const root = doc && doc.getElementById('ui');
  if (!root) {
    console.warn('[ui] #ui not found (built without src/index.template.html?); UI disabled');
    return nullUI();
  }
  const $ = (id) => doc.getElementById(id) || doc.createElement('div');

  // ---------- elements ----------
  const hud = $('hud');
  const live = $('ui-live');
  const title = $('title');
  const startBtn = $('btn-start');
  const titleBest = $('title-best');
  const titleBestMain = $('title-best-main');
  const titleBestSub = $('title-best-sub');
  const clockBtn = $('clock-btn');
  const clockHM = $('clock-hm');
  const clockAMPM = $('clock-ampm');
  const sunDot = $('sun-dot');
  const moonDot = $('moon-dot');
  const presets = $('presets');
  const btnSound = $('btn-sound');
  const btnUnits = $('btn-units');
  const unitsLabel = $('units-label');
  const btnJournal = $('btn-journal');
  const journalCount = $('journal-count');
  const btnPause = $('btn-pause');
  const toasts = $('toasts');
  const power = $('power');
  const powerFill = $('power-fill');
  const powerEst = $('power-est');
  const prompt = $('prompt');
  const promptText = $('prompt-text');
  const strike = $('strike');
  const strikeSub = $('strike-sub');
  const lures = $('lures');
  const gaugeLabel = $('gauge-label');
  const fishOnEl = $('fish-on');
  const rodMeter = $('rodmeter');
  const rodLine = $('rodmeter-rod');
  const rodTip = $('rodmeter-tip');
  const dial = $('dial');
  const dialSvg = $('dial-svg');
  const dialValue = $('dial-value');
  const dialUnit = $('dial-unit');
  const action = $('action');
  const btnSlow = $('btn-slow');
  const actionMain = $('action-main');
  const actionSub = $('action-sub');
  const roLine = $('ro-line');
  const roFish = $('ro-fish');
  const roTension = $('ro-tension');
  const dragMinus = $('drag-minus');
  const dragPlus = $('drag-plus');
  const dragVal = $('drag-val');
  const gaugeEl = $('gauge');
  const catchEl = $('catch');
  const catchDate = $('catch-date');
  const catchTime = $('catch-time');
  const catchName = $('catch-name');
  const catchLatin = $('catch-latin');
  const catchFlags = $('catch-flags');
  const catchWeight = $('catch-weight');
  const catchLength = $('catch-length');
  const catchLure = $('catch-lure');
  const catchBlurb = $('catch-blurb');
  const stamps = $('stamps');
  const stampPB = $('stamp-pb');
  const stampNew = $('stamp-new');
  const btnKeep = $('btn-keep');
  const btnRelease = $('btn-release');
  const journalModal = $('journal-modal');
  const journalEl = $('journal');
  const journalTotals = $('journal-totals');
  const journalBody = $('journal-body');
  const btnJournalClose = $('btn-journal-close');
  const pauseModal = $('pause-modal');
  const pauseEl = $('pause');
  const btnResume = $('btn-resume');
  const lureNotes = $('lure-notes');
  const pauseHelp = $('pause-help');
  const center = hud.querySelector('.center') || doc.createElement('div');
  const clockPanel = clockBtn.closest('.clock') || clockBtn;
  const catchScroll = catchEl.querySelector('.catch-scroll') || catchEl;

  // The fonts stylesheet is preloaded without blocking the first paint; its inline onload flips it
  // to a stylesheet. If a CSP ever blocks that inline handler (element.onload is then null while the
  // link is still a preload), add a script-created stylesheet link instead (never render-blocking).
  const fontLink = doc.getElementById('font-css');
  if (fontLink && fontLink.rel === 'preload' && typeof fontLink.onload !== 'function' && fontLink.href) {
    const l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = fontLink.href;
    fontLink.after(l);
  }

  const gauge = createGauge(dialSvg, dial);
  const reducedMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const coarseMq = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
  const reduced = () => !!(reducedMq && reducedMq.matches);

  // ---------- state ----------
  const cur = {
    state: root.dataset.state || STATES.TITLE,
    input: 'mouse',
    units: normUnits(config.units),
    muted: !!config.muted,
    quality: QUALITIES.includes(config.quality) ? config.quality : 'high',
    lureId: LURES[0].id,
    drag01: TACKLE.dragDefault01,
    hours: DAY.startHours,
    titleOpen: !title.hidden,
    catchOpen: false,
    journalOpen: false,
    pauseOpen: false,
    striking: false,
    slow: false, // touch Slow chip (slow retrieve; Shift on a keyboard)
  };
  // Last values written to the DOM (per-frame change detection; numbers are quantized keys).
  const last = {
    hud: null, units: null, minuteKey: NaN, sunKey: NaN, preset: undefined, tensionKey: NaN, dragKey: NaN,
    lineKey: NaN, fishKey: NaN, fishOn: null, powerOn: null, powerQ: -1, powerKey: NaN, rodOn: null, rodKey: NaN,
    prompt: null, promptKind: null, action: null, catches: -1, lureId: null, dragFracQ: -1,
  };
  // hud-derived numbers kept between frames so drag clicks can preview instantly
  const dragNFor = (d01) => TACKLE.dragMinN + d01 * (TACKLE.dragMaxN - TACKLE.dragMinN);
  const num = { tensionN: 0, tension01: 0, dragN: dragNFor(TACKLE.dragDefault01), lineOutM: 0, fishOn: false, fishDistanceM: NaN };
  let lastRecords = Array.isArray(config.records) ? config.records : [];
  // prompt quieting: a steady hint fades QUIET_AFTER_MS after it appears
  let quietTimer = 0;
  let catchRecord = null;
  let catchOpts = { isPersonalBest: false, isNewSpecies: false };
  const speciesList = Array.isArray(ctx.species) ? ctx.species : Array.isArray(config.species) ? config.species : null;

  function call(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn(...args);
    } catch (err) {
      console.error(`[ui] handler ${name} threw`, err);
      return undefined;
    }
  }
  function announce(text) {
    if (!text) return;
    live.textContent = '';
    live.textContent = text;
  }
  function speciesInfo(id, record) {
    const s = speciesList ? speciesList.find((x) => x && x.id === id) : null;
    const f = FIELD_GUIDE[id];
    return {
      name: (record && record.speciesName) || (s && s.name) || (f && f.name) || String(id || 'Unknown fish').replace(/_/g, ' '),
      latin: (record && record.latin) || (s && s.latin) || (f && f.latin) || '',
      blurb: (record && record.blurb) || (s && s.blurb) || (f && f.blurb) || '',
    };
  }

  // ---------- build data-driven parts ----------
  presets.innerHTML = TIME_PRESETS.map(
    (p) => `<button type="button" class="chip" data-hours="${p.hours}" data-preset="${p.id}" aria-pressed="false" aria-label="${p.label}, ${formatClock(p.hours)}">${p.label}</button>`
  ).join('');
  lures.innerHTML = LURES.map(
    (l, i) =>
      `<button type="button" class="lure" data-lure="${l.id}" aria-pressed="false" aria-label="${l.name}, key ${i + 1}" title="${l.name}. ${l.note}">` +
      `${LURE_ICONS[l.id] || ''}<span class="lure-name"><span class="key">${i + 1}</span><span>${l.short}</span></span></button>`
  ).join('');
  const lureButtons = Array.from(lures.querySelectorAll('.lure'));
  const presetButtons = Array.from(presets.querySelectorAll('.chip'));
  const segButtons = Array.from(pauseEl.querySelectorAll('.seg button'));
  // A lure's note (the notes are input-neutral: the slow retrieve is Shift or the touch Slow chip).
  const noteFor = (l) => (l && l.note) || '';
  // What each lure is for, in the pause menu (the chip tooltips are hover-only).
  const lureNoteDDs = [];
  lureNotes.textContent = '';
  for (const l of LURES) {
    const row = doc.createElement('div');
    const dt = doc.createElement('dt');
    const dd = doc.createElement('dd');
    dt.textContent = l.short;
    row.append(dt, dd);
    lureNotes.appendChild(row);
    lureNoteDDs.push([l, dd]);
  }
  function renderLureNotes() {
    for (const [l, dd] of lureNoteDDs) dd.textContent = noteFor(l);
  }

  // ---------- input mode (mouse vs touch) ----------
  // Pen behaves like a mouse (core's input treats a pen press on the lake as the hold action), so
  // only fingers switch the HUD to the touch layout with its big hold button.
  let lastKeyAt = -1e9;
  let lastPointerAt = -1e9;
  function setInput(mode) {
    if (mode !== 'touch' && mode !== 'mouse') return;
    if (mode === cur.input && root.dataset.input === mode) return;
    cur.input = mode;
    root.dataset.input = mode;
    last.prompt = null; // derived prompts depend on the input mode
    setStrikeSub();
    renderLureNotes();
  }
  // The STRIKE cue's sub-line: how to set the hook with this input, or, when a lure is hit while the
  // angler is already reeling (a reel set, core's bite.reelSet), to keep cranking.
  let strikeReelSet = false;
  function setStrikeSub() {
    strikeSub.textContent = strikeReelSet ? 'Keep reeling!' : cur.input === 'touch' ? 'Tap anywhere to set the hook' : 'Click to set the hook';
  }
  setInput(config.touch === true || (config.touch !== false && coarseMq && coarseMq.matches) ? 'touch' : 'mouse');
  const onAnyPointer = (e) => {
    lastPointerAt = performance.now();
    if (e.pointerType === 'touch') setInput('touch');
    else if (e.pointerType === 'mouse' || e.pointerType === 'pen') setInput('mouse');
  };
  window.addEventListener('pointerdown', onAnyPointer, { capture: true, passive: true });
  const onAnyKeyUp = () => {
    lastKeyAt = performance.now();
  };
  window.addEventListener('keyup', onAnyKeyUp, true);
  // True while handling (or right after) a real key press: a dialog opened now was opened from the keyboard.
  const fromKeyboard = () => lastKeyAt > lastPointerAt && performance.now() - lastKeyAt < 300;

  // Time presets start expanded on roomy desktop screens, collapsed on phones.
  function clockLabel() {
    const s = formatClock(((fin(cur.hours, DAY.startHours) % 24) + 24) % 24);
    clockBtn.setAttribute('aria-label', `Time of day ${s}. ${presets.hidden ? 'Show' : 'Hide'} time presets`);
  }
  function setPresetsOpen(open) {
    presets.hidden = !open;
    clockBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    clockLabel();
  }
  setPresetsOpen(cur.input !== 'touch' && window.innerWidth >= 760);

  // ---------- applying settings ----------
  function applyUnits(u) {
    u = normUnits(u);
    if (u === cur.units && last.units === u) return;
    cur.units = u;
    last.units = u;
    const metric = u === 'metric';
    unitsLabel.textContent = metric ? 'KG' : 'LB';
    btnUnits.setAttribute(
      'aria-label',
      metric ? 'Units: kilograms and centimeters. Switch to pounds and inches' : 'Units: pounds and inches. Switch to kilograms and centimeters'
    );
    gauge.setUnits(u);
    const test = lineTestIn(u);
    gaugeLabel.textContent = metric ? `${test.toFixed(1)} kg test` : `${Math.round(test)} lb test`;
    dialUnit.textContent = metric ? 'kg' : 'lb';
    for (const b of segButtons) if (b.dataset.units) b.setAttribute('aria-pressed', b.dataset.units === u ? 'true' : 'false');
    // invalidate unit-dependent readouts
    last.tensionKey = last.dragKey = last.lineKey = last.fishKey = last.powerKey = NaN;
    refreshReadouts();
    if (cur.catchOpen) fillCatch();
    if (cur.journalOpen) renderJournal();
    if (cur.titleOpen) renderTitleBest();
  }
  function applyMuted(m) {
    m = !!m;
    cur.muted = m;
    btnSound.setAttribute('aria-pressed', m ? 'false' : 'true');
    btnSound.setAttribute('aria-label', m ? 'Sound is off. Turn sound on' : 'Sound is on. Turn sound off');
    for (const b of segButtons) if (b.dataset.muted) b.setAttribute('aria-pressed', (b.dataset.muted === '1') === m ? 'true' : 'false');
  }
  function applyQuality(q) {
    if (!QUALITIES.includes(q)) return;
    cur.quality = q;
    for (const b of segButtons) if (b.dataset.quality) b.setAttribute('aria-pressed', b.dataset.quality === q ? 'true' : 'false');
  }
  function applyLure(id) {
    if (!id || id === last.lureId) return;
    cur.lureId = id;
    last.lureId = id;
    for (const b of lureButtons) b.setAttribute('aria-pressed', b.dataset.lure === id ? 'true' : 'false');
    last.prompt = null;
  }
  // A lure's note ("Dives to about 8 ft when reeled…") as a toast: shown whenever core confirms a new
  // lure (chip, keys 1-4) and when the tied-on lure's chip is tapped again, so touch players get it too.
  let noteLure = null;
  function showLureNote(id) {
    const l = LURE_BY_ID[id];
    const n = noteFor(l);
    if (n) toast(`${l.name}: ${n}`, 'info', 5200);
  }
  applyUnits(cur.units);
  applyMuted(cur.muted);
  applyQuality(cur.quality);
  applyLure(cur.lureId);

  // ---------- visibility ----------
  function syncHud() {
    const show = !cur.titleOpen && cur.state !== STATES.TITLE;
    if (hud.hidden === show) hud.hidden = !show;
    const modal = cur.pauseOpen || cur.journalOpen;
    hud.inert = modal;
    catchEl.inert = modal;
  }

  function setState(state) {
    if (!state || state === cur.state) return;
    cur.state = state;
    root.dataset.state = state;
    if (cur.striking && state !== STATES.STRIKE) cutStrike();
    syncHud();
    refreshAction();
  }

  // ---------- title ----------
  function renderTitleBest() {
    const sum = summarize(lastRecords);
    if (!sum.best) {
      titleBest.hidden = true;
      return;
    }
    const b = sum.best;
    const inf = speciesInfo(b.speciesId, b);
    titleBestMain.textContent = `${inf.name} · ${formatWeight(fin(b.weightKg), cur.units)} · ${formatLength(fin(b.lengthCm), cur.units)}`;
    titleBestSub.textContent = `${sum.total} fish in the log · ${Math.min(sum.speciesCount, SPECIES_IDS.length)} of ${SPECIES_IDS.length} species`;
    titleBest.hidden = false;
  }
  function showTitle(opts = {}) {
    if (opts && Array.isArray(opts.records)) lastRecords = opts.records;
    renderTitleBest();
    title.hidden = false;
    cur.titleOpen = true;
    syncHud();
  }
  function hideTitle() {
    if (!cur.titleOpen && title.hidden) return;
    title.hidden = true;
    cur.titleOpen = false;
    syncHud();
  }
  // Loading state (core builds the lake in stages): Start stays disabled and shows progress until
  // setLoading(1). config.loading === true starts in that state.
  let loading = false;
  function setLoading(p01, label) {
    const p = clamp(fin(p01, 1), 0, 1);
    loading = p < 1;
    startBtn.disabled = loading;
    startBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    startBtn.style.setProperty('--p', p.toFixed(3));
    startBtn.textContent = loading ? `${label || 'Preparing the lake'}… ${Math.round(p * 100)}%` : 'Start fishing';
  }
  setLoading(config.loading === true ? 0 : 1);
  startBtn.addEventListener('click', () => {
    if (!cur.titleOpen || loading) return;
    call('onStart'); // from the click itself so audio can start
    hideTitle();
  });

  // ---------- dialogs: focus in, Tab trap, Esc ----------
  const dialogStack = []; // { el, onEsc, restore }
  function focusables(el) {
    return Array.from(el.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(
      (n) => !n.hidden && n.offsetParent !== null
    );
  }
  // Focus goes back to the control that was focused before only when the player opened the dialog from
  // the keyboard (Esc / J / Enter on a HUD button). Dialogs opened by a click or by the game itself (the
  // catch card) leave focus on nothing when they close, so Space goes straight back to the lake.
  function openDialog(el, focusEl, onEsc, { mayRestore = true } = {}) {
    const i = dialogStack.findIndex((d) => d.el === el);
    if (i >= 0) dialogStack.splice(i, 1);
    const prev = doc.activeElement;
    const restore = mayRestore && fromKeyboard() && prev && prev !== doc.body && root.contains(prev) && !el.contains(prev) ? prev : null;
    dialogStack.push({ el, onEsc, restore, openedAt: performance.now() });
    const target = focusEl && !focusEl.disabled ? focusEl : el;
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
  }
  function closeDialog(el) {
    const i = dialogStack.findIndex((d) => d.el === el);
    if (i < 0) return;
    const [d] = dialogStack.splice(i, 1);
    const wasTop = i === dialogStack.length;
    if (!wasTop) return;
    const next = dialogStack[dialogStack.length - 1];
    const active = doc.activeElement;
    const focusWasInside = active && (el.contains(active) || active === doc.body);
    if (!focusWasInside) return;
    if (next) {
      const f = focusables(next.el)[0] || next.el;
      f.focus({ preventScroll: true });
    } else if (d.restore && d.restore.isConnected && !d.restore.closest('[hidden]')) {
      d.restore.focus({ preventScroll: true });
    } else if (active && active !== doc.body && active.blur) {
      active.blur();
    }
  }
  function onKeyDown(e) {
    if (!e.repeat) lastKeyAt = performance.now();
    const top = dialogStack[dialogStack.length - 1];
    if (!top) return;
    // A key still held from gameplay (Space = hold to reel) auto-repeats onto the button that just
    // received focus; its keyup would then click it (e.g. Release). Only fresh presses activate.
    if ((e.key === ' ' || e.key === 'Enter') && (e.repeat || performance.now() - top.openedAt < 350)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) top.onEsc();
    } else if (e.key === 'Tab') {
      const list = focusables(top.el);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const lastEl = list[list.length - 1];
      const a = doc.activeElement;
      if (!top.el.contains(a)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (a === first || a === top.el)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && a === lastEl) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  window.addEventListener('keydown', onKeyDown, true);

  // ---------- catch card ----------
  function fillCatch() {
    const r = catchRecord;
    if (!r) return;
    const inf = speciesInfo(r.speciesId, r);
    catchName.textContent = inf.name;
    catchLatin.textContent = inf.latin;
    catchLatin.hidden = !inf.latin;
    catchWeight.textContent = formatWeight(fin(r.weightKg), cur.units);
    catchLength.textContent = formatLength(fin(r.lengthCm), cur.units);
    catchLure.textContent = lureName(r.lureId);
    catchBlurb.textContent = inf.blurb;
    catchBlurb.hidden = !inf.blurb;
    catchTime.textContent = Number.isFinite(r.hours) ? formatClock(r.hours) : '–';
    let date = '–';
    const t = Date.parse(r.caughtAt);
    if (Number.isFinite(t)) {
      try {
        date = new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch {
        date = String(r.caughtAt).slice(0, 10);
      }
    }
    catchDate.textContent = date;
    stampPB.hidden = !catchOpts.isPersonalBest;
    stampNew.hidden = !catchOpts.isNewSpecies;
    stamps.hidden = !catchOpts.isPersonalBest && !catchOpts.isNewSpecies;
    const flags = [catchOpts.isNewSpecies ? 'New species' : '', catchOpts.isPersonalBest ? 'Personal best' : ''].filter(Boolean).join('. ');
    catchFlags.textContent = flags;
  }
  function showCatch(record, opts = {}) {
    if (!record || typeof record !== 'object') return;
    catchRecord = record;
    catchOpts = { isPersonalBest: !!(opts && opts.isPersonalBest), isNewSpecies: !!(opts && opts.isNewSpecies) };
    fillCatch();
    const wasOpen = cur.catchOpen;
    catchEl.hidden = false;
    cur.catchOpen = true;
    catchScroll.scrollTop = 0;
    syncHud();
    if (!wasOpen) {
      // opened by the game, not by the player: never hand focus back to a HUD control afterwards
      openDialog(catchEl, btnRelease, () => release(), { mayRestore: false });
      const inf = speciesInfo(record.speciesId, record);
      announce(`${inf.name}, ${formatWeight(fin(record.weightKg), cur.units)}, ${formatLength(fin(record.lengthCm), cur.units)}. ${catchFlags.textContent} Keep or release?`);
    }
    relayout();
    requestAnimationFrame(updateScrollHint);
  }
  function hideCatch() {
    if (!cur.catchOpen) return;
    cur.catchOpen = false;
    catchEl.hidden = true;
    catchScroll.classList.remove('has-more');
    closeDialog(catchEl);
    syncHud();
    relayout();
  }
  // The card's final layout box in viewport CSS px (ignores the slide-in transform), or null when the
  // card is not up. Core frames the showcase fish in the free region beside / above it.
  function getCatchRect() {
    if (!cur.catchOpen || catchEl.hidden) return null;
    const w = catchEl.offsetWidth;
    const h = catchEl.offsetHeight;
    if (!(w > 0 && h > 0)) return null;
    const x = catchEl.offsetLeft;
    const y = catchEl.offsetTop;
    if (typeof DOMRect === 'function') return new DOMRect(x, y, w, h);
    return { x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h };
  }
  // Fade the bottom of a scroll area (catch card, pause menu) while there is more to scroll to.
  function scrollHint(el) {
    const more = el.scrollHeight - el.clientHeight > 2 && el.scrollTop + el.clientHeight < el.scrollHeight - 4;
    if (more !== el.classList.contains('has-more')) el.classList.toggle('has-more', more);
  }
  function updateScrollHint() {
    if (cur.catchOpen) scrollHint(catchScroll);
    if (cur.pauseOpen) {
      scrollHint(pauseEl);
      scrollHint(pauseHelp);
    }
  }
  for (const el of [catchScroll, pauseEl, pauseHelp]) el.addEventListener('scroll', () => scrollHint(el), { passive: true });
  function keep() {
    if (!cur.catchOpen) return;
    call('onKeep');
    hideCatch();
  }
  function release() {
    if (!cur.catchOpen) return;
    call('onRelease');
    hideCatch();
  }
  btnKeep.addEventListener('click', keep);
  btnRelease.addEventListener('click', release);

  // ---------- journal ----------
  function renderJournal() {
    const { totals, body } = renderJournalBody(lastRecords, cur.units, speciesInfo, speciesList);
    journalTotals.innerHTML = totals;
    journalBody.innerHTML = body;
  }
  function openJournal(records) {
    if (Array.isArray(records)) lastRecords = records;
    renderJournal();
    if (cur.journalOpen) return;
    cur.journalOpen = true;
    journalModal.hidden = false;
    journalBody.scrollTop = 0;
    syncHud();
    openDialog(journalEl, btnJournalClose, userCloseJournal);
  }
  function closeJournal() {
    if (!cur.journalOpen) return;
    cur.journalOpen = false;
    journalModal.hidden = true;
    closeDialog(journalEl);
    syncHud();
  }
  function userCloseJournal() {
    if (!cur.journalOpen) return;
    closeJournal();
    call('onJournal', false);
  }
  btnJournalClose.addEventListener('click', userCloseJournal);
  journalModal.addEventListener('click', (e) => {
    if (e.target === journalModal) userCloseJournal();
  });
  btnJournal.addEventListener('click', () => {
    if (cur.journalOpen) {
      userCloseJournal();
      return;
    }
    call('onJournal', true);
    if (!cur.journalOpen) openJournal(lastRecords); // core may answer with openJournal(records) itself
  });

  // ---------- pause ----------
  function setPaused(p) {
    p = !!p;
    if (p === cur.pauseOpen) return;
    cur.pauseOpen = p;
    pauseModal.hidden = !p;
    syncHud();
    if (p) {
      openDialog(pauseEl, btnResume, resume);
      pauseEl.scrollTop = 0;
      pauseHelp.scrollTop = 0;
      requestAnimationFrame(updateScrollHint);
    } else closeDialog(pauseEl);
  }
  function resume() {
    if (!cur.pauseOpen) return;
    setPaused(false);
    call('onPause', false);
  }
  btnPause.addEventListener('click', () => {
    setPaused(true);
    call('onPause', true);
  });
  btnResume.addEventListener('click', resume);
  pauseModal.addEventListener('click', (e) => {
    if (e.target === pauseModal) resume();
  });
  for (const b of segButtons) {
    b.addEventListener('click', () => {
      if (b.dataset.muted) {
        const m = b.dataset.muted === '1';
        if (m !== cur.muted) {
          applyMuted(m);
          call('onMute', m);
        }
      } else if (b.dataset.units) {
        const u = b.dataset.units;
        if (u !== cur.units) {
          applyUnits(u);
          call('onUnits', u);
        }
      } else if (b.dataset.quality) {
        const q = b.dataset.quality;
        if (q !== cur.quality) {
          applyQuality(q);
          call('onQuality', q);
        }
      }
    });
  }

  // ---------- HUD controls ----------
  clockBtn.addEventListener('click', () => setPresetsOpen(presets.hidden));
  for (const b of presetButtons) {
    b.addEventListener('click', () => {
      const h = Number(b.dataset.hours);
      cur.hours = h;
      updateClock(h);
      call('onTimePreset', h);
      // on phones the open preset rows push into the toast lane: fold them away once used
      if (cur.input === 'touch') setPresetsOpen(false);
    });
  }
  btnSound.addEventListener('click', () => {
    const m = !cur.muted;
    applyMuted(m);
    call('onMute', m);
  });
  btnUnits.addEventListener('click', () => {
    const u = cur.units === 'metric' ? 'imperial' : 'metric';
    applyUnits(u);
    call('onUnits', u);
  });
  for (const b of lureButtons) {
    b.addEventListener('click', () => {
      const id = b.dataset.lure;
      if (id === cur.lureId && id === noteLure) {
        showLureNote(id); // already tied on: just say what it is for
        return;
      }
      applyLure(id);
      call('onLure', id);
    });
  }

  // Touch: the Slow chip beside the big button toggles the slow retrieve (Shift on a keyboard).
  function applySlow(on) {
    cur.slow = !!on;
    btnSlow.setAttribute('aria-pressed', cur.slow ? 'true' : 'false');
  }
  btnSlow.addEventListener('click', () => {
    applySlow(!cur.slow);
    call('onSlow', cur.slow);
  });

  function stepDrag(dir) {
    const next = Math.round(clamp(cur.drag01 + dir * DRAG_STEP, 0, 1) * 1000) / 1000;
    if (next === cur.drag01) return;
    cur.drag01 = next;
    num.dragN = dragNFor(next);
    refreshReadouts();
    call('onDrag', next);
  }
  function bindRepeat(btn, dir) {
    let delay = 0;
    let rep = 0;
    const stop = () => {
      clearTimeout(delay);
      clearInterval(rep);
      delay = rep = 0;
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.stopPropagation();
      stop();
      stepDrag(dir);
      delay = setTimeout(() => {
        rep = setInterval(() => stepDrag(dir), 90);
      }, 380);
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'blur']) btn.addEventListener(t, stop);
    btn.addEventListener('click', (e) => {
      if (e.detail === 0) stepDrag(dir); // keyboard activation; pointer presses stepped on pointerdown
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    return stop;
  }
  const stopMinus = bindRepeat(dragMinus, -1);
  const stopPlus = bindRepeat(dragPlus, 1);
  // Wheel over the gauge adjusts drag too (core owns the wheel elsewhere).
  let wheelAcc = 0;
  gaugeEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      while (Math.abs(wheelAcc) >= 60) {
        const s = Math.sign(wheelAcc);
        wheelAcc -= s * 60;
        stepDrag(-s);
      }
    },
    { passive: false }
  );

  // Big hold-to-cast/reel button (touch). Exactly one onActionUp per onActionDown.
  let actionPointer = null;
  let actionKey = false;
  function actionDown() {
    action.classList.add('is-down');
    call('onActionDown');
  }
  function actionUp() {
    action.classList.remove('is-down');
    call('onActionUp');
  }
  action.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (actionPointer !== null || actionKey) return;
    actionPointer = e.pointerId;
    try {
      action.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    actionDown();
  });
  const actionRelease = (e) => {
    if (actionPointer === null || (e && e.pointerId !== undefined && e.pointerId !== actionPointer)) return;
    actionPointer = null;
    actionUp();
  };
  for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) action.addEventListener(t, actionRelease);
  action.addEventListener('contextmenu', (e) => e.preventDefault());
  action.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || actionKey || actionPointer !== null) return;
    actionKey = true;
    actionDown();
  });
  action.addEventListener('keyup', (e) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (!actionKey) return;
    actionKey = false;
    actionUp();
  });
  function releaseAllHolds() {
    if (actionPointer !== null) {
      actionPointer = null;
      actionUp();
    }
    if (actionKey) {
      actionKey = false;
      actionUp();
    }
    stopMinus();
    stopPlus();
  }
  action.addEventListener('blur', () => {
    if (actionKey) {
      actionKey = false;
      actionUp();
    }
  });
  window.addEventListener('blur', releaseAllHolds);
  const onVisibility = () => {
    if (doc.hidden) releaseAllHolds();
  };
  doc.addEventListener('visibilitychange', onVisibility);

  // Every button press ticks (except the hold button); pointer clicks drop focus from HUD
  // buttons so Space (cast) is never swallowed by a focused lure chip or the pause button.
  root.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || b === action || !root.contains(b)) return;
    if (events) events.emit('ui:click', {});
    if (e.detail > 0 && hud.contains(b)) b.blur();
  });
  // Keep presses on HUD controls from reaching the canvas / core pointer handlers.
  const stopPointer = (e) => {
    if (e.target && e.target.closest && e.target.closest('button, [role="dialog"], .title, .modal')) e.stopPropagation();
  };
  root.addEventListener('pointerdown', stopPointer);
  root.addEventListener('mousedown', stopPointer);

  // ---------- layout: prompt band + toast lane (measured, so it follows fonts, safe areas, input mode) ----------
  const bandSet = { x: '', w: '', b: '' };
  const toastSet = { x: '', w: '', top: '' };
  function setVar(el, store, key, prop, value) {
    if (store[key] === value) return;
    store[key] = value;
    if (value) el.style.setProperty(prop, value);
    else el.style.removeProperty(prop);
  }
  // The prompt (and the cast-power bar above it) never sits in the middle band where the camera puts
  // the float and the hooked fish: it goes between the lure panel and the gauge when that gap is wide
  // enough, else above whichever bottom panel it would cover (above the lures on narrow desktops and
  // tablets, above both on phones).
  function layoutBand() {
    if (hud.hidden) return;
    const vw = window.innerWidth || doc.documentElement.clientWidth;
    const vh = window.innerHeight || doc.documentElement.clientHeight;
    const lr = lures.getBoundingClientRect();
    const gr = gaugeEl.getBoundingClientRect();
    if (!(lr.width > 0 && gr.width > 0 && vw > 0 && vh > 0)) return;
    const pad = 12;
    let x0 = lr.right + pad;
    let x1 = gr.left - pad;
    let bottom;
    if (x1 - x0 >= BAND_MIN_W) {
      bottom = vh - Math.max(lr.bottom, gr.bottom); // between the panels, on their baseline
    } else if (gr.left - pad - GUT >= Math.min(BAND_MAX_W, 360)) {
      x0 = GUT; // above the lure panel, clear of the (taller) gauge
      bottom = vh - lr.top + 10;
    } else {
      x0 = GUT; // full width above both (portrait phones)
      x1 = vw - GUT;
      bottom = vh - Math.min(lr.top, gr.top) + 10;
    }
    const w = Math.max(0, Math.min(BAND_MAX_W, x1 - x0));
    const x = clamp(vw / 2, x0 + w / 2, x1 - w / 2);
    setVar(center, bandSet, 'x', '--band-x', `${Math.round(x)}px`);
    setVar(center, bandSet, 'w', '--band-w', `${Math.floor(w)}px`);
    setVar(center, bandSet, 'b', '--band-b', `${Math.round(Math.max(0, bottom))}px`);
  }
  // Toasts: below an open time-preset row they would cover, and beside (not over) a side-panel catch card.
  function placeToasts() {
    const vw = window.innerWidth || doc.documentElement.clientWidth;
    let x0 = 0;
    let x1 = vw;
    const cr = getCatchRect();
    if (cr && cr.left > vw * 0.3) x1 = cr.left - 8; // side panel: use the strip left of it
    const w = Math.max(160, Math.min(440, x1 - x0 - 2 * GUT));
    const cx = (x0 + x1) / 2;
    let top = '';
    if (!hud.hidden) {
      const c = clockPanel.getBoundingClientRect();
      const defTop = c.top + 58; // CSS default: 70px + safe-area top (the clock sits at 12px + safe-area top)
      if (c.height > 0 && c.bottom + 8 > defTop && c.right > cx - w / 2 && c.left < cx + w / 2) top = `${Math.round(c.bottom + 8)}px`;
    }
    const moved = x1 < vw;
    setVar(toasts, toastSet, 'x', '--toast-x', moved ? `${Math.round(cx)}px` : '');
    setVar(toasts, toastSet, 'w', '--toast-w', moved ? `${Math.floor(w)}px` : '');
    setVar(toasts, toastSet, 'top', '--toast-top', top);
  }
  function relayout() {
    layoutBand();
    placeToasts();
    updateScrollHint();
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => relayout());
    for (const el of [lures, gaugeEl, clockPanel, catchEl, ...catchScroll.children, pauseEl, pauseHelp]) ro.observe(el);
  }
  window.addEventListener('resize', relayout);
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(relayout, () => {});

  // ---------- per-frame pieces ----------
  function updateClock(hours) {
    const h = ((fin(hours, cur.hours) % 24) + 24) % 24;
    const minuteKey = Math.floor(h * 60);
    if (minuteKey !== last.minuteKey) {
      last.minuteKey = minuteKey;
      const s = formatClock(h);
      const sp = s.lastIndexOf(' ');
      clockHM.textContent = s.slice(0, sp);
      clockAMPM.textContent = s.slice(sp + 1);
      clockBtn.setAttribute('aria-label', `Time of day ${s}. ${presets.hidden ? 'Show' : 'Hide'} time presets`);
    }
    const sunKey = Math.floor(h * 12); // 5 game minutes
    if (sunKey !== last.sunKey) {
      last.sunKey = sunKey;
      const rise = DAY.sunriseHours;
      const set = DAY.sunsetHours;
      const day = h >= rise && h <= set;
      let t;
      if (day) t = (h - rise) / (set - rise);
      else t = (((h - set) % 24) + 24) % 24 / (24 - (set - rise));
      const a = Math.PI * (1 - clamp(t, 0, 1));
      const x = (19 + 16 * Math.cos(a)).toFixed(2);
      const y = (19 - 16 * Math.sin(a)).toFixed(2);
      if (day) {
        sunDot.setAttribute('cx', x);
        sunDot.setAttribute('cy', y);
      } else {
        moonDot.setAttribute('transform', `translate(${x} ${y})`);
      }
      // SVG elements have no .hidden property; toggle the attribute ([hidden] is display:none).
      if (sunDot.hasAttribute('hidden') === day) sunDot.toggleAttribute('hidden', !day);
      if (moonDot.hasAttribute('hidden') !== day) moonDot.toggleAttribute('hidden', day);
      // Mark the preset we are at (within 10 game minutes).
      let active = null;
      for (const p of TIME_PRESETS) {
        let d = Math.abs(h - p.hours);
        d = Math.min(d, 24 - d);
        if (d <= 10 / 60) active = p.id;
      }
      if (active !== last.preset) {
        last.preset = active;
        for (const b of presetButtons) b.setAttribute('aria-pressed', b.dataset.preset === active ? 'true' : 'false');
      }
    }
  }

  function refreshReadouts() {
    const u = cur.units;
    const metric = u === 'metric';
    // tension
    const tv = forceValue(num.tensionN, u);
    const tKey = Math.round(tv * 10);
    if (tKey !== last.tensionKey) {
      last.tensionKey = tKey;
      const s = (tKey / 10).toFixed(1);
      dialValue.textContent = s;
      roTension.textContent = `${s} ${metric ? 'kg' : 'lb'}`;
    }
    // drag: prefer the local value right after a click, else hud.dragN
    const dragN = num.dragN;
    const dv = forceValue(dragN, u);
    const dKey = Math.round(dv * 10);
    if (dKey !== last.dragKey) {
      last.dragKey = dKey;
      const s = `${(dKey / 10).toFixed(1)} ${metric ? 'kg' : 'lb'}`;
      dragVal.textContent = s;
      dragMinus.setAttribute('aria-label', `Loosen drag, now ${s}`);
      dragPlus.setAttribute('aria-label', `Tighten drag, now ${s}`);
    }
    gauge.set(num.tension01, dragN / TACKLE.lineBreakN);
    // line out
    const lm = Math.max(0, num.lineOutM);
    const lKey = metric ? Math.round(lm * 10) : Math.round(lm / M_PER_FT);
    if (lKey !== last.lineKey) {
      last.lineKey = lKey;
      roLine.textContent = formatDistance(lm, u);
    }
    // fish distance
    const fOn = !!num.fishOn;
    if (fOn !== last.fishOn) {
      last.fishOn = fOn;
      fishOnEl.hidden = !fOn;
      last.fishKey = NaN;
    }
    const fd = fOn && Number.isFinite(num.fishDistanceM) ? Math.max(0, num.fishDistanceM) : NaN;
    const fKey = Number.isFinite(fd) ? (metric ? Math.round(fd * 10) : Math.round(fd / M_PER_FT)) : -1;
    if (fKey !== last.fishKey) {
      last.fishKey = fKey;
      roFish.textContent = fKey < 0 ? '–' : formatDistance(fd, u);
    }
  }

  // Rod meter (fighting): the rod from behind. It leans with side pressure (hud.rodSide -1..1), stands
  // taller as it is lifted (hud.rodLift01) and turns amber while it points down the line (hud.rodStiff01).
  function updateRodMeter(h) {
    const on = cur.state === STATES.FIGHTING && num.fishOn && Number.isFinite(h.rodLift01);
    if (on !== last.rodOn) {
      last.rodOn = on;
      rodMeter.hidden = !on;
      last.rodKey = NaN;
    }
    if (!on) return;
    const side = clamp(fin(h.rodSide), -1, 1);
    const lift = clamp(fin(h.rodLift01), 0, 1);
    const stiff = fin(h.rodStiff01) > 0.6;
    const qs = Math.round(side * 20);
    const ql = Math.round(lift * 20);
    const key = (qs + 20) * 100 + ql * 2 + (stiff ? 1 : 0); // numeric: no per-frame garbage
    if (key === last.rodKey) return;
    last.rodKey = key;
    const a = (qs / 20) * 0.95; // radians from upright
    const len = 7 + 11 * (ql / 20);
    const x = (22 + len * Math.sin(a)).toFixed(1);
    const y = (22 - len * Math.cos(a)).toFixed(1);
    rodLine.setAttribute('x2', x);
    rodLine.setAttribute('y2', y);
    rodTip.setAttribute('cx', x);
    rodTip.setAttribute('cy', y);
    rodMeter.classList.toggle('is-stiff', stiff);
  }

  // Slack line with a fish on (the dial sits at zero): after a moment the empty track pulses amber,
  // because slack is when a shaking fish throws the hook.
  let slackSince = 0;
  let slackOn = false;
  function updateSlack() {
    // (core says when the line really hangs slack; without it, a dial sitting at zero)
    const h = last.hud;
    const slack = cur.state === STATES.FIGHTING && num.fishOn && (h && typeof h.slackLine === 'boolean' ? h.slackLine : num.tension01 < 0.02);
    const now = performance.now();
    if (!slack) slackSince = 0;
    else if (!slackSince) slackSince = now;
    const on = slack && now - slackSince >= SLACK_PULSE_MS;
    if (on === slackOn) return;
    slackOn = on;
    if (on) dial.dataset.slack = '1';
    else delete dial.dataset.slack;
  }

  // Fallback prompts when core does not send hud.prompt. Writes into a scratch object (no per-frame garbage).
  const derived = { text: '', kind: 'info' };
  function derivePrompt(h) {
    const touch = cur.input === 'touch';
    let text = '';
    let kind = 'info';
    switch (cur.state) {
      case STATES.READY:
        text = touch ? 'Hold the button to cast' : 'Hold to cast';
        kind = 'ready';
        break;
      case STATES.CHARGING:
        text = touch ? 'Let go to cast' : 'Release to cast';
        kind = 'ready';
        break;
      case STATES.WAITING: {
        const lure = LURE_BY_ID[h.lureId || cur.lureId];
        if (!lure || lure.kind === 'bait') {
          text = touch ? 'Watch the float · tap when it goes under · hold Reel to bring it in' : 'Watch the float · click when it goes under · hold to reel in';
        } else if (lure.id === 'topwater') {
          text = touch ? 'Reel in short bursts · pause now and then' : 'Shift + hold for a slow walk · pause now and then';
        } else {
          text = touch ? 'Hold Reel to retrieve · pause now and then' : 'Hold to reel · Shift for a slower retrieve';
        }
        break;
      }
      case STATES.STRIKE:
        text = touch ? 'Tap anywhere to set the hook' : 'Click to set the hook';
        kind = 'danger';
        break;
      case STATES.FIGHTING: {
        // say what to do, with the control for this input
        const lvl = gauge.level;
        if (lvl === 2) (text = touch ? 'Too much tension! Let go of Reel and tap –' : 'Too much tension! Stop reeling, loosen the drag'), (kind = 'danger');
        else if (lvl === 1) (text = touch ? 'Heavy load. Tap – to loosen the drag' : 'Heavy load. Loosen the drag: wheel down or ['), (kind = 'warn');
        else if (Number.isFinite(h.fishStamina01) && h.fishStamina01 < 0.25) (text = 'Fish is tiring. Keep it coming'), (kind = 'good');
        else (text = touch ? 'Fish on! Drag up on the lake to lift the rod' : 'Fish on! Mouse up to keep the rod high'), (kind = 'good');
        break;
      }
      case STATES.LANDING:
        text = 'Netting the fish';
        kind = 'good';
        break;
      case STATES.SNAPPED:
        text = 'Line snapped. Re-tying';
        kind = 'danger';
        break;
      case STATES.ESCAPED:
        text = 'The fish got off';
        kind = 'warn';
        break;
      default:
        break;
    }
    derived.text = text;
    derived.kind = kind;
    return derived;
  }
  function refreshPrompt(h) {
    let text;
    let kind;
    if (h && h.prompt != null) {
      text = String(h.prompt);
      kind = normKind(h.promptKind);
    } else {
      const d = derivePrompt(h || {});
      text = d.text;
      kind = d.kind;
    }
    if (cur.striking) text = ''; // the strike cue carries the message
    if (text === last.prompt && kind === last.promptKind) return;
    const changedText = text !== last.prompt;
    last.prompt = text;
    last.promptKind = kind;
    prompt.hidden = !text;
    // Steady hints while the float is out or a fish is on (info / good) fade a few seconds after they
    // appear, so they never sit over the water for long; a new hint shows again, and warnings and
    // dangers always stay.
    if (changedText || !text) {
      clearTimeout(quietTimer);
      quietTimer = 0;
      prompt.classList.remove('is-quiet');
    }
    if (text && (kind === 'info' || kind === 'good') && (cur.state === STATES.WAITING || cur.state === STATES.FIGHTING)) {
      if (!quietTimer && !prompt.classList.contains('is-quiet')) {
        quietTimer = setTimeout(() => {
          quietTimer = 0;
          if (last.prompt === text) prompt.classList.add('is-quiet');
        }, QUIET_AFTER_MS);
      }
    } else {
      clearTimeout(quietTimer);
      quietTimer = 0;
      prompt.classList.remove('is-quiet');
    }
    if (text) {
      promptText.textContent = text;
      prompt.dataset.kind = kind;
      if (changedText) announce(text);
    }
  }
  function refreshAction() {
    const a = ACTIONS[cur.state] || ACTIONS[STATES.READY];
    if (a === last.action) return;
    last.action = a;
    action.dataset.mode = a[0];
    actionMain.textContent = a[1];
    actionSub.textContent = a[2];
    actionSub.hidden = !a[2];
    action.setAttribute('aria-label', a[3]);
  }

  function update(h) {
    if (!h || typeof h !== 'object') return;
    last.hud = h;
    if (h.state && h.state !== cur.state) setState(h.state);
    if (h.units != null && normUnits(h.units) !== cur.units) applyUnits(h.units);
    if (typeof h.muted === 'boolean' && h.muted !== cur.muted) applyMuted(h.muted);
    if (typeof h.quality === 'string' && h.quality !== cur.quality) applyQuality(h.quality);
    if (typeof h.paused === 'boolean' && h.paused !== cur.pauseOpen) setPaused(h.paused);
    if (typeof h.slow === 'boolean' && h.slow !== cur.slow) applySlow(h.slow);
    if (h.lureId && h.lureId !== last.lureId) applyLure(h.lureId);
    if (h.lureId && h.lureId !== noteLure) {
      const had = noteLure;
      noteLure = h.lureId;
      if (had && !cur.titleOpen && cur.state !== STATES.TITLE) showLureNote(h.lureId);
    }
    if (Number.isFinite(h.hours)) {
      cur.hours = h.hours;
      updateClock(h.hours);
    }

    // numbers (NaN-safe)
    if (Number.isFinite(h.drag01)) cur.drag01 = clamp(h.drag01, 0, 1);
    num.dragN = Number.isFinite(h.dragN) ? h.dragN : dragNFor(cur.drag01);
    num.tensionN = Number.isFinite(h.tensionN) ? Math.max(0, h.tensionN) : fin(h.tension01) * TACKLE.lineBreakN;
    num.tension01 = Number.isFinite(h.tension01) ? h.tension01 : num.tensionN / TACKLE.lineBreakN;
    num.lineOutM = fin(h.lineOutM);
    num.fishOn = !!h.fishOn;
    num.fishDistanceM = fin(h.fishDistanceM, NaN);
    refreshReadouts();
    updateSlack();
    updateRodMeter(h);

    // cast power
    const showPower = cur.state === STATES.CHARGING;
    if (showPower !== last.powerOn) {
      last.powerOn = showPower;
      power.hidden = !showPower;
      last.powerQ = -1;
      last.powerKey = NaN;
    }
    if (showPower) {
      const p = clamp(fin(h.castPower01), 0, 1);
      const q = Math.round(p * 500);
      if (q !== last.powerQ) {
        last.powerQ = q;
        powerFill.style.transform = `scaleX(${q / 500})`;
      }
      const lure = LURE_BY_ID[h.lureId || cur.lureId];
      const m = p * (lure ? lure.maxCastM : TACKLE.maxCastM);
      const key = cur.units === 'metric' ? Math.round(m) : Math.round(m / M_PER_FT);
      if (key !== last.powerKey) {
        last.powerKey = key;
        powerEst.textContent = `≈ ${cur.units === 'metric' ? `${key} m` : `${key} ft`}`;
      }
    }

    refreshPrompt(h);
    refreshAction();

    // journal badge
    const c = Array.isArray(h.catches) ? h.catches.length : Number.isFinite(h.catches) ? Math.max(0, Math.floor(h.catches)) : -1;
    if (c !== last.catches) {
      last.catches = c;
      journalCount.hidden = c <= 0;
      if (c > 0) journalCount.textContent = c > 99 ? '99+' : String(c);
      btnJournal.setAttribute('aria-label', c > 0 ? `Open the journal (${c} fish logged)` : 'Open the journal');
      if (Array.isArray(h.catches)) lastRecords = h.catches;
    }
  }

  // ---------- strike cue ----------
  let strikeAnim = null;
  let strikeTimer = 0;
  function endStrike() {
    clearTimeout(strikeTimer);
    strikeTimer = 0;
    strikeAnim = null;
    strike.hidden = true;
    cur.striking = false;
    last.prompt = null;
    if (last.hud) refreshPrompt(last.hud);
  }
  // The window closed (hook set, missed or spat): clear the word quickly instead of letting it linger.
  function cutStrike() {
    if (!cur.striking) return;
    if (strikeAnim) {
      strikeAnim.onfinish = null;
      strikeAnim.cancel();
      strikeAnim = null;
    }
    clearTimeout(strikeTimer);
    if (!reduced() && typeof strike.animate === 'function') {
      strikeAnim = strike.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' });
      strikeAnim.onfinish = endStrike;
      strikeTimer = setTimeout(endStrike, 260);
    } else endStrike();
  }
  function strikeCue(opts = {}) {
    strikeReelSet = !!(opts && opts.reelSet);
    setStrikeSub();
    cur.striking = true;
    strike.hidden = false;
    announce('Strike!');
    if (last.hud) refreshPrompt(last.hud);
    if (strikeAnim) {
      strikeAnim.onfinish = null;
      strikeAnim.cancel();
      strikeAnim = null;
    }
    clearTimeout(strikeTimer);
    if (!reduced() && typeof strike.animate === 'function') {
      strikeAnim = strike.animate(
        [
          { transform: 'scale(1.07)', opacity: 1, offset: 0 },
          { transform: 'scale(1)', opacity: 1, offset: 0.1, easing: 'ease-in' },
          { transform: 'scale(1)', opacity: 1, offset: 0.74 },
          { transform: 'scale(1)', opacity: 0, offset: 1 },
        ],
        { duration: 1150, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      );
      strikeAnim.onfinish = endStrike;
    }
    // Always end by timer too (also covers reduced motion and missing WAAPI).
    strikeTimer = setTimeout(endStrike, reduced() ? 1100 : 1250);
  }

  // ---------- toasts ----------
  function toast(text, kind = 'info', ms = 3400) {
    if (!text) return;
    const el = doc.createElement('div');
    el.className = 'toast';
    el.dataset.kind = kind === 'good' || kind === 'bad' ? kind : 'info';
    el.textContent = String(text);
    toasts.appendChild(el);
    while (toasts.children.length > 3) toasts.firstElementChild.remove();
    announce(String(text));
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), reduced() ? 0 : 340);
    }, Number.isFinite(ms) && ms > 0 ? ms : 3400);
  }

  // Stay in sync if core forgets to call setState.
  const offState = events && typeof events.on === 'function' ? events.on('state', (p) => p && p.to && setState(p.to)) : null;

  refreshAction();
  refreshReadouts();
  updateClock(cur.hours);
  syncHud();

  function dispose() {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onAnyKeyUp, true);
    window.removeEventListener('pointerdown', onAnyPointer, { capture: true });
    window.removeEventListener('blur', releaseAllHolds);
    window.removeEventListener('resize', relayout);
    doc.removeEventListener('visibilitychange', onVisibility);
    if (ro) ro.disconnect();
    if (typeof offState === 'function') offState();
    releaseAllHolds();
    clearTimeout(strikeTimer);
    clearTimeout(quietTimer);
  }

  return {
    showTitle,
    hideTitle,
    setState,
    update,
    strikeCue,
    showCatch,
    hideCatch,
    toast,
    openJournal,
    closeJournal,
    // extras (not in the contract; safe to ignore)
    setLoading,
    setPaused,
    isModalOpen: () => cur.pauseOpen || cur.journalOpen || cur.catchOpen,
    // The catch card's layout box (DOMRect, viewport CSS px) while it is up, else null. A bottom sheet
    // when the window is <= 720 px wide (and taller than 520 px) or its aspect is <= 0.85, else a side
    // panel on the right.
    getCatchRect,
    dispose,
  };
}
