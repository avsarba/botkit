// Analytic terrain for Loon Lake. One function answers every height query and builds the
// mesh, so CPU queries (fish, tackle, scenery placement) match what is rendered.
// Pure JS (no THREE) so it can be exercised in node.
import { clamp, smoothstep } from '../config.js';
import { createNoise2D, fbm, ridged, createProfile } from './noise.js';
import { LAKE_OUTLINE, ISLANDS, smoothClosed, buildSdfGrid } from './shoreline.js';

const DEG = Math.PI / 180;

// Compass bearing of the view down the dock (-Z). Shared with the sky so the sunset
// sector and the low notch in the far ridges line up.
export const FORWARD_AZIMUTH = 258;

// Lake-bed profile against (steepness-scaled) distance from shore, meters -> depth.
// Tuned so that along the dock line (shore at z = +16): 1.6 m at the dock end (d = 17),
// 3 m at z = -12 (d = 28), 5 m at z = -30 (d = 46), a drop-off to 8+ m by z = -45.
const DEPTH_PROFILE = createProfile([
  [0, 0],
  [3, 0.22],
  [8, 0.64],
  [17, 1.6],
  [28, 3.0],
  [38, 4.05],
  [46, 5.0],
  [52, 6.3],
  [60, 7.9],
  [76, 9.2],
  [110, 10.4],
  [160, 11.0],
  [260, 11.4],
]);

const gauss2 = (dx, dz, r) => Math.exp(-(dx * dx + dz * dz) / (r * r));

// Distance from p to segment a-b, and the segment parameter t (written to out[0], out[1]).
function segDist(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax;
  const dz = bz - az;
  let t = ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qz = az + t * dz - pz;
  out[0] = Math.sqrt(qx * qx + qz * qz);
  out[1] = t;
  return out;
}

export function createTerrainField() {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const nShore = createNoise2D(101);
  const nShore2 = createNoise2D(131);
  const nBed = createNoise2D(211);
  const nHill = createNoise2D(307);
  const nRidge = createNoise2D(401);
  const nMtn = createNoise2D(503);
  const nRock = createNoise2D(601);
  const nCover = createNoise2D(701);
  const nMicro = createNoise2D(809);

  const polys = [smoothClosed(LAKE_OUTLINE, 5), ...ISLANDS.map((p) => smoothClosed(p, 3))];
  const sdf = buildSdfGrid(polys, { minX: -250, minZ: -410, maxX: 250, maxZ: 76, cell: 2 });
  const buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;

  const tmp = [0, 0];

  // ---- zone masks (all smooth, 0..1) ----
  // Calm near the dock: no shoreline wobble, textbook profile.
  const dockZone = (x, z) => gauss2(x / 1.25, z - 6, 32);
  // The water straight out from the dock keeps the textbook shelf / drop-off profile.
  const dockLine = (x, z) => Math.exp(-(x * x) / (42 * 42)) * smoothstep(-85, -58, z);
  // Rocky point: the land tip and the boulder ridge that continues underwater toward the dock.
  const RIDGE_A = [65.5, -21.0];
  const RIDGE_B = [20.0, -23.0];
  const POINT_BASE = [88, -20];
  function pointZone(x, z) {
    const a = segDist(x, z, RIDGE_A[0], RIDGE_A[1], RIDGE_B[0], RIDGE_B[1], tmp)[0];
    const b = segDist(x, z, RIDGE_A[0], RIDGE_A[1], POINT_BASE[0], POINT_BASE[1], tmp)[0];
    const m = Math.min(a, b);
    return Math.exp(-(m * m) / (12 * 12));
  }
  // The point's land and its immediate shore: steep granite, deep water close in.
  function pointLand(x, z) {
    const b = segDist(x, z, RIDGE_A[0] - 4, RIDGE_A[1], POINT_BASE[0], POINT_BASE[1], tmp)[0];
    return Math.exp(-(b * b) / (22 * 22));
  }
  // Weedy cove to the left (x -45..-15, z -12..+14, it runs back to ~+25): a rounded,
  // slightly irregular basin.
  function coveZone(x, z) {
    const dx = (x + 30) / 20.5;
    const dz = (z - 3) / 22;
    const r = Math.sqrt(dx * dx + dz * dz) + 0.1 * nCover(x / 13 + 3.3, z / 13 + 1.1);
    return 1 - smoothstep(0.78, 1.22, r);
  }
  // Rocky islands: steep granite shores, no sandy halo.
  const ISLAND_C = ISLANDS.map((p) => {
    let cx = 0;
    let cz = 0;
    for (const [x, z] of p) {
      cx += x;
      cz += z;
    }
    cx /= p.length;
    cz /= p.length;
    let r = 0;
    for (const [x, z] of p) r = Math.max(r, Math.hypot(x - cx, z - cz));
    return [cx, cz, r + 16];
  });
  function islandZone(x, z) {
    let m = 0;
    for (const [cx, cz, r] of ISLAND_C) {
      const dx = x - cx;
      const dz = z - cz;
      // cull only where the gaussian is below 1e-4 (no visible step at the cutoff)
      if (Math.abs(dx) < r * 3 && Math.abs(dz) < r * 3) m = Math.max(m, Math.exp(-(dx * dx + dz * dz) / (r * r)));
    }
    return m;
  }
  // Sunken timber patch in front-left.
  const timberZone = (x, z) => gauss2(x + 10, z + 22, 8);
  // Low notches in the ridge line toward sunset (right of forward) and sunrise (behind),
  // so the low sun is not hidden behind the hills at dawn and dusk.
  function notch(x, z) {
    const yaw = Math.atan2(x, -z) / DEG; // 0 = forward, +90 = right
    const a = smoothstep(4, 18, yaw) * (1 - smoothstep(46, 62, yaw));
    const yb = yaw < 0 ? yaw + 360 : yaw;
    const b = smoothstep(148, 162, yb) * (1 - smoothstep(190, 204, yb));
    return Math.max(a, b * 0.8);
  }
  // Rocky shore stretches (Canadian-shield granite) away from the dock.
  function rockyShore(x, z) {
    const n = fbm(nRock, x / 140 + 3.1, z / 140 - 1.7, 2);
    return Math.max(smoothstep(0.1, 0.45, n) * (1 - dockZone(x, z)) * (1 - coveZone(x, z)), islandZone(x, z));
  }

  // ---- signed distance to the shoreline (meters, + in the lake) ----
  function lakeDistance(x, z) {
    let d = sdf.sample(x, z);
    if (d > -60 && d < 80) {
      // fades to zero at both ends of the band, so the field stays continuous
      const band = smoothstep(-60, -42, d) * (1 - smoothstep(60, 80, d));
      const calm = (1 - 0.95 * dockZone(x, z) - 0.85 * pointLand(x, z)) * band;
      if (calm > 0.002) d += (fbm(nShore, x / 42, z / 42, 3) * 4.2 + nShore2(x / 11, z / 11) * 1.1) * calm;
    }
    return d;
  }

  function steepness(x, z) {
    let s = 1 + 1.1 * pointLand(x, z) + 1.2 * islandZone(x, z);
    s += 0.9 * rockyShore(x, z) * (1 - dockLine(x, z));
    return s;
  }

  // ---- lake bed ----
  function lakeDepth(x, z, d) {
    const s = steepness(x, z);
    let depth = DEPTH_PROFILE(d * s);
    // Cove: broad, flat, mucky shallows (0.35 - 2 m).
    const cove = coveZone(x, z);
    if (cove > 0) {
      const cap = 0.3 + 1.75 * smoothstep(0, 36, d);
      if (depth > cap) depth += (cap - depth) * cove;
    }
    // Rocky point: a boulder ridge running from the tip toward the dock, 1 m over the crest
    // near the point, falling away to ~7 m on its flanks.
    segDist(x, z, RIDGE_A[0], RIDGE_A[1], RIDGE_B[0], RIDGE_B[1], tmp);
    const r = tmp[0];
    const t = tmp[1];
    // deep water off the flanks of the ridge (the drop-off anglers fish)
    if (r < 70) depth += 4.4 * Math.exp(-(r * r) / (19 * 19)) * smoothstep(4, 16, d) * (1 - dockLine(x, z));
    const pz = pointZone(x, z);
    if (pz > 0.001) {
      const crest = 0.95 + 4.1 * smoothstep(0.3, 1.0, t);
      const w = 7 + 5 * t;
      const ridge = crest + (r / w) * (r / w) * 5.5;
      // bouldery micro-relief (never breaks the surface: the point stays open water)
      const bumps = ridged(nRock, x / 3.2, z / 3.2, 2) * 0.38 * pz;
      const target = Math.min(depth, ridge) - bumps;
      depth += (target - depth) * smoothstep(0, 0.3, pz);
    }
    // Sunken timber sits on a ~3.5 m shelf.
    const tz = timberZone(x, z);
    if (tz > 0.001) depth += (3.5 - depth) * 0.75 * tz;
    // Gentle undulation of the bed, smoothed out right at the shore.
    const und = fbm(nBed, x / 36, z / 36, 3) * (0.25 + 0.35 * smoothstep(20, 80, d));
    depth += und * smoothstep(3, 14, d) * (1 - 0.75 * dockLine(x, z));
    return depth > 0 ? depth : 0;
  }

  // ---- land ----
  function hills(x, z) {
    const a = 0.5 + 0.5 * fbm(nHill, x / 340 + 11.3, z / 340 - 4.2, 4);
    const b = ridged(nRidge, x / 560 - 3.7, z / 560 + 8.9, 3);
    return 10 + 48 * clamp(0.6 * a + 0.5 * b - 0.05, 0, 1);
  }
  function mountains(x, z) {
    const cx = x;
    const cz = z + 180;
    const r = Math.sqrt(cx * cx + cz * cz);
    const ring = smoothstep(760, 1320, r);
    if (ring <= 0) return 0;
    const m = ridged(nMtn, x / 760 + 1.3, z / 760 - 7.1, 5, 0.5);
    const swell = 0.5 + 0.5 * fbm(nHill, x / 1500 - 5.1, z / 1500 + 2.2, 2);
    // taper again toward the terrain edge so the ring reads as a ring of ridges
    const outer = 1 - 0.35 * smoothstep(1700, 2300, r);
    return ring * outer * (60 + 230 * m * (0.5 + 0.65 * swell));
  }
  function landHeight(x, z, e) {
    const s = steepness(x, z);
    const dz = dockZone(x, z);
    // shore rise: gentle sand/mud margin, then meadow
    const ec = e < 60 ? e : Math.min(200, 60 + (e - 60) * 0.15);
    let h = 0.045 * ec * (0.4 + 0.6 * s) + 3.0 * smoothstep(5, 70, e) * (0.6 + 0.5 * s);
    // forested hills behind every shore; behind the dock they start farther back
    const ramp = smoothstep(20 + 60 * dz, 250 + 160 * dz, e);
    const nt = notch(x, z);
    if (ramp > 0) h += hills(x, z) * ramp * (1 - 0.72 * nt);
    // glacially rounded granite whalebacks (low domes), mostly on rocky shores and the point
    const kb = fbm(nRock, x / 34 + 5.5, z / 34 - 2.5, 3);
    const knob = smoothstep(0.16, 0.6, kb) * 2.6 * (0.25 + 0.75 * rockyShore(x, z) + 1.3 * pointLand(x, z));
    h += knob * smoothstep(0, 9, e) * (1 - dz);
    // distant ring of ridges / mountains
    h += mountains(x, z) * (1 - 0.88 * nt);
    // micro relief so near ground is not glassy smooth
    h += fbm(nMicro, x / 7.5, z / 7.5, 2) * 0.18 * smoothstep(2, 12, e);
    return h;
  }

  // `lastDistance` holds the shore distance of the latest height() call, so bulk builders
  // (mesh, depth map) can reuse it instead of recomputing.
  let lastDistance = 0;
  function height(x, z) {
    const d = lakeDistance(x, z);
    lastDistance = d;
    if (d >= 0) return -lakeDepth(x, z, d);
    return landHeight(x, z, -d);
  }

  function depthAt(x, z) {
    const h = height(x, z);
    return h < 0 ? -h : 0;
  }

  // ---- habitat (for fish AI and scenery placement) ----
  function habitat(x, z, out, dKnown) {
    const o = out || {};
    const d = dKnown === undefined ? lakeDistance(x, z) : dKnown;
    const depth = d >= 0 ? lakeDepth(x, z, d) : 0;
    o.depth = depth;
    if (depth <= 0.05) {
      o.weeds = 0;
      o.rocks = 0;
      o.wood = 0;
      return o;
    }
    const cove = coveZone(x, z);
    const pz = pointZone(x, z);
    const patch = 0.5 + 0.5 * fbm(nCover, x / 18 + 2.2, z / 18 - 7.3, 2);
    const weedDepth = smoothstep(0.2, 0.7, depth) * (1 - smoothstep(2.6, 3.8, depth));
    let weeds = cove * (0.65 + 0.35 * patch) * weedDepth;
    weeds = Math.max(weeds, 0.55 * smoothstep(0.45, 0.8, patch) * weedDepth * (1 - pz) * (1 - rockyShore(x, z)));
    let rocks = pz * smoothstep(0.3, 1.2, depth);
    rocks = Math.max(rocks, 0.7 * rockyShore(x, z) * (1 - smoothstep(4, 8, depth)) * (1 - smoothstep(10, 40, d)));
    rocks = Math.max(rocks, 0.6 * pointLand(x, z) * (1 - smoothstep(6, 10, depth)));
    let wood = timberZone(x, z) * 1.15;
    // scattered deadfall along wooded shores
    wood = Math.max(wood, 0.35 * smoothstep(0.72, 0.9, patch) * (1 - smoothstep(1.5, 3, depth)) * (1 - cove));
    o.weeds = clamp(weeds, 0, 1);
    o.rocks = clamp(rocks, 0, 1);
    o.wood = clamp(wood, 0, 1);
    return o;
  }

  // Ground cover used by the terrain shader (and offered to scenery for tree placement):
  // forest floor (trees belong here), granite, lake-bed muck, and how sandy the margin is.
  function landCover(x, z, h, normalY, out, dKnown) {
    const o = out || {};
    const d = dKnown === undefined ? lakeDistance(x, z) : dKnown;
    const e = -d;
    const dz = dockZone(x, z);
    const rs = rockyShore(x, z);
    const pz = Math.max(pointZone(x, z), pointLand(x, z));
    const n1 = fbm(nCover, x / 26, z / 26, 3);
    const n2 = nCover(x / 7 + 31.7, z / 7 - 12.1);
    // granite: steep faces, shield outcrops along rocky shores and the point
    const far = smoothstep(150, 500, e);
    let rock = smoothstep(0.84 - 0.22 * far, 0.7 - 0.2 * far, normalY);
    rock = Math.max(rock, smoothstep(0.1, 0.5, rs + pz * 0.8 + n1 * 0.35) * (1 - smoothstep(6, 22, e)) * (0.6 + 0.4 * smoothstep(-4, -2, h)));
    rock = Math.max(rock, smoothstep(0.35, 0.55, pz) * smoothstep(-2.5, 0.5, h));
    // forest starts a few meters above the water; a meadow clearing surrounds the dock
    const clearing = gauss2(x / 1.3, z - 34, 42);
    const fStart = 7 + 4 * n1 + 55 * clearing + 6 * dz;
    let forest = smoothstep(fStart - 3, fStart + 5, e) * smoothstep(0.4, 0.9, h);
    forest *= 1 - 0.8 * smoothstep(0.35, 0.7, rock);
    forest *= 1 - 0.35 * smoothstep(0.35, 0.65, n2); // glades
    // sandy / muddy margins: most sand near the dock, mud in the cove, narrow elsewhere
    const cove = coveZone(x, z);
    let beach = clamp(0.3 + 0.7 * dz + 0.35 * n1, 0, 1) * (1 - rs) * (1 - pz);
    // cove bed: dark organic muck with weed carpet
    const patch = smoothstep(-0.25, 0.35, n1 + 0.5 * n2);
    const muck = clamp(cove * (0.45 + 0.5 * patch) + 0.3 * smoothstep(0.3, 0.7, n1) * (1 - pz) * (1 - rs), 0, 1);
    o.forest = clamp(forest, 0, 1);
    o.rock = clamp(rock, 0, 1);
    o.muck = muck * (1 - smoothstep(0.1, 0.4, h));
    o.beach = clamp(beach + cove * 0.5, 0, 1);
    return o;
  }

  return {
    height,
    depthAt,
    lakeDistance,
    habitat,
    landCover,
    zones: { dockZone, pointZone, pointLand, coveZone, islandZone, timberZone, rockyShore, notch },
    sdf,
    buildMs,
    get lastDistance() {
      return lastDistance;
    },
  };
}
