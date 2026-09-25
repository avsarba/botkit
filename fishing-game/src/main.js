// Loon Lake Angler: boot. Paints the title right away (it is static in the template), then builds the
// lake in stages across animation frames (environment, scenery, water, fish, tackle, audio) while the
// Start button shows progress, fades the live lake in behind the title and starts the frame loop.
import * as THREE from 'three';
import { createEmitter } from './config.js';
import { createEnvironment } from './environment/index.js';
import { createScenery } from './scenery/index.js';
import { createWater } from './water/index.js';
import { SPECIES, createFishSystem, createFishMesh } from './fish/index.js';
import { createTackle } from './tackle/index.js';
import { createAudio } from './audio/index.js';
import { createUI } from './ui/index.js';
import { createGame } from './game/game.js';
import { loadSave } from './game/records.js';

// Yield so the browser can paint between the heavy build stages (rAF stalls in hidden tabs).
function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 150);
  });
}

function pickInitialQuality(save) {
  const q = save && save.settings && save.settings.quality;
  if (q === 'high' || q === 'medium' || q === 'low') return q;
  let coarse = false;
  try {
    coarse = window.matchMedia('(pointer: coarse)').matches;
  } catch {
    /* ignore */
  }
  const small = Math.min(window.screen?.width || 1920, window.screen?.height || 1080) < 820;
  return coarse && small ? 'medium' : 'high';
}

function fatal(message) {
  const btn = document.getElementById('btn-start');
  if (btn) {
    btn.disabled = true;
    btn.removeAttribute('aria-busy');
    btn.textContent = message;
  }
}

let booted = false;
async function boot(data = {}) {
  if (booted) return;
  booted = true;
  const stage = document.getElementById('stage') || document.body;

  // ---- renderer / scene / camera
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[core] WebGL unavailable', err);
    fatal('WebGL is not available in this browser');
    return;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false; // water renders extra passes; core resets once per frame
  const canvas = renderer.domElement;
  canvas.style.opacity = '0';
  canvas.style.transition = 'opacity 1.6s ease';
  canvas.setAttribute('aria-label', 'Loon Lake, seen from the end of the dock');
  stage.appendChild(canvas);

  const scene = new THREE.Scene();
  const w0 = Math.max(1, stage.clientWidth || window.innerWidth);
  const h0 = Math.max(1, stage.clientHeight || window.innerHeight);
  const camera = new THREE.PerspectiveCamera(60, w0 / h0, 0.1, 2500);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  const events = createEmitter();

  // ---- game core + UI first, so the title is interactive-looking and shows progress
  const save = loadSave();
  const quality = pickInitialQuality(save);
  const game = createGame({ renderer, scene, camera, events, save, hotData: data || {}, quality });
  const ui = createUI({
    events,
    handlers: game.handlers,
    config: { units: game.units, muted: game.muted, quality: game.quality, records: game.records, loading: true },
    species: SPECIES,
  });
  game.setUI(ui);
  ui.showTitle({ records: game.records });
  window.__game = game.api;
  game.resize();

  const ctx = { renderer, scene, camera, events, quality: game.quality };
  const mods = { createFishMesh };
  const stages = [
    ['Shaping the lake', () => (mods.env = createEnvironment(ctx))],
    ['Growing the forest', () => (mods.scenery = createScenery({ ...ctx, env: mods.env }))],
    [
      'Filling the lake',
      () => {
        mods.water = createWater({ ...ctx, env: mods.env });
        if (mods.scenery && typeof mods.scenery.attachWater === 'function') mods.scenery.attachWater(mods.water);
        // first look at the lake behind the title while the rest is built
        const f = game.frame;
        f.dt = 0;
        mods.env.setTimeOfDay(f.hours);
        mods.env.update(f);
        mods.scenery.update(f);
        mods.water.update(f);
        renderer.info.reset();
        renderer.render(scene, camera);
        canvas.style.opacity = '1';
      },
    ],
    ['Stocking the fish', () => (mods.fish = createFishSystem({ ...ctx, env: mods.env, water: mods.water, hours: game.hours }))],
    ['Rigging the rod', () => (mods.tackle = createTackle({ ...ctx, env: mods.env, water: mods.water }))],
    ['Tuning in the loons', () => (mods.audio = createAudio({ ...ctx, env: mods.env }))],
  ];

  ui.setLoading(0.02);
  await nextFrame();
  for (let i = 0; i < stages.length; i++) {
    const [label, build] = stages[i];
    ui.setLoading(Math.max(0.02, i / (stages.length + 1)), label);
    await nextFrame();
    const t0 = performance.now();
    try {
      build();
    } catch (err) {
      console.error(`[core] ${label} failed`, err);
      fatal('Something went wrong while preparing the lake');
      return;
    }
    game.buildTimes = game.buildTimes || {};
    game.buildTimes[label] = Math.round(performance.now() - t0);
  }

  game.attach(mods);
  ui.setLoading(stages.length / (stages.length + 1), 'Warming up');
  await nextFrame();
  // compile the remaining shader programs without blocking where the driver allows it
  try {
    if (typeof renderer.compileAsync === 'function') {
      await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 6000))]);
    }
  } catch (err) {
    console.warn('[core] shader warm-up skipped', err);
  }
  canvas.style.opacity = '1';
  game.goLive();
  window.__game.buildTimes = game.buildTimes;
  ui.setLoading(1);
}

function start(data) {
  boot(data || {}).catch((err) => {
    console.error('[core] boot failed', err);
    fatal('Something went wrong while preparing the lake');
  });
}

const hot = typeof window !== 'undefined' && window.claude ? window.claude.hot : null;
if (hot && typeof hot.ready === 'function') hot.ready(start);
else start((hot && hot.data) || {});
