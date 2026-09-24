// Verlet fishing line rendered with Line2 (screen-space width). String-like: segments only resist
// stretching, pinned points are driven from outside (rod tip, float clips, lure tie, fish mouth).
// Points on the main line float on the water surface; "sink" points (the leader under a float) may
// hang below it. Long-range attachment constraints keep long ropes from over-stretching.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { DOCK, G } from '../config.js';

const NO_SURF = -1e4;

export function createRope(n, material, { renderOrder = 12 } = {}) {
  const pos = new Float32Array(n * 3);
  const prev = new Float32Array(n * 3);
  const rest = new Float32Array(Math.max(1, n - 1));
  const cum = new Float32Array(n);
  const pinned = new Uint8Array(n);
  const sinks = new Uint8Array(n);
  const surf = new Float32Array(n).fill(NO_SURF);
  const ground = new Float32Array(n).fill(-50);
  const leftPin = new Int16Array(n).fill(-1);
  const rightPin = new Int16Array(n).fill(-1);
  let groundCursor = 0;
  let pinsDirty = true;

  const geom = new LineGeometry();
  geom.setPositions(new Float32Array(n * 3));
  geom.setColors(new Float32Array(n * 3).fill(1));
  const line = new Line2(geom, material);
  line.frustumCulled = false;
  line.renderOrder = renderOrder;
  line.matrixAutoUpdate = false;
  const posBuf = geom.attributes.instanceStart.data;
  const colBuf = geom.attributes.instanceColorStart.data;

  function refreshPins() {
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) last = i;
      leftPin[i] = pinned[i] ? i : last;
    }
    last = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (pinned[i]) last = i;
      rightPin[i] = pinned[i] ? i : last;
    }
    pinsDirty = false;
  }

  function refreshCum() {
    cum[0] = 0;
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + rest[i - 1];
  }

  const api = {
    n,
    pos,
    prev,
    rest,
    cum,
    pinned,
    sinks,
    surf,
    line,
    setPinned(i, on) {
      const v = on ? 1 : 0;
      if (pinned[i] !== v) {
        pinned[i] = v;
        pinsDirty = true;
      }
    },
    clearPins() {
      pinned.fill(0);
      pinsDirty = true;
    },
    setPoint(i, x, y, z, keepVelocity = false) {
      const o = i * 3;
      if (keepVelocity) {
        prev[o] += x - pos[o];
        prev[o + 1] += y - pos[o + 1];
        prev[o + 2] += z - pos[o + 2];
      } else {
        prev[o] = x;
        prev[o + 1] = y;
        prev[o + 2] = z;
      }
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
    },
    // Pinned point: moves with its driver (prev follows so verlet sees its velocity).
    pin(i, v) {
      const o = i * 3;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      pos[o] = v.x;
      pos[o + 1] = v.y;
      pos[o + 2] = v.z;
    },
    getPoint(i, target) {
      const o = i * 3;
      return target.set(pos[o], pos[o + 1], pos[o + 2]);
    },
    // Lay every free point on straight lines between its neighbouring pins (no velocity).
    layStraight() {
      if (pinsDirty) refreshPins();
      refreshCum();
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        const a = leftPin[i];
        const b = rightPin[i];
        const o = i * 3;
        if (a < 0 && b < 0) continue;
        if (a < 0 || b < 0) {
          const p = (a < 0 ? b : a) * 3;
          const d = cum[i] - cum[a < 0 ? b : a];
          pos[o] = pos[p];
          pos[o + 1] = pos[p + 1] - Math.abs(d);
          pos[o + 2] = pos[p + 2];
        } else {
          const span = cum[b] - cum[a];
          const f = span > 1e-9 ? (cum[i] - cum[a]) / span : 0;
          pos[o] = pos[a * 3] + (pos[b * 3] - pos[a * 3]) * f;
          pos[o + 1] = pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * f;
          pos[o + 2] = pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * f;
        }
        prev[o] = pos[o];
        prev[o + 1] = pos[o + 1];
        prev[o + 2] = pos[o + 2];
      }
    },
    // Shift all free points by d weighted by arc-length fraction toward the far end (latency fix).
    shiftTowardEnd(dx, dy, dz) {
      refreshCum();
      const total = cum[n - 1] || 1;
      for (let i = 1; i < n; i++) {
        const w = cum[i] / total;
        const o = i * 3;
        pos[o] += dx * w;
        pos[o + 1] += dy * w;
        pos[o + 2] += dz * w;
        prev[o] += dx * w;
        prev[o + 1] += dy * w;
        prev[o + 2] += dz * w;
      }
    },
    // opts: { wind: Vector3 (m/s), water, env, iterations, airDrag, waterSurfaceOffset }
    step(dt, opts) {
      if (!(dt > 0)) return;
      if (pinsDirty) refreshPins();
      refreshCum();
      const { wind, water, env, iterations = 16 } = opts;
      const airK = opts.airDrag ?? 2.2;
      const subs = dt > 1 / 70 ? 2 : 1;
      const h = dt / subs;
      const h2 = h * h;
      // water surface under low points (once per frame), terrain round-robin cache
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        surf[i] = pos[o + 1] < 0.9 ? water.getHeight(pos[o], pos[o + 2]) : NO_SURF;
      }
      const per = Math.max(4, Math.ceil(n / 4));
      for (let k = 0; k < per; k++) {
        const i = groundCursor;
        groundCursor = (groundCursor + 1) % n;
        ground[i] = env.getTerrainHeight(pos[i * 3], pos[i * 3 + 2]);
      }
      const deckTop = DOCK.deckY + 0.004;
      const halfW = DOCK.width / 2 + 0.03;
      for (let s = 0; s < subs; s++) {
        for (let i = 0; i < n; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          const x = pos[o];
          const y = pos[o + 1];
          const z = pos[o + 2];
          const vx = x - prev[o];
          const vy = y - prev[o + 1];
          const vz = z - prev[o + 2];
          prev[o] = x;
          prev[o + 1] = y;
          prev[o + 2] = z;
          const under = y < surf[i];
          if (under) {
            // mono is barely denser than water: slow sink, heavy drag
            pos[o] = x + vx * 0.86;
            pos[o + 1] = y + vy * 0.86 - G * 0.06 * h2;
            pos[o + 2] = z + vz * 0.86;
          } else {
            const k = Math.min(1, airK * h);
            const ax = (wind.x - vx / h) * k;
            const ay = (wind.y - vy / h) * k;
            const az = (wind.z - vz / h) * k;
            pos[o] = x + vx * 0.998 + ax * h;
            pos[o + 1] = y + vy * 0.998 + ay * h - G * h2;
            pos[o + 2] = z + vz * 0.998 + az * h;
          }
        }
        for (let it = 0; it < iterations; it++) {
          const fwd = (it & 1) === 0;
          for (let q = 0; q < n - 1; q++) {
            const a = fwd ? q : n - 2 - q;
            const b = a + 1;
            const wa = pinned[a] ? 0 : 1;
            const wb = pinned[b] ? 0 : 1;
            const w = wa + wb;
            if (!w) continue;
            const oa = a * 3;
            const ob = b * 3;
            const dx = pos[ob] - pos[oa];
            const dy = pos[ob + 1] - pos[oa + 1];
            const dz = pos[ob + 2] - pos[oa + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            const r = rest[a];
            if (d2 <= r * r || d2 < 1e-18) continue; // string: no compression resistance
            const d = Math.sqrt(d2);
            const corr = (d - r) / (d * w);
            pos[oa] += dx * corr * wa;
            pos[oa + 1] += dy * corr * wa;
            pos[oa + 2] += dz * corr * wa;
            pos[ob] -= dx * corr * wb;
            pos[ob + 1] -= dy * corr * wb;
            pos[ob + 2] -= dz * corr * wb;
          }
        }
        // long-range attachments to the neighbouring pins
        for (let i = 0; i < n; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          for (let side = 0; side < 2; side++) {
            const p = side === 0 ? leftPin[i] : rightPin[i];
            if (p < 0) continue;
            const maxD = Math.abs(cum[i] - cum[p]) * 1.001;
            const op = p * 3;
            const dx = pos[o] - pos[op];
            const dy = pos[o + 1] - pos[op + 1];
            const dz = pos[o + 2] - pos[op + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > maxD * maxD && d2 > 1e-18) {
              const k = maxD / Math.sqrt(d2);
              pos[o] = pos[op] + dx * k;
              pos[o + 1] = pos[op + 1] + dy * k;
              pos[o + 2] = pos[op + 2] + dz * k;
            }
          }
        }
        // collisions: water surface (floating line), ground, dock deck
        for (let i = 0; i < n; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          const x = pos[o];
          const z = pos[o + 2];
          let y = pos[o + 1];
          const gy = ground[i];
          const sy = surf[i];
          if (sy !== NO_SURF && gy < sy - 0.01) {
            if (!sinks[i] && y < sy + 0.003) {
              y = sy + 0.003;
              // surface film: the line barely slides on the water
              prev[o] = x - (x - prev[o]) * 0.25;
              prev[o + 2] = z - (z - prev[o + 2]) * 0.25;
              prev[o + 1] = y;
            } else if (sinks[i] && y < gy + 0.01) {
              y = gy + 0.01;
            }
          } else if (y < gy + 0.006) {
            y = gy + 0.006;
            prev[o] = x - (x - prev[o]) * 0.2;
            prev[o + 2] = z - (z - prev[o + 2]) * 0.2;
            prev[o + 1] = y;
          }
          if (x > -halfW && x < halfW && z > DOCK.endZ - 0.03 && z < DOCK.shoreZ && y < deckTop && y > DOCK.deckY - 0.35) {
            y = deckTop;
            prev[o + 1] = y;
          }
          pos[o + 1] = y;
        }
      }
    },
    // Pull free points of [a..b] toward the straight line between pins a and b (both must be pinned
    // or valid points). t in 0..1; velocity is preserved.
    straighten(a, b, t) {
      if (t <= 0 || b <= a + 1) return;
      refreshCum();
      const span = cum[b] - cum[a];
      if (span < 1e-9) return;
      const oa = a * 3;
      const ob = b * 3;
      for (let i = a + 1; i < b; i++) {
        const f = (cum[i] - cum[a]) / span;
        const o = i * 3;
        for (let c = 0; c < 3; c++) {
          const target = pos[oa + c] + (pos[ob + c] - pos[oa + c]) * f;
          const d = (target - pos[o + c]) * t;
          pos[o + c] += d;
          prev[o + c] += d;
        }
      }
    },
    // Upload to the GPU. dimUnderwater: tint points below the surface toward murky water.
    write(dimUnderwater = true) {
      const a = posBuf.array;
      const c = colBuf.array;
      for (let i = 0; i < n - 1; i++) {
        const o = i * 3;
        const k = i * 6;
        a[k] = pos[o];
        a[k + 1] = pos[o + 1];
        a[k + 2] = pos[o + 2];
        a[k + 3] = pos[o + 3];
        a[k + 4] = pos[o + 4];
        a[k + 5] = pos[o + 5];
      }
      for (let i = 0; i < n; i++) {
        let r = 1;
        let g = 1;
        let b = 1;
        if (dimUnderwater && surf[i] !== NO_SURF) {
          const d = surf[i] - pos[i * 3 + 1];
          if (d > 0.002) {
            // below the surface the line quickly fades into the water colour
            const f = Math.exp(-d / 0.3) * 0.32;
            r = 0.06 + f;
            g = 0.13 + f;
            b = 0.13 + f * 0.7;
          }
        }
        // color of segment start (i) and end (i-1)
        if (i < n - 1) {
          c[i * 6] = r;
          c[i * 6 + 1] = g;
          c[i * 6 + 2] = b;
        }
        if (i > 0) {
          c[(i - 1) * 6 + 3] = r;
          c[(i - 1) * 6 + 4] = g;
          c[(i - 1) * 6 + 5] = b;
        }
      }
      posBuf.needsUpdate = true;
      colBuf.needsUpdate = true;
    },
    hasNaN() {
      for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) return true;
      return false;
    },
    dispose() {
      geom.dispose();
    },
  };
  return api;
}
