// Sandbox for src/fish/mesh.js: species lineup, hero close-ups at showcase distance, swimming, exhaustion.
//   node build.mjs --entry src/sandbox/fishmesh.js --out dist/sandbox-fishmesh.html --template none
//   window.__fish.view('lineup' | 'lineup-low' | 'hero:<speciesId>' | 'swim' | 'spent')  (or #hash in the URL)
import * as THREE from 'three';
import { createFishMesh } from '../fish/mesh.js';
import { SPECIES_IDS } from '../config.js';

const NAMES = {
  bluegill: 'Bluegill',
  yellow_perch: 'Yellow Perch',
  rainbow_trout: 'Rainbow Trout',
  smallmouth_bass: 'Smallmouth Bass',
  largemouth_bass: 'Largemouth Bass',
  walleye: 'Walleye',
  channel_catfish: 'Channel Catfish',
  northern_pike: 'Northern Pike',
  muskellunge: 'Muskellunge',
};
const LENGTH_CM = {
  bluegill: 20,
  yellow_perch: 26,
  rainbow_trout: 45,
  smallmouth_bass: 42,
  largemouth_bass: 48,
  walleye: 55,
  channel_catfish: 62,
  northern_pike: 82,
  muskellunge: 110,
};
const species = (id) => ({ id, name: NAMES[id] || id });

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 200);
scene.add(camera);

// Simple sky-over-lake gradient environment (PMREM) so the wet materials have something to reflect.
function makeEnv() {
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const pos = geo.attributes.position;
  const cols = new Float32Array(pos.count * 3);
  const zen = new THREE.Color(0.32, 0.46, 0.7);
  const hor = new THREE.Color(0.86, 0.85, 0.8);
  const lake = new THREE.Color(0.14, 0.18, 0.16);
  const deep = new THREE.Color(0.05, 0.07, 0.06);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y >= 0) c.copy(hor).lerp(zen, Math.pow(y, 0.6));
    else c.copy(lake).lerp(deep, Math.pow(-y, 0.7));
    cols.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  envScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 8, 6.5) }));
  sun.position.set(-4, 5, 5).normalize().multiplyScalar(9);
  envScene.add(sun);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(envScene, 0.02).texture;
  pm.dispose();
  return tex;
}
scene.environment = makeEnv();

function gradientBackground(top, bottom) {
  const cv = document.createElement('canvas');
  cv.width = 4;
  cv.height = 256;
  const g = cv.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, top);
  gr.addColorStop(1, bottom);
  g.fillStyle = gr;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const bgStudio = gradientBackground('#9aa7ad', '#3e4a4a');
const bgWater = gradientBackground('#4f7870', '#15282a');

const key = new THREE.DirectionalLight(0xffe2c2, 2.6);
key.position.set(-3, 4, 3);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = key.shadow.camera.bottom = -2;
key.shadow.camera.right = key.shadow.camera.top = 2;
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 20;
scene.add(key);
const hemi = new THREE.HemisphereLight(0xcfe0ee, 0x3e4a36, 0.7);
scene.add(hemi);

const labels = document.createElement('div');
labels.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:12px system-ui;color:#eef;text-shadow:0 1px 2px #000';
document.body.appendChild(labels);

let fish = []; // { h, drive(t, dt) }
let extras = [];
let t0 = performance.now();
const state = { view: '', ready: false };

function clearView() {
  for (const f of fish) f.h.dispose();
  fish = [];
  for (const o of extras) {
    scene.remove(o);
    o.traverse?.((m) => {
      m.geometry?.dispose();
      m.material?.dispose?.();
    });
  }
  extras = [];
  labels.innerHTML = '';
  scene.fog = null;
}

function label(text, x, y) {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.cssText = `position:absolute;left:${x}px;top:${y}px`;
  labels.appendChild(d);
}

function view(name) {
  clearView();
  camera.up.set(0, 1, 0);
  state.view = name;
  state.ready = false;
  t0 = performance.now();
  if (name === 'lineup' || name === 'lineup-low') {
    const detail = name === 'lineup' ? 'high' : 'low';
    scene.background = bgStudio;
    const display = 0.95;
    SPECIES_IDS.forEach((id, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const L = LENGTH_CM[id] / 100;
      const h = createFishMesh(species(id), LENGTH_CM[id], { detail, quality: 'medium', seed: 11 + i });
      const o = h.object3d;
      o.scale.setScalar(display / L);
      o.rotation.y = Math.PI / 2;
      const cx = (col - 1) * 1.12;
      const cy = (1 - row) * 0.56;
      o.position.set(cx + display * 0.5, cy, 0);
      scene.add(o);
      fish.push({ h, drive: (t, dt) => h.update(dt, 0, 0, 0) });
    });
    camera.fov = 40;
    camera.position.set(0, 0, 4.2);
    camera.lookAt(0, 0, 0);
    key.position.set(-2, 4, 5);
    const W = innerWidth;
    const H = innerHeight;
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    SPECIES_IDS.forEach((id, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const v = new THREE.Vector3((col - 1) * 1.12 - 0.45, (1 - row) * 0.56 + 0.2, 0).project(camera);
      label(`${NAMES[id]} (${LENGTH_CM[id]} cm)`, ((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H);
    });
  } else if (name.startsWith('hero:')) {
    const id = name.slice(5);
    scene.background = bgStudio;
    const L = LENGTH_CM[id] / 100;
    const h = createFishMesh(species(id), LENGTH_CM[id], { detail: 'high', quality: 'high', seed: 5, castShadow: true });
    const o = h.object3d;
    // held in front of the camera, broadside, slightly turned toward the viewer
    o.rotation.set(0.05, Math.PI / 2 - 0.35, 0.04);
    o.position.set(L * 0.45, 0, 0);
    scene.add(o);
    fish.push({ h, drive: (t, dt) => h.update(dt, 0, 0, 0.15) });
    const dist = L * 0.82;
    camera.fov = 45;
    camera.position.set(0.05 * L, 0.18 * L, dist);
    camera.lookAt(0, 0, 0);
    key.position.set(-2, 3, 4);
  } else if (name.startsWith('face:')) {
    const id = name.slice(5);
    scene.background = bgStudio;
    const L = LENGTH_CM[id] / 100;
    const h = createFishMesh(species(id), LENGTH_CM[id], { detail: 'high', quality: 'high', seed: 5 });
    const o = h.object3d;
    o.rotation.set(0, Math.PI / 2 - 0.55, 0);
    scene.add(o);
    fish.push({ h, drive: (t, dt) => h.update(dt, 0, 0, 0) });
    camera.fov = 40;
    camera.position.set(0.12 * L, 0.06 * L, 0.42 * L);
    camera.lookAt(0.02 * L, 0, 0);
    key.position.set(-2, 3, 4);
  } else if (name === 'swim') {
    scene.background = bgWater;
    scene.fog = new THREE.FogExp2(0x2a4a46, 0.22);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6d6448, roughness: 1 }));
    floor.position.y = -1.2;
    scene.add(floor);
    extras.push(floor);
    const ids = ['bluegill', 'yellow_perch', 'rainbow_trout', 'smallmouth_bass', 'walleye', 'channel_catfish', 'northern_pike'];
    ids.forEach((id, i) => {
      const h = createFishMesh(species(id), LENGTH_CM[id], { detail: 'low', quality: 'high', seed: 100 + i });
      const o = h.object3d;
      scene.add(o);
      const r = 1.4 + i * 0.35;
      const w = (0.35 + (i % 3) * 0.12) * (i % 2 ? 1 : -1);
      const y = -0.9 + (i % 4) * 0.18;
      const ph = i * 1.3;
      fish.push({
        h,
        drive: (t, dt) => {
          const a = ph + t * w;
          o.position.set(Math.cos(a) * r, y, -3.2 + Math.sin(a) * r);
          // velocity direction = derivative of the circle
          const vx = -Math.sin(a) * w;
          const vz = Math.cos(a) * w;
          o.rotation.y = Math.atan2(vx, vz);
          h.update(dt, Math.abs(w) * r, -w, 0);
        },
      });
    });
    const hero = createFishMesh(species('largemouth_bass'), 48, { detail: 'high', quality: 'medium', seed: 3 });
    scene.add(hero.object3d);
    fish.push({
      h: hero,
      drive: (t, dt) => {
        const o = hero.object3d;
        const x = -0.9 + ((t * 0.28) % 2.2);
        o.position.set(x, -0.35 + Math.sin(t * 0.7) * 0.03, -1.35);
        o.rotation.set(0, Math.PI / 2 + Math.sin(t * 0.9) * 0.12, 0);
        hero.update(dt, 0.45, Math.cos(t * 0.9) * 0.11, 0);
      },
    });
    camera.fov = 55;
    camera.position.set(0, 0.1, 0);
    camera.lookAt(0, -0.45, -2.2);
    key.position.set(-1, 6, 2);
  } else if (name.startsWith('showcase:')) {
    // what the catch showcase looks like in game: fov 60, fish ~0.65 m from the eye, lake-ish backdrop
    const id = name.slice(9);
    scene.background = gradientBackground('#b9c3c2', '#56645c');
    const h = createFishMesh(species(id), LENGTH_CM[id], { detail: 'high', quality: 'high', seed: 7 });
    const o = h.object3d;
    const L = LENGTH_CM[id] / 100;
    o.rotation.set(0.12, Math.PI / 2 - 0.25, 0.1);
    o.position.set(L * 0.42, -0.08, -0.65);
    scene.add(o);
    fish.push({ h, drive: (t, dt) => h.update(dt, 0, 0, 0.35) });
    camera.fov = 60;
    camera.position.set(0, 0, 0);
    camera.lookAt(0, -0.05, -1);
    key.position.set(-2, 4, 3);
  } else if (name.startsWith('tex:')) {
    // show the generated textures of one species (body colour, relief normal, rough/metal, fins, eye)
    const id = name.slice(4);
    scene.background = bgStudio;
    const h = createFishMesh(species(id), LENGTH_CM[id], { detail: 'high', quality: 'medium', seed: 1 });
    fish.push({ h, drive: () => {} });
    const [body, eyes, fins] = h.object3d.children[0].children;
    const imgs = [body.material.map, body.material.normalMap, body.material.roughnessMap, fins.material.map, eyes.material.map];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;background:#556';
    for (const tex of imgs) {
      const im = document.createElement('img');
      im.src = tex.image.toDataURL();
      im.style.cssText = 'width:100%;height:auto;background:repeating-conic-gradient(#999 0 25%,#666 0 50%) 0 0/16px 16px';
      wrap.appendChild(im);
    }
    labels.appendChild(wrap);
    camera.position.set(0, 0, 5);
  } else if (name === 'wave') {
    // top-down: idle, cruising (1 BL/s), burst (3 BL/s), turning. Fish swim in place (treadmill).
    scene.background = bgWater;
    const cfgs = [
      ['largemouth_bass', 0, 0],
      ['largemouth_bass', 0.45, 0],
      ['largemouth_bass', 1.4, 0],
      ['largemouth_bass', 0.45, 2.0],
      ['northern_pike', 0.8, 0],
    ];
    cfgs.forEach(([id, v, turn], i) => {
      const h = createFishMesh(species(id), id === 'northern_pike' ? 70 : 45, { detail: 'medium', quality: 'high', seed: 20 + i });
      const o = h.object3d;
      o.rotation.y = Math.PI / 2;
      o.position.set(0.45, 0, -0.9 + i * 0.45);
      scene.add(o);
      fish.push({ h, drive: (t, dt) => h.update(dt, v, turn, 0) });
    });
    camera.fov = 45;
    camera.position.set(0.05, 3.0, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0.05, 0, 0);
  } else if (name === 'spent') {
    scene.background = bgStudio;
    const a = createFishMesh(species('largemouth_bass'), 45, { detail: 'high', quality: 'medium', seed: 1, castShadow: true });
    const b = createFishMesh(species('northern_pike'), 70, { detail: 'medium', quality: 'medium', seed: 2, castShadow: true });
    a.object3d.position.set(0.25, 0.1, 0);
    a.object3d.rotation.y = Math.PI / 2;
    b.object3d.position.set(0.4, -0.25, 0);
    b.object3d.rotation.y = Math.PI / 2;
    scene.add(a.object3d, b.object3d);
    fish.push({ h: a, drive: (t, dt) => a.update(dt, 0, 0, 1) }, { h: b, drive: (t, dt) => b.update(dt, 0, 0, 0.6) });
    camera.fov = 45;
    camera.position.set(0, 0.35, 1.25);
    camera.lookAt(0, -0.05, 0);
  }
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  // settle the animation state (exhaustion roll etc.) before the first screenshot
  for (let i = 0; i < 90; i++) for (const f of fish) f.drive(i / 30, 1 / 30);
  state.ready = true;
  return fish.length;
}
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

let last = performance.now();
let frames = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = (now - t0) / 1000;
  for (const f of fish) f.drive(t, dt);
  renderer.render(scene, camera);
  frames++;
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// Robustness / leak check: every species x detail x quality, odd inputs, NaN scan, dispose back to baseline.
function stress() {
  clearView();
  renderer.render(scene, camera);
  const base = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  const report = { built: 0, nanAttrs: 0, errors: [], maxTris: {}, drawCalls: {} };
  const ids = [...SPECIES_IDS, 'unknown_species', 'brook_trout'];
  const lengths = [30, NaN, -5, 0, 1e6, '25'];
  let li = 0;
  const made = [];
  for (const detail of ['low', 'medium', 'high']) {
    for (const quality of ['high', 'medium', 'low']) {
      for (const id of ids) {
        try {
          const len = detail === 'high' && quality === 'high' ? 40 : lengths[li++ % lengths.length];
          const h = createFishMesh(id === 'unknown_species' ? { id } : species(id), len, { detail, quality, seed: li, castShadow: li % 2 === 0 });
          h.object3d.traverse((o) => {
            if (!o.isMesh) return;
            for (const a of Object.values(o.geometry.attributes)) {
              for (let i = 0; i < a.array.length; i++) if (!Number.isFinite(a.array[i])) { report.nanAttrs++; break; }
            }
            const k = detail;
            report.maxTris[k] = Math.max(report.maxTris[k] || 0, o.geometry.index.count / 3);
          });
          h.update(0.016, NaN, Infinity, -3);
          h.update(1e9, 1e9, -1e9, 7);
          h.update(0.016, 1.2, 0.5, 0.5);
          scene.add(h.object3d);
          made.push(h);
          report.built++;
        } catch (e) {
          report.errors.push(`${detail}/${quality}/${id}: ${e.message}`);
        }
      }
    }
  }
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.render(scene, camera);
  report.callsAll = renderer.info.render.calls;
  renderer.info.autoReset = true;
  // single fish draw calls per detail
  for (const d of ['low', 'high']) {
    const h = createFishMesh(species('largemouth_bass'), 40, { detail: d });
    scene.add(h.object3d);
    for (const m of made) m.object3d.visible = false;
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.render(scene, camera);
    report.drawCalls[d] = renderer.info.render.calls;
    renderer.info.autoReset = true;
    for (const m of made) m.object3d.visible = true;
    h.dispose();
  }
  report.afterBuild = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  for (const h of made) h.dispose();
  for (const h of made) h.dispose(); // double dispose must be harmless
  renderer.render(scene, camera);
  report.afterDispose = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
  report.base = base;
  report.childrenLeft = scene.children.filter((o) => o.name.startsWith('fish:')).length;
  return report;
}

window.__fish = {
  stress,
  view,
  state,
  stats: () => ({ frames, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries }),
};
window.__game = { debug: { stats: () => window.__fish.stats() } };
view(decodeURIComponent(location.hash.slice(1)) || 'lineup');
