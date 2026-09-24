// Procedural textures for the dock: weathered cedar deck boards (color / normal / ORM atlas),
// round pilings with a wet band and algae at the waterline, and galvanized steel.
import { makeRng, clamp, smoothstep } from '../config.js';
import { makeNoise2, fbm2, coarseField } from './noise.js';
import { dataTexture, normalMapFromHeight } from './texutil.js';

// ---------------------------------------------------------------- deck atlas
// Layout (flipY = false, row 0 = v 0):
//   rows [0, band)            : 8 end-grain patches (140 x 38 mm each), side by side
//   rows [band + k*stripH ...]: 12 plank strips, u 0..1 <-> x -0.9..+0.9, v across 140 mm
// Screw heads sit at x = -0.8, 0, +0.8 (over the stringers) and 35 mm in from each edge, so
// flipping a strip in u or v keeps them aligned with the framing.
export const DECK_LAYOUT = { strips: 12, endPatches: 8, plankLen: 1.8, plankW: 0.14, screwX: [-0.8, 0, 0.8], screwT: [0.035, 0.105] };

export function deckLayout(W, H) {
  const band = H / 16;
  const stripH = (H - band) / DECK_LAYOUT.strips;
  return { W, H, band, stripH };
}

// Smooth 1D noise table (period `len`, features every ~`step` samples) for fiber streaks.
function fiberTable(n, len, step) {
  const t = new Float32Array(len);
  const cells = len / step;
  for (let i = 0; i < len; i++) t[i] = n((i / len) * cells, 7.3, cells, 0) * 0.7 + n((i / len) * cells * 3.1, 2.1, 0, 0) * 0.3;
  return t;
}

export function makeDeckTextures(size = 2048, anisotropy = 8) {
  const W = size;
  const H = size / 2;
  const { band, stripH } = deckLayout(W, H);
  const rng = makeRng(7331);
  const n = makeNoise2(11);
  const n2 = makeNoise2(23);
  const color = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const ormFull = new Uint8Array(W * H * 4);
  const L = DECK_LAYOUT.plankLen;
  const PW = DECK_LAYOUT.plankW;

  // palette (sRGB 0..255): sun-bleached silver-grey cedar, warmer tan where foot traffic wears it
  const greyE = [146, 142, 134];
  const greyL = [106, 102, 95];
  const warmE = [156, 124, 94];
  const warmL = [122, 92, 68];
  const colS = new Float32Array(W);
  const colWear = new Float32Array(W);
  const colEnd = new Float32Array(W);
  const colEndF = new Float32Array(W);
  const colEndH = new Float32Array(W);
  const colKnot = new Uint8Array(W);
  const colCheck = new Uint8Array(W);
  const colScrew = new Uint8Array(W);
  // latewood band profile as a lookup table over the ring phase
  const LATE = new Float32Array(257);
  for (let i = 0; i <= 256; i++) LATE[i] = smoothstep(0.66, 0.86, i / 256) * (1 - smoothstep(0.9, 1.0, i / 256));
  // long thin fibers: smooth 1D noise sampled with a per-row random offset
  const FIB = fiberTable(n, 8192, 18);

  for (let k = 0; k < DECK_LAYOUT.strips; k++) {
    const y0 = band + k * stripH;
    const weather = 0.8 + rng() * 0.2;
    const tc0 = -0.04 + rng() * 0.22;
    const d0 = 0.03 + rng() * 0.16;
    const taper = (rng() - 0.5) * 0.07;
    const ringSp = 0.0028 + rng() * 0.0022;
    const wearAmt = 0.25 + rng() * 0.35;
    const tint = 0.95 + rng() * 0.09;
    const seedS = rng() * 100;
    const knots = [];
    const nk = rng() < 0.35 ? 0 : 1 + Math.floor(rng() * 2.4);
    for (let i = 0; i < nk; i++) knots.push({ s: 0.15 + rng() * (L - 0.3), t: 0.02 + rng() * (PW - 0.04), r: 0.005 + rng() * 0.009, dark: rng() < 0.5 });
    const checks = [];
    const nc = 1 + Math.floor(rng() * 5);
    for (let i = 0; i < nc; i++) {
      const s0 = rng() * L;
      checks.push({ s0, s1: Math.min(L, s0 + 0.08 + rng() * 0.55), t: 0.012 + rng() * (PW - 0.024), w: 0.0004 + rng() * 0.0009, q: i });
    }
    const screws = [];
    for (const sx of DECK_LAYOUT.screwX)
      for (const st of DECK_LAYOUT.screwT) screws.push({ s: sx + 0.9 + (rng() - 0.5) * 0.006, t: st + (rng() - 0.5) * 0.006, rot: rng() * Math.PI, rust: rng() });
    // per-column terms
    for (let px = 0; px < W; px++) {
      const s = ((px + 0.5) / W) * L;
      colS[px] = n(s * 1.3 + seedS, k * 3.1) * 0.012 + n(s * 5.0 + seedS, k * 7.7) * 0.003;
      colWear[px] = (1 - smoothstep(0.18, 0.62, Math.abs(s - L * 0.5))) * wearAmt;
      const endS = Math.min(s, L - s);
      colEnd[px] = endS;
      colEndF[px] = 1 - 0.3 * (1 - smoothstep(0, 0.07, endS));
      colEndH[px] = -0.0015 * (1 - smoothstep(0, 0.004, endS)) ** 2;
    }
    // low-frequency fields on coarse grids (pixel coords within the strip)
    const blotchF = coarseField(W, stripH, 8, (x, y) => fbm2(n2, (x / W) * L * 4 + seedS, (y / stripH) * PW * 30 + k * 13, 3));
    const ddF = coarseField(W, stripH, 16, (x, y) => n2((x / W) * L * 0.8 + seedS, (y / stripH) * PW * 9) * 0.004);
    const spF = coarseField(W, stripH, 4, (x, y) => n2((x / W) * L * 140 + seedS, (y / stripH) * PW * 140));
    // which knots / checks / screws can touch each column (bitmasks) so most pixels skip them
    colKnot.fill(0);
    colCheck.fill(0);
    colScrew.fill(0);
    for (let px = 0; px < W; px++) {
      const s = ((px + 0.5) / W) * L;
      for (let q = 0; q < knots.length; q++) if (Math.abs(s - knots[q].s) * 0.8 <= 0.06) colKnot[px] |= 1 << q;
      for (let q = 0; q < checks.length; q++) if (s >= checks[q].s0 && s <= checks[q].s1) colCheck[px] |= 1 << q;
      for (let q = 0; q < screws.length; q++) if (Math.abs(s - screws[q].s) <= 0.07) colScrew[px] |= 1 << q;
    }

    const doRow = (py) => {
      const t = ((py + 0.5) / stripH) * PW;
      const edgeT = Math.min(t, PW - t);
      const edgeF = 1 - 0.38 * (1 - smoothstep(0, 0.011, edgeT));
      const edgeness = 1 - smoothstep(0.0, 0.02, edgeT);
      const edgeH = -0.0022 * (1 - smoothstep(0, 0.0045, edgeT)) ** 2;
      const edgeAO = 0.35 * (1 - smoothstep(0, 0.006, edgeT));
      const rowRef = (y0 + py) * W;
      const fibOff = ((k * 977 + py * 131) * 7) & 8191;
      for (let px = 0; px < W; px++) {
        const s = ((px + 0.5) / W) * L;
        const i = rowRef + px;
        // --- growth rings of a flat-sawn board (cathedral figure where the face cuts the rings)
        const tc = tc0 + colS[px];
        const dd = d0 + taper * (s - L * 0.5) + ddF(px, py);
        let r = Math.sqrt((t - tc) * (t - tc) + dd * dd);
        let knotMask = 0;
        let knotRing = 0;
        let knotIdx = -1;
        const km = colKnot[px];
        for (let q = 0; km && q < knots.length; q++) {
          if (!(km & (1 << q))) continue;
          const kn = knots[q];
          const ds = (s - kn.s) * 0.8;
          if (ds > 0.06 || ds < -0.06) continue;
          const dt = t - kn.t;
          const d2 = ds * ds + dt * dt;
          r += 0.004 * Math.exp(-d2 / (kn.r * kn.r * 6));
          const d = Math.sqrt(d2);
          if (d < kn.r * 1.15) {
            const m = 1 - smoothstep(kn.r * 0.85, kn.r * 1.15, d);
            if (m > knotMask) {
              knotMask = m;
              knotRing = d / kn.r;
              knotIdx = q;
            }
          }
        }
        const ph = r / ringSp;
        const late = LATE[((ph - Math.floor(ph)) * 256) | 0];
        // --- fibers and weathering
        const fiber = FIB[(px + fibOff) & 8191];
        const blotch = blotchF(px, py);
        const worn = colWear[px] * clamp(0.55 + blotch * 1.2, 0, 1);
        const wAmt = clamp(weather - worn * 0.7 + blotch * 0.15, 0, 1);
        const eR = warmE[0] + (greyE[0] - warmE[0]) * wAmt;
        const eG = warmE[1] + (greyE[1] - warmE[1]) * wAmt;
        const eB = warmE[2] + (greyE[2] - warmE[2]) * wAmt;
        const lR = warmL[0] + (greyL[0] - warmL[0]) * wAmt;
        const lG = warmL[1] + (greyL[1] - warmL[1]) * wAmt;
        const lB = warmL[2] + (greyL[2] - warmL[2]) * wAmt;
        const lateW = late * (0.35 + 0.35 * wAmt);
        let cr = eR + (lR - eR) * lateW;
        let cg = eG + (lG - eG) * lateW;
        let cb = eB + (lB - eB) * lateW;
        let f = tint * (1 + fiber * 0.06 + blotch * 0.07);
        // mildew specks (more near the edges and ends)
        const sp = spF(px, py);
        if (sp > 0.6 - edgeness * 0.25) f *= 0.74 + (1 - sp) * 0.3;
        // dirt in the gaps, darker end grain wicking at the ends
        f *= edgeF * colEndF[px];
        let h = late * 0.00045 * (0.4 + 0.6 * wAmt) + fiber * 0.00012 + edgeH;
        let rough = 0.86 + blotch * 0.06 - worn * 0.14 + late * 0.03;
        let metal = 0;
        let ao = 1 - edgeAO;
        // checks (cracks along the grain)
        const cm = colCheck[px];
        for (let q = 0; cm && q < checks.length; q++) {
          if (!(cm & (1 << q))) continue;
          const c = checks[q];
          const u = (s - c.s0) / (c.s1 - c.s0);
          const wdt = c.w * Math.sin(Math.PI * u) + 0.00008;
          const ct = c.t + colS[px] * 0.35 + (q - 2) * 0.0005;
          const dct = Math.abs(t - ct);
          if (dct < wdt * 2.2) {
            const m = 1 - smoothstep(wdt * 0.5, wdt * 2.2, dct);
            f *= 1 - 0.7 * m;
            h -= 0.0016 * m;
            ao -= 0.5 * m;
          }
        }
        // knots
        if (knotMask > 0) {
          const kn = knots[knotIdx];
          const kr = knotRing * 7.0;
          const kring = kr - Math.floor(kr);
          const kc0 = kn.dark ? 74 : 112;
          const kc1 = kn.dark ? 56 : 84;
          const kc2 = kn.dark ? 44 : 64;
          const ringD = 0.78 + 0.22 * kring;
          const rim = smoothstep(0.75, 1.0, knotRing) * (1 - smoothstep(1.0, 1.15, knotRing));
          cr += ((kc0 + 30 * wAmt) * ringD - cr) * knotMask;
          cg += ((kc1 + 28 * wAmt) * ringD - cg) * knotMask;
          cb += ((kc2 + 26 * wAmt) * ringD - cb) * knotMask;
          f *= 1 - rim * 0.35;
          h += 0.00025 * knotMask - rim * 0.0005;
          rough -= 0.08 * knotMask;
          if (Math.abs(t - kn.t - (s - kn.s) * 0.3) < 0.0005 && knotMask > 0.5) {
            f *= 0.5;
            h -= 0.0008;
          }
        }
        // screws: black tannin stain, rust streak along the grain, countersunk galvanized head
        const sm = colScrew[px];
        for (let q = 0; sm && q < screws.length; q++) {
          if (!(sm & (1 << q))) continue;
          const sc = screws[q];
          const ds = s - sc.s;
          const dt = t - sc.t;
          if (dt > 0.02 || dt < -0.02) continue;
          const d = Math.sqrt(ds * ds + dt * dt);
          const stain = Math.exp(-(d * d) / (0.011 * 0.011)) * 0.55;
          const streak = Math.exp(-(dt * dt) / (0.0035 * 0.0035)) * Math.exp(-Math.abs(ds) / 0.028) * 0.3 * (0.4 + sc.rust);
          f *= 1 - stain * 0.7;
          cr += (86 - cr) * streak;
          cg += (60 - cg) * streak;
          cb += (40 - cb) * streak;
          if (d < 0.0062) {
            if (d < 0.0043) {
              const rr = n(ds * 900 + q, dt * 900) * 0.5 + 0.5;
              const rust = clamp(sc.rust * 1.2 - 0.3 + rr * 0.5, 0, 1);
              cr = 128 + (112 - 128) * rust;
              cg = 126 + (72 - 126) * rust;
              cb = 120 + (44 - 120) * rust;
              f = 0.95 + rr * 0.1;
              const ca = Math.cos(sc.rot);
              const sa = Math.sin(sc.rot);
              const a1 = Math.abs(ds * ca + dt * sa);
              const a2 = Math.abs(-ds * sa + dt * ca);
              const slot = (a1 < 0.0007 && a2 < 0.0028) || (a2 < 0.0007 && a1 < 0.0028);
              h = -0.0006 - (slot ? 0.0009 : 0) + (0.0043 - d) * 0.08;
              if (slot) f *= 0.35;
              rough = 0.45 + rust * 0.4;
              metal = 0.75 * (1 - rust);
              ao = slot ? 0.5 : 0.95;
            } else {
              h -= 0.0007;
              f *= 0.45;
              ao -= 0.35;
            }
          }
        }
        h += colEndH[px];
        const ci = i * 4;
        color[ci] = clamp(cr * f, 0, 255);
        color[ci + 1] = clamp(cg * f, 0, 255);
        color[ci + 2] = clamp(cb * f, 0, 255);
        color[ci + 3] = 255;
        height[i] = h;
        ormFull[ci] = clamp(ao, 0.25, 1) * 255;
        ormFull[ci + 1] = clamp(rough, 0.2, 1) * 255;
        ormFull[ci + 2] = clamp(metal, 0, 1) * 255;
        ormFull[ci + 3] = 255;
      }
    };
    for (let py = 0; py < stripH; py++) doRow(py);
  }

  // --- end-grain patches (140 x 38 mm)
  const pw = W / DECK_LAYOUT.endPatches;
  for (let p = 0; p < DECK_LAYOUT.endPatches; p++) {
    const cx = (rng() - 0.5) * 0.18;
    const cy = -0.02 - rng() * 0.12;
    const sp = 0.0024 + rng() * 0.002;
    for (let py = 0; py < band; py++) {
      const y = ((py + 0.5) / band) * 0.038;
      for (let px = 0; px < pw; px++) {
        const x = ((px + 0.5) / pw) * 0.14 - 0.07;
        const r = Math.hypot(x - cx, y - cy) + n(x * 60 + p * 10, y * 60) * 0.0015;
        const ph = r / sp;
        const ring = ph - Math.floor(ph);
        const late = smoothstep(0.65, 0.88, ring) * (1 - smoothstep(0.92, 1, ring));
        const ang = Math.atan2(y - cy, x - cx);
        const crack = Math.abs(Math.sin(ang * 3 + p)) < 0.02 && r > 0.02 ? 1 : 0;
        const nn = n(x * 300 + p * 7, y * 300) * 0.5 + 0.5;
        let f = (0.85 + nn * 0.15) * (1 - late * 0.25) * (1 - crack * 0.6);
        const ed = Math.min(0.07 - Math.abs(x), y, 0.038 - y);
        f *= 1 - 0.3 * (1 - smoothstep(0, 0.003, ed));
        const i = py * W + p * pw + px;
        const ci = i * 4;
        color[ci] = 104 * f;
        color[ci + 1] = 95 * f;
        color[ci + 2] = 86 * f;
        color[ci + 3] = 255;
        height[i] = late * 0.0003 - crack * 0.001;
        ormFull[ci] = 255 * (1 - crack * 0.5);
        ormFull[ci + 1] = 240;
        ormFull[ci + 2] = 0;
        ormFull[ci + 3] = 255;
      }
    }
  }

  const sx = L / W;
  const sy = PW / stripH;
  const normal = normalMapFromHeight(height, W, H, sx, sy, { strength: 1 });
  // ORM at half resolution (roughness/AO do not need the full detail).
  const W2 = W / 2;
  const H2 = H / 2;
  const orm = new Uint8Array(W2 * H2 * 4);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const o = (y * W2 + x) * 4;
      const a = (2 * y * W + 2 * x) * 4;
      const b = a + 4;
      const c = a + W * 4;
      const d = c + 4;
      for (let ch = 0; ch < 4; ch++) orm[o + ch] = (ormFull[a + ch] + ormFull[b + ch] + ormFull[c + ch] + ormFull[d + ch]) >> 2;
    }
  }
  return {
    map: dataTexture(color, W, H, { srgb: true, anisotropy }),
    normalMap: dataTexture(normal, W, H, { srgb: false, anisotropy }),
    ormMap: dataTexture(orm, W2, H2, { srgb: false, anisotropy }),
    layout: deckLayout(W, H),
  };
}

// ---------------------------------------------------------------- pilings
// 512 x 1024. Left half (u 0..0.5): wrap-around pole surface; v maps world y from PILE_Y0 to PILE_Y1,
// so the wet band and algae line up with the real waterline on every piling.
// Right half, top 256 rows: the sawn top (end grain disc). The rest: plain weathered wood.
export const PILE_Y0 = -4.5;
export const PILE_Y1 = 1.3;
export function pileV(y) {
  return clamp((y - PILE_Y0) / (PILE_Y1 - PILE_Y0), 0, 1);
}

export function makePilingTextures(scale = 1) {
  const W = 512 * scale;
  const H = 1024 * scale;
  const WW = W / 2; // wrap width
  const n = makeNoise2(91);
  const n2 = makeNoise2(92);
  const rng = makeRng(93);
  const color = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const orm = new Uint8Array(W * H * 4);
  const period = 8; // noise lattice cells around the circumference
  const cracks = [];
  for (let i = 0; i < 9; i++) cracks.push({ u: rng(), y0: -0.2 + rng() * 0.6, y1: 0.3 + rng() * 0.6, w: 0.002 + rng() * 0.004 });
  const FIB = fiberTable(n, 4096, 28);
  const colOff = new Int32Array(WW);
  const edgeCol = new Float32Array(WW);
  const algCol = new Float32Array(WW);
  for (let px = 0; px < WW; px++) {
    const gx = ((px + 0.5) / WW) * period;
    colOff[px] = (rng() * 4096) | 0;
    edgeCol[px] = fbm2(n, gx * 1.5, 3.7, 3, period * 1.5, 0) * 0.07;
    algCol[px] = 0.035 + edgeCol[px] * 0.6 + n(gx * 8, 1.1, period * 8, 0) * 0.03;
  }
  const yOf = (py) => PILE_Y0 + ((py + 0.5) / H) * (PILE_Y1 - PILE_Y0);
  const blF = coarseField(WW, H, 8, (x, yy) => fbm2(n2, (x / WW) * period, yOf(yy) * 1.2, 3, period, 0));
  const u1F = coarseField(WW, H, 4, (x, yy) => n2((x / WW) * period * 3, yOf(yy) * 4, period * 3, 0));
  const u2F = coarseField(WW, H, 3, (x, yy) => n2((x / WW) * period * 10, yOf(yy) * 10, period * 10, 0));
  const crackOff = new Float32Array(cracks.length);
  const doRow = (py) => {
    const y = yOf(py);
    for (let c = 0; c < cracks.length; c++) crackOff[c] = cracks[c].u + n(y * 3, cracks[c].u * 10) * 0.01;
    const wetRow = y < 0.35;
    const underRow = y < -0.02;
    const algRow = y > -0.2 && y < 0.2;
    const topF = 1 + smoothstep(0.3, 0.8, y) * 0.06;
    const silt = smoothstep(-0.4, -1.8, y);
    const under = 1 - smoothstep(-0.12, -0.02, y);
    const algLow = smoothstep(-0.2, -0.06, y);
    for (let px = 0; px < WW; px++) {
      const u = (px + 0.5) / WW;
      const gx = u * period;
      const fib = FIB[(py + colOff[px]) & 4095];
      const bl = blF(px, py);
      // dry weathered pole
      let r = 112 + bl * 20;
      let g = 106 + bl * 18;
      let b = 97 + bl * 14;
      let f = 1 + fib * 0.1;
      let h = fib * 0.0003;
      let rough = 0.88;
      let ao = 1;
      // long drying checks
      for (let c = 0; c < cracks.length; c++) {
        const cr = cracks[c];
        if (y < cr.y0 || y > cr.y1) continue;
        let du = Math.abs(u - crackOff[c]);
        du = Math.min(du, 1 - du);
        if (du >= cr.w) continue;
        const m = 1 - smoothstep(0, cr.w, du);
        f *= 1 - 0.65 * m;
        h -= 0.002 * m;
        ao -= 0.4 * m;
      }
      // waterline: wet band with ragged upper edge, then algae, then slime under water
      if (wetRow) {
        const wetTop = 0.17 + edgeCol[px];
        const wet = 1 - smoothstep(wetTop - 0.05, wetTop + 0.02, y);
        if (wet > 0) {
          f *= 1 - 0.42 * wet;
          rough = rough + (0.38 - rough) * wet;
        }
      }
      if (underRow && under > 0) {
        const sr = 70 + bl * 10 + silt * 18;
        const sg = 66 + bl * 10 + silt * 10;
        const sb = 42 + bl * 6 + silt * 6;
        r += (sr - r) * under;
        g += (sg - g) * under;
        b += (sb - b) * under;
        f = f * (1 - under) + (0.85 + fib * 0.1 + u1F(px, py) * 0.15) * under;
        rough = rough + (0.62 - rough) * under;
        h += under * u2F(px, py) * 0.0006;
      }
      if (algRow) {
        const strands = n(gx * 3, y * 0.8, period * 3, 0);
        const algTop = algCol[px];
        const alg = algLow * (1 - smoothstep(algTop - 0.02, algTop + 0.01 + strands * 0.03, y));
        if (alg > 0) {
          const a = alg * (0.65 + 0.35 * strands);
          r += (58 - r) * a;
          g += (86 - g) * a;
          b += (34 - b) * a;
          h += a * 0.0012 * (0.5 + strands * 0.5);
          rough = rough + (0.5 - rough) * a;
        }
      }
      // slightly lighter, drier tops
      f *= topF;
      const i = py * W + px;
      const ci = i * 4;
      color[ci] = clamp(r * f, 0, 255);
      color[ci + 1] = clamp(g * f, 0, 255);
      color[ci + 2] = clamp(b * f, 0, 255);
      color[ci + 3] = 255;
      height[i] = h;
      orm[ci] = clamp(ao, 0.3, 1) * 255;
      orm[ci + 1] = clamp(rough, 0.2, 1) * 255;
      orm[ci + 2] = 0;
      orm[ci + 3] = 255;
    }
    // right half: end grain disc in the top square, plain board wood below
    for (let px = WW; px < W; px++) {
      const i = py * W + px;
      const ci = i * 4;
      let r;
      let g;
      let b;
      let h = 0;
      let rough = 0.9;
      let ao = 1;
      if (py < WW) {
        const x = ((px - WW + 0.5) / WW) * 2 - 1;
        const z = ((py + 0.5) / WW) * 2 - 1;
        const rad = Math.hypot(x, z) + n(x * 5, z * 5) * 0.03;
        const ang = Math.atan2(z, x);
        const ph = rad * 24;
        const ring = ph - Math.floor(ph);
        const late = smoothstep(0.6, 0.85, ring) * (1 - smoothstep(0.9, 1, ring));
        const crack = (Math.abs(Math.sin(ang * 1.5 + 0.7)) < 0.035 && rad > 0.12) || (Math.abs(Math.sin(ang * 2.5 + 2.1)) < 0.02 && rad > 0.45) ? 1 : 0;
        const nn = n(x * 20, z * 20) * 0.5 + 0.5;
        let f = (0.82 + nn * 0.18) * (1 - late * 0.22) * (1 - crack * 0.65);
        const mild = n2(x * 12, z * 12);
        if (mild > 0.35) f *= 0.8;
        f *= 1 - 0.25 * smoothstep(0.85, 1.0, rad);
        r = 118 * f;
        g = 112 * f;
        b = 102 * f;
        h = late * 0.0004 - crack * 0.0015;
        ao = crack ? 0.5 : 1;
      } else {
        const x = (px - WW) / WW;
        const yy = py / H;
        const fib = n(x * 40, yy * 3) * 0.5 + n(x * 90, yy * 8) * 0.5;
        const f = 1 + fib * 0.08;
        r = 120 * f;
        g = 112 * f;
        b = 100 * f;
        h = fib * 0.0003;
      }
      color[ci] = clamp(r, 0, 255);
      color[ci + 1] = clamp(g, 0, 255);
      color[ci + 2] = clamp(b, 0, 255);
      color[ci + 3] = 255;
      height[i] = h;
      orm[ci] = ao * 255;
      orm[ci + 1] = rough * 255;
      orm[ci + 2] = 0;
      orm[ci + 3] = 255;
    }
  };
  for (let py = 0; py < H; py++) doRow(py);
  // meters per pixel: circumference ~0.75 m over WW px; world y range over H px
  const normal = normalMapFromHeight(height, W, H, 0.75 / WW, (PILE_Y1 - PILE_Y0) / H, { strength: 1 });
  return {
    map: dataTexture(color, W, H, { srgb: true, anisotropy: 4 }),
    normalMap: dataTexture(normal, W, H, { srgb: false, anisotropy: 4 }),
    ormMap: dataTexture(orm, W, H, { srgb: false, anisotropy: 4 }),
  };
}

// ---------------------------------------------------------------- galvanized steel (tileable)
export function makeGalvanizedTextures(size = 256) {
  const S = size;
  const rng = makeRng(501);
  const n = makeNoise2(502);
  const pts = [];
  const CELLS = 7;
  for (let cy = 0; cy < CELLS; cy++)
    for (let cx = 0; cx < CELLS; cx++) pts.push({ x: (cx + rng()) / CELLS, y: (cy + rng()) / CELLS, v: rng() });
  const color = new Uint8Array(S * S * 4);
  const orm = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const v = (y + 0.5) / S;
      // tileable nearest-cell (spangle crystals)
      let best = 9;
      let second = 9;
      let val = 0;
      const cx = Math.floor(u * CELLS);
      const cy = Math.floor(v * CELLS);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = (cx + ox + CELLS) % CELLS;
          const gy = (cy + oy + CELLS) % CELLS;
          const p = pts[gy * CELLS + gx];
          const px = p.x + Math.floor((cx + ox) / CELLS);
          const py = p.y + Math.floor((cy + oy) / CELLS);
          const d = Math.hypot(u - px, v - py);
          if (d < best) {
            second = best;
            best = d;
            val = p.v;
          } else if (d < second) second = d;
        }
      }
      const border = 1 - smoothstep(0, 0.012, second - best);
      const oxide = smoothstep(0.15, 0.55, fbm2(n, u * 6, v * 6, 4, 6, 6));
      const grime = fbm2(n, u * 3 + 10, v * 3, 3, 3, 3);
      let g = 136 + val * 16 - border * 7;
      g = g * (1 - oxide * 0.12) + oxide * 30;
      g *= 1 + grime * 0.14;
      const i = (y * S + x) * 4;
      color[i] = clamp(g * 0.98, 0, 255);
      color[i + 1] = clamp(g, 0, 255);
      color[i + 2] = clamp(g * 1.01, 0, 255);
      color[i + 3] = 255;
      orm[i] = 255;
      orm[i + 1] = clamp(0.55 + val * 0.1 + oxide * 0.3 + grime * 0.08, 0, 1) * 255;
      orm[i + 2] = clamp(1 - oxide * 0.45, 0, 1) * 255;
      orm[i + 3] = 255;
    }
  }
  return {
    map: dataTexture(color, S, S, { srgb: true, repeat: true, anisotropy: 4 }),
    ormMap: dataTexture(orm, S, S, { srgb: false, repeat: true, anisotropy: 4 }),
  };
}
