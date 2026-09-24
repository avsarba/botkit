// UI sandbox: mounts createUI over a painted stand-in for the 3D lake view, fakes the core
// handlers and scripts through every UI state. Build WITH the template:
//   node build.mjs --entry src/sandbox/ui.js --out dist/sandbox-ui.html
// then drive it with window.__sandbox.go('<state>') (see STATES_SCRIPT below).
import { createUI } from '../ui/index.js';
import { createEmitter, STATES, TACKLE, makeRng } from '../config.js';

// ---------- painted backdrop: a northern lake at dawn, seen from the end of a dock ----------
function paintLake(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rng = makeRng(7);
  const hz = Math.round(h * (w < h ? 0.4 : 0.44)); // horizon

  // sky
  let gr = g.createLinearGradient(0, 0, 0, hz);
  gr.addColorStop(0, '#4d6680');
  gr.addColorStop(0.45, '#8d9cab');
  gr.addColorStop(0.8, '#d5c0a6');
  gr.addColorStop(1, '#efcf9f');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, hz);
  const sunX = w * 0.63;
  const glow = g.createRadialGradient(sunX, hz - 6, 2, sunX, hz - 6, h * 0.45);
  glow.addColorStop(0, 'rgba(255,236,196,0.95)');
  glow.addColorStop(0.08, 'rgba(255,220,170,0.55)');
  glow.addColorStop(0.4, 'rgba(250,200,150,0.12)');
  glow.addColorStop(1, 'rgba(250,200,150,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, hz + 40);
  // high thin cloud streaks
  for (let i = 0; i < 9; i++) {
    const y = hz * (0.12 + rng() * 0.55);
    const x = rng() * w;
    const cw = w * (0.2 + rng() * 0.35);
    const c = g.createLinearGradient(x - cw / 2, 0, x + cw / 2, 0);
    c.addColorStop(0, 'rgba(240,210,190,0)');
    c.addColorStop(0.5, `rgba(240,205,185,${0.12 + rng() * 0.12})`);
    c.addColorStop(1, 'rgba(240,210,190,0)');
    g.fillStyle = c;
    g.fillRect(x - cw / 2, y, cw, 2 + rng() * 3);
  }

  // distant ridge (hazy) and the forested far shore
  const ridge = (base, amp, step, color, spiky) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, hz + 1);
    let y = base;
    for (let x = 0; x <= w + step; x += step) {
      y += (rng() - 0.5) * amp;
      y = Math.min(base + amp, Math.max(base - amp, y));
      if (spiky) {
        const tip = y - 4 - rng() * spiky;
        g.lineTo(x - step * 0.5, y);
        g.lineTo(x - step * 0.25, tip);
        g.lineTo(x, y);
      } else g.lineTo(x, y);
    }
    g.lineTo(w, hz + 1);
    g.closePath();
    g.fill();
  };
  ridge(hz - h * 0.05, h * 0.018, 18, '#7a8588', 0);
  ridge(hz - h * 0.028, h * 0.01, 7, '#3c4a4a', 9);
  ridge(hz - h * 0.012, h * 0.006, 5, '#223030', 7);
  // morning mist on the far shore
  gr = g.createLinearGradient(0, hz - h * 0.04, 0, hz + 6);
  gr.addColorStop(0, 'rgba(226,214,196,0)');
  gr.addColorStop(1, 'rgba(226,214,196,0.35)');
  g.fillStyle = gr;
  g.fillRect(0, hz - h * 0.04, w, h * 0.04 + 6);

  // water: darker reflected sky, glassy with wind lines
  gr = g.createLinearGradient(0, hz, 0, h);
  gr.addColorStop(0, '#b7a792');
  gr.addColorStop(0.08, '#7b8589');
  gr.addColorStop(0.35, '#3d5058');
  gr.addColorStop(1, '#16252a');
  g.fillStyle = gr;
  g.fillRect(0, hz, w, h - hz);
  // shoreline reflection band
  g.fillStyle = 'rgba(28,40,40,0.55)';
  g.fillRect(0, hz, w, h * 0.012);
  // wind lines and ripple highlights, denser near the horizon
  for (let i = 0; i < 520; i++) {
    const t = Math.pow(rng(), 1.8);
    const y = hz + 3 + t * (h - hz);
    const len = 8 + t * 90 * (0.5 + rng());
    const x = rng() * w;
    const nearSun = Math.max(0, 1 - Math.abs(x - sunX) / (w * 0.1 + t * w * 0.12));
    const a = 0.05 + nearSun * 0.5 * (1 - t * 0.6);
    g.fillStyle = nearSun > 0.05 ? `rgba(255,228,180,${a.toFixed(3)})` : `rgba(190,205,210,${(0.05 + rng() * 0.05).toFixed(3)})`;
    g.fillRect(x, y, len, 1 + t * 1.6);
  }
  for (let i = 0; i < 260; i++) {
    const t = Math.pow(rng(), 1.4);
    const y = hz + 3 + t * (h - hz);
    g.fillStyle = `rgba(6,16,20,${(0.08 + rng() * 0.1).toFixed(3)})`;
    g.fillRect(rng() * w, y, 10 + t * 120, 1 + t * 2.5);
  }

  // dock end in the foreground
  const dockTop = h * 0.9;
  g.fillStyle = '#4b4239';
  g.beginPath();
  g.moveTo(w * 0.18, h);
  g.lineTo(w * 0.3, dockTop);
  g.lineTo(w * 0.7, dockTop);
  g.lineTo(w * 0.82, h);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(20,16,12,0.55)';
  g.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    const y = dockTop + ((h - dockTop) * i) / 6;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  g.fillStyle = 'rgba(0,0,0,0)';

  // rod: graphite blank from bottom right up toward the lake, line hanging from the tip
  const bx = w * 0.8;
  const by = h * 1.02;
  const tx = w * 0.58;
  const ty = h * 0.36;
  g.lineCap = 'round';
  for (let k = 0; k < 16; k++) {
    const a = k / 16;
    const b = (k + 1) / 16;
    g.strokeStyle = '#1b1e1c';
    g.lineWidth = 5.5 * (1 - a) + 1;
    g.beginPath();
    g.moveTo(bx + (tx - bx) * a, by + (ty - by) * a + Math.sin(a * Math.PI) * 10);
    g.lineTo(bx + (tx - bx) * b, by + (ty - by) * b + Math.sin(b * Math.PI) * 10);
    g.stroke();
  }
  g.strokeStyle = 'rgba(211,238,79,0.8)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(tx, ty);
  g.quadraticCurveTo(tx - w * 0.05, ty + h * 0.12, tx - w * 0.1, hz + h * 0.1);
  g.stroke();
}

// ---------- sample data ----------
const iso = (m) => new Date(Date.UTC(2026, 8, 20, 11, 0) + m * 60000).toISOString();
const RECORDS = [
  { id: 'c1', speciesId: 'bluegill', speciesName: 'Bluegill', latin: 'Lepomis macrochirus', weightKg: 0.23, lengthCm: 17.8, lureId: 'bobber', hours: 6.3, caughtAt: iso(0), kept: false },
  { id: 'c2', speciesId: 'yellow_perch', speciesName: 'Yellow Perch', latin: 'Perca flavescens', weightKg: 0.31, lengthCm: 26.1, lureId: 'bobber', hours: 6.6, caughtAt: iso(20), kept: true },
  { id: 'c3', speciesId: 'largemouth_bass', speciesName: 'Largemouth Bass', latin: 'Micropterus salmoides', weightKg: 1.62, lengthCm: 44.5, lureId: 'topwater', hours: 6.9, caughtAt: iso(40), kept: false },
  { id: 'c4', speciesId: 'bluegill', speciesName: 'Bluegill', latin: 'Lepomis macrochirus', weightKg: 0.18, lengthCm: 16.2, lureId: 'bobber', hours: 7.4, caughtAt: iso(70), kept: false },
  { id: 'c5', speciesId: 'walleye', speciesName: 'Walleye', latin: 'Sander vitreus', weightKg: 1.9, lengthCm: 55.2, lureId: 'crankbait', hours: 19.9, caughtAt: iso(800), kept: true },
  { id: 'c6', speciesId: 'northern_pike', speciesName: 'Northern Pike', latin: 'Esox lucius', weightKg: 2.85, lengthCm: 69.8, lureId: 'spinner', hours: 20.1, caughtAt: iso(815), kept: false },
  { id: 'c7', speciesId: 'yellow_perch', speciesName: 'Yellow Perch', latin: 'Perca flavescens', weightKg: 0.21, lengthCm: 23.4, lureId: 'spinner', hours: 9.2, caughtAt: iso(1500), kept: false },
  { id: 'c8', speciesId: 'smallmouth_bass', speciesName: 'Smallmouth Bass', latin: 'Micropterus dolomieu', weightKg: 1.28, lengthCm: 40.1, lureId: 'crankbait', hours: 9.8, caughtAt: iso(1540), kept: false },
];
const CATCH = {
  id: 'c9', speciesId: 'smallmouth_bass', speciesName: 'Smallmouth Bass', latin: 'Micropterus dolomieu',
  weightKg: 1.93, lengthCm: 45.7, lureId: 'crankbait', hours: 6.42, caughtAt: iso(2900), kept: false,
};

// ---------- mount ----------
const stage = document.getElementById('stage') || document.body;
const canvas = document.createElement('canvas');
stage.appendChild(canvas);
paintLake(canvas);
addEventListener('resize', () => paintLake(canvas));

const events = createEmitter();
const log = [];
events.on('ui:click', () => log.push('ui:click'));
const dragNFor = (d) => TACKLE.dragMinN + d * (TACKLE.dragMaxN - TACKLE.dragMinN);
const hud = {
  state: STATES.TITLE, tension01: 0, tensionN: 0, dragN: dragNFor(TACKLE.dragDefault01), drag01: TACKLE.dragDefault01,
  lineOutM: 0, castPower01: 0, hours: 6.1, lureId: 'bobber', units: 'imperial', muted: false,
  catches: RECORDS.length, fishOn: false, fishDistanceM: 0, prompt: undefined, promptKind: undefined,
};
let paused = false;
let records = RECORDS.slice();
let ui = null;
const handlers = {
  onStart: () => { log.push('start'); hud.state = STATES.READY; },
  onLure: (id) => { log.push(`lure:${id}`); hud.lureId = id; },
  onDrag: (d) => { log.push(`drag:${d}`); hud.drag01 = d; hud.dragN = dragNFor(d); },
  onTimePreset: (hrs) => { log.push(`time:${hrs}`); hud.hours = hrs; },
  onMute: (m) => { log.push(`mute:${m}`); hud.muted = m; },
  onUnits: (u) => { log.push(`units:${u}`); hud.units = u; },
  onPause: (p) => { log.push(`pause:${p}`); paused = p; },
  onActionDown: () => log.push('actionDown'),
  onActionUp: () => log.push('actionUp'),
  onQuality: (q) => log.push(`quality:${q}`),
  onKeep: () => { log.push('keep'); hud.state = STATES.READY; },
  onRelease: () => { log.push('release'); hud.state = STATES.READY; },
  onJournal: (open) => { log.push(`journal:${open}`); if (open) ui.openJournal(records); else ui.closeJournal(); },
};
ui = createUI({ events, handlers, config: { quality: 'high' } });
ui.showTitle({ records });

let live = false;
let t = 0;
function frame() {
  t += 1 / 60;
  if (live && hud.state === STATES.FIGHTING) {
    const base = hud._base || 0.3;
    hud.tension01 = Math.max(0, base + Math.sin(t * 5.3) * 0.03 + Math.sin(t * 13.1) * 0.015);
    hud.tensionN = hud.tension01 * TACKLE.lineBreakN;
  }
  ui.update(hud);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Count DOM mutations inside #ui (steady-state frames must not write).
let mutations = 0;
new MutationObserver((list) => { mutations += list.length; }).observe(document.getElementById('ui'), { subtree: true, childList: true, attributes: true, characterData: true });

function fight(tension01, dragD, extra = {}) {
  ui.hideCatch();
  ui.hideTitle();
  Object.assign(hud, {
    state: STATES.FIGHTING, tension01, tensionN: tension01 * TACKLE.lineBreakN, _base: tension01,
    drag01: dragD, dragN: dragNFor(dragD), fishOn: true, lineOutM: 16.8, fishDistanceM: 14.2, lureId: 'crankbait', prompt: undefined,
  }, extra);
}

const STATES_SCRIPT = {
  title: () => { hud.state = STATES.TITLE; ui.showTitle({ records }); },
  'title-empty': () => { hud.state = STATES.TITLE; records = []; hud.catches = 0; ui.showTitle({ records }); },
  ready: () => { ui.hideTitle(); Object.assign(hud, { state: STATES.READY, tension01: 0, tensionN: 0, lineOutM: 0, fishOn: false, lureId: 'bobber', hours: 6.1 }); },
  charging: () => { ui.hideTitle(); Object.assign(hud, { state: STATES.CHARGING, castPower01: 0.6, lureId: 'bobber' }); },
  waiting: () => { ui.hideTitle(); Object.assign(hud, { state: STATES.WAITING, castPower01: 0, lineOutM: 17.5, lureId: 'bobber', hours: 6.4, tension01: 0.02, tensionN: 1.1 }); },
  strike: () => { ui.hideTitle(); Object.assign(hud, { state: STATES.STRIKE, lureId: 'bobber' }); ui.strikeCue(); },
  fight30: () => fight(0.3, 0.45),
  fight75: () => fight(0.75, 0.9),
  fight95: () => fight(0.95, 0.9),
  catch: () => {
    Object.assign(hud, { state: STATES.CAUGHT, fishOn: false, tension01: 0, tensionN: 0 });
    ui.showCatch(CATCH, { isPersonalBest: true, isNewSpecies: false });
  },
  'catch-new': () => {
    Object.assign(hud, { state: STATES.CAUGHT, fishOn: false, tension01: 0, tensionN: 0 });
    ui.showCatch({ ...CATCH, speciesId: 'muskellunge', speciesName: 'Muskellunge', latin: 'Esox masquinongy', weightKg: 7.9, lengthCm: 104.1, lureId: 'topwater', hours: 19.8 }, { isPersonalBest: true, isNewSpecies: true });
  },
  // Longest field-guide note in src/fish/species.js is ~224 characters.
  'catch-long': () => {
    Object.assign(hud, { state: STATES.CAUGHT, fishOn: false, tension01: 0, tensionN: 0 });
    ui.showCatch({
      ...CATCH, speciesId: 'walleye', speciesName: 'Walleye', latin: 'Sander vitreus', weightKg: 3.41, lengthCm: 66.3, lureId: 'crankbait', hours: 20.05,
      blurb: 'Olive-gold with glassy, light-gathering eyes (a reflective tapetum lucidum) and a white tip on the lower tail lobe. Feeds at dawn, dusk and after dark along drop-offs and weed edges; schools of walleye roam.',
    }, { isPersonalBest: true, isNewSpecies: true });
  },
  journal: () => { ui.hideCatch(); hud.state = STATES.WAITING; ui.openJournal(records); },
  pause: () => { ui.closeJournal(); ui.setPaused(true); },
  unpause: () => ui.setPaused(false),
  toasts: () => {
    ui.hideTitle();
    Object.assign(hud, { state: STATES.WAITING, lureId: 'topwater', lineOutM: 24 });
    ui.toast('Tied on a Walking Topwater', 'info');
    ui.toast('Line snapped at 12.3 lb', 'bad');
    ui.toast('New personal best: Smallmouth Bass', 'good');
  },
  metric: () => { hud.units = 'metric'; fight(0.42, 0.45); },
  imperial: () => { hud.units = 'imperial'; },
  night: () => { hud.hours = 22.6; },
  live: () => { live = true; },
};

window.__sandbox = {
  ui, hud, events, log,
  go(name) {
    const f = STATES_SCRIPT[name];
    if (!f) throw new Error(`unknown sandbox state ${name}`);
    f();
    return name;
  },
  // Mutations over the next n frames with hud unchanged (should be 0).
  steadyMutations(n = 30) {
    return new Promise((resolve) => {
      let k = 0;
      requestAnimationFrame(() => {
        const start = mutations;
        const step = () => (++k >= n ? resolve(mutations - start) : requestAnimationFrame(step));
        requestAnimationFrame(step);
      });
    });
  },
  get paused() { return paused; },
};
