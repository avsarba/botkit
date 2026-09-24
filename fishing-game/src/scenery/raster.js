// Minimal CPU rasterizer into an RGBA byte buffer (straight alpha, "over" compositing).
// Much faster than thousands of Canvas2D path calls and needs no GPU readback.
export class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
    this.clipX0 = 0;
    this.clipY0 = 0;
    this.clipX1 = w;
    this.clipY1 = h;
  }

  clip(x, y, w, h) {
    this.clipX0 = Math.max(0, x | 0);
    this.clipY0 = Math.max(0, y | 0);
    this.clipX1 = Math.min(this.w, (x + w) | 0);
    this.clipY1 = Math.min(this.h, (y + h) | 0);
  }

  unclip() {
    this.clip(0, 0, this.w, this.h);
  }

  // composite one pixel with coverage a (0..1)
  px(x, y, r, g, b, a) {
    if (x < this.clipX0 || y < this.clipY0 || x >= this.clipX1 || y >= this.clipY1 || a <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const da = d[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    const k = a / oa;
    d[i] = d[i] + (r - d[i]) * k;
    d[i + 1] = d[i + 1] + (g - d[i + 1]) * k;
    d[i + 2] = d[i + 2] + (b - d[i + 2]) * k;
    d[i + 3] = oa * 255;
  }

  fillRect(x, y, w, h, r, g, b, a = 1) {
    const x0 = Math.max(this.clipX0, Math.floor(x));
    const y0 = Math.max(this.clipY0, Math.floor(y));
    const x1 = Math.min(this.clipX1, Math.ceil(x + w));
    const y1 = Math.min(this.clipY1, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.px(xx, yy, r, g, b, a);
  }

  // thick line by stamping soft discs along it
  line(x0, y0, x1, y1, width, r, g, b, a = 1) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / 0.7));
    const rad = width * 0.5;
    if (rad <= 0.75) {
      // thin: single pixels with fractional coverage
      const cov = Math.min(1, width) * a;
      let lx = -1;
      let ly = -1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = Math.round(x0 + (x1 - x0) * t);
        const y = Math.round(y0 + (y1 - y0) * t);
        if (x === lx && y === ly) continue;
        lx = x;
        ly = y;
        this.px(x, y, r, g, b, cov);
      }
      return;
    }
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rad, r, g, b, a);
    }
  }

  disc(cx, cy, rad, r, g, b, a = 1) {
    const x0 = Math.floor(cx - rad - 1);
    const x1 = Math.ceil(cx + rad + 1);
    const y0 = Math.floor(cy - rad - 1);
    const y1 = Math.ceil(cy + rad + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cov = Math.min(1, Math.max(0, rad + 0.5 - d));
        if (cov > 0) this.px(x, y, r, g, b, cov * a);
      }
    }
  }

  // filled ellipse, rotated by ang
  ellipse(cx, cy, rx, ry, ang, r, g, b, a = 1) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const R = Math.max(rx, ry) + 1;
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = (dx * c + dy * s) / rx;
        const v = (-dx * s + dy * c) / ry;
        const q = u * u + v * v;
        if (q < 1) this.px(x, y, r, g, b, a * Math.min(1, (1 - q) * Math.min(rx, ry)));
      }
    }
  }

  // leaf (lens) from (x, y) along angle ang: length L, max width W
  leaf(x, y, ang, L, W, r, g, b, a = 1, rib = 0) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    // oriented bounding box -> axis aligned bounds
    const ex = Math.abs(c) * L + Math.abs(s) * W * 0.5 + 1;
    const ey = Math.abs(s) * L + Math.abs(c) * W * 0.5 + 1;
    const mx = x + c * L * 0.5;
    const my = y + s * L * 0.5;
    const hx = ex * 0.5 + 1;
    const hy = ey * 0.5 + 1;
    for (let yy = Math.floor(my - hy); yy <= Math.ceil(my + hy); yy++) {
      for (let xx = Math.floor(mx - hx); xx <= Math.ceil(mx + hx); xx++) {
        const dx = xx + 0.5 - x;
        const dy = yy + 0.5 - y;
        const u = dx * c + dy * s;
        if (u < 0 || u > L) continue;
        const v = -dx * s + dy * c;
        const t = u / L;
        // ovate: widest at ~40% of the length, pointed tip
        const q = t < 0.4 ? t / 0.4 : (1 - t) / 0.6;
        const half = W * 0.5 * Math.sqrt(Math.max(0, q * (2 - q)));
        const edge = half - Math.abs(v);
        if (edge <= -0.5) continue;
        let k = 1;
        if (rib && Math.abs(v) < 0.6 && t > 0.05 && t < 0.9) k = rib;
        this.px(xx, yy, Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k), a * Math.min(1, edge + 0.5));
      }
    }
  }

  // convex polygon (array of [x, y]) via per-pixel half-plane test
  poly(pts, r, g, b, a = 1) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    // winding sign
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    const sg = area >= 0 ? 1 : -1;
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let dmin = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const q = pts[(i + 1) % pts.length];
          const ex = q[0] - p[0];
          const ey = q[1] - p[1];
          const el = Math.hypot(ex, ey) || 1;
          const d = (sg * (ex * (py - p[1]) - ey * (px - p[0]))) / el;
          if (d < dmin) dmin = d;
        }
        if (dmin > -0.5) this.px(x, y, r, g, b, a * Math.min(1, dmin + 0.5));
      }
    }
  }
}
