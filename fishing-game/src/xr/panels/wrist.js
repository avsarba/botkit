// Wrist gauge (reel hand, back of the wrist, tilted toward the eyes, 13 x 9 cm): the DOM tension dial
// redrawn for a headset. 0 -> line test with ticks, the red zone and the brass drag marker; the value
// in the middle; header "12 lb test" + fish-on dot (and the fish's distance); clock, drag, lure and
// line out beside it. Only redraws when a displayed value changes (quantized like the DOM readouts).
import * as THREE from 'three';
import { TACKLE, LURES, G, KG_PER_LB, M_PER_FT, formatDistance, formatClock, clamp } from '../../config.js';
import { RED_FROM, lineTestIn } from '../../ui/gauge.js';
import { createPanel } from './panel.js';
import { setFont, text, box, dot, textWidth } from './draw.js';

const W = 780;
const H = 540; // 6 px per mm
const AMBER_UP = 0.7;
const AMBER_DOWN = 0.66;
const RED_DOWN = 0.85;
const A0 = 210;
const SWEEP = 240;
const SLACK_PULSE_MS = 800;
const LURE_SHORT = Object.fromEntries(LURES.map((l) => [l.id, l.short]));
const LURE_INDEX = Object.fromEntries(LURES.map((l, i) => [l.id, i]));
const DEG = Math.PI / 180;

// Mount in the reel grip's space. Grip space: -Z along the handle toward the thumb, the back of the
// right hand toward +X (left hand: -X). ALIGN turns that into the controller's pointing frame (-Z ahead,
// +Y up, as the Touch / most controllers tilt the grip ~45 degrees from the ray); the gauge then sits on
// top of the wrist behind the hand, its face up and tilted back toward the eyes, rolled a little toward
// the back of the hand. Distances in meters.
const ALIGN_X = -45 * DEG;
const POS = { x: 0.012, y: 0.042, z: 0.118 }; // x is toward the back of the hand (mirrored per hand)
const TILT_X = -52 * DEG; // -90 = face straight up; less tilts the face back toward the eyes
const ROLL_Z = 16 * DEG; // toward the back of the hand

const forceIn = (n, units) => (units === 'metric' ? n / G : n / (G * KG_PER_LB));
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createWristGauge(tk) {
  const c = tk.c;
  const F = tk.font;
  const mount = new THREE.Group();
  mount.name = 'xr-wrist-mount';
  mount.rotation.x = ALIGN_X;

  const v = {
    units: 'imperial',
    t01: 0,
    tensionN: 0,
    dragN: TACKLE.dragMinN + TACKLE.dragDefault01 * (TACKLE.dragMaxN - TACKLE.dragMinN),
    lineOutM: 0,
    fishOn: false,
    fishDistanceM: NaN,
    lureId: LURES[0].id,
    hours: 6,
    level: 0,
    slack: false,
    slackSince: 0,
    pulse: 0, // 0..1 slack pulse phase (0 = track color, 1 = amber)
  };
  const keys = new Array(12).fill(NaN);

  function levelFor(t) {
    let l = v.level;
    if (l === 2 && t < RED_DOWN) l = 1;
    if (l === 1 && t < AMBER_DOWN) l = 0;
    if (l === 0 && t >= AMBER_UP) l = 1;
    if (l === 1 && t >= RED_FROM) l = 2;
    return l;
  }

  // ---------- drawing ----------
  function draw(ctx) {
    const metric = v.units === 'metric';
    box(ctx, 2, 2, W - 4, H - 4, 30, { fill: c['glass-strong'], stroke: c.hair, lineWidth: 2 });

    // header: line test (left), fish on (right)
    const test = lineTestIn(v.units);
    setFont(ctx, 600, 26, F.ui, { spacing: 0.14 });
    text(ctx, (metric ? `${test.toFixed(1)} kg test` : `${Math.round(test)} lb test`).toUpperCase(), 36, 62, { color: c.muted });
    if (v.fishOn) {
      const dist = Number.isFinite(v.fishDistanceM) ? formatDistance(Math.max(0, v.fishDistanceM), v.units) : '';
      setFont(ctx, 500, 28, F.mono);
      const dw = dist ? textWidth(ctx, dist) : 0;
      if (dist) text(ctx, dist, W - 36, 62, { color: c.text, align: 'right' });
      setFont(ctx, 600, 26, F.ui, { spacing: 0.14 });
      const lw = textWidth(ctx, 'FISH ON');
      const x1 = W - 36 - (dw ? dw + 16 : 0);
      text(ctx, 'FISH ON', x1, 62, { color: c.text, align: 'right' });
      dot(ctx, x1 - lw - 16, 53, 8, c.red);
    }

    // dial (the DOM gauge's 240 x 164 geometry, scaled)
    const s = 1.83;
    const ox = 22;
    const oy = 78;
    const cx = ox + 120 * s;
    const cy = oy + 112 * s;
    const R = 86 * s;
    const ang = (t) => (SWEEP * t - A0) * DEG;
    const at = (t, r) => [cx + r * Math.cos(ang(t)), cy + r * Math.sin(ang(t))];
    const arc = (t0, t1, color, width, alpha = 1) => {
      if (t1 <= t0) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(cx, cy, R, ang(t0), ang(t1), false);
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const tw = 7 * s;
    arc(0, 1, c.track, tw);
    if (v.pulse > 0) arc(0, 1, c['amber-soft'], tw, v.pulse);
    arc(RED_FROM, 1, c.red, tw, 0.55);
    const t = clamp(v.t01, 0, 1);
    const fillColor = v.level === 2 ? c.red : v.level === 1 ? c.amber : c.line;
    arc(0, t, fillColor, tw);

    // ticks and numbers in display units
    const maxV = test;
    const minor = metric ? 0.5 : 1;
    const major = metric ? 1 : 2;
    const n = Math.floor(maxV / minor + 1e-6);
    setFont(ctx, 500, 22, F.mono);
    ctx.lineCap = 'butt';
    for (let i = 0; i <= n; i++) {
      const val = i * minor;
      const tt = val / maxV;
      const isMajor = Math.abs(val / major - Math.round(val / major)) < 1e-6;
      const red = tt >= RED_FROM - 1e-6;
      const [x0, y0] = at(tt, R - 7 * s);
      const [x1, y1] = at(tt, isMajor ? R - 16 * s : R - 12 * s);
      ctx.strokeStyle = red ? c.red : isMajor ? c.text : c.muted;
      ctx.lineWidth = (isMajor ? 1.6 : 1.2) * s;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (isMajor) {
        const [tx, ty] = at(tt, R - 29 * s);
        text(ctx, String(Math.round(val)), tx, ty, { color: red ? c.red : c.muted, align: 'center', baseline: 'middle' });
      }
    }
    // brass drag marker: where the spool starts to slip
    const dragT = clamp(v.dragN / TACKLE.lineBreakN, 0, 1);
    {
      const a = ang(dragT);
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      ctx.strokeStyle = c.brass;
      ctx.lineWidth = 2.5 * s;
      ctx.beginPath();
      ctx.moveTo(cx + ux * (R - 6 * s), cy + uy * (R - 6 * s));
      ctx.lineTo(cx + ux * (R + 6 * s), cy + uy * (R + 6 * s));
      ctx.stroke();
      const tipX = cx + ux * (R + 6 * s);
      const tipY = cy + uy * (R + 6 * s);
      const bx = cx + ux * (R + 15 * s);
      const by = cy + uy * (R + 15 * s);
      const w = 4.6 * s;
      ctx.fillStyle = c.brass;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(bx - uy * w, by + ux * w);
      ctx.lineTo(bx + uy * w, by - ux * w);
      ctx.closePath();
      ctx.fill();
    }
    // index bar across the track at the current tension
    {
      const [x0, y0] = at(t, R - 11 * s);
      const [x1, y1] = at(t, R + 5 * s);
      ctx.strokeStyle = v.level === 2 ? c.red : c.text;
      ctx.lineWidth = 2.5 * s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    // value in the middle
    const valueColor = v.level === 2 ? c.red : v.level === 1 || v.pulse > 0.01 || v.slack ? c.amber : c.text;
    setFont(ctx, 500, 70, F.mono);
    text(ctx, (Math.round(forceIn(v.tensionN, v.units) * 10) / 10).toFixed(1), cx, cy + 4, { color: valueColor, align: 'center', baseline: 'alphabetic' });
    setFont(ctx, 600, 22, F.ui, { spacing: 0.14 });
    text(ctx, metric ? 'KG' : 'LB', cx, cy + 40, { color: c.muted, align: 'center' });

    // left, under the dial: line out
    const lx = 44;
    setFont(ctx, 600, 24, F.ui, { spacing: 0.14 });
    text(ctx, 'LINE OUT', lx, 452, { color: c.muted });
    setFont(ctx, 500, 44, F.mono);
    text(ctx, formatDistance(Math.max(0, v.lineOutM), v.units), lx, 504, { color: c.text });

    // right column: clock, drag, lure
    const rx = 500;
    ctx.fillStyle = c.hair;
    ctx.fillRect(rx - 26, 92, 2, 412);
    const clock = formatClock(((fin(v.hours, 6) % 24) + 24) % 24);
    const sp = clock.lastIndexOf(' ');
    setFont(ctx, 500, 56, F.mono);
    const hm = clock.slice(0, sp);
    text(ctx, hm, rx, 150, { color: c.text });
    const hmw = textWidth(ctx, hm);
    setFont(ctx, 500, 26, F.mono, { spacing: 0.04 });
    text(ctx, clock.slice(sp + 1), rx + hmw + 8, 150, { color: c.muted });

    setFont(ctx, 600, 24, F.ui, { spacing: 0.14 });
    text(ctx, 'DRAG', rx, 248, { color: c.brass });
    setFont(ctx, 500, 44, F.mono);
    text(ctx, `${(Math.round(forceIn(v.dragN, v.units) * 10) / 10).toFixed(1)} ${metric ? 'kg' : 'lb'}`, rx, 298, { color: c.text, maxWidth: W - rx - 30 });

    setFont(ctx, 600, 24, F.ui, { spacing: 0.14 });
    text(ctx, 'LURE', rx, 400, { color: c.muted });
    setFont(ctx, 600, 40, F.ui, { spacing: 0.06 });
    text(ctx, (LURE_SHORT[v.lureId] || String(v.lureId || '–')).toUpperCase(), rx, 450, { color: c.text, maxWidth: W - rx - 30 });
    return H;
  }

  const panel = createPanel({ name: 'xr-wrist', widthM: 0.13, heightM: 0.09, pxW: W, pxH: H, draw });
  mount.add(panel.object);

  function setHand(reelHand) {
    // x toward the back of the hand: -X on the left hand, +X on the right
    const side = reelHand === 'right' ? 1 : -1;
    panel.object.position.set(side * POS.x, POS.y, POS.z);
    panel.object.rotation.set(TILT_X, 0, -side * ROLL_Z, 'ZXY');
  }
  setHand('left');

  // Take the per-frame numbers; invalidate the panel only when something shown changed.
  function set(hud, now) {
    if (!hud) return;
    const units = hud.units === 'metric' ? 'metric' : 'imperial';
    v.units = units;
    v.tensionN = Number.isFinite(hud.tensionN) ? Math.max(0, hud.tensionN) : fin(hud.tension01) * TACKLE.lineBreakN;
    v.t01 = Number.isFinite(hud.tension01) ? hud.tension01 : v.tensionN / TACKLE.lineBreakN;
    v.level = levelFor(clamp(v.t01, 0, 1));
    if (Number.isFinite(hud.dragN)) v.dragN = hud.dragN;
    else if (Number.isFinite(hud.drag01)) v.dragN = TACKLE.dragMinN + hud.drag01 * (TACKLE.dragMaxN - TACKLE.dragMinN);
    v.lineOutM = fin(hud.lineOutM);
    v.fishOn = !!hud.fishOn;
    v.fishDistanceM = fin(hud.fishDistanceM, NaN);
    if (hud.lureId) v.lureId = hud.lureId;
    if (Number.isFinite(hud.hours)) v.hours = hud.hours;
    // slack line with a fish on: after a moment the empty track pulses amber (0.9 s period)
    const slack = hud.state === 'fighting' && v.fishOn && (typeof hud.slackLine === 'boolean' ? hud.slackLine : v.t01 < 0.02);
    if (!slack) v.slackSince = 0;
    else if (!v.slackSince) v.slackSince = now;
    v.slack = slack && now - v.slackSince >= SLACK_PULSE_MS;
    v.pulse = v.slack ? 0.5 - 0.5 * Math.cos(((now - v.slackSince) / 900) * Math.PI * 2) : 0;

    // numeric change keys (no per-frame garbage), quantized like the DOM readouts
    const metric = units === 'metric';
    const dist = (m) => (metric ? Math.round(m * 10) : Math.round(m / M_PER_FT));
    let i = 0;
    let changed = false;
    const put = (x) => {
      if (keys[i] !== x) {
        keys[i] = x;
        changed = true;
      }
      i++;
    };
    put(metric ? 1 : 0);
    put(Math.round(forceIn(v.tensionN, units) * 10));
    put(Math.round(clamp(v.t01, 0, 1) * 400));
    put(v.level);
    put(Math.round(forceIn(v.dragN, units) * 10));
    put(Math.round(clamp(v.dragN / TACKLE.lineBreakN, 0, 1) * 400));
    put(dist(v.lineOutM));
    put(v.fishOn ? 1 : 0);
    put(Number.isFinite(v.fishDistanceM) ? dist(v.fishDistanceM) : -1);
    put(LURE_INDEX[v.lureId] ?? -1);
    put(Math.floor(v.hours * 60));
    put(v.slack ? Math.round(v.pulse * 6) : -1);
    if (changed) panel.invalidate();
  }

  return {
    panel,
    mount,
    setHand,
    set,
    get level() {
      return v.level;
    },
    dispose() {
      mount.removeFromParent();
      panel.dispose();
    },
  };
}
