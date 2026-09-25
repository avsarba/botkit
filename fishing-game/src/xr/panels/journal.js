// Journal (angler's log) for the headset: the DOM journal's paper page with every species (caught count,
// heaviest, longest; a field tip for the ones not caught yet) and the recent catches. Built from the same
// record summaries as the DOM (src/ui/journal.js) so both always agree.
import { SPECIES_IDS, formatWeight, formatLength, formatClock } from '../../config.js';
import { summarize, recentRecords, fieldTip, lureShort } from '../../ui/journal.js';
import { createPanel } from './panel.js';
import { setFont, text, box, paper, wrap, textWidth, hline, ellipsize } from './draw.js';

const W = 1280;
const H = 980;
const WIDTH_M = 0.94;
const PAD = 44;
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createJournal(tk, { speciesInfo, species, onClose }) {
  const c = tk.c;
  const F = tk.font;
  const v = { records: [], units: 'imperial' };
  const byId = new Map(Array.isArray(species) ? species.filter((x) => x && x.id).map((x) => [x.id, x]) : []);

  function tipFor(id) {
    const def = byId.get(id);
    if (def && typeof def.tip === 'string' && def.tip.trim()) return { lure: '', rest: def.tip.trim() };
    const t = fieldTip(def);
    if (!t) return null;
    return { lure: t.lure || '', rest: [t.when, t.where].filter(Boolean).join(' · ') };
  }

  function draw(ctx, panel, now) {
    const units = v.units;
    const sum = summarize(v.records);
    const ids = SPECIES_IDS.slice();
    for (const id of sum.bySpecies.keys()) if (!ids.includes(id)) ids.push(id);

    // ---- measure: species rows (+ a tip line when not caught), recent list
    const colL = PAD;
    const colLW = 720;
    const colR = PAD + colLW + 44;
    const colRW = W - PAD - colR;
    const rows = ids.map((id) => {
      const s = sum.bySpecies.get(id);
      const tip = s ? null : tipFor(id);
      return { id, s, tip, h: 50 + (tip ? 30 : 0) };
    });
    const headH = 128;
    const tableTop = headH + 20;
    const tableH = 44 + rows.reduce((a, r) => a + r.h, 0);
    const recent = recentRecords(v.records, 8);
    const recentH = 44 + (recent.length ? recent.length * 70 : 150);
    const total = Math.min(H, tableTop + Math.max(tableH, recentH) + PAD);

    paper(ctx, 0, 0, W, total, 8, c, 30);
    ctx.strokeStyle = c['paper-edge'];
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, total - 2);

    // ---- header: title, totals, close
    setFont(ctx, 800, 62, F.display, { spacing: 0.02 });
    text(ctx, 'ANGLER’S LOG', PAD, PAD + 50, { color: c.ink });
    setFont(ctx, 500, 21, F.mono);
    let tx = PAD;
    const tot = sum.total
      ? [
          [String(sum.total), ' fish logged'],
          [String(Math.min(sum.speciesCount, SPECIES_IDS.length)), ` of ${SPECIES_IDS.length} species`],
          [formatWeight(sum.totalKg, units), ' in all'],
        ]
      : [
          ['', 'No fish logged yet'],
          ['0', ` of ${SPECIES_IDS.length} species`],
        ];
    for (const [b, rest] of tot) {
      setFont(ctx, 600, 21, F.mono);
      if (b) tx += text(ctx, b, tx, PAD + 90, { color: c.ink });
      setFont(ctx, 500, 21, F.mono);
      tx += text(ctx, rest, tx, PAD + 90, { color: c['ink-soft'] }) + 28;
    }
    {
      const id = 'close';
      const bw = 170;
      const bh = 68;
      const bx = W - PAD - bw;
      const by = PAD + 4;
      const hv = panel.isHover(id);
      const dn = panel.isPressed(id, now);
      box(ctx, bx, by, bw, bh, 8, { fill: dn ? 'rgba(51, 55, 47, 0.16)' : hv ? c['ink-wash'] : null, stroke: c.ink, lineWidth: hv ? 4 : 2.5 });
      setFont(ctx, 700, 24, F.ui, { spacing: 0.16 });
      text(ctx, 'CLOSE', bx + bw / 2, by + bh / 2 + 1, { color: c.ink, align: 'center', baseline: 'middle' });
      panel.addButton({ id, x: bx, y: by, w: bw, h: bh, press: onClose });
    }
    hline(ctx, PAD, W - PAD, headH, c.ink, 3);

    // ---- species table
    let y = tableTop;
    const cNum = [colL + colLW - 330, colL + colLW - 170, colL + colLW]; // right edges: caught, heaviest, longest
    setFont(ctx, 600, 15, F.ui, { spacing: 0.16 });
    text(ctx, 'SPECIES', colL, y + 22, { color: c['ink-soft'] });
    text(ctx, 'CAUGHT', cNum[0], y + 22, { color: c['ink-soft'], align: 'right' });
    text(ctx, 'HEAVIEST', cNum[1], y + 22, { color: c['ink-soft'], align: 'right' });
    text(ctx, 'LONGEST', cNum[2], y + 22, { color: c['ink-soft'], align: 'right' });
    y += 36;
    hline(ctx, colL, colL + colLW, y, c['ink-hair'], 3);
    y += 8;
    for (const r of rows) {
      const inf = speciesInfo(r.id, r.s && r.s.record);
      const base = y + 34;
      setFont(ctx, r.s ? 700 : 600, 25, F.ui);
      const nw = text(ctx, inf.name, colL, base, { color: r.s ? c.ink : c['ink-soft'] });
      if (inf.latin) {
        setFont(ctx, 400, 18, F.ui, { style: 'italic' });
        const room = (r.s ? cNum[0] - 70 : colL + colLW - 190) - (colL + nw + 12);
        if (room > 60) text(ctx, ellipsize(ctx, inf.latin, room), colL + nw + 12, base, { color: c['ink-soft'] });
      }
      if (r.s) {
        setFont(ctx, 500, 22, F.mono);
        text(ctx, String(r.s.count), cNum[0], base, { color: c.ink, align: 'right' });
        text(ctx, formatWeight(r.s.maxKg, units), cNum[1], base, { color: c.ink, align: 'right' });
        text(ctx, formatLength(r.s.maxCm, units), cNum[2], base, { color: c.ink, align: 'right' });
      } else {
        setFont(ctx, 400, 21, F.ui, { style: 'italic' });
        text(ctx, 'Not yet caught', cNum[2], base, { color: c['ink-soft'], align: 'right' });
      }
      if (r.tip) {
        const ty = base + 30;
        let x = colL;
        if (r.tip.lure) {
          setFont(ctx, 600, 19, F.ui);
          x += text(ctx, r.tip.lure, x, ty, { color: c.ink });
          if (r.tip.rest) {
            setFont(ctx, 500, 19, F.ui);
            x += text(ctx, ' · ', x, ty, { color: c.ink });
          }
        }
        if (r.tip.rest) {
          setFont(ctx, 500, 19, F.ui);
          text(ctx, ellipsize(ctx, r.tip.rest, colL + colLW - x), x, ty, { color: c.ink });
        }
      }
      y += r.h;
      hline(ctx, colL, colL + colLW, y, c['ink-hair'], 2);
    }

    // ---- recent catches
    y = tableTop;
    setFont(ctx, 700, 17, F.ui, { spacing: 0.16 });
    text(ctx, 'RECENT CATCHES', colR, y + 22, { color: c['ink-soft'] });
    y += 36;
    hline(ctx, colR, colR + colRW, y, c['ink-hair'], 3);
    y += 8;
    if (!recent.length) {
      setFont(ctx, 400, 21, F.ui, { style: 'italic' });
      const lines = wrap(ctx, 'No fish yet. At dawn, try a worm under the float along the weed edge to the left of the dock. Spinners and crankbaits need reeling; the topwater walks slowly on the surface at dawn and dusk.', colRW);
      lines.slice(0, 6).forEach((l, i) => text(ctx, l, colR, y + 30 + i * 29, { color: c['ink-soft'] }));
    }
    for (const r of recent) {
      const inf = speciesInfo(r.speciesId, r);
      setFont(ctx, 500, 22, F.mono);
      const wStr = formatWeight(fin(r.weightKg), units);
      const ww = textWidth(ctx, wStr);
      text(ctx, wStr, colR + colRW, y + 30, { color: c.ink, align: 'right' });
      setFont(ctx, 700, 23, F.ui);
      text(ctx, ellipsize(ctx, r.speciesName || inf.name, colRW - ww - 16), colR, y + 30, { color: c.ink });
      const when = Number.isFinite(r.hours) ? formatClock(r.hours) : '–';
      setFont(ctx, 600, 15, F.ui, { spacing: 0.14 });
      const fate = r.kept ? 'KEPT' : 'RELEASED';
      const fw = textWidth(ctx, fate);
      text(ctx, fate, colR + colRW, y + 58, { color: r.kept ? c.ink : c['ink-soft'], align: 'right' });
      setFont(ctx, 500, 17, F.mono);
      text(ctx, ellipsize(ctx, `${when} · ${lureShort(r.lureId)} · ${formatLength(fin(r.lengthCm), units)}`, colRW - fw - 16), colR, y + 58, { color: c['ink-soft'] });
      y += 70;
      hline(ctx, colR, colR + colRW, y, c['ink-hair'], 2);
    }
    return total;
  }

  const panel = createPanel({ name: 'xr-journal', widthM: WIDTH_M, heightM: (WIDTH_M * H) / W, pxW: W, pxH: H, draw, interactive: true });

  return {
    panel,
    set(records, units) {
      if (Array.isArray(records) && records !== v.records) {
        v.records = records;
        panel.invalidate();
      }
      if (units && units !== v.units) {
        v.units = units;
        panel.invalidate();
      }
    },
    dispose() {
      panel.dispose();
    },
  };
}
