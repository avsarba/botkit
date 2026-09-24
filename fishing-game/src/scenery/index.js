// Scenery: everything that sits on the terrain around Loon Lake (dock + deck props, boreal forest
// with LODs and canopy cover, shoreline plants, lily pads, boulders, sunken timber, logs, distant
// ridges, loon / birds / dragonflies).
//
//   createScenery(ctx) -> {
//     update(frame),        // wind/sun uniforms, azimuth+elevation chunk culling from frame.camera,
//                           // wildlife, ridge haze; frame.quality === 'low' hides optional detail
//     dockTopAt(x, z),      // DOCK.deckY on the deck, a post's top inside a piling, else null
//     attachWater(water),   // optional: loon rides water.getHeight and makes wakes / dive rings
//     object3d,             // THREE.Group 'scenery' (already added to ctx.scene)
//     debug: { loonPosition(), birdPosition(i), flyPosition(i) },
//     stats,                // counts and build timings
//     dispose(),
//   }
// ctx = { renderer, scene, camera, events, quality, env }. Only the contract env API is used
// (getTerrainHeight / getDepth / getHabitat / windStrength / windDirection / sunDirection /
// sunColor / sunIntensity / horizonColor / envMap).
import * as THREE from 'three';
import { buildDock } from './dock.js';
import { createSharedUniforms } from './shaderlib.js';
import { sampleTerrain } from './terrainGrid.js';
import { buildForest } from './forest.js';
import { buildShore } from './shore.js';
import { buildWildlife } from './wildlife.js';
import { createSectorCuller } from './culling.js';

export function createScenery(ctx) {
  const { scene, env } = ctx;
  const quality = ctx.quality === 'low' || ctx.quality === 'medium' ? ctx.quality : 'high';
  const root = new THREE.Group();
  root.name = 'scenery';
  scene.add(root);
  const shared = createSharedUniforms();
  const culler = createSectorCuller();

  const t0 = performance.now();
  const dock = buildDock({ env, quality, renderer: ctx.renderer });
  const tDock = performance.now() - t0;
  root.add(dock.group);

  const parts = [];
  let water = null;

  const t1 = performance.now();
  const grid = sampleTerrain(env, { half: quality === 'low' ? 560 : 700, cell: quality === 'high' ? 5 : 6 });
  const tGrid = performance.now() - t1;
  const forest = buildForest({ env, quality, renderer: ctx.renderer, shared, grid, culler });
  root.add(forest.group);
  parts.push({ update: (frame) => forest.update(frame, scene) });
  const t2 = performance.now();
  const shore = buildShore({ env, quality, shared, grid, culler });
  root.add(shore.group);
  const tShore = performance.now() - t2;
  const wildlife = buildWildlife({ env, quality, events: ctx.events, grid, reedAnchors: shore.anchors, shared });
  root.add(wildlife.group);
  parts.push({ update: (frame) => wildlife.update(frame, water) });

  function syncShared(frame) {
    shared.uTime.value = frame && Number.isFinite(frame.time) ? frame.time : shared.uTime.value;
    const ws = Number(env.windStrength);
    shared.uWind.value = Number.isFinite(ws) ? Math.max(0, Math.min(1.5, ws)) : 0.25;
    if (env.windDirection && Number.isFinite(env.windDirection.x)) shared.uWindDir.value.copy(env.windDirection);
    if (env.sunDirection && Number.isFinite(env.sunDirection.x)) shared.uSunDir.value.copy(env.sunDirection);
    if (env.sunColor && env.sunColor.isColor) {
      const si = Number.isFinite(env.sunIntensity) ? env.sunIntensity : 1;
      shared.uSunColor.value.copy(env.sunColor).multiplyScalar(si);
    }
  }
  syncShared(null);

  let lastEnvMap = null;
  function syncEnvMap() {
    // metals need an environment to look like metal; follow env.envMap when the scene has none
    const em = scene.environment ? null : env.envMap || null;
    if (em === lastEnvMap) return;
    lastEnvMap = em;
    for (const m of dock.metalMaterials) {
      m.envMap = em;
      m.needsUpdate = true;
    }
  }

  // Runtime quality: the build uses ctx.quality; if the core drops to 'low' later (adaptive
  // quality), hide optional detail. Restores when quality goes back up.
  const optional = [];
  root.traverse((o) => {
    if (/^(shore\.reedCards|shore\.farRocks|wildlife\.dragonflies|shore\.pondlily)/.test(o.name)) optional.push(o);
  });
  let runtimeQ = quality;
  function applyRuntimeQuality(q) {
    if (q === runtimeQ) return;
    runtimeQ = q;
    const hide = q === 'low' && quality !== 'low';
    for (const o of optional) {
      o.userData.sceneryHidden = hide;
      if (hide) o.visible = false;
      else if (!o.name.startsWith('wildlife.')) o.visible = true;
    }
  }

  return {
    update(frame) {
      if (frame && (frame.quality === 'low' || frame.quality === 'medium' || frame.quality === 'high')) applyRuntimeQuality(frame.quality);
      syncShared(frame);
      syncEnvMap();
      culler.update((frame && frame.camera) || ctx.camera);
      for (let i = 0; i < parts.length; i++) parts[i].update(frame);
    },
    dockTopAt: dock.dockTopAt,
    // Optional: core may hand over the water module after creating it (for loon bobbing / ripples).
    attachWater(w) {
      water = w || null;
    },
    object3d: root,
    dispose() {
      wildlife.dispose();
      root.removeFromParent();
      const seen = new Set();
      root.traverse((o) => {
        if (o.geometry && !seen.has(o.geometry)) {
          seen.add(o.geometry);
          o.geometry.dispose();
        }
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          if (seen.has(m)) continue;
          seen.add(m);
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap']) if (m[k] && !seen.has(m[k])) (seen.add(m[k]), m[k].dispose());
          m.dispose();
        }
      });
      forest.impostorTextures.rt.dispose();
    },
    debug: { loonPosition: () => wildlife.loonPosition(), birdPosition: (i) => wildlife.birdPosition(i), flyPosition: (i) => wildlife.flyPosition(i) },
    stats: { forest: forest.stats, shore: shore.stats, ms: { dock: Math.round(tDock), grid: Math.round(tGrid), shore: Math.round(tShore) } },
  };
}
