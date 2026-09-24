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

// info(id) -> { name, latin }
export function renderJournalBody(records, units, info) {
  const sum = summarize(records);
  const ids = SPECIES_IDS.slice();
  for (const id of sum.bySpecies.keys()) if (!ids.includes(id)) ids.push(id);

  let rows = '';
  for (const id of ids) {
    const s = sum.bySpecies.get(id);
    const inf = info(id, s && s.record);
    const sp = `<th scope="row" class="j-sp"><span class="j-sp-name">${esc(inf.name)}</span><span class="j-sp-latin">${esc(inf.latin)}</span></th>`;
    if (s) {
      rows +=
        `<tr>${sp}<td class="num">${s.count}</td>` +
        `<td class="num">${esc(formatWeight(s.maxKg, units))}</td>` +
        `<td class="num c-len">${esc(formatLength(s.maxCm, units))}</td></tr>`;
    } else {
      rows += `<tr class="uncaught">${sp}<td class="j-none" colspan="3">Not yet caught</td></tr>`;
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
    list = '<p class="j-empty">No fish yet. At dawn, try a worm under the float along the weed edge to the left of the dock.</p>';
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
