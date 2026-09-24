// Boreal trees: a shared texture atlas (spruce/fir sprays, pine tufts, birch leaf clusters and three
// barks, painted procedurally) and geometry builders for spruce/fir, white/red pine and paper birch.
// Trees are built at a reference height and instanced with a uniform scale. Foliage cards carry
// "crown" normals (pointing out of the crown) and vertex AO so the canopy shades as a volume.
import * as THREE from 'three';
import { makeRng, clamp } from '../config.js';
import { dataTexture, dilateTransparent } from './texutil.js';
import { Raster } from './raster.js';
import { makeNoise2, fbm2 } from './noise.js';
import { MeshBuilder } from './geo.js';

export const ATLAS_SIZE = 1024;
// regions in atlas pixels [x, y, w, h] (v = y / size with flipY = false)
export const REGION = {
  spruce: [0, 0, 512, 512],
  pine: [512, 0, 512, 512],
  birch: [0, 512, 512, 512],
  barkSpruce: [512, 512, 128, 512],
  barkPine: [640, 512, 128, 512],
  barkBirch: [768, 512, 128, 512],
  barkGrey: [896, 512, 128, 512],
};

// ---------------------------------------------------------------- atlas painting (CPU raster)
function paintSpruce(R, rx, ry, S, rng) {
  // A flat spruce/fir spray seen from above: main axis from the trunk (left) to the tip (right),
  // alternate side shoots, needles all around each shoot.
  const cols = [
    [30, 48, 40],
    [37, 59, 47],
    [44, 69, 53],
    [53, 81, 60],
    [63, 93, 66],
    [76, 108, 71],
    [92, 124, 76],
  ];
  const NB = cols.length;
  const needles = [];
  const twigs = [];
  const shoot = (x0, y0, ang, len, depth, bright) => {
    const steps = Math.max(4, Math.floor(len / 1.6));
    let x = x0;
    let y = y0;
    let a = ang;
    const pts = [[x, y]];
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      a += (rng() - 0.5) * 0.05;
      x += Math.cos(a) * (len / steps);
      y += Math.sin(a) * (len / steps);
      pts.push([x, y]);
      const nl = (4.4 + rng() * 3.4) * (depth === 0 ? 1.15 : 1) * (1 - t * 0.25);
      const tipGlow = t > 0.72 ? 1 : 0;
      for (const side of [-1, 1]) {
        if (rng() < 0.1) continue;
        const na = a + side * (0.75 + rng() * 0.55);
        const b = Math.min(NB - 1, Math.max(0, Math.floor(rng() * 3 + bright * 2 + tipGlow * 2)));
        needles.push(x, y, na, nl, b);
      }
      if (rng() < 0.5) needles.push(x, y, a + (rng() - 0.5) * 0.4, nl * 0.7, Math.min(NB - 1, 2 + tipGlow * 3));
      if (depth < 2 && i > 2 && i % (depth === 0 ? 7 : 6) === 0) {
        const side = (i / (depth === 0 ? 7 : 6)) % 2 === 0 ? 1 : -1;
        const prof = depth === 0 ? Math.sin(Math.PI * Math.pow(t, 0.75)) : 1 - t;
        const sl = len * (depth === 0 ? 0.42 : 0.45) * prof * (0.75 + rng() * 0.4);
        if (sl > 10) shoot(x, y, a + side * (0.85 + rng() * 0.3), sl, depth + 1, bright + (depth === 0 ? 0.2 : 0.4));
      }
    }
    twigs.push({ pts, w: depth === 0 ? 3.2 : depth === 1 ? 1.7 : 1.1 });
  };
  shoot(rx + 6, ry + S / 2, 0, S - 14, 0, 0);
  for (const t of twigs) for (let i = 1; i < t.pts.length; i++) R.line(t.pts[i - 1][0], t.pts[i - 1][1], t.pts[i][0], t.pts[i][1], t.w, 62, 50, 40);
  // darker needles first so bright tips end on top
  for (let b = 0; b < NB; b++) {
    const c = cols[b];
    for (let i = 0; i < needles.length; i += 5) {
      if (needles[i + 4] !== b) continue;
      const x = needles[i];
      const y = needles[i + 1];
      const a = needles[i + 2];
      const l = needles[i + 3];
      R.line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 1.35, c[0], c[1], c[2]);
    }
  }
}

function paintPine(R, rx, ry, S, rng) {
  // Pine spray: a main twig with side twigs, all carrying soft brushes of long needles
  // (white pine: bundles of five, 8-13 cm) that fan forward. Fills a broad oval like a real spray.
  const cols = [
    [38, 58, 50],
    [48, 72, 60],
    [59, 86, 69],
    [72, 101, 78],
    [86, 117, 87],
    [102, 132, 94],
  ];
  const NB = cols.length;
  const needles = [];
  const twigs = [];
  const cx = rx + S / 2;
  const cy = ry + S / 2;
  const inside = (x, y) => ((x - cx) / (S * 0.47)) ** 2 + ((y - cy) / (S * 0.4)) ** 2 < 1;
  const brush = (x, y, ang, spread, len, n, lift) => {
    for (let i = 0; i < n; i++) {
      const a = ang + (rng() - 0.5) * spread;
      const l = len * (0.55 + rng() * 0.5);
      const ex = x + Math.cos(a) * l;
      const ey = y + Math.sin(a) * l;
      if (!inside(ex, ey)) continue;
      const bend = (rng() - 0.5) * 0.35;
      const b = Math.min(NB - 1, Math.max(0, Math.floor(rng() * 3.2 + lift + (Math.abs(a - ang) < spread * 0.2 ? 1 : 0))));
      needles.push(x, y, a, l, bend, b);
    }
  };
  const twig = (x0, y0, ang, len, depth) => {
    const steps = 12;
    let x = x0;
    let y = y0;
    let a = ang;
    const pts = [[x, y]];
    for (let i = 1; i <= steps; i++) {
      a += (rng() - 0.5) * 0.12;
      const nx = x + (Math.cos(a) * len) / steps;
      const ny = y + (Math.sin(a) * len) / steps;
      if (!inside(nx, ny)) break;
      x = nx;
      y = ny;
      pts.push([x, y]);
      const t = i / steps;
      if (t > 0.15) for (const side of [-1, 1]) brush(x, y, a + side * (0.5 + rng() * 0.3), 0.9, 40 + rng() * 22, 15, t * 1.5);
      if (depth === 0 && i % 2 === 0 && i < steps - 1) {
        const side = i % 4 === 0 ? 1 : -1;
        twig(x, y, a + side * (0.55 + rng() * 0.35), len * (0.42 + rng() * 0.2) * (1 - t * 0.4), 1);
      }
    }
    brush(x, y, a, 1.4, 62 + rng() * 24, 80, 1.5);
    twigs.push({ pts, w: depth === 0 ? 3 : 1.5 });
  };
  twig(rx + 10, cy + (rng() - 0.5) * 10, 0, S * 0.86, 0);
  for (const t of twigs) for (let i = 1; i < t.pts.length; i++) R.line(t.pts[i - 1][0], t.pts[i - 1][1], t.pts[i][0], t.pts[i][1], t.w, 78, 58, 42);
  for (let b = 0; b < NB; b++) {
    const c = cols[b];
    for (let i = 0; i < needles.length; i += 6) {
      if (needles[i + 5] !== b) continue;
      const x = needles[i];
      const y = needles[i + 1];
      const a = needles[i + 2];
      const l = needles[i + 3];
      const bend = needles[i + 4];
      const mx = x + Math.cos(a) * l * 0.5;
      const my = y + Math.sin(a) * l * 0.5;
      R.line(x, y, mx, my, 1.25, c[0], c[1], c[2]);
      R.line(mx, my, x + Math.cos(a + bend) * l, y + Math.sin(a + bend) * l, 1.1, c[0], c[1], c[2]);
    }
  }
}

function paintBirch(R, rx, ry, S, rng) {
  // A spray of paper birch leaves (ovate, pointed) on thin dark twigs, rounded cluster with gaps.
  const cx = rx + S / 2;
  const cy = ry + S / 2;
  const twigs = [];
  const leaves = [];
  const grow = (x, y, ang, len, depth) => {
    const steps = 8;
    const pts = [[x, y]];
    let a = ang;
    for (let i = 1; i <= steps; i++) {
      a += (rng() - 0.5) * 0.35;
      const nx = x + (Math.cos(a) * len) / steps;
      const ny = y + (Math.sin(a) * len) / steps;
      if (Math.hypot(nx - cx, ny - cy) > S * 0.47) break;
      x = nx;
      y = ny;
      pts.push([x, y]);
      const nL = depth === 0 ? 2 : 3;
      for (let k = 0; k < nL; k++) {
        const la = a + (rng() - 0.5) * 2.6;
        const d = 4 + rng() * 6;
        const lx = x + Math.cos(la) * d;
        const ly = y + Math.sin(la) * d;
        const r = Math.hypot(lx - cx, ly - cy) / (S * 0.44);
        if (r < 1) leaves.push({ x: lx, y: ly, a: la + (rng() - 0.5) * 0.8, s: 0.75 + rng() * 0.5, r, shade: rng(), warm: rng() });
      }
      if (depth < 2 && i > 1 && rng() < 0.55) grow(x, y, a + (rng() < 0.5 ? -1 : 1) * (0.6 + rng() * 0.5), len * 0.5, depth + 1);
    }
    twigs.push({ pts, w: depth === 0 ? 2.2 : 1.1 });
  };
  for (let i = 0; i < 5; i++) grow(cx + (rng() - 0.5) * 30, ry + S * 0.93, -Math.PI / 2 + (i - 2) * 0.42 + (rng() - 0.5) * 0.2, S * (0.55 + rng() * 0.2), 0);
  for (const t of twigs) for (let i = 1; i < t.pts.length; i++) R.line(t.pts[i - 1][0], t.pts[i - 1][1], t.pts[i][0], t.pts[i][1], t.w, 58, 44, 38);
  leaves.sort((a, b) => a.s - b.s);
  for (const l of leaves) {
    const shade = clamp(0.6 + l.shade * 0.42 - l.r * 0.1, 0.45, 1.05);
    const r = (70 + l.warm * 20) * shade;
    const g = (104 + l.warm * 16) * shade;
    const b = (44 + l.warm * 6) * shade;
    R.leaf(l.x, l.y, l.a, 17 * l.s, 10 * l.s, r, g, b, 1, 1.15);
  }
}

function paintBark(R, [x0, y0, w, h], kind, rng) {
  const n = makeNoise2(kind.length * 97 + 5);
  const d = R.data;
  const W = R.w;
  // tileable cell noise helper for plates (pine)
  const cells = [];
  const CX = 5;
  const CY = 9;
  for (let j = 0; j < CY; j++) for (let i = 0; i < CX; i++) cells.push([(i + rng()) / CX, (j + rng()) / CY, rng()]);
  for (let py = 0; py < h; py++) {
    const v = (py + 0.5) / h;
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w;
      let r;
      let g;
      let b;
      if (kind === 'birch') {
        const base = 214 + n(u * 6, v * 4, 6, 4) * 14;
        r = base;
        g = base - 3;
        b = base - 10;
        const peel = fbm2(n, u * 3 + 3, v * 5, 3, 3, 5);
        if (peel > 0.28) {
          const k = clamp((peel - 0.28) * 6, 0, 1);
          r += (196 - r) * k;
          g += (156 - g) * k;
          b += (124 - b) * k;
        }
        const grey = fbm2(n, u * 4 + 9, v * 6, 3, 4, 6);
        if (grey > 0.15) {
          const k = clamp((grey - 0.15) * 2.5, 0, 0.5);
          r *= 1 - k * 0.35;
          g *= 1 - k * 0.35;
          b *= 1 - k * 0.32;
        }
        // lenticels: short dark horizontal dashes
        const len = n(u * 3, v * 120, 3, 120);
        const dash = n(u * 24 + 5, v * 120, 24, 120);
        if (len > 0.45 && dash > 0.1) {
          r = 34;
          g = 30;
          b = 28;
        }
      } else if (kind === 'pine') {
        let best = 9;
        let second = 9;
        let val = 0;
        const gi = Math.floor(u * CX);
        const gj = Math.floor(v * CY);
        for (let oj = -1; oj <= 1; oj++) {
          for (let oi = -1; oi <= 1; oi++) {
            const ii = gi + oi;
            const jj = gj + oj;
            const wi = ((ii % CX) + CX) % CX;
            const wj = ((jj % CY) + CY) % CY;
            const c = cells[wj * CX + wi];
            const dx = u - (c[0] + Math.floor(ii / CX));
            const dy = (v - (c[1] + Math.floor(jj / CY))) * 0.55;
            const dd = dx * dx + dy * dy;
            if (dd < best) {
              second = best;
              best = dd;
              val = c[2];
            } else if (dd < second) second = dd;
          }
        }
        const edge = Math.sqrt(second) - Math.sqrt(best);
        const plate = clamp(edge * 30, 0, 1);
        const c = val * 0.8 + n(u * 20, v * 30, 20, 30) * 0.2;
        r = 52 + plate * (62 + c * 34);
        g = 36 + plate * (40 + c * 22);
        b = 28 + plate * (28 + c * 14);
      } else {
        const base = kind === 'grey' ? [118, 114, 106] : [80, 71, 63];
        const sc = fbm2(n, u * 8, v * 16, 3, 8, 16);
        const fis = Math.abs(n(u * 7, v * 1.5, 7, 0));
        const k = 1 + sc * 0.35 - (fis < 0.08 ? 0.45 * (1 - fis / 0.08) : 0);
        r = base[0] * k;
        g = base[1] * k;
        b = base[2] * k;
      }
      const i = ((y0 + py) * W + x0 + px) * 4;
      d[i] = clamp(r, 0, 255);
      d[i + 1] = clamp(g, 0, 255);
      d[i + 2] = clamp(b, 0, 255);
      d[i + 3] = 255;
    }
  }
  if (kind === 'birch') {
    // dark branch scars ("eyebrows")
    R.clip(x0, y0, w, h);
    for (let i = 0; i < 7; i++) {
      const px = x0 + rng() * w;
      const py = y0 + 10 + rng() * (h - 20);
      const L = 10 + rng() * 14;
      R.leaf(px - L, py, 0, L * 2, 4 + rng() * 3, 30, 26, 24, 0.9);
    }
    R.unclip();
  }
}

export function makeTreeAtlas() {
  const S = ATLAS_SIZE;
  const R = new Raster(S, S);
  const rng = makeRng(8080);
  const [sx, sy, ss] = REGION.spruce;
  R.clip(sx, sy, ss, ss);
  paintSpruce(R, sx, sy, ss, rng);
  const [px, py, ps] = REGION.pine;
  R.clip(px, py, ps, ps);
  paintPine(R, px, py, ps, rng);
  const [bx, by, bs] = REGION.birch;
  R.clip(bx, by, bs, bs);
  paintBirch(R, bx, by, bs, rng);
  R.unclip();
  paintBark(R, REGION.barkSpruce, 'spruce', rng);
  paintBark(R, REGION.barkPine, 'pine', rng);
  paintBark(R, REGION.barkBirch, 'birch', rng);
  paintBark(R, REGION.barkGrey, 'grey', rng);
  for (const k of ['spruce', 'pine', 'birch']) dilateTransparent(R.data, S, S, REGION[k], 8);
  return dataTexture(R.data, S, S, { srgb: true, anisotropy: 4 });
}

// ---------------------------------------------------------------- geometry helpers
const uvIn = (region, u, v) => [(region[0] + 1 + u * (region[2] - 2)) / ATLAS_SIZE, (region[1] + 1 + v * (region[3] - 2)) / ATLAS_SIZE];

function newBuilder() {
  return new MeshBuilder({ colors: true, extra: { aSway: 1 } });
}

// Tapered trunk/branch between two points, `sides` around, bark strip region, `vReps` texture
// repeats along the length. Normals radial.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
function addLimb(B, p0, p1, r0, r1, sides, region, vReps, ao0 = 0.5, ao1 = 0.8, sway0 = 0, sway1 = 0, segs = 1) {
  _d.subVectors(p1, p0);
  const len = _d.length();
  _d.normalize();
  _t1.set(0, 1, 0);
  if (Math.abs(_d.y) > 0.95) _t1.set(1, 0, 0);
  _t2.crossVectors(_d, _t1).normalize();
  _t1.crossVectors(_t2, _d).normalize();
  const rings = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const r = r0 + (r1 - r0) * t;
    const ids = [];
    const vv = (t * vReps) % 1 === 0 && t > 0 ? 1 : (t * vReps) % 1;
    for (let j = 0; j <= sides; j++) {
      const ang = (j / sides) * Math.PI * 2;
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      const nx = _t1.x * c + _t2.x * sn;
      const ny = _t1.y * c + _t2.y * sn;
      const nz = _t1.z * c + _t2.z * sn;
      const ao = ao0 + (ao1 - ao0) * t;
      ids.push(
        B.vert(
          [p0.x + _d.x * len * t + nx * r, p0.y + _d.y * len * t + ny * r, p0.z + _d.z * len * t + nz * r],
          [nx, ny, nz],
          uvIn(region, j / sides, vv),
          [ao, ao, ao],
          { aSway: sway0 + (sway1 - sway0) * t }
        )
      );
    }
    rings.push(ids);
  }
  for (let s = 0; s < segs; s++) {
    for (let j = 0; j < sides; j++) B.quad(rings[s][j], rings[s][j + 1], rings[s + 1][j + 1], rings[s + 1][j]);
  }
}

// Trunk from y=y0 to y=y1 made of several segments, each mapping the full bark strip once.
function addTrunk(B, base, top, r0, r1, sides, region, segLen, ao0, ao1, bendX = 0, bendZ = 0) {
  const len = base.distanceTo(top);
  const n = Math.max(1, Math.round(len / segLen));
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    _a.lerpVectors(base, top, t0);
    _b.lerpVectors(base, top, t1);
    _a.x += Math.sin(t0 * Math.PI) * bendX;
    _a.z += Math.sin(t0 * Math.PI) * bendZ;
    _b.x += Math.sin(t1 * Math.PI) * bendX;
    _b.z += Math.sin(t1 * Math.PI) * bendZ;
    const a = _a.clone();
    const b = _b.clone();
    addLimb(B, a, b, r0 + (r1 - r0) * Math.pow(t0, 0.9), r0 + (r1 - r0) * Math.pow(t1, 0.9), sides, region, 1, ao0 + (ao1 - ao0) * t0, ao0 + (ao1 - ao0) * t1, 0, 0);
  }
}

// A bent foliage card from `root` along horizontal angle `ang`, length `len`, width `wid`,
// drooping by d0 (inner) and d1 (outer) radians; crown normals from `axis` (trunk xz).
const _p = new THREE.Vector3();
function addCard(B, region, root, ang, len, wid, d0, d1, axisX, axisZ, ao, tint, roll = 0, crownUp = 0.8, uFlip = false) {
  const dx = Math.cos(ang);
  const dz = Math.sin(ang);
  // width axis: horizontal perpendicular, rolled around the branch axis a little
  const wx = -dz * Math.cos(roll);
  const wy = Math.sin(roll);
  const wz = dx * Math.cos(roll);
  const segs = [0, 0.45, 1];
  const drops = [d0, (d0 + d1) / 2, d1];
  const ids = [];
  let x = root.x;
  let y = root.y;
  let z = root.z;
  let prevT = 0;
  for (let s = 0; s < segs.length; s++) {
    const t = segs[s];
    if (s > 0) {
      const dl = (t - prevT) * len;
      const dr = drops[s];
      x += dx * Math.cos(dr) * dl;
      y -= Math.sin(dr) * dl;
      z += dz * Math.cos(dr) * dl;
    }
    prevT = t;
    const w = wid * (s === 0 ? 0.55 : 1);
    for (const side of [-1, 1]) {
      const vx = x + wx * w * 0.5 * side;
      const vy = y + wy * w * 0.5 * side;
      const vz = z + wz * w * 0.5 * side;
      // crown normal: out from the trunk axis + up
      let nx = vx - axisX;
      let nz = vz - axisZ;
      const hl = Math.hypot(nx, nz) || 1;
      nx /= hl;
      nz /= hl;
      _p.set(nx, crownUp, nz).normalize();
      const a = ao * (0.55 + 0.45 * t);
      const u = uFlip ? 1 - t : t;
      ids.push(B.vert([vx, vy, vz], [_p.x, _p.y, _p.z], uvIn(region, u, side < 0 ? 0 : 1), [a * tint[0], a * tint[1], a * tint[2]], { aSway: t }));
    }
  }
  for (let s = 0; s < segs.length - 1; s++) {
    const a0 = ids[s * 2];
    const a1 = ids[s * 2 + 1];
    const b0 = ids[s * 2 + 2];
    const b1 = ids[s * 2 + 3];
    B.quad(a0, b0, b1, a1);
  }
}

// Crossed "clump" of cards around a center (pine tufts / birch leaf clusters): n cards with
// random orientation; normals mix clump-outward and crown-outward directions.
function addClump(B, region, cx, cy, cz, size, n, crownC, ao, tint, rng, sway = 1, flat = 0.3) {
  for (let i = 0; i < n; i++) {
    const yaw = rng() * Math.PI;
    const tilt = (rng() - 0.5) * 1.1 + (rng() < flat ? Math.PI / 2 - 0.25 : 0);
    const ux = Math.cos(yaw);
    const uz = Math.sin(yaw);
    // card plane spanned by u (horizontal) and v (tilted up)
    const vx = -Math.sin(yaw) * Math.sin(tilt);
    const vy = Math.cos(tilt);
    const vz = Math.cos(yaw) * Math.sin(tilt);
    const h = size * 0.5;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const ids = [];
    for (const [a, b] of corners) {
      const px = cx + ux * a * h + vx * b * h;
      const py = cy + vy * b * h;
      const pz = cz + uz * a * h + vz * b * h;
      let ox = px - cx;
      let oy = py - cy;
      let oz = pz - cz;
      const ol = Math.hypot(ox, oy, oz) || 1;
      let kx = px - crownC.x;
      let ky = (py - crownC.y) * 0.6;
      let kz = pz - crownC.z;
      const kl = Math.hypot(kx, ky, kz) || 1;
      _p.set((ox / ol) * 0.45 + (kx / kl) * 0.8, (oy / ol) * 0.45 + (ky / kl) * 0.8 + 0.6, (oz / ol) * 0.45 + (kz / kl) * 0.8).normalize();
      const aoV = ao * (0.75 + 0.25 * ((b + 1) / 2));
      ids.push(B.vert([px, py, pz], [_p.x, _p.y, _p.z], uvIn(region, (a + 1) / 2, (b + 1) / 2), [aoV * tint[0], aoV * tint[1], aoV * tint[2]], { aSway: sway * (0.6 + 0.4 * ((b + 1) / 2)) }));
    }
    B.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

// ---------------------------------------------------------------- species builders
// All trees are built at REF heights; instances scale uniformly (height / REF).
export const REF = { spruce: 20, pine: 24, birch: 16 };

// kind: 'white' (white spruce: fuller cone), 'fir' (balsam fir: narrow, flatter sprays),
// 'black' (black spruce: very narrow, club top, sparse)
export function buildSpruce(seed, kind = 'white') {
  const rng = makeRng(seed);
  const B = newBuilder();
  const H = REF.spruce;
  const cb = kind === 'black' ? H * (0.08 + rng() * 0.1) : H * (0.03 + rng() * 0.08);
  const baseR = H * (kind === 'white' ? 0.17 : kind === 'fir' ? 0.135 : 0.085) * (0.9 + rng() * 0.2);
  const tint = kind === 'fir' ? [0.92, 1.02, 0.95] : kind === 'black' ? [0.85, 0.92, 0.95] : [0.95, 1.0, 1.02];
  const r0 = H * 0.013;
  addTrunk(B, new THREE.Vector3(0, -0.6, 0), new THREE.Vector3(0, H * 0.985, 0), r0, 0.02, 6, REGION[kind === 'fir' ? 'barkGrey' : 'barkSpruce'], 5, 0.35, 0.6);
  let h = cb;
  let wi = 0;
  while (h < H - 0.5) {
    const tH = (h - cb) / (H - cb);
    let R = baseR * Math.pow(1 - tH, 0.95) + 0.28;
    if (kind === 'black') R *= tH > 0.8 ? 1.25 : tH < 0.3 ? 0.8 : 1;
    const n = kind === 'black' ? 4 : 5 + (rng() < 0.4 ? 1 : 0);
    const off = rng() * Math.PI * 2;
    const lightAO = 0.62 + 0.38 * Math.pow(tH, 0.7);
    for (let i = 0; i < n; i++) {
      const ang = off + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.5;
      const len = R * (0.8 + rng() * 0.35);
      const wid = Math.max(0.5, len * (kind === 'fir' ? 0.62 : 0.72));
      const droop0 = kind === 'fir' ? 0.08 + rng() * 0.1 : 0.14 + rng() * 0.12;
      const droop1 = kind === 'fir' ? 0.2 + rng() * 0.15 : 0.42 + rng() * 0.25;
      const roll = (rng() - 0.5) * 0.6;
      addCard(B, REGION.spruce, new THREE.Vector3(Math.cos(ang) * 0.06, h + (rng() - 0.5) * 0.25, Math.sin(ang) * 0.06), ang, len, wid, droop0, droop1, 0, 0, lightAO * (0.9 + rng() * 0.2), tint, roll);
    }
    // a few steep "filler" cards give the side silhouette body
    if (wi % 2 === 0 && tH < 0.85) {
      const ang = rng() * Math.PI * 2;
      const len = R * 0.8;
      addCard(B, REGION.spruce, new THREE.Vector3(0, h + 0.3, 0), ang, len, len * 0.7, 0.7, 0.9, 0, 0, lightAO * 0.8, tint, 0);
    }
    const step = (kind === 'black' ? 0.75 : 0.95) + rng() * 0.35;
    h += step * (1 - tH * 0.35);
    wi++;
  }
  // leader: two crossed vertical cards at the tip
  for (let i = 0; i < 2; i++) {
    const ang = (i * Math.PI) / 2 + rng();
    addCard(B, REGION.spruce, new THREE.Vector3(0, H - 1.4, 0), ang, 1.5, 0.45, -1.45, -1.5, 0, 0, 1.0, tint, 0, 0.6);
  }
  return B;
}

export function buildPine(seed, kind = 'white') {
  const rng = makeRng(seed);
  const B = newBuilder();
  const H = REF.pine;
  const white = kind === 'white';
  const tint = white ? [0.95, 1.02, 1.05] : [1.02, 1.0, 0.86];
  const bareTo = H * (white ? 0.42 + rng() * 0.12 : 0.58 + rng() * 0.1);
  const lean = [(rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6];
  const top = new THREE.Vector3(lean[0], H * 0.97, lean[1]);
  addTrunk(B, new THREE.Vector3(0, -0.6, 0), top, H * 0.014, 0.05, 7, white ? REGION.barkSpruce : REGION.barkPine, 4.5, 0.55, 0.85, (rng() - 0.5) * 0.4, (rng() - 0.5) * 0.4);
  const axisAt = (y) => [(lean[0] * y) / H, (lean[1] * y) / H];
  // dead stubs on the bare trunk
  for (let i = 0; i < 6; i++) {
    const y = H * 0.15 + rng() * (bareTo - H * 0.15);
    const ang = rng() * Math.PI * 2;
    const [ax, az] = axisAt(y);
    const p0 = new THREE.Vector3(ax, y, az);
    const p1 = new THREE.Vector3(ax + Math.cos(ang) * (0.4 + rng() * 0.8), y - 0.1 - rng() * 0.2, az + Math.sin(ang) * (0.4 + rng() * 0.8));
    addLimb(B, p0, p1, 0.035, 0.012, 3, REGION.barkGrey, 1, 0.5, 0.6);
  }
  const crownC = new THREE.Vector3(lean[0] * 0.8, (bareTo + H) / 2, lean[1] * 0.8);
  const nb = white ? 6 + Math.floor(rng() * 3) : 7 + Math.floor(rng() * 3);
  const golden = 2.39996;
  let ang = rng() * Math.PI * 2;
  for (let i = 0; i < nb; i++) {
    const t = i / (nb - 1);
    const y = bareTo + (H * 0.95 - bareTo) * t + (rng() - 0.5) * 0.6;
    ang += golden + (rng() - 0.5) * 0.5;
    const [ax, az] = axisAt(y);
    const len = white ? (5.2 - t * 3.3) * (0.7 + rng() * 0.6) : (3.4 - t * 1.9) * (0.75 + rng() * 0.5);
    const elev = white ? 0.05 + t * 0.35 + (rng() - 0.5) * 0.2 : 0.3 + t * 0.4 + (rng() - 0.5) * 0.2;
    const p0 = new THREE.Vector3(ax, y, az);
    const dir = new THREE.Vector3(Math.cos(ang) * Math.cos(elev), Math.sin(elev), Math.sin(ang) * Math.cos(elev));
    const p1 = p0.clone().addScaledVector(dir, len);
    addLimb(B, p0, p1, 0.1 - t * 0.04, 0.025, 4, white ? REGION.barkSpruce : REGION.barkPine, 1, 0.45, 0.75, 0, 0.6);
    // foliage pads along the outer part of the branch: flat layered tufts
    const nPads = white ? 3 + Math.floor(len / 1.3) : 3 + Math.floor(len / 1.2);
    for (let k = 0; k < nPads; k++) {
      const u = 0.4 + (k / Math.max(1, nPads - 1)) * 0.6;
      const c = p0.clone().addScaledVector(dir, len * u);
      c.y += 0.15 + rng() * 0.3;
      const size = (white ? 2.9 : 2.4) * (0.8 + rng() * 0.4);
      const ao = 0.55 + 0.45 * t;
      // flat horizontal-ish cards (white pine's layered look) + a couple of steeper ones
      for (let q = 0; q < 2; q++) {
        const a2 = ang + (rng() - 0.5) * 1.6;
        addCard(B, REGION.pine, new THREE.Vector3(c.x - Math.cos(a2) * size * 0.35, c.y, c.z - Math.sin(a2) * size * 0.35), a2, size, size * 0.8, -0.1 + rng() * 0.15, 0.1 + rng() * 0.25, crownC.x, crownC.z, ao, tint, (rng() - 0.5) * 0.7, 0.85);
      }
      addClump(B, REGION.pine, c.x, c.y + 0.2, c.z, size * 0.9, white ? 1 : 2, crownC, ao * 0.95, tint, rng, 1, 0.2);
    }
  }
  // leader tuft
  addClump(B, REGION.pine, top.x, top.y + 0.2, top.z, 2.4, 3, crownC, 1, tint, rng, 1, 0.1);
  return B;
}

export function buildBirch(seed) {
  const rng = makeRng(seed);
  const B = newBuilder();
  const H = REF.birch;
  const tint = [1, 1, 1];
  const stems = rng() < 0.45 ? 1 : rng() < 0.75 ? 2 : 3;
  const crownC = new THREE.Vector3(0, H * 0.66, 0);
  const tips = [];
  for (let s = 0; s < stems; s++) {
    const a = rng() * Math.PI * 2;
    const leanA = stems === 1 ? 0.05 + rng() * 0.08 : 0.1 + rng() * 0.12;
    const hS = H * (stems === 1 ? 0.96 : 0.8 + rng() * 0.18);
    const base = new THREE.Vector3(Math.cos(a) * 0.12 * (stems > 1 ? 1 : 0), -0.5, Math.sin(a) * 0.12 * (stems > 1 ? 1 : 0));
    const top = new THREE.Vector3(base.x + Math.cos(a) * Math.sin(leanA) * hS, hS, base.z + Math.sin(a) * Math.sin(leanA) * hS);
    const r0 = (stems === 1 ? 0.17 : 0.13) * (0.85 + rng() * 0.3);
    addTrunk(B, base, top, r0, 0.035, 7, REGION.barkBirch, 2.6, 0.5, 0.78, Math.cos(a + 1.3) * 0.25, Math.sin(a + 1.3) * 0.25);
    tips.push(top);
    // ascending branches from 45% up
    const nb = 5 + Math.floor(rng() * 4);
    for (let i = 0; i < nb; i++) {
      const t = 0.42 + (i / nb) * 0.5 + (rng() - 0.5) * 0.05;
      const p0 = new THREE.Vector3().lerpVectors(base, top, t);
      const ba = rng() * Math.PI * 2;
      const elev = 0.55 + rng() * 0.35;
      const len = (1 - t) * H * 0.34 * (0.7 + rng() * 0.6) + 0.8;
      const dir = new THREE.Vector3(Math.cos(ba) * Math.cos(elev), Math.sin(elev), Math.sin(ba) * Math.cos(elev));
      const p1 = p0.clone().addScaledVector(dir, len);
      addLimb(B, p0, p1, 0.045, 0.012, 3, REGION.barkBirch, 1, 0.55, 0.8, 0, 0.5);
      tips.push(p1);
    }
  }
  // leaf clusters: at branch tips and scattered through an ovoid crown
  const clusters = [];
  for (const tp of tips) clusters.push(tp.clone());
  const extra = 16 + Math.floor(rng() * 8);
  for (let i = 0; i < extra; i++) {
    const u = rng() * Math.PI * 2;
    const v = Math.acos(2 * rng() - 1);
    const rr = Math.pow(rng(), 0.4);
    clusters.push(new THREE.Vector3(crownC.x + Math.cos(u) * Math.sin(v) * H * 0.24 * rr, crownC.y + Math.cos(v) * H * 0.26 * rr, crownC.z + Math.sin(u) * Math.sin(v) * H * 0.24 * rr));
  }
  for (const c of clusters) {
    const out = Math.hypot(c.x - crownC.x, (c.y - crownC.y) * 0.9, c.z - crownC.z) / (H * 0.26);
    const ao = clamp(0.5 + out * 0.45 + ((c.y - crownC.y) / H) * 0.6, 0.35, 1);
    addClump(B, REGION.birch, c.x, c.y, c.z, 1.7 + rng() * 0.8, 2, crownC, ao, tint, rng, 1.4, 0.35);
  }
  return B;
}

// Bounding info (for impostor framing): half width and height of a builder's vertices.
export function builderExtents(B) {
  let hw = 0;
  let top = 0;
  for (let i = 0; i < B.count; i++) {
    hw = Math.max(hw, Math.abs(B.p[i * 3]), Math.abs(B.p[i * 3 + 2]));
    top = Math.max(top, B.p[i * 3 + 1]);
  }
  return { halfWidth: hw, height: top };
}
