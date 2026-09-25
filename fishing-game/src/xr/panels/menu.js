// VR menu (pause): the DOM pause menu's look (glass panel, stencil "Paused", uppercase labels, segmented
// buttons, the hi-vis primary button) with what a player needs inside the headset: Resume, the lure
// picker (the same painted lure icons), time presets, sound, units, rod hand, the journal and Exit VR.
// Everything is a big ray target (>= 5 cm tall at ~1 m).
import { LURES, formatClock } from '../../config.js';
import { LURE_ICONS } from '../../ui/icons.js';
import { TIME_PRESETS } from '../../ui/index.js';
import { createPanel } from './panel.js';
import { setFont, text, box, wrap } from './draw.js';

const W = 1024;
const H = 900;
const WIDTH_M = 0.74; // at ~1 m: ~1380 px / m is about one headset pixel per canvas pixel
const PAD = 48;
const LABEL_W = 176;

// The lure pictures as images (data: URLs are allowed by the page's CSP). Painted colors are literal.
const iconImages = {};
function lureIcon(id, onLoad) {
  if (iconImages[id]) return iconImages[id].complete && iconImages[id].naturalWidth ? iconImages[id] : null;
  const svg = LURE_ICONS[id];
  if (!svg || typeof Image !== 'function') return null;
  const src = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" ');
  const img = new Image();
  img.onload = () => onLoad && onLoad();
  img.onerror = () => {};
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
  iconImages[id] = img;
  return null;
}

export function createMenu(tk, act) {
  const c = tk.c;
  const F = tk.font;
  const v = { lureId: LURES[0].id, hours: 6, muted: false, units: 'imperial', rodHand: 'right', canPickLure: true };

  function draw(ctx, panel, now) {
    box(ctx, 2, 2, W - 4, H - 4, 22, { fill: c['glass-strong'], stroke: c.hair, lineWidth: 2 });
    const hov = (id) => panel.isHover(id);
    const down = (id) => panel.isPressed(id, now);

    // header
    setFont(ctx, 800, 104, F.display, { spacing: 0.04 });
    text(ctx, 'PAUSED', PAD, PAD + 84, { color: c.text });
    const clock = formatClock(((v.hours % 24) + 24) % 24);
    setFont(ctx, 500, 34, F.mono);
    text(ctx, clock, W - PAD, PAD + 50, { color: c.text, align: 'right' });
    setFont(ctx, 600, 20, F.ui, { spacing: 0.14 });
    text(ctx, 'LOON LAKE', W - PAD, PAD + 84, { color: c.muted, align: 'right' });

    const label = (s, y) => {
      setFont(ctx, 600, 22, F.ui, { spacing: 0.14 });
      text(ctx, s, PAD, y, { color: c.muted, baseline: 'middle' });
    };
    // a chip / segment: pressed state like the DOM's aria-pressed, hover like :hover
    const chip = (id, x, y, w, h, on, press, drawInner, disabled = false) => {
      const hv = hov(id) && !disabled;
      const fill = down(id) ? c['glass-press'] : on ? c['glass-press'] : hv ? c['glass-hi'] : null;
      box(ctx, x, y, w, h, 10, { fill, stroke: on ? c['hair-strong'] : hv ? c.hair : null, lineWidth: 2 });
      drawInner(on || hv, disabled);
      panel.addButton({ id, x, y, w, h, press, disabled });
    };

    let y = PAD + 124;
    // ---- lures (icons + names)
    label('LURE', y + 66);
    {
      const x0 = PAD + LABEL_W;
      const gap = 8;
      const w = (W - PAD - x0 - gap * (LURES.length - 1)) / LURES.length;
      const h = 132;
      LURES.forEach((l, i) => {
        const x = x0 + i * (w + gap);
        const on = l.id === v.lureId;
        chip(`lure:${l.id}`, x, y, w, h, on, () => act.lure(l.id), (lit) => {
          const img = lureIcon(l.id, () => panel.invalidate());
          if (img) {
            ctx.globalAlpha = lit ? 1 : 0.8;
            ctx.drawImage(img, x + (w - 128) / 2, y + 14, 128, 64);
            ctx.globalAlpha = 1;
          }
          setFont(ctx, 600, 24, F.ui, { spacing: 0.1 });
          text(ctx, l.short.toUpperCase(), x + w / 2, y + h - 22, { color: lit ? c.text : c.muted, align: 'center', maxWidth: w - 12 });
        });
      });
      y += h + 12;
      // what the tied-on lure is for (the DOM shows it as a toast / in the pause help)
      const l = LURES.find((x) => x.id === v.lureId);
      if (l && l.note) {
        setFont(ctx, 500, 22, F.ui);
        const lines = wrap(ctx, l.note, W - PAD - x0).slice(0, 2);
        lines.forEach((s, i) => text(ctx, s, x0, y + 22 + i * 28, { color: c.muted }));
      }
      y += 70;
    }

    // ---- time presets
    label('TIME', y + 38);
    {
      const x0 = PAD + LABEL_W;
      const gap = 6;
      const n = TIME_PRESETS.length;
      const w = (W - PAD - x0 - gap * (n - 1)) / n;
      const h = 76;
      let active = null;
      for (const p of TIME_PRESETS) {
        let d = Math.abs(v.hours - p.hours);
        d = Math.min(d, 24 - d);
        if (d <= 10 / 60) active = p.id;
      }
      TIME_PRESETS.forEach((p, i) => {
        const x = x0 + i * (w + gap);
        chip(`time:${p.id}`, x, y, w, h, p.id === active, () => act.time(p.hours), (lit) => {
          setFont(ctx, 600, 23, F.ui, { spacing: 0.1 });
          text(ctx, p.label.toUpperCase(), x + w / 2, y + h / 2 + 1, { color: lit ? c.text : c['text-soft'], align: 'center', baseline: 'middle', maxWidth: w - 10 });
        });
      });
      y += h + 22;
    }

    // ---- segmented settings (sound, units, rod hand): two per row
    const seg = (title, x, y0, w, opts) => {
      setFont(ctx, 600, 22, F.ui, { spacing: 0.14 });
      text(ctx, title, x, y0 + 38, { color: c.muted, baseline: 'middle' });
      const sx = x + 150;
      const sw = w - 150;
      const h = 76;
      box(ctx, sx, y0, sw, h, 12, { fill: c['fill-faint'], stroke: c.hair, lineWidth: 2 });
      const bw = (sw - 8 - 4 * (opts.length - 1)) / opts.length;
      opts.forEach(([id, lab, on, press], i) => {
        const bx = sx + 4 + i * (bw + 4);
        const hv = hov(id);
        const fill = down(id) || on ? c['glass-press'] : hv ? c['glass-hi'] : null;
        if (fill) box(ctx, bx, y0 + 4, bw, h - 8, 9, { fill });
        setFont(ctx, 600, 24, F.ui, { spacing: 0.06 });
        text(ctx, lab, bx + bw / 2, y0 + h / 2 + 1, { color: on || hv ? c.text : c.muted, align: 'center', baseline: 'middle', maxWidth: bw - 8 });
        panel.addButton({ id, x: bx, y: y0 + 4, w: bw, h: h - 8, press });
      });
    };
    const colW = (W - 2 * PAD - 36) / 2;
    seg('SOUND', PAD, y, colW, [
      ['sound:on', 'ON', !v.muted, () => act.mute(false)],
      ['sound:off', 'OFF', v.muted, () => act.mute(true)],
    ]);
    seg('UNITS', PAD + colW + 36, y, colW, [
      ['units:imperial', 'LB · IN', v.units !== 'metric', () => act.units('imperial')],
      ['units:metric', 'KG · CM', v.units === 'metric', () => act.units('metric')],
    ]);
    y += 76 + 18;
    seg('ROD HAND', PAD, y, colW, [
      ['hand:left', 'LEFT', v.rodHand === 'left', () => act.rodHand('left')],
      ['hand:right', 'RIGHT', v.rodHand === 'right', () => act.rodHand('right')],
    ]);
    y += 76 + 34;

    // ---- bottom row: Journal, Exit VR (secondary), Resume (primary)
    ctx.fillStyle = c.hair;
    ctx.fillRect(PAD, y - 14, W - 2 * PAD, 2);
    {
      const h = 92;
      const y0 = y + 10;
      const gap = 16;
      const wSec = 230;
      const secondary = (id, x, w, lab, press) => {
        const hv = hov(id);
        box(ctx, x, y0, w, h, 10, { fill: down(id) ? c['glass-press'] : hv ? c['glass-hi'] : c['fill-faint'], stroke: hv ? c.text : c['hair-strong'], lineWidth: 2 });
        setFont(ctx, 700, 26, F.ui, { spacing: 0.16 });
        text(ctx, lab, x + w / 2, y0 + h / 2 + 1, { color: c.text, align: 'center', baseline: 'middle', maxWidth: w - 16 });
        panel.addButton({ id, x, y: y0, w, h, press });
      };
      secondary('journal', PAD, wSec, 'JOURNAL', act.journal);
      secondary('exit', PAD + wSec + gap, wSec, 'EXIT VR', act.exit);
      const rx = PAD + 2 * (wSec + gap);
      const rw = W - PAD - rx;
      const hv = hov('resume');
      box(ctx, rx, y0, rw, h, 10, { fill: down('resume') ? c.line : hv ? c['line-hi'] : c.line, stroke: hv ? c.text : null, lineWidth: 3 });
      setFont(ctx, 700, 30, F.ui, { spacing: 0.16 });
      text(ctx, 'RESUME', rx + rw / 2, y0 + h / 2 + 1, { color: c['line-ink'], align: 'center', baseline: 'middle' });
      panel.addButton({ id: 'resume', x: rx, y: y0, w: rw, h, press: act.resume });
      y = y0 + h;
    }
    setFont(ctx, 500, 19, F.mono);
    const hint = 'Point a controller at a button and pull the trigger';
    text(ctx, hint, W / 2, y + 40, { color: c.muted, align: 'center', maxWidth: W - 2 * PAD });
    return Math.min(H, y + 66);
  }

  const panel = createPanel({ name: 'xr-menu', widthM: WIDTH_M, heightM: (WIDTH_M * H) / W, pxW: W, pxH: H, draw, interactive: true });
  // start the icon loads early so the first open already has them
  for (const l of LURES) lureIcon(l.id, () => panel.invalidate());

  return {
    panel,
    set(s) {
      let changed = false;
      for (const k of Object.keys(v)) {
        if (s[k] !== undefined && s[k] !== v[k]) {
          v[k] = s[k];
          changed = true;
        }
      }
      if (changed) panel.invalidate();
    },
    get values() {
      return v;
    },
    dispose() {
      panel.dispose();
    },
  };
}
