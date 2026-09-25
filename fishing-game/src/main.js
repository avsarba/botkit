// Loon Lake Angler: boot. Paints the title right away (it is static in the template), then builds the
// lake in stages across animation frames (environment, scenery, water, fish, tackle, audio) while the
// Start button shows progress, fades the live lake in behind the title and starts the frame loop.
import * as THREE from 'three';
import { createEmitter } from './config.js';
import { createEnvironment } from './environment/index.js';
import { createScenery } from './scenery/index.js';
import { createWater } from './water/index.js';
import { SPECIES, createFishSystem, createFishMesh } from './fish/index.js';
import * as FishMesh from './fish/mesh.js';
import { createTackle } from './tackle/index.js';
import { createAudio } from './audio/index.js';
import { createUI } from './ui/index.js';
import { createGame } from './game/game.js';
import { loadSave } from './game/records.js';
import { deviceQuality, loadAutoQuality } from './game/quality.js';
import { setCatchRectSource, setShowcaseStandIn } from './game/showcase.js';

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

const LEVELS = ['high', 'medium', 'low'];
// A level picked in the pause menu wins; otherwise where auto quality settled last time on this machine
// (never above the device's default); otherwise the device default.
function pickInitialQuality(save) {
  const q = save && save.settings && save.settings.quality;
  if (LEVELS.includes(q)) return q;
  const dev = deviceQuality();
  const auto = loadAutoQuality();
  return auto && LEVELS.indexOf(auto) > LEVELS.indexOf(dev) ? auto : dev;
}

// Every texture a material in the scene uses (maps and shader uniforms, hidden objects included).
function sceneTextures(root) {
  const out = new Set();
  const seen = new Set();
  const addTex = (t) => {
    if (t && t.isTexture && !t.isRenderTargetTexture && !t.isDepthTexture && !t.isVideoTexture && t.image) out.add(t);
  };
  const visit = (m) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (v && v.isTexture) addTex(v);
    }
    if (m.uniforms) {
      for (const k of Object.keys(m.uniforms)) {
        const v = m.uniforms[k] && m.uniforms[k].value;
        if (Array.isArray(v)) v.forEach(addTex);
        else addTex(v);
      }
    }
  };
  root.traverse((o) => {
    if (Array.isArray(o.material)) o.material.forEach(visit);
    else visit(o.material);
    visit(o.customDepthMaterial);
    visit(o.customDistanceMaterial);
  });
  return out;
}

// Before Start is enabled: upload every texture and draw one full frame with frustum culling off, so the
// water's depth pre-pass and reflection, the shadow map and the main pass compile every program variant
// they need and upload every texture now, not in the first live frame (a multi-second freeze where
// parallel shader compile is missing) or the first time the view turns toward something new.
async function warmUp(renderer, scene, game, ui, p0) {
  const texs = [...sceneTextures(scene)];
  const batch = 8;
  for (let i = 0; i < texs.length; i += batch) {
    for (const t of texs.slice(i, i + batch)) {
      try {
        renderer.initTexture(t);
      } catch {
        /* a texture that can't upload yet will on first use */
      }
    }
    ui.setLoading(p0 + 0.5 * (1 - p0) * ((i + batch) / Math.max(1, texs.length)), 'Warming up');
    await nextFrame();
  }
  const culled = [];
  scene.traverse((o) => {
    if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.frustumCulled) {
      o.frustumCulled = false;
      culled.push(o);
    }
  });
  try {
    game.frame.dt = 0;
    game.renderFrame(0);
  } catch (err) {
    console.warn('[core] warm-up frame failed', err);
  } finally {
    for (const o of culled) o.frustumCulled = true;
  }
  ui.setLoading(p0 + 0.9 * (1 - p0), 'Warming up');
  await nextFrame();
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
  // automatic quality changes (they rebuild shader variants and may hitch) wait for a calm moment
  if (game.qm) game.qm.canChangeLevel = () => game.api.state === 'ready' || game.api.state === 'title';
  // the catch showcase frames the fish beside / above the catch card
  setCatchRectSource(() => (typeof ui.getCatchRect === 'function' ? ui.getCatchRect() : null));
  if (typeof FishMesh.createFishProgramKeeper === 'function') {
    setShowcaseStandIn(() => FishMesh.createFishProgramKeeper({ quality: game.quality, castShadow: false }));
  }

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
  const pWarm = stages.length / (stages.length + 1);
  ui.setLoading(pWarm, 'Warming up');
  await nextFrame();
  const tWarm = performance.now();
  // compile the remaining shader programs without blocking where the driver allows it
  try {
    if (typeof renderer.compileAsync === 'function') {
      await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 6000))]);
    }
  } catch (err) {
    console.warn('[core] shader warm-up skipped', err);
  }
  // then the render-target variants (reflection, depth pre-pass), shadow casters and texture uploads
  try {
    await warmUp(renderer, scene, game, ui, pWarm);
  } catch (err) {
    console.warn('[core] warm-up frame skipped', err);
  }
  game.buildTimes['Warming up'] = Math.round(performance.now() - tWarm);
  canvas.style.opacity = '1';
  game.goLive();
  window.__game.buildTimes = game.buildTimes;
  // one live frame before Start is offered, so pressing it never waits on leftover work
  await nextFrame();
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
