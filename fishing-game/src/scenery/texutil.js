// Helpers for procedural textures built as raw RGBA arrays (DataTexture) or on a Canvas2D.
// DataTextures keep full control over un-premultiplied color (no dark alpha fringes) and use
// flipY = false, so pixel row 0 is v = 0.
import * as THREE from 'three';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function dataTexture(data, w, h, { srgb = true, repeat = false, anisotropy = 1, mipmaps = true } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mipmaps;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

// Canvas pixels -> DataTexture (un-premultiplied RGBA from getImageData).
export function canvasToData(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return new Uint8Array(img.data.buffer.slice(0));
}

// Tangent-space normal map from a height field (meters). sx/sy: meters per pixel along x/y.
// With flipY = false textures, +y in the array is +v, which matches three's tangent frame.
export function normalMapFromHeight(height, w, h, sx, sy, { wrapX = false, wrapY = false, strength = 1 } = {}) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    let y0 = y - 1;
    let y1 = y + 1;
    if (wrapY) {
      y0 = (y0 + h) % h;
      y1 = y1 % h;
    } else {
      if (y0 < 0) y0 = 0;
      if (y1 >= h) y1 = h - 1;
    }
    for (let x = 0; x < w; x++) {
      let x0 = x - 1;
      let x1 = x + 1;
      if (wrapX) {
        x0 = (x0 + w) % w;
        x1 = x1 % w;
      } else {
        if (x0 < 0) x0 = 0;
        if (x1 >= w) x1 = w - 1;
      }
      const dx = ((height[y * w + x1] - height[y * w + x0]) / ((x1 - x0) * sx || 1)) * strength;
      const dy = ((height[y1 * w + x] - height[y0 * w + x]) / ((y1 - y0) * sy || 1)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= l;
      ny *= l;
      nz *= l;
      const i = (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

// For alpha-tested textures: give (nearly) transparent texels the color of nearby opaque texels
// (so filtering and mipmaps never pull in black). Box-blurs premultiplied color and alpha in the
// region and divides; far-away texels fall back to the region mean.
export function dilateTransparent(data, w, h, rect = [0, 0, w, h], radius = 6) {
  const [rx, ry, rw, rh] = rect;
  const N = rw * rh;
  const ch = [new Float32Array(N), new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  let mr = 0;
  let mg = 0;
  let mb = 0;
  let mn = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = ((ry + y) * w + rx + x) * 4;
      const a = data[i + 3] / 255;
      const k = y * rw + x;
      ch[0][k] = data[i] * a;
      ch[1][k] = data[i + 1] * a;
      ch[2][k] = data[i + 2] * a;
      ch[3][k] = a;
      if (a > 0.5) {
        mr += data[i];
        mg += data[i + 1];
        mb += data[i + 2];
        mn++;
      }
    }
  }
  if (!mn) return;
  mr /= mn;
  mg /= mn;
  mb /= mn;
  const tmp = new Float32Array(Math.max(rw, rh));
  const r = Math.max(1, radius >> 1);
  const blur1D = (arr, len, stride, offset) => {
    let acc = 0;
    let cnt = 0;
    for (let i = -r; i <= r; i++) {
      if (i >= 0 && i < len) {
        acc += arr[offset + i * stride];
        cnt++;
      }
    }
    for (let i = 0; i < len; i++) {
      tmp[i] = acc / cnt;
      const out = i - r;
      const inn = i + r + 1;
      if (out >= 0) {
        acc -= arr[offset + out * stride];
        cnt--;
      }
      if (inn < len) {
        acc += arr[offset + inn * stride];
        cnt++;
      }
    }
    for (let i = 0; i < len; i++) arr[offset + i * stride] = tmp[i];
  };
  for (let it = 0; it < 2; it++) {
    for (const c of ch) {
      for (let y = 0; y < rh; y++) blur1D(c, rw, 1, y * rw);
      for (let x = 0; x < rw; x++) blur1D(c, rh, rw, x);
    }
  }
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = ((ry + y) * w + rx + x) * 4;
      if (data[i + 3] > 40) continue;
      const k = y * rw + x;
      const a = ch[3][k];
      if (a > 0.004) {
        data[i] = Math.min(255, ch[0][k] / a);
        data[i + 1] = Math.min(255, ch[1][k] / a);
        data[i + 2] = Math.min(255, ch[2][k] / a);
      } else {
        data[i] = mr;
        data[i + 1] = mg;
        data[i + 2] = mb;
      }
    }
  }
}

// sRGB byte <-> linear float helpers for mixing colors in generators.
export const hexToRgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
export const mix3 = (a, b, t, out = [0, 0, 0]) => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};
