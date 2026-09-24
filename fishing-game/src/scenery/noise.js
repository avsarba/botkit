// Small, fast procedural noise helpers for texture and placement generation (CPU side),
// plus a GLSL snippet with the matching hash/value noise for shaders.
import { makeRng } from '../config.js';

// 2D value noise with smooth interpolation. Optional integer periods make it tile.
// Returns values in [-1, 1].
export function makeNoise2(seed = 1) {
  const rng = makeRng(seed);
  const perm = new Uint16Array(512);
  const vals = new Float32Array(256);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    p[i] = i;
    vals[i] = rng() * 2 - 1;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  function noise(x, y, px = 0, py = 0) {
    const xf0 = Math.floor(x);
    const yf0 = Math.floor(y);
    let xi = xf0;
    let yi = yf0;
    const fx = x - xf0;
    const fy = y - yf0;
    let xi1 = xi + 1;
    let yi1 = yi + 1;
    if (px > 0) {
      xi = ((xi % px) + px) % px;
      xi1 = (xi + 1) % px;
    }
    if (py > 0) {
      yi = ((yi % py) + py) % py;
      yi1 = (yi + 1) % py;
    }
    xi &= 255;
    yi &= 255;
    xi1 &= 255;
    yi1 &= 255;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = vals[perm[perm[xi] + yi]];
    const b = vals[perm[perm[xi1] + yi]];
    const c = vals[perm[perm[xi] + yi1]];
    const d = vals[perm[perm[xi1] + yi1]];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  return noise;
}

// Fractal sum of a noise2 function. Periods (if given) double per octave so the result still tiles.
export function fbm2(noise, x, y, octaves = 4, px = 0, py = 0, lac = 2, gain = 0.5) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f, y * f, px ? px * f : 0, py ? py * f : 0);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}

// 1D smooth noise from the 2D one.
export const noise1 = (noise, x) => noise(x, 0.5);

// GLSL: hash + 3D value noise + fbm. Values of vnoise3 are in [0, 1].
export const GLSL_NOISE = /* glsl */ `
float sHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float sNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = sHash13(i);
  float n100 = sHash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = sHash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = sHash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = sHash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = sHash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = sHash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = sHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float sFbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * sNoise3(p);
    p = p * 2.03 + vec3(17.1, 5.3, 11.7);
    a *= 0.5;
  }
  return s / 0.9375;
}
`;

// Low-frequency field evaluated on a coarse grid and sampled bilinearly (much cheaper than
// calling fbm per pixel). fn(x, y) is called at grid nodes in pixel coordinates.
export function coarseField(w, h, step, fn) {
  const gw = Math.ceil(w / step) + 2;
  const gh = Math.ceil(h / step) + 2;
  const g = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) g[j * gw + i] = fn(i * step, j * step);
  const inv = 1 / step;
  return (x, y) => {
    const fx = x * inv;
    const fy = y * inv;
    let i = fx | 0;
    let j = fy | 0;
    if (i > gw - 2) i = gw - 2;
    if (j > gh - 2) j = gh - 2;
    const tx = fx - i;
    const ty = fy - j;
    const a = g[j * gw + i];
    const b = g[j * gw + i + 1];
    const c = g[(j + 1) * gw + i];
    const d = g[(j + 1) * gw + i + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}
