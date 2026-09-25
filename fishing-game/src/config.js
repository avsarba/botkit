// Shared constants, units and helpers for Loon Lake Angler.
// World units are meters, +Y is up, the calm water surface is y = 0.
// The player stands at the end of a wooden dock at the origin and faces -Z (yaw 0).

export const WATER_LEVEL = 0;

export const DOCK = {
  deckY: 0.55, // top of the deck boards above calm water
  width: 1.8, // x from -0.9 to +0.9
  endZ: -1.0, // lake-side end of the dock
  shoreZ: 24.0, // where the dock meets land
};

export const PLAYER = {
  position: [0, DOCK.deckY, 0], // feet
  eyeHeight: 1.65,
  yawLimitDeg: 100, // how far the player can turn left/right from -Z
  pitchMinDeg: -55,
  pitchMaxDeg: 25,
};

// A 7'0" medium-power spinning outfit spooled with 12 lb monofilament.
export const TACKLE = {
  rodLengthM: 2.13,
  lineTestLb: 12,
  lineBreakN: 53.4, // 12 lb
  dragMinN: 4.5, // ~1 lb
  dragMaxN: 44.5, // ~10 lb (a real reel caps drag below line test)
  dragDefault01: 0.45,
  reelRetrieveMps: 0.78, // 6.2:1 gear, ~31 in of line per handle turn at ~1.5 turns/s
  spoolCapacityM: 150, // ~165 yd of 12 lb mono
  maxCastM: 42,
};

// Terminal tackle the player can tie on (keys 1-4).
export const LURES = [
  {
    id: 'bobber',
    name: 'Nightcrawler & Float',
    short: 'Worm',
    kind: 'bait', // sits still under a float; fish nibble, then take the float down
    castMassG: 9,
    maxCastM: 26,
    depthM: 1.5, // bait hangs this far under the float
    note: 'Live worm under a red-and-white float. Everything eats it.',
  },
  {
    id: 'spinner',
    name: 'Inline Spinner #3',
    short: 'Spinner',
    kind: 'lure', // must be retrieved to work
    castMassG: 7,
    maxCastM: 38,
    depthM: 0.8,
    note: 'Flashing blade. A steady, unhurried retrieve for trout, perch and bass.',
  },
  {
    id: 'crankbait',
    name: 'Medium-Diving Crankbait',
    short: 'Crank',
    kind: 'lure',
    castMassG: 14,
    maxCastM: 42,
    depthM: 2.4,
    note: 'Dives to about 8 ft when reeled. Bass, walleye and pike.',
  },
  {
    id: 'topwater',
    name: 'Walking Topwater',
    short: 'Topwater',
    kind: 'lure',
    castMassG: 12,
    maxCastM: 40,
    depthM: 0,
    note: 'Walk it on a slow retrieve, with pauses. Explosive strikes at dawn and dusk.',
  },
];

// Game states (core owns transitions; everyone else may read frame.state).
export const STATES = Object.freeze({
  TITLE: 'title', // title overlay up, scene idles behind it
  READY: 'ready', // lure hanging at the rod tip
  CHARGING: 'charging', // holding the cast button, power building
  CASTING: 'casting', // lure in flight
  WAITING: 'waiting', // lure in the water (sitting under a float or being retrieved)
  STRIKE: 'strike', // a fish has taken it; the hookset window is open
  FIGHTING: 'fighting', // fish on
  LANDING: 'landing', // fish at the dock, being netted
  CAUGHT: 'caught', // showcase + catch card
  SNAPPED: 'snapped', // line broke; re-tying
  ESCAPED: 'escaped', // fish threw the hook / spat the bait
});

export const DAY = {
  startHours: 6.1, // dawn
  // 1 real second = 15 in-game seconds: an hour of light takes ~4 real minutes, dawn and dusk bites
  // last a good while and a 14 h day ~56 minutes. The clock stops while paused and on the catch card.
  gameMinutesPerSecond: 0.25,
  sunriseHours: 6.0,
  sunsetHours: 20.2,
};

export const G = 9.81;

// Render layers. Everything is on layer 0 as usual; objects that can be SEEN THROUGH THE WATER
// (terrain / lake bed, fish, lures, the float, submerged timber, dock pilings, rocks, reed stems)
// also enable LAYERS.UNDERWATER so the water's depth pre-pass can measure how much water lies
// in front of them. Objects that should not show up in the planar reflection enable NO_REFLECT.
// LAYERS.REFLECTION holds cheap stand-ins (e.g. a coarse terrain proxy) that ONLY the planar
// reflection camera renders; the full-detail originals carry NO_REFLECT.
export const LAYERS = Object.freeze({ UNDERWATER: 3, NO_REFLECT: 4, REFLECTION: 5 });

// Fixed species ids (fish-behavior owns the data, fish-mesh owns the looks).
export const SPECIES_IDS = Object.freeze([
  'bluegill',
  'yellow_perch',
  'rainbow_trout',
  'smallmouth_bass',
  'largemouth_bass',
  'walleye',
  'channel_catfish',
  'northern_pike',
  'muskellunge',
]);

// ---------- units ----------
export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;
export const M_PER_FT = 0.3048;

export function formatWeight(kg, units = 'imperial') {
  if (units === 'metric') return kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg.toFixed(2)} kg`;
  const totalOz = Math.round((kg / KG_PER_LB) * 16);
  const lb = Math.floor(totalOz / 16);
  const oz = totalOz % 16;
  return lb > 0 ? `${lb} lb ${oz} oz` : `${oz} oz`;
}

export function formatLength(cm, units = 'imperial') {
  if (units === 'metric') return `${cm.toFixed(1)} cm`;
  const inches = cm / CM_PER_IN;
  return `${inches.toFixed(1)} in`;
}

export function formatDistance(m, units = 'imperial') {
  if (units === 'metric') return `${m.toFixed(1)} m`;
  return `${Math.round(m / M_PER_FT)} ft`;
}

export function formatClock(hours) {
  const h = Math.floor(((hours % 24) + 24) % 24);
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ---------- small shared helpers ----------
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// Frame-rate independent exponential approach: damp(current, target, 8, dt)
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

// Deterministic PRNG (mulberry32). rng() -> [0, 1)
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tiny synchronous event bus shared by every module (created once by main.js).
export function createEmitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    off(type, fn) {
      map.get(type)?.delete(fn);
    },
    emit(type, payload = {}) {
      const set = map.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[events] handler for "${type}" threw`, err);
        }
      }
    },
  };
}
