// Boreal forest around the lake.
//  - near (< detailR from the dock): instanced 3D trees (spruce/fir, white/red pine, paper birch)
//    chunked by azimuth sector and distance band so off-screen chunks are frustum culled
//  - farther: billboards facing the dock (the viewpoint never leaves it), whose color + normal
//    atlas is rendered once at startup from the same 3D trees, so both LODs match
//  - a continuous canopy shell over all land (dark lumpy forest on every hill) plus sparse
//    spires poking through it for a ragged skyline
//  - two distant ridge silhouettes with a tree-line edge and aerial perspective
import * as THREE from 'three';
import { makeRng, clamp, smoothstep, DOCK } from '../config.js';
import { makeTreeAtlas, buildSpruce, buildPine, buildBirch, REF, builderExtents } from './trees.js';
import { patchMaterial } from './shaderlib.js';
import { makeNoise2, fbm2 } from './noise.js';
import { dataTexture } from './texutil.js';

const QUALITY = {
  high: { detailR: 110, sectors: 6, band: 1.0, interior: 0.55, far: 0.24, shellAz: 420, shellGrowth: 1.03, shellR1: 2300, spireP: 0.5, skylineAz: 2400, ridges: 2 },
  medium: { detailR: 90, sectors: 6, band: 0.85, interior: 0.45, far: 0.18, shellAz: 330, shellGrowth: 1.036, shellR1: 2100, spireP: 0.2, skylineAz: 1500, ridges: 2 },
  low: { detailR: 60, sectors: 4, band: 0.65, interior: 0.3, far: 0.12, shellAz: 240, shellGrowth: 1.045, shellR1: 1800, spireP: 0.12, skylineAz: 800, ridges: 1 },
};

// species: near-geometry variants and impostor templates (seeds)
const SPECIES = [
  { id: 'spruceW', ref: REF.spruce, h: [13, 25], build: (s) => buildSpruce(s, 'white'), near: [11, 12], tpl: [11, 12, 13, 14] },
  { id: 'fir', ref: REF.spruce, h: [12, 21], build: (s) => buildSpruce(s, 'fir'), near: [21], tpl: [21, 22, 23] },
  { id: 'spruceB', ref: REF.spruce, h: [10, 18], build: (s) => buildSpruce(s, 'black'), near: [31], tpl: [31, 32, 33] },
  { id: 'pineW', ref: REF.pine, h: [20, 30], build: (s) => buildPine(s, 'white'), near: [41], tpl: [41, 42, 43] },
  { id: 'pineR', ref: REF.pine, h: [17, 27], build: (s) => buildPine(s, 'red'), near: [51], tpl: [51, 52] },
  { id: 'birch', ref: REF.birch, h: [11, 19], build: (s) => buildBirch(s), near: [61, 64], tpl: [61, 62, 63, 64] },
];

const CAP = { size: 1024, cw: 128, ch: 256 };

// Render albedo (sqrt-encoded) and crown normals of each template into a two-attachment
// render target (one pass, one depth buffer).
function captureImpostors(renderer, templates, atlas) {
  const rt = new THREE.WebGLRenderTarget(CAP.size, CAP.size, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    count: 2,
  });
  for (const t of rt.textures) {
    t.generateMipmaps = true;
    t.anisotropy = 4;
  }
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { map: { value: atlas } },
    vertexShader: `
      out vec2 vUv; out vec3 vCol; out vec3 vN;
      void main() {
        vUv = uv;
        #ifdef USE_COLOR
        vCol = color;
        #else
        vCol = vec3(1.0);
        #endif
        vN = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D map;
      in vec2 vUv; in vec3 vCol; in vec3 vN;
      layout(location = 0) out vec4 gAlbedo;
      layout(location = 1) out vec4 gNormal;
      void main() {
        vec4 t = texture(map, vUv);
        if (t.a < 0.3) discard;
        gAlbedo = vec4(sqrt(max(t.rgb * vCol, 0.0)), 1.0);
        gNormal = vec4(normalize(vN) * 0.5 + 0.5, 1.0);
      }`,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  // clear pass: albedo -> average foliage color (no dark mip fringes), normal -> facing
  const clearMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uAvg: { value: new THREE.Vector3() } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy * 2.0, 0.999, 1.0); }',
    fragmentShader: `uniform vec3 uAvg;
      layout(location = 0) out vec4 gAlbedo;
      layout(location = 1) out vec4 gNormal;
      void main() { gAlbedo = vec4(uAvg, 0.0); gNormal = vec4(0.5, 0.5, 1.0, 0.0); }`,
    depthWrite: false,
    depthTest: false,
  });
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(templates[0].geometry, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const clearScene = new THREE.Scene();
  const clearQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), clearMat);
  clearQuad.frustumCulled = false;
  clearScene.add(clearQuad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  cam.position.set(0, 0, 200);
  cam.lookAt(0, 0, 0);
  const prevRT = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  const cols = CAP.size / CAP.cw;
  templates.forEach((t, i) => {
    const cx = (i % cols) * CAP.cw;
    const cy = Math.floor(i / cols) * CAP.ch;
    const span = Math.max(t.height + 0.7, t.halfWidth * 4.1);
    t.span = span;
    t.w = span / 2;
    t.h = span;
    t.y0 = t.height + 0.1 - span;
    t.cell = [cx / CAP.size, cy / CAP.size, CAP.cw / CAP.size, CAP.ch / CAP.size];
    cam.left = -span / 4;
    cam.right = span / 4;
    cam.top = t.height + 0.1;
    cam.bottom = t.height + 0.1 - span;
    cam.updateProjectionMatrix();
    rt.viewport.set(cx, cy, CAP.cw, CAP.ch);
    rt.scissor.set(cx, cy, CAP.cw, CAP.ch);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    renderer.autoClear = false;
    renderer.clearDepth();
    clearMat.uniforms.uAvg.value.set(t.avg[0], t.avg[1], t.avg[2]);
    renderer.render(clearScene, cam);
    mesh.geometry = t.geometry;
    renderer.render(scene, cam);
  });
  rt.scissorTest = false;
  renderer.setRenderTarget(prevRT);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.autoUpdate = prevShadow;
  mat.dispose();
  clearMat.dispose();
  clearQuad.geometry.dispose();
  return { rt, albedo: rt.textures[0], normal: rt.textures[1] };
}

export function buildForest({ env, quality, renderer, shared, grid, culler }) {
  const Q = QUALITY[quality] || QUALITY.high;
  const group = new THREE.Group();
  group.name = 'forest';
  const rng = makeRng(777);
  const noise = makeNoise2(778);
  const T = { t0: performance.now() };
  const lap = (k) => {
    const now = performance.now();
    T[k] = Math.round(now - T.t0);
    T.t0 = now;
  };
  const atlas = makeTreeAtlas();
  lap('atlas');

  // ---------- geometry: near variants + impostor templates
  const nearGeos = []; // { sp, geometry }
  const templates = []; // { sp, geometry, halfWidth, height, avg }
  const tplBySpecies = new Map();
  const nearBySpecies = new Map();
  const conifAvg = [0.13, 0.18, 0.15]; // sqrt-encoded like the captured albedo
  const birchAvg = [0.24, 0.33, 0.17];
  for (const sp of SPECIES) {
    const tl = [];
    for (const seed of sp.tpl) {
      const B = sp.build(seed);
      const ext = builderExtents(B);
      const geometry = B.build();
      const t = { sp, geometry, halfWidth: ext.halfWidth, height: ext.height, avg: sp.id === 'birch' ? birchAvg : conifAvg, seed };
      templates.push(t);
      tl.push(t);
      if (sp.near.includes(seed)) {
        const ng = { sp, geometry, index: nearGeos.length };
        nearGeos.push(ng);
        if (!nearBySpecies.has(sp.id)) nearBySpecies.set(sp.id, []);
        nearBySpecies.get(sp.id).push(ng);
      }
    }
    tplBySpecies.set(sp.id, tl);
  }
  lap('treeGeo');
  const imp = captureImpostors(renderer, templates, atlas);
  lap('capture');
  // template geometries not used as near variants are no longer needed
  for (const t of templates) if (!nearGeos.some((g) => g.geometry === t.geometry)) t.geometry.dispose();

  // ---------- materials
  const nearMat = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true });
  nearMat.name = 'scenery.trees';
  patchMaterial(nearMat, shared, { sway: { amp: 0.35, freq: 0.9, wave: 0.03, invH: 1 / 20, flutter: 0.05 }, noFlip: true, alphaMip: 0.5, transl: 0.22, wrap: 0.22 });
  const impMat = new THREE.MeshLambertMaterial({ map: imp.albedo, alphaTest: 0.45, side: THREE.DoubleSide });
  impMat.name = 'scenery.impostors';
  patchMaterial(impMat, shared, { impostor: true, alphaMip: 0.7, transl: 0.18, wrap: 0.22, extraUniforms: { uImpNormal: { value: imp.normal } } });

  // ---------- placement
  const S = Q.sectors;
  const sectorOf = (x, z) => {
    const az = Math.atan2(x, -z); // 0 = straight out over the lake, +pi/2 = right
    return Math.min(S - 1, Math.floor(((az + Math.PI) / (Math.PI * 2)) * S));
  };
  const near = new Map(); // key `${geoIndex}|${chunk}` -> [inst]
  const far = []; // per sector list
  for (let i = 0; i < S; i++) far.push([]);
  const habitatCache = new Map();
  const rockAt = (x, z) => {
    const w = grid.nearestWater(x, z, _w);
    if (!w) return 0;
    const key = w.x * 10000 + w.z;
    let v = habitatCache.get(key);
    if (v === undefined) {
      const hb = env.getHabitat ? env.getHabitat(w.x, w.z) : null;
      v = hb && Number.isFinite(hb.rocks) ? hb.rocks : 0;
      habitatCache.set(key, v);
    }
    return v;
  };
  const _w = { x: 0, z: 0 };
  const pickSpecies = (d, rock, R) => {
    const r = rng();
    if (d < 9) {
      if (rock > 0.5) return r < 0.4 ? 'pineR' : r < 0.6 ? 'pineW' : r < 0.8 ? 'spruceW' : 'birch';
      return r < 0.42 ? 'birch' : r < 0.62 ? 'spruceW' : r < 0.74 ? 'fir' : r < 0.82 ? 'spruceB' : r < 0.93 ? 'pineW' : 'pineR';
    }
    if (rock > 0.5) return r < 0.35 ? 'pineR' : r < 0.55 ? 'pineW' : r < 0.8 ? 'spruceB' : 'spruceW';
    return r < 0.3 ? 'spruceW' : r < 0.47 ? 'fir' : r < 0.58 ? 'spruceB' : r < 0.72 ? 'pineW' : r < 0.8 ? 'pineR' : 'birch';
  };
  const addTree = (spId, x, z, yBase, height, lean, leanDir, forceFar = false) => {
    const sp = SPECIES.find((s) => s.id === spId);
    const R = Math.hypot(x, z);
    const az = Math.atan2(x, -z);
    const back = Math.abs(az) > Math.PI * 0.82;
    const s = height / sp.ref;
    const yaw = rng() * Math.PI * 2;
    const tint = spId === 'birch' ? [0.92 + rng() * 0.16, 0.92 + rng() * 0.14, 0.85 + rng() * 0.18] : [0.84 + rng() * 0.2, 0.88 + rng() * 0.18, 0.86 + rng() * 0.2];
    if (!forceFar && R < Q.detailR && !back) {
      const list = nearBySpecies.get(spId);
      const g = list[Math.floor(rng() * list.length)];
      const chunk = sectorOf(x, z) * 2 + (R < 60 ? 0 : 1);
      const key = `${g.index}|${chunk}`;
      if (!near.has(key)) near.set(key, []);
      near.get(key).push({ x, y: yBase, z, s, yaw, lean, leanDir, tint });
    } else {
      const tl = tplBySpecies.get(spId);
      const t = tl[Math.floor(rng() * tl.length)];
      far[sectorOf(x, z)].push({ x, y: yBase, z, s, t, tint });
    }
  };

  const { n, half, cell, h, dist } = grid;
  const exactH = (x, z) => {
    const v = env.getTerrainHeight(x, z);
    return Number.isFinite(v) ? v : grid.heightAt(x, z);
  };
  const clearing = (x, z) => {
    // mowed clearing where the dock meets land
    const cx = Math.max(0, Math.abs(x) - 7);
    const cz = z < DOCK.shoreZ - 12 ? DOCK.shoreZ - 12 - z : z > DOCK.shoreZ + 28 ? z - DOCK.shoreZ - 28 : 0;
    return smoothstep(0, 10, Math.hypot(cx, cz));
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (h[k] < 0.3) continue;
      const d = dist[k];
      if (d < 2.2) continue;
      const x = -half + i * cell + (rng() - 0.5) * cell * 0.9;
      const z = -half + j * cell + (rng() - 0.5) * cell * 0.9;
      const R = Math.hypot(x, z);
      let p = d < 60 ? Q.band : R < Q.detailR ? Q.interior : Q.far;
      p *= clearing(x, z);
      if (p <= 0) continue;
      const slope = grid.slopeAt(x, z);
      p *= 1 - 0.75 * smoothstep(0.7, 1.3, slope);
      const rock = d < 80 ? rockAt(x, z) : 0;
      p *= 1 - 0.65 * rock * (1 - smoothstep(25, 80, d));
      // clumpy stands and gaps
      p *= clamp(0.75 + fbm2(noise, x * 0.02, z * 0.02, 3) * 1.1, 0.15, 1.2);
      if (rng() > p) continue;
      const spId = pickSpecies(d, rock, R);
      const sp = SPECIES.find((s) => s.id === spId);
      let height = sp.h[0] + (sp.h[1] - sp.h[0]) * Math.pow(rng(), 0.8);
      if (d < 6) height *= 0.85;
      // near trees stand on the exact terrain; far ones can use the sampled grid
      const hAt = R < Q.detailR + 10 ? exactH : grid.heightAt;
      if (hAt(x, z) < 0.3) continue; // the jittered spot slipped into the water
      const yBase = Math.min(hAt(x - 0.6, z), hAt(x + 0.6, z), hAt(x, z - 0.6), hAt(x, z + 0.6)) - 0.2;
      let lean = 0;
      let leanDir = 0;
      if (d < 10) {
        const w = grid.nearestWater(x, z, _w);
        if (w) {
          leanDir = Math.atan2(w.x - x, w.z - z);
          lean = (spId === 'birch' ? 0.1 : 0.04) * rng() * (1 - d / 10);
        }
      }
      addTree(spId, x, z, yBase, height, lean, leanDir);
    }
  }

  lap('placement');
  // ---------- canopy shell (+ spires beyond the placement grid)
  const shellMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  shellMat.name = 'scenery.canopy';
  patchMaterial(shellMat, shared, {
    fragColor: `{
      float dist = length(vViewPosition);
      float nA = sFbm3(vSWorld * 0.045);
      // crown-sized stipple: dark gaps between lit crowns, reads as individual trees far away
      float st = sNoise3(vSWorld * vec3(0.3, 0.16, 0.3));
      float st2 = sNoise3(vSWorld * vec3(0.75, 0.4, 0.75));
      float fine = 1.0 - smoothstep(1500.0, 2600.0, dist);
      diffuseColor.rgb *= (0.6 + 0.6 * nA) * mix(0.85, 0.3 + 1.2 * st * st * (0.7 + 0.6 * st2), fine);
    }`,
    bump: `(sNoise3(vSWorld * vec3(0.16, 0.1, 0.16)) * 3.2 + sNoise3(vSWorld * 0.55) * 0.9 * (1.0 - smoothstep(150.0, 450.0, length(vViewPosition)))) * (1.0 - smoothstep(600.0, 1400.0, length(vViewPosition)))`,
  });
  const shellMeshes = buildShell();
  for (const m of shellMeshes) group.add(m);
  lap('shell');

  function canopyAt(x, z, hh, R) {
    if (hh < 0.3) return 0;
    let d = grid.inside(x, z) ? grid.distAt(x, z) : 1e4;
    if (d < 3) return 0;
    // low understory right at the edge, full canopy well back from the water, so the edge trees
    // (impostors / 3D) form the skyline in front of it
    const edge = smoothstep(2.5, 6, d) * (0.35 + 0.65 * smoothstep(8, 55, d));
    let c = 14.5 + fbm2(noise, x * 0.008, z * 0.008, 3) * 6;
    // understory near the dock (the 3D trees stand in it)
    const under = 1.3 + 0.9 * fbm2(noise, x * 0.09 + 3, z * 0.09, 2);
    c = c * smoothstep(Q.detailR - 30, Q.detailR + 25, R) + under * (1 - smoothstep(Q.detailR - 30, Q.detailR + 25, R));
    const slope = grid.inside(x, z) ? grid.slopeAt(x, z) : 0.3;
    c *= 1 - 0.85 * smoothstep(0.9, 1.5, slope);
    c *= clearing(x, z);
    return c * edge;
  }

  function buildShell() {
    const AZ = Q.shellAz;
    const radii = [];
    for (let r = 38; r < Q.shellR1; r *= Q.shellGrowth) radii.push(r);
    const NR = radii.length;
    const ys = new Float32Array(NR * AZ);
    const cs = new Float32Array(NR * AZ);
    const xs = new Float32Array(NR * AZ);
    const zs = new Float32Array(NR * AZ);
    const col = new Float32Array(NR * AZ * 3);
    const cDark = new THREE.Color().setRGB(30 / 255, 45 / 255, 36 / 255, THREE.SRGBColorSpace);
    const cMid = new THREE.Color().setRGB(38 / 255, 54 / 255, 40 / 255, THREE.SRGBColorSpace);
    const cDecid = new THREE.Color().setRGB(58 / 255, 76 / 255, 42 / 255, THREE.SRGBColorSpace);
    const cShrub = new THREE.Color().setRGB(76 / 255, 98 / 255, 50 / 255, THREE.SRGBColorSpace);
    const tmp = new THREE.Color();
    for (let ri = 0; ri < NR; ri++) {
      const R = radii[ri];
      for (let a = 0; a < AZ; a++) {
        const th = (a / AZ) * Math.PI * 2;
        const x = Math.sin(th) * R;
        const z = -Math.cos(th) * R;
        const hh = grid.heightAt(x, z);
        const c = canopyAt(x, z, hh, R);
        const k = ri * AZ + a;
        xs[k] = x;
        zs[k] = z;
        cs[k] = c;
        ys[k] = c > 0.3 ? hh + c : Math.min(hh, 0) - 1.0;
        const dn = fbm2(noise, x * 0.004 + 9, z * 0.004, 3);
        tmp.copy(cDark).lerp(cMid, clamp(0.5 + dn * 1.5, 0, 1));
        const decid = smoothstep(0.18, 0.4, fbm2(noise, x * 0.012 + 4, z * 0.012 - 2, 3));
        tmp.lerp(cDecid, decid * 0.7);
        // alder / dogwood / sweet-gale shrubs along the water's edge are lighter and warmer
        if (c > 0.3 && grid.inside(x, z)) {
          const dw = grid.distAt(x, z);
          if (dw < 22) tmp.lerp(cShrub, (1 - smoothstep(6, 22, dw)) * 0.75);
        }
        col[k * 3] = tmp.r;
        col[k * 3 + 1] = tmp.g;
        col[k * 3 + 2] = tmp.b;
        // spires poking through the canopy beyond the placement grid
        if (!grid.inside(x, z) && c > 8 && rng() < Q.spireP * (R / 1000)) {
          const spId = rng() < 0.7 ? 'spruceW' : rng() < 0.5 ? 'fir' : 'pineW';
          const sp = SPECIES.find((s) => s.id === spId);
          addTree(spId, x + (rng() - 0.5) * 8, z + (rng() - 0.5) * 8, hh - 0.3, Math.max(sp.h[0], c + 4 + rng() * 6), 0, 0, true);
        }
      }
    }
    // Serrated tree-line on every visible ridge: march each azimuth outward from the dock and
    // put conifer spires where the canopy top forms a silhouette (a local maximum of elevation
    // angle that is not hidden by anything nearer).
    const eyeY = DOCK.deckY + 1.65;
    const SKY_AZ = Q.skylineAz;
    for (let sa = 0; sa < SKY_AZ; sa++) {
      const th = ((sa + rng()) / SKY_AZ) * Math.PI * 2;
      const az = th > Math.PI ? th - Math.PI * 2 : th;
      if (Math.abs(az) > 2.6) continue; // never seen behind the dock
      const sx = Math.sin(th);
      const sz = -Math.cos(th);
      let best = -Infinity;
      let prev = -Infinity;
      let prevR = 0;
      let prevH = 0;
      let rising = false;
      for (let R = Q.detailR + 40; R < Q.shellR1; R *= 1.012) {
        const x = sx * R;
        const z = sz * R;
        const hh = grid.heightAt(x, z);
        const c = canopyAt(x, z, hh, R);
        const top = hh + (c > 0.3 ? c : 0);
        const el = (top - eyeY) / R;
        if (el < prev && rising && prev >= best - 1e-4 && prevH > 0.3) {
          // silhouette at the previous sample: a few spires around it
          const n = 1 + (rng() < 0.6 ? 1 : 0);
          for (let k = 0; k < n; k++) {
            const r = prevR * (1 - rng() * 0.012);
            const jx = sx * r + (rng() - 0.5) * 6;
            const jz = sz * r + (rng() - 0.5) * 6;
            const hb = grid.heightAt(jx, jz);
            const cc = canopyAt(jx, jz, hb, r);
            if (cc < 4) continue;
            const spId = rng() < 0.55 ? 'spruceW' : rng() < 0.6 ? 'fir' : 'spruceB';
            addTree(spId, jx, jz, hb - 0.3, cc + 2 + rng() * 7, 0, 0, true);
          }
        }
        rising = el > prev;
        if (el > best) best = el;
        prev = el;
        prevR = R;
        prevH = c;
      }
    }
    // normals from the whole polar grid (no seams at chunk borders)
    const nrm = new Float32Array(NR * AZ * 3);
    for (let ri = 0; ri < NR; ri++) {
      const r0 = Math.max(0, ri - 1);
      const r1 = Math.min(NR - 1, ri + 1);
      for (let a = 0; a < AZ; a++) {
        const k = ri * AZ + a;
        const ka = ri * AZ + ((a + 1) % AZ);
        const kb = ri * AZ + ((a + AZ - 1) % AZ);
        const kr1 = r1 * AZ + a;
        const kr0 = r0 * AZ + a;
        const tx = xs[ka] - xs[kb];
        const ty = ys[ka] - ys[kb];
        const tz = zs[ka] - zs[kb];
        const rx = xs[kr1] - xs[kr0];
        const ry = ys[kr1] - ys[kr0];
        const rz = zs[kr1] - zs[kr0];
        let nx = ry * tz - rz * ty;
        let ny = rz * tx - rx * tz;
        let nz = rx * ty - ry * tx;
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const l = Math.hypot(nx, ny, nz) || 1;
        nrm[k * 3] = nx / l;
        nrm[k * 3 + 1] = ny / l;
        nrm[k * 3 + 2] = nz / l;
      }
    }
    const meshes = [];
    const perSector = Math.ceil(AZ / S);
    for (let s = 0; s < S; s++) {
      const a0 = s * perSector;
      const a1 = Math.min(AZ, a0 + perSector);
      const pos = [];
      const cl = [];
      const nl = [];
      const idx = [];
      const map = new Int32Array(NR * (a1 - a0 + 1)).fill(-1);
      const vid = (ri, a) => {
        const aa = a % AZ;
        const key = ri * (a1 - a0 + 1) + (a - a0);
        if (map[key] >= 0) return map[key];
        const k = ri * AZ + aa;
        map[key] = pos.length / 3;
        pos.push(xs[k], ys[k], zs[k]);
        cl.push(col[k * 3], col[k * 3 + 1], col[k * 3 + 2]);
        nl.push(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]);
        return map[key];
      };
      for (let ri = 0; ri < NR - 1; ri++) {
        for (let a = a0; a < a1; a++) {
          const k00 = ri * AZ + (a % AZ);
          const k01 = ri * AZ + ((a + 1) % AZ);
          const k10 = (ri + 1) * AZ + (a % AZ);
          const k11 = (ri + 1) * AZ + ((a + 1) % AZ);
          if (cs[k00] <= 0.3 && cs[k01] <= 0.3 && cs[k10] <= 0.3 && cs[k11] <= 0.3) continue;
          const i0 = vid(ri, a);
          const i1 = vid(ri, a + 1);
          const j0 = vid(ri + 1, a);
          const j1 = vid(ri + 1, a + 1);
          idx.push(i0, i1, j0, i1, j1, j0);
        }
      }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nl, 3));
      g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, shellMat);
      m.name = `forest.canopy.${s}`;
      if (culler) culler.add(m, (a0 / AZ) * Math.PI * 2, (a1 / AZ) * Math.PI * 2); // azimuth == th here
      meshes.push(m);
    }
    return meshes;
  }

  // ---------- instanced meshes
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _e = new THREE.Euler();
  const _c = new THREE.Color();
  const _ax = new THREE.Vector3();
  let nearCount = 0;
  for (const [key, list] of near) {
    const gi = Number(key.split('|')[0]);
    const g = nearGeos[gi];
    const mesh = new THREE.InstancedMesh(g.geometry, nearMat, list.length);
    list.forEach((t, i) => {
      _q.setFromEuler(_e.set(0, t.yaw, 0));
      if (t.lean > 0) {
        _ax.set(Math.cos(t.leanDir), 0, -Math.sin(t.leanDir));
        _q2.setFromAxisAngle(_ax, t.lean);
        _q.premultiply(_q2);
      }
      _p.set(t.x, t.y, t.z);
      _s.setScalar(t.s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, _c.setRGB(t.tint[0], t.tint[1], t.tint[2]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `forest.near.${g.sp.id}.${key}`;
    if (culler) culler.addSector(mesh, Math.floor(Number(key.split('|')[1]) / 2), S);
    group.add(mesh);
    nearCount += list.length;
  }
  const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  let farCount = 0;
  far.forEach((list, si) => {
    if (!list.length) return;
    const geo = quad.clone();
    const cells = new Float32Array(list.length * 4);
    const mesh = new THREE.InstancedMesh(geo, impMat, list.length);
    list.forEach((t, i) => {
      const yaw = Math.atan2(-t.x, -t.z);
      _q.setFromEuler(_e.set(0, yaw, 0));
      _p.set(t.x, t.y + t.t.y0 * t.s, t.z);
      _s.set(t.t.w * t.s, t.t.h * t.s, 1);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, _c.setRGB(t.tint[0], t.tint[1], t.tint[2]));
      cells.set(t.t.cell, i * 4);
    });
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 4));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `forest.far.${si}`;
    if (culler) culler.addSector(mesh, si, S);
    group.add(mesh);
    farCount += list.length;
  });
  quad.dispose();

  // ---------- distant ridges
  lap('instancing');
  const ridges = buildRidges();
  for (const r of ridges.meshes) group.add(r);
  lap('ridges');
  delete T.t0;

  function buildRidges() {
    const W = 1024;
    const H = 128;
    // tree-line silhouette: per-column height from overlapping conifer spires (tiles in u)
    const colH = new Float32Array(W);
    let x = 0;
    while (x < W) {
      const hgt = 30 + rng() * 90;
      const wd = hgt * (0.16 + rng() * 0.1);
      for (let dx = -Math.ceil(wd); dx <= Math.ceil(wd); dx++) {
        const t = Math.abs(dx) / wd;
        if (t >= 1) continue;
        const hh = 12 + hgt * (1 - t) * (0.85 + 0.15 * Math.sin(dx * 1.7 + x));
        const cx = (((x + dx) % W) + W) % W;
        if (hh > colH[cx]) colH[cx] = hh;
      }
      x += 3 + rng() * 9;
    }
    const data = new Uint8Array(W * H * 4);
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        const i = (yy * W + xx) * 4;
        const on = yy < 14 || yy < colH[xx] ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = on;
        data[i + 3] = 255;
      }
    }
    const tex = dataTexture(data, W, H, { srgb: false, repeat: true, anisotropy: 4 });
    tex.wrapT = THREE.ClampToEdgeWrapping;
    const layers = [
      { R: 2360, base: 0.5, color: 0x27352c, amp: 110, lift: 45, seed: 3.1 },
      { R: 2470, base: 0.62, color: 0x2e3b36, amp: 150, lift: 70, seed: 7.7 },
    ].slice(0, Q.ridges);
    const meshes = [];
    const hazeUniforms = [];
    for (const L of layers) {
      const AZ = 1440;
      const pos = [];
      const nor = [];
      const uv = [];
      const idx = [];
      const circ = 2 * Math.PI * L.R;
      for (let a = 0; a <= AZ; a++) {
        const th = (a / AZ) * Math.PI * 2;
        const sx = Math.sin(th);
        const sz = -Math.cos(th);
        const x = sx * L.R;
        const z = sz * L.R;
        const ridged = 1 - Math.abs(fbm2(noise, Math.cos(th) * 3 + L.seed, Math.sin(th) * 3 + L.seed, 4));
        const envH = env.getTerrainHeight(x, z);
        const top = Math.max(Number.isFinite(envH) ? envH + 20 : 0, L.lift + ridged * ridged * L.amp);
        const u = ((a / AZ) * circ) / 85;
        const nx = -sx * 0.9;
        const nz = -sz * 0.9;
        const nl = Math.hypot(nx, 0.45, nz);
        // body (opaque rows of the texture) then the tree-line band on top
        const rows = [
          [-60, 0.02],
          [top - 4, 0.05],
          [top + 16, 0.97],
        ];
        for (const [y, v] of rows) {
          pos.push(x, y, z);
          nor.push(nx / nl, 0.45 / nl, nz / nl);
          uv.push(u, v);
        }
      }
      for (let a = 0; a < AZ; a++) {
        const b0 = a * 3;
        const b1 = (a + 1) * 3;
        for (let r = 0; r < 2; r++) idx.push(b0 + r, b0 + r + 1, b1 + r, b1 + r, b0 + r + 1, b1 + r + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const uHaze = { value: L.base };
      hazeUniforms.push({ u: uHaze, base: L.base });
      const mat = new THREE.MeshStandardMaterial({ color: L.color, alphaMap: tex, alphaTest: 0.5, roughness: 1, metalness: 0, fog: false, side: THREE.DoubleSide });
      mat.name = 'scenery.ridge';
      patchMaterial(mat, shared, { haze: true, extraUniforms: { uHaze, uHazeColor: { value: env.horizonColor || new THREE.Color(0xb0c0cc) } } });
      const m = new THREE.Mesh(g, mat);
      m.name = 'forest.ridge';
      m.frustumCulled = false;
      meshes.push(m);
    }
    return { meshes, hazeUniforms, tex };
  }

  function fogAt(scene, d) {
    const f = scene && scene.fog;
    if (!f) return 0;
    if (f.isFogExp2) return 1 - Math.exp(-(f.density * d) * (f.density * d));
    if (f.isFog) return smoothstep(f.near, f.far, d);
    return 0;
  }

  return {
    group,
    stats: { near: nearCount, far: farCount, templates: templates.length, nearDraw: near.size, ms: T },
    impostorTextures: imp,
    update(frame, scene) {
      const k = fogAt(scene, 700);
      for (const h of ridges.hazeUniforms) h.u.value = clamp(1 - (1 - h.base) * (1 - 0.85 * k), 0, 0.97);
    },
  };
}
