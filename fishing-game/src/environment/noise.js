// Deterministic CPU-side noise for terrain shaping (no THREE dependency, so it can be
// unit-tested in node). All functions are pure and allocation-free per call.
import { makeRng } from '../config.js';

// 2D gradient (Perlin-style) noise with a quintic fade. Returns roughly [-1, 1].
export function createNoise2D(seed = 1) {
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const GX = new Float64Array(16);
  const GY = new Float64Array(16);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + 0.19;
    GX[i] = Math.cos(a);
    GY[i] = Math.sin(a);
  }
  return function noise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const xi = x0 & 255;
    const yi = y0 & 255;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = perm[xi] + yi;
    const b = perm[xi + 1] + yi;
    const h00 = perm[a] & 15;
    const h01 = perm[a + 1] & 15;
    const h10 = perm[b] & 15;
    const h11 = perm[b + 1] & 15;
    const n00 = GX[h00] * fx + GY[h00] * fy;
    const n10 = GX[h10] * (fx - 1) + GY[h10] * fy;
    const n01 = GX[h01] * fx + GY[h01] * (fy - 1);
    const n11 = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4;
  };
}

// Fractal sum with a rotation between octaves (hides lattice alignment). ~[-1, 1].
export function fbm(noise, x, y, octaves = 4, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y);
    norm += amp;
    amp *= gain;
    const nx = 1.6 * x + 1.2 * y + 17.13;
    y = -1.2 * x + 1.6 * y + 4.71;
    x = nx;
  }
  return sum / norm;
}

// Ridged multifractal, [0, 1]: sharp crests (ridges, mountain spines).
export function ridged(noise, x, y, octaves = 4, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise(x, y));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 1.6));
    sum += amp * n;
    norm += amp;
    amp *= gain;
    const nx = 1.6 * x + 1.2 * y + 9.7;
    y = -1.2 * x + 1.6 * y + 21.3;
    x = nx;
  }
  return sum / norm;
}

// Monotone (Fritsch-Carlson) cubic through [x, y] knots, baked into a lookup table.
export function createProfile(knots, step = 0.25) {
  const n = knots.length;
  const xs = knots.map((k) => k[0]);
  const ys = knots.map((k) => k[1]);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  const evalAt = (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
    );
  };
  const x0 = xs[0];
  const x1 = xs[n - 1];
  const count = Math.ceil((x1 - x0) / step) + 2;
  const lut = new Float64Array(count);
  for (let i = 0; i < count; i++) lut[i] = evalAt(x0 + i * step);
  const inv = 1 / step;
  const last = ys[n - 1];
  return function profile(x) {
    if (!(x > x0)) return ys[0];
    const f = (x - x0) * inv;
    const i = Math.floor(f);
    if (i >= count - 1) return last;
    const t = f - i;
    return lut[i] + (lut[i + 1] - lut[i]) * t;
  };
}
