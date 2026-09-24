// Scenery: everything that sits on the terrain around Loon Lake.
//   createScenery(ctx) -> { update(frame), dockTopAt(x, z), attachWater(water) }
// ctx = { renderer, scene, camera, events, quality, env }
import * as THREE from 'three';
import { buildDock } from './dock.js';
import { createSharedUniforms } from './shaderlib.js';
import { sampleTerrain } from './terrainGrid.js';
import { buildForest } from './forest.js';
import { buildShore } from './shore.js';
import { buildWildlife } from './wildlife.js';

export function createScenery(ctx) {
  const { scene, env } = ctx;
  const quality = ctx.quality === 'low' || ctx.quality === 'medium' ? ctx.quality : 'high';
  const root = new THREE.Group();
  root.name = 'scenery';
  scene.add(root);
  const shared = createSharedUniforms();

  const t0 = performance.now();
  const dock = buildDock({ env, quality, renderer: ctx.renderer });
  const tDock = performance.now() - t0;
  root.add(dock.group);

  const parts = [];
  let water = null;

  const t1 = performance.now();
  const grid = sampleTerrain(env, { half: quality === 'low' ? 560 : 700, cell: quality === 'high' ? 5 : 6 });
  const tGrid = performance.now() - t1;
  const forest = buildForest({ env, quality, renderer: ctx.renderer, shared, grid });
  root.add(forest.group);
  parts.push({ update: (frame) => forest.update(frame, scene) });
  const t2 = performance.now();
  const shore = buildShore({ env, quality, shared, grid });
  root.add(shore.group);
  const tShore = performance.now() - t2;
  const wildlife = buildWildlife({ env, quality, events: ctx.events, grid, reedAnchors: shore.anchors });
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

  return {
    update(frame) {
      syncShared(frame);
      syncEnvMap();
      for (let i = 0; i < parts.length; i++) parts[i].update(frame);
    },
    dockTopAt: dock.dockTopAt,
    // Optional: core may hand over the water module after creating it (for loon bobbing / ripples).
    attachWater(w) {
      water = w || null;
    },
    object3d: root,
    debug: { loonPosition: () => wildlife.loonPosition() },
    stats: { forest: forest.stats, shore: shore.stats, ms: { dock: Math.round(tDock), grid: Math.round(tGrid), shore: Math.round(tShore) } },
  };
}
