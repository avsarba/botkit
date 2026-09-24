// Procedural Canvas2D textures for the rod, reel and terminal tackle (no network assets).
import * as THREE from 'three';
import { makeRng } from '../config.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function colorTex(c, { repeat = [1, 1], wrap = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function dataTex(c, { repeat = [1, 1], wrap = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.needsUpdate = true;
  return t;
}

// Cork: tan base, dark elongated lenticels and filled pits, faint ring seams. Returns { map, bump }.
// Mapping: u around the grip, v = meters * 20 (one tile per 5 cm).
export function makeCorkTextures() {
  const W = 512;
  const H = 256;
  const c = canvas(W, H);
  const b = canvas(W, H);
  const g = c.getContext('2d');
  const gb = b.getContext('2d');
  const rng = makeRng(7);
  g.fillStyle = '#b89468';
  g.fillRect(0, 0, W, H);
  gb.fillStyle = '#9a9a9a';
  gb.fillRect(0, 0, W, H);
  // mottled base
  for (let i = 0; i < 2600; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const r = 2 + rng() * 9;
    const l = rng();
    g.fillStyle = l < 0.5 ? `rgba(214,184,140,${0.05 + rng() * 0.1})` : `rgba(140,104,64,${0.04 + rng() * 0.08})`;
    g.beginPath();
    g.ellipse(x, y, r * (1 + rng()), r, rng() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  // fine grain
  for (let i = 0; i < 14000; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const v = rng();
    g.fillStyle = v < 0.5 ? `rgba(90,62,34,${0.12 + rng() * 0.18})` : `rgba(230,205,160,${0.1 + rng() * 0.15})`;
    g.fillRect(x, y, 1 + rng() * 1.5, 1);
  }
  // lenticels / pits (dark, slightly elongated around the grip), same spots dark in the bump map
  for (let i = 0; i < 520; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const rx = 1 + rng() * (rng() < 0.12 ? 7 : 3.2);
    const ry = rx * (0.35 + rng() * 0.45);
    const a = (rng() - 0.5) * 0.6;
    const dark = 40 + rng() * 40;
    g.fillStyle = `rgba(${dark + 28},${dark + 10},${dark - 8},${0.55 + rng() * 0.4})`;
    g.beginPath();
    g.ellipse(x, y, rx, ry, a, 0, Math.PI * 2);
    g.fill();
    gb.fillStyle = `rgba(20,20,20,${0.6 + rng() * 0.4})`;
    gb.beginPath();
    gb.ellipse(x, y, rx, ry, a, 0, Math.PI * 2);
    gb.fill();
    // wrap horizontally so the seam tiles
    if (x < 10 || x > W - 10) {
      const x2 = x < 10 ? x + W : x - W;
      g.beginPath();
      g.ellipse(x2, y, rx, ry, a, 0, Math.PI * 2);
      g.fill();
      gb.beginPath();
      gb.ellipse(x2, y, rx, ry, a, 0, Math.PI * 2);
      gb.fill();
    }
  }
  // ring seams (cork rings are ~12.7 mm): 4 per 5 cm tile
  for (let k = 0; k < 4; k++) {
    const y = ((k + 0.5) / 4) * H + (rng() - 0.5) * 3;
    g.strokeStyle = 'rgba(95,68,40,0.35)';
    g.lineWidth = 1.2;
    g.beginPath();
    for (let x = 0; x <= W; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + k) * 0.8);
    g.stroke();
    gb.strokeStyle = 'rgba(40,40,40,0.5)';
    gb.lineWidth = 1.5;
    gb.beginPath();
    gb.moveTo(0, y);
    gb.lineTo(W, y);
    gb.stroke();
  }
  return { map: colorTex(c), bump: dataTex(b) };
}

// Hi-vis monofilament cross-wrapped on the spool. u around, v across the arbor.
export function makeSpoolLineTexture() {
  const W = 256;
  const H = 64;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#a9bf2c';
  g.fillRect(0, 0, W, H);
  const rng = makeRng(3);
  // two crossing helix directions
  for (let pass = 0; pass < 2; pass++) {
    const slope = pass === 0 ? 0.32 : -0.32;
    for (let i = -40; i < 90; i++) {
      const x0 = i * 3.4;
      const l = rng();
      g.strokeStyle = l < 0.5 ? `rgba(226,244,110,${0.45 + rng() * 0.3})` : `rgba(96,118,20,${0.35 + rng() * 0.3})`;
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(x0, 0);
      g.lineTo(x0 + H / slope, H);
      g.stroke();
    }
  }
  return colorTex(c, { repeat: [5, 1] });
}

// Knurled lock nut / hood bump.
export function makeKnurlBump() {
  const c = canvas(64, 32);
  const g = c.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 64, 32);
  g.strokeStyle = '#303030';
  g.lineWidth = 1;
  for (let i = -8; i < 24; i++) {
    g.beginPath();
    g.moveTo(i * 4, 0);
    g.lineTo(i * 4 + 16, 32);
    g.stroke();
    g.beginPath();
    g.moveTo(i * 4 + 16, 0);
    g.lineTo(i * 4, 32);
    g.stroke();
  }
  return dataTex(c, { repeat: [8, 1] });
}

// Classic clip-on bobber: red top, white bottom, pressed seam; slight grime near the waterline.
export function makeFloatTexture() {
  const W = 128;
  const H = 64;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const rng = makeRng(11);
  const top = g.createLinearGradient(0, 0, 0, H / 2);
  top.addColorStop(0, '#b3151b');
  top.addColorStop(1, '#c81f22');
  g.fillStyle = top;
  g.fillRect(0, 0, W, H / 2);
  const bot = g.createLinearGradient(0, H / 2, 0, H);
  bot.addColorStop(0, '#ecebe4');
  bot.addColorStop(0.6, '#e2e3dc');
  bot.addColorStop(1, '#c9cfc2');
  g.fillStyle = bot;
  g.fillRect(0, H / 2, W, H / 2);
  // seam
  g.fillStyle = 'rgba(70,10,12,0.55)';
  g.fillRect(0, H / 2 - 1.5, W, 1.2);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(0, H / 2 + 0.2, W, 0.8);
  // scuffs
  for (let i = 0; i < 90; i++) {
    const x = rng() * W;
    const y = rng() * H;
    g.fillStyle = y < H / 2 ? `rgba(255,190,190,${rng() * 0.12})` : `rgba(110,120,90,${rng() * 0.1})`;
    g.fillRect(x, y, 1 + rng() * 5, 0.6);
  }
  return colorTex(c, { wrap: false });
}

// Nightcrawler: annuli, paler belly, clitellum band ~1/3 from the head. u around, v along (0 head .. 1 tail).
export function makeWormTexture() {
  const W = 32;
  const H = 256;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  for (let y = 0; y < H; y++) {
    const v = y / H;
    const r = 136 - v * 14;
    const gg = 70 + v * 10;
    const b = 76 + v * 8;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const side = 0.5 + 0.5 * Math.cos(u * Math.PI * 2); // 1 on the back, 0 on the belly
      const k = 0.78 + 0.22 * side;
      g.fillStyle = `rgb(${Math.round((r + (1 - side) * 42) * k)},${Math.round((gg + (1 - side) * 36) * k)},${Math.round((b + (1 - side) * 30) * k)})`;
      g.fillRect(x, y, 1, 1);
    }
  }
  // clitellum
  const cy = H * 0.2;
  const grad = g.createLinearGradient(0, cy - 14, 0, cy + 14);
  grad.addColorStop(0, 'rgba(196,112,92,0)');
  grad.addColorStop(0.3, 'rgba(196,112,92,0.8)');
  grad.addColorStop(0.7, 'rgba(190,106,88,0.8)');
  grad.addColorStop(1, 'rgba(196,112,92,0)');
  g.fillStyle = grad;
  g.fillRect(0, cy - 14, W, 28);
  // annuli
  for (let y = 0; y < H; y += 2.6) {
    g.fillStyle = 'rgba(40,14,18,0.28)';
    g.fillRect(0, y, W, 0.8);
  }
  return colorTex(c, { wrap: true });
}

// Painted yellow-perch crankbait. u: tail(0) -> nose(1), v: around (0 back, 0.5 belly, 1 back).
export function makePerchCrankTexture() {
  const W = 512;
  const H = 256;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const rng = makeRng(21);
  // vertical color gradient (mirrored around the belly)
  const grad = g.createLinearGradient(0, 0, 0, H);
  const stops = [
    [0.0, '#2e3a12'],
    [0.1, '#56631c'],
    [0.2, '#a39a2a'],
    [0.3, '#d6c34a'],
    [0.4, '#eee0a0'],
    [0.47, '#f4efe2'],
    [0.53, '#f4efe2'],
    [0.6, '#eee0a0'],
    [0.7, '#d6c34a'],
    [0.8, '#a39a2a'],
    [0.9, '#56631c'],
    [1.0, '#2e3a12'],
  ];
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // orange chin / belly toward the head
  const chin = g.createRadialGradient(W * 0.85, H * 0.5, 4, W * 0.85, H * 0.5, H * 0.3);
  chin.addColorStop(0, 'rgba(236,112,34,0.85)');
  chin.addColorStop(1, 'rgba(236,112,34,0)');
  g.fillStyle = chin;
  g.fillRect(W * 0.55, 0, W * 0.45, H);
  // dark vertical bars (6), both sides (mirror across v=0.5)
  const bars = [0.2, 0.31, 0.42, 0.53, 0.63, 0.72];
  for (const bx of bars) {
    const w = W * (0.035 + rng() * 0.015);
    for (const side of [0, 1]) {
      g.save();
      g.beginPath();
      const x = W * bx;
      const y0 = side === 0 ? 0 : H;
      const y1 = side === 0 ? H * 0.33 : H * 0.67;
      g.moveTo(x - w * 0.6, y0);
      g.bezierCurveTo(x - w * 0.9, (y0 + y1) / 2, x - w * 0.2, y1, x, y1 + (side === 0 ? 6 : -6));
      g.bezierCurveTo(x + w * 0.2, y1, x + w * 0.9, (y0 + y1) / 2, x + w * 0.6, y0);
      g.closePath();
      g.filter = 'blur(3px)';
      g.fillStyle = 'rgba(36,46,12,0.62)';
      g.fill();
      g.restore();
    }
  }
  // darker head top
  const head = g.createLinearGradient(W * 0.78, 0, W, 0);
  head.addColorStop(0, 'rgba(30,38,10,0)');
  head.addColorStop(1, 'rgba(30,38,10,0.55)');
  g.fillStyle = head;
  g.fillRect(W * 0.78, 0, W * 0.22, H * 0.25);
  g.fillRect(W * 0.78, H * 0.75, W * 0.22, H * 0.25);
  // scale crosshatch on the sides
  g.strokeStyle = 'rgba(255,255,230,0.09)';
  g.lineWidth = 1;
  for (let i = -40; i < 80; i++) {
    g.beginPath();
    g.moveTo(i * 9, 0);
    g.lineTo(i * 9 + H * 0.6, H);
    g.stroke();
    g.beginPath();
    g.moveTo(i * 9 + H * 0.6, 0);
    g.lineTo(i * 9, H);
    g.stroke();
  }
  // gill slash (red), both sides
  g.strokeStyle = 'rgba(190,30,30,0.85)';
  g.lineWidth = 3;
  for (const side of [0, 1]) {
    g.beginPath();
    const yA = side === 0 ? H * 0.2 : H * 0.8;
    const yB = side === 0 ? H * 0.44 : H * 0.56;
    g.moveTo(W * 0.8, yA);
    g.quadraticCurveTo(W * 0.765, (yA + yB) / 2, W * 0.79, yB);
    g.stroke();
  }
  // fine speckle
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(20,30,8,${rng() * 0.18})`;
    g.fillRect(rng() * W, rng() * H, 1, 1);
  }
  return colorTex(c, { wrap: false });
}

// Bone body with a chartreuse back (walking topwater).
export function makeBoneChartTexture() {
  const W = 512;
  const H = 256;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  const rng = makeRng(33);
  const grad = g.createLinearGradient(0, 0, 0, H);
  const stops = [
    [0.0, '#9fb52a'],
    [0.08, '#b7c83c'],
    [0.17, '#d9d9a6'],
    [0.26, '#ebe5cf'],
    [0.5, '#f1ecdc'],
    [0.74, '#ebe5cf'],
    [0.83, '#d9d9a6'],
    [0.92, '#b7c83c'],
    [1.0, '#9fb52a'],
  ];
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // faint scale pattern
  g.strokeStyle = 'rgba(120,110,80,0.10)';
  for (let y = 0; y < H; y += 7) {
    for (let x = (y / 7) % 2 ? 0 : 5; x < W; x += 10) {
      g.beginPath();
      g.arc(x, y, 5, 0.2, Math.PI - 0.2);
      g.stroke();
    }
  }
  // lateral shadow line
  g.fillStyle = 'rgba(120,120,70,0.12)';
  g.fillRect(0, H * 0.25 - 2, W * 0.9, 4);
  g.fillRect(0, H * 0.75 - 2, W * 0.9, 4);
  // gill mark
  g.strokeStyle = 'rgba(175,30,30,0.8)';
  g.lineWidth = 3;
  for (const side of [0, 1]) {
    const yA = side === 0 ? H * 0.18 : H * 0.82;
    const yB = side === 0 ? H * 0.42 : H * 0.58;
    g.beginPath();
    g.moveTo(W * 0.82, yA);
    g.quadraticCurveTo(W * 0.8, (yA + yB) / 2, W * 0.815, yB);
    g.stroke();
  }
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(80,70,40,${rng() * 0.1})`;
    g.fillRect(rng() * W, rng() * H, 1, 1);
  }
  return colorTex(c, { wrap: false });
}

// 3D lure eye: gold iris with a black pupil (mapped onto a sphere cap facing +Z).
export function makeEyeTexture(iris = '#e2b21c') {
  const S = 64;
  const c = canvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#1b1b12';
  g.fillRect(0, 0, S, S);
  const r = g.createRadialGradient(S / 2, S / 2, 2, S / 2, S / 2, S * 0.5);
  r.addColorStop(0, '#050505');
  r.addColorStop(0.36, '#050505');
  r.addColorStop(0.4, iris);
  r.addColorStop(0.85, iris);
  r.addColorStop(1, '#6b4d08');
  g.fillStyle = r;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.5, 0, Math.PI * 2);
  g.fill();
  return colorTex(c, { wrap: false });
}

// Text decal for the blank (silver print on transparent), u along the blank.
export function makeRodDecalTexture() {
  const W = 512;
  const H = 32;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(200,204,210,0.95)';
  g.font = '600 17px Helvetica, Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText('LOON LAKE  IM8 GRAPHITE', 8, H / 2 + 1);
  g.font = '500 15px Helvetica, Arial, sans-serif';
  g.fillText("7'0\"  M  F   6-12 lb   1/8-5/8 oz", 262, H / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
