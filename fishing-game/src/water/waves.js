// Wind waves shared by the GPU (vertex displacement + per-pixel normals) and
// the CPU (getHeight / getNormal). A handful of directional Gerstner components,
// 0.46-5.8 m long, a few cm high, scaled by the wind. Phases are wrapped to
// [0, 2pi) on the CPU in double precision so long sessions stay stable on the GPU.
import { G, clamp, damp, makeRng } from '../config.js';

export const WAVE_COUNT = 6;
const TWO_PI = Math.PI * 2;

// [wavelength m, amplitude m at windScale 1, direction offset from the wind rad, Gerstner steepness Q]
// Short waves spread wider around the wind direction, as real wind seas do.
const BASE = [
  [5.8, 0.03, 0.0, 0.55],
  [3.6, 0.021, 0.46, 0.6],
  [2.3, 0.0145, -0.52, 0.62],
  [1.45, 0.0095, 0.92, 0.66],
  [0.88, 0.0062, -0.3, 0.7],
  [0.46, 0.0038, 1.32, 0.7],
];

// windStrength 0..1 -> amplitude scale. From the midday breeze up (>= 0.3) this is
// the original calibration (0.12 + 1.75 w: ~1.9 cm on the longest component at 0.3);
// below it the waves die away toward glassy calm (~1 mm at light airs < 0.05), as a
// real lake does at dawn and dusk.
export const windScaleFor = (w) => {
  const x = Number.isFinite(w) ? w : 0.25;
  if (x >= 0.3) return Math.min(2.2, 0.12 + 1.75 * x);
  return 0.04 + 2.42 * Math.max(0, x - 0.05);
};

export function createWaveField({ windStrength = 0.25, windDirection = null, seed = 11 } = {}) {
  const rng = makeRng(seed);
  const n = WAVE_COUNT;
  const k = new Float64Array(n);
  const omega = new Float64Array(n);
  const baseAmp = new Float64Array(n);
  const dAng = new Float64Array(n);
  const Q = new Float64Array(n);
  const phi0 = new Float64Array(n);
  const lambda = new Float64Array(n);
  // live state (read by getHeight/getNormal and packed into uniforms)
  const dirX = new Float64Array(n);
  const dirZ = new Float64Array(n);
  const amp = new Float64Array(n);
  const phase = new Float64Array(n);
  // uniform arrays: A = (dirX, dirZ, k, amp), B = (phase, Q, lambda, 0)
  const uA = new Float32Array(n * 4);
  const uB = new Float32Array(n * 4);

  for (let i = 0; i < n; i++) {
    const [lam, a, da, q] = BASE[i];
    lambda[i] = lam;
    k[i] = TWO_PI / lam;
    omega[i] = Math.sqrt(G * k[i]); // deep-water dispersion
    baseAmp[i] = a;
    dAng[i] = da;
    Q[i] = q;
    phi0[i] = rng() * TWO_PI;
  }

  let angle = windDirection ? Math.atan2(windDirection.y, windDirection.x) : 0.3;
  let scale = windScaleFor(windStrength);

  function apply(time) {
    for (let i = 0; i < n; i++) {
      const a = angle + dAng[i];
      dirX[i] = Math.cos(a);
      dirZ[i] = Math.sin(a);
      amp[i] = baseAmp[i] * scale;
      let ph = (omega[i] * time - phi0[i]) % TWO_PI;
      if (ph < 0) ph += TWO_PI;
      phase[i] = ph;
      uA[i * 4] = dirX[i];
      uA[i * 4 + 1] = dirZ[i];
      uA[i * 4 + 2] = k[i];
      uA[i * 4 + 3] = amp[i];
      uB[i * 4] = ph;
      uB[i * 4 + 1] = Q[i];
      uB[i * 4 + 2] = lambda[i];
      uB[i * 4 + 3] = 0;
    }
  }
  apply(0);

  function update(time, dt, windStrength01, windDir) {
    const w = Number.isFinite(windStrength01) ? windStrength01 : 0.25;
    scale = damp(scale, windScaleFor(w), 0.35, dt);
    if (windDir && (windDir.x !== 0 || windDir.y !== 0)) {
      const target = Math.atan2(windDir.y, windDir.x);
      let d = target - angle;
      d -= Math.round(d / TWO_PI) * TWO_PI;
      // Rotate very slowly: a fast turn would make distant crests slide.
      const maxStep = 0.003 * dt;
      angle += clamp(d, -maxStep, maxStep);
    }
    apply(time);
  }

  // Horizontal Gerstner displacement at undisplaced point (x0, z0) -> out[0], out[1]
  function displacement(x0, z0, out) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < n; i++) {
      const th = k[i] * (dirX[i] * x0 + dirZ[i] * z0) - phase[i];
      const c = Math.cos(th) * Q[i] * amp[i];
      dx += dirX[i] * c;
      dz += dirZ[i] * c;
    }
    out[0] = dx;
    out[1] = dz;
  }

  const tmp = [0, 0];
  const x0z0 = [0, 0];
  // Find the undisplaced point whose Gerstner displacement lands on (x, z).
  // |dD/dx0| is ~0.1, so three fixed-point steps converge to < 0.1 mm.
  function invert(x, z) {
    let x0 = x;
    let z0 = z;
    for (let it = 0; it < 3; it++) {
      displacement(x0, z0, tmp);
      x0 = x - tmp[0];
      z0 = z - tmp[1];
    }
    x0z0[0] = x0;
    x0z0[1] = z0;
    return x0z0;
  }

  function heightAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const p = invert(x, z);
    let y = 0;
    for (let i = 0; i < n; i++) {
      y += amp[i] * Math.sin(k[i] * (dirX[i] * p[0] + dirZ[i] * p[1]) - phase[i]);
    }
    return y;
  }

  // Exact normal of the parametric Gerstner surface (same formula as the shader).
  function normalAt(x, z, target) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return target.set(0, 1, 0);
    const p = invert(x, z);
    let a = 0, b = 0, c = 0, px = 0, pz = 0;
    for (let i = 0; i < n; i++) {
      const th = k[i] * (dirX[i] * p[0] + dirZ[i] * p[1]) - phase[i];
      const s = Math.sin(th);
      const co = Math.cos(th);
      const kA = k[i] * amp[i];
      const qk = Q[i] * kA * s;
      a += qk * dirX[i] * dirX[i];
      b += qk * dirX[i] * dirZ[i];
      c += qk * dirZ[i] * dirZ[i];
      px += kA * dirX[i] * co;
      pz += kA * dirZ[i] * co;
    }
    target.set(-(b * pz + (1 - c) * px), (1 - a) * (1 - c) - b * b, -(b * px + (1 - a) * pz));
    const len = target.length();
    return len > 1e-8 ? target.multiplyScalar(1 / len) : target.set(0, 1, 0);
  }

  return {
    count: n,
    uA,
    uB,
    update,
    heightAt,
    normalAt,
    get scale() {
      return scale;
    },
    get angle() {
      return angle;
    },
    // RMS slope of all components (for particles / debug)
    slopeVariance() {
      let v = 0;
      for (let i = 0; i < n; i++) v += 0.5 * (k[i] * amp[i]) ** 2;
      return v;
    },
  };
}
