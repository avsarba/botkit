// 7'0" medium-power, fast-action graphite spinning rod + size-2500 spinning reel.
// Rod-local frame (meters): origin at the reel seat, +Y along the blank toward the tip,
// -Z is the guide/reel side (hangs down when held), +X to the angler's right.
// The flexible part of the blank (above the fore grip) bends as a tapered cantilever elastica
// under a tip load; blank, wraps, guides and tip-top are one CPU-deformed geometry.
import * as THREE from 'three';
import { clamp } from '../config.js';
import { sweepTube, lathe, mergeParts, ringY } from './geom.js';
import { makeCorkTextures, makeSpoolLineTexture, makeKnurlBump, makeRodDecalTexture } from './textures.js';

export const ROD = Object.freeze({
  buttY: -0.375,
  tipY: 1.755, // butt to tip = 2.13 m (7'0")
  flexY0: 0.142,
  segs: 32,
  guides: [
    { y: 0.515, r: 0.0125, h: 0.058, double: true },
    { y: 0.855, r: 0.0082, h: 0.036 },
    { y: 1.125, r: 0.0056, h: 0.0245 },
    { y: 1.335, r: 0.0046, h: 0.0185 },
    { y: 1.505, r: 0.0039, h: 0.015 },
    { y: 1.645, r: 0.0034, h: 0.0125 },
  ],
  tipRing: 0.0029,
  reelY: 0.028,
  reelZ: -0.0795,
  // bend calibration (shooting-method elastica): compliance ~ C0 / (r/rBase)^P  [rad / (N m^2)]
  C0: 0.02,
  P: 3,
});

const R_TIP = 0.00115;
const R_BASE = 0.0058;

export function blankRadius(y) {
  if (y <= ROD.flexY0) return 0.006;
  const u = clamp((y - ROD.flexY0) / (ROD.tipY - ROD.flexY0), 0, 1);
  return R_TIP + (R_BASE - R_TIP) * Math.pow(1 - u, 1.35);
}

function makeMaterials() {
  const cork = makeCorkTextures();
  const knurl = makeKnurlBump();
  return {
    blank: new THREE.MeshPhysicalMaterial({ color: 0x1b1f22, roughness: 0.36, metalness: 0.22, clearcoat: 1, clearcoatRoughness: 0.09 }),
    thread: new THREE.MeshPhysicalMaterial({ color: 0x101113, roughness: 0.5, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xbfc3c7, metalness: 1, roughness: 0.3 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x2d3034, metalness: 1, roughness: 0.24 }),
    insert: new THREE.MeshPhysicalMaterial({ color: 0x4f545a, metalness: 0.55, roughness: 0.12, clearcoat: 0.6, clearcoatRoughness: 0.05 }),
    decal: new THREE.MeshStandardMaterial({
      map: makeRodDecalTexture(),
      transparent: true,
      alphaTest: 0.25,
      metalness: 0.7,
      roughness: 0.35,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    cork: new THREE.MeshStandardMaterial({ map: cork.map, bumpMap: cork.bump, bumpScale: 2.2, roughness: 0.86 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x151516, roughness: 0.9 }),
    seat: new THREE.MeshPhysicalMaterial({ color: 0x17181b, roughness: 0.3, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.12 }),
    gunmetal: new THREE.MeshStandardMaterial({ color: 0x5b6066, metalness: 1, roughness: 0.3 }),
    knurl: new THREE.MeshStandardMaterial({ color: 0x1d1e21, metalness: 0.55, roughness: 0.42, bumpMap: knurl, bumpScale: 1.5 }),
    reelBody: new THREE.MeshPhysicalMaterial({ color: 0x1e2024, roughness: 0.4, metalness: 0.3, clearcoat: 0.55, clearcoatRoughness: 0.22 }),
    spool: new THREE.MeshStandardMaterial({ color: 0xb2b8be, metalness: 1, roughness: 0.27 }),
    spoolLine: new THREE.MeshStandardMaterial({ map: makeSpoolLineTexture(), roughness: 0.38 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xdcdee1, metalness: 1, roughness: 0.13 }),
    knob: new THREE.MeshStandardMaterial({ color: 0x19191b, roughness: 0.86 }),
  };
}

export function createRod({ quality = 'high' } = {}) {
  const radial = quality === 'low' ? 8 : quality === 'medium' ? 10 : 12;
  const M = makeMaterials();
  const pose = new THREE.Group();
  pose.name = 'rod';

  // ------------------------------------------------------------------ flex section
  const flex = [];
  const G_BLANK = 0;
  const G_THREAD = 1;
  const G_TRIM = 2;
  const G_FRAME = 3;
  const G_INSERT = 4;
  const G_DECAL = 5;
  {
    const prof = [[0, -0.166]];
    const n = 76;
    for (let i = 0; i <= n; i++) {
      const y = -0.162 + ((ROD.tipY - 0.0012 + 0.162) * i) / n;
      prof.push([blankRadius(y), y]);
    }
    prof.push([0, ROD.tipY]);
    flex.push({ geometry: lathe(prof, radial), group: G_BLANK, sRef: 'y' });
  }
  const wrap = (y0, y1, t = 0.0008, trims = true) => {
    const r0 = blankRadius(y0);
    const r1 = blankRadius(y1);
    flex.push({
      geometry: lathe(
        [
          [r0, y0 - 0.0005],
          [r0 + t * 0.75, y0],
          [r0 + t, y0 + 0.0009],
          [r1 + t, y1 - 0.0009],
          [r1 + t * 0.75, y1],
          [r1, y1 + 0.0005],
        ],
        radial
      ),
      group: G_THREAD,
      sRef: 'y',
    });
    if (trims) {
      for (const yt of [y0 + 0.0011, y1 - 0.0011]) {
        const r = blankRadius(yt) + t + 0.00012;
        flex.push({
          geometry: lathe(
            [
              [r - 0.0002, yt - 0.00065],
              [r, yt - 0.00045],
              [r, yt + 0.00045],
              [r - 0.0002, yt + 0.00065],
            ],
            radial
          ),
          group: G_TRIM,
          sRef: 'y',
        });
      }
    }
  };
  // decorative butt wrap above the fore grip and the hook keeper wrap
  wrap(0.1425, 0.172, 0.0007);
  // model decal on the top of the blank (faces the angler)
  {
    const y0 = 0.19;
    const y1 = 0.3;
    const prof = [];
    for (let i = 0; i <= 8; i++) {
      const y = y0 + ((y1 - y0) * i) / 8;
      prof.push([blankRadius(y) + 0.00004, y]);
    }
    const g = lathe(prof, 6, { phiStart: -0.62, phiLength: 1.24 });
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const phi = Math.atan2(p.getX(i), p.getZ(i));
      uv.setXY(i, (p.getY(i) - y0) / (y1 - y0), 0.5 - phi / 1.24);
    }
    flex.push({ geometry: g, group: G_DECAL, sRef: 'y' });
  }
  // guides (on the -Z side), V-frame legs to a foot under a thread wrap
  const guideRef = []; // { s, local: Vector3 } ring centers (straight)
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  for (const gd of ROD.guides) {
    const rb = blankRadius(gd.y);
    const R = gd.r;
    const ft = Math.max(0.00042, R * 0.07);
    const cz = -gd.h;
    const insT = R * 0.16;
    flex.push({ geometry: ringY(R - insT, insT, 6, 28, 0, gd.y, cz), group: G_INSERT, sRef: gd.y });
    flex.push({ geometry: ringY(R + ft * 0.5, ft, 5, 28, 0, gd.y - insT * 0.3, cz), group: G_FRAME, sRef: gd.y });
    const legBack = Math.max(0.0045, gd.h * 0.55);
    const footY = gd.y - legBack;
    const footZ = -(rb + ft * 0.6);
    const legs = (dir) => {
      for (const side of [-1, 1]) {
        const a = 0.72;
        const p0 = V(side * Math.sin(a) * (R + ft), gd.y + (dir > 0 ? 0.0004 : -0.0004), cz + Math.cos(a) * (R + ft));
        const p2 = V(side * ft * 0.9, gd.y + dir * legBack, footZ);
        const p1 = V((p0.x + p2.x) * 0.5 + side * ft * 0.8, (p0.y + p2.y) * 0.5, (p0.z + p2.z) * 0.5 - 0.0006);
        flex.push({ geometry: sweepTube([p0, p1, p2], ft, 5), group: G_FRAME, sRef: gd.y });
      }
    };
    legs(-1);
    const footLen = Math.max(0.0065, gd.h * 0.3);
    wrap(footY - footLen - 0.0015, footY + 0.0018, 0.00085);
    if (gd.double) {
      legs(1);
      const fy = gd.y + legBack;
      wrap(fy - 0.0018, fy + footLen + 0.0015, 0.00085);
    }
    guideRef.push({ s: gd.y, local: V(0, gd.y, cz) });
  }
  // tip-top: sleeve over the blank end + ring
  const rtt = blankRadius(ROD.tipY - 0.004);
  const RT = ROD.tipRing;
  const tipCenter = V(0, ROD.tipY + 0.0008, -(rtt + RT + 0.0009));
  {
    flex.push({
      geometry: lathe(
        [
          [rtt + 0.00025, ROD.tipY - 0.0125],
          [rtt + 0.0005, ROD.tipY - 0.012],
          [rtt + 0.0005, ROD.tipY - 0.001],
          [rtt + 0.0003, ROD.tipY],
          [0, ROD.tipY + 0.0002],
        ],
        radial
      ),
      group: G_FRAME,
      sRef: ROD.tipY,
    });
    const insT = RT * 0.18;
    flex.push({ geometry: ringY(RT - insT, insT, 6, 22, tipCenter.x, tipCenter.y, tipCenter.z), group: G_INSERT, sRef: ROD.tipY });
    flex.push({ geometry: ringY(RT + 0.0002, 0.00032, 5, 22, tipCenter.x, tipCenter.y - 0.0002, tipCenter.z), group: G_FRAME, sRef: ROD.tipY });
    flex.push({
      geometry: sweepTube([V(0, ROD.tipY - 0.0065, -rtt - 0.0003), V(0, ROD.tipY - 0.0022, -rtt - 0.0009), V(0, tipCenter.y, tipCenter.z + RT + 0.0002)], 0.00045, 5),
      group: G_FRAME,
      sRef: ROD.tipY,
    });
    guideRef.push({ s: ROD.tipY, local: tipCenter.clone() });
  }
  const merged = mergeParts(flex, true);
  const flexGeo = merged.geometry;
  const sRef = merged.sRef;
  const flexMesh = new THREE.Mesh(flexGeo, [M.blank, M.thread, M.trim, M.frame, M.insert, M.decal]);
  flexMesh.name = 'rod-flex';
  pose.add(flexMesh);

  // per-vertex deformation tables: unique arc positions -> frames
  const basePos = Float32Array.from(flexGeo.attributes.position.array);
  const baseNrm = Float32Array.from(flexGeo.attributes.normal.array);
  const vCount = sRef.length;
  const keyMap = new Map();
  const uniq = [];
  const vKey = new Int32Array(vCount).fill(-1);
  const deformList = [];
  for (let i = 0; i < vCount; i++) {
    const s = sRef[i];
    const y = basePos[i * 3 + 1];
    if (s <= ROD.flexY0 && y <= ROD.flexY0) continue;
    const sc = Math.max(ROD.flexY0, s);
    const k = Math.round(sc * 20000);
    let id = keyMap.get(k);
    if (id === undefined) {
      id = uniq.length;
      keyMap.set(k, id);
      uniq.push(sc);
    }
    vKey[i] = id;
    deformList.push(i);
  }
  const deformIdx = Int32Array.from(deformList);
  const U = uniq.length;
  const uS = Float64Array.from(uniq);
  const uJ = new Int32Array(U);
  const uF = new Float64Array(U);
  const NSEG = ROD.segs;
  const LF = ROD.tipY - ROD.flexY0;
  const DS = LF / NSEG;
  for (let k = 0; k < U; k++) {
    const x = (uS[k] - ROD.flexY0) / DS;
    let j = Math.floor(x);
    if (j < 0) j = 0;
    if (j > NSEG - 1) j = NSEG - 1;
    uJ[k] = j;
    uF[k] = clamp(x - j, 0, 1);
  }
  const uCu = new Float64Array(U);
  const uCv = new Float64Array(U);
  const uCos = new Float64Array(U);
  const uSin = new Float64Array(U);
  // segment compliance
  const comp = new Float64Array(NSEG);
  for (let j = 0; j < NSEG; j++) {
    const y = ROD.flexY0 + (j + 0.5) * DS;
    comp[j] = ROD.C0 / Math.pow(blankRadius(y) / R_BASE, ROD.P);
  }
  const th = new Float64Array(NSEG + 1);
  const thTmp = new Float64Array(NSEG + 1);
  const nu = new Float64Array(NSEG + 1);
  const nv = new Float64Array(NSEG + 1);
  const bendB = new THREE.Vector3(0, 0, -1);
  let lastTipTh = 1;
  let lastBx = 0;
  let lastBz = -1;

  // integrate from the tip (free end, zero moment) back to the clamp; returns the base angle
  function shoot(thTip, Fu, Fv, out) {
    let pu = 0;
    let pv = 0;
    let t = thTip;
    out[NSEG] = t;
    for (let j = NSEG - 1; j >= 0; j--) {
      const mu = pu - 0.5 * DS * Math.cos(t);
      const mv = pv - 0.5 * DS * Math.sin(t);
      const mo = -mu * Fv + mv * Fu;
      const k = mo * comp[j];
      const tm = t - 0.5 * k * DS;
      pu -= DS * Math.cos(tm);
      pv -= DS * Math.sin(tm);
      t -= k * DS;
      out[j] = t;
    }
    return t;
  }

  const tipLocal = new THREE.Vector3().copy(tipCenter);
  const tipTangent = new THREE.Vector3(0, 1, 0);
  const guideLocal = guideRef.map((g) => g.local.clone());

  // deform one point given in straight rod-local coordinates with rigid reference s
  function deformPoint(s, bx, by, bz, out) {
    const x = (Math.max(ROD.flexY0, s) - ROD.flexY0) / DS;
    let j = Math.floor(x);
    if (j < 0) j = 0;
    if (j > NSEG - 1) j = NSEG - 1;
    const f = clamp(x - j, 0, 1);
    const sc = Math.max(ROD.flexY0, s);
    const d0 = th[j];
    const d1 = th[j + 1];
    const ts = d0 + (d1 - d0) * f;
    const tm = d0 + (d1 - d0) * f * 0.5;
    const cu = nu[j] + DS * f * Math.cos(tm);
    const cv = nv[j] + DS * f * Math.sin(tm);
    const c = Math.cos(ts);
    const sn = Math.sin(ts);
    const bX = bendB.x;
    const bZ = bendB.z;
    const nX = bZ;
    const nZ = -bX;
    const dy = by - sc;
    const ob = bx * bX + bz * bZ;
    const on = bx * nX + bz * nZ;
    out.set(
      cv * bX + dy * sn * bX + ob * c * bX + on * nX,
      ROD.flexY0 + cu + dy * c - ob * sn,
      cv * bZ + dy * sn * bZ + ob * c * bZ + on * nZ
    );
    return out;
  }

  // F: tip load in rod-local coordinates (newtons)
  function setLoad(F) {
    const Fa = F.y;
    const Fp = Math.hypot(F.x, F.z);
    const mag = Math.hypot(Fa, Fp);
    if (Fp > 1e-5) bendB.set(F.x / Fp, 0, F.z / Fp);
    if (mag < 1e-4 || Fp < 1e-6 || !Number.isFinite(mag)) {
      th.fill(0);
    } else {
      const ang = Math.min(Math.atan2(Fp, Fa), 2.7);
      const Fu = mag * Math.cos(ang);
      const Fv = mag * Math.sin(ang);
      let lo = 0;
      let hi = ang;
      for (let i = 0; i < 26; i++) {
        const mid = 0.5 * (lo + hi);
        if (shoot(mid, Fu, Fv, thTmp) > 0) hi = mid;
        else lo = mid;
      }
      shoot(0.5 * (lo + hi), Fu, Fv, th);
      const b0 = th[0];
      for (let j = 0; j <= NSEG; j++) th[j] -= b0;
    }
    nu[0] = 0;
    nv[0] = 0;
    for (let j = 0; j < NSEG; j++) {
      const a = 0.5 * (th[j] + th[j + 1]);
      nu[j + 1] = nu[j] + DS * Math.cos(a);
      nv[j + 1] = nv[j] + DS * Math.sin(a);
    }
    const tipTh = th[NSEG];
    const changed = Math.abs(tipTh - lastTipTh) > 2e-5 || Math.abs(bendB.x - lastBx) > 1e-4 || Math.abs(bendB.z - lastBz) > 1e-4;
    lastTipTh = tipTh;
    lastBx = bendB.x;
    lastBz = bendB.z;
    // tip + guide ring centers
    deformPoint(ROD.tipY, tipCenter.x, tipCenter.y, tipCenter.z, tipLocal);
    const c = Math.cos(tipTh);
    const sn = Math.sin(tipTh);
    tipTangent.set(sn * bendB.x, c, sn * bendB.z);
    for (let i = 0; i < guideRef.length; i++) {
      const g = guideRef[i];
      deformPoint(g.s, g.local.x, g.local.y, g.local.z, guideLocal[i]);
    }
    if (!changed) return;
    for (let k = 0; k < U; k++) {
      const j = uJ[k];
      const f = uF[k];
      const d0 = th[j];
      const d1 = th[j + 1];
      const ts = d0 + (d1 - d0) * f;
      const tm = d0 + (d1 - d0) * f * 0.5;
      uCu[k] = nu[j] + DS * f * Math.cos(tm);
      uCv[k] = nv[j] + DS * f * Math.sin(tm);
      uCos[k] = Math.cos(ts);
      uSin[k] = Math.sin(ts);
    }
    const pos = flexGeo.attributes.position.array;
    const nor = flexGeo.attributes.normal.array;
    const bX = bendB.x;
    const bZ = bendB.z;
    const nX = bZ;
    const nZ = -bX;
    for (let q = 0; q < deformIdx.length; q++) {
      const i = deformIdx[q];
      const k = vKey[i];
      const o = i * 3;
      const s = uS[k];
      const c2 = uCos[k];
      const s2 = uSin[k];
      const cu = uCu[k];
      const cv = uCv[k];
      const x = basePos[o];
      const y = basePos[o + 1];
      const z = basePos[o + 2];
      const dy = y - s;
      const ob = x * bX + z * bZ;
      const on = x * nX + z * nZ;
      pos[o] = cv * bX + dy * s2 * bX + ob * c2 * bX + on * nX;
      pos[o + 1] = ROD.flexY0 + cu + dy * c2 - ob * s2;
      pos[o + 2] = cv * bZ + dy * s2 * bZ + ob * c2 * bZ + on * nZ;
      const na = baseNrm[o + 1];
      const nb = baseNrm[o] * bX + baseNrm[o + 2] * bZ;
      const nn = baseNrm[o] * nX + baseNrm[o + 2] * nZ;
      nor[o] = na * s2 * bX + nb * c2 * bX + nn * nX;
      nor[o + 1] = na * c2 - nb * s2;
      nor[o + 2] = na * s2 * bZ + nb * c2 * bZ + nn * nZ;
    }
    flexGeo.attributes.position.needsUpdate = true;
    flexGeo.attributes.normal.needsUpdate = true;
  }

  // ------------------------------------------------------------------ handle (rigid)
  const G_CORK = 0;
  const G_RUBBER = 1;
  const G_SEAT = 2;
  const G_GUN = 3;
  const G_KNURL = 4;
  const rs = radial * 2;
  const rigid = [];
  rigid.push({
    geometry: lathe(
      [
        [0, -0.375],
        [0.0085, -0.3749],
        [0.0121, -0.3736],
        [0.0133, -0.3702],
        [0.0134, -0.3652],
        [0.013, -0.3615],
        [0.0121, -0.3606],
      ],
      rs
    ),
    group: G_RUBBER,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.0112, -0.3607],
        [0.0121, -0.3597],
        [0.0126, -0.357],
        [0.0128, -0.33],
        [0.0126, -0.28],
        [0.0121, -0.22],
        [0.0116, -0.176],
        [0.0112, -0.166],
        [0.0101, -0.1613],
        [0.0079, -0.1603],
      ],
      rs,
      { uvScaleY: 20 }
    ),
    group: G_CORK,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.0062, -0.1607],
        [0.0075, -0.1602],
        [0.0076, -0.1582],
        [0.0066, -0.1575],
      ],
      rs
    ),
    group: G_GUN,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.0063, -0.0846],
        [0.0106, -0.0843],
        [0.0115, -0.0831],
        [0.0117, -0.075],
        [0.0117, -0.0642],
        [0.0114, -0.0607],
        [0.0106, -0.0599],
      ],
      rs,
      { uvScaleY: 40 }
    ),
    group: G_KNURL,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.0099, -0.0601],
        [0.0101, -0.059],
        [0.0101, 0.046],
        [0.0099, 0.0476],
      ],
      rs
    ),
    group: G_SEAT,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.0101, -0.0596],
        [0.0111, -0.0589],
        [0.0113, -0.0505],
        [0.0109, -0.0418],
        [0.0101, -0.0402],
      ],
      rs
    ),
    group: G_GUN,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.0101, 0.0308],
        [0.0109, 0.0322],
        [0.0112, 0.0402],
        [0.0111, 0.0462],
        [0.0101, 0.0476],
      ],
      rs
    ),
    group: G_GUN,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.0092, 0.0476],
        [0.0099, 0.0481],
        [0.0103, 0.052],
        [0.0102, 0.08],
        [0.0098, 0.11],
        [0.0092, 0.1285],
        [0.0085, 0.1355],
        [0.0075, 0.1393],
        [0.0064, 0.1406],
      ],
      rs,
      { uvScaleY: 20 }
    ),
    group: G_CORK,
  });
  rigid.push({
    geometry: lathe(
      [
        [0.006, 0.1398],
        [0.0068, 0.1402],
        [0.0069, 0.1422],
        [0.0062, 0.1428],
      ],
      rs
    ),
    group: G_GUN,
  });
  const handle = new THREE.Mesh(mergeParts(rigid).geometry, [M.cork, M.rubber, M.seat, M.gunmetal, M.knurl]);
  handle.name = 'rod-handle';
  pose.add(handle);

  // ------------------------------------------------------------------ reel (reel-local: +Y forward, +Z toward the rod)
  const reel = new THREE.Group();
  reel.name = 'reel';
  reel.position.set(0, ROD.reelY, ROD.reelZ);
  pose.add(reel);
  {
    const body = lathe(
      [
        [0, -0.081],
        [0.011, -0.0805],
        [0.019, -0.0785],
        [0.025, -0.0735],
        [0.0285, -0.066],
        [0.0298, -0.056],
        [0.0292, -0.046],
        [0.0265, -0.038],
        [0.021, -0.0315],
        [0.0155, -0.0285],
        [0.0125, -0.027],
        [0.012, -0.0245],
      ],
      28
    );
    body.scale(0.78, 1, 1);
    const stem = sweepTube(
      [V(0, -0.06, 0.02), V(0, -0.052, 0.036), V(0, -0.042, 0.051), V(0, -0.034, 0.061), V(0, -0.031, 0.0665)],
      (i, t) => 0.0068 - t * 0.0022,
      12
    );
    stem.scale(0.62, 1, 1);
    const foot = new THREE.BoxGeometry(0.0092, 0.056, 0.0026);
    foot.translate(0, -0.031, 0.0678);
    const parts = [
      { geometry: body, group: 0 },
      { geometry: stem, group: 0 },
      { geometry: foot, group: 0 },
    ];
    reel.add(new THREE.Mesh(mergeParts(parts).geometry, M.reelBody));
    const caps = [];
    const capL = new THREE.CylinderGeometry(0.0128, 0.0128, 0.004, 28);
    capL.rotateZ(Math.PI / 2);
    capL.translate(-0.0236, -0.055, 0);
    const capR = new THREE.CylinderGeometry(0.0108, 0.0115, 0.0052, 28);
    capR.rotateZ(Math.PI / 2);
    capR.translate(0.0238, -0.055, 0);
    caps.push({ geometry: capL, group: 0 }, { geometry: capR, group: 0 });
    reel.add(new THREE.Mesh(mergeParts(caps).geometry, M.gunmetal));
  }
  // rotor (spins about Y) with arms, bail pivots and the bail (flips about X)
  const rotor = new THREE.Group();
  reel.add(rotor);
  {
    const parts = [];
    parts.push({
      geometry: lathe(
        [
          [0.0118, -0.0262],
          [0.015, -0.0258],
          [0.0205, -0.0225],
          [0.0238, -0.017],
          [0.0248, -0.01],
          [0.0248, -0.003],
          [0.024, 0.0],
          [0.02, 0.0006],
          [0.012, 0.0008],
        ],
        28
      ),
      group: 0,
    });
    for (const side of [-1, 1]) {
      parts.push({
        geometry: sweepTube([V(side * 0.0222, -0.02, 0), V(side * 0.0272, -0.011, 0), V(side * 0.0298, 0.0, 0), V(side * 0.0303, 0.0075, 0)], (i, t) => 0.0046 - t * 0.0014, 10),
        group: 0,
      });
    }
    rotor.add(new THREE.Mesh(mergeParts(parts).geometry, M.reelBody));
    const acc = [];
    acc.push({
      geometry: lathe(
        [
          [0.0241, -0.0178],
          [0.0249, -0.0176],
          [0.0251, -0.0158],
          [0.0243, -0.0156],
        ],
        28
      ),
      group: 0,
    });
    for (const side of [-1, 1]) {
      const c = new THREE.CylinderGeometry(0.0042, 0.0042, 0.0036, 16);
      c.rotateZ(Math.PI / 2);
      c.translate(side * 0.0322, 0.0078, 0);
      acc.push({ geometry: c, group: 0 });
    }
    rotor.add(new THREE.Mesh(mergeParts(acc).geometry, M.gunmetal));
  }
  const bail = new THREE.Group();
  bail.position.set(0, 0.0078, 0);
  rotor.add(bail);
  const rollerPos = V(0.0312, 0.0012, -0.0036); // in the bail frame
  {
    const hoop = [];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI;
      hoop.push(V(0.0322 * Math.cos(a), 0.0128 * Math.sin(a), -0.0338 * Math.sin(a)));
    }
    const wire = sweepTube(hoop, 0.00085, 6);
    const roller = new THREE.CylinderGeometry(0.0024, 0.0024, 0.0052, 12);
    roller.rotateX(0.35);
    roller.translate(rollerPos.x, rollerPos.y, rollerPos.z);
    bail.add(new THREE.Mesh(mergeParts([{ geometry: wire, group: 0 }, { geometry: roller, group: 0 }]).geometry, M.steel));
  }
  // spool (oscillates along Y), line, drag knob
  const spool = new THREE.Group();
  reel.add(spool);
  {
    spool.add(
      new THREE.Mesh(
        lathe(
          [
            [0.012, -0.014],
            [0.0262, -0.0135],
            [0.0265, -0.012],
            [0.0265, 0.0015],
            [0.025, 0.0035],
            [0.0212, 0.005],
            [0.0208, 0.006],
            [0.0208, 0.0245],
            [0.0222, 0.0258],
            [0.024, 0.0275],
            [0.0242, 0.03],
            [0.0232, 0.0312],
            [0.013, 0.032],
          ],
          32
        ),
        M.spool
      )
    );
    const knob = lathe(
      [
        [0.012, 0.0318],
        [0.0122, 0.0335],
        [0.0118, 0.042],
        [0.01, 0.045],
        [0.006, 0.0462],
        [0, 0.0465],
      ],
      48
    );
    const p = knob.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < 0.0334 || y > 0.0421) continue;
      const x = p.getX(i);
      const z = p.getZ(i);
      const phi = Math.atan2(x, z);
      const k = 1 + 0.05 * Math.pow(Math.abs(Math.cos(phi * 8)), 6) - 0.025;
      p.setXYZ(i, x * k, y, z * k);
    }
    knob.computeVertexNormals();
    spool.add(new THREE.Mesh(knob, M.knob));
  }
  const spoolLine = new THREE.Mesh(
    lathe(
      [
        [0.0208, 0.0059],
        [0.0224, 0.0066],
        [0.0226, 0.0075],
        [0.0226, 0.0229],
        [0.0224, 0.0238],
        [0.0208, 0.0245],
      ],
      32
    ),
    M.spoolLine
  );
  spool.add(spoolLine);
  // handle (left side), rotates about X
  const crank = new THREE.Group();
  crank.position.set(-0.0258, -0.055, 0);
  reel.add(crank);
  {
    const gun = [];
    const shaft = new THREE.CylinderGeometry(0.0034, 0.0034, 0.008, 14);
    shaft.rotateZ(Math.PI / 2);
    shaft.translate(-0.003, 0, 0);
    gun.push({ geometry: shaft, group: 0 });
    gun.push({
      geometry: sweepTube([V(-0.0065, 0, -0.004), V(-0.0072, 0, 0.012), V(-0.0092, 0, 0.03), V(-0.0112, 0, 0.0455)], (i, t) => 0.0038 - t * 0.0012, 10),
      group: 0,
    });
    const stub = new THREE.CylinderGeometry(0.0021, 0.0021, 0.006, 10);
    stub.rotateZ(Math.PI / 2);
    stub.translate(-0.0135, 0, 0.0465);
    gun.push({ geometry: stub, group: 0 });
    crank.add(new THREE.Mesh(mergeParts(gun).geometry, M.gunmetal));
    const knob = lathe(
      [
        [0, 0],
        [0.0042, 0.0004],
        [0.006, 0.0028],
        [0.0067, 0.0085],
        [0.0062, 0.0148],
        [0.0045, 0.0176],
        [0, 0.0182],
      ],
      18
    );
    knob.rotateZ(Math.PI / 2);
    knob.translate(-0.0158, 0, 0.0465);
    crank.add(new THREE.Mesh(knob, M.knob));
  }

  // in-rod line path helpers (rod-local)
  const _r = new THREE.Vector3();
  function lineExitLocal(target, bailOpen01, spinAngle) {
    if (bailOpen01 > 0.5) {
      // line spirals off the spool lip
      const a = spinAngle;
      target.set(Math.sin(a) * 0.0238, 0.0305 + spool.position.y, Math.cos(a) * 0.0238);
    } else {
      _r.copy(rollerPos);
      _r.applyEuler(bail.rotation);
      _r.add(bail.position);
      _r.applyEuler(rotor.rotation);
      target.copy(_r);
    }
    target.add(reel.position);
    return target;
  }

  let fillR = 1;
  function animateReel(handleAngle, rotorAngle, bail01, spoolShift, spoolSpin, fill01) {
    crank.rotation.x = -handleAngle;
    rotor.rotation.y = -rotorAngle;
    bail.rotation.x = -1.72 * clamp(bail01, 0, 1);
    spool.position.y = spoolShift;
    spool.rotation.y = spoolSpin;
    const f = 0.95 + 0.05 * clamp(fill01, 0, 1);
    if (Math.abs(f - fillR) > 1e-4) {
      fillR = f;
      spoolLine.scale.set(f, 1, f);
    }
  }

  const materials = Object.values(M);
  let envTex = null;
  function setEnvMap(tex) {
    if (tex === envTex) return;
    envTex = tex;
    for (const m of materials) {
      m.envMap = tex || null;
      m.needsUpdate = true;
    }
  }

  setLoad(new THREE.Vector3(0, 0, 0));

  return {
    object: pose,
    materials: M,
    setLoad,
    tipLocal,
    tipTangent,
    guideLocal, // 6 guides + tip-top ring centers, deformed, rod-local
    lineExitLocal,
    animateReel,
    setEnvMap,
    dispose() {
      pose.traverse((o) => o.geometry && o.geometry.dispose());
      for (const m of materials) {
        for (const k of ['map', 'bumpMap']) if (m[k]) m[k].dispose();
        m.dispose();
      }
    },
  };
}
