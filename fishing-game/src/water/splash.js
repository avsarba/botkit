// Splash spray: a CPU-simulated particle pool (gravity, size-dependent air drag)
// drawn in one instanced draw call. Drops are camera-facing quads stretched along
// their screen-space velocity, so fast spray reads as the streaks the eye sees;
// clumps of drops and churned white water use soft round puffs. Lit by the sun and
// sky (white multiple-scattering water, bright rims when back-lit, sun twinkles).
import * as THREE from 'three';
import { G, WATER_LEVEL } from '../config.js';

const vert = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iData; // size m, alpha, soft (0|1), seed
uniform float uScale;  // pixels per meter at 1 m distance
uniform float uStreak; // seconds of motion smeared into a streak
uniform vec3 uSunDir;
varying vec2 vCorner;
varying float vAlpha;
varying float vSoft;
varying float vSeed;
varying float vForward;
varying float vTail;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 c = viewMatrix * vec4(iPos, 1.0);
  float depth = max(-c.z, 0.05);
  float size = iData.x;
  float a = iData.y;
  float soft = iData.z;
  // keep coverage when a drop is thinner than ~1.5 px instead of letting it vanish
  float px = size * uScale / depth;
  if (px < 1.5) { a *= sqrt(px / 1.5); size *= 1.5 / px; }
  vec3 viewDir = normalize(c.xyz);
  vec3 v = (viewMatrix * vec4(iVel, 0.0)).xyz * (uStreak * (1.0 - soft));
  v -= viewDir * dot(v, viewDir);
  float len = length(v);
  vec3 along = len > 1e-5 ? v / len : vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(along, viewDir));
  float hw = 0.5 * size;
  float t = position.y * 0.5 + 0.5; // 0 = tail, 1 = head
  vec3 p = c.xyz + side * (position.x * hw) + along * mix(-len - hw, hw, t);
  vCorner = position.xy;
  vTail = t;
  // each particle stands for a clump of drops: smearing thins it, but only a little
  vAlpha = a * mix(1.0, size / (size + len), 0.4);
  vSoft = soft;
  vSeed = iData.w;
  vForward = max(dot(normalize(iPos - cameraPosition), uSunDir), 0.0);
  vec4 mvPosition = vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
uniform vec3 uSunRad;
uniform vec3 uAmbient;
uniform vec3 uWhite;   // radiance of white water / foam under the current light
uniform float uTime;
varying vec2 vCorner;
varying float vAlpha;
varying float vSoft;
varying float vSeed;
varying float vForward;
varying float vTail;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float shape;
  if (vSoft > 0.5) {
    float r2 = dot(vCorner, vCorner);
    if (r2 > 1.0) discard;
    shape = (1.0 - r2) * (1.0 - r2);
  } else {
    float across = 1.0 - smoothstep(0.35, 1.0, abs(vCorner.x));
    shape = across * mix(0.35, 1.0, vTail) * smoothstep(0.0, 0.25, vTail) * (1.0 - smoothstep(0.88, 1.0, vTail) * 0.6);
  }
  float fwd = pow(vForward, 6.0);
  float tw = pow(fract(sin(vSeed * 91.7 + floor(uTime * 24.0 + vSeed * 13.0) * 7.31) * 43758.5), 24.0);
  // Drops scatter light many times and read as white water; they also mirror
  // the sky and flare when the sun is behind them.
  vec3 col = vSoft > 0.5 ? uWhite * 1.05 + uSunRad * 0.08 * fwd
                         : uWhite * 1.3 + uAmbient * 0.25 + uSunRad * (0.8 * fwd + 1.2 * tw);
  gl_FragColor = vec4(col, clamp(vAlpha * shape, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export function createSplashSystem({ scene, maxParticles = 900, getHeight }) {
  const N = maxParticles;
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const data = new Float32Array(N * 4);
  const age = new Float32Array(N);
  const life = new Float32Array(N);
  const baseSize = new Float32Array(N);
  const baseAlpha = new Float32Array(N);
  const drag = new Float32Array(N);
  const grav = new Float32Array(N);
  let alive = 0;
  let cap = N;
  let seedCounter = 1;

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const posAttr = new THREE.InstancedBufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const velAttr = new THREE.InstancedBufferAttribute(vel, 3).setUsage(THREE.DynamicDrawUsage);
  const dataAttr = new THREE.InstancedBufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iPos', posAttr);
  geometry.setAttribute('iVel', velAttr);
  geometry.setAttribute('iData', dataAttr);
  geometry.instanceCount = 0;
  const attrs = [posAttr, velAttr, dataAttr];
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uScale: { value: 500 },
    uStreak: { value: 1 / 30 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunRad: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.5, 0.6, 0.7) },
    uWhite: { value: new THREE.Color(0.4, 0.4, 0.4) },
    uTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'WaterSplash',
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  const object = new THREE.Mesh(geometry, material);
  object.name = 'water-splash';
  object.frustumCulled = false;
  object.renderOrder = 20; // after the water surface
  object.visible = false;
  scene.add(object);

  function spawn(x, y, z, vx, vy, vz, size, lifeS, soft, alpha) {
    if (alive >= cap) return;
    const i = alive++;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    vel[i * 3] = vx;
    vel[i * 3 + 1] = vy;
    vel[i * 3 + 2] = vz;
    age[i] = 0;
    life[i] = lifeS;
    baseSize[i] = size;
    baseAlpha[i] = alpha;
    // small drops slow down quicker; mist and white water are carried by the air
    drag[i] = soft ? 2.6 : 0.12 + 0.0009 / Math.max(size, 0.002);
    grav[i] = soft ? 0.12 : 1;
    data[i * 4] = size;
    data[i * 4 + 1] = alpha;
    data[i * 4 + 2] = soft ? 1 : 0;
    data[i * 4 + 3] = (seedCounter = (seedCounter * 16807) % 2147483647) / 2147483647;
  }

  function kill(i) {
    const j = --alive;
    if (i === j) return;
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = pos[j * 3 + k];
      vel[i * 3 + k] = vel[j * 3 + k];
    }
    for (let k = 0; k < 4; k++) data[i * 4 + k] = data[j * 4 + k];
    age[i] = age[j];
    life[i] = life[j];
    baseSize[i] = baseSize[j];
    baseAlpha[i] = baseAlpha[j];
    drag[i] = drag[j];
    grav[i] = grav[j];
  }

  let rngState = 987654321;
  const rnd = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  // Emit a splash of the given size (0 = a drip, 1 = a big fish crashing back in).
  function burst(px, py, pz, size01, opts = {}) {
    const s = Math.min(Math.max(size01, 0), 1);
    const q = opts.quality === 'low' ? 0.4 : opts.quality === 'medium' ? 0.65 : 1;
    const dirX = opts.dirX || 0;
    const dirZ = opts.dirZ || 0;
    const baseY = Math.max(py, WATER_LEVEL - 0.05) + 0.01;

    // Worthington jet: a column of drops thrown nearly straight up.
    const jet = Math.round((5 + 30 * s) * q);
    for (let i = 0; i < jet; i++) {
      const up = (1.0 + 2.8 * s) * (0.55 + 0.6 * rnd());
      const a = rnd() * Math.PI * 2;
      const side = (0.05 + 0.35 * s) * rnd();
      spawn(px, baseY, pz, Math.cos(a) * side + dirX * 0.3, up, Math.sin(a) * side + dirZ * 0.3,
        0.005 + 0.012 * rnd() * (0.5 + s), 3, false, 0.9);
    }
    // Drops thrown outward (topwater spits are thrown along dirX/dirZ).
    const drops = Math.round((8 + 120 * s * s) * q);
    for (let i = 0; i < drops; i++) {
      const a = rnd() * Math.PI * 2;
      const out = (0.25 + 1.9 * s) * (0.3 + rnd());
      const up = (0.5 + 2.8 * s) * (0.35 + 0.8 * rnd());
      spawn(px + Math.cos(a) * 0.04, baseY, pz + Math.sin(a) * 0.04,
        Math.cos(a) * out + dirX * 1.2, up, Math.sin(a) * out + dirZ * 1.2,
        0.004 + 0.01 * rnd() * (0.4 + s), 3, false, 0.85);
    }
    if (s > 0.42) {
      // Crown: a ring sheet that breaks into drops, launched up and out. Each
      // particle stands for a sheet fragment (a few cm), so the crown reads as a
      // white wall at 8-15 m instead of sub-pixel dashes.
      const crown = Math.round((90 + 260 * (s - 0.42)) * q);
      const r0 = 0.08 + 0.22 * s;
      for (let i = 0; i < crown; i++) {
        const a = (i / crown) * Math.PI * 2 + rnd() * 0.15;
        const out = (0.9 + 1.7 * s) * (0.7 + 0.5 * rnd());
        const up = (1.5 + 2.6 * s) * (0.6 + 0.55 * rnd());
        spawn(px + Math.cos(a) * r0, baseY, pz + Math.sin(a) * r0, Math.cos(a) * out, up, Math.sin(a) * out,
          (0.02 + 0.04 * s) * (0.55 + 0.6 * rnd()), 3, false, 0.85);
      }
      // white water churned up at the impact point: a column that rises, spreads and
      // hangs for most of a second; and a little mist
      const churn = Math.round((5 + 10 * s) * q);
      for (let i = 0; i < churn; i++) {
        const a = rnd() * Math.PI * 2;
        const out = 0.2 + 0.55 * rnd();
        spawn(px + Math.cos(a) * 0.12 * rnd(), baseY + 0.03, pz + Math.sin(a) * 0.12 * rnd(),
          Math.cos(a) * out, 0.4 + 1.5 * rnd() * s, Math.sin(a) * out,
          (0.12 + 0.26 * s) * (0.6 + 0.6 * rnd()), 0.6 + 0.5 * rnd(), true, 0.55);
      }
      const mist = Math.round((3 + 6 * s) * q);
      for (let i = 0; i < mist; i++) {
        const a = rnd() * Math.PI * 2;
        const out = 0.3 + 0.8 * rnd();
        spawn(px + Math.cos(a) * 0.1, baseY + 0.1 + 0.3 * rnd() * s, pz + Math.sin(a) * 0.1,
          Math.cos(a) * out, 0.5 + 1.2 * rnd() * s, Math.sin(a) * out,
          0.16 + 0.22 * s * rnd(), 0.6 + 0.5 * rnd(), true, 0.14);
      }
    }
  }

  function update(dt, cameraProjScale, time) {
    const d = Math.min(dt, 0.05);
    for (let i = alive - 1; i >= 0; i--) {
      age[i] += d;
      const o = i * 3;
      const soft = data[i * 4 + 2] > 0.5;
      const k = Math.exp(-drag[i] * d);
      vel[o] *= k;
      vel[o + 2] *= k;
      vel[o + 1] = vel[o + 1] * k - G * grav[i] * d;
      pos[o] += vel[o] * d;
      pos[o + 1] += vel[o + 1] * d;
      pos[o + 2] += vel[o + 2] * d;
      const t = age[i] / life[i];
      if (soft) {
        data[i * 4] = baseSize[i] * (1 + 1.6 * t);
        data[i * 4 + 1] = baseAlpha[i] * (1 - t) * (1 - t);
        if (t >= 1) kill(i);
      } else {
        // drops vanish when they fall back into the lake (waves are only a few cm)
        let under = false;
        if (vel[o + 1] < 0 && pos[o + 1] < WATER_LEVEL + 0.08) {
          under = pos[o + 1] < (getHeight ? getHeight(pos[o], pos[o + 2]) : WATER_LEVEL);
        }
        if (under || t >= 1 || !Number.isFinite(pos[o + 1])) kill(i);
      }
    }
    geometry.instanceCount = alive;
    object.visible = alive > 0;
    if (alive > 0) {
      for (let k = 0; k < attrs.length; k++) {
        const a = attrs[k];
        a.clearUpdateRanges();
        a.addUpdateRange(0, alive * a.itemSize);
        a.needsUpdate = true;
      }
    }
    uniforms.uScale.value = cameraProjScale;
    uniforms.uTime.value = time % 1000;
  }

  function setCapacity(n) {
    cap = Math.max(16, Math.min(N, n | 0));
    while (alive > cap) kill(alive - 1);
  }

  return {
    object,
    uniforms,
    burst,
    update,
    setCapacity,
    get alive() {
      return alive;
    },
    dispose() {
      scene.remove(object);
      geometry.dispose();
      material.dispose();
    },
  };
}
