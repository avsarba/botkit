// Deck props: an old green steel tackle box, a galvanized minnow bucket, galvanized dock cleats
// and a coiled dock line. Everything is procedural and built at real size (meters).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeRng, clamp, smoothstep } from '../config.js';
import { makeNoise2, fbm2, coarseField } from './noise.js';
import { dataTexture, normalMapFromHeight } from './texutil.js';
import { MeshBuilder } from './geo.js';

// Convert an indexed/non-indexed BufferGeometry into a MeshBuilder (optionally transformed).
export function builderFromGeometry(geom, matrix = null, color = null, uvScale = null) {
  const b = new MeshBuilder({ colors: true });
  const g = geom.index ? geom : geom;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    b.vert(
      [pos.getX(i), pos.getY(i), pos.getZ(i)],
      [nor.getX(i), nor.getY(i), nor.getZ(i)],
      uv ? [uv.getX(i) * (uvScale ? uvScale[0] : 1), uv.getY(i) * (uvScale ? uvScale[1] : 1)] : [0, 0],
      color
    );
  }
  if (g.index) for (let i = 0; i < g.index.count; i++) b.idx.push(g.index.getX(i));
  else for (let i = 0; i < pos.count; i++) b.idx.push(i);
  if (!matrix) return b;
  const out = new MeshBuilder({ colors: true });
  out.append(b, matrix);
  return out;
}

// ------------------------------------------------------------------ tackle box
const TB = { L: 0.46, D: 0.22, Hb: 0.14, Hl: 0.066 };
const TB_TEX = { W: 1024, H: 512 };
const TB_RECTS = {
  bodyFront: [0, 0, 460, 140],
  bodyBack: [464, 0, 460, 140],
  lidTop: [0, 144, 460, 220],
  lidFront: [464, 144, 460, 65],
  lidBack: [464, 213, 460, 65],
  bodyLeft: [0, 368, 220, 140],
  bodyRight: [224, 368, 220, 140],
  lidLeft: [448, 368, 220, 65],
  lidRight: [672, 368, 220, 65],
  bottom: [896, 368, 120, 130],
};

function makeTackleBoxTextures() {
  const { W, H } = TB_TEX;
  const color = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const orm = new Uint8Array(W * H * 4);
  const n = makeNoise2(301);
  const n2 = makeNoise2(302);
  const rng = makeRng(303);
  // fill background
  for (let i = 0; i < W * H; i++) {
    color[i * 4] = 60;
    color[i * 4 + 1] = 80;
    color[i * 4 + 2] = 56;
    color[i * 4 + 3] = 255;
    orm[i * 4] = 255;
    orm[i * 4 + 1] = 170;
    orm[i * 4 + 3] = 255;
  }
  let faceSeed = 0;
  for (const name in TB_RECTS) {
    const [rx, ry, rw, rh] = TB_RECTS[name];
    faceSeed += 17.3;
    const isTop = name === 'lidTop';
    const isBody = name.startsWith('body');
    const fade = isTop ? 0.75 : name.startsWith('lid') ? 0.45 : 0.3;
    // scratches (line segments) in face pixel space
    const scratches = [];
    const ns = isTop ? 26 : 10;
    for (let i = 0; i < ns; i++) {
      const x0 = rng() * rw;
      const y0 = rng() * rh;
      const a = (rng() - 0.5) * 1.2 + (rng() < 0.5 ? 0 : Math.PI / 2) * 0.2;
      const len = 8 + rng() * 60;
      scratches.push([x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, rng()]);
    }
    const drips = [];
    const nd = name === 'bodyBack' ? 5 : name === 'bodyFront' ? 3 : 1;
    for (let i = 0; i < nd; i++) drips.push({ x: name === 'bodyFront' ? rw / 2 + (rng() - 0.5) * 40 : rng() * rw, len: 20 + rng() * 80, w: 1.5 + rng() * 3 });
    const mottF = coarseField(rw, rh, 6, (x, y) => fbm2(n, x * 0.02 + faceSeed, y * 0.02, 4));
    const wearF = coarseField(rw, rh, 2, (x, y) => fbm2(n2, x * 0.07 + faceSeed, y * 0.07, 3));
    for (const sc of scratches) {
      sc.minX = Math.min(sc[0], sc[2]) - 1;
      sc.maxX = Math.max(sc[0], sc[2]) + 1;
      sc.minY = Math.min(sc[1], sc[3]) - 1;
      sc.maxY = Math.max(sc[1], sc[3]) + 1;
    }
    const doRow = (fy) => {
      for (let fx = 0; fx < rw; fx++) {
        const px = rx + fx;
        const py = ry + fy;
        if (px >= W || py >= H) continue;
        const e = Math.min(fx, rw - 1 - fx, fy, rh - 1 - fy);
        const mott = mottF(fx, fy);
        const f2 = wearF(fx, fy);
        // paint
        const fd = clamp(fade * (0.6 + mott * 0.6), 0, 1);
        let r = 58 + (96 - 58) * fd;
        let g = 80 + (108 - 80) * fd;
        let b = 55 + (84 - 55) * fd;
        let f = 1 + mott * 0.06;
        let h = mott * 0.0003;
        let rough = 0.62 + fd * 0.18;
        let metal = 0;
        let ao = 1;
        // raised panel on the lid top
        if (isTop) h += 0.0012 * smoothstep(15, 21, e);
        // edge wear -> primer -> bare steel / rust
        const wear = f2 * 0.5 + 0.5 + 0.42 * (1 - smoothstep(0, 9, e)) + 0.22 * (1 - smoothstep(0, 2.5, e));
        if (wear > 0.73) {
          const t = smoothstep(0.73, 0.77, wear);
          r += (118 - r) * t;
          g += (92 - g) * t;
          b += (78 - b) * t;
          rough += (0.8 - rough) * t;
          h -= 0.00008 * t;
        }
        if (wear > 0.79) {
          const rustN = n(fx * 0.15 + faceSeed, fy * 0.15);
          if (rustN > -0.15) {
            const rr = 0.8 + n2(fx * 0.6, fy * 0.6) * 0.2;
            r = 112 * rr;
            g = 60 * rr;
            b = 30 * rr;
            rough = 0.88;
            h -= 0.00005 - rustN * 0.00015;
          } else {
            r = 150;
            g = 150;
            b = 146;
            rough = 0.38;
            metal = 1;
          }
          f = 1;
        }
        // scratches
        for (const s of scratches) {
          if (fx < s.minX || fx > s.maxX || fy < s.minY || fy > s.maxY) continue;
          const dx = s[2] - s[0];
          const dy = s[3] - s[1];
          const l2 = dx * dx + dy * dy;
          let t = ((fx - s[0]) * dx + (fy - s[1]) * dy) / l2;
          if (t < 0 || t > 1) continue;
          const qx = s[0] + dx * t - fx;
          const qy = s[1] + dy * t - fy;
          const d = Math.sqrt(qx * qx + qy * qy);
          if (d < 0.8) {
            const m = (1 - d / 0.8) * (0.4 + s[4] * 0.6) * Math.sin(Math.PI * t);
            r += (140 - r) * m * 0.6;
            g += (140 - g) * m * 0.6;
            b += (128 - b) * m * 0.6;
            h -= 0.00006 * m;
          }
        }
        // rust drips running down vertical faces
        if (!isTop) {
          for (const d of drips) {
            const dxp = Math.abs(fx - d.x - n(fy * 0.05, d.x) * 3);
            if (dxp < d.w * 2 && fy < d.len) {
              const m = Math.exp(-(dxp * dxp) / (d.w * d.w)) * (1 - fy / d.len) * 0.55;
              r += (92 - r) * m;
              g += (58 - g) * m;
              b += (36 - b) * m;
            }
          }
          // grime near the bottom of the body
          if (isBody) f *= 1 - 0.28 * smoothstep(0.55, 1.0, fy / rh) * (0.6 + 0.4 * mott);
        }
        // maker's plate on the front
        if (name === 'bodyFront' && Math.abs(fx - rw / 2) < 34 && fy > 70 && fy < 92) {
          const pe = Math.min(34 - Math.abs(fx - rw / 2), fy - 70, 92 - fy);
          r = 150;
          g = 146;
          b = 132;
          f = 0.85 + mott * 0.2;
          metal = 0.8;
          rough = 0.45;
          h = 0.0004 * smoothstep(0, 2, pe);
          if (fy > 78 && fy < 84 && Math.abs(fx - rw / 2) < 26 && n2(fx * 0.4, fy * 0.9) > 0.1) f *= 0.55;
        }
        // faded label on the lid top
        if (isTop) {
          const lx = (fx - rw * 0.5) / 120;
          const ly = (fy - rh * 0.5) / 45;
          const le = lx * lx + ly * ly;
          if (le < 1) {
            const m = (1 - smoothstep(0.85, 1, le)) * clamp(0.35 + n(fx * 0.05, fy * 0.05) * 0.8, 0, 1) * 0.55;
            r += (170 - r) * m;
            g += (160 - g) * m;
            b += (126 - b) * m;
          }
        }
        const i = py * W + px;
        color[i * 4] = clamp(r * f, 0, 255);
        color[i * 4 + 1] = clamp(g * f, 0, 255);
        color[i * 4 + 2] = clamp(b * f, 0, 255);
        height[i] = h;
        orm[i * 4] = clamp(ao, 0, 1) * 255;
        orm[i * 4 + 1] = clamp(rough, 0, 1) * 255;
        orm[i * 4 + 2] = clamp(metal, 0, 1) * 255;
      }
    };
    for (let fy = 0; fy < rh; fy++) doRow(fy);
  }
  const normal = normalMapFromHeight(height, W, H, 0.001, 0.001, { strength: 1 });
  return {
    map: dataTexture(color, W, H, { srgb: true, anisotropy: 4 }),
    normalMap: dataTexture(normal, W, H, { srgb: false, anisotropy: 4 }),
    ormMap: dataTexture(orm, W, H, { srgb: false, anisotropy: 4 }),
  };
}

function remapBoxUVs(geom, sx, sy, sz, faces) {
  const pos = geom.attributes.position;
  const nor = geom.attributes.normal;
  const uv = geom.attributes.uv;
  const { W, H } = TB_TEX;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let rect;
    let a;
    let b; // b: 0 at the top row of the rect
    if (ay >= ax && ay >= az) {
      rect = ny > 0 ? faces.top : faces.bottom;
      a = (x + sx / 2) / sx;
      b = (z + sz / 2) / sz;
    } else if (az >= ax) {
      rect = nz > 0 ? faces.front : faces.back;
      a = nz > 0 ? (x + sx / 2) / sx : (sx / 2 - x) / sx;
      b = (sy / 2 - y) / sy;
    } else {
      rect = nx > 0 ? faces.right : faces.left;
      a = nx > 0 ? (sz / 2 - z) / sz : (z + sz / 2) / sz;
      b = (sy / 2 - y) / sy;
    }
    a = clamp(a, 0, 1);
    b = clamp(b, 0, 1);
    const [rx, ry, rw, rh] = TB_RECTS[rect];
    uv.setXY(i, (rx + 0.5 + a * (rw - 1)) / W, (ry + 0.5 + b * (rh - 1)) / H);
  }
  uv.needsUpdate = true;
}

// Returns { paint: MeshBuilder (tackle-box paint material), hardware: MeshBuilder (steel), textures }
export function buildTackleBox() {
  const tex = makeTackleBoxTextures();
  const body = new RoundedBoxGeometry(TB.L, TB.Hb, TB.D, 2, 0.007);
  remapBoxUVs(body, TB.L, TB.Hb, TB.D, { top: 'lidTop', bottom: 'bottom', front: 'bodyFront', back: 'bodyBack', left: 'bodyLeft', right: 'bodyRight' });
  body.translate(0, TB.Hb / 2, 0);
  const lid = new RoundedBoxGeometry(TB.L + 0.004, TB.Hl, TB.D + 0.004, 2, 0.009);
  remapBoxUVs(lid, TB.L + 0.004, TB.Hl, TB.D + 0.004, { top: 'lidTop', bottom: 'bottom', front: 'lidFront', back: 'lidBack', left: 'lidLeft', right: 'lidRight' });
  lid.translate(0, TB.Hb + TB.Hl / 2 + 0.0015, 0);
  const paint = new MeshBuilder({ colors: true });
  paint.append(builderFromGeometry(body));
  paint.append(builderFromGeometry(lid));
  body.dispose();
  lid.dispose();

  const hw = new MeshBuilder({ colors: true });
  const top = TB.Hb + TB.Hl + 0.0015;
  const steel = [0.95, 0.95, 0.95];
  // folded-down strap handle on the lid
  const hp = [
    [-0.075, top + 0.004, -0.012],
    [-0.075, top + 0.005, 0.026],
    [-0.062, top + 0.006, 0.044],
    [0, top + 0.0065, 0.047],
    [0.062, top + 0.006, 0.044],
    [0.075, top + 0.005, 0.026],
    [0.075, top + 0.004, -0.012],
  ].map((p) => new THREE.Vector3(...p));
  const handle = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hp), 40, 0.0042, 6, false);
  handle.scale(1, 0.55, 1);
  handle.translate(0, top * 0.45, 0);
  hw.append(builderFromGeometry(handle, null, steel));
  handle.dispose();
  for (const sx of [-1, 1]) {
    const pv = new THREE.BoxGeometry(0.014, 0.012, 0.024);
    pv.translate(sx * 0.075, top + 0.005, -0.012);
    hw.append(builderFromGeometry(pv, null, steel));
    pv.dispose();
  }
  // latch on the front, straddling the seam
  const latch = new THREE.BoxGeometry(0.032, 0.046, 0.005);
  latch.translate(0, TB.Hb + 0.004, TB.D / 2 + 0.004);
  hw.append(builderFromGeometry(latch, null, steel));
  latch.dispose();
  const hasp = new THREE.TorusGeometry(0.009, 0.0022, 5, 10, Math.PI);
  hasp.translate(0, TB.Hb - 0.022, TB.D / 2 + 0.0075);
  hw.append(builderFromGeometry(hasp, null, steel));
  hasp.dispose();
  // piano hinge along the back seam
  const hinge = new THREE.CylinderGeometry(0.0038, 0.0038, TB.L - 0.03, 8);
  hinge.rotateZ(Math.PI / 2);
  hinge.translate(0, TB.Hb + 0.001, -TB.D / 2 - 0.0025);
  hw.append(builderFromGeometry(hinge, null, [0.7, 0.62, 0.55]));
  hinge.dispose();
  return { paint, hardware: hw, textures: tex };
}

// ------------------------------------------------------------------ minnow bucket (galvanized)
export function buildBucket() {
  const b = new MeshBuilder({ colors: true });
  const V = (r, y) => new THREE.Vector2(r, y);
  const shell = [
    V(0.0, 0.006),
    V(0.108, 0.006),
    V(0.117, 0.001),
    V(0.123, 0.004),
    V(0.1245, 0.011),
    V(0.1205, 0.016),
    V(0.1215, 0.03),
    V(0.1245, 0.07),
    V(0.1285, 0.076),
    V(0.1295, 0.081),
    V(0.1265, 0.087),
    V(0.1315, 0.15),
    V(0.1355, 0.156),
    V(0.1365, 0.161),
    V(0.1335, 0.167),
    V(0.1375, 0.226),
    V(0.1445, 0.231),
    V(0.1462, 0.2385),
    V(0.1425, 0.2445),
  ];
  const g1 = new THREE.LatheGeometry(shell, 36);
  b.append(builderFromGeometry(g1, null, [1, 1, 1], [5, 1.3]));
  g1.dispose();
  const lidPts = [V(0.1455, 0.2405), V(0.1415, 0.2475), V(0.118, 0.2515), V(0.082, 0.2545), V(0.0765, 0.2555), V(0.0755, 0.2625), V(0.0715, 0.2645), V(0.0, 0.2645)];
  const g2 = new THREE.LatheGeometry(lidPts, 36);
  b.append(builderFromGeometry(g2, null, [0.93, 0.93, 0.92], [5, 1]));
  g2.dispose();
  // flip door with a hinge and a small knob
  const door = new THREE.CylinderGeometry(0.066, 0.066, 0.003, 28);
  door.translate(0, 0.2665, 0);
  b.append(builderFromGeometry(door, null, [0.88, 0.88, 0.87], [2, 2]));
  door.dispose();
  const hinge = new THREE.CylinderGeometry(0.004, 0.004, 0.04, 8);
  hinge.rotateZ(Math.PI / 2);
  hinge.translate(0, 0.268, -0.066);
  b.append(builderFromGeometry(hinge, null, [0.8, 0.8, 0.8]));
  hinge.dispose();
  const knob = new THREE.CylinderGeometry(0.006, 0.007, 0.012, 10);
  knob.translate(0, 0.273, 0.052);
  b.append(builderFromGeometry(knob, null, [0.75, 0.75, 0.74]));
  knob.dispose();
  // bail ears and wire bail lying down toward -x
  for (const sx of [-1, 1]) {
    const ear = new THREE.BoxGeometry(0.006, 0.03, 0.022);
    ear.translate(0, 0.207, 0);
    ear.translate(0, 0, 0);
    const m = new THREE.Matrix4().makeTranslation(sx * 0.1335, 0, 0);
    ear.applyMatrix4(m);
    b.append(builderFromGeometry(ear, null, [0.9, 0.9, 0.9]));
    ear.dispose();
  }
  const tilt = 1.22; // radians from vertical, resting against the lid
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI;
    const x = Math.cos(a) * 0.1375;
    const up = Math.sin(a) * 0.15;
    pts.push(new THREE.Vector3(x, 0.207 + up * Math.cos(tilt), -up * Math.sin(tilt)));
  }
  const bail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.0026, 5, false);
  b.append(builderFromGeometry(bail, null, [0.85, 0.85, 0.85]));
  bail.dispose();
  return b;
}

// ------------------------------------------------------------------ cleat (8" galvanized)
export function buildCleat() {
  const b = new MeshBuilder({ colors: true });
  const V = (r, y) => new THREE.Vector2(r, y);
  const prof = [V(0.0005, -0.102), V(0.0065, -0.1), V(0.0088, -0.092), V(0.0098, -0.075), V(0.0112, -0.04), V(0.0126, -0.015), V(0.0128, 0), V(0.0126, 0.015), V(0.0112, 0.04), V(0.0098, 0.075), V(0.0088, 0.092), V(0.0065, 0.1), V(0.0005, 0.102)];
  const horn = new THREE.LatheGeometry(prof, 14);
  horn.rotateX(Math.PI / 2);
  horn.scale(1, 0.82, 1);
  horn.translate(0, 0.052, 0);
  b.append(builderFromGeometry(horn, null, [1, 1, 1], [1, 2]));
  horn.dispose();
  for (const sz of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.0095, 0.013, 0.046, 10);
    leg.scale(1, 1, 1.25);
    leg.translate(0, 0.026, sz * 0.03);
    b.append(builderFromGeometry(leg, null, [1, 1, 1]));
    leg.dispose();
  }
  const base = new THREE.BoxGeometry(0.036, 0.006, 0.13);
  base.translate(0, 0.003, 0);
  b.append(builderFromGeometry(base, null, [0.96, 0.96, 0.96]));
  base.dispose();
  for (const sz of [-1, 1]) {
    const sc = new THREE.CylinderGeometry(0.0048, 0.0052, 0.0025, 10);
    sc.translate(0, 0.0072, sz * 0.056);
    b.append(builderFromGeometry(sc, null, [0.55, 0.42, 0.32]));
    sc.dispose();
  }
  return b;
}

// ------------------------------------------------------------------ rope (1/2" three-strand, weathered)
export function makeRopeTextures() {
  const S = 256;
  const n = makeNoise2(401);
  const color = new Uint8Array(S * S * 4);
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const q = 3 * (v + u);
      const ph = q - Math.floor(q);
      const strand = ((Math.floor(q) % 3) + 3) % 3;
      const prof = Math.sin(Math.PI * ph);
      const fib = n(ph * 40 + strand * 7, (u - v * 0.3) * 24, 0, 24) * 0.5 + n(ph * 90, (u - v * 0.3) * 60, 0, 60) * 0.5;
      const dirt = fbm2(n, u * 4 + 3, v * 4, 3, 4, 4);
      const sh = [1.0, 0.94, 0.88][strand];
      const f = (0.55 + 0.45 * Math.sqrt(prof)) * sh * (1 + fib * 0.12) * (1 + dirt * 0.18);
      const i = (y * S + x) * 4;
      color[i] = clamp(152 * f, 0, 255);
      color[i + 1] = clamp(136 * f, 0, 255);
      color[i + 2] = clamp(108 * f, 0, 255);
      color[i + 3] = 255;
      height[i / 4] = Math.sqrt(prof) * 0.0016 + fib * 0.00015;
    }
  }
  // texture spans one lay length (~42 mm) along u and the circumference (~41 mm) along v
  const normal = normalMapFromHeight(height, S, S, 0.042 / S, 0.041 / S, { wrapX: true, wrapY: true });
  return {
    map: dataTexture(color, S, S, { srgb: true, repeat: true, anisotropy: 4 }),
    normalMap: dataTexture(normal, S, S, { srgb: false, repeat: true, anisotropy: 4 }),
  };
}

// A loose pile of loops on the deck with the working end running to a cleat horn.
// `origin` = coil center on the deck (Vector3, y = deck), `cleat` = horn position (Vector3).
export function buildRopeCoil(origin, cleat, seed = 5) {
  const rng = makeRng(seed);
  const R = 0.0065;
  const pts = [];
  const loops = 5;
  let ang = 0;
  for (let i = 0; i < loops; i++) {
    const rad = 0.13 + rng() * 0.035;
    const cx = (rng() - 0.5) * 0.04;
    const cz = (rng() - 0.5) * 0.04;
    const steps = 14;
    for (let s = 0; s < steps; s++) {
      const a = ang + (s / steps) * Math.PI * 2;
      const wob = 1 + Math.sin(a * 3 + i) * 0.04;
      const y = R + i * R * 0.9 * (0.55 + 0.45 * Math.sin(a + i * 1.7)) + R * 0.25;
      pts.push(new THREE.Vector3(origin.x + cx + Math.cos(a) * rad * wob, origin.y + Math.max(R, y), origin.z + cz + Math.sin(a) * rad * wob));
    }
    ang += 0.35;
  }
  // tail: from the last loop across the deck to the cleat, lifting at the horn
  const last = pts[pts.length - 1].clone();
  const toC = new THREE.Vector3().subVectors(cleat, last);
  const len = toC.length();
  const side = new THREE.Vector3(-toC.z, 0, toC.x).normalize();
  const nt = Math.max(3, Math.floor(len / 0.15));
  for (let i = 1; i <= nt; i++) {
    const t = i / nt;
    const p = last.clone().addScaledVector(toC, t);
    p.addScaledVector(side, Math.sin(t * Math.PI) * 0.05);
    p.y = origin.y + R + smoothstep(0.75, 1, t) * (cleat.y - origin.y - R);
    pts.push(p);
  }
  // wrap once around the horn
  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    pts.push(new THREE.Vector3(cleat.x + Math.cos(a) * 0.017, cleat.y + Math.sin(a) * 0.015, cleat.z + 0.02 + (i / 8) * 0.03));
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const length = curve.getLength();
  const segs = Math.floor(length / 0.012);
  const g = new THREE.TubeGeometry(curve, segs, R, 6, false);
  // one texture repeat per lay length
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * length) / 0.042);
  return g;
}
