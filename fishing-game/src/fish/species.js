// Species data for Loon Lake Angler (fish-behavior module).
// Real northern-lake (Minnesota / Ontario) freshwater species with field-guide facts,
// length-weight relationships and the numbers that drive the AI and the fight.
//
// Length-weight: W(g) = a * L(cm)^b, total length in cm (FishBase / standard-weight style).
// Coefficients come from the North American standard-weight (Ws) equations converted to cm
// (a = 10^(A + b)), nudged for a few species toward the well-fed fish of a productive
// northern lake: a 2 kg largemouth is ~47 cm (18.5 in), a 5 kg pike ~85 cm, a 0.25 kg bluegill ~22 cm.
//
// Fight personality (0..1): strength (burst force per kg), stamina (how long it keeps fighting),
// jumpiness (how often it clears the water), headshake (violent head shakes, pike/musky).
// depthM: comfortable depth band. habitat: cover preference (weeds / rocks / wood / open water).
// lures: 0..1 how readily it takes each lure in LURES (config.js).
// activity(hours): 0..1 feeding activity by time of day.
// hookWindowS: how long it holds the bait/lure before spitting it. rarity: 0 common .. 1 very rare.
import { clamp, smoothstep, makeRng } from '../config.js';

// ---------- time-of-day curve helpers ----------
// Circular Gaussian bump in hours (wraps at midnight).
function bump(h, center, width) {
  let d = Math.abs(h - center) % 24;
  if (d > 12) d = 24 - d;
  const x = d / width;
  return Math.exp(-0.5 * x * x);
}
// 1 in full daylight, 0 at night, smooth through dawn / dusk (sunrise ~6:00, sunset ~20:12).
function daylight(h) {
  h = ((h % 24) + 24) % 24;
  return smoothstep(5.1, 6.7, h) * (1 - smoothstep(20.0, 21.4, h));
}
// Sight feeders (pike, musky) start at first light, a little before sunrise.
function earlyDay(h) {
  h = ((h % 24) + 24) % 24;
  return smoothstep(4.8, 6.2, h) * (1 - smoothstep(20.6, 21.8, h));
}
// 1 in full night, 0 in daylight.
function nightness(h) {
  return 1 - daylight(h);
}

export const ACTIVITY_HELPERS = { bump, daylight, nightness };

// Light level for sight-feeding and lure visibility (0 night .. 1 bright day), independent of species.
export function lightLevel(hours) {
  const h = ((hours % 24) + 24) % 24;
  const day = daylight(h);
  // Low sun at dawn / dusk is dimmer than midday.
  const sunHigh = smoothstep(6.0, 9.0, h) * (1 - smoothstep(17.5, 20.3, h));
  return clamp(0.06 + 0.5 * day + 0.44 * sunHigh, 0, 1);
}

// How "low light" it is: peaks at dawn and dusk, stays fairly high at night (topwater, walleye).
export function lowLightLevel(hours) {
  return Math.max(bump(hours, 6.1, 1.25), bump(hours, 20.0, 1.35), 0.75 * nightness(hours));
}

// ---------- the species ----------
export const SPECIES = [
  {
    id: 'bluegill',
    name: 'Bluegill',
    latin: 'Lepomis macrochirus',
    blurb:
      'Deep-bodied sunfish with a dark "ear" flap and a copper-orange breast. Schools around weeds and docks, ' +
      'nests in colonies in the shallows in early summer, and pecks at a worm several times before taking it.',
    weightKg: { min: 0.04, typical: 0.16, max: 0.72, record: 2.15 }, // record: 4 lb 12 oz, Ketona Lake, AL, 1950
    lw: { a: 0.00875, b: 3.316 },
    strength: 0.3,
    stamina: 0.3,
    jumpiness: 0.0,
    headshake: 0.12,
    depthM: [0.3, 5],
    habitat: { weeds: 0.9, rocks: 0.3, wood: 0.6, open: 0.1 },
    lures: { bobber: 1.0, spinner: 0.3, crankbait: 0.03, topwater: 0.06 },
    activity: (h) => 0.06 + 0.94 * daylight(h) * (0.55 + 0.45 * bump(h, 12, 3.8)),
    hookWindowS: 0.6,
    rarity: 0.0,
    // --- behavior extras (fish-behavior only) ---
    abundance: 1.0,
    school: [5, 8],
    column: 0.5, // preferred height in the water column: 0 = surface, 1 = bottom
    cruiseMps: 0.22,
    boldness: 0.9, // strike vs follow tendency
    nibbles: [1, 4],
    spookiness: 0.55,
    fight: { run: 0.8, dive: 0.4, thrash: 0.0, cover: 0.6, circle: 1.0 },
    rarityLabel: 'Common',
    bodyDepth: 0.45, // max body depth / total length
    bodyWidth: 0.36, // body width / body depth
  },
  {
    id: 'yellow_perch',
    name: 'Yellow Perch',
    latin: 'Perca flavescens',
    blurb:
      'Golden-green with six to eight dark saddle bars and orange lower fins. Roams in loose schools near the ' +
      'bottom, feeds by day, and nibbles bait. The world record, caught in 1865, is the oldest standing freshwater record.',
    weightKg: { min: 0.05, typical: 0.17, max: 0.9, record: 1.91 }, // 4 lb 3 oz, Bordentown, NJ, 1865
    lw: { a: 0.00698, b: 3.23 },
    strength: 0.2,
    stamina: 0.22,
    jumpiness: 0.0,
    headshake: 0.3,
    depthM: [1.0, 9],
    habitat: { weeds: 0.6, rocks: 0.5, wood: 0.4, open: 0.3 },
    lures: { bobber: 1.0, spinner: 0.55, crankbait: 0.15, topwater: 0.0 },
    activity: (h) => 0.04 + 0.96 * daylight(h) * (0.6 + 0.4 * Math.max(bump(h, 9, 2), bump(h, 17.5, 2))),
    hookWindowS: 0.7,
    rarity: 0.05,
    abundance: 0.9,
    school: [4, 7],
    column: 0.82,
    cruiseMps: 0.24,
    boldness: 0.85,
    nibbles: [1, 3],
    spookiness: 0.45,
    fight: { run: 0.6, dive: 0.6, thrash: 0.0, cover: 0.3, circle: 0.5 },
    rarityLabel: 'Common',
    bodyDepth: 0.27, // max body depth / total length
    bodyWidth: 0.5, // body width / body depth
  },
  {
    id: 'rainbow_trout',
    name: 'Rainbow Trout',
    latin: 'Oncorhynchus mykiss',
    blurb:
      'Silvery with a pink-red lateral band and small black spots. Needs cool, oxygen-rich water, so in summer it ' +
      'cruises the deep open basin. Hooked, it makes fast runs and leaps again and again.',
    weightKg: { min: 0.3, typical: 0.8, max: 4.0, record: 21.8 }, // 48 lb, Lake Diefenbaker, SK, 2009
    lw: { a: 0.01002, b: 3.024 },
    strength: 0.62,
    stamina: 0.6,
    jumpiness: 0.85,
    headshake: 0.45,
    depthM: [2.0, 11],
    habitat: { weeds: 0.05, rocks: 0.35, wood: 0.1, open: 1.0 },
    lures: { bobber: 0.75, spinner: 0.95, crankbait: 0.35, topwater: 0.15 },
    activity: (h) => 0.18 + 0.82 * Math.max(bump(h, 6.3, 1.5), bump(h, 19.9, 1.5), 0.45 * bump(h, 9.5, 2.2)),
    hookWindowS: 0.8,
    rarity: 0.35,
    abundance: 0.35,
    school: null,
    column: 0.45,
    cruiseMps: 0.45,
    boldness: 0.7,
    nibbles: [0, 2],
    spookiness: 0.7,
    fight: { run: 1.0, dive: 0.4, thrash: 0.1, cover: 0.0, circle: 0.2 },
    rarityLabel: 'Uncommon',
    bodyDepth: 0.24, // max body depth / total length
    bodyWidth: 0.48, // body width / body depth
  },
  {
    id: 'smallmouth_bass',
    name: 'Smallmouth Bass',
    latin: 'Micropterus dolomieu',
    blurb:
      'Bronze-brown with faint vertical bars and red eyes. Lives on rocks, gravel and drop-offs in clear water. ' +
      'Pound for pound one of the hardest-fighting freshwater fish, famous for repeated jumps.',
    weightKg: { min: 0.25, typical: 0.9, max: 3.2, record: 4.93 }, // 10 lb 14 oz, Dale Hollow Lake, TN/KY, 1955
    lw: { a: 0.00743, b: 3.2 },
    strength: 0.82,
    stamina: 0.78,
    jumpiness: 0.9,
    headshake: 0.6,
    depthM: [1.0, 8],
    habitat: { weeds: 0.15, rocks: 1.0, wood: 0.4, open: 0.3 },
    lures: { bobber: 0.55, spinner: 0.8, crankbait: 0.9, topwater: 0.75 },
    activity: (h) => 0.12 + 0.88 * Math.max(bump(h, 6.6, 1.5), bump(h, 19.6, 1.5), 0.36 * daylight(h)),
    hookWindowS: 1.0,
    rarity: 0.3,
    abundance: 0.4,
    school: null,
    column: 0.8,
    cruiseMps: 0.32,
    boldness: 0.75,
    nibbles: [0, 1],
    spookiness: 0.6,
    fight: { run: 1.0, dive: 0.6, thrash: 0.2, cover: 0.4, circle: 0.3 },
    rarityLabel: 'Uncommon',
    bodyDepth: 0.27, // max body depth / total length
    bodyWidth: 0.5, // body width / body depth
  },
  {
    id: 'largemouth_bass',
    name: 'Largemouth Bass',
    latin: 'Micropterus salmoides',
    blurb:
      'Green with a dark, blotchy lateral stripe and a jaw that reaches past the eye. Ambushes from weeds, docks ' +
      'and timber, blows up on topwater at dawn and dusk, and jumps with its gills flared to throw the hook.',
    weightKg: { min: 0.3, typical: 1.1, max: 4.0, record: 10.09 }, // 22 lb 4 oz, Montgomery Lake, GA, 1932 (tied 2009)
    lw: { a: 0.0135, b: 3.1 },
    strength: 0.66,
    stamina: 0.55,
    jumpiness: 0.7,
    headshake: 0.7,
    depthM: [0.5, 6],
    habitat: { weeds: 1.0, rocks: 0.35, wood: 0.9, open: 0.1 },
    lures: { bobber: 0.6, spinner: 0.75, crankbait: 0.85, topwater: 0.95 },
    activity: (h) => 0.2 + 0.8 * Math.max(bump(h, 6.4, 1.45), bump(h, 19.9, 1.45), 0.25 * daylight(h), 0.3 * nightness(h)),
    hookWindowS: 1.2,
    rarity: 0.2,
    abundance: 0.55,
    school: null,
    column: 0.6,
    cruiseMps: 0.28,
    boldness: 0.8,
    nibbles: [0, 1],
    spookiness: 0.5,
    fight: { run: 0.9, dive: 0.3, thrash: 0.3, cover: 1.0, circle: 0.3 },
    rarityLabel: 'Common',
    bodyDepth: 0.29, // max body depth / total length
    bodyWidth: 0.52, // body width / body depth
  },
  {
    id: 'walleye',
    name: 'Walleye',
    latin: 'Sander vitreus',
    blurb:
      'Olive-gold with glassy, light-gathering eyes (a reflective tapetum lucidum) and a white tip on the lower tail. ' +
      'Holds on rocky drop-offs and hunts at dawn, dusk and after dark. Bites softly and fights with dogged head shakes.',
    weightKg: { min: 0.35, typical: 1.1, max: 5.5, record: 11.34 }, // 25 lb, Old Hickory Lake, TN, 1960
    lw: { a: 0.00533, b: 3.18 },
    strength: 0.45,
    stamina: 0.42,
    jumpiness: 0.02,
    headshake: 0.62,
    depthM: [2.0, 11],
    habitat: { weeds: 0.25, rocks: 1.0, wood: 0.4, open: 0.4 },
    lures: { bobber: 0.75, spinner: 0.45, crankbait: 0.9, topwater: 0.02 },
    activity: (h) => 0.1 + 0.9 * Math.max(bump(h, 5.9, 1.3), bump(h, 20.4, 1.4), 0.78 * nightness(h), 0.2 * bump(h, 9, 1.8)),
    hookWindowS: 0.9,
    rarity: 0.25,
    abundance: 0.5,
    school: null,
    column: 0.94,
    cruiseMps: 0.25,
    boldness: 0.6,
    nibbles: [1, 3],
    spookiness: 0.65,
    fight: { run: 0.5, dive: 1.0, thrash: 0.0, cover: 0.2, circle: 0.2 },
    rarityLabel: 'Uncommon',
    bodyDepth: 0.2, // max body depth / total length
    bodyWidth: 0.62, // body width / body depth
  },
  {
    id: 'channel_catfish',
    name: 'Channel Catfish',
    latin: 'Ictalurus punctatus',
    blurb:
      'Slate-grey with a deeply forked tail and eight barbels. Finds food by taste and smell, feeds mostly from ' +
      'evening into the night, and bulldogs toward the bottom in a long, heavy fight.',
    weightKg: { min: 0.6, typical: 2.2, max: 11.0, record: 26.3 }, // 58 lb, Santee-Cooper Reservoir, SC, 1964
    lw: { a: 0.00312, b: 3.294 },
    strength: 0.8,
    stamina: 0.85,
    jumpiness: 0.0,
    headshake: 0.35,
    depthM: [1.5, 11],
    habitat: { weeds: 0.1, rocks: 0.3, wood: 1.0, open: 0.4 },
    lures: { bobber: 1.0, spinner: 0.05, crankbait: 0.1, topwater: 0.0 },
    activity: (h) => 0.12 + 0.88 * Math.max(0.9 * bump(h, 20.9, 1.9), nightness(h), 0.5 * bump(h, 5.6, 1.2)),
    hookWindowS: 1.4,
    rarity: 0.4,
    abundance: 0.32,
    school: null,
    column: 0.97,
    cruiseMps: 0.2,
    boldness: 0.85,
    nibbles: [0, 2],
    spookiness: 0.35,
    fight: { run: 0.6, dive: 1.0, thrash: 0.0, cover: 0.7, circle: 0.2 },
    rarityLabel: 'Uncommon',
    bodyDepth: 0.19, // max body depth / total length
    bodyWidth: 0.8, // body width / body depth
  },
  {
    id: 'northern_pike',
    name: 'Northern Pike',
    latin: 'Esox lucius',
    blurb:
      'Long, torpedo-shaped ambush predator with a duck-bill snout and rows of pale, bean-shaped spots. Lurks on ' +
      'weed edges, strikes in a burst, then shakes its head and thrashes at the surface. Sharp teeth, handle with care.',
    weightKg: { min: 0.7, typical: 2.0, max: 11.0, record: 25.0 }, // 55 lb 1 oz, Lake of Grefeern, Germany, 1986
    lw: { a: 0.0053, b: 3.096 },
    strength: 0.76,
    stamina: 0.55,
    jumpiness: 0.22,
    headshake: 0.92,
    depthM: [0.8, 7],
    habitat: { weeds: 1.0, rocks: 0.2, wood: 0.4, open: 0.2 },
    lures: { bobber: 0.35, spinner: 0.9, crankbait: 0.9, topwater: 0.8 },
    activity: (h) => 0.04 + 0.96 * earlyDay(h) * (0.34 + 0.66 * Math.max(bump(h, 6.9, 1.6), bump(h, 19.2, 1.5))),
    hookWindowS: 1.3,
    rarity: 0.25,
    abundance: 0.45,
    school: null,
    column: 0.45,
    cruiseMps: 0.2,
    boldness: 0.8,
    nibbles: [0, 0],
    spookiness: 0.4,
    fight: { run: 1.0, dive: 0.3, thrash: 1.0, cover: 0.9, circle: 0.2 },
    rarityLabel: 'Common',
    bodyDepth: 0.16, // max body depth / total length
    bodyWidth: 0.68, // body width / body depth
  },
  {
    id: 'muskellunge',
    name: 'Muskellunge',
    latin: 'Esox masquinongy',
    blurb:
      'The "fish of 10,000 casts". The largest pike, light-bodied with dark bars or spots, it patrols weed edges and ' +
      'follows lures to the boat far more often than it strikes. A hooked musky thrashes, rolls and runs hard.',
    weightKg: { min: 3.0, typical: 6.5, max: 20.0, record: 30.6 }, // 67 lb 8 oz, Chippewa Flowage, WI, 1949
    lw: { a: 0.00339, b: 3.13 },
    strength: 0.92,
    stamina: 0.8,
    jumpiness: 0.3,
    headshake: 1.0,
    depthM: [1.0, 8],
    habitat: { weeds: 1.0, rocks: 0.5, wood: 0.3, open: 0.35 },
    lures: { bobber: 0.1, spinner: 0.7, crankbait: 0.85, topwater: 0.8 },
    activity: (h) => 0.06 + 0.94 * Math.max(earlyDay(h) * (0.3 + 0.7 * Math.max(bump(h, 7.2, 1.5), bump(h, 19.4, 1.6))), 0.25 * bump(h, 21.2, 1)),
    hookWindowS: 1.1,
    rarity: 0.95,
    abundance: 0.03,
    school: null,
    column: 0.4,
    cruiseMps: 0.35,
    boldness: 0.18,
    nibbles: [0, 0],
    spookiness: 0.5,
    fight: { run: 1.0, dive: 0.3, thrash: 1.0, cover: 0.6, circle: 0.2 },
    rarityLabel: 'Very rare',
    bodyDepth: 0.17, // max body depth / total length
    bodyWidth: 0.66, // body width / body depth
  },
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map((s) => [s.id, s]));

export function getSpecies(id) {
  return SPECIES_BY_ID[id] || null;
}

// ---------- length-weight ----------
export function weightFromLength(species, lengthCm) {
  return (species.lw.a * Math.pow(lengthCm, species.lw.b)) / 1000;
}
export function lengthFromWeight(species, weightKg) {
  return Math.pow((Math.max(weightKg, 0.001) * 1000) / species.lw.a, 1 / species.lw.b);
}

// Standard normal via Box-Muller (uses two draws).
function gauss(rng) {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * v);
}

// Split (two-piece) lognormal around the typical weight: most fish near typical, the lower tail
// reaches `min`, the upper tail reaches `max` only rarely (~0.1%), never above the record.
export function sampleWeightKg(species, rng) {
  const w = species.weightKg;
  const sLow = Math.log(w.typical / w.min) / 2.3;
  const sHigh = Math.log(w.max / w.typical) / 3.0;
  for (let i = 0; i < 12; i++) {
    const z = gauss(rng);
    const kg = w.typical * Math.exp(z * (z < 0 ? sLow : sHigh));
    if (kg >= w.min && kg <= w.max) return kg;
  }
  return w.typical;
}

let fallbackRng = null;

// rollFish(speciesId, rng?) -> { speciesId, species, weightKg, lengthCm }
// Weight from the species distribution, length from the length-weight curve with a little
// natural variation in condition (+-4% in weight at a given length).
export function rollFish(speciesId, rng) {
  const species = getSpecies(speciesId) || SPECIES[0];
  if (typeof rng !== 'function') {
    if (!fallbackRng) fallbackRng = makeRng((Date.now() ^ 0x5eed) >>> 0);
    rng = fallbackRng;
  }
  const kg = Math.min(sampleWeightKg(species, rng), species.weightKg.record);
  const condition = clamp(1 + 0.04 * gauss(rng), 0.9, 1.1); // relative plumpness
  const lengthCm = lengthFromWeight(species, kg / condition);
  return {
    speciesId: species.id,
    species,
    weightKg: Math.round(kg * 1000) / 1000,
    lengthCm: Math.round(lengthCm * 10) / 10,
  };
}
