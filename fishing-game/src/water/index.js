// Water: the lake surface of Loon Lake Angler (see CONTRACT.md, "Water").
//
//  - Surface: camera-following graded grid (fine near the player, 2.5 km across),
//    Gerstner wind waves shared with getHeight/getNormal, three scrolling layers of
//    procedural ripple normals, wind patches.
//  - Shading: Schlick Fresnel (F0 0.02) over a planar reflection (high/medium) or
//    the sky (low); Beckmann sun glint whose roughness is the unresolved wave slope,
//    so the glitter turns into a tight glint path at a distance; Beer-Lambert
//    absorption (red first) from the true water thickness measured by a depth
//    pre-pass of LAYERS.UNDERWATER (env depth on low); soft shoreline; scene fog.
//  - Effects: ripple rings (uniform arrays), splash droplets / crown / mist, V-wakes,
//    driven by the contract events.
import * as THREE from 'three';
import { LAYERS, WATER_LEVEL, clamp, smoothstep } from '../config.js';
import { buildSurfaceGeometry } from './grid.js';
import { createWaveField } from './waves.js';
import { createDetailTexture } from './detailTexture.js';
import { createRipples } from './ripples.js';
import { createSplashSystem } from './splash.js';
import { createPasses } from './passes.js';
import { waterVertex, waterFragment } from './shaders.js';

// depthRange: the pre-pass only draws under-water things this close (m). Further out
// Fresnel leaves a few percent of transmission and the env depth map stands in.
const QUALITY = {
  high: { refl: 0.5, reflMaxW: 1280, depth: 0.5, depthMaxW: 1024, depthRange: 220, rings: 32, particles: 900 },
  medium: { refl: 1 / 3, reflMaxW: 800, depth: 1 / 3, depthMaxW: 640, depthRange: 170, rings: 24, particles: 500 },
  low: { refl: 0, reflMaxW: 0, depth: 0, depthMaxW: 0, depthRange: 0, rings: 14, particles: 220 },
};
const normQ = (q) => (q === 'low' || q === 'medium' ? q : 'high');

// Optical properties of a clear-ish, slightly tea-stained northern lake (Secchi ~3 m):
// red is absorbed first, blue by dissolved organics, green travels furthest.
const SIGMA = [0.26, 0.2, 0.46]; // 1/m (core: slightly clearer than first tuned, see the report)
const DOWN_K = 1.15; // light reaching the bed travels ~1.15x its depth
const BODY = [0.0026, 0.0078, 0.0066]; // radiance of optically deep water per unit irradiance
const BED_EST = 0.055; // typical sand/mud/weed radiance per unit irradiance
const FOAM = 0.2;
const LURE_SPLASH = { bobber: 0.34, spinner: 0.24, crankbait: 0.38, topwater: 0.38 };

// Detail normal layers: tile (m), texture rotation relative to the wind, scroll speed (m/s),
// scroll direction relative to the wind, slope strength.
const DETAIL = [
  { tile: 4.3, rot: 0.3, speed: 0.2, dir: 0.0, strength: 0.13 },
  { tile: 1.37, rot: -0.85, speed: 0.11, dir: 0.55, strength: 0.09 },
  { tile: 13.1, rot: 2.2, speed: 0.34, dir: -0.25, strength: 0.07 },
];
const PATCH_TILE = 190; // m, wind patches ("cat's paws")

// Wind 0..1 -> strength of the ripple (detail normal) layers. Light airs at dawn and
// dusk (< ~0.08) leave the lake nearly glassy; a small floor keeps a hint of life so
// the reduced-resolution mirror never reads as a perfect, soft copy. From the
// midday breeze up (>= 0.3) this is the original calibration (0.2 + 1.3 w).
function ruffleFor(w) {
  const x = Number.isFinite(w) ? w : 0.25;
  if (x >= 0.3) return Math.min(1.8, 0.2 + 1.3 * x);
  return 0.06 + 2.12 * Math.max(0, x - 0.05);
}

export function createWater(ctx) {
  const { renderer, scene, events } = ctx;
  const env = ctx.env || {};
  let quality = normQ(ctx.quality);
  let cfg = QUALITY[quality];

  const waves = createWaveField({ windStrength: env.windStrength, windDirection: env.windDirection });
  const detailTex = createDetailTexture(renderer);
  const ripples = createRipples();
  const passes = createPasses(renderer);
  // Surface grids are kept per quality level, so switching back and forth at run
  // time costs nothing after the first build (a few hundred KB each).
  const grids = {};
  const gridFor = (q) => grids[q] || (grids[q] = buildSurfaceGeometry(q));
  let grid = gridFor(quality);

  // ---- uniforms (shared by both passes) --------------------------------------------
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uWaveA: { value: waves.uA },
    uWaveB: { value: waves.uB },
    uRingA: { value: ripples.uA },
    uRingB: { value: ripples.uB },
    uRingCount: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunRad: { value: new THREE.Vector3(1, 1, 1) },
    uSkyColor: { value: new THREE.Vector3(0.4, 0.55, 0.8) },
    uHorizonColor: { value: new THREE.Vector3(0.7, 0.75, 0.8) },
    uSigma: { value: new THREE.Vector3(...SIGMA) },
    uDownK: { value: DOWN_K },
    uBodyRad: { value: new THREE.Vector3() },
    uBedEst: { value: new THREE.Vector3(0.05, 0.05, 0.05) },
    uFoamRad: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
    tDetail: { value: detailTex },
    uDet0: { value: new THREE.Vector4() },
    uDet1: { value: new THREE.Vector4() },
    uDet2: { value: new THREE.Vector4() },
    uDetOff01: { value: new THREE.Vector4() },
    uDetOff2P: { value: new THREE.Vector4() },
    uPatchScale: { value: 1 / PATCH_TILE },
    uRuffle: { value: 1 },
    uSpreadCap: { value: 10 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uResolution: { value: new THREE.Vector2(1, 1) },
    tEnvDepth: { value: null },
    uEnvDepthXf: { value: new THREE.Vector4(-500, -500, 1 / 1000, 1 / 1000) },
    uEnvDepthMode: { value: 1 },
    uReflClamp: { value: 8 },
    uUseDepth: { value: 0 },
    uUseRefl: { value: 0 },
    tSceneDepth: { value: null },
    uDepthTexel: { value: new THREE.Vector2(1, 1) },
    uCamNear: { value: 0.1 },
    uCamFar: { value: 2500 },
    tRefl: { value: null },
    tReflDepth: { value: null },
    uTexMatrix: { value: passes.textureMatrix },
    uReflProjInv: { value: passes.reflectionProjectionInverse },
    uReflCamWorld: { value: passes.reflectionCameraWorld },
    uReflProjXY: { value: passes.reflectionProjXY },
    uReflPxPerRad: { value: 300 },
    uReflTexel: { value: new THREE.Vector2(1 / 512, 1 / 256) },
    uShoreColor: { value: new THREE.Vector3(0.02, 0.03, 0.02) },
    uShoreElev: { value: 0.06 },
    uShoreProfile: { value: 0 }, // 1: far-shore band from the real skyline (tSkyline), VR only
    tSkyline: { value: null },
    tEnv: { value: null },
    uEnvIntensity: { value: 1 },
  };

  const common = {
    uniforms,
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  };
  // dst *= transmittance
  const mulMat = new THREE.ShaderMaterial({ ...common, name: 'WaterTransmit', blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor });
  // dst += reflection + scattering + glint + foam + fog
  const addMat = new THREE.ShaderMaterial({ ...common, name: 'WaterSurface', blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });

  const mesh = new THREE.Mesh(grid.geometry, addMat);
  mesh.name = 'water';
  mesh.renderOrder = 11; // after opaque + default-order transparent under-water things
  mesh.frustumCulled = false;
  const mulMesh = new THREE.Mesh(grid.geometry, mulMat);
  mulMesh.name = 'water-transmittance';
  mulMesh.renderOrder = 10;
  mulMesh.frustumCulled = false;
  mesh.add(mulMesh);
  scene.add(mesh);

  const splashSys = createSplashSystem({ scene, maxParticles: QUALITY.high.particles, getHeight });

  // ---- environment depth texture (low quality, and pre-pass holes) -------------------
  let fallbackDepthTex = null;
  function buildFallbackDepth() {
    const W = 256;
    const H = 192;
    const minX = -560;
    const maxX = 560;
    const minZ = -680;
    const maxZ = 80;
    const data = new Uint8Array(W * H);
    const getDepth = typeof env.getDepth === 'function' ? env.getDepth : null;
    for (let j = 0; j < H; j++) {
      const z = minZ + ((j + 0.5) / H) * (maxZ - minZ);
      for (let i = 0; i < W; i++) {
        const x = minX + ((i + 0.5) / W) * (maxX - minX);
        let d = getDepth ? getDepth(x, z) : 12;
        if (!Number.isFinite(d)) d = 0;
        data[j * W + i] = Math.round(Math.sqrt(clamp(d / 12, 0, 1)) * 255);
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    tex.userData.bounds = { minX, minZ, maxX, maxZ };
    return tex;
  }
  let envDepthSource = null;
  function syncEnvDepth() {
    const dm = env.depthMap;
    if (dm && dm.texture && dm.bounds) {
      if (envDepthSource === dm.texture) return;
      envDepthSource = dm.texture;
      const b = dm.bounds;
      uniforms.tEnvDepth.value = dm.texture;
      uniforms.uEnvDepthXf.value.set(b.minX, b.minZ, 1 / Math.max(1e-3, b.maxX - b.minX), 1 / Math.max(1e-3, b.maxZ - b.minZ));
      uniforms.uEnvDepthMode.value = 0;
      return;
    }
    if (!fallbackDepthTex) fallbackDepthTex = buildFallbackDepth();
    if (envDepthSource === fallbackDepthTex) return;
    envDepthSource = fallbackDepthTex;
    const b = fallbackDepthTex.userData.bounds;
    uniforms.tEnvDepth.value = fallbackDepthTex;
    uniforms.uEnvDepthXf.value.set(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ));
    uniforms.uEnvDepthMode.value = 1;
  }

  // ---- defines / quality ------------------------------------------------------------------
  // Quality levels only switch uniforms (uUseRefl / uUseDepth), never defines: a
  // runtime quality change must not recompile the water programs. The only define
  // that follows the environment is the PMREM layout of the sky fallback, which is
  // fixed once the environment has baked its first env map.
  let definesKey = '';
  let debugMode = 0;
  let envMapSeen = undefined;
  let envMapHeight = 0;
  function syncDefines() {
    const d = {};
    if (debugMode) d.WATER_DEBUG = String(debugMode);
    const em = env.envMap;
    uniforms.tEnv.value = null;
    if (em && em.mapping === THREE.CubeUVReflectionMapping && em.image && em.image.height > 0) {
      const h = em.image.height;
      const maxMip = Math.log2(h) - 2;
      d.ENVMAP_TYPE_CUBE_UV = '';
      d.CUBEUV_TEXEL_WIDTH = (1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16))).toFixed(10);
      d.CUBEUV_TEXEL_HEIGHT = (1 / h).toFixed(10);
      d.CUBEUV_MAX_MIP = maxMip.toFixed(1);
      uniforms.tEnv.value = em;
    }
    const key = Object.keys(d).map((k) => k + d[k]).join('|');
    if (key === definesKey) return;
    definesKey = key;
    mulMat.defines = { ...d, PASS_MUL: '' };
    addMat.defines = { ...d, PASS_ADD: '' };
    mulMat.needsUpdate = true;
    addMat.needsUpdate = true;
  }

  // While an XR session presents, neither off-screen pass runs (XR.md "Rendering while presenting"):
  // a mirror / depth image from one camera cannot serve two eyes, and the headset has no time for
  // them. The water then shades like 'low': env-map sky + analytic far-shore band (here shaped by the
  // real skyline, see setXRActive), and thickness from the environment's depth map. Only uniforms
  // flip: no recompile on enter / exit.
  let xrActive = false;
  const reflOn = () => cfg.refl > 0 && !xrActive;
  const depthOn = () => cfg.depth > 0 && !xrActive;
  function syncPassSwitches() {
    uniforms.uUseRefl.value = reflOn() ? 1 : 0;
    uniforms.uUseDepth.value = depthOn() ? 1 : 0;
    if (!reflOn()) {
      uniforms.tRefl.value = null;
      uniforms.tReflDepth.value = null;
    }
    if (!depthOn()) uniforms.tSceneDepth.value = null;
  }
  function setXRActive(on) {
    xrActive = on;
    // free the targets while presenting (headset memory); they are re-made at the next pass
    if (on) {
      passes.releaseReflection();
      passes.releaseDepth();
      if (!skylineTex) skylineTex = buildSkylineTexture();
    }
    // Without the mirror the far-shore band stands in for the treeline's reflection. The fixed band
    // (3.4 deg) is far below the real skyline seen from the dock (treeline 5-8 deg, hills to ~20 deg),
    // which left the far water pale in VR where the desktop mirror shows the dark treeline: in VR the
    // band follows the environment's skyline profile instead. (Desktop 'low' keeps the fixed band.)
    uniforms.tSkyline.value = skylineTex;
    uniforms.uShoreProfile.value = on && skylineTex ? 1 : 0;
    syncPassSwitches();
  }

  // Skyline occluder per azimuth atan2(x, -z) (bin k at -pi + 2 pi (k + 0.5) / N): R = its top (world y,
  // m), G = its distance from the dock (m). From env.skylineOccluderAt, else the elevation profile at an
  // assumed 300 m; null without either (the fixed band stays).
  let skylineTex = null;
  function buildSkylineTexture() {
    const occ = typeof env.skylineOccluderAt === 'function' ? env.skylineOccluderAt : null;
    const elev = typeof env.skylineElevationAt === 'function' ? env.skylineElevationAt : null;
    if (!occ && !elev) return null;
    const N = 720;
    const data = new Float32Array(N * 4);
    const o = {};
    for (let k = 0; k < N; k++) {
      const az = -Math.PI + ((k + 0.5) / N) * Math.PI * 2;
      let hgt = 20;
      let dist = 300;
      if (occ) {
        occ(az, o);
        hgt = o.height;
        dist = o.distance;
      } else {
        dist = 300;
        hgt = 2.2 + dist * Math.tan(clamp(elev(az), -1.4, 1.4));
      }
      data[k * 4] = Number.isFinite(hgt) ? clamp(hgt, -50, 2000) : 20;
      data[k * 4 + 1] = Number.isFinite(dist) ? clamp(dist, 1, 5000) : 300;
    }
    const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.name = 'water-skyline';
    tex.needsUpdate = true;
    return tex;
  }

  // Cheap at run time: uniforms, a cached grid, render-target sizes. No shader
  // recompiles, no texture re-uploads.
  function applyQuality(q) {
    quality = q;
    cfg = QUALITY[q];
    ripples.setLimit(cfg.rings);
    splashSys.setCapacity(cfg.particles);
    grid = gridFor(q);
    mesh.geometry = grid.geometry;
    mulMesh.geometry = grid.geometry;
    if (!cfg.refl) passes.releaseReflection();
    if (!cfg.depth) passes.releaseDepth();
    setAnisotropy(q);
    syncPassSwitches();
  }
  function setAnisotropy(q) {
    const an = Math.min(q === 'high' ? 8 : q === 'medium' ? 4 : 1, renderer.capabilities.getMaxAnisotropy());
    if (detailTex.anisotropy === an) return;
    detailTex.anisotropy = an; // a 256 px texture: re-uploading it is trivial
    detailTex.needsUpdate = true;
  }
  setAnisotropy(quality);
  ripples.setLimit(cfg.rings);
  splashSys.setCapacity(cfg.particles);
  syncPassSwitches();
  syncDefines();

  // ---- per-frame environment ----------------------------------------------------------------
  const E = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const lin = (c, out) => (c && c.isColor ? out.set(c.r, c.g, c.b) : c && c.isVector3 ? out.copy(c) : out);
  const lum = (v) => 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
  let windStrength = Number.isFinite(env.windStrength) ? env.windStrength : 0.25;

  function readEnv() {
    const u = uniforms;
    const sd = env.sunDirection;
    if (sd && Number.isFinite(sd.x) && sd.lengthSq() > 1e-8) u.uSunDir.value.copy(sd).normalize();
    const sunDir = u.uSunDir.value;
    // env.sunIntensity already carries env.sunVisibility (the share of the sun / moon disc
    // above the terrain + treeline skyline seen from the dock), so a key light behind the
    // far forest leaves the lake in shade and makes no glint. Only the geometric horizon
    // is added here.
    const sunI = Number.isFinite(env.sunIntensity) ? Math.max(0, env.sunIntensity) : 2;
    const vis = smoothstep(-0.015, 0.02, sunDir.y);
    lin(env.sunColor, tmpC.set(1, 0.95, 0.88));
    u.uSunRad.value.copy(tmpC).multiplyScalar(sunI * vis);
    lin(env.skyColor, u.uSkyColor.value);
    lin(env.horizonColor, u.uHorizonColor.value);
    const sky = u.uSkyColor.value;
    const hor = u.uHorizonColor.value;
    // irradiance just under the surface (drives the water body, foam, bed estimate)
    E.copy(u.uSunRad.value).multiplyScalar(Math.max(sunDir.y, 0) * 0.9).addScaledVector(sky, 1.0).addScaledVector(hor, 0.35);
    u.uBodyRad.value.set(BODY[0] * E.x, BODY[1] * E.y, BODY[2] * E.z);
    u.uBedEst.value.copy(E).multiplyScalar(BED_EST).max(tmpC.set(1e-4, 1e-4, 1e-4));
    u.uFoamRad.value.copy(E).multiplyScalar(FOAM);
    u.uReflClamp.value = Math.max(1.5, 7 * (lum(sky) + lum(hor)));
    // low quality: dark forested far shore in the sky reflection, hazed by fog at ~300 m
    let f300 = 0;
    const fog = scene.fog;
    if (fog && fog.isFogExp2) f300 = 1 - Math.exp(-((fog.density * 300) ** 2));
    else if (fog && fog.isFog) f300 = smoothstep(fog.near, fog.far, 300);
    const forest = tmpC.set(0.018, 0.028, 0.017).multiplyScalar(0.6 + 0.4 * Math.min(1, lum(E)));
    u.uShoreColor.value.copy(forest).lerp(hor, f300);
    if (Number.isFinite(env.windStrength)) windStrength = env.windStrength;
    u.uRuffle.value = ruffleFor(windStrength);
    // Light airs: the ripples are too weak to smear the mirrored treeline into the sky.
    u.uSpreadCap.value = 0.03 + 4 * smoothstep(0.1, 0.24, windStrength);
    if (env.envMap !== envMapSeen || (env.envMap && env.envMap.image && env.envMap.image.height !== envMapHeight)) {
      envMapSeen = env.envMap;
      envMapHeight = env.envMap && env.envMap.image ? env.envMap.image.height : 0;
      syncDefines();
    }
  }

  // detail scroll offsets (wrapped to [0,1) in double precision)
  const detOff = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const detU = [uniforms.uDet0.value, uniforms.uDet1.value, uniforms.uDet2.value];
  function scrollDetail(dt) {
    const a = waves.angle;
    for (let i = 0; i < 3; i++) {
      const L = DETAIL[i];
      const th = -(a + L.rot); // texture +u follows the wind (+ a per-layer twist)
      const c = Math.cos(th);
      const s = Math.sin(th);
      detU[i].set(c, s, 1 / L.tile, L.strength);
      const dx = Math.cos(a + L.dir) * L.speed * dt;
      const dz = Math.sin(a + L.dir) * L.speed * dt;
      // moving pattern h(x - v t): uv offset -= R * v dt / tile
      const o = detOff[i];
      o[0] = (o[0] - (c * dx - s * dz) / L.tile) % 1;
      o[1] = (o[1] - (s * dx + c * dz) / L.tile) % 1;
    }
    const p = detOff[3];
    const ps = (0.6 + 1.6 * windStrength) * dt / PATCH_TILE;
    p[0] = (p[0] - Math.cos(a) * ps) % 1;
    p[1] = (p[1] - Math.sin(a) * ps) % 1;
    uniforms.uDetOff01.value.set(detOff[0][0], detOff[0][1], detOff[1][0], detOff[1][1]);
    uniforms.uDetOff2P.value.set(detOff[2][0], detOff[2][1], p[0], p[1]);
  }

  // ---- objects to hide during the off-screen passes ----------------------------------
  const hiddenRefl = [];
  const hiddenDepth = [];
  const NR = 1 << LAYERS.NO_REFLECT;
  const UW = 1 << LAYERS.UNDERWATER;
  const isCutout = (m) => {
    if (!m) return false;
    if (Array.isArray(m)) return m.some(isCutout);
    return m.alphaTest > 0 || m.depthWrite === false || (m.transparent && m.opacity < 0.5);
  };
  function collect(obj) {
    const ch = obj.children;
    for (let i = 0; i < ch.length; i++) {
      const o = ch[i];
      if (!o.visible) continue;
      if (o === mesh || o === splashSys.object) {
        hiddenRefl.push(o);
        continue;
      }
      const m = o.layers.mask;
      if (m & NR) hiddenRefl.push(o);
      if (m & UW && isCutout(o.material)) hiddenDepth.push(o);
      if (o.children.length) collect(o);
    }
  }

  // ---- public API -----------------------------------------------------------------------------
  function getHeight(x, z) {
    return WATER_LEVEL + waves.heightAt(x, z);
  }

  function getNormal(x, z, target) {
    return waves.normalAt(x, z, target || new THREE.Vector3());
  }

  function addRipple(x, z, strength01 = 0.5, radiusM = 3) {
    const s = clamp(Number.isFinite(strength01) ? strength01 : 0.5, 0, 1);
    const r = clamp(Number.isFinite(radiusM) ? radiusM : 3, 0.2, 12);
    ripples.add(x, z, 0.0012 + 0.009 * s, 0.06 + 0.2 * s, 0.24 + 0.3 * s, r, 0);
  }

  function splash(position, size01 = 0.5, dirX = 0, dirZ = 0) {
    if (!position) return;
    const x = position.x;
    const z = position.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const s = clamp(Number.isFinite(size01) ? size01 : 0.5, 0, 1);
    const y = getHeight(x, z);
    splashSys.burst(x, y, z, s, { quality, dirX, dirZ });
    const amp = 0.0025 + 0.013 * s;
    const lam = 0.08 + 0.24 * s;
    const sp = 0.3 + 0.32 * s;
    const R = 1.4 + 4.2 * s;
    ripples.add(x, z, amp, lam, sp, R, s > 0.3 ? 0.25 + 0.75 * s : 0.3 * s, 0, false, true);
    // falling drops and the collapsing jet make a second, finer set of rings
    ripples.add(x, z, amp * 0.55, lam * 0.65, sp * 0.8, R * 0.7, 0, 0.3 + 0.25 * s);
    if (s > 0.5) ripples.add(x, z, amp * 0.4, lam * 0.55, sp * 0.7, R * 0.5, 0.2, 0.85);
  }

  function boil(position, size01) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return;
    const s = clamp(Number.isFinite(size01) ? size01 : 0.5, 0, 1);
    const x = position.x;
    const z = position.z;
    ripples.add(x, z, 0.004 + 0.012 * s, 0.16 + 0.2 * s, 0.34 + 0.3 * s, 2 + 3.5 * s, 0.55 + 0.45 * s, 0, false, true);
    ripples.add(x, z, 0.0025 + 0.005 * s, 0.12, 0.3, 1.4 + 2 * s, 0.25, 0.3);
    splashSys.burst(x, getHeight(x, z), z, 0.16 + 0.32 * s, { quality });
  }

  // A nibble at the float: a few mm high rings spreading 0.5-1 m, long enough (10 cm
  // crests) to catch the light at 15-25 m, where shorter capillary rings would only
  // roughen a pixel or two.
  function plip(position, strength01) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return;
    const s = clamp(Number.isFinite(strength01) ? strength01 : 0.4, 0, 1);
    ripples.add(position.x, position.z, 0.003 + 0.0025 * s, 0.1, 0.3, 0.6 + 0.4 * s, 0);
    ripples.add(position.x, position.z, 0.0018 + 0.0015 * s, 0.065, 0.24, 0.45 + 0.3 * s, 0, 0.2);
  }

  let lastDt = 1 / 60;
  function wake(x, z, dirX, dirZ, speedMps) {
    ripples.wake(x, z, dirX, dirZ, speedMps, lastDt);
  }

  // ---- events ------------------------------------------------------------------------------
  let lastFrame = null;
  const offs = [];
  if (events && typeof events.on === 'function') {
    offs.push(
      events.on('lure:landed', (e) => {
        if (!e || e.onWater === false || !e.position) return;
        const base = LURE_SPLASH[e.lureId] ?? 0.32;
        const sp = Number.isFinite(e.speed) ? e.speed : 8;
        splash(e.position, clamp(base * (0.7 + sp / 25), 0.12, 0.6));
      }),
      events.on('lure:twitch', (e) => {
        if (!e || !e.position) return;
        const v = lastFrame && lastFrame.lure && lastFrame.lure.velocity;
        let dx = 0;
        let dz = 0;
        if (v && Number.isFinite(v.x)) {
          const l = Math.hypot(v.x, v.z);
          if (l > 1e-3) {
            dx = -v.x / l; // the topwater spits water back toward the angler
            dz = -v.z / l;
          }
        }
        splash(e.position, 0.13, dx * 0.8, dz * 0.8);
      }),
      events.on('fish:swirl', (e) => e && boil(e.position, e.size01)),
      events.on('fish:jump', (e) => e && splash(e.position, 0.55 + 0.45 * clamp(e.size01 ?? 0.5, 0, 1))),
      events.on('fish:splash', (e) => e && splash(e.position, 0.28 + 0.45 * clamp(e.size01 ?? 0.5, 0, 1))),
      events.on('fish:nibble', (e) => {
        const lure = lastFrame && lastFrame.lure;
        const p = lure && (lure.bobberPosition || lure.position);
        if (p) plip(p, e && e.strength01);
      })
    );
  }

  // ---- update -------------------------------------------------------------------------------
  const camPos = new THREE.Vector3();
  const buf = new THREE.Vector2();
  let time = 0;

  function update(frame) {
    if (!frame) return;
    const dt = clamp(Number.isFinite(frame.dt) ? frame.dt : 0, 0, 0.1);
    time = Number.isFinite(frame.time) ? frame.time : time + dt;
    lastDt = dt > 0 ? dt : lastDt;
    lastFrame = frame;
    const q = normQ(frame.quality || quality);
    if (q !== quality) applyQuality(q);
    const xrNow = !!(renderer.xr && renderer.xr.isPresenting);
    if (xrNow !== xrActive) setXRActive(xrNow);
    const cam = frame.camera || ctx.camera;

    readEnv();
    syncEnvDepth();
    waves.update(time, dt, windStrength, env.windDirection);
    uniforms.uWindDir.value.set(Math.cos(waves.angle), Math.sin(waves.angle));
    scrollDetail(dt);
    ripples.update(time);
    uniforms.uRingCount.value = ripples.count;

    if (!cam) return;
    cam.updateWorldMatrix(true, false);
    camPos.setFromMatrixPosition(cam.matrixWorld);
    const s0 = grid.s0;
    mesh.position.set(Math.round(camPos.x / s0) * s0, WATER_LEVEL, Math.round(camPos.z / s0) * s0);
    mesh.updateMatrixWorld(true);

    renderer.getDrawingBufferSize(buf);
    const bw = Math.max(1, buf.x);
    const bh = Math.max(1, buf.y);
    uniforms.uResolution.value.set(bw, bh);
    const fovRad = THREE.MathUtils.degToRad(cam.fov || 60);
    const projScale = bh / (2 * Math.tan(fovRad / 2) / (cam.zoom || 1));

    // splash particles are lit like everything else
    const su = splashSys.uniforms;
    su.uSunDir.value.copy(uniforms.uSunDir.value);
    su.uSunRad.value.setRGB(uniforms.uSunRad.value.x, uniforms.uSunRad.value.y, uniforms.uSunRad.value.z, THREE.LinearSRGBColorSpace);
    su.uWhite.value.setRGB(uniforms.uFoamRad.value.x, uniforms.uFoamRad.value.y, uniforms.uFoamRad.value.z, THREE.LinearSRGBColorSpace);
    su.uAmbient.value.setRGB(
      uniforms.uSkyColor.value.x * 0.75 + uniforms.uHorizonColor.value.x * 0.4,
      uniforms.uSkyColor.value.y * 0.75 + uniforms.uHorizonColor.value.y * 0.4,
      uniforms.uSkyColor.value.z * 0.75 + uniforms.uHorizonColor.value.z * 0.4,
      THREE.LinearSRGBColorSpace
    );
    splashSys.update(dt, projScale, time);

    if (!depthOn() && !reflOn()) return;
    hiddenRefl.length = 0;
    hiddenDepth.length = 0;
    collect(scene);
    if (depthOn()) {
      const scale = Math.min(cfg.depth, cfg.depthMaxW / bw);
      const w = Math.max(16, Math.round(bw * scale));
      const h = Math.max(16, Math.round(bh * scale));
      const range = passes.renderDepth(scene, cam, hiddenDepth, w, h, cfg.depthRange);
      uniforms.tSceneDepth.value = passes.depthTexture;
      uniforms.uDepthTexel.value.set(1 / w, 1 / h);
      uniforms.uCamNear.value = range.near;
      uniforms.uCamFar.value = range.far;
    }
    if (reflOn()) {
      const scale = Math.min(cfg.refl, cfg.reflMaxW / bw);
      const w = Math.max(16, Math.round(bw * scale));
      const h = Math.max(16, Math.round(bh * scale));
      passes.renderReflection(scene, cam, hiddenRefl, w, h, uniforms.uHorizonColor.value);
      uniforms.tRefl.value = passes.reflectionTexture;
      uniforms.tReflDepth.value = passes.reflectionDepth;
      uniforms.uReflPxPerRad.value = h / (fovRad / (cam.zoom || 1));
      uniforms.uReflTexel.value.set(1 / w, 1 / h);
    }
  }

  function dispose() {
    for (const off of offs) if (typeof off === 'function') off();
    scene.remove(mesh);
    for (const k of Object.keys(grids)) grids[k].geometry.dispose();
    mulMat.dispose();
    addMat.dispose();
    detailTex.dispose();
    if (fallbackDepthTex) fallbackDepthTex.dispose();
    if (skylineTex) skylineTex.dispose();
    splashSys.dispose();
    passes.dispose();
  }

  // Initialise uniforms so a render before the first update() is already sane.
  readEnv();
  syncEnvDepth();
  scrollDetail(0);

  return {
    mesh,
    update,
    getHeight,
    getNormal,
    addRipple,
    splash: (position, size01 = 0.5) => splash(position, size01),
    wake,
    clarityM: 3,
    dispose,
    // Integration aid: 0 off, 1 reflection, 2 water depth over the visible point,
    // 3 transmittance, 4 normals, 5 sun glint, 6 lee / calm / unresolved slope.
    debugView(mode = 0) {
      debugMode = clamp(mode | 0, 0, 6);
      syncDefines();
    },
    get quality() {
      return quality;
    },
  };
}
