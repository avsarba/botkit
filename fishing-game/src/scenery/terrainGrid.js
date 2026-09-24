// Samples env.getTerrainHeight on a regular grid around the dock once, then computes the distance
// from every land cell to the nearest water cell (with the index of that water cell, so placement
// can ask env.getHabitat there). Used for forest density, shoreline plants and the canopy shell.
export function sampleTerrain(env, { half = 700, cell = 5, waterLevel = 0.12 } = {}) {
  const n = Math.round((2 * half) / cell) + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + j * cell;
    for (let i = 0; i < n; i++) {
      const v = env.getTerrainHeight(-half + i * cell, z);
      h[j * n + i] = Number.isFinite(v) ? v : 0;
    }
  }
  const dist = new Float32Array(n * n);
  const near = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    if (h[k] < waterLevel) {
      dist[k] = 0;
      near[k] = k;
    } else {
      dist[k] = 1e9;
      near[k] = -1;
    }
  }
  const relax = (k, nb) => {
    const s = near[nb];
    if (s < 0) return;
    const dx = (k % n) - (s % n);
    const dz = ((k / n) | 0) - ((s / n) | 0);
    const d = Math.sqrt(dx * dx + dz * dz) * cell;
    if (d < dist[k]) {
      dist[k] = d;
      near[k] = s;
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (i > 0) relax(k, k - 1);
        if (j > 0) {
          relax(k, k - n);
          if (i > 0) relax(k, k - n - 1);
          if (i < n - 1) relax(k, k - n + 1);
        }
      }
    }
    for (let j = n - 1; j >= 0; j--) {
      for (let i = n - 1; i >= 0; i--) {
        const k = j * n + i;
        if (i < n - 1) relax(k, k + 1);
        if (j < n - 1) {
          relax(k, k + n);
          if (i < n - 1) relax(k, k + n + 1);
          if (i > 0) relax(k, k + n - 1);
        }
      }
    }
  }
  const inside = (x, z) => x >= -half && x <= half && z >= -half && z <= half;
  const idx = (x, z) => {
    const i = Math.min(n - 1, Math.max(0, Math.round((x + half) / cell)));
    const j = Math.min(n - 1, Math.max(0, Math.round((z + half) / cell)));
    return j * n + i;
  };
  const bilinear = (arr, x, z) => {
    const fx = Math.min(n - 1.001, Math.max(0, (x + half) / cell));
    const fz = Math.min(n - 1.001, Math.max(0, (z + half) / cell));
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const a = arr[j * n + i];
    const b = arr[j * n + i + 1];
    const c = arr[(j + 1) * n + i];
    const d = arr[(j + 1) * n + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };
  return {
    n,
    half,
    cell,
    h,
    dist,
    near,
    inside,
    idx,
    // distance (m) to the nearest water, bilinear; beyond the grid: guess from height
    distAt(x, z) {
      if (!inside(x, z)) return 1e4;
      return bilinear(dist, x, z);
    },
    heightAt(x, z) {
      if (!inside(x, z)) {
        const v = env.getTerrainHeight(x, z);
        return Number.isFinite(v) ? v : 0;
      }
      return bilinear(h, x, z);
    },
    // world xz of the nearest water cell (for habitat lookups / leaning toward water)
    nearestWater(x, z, out) {
      const s = near[idx(x, z)];
      if (s < 0) return null;
      out.x = -half + (s % n) * cell;
      out.z = -half + ((s / n) | 0) * cell;
      return out;
    },
    slopeAt(x, z) {
      const e = cell;
      const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
      const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
      return Math.hypot(hx, hz) / (2 * e);
    },
  };
}
