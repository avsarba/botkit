// Procedural, perfectly tileable detail texture generated once at start-up.
//  RGB: unit normal of a wind-ripple height field (random-phase sum of ~80
//       sinusoids with integer wave vectors, directional spread around +u,
//       k^-1.9 spectrum), encoded n * 0.5 + 0.5. Mipmaps shorten the averaged
//       normals, which the shader turns into extra roughness (Toksvig).
//  A:   low-frequency tileable noise used for wind patches ("cat's paws")
//       and foam break-up.
import * as THREE from 'three';
import { makeRng } from '../config.js';

export function createDetailTexture(renderer, { size = 256, seed = 1234, components = 84 } = {}) {
  const N = size; // must be a power of two (index wrap uses & (N - 1))
  const mask = N - 1;
  const rng = makeRng(seed);
  const cosT = new Float32Array(N);
  const sinT = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / N);
    sinT[i] = Math.sin((2 * Math.PI * i) / N);
  }

  // Accumulate cos(2pi (m i + n j)/N + phi) * w into dst using table lookups.
  function addComponent(dst, m, n, w, phi) {
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    for (let j = 0; j < N; j++) {
      let idx = (n * j) & mask;
      const row = j * N;
      for (let i = 0; i < N; i++) {
        dst[row + i] += w * (cosT[idx] * cp - sinT[idx] * sp);
        idx = (idx + m) & mask;
      }
    }
  }

  // --- ripple slopes -------------------------------------------------------
  const sx = new Float32Array(N * N);
  const sy = new Float32Array(N * N);
  for (let c = 0; c < components; c++) {
    const kmag = 3 * Math.pow(38 / 3, rng()); // 3..38 cycles per tile, log-uniform
    let ang = (rng() + rng() + rng() - 1.5) * 1.25; // ~gaussian spread, sigma ~0.6 rad
    if (rng() < 0.14) ang += Math.PI; // a few counter-running wavelets
    const m = Math.round(kmag * Math.cos(ang));
    const n = Math.round(kmag * Math.sin(ang));
    if (m === 0 && n === 0) continue;
    const kk = Math.hypot(m, n);
    const a = Math.pow(kk, -1.9) * (0.45 + rng());
    const phi = rng() * Math.PI * 2;
    // h = a sin(theta) -> dh/du = a 2pi m cos(theta)
    const phiCos = phi; // cos(theta + phi)
    addComponent(sx, m, n, a * 2 * Math.PI * m, phiCos);
    addComponent(sy, m, n, a * 2 * Math.PI * n, phiCos);
  }
  let ms = 0;
  for (let i = 0; i < N * N; i++) ms += sx[i] * sx[i] + sy[i] * sy[i];
  const rms = Math.sqrt(ms / (N * N)) || 1;
  const slopeScale = 0.42 / rms; // stored RMS slope ~0.42; the shader rescales

  // --- low-frequency patch noise -------------------------------------------
  const pn = new Float32Array(N * N);
  for (let c = 0; c < 14; c++) {
    const octave = c < 8 ? 1 : 2;
    let m = 0;
    let n = 0;
    while (m === 0 && n === 0) {
      m = Math.round((rng() * 2 - 1) * 3 * octave);
      n = Math.round((rng() * 2 - 1) * 3 * octave);
    }
    addComponent(pn, m, n, (octave === 1 ? 1 : 0.45) * (0.5 + rng()), rng() * Math.PI * 2);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < N * N; i++) {
    if (pn[i] < lo) lo = pn[i];
    if (pn[i] > hi) hi = pn[i];
  }
  const inv = 1 / (hi - lo || 1);

  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const x = -sx[i] * slopeScale;
    const y = -sy[i] * slopeScale;
    const il = 1 / Math.sqrt(x * x + y * y + 1);
    data[i * 4] = Math.round((x * il * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((y * il * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round((il * 0.5 + 0.5) * 255);
    data[i * 4 + 3] = Math.round((pn[i] - lo) * inv * 255);
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1;
  tex.needsUpdate = true;
  return tex;
}
