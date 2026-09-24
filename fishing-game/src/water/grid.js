// Lake surface geometry: a tensor-product grid whose lines are evenly spaced
// (s0) in a fine window around the camera and then grow geometrically out to
// +-extent (~1.25 km each way). The mesh follows the camera in steps of s0 so
// the fine lattice always lands on the same world positions (no swimming);
// every vertex carries its local cell size (aCell) so the vertex shader can
// drop wave components the grid cannot resolve (the surface goes flat far away,
// where only the per-pixel normals matter).
import * as THREE from 'three';

export const GRID_PRESETS = {
  //       fine spacing, fine window (x half-width, z min/max rel. to camera), growth per cell
  high: { s0: 0.18, halfX: 11, zMin: -15, zMax: 7, growth: 1.12 },
  medium: { s0: 0.26, halfX: 9, zMin: -12, zMax: 6, growth: 1.16 },
  low: { s0: 0.42, halfX: 7, zMin: -9, zMax: 5, growth: 1.24 },
};

export const GRID_EXTENT = 1250;

// Sorted grid-line coordinates: uniform s0 spacing in [fineMin, fineMax], then
// geometric growth out to +-extent.
export function gradedAxis(s0, fineMin, fineMax, growth, extent) {
  const i0 = Math.round(fineMin / s0);
  const i1 = Math.round(fineMax / s0);
  const out = [];
  const neg = [];
  let p = i0 * s0;
  let s = s0;
  while (p > -extent + 1e-6) {
    s *= growth;
    p = Math.max(-extent, p - s);
    neg.push(p);
  }
  for (let k = neg.length - 1; k >= 0; k--) out.push(neg[k]);
  for (let i = i0; i <= i1; i++) out.push(i * s0);
  p = i1 * s0;
  s = s0;
  while (p < extent - 1e-6) {
    s *= growth;
    p = Math.min(extent, p + s);
    out.push(p);
  }
  return out;
}

function cellSizes(axis) {
  const n = axis.length;
  const cell = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? axis[i] - axis[i - 1] : axis[1] - axis[0];
    const b = i < n - 1 ? axis[i + 1] - axis[i] : a;
    cell[i] = Math.max(a, b);
  }
  return cell;
}

export function buildSurfaceGeometry(quality = 'high') {
  const q = GRID_PRESETS[quality] || GRID_PRESETS.high;
  const xs = gradedAxis(q.s0, -q.halfX, q.halfX, q.growth, GRID_EXTENT);
  const zs = gradedAxis(q.s0, q.zMin, q.zMax, q.growth, GRID_EXTENT);
  const cx = cellSizes(xs);
  const cz = cellSizes(zs);
  const nx = xs.length;
  const nz = zs.length;
  const count = nx * nz;
  const pos = new Float32Array(count * 3);
  const cell = new Float32Array(count);
  let v = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++, v++) {
      pos[v * 3] = xs[i];
      pos[v * 3 + 1] = 0;
      pos[v * 3 + 2] = zs[j];
      cell[v] = Math.max(cx[i], cz[j]);
    }
  }
  const quads = (nx - 1) * (nz - 1);
  const index = count > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let t = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // alternate the diagonal so long thin cells do not all lean one way
      if ((i + j) & 1) {
        index[t++] = a; index[t++] = c; index[t++] = b;
        index[t++] = b; index[t++] = c; index[t++] = d;
      } else {
        index[t++] = a; index[t++] = c; index[t++] = d;
        index[t++] = a; index[t++] = d; index[t++] = b;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  // Displacement is a few cm; a generous bound keeps three's culling honest.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), GRID_EXTENT * 1.5);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-GRID_EXTENT, -1, -GRID_EXTENT), new THREE.Vector3(GRID_EXTENT, 1, GRID_EXTENT));
  return { geometry: g, s0: q.s0, vertices: count, triangles: quads * 2 };
}
