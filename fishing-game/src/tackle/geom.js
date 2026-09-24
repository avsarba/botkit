// Geometry helpers for the tackle module (setup-time only; allocation is fine here).
import * as THREE from 'three';
import { clamp } from '../config.js';

// Sweep a circular cross-section along a polyline (parallel-transport frames).
// radius: number | (i, t) => number. Returns an indexed BufferGeometry with position/normal/uv.
export function sweepTube(path, radius, radialSegs = 6, { capStart = true, capEnd = true, flatten = 1 } = {}) {
  const n = path.length;
  const T = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-14) t.set(0, 1, 0);
    T.push(t.normalize());
  }
  const N = [];
  const B = [];
  const nrm = new THREE.Vector3();
  const ref = Math.abs(T[0].x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  nrm.crossVectors(T[0], ref).normalize();
  const axis = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      axis.crossVectors(T[i - 1], T[i]);
      const len = axis.length();
      if (len > 1e-9) {
        axis.divideScalar(len);
        nrm.applyAxisAngle(axis, Math.acos(clamp(T[i - 1].dot(T[i]), -1, 1)));
      }
      nrm.addScaledVector(T[i], -nrm.dot(T[i])).normalize();
    }
    N.push(nrm.clone());
    B.push(new THREE.Vector3().crossVectors(T[i], nrm));
  }
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  const ring = radialSegs + 1;
  const d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const r = typeof radius === 'function' ? radius(i, n > 1 ? i / (n - 1) : 0) : radius;
    for (let k = 0; k <= radialSegs; k++) {
      const a = (k / radialSegs) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a) * flatten;
      d.set(0, 0, 0).addScaledVector(N[i], c).addScaledVector(B[i], s);
      pos.push(path[i].x + d.x * r, path[i].y + d.y * r, path[i].z + d.z * r);
      const dn = d.clone().normalize();
      nor.push(dn.x, dn.y, dn.z);
      uv.push(k / radialSegs, n > 1 ? i / (n - 1) : 0);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < radialSegs; k++) {
      const a = i * ring + k;
      const b = (i + 1) * ring + k;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const cap = (i, sign) => {
    const r = typeof radius === 'function' ? radius(i, n > 1 ? i / (n - 1) : 0) : radius;
    if (r <= 1e-7) return;
    const base = pos.length / 3;
    const t = T[i];
    pos.push(path[i].x, path[i].y, path[i].z);
    nor.push(t.x * sign, t.y * sign, t.z * sign);
    uv.push(0.5, 0.5);
    for (let k = 0; k <= radialSegs; k++) {
      const a = (k / radialSegs) * Math.PI * 2;
      d.set(0, 0, 0).addScaledVector(N[i], Math.cos(a)).addScaledVector(B[i], Math.sin(a) * flatten);
      pos.push(path[i].x + d.x * r, path[i].y + d.y * r, path[i].z + d.z * r);
      nor.push(t.x * sign, t.y * sign, t.z * sign);
      uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let k = 0; k < radialSegs; k++) {
      if (sign > 0) idx.push(base, base + 1 + k, base + 2 + k);
      else idx.push(base, base + 2 + k, base + 1 + k);
    }
  };
  if (capStart) cap(0, -1);
  if (capEnd) cap(n - 1, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Lathe around +Y from [r, y] pairs. uvScaleY: if set, uv.y = y * uvScaleY (meters based).
export function lathe(profile, segments = 16, { uvScaleY = 0, phiStart = 0, phiLength = Math.PI * 2 } = {}) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  const g = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  if (uvScaleY) {
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setY(i, p.getY(i) * uvScaleY);
  }
  return g;
}

// Ensure the geometry is indexed and has position/normal/uv, so parts can be merged.
export function normalizeGeometry(g) {
  if (!g.index) {
    const count = g.attributes.position.count;
    const idx = new Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setIndex(idx);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  return g;
}

// Merge parts [{ geometry, group, sRef? }] into one geometry with one draw group per material index.
// Returns { geometry, sRef (Float32Array|null) }. sRef: 'y' -> vertex y, number -> constant.
export function mergeParts(parts, withSRef = false) {
  const sorted = [...parts].sort((a, b) => a.group - b.group);
  let vCount = 0;
  let iCount = 0;
  for (const p of sorted) {
    normalizeGeometry(p.geometry);
    vCount += p.geometry.attributes.position.count;
    iCount += p.geometry.index.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const sRef = withSRef ? new Float32Array(vCount) : null;
  const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  const g = new THREE.BufferGeometry();
  let vo = 0;
  let io = 0;
  let groupStart = 0;
  let curGroup = sorted.length ? sorted[0].group : 0;
  for (const p of sorted) {
    const src = p.geometry;
    if (p.group !== curGroup) {
      g.addGroup(groupStart, io - groupStart, curGroup);
      groupStart = io;
      curGroup = p.group;
    }
    const sp = src.attributes.position.array;
    const sn = src.attributes.normal.array;
    const su = src.attributes.uv.array;
    const c = src.attributes.position.count;
    pos.set(sp, vo * 3);
    nor.set(sn, vo * 3);
    uv.set(su.length === c * 2 ? su : new Float32Array(c * 2), vo * 2);
    if (sRef) {
      for (let i = 0; i < c; i++) sRef[vo + i] = p.sRef === 'y' || p.sRef === undefined ? sp[i * 3 + 1] : p.sRef;
    }
    const si = src.index.array;
    for (let i = 0; i < si.length; i++) index[io + i] = si[i] + vo;
    vo += c;
    io += si.length;
  }
  if (sorted.length) g.addGroup(groupStart, io - groupStart, curGroup);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  for (const p of parts) p.geometry.dispose();
  return { geometry: g, sRef };
}

// Torus whose axis is +Y (ring lies in the XZ plane), centered at c.
export function ringY(radius, tube, radialSegs, tubularSegs, cx = 0, cy = 0, cz = 0) {
  const g = new THREE.TorusGeometry(radius, tube, radialSegs, tubularSegs);
  g.rotateX(Math.PI / 2);
  g.translate(cx, cy, cz);
  return g;
}

// Smooth closed-form body of revolution with elliptical cross-sections along +Z (lure bodies).
// shape(t) -> { w, h, c } half-width, half-height and vertical center offset at t (0 tail .. 1 nose).
export function loftBody(length, shape, segsAlong = 32, segsAround = 20) {
  const pos = [];
  const uv = [];
  const idx = [];
  for (let i = 0; i <= segsAlong; i++) {
    const t = i / segsAlong;
    const z = -length / 2 + t * length;
    const { w, h, c } = shape(t);
    for (let k = 0; k <= segsAround; k++) {
      const v = k / segsAround; // 0 = top (back), 0.5 = belly
      const a = v * Math.PI * 2;
      const x = Math.sin(a) * w;
      const y = Math.cos(a) * h + c;
      pos.push(x, y, z);
      uv.push(t, v);
    }
  }
  const ring = segsAround + 1;
  for (let i = 0; i < segsAlong; i++) {
    for (let k = 0; k < segsAround; k++) {
      const a = i * ring + k;
      const b = (i + 1) * ring + k;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Weld the seam normals (k = 0 and k = segsAround share a position).
  const n = g.attributes.normal;
  for (let i = 0; i <= segsAlong; i++) {
    const a = i * ring;
    const b = i * ring + segsAround;
    const x = n.getX(a) + n.getX(b);
    const y = n.getY(a) + n.getY(b);
    const zz = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, zz) || 1;
    n.setXYZ(a, x / l, y / l, zz / l);
    n.setXYZ(b, x / l, y / l, zz / l);
  }
  return g;
}

// Hook bend path (single arm) in the XY plane: shank down -Y from the eye at the origin,
// bend toward +X, point back up. size = overall length, gap = hook gap.
export function hookArmPath(size, gap, { shankFrac = 0.72, pointFrac = 0.36, segs = 10 } = {}) {
  const pts = [];
  const R = gap / 2;
  const yb = -size * shankFrac;
  pts.push(new THREE.Vector3(0, -size * 0.02, 0));
  pts.push(new THREE.Vector3(0, yb * 0.5, 0));
  pts.push(new THREE.Vector3(0, yb, 0));
  for (let i = 1; i <= segs; i++) {
    const a = Math.PI + (i / segs) * Math.PI;
    pts.push(new THREE.Vector3(R + Math.cos(a) * R, yb + Math.sin(a) * R, 0));
  }
  pts.push(new THREE.Vector3(gap * 0.99, yb + size * pointFrac * 0.55, 0));
  pts.push(new THREE.Vector3(gap * 0.9, yb + size * pointFrac, 0));
  return pts;
}

export function hookArmGeometry(size, gap, wireR, radialSegs = 5, opts) {
  const path = hookArmPath(size, gap, opts);
  const n = path.length;
  return sweepTube(path, (i) => (i >= n - 2 ? wireR * (i === n - 1 ? 0.15 : 0.7) : wireR), radialSegs, { capStart: true, capEnd: false });
}

// Treble hook hanging from its eye at the origin (shank along -Y).
export function trebleGeometry(size, gap, wireR, radialSegs = 5) {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const g = hookArmGeometry(size, gap, wireR, radialSegs);
    g.rotateY((k / 3) * Math.PI * 2 + 0.3);
    parts.push({ geometry: g, group: 0 });
  }
  // eye
  const eye = new THREE.TorusGeometry(gap * 0.22, wireR * 0.9, 5, 12);
  eye.translate(0, gap * 0.22, 0);
  parts.push({ geometry: eye, group: 0 });
  return mergeParts(parts).geometry;
}
