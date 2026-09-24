// Tension dial: an instrument arc reading 0 -> line test (TACKLE.lineBreakN), with a red zone
// near the break, the drag setting as a brass marker (where the spool starts to slip) and a
// hi-vis fill that turns amber, then red. Pure SVG; only touches the DOM when a value changes.
import { TACKLE, G, KG_PER_LB, clamp } from '../config.js';

const NS = 'http://www.w3.org/2000/svg';
const CX = 120;
const CY = 112; // matches .dial aspect 240/164 and the 68.3% center in the template CSS
const R = 86;
const A0 = 210; // degrees, t = 0 (lower left)
const SWEEP = 240; // degrees clockwise to t = 1 (lower right)
export const RED_FROM = 0.88;
const AMBER_UP = 0.7;
const AMBER_DOWN = 0.66;
const RED_DOWN = 0.85;

const rad = (t) => ((A0 - SWEEP * t) * Math.PI) / 180;
const px = (t, r) => +(CX + r * Math.cos(rad(t))).toFixed(2);
const py = (t, r) => +(CY - r * Math.sin(rad(t))).toFixed(2);
function arc(t0, t1, r) {
  const large = (t1 - t0) * SWEEP > 180 ? 1 : 0;
  return `M${px(t0, r)} ${py(t0, r)}A${r} ${r} 0 ${large} 1 ${px(t1, r)} ${py(t1, r)}`;
}
function node(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

// Line test in display units.
export function lineTestIn(units) {
  return units === 'metric' ? TACKLE.lineBreakN / G : TACKLE.lineBreakN / (G * KG_PER_LB);
}

export function createGauge(svg, dial) {
  svg.textContent = '';
  node('path', { class: 'g-track', d: arc(0, 1, R) }, svg);
  node('path', { class: 'g-redzone', d: arc(RED_FROM, 1, R) }, svg);
  const fill = node('path', { class: 'g-fill', d: arc(0, 1, R), pathLength: '1000', 'stroke-dasharray': '0 1000' }, svg);
  const ticks = node('g', {}, svg);

  // Brass drag marker, drawn at t = 0 and rotated into place.
  const drag = node('g', { class: 'g-drag' }, svg);
  node('line', { x1: px(0, R - 6), y1: py(0, R - 6), x2: px(0, R + 6), y2: py(0, R + 6) }, drag);
  {
    const a = rad(0);
    const ux = Math.cos(a);
    const uy = -Math.sin(a);
    const tipX = CX + ux * (R + 6);
    const tipY = CY + uy * (R + 6);
    const bx = CX + ux * (R + 15);
    const by = CY + uy * (R + 15);
    const w = 4.6;
    const d = `M${tipX.toFixed(2)} ${tipY.toFixed(2)}L${(bx - uy * w).toFixed(2)} ${(by + ux * w).toFixed(2)}L${(bx + uy * w).toFixed(2)} ${(by - ux * w).toFixed(2)}Z`;
    node('path', { d }, drag);
  }
  // Current-value index bar across the track.
  const index = node('line', { class: 'g-index', x1: px(0, R - 11), y1: py(0, R - 11), x2: px(0, R + 5), y2: py(0, R + 5) }, svg);

  let unitsBuilt = null;
  let lastQ = -1;
  let lastDragQ = -1;
  let level = 0;

  function buildTicks(units) {
    if (units === unitsBuilt) return;
    unitsBuilt = units;
    ticks.textContent = '';
    const maxV = lineTestIn(units);
    const minor = units === 'metric' ? 0.5 : 1;
    const major = units === 'metric' ? 1 : 2;
    const n = Math.floor(maxV / minor + 1e-6);
    for (let i = 0; i <= n; i++) {
      const v = i * minor;
      const t = v / maxV;
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      const red = t >= RED_FROM - 1e-6;
      const r2 = isMajor ? R - 16 : R - 12;
      node('line', { class: `g-tick${isMajor ? ' major' : ''}${red ? ' red' : ''}`, x1: px(t, R - 7), y1: py(t, R - 7), x2: px(t, r2), y2: py(t, r2) }, ticks);
      if (isMajor) {
        const tx = node('text', { class: `g-num${red ? ' red' : ''}`, x: px(t, R - 27), y: py(t, R - 27), 'text-anchor': 'middle', 'dominant-baseline': 'central' }, ticks);
        tx.textContent = String(Math.round(v));
      }
    }
  }

  // tension01 = tensionN / lineBreakN; dragFrac = dragN / lineBreakN. Returns the color level 0/1/2.
  function set(tension01, dragFrac) {
    const t = clamp(Number.isFinite(tension01) ? tension01 : 0, 0, 1);
    const q = Math.round(t * 1000);
    if (q !== lastQ) {
      lastQ = q;
      fill.setAttribute('stroke-dasharray', `${q} 1000`);
      index.setAttribute('transform', `rotate(${((SWEEP * q) / 1000).toFixed(2)} ${CX} ${CY})`);
    }
    const prev = level;
    if (level === 2 && t < RED_DOWN) level = 1;
    if (level === 1 && t < AMBER_DOWN) level = 0;
    if (level === 0 && t >= AMBER_UP) level = 1;
    if (level === 1 && t >= RED_FROM) level = 2;
    if (level !== prev && dial) dial.dataset.level = String(level);

    const d = clamp(Number.isFinite(dragFrac) ? dragFrac : 0, 0, 1);
    const dq = Math.round(d * 1000);
    if (dq !== lastDragQ) {
      lastDragQ = dq;
      drag.setAttribute('transform', `rotate(${((SWEEP * dq) / 1000).toFixed(2)} ${CX} ${CY})`);
    }
    return level;
  }

  return {
    set,
    setUnits: buildTicks,
    get level() {
      return level;
    },
  };
}
