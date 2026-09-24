// Environment sandbox: terrain + sky from the player's eye at the dock end.
//   node build.mjs --entry src/sandbox/environment.js --out dist/sandbox-environment.html --template none
// Interactive: keys 1-8 pick a view, drag to look. Automated: window.__sb.show(name) -> Promise.
import * as THREE from 'three';
import { makeSandbox } from './stubs.js';
import { createEnvironment } from '../environment/index.js';
import { DOCK, LAYERS, makeRng, STATES } from '../config.js';

const { renderer, scene, camera, frame, ctx } = makeSandbox({
  quality: new URLSearchParams(location.search).get('q') || globalThis.__ENV_Q || 'high',
});

const env = createEnvironment(ctx);
console.log('[env] init', JSON.stringify(env.stats));

// --- stand-in water: translucent, depth-tinted using env.depthMap (Water owns the real one) ---
const b = env.depthMap.bounds;
const waterMat = new THREE.MeshStandardMaterial({ color: 0x0b1714, roughness: 0.06, metalness: 0, transparent: true, depthWrite: false });
waterMat.onBeforeCompile = (sh) => {
  sh.uniforms.tDepth = { value: env.depthMap.texture };
  sh.uniforms.uB = { value: new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ)) };
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D tDepth; uniform vec4 uB; varying vec3 vW;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       vec2 duv = (vW.xz - uB.xy) * uB.zw;
       float inb = step(0.0, duv.x) * step(duv.x, 1.0) * step(0.0, duv.y) * step(duv.y, 1.0);
       float dep = mix(12.0, texture2D(tDepth, clamp(duv, 0.0, 1.0)).r * 12.0, inb);
       vec3 vdir = normalize(vW - cameraPosition);
       float path = dep / max(0.15, -vdir.y);
       diffuseColor.a = 1.0 - exp(-path * 0.3);
       diffuseColor.rgb = mix(vec3(0.045, 0.05, 0.03), vec3(0.012, 0.03, 0.03), smoothstep(0.0, 4.0, dep));`
    );
};
const water = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2), waterMat);
water.renderOrder = 10;
scene.add(water);

// --- stand-in dock (Scenery owns the real one) ---
const wood = new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.85 });
const deck = new THREE.Mesh(new THREE.BoxGeometry(DOCK.width, 0.06, DOCK.shoreZ - DOCK.endZ), wood);
deck.position.set(0, DOCK.deckY - 0.03, (DOCK.shoreZ + DOCK.endZ) / 2);
deck.castShadow = deck.receiveShadow = true;
scene.add(deck);
for (let z = DOCK.endZ + 0.2; z < DOCK.shoreZ; z += 2.4) {
  for (const x of [-0.8, 0.8]) {
    const y0 = env.getTerrainHeight(x, z);
    const len = DOCK.deckY - y0 + 0.2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, len, 10), wood);
    post.position.set(x, y0 - 0.2 + len / 2, z);
    post.castShadow = true;
    post.layers.enable(LAYERS.UNDERWATER);
    scene.add(post);
  }
}

// --- stand-in forest: plain instanced conifers where the terrain says forest ---
{
  const rng = makeRng(7);
  const trunkGeo = new THREE.ConeGeometry(1, 1, 7, 1).translate(0, 0.5, 0);
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x1d2b1a, roughness: 0.95 });
  const N = 2600;
  const inst = new THREE.InstancedMesh(trunkGeo, treeMat, N);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const lc = {};
  let n = 0;
  for (let tries = 0; tries < 40000 && n < N; tries++) {
    const r = 20 + Math.pow(rng(), 0.8) * 700;
    const a = rng() * Math.PI * 2;
    const x = Math.sin(a) * r;
    const z = -Math.cos(a) * r - 120;
    env.getLandCover(x, z, lc);
    if (lc.forest < 0.55 || rng() > lc.forest) continue;
    const hgt = 14 + rng() * 12;
    p.set(x, lc.height - 0.5, z);
    s.set(hgt * 0.17, hgt, hgt * 0.17);
    m.compose(p, q, s);
    inst.setMatrixAt(n++, m);
  }
  inst.count = n;
  inst.castShadow = true;
  scene.add(inst);
}

// --- views ---
const VIEWS = {
  dawn: { h: 6.1667, yaw: 0, pitch: -0.12 },
  noon: { h: 12.5, yaw: 0, pitch: -0.12 },
  dusk: { h: 19.75, yaw: 0, pitch: -0.12 },
  night: { h: 22.5, yaw: 0, pitch: -0.12 },
  cove: { h: 10.5, yaw: 1.05, pitch: -0.2 },
  point: { h: 10.5, yaw: -1.0, pitch: -0.16 },
  down: { h: 12.5, yaw: 0.25, pitch: -0.75 },
  behind: { h: 9.0, yaw: 2.7, pitch: -0.1 },
  shore: { h: 9.0, yaw: 2.35, pitch: -0.42, noWater: true },
  bed: { h: 13.0, yaw: 0.7, pitch: -1.0 },
  mist: { h: 6.4, yaw: 0.35, pitch: -0.06 },
  shoal: { h: 13.5, yaw: -1.12, pitch: -0.38 },
  predawn: { h: 5.75, yaw: 0, pitch: -0.12 },
  sunrise: { h: 6.3, yaw: -2.75, pitch: -0.02 },
  bluehour: { h: 20.67, yaw: 0.3, pitch: -0.05 },
  latenight: { h: 3.5, yaw: 0, pitch: 0.1 },
  // debug: bird's-eye over the dock, no stand-in water, to check the lake-bed shaping
  aerial: { h: 13.0, yaw: 0, pitch: -1.0, pos: [0, 70, 45], noWater: true },
  aerialFar: { h: 11.0, yaw: 0, pitch: -0.42, pos: [0, 160, 120], noWater: true },
};
let t0 = performance.now();
let current = 'dawn';
function applyView(name) {
  const v = VIEWS[name];
  if (!v) return;
  current = name;
  water.visible = !v.noWater;
  const p = v.pos || [0, DOCK.deckY + 1.65, 0];
  camera.position.set(p[0], p[1], p[2]);
  camera.rotation.set(v.pitch, v.yaw, 0, 'YXZ');
  camera.updateMatrixWorld();
  frame.hours = v.h;
  env.setTimeOfDay(v.h);
  env.bakeEnvironment();
}
function step() {
  const now = performance.now();
  frame.dt = Math.min(0.05, (now - t0) / 1000);
  frame.time += frame.dt;
  t0 = now;
  env.setTimeOfDay(frame.hours);
  env.update(frame);
  renderer.render(scene, camera);
}
applyView('dawn');

const auto = !navigator.webdriver;
if (!auto) requestAnimationFrame(step); // automation: one frame so plain --shots runs show the scene
if (auto) {
  renderer.setAnimationLoop(step);
  const names = Object.keys(VIEWS);
  addEventListener('keydown', (e) => {
    const i = Number(e.key) - 1;
    if (i >= 0 && i < names.length) applyView(names[i]);
  });
  let drag = null;
  addEventListener('pointerdown', (e) => (drag = { x: e.clientX, y: e.clientY }));
  addEventListener('pointerup', () => (drag = null));
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    camera.rotation.y += (e.clientX - drag.x) * 0.004;
    camera.rotation.x = Math.max(-1.2, Math.min(0.5, camera.rotation.x + (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });
}

const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
window.__sb = {
  views: Object.keys(VIEWS),
  env,
  // CPU cost of the per-frame environment calls (ms per call, averaged)
  timing(n = 600) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      frame.hours += 1 / 3600; // 1 game minute per real second at 60 fps
      env.setTimeOfDay(frame.hours);
      env.update(frame);
    }
    const t1 = performance.now();
    let acc = 0;
    for (let i = 0; i < 2000; i++) acc += env.getTerrainHeight((i % 97) - 48, -(i % 53));
    const t2 = performance.now();
    return { perFrameMs: (t1 - t0) / n, heightQueryUs: ((t2 - t1) / 2000) * 1000, acc, bakes: env.stats.envBakes };
  },
  async show(name, seconds = 0) {
    applyView(name);
    frame.time += seconds;
    step();
    await raf();
    step();
    await raf();
    return { name, exposure: env.exposure, sunEl: env.sunElevationDeg, night: env.nightFactor, info: renderer.info.render };
  },
};
window.__game = {
  state: STATES.READY,
  debug: {
    stats: () => ({
      view: current,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      env: env.stats,
    }),
  },
};
