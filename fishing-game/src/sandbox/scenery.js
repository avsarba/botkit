// Scenery sandbox: the scenery module on a contract-shaped lake (cove left, rocky point right,
// sunken timber, hills), with a physical sky, sun + shadows and a simple water plane.
//   node build.mjs --entry src/sandbox/scenery.js --out dist/sandbox-scenery.html --template none
// window.__view(name) switches camera views (eye, down, left, right, far, cove, point, back,
// loon, waterline, ...); window.__frames() counts frames since the last switch, window.__tris()
// lists triangles per scenery group. URL hash options (set location.hash then reload):
//   #stub          plain stubEnvironment (bowl lake) instead of the contract-shaped sandbox lake
//   #q=medium|low  build quality          #sun=x,y,z  sun direction     #h=6.5  time-of-day sun
//   #clear         more transparent water (inspect pilings/rocks/timber)   #birdtest  wildlife close-ups
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeSandbox, stubEnvironment, stubWater } from './stubs.js';
import { createScenery } from '../scenery/index.js';
import { makeRng, clamp, smoothstep, DOCK } from '../config.js';
import { makeNoise2, fbm2 } from '../scenery/noise.js';
import { createEnvironment } from '../environment/index.js';
import { createWater } from '../water/index.js';

const quality = (location.hash.match(/q=(\w+)/) || [])[1] || 'high';
const useStub = location.hash.includes('stub');
const useReal = location.hash.includes('real');
const { renderer, scene, camera, events, frame, ctx } = makeSandbox({ quality });
renderer.toneMappingExposure = 0.55;
const hours = Number((location.hash.match(/h=([\d.]+)/) || [])[1] || 8.0);
if (useReal) runReal();
else runSandbox();

// ------------------------------------------------------------------ real environment + water
function runReal() {
  frame.hours = hours;
  const env = createEnvironment(ctx);
  env.setTimeOfDay(hours);
  const t0 = performance.now();
  const scenery = createScenery({ ...ctx, env });
  const buildMs = performance.now() - t0;
  const water = createWater({ ...ctx, env });
  scenery.attachWater(water);
  console.log(`[scenery] built in ${buildMs.toFixed(0)} ms on the real environment (quality ${quality})`);
  console.log('[scenery] stats', JSON.stringify(scenery.stats));
  startLoop(scenery, (f) => {
    env.setTimeOfDay(hours);
    env.update(f);
  }, (f) => water.update(f), buildMs);
}

function runSandbox() {
const base = stubEnvironment({ scene, renderer });
// remove the stub's placeholder ground + dock box; keep its lights for reference only
const stubMeshes = [];
scene.traverse((o) => {
  if (o.isMesh) stubMeshes.push(o);
  if (o.isLight) o.visible = false;
});

// ------------------------------------------------------------------ sandbox terrain
const nz = makeNoise2(4242);
function lakeDist(x, z) {
  // signed distance-ish to the shoreline: + in water, - on land
  const cz = -190;
  const e = Math.sqrt((x / 232) ** 2 + ((z - cz) / 206) ** 2) + fbm2(nz, x * 0.006, z * 0.006, 4) * 0.07 + nz(x * 0.02, z * 0.02) * 0.012;
  let d = (1 - e) * 206;
  // rocky point (land) to the right, tip near x = 36, z = -17
  const px = x - 76;
  const pz = z + 9;
  const ca = Math.cos(0.26);
  const sa = Math.sin(0.26);
  const lx = px * ca - pz * sa;
  const lz = px * sa + pz * ca;
  const pe = Math.sqrt((lx / 41) ** 2 + (lz / 9.5) ** 2);
  const pd = (pe - 1) * 9.5;
  d = Math.min(d, pd * 1.0 + 0.0);
  return { d, pointD: pd };
}
function terrainHeight(x, z) {
  const { d, pointD } = lakeDist(x, z);
  if (d > 0) {
    // lake bed
    let slope = 0.11;
    const nearPoint = 1 - smoothstep(0, 30, pointD);
    slope = slope + nearPoint * 0.16;
    let depth = Math.min(11, d * slope - 0.25);
    // weedy cove: shallow shelf to the left
    const cove = smoothstep(-52, -40, x) * (1 - smoothstep(-18, -10, x)) * smoothstep(-20, -8, z) * (1 - smoothstep(12, 20, z));
    depth = depth * (1 - cove) + Math.min(depth, 0.4 + (d * 0.05) + fbm2(nz, x * 0.05, z * 0.05, 2) * 0.4) * cove;
    // sunken timber hump
    depth -= 0.3 * Math.exp(-((x + 10) ** 2 + (z + 22) ** 2) / 40);
    return -depth + fbm2(nz, x * 0.08, z * 0.08, 2) * 0.12;
  }
  const L = -d;
  let h = L * 0.075 + smoothstep(0, 6, L) * 0.3;
  h += smoothstep(10, 140, L) * (fbm2(nz, x * 0.004 + 3, z * 0.004, 5) * 0.5 + 0.5) * 70;
  h += smoothstep(200, 900, L) * (1 - Math.abs(fbm2(nz, x * 0.0016, z * 0.0016 + 7, 4))) * 150;
  // the point is low granite
  h *= 1 - 0.6 * (1 - smoothstep(0, 25, pointD));
  return h;
}

let env;
if (useStub) {
  env = base;
} else {
  for (const m of stubMeshes) m.removeFromParent();
  const depthAt = (x, z) => Math.max(0, -terrainHeight(x, z));
  env = Object.assign({}, base, {
    getTerrainHeight: terrainHeight,
    getDepth: depthAt,
    isWater: (x, z) => depthAt(x, z) > 0.05,
    getHabitat(x, z) {
      const depth = depthAt(x, z);
      const weeds = smoothstep(-52, -40, x) * (1 - smoothstep(-18, -10, x)) * smoothstep(-20, -8, z) * (1 - smoothstep(12, 20, z));
      const pd = lakeDist(x, z).pointD;
      const rocks = 1 - smoothstep(4, 28, pd);
      const wood = Math.exp(-((x + 10) ** 2 + (z + 22) ** 2) / 60);
      return { depth, weeds: clamp(weeds * (depth < 2.5 ? 1 : 0.3), 0, 1), rocks, wood };
    },
  });
  // ground mesh (polar grid centred on the dock)
  const AZ = 320;
  const radii = [];
  for (let r = 0.4; r < 2200; r *= 1.03) radii.push(r);
  const pos = [];
  const col = [];
  const idx = [];
  const cSand = new THREE.Color(0x8a7a5a);
  const cMud = new THREE.Color(0x4a4232);
  const cGrass = new THREE.Color(0x4f5a2e);
  const cRock = new THREE.Color(0x6b6660);
  const cForest = new THREE.Color(0x26301f);
  const tmp = new THREE.Color();
  pos.push(0, terrainHeight(0, 0), 0);
  col.push(cMud.r, cMud.g, cMud.b);
  for (const r of radii) {
    for (let a = 0; a < AZ; a++) {
      const th = (a / AZ) * Math.PI * 2;
      const x = Math.sin(th) * r;
      const z = -Math.cos(th) * r;
      const h = terrainHeight(x, z);
      pos.push(x, h, z);
      const pd = lakeDist(x, z).pointD;
      if (h < -0.3) tmp.copy(cSand).lerp(cMud, smoothstep(0.3, 3, -h));
      else if (h < 0.6) tmp.copy(cSand);
      else tmp.copy(cGrass).lerp(cForest, smoothstep(2, 12, h));
      if (pd < 12 && h > -2) tmp.lerp(cRock, 0.8);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let a = 0; a < AZ; a++) idx.push(0, 1 + ((a + 1) % AZ), 1 + a);
  for (let ri = 0; ri < radii.length - 1; ri++) {
    for (let a = 0; a < AZ; a++) {
      const i0 = 1 + ri * AZ + a;
      const i1 = 1 + ri * AZ + ((a + 1) % AZ);
      const j0 = i0 + AZ;
      const j1 = i1 + AZ;
      idx.push(i0, i1, j0, i1, j1, j0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  ground.receiveShadow = true;
  ground.layers.enable(3);
  scene.add(ground);
}

// ------------------------------------------------------------------ sky, sun, fog
const sky = new Sky();
sky.scale.setScalar(2000);
scene.add(sky);
const su = sky.material.uniforms;
su.turbidity.value = 3.5;
su.rayleigh.value = 1.2;
su.mieCoefficient.value = 0.004;
su.mieDirectionalG.value = 0.8;
const sunAz = THREE.MathUtils.degToRad(-20 + (hours - 12) * 15); // rough path, sun south-ish
const sunEl = THREE.MathUtils.degToRad(Math.max(-6, 55 * Math.sin(((hours - 6) / 14.2) * Math.PI)));
env.sunDirection.set(Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(sunAz) * Math.cos(sunEl)).normalize();
// put the morning sun to the front-right so the forest is side-lit
if (!location.hash.includes('h=')) env.sunDirection.set(0.55, 0.36, -0.75).normalize();
const sunM = location.hash.match(/sun=([-\d.]+),([-\d.]+),([-\d.]+)/);
if (sunM) env.sunDirection.set(Number(sunM[1]), Number(sunM[2]), Number(sunM[3])).normalize();
su.sunPosition.value.copy(env.sunDirection);
const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
sun.position.copy(env.sunDirection).multiplyScalar(60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -14;
sun.shadow.camera.right = 14;
sun.shadow.camera.top = 14;
sun.shadow.camera.bottom = -14;
sun.shadow.camera.far = 150;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.target.position.set(0, 0, 4);
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbcd3ff, 0x3a3a2a, 0.55);
scene.add(hemi);
env.sunColor.set(0xfff1dc);
env.sunIntensity = 3.0;
env.horizonColor.set(0xb4c4d0);
scene.fog = new THREE.FogExp2(env.horizonColor.getHex(), 0.00085);
const pmrem = new THREE.PMREMGenerator(renderer);
const skyScene = new THREE.Scene();
const sky2 = new Sky();
sky2.scale.setScalar(1000);
Object.assign(sky2.material.uniforms.sunPosition.value, env.sunDirection);
for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) sky2.material.uniforms[k].value = su[k].value;
skyScene.add(sky2);
const envRT = pmrem.fromScene(skyScene, 0.02);
env.envMap = envRT.texture;
scene.environment = envRT.texture;
scene.environmentIntensity = 0.55;
scene.background = null;

// ------------------------------------------------------------------ water (stub, tuned to read better)
const water = stubWater({ scene });
water.mesh.material.color.set(0x0c2530);
water.mesh.material.roughness = 0.06;
water.mesh.material.metalness = 0.0;
water.mesh.material.opacity = 0.8;

// ------------------------------------------------------------------ scenery under test
const t0 = performance.now();
const scenery = createScenery({ ...ctx, env });
scenery.attachWater && scenery.attachWater(water);
if (location.hash.includes('clear')) water.mesh.material.opacity = 0.35;
if (location.hash.includes('birdtest')) {
  // close-up clones of the wildlife meshes in front of the camera (shared geometry/material)
  let k = 0;
  scenery.object3d.traverse((o) => {
    if (!o.isMesh || !/wildlife\.(gull|raven|eagle|loon)/.test(o.name)) return;
    const c = new THREE.Mesh(o.geometry, o.material);
    c.position.set(-1.5 + k * 1.0, 2.4, -3.2);
    c.rotation.set(0.5, 0.6, 0);
    c.scale.setScalar(o.name.includes('loon') ? 1.4 : 0.8);
    scene.add(c);
    k++;
  });
}
const buildMs = performance.now() - t0;
console.log(`[scenery] built in ${buildMs.toFixed(0)} ms (quality ${quality}, ${useStub ? 'stub env' : 'sandbox env'})`);
console.log('[scenery] stats', JSON.stringify(scenery.stats));
console.log('[scenery] dockTopAt(0,0)=', scenery.dockTopAt(0, 0), ' dockTopAt(3,0)=', scenery.dockTopAt(3, 0));

startLoop(scenery, null, null, buildMs);
}

// ------------------------------------------------------------------ views + loop
function startLoop(scenery, preUpdate, postUpdate, buildMs) {
window.__loonPos = () => scenery.debug.loonPosition();
window.__trackPos = { loon: () => scenery.debug.loonPosition(), bird: () => scenery.debug.birdPosition(3), gull: () => scenery.debug.birdPosition(0), raven: () => scenery.debug.birdPosition(2), fly: () => scenery.debug.flyPosition(0) };
const eye = DOCK.deckY + 1.65;
const VIEWS = {
  eye: { yaw: 0, pitch: -6, fov: 60 },
  down: { yaw: 0, pitch: -52, fov: 60 },
  downleft: { yaw: 55, pitch: -45, fov: 60 },
  downright: { yaw: -60, pitch: -42, fov: 60 },
  left: { yaw: 70, pitch: -7, fov: 60 },
  right: { yaw: -65, pitch: -6, fov: 60 },
  far: { yaw: 12, pitch: 1.5, fov: 22 },
  farright: { yaw: -40, pitch: 1, fov: 22 },
  back: { yaw: 100, pitch: -12, fov: 60 },
  backright: { yaw: -100, pitch: -12, fov: 60 },
  loon: { yaw: 0, pitch: -1.5, fov: 8, track: 'loon' },
  eagle: { yaw: 0, pitch: 0, fov: 2.5, track: 'bird' },
  gull: { yaw: 0, pitch: 0, fov: 0.8, track: 'gull' },
  raven: { yaw: 0, pitch: 0, fov: 0.8, track: 'raven' },
  fly: { yaw: 0, pitch: 0, fov: 4, track: 'fly' },
  waterline: { yaw: -20, pitch: -68, fov: 50 },
  cove: { yaw: 62, pitch: -9, fov: 28 },
  point: { yaw: -58, pitch: -6, fov: 28 },
  timber: { yaw: 25, pitch: -12, fov: 30 },
  trees: { yaw: 85, pitch: 4, fov: 35 },
  rocks: { yaw: -66, pitch: -2.5, fov: 14 },
  reeds: { yaw: 75, pitch: -6, fov: 18 },
  sideleft: { yaw: 90, pitch: -30, fov: 60 },
  mountains: { yaw: 5, pitch: 6, fov: 16 },
  mountainsR: { yaw: -55, pitch: 6, fov: 16 },
};
let view = VIEWS.eye;
window.__view = (name) => {
  view = VIEWS[name] || VIEWS.eye;
  frames = 0;
  return name;
};
let frames = 0;
window.__frames = () => frames;

camera.position.set(0, eye, 0);
const clock = new THREE.Clock();
let time = 0;
const _v = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  time += dt;
  frame.dt = dt;
  frame.time = time;
  frame.hours = hours;
  if (view.track && window.__trackPos[view.track] && window.__trackPos[view.track]()) {
    _v.copy(window.__trackPos[view.track]());
    view.yaw = THREE.MathUtils.radToDeg(Math.atan2(-_v.x, -_v.z));
    view.pitch = THREE.MathUtils.radToDeg(Math.atan2(_v.y + 0.2 - eye, Math.hypot(_v.x, _v.z)));
  }
  camera.rotation.set(THREE.MathUtils.degToRad(view.pitch), THREE.MathUtils.degToRad(view.yaw), 0, 'YXZ');
  if (camera.fov !== view.fov) {
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
  }
  frame.input.aimYaw = camera.rotation.y;
  frame.input.aimPitch = camera.rotation.x;
  if (preUpdate) preUpdate(frame);
  scenery.update(frame);
  if (postUpdate) postUpdate(frame);
  renderer.render(scene, camera);
  frames++;
});

function triBudget() {
  const out = {};
  scenery.object3d.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const n = o.isInstancedMesh ? o.count : 1;
    let key = o.name.split('.').slice(0, 2).join('.');
    out[key] = out[key] || { meshes: 0, tris: 0 };
    out[key].meshes++;
    out[key].tris += Math.round(tris * n);
  });
  return out;
}
window.__tris = triBudget;
window.__visTris = () => {
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const out = {};
  scenery.object3d.traverseVisible((o) => {
    if (!o.isMesh || (o.frustumCulled && !fr.intersectsObject(o))) return;
    const g = o.geometry;
    const tris = ((g.index ? g.index.count : g.attributes.position.count) / 3) * (o.isInstancedMesh ? o.count : 1);
    const key = o.name.split('.').slice(0, 2).join('.');
    out[key] = (out[key] || 0) + Math.round(tris);
  });
  return out;
};
window.__sceneryVisible = (v) => {
  scenery.object3d.visible = !!v;
  frames = 0;
};
console.log('[scenery] tris', JSON.stringify(triBudget()));
window.__game = {
  debug: {
    stats: () => ({
      buildMs: Math.round(buildMs),
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      frames,
    }),
  },
};
}
