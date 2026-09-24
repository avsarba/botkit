// Lake outline (hand-placed control points, meters) -> smooth closed curves -> a signed
// distance grid (positive = inside the lake, meters to the nearest shore).
// Coordinates follow CONTRACT.md: the player stands at the origin looking toward -Z.

// Main lake outline. Behind the dock the shore runs along z = +16; the weedy cove is the
// indentation to the left, the rocky point juts in from the right with its tip ~65 m out.
export const LAKE_OUTLINE = [
  [0, 16.0], [12, 15.6], [24, 14.6], [36, 12.4], [48, 8.8], [60, 3.4], [71, -2.4], [79, -8.2],
  // rocky point (tip at ~65,-21)
  [74.5, -13.6], [68.5, -17.2], [65.2, -21.0], [68.2, -25.4], [76, -28.4], [86, -31.2],
  // right shore, receding to the far end
  [92, -42], [101, -62], [114, -88], [131, -112], [154, -137], [177, -167], [192, -204], [190, -243],
  // far shore (250-380 m away), irregular with small bays
  [170, -268], [141, -283], [109, -298], [76, -315], [42, -331], [9, -338], [-22, -330],
  [-50, -337], [-83, -347], [-116, -330], [-146, -307], [-171, -281], [-186, -249],
  // left shore back toward the cove
  [-185, -214], [-169, -182], [-148, -150], [-126, -120], [-106, -92], [-90, -66], [-79, -44],
  [-71, -26], [-66.5, -10], [-63.5, 3], [-59, 13], [-51, 21], [-39.5, 25.8], [-27.5, 24], [-17.5, 19.6],
  [-8, 16.8],
];

// Small rocky islands (with room for a few trees).
export const ISLANDS = [
  [[-97, -203], [-91, -212], [-78, -217], [-64, -212], [-57, -204], [-65, -196.5], [-80, -193.5], [-92, -196]],
  [[88, -240], [91.5, -246.5], [100, -246], [104, -239.5], [98, -234], [91, -235]],
];

// Centripetal-ish closed Catmull-Rom subdivision (uniform parameterisation is fine for
// the point spacing used here). Returns a flat [x0, z0, x1, z1, ...] array.
export function smoothClosed(points, maxSegM = 5) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const sub = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / maxSegM));
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const t2 = t * t;
      const t3 = t2 * t;
      for (let k = 0; k < 2; k++) {
        out.push(
          0.5 *
            (2 * p1[k] +
              (-p0[k] + p2[k]) * t +
              (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
              (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
        );
      }
    }
  }
  return out;
}

// Signed distance grid of the union (even-odd) of closed polylines. Exact distances are
// computed on a coarse grid everywhere and on the fine grid only within a band around the
// shore; far from the shore the (smooth) coarse field is interpolated.
export function buildSdfGrid(polys, { minX, minZ, maxX, maxZ, cell, band = 18, coarseFactor = 4 }) {
  const nx = Math.round((maxX - minX) / cell) + 1;
  const nz = Math.round((maxZ - minZ) / cell) + 1;
  const data = new Float32Array(nx * nz);

  let segCount = 0;
  for (const poly of polys) segCount += poly.length / 2;
  const ax = new Float64Array(segCount);
  const az = new Float64Array(segCount);
  const dx = new Float64Array(segCount);
  const dz = new Float64Array(segCount);
  const invL2 = new Float64Array(segCount);
  let s = 0;
  for (const poly of polys) {
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      ax[s] = poly[2 * i];
      az[s] = poly[2 * i + 1];
      dx[s] = poly[2 * j] - ax[s];
      dz[s] = poly[2 * j + 1] - az[s];
      const l2 = dx[s] * dx[s] + dz[s] * dz[s];
      invL2[s] = l2 > 1e-12 ? 1 / l2 : 0;
      s++;
    }
  }
  const xs = new Float64Array(128);
  let nCross = 0;
  function rowCrossings(z) {
    nCross = 0;
    for (let i = 0; i < segCount; i++) {
      const z0 = az[i];
      const z1 = az[i] + dz[i];
      if ((z0 <= z && z1 > z) || (z1 <= z && z0 > z)) {
        if (nCross < xs.length) xs[nCross++] = ax[i] + ((z - z0) / (z1 - z0)) * dx[i];
      }
    }
  }
  function insideRow(x) {
    let inside = false;
    for (let k = 0; k < nCross; k++) if (xs[k] < x) inside = !inside;
    return inside;
  }
  function exact(x, z) {
    let m = Infinity;
    for (let k = 0; k < segCount; k++) {
      let t = ((x - ax[k]) * dx[k] + (z - az[k]) * dz[k]) * invL2[k];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax[k] + t * dx[k] - x;
      const qz = az[k] + t * dz[k] - z;
      const d2 = qx * qx + qz * qz;
      if (d2 < m) m = d2;
    }
    return Math.sqrt(m);
  }

  // coarse pass
  const cc = cell * coarseFactor;
  const cnx = Math.ceil((maxX - minX) / cc) + 1;
  const cnz = Math.ceil((maxZ - minZ) / cc) + 1;
  const coarse = new Float32Array(cnx * cnz);
  for (let j = 0; j < cnz; j++) {
    const z = minZ + j * cc;
    rowCrossings(z);
    for (let i = 0; i < cnx; i++) {
      const x = minX + i * cc;
      const d = exact(x, z);
      coarse[j * cnx + i] = insideRow(x) ? d : -d;
    }
  }
  const coarseAt = (x, z) => {
    const fx = Math.min(cnx - 1.0001, Math.max(0, (x - minX) / cc));
    const fz = Math.min(cnz - 1.0001, Math.max(0, (z - minZ) / cc));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const o = j * cnx + i;
    const a = coarse[o] + (coarse[o + 1] - coarse[o]) * tx;
    const b = coarse[o + cnx] + (coarse[o + cnx + 1] - coarse[o + cnx]) * tx;
    return a + (b - a) * tz;
  };

  // fine pass: exact only near the shore
  const bandLimit = band + cc;
  for (let j = 0; j < nz; j++) {
    const z = minZ + j * cell;
    rowCrossings(z);
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell;
      const c = coarseAt(x, z);
      if (c > bandLimit || c < -bandLimit) {
        data[j * nx + i] = c;
        continue;
      }
      const d = exact(x, z);
      data[j * nx + i] = insideRow(x) ? d : -d;
    }
  }

  const invCell = 1 / cell;
  const maxI = nx - 1;
  const maxJ = nz - 1;
  // Bilinear sample; outside the grid the value keeps falling (land) with distance.
  function sample(x, z) {
    let fx = (x - minX) * invCell;
    let fz = (z - minZ) * invCell;
    let outside = 0;
    if (fx < 0) {
      outside += -fx * cell;
      fx = 0;
    } else if (fx > maxI) {
      outside += (fx - maxI) * cell;
      fx = maxI;
    }
    if (fz < 0) {
      outside += -fz * cell;
      fz = 0;
    } else if (fz > maxJ) {
      outside += (fz - maxJ) * cell;
      fz = maxJ;
    }
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i >= maxI) i = maxI - 1;
    if (j >= maxJ) j = maxJ - 1;
    const tx = fx - i;
    const tz = fz - j;
    const o = j * nx + i;
    const a = data[o] + (data[o + 1] - data[o]) * tx;
    const b = data[o + nx] + (data[o + nx + 1] - data[o + nx]) * tx;
    return a + (b - a) * tz - outside;
  }
  return { sample, nx, nz, data, bounds: { minX, minZ, maxX, maxZ } };
}

export function outlineBounds(margin = 0) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of LAKE_OUTLINE) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX: minX - margin, minZ: minZ - margin, maxX: maxX + margin, maxZ: maxZ + margin };
}
