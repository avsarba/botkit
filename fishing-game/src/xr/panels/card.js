// Catch card: the DOM field-notebook card (location / date / time header, species, latin name, New
// species / Personal best stamps, weight and length, lure, field note, Keep / Release) drawn for the
// headset. It floats beside the reel hand, which holds the fish (the showcase), and faces the player.
// Keep / Release: point a ray and pull a trigger, or the rod hand's A / B (X / Y when the rod is in
// the left hand), which the buttons show.
import { formatWeight, formatLength, formatClock } from '../../config.js';
import { lureName } from '../../ui/journal.js';
import { createPanel } from './panel.js';
import { setFont, text, box, paper, wrap, wrapBalanced, textWidth, hline, ellipsize } from './draw.js';

const W = 640; // 0.28 m wide: ~2.3 px per mm, about one headset pixel at ~0.7 m
const H = 1000;
const WIDTH_M = 0.28;
const PAD = 36;
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createCatchCard(tk, { speciesInfo, onKeep, onRelease }) {
  const c = tk.c;
  const F = tk.font;
  const v = { record: null, flags: { isPersonalBest: false, isNewSpecies: false }, units: 'imperial', rodHand: 'right', openedAt: 0 };

  function draw(ctx, panel, now) {
    const r = v.record;
    if (!r) return 200;
    const inf = speciesInfo(r.speciesId, r);
    const units = v.units;
    const inner = W - 2 * PAD;

    // measure the content first: the card is as tall as what it holds (the plane is cropped to it)
    setFont(ctx, 800, 76, F.display, { spacing: 0.02 });
    let nameSize = 76;
    let nameLines = wrapBalanced(ctx, inf.name.toUpperCase(), inner);
    while (nameLines.length > 2 && nameSize > 48) {
      nameSize -= 6;
      setFont(ctx, 800, nameSize, F.display, { spacing: 0.02 });
      nameLines = wrapBalanced(ctx, inf.name.toUpperCase(), inner);
    }
    setFont(ctx, 400, 25, F.ui);
    let blurbLines = inf.blurb ? wrap(ctx, inf.blurb, inner) : [];
    if (blurbLines.length > 8) {
      blurbLines = blurbLines.slice(0, 8);
      blurbLines[7] = ellipsize(ctx, `${blurbLines[7]} …`, inner);
    }
    const stamps = v.flags.isNewSpecies || v.flags.isPersonalBest;
    const headH = 70;
    const nameH = nameLines.length * nameSize * 0.92;
    const latinH = inf.latin ? 36 : 0;
    const stampsH = stamps ? 62 : 0;
    const measureH = 112;
    const lureH = 44;
    const blurbH = blurbLines.length ? blurbLines.length * 25 * 1.45 + 6 : 0;
    const actionsH = 124;
    const total = Math.min(H, PAD + headH + 22 + nameH + latinH + 10 + stampsH + 18 + measureH + 20 + lureH + 16 + blurbH + 10 + actionsH);

    paper(ctx, 0, 0, W, total, 8, c, 29);
    ctx.strokeStyle = c['paper-edge'];
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, total - 2);

    // notebook header: location, date, time
    let y = PAD;
    const date = (() => {
      const t = Date.parse(r.caughtAt);
      if (!Number.isFinite(t)) return '–';
      try {
        return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch {
        return String(r.caughtAt).slice(0, 10);
      }
    })();
    const time = Number.isFinite(r.hours) ? formatClock(r.hours) : '–';
    setFont(ctx, 500, 21, F.mono);
    const wDate = textWidth(ctx, date);
    const wTime = textWidth(ctx, time);
    const gap = 22;
    const colT = W - PAD - wTime;
    const colD = colT - gap - wDate;
    const cols = [
      ['LOCATION', 'Loon Lake, dock', PAD, colD - gap - PAD],
      ['DATE', date, colD, wDate],
      ['TIME', time, colT, wTime],
    ];
    for (const [label, val, x, w] of cols) {
      setFont(ctx, 600, 16, F.ui, { spacing: 0.16 });
      text(ctx, label, x, y + 16, { color: c['ink-soft'] });
      setFont(ctx, 500, 21, F.mono);
      text(ctx, ellipsize(ctx, val, Math.max(20, w)), x, y + 46, { color: c.ink });
      hline(ctx, x, x + Math.max(20, w), y + 56, c['ink-hair'], 2);
    }
    y += headH;
    hline(ctx, PAD, W - PAD, y, c.ink, 3);
    y += 22;

    // species name + latin
    setFont(ctx, 800, nameSize, F.display, { spacing: 0.02 });
    for (const l of nameLines) {
      y += nameSize * 0.92;
      text(ctx, l, PAD, y - nameSize * 0.12, { color: c.ink, maxWidth: inner });
    }
    if (inf.latin) {
      setFont(ctx, 400, 28, F.ui, { style: 'italic' });
      text(ctx, inf.latin, PAD, y + 30, { color: c['ink-soft'], maxWidth: inner });
      y += latinH;
    }
    y += 10;

    // stamps
    if (stamps) {
      let sx = PAD + 4;
      const list = [];
      if (v.flags.isNewSpecies) list.push(['NEW SPECIES', -3]);
      if (v.flags.isPersonalBest) list.push(['PERSONAL BEST', 2]);
      setFont(ctx, 800, 28, F.display, { spacing: 0.1 });
      for (const [label, rot] of list) {
        const w = textWidth(ctx, label) + 30;
        const h = 44;
        ctx.save();
        ctx.translate(sx + w / 2, y + 8 + h / 2);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.globalAlpha = 0.88;
        ctx.strokeStyle = c.red;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
        ctx.strokeRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10);
        text(ctx, label, 0, 11, { color: c.red, align: 'center' });
        ctx.restore();
        sx += w + 22;
      }
      y += stampsH;
    }
    y += 18;

    // weight and length
    hline(ctx, PAD, W - PAD, y, c['ink-hair'], 2);
    const colW = inner * (1.3 / 2.3);
    setFont(ctx, 600, 16, F.ui, { spacing: 0.16 });
    text(ctx, 'WEIGHT', PAD, y + 34, { color: c['ink-soft'] });
    text(ctx, 'LENGTH', PAD + colW + 22, y + 34, { color: c['ink-soft'] });
    setFont(ctx, 600, 46, F.mono, { spacing: -0.04 });
    text(ctx, formatWeight(fin(r.weightKg), units), PAD, y + 86, { color: c.ink, maxWidth: colW - 8 });
    text(ctx, formatLength(fin(r.lengthCm), units), PAD + colW + 22, y + 86, { color: c.ink, maxWidth: inner - colW - 22 });
    y += measureH;
    hline(ctx, PAD, W - PAD, y, c['ink-hair'], 2);
    y += 20;

    // lure
    setFont(ctx, 600, 16, F.ui, { spacing: 0.16 });
    text(ctx, 'LURE', PAD, y + 26, { color: c['ink-soft'] });
    setFont(ctx, 500, 25, F.ui);
    text(ctx, lureName(r.lureId), PAD + 82, y + 27, { color: c.ink, maxWidth: inner - 82 });
    y += lureH + 16;

    // field note
    if (blurbLines.length) {
      setFont(ctx, 400, 25, F.ui);
      for (const l of blurbLines) {
        y += 25 * 1.45;
        text(ctx, l, PAD, y - 8, { color: c.ink });
      }
      y += 6;
    }
    y += 10;

    // actions: Keep (outline) / Release (filled), 1 : 1.4 like the DOM
    const ay = total - actionsH;
    hline(ctx, 0, W, ay, c['ink-hair'], 2);
    const bh = 78;
    const by = ay + 22;
    const kw = (inner - 16) * (1 / 2.4);
    const rw = inner - 16 - kw;
    const keys = v.rodHand === 'left' ? ['X', 'Y'] : ['A', 'B'];
    const btn = (id, x, w, label, key, filled, press) => {
      const hov = panel.isHover(id);
      const down = panel.isPressed(id, now);
      const fill = filled ? (hov || down ? c['ink-deep'] : c.ink) : down ? 'rgba(51, 55, 47, 0.16)' : hov ? c['ink-wash'] : null;
      box(ctx, x, by, w, bh, 8, { fill, stroke: c.ink, lineWidth: hov ? 4 : 2.5 });
      const fg = filled ? c.paper : c.ink;
      setFont(ctx, 700, 25, F.ui, { spacing: 0.16 });
      const lw = textWidth(ctx, label);
      setFont(ctx, 600, 19, F.mono);
      const kw2 = textWidth(ctx, key) + 16;
      const total2 = lw + 14 + kw2;
      const lx = x + (w - total2) / 2;
      setFont(ctx, 700, 25, F.ui, { spacing: 0.16 });
      text(ctx, label, lx, by + bh / 2 + 1, { color: fg, baseline: 'middle' });
      // controller button hint, drawn like the DOM's <kbd>
      const kx = lx + lw + 14;
      box(ctx, kx, by + bh / 2 - 16, kw2, 32, 6, { stroke: filled ? 'rgba(238, 227, 176, 0.55)' : c['ink-hair'], lineWidth: 2 });
      setFont(ctx, 600, 19, F.mono);
      text(ctx, key, kx + kw2 / 2, by + bh / 2 + 1, { color: fg, align: 'center', baseline: 'middle' });
      panel.addButton({ id, x, y: by, w, h: bh, press });
    };
    btn('keep', PAD, kw, 'KEEP', keys[0], false, onKeep);
    btn('release', PAD + kw + 16, rw, 'RELEASE', keys[1], true, onRelease);
    return total;
  }

  const panel = createPanel({ name: 'xr-card', widthM: WIDTH_M, heightM: (WIDTH_M * H) / W, pxW: W, pxH: H, draw, interactive: true });

  return {
    panel,
    show(record, flags, units, rodHand, now) {
      v.record = record;
      v.flags = { isPersonalBest: !!(flags && flags.isPersonalBest), isNewSpecies: !!(flags && flags.isNewSpecies) };
      v.units = units;
      v.rodHand = rodHand;
      v.openedAt = now;
      panel.invalidate();
    },
    set(units, rodHand) {
      if (units !== v.units || rodHand !== v.rodHand) {
        v.units = units;
        v.rodHand = rodHand;
        panel.invalidate();
      }
    },
    get record() {
      return v.record;
    },
    clear() {
      v.record = null;
    },
    dispose() {
      panel.dispose();
    },
  };
}
