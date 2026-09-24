// Expanding ripple rings (packed into uniform arrays for the water shader) and
// wake emitters that drop small rings along a moving object's path. Rings
// expand slower than a retrieved lure moves, so a V-shaped (Kelvin-like) wake
// appears on its own.
import { clamp } from '../config.js';

export const MAX_RINGS = 32;
const TWO_PI = Math.PI * 2;

export function createRipples() {
  const rings = [];
  for (let i = 0; i < MAX_RINGS; i++) {
    rings.push({ on: false, x: 0, z: 0, t0: 0, amp: 0, speed: 0.3, maxR: 1, k: 50, foam: 0, life: 1, wake: false, crater: false });
  }
  const uA = new Float32Array(MAX_RINGS * 4); // x, z, age, amp (m)
  const uB = new Float32Array(MAX_RINGS * 4); // speed m/s, maxR m, k rad/m, foam (>= 0 impact, -1-foam no crater)
  let count = 0;
  let limit = MAX_RINGS;
  let now = 0;

  function importance(r) {
    const age = now - r.t0;
    const left = 1 - clamp(age / r.life, 0, 1);
    return (r.amp * 100 + r.foam) * left * (r.wake ? 0.4 : 1);
  }

  // amp: crest height in meters; lambda: crest spacing in meters; speed: m/s of the ring front;
  // crater: an impact (splash crater and rebound at the centre), not a wake or a plip
  function add(x, z, amp, lambda, speed, maxR, foam = 0, delay = 0, wake = false, crater = false) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(amp > 0)) return;
    let slot = null;
    let worst = Infinity;
    for (let i = 0; i < limit; i++) {
      const r = rings[i];
      if (!r.on) {
        slot = r;
        break;
      }
      const imp = importance(r);
      if (imp < worst) {
        worst = imp;
        slot = r;
      }
    }
    if (!slot) return;
    // A weak wake ring never evicts a stronger splash ring.
    if (slot.on && wake && !slot.wake && worst > amp * 100 * 0.4) return;
    slot.on = true;
    slot.x = x;
    slot.z = z;
    slot.t0 = now + Math.max(0, delay);
    slot.amp = amp;
    slot.speed = Math.max(0.05, speed);
    slot.maxR = Math.max(0.1, maxR);
    slot.k = TWO_PI / Math.max(0.02, lambda);
    slot.foam = clamp(foam, 0, 1);
    slot.crater = crater;
    slot.life = slot.maxR / slot.speed;
    slot.wake = wake;
  }

  function setLimit(n) {
    limit = clamp(Math.round(n), 4, MAX_RINGS);
    for (let i = limit; i < MAX_RINGS; i++) rings[i].on = false;
  }

  function update(time) {
    now = time;
    count = 0;
    for (let i = 0; i < limit; i++) {
      const r = rings[i];
      if (!r.on) continue;
      const age = time - r.t0;
      if (age > r.life + 0.05 || age < -5) {
        r.on = false;
        continue;
      }
      if (age < 0) continue; // delayed secondary ring not born yet
      const o = count * 4;
      uA[o] = r.x;
      uA[o + 1] = r.z;
      uA[o + 2] = age;
      uA[o + 3] = r.amp;
      uB[o] = r.speed;
      uB[o + 1] = r.maxR;
      uB[o + 2] = r.k;
      uB[o + 3] = r.crater ? r.foam : -1 - r.foam; // sign flags "no crater"
      count++;
    }
    for (let i = count; i < MAX_RINGS; i++) {
      const o = i * 4;
      uA[o] = uA[o + 1] = uA[o + 2] = uA[o + 3] = 0;
      uB[o] = 1;
      uB[o + 1] = 1;
      uB[o + 2] = 1;
      uB[o + 3] = -1;
    }
  }

  // ---- wakes ---------------------------------------------------------------
  // Callers do not identify themselves, so emitters are matched by proximity.
  const emitters = [];
  for (let i = 0; i < 6; i++) emitters.push({ on: false, x: 0, z: 0, t: 0, acc: 0 });

  function wake(x, z, dirX, dirZ, speed, dt) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(speed) || speed < 0.04) return;
    let e = null;
    let best = 1.5 * 1.5;
    let free = null;
    let oldest = null;
    for (let i = 0; i < emitters.length; i++) {
      const em = emitters[i];
      if (em.on && now - em.t > 0.5) em.on = false;
      if (!em.on) {
        if (!free) free = em;
        continue;
      }
      const d2 = (em.x - x) ** 2 + (em.z - z) ** 2;
      if (d2 < best) {
        best = d2;
        e = em;
      }
      if (!oldest || em.t < oldest.t) oldest = em;
    }
    if (!e) {
      e = free || oldest;
      e.on = true;
      e.acc = 0.6; // first ring comes quickly
    }
    e.x = x;
    e.z = z;
    e.t = now;
    const sp = Math.min(speed, 4);
    e.acc += sp * Math.min(dt, 0.1);
    const spacing = clamp(0.22 + sp * 0.3, 0.22, 0.9);
    const dl = Math.hypot(dirX || 0, dirZ || 0);
    const ux = dl > 1e-6 ? dirX / dl : 0;
    const uz = dl > 1e-6 ? dirZ / dl : 0;
    let guard = 0;
    while (e.acc >= spacing && guard++ < 3) {
      e.acc -= spacing;
      // Kelvin-like: transverse wavelength ~ 2 pi v^2 / g, rings spread at ~v/3
      // (group velocity), which gives the ~20 degree V behind the object.
      const amp = clamp(0.003 + sp * 0.009, 0.003, 0.016);
      const lambda = clamp(0.8 * 2 * Math.PI * sp * sp / 9.81, 0.05, 0.6);
      const ringSpeed = Math.max(0.1, sp * 0.36);
      // emitted slightly ahead: the bow pushes the first crest
      add(x + ux * 0.03, z + uz * 0.03, amp, lambda, ringSpeed, clamp(0.7 + sp * 1.2, 0.6, 2.6), 0, 0, true);
    }
    if (e.acc > spacing * 3) e.acc = 0;
  }

  return {
    uA,
    uB,
    add,
    wake,
    update,
    setLimit,
    get count() {
      return count;
    },
  };
}
