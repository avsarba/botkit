// Water sandbox: the real createWater() over a stand-in northern-lake environment
// (physical sky, lake-shaped terrain with a sand/mud bed, forested far shore, dock
// with pilings) plus test objects: a crate half in the water, fish-sized bodies
// 30 cm under the surface, a float with line, a topwater lure leaving a wake.
// Scripting for the harness: window.__sandbox.{setPreset, look, setQuality, emit, waitFrames}.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeSandbox } from './stubs.js';
import { createWater } from '../water/index.js';
import { gradedAxis } from '../water/grid.js';
import { LAYERS, DOCK, clamp, smoothstep, lerp, makeRng } from '../config.js';

const sb = makeSandbox({ quality: 'high' });
const { renderer, scene, camera, events, frame, ctx } = sb;
renderer.info.autoReset = false;

// ---------------------------------------------------------------- terrain
const LAKE_C = { x: 0, z: -175 };
function shoreRadius(th) {
  const irregular = 305 + 38 * Math.sin(3 * th + 1.1) + 22 * Math.sin(5 * th + 2.3) + 12 * Math.sin(11 * th + 0.4);
  const d = Math.atan2(Math.sin(th - Math.PI / 2), Math.cos(th - Math.PI / 2)); // toward the player
  return lerp(irregular, 191, Math.exp(-((d / 0.42) ** 2)));
}
function hash2(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, z) {
  return vnoise(x, z) * 0.5 + vnoise(x * 2.1, z * 2.1) * 0.25 + vnoise(x * 4.3, z * 4.3) * 0.125;
}
function terrainHeight(x, z) {
  const dx = x - LAKE_C.x;
  const dz = z - LAKE_C.z;
  const r = Math.hypot(dx, dz);
  const R = shoreRadius(Math.atan2(dz, dx));
  const s = r / R;
  let h;
  if (s < 1) {
    h = -11 * (1 - Math.pow(s, 2.3));
    // weedy cove to the left: a shallow shelf
    const cove = smoothstep(-52, -40, x) * (1 - smoothstep(-18, -10, x)) * smoothstep(-18, -8, z);
    h = lerp(h, Math.max(h, -0.4 - 1.4 * smoothstep(8, -12, z)), cove);
    h += (fbm(x * 0.12, z * 0.12) - 0.45) * 0.5 * smoothstep(1, 0.6, s);
  } else {
    h = (r - R) * 0.07 + (fbm(x * 0.01, z * 0.01) - 0.3) * 30 * smoothstep(1.05, 1.6, s);
    h += smoothstep(1.3, 2.4, s) * 70 * fbm(x * 0.004 + 3, z * 0.004);
  }
  // gentle beach where the dock reaches shore
  return h;
}
const getDepth = (x, z) => Math.max(0, -terrainHeight(x, z));

function makeBedTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const rng = makeRng(5);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fbm((x / S) * 16, (y / S) * 16);
      const grain = rng() * 0.18;
      let v = 0.72 + (n - 0.45) * 0.55 + grain - 0.09;
      // faint sand ripples
      v += Math.sin((x / S) * Math.PI * 2 * 11 + n * 4) * 0.05;
      v = clamp(v, 0, 1) * 255;
      const i = (y * S + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // pebbles
  for (let i = 0; i < 260; i++) {
    const r = 1 + rng() * 3.5;
    g.fillStyle = `rgba(${90 + rng() * 70},${80 + rng() * 60},${60 + rng() * 50},${0.25 + rng() * 0.35})`;
    g.beginPath();
    g.ellipse(rng() * S, rng() * S, r, r * (0.6 + rng() * 0.4), rng() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildTerrain() {
  const xs = gradedAxis(0.8, -40, 40, 1.09, 1300);
  const zs = gradedAxis(0.8, -44, 24, 1.09, 1300);
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const c = new THREE.Color();
  const sand = new THREE.Color(0.52, 0.45, 0.33);
  const mud = new THREE.Color(0.2, 0.17, 0.12);
  const weed = new THREE.Color(0.12, 0.15, 0.07);
  const grass = new THREE.Color(0.14, 0.17, 0.07);
  const forest = new THREE.Color(0.06, 0.08, 0.04);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = xs[i];
      const z = zs[j];
      const h = terrainHeight(x, z);
      pos[k * 3] = x;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 3.2;
      uv[k * 2 + 1] = z / 3.2;
      const n = fbm(x * 0.08, z * 0.08);
      if (h < -0.05) {
        c.copy(sand).lerp(mud, smoothstep(0.8, 4.5, -h));
        c.lerp(weed, smoothstep(0.55, 0.75, n) * 0.7 * smoothstep(0.5, 1.5, -h));
      } else if (h < 0.7) {
        c.copy(sand).multiplyScalar(0.8 + 0.2 * n);
        c.lerp(grass, smoothstep(0.3, 0.7, h));
      } else {
        c.copy(grass).lerp(forest, smoothstep(2, 10, h));
      }
      c.multiplyScalar(0.85 + 0.3 * n);
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let t = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      idx[t++] = a; idx[t++] = a + nx; idx[t++] = a + 1;
      idx[t++] = a + 1; idx[t++] = a + nx; idx[t++] = a + nx + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, map: makeBedTexture() });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.layers.enable(LAYERS.UNDERWATER);
  mesh.name = 'terrain';
  return mesh;
}

// ---------------------------------------------------------------- forest
function buildForest() {
  const rng = makeRng(21);
  const conifer = new THREE.ConeGeometry(1, 1, 7, 1).translate(0, 0.5, 0);
  const broad = new THREE.IcosahedronGeometry(1, 1).scale(1, 1.25, 1).translate(0, 1.1, 0);
  const mc = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
  const mb = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
  const NC = 1700;
  const NB = 500;
  const cones = new THREE.InstancedMesh(conifer, mc, NC);
  const blobs = new THREE.InstancedMesh(broad, mb, NB);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  let ic = 0;
  let ib = 0;
  let guard = 0;
  while ((ic < NC || ib < NB) && guard++ < 60000) {
    const th = rng() * Math.PI * 2;
    const R = shoreRadius(th);
    const r = R + 6 + Math.pow(rng(), 1.6) * 420;
    const x = LAKE_C.x + Math.cos(th) * r;
    const z = LAKE_C.z + Math.sin(th) * r;
    if (Math.abs(x) < 6 && z > -2) continue; // keep the dock clear
    if (Math.hypot(x, z) < 22) continue;
    const h = terrainHeight(x, z);
    if (h < 0.4) continue;
    const isConifer = rng() < 0.78;
    if (isConifer && ic < NC) {
      const H = 11 + rng() * 15;
      p.set(x, h - 0.3, z);
      s.set(H * (0.16 + rng() * 0.06), H, H * (0.16 + rng() * 0.06));
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rng() * 6.28);
      m4.compose(p, q, s);
      cones.setMatrixAt(ic, m4);
      c.setRGB(0.028 + rng() * 0.02, 0.05 + rng() * 0.025, 0.03 + rng() * 0.015);
      cones.setColorAt(ic++, c);
    } else if (!isConifer && ib < NB) {
      const H = 5 + rng() * 6;
      p.set(x, h - 0.2, z);
      s.set(H * 0.45, H * 0.8, H * 0.45);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rng() * 6.28);
      m4.compose(p, q, s);
      blobs.setMatrixAt(ib, m4);
      c.setRGB(0.06 + rng() * 0.04, 0.09 + rng() * 0.04, 0.035 + rng() * 0.02);
      blobs.setColorAt(ib++, c);
    }
  }
  cones.count = ic;
  blobs.count = ib;
  cones.computeBoundingSphere();
  blobs.computeBoundingSphere();
  const group = new THREE.Group();
  group.add(cones, blobs);
  return group;
}

// ---------------------------------------------------------------- sky / light presets
const sky = new Sky();
sky.scale.setScalar(2000);
scene.add(sky);
scene.background = null;
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
const envSky = new Sky();
envSky.scale.setScalar(1000);
envScene.add(envSky);
let envRT = null;

// Remove the stub's lights/ground/dock; build our own.
const stub = { sunLight: new THREE.DirectionalLight(0xffffff, 2), hemi: new THREE.HemisphereLight(0xbfd4ff, 0x3a3a24, 0.6) };
scene.add(stub.sunLight, stub.hemi, stub.sunLight.target);
stub.sunLight.castShadow = true;
stub.sunLight.shadow.mapSize.set(1024, 1024);
stub.sunLight.shadow.camera.left = -12;
stub.sunLight.shadow.camera.right = 12;
stub.sunLight.shadow.camera.top = 12;
stub.sunLight.shadow.camera.bottom = -12;
stub.sunLight.shadow.camera.far = 120;

const env = {
  update() {},
  setTimeOfDay() {},
  sunDirection: new THREE.Vector3(0, 1, 0),
  sunColor: new THREE.Color(1, 1, 1),
  sunIntensity: 2,
  skyColor: new THREE.Color(0.3, 0.45, 0.7),
  horizonColor: new THREE.Color(0.6, 0.65, 0.7),
  envMap: null,
  windStrength: 0.25,
  windDirection: new THREE.Vector2(0.35, -1).normalize(),
  getTerrainHeight: terrainHeight,
  getDepth,
  isWater: (x, z) => getDepth(x, z) > 0.05,
  getHabitat: (x, z) => ({ depth: getDepth(x, z), weeds: 0, rocks: 0, wood: 0 }),
  depthMap: null,
  sunLight: stub.sunLight,
  hemiLight: stub.hemi,
};

const PRESETS = {
  // low sun ahead-right: the glint path runs straight at the dock
  dawn: { elev: 5.5, az: 16, turbidity: 7, rayleigh: 2.2, mie: 0.006, mieG: 0.86, sun: [1.0, 0.6, 0.34], sunI: 2.1, sky: [0.16, 0.24, 0.42], hor: [0.62, 0.52, 0.5], exposure: 0.62, fog: [110, 1700] },
  morning: { elev: 22, az: 60, turbidity: 4, rayleigh: 1.4, mie: 0.004, mieG: 0.8, sun: [1.0, 0.9, 0.78], sunI: 2.8, sky: [0.22, 0.38, 0.72], hor: [0.62, 0.68, 0.76], exposure: 0.55, fog: [120, 2200] },
  noon: { elev: 55, az: 150, turbidity: 3, rayleigh: 1.2, mie: 0.004, mieG: 0.8, sun: [1.0, 0.96, 0.9], sunI: 3.2, sky: [0.22, 0.4, 0.78], hor: [0.62, 0.7, 0.8], exposure: 0.5, fog: [140, 2400] },
  dusk: { elev: 1.8, az: -32, turbidity: 8, rayleigh: 2.6, mie: 0.007, mieG: 0.88, sun: [1.0, 0.48, 0.24], sunI: 1.6, sky: [0.12, 0.16, 0.32], hor: [0.58, 0.42, 0.38], exposure: 0.7, fog: [100, 1500] },
};
let presetName = 'dawn';
function setPreset(name) {
  const P = PRESETS[name] || PRESETS.dawn;
  presetName = PRESETS[name] ? name : 'dawn';
  const el = THREE.MathUtils.degToRad(P.elev);
  const az = THREE.MathUtils.degToRad(P.az); // 0 = straight out over the lake (-Z), + = right
  env.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  env.sunColor.setRGB(...P.sun);
  env.sunIntensity = P.sunI;
  env.skyColor.setRGB(...P.sky);
  env.horizonColor.setRGB(...P.hor);
  for (const s of [sky, envSky]) {
    const u = s.material.uniforms;
    u.turbidity.value = P.turbidity;
    u.rayleigh.value = P.rayleigh;
    u.mieCoefficient.value = P.mie;
    u.mieDirectionalG.value = P.mieG;
    u.sunPosition.value.copy(env.sunDirection).multiplyScalar(1000);
  }
  renderer.toneMappingExposure = P.exposure;
  scene.fog = new THREE.Fog(env.horizonColor.getHex(THREE.LinearSRGBColorSpace), P.fog[0], P.fog[1]);
  scene.fog.color.copy(env.horizonColor);
  stub.sunLight.color.copy(env.sunColor);
  stub.sunLight.intensity = env.sunIntensity;
  stub.sunLight.position.copy(env.sunDirection).multiplyScalar(60);
  stub.hemi.color.copy(env.skyColor).multiplyScalar(1.6);
  stub.hemi.intensity = 0.9;
  if (envRT) envRT.dispose();
  envRT = pmrem.fromScene(envScene, 0, 0.1, 3000);
  env.envMap = envRT.texture;
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.45;
}

// ---------------------------------------------------------------- scene content
// terrain, forest, dock (the stub environment is not used; only makeSandbox)
const terrain = buildTerrain();
scene.add(terrain);
scene.add(buildForest());

const wood = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.9 });
const wetWood = new THREE.MeshStandardMaterial({ color: 0x2f2a22, roughness: 0.75 });
const deck = new THREE.Mesh(new THREE.BoxGeometry(DOCK.width, 0.06, DOCK.shoreZ - DOCK.endZ), wood);
deck.position.set(0, DOCK.deckY - 0.03, (DOCK.shoreZ + DOCK.endZ) / 2);
deck.castShadow = deck.receiveShadow = true;
scene.add(deck);
for (let z = DOCK.endZ + 0.1; z < DOCK.shoreZ; z += 3) {
  for (const x of [-0.82, 0.82]) {
    const ground = terrainHeight(x, z);
    const h = DOCK.deckY - ground;
    if (h < 0.1) continue;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, h, 10), wetWood);
    post.position.set(x, ground + h / 2, z);
    post.castShadow = true;
    post.layers.enable(LAYERS.UNDERWATER);
    scene.add(post);
  }
}

// crate half in the water
const crate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x9a2a1c, roughness: 0.6 }));
crate.position.set(-2.3, 0.0, -5.2);
crate.rotation.set(0.12, 0.6, 0.05);
crate.layers.enable(LAYERS.UNDERWATER);
scene.add(crate);

// fish-sized bodies 0.3 m down: one over ~2.5 m, one over ~4.5 m of water
function fishBody(color) {
  const g = new THREE.CapsuleGeometry(0.045, 0.26, 6, 12).rotateX(Math.PI / 2).scale(0.85, 1.15, 1);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 }));
  m.layers.enable(LAYERS.UNDERWATER);
  scene.add(m);
  return m;
}
const fishA = fishBody(0x6d6a3a);
fishA.position.set(1.5, -0.3, -6.5);
fishA.rotation.y = 0.7;
const fishB = fishBody(0x5b6440);
fishB.position.set(-0.9, -0.3, -21);
fishB.rotation.y = -0.4;
const fishDeep = fishBody(0x6d6a3a);
fishDeep.position.set(0.3, -1.6, -9);

// float + line
const floatG = new THREE.Group();
const top = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xc8231c, roughness: 0.35 }));
const bot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.35 }));
floatG.add(top, bot);
for (const m of [top, bot]) m.layers.enable(LAYERS.UNDERWATER);
scene.add(floatG);
const floatPos = new THREE.Vector3(-0.7, 0, -4.6);
const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.45, 2.35, -1.7), new THREE.Vector3(-0.7, 0.02, -4.6)]);
const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xd8f070 }));
scene.add(line);

// topwater lure crossing in front of the dock (wake test)
const lure = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.08, 4, 8).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd9d2b0, roughness: 0.4 }));
lure.layers.enable(LAYERS.UNDERWATER);
scene.add(lure);
const lureVel = new THREE.Vector3();

// ---------------------------------------------------------------- water
const water = createWater({ ...ctx, env });
setPreset(presetName);

// ---------------------------------------------------------------- loop
let yawDeg = 0;
let pitchDeg = -8;
function look(y, p) {
  yawDeg = y;
  pitchDeg = p;
  camera.rotation.set(THREE.MathUtils.degToRad(p), THREE.MathUtils.degToRad(-y), 0, 'YXZ');
}
look(yawDeg, pitchDeg);

frame.lure = { id: 'bobber', position: floatPos, bobberPosition: floatPos, velocity: lureVel, inWater: true };
let frames = 0;
let timeScale = 1;
let autoEvents = true;
let evClock = 0;
let fps = 0;
let fpsAcc = 0;
let fpsN = 0;
const waiters = [];
const clock = new THREE.Clock();
const tmpN = new THREE.Vector3();
const evPos = new THREE.Vector3();
let lureX = -4;
let lureDir = 1;
let twitchT = 0;

renderer.setAnimationLoop(() => {
  const rdt = clock.getDelta();
  fpsAcc += rdt;
  fpsN++;
  if (fpsAcc > 1) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  const dt = Math.min(0.05, rdt) * timeScale;
  frame.dt = dt;
  frame.time += dt;
  frames++;

  // float rides the waves
  floatPos.y = water.getHeight(floatPos.x, floatPos.z) - 0.004;
  floatG.position.copy(floatPos);
  water.getNormal(floatPos.x, floatPos.z, tmpN);
  floatG.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, tmpN);
  lineGeo.attributes.position.setXYZ(1, floatPos.x, floatPos.y + 0.03, floatPos.z);
  lineGeo.attributes.position.needsUpdate = true;

  // topwater lure walks across and leaves a wake
  lureX += lureDir * 0.75 * dt;
  if (lureX > 4.5) lureDir = -1;
  if (lureX < -4.5) lureDir = 1;
  lure.position.set(lureX, water.getHeight(lureX, -8.5) + 0.004, -8.5);
  lure.rotation.y = lureDir > 0 ? 0 : Math.PI;
  lureVel.set(lureDir * 0.75, 0, 0);
  water.wake(lure.position.x, lure.position.z, lureDir, 0, 0.75);
  twitchT += dt;
  if (autoEvents && twitchT > 1.3) {
    twitchT = 0;
    events.emit('lure:twitch', { position: lure.position });
  }

  if (autoEvents) {
    const prev = evClock;
    evClock = (evClock + dt) % 7;
    const at = (t) => prev < t && evClock >= t;
    if (at(0.3)) events.emit('lure:landed', { position: evPos.set(-1.4, 0, -7.2), lureId: 'crankbait', onWater: true, speed: 9 });
    if (at(1.4)) events.emit('fish:jump', { position: evPos.set(2.8, 0.2, -12), size01: 0.8 });
    if (at(2.8)) events.emit('fish:swirl', { position: evPos.set(-3.4, 0, -10), size01: 0.7 });
    if (at(4.0) || at(4.6)) events.emit('fish:nibble', { fishId: 1, strength01: 0.6 });
  }

  renderer.info.reset();
  water.update(frame);
  renderer.render(scene, camera);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (frames >= waiters[i].at) {
      waiters[i].resolve(frames);
      waiters.splice(i, 1);
    }
  }
});

window.__sandbox = {
  setPreset,
  look,
  setQuality(q) {
    frame.quality = q;
  },
  setAutoEvents(on) {
    autoEvents = !!on;
  },
  setTimeScale(k) {
    timeScale = Math.max(0.1, Math.min(8, k));
  },
  setLure(x, dir) {
    lureX = x;
    lureDir = dir;
  },
  setWind(w) {
    env.windStrength = w;
  },
  emit(type, payload) {
    if (payload && payload.position && !payload.position.isVector3) {
      payload.position = new THREE.Vector3(payload.position.x, payload.position.y || 0, payload.position.z);
    }
    events.emit(type, payload || {});
  },
  waitFrames(n) {
    return new Promise((resolve) => waiters.push({ at: frames + n, resolve }));
  },
  get frames() {
    return frames;
  },
  height: (x, z) => water.getHeight(x, z),
  debugView: (m) => water.debugView(m),
  scene,
  camera,
};
window.__game = {
  debug: {
    stats: () => ({
      fps: Math.round(fps * 10) / 10,
      frames,
      preset: presetName,
      quality: water.quality,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    }),
  },
};
