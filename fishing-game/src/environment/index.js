// Environment: sky, sun / moon, lights, fog, exposure, terrain (land + lake bed), time of day.
// See CONTRACT.md "Environment".
import * as THREE from 'three';
import { DAY, DOCK, PLAYER, clamp, lerp, smoothstep } from '../config.js';
import { createTerrainField } from './terrainField.js';
import { createTerrain } from './terrainMesh.js';
import { createSkySystem, SkyModel, toneMapACES } from './sky.js';
import { sunDirectionAt, moonDirectionAt, CELESTIAL_POLE, siderealAngle, SOLAR_NOON } from './astro.js';
import { bakeDetailTexture, bakeCloudNoise } from './textures.js';
import { createDepthMap } from './depthMap.js';
import { createMist } from './mist.js';
import { outlineBounds } from './shoreline.js';

const DEG = Math.PI / 180;

// ---- look constants (scene-referred units shared by sky, lights and clouds) ----
const SKY_GAIN = 0.36; // Preetham output -> radiance consistent with the sun below
const SUN_E0 = 3.3; // direct sun, high in a clear sky
const SUN_TAU = [0.03, 0.052, 0.094]; // per-channel optical depth at airmass 1 (clean northern air)
const MOON_E = 0.2; // moonlight key (with the night exposure boost)
const MOON_COLOR = new THREE.Color(0.6, 0.71, 1.0);
const SHADOW_HALF = 25; // meters around the dock
const SHADOW_TARGET = new THREE.Vector3(0, 0, 7);
const SHADOW_SIZE = { high: 2048, medium: 1024, low: 512 };
// skyline (terrain + treeline elevation seen from the dock) for sun / moon occlusion
const SKY_BINS = 1440; // 0.25 deg azimuth bins; azimuth = atan2(x, -z) (0 = out over the lake)
const EYE_Y = DOCK.deckY + PLAYER.eyeHeight;
const SUN_RADIUS = 0.265 * DEG;
const MOON_RADIUS = 0.62 * DEG; // the rendered moon disc (sky.js uMoonSize)
const CANOPY_EST = 16; // fallback canopy height (m) on forested land when scenery gives no profile

// piecewise-linear table lookup on sorted [x, y] pairs
function table(t, x) {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) {
      const a = t[i - 1];
      const b = t[i];
      const u = (x - a[0]) / (b[0] - a[0]);
      const s = u * u * (3 - 2 * u);
      return a[1] + (b[1] - a[1]) * s;
    }
  }
  return t[t.length - 1][1];
}
// exposure against sun elevation (deg): adapts like an eye / auto-exposure camera
const EXPOSURE = [
  [-18, 3.6],
  [-11, 3.2],
  [-7, 2.5],
  [-3, 1.7],
  [0, 1.6],
  [3, 1.2],
  [8, 0.86],
  [18, 0.66],
  [35, 0.58],
  [60, 0.55],
];

// breeze against time of day: glassy at dawn and dusk, an afternoon breeze
const WIND = [
  [0, 0.14],
  [5.5, 0.15],
  [8, 0.21],
  [12, 0.3],
  [15.5, 0.34],
  [18.5, 0.24],
  [20.5, 0.17],
  [24, 0.14],
];

export function createEnvironment(ctx) {
  const { renderer, scene, camera } = ctx;
  const quality = ctx.quality || 'high';
  let runtimeQuality = quality; // follows frame.quality (adaptive / manual changes at runtime)
  const tStart = performance.now();

  // ---------------- terrain ----------------
  const field = createTerrainField();
  const detailRT = bakeDetailTexture(renderer, quality);
  const cloudRT = bakeCloudNoise(renderer);
  const terrain = createTerrain({ field, quality, detailTexture: detailRT.texture });
  for (const m of terrain.meshes) scene.add(m);
  const tuLift = terrain.uniforms;
  // cull the main-view terrain tiles against the main camera just before three builds its render
  // list (scene.onBeforeRender runs after the matrices update, before projection); other passes
  // (reflection, depth pre-pass) draw their own proxy / wet tiles with three's culling
  const prevSceneBeforeRender = scene.onBeforeRender;
  scene.onBeforeRender = function (r, s, cam, rt) {
    if (cam === camera) terrain.cull(cam);
    if (typeof prevSceneBeforeRender === 'function') prevSceneBeforeRender.call(this, r, s, cam, rt);
  };

  const lakeBounds = outlineBounds(14);
  const depthMap = createDepthMap(field, lakeBounds, quality === 'low' ? 256 : 512);

  // ---------------- sky ----------------
  const skySys = createSkySystem({ quality, cloudNoise: cloudRT.texture });
  scene.add(skySys.group);
  const model = new SkyModel();
  model.gain = SKY_GAIN;

  const mist = createMist({ quality, cloudNoise: cloudRT.texture, depthMap });
  scene.add(mist.group);

  // ---------------- lights ----------------
  const sunLight = new THREE.DirectionalLight(0xffffff, SUN_E0);
  sunLight.name = 'env-sun';
  sunLight.target.position.copy(SHADOW_TARGET);
  const sc = sunLight.shadow.camera;
  sc.left = -SHADOW_HALF;
  sc.right = SHADOW_HALF;
  sc.top = SHADOW_HALF;
  sc.bottom = -SHADOW_HALF;
  sc.near = 1;
  sc.far = 320;
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.035;
  scene.add(sunLight);
  scene.add(sunLight.target);
  // castShadow stays on at every level: toggling it changes the light / shadow counts in every
  // lit program's cache key and recompiles ~two dozen programs mid-play. 'low' instead uses a
  // small map that is re-rendered every other frame (the casters are the static dock plus fish).
  let throttleShadow = false;
  function applyShadowQuality(q) {
    sunLight.castShadow = true;
    const size = SHADOW_SIZE[q] || SHADOW_SIZE.high;
    if (sunLight.shadow.mapSize.x !== size) {
      sunLight.shadow.mapSize.set(size, size);
      if (sunLight.shadow.map) {
        sunLight.shadow.map.dispose();
        sunLight.shadow.map = null;
      }
    }
    throttleShadow = q === 'low';
    sunLight.shadow.autoUpdate = !throttleShadow;
    sunLight.shadow.needsUpdate = true;
    sc.updateProjectionMatrix();
  }
  applyShadowQuality(quality);

  const hemiLight = new THREE.HemisphereLight(0x8fb3d9, 0x3b3a2a, 0.3);
  hemiLight.name = 'env-hemi';
  scene.add(hemiLight);

  const fog = new THREE.FogExp2(0xb0c0d0, 0.0007);
  scene.fog = fog;

  // ---------------- environment map (PMREM of the sky) ----------------
  const envScene = new THREE.Scene();
  envScene.add(skySys.envSky);
  const groundMat = new THREE.ShaderMaterial({
    uniforms: { uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uHorizon; uniform vec3 uGround; varying vec3 vDir;
      void main(){ gl_FragColor = vec4(mix(uHorizon, uGround, smoothstep(-0.01, -0.3, vDir.y)), 1.0); }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const ground = new THREE.Mesh(new THREE.SphereGeometry(20, 32, 8, 0, Math.PI * 2, Math.PI / 2 - 0.02, Math.PI / 2 + 0.02), groundMat);
  ground.renderOrder = 1;
  envScene.add(ground);
  const cubeSize = quality === 'high' ? 128 : 64;
  const cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cubeCamera = new THREE.CubeCamera(0.1, 100, cubeRT);
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  let envRT = null;
  let bakedHours = -100;
  let lastBakeMs = -1e9;
  let bakeCount = 0;

  // ---------------- live state (contract fields) ----------------
  const sunDirection = new THREE.Vector3(0, 1, 0);
  const sunColor = new THREE.Color(1, 1, 1);
  const skyColor = new THREE.Color(0.4, 0.6, 0.9);
  const horizonColor = new THREE.Color(0.7, 0.8, 0.9);
  const windDirection = new THREE.Vector2(0.28, 0.96).normalize();

  // extras
  const trueSunDirection = new THREE.Vector3(0, 1, 0);
  const moonDirection = new THREE.Vector3(0, 1, 0);
  const skyRadiance = new THREE.Color();
  const horizonRadiance = new THREE.Color();

  // scratch
  const _c = new THREE.Color();
  const _c2 = new THREE.Color();
  const _fwd = new THREE.Vector3();
  const pole = new THREE.Vector3(...CELESTIAL_POLE);
  const sunRGB = new THREE.Color(); // scene-referred direct sun (color * intensity)
  const moonRGB = new THREE.Color();
  const glowBackup = new THREE.Color();
  const cloudT = [0, 0, 0];
  const T = [1, 1, 1];
  const fogDisp = { sun: new THREE.Color(), mid: new THREE.Color(), side: new THREE.Color(), away: new THREE.Color() };
  const fogSunXZ = new THREE.Vector2(1, 0);

  let currentHours = NaN;
  let exposure = 1;
  let sunElDeg = 0;
  let nightF = 0;
  let windBase = 0.25;
  const cloudDrift = new THREE.Vector2(0.13, 0.71);

  // ---------------- skyline: how much of the sun / moon disc clears the hills + treeline ----------
  // Scenery hands over the elevation profile of what it actually built (canopy shell, trees,
  // ridges, ground) via setSkylineProfile(); until then (or without scenery) each azimuth bin is
  // marched lazily over the terrain with an estimated canopy on forested land.
  let skyProfile = null;
  let skyProfileD = null;
  const skyMarched = new Float32Array(SKY_BINS).fill(NaN);
  const skyMarchedD = new Float32Array(SKY_BINS).fill(1000);
  const lcS = {};
  function marchSkyline(bin) {
    const az = ((bin + 0.5) / SKY_BINS) * Math.PI * 2 - Math.PI;
    const sx = Math.sin(az);
    const sz = -Math.cos(az);
    let best = -Math.PI / 2;
    for (let R = 12; R < 2400; R *= 1.05) {
      const x = sx * R;
      const z = sz * R;
      const h = field.height(x, z);
      let top = h;
      if (h > 0.4) top += CANOPY_EST * field.landCover(x, z, h, 0.95, lcS, field.lastDistance).forest;
      const el = Math.atan2(top - EYE_Y, R);
      if (el > best) {
        best = el;
        skyMarchedD[bin] = R;
      }
    }
    return best;
  }
  const wrapBin = (i) => ((i % SKY_BINS) + SKY_BINS) % SKY_BINS;
  function skyBin(i) {
    const k = wrapBin(i);
    if (skyProfile) return skyProfile[k];
    if (Number.isNaN(skyMarched[k])) skyMarched[k] = marchSkyline(k);
    return skyMarched[k];
  }
  // distance (m) from the dock to the occluder that forms the skyline at this azimuth
  function skyDistAt(az) {
    const k = wrapBin(Math.floor(((az + Math.PI) / (Math.PI * 2)) * SKY_BINS));
    skyBin(k);
    return skyProfile ? skyProfileD[k] : skyMarchedD[k];
  }
  function skylineAt(az) {
    const u = ((az + Math.PI) / (Math.PI * 2)) * SKY_BINS - 0.5;
    const i = Math.floor(u);
    const t = u - i;
    return skyBin(i) * (1 - t) + skyBin(i + 1) * t;
  }
  // Fraction of a disc of angular radius r around `dir` that is above the skyline (5 columns).
  const DISC_COLS = [-0.8, -0.4, 0, 0.4, 0.8];
  function discVisibility(dir, r) {
    const el = Math.asin(clamp(dir.y, -1, 1));
    if (el < -0.2) return 0;
    const az = Math.atan2(dir.x, -dir.z);
    const ce = Math.max(0.05, Math.cos(el));
    let vis = 0;
    let wsum = 0;
    for (let c = 0; c < DISC_COLS.length; c++) {
      const o = DISC_COLS[c];
      const half = r * Math.sqrt(1 - o * o);
      const sky = skylineAt(az + (o * r) / ce);
      vis += clamp((el + half - sky) / (2 * half), 0, 1) * half;
      wsum += half;
    }
    return vis / wsum;
  }
  let keyVisibility = 1;
  let keyOpenIntensity = SUN_E0; // key light before the skyline
  // Treeline occluder toward the key light, for shaders that re-light what stands above the
  // dock's shadow (tree crowns, hillsides): x = occluder top height (m), y = its distance from the
  // dock along the light's azimuth (m), z = light elevation (rad), w = disc radius (rad).
  const sunOccluder = new THREE.Vector4(0, 1000, 1, SUN_RADIUS);
  function updateOccluder(dir, r) {
    const el = Math.asin(clamp(dir.y, -1, 1));
    const az = Math.atan2(dir.x, -dir.z);
    const d = skyDistAt(az);
    sunOccluder.set(EYE_Y + d * Math.tan(skylineAt(az)), d, el, r);
  }

  function transmittance(elDeg, haze, out) {
    const e = Math.max(elDeg, 0);
    const m = 1 / (Math.sin(e * DEG) + 0.50572 * Math.pow(e + 6.07995, -1.6364));
    for (let i = 0; i < 3; i++) out[i] = Math.exp(-m * SUN_TAU[i] * haze);
    return out;
  }

  // Horizon radiance at a compass angle `rel` (radians) from the sun's azimuth.
  function horizonAt(rel, el, out) {
    const c = Math.cos(rel);
    const s = Math.sin(rel);
    const x = fogSunXZ.x * c - fogSunXZ.y * s;
    const z = fogSunXZ.x * s + fogSunXZ.y * c;
    const ce = Math.cos(el * DEG);
    return model.radiance(x * ce, Math.sin(el * DEG), z * ce, out);
  }

  function bakeEnvironment() {
    // ground seen from the dock: dark lake / forest lit by sun and sky
    const g = groundMat.uniforms.uGround.value;
    const sy = Math.max(0, trueSunDirection.y);
    g.setRGB(
      0.07 * (sunRGB.r * sy * 0.32 + skyRadiance.r * 0.9) + horizonRadiance.r * 0.05,
      0.08 * (sunRGB.g * sy * 0.32 + skyRadiance.g * 0.9) + horizonRadiance.g * 0.05,
      0.06 * (sunRGB.b * sy * 0.32 + skyRadiance.b * 0.9) + horizonRadiance.b * 0.05
    );
    groundMat.uniforms.uHorizon.value.copy(horizonRadiance).multiplyScalar(0.55);
    const su = skySys.skyUniforms;
    su.uSunDisk.value = 0;
    const glow = su.uMoonGlow.value;
    glowBackup.copy(glow);
    glow.setRGB(0, 0, 0);
    cubeCamera.update(renderer, envScene);
    su.uSunDisk.value = 1;
    glow.copy(glowBackup);
    envRT = pmrem.fromCubemap(cubeRT.texture, envRT);
    api.envMap = envRT.texture;
    scene.environment = envRT.texture;
    bakedHours = currentHours;
    lastBakeMs = performance.now();
    bakeCount++;
  }

  function applyTime(hours) {
    currentHours = hours;
    sunDirectionAt(hours, trueSunDirection);
    moonDirectionAt(hours, moonDirection);
    const sunEl = Math.asin(clamp(trueSunDirection.y, -1, 1)) / DEG;
    const moonEl = Math.asin(clamp(moonDirection.y, -1, 1)) / DEG;
    sunElDeg = sunEl;
    const morning = hours > 2 && hours < SOLAR_NOON ? 1 - smoothstep(SOLAR_NOON - 2.5, SOLAR_NOON, hours) : 0;
    const low = 1 - smoothstep(2, 32, sunEl);
    nightF = smoothstep(-3, -14, sunEl);
    const moonUp = smoothstep(-1.5, 5, moonEl);

    // ---- sky model ----
    const turbidity = lerp(2.3, lerp(3.4, 7.5, morning), low);
    const rayleigh = lerp(1.15, lerp(3.6, 2.2, morning), low);
    const mie = lerp(0.0032, lerp(0.005, 0.0085, morning), low);
    const mieG = lerp(0.76, lerp(0.88, 0.84, morning), low);
    model.set(trueSunDirection, turbidity, rayleigh, mie, mieG);
    // Preetham keeps a flat grey floor at night; fade it so the night gradient takes over
    model.gain = SKY_GAIN * lerp(1, 0.08, smoothstep(0.5, -7, sunEl));
    // golden-hour / twilight glow toward the sun's azimuth (Preetham goes black just below
    // the horizon): orange while the sun is up, rose-red then violet as it sinks
    const twi = smoothstep(-13, -2.5, sunEl) * (1 - smoothstep(2, 11, sunEl));
    const deep = smoothstep(0.5, -8, sunEl);
    const gold = (1 - morning) * 1.0 + morning * 0.8;
    model.twilight
      .setRGB(lerp(0.62, 0.12, deep), lerp(0.22, 0.03, deep), lerp(0.04, 0.055, deep))
      .multiplyScalar(twi * 0.5 * gold);
    // belt of Venus: the rose band opposite the low sun, above the earth's shadow
    const belt = smoothstep(-7.5, -1.5, sunEl) * (1 - smoothstep(2.5, 9, sunEl));
    model.belt.setRGB(0.11, 0.05, 0.06).multiplyScalar(belt * (0.8 + 0.4 * morning));
    model.shadow = 0.85 * smoothstep(-8, -1, sunEl) * (1 - smoothstep(2, 9, sunEl));
    // blue hour + moonlit / starlit night sky
    const blue = smoothstep(2, -2.5, sunEl) * (1 - smoothstep(-6, -13, sunEl));
    const nightK = nightF * (1 + 1.6 * moonUp);
    model.nightZenith.setRGB(0.0016 * nightK + 0.009 * blue, 0.0031 * nightK + 0.022 * blue, 0.0085 * nightK + 0.066 * blue);
    model.nightHorizon.setRGB(0.0032 * nightK + 0.02 * blue, 0.0048 * nightK + 0.03 * blue, 0.0085 * nightK + 0.058 * blue);

    const su = skySys.skyUniforms;
    su.sunPosition.value.copy(trueSunDirection);
    su.turbidity.value = turbidity;
    su.rayleigh.value = rayleigh;
    su.mieCoefficient.value = mie;
    su.mieDirectionalG.value = mieG;
    su.uSkyGain.value = model.gain;
    su.uBelt.value.copy(model.belt);
    su.uEarthShadow.value = model.shadow;
    su.uNightZenith.value.copy(model.nightZenith);
    su.uNightHorizon.value.copy(model.nightHorizon);
    su.uTwilight.value.copy(model.twilight);
    su.uSunXZ.value.copy(model.sunXZ);
    su.uMoonDir.value.copy(moonDirection);
    fogSunXZ.copy(model.sunXZ);

    // ---- sun ----
    const haze = lerp(1, 1.2, morning * low);
    transmittance(sunEl + 0.4, haze, T);
    const sunVis = smoothstep(-0.9, 0.9, sunEl);
    sunRGB.setRGB(T[0], T[1], T[2]).multiplyScalar(SUN_E0 * sunVis);

    // ---- moon ----
    const moonI = MOON_E * moonUp * nightF;
    moonRGB.copy(MOON_COLOR).multiplyScalar(moonI);

    // ---- key light: the sun by day, the moon at night ----
    // Direct light (and so the water glint, caustics, tackle and showcase lighting that read
    // sunIntensity) fades while the disc sinks behind the far hills / treeline seen from the dock;
    // the sky and clouds keep the unoccluded sun.
    const sunKey = sunEl > -3;
    if (sunKey) {
      sunDirection.copy(trueSunDirection);
      keyVisibility = discVisibility(trueSunDirection, SUN_RADIUS);
      updateOccluder(trueSunDirection, SUN_RADIUS);
      const m = Math.max(sunRGB.r, sunRGB.g, sunRGB.b, 1e-6);
      sunColor.setRGB(sunRGB.r / m, sunRGB.g / m, sunRGB.b / m);
      keyOpenIntensity = m;
    } else {
      sunDirection.copy(moonDirection);
      keyVisibility = discVisibility(moonDirection, MOON_RADIUS);
      updateOccluder(moonDirection, MOON_RADIUS);
      sunColor.copy(MOON_COLOR);
      keyOpenIntensity = moonI;
    }
    api.sunIntensity = keyOpenIntensity * keyVisibility;
    tuLift.uSunOpen.value.copy(sunColor).multiplyScalar(keyOpenIntensity);
    tuLift.uSunOcc.value.copy(sunOccluder);
    tuLift.uSunVisEye.value = keyVisibility;
    sunLight.color.copy(sunColor);
    sunLight.intensity = api.sunIntensity;
    sunLight.position.copy(SHADOW_TARGET).addScaledVector(sunDirection, 160);
    // never toggle .visible: the light count is part of every program's cache key
    if (sunDirection.y < -0.02) sunLight.intensity = 0;

    // ---- sky / horizon radiance samples ----
    model.radiance(0, 1, 0, skyRadiance);
    model.radiance(-model.sunXZ.x * 0.64, 0.77, -model.sunXZ.y * 0.64, _c2);
    skyRadiance.lerp(_c2, 0.5);
    horizonAt(Math.PI / 2, 1.5, horizonRadiance);

    // ---- exposure ----
    exposure = table(EXPOSURE, sunEl) * lerp(1, 0.8, moonUp * nightF);
    renderer.toneMappingExposure = exposure;

    // ---- fog (display-referred colors: three mixes fog after tone mapping) ----
    fog.density = lerp(lerp(0.0005, lerp(0.00062, 0.00082, morning), low), 0.0007, nightF);
    horizonAt(0, 1.5, _c);
    toneMapACES(_c, exposure, fogDisp.sun);
    horizonAt(Math.PI / 4, 1.5, _c);
    toneMapACES(_c, exposure, fogDisp.mid);
    horizonAt(Math.PI / 2, 1.5, _c);
    toneMapACES(_c, exposure, fogDisp.side);
    horizonAt(Math.PI, 1.5, _c);
    toneMapACES(_c, exposure, fogDisp.away);
    const tu = terrain.uniforms;
    tu.uFogSunDir.value.set(fogSunXZ.x, 0, fogSunXZ.y);
    tu.uSunDirW.value.copy(sunDirection);
    tu.uFogSun.value.copy(fogDisp.sun);
    tu.uFogMid.value.copy(fogDisp.mid);
    tu.uFogSide.value.copy(fogDisp.side);
    tu.uFogAway.value.copy(fogDisp.away);
    toneMapACES(skyRadiance, exposure, skyColor);

    // ---- hemisphere fill ----
    _c.copy(skyRadiance);
    const lum = 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b;
    hemiLight.color.setRGB(_c.r / Math.max(lum, 1e-6), _c.g / Math.max(lum, 1e-6), _c.b / Math.max(lum, 1e-6));
    hemiLight.color.multiplyScalar(1 / Math.max(hemiLight.color.r, hemiLight.color.g, hemiLight.color.b, 1e-6));
    hemiLight.groundColor.setRGB(0.3, 0.3, 0.2).lerp(_c.setRGB(0.22, 0.26, 0.34), nightF);
    // starlight + airglow keep a moonless night legible (dark-adapted eyes)
    hemiLight.intensity = lerp(0.12 + 0.12 * (1 - low), 0.3 + 0.08 * moonUp, nightF) + 0.18 * blue;
    scene.environmentIntensity = lerp(1.0, 2.0, nightF);

    // ---- caustics follow direct sun on the water ----
    terrain.uniforms.uCaustic.value = smoothstep(4, 35, sunEl) * 0.9 * (sunKey ? keyVisibility : 0);

    // ---- stars, milky way, moon ----
    const starVis = smoothstep(-5, -13, sunEl) * (1 - 0.3 * moonUp);
    skySys.starMaterial.uniforms.uVis.value = starVis;
    skySys.stars.visible = starVis > 0.002;
    skySys.starQuaternion.setFromAxisAngle(pole, siderealAngle(hours));
    su.uMilkyPole.value.copy(skySys.galPole).applyQuaternion(skySys.starQuaternion);
    su.uMilky.value = 0.016 * smoothstep(-11, -17, sunEl) * (1 - 0.7 * moonUp);
    const mm = skySys.moonMaterial.uniforms;
    mm.uMoonDir.value.copy(moonDirection);
    mm.uSunDir.value.copy(trueSunDirection);
    model.radiance(moonDirection.x, Math.max(0.02, moonDirection.y), moonDirection.z, _c);
    const dayLum = 0.2126 * _c.r + 0.7152 * _c.g + 0.0722 * _c.b;
    mm.uMoonColor.value.setRGB(1.0, 0.97, 0.9).multiplyScalar(lerp(dayLum * 0.55, 0.62, nightF));
    mm.uOcclude.value = nightF;
    skySys.moon.visible = moonEl > -1.5;
    su.uMoonGlow.value.setRGB(0.55, 0.62, 0.78).multiplyScalar(nightF * moonUp * 0.16);
    // the dark limb still shows the sky and halo in front of it
    mm.uBehind.value.copy(_c).multiplyScalar(nightF).add(_c2.copy(su.uMoonGlow.value).multiplyScalar(0.5));

    // ---- clouds ----
    const cm = skySys.cloudMaterial.uniforms;
    const streaky = smoothstep(0.35, 0.8, low) * (1 - nightF);
    cm.uCumulus.value = 1 - streaky;
    cm.uCoverage.value = lerp(lerp(0.75, 0.56, streaky), 0.84, nightF);
    cm.uSoft.value = lerp(0.16, 0.13, streaky);
    cm.uStretch.value = lerp(1.4, 4.5, streaky); // cumulus drift into loose streets along the wind
    cm.uThick.value = lerp(750, 160, streaky);
    cm.uTopErode.value = lerp(0.12, 0.04, streaky);
    cm.uOpacity.value = lerp(lerp(0.97, 0.78, streaky), 0.65, nightF);
    cm.uSunDir.value.copy(trueSunDirection);
    // clouds keep catching the sun a few minutes after it has set at the dock
    transmittance(Math.max(sunEl + 2.2, 0), haze * 1.1, cloudT);
    const cloudSun = smoothstep(-4.5, -0.3, sunEl);
    _c.setRGB(cloudT[0], cloudT[1], cloudT[2]).multiplyScalar(SUN_E0 * cloudSun * 0.3);
    _c.r += skyRadiance.r * 0.6 + moonRGB.r * 0.12;
    _c.g += skyRadiance.g * 0.6 + moonRGB.g * 0.12;
    _c.b += skyRadiance.b * 0.6 + moonRGB.b * 0.12;
    cm.uLit.value.copy(_c);
    // cumulus bases: sky light plus light scattered through the cloud and off the ground
    cm.uShade.value.copy(skyRadiance).multiplyScalar(0.9).add(_c2.copy(sunRGB).multiplyScalar(0.1));
    cm.uHorizon.value.copy(horizonRadiance);
    cm.uHaze.value = lerp(1 / 52000, 1 / 30000, morning * low);
    cm.uForward.value = 1 - nightF;

    // ---- mist ----
    const mistAmt = (1 - smoothstep(6.9, 8.5, hours)) * smoothstep(3.5, 5.0, hours) * (runtimeQuality === 'low' ? 0.7 : 1);
    mist.group.visible = mistAmt > 0.002;
    mist.uniforms.uAmount.value = mistAmt * 0.8;
    mist.uniforms.uAmb.value.copy(horizonRadiance).multiplyScalar(0.92);
    // the low sheets lie in the treeline's shadow once the sun is behind it
    mist.uniforms.uSun.value.copy(sunRGB).multiplyScalar(0.06 * (sunKey ? lerp(0.3, 1, keyVisibility) : 0.3));
    mist.uniforms.uSunDir.value.copy(trueSunDirection);

    windBase = table(WIND, hours);
  }

  // Re-bake the sky PMREM when the time has moved >= 5 game minutes, at most every 2 s.
  // Also runs from update(), so a preset jump inside the 2 s window still lands while paused.
  function maybeBake() {
    let dh = Math.abs(currentHours - bakedHours);
    if (dh > 12) dh = 24 - dh;
    if (dh >= 5 / 60 && performance.now() - lastBakeMs >= 2000) bakeEnvironment();
  }
  function setTimeOfDay(hours) {
    if (!Number.isFinite(hours)) return;
    const h = ((hours % 24) + 24) % 24;
    let dh = Math.abs(h - currentHours);
    if (dh > 12) dh = 24 - dh;
    if (!(dh < 1 / 600)) applyTime(h); // cheap no-op within 6 game-seconds
    maybeBake();
  }

  // Runtime quality (adaptive or manual): only cheap switches, no shader recompiles. The shadow
  // map size / refresh rate, the dense terrain ring's 1 m <-> 2 m index, and the mist layer count.
  function applyRuntimeQuality(q) {
    runtimeQuality = q;
    applyShadowQuality(q);
    terrain.setDetail(q === 'high' ? 'fine' : 'coarse');
    const layers = q === 'high' ? 3 : q === 'medium' ? 2 : 1;
    mist.group.children.forEach((m, i) => (m.visible = i < layers));
    if (Number.isFinite(currentHours)) applyTime(currentHours);
  }
  let shadowTick = 0;
  function update(frame) {
    const dt = frame && frame.dt > 0 ? Math.min(frame.dt, 0.1) : 0;
    const time = frame && Number.isFinite(frame.time) ? frame.time : 0;
    maybeBake();
    const fq = frame && frame.quality;
    if ((fq === 'high' || fq === 'medium' || fq === 'low') && fq !== runtimeQuality) applyRuntimeQuality(fq);
    if (throttleShadow && (shadowTick++ & 1) === 0) sunLight.shadow.needsUpdate = true;
    // wind: slow gusts and a gently veering direction
    const gust = 0.06 * Math.sin(time * 0.21) * Math.sin(time * 0.057 + 1.3) + 0.03 * Math.sin(time * 0.73 + 0.4);
    api.windStrength = clamp(windBase + gust, 0, 1);
    const veer = 0.16 * Math.sin(time * 0.013 + 0.7) + 0.05 * Math.sin(time * 0.071);
    windDirection.set(Math.sin(0.29 + veer), Math.cos(0.29 + veer));
    // clouds drift with the wind aloft
    const cm = skySys.cloudMaterial.uniforms;
    const aloft = 5 + 9 * api.windStrength;
    cloudDrift.x -= (aloft * dt * cm.uScale.value) / cm.uStretch.value;
    cm.uOffset.value.copy(cloudDrift);
    cm.uWind.value.copy(windDirection);
    mist.uniforms.uOffset.value.x -= windDirection.x * dt * 0.0035;
    mist.uniforms.uOffset.value.y -= windDirection.y * dt * 0.0035;
    skySys.starMaterial.uniforms.uTime.value = time;
    skySys.starMaterial.uniforms.uSize.value = 2.0 * renderer.getPixelRatio();
    terrain.uniforms.uTime.value = time;

    // fog color follows the horizon in the view direction
    const cam = (frame && frame.camera) || camera;
    if (cam) {
      cam.getWorldDirection(_fwd);
      const l = Math.hypot(_fwd.x, _fwd.z);
      const cs = l > 1e-4 ? (_fwd.x * fogSunXZ.x + _fwd.z * fogSunXZ.y) / l : 0;
      if (cs > 0.7071) _c.copy(fogDisp.mid).lerp(fogDisp.sun, smoothstep(0.7071, 1, cs));
      else if (cs > 0) _c.copy(fogDisp.side).lerp(fogDisp.mid, smoothstep(0, 0.7071, cs));
      else _c.copy(fogDisp.side).lerp(fogDisp.away, -cs);
      horizonColor.copy(_c);
      fog.color.copy(_c);
    }
  }

  // ---------------- queries ----------------
  const finite = (x, z) => Number.isFinite(x) && Number.isFinite(z);
  function getTerrainHeight(x, z) {
    return finite(x, z) ? field.height(x, z) : 0;
  }
  function getDepth(x, z) {
    if (!finite(x, z)) return 0;
    const h = field.height(x, z);
    return h < 0 ? -h : 0;
  }
  const isWater = (x, z) => getDepth(x, z) > 0.05;
  function getHabitat(x, z, out) {
    if (!finite(x, z)) {
      const o = out || {};
      o.depth = 0;
      o.weeds = 0;
      o.rocks = 0;
      o.wood = 0;
      return o;
    }
    return field.habitat(x, z, out);
  }
  // Extra (not in the contract): ground cover for tree / rock placement.
  function getLandCover(x, z, out) {
    const o = out || {};
    if (!finite(x, z)) {
      o.forest = o.rock = o.muck = o.beach = 0;
      return o;
    }
    const e = 0.75;
    const h = field.height(x, z);
    const gx = (field.height(x + e, z) - field.height(x - e, z)) / (2 * e);
    const gz = (field.height(x, z + e) - field.height(x, z - e)) / (2 * e);
    const ny = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    field.landCover(x, z, h, ny, o);
    o.height = h;
    o.slope = Math.acos(ny) / DEG;
    return o;
  }

  const api = {
    update,
    setTimeOfDay,
    sunDirection,
    sunColor,
    sunIntensity: SUN_E0,
    skyColor,
    horizonColor,
    envMap: null,
    windStrength: 0.25,
    windDirection,
    getTerrainHeight,
    getDepth,
    isWater,
    getHabitat,
    depthMap,
    sunLight,
    hemiLight,
    // extras
    getLandCover,
    trueSunDirection,
    moonDirection,
    skyRadiance,
    horizonRadiance,
    bakeEnvironment: () => bakeEnvironment(),
    get hours() {
      return currentHours;
    },
    get nightFactor() {
      return nightF;
    },
    get sunElevationDeg() {
      return sunElDeg;
    },
    get exposure() {
      return exposure;
    },
    // 0..1: share of the sun's (by night the moon's) disc above the terrain + treeline skyline
    // seen from the dock. Already folded into sunIntensity / sunLight.intensity.
    get sunVisibility() {
      return keyVisibility;
    },
    // extras for shaders that re-light tall things above the dock-level treeline shadow
    get sunOpenIntensity() {
      return keyOpenIntensity;
    },
    sunOccluder,
    // skyline elevation (radians above the eye's horizontal) at azimuth atan2(x, -z)
    skylineElevationAt: (az) => (Number.isFinite(az) ? skylineAt(az) : 0),
    // Scenery hands over the skyline of what it built: { bins, elevation: Float32Array } with
    // bin k covering azimuths [-pi + 2 pi k / bins, ...). Resampled to SKY_BINS if needed.
    setSkylineProfile(p) {
      const src = p && p.elevation;
      if (!src || !src.length) return;
      const n = src.length;
      const dsrc = p.distance && p.distance.length === n ? p.distance : null;
      const out = new Float32Array(SKY_BINS);
      const outD = new Float32Array(SKY_BINS);
      for (let k = 0; k < SKY_BINS; k++) {
        const s = Math.min(n - 1, Math.floor(((k + 0.5) / SKY_BINS) * n));
        const v = src[s];
        out[k] = Number.isFinite(v) ? v : -Math.PI / 2;
        const d = dsrc ? dsrc[s] : 1000;
        outD[k] = Number.isFinite(d) && d > 1 ? d : 1000;
      }
      skyProfile = out;
      skyProfileD = outD;
      if (Number.isFinite(currentHours)) applyTime(currentHours);
    },
    terrain,
    stats: null,
    dispose() {
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      for (const m of terrain.meshes) scene.remove(m);
      scene.onBeforeRender = prevSceneBeforeRender;
      scene.remove(skySys.group, mist.group, sunLight, sunLight.target, hemiLight);
      terrain.dispose();
      skySys.dispose();
      mist.dispose();
      depthMap.texture.dispose();
      detailRT.dispose();
      cloudRT.dispose();
      cubeRT.dispose();
      if (envRT) envRT.dispose();
      pmrem.dispose();
      ground.geometry.dispose();
      groundMat.dispose();
      if (scene.environment === api.envMap) scene.environment = null;
      if (scene.fog === fog) scene.fog = null;
    },
  };

  // Render-target contents do not survive a WebGL context loss: re-bake them on restore.
  const onContextRestored = () => {
    bakeDetailTexture(renderer, quality, detailRT);
    bakeCloudNoise(renderer, cloudRT);
    bakeEnvironment();
  };
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

  applyTime(DAY.startHours);
  bakeEnvironment();
  update({ dt: 0, time: 0, camera });
  api.stats = {
    initMs: Math.round(performance.now() - tStart),
    terrainBuildMs: Math.round(terrain.buildMs),
    sdfMs: Math.round(field.buildMs),
    terrainTriangles: terrain.triangles,
    get terrain() {
      return terrain.stats();
    },
    get envBakes() {
      return bakeCount;
    },
  };
  return api;
}
