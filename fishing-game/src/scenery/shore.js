// Shoreline: cattail / bulrush / sedge clumps (instanced 3D near the dock, painted cards farther),
// lily pads with white water-lilies and yellow pond-lilies in the weedy cove, granite boulders on
// the rocky point (some breaking the surface), the sunken timber tangle and a few fallen logs.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, clamp, smoothstep, LAYERS, DOCK } from '../config.js';
import { MeshBuilder } from './geo.js';
import { makeNoise2, fbm2 } from './noise.js';
import { Raster } from './raster.js';
import { dataTexture, dilateTransparent, normalMapFromHeight } from './texutil.js';
import { patchMaterial } from './shaderlib.js';

const QUALITY = {
  high: { reedNearR: 75, reedNear: 900, reedFarR: 420, reedFar: 3000, pads: 1500, flowers: 34, rocks: 170, farRocks: 260, sectors: 6 },
  medium: { reedNearR: 60, reedNear: 550, reedFarR: 360, reedFar: 2000, pads: 950, flowers: 22, rocks: 110, farRocks: 160, sectors: 6 },
  low: { reedNearR: 45, reedNear: 280, reedFarR: 280, reedFar: 1100, pads: 500, flowers: 12, rocks: 60, farRocks: 80, sectors: 4 },
};

const srgb = (r, g, b) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
const _c = new THREE.Color();

// ---------------------------------------------------------------- reed clump geometry
function blade(B, rng, bx, bz, yaw, height, width, lean, droop, segs, colBase, colMid, colTip, twist = 0) {
  const ox = Math.sin(yaw);
  const oz = Math.cos(yaw);
  const ids = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const out = height * (lean * t + droop * t * t);
    const y = height * t * (1 - droop * 0.35 * t * t);
    const cx = bx + ox * out;
    const cz = bz + oz * out;
    const w = width * (t < 0.08 ? 0.8 + t * 2.5 : 1) * Math.pow(1 - t, 0.7) + 0.0006;
    const tw = twist * t;
    const wx = Math.cos(yaw + tw);
    const wz = -Math.sin(yaw + tw);
    const nx = Math.sin(yaw + tw);
    const nz = Math.cos(yaw + tw);
    const col = t < 0.5 ? _c.copy(colBase).lerp(colMid, t / 0.5) : _c.copy(colMid).lerp(colTip, (t - 0.5) / 0.5);
    for (const side of [-1, 1]) ids.push(B.vert([cx + wx * w * 0.5 * side, y, cz + wz * w * 0.5 * side], [nx * 0.8, 0.45, nz * 0.8], [side < 0 ? 0 : 1, t], [col.r, col.g, col.b]));
  }
  for (let s = 0; s < segs; s++) B.quad(ids[s * 2], ids[s * 2 + 1], ids[s * 2 + 3], ids[s * 2 + 2]);
}

function buildCattailClump(seed) {
  const rng = makeRng(seed);
  const B = new MeshBuilder({ colors: true });
  const n = 16 + Math.floor(rng() * 8);
  const cBase = srgb(58, 52, 30);
  for (let i = 0; i < n; i++) {
    const dry = rng() < 0.1;
    const g = 0.85 + rng() * 0.3;
    const mid = dry ? srgb(150, 132, 88) : srgb(92 * g, 112 * g, 62 * g);
    const tip = dry ? srgb(168, 150, 104) : rng() < 0.5 ? srgb(142, 138, 84) : srgb(104 * g, 122 * g, 70 * g);
    const r = Math.sqrt(rng()) * 0.16;
    const a = rng() * Math.PI * 2;
    blade(B, rng, Math.cos(a) * r, Math.sin(a) * r, a + (rng() - 0.5) * 0.8, 1.3 + rng() * 1.0, 0.018 + rng() * 0.012, 0.04 + rng() * 0.12, 0.08 + rng() * 0.25 + (dry ? 0.3 : 0), 4, cBase, mid, tip, (rng() - 0.5) * 1.2);
  }
  const stalks = 1 + Math.floor(rng() * 3);
  const cHead = srgb(78, 50, 30);
  const cStem = srgb(96, 110, 62);
  for (let i = 0; i < stalks; i++) {
    const a = rng() * Math.PI * 2;
    const r = rng() * 0.1;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const H = 1.6 + rng() * 0.6;
    const lean = (rng() - 0.5) * 0.08;
    // stem: two crossed thin quads
    for (const rot of [0, Math.PI / 2]) {
      const wx = Math.cos(rot) * 0.005;
      const wz = Math.sin(rot) * 0.005;
      const i0 = B.vert([x - wx, 0, z - wz], [Math.sin(rot), 0.3, Math.cos(rot)], [0, 0], [cBase.r, cBase.g, cBase.b]);
      const i1 = B.vert([x + wx, 0, z + wz], [Math.sin(rot), 0.3, Math.cos(rot)], [1, 0], [cBase.r, cBase.g, cBase.b]);
      const i2 = B.vert([x + wx + lean * H, H * 0.95, z + wz], [Math.sin(rot), 0.3, Math.cos(rot)], [1, 1], [cStem.r, cStem.g, cStem.b]);
      const i3 = B.vert([x - wx + lean * H, H * 0.95, z - wz], [Math.sin(rot), 0.3, Math.cos(rot)], [0, 1], [cStem.r, cStem.g, cStem.b]);
      B.quad(i0, i1, i2, i3);
    }
    // brown seed head (the "cattail"), 6-sided
    const y0 = H * 0.66;
    const y1 = H * 0.8;
    const rad = 0.014 + rng() * 0.006;
    const ring0 = [];
    const ring1 = [];
    for (let j = 0; j <= 6; j++) {
      const ang = (j / 6) * Math.PI * 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const k = 0.85 + rng() * 0.2;
      ring0.push(B.vert([x + lean * y0 + c * rad, y0, z + s * rad], [c, 0, s], [j / 6, 0], [cHead.r * k, cHead.g * k, cHead.b * k]));
      ring1.push(B.vert([x + lean * y1 + c * rad * 0.9, y1, z + s * rad * 0.9], [c, 0, s], [j / 6, 1], [cHead.r * 1.1, cHead.g * 1.1, cHead.b * 1.1]));
    }
    for (let j = 0; j < 6; j++) B.quad(ring0[j], ring0[j + 1], ring1[j + 1], ring1[j]);
  }
  return B;
}

function buildBulrushClump(seed) {
  const rng = makeRng(seed);
  const B = new MeshBuilder({ colors: true });
  const n = 26 + Math.floor(rng() * 14);
  const cBase = srgb(56, 50, 30);
  const cTipBrown = srgb(112, 88, 54);
  for (let i = 0; i < n; i++) {
    const g = 0.8 + rng() * 0.35;
    const mid = srgb(62 * g, 88 * g, 46 * g);
    const tip = rng() < 0.35 ? cTipBrown : srgb(76 * g, 98 * g, 54 * g);
    const r = Math.sqrt(rng()) * 0.22;
    const a = rng() * Math.PI * 2;
    // stems face local +z (the clump instance is turned to face the dock)
    blade(B, rng, Math.cos(a) * r, Math.sin(a) * r, 0, 1.1 + rng() * 1.1, 0.011 + rng() * 0.005, (rng() - 0.5) * 0.12, rng() * 0.1, 3, cBase, mid, tip, 0);
  }
  return B;
}

function buildSedgeTuft(seed) {
  const rng = makeRng(seed);
  const B = new MeshBuilder({ colors: true });
  const n = 26 + Math.floor(rng() * 12);
  const cBase = srgb(70, 66, 40);
  for (let i = 0; i < n; i++) {
    const g = 0.85 + rng() * 0.3;
    const mid = srgb(118 * g, 128 * g, 70 * g);
    const tip = rng() < 0.4 ? srgb(160, 146, 96) : srgb(132 * g, 138 * g, 80 * g);
    const a = rng() * Math.PI * 2;
    const r = rng() * 0.08;
    blade(B, rng, Math.cos(a) * r, Math.sin(a) * r, a, 0.45 + rng() * 0.5, 0.008 + rng() * 0.006, 0.12 + rng() * 0.2, 0.25 + rng() * 0.45, 3, cBase, mid, tip, (rng() - 0.5));
  }
  return B;
}

// painted reed stands for far cards: [cattail | bulrush], 512 x 256
function makeReedCardTexture() {
  const W = 512;
  const H = 256;
  const R = new Raster(W, H);
  const rng = makeRng(611);
  for (let v = 0; v < 2; v++) {
    const x0 = v * 256;
    R.clip(x0, 0, 256, 256);
    const n = v === 0 ? 150 : 220;
    for (let i = 0; i < n; i++) {
      const bx = x0 + 10 + rng() * 236;
      const hgt = (0.45 + rng() * 0.5) * H * (1 - Math.abs(bx - x0 - 128) / 300);
      const lean = (rng() - 0.5) * (v === 0 ? 40 : 14);
      const g = 0.75 + rng() * 0.4;
      const dry = rng() < 0.1;
      const cr = dry ? 150 : (v === 0 ? 92 : 62) * g;
      const cg = dry ? 132 : (v === 0 ? 112 : 88) * g;
      const cb = dry ? 88 : (v === 0 ? 62 : 46) * g;
      const steps = 8;
      let px = bx;
      let py = H - 1;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const nx = bx + lean * t * t;
        const ny = H - 1 - hgt * t;
        const k = t < 0.2 ? 0.55 : 1;
        R.line(px, py, nx, ny, (v === 0 ? 2.2 : 1.4) * (1 - t * 0.6), cr * k, cg * k, cb * k);
        px = nx;
        py = ny;
      }
      if (v === 0 && rng() < 0.08) R.ellipse(bx + lean * 0.5, H - 1 - hgt * 0.75, 2.4, 9, 0, 80, 52, 32);
    }
  }
  R.unclip();
  dilateTransparent(R.data, W, H, [0, 0, 256, 256], 6);
  dilateTransparent(R.data, W, H, [256, 0, 256, 256], 6);
  return dataTexture(R.data, W, H, { srgb: true, anisotropy: 4 });
}

// ---------------------------------------------------------------- lily pads + flowers
function makeLilyTexture() {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const n = makeNoise2(707);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S - 0.5;
      const v = (y + 0.5) / S - 0.5;
      const r = Math.hypot(u, v) * 2;
      const ang = Math.atan2(v, u);
      const i = (y * S + x) * 4;
      let a = r < 0.985 ? 1 : 0;
      // notch (V slit to the center) along +x
      if (Math.abs(ang) < 0.07 + (1 - r) * 0.05 && r > 0.05) a = 0;
      // insect holes
      if (n(x * 0.25, y * 0.25) > 0.78) a = 0;
      const vein = Math.pow(Math.abs(Math.sin(ang * 13 + n(x * 0.05, y * 0.05) * 1.5)), 12) * smoothstep(0.1, 0.4, r);
      const bl = fbm2(n, x * 0.04, y * 0.04, 3);
      let cr = 50 + bl * 16;
      let cg = 84 + bl * 18 + (1 - r) * 10;
      let cb = 34 + bl * 8;
      cr *= 1 - vein * 0.18;
      cg *= 1 - vein * 0.12;
      cb *= 1 - vein * 0.12;
      // blemishes
      const sp = n(x * 0.12 + 40, y * 0.12);
      if (sp > 0.55) {
        const k = clamp((sp - 0.55) * 5, 0, 0.8);
        cr += (132 - cr) * k;
        cg += (116 - cg) * k;
        cb += (56 - cb) * k;
      }
      // reddish rim
      if (r > 0.9) {
        const k = smoothstep(0.9, 0.98, r);
        cr += (116 - cr) * k;
        cg += (66 - cg) * k;
        cb += (44 - cb) * k;
      }
      data[i] = clamp(cr, 0, 255);
      data[i + 1] = clamp(cg, 0, 255);
      data[i + 2] = clamp(cb, 0, 255);
      data[i + 3] = a * 255;
    }
  }
  dilateTransparent(data, S, S, [0, 0, S, S], 6);
  return dataTexture(data, S, S, { srgb: true, anisotropy: 4 });
}

function buildPadGeometry() {
  const B = new MeshBuilder();
  const segs = 18;
  const c = B.vert([0, 0.002, 0], [0, 1, 0], [0.5, 0.5]);
  const ring = [];
  for (let j = 0; j <= segs; j++) {
    const a = (j / segs) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    ring.push(B.vert([x, 0.0, z], [x * 0.08, 1, z * 0.08], [0.5 + x * 0.5, 0.5 + z * 0.5]));
  }
  for (let j = 0; j < segs; j++) B.tri(c, ring[j + 1], ring[j]);
  return B.build();
}

function buildWaterLily(white) {
  const B = new MeshBuilder({ colors: true });
  const petal = (ang, len, wid, up, col, colTip) => {
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const px = -dz;
    const pz = dx;
    const ids = [];
    const pts = [0, 0.5, 1];
    for (const t of pts) {
      const r = len * t;
      const y = Math.sin(up) * r * (0.8 + 0.4 * t) + 0.004;
      const hr = Math.cos(up) * r;
      const w = wid * Math.sin(Math.PI * Math.min(0.95, 0.15 + t * 0.85)) * (t === 1 ? 0.15 : 1);
      const k = t;
      const cc = _c.copy(col).lerp(colTip, k);
      for (const s of [-1, 1]) ids.push(B.vert([dx * hr + px * w * s * 0.5, y + (s > 0 ? 0.002 : 0), dz * hr + pz * w * s * 0.5], [dx * -Math.sin(up), Math.cos(up), dz * -Math.sin(up)], [0, t], [cc.r, cc.g, cc.b]));
    }
    B.quad(ids[0], ids[2], ids[3], ids[1]);
    B.quad(ids[2], ids[4], ids[5], ids[3]);
  };
  if (white) {
    const base = srgb(222, 218, 196);
    const tip = srgb(250, 248, 240);
    const pinkish = srgb(236, 220, 214);
    for (let i = 0; i < 12; i++) petal((i / 12) * Math.PI * 2, 0.07, 0.024, 0.28, srgb(170, 172, 130), base);
    for (let i = 0; i < 12; i++) petal(((i + 0.5) / 12) * Math.PI * 2, 0.062, 0.022, 0.62, base, tip);
    for (let i = 0; i < 9; i++) petal(((i + 0.25) / 9) * Math.PI * 2, 0.05, 0.02, 0.95, pinkish, tip);
    // golden stamens
    const gold = srgb(226, 176, 40);
    for (let i = 0; i < 10; i++) petal((i / 10) * Math.PI * 2, 0.022, 0.012, 1.15, gold, srgb(240, 200, 70));
  } else {
    // yellow pond-lily: a cup of thick yellow sepals
    const y = srgb(214, 172, 36);
    const yt = srgb(232, 196, 60);
    for (let i = 0; i < 6; i++) petal((i / 6) * Math.PI * 2, 0.034, 0.03, 1.0, srgb(150, 140, 50), y);
    for (let i = 0; i < 5; i++) petal(((i + 0.5) / 5) * Math.PI * 2, 0.03, 0.028, 1.25, y, yt);
  }
  return B.build();
}

// ---------------------------------------------------------------- boulders
function buildBoulder(seed, detail) {
  const rng = makeRng(seed);
  const n = makeNoise2(seed * 7 + 1);
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const planes = [];
  for (let i = 0; i < 3; i++) {
    const v = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    planes.push({ n: v, d: 0.62 + rng() * 0.25 });
  }
  planes.push({ n: new THREE.Vector3(0, -1, 0), d: 0.5 });
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const r = 1 + fbm2(n, p.x * 1.3 + p.z * 0.7, p.y * 1.3 - p.z * 0.4, 3) * 0.22;
    p.multiplyScalar(r);
    for (const pl of planes) {
      const dd = p.dot(pl.n) - pl.d;
      if (dd > 0) p.addScaledVector(pl.n, -dd * 0.85);
    }
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.scale(1, 0.62 + rng() * 0.2, 0.8 + rng() * 0.25);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- logs
function makeBarkTextures() {
  const W = 256;
  const H = 256;
  const n = makeNoise2(909);
  const color = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      // u runs along the log, v around it; fissures follow the length
      const fis = Math.abs(n(u * 3, v * 14, 3, 14));
      const ridge = fbm2(n, u * 6 + 5, v * 24, 3, 6, 24);
      const f = 0.8 + ridge * 0.35 - (fis < 0.1 ? (0.1 - fis) * 4 : 0);
      const i = (y * W + x) * 4;
      color[i] = clamp(104 * f, 0, 255);
      color[i + 1] = clamp(94 * f, 0, 255);
      color[i + 2] = clamp(82 * f, 0, 255);
      color[i + 3] = 255;
      height[y * W + x] = ridge * 0.004 - (fis < 0.1 ? (0.1 - fis) * 0.04 : 0);
    }
  }
  return {
    map: dataTexture(color, W, H, { srgb: true, repeat: true, anisotropy: 4 }),
    normalMap: dataTexture(normalMapFromHeight(height, W, H, 1.5 / W, 0.9 / H, { wrapX: true, wrapY: true }), W, H, { srgb: false, repeat: true, anisotropy: 4 }),
  };
}

// tapered, slightly bent log from a to b (Vector3), radius r0 -> r1, with branch stubs
function addLog(B, rng, a, b, r0, r1, tint, topTint, stubs = 3, sides = 8) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  d.normalize();
  const t1 = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const s1 = new THREE.Vector3().crossVectors(d, t1).normalize();
  const s2 = new THREE.Vector3().crossVectors(s1, d).normalize();
  const segs = Math.max(2, Math.round(len / 2));
  const bendA = (rng() - 0.5) * 0.25;
  const rings = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const r = r0 + (r1 - r0) * t;
    const c = new THREE.Vector3().copy(a).addScaledVector(d, len * t).addScaledVector(s1, Math.sin(t * Math.PI) * bendA * len * 0.1);
    const ids = [];
    for (let j = 0; j <= sides; j++) {
      const ang = (j / sides) * Math.PI * 2;
      const nx = s1.x * Math.cos(ang) + s2.x * Math.sin(ang);
      const ny = s1.y * Math.cos(ang) + s2.y * Math.sin(ang);
      const nz = s1.z * Math.cos(ang) + s2.z * Math.sin(ang);
      const rr = r * (1 + Math.sin(ang * 3 + s) * 0.04);
      const up = clamp(ny, 0, 1);
      const col = [tint[0] + (topTint[0] - tint[0]) * up, tint[1] + (topTint[1] - tint[1]) * up, tint[2] + (topTint[2] - tint[2]) * up];
      ids.push(B.vert([c.x + nx * rr, c.y + ny * rr, c.z + nz * rr], [nx, ny, nz], [(t * len) / 1.5, j / sides], col));
    }
    rings.push(ids);
  }
  for (let s = 0; s < segs; s++) for (let j = 0; j < sides; j++) B.quad(rings[s][j], rings[s][j + 1], rings[s + 1][j + 1], rings[s + 1][j]);
  // end caps (sawn/broken ends read darker)
  for (const [ring, sign, cpos] of [
    [rings[0], -1, a],
    [rings[segs], 1, b],
  ]) {
    const cc = B.vert([cpos.x, cpos.y, cpos.z], [d.x * sign, d.y * sign, d.z * sign], [0.5, 0.5], [tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7]);
    for (let j = 0; j < sides; j++) {
      const p0 = ring[j];
      const p1 = ring[j + 1];
      const ni = B.count;
      B.vert([B.p[p0 * 3], B.p[p0 * 3 + 1], B.p[p0 * 3 + 2]], [d.x * sign, d.y * sign, d.z * sign], [0, 0], [tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7]);
      B.vert([B.p[p1 * 3], B.p[p1 * 3 + 1], B.p[p1 * 3 + 2]], [d.x * sign, d.y * sign, d.z * sign], [1, 0], [tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7]);
      if (sign > 0) B.tri(cc, ni, ni + 1);
      else B.tri(cc, ni + 1, ni);
    }
  }
  // branch stubs
  for (let i = 0; i < stubs; i++) {
    const t = 0.25 + rng() * 0.65;
    const ang = rng() * Math.PI * 2;
    const base = new THREE.Vector3().copy(a).addScaledVector(d, len * t);
    const dir = new THREE.Vector3().addScaledVector(s1, Math.cos(ang)).addScaledVector(s2, Math.sin(ang)).addScaledVector(d, 0.5).normalize();
    const rr = (r0 + (r1 - r0) * t) * (0.3 + rng() * 0.25);
    const tip = base.clone().addScaledVector(dir, 0.4 + rng() * 1.4);
    // submerged wood stays under the surface
    if (base.y < -0.3 && tip.y > -0.35) tip.y = -0.35 - rng() * 0.3;
    addLog(B, rng, base, tip, rr, rr * 0.4, tint, topTint, 0, 5);
  }
}

// ---------------------------------------------------------------- build
export function buildShore({ env, quality, shared, grid }) {
  const Q = QUALITY[quality] || QUALITY.high;
  const group = new THREE.Group();
  group.name = 'shore';
  const rng = makeRng(4321);
  const noise = makeNoise2(4322);
  const S = Q.sectors;
  const sectorOf = (x, z) => Math.min(S - 1, Math.floor(((Math.atan2(x, -z) + Math.PI) / (Math.PI * 2)) * S));
  const habitat = (x, z) => {
    const h = env.getHabitat ? env.getHabitat(x, z) : null;
    return h || { depth: Math.max(0, -env.getTerrainHeight(x, z)), weeds: 0, rocks: 0, wood: 0 };
  };
  const onDock = (x, z) => Math.abs(x) < 1.35 && z > DOCK.endZ - 1.2 && z < DOCK.shoreZ + 1;
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _e = new THREE.Euler();

  // ---------- reeds
  const reedMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  reedMat.name = 'scenery.reeds';
  patchMaterial(reedMat, shared, { sway: { amp: 0.16, freq: 1.7, wave: 0.18, invH: 1 / 2.2 }, transl: 0.35 });
  const reedGeos = [buildCattailClump(71).build(), buildCattailClump(72).build(), buildBulrushClump(81).build(), buildSedgeTuft(91).build()];
  const reedNear = new Map();
  const reedFar = [];
  for (let i = 0; i < S; i++) reedFar.push([]);
  let nNear = 0;
  let nFar = 0;
  const { n, half, cell, h } = grid;
  const cellArea = cell * cell;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const hc = h[j * n + i];
      if (hc < -1.2 || hc > 0.6) continue;
      const cx = -half + i * cell;
      const cz = -half + j * cell;
      const R = Math.hypot(cx, cz);
      if (R > Q.reedFarR) continue;
      const hab = habitat(cx, cz);
      const weeds = clamp(Number(hab.weeds) || 0, 0, 1);
      const rocks = clamp(Number(hab.rocks) || 0, 0, 1);
      const patch = fbm2(noise, cx * 0.025, cz * 0.025, 3);
      let dens = smoothstep(0.02, 0.3, patch) * 0.55 + weeds * 0.9;
      dens *= 1 - 0.85 * rocks;
      if (dens <= 0.02) continue;
      const tries = Math.round((cellArea / 2.2) * dens);
      for (let k = 0; k < tries; k++) {
        const x = cx + (rng() - 0.5) * cell;
        const z = cz + (rng() - 0.5) * cell;
        if (onDock(x, z)) continue;
        const y = env.getTerrainHeight(x, z);
        if (!Number.isFinite(y) || y < -0.85 || y > 0.3) continue;
        const Rr = Math.hypot(x, z);
        const depth = -y;
        // species by water depth: bulrush deepest, cattail shallow, sedge on the wet margin
        let v;
        if (y > 0.05) v = 3;
        else if (depth > 0.45) v = rng() < 0.7 ? 2 : Math.floor(rng() * 2);
        else v = rng() < 0.25 ? 2 : Math.floor(rng() * 2);
        const sc = (v === 3 ? 0.8 : 0.75) + rng() * 0.45;
        if (Rr < Q.reedNearR && nNear < Q.reedNear) {
          const key = `${v}|${sectorOf(x, z)}`;
          if (!reedNear.has(key)) reedNear.set(key, []);
          reedNear.get(key).push({ x, y, z, s: sc, v });
          nNear++;
        } else if (Rr >= Q.reedNearR && v !== 3 && nFar < Q.reedFar && rng() < 0.45) {
          reedFar[sectorOf(x, z)].push({ x, y, z, s: sc, v });
          nFar++;
        }
      }
    }
  }
  const reedMeshes = [];
  for (const [key, list] of reedNear) {
    const v = Number(key.split('|')[0]);
    const mesh = new THREE.InstancedMesh(reedGeos[v], reedMat, list.length);
    list.forEach((t, i) => {
      // turn clumps to face the dock so round stems always present their width
      const yaw = v === 2 ? Math.atan2(-t.x, -t.z) : rng() * Math.PI * 2;
      _q.setFromEuler(_e.set((rng() - 0.5) * 0.08, yaw, (rng() - 0.5) * 0.08));
      _p.set(t.x, t.y - 0.05, t.z);
      _s.set(t.s, t.s * (0.85 + rng() * 0.3), t.s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      const g = 0.85 + rng() * 0.3;
      mesh.setColorAt(i, _c.setRGB(g * (0.95 + rng() * 0.1), g, g * (0.9 + rng() * 0.15)));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.layers.enable(LAYERS.UNDERWATER);
    mesh.name = `shore.reeds.${key}`;
    group.add(mesh);
    reedMeshes.push(mesh);
  }
  // far reed cards (face the dock)
  const reedTex = makeReedCardTexture();
  const cardMat = new THREE.MeshLambertMaterial({ map: reedTex, alphaTest: 0.5, side: THREE.DoubleSide });
  cardMat.name = 'scenery.reedCards';
  patchMaterial(cardMat, shared, { cellUV: true, alphaMip: 0.5, sway: { amp: 0.08, freq: 1.5, wave: 0.18, invH: 1 }, transl: 0.3 });
  const cardGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  reedFar.forEach((list, si) => {
    if (!list.length) return;
    const geo = cardGeo.clone();
    const uvOff = new Float32Array(list.length * 4);
    const mesh = new THREE.InstancedMesh(geo, cardMat, list.length);
    list.forEach((t, i) => {
      const yaw = Math.atan2(-t.x, -t.z);
      _q.setFromEuler(_e.set(0, yaw, 0));
      _p.set(t.x, Math.max(t.y, -0.35), t.z);
      _s.set(2.8 * t.s, 2.1 * t.s, 1);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      const g = 0.85 + rng() * 0.3;
      mesh.setColorAt(i, _c.setRGB(g, g, g * 0.95));
      const variant = t.v === 2 ? 1 : 0;
      uvOff.set([variant * 0.5, 0, 0.5, 1], i * 4);
    });
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(uvOff, 4));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = `shore.reedCards.${si}`;
    group.add(mesh);
  });
  cardGeo.dispose();

  // ---------- lily pads (weedy cove) + flowers
  const padSpots = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const hc = h[j * n + i];
      if (hc > -0.25 || hc < -2.2) continue;
      const cx = -half + i * cell;
      const cz = -half + j * cell;
      if (Math.hypot(cx, cz) > 260) continue;
      const hab = habitat(cx, cz);
      const weeds = clamp(Number(hab.weeds) || 0, 0, 1);
      if (weeds < 0.35) continue;
      padSpots.push({ cx, cz, w: weeds });
    }
  }
  const pads = [];
  const flowers = [];
  if (padSpots.length) {
    let guard = 0;
    while (pads.length < Q.pads && guard++ < Q.pads * 20) {
      const sp = padSpots[Math.floor(rng() * padSpots.length)];
      const x = sp.cx + (rng() - 0.5) * cell;
      const z = sp.cz + (rng() - 0.5) * cell;
      // patchy colonies
      if (fbm2(noise, x * 0.09 + 20, z * 0.09, 2) < 0.05 - sp.w * 0.2) continue;
      const y = env.getTerrainHeight(x, z);
      if (!(y < -0.25 && y > -2.2) || onDock(x, z)) continue;
      const r = 0.1 + rng() * 0.07;
      // avoid heavy overlap
      let ok = true;
      for (let k = Math.max(0, pads.length - 40); k < pads.length; k++) {
        const p = pads[k];
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r) ** 2 * 0.55) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pads.push({ x, z, r, yaw: rng() * Math.PI * 2 });
      if (flowers.length < Q.flowers && rng() < 0.04) flowers.push({ x: x + (rng() - 0.5) * 0.15, z: z + (rng() - 0.5) * 0.15, white: rng() < 0.8, yaw: rng() * 6.28, s: 0.85 + rng() * 0.35 });
    }
  }
  if (pads.length) {
    const padMat = new THREE.MeshStandardMaterial({ map: makeLilyTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.42, metalness: 0 });
    padMat.name = 'scenery.lilypads';
    patchMaterial(padMat, shared, { alphaMip: 0.3 });
    const mesh = new THREE.InstancedMesh(buildPadGeometry(), padMat, pads.length);
    pads.forEach((p, i) => {
      _q.setFromEuler(_e.set((rng() - 0.5) * 0.03, p.yaw, (rng() - 0.5) * 0.03));
      _p.set(p.x, 0.012 + rng() * 0.004, p.z);
      _s.set(p.r, p.r, p.r * (0.92 + rng() * 0.1));
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      const k = rng();
      if (k < 0.12) mesh.setColorAt(i, _c.setRGB(1.25, 0.7, 0.62)); // young bronze-red pad
      else if (k < 0.2) mesh.setColorAt(i, _c.setRGB(1.3, 1.15, 0.7)); // yellowing
      else mesh.setColorAt(i, _c.setRGB(0.85 + rng() * 0.3, 0.85 + rng() * 0.3, 0.85 + rng() * 0.25));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = 'shore.lilypads';
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (flowers.length) {
    const flMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.6, metalness: 0 });
    flMat.name = 'scenery.waterlilies';
    patchMaterial(flMat, shared, { transl: 0.6 });
    for (const white of [true, false]) {
      const list = flowers.filter((f) => f.white === white);
      if (!list.length) continue;
      const mesh = new THREE.InstancedMesh(buildWaterLily(white), flMat, list.length);
      list.forEach((f, i) => {
        _q.setFromEuler(_e.set(0, f.yaw, 0));
        _p.set(f.x, 0.012, f.z);
        _s.setScalar(f.s);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = white ? 'shore.waterlily' : 'shore.pondlily';
      group.add(mesh);
    }
  }

  // ---------- boulders
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 });
  rockMat.name = 'scenery.granite';
  patchMaterial(rockMat, shared, {
    fragColor: `{
      vec3 wp = vSWorld;
      vec3 wn = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
      float speck = sNoise3(wp * 11.0);
      float feld = smoothstep(0.5, 0.72, sNoise3(wp * 3.7 + 3.1));
      vec3 col = vec3(0.22, 0.2, 0.185);
      col = mix(col, vec3(0.3, 0.2, 0.165), feld * 0.55);
      col *= 0.82 + 0.3 * speck;
      float dark = smoothstep(0.62, 0.75, sNoise3(wp * 6.0 + 9.0));
      col *= 1.0 - dark * 0.35;
      float lichN = sFbm3(wp * 1.4 + 2.0);
      float lich = smoothstep(0.5, 0.64, lichN) * smoothstep(0.1, 0.6, wn.y) * smoothstep(0.25, 0.5, wp.y);
      col = mix(col, vec3(0.36, 0.38, 0.28), lich * 0.85);
      float blk = smoothstep(0.62, 0.7, sNoise3(wp * 4.3 + 17.0)) * smoothstep(0.3, 0.6, wp.y);
      col *= 1.0 - blk * 0.5;
      float orange = smoothstep(0.78, 0.84, sNoise3(wp * 5.0 + 41.0)) * smoothstep(0.2, 0.5, wp.y) * smoothstep(0.3, 0.8, wn.y);
      col = mix(col, vec3(0.55, 0.2, 0.04), orange * 0.8);
      float wl = 0.3 + 0.12 * sNoise3(wp * 2.5);
      float wet = 1.0 - smoothstep(0.02, wl, wp.y);
      float under = 1.0 - smoothstep(-0.12, 0.02, wp.y);
      col *= 1.0 - 0.45 * wet;
      col = mix(col, vec3(0.07, 0.07, 0.035) + col * 0.3, under * 0.75);
      diffuseColor.rgb = col;
    }`,
    fragRough: `{
      float wl = 0.3 + 0.12 * sNoise3(vSWorld * 2.5);
      float wet = (1.0 - smoothstep(0.02, wl, vSWorld.y)) * smoothstep(-0.12, 0.02, vSWorld.y);
      roughnessFactor = mix(roughnessFactor, 0.3, wet);
    }`,
    bump: `(sNoise3(vSWorld * 2.2) * 0.05 + sNoise3(vSWorld * 9.0) * 0.012) * (1.0 - smoothstep(30.0, 90.0, length(vViewPosition)))`,
  });
  const rockGeos = [buildBoulder(5, 2), buildBoulder(6, 2), buildBoulder(7, 2)];
  const farRockGeo = buildBoulder(8, 1);
  const rocks = [];
  const farRocks = [];
  const rockSpots = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const hc = h[j * n + i];
      if (hc < -3.2 || hc > 3) continue;
      const cx = -half + i * cell;
      const cz = -half + j * cell;
      const R = Math.hypot(cx, cz);
      if (R > 520) continue;
      // rockiness: habitat in water, else of the nearest water cell
      let rk = 0;
      if (hc < 0) rk = clamp(Number(habitat(cx, cz).rocks) || 0, 0, 1);
      else if (grid.distAt(cx, cz) < 14) {
        const w = grid.nearestWater(cx, cz, { x: 0, z: 0 });
        if (w) rk = clamp(Number(habitat(w.x, w.z).rocks) || 0, 0, 1) * 0.8;
      } else continue;
      const base = hc > -0.6 && hc < 0.6 ? 0.08 : 0.015; // a few boulders along every shoreline
      rockSpots.push({ cx, cz, p: rk * 0.9 + base, R });
    }
  }
  for (const sp of rockSpots) {
    const k = sp.p * (sp.R < 150 ? 1 : 0.5);
    let count = Math.floor(k * 2.2 + rng());
    while (count-- > 0) {
      const x = sp.cx + (rng() - 0.5) * cell;
      const z = sp.cz + (rng() - 0.5) * cell;
      if (onDock(x, z) || Math.hypot(x, z) < 6) continue;
      const y = env.getTerrainHeight(x, z);
      if (!Number.isFinite(y)) continue;
      const big = rng() < 0.2;
      const s = (big ? 1.0 + rng() * 1.3 : 0.3 + rng() * 0.7) * (sp.p > 0.5 ? 1.15 : 1);
      const item = { x, y: y - s * (0.15 + rng() * 0.2), z, s, yaw: rng() * Math.PI * 2, tilt: (rng() - 0.5) * 0.3, g: Math.floor(rng() * rockGeos.length) };
      if (sp.R < 160) {
        if (rocks.length < Q.rocks) rocks.push(item);
      } else if (farRocks.length < Q.farRocks) farRocks.push(item);
    }
  }
  const rockMeshes = [];
  const addRocks = (list, geos, name) => {
    geos.forEach((geo, gi) => {
      const sub = list.filter((r) => r.g % geos.length === gi);
      if (!sub.length) return;
      const mesh = new THREE.InstancedMesh(geo, rockMat, sub.length);
      sub.forEach((r, i) => {
        _q.setFromEuler(_e.set(r.tilt, r.yaw, r.tilt * 0.5));
        _p.set(r.x, r.y, r.z);
        _s.set(r.s * (0.9 + rng() * 0.25), r.s, r.s * (0.9 + rng() * 0.25));
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.layers.enable(LAYERS.UNDERWATER);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = `${name}.${gi}`;
      group.add(mesh);
      rockMeshes.push(mesh);
    });
  };
  addRocks(rocks, rockGeos, 'shore.rocks');
  addRocks(farRocks, [farRockGeo], 'shore.farRocks');

  // ---------- sunken timber + fallen logs (one merged mesh)
  const bark = makeBarkTextures();
  const logB = new MeshBuilder({ colors: true });
  const sunkTint = [0.42, 0.4, 0.3];
  const siltTint = [0.62, 0.57, 0.44];
  const tc = { x: -10, z: -22 };
  // find the timber site: contract says (-10, -22); if the terrain there is dry, keep it anyway
  const bedAt = (x, z) => {
    const y = env.getTerrainHeight(x, z);
    return Number.isFinite(y) ? y : -3.5;
  };
  const logDefs = [];
  for (let i = 0; i < 8; i++) {
    const ang = rng() * Math.PI;
    const len = 4 + rng() * 7;
    const cx = tc.x + (rng() - 0.5) * 7;
    const cz = tc.z + (rng() - 0.5) * 7;
    const r0 = 0.14 + rng() * 0.16;
    logDefs.push({ ang, len, cx, cz, r0 });
  }
  logDefs.forEach((L, i) => {
    const dx = Math.cos(L.ang) * L.len * 0.5;
    const dz = Math.sin(L.ang) * L.len * 0.5;
    const a = new THREE.Vector3(L.cx - dx, 0, L.cz - dz);
    const b = new THREE.Vector3(L.cx + dx, 0, L.cz + dz);
    a.y = bedAt(a.x, a.z) + L.r0 * 0.7;
    b.y = bedAt(b.x, b.z) + L.r0 * 0.4;
    // later logs rest on earlier ones: lift one end
    if (i > 2 && rng() < 0.6) a.y += 0.3 + rng() * 0.5;
    addLog(logB, rng, a, b, L.r0, L.r0 * 0.55, sunkTint, siltTint, 3 + Math.floor(rng() * 3));
  });
  // one big sweeper branch reaching up toward the surface
  {
    const base = new THREE.Vector3(tc.x + 1.2, bedAt(tc.x + 1.2, tc.z + 0.5) + 0.35, tc.z + 0.5);
    const top = new THREE.Vector3(tc.x + 2.8, Math.min(-0.6, base.y + 2.6), tc.z - 1.4);
    addLog(logB, rng, base, top, 0.12, 0.04, sunkTint, siltTint, 4, 6);
  }
  // fallen logs along the shore: find shoreline cells near the cove and point
  const shoreLogs = [];
  const want = quality === 'low' ? 3 : 5;
  const cands = [];
  for (let j = 0; j < n; j += 2) {
    for (let i = 0; i < n; i += 2) {
      const hc = h[j * n + i];
      if (hc < 0.05 || hc > 0.6) continue;
      const cx = -half + i * cell;
      const cz = -half + j * cell;
      const R = Math.hypot(cx, cz);
      if (R < 20 || R > 140 || onDock(cx, cz) || Math.abs(Math.atan2(cx, -cz)) > 2.4) continue;
      cands.push({ cx, cz });
    }
  }
  for (let k = 0; k < want && cands.length; k++) {
    const c = cands.splice(Math.floor(rng() * cands.length), 1)[0];
    const w = grid.nearestWater(c.cx, c.cz, { x: 0, z: 0 });
    if (!w) continue;
    // lie roughly perpendicular to the shore, crown end in the water
    const ang = Math.atan2(w.z - c.cz, w.x - c.cx) + (rng() - 0.5) * 0.9;
    const len = 5 + rng() * 6;
    const a = new THREE.Vector3(c.cx - Math.cos(ang) * 1.5, 0, c.cz - Math.sin(ang) * 1.5);
    const b = new THREE.Vector3(a.x + Math.cos(ang) * len, 0, a.z + Math.sin(ang) * len);
    const r0 = 0.18 + rng() * 0.12;
    a.y = Math.max(bedAt(a.x, a.z), -0.3) + r0 * 0.6;
    b.y = Math.max(bedAt(b.x, b.z), -0.25) + r0 * 0.2;
    const drift = [0.95 + rng() * 0.1, 0.93 + rng() * 0.1, 0.88 + rng() * 0.1];
    addLog(logB, rng, a, b, r0, r0 * 0.5, drift, [drift[0] * 1.12, drift[1] * 1.12, drift[2] * 1.1], 4 + Math.floor(rng() * 3));
    shoreLogs.push({ a, b });
  }
  const logMat = new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, vertexColors: true, roughness: 0.9, metalness: 0 });
  logMat.name = 'scenery.logs';
  const logMesh = new THREE.Mesh(logB.build(), logMat);
  logMesh.name = 'shore.timber';
  logMesh.layers.enable(LAYERS.UNDERWATER);
  logMesh.receiveShadow = true;
  group.add(logMesh);

  // reed clumps nearest the dock (dragonflies hang around them)
  const anchors = [];
  for (const list of reedNear.values()) for (const t of list) anchors.push({ x: t.x, y: t.y, z: t.z, d: Math.hypot(t.x, t.z) });
  anchors.sort((a, b) => a.d - b.d);
  anchors.length = Math.min(anchors.length, 24);

  return {
    group,
    anchors,
    stats: { reedsNear: nNear, reedCards: nFar, pads: pads.length, flowers: flowers.length, rocks: rocks.length, farRocks: farRocks.length, logs: logDefs.length + shoreLogs.length },
    update() {},
  };
}
