// Catch records and settings persisted in localStorage (every access guarded: the game must keep
// working when storage is blocked, full or throws).
const KEY = 'loonlake.v1';
const MAX_RECORDS = 500;

export function loadSave() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function writeSave(data) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);

export function sanitizeRecords(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || typeof r.speciesId !== 'string' || !fin(r.weightKg) || !fin(r.lengthCm)) continue;
    out.push({
      id: String(r.id || `${r.speciesId}-${out.length}`),
      speciesId: r.speciesId,
      speciesName: String(r.speciesName || r.speciesId),
      latin: String(r.latin || ''),
      weightKg: r.weightKg,
      lengthCm: r.lengthCm,
      lureId: String(r.lureId || 'bobber'),
      hours: fin(r.hours) ? r.hours : 0,
      caughtAt: String(r.caughtAt || ''),
      kept: !!r.kept,
    });
  }
  return out.slice(-MAX_RECORDS);
}

let seq = 0;
export function makeRecord({ species, weightKg, lengthCm, lureId, hours }) {
  seq = (seq + 1) % 1e6;
  return {
    id: `${Date.now().toString(36)}-${seq.toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`,
    speciesId: species.id,
    speciesName: species.name,
    latin: species.latin || '',
    weightKg: Math.round(weightKg * 1000) / 1000,
    lengthCm: Math.round(lengthCm * 10) / 10,
    lureId,
    hours: Math.round(hours * 1000) / 1000,
    caughtAt: new Date().toISOString(),
    kept: false,
  };
}

// Flags for the catch card, computed against the log BEFORE the new record is added.
export function catchFlags(records, record) {
  let prev = 0;
  let best = 0;
  for (const r of records) {
    if (r.speciesId !== record.speciesId || r.id === record.id) continue;
    prev++;
    if (r.weightKg > best) best = r.weightKg;
  }
  return { isNewSpecies: prev === 0, isPersonalBest: prev > 0 && record.weightKg > best };
}

export { MAX_RECORDS };
