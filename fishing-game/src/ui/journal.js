// Journal (angler's log) and record summaries. Pure functions that return HTML strings;
// only called when the journal opens or units change, never per frame.
import { SPECIES_IDS, LURES, formatWeight, formatLength, formatClock } from '../config.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function lureShort(id) {
  const l = LURES.find((x) => x.id === id);
  return l ? l.short : id ? String(id) : '–';
}
export function lureName(id) {
  const l = LURES.find((x) => x.id === id);
  return l ? l.name : id ? String(id) : '–';
}

// { total, totalKg, speciesCount, best, bySpecies: Map(id -> { count, maxKg, maxCm, record }) }
export function summarize(records) {
  const bySpecies = new Map();
  let total = 0;
  let totalKg = 0;
  let best = null;
  if (Array.isArray(records)) {
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      total++;
      const w = fin(r.weightKg);
      const l = fin(r.lengthCm);
      totalKg += w;
      if (!best || w > fin(best.weightKg)) best = r;
      const id = r.speciesId || 'unknown';
      let s = bySpecies.get(id);
      if (!s) {
        s = { count: 0, maxKg: 0, maxCm: 0, record: r };
        bySpecies.set(id, s);
      }
      s.count++;
      if (w > s.maxKg) s.maxKg = w;
      if (l > s.maxCm) s.maxCm = l;
    }
  }
  return { total, totalKg, speciesCount: bySpecies.size, best, bySpecies };
}

export function recentRecords(records, n = 8) {
  if (!Array.isArray(records)) return [];
  const list = records.filter((r) => r && typeof r === 'object');
  const t = (r) => {
    const v = Date.parse(r.caughtAt);
    return Number.isFinite(v) ? v : 0;
  };
  // Stable: newest first by timestamp, falling back to insertion order.
  return list
    .map((r, i) => ({ r, i, t: t(r) }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .slice(0, n)
    .map((x) => x.r);
}

export function renderTotals(sum, units, speciesTotal = SPECIES_IDS.length) {
  if (!sum.total) return `<span>No fish logged yet</span><span><b>0</b> of ${speciesTotal} species</span>`;
  const parts = [
    `<span><b>${sum.total}</b> fish logged</span>`,
    `<span><b>${Math.min(sum.speciesCount, speciesTotal)}</b> of ${speciesTotal} species</span>`,
    `<span><b>${esc(formatWeight(sum.totalKg, units))}</b> in all</span>`,
  ];
  return parts.join('');
}

// ---------- field tips for species not caught yet (derived from the species data, so they stay true) ----------
const TIP_TIMES = [
  ['dawn', 5.75],
  ['morning', 9],
  ['noon', 12.5],
  ['dusk', 19 + 40 / 60],
  ['night', 22.5],
];
const orList = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`);

// sp: a species definition (src/fish/species.js). Returns e.g.
// { lure: 'Spinner', when: 'dawn or dusk', where: 'deep open water, long casts' } or null.
export function fieldTip(sp) {
  if (!sp || typeof sp !== 'object') return null;
  // best baits: the top one plus any within 0.1 of it (at most two)
  let lure = '';
  if (sp.lures && typeof sp.lures === 'object') {
    const ranked = LURES.map((l) => [l, Number(sp.lures[l.id]) || 0]).sort((a, b) => b[1] - a[1]);
    if (ranked.length && ranked[0][1] > 0) {
      const top = ranked.filter(([, v], i) => i < 2 && v >= ranked[0][1] - 0.1).map(([l]) => l.short.toLowerCase());
      lure = orList(top);
    }
  }
  // best times: preset hours within 12 % of the peak activity
  let when = '';
  if (typeof sp.activity === 'function') {
    const act = TIP_TIMES.map(([label, h]) => {
      let v = 0;
      try {
        v = Number(sp.activity(h)) || 0;
      } catch {
        v = 0;
      }
      return [label, v];
    });
    const max = Math.max(...act.map((x) => x[1]));
    if (max > 0) when = orList(act.filter(([, v]) => v >= max * 0.88).map(([l]) => l).slice(0, 3));
  }
  // where: the cover it likes most; deep open-water fish need long casts past the float's reach
  let where = '';
  const hab = sp.habitat || {};
  const maxDepth = Array.isArray(sp.depthM) ? Number(sp.depthM[1]) || 0 : 0;
  const best = ['weeds', 'rocks', 'wood', 'open'].reduce((a, k) => ((Number(hab[k]) || 0) > (Number(hab[a]) || 0) ? k : a), 'weeds');
  if ((Number(hab.open) || 0) >= 0.9 && maxDepth >= 8) where = 'deep open water, long casts';
  else if (best === 'rocks') where = 'the rocky point to the right';
  else if (best === 'wood') where = 'the sunken timber';
  else if (best === 'weeds') where = 'weed edges and lily pads';
  else if (best === 'open') where = 'open water';
  if (!lure && !when && !where) return null;
  return { lure, when, where };
}

// info(id) -> { name, latin }; species: optional array of species definitions (for field tips)
export function renderJournalBody(records, units, info, species = null) {
  const sum = summarize(records);
  const ids = SPECIES_IDS.slice();
  for (const id of sum.bySpecies.keys()) if (!ids.includes(id)) ids.push(id);

  const byId = new Map(Array.isArray(species) ? species.filter((x) => x && x.id).map((x) => [x.id, x]) : []);
  let rows = '';
  for (const id of ids) {
    const s = sum.bySpecies.get(id);
    const inf = info(id, s && s.record);
    let tip = '';
    if (!s) {
      const def = byId.get(id);
      if (def && typeof def.tip === 'string' && def.tip.trim()) {
        tip = esc(def.tip.trim()); // the fish module's own field note
      } else {
        const t = fieldTip(def);
        if (t) {
          const parts = [t.lure && `<b>${esc(t.lure)}</b>`, t.when && esc(t.when), t.where && esc(t.where)].filter(Boolean);
          tip = parts.join(' · ');
        }
      }
    }
    const sp = `<th scope="row" class="j-sp"><span class="j-sp-name">${esc(inf.name)}</span><span class="j-sp-latin">${esc(inf.latin)}</span></th>`;
    if (s) {
      rows +=
        `<tr>${sp}<td class="num">${s.count}</td>` +
        `<td class="num">${esc(formatWeight(s.maxKg, units))}</td>` +
        `<td class="num c-len">${esc(formatLength(s.maxCm, units))}</td></tr>`;
    } else {
      rows += `<tr class="uncaught${tip ? ' has-tip' : ''}">${sp}<td class="j-none" colspan="3">Not yet caught</td></tr>`;
      // the field tip gets its own full-width line under the species
      if (tip) rows += `<tr class="j-tip-row"><td colspan="4"><span class="j-tip">${tip}</span></td></tr>`;
    }
  }
  const table =
    '<table class="j-table"><caption class="sr-only">Species caught</caption>' +
    '<thead><tr><th scope="col">Species</th><th scope="col" class="num">Caught</th>' +
    '<th scope="col" class="num">Heaviest</th><th scope="col" class="num c-len">Longest</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`;

  const recent = recentRecords(records, 8);
  let list;
  if (!recent.length) {
    list =
      '<p class="j-empty">No fish yet. At dawn, try a worm under the float along the weed edge to the left of the dock. ' +
      'Spinners and crankbaits need reeling; the topwater walks slowly on the surface at dawn and dusk. ' +
      'Every species you have not caught yet has a tip in the list.</p>';
  } else {
    list = '<ol class="recent-list">';
    for (const r of recent) {
      const inf = info(r.speciesId, r);
      const when = Number.isFinite(r.hours) ? formatClock(r.hours) : '–';
      list +=
        '<li class="r-row">' +
        `<span class="r-sp">${esc(r.speciesName || inf.name)}</span>` +
        `<span class="r-w">${esc(formatWeight(fin(r.weightKg), units))}</span>` +
        `<span class="r-meta">${esc(when)} · ${esc(lureShort(r.lureId))} · ${esc(formatLength(fin(r.lengthCm), units))}</span>` +
        `<span class="r-fate${r.kept ? ' kept' : ''}">${r.kept ? 'Kept' : 'Released'}</span>` +
        '</li>';
    }
    list += '</ol>';
  }
  return {
    totals: renderTotals(sum, units),
    body: `<section class="j-col" aria-label="Species">${table}</section><section class="j-col"><h3 class="j-section-h">Recent catches</h3>${list}</section>`,
  };
}
