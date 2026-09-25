// Loon Lake Angler - fish models (owner: fish-mesh).
//
//   createFishMesh(species, lengthCm, opts?) -> { object3d, update(dt, swimSpeedMps, turnRate, exhaustion01), dispose() }
//
// Local space of `object3d` (a THREE.Group you position / orient freely):
//   +Z  the direction the fish faces (snout), +Y dorsal (up), +X the fish's left side.
//   Origin = tip of the snout / mouth, i.e. the hook point. The body runs along -Z; the tail tip is at z = -lengthM.
//   Scale is 1:1 in meters (total length = lengthCm / 100).
//   object3d.userData = { speciesId, appearance, lengthM, centerZ (local z of the centre of mass, ~ -0.42 L), detail }
//
// opts:
//   detail   'high' (default; showcase / hooked fish 0.5-0.8 m from the camera: body + eyes + fins meshes = 4 draw
//            calls, 1-2k skin with relief normal map, silvering, clearcoat, iridescence)
//            | 'medium' (one mesh, 1k atlas) | 'low' (population: ONE mesh / ONE draw call per fish, a 256-512 px
//            atlas shared per species and kept cached). High/medium assets are shared while in use and freed with
//            the last fish that uses them.
//   quality  'high' | 'medium' | 'low' (scales texture sizes and tessellation). Default 'high'.
//   seed     integer, per-fish variation of animation phases and which side an exhausted fish rolls onto.
//   girth    0.8..1.25 body depth/width multiplier (a heavy fish for its length is > 1). Default 1.
//   castShadow  bool (default false; casters get a swim-deformed depth material). receiveShadow is on.
//   envMap   optional THREE.Texture for the materials (otherwise scene.environment is used).
//
// update(dt, swimSpeedMps, turnRate, exhaustion01):
//   swimSpeedMps  forward speed through the water (m/s); sets tail-beat frequency (~1-4 Hz) and amplitude.
//   turnRate      yaw rate in rad/s about local +Y (positive = turning toward +X, the fish's left); bends the body.
//   exhaustion01  0 fresh .. 1 spent: slows everything, flares the gills and rolls the fish onto its side (~75 deg).
//
// Also exported (used by the fish system for the hooked fish; all optional):
//   fishAssetsReady(species, { detail, quality })            are that model's textures / geometry already built?
//   prepareFishAssets(species, { detail, quality, renderer }) build them a few ms per frame: job.step(budgetMs)
//   createFishProgramKeeper({ quality })                      1-px stand-in with the 'high' materials (shader warm-up)
// The last two showcase / hooked-fish asset sets stay cached (LRU); population atlases are always cached.
//
// Swimming is a traveling body wave in the vertex shader (onBeforeCompile) whose amplitude grows toward the tail,
// plus pectoral sculling, median-fin ripple, caudal-fin flex, gill pulse and barbel sway. All textures are
// painted procedurally on Canvas2D (no network assets); geometry is lofted from species-specific profiles.
import * as THREE from 'three';
import { LAYERS, SPECIES_IDS, clamp, lerp, smoothstep, damp, makeRng } from '../config.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// ---------------------------------------------------------------------------------------------------------------
// Appearance table (unit length: every distance is a fraction of total length L; s runs snout 0 -> tail tip 1).
// profile rows: [s, dorsal height above the snout axis, ventral depth below it, half width, dorsal exponent,
//                ventral exponent]  (exponent > 1 = laterally compressed ridge, < 1 = boxy / flat)
// fins.*.h: fin heights sampled evenly along the fin base; rake: [first, last] ray angle back from vertical.
// shade: countershading stops [q, colour] where q is -1 (ventral midline) .. 0 (lateral midline) .. 1 (dorsal).
// ---------------------------------------------------------------------------------------------------------------
const PERCH_WAVE = { env: [0.14, -0.55, 1.41], k: TAU / 1.0 }; // carangiform
const SUB_WAVE = { env: [0.12, -0.42, 1.3], k: TAU / 0.92 }; // subcarangiform
const ESOX_WAVE = { env: [0.1, -0.26, 1.16], k: TAU / 0.86 };
const CAT_WAVE = { env: [0.1, -0.2, 1.1], k: TAU / 0.82 };

const APPEARANCE = {
  largemouth_bass: {
    style: 'largemouth',
    profile: [
      [0.0, 0.022, 0.022, 0.017, 1.0, 1.2],
      [0.02, 0.036, 0.035, 0.025, 1.0, 1.25],
      [0.05, 0.055, 0.053, 0.036, 1.0, 1.3],
      [0.1, 0.085, 0.079, 0.054, 1.0, 1.3],
      [0.16, 0.108, 0.1, 0.066, 1.05, 1.2],
      [0.24, 0.127, 0.118, 0.076, 1.15, 1.1],
      [0.34, 0.139, 0.127, 0.076, 1.2, 1.05],
      [0.45, 0.133, 0.119, 0.07, 1.25, 1.1],
      [0.56, 0.111, 0.098, 0.058, 1.3, 1.15],
      [0.66, 0.083, 0.073, 0.043, 1.3, 1.2],
      [0.75, 0.058, 0.052, 0.028, 1.25, 1.2],
      [0.8, 0.05, 0.047, 0.02, 1.2, 1.2],
      [0.835, 0.054, 0.051, 0.012, 1.2, 1.2],
    ],
    nose: 0.012,
    tailRound: 0.012,
    eye: { s: 0.088, y: 0.047, r: 0.019, up: 0.12, fwd: 0.2, iris: '#7a5a2a', irisOut: '#34260e', ring: '#b8944a', pupil: 0.15, irisEnd: 0.31 },
    mouth: { y0: 0.003, sJaw: 0.142, yJaw: -0.008, sag: 0.0, depth: 0.14, lip: 0.05 },
    gill: { s: 0.3, r0: 0.06, k: 0.075, step: 0.035 },
    lateral: [0.46, 0.03, 0.12],
    scales: { count: 64, color: 0.13, relief: 1 },
    wave: PERCH_WAVE,
    shade: [[-1, '#e9e7da'], [-0.62, '#dddbc8'], [-0.34, '#b9bba0'], [-0.08, '#8f9a72'], [0.22, '#667444'], [0.55, '#435128'], [1, '#26301a']],
    fins: {
      dorsal1: { s0: 0.335, s1: 0.525, h: [0.035, 0.07, 0.082, 0.078, 0.068, 0.056, 0.045, 0.036, 0.028, 0.022], rake: [0.3, 0.6], rays: 10, spines: 10 },
      dorsal2: { s0: 0.53, s1: 0.735, h: [0.045, 0.082, 0.094, 0.092, 0.085, 0.072, 0.055, 0.035, 0.015], rake: [0.45, 1.05], rays: 13, spines: 1 },
      anal: { s0: 0.565, s1: 0.715, h: [0.028, 0.055, 0.075, 0.078, 0.07, 0.056, 0.036, 0.015], rake: [0.5, 1.1], rays: 14, spines: 3 },
      caudal: { spread: 0.60, fork: 0.16, roll: 0.35, rays: 17 },
      pectoral: { base: [[0.3, -0.14], [0.31, -0.42]], len: 0.13, shape: [0.72, 0.95, 1.0, 0.96, 0.86, 0.72, 0.58, 0.45], out: 0.62, down: 0.1, spread: 0.95, rays: 15 },
      pelvic: { base: [[0.318, -0.82], [0.352, -0.95]], len: 0.095, shape: [0.95, 1.0, 0.9, 0.72, 0.5], out: 0.18, down: 0.95, spread: 0.8, rays: 6, spines: 1 },
    },
    finLook: { membrane: '#6f7852', ray: '#3e4429', base: '#5e6844', aBase: 0.9, aTip: 0.52, pectoral: { membrane: '#aaa47c', ray: '#5c5636', aBase: 0.42, aTip: 0.17 }, pelvic: { membrane: '#8a8660', ray: '#55523a', aBase: 0.8, aTip: 0.42 } },
    mat: { rough: 0.46, clearcoat: 0.5, irid: 0.16, silver: 0.22 },
  },

  smallmouth_bass: {
    style: 'smallmouth',
    profile: [
      [0.0, 0.019, 0.017, 0.016, 1.0, 1.2],
      [0.03, 0.039, 0.034, 0.028, 1.0, 1.25],
      [0.085, 0.07, 0.062, 0.048, 1.0, 1.25],
      [0.16, 0.1, 0.09, 0.063, 1.1, 1.15],
      [0.26, 0.12, 0.108, 0.071, 1.15, 1.05],
      [0.36, 0.127, 0.114, 0.07, 1.2, 1.05],
      [0.46, 0.121, 0.107, 0.064, 1.25, 1.1],
      [0.57, 0.1, 0.088, 0.053, 1.25, 1.15],
      [0.67, 0.076, 0.066, 0.039, 1.25, 1.2],
      [0.76, 0.053, 0.048, 0.025, 1.2, 1.2],
      [0.81, 0.047, 0.044, 0.018, 1.2, 1.2],
      [0.835, 0.051, 0.048, 0.011, 1.2, 1.2],
    ],
    nose: 0.02,
    tailRound: 0.012,
    eye: { s: 0.085, y: 0.034, r: 0.02, up: 0.1, fwd: 0.2, iris: '#a02c18', irisOut: '#4e160c', ring: '#c85c34', pupil: 0.15, irisEnd: 0.31 },
    mouth: { y0: 0.003, sJaw: 0.1, yJaw: -0.006, sag: 0.004, depth: 0.08 },
    gill: { s: 0.285, r0: 0.06, k: 0.075, step: 0.035 },
    lateral: [0.45, 0.03, 0.1],
    scales: { count: 72, color: 0.2, relief: 1 },
    wave: PERCH_WAVE,
    shade: [[-1, '#e6ddc4'], [-0.6, '#d4c7a0'], [-0.28, '#a79466'], [0.05, '#8a7548'], [0.42, '#6b5a35'], [0.75, '#4f4329'], [1, '#3a3121']],
    fins: {
      dorsal1: { s0: 0.33, s1: 0.52, h: [0.03, 0.058, 0.066, 0.064, 0.058, 0.054, 0.05, 0.047, 0.046, 0.046], rake: [0.3, 0.55], rays: 10, spines: 10 },
      dorsal2: { s0: 0.52, s1: 0.725, h: [0.05, 0.072, 0.08, 0.078, 0.072, 0.062, 0.048, 0.03, 0.014], rake: [0.45, 1.05], rays: 14, spines: 1 },
      anal: { s0: 0.57, s1: 0.715, h: [0.028, 0.052, 0.068, 0.07, 0.064, 0.05, 0.032, 0.014], rake: [0.5, 1.1], rays: 14, spines: 3 },
      caudal: { spread: 0.60, fork: 0.18, roll: 0.3, rays: 17 },
      pectoral: { base: [[0.285, -0.14], [0.295, -0.4]], len: 0.125, shape: [0.72, 0.95, 1.0, 0.96, 0.86, 0.72, 0.58, 0.45], out: 0.45, down: 0.08, spread: 0.85, rays: 15 },
      pelvic: { base: [[0.31, -0.84], [0.335, -0.95]], len: 0.08, shape: [0.95, 1.0, 0.9, 0.72, 0.5], out: 0.32, down: 0.95, spread: 0.72, rays: 6, spines: 1 },
    },
    finLook: { membrane: '#7a6a46', ray: '#453822', base: '#6e5c38', aBase: 0.9, aTip: 0.52, pectoral: { membrane: '#b0a07a', ray: '#76684a', aBase: 0.6, aTip: 0.25 }, pelvic: { membrane: '#927f5a', ray: '#5a4c32', aBase: 0.8, aTip: 0.42 } },
    mat: { rough: 0.42, clearcoat: 0.5, irid: 0.12, silver: 0.16 },
  },

  bluegill: {
    style: 'bluegill',
    profile: [
      [0.0, 0.016, 0.013, 0.013, 1.0, 1.0],
      [0.018, 0.045, 0.03, 0.024, 1.1, 1.05],
      [0.06, 0.092, 0.068, 0.04, 1.2, 1.1],
      [0.14, 0.14, 0.117, 0.056, 1.35, 1.25],
      [0.24, 0.182, 0.16, 0.064, 1.5, 1.4],
      [0.35, 0.198, 0.178, 0.064, 1.6, 1.5],
      [0.46, 0.19, 0.168, 0.058, 1.65, 1.55],
      [0.57, 0.155, 0.135, 0.046, 1.6, 1.5],
      [0.68, 0.105, 0.092, 0.031, 1.5, 1.4],
      [0.76, 0.07, 0.064, 0.019, 1.35, 1.3],
      [0.8, 0.06, 0.056, 0.014, 1.3, 1.3],
      [0.82, 0.064, 0.06, 0.009, 1.3, 1.3],
    ],
    nose: 0.01,
    tailRound: 0.01,
    eye: { s: 0.082, y: 0.048, r: 0.027, up: 0.05, fwd: 0.22, iris: '#3c3a2e', irisOut: '#1c1b16', ring: '#6e6a50', pupil: 0.17, irisEnd: 0.31 },
    mouth: { y0: 0.006, sJaw: 0.042, yJaw: 0.004, sag: 0.002, depth: 0.07 },
    gill: { s: 0.27, r0: 0.1, k: 0.08, step: 0.035 },
    lateral: [0.55, 0.1, 0.12],
    scales: { count: 42, color: 0.07, relief: 0.5 },
    wave: { env: [0.16, -0.7, 1.54], k: TAU / 1.05 },
    shade: [[-1, '#d6ae62'], [-0.66, '#c7a45e'], [-0.36, '#8e8a5c'], [-0.02, '#687255'], [0.35, '#4c5744'], [0.7, '#3a4437'], [1, '#2a3129']],
    fins: {
      dorsal1: { s0: 0.33, s1: 0.545, h: [0.035, 0.065, 0.075, 0.077, 0.078, 0.079, 0.08, 0.082, 0.085, 0.088], rake: [0.3, 0.45], rays: 10, spines: 10 },
      dorsal2: { s0: 0.545, s1: 0.775, h: [0.095, 0.115, 0.12, 0.116, 0.105, 0.088, 0.066, 0.042, 0.018], rake: [0.45, 1.1], rays: 12, spines: 0 },
      anal: { s0: 0.5, s1: 0.765, h: [0.025, 0.05, 0.068, 0.085, 0.095, 0.092, 0.08, 0.06, 0.036, 0.014], rake: [0.4, 1.1], rays: 15, spines: 3 },
      caudal: { spread: 0.63, fork: 0.12, roll: 0.35, rays: 17 },
      pectoral: { base: [[0.272, -0.1], [0.28, -0.3]], len: 0.21, shape: [0.5, 0.82, 1.0, 0.93, 0.78, 0.6, 0.46, 0.36, 0.3], out: 0.3, down: -0.08, spread: 0.55, rays: 13 },
      pelvic: { base: [[0.3, -0.86], [0.325, -0.95]], len: 0.1, shape: [0.95, 1.0, 0.88, 0.7, 0.5], out: 0.32, down: 0.95, spread: 0.72, rays: 6, spines: 1 },
    },
    finLook: { membrane: '#5f6451', ray: '#353a2c', base: '#555c45', aBase: 0.9, aTip: 0.55, pectoral: { membrane: '#c2b284', ray: '#8e8058', aBase: 0.5, aTip: 0.2 }, pelvic: { membrane: '#4a4a3c', ray: '#2e2e24' } },
    mat: { rough: 0.38, clearcoat: 0.55, irid: 0.4, silver: 0.22 },
  },

  yellow_perch: {
    style: 'perch',
    profile: [
      [0.0, 0.012, 0.01, 0.013, 1.0, 1.0],
      [0.03, 0.03, 0.026, 0.026, 1.0, 1.0],
      [0.09, 0.058, 0.05, 0.043, 1.05, 1.0],
      [0.18, 0.093, 0.075, 0.056, 1.1, 1.05],
      [0.28, 0.12, 0.092, 0.061, 1.2, 1.05],
      [0.36, 0.124, 0.098, 0.06, 1.25, 1.1],
      [0.46, 0.11, 0.094, 0.055, 1.25, 1.1],
      [0.57, 0.088, 0.078, 0.045, 1.25, 1.15],
      [0.68, 0.064, 0.058, 0.032, 1.2, 1.15],
      [0.78, 0.043, 0.04, 0.02, 1.2, 1.2],
      [0.825, 0.038, 0.036, 0.014, 1.2, 1.2],
      [0.845, 0.042, 0.04, 0.008, 1.2, 1.2],
    ],
    nose: 0.016,
    tailRound: 0.01,
    eye: { s: 0.078, y: 0.03, r: 0.022, up: 0.15, fwd: 0.2, iris: '#9a9244', irisOut: '#4a4a24', ring: '#c8bc66', pupil: 0.15, irisEnd: 0.31 },
    mouth: { y0: 0.001, sJaw: 0.085, yJaw: -0.006, sag: 0.003, depth: 0.08 },
    gill: { s: 0.265, r0: 0.05, k: 0.07, step: 0.035 },
    lateral: [0.55, 0.04, 0.1],
    scales: { count: 60, color: 0.2, relief: 1 },
    wave: SUB_WAVE,
    shade: [[-1, '#efe9d0'], [-0.58, '#e6dba8'], [-0.28, '#cdb65e'], [0.08, '#b89e44'], [0.42, '#86833a'], [0.72, '#5d6428'], [1, '#3e471f']],
    fins: {
      dorsal1: { s0: 0.3, s1: 0.515, h: [0.045, 0.072, 0.08, 0.076, 0.07, 0.062, 0.054, 0.045, 0.036, 0.027, 0.018, 0.01], rake: [0.3, 0.6], rays: 14, spines: 14 },
      dorsal2: { s0: 0.555, s1: 0.72, h: [0.045, 0.058, 0.06, 0.056, 0.049, 0.04, 0.028, 0.014], rake: [0.4, 1.0], rays: 14, spines: 1 },
      anal: { s0: 0.6, s1: 0.71, h: [0.03, 0.052, 0.058, 0.052, 0.042, 0.03, 0.015], rake: [0.5, 1.0], rays: 10, spines: 2 },
      caudal: { spread: 0.58, fork: 0.32, roll: 0.25, rays: 17 },
      pectoral: { base: [[0.268, -0.2], [0.277, -0.42]], len: 0.11, shape: [0.7, 0.93, 1.0, 0.95, 0.85, 0.7, 0.55, 0.42], out: 0.45, down: 0.08, spread: 0.8, rays: 14 },
      pelvic: { base: [[0.29, -0.86], [0.315, -0.95]], len: 0.09, shape: [0.95, 1.0, 0.9, 0.72, 0.5], out: 0.32, down: 0.95, spread: 0.72, rays: 6, spines: 1 },
    },
    finLook: { membrane: '#8e8a5c', ray: '#4a4626', base: '#7d7a44', aBase: 0.9, aTip: 0.52, pectoral: { membrane: '#c9ab5c', ray: '#8f7436', aBase: 0.62, aTip: 0.28 }, pelvic: { membrane: '#d7732e', ray: '#9a4a1a', aBase: 0.92, aTip: 0.5 }, anal: { membrane: '#d27a34', ray: '#96501e', aBase: 0.9, aTip: 0.48 } },
    mat: { rough: 0.4, clearcoat: 0.5, irid: 0.12, silver: 0.2 },
  },

  rainbow_trout: {
    style: 'trout',
    profile: [
      [0.0, 0.013, 0.012, 0.015, 1.0, 1.0],
      [0.03, 0.032, 0.028, 0.028, 1.0, 1.0],
      [0.09, 0.058, 0.052, 0.043, 1.0, 1.0],
      [0.18, 0.083, 0.077, 0.053, 1.05, 1.0],
      [0.3, 0.098, 0.093, 0.057, 1.1, 1.0],
      [0.42, 0.099, 0.094, 0.055, 1.15, 1.05],
      [0.54, 0.086, 0.081, 0.047, 1.15, 1.1],
      [0.66, 0.063, 0.059, 0.034, 1.15, 1.15],
      [0.77, 0.043, 0.041, 0.021, 1.15, 1.15],
      [0.835, 0.037, 0.035, 0.014, 1.15, 1.15],
      [0.855, 0.041, 0.039, 0.008, 1.15, 1.15],
    ],
    nose: 0.02,
    tailRound: 0.01,
    eye: { s: 0.07, y: 0.026, r: 0.018, up: 0.12, fwd: 0.22, iris: '#8e8a74', irisOut: '#3e3c34', ring: '#c8bf96', pupil: 0.17, irisEnd: 0.3 },
    mouth: { y0: 0.0, sJaw: 0.1, yJaw: -0.008, sag: 0.004, depth: 0.08 },
    gill: { s: 0.215, r0: 0.0, k: 0.06, step: 0.03 },
    lateral: [0.25, 0.0, 0.05],
    scales: { count: 130, color: 0.07, relief: 0.45 },
    wave: SUB_WAVE,
    shade: [[-1, '#f0efe8'], [-0.55, '#e3e3da'], [-0.26, '#cbcdc2'], [-0.05, '#b9aca2'], [0.2, '#8f9679'], [0.5, '#617056'], [1, '#3b4a3f']],
    fins: {
      dorsal1: { s0: 0.4, s1: 0.515, h: [0.075, 0.085, 0.08, 0.07, 0.057, 0.045, 0.036, 0.03], rake: [0.35, 0.65], rays: 11, spines: 0 },
      adipose: { s0: 0.7, s1: 0.745, h: 0.024 },
      anal: { s0: 0.63, s1: 0.72, h: [0.065, 0.07, 0.062, 0.05, 0.038, 0.03], rake: [0.4, 0.75], rays: 10, spines: 0 },
      caudal: { spread: 0.58, fork: 0.12, roll: 0.18, rays: 19 },
      pectoral: { base: [[0.222, -0.66], [0.232, -0.84]], len: 0.1, shape: [0.85, 1.0, 0.95, 0.85, 0.72, 0.58, 0.45], out: 0.6, down: 0.3, spread: 0.7, rays: 13 },
      pelvic: { base: [[0.475, -0.86], [0.5, -0.95]], len: 0.07, shape: [1.0, 0.95, 0.82, 0.65, 0.45], out: 0.32, down: 0.95, spread: 0.72, rays: 9 },
    },
    finLook: { membrane: '#8c907c', ray: '#565a48', base: '#7d846e', aBase: 0.9, aTip: 0.52, pectoral: { membrane: '#c2ae94', ray: '#8a7a64', aBase: 0.62, aTip: 0.28 }, pelvic: { membrane: '#c49484', ray: '#86645a', aBase: 0.78, aTip: 0.4 }, anal: { membrane: '#b88e80', ray: '#7c5e54' } },
    mat: { rough: 0.34, clearcoat: 0.55, irid: 0.3, silver: 0.42 },
  },

  walleye: {
    style: 'walleye',
    profile: [
      [0.0, 0.011, 0.01, 0.013, 1.0, 1.0],
      [0.03, 0.027, 0.024, 0.025, 1.0, 1.0],
      [0.09, 0.051, 0.046, 0.04, 1.0, 1.0],
      [0.18, 0.074, 0.067, 0.052, 1.05, 1.0],
      [0.29, 0.09, 0.081, 0.058, 1.05, 1.0],
      [0.4, 0.093, 0.084, 0.057, 1.1, 1.0],
      [0.52, 0.082, 0.075, 0.049, 1.1, 1.05],
      [0.64, 0.062, 0.056, 0.036, 1.15, 1.1],
      [0.75, 0.043, 0.04, 0.023, 1.15, 1.15],
      [0.83, 0.034, 0.032, 0.014, 1.15, 1.15],
      [0.85, 0.038, 0.036, 0.008, 1.15, 1.15],
    ],
    nose: 0.016,
    tailRound: 0.01,
    eye: { s: 0.082, y: 0.028, r: 0.025, up: 0.15, fwd: 0.22, iris: '#a69a6a', irisOut: '#4c4630', ring: '#d2c690', pupilCol: '#5d6a62', pupilCore: '#8e9c90', pupil: 0.15, irisEnd: 0.3 },
    mouth: { y0: 0.001, sJaw: 0.115, yJaw: -0.008, sag: 0.004, depth: 0.08 },
    gill: { s: 0.26, r0: 0.05, k: 0.07, step: 0.035 },
    lateral: [0.4, 0.02, 0.1],
    scales: { count: 90, color: 0.15, relief: 0.8 },
    wave: SUB_WAVE,
    shade: [[-1, '#f1eee4'], [-0.56, '#e2dbc2'], [-0.27, '#b8a472'], [0.04, '#9a8750'], [0.4, '#6f6537'], [0.75, '#4d4a2b'], [1, '#35331f']],
    fins: {
      dorsal1: { s0: 0.31, s1: 0.515, h: [0.04, 0.07, 0.078, 0.076, 0.07, 0.063, 0.056, 0.049, 0.042, 0.035, 0.028, 0.02, 0.013], rake: [0.3, 0.65], rays: 13, spines: 13 },
      dorsal2: { s0: 0.55, s1: 0.745, h: [0.048, 0.062, 0.064, 0.06, 0.053, 0.044, 0.032, 0.016], rake: [0.4, 1.0], rays: 20, spines: 1 },
      anal: { s0: 0.635, s1: 0.745, h: [0.035, 0.058, 0.06, 0.052, 0.042, 0.03, 0.016], rake: [0.45, 0.95], rays: 14, spines: 2 },
      caudal: { spread: 0.58, fork: 0.3, roll: 0.2, rays: 17 },
      pectoral: { base: [[0.265, -0.22], [0.274, -0.44]], len: 0.1, shape: [0.7, 0.93, 1.0, 0.95, 0.85, 0.7, 0.55, 0.42], out: 0.45, down: 0.1, spread: 0.8, rays: 14 },
      pelvic: { base: [[0.29, -0.86], [0.315, -0.95]], len: 0.09, shape: [0.95, 1.0, 0.9, 0.72, 0.5], out: 0.32, down: 0.95, spread: 0.72, rays: 6, spines: 1 },
    },
    finLook: { membrane: '#8e8660', ray: '#46402a', base: '#7c7248', aBase: 0.9, aTip: 0.52, pectoral: { membrane: '#b8a878', ray: '#7e7048', aBase: 0.62, aTip: 0.28 }, pelvic: { membrane: '#a89a70', ray: '#6c6040' } },
    mat: { rough: 0.38, clearcoat: 0.55, irid: 0.2, silver: 0.3 },
  },

  channel_catfish: {
    style: 'catfish',
    // broad, flat head (half width well above the dorsal height, boxy sections) that rises into the humped nape
    profile: [
      [0.0, 0.013, 0.011, 0.034, 0.85, 0.8],
      [0.03, 0.025, 0.021, 0.055, 0.78, 0.68],
      [0.09, 0.04, 0.034, 0.074, 0.74, 0.62],
      [0.17, 0.061, 0.047, 0.083, 0.85, 0.68],
      [0.26, 0.084, 0.066, 0.078, 1.0, 0.8],
      [0.38, 0.091, 0.078, 0.066, 1.1, 0.9],
      [0.5, 0.084, 0.076, 0.053, 1.15, 1.0],
      [0.62, 0.069, 0.063, 0.04, 1.2, 1.1],
      [0.74, 0.05, 0.046, 0.026, 1.2, 1.15],
      [0.81, 0.037, 0.035, 0.016, 1.2, 1.2],
      [0.835, 0.04, 0.038, 0.009, 1.2, 1.2],
    ],
    nose: 0.026,
    tailRound: 0.01,
    eye: { s: 0.085, y: 0.021, r: 0.011, up: 0.3, fwd: 0.15, iris: '#8a7a50', irisOut: '#3a3424', ring: '#b4a472', pupil: 0.16, irisEnd: 0.32 },
    mouth: { y0: -0.004, sJaw: 0.05, yJaw: -0.004, sag: 0.0, depth: 0.1, wide: true },
    gill: { s: 0.215, r0: -0.1, k: 0.06, step: 0.03 },
    lateral: [0.35, 0.0, 0.05],
    scales: null,
    wave: CAT_WAVE,
    shade: [[-1, '#ecebe6'], [-0.66, '#dcdcd6'], [-0.42, '#aeb3b8'], [-0.12, '#848c95'], [0.18, '#5e6771'], [0.5, '#474f59'], [1, '#333a42']],
    fins: {
      dorsal1: { s0: 0.3, s1: 0.375, h: [0.1, 0.096, 0.08, 0.063, 0.046, 0.03, 0.018], rake: [0.4, 0.65], rays: 7, spines: 1, stout: true },
      adipose: { s0: 0.68, s1: 0.77, h: 0.026 },
      anal: { s0: 0.555, s1: 0.8, h: [0.028, 0.048, 0.055, 0.057, 0.057, 0.055, 0.05, 0.04, 0.025, 0.01], rake: [0.45, 0.9], rays: 26, spines: 0 },
      caudal: { spread: 0.63, fork: 0.58, roll: 0.03, rays: 17 },
      pectoral: { base: [[0.205, -0.55], [0.215, -0.72]], len: 0.11, shape: [1.0, 0.97, 0.9, 0.8, 0.68, 0.55], out: 0.9, down: 0.15, spread: 0.55, rays: 9, spines: 1, stout: true },
      pelvic: { base: [[0.49, -0.86], [0.515, -0.95]], len: 0.075, shape: [0.9, 1.0, 0.9, 0.72, 0.5], out: 0.32, down: 0.95, spread: 0.72, rays: 8 },
    },
    finLook: { membrane: '#5e666f', ray: '#373d45', base: '#58606a', aBase: 0.94, aTip: 0.7, pectoral: { membrane: '#666e76', ray: '#3a4048' }, pelvic: { membrane: '#848a92', ray: '#50565e' }, anal: { membrane: '#7c838a', ray: '#474e56' } },
    // [x lateral, y, s along the body]. The long maxillary pair flares out from the corners of the mouth and
    // droops below the head, so it reads in silhouette side-on and fans out seen from above; the nasal pair is
    // short; the four chin barbels hang down under the jaw and are pale (dark maxillary, whitish chin barbels).
    barbels: [
      { a: [0.03, 0.004, 0.035], b: [0.09, -0.01, 0.07], c: [0.13, -0.052, 0.19], r: 0.0068 },
      { a: [0.016, 0.022, 0.028], b: [0.022, 0.036, 0.034], c: [0.03, 0.042, 0.062], r: 0.0028 },
      { a: [0.02, -0.018, 0.035], b: [0.03, -0.04, 0.045], c: [0.04, -0.064, 0.08], r: 0.0035, pale: true },
      { a: [0.008, -0.02, 0.03], b: [0.012, -0.042, 0.038], c: [0.016, -0.06, 0.066], r: 0.0035, pale: true },
    ],
    mat: { rough: 0.3, clearcoat: 0.7, irid: 0.08, silver: 0.26 },
  },

  northern_pike: {
    style: 'pike',
    profile: [
      [0.0, 0.008, 0.008, 0.017, 0.7, 0.8],
      [0.03, 0.014, 0.014, 0.025, 0.7, 0.8],
      [0.08, 0.024, 0.023, 0.031, 0.8, 0.85],
      [0.14, 0.037, 0.036, 0.039, 0.9, 0.9],
      [0.22, 0.054, 0.051, 0.047, 1.0, 0.95],
      [0.34, 0.065, 0.063, 0.053, 1.05, 1.0],
      [0.48, 0.067, 0.066, 0.052, 1.05, 1.0],
      [0.6, 0.062, 0.061, 0.045, 1.1, 1.05],
      [0.7, 0.052, 0.051, 0.034, 1.15, 1.1],
      [0.79, 0.036, 0.035, 0.02, 1.15, 1.15],
      [0.825, 0.033, 0.032, 0.013, 1.15, 1.15],
      [0.845, 0.036, 0.035, 0.008, 1.15, 1.15],
    ],
    nose: 0.008,
    tailRound: 0.01,
    eye: { s: 0.115, y: 0.022, r: 0.016, up: 0.35, fwd: 0.25, embed: 0.55, iris: '#a08634', irisOut: '#4a3c16', ring: '#cfae56', pupil: 0.16, irisEnd: 0.31 },
    mouth: { y0: 0.0, sJaw: 0.13, yJaw: -0.004, sag: 0.002, depth: 0.08 },
    gill: { s: 0.262, r0: 0.0, k: 0.06, step: 0.03 },
    lateral: [0.12, 0.0, 0.02],
    scales: { count: 120, color: 0.12, relief: 0.6 },
    wave: ESOX_WAVE,
    pores: 5,
    shade: [[-1, '#ebe7d0'], [-0.62, '#dcd7b6'], [-0.38, '#a2a676'], [-0.08, '#6f7c48'], [0.3, '#4c5b2e'], [0.66, '#34431f'], [1, '#222c17']],
    fins: {
      dorsal1: { s0: 0.645, s1: 0.765, h: [0.03, 0.056, 0.066, 0.067, 0.063, 0.056, 0.045, 0.03, 0.014], rake: [0.4, 1.0], rays: 17, spines: 0 },
      anal: { s0: 0.665, s1: 0.775, h: [0.03, 0.054, 0.062, 0.061, 0.056, 0.047, 0.035, 0.02], rake: [0.4, 1.0], rays: 15, spines: 0 },
      caudal: { spread: 0.58, fork: 0.3, roll: 0.35, rays: 19 },
      pectoral: { base: [[0.266, -0.7], [0.276, -0.86]], len: 0.075, shape: [0.85, 1.0, 0.95, 0.85, 0.72, 0.58], out: 0.6, down: 0.3, spread: 0.7, rays: 14 },
      pelvic: { base: [[0.495, -0.86], [0.52, -0.95]], len: 0.07, shape: [0.95, 1.0, 0.9, 0.72, 0.5], out: 0.32, down: 0.95, spread: 0.72, rays: 10 },
    },
    finLook: { membrane: '#8e6a3c', ray: '#4e3a1e', base: '#5c5e30', aBase: 0.9, aTip: 0.55, pectoral: { membrane: '#a88a58', ray: '#6e5530', aBase: 0.65, aTip: 0.3 }, pelvic: { membrane: '#9a7446', ray: '#5e4426' } },
    mat: { rough: 0.36, clearcoat: 0.55, irid: 0.14, silver: 0.2 },
  },

  muskellunge: {
    style: 'musky',
    profile: [
      [0.0, 0.0075, 0.0075, 0.016, 0.7, 0.8],
      [0.03, 0.013, 0.013, 0.024, 0.7, 0.8],
      [0.08, 0.022, 0.021, 0.029, 0.8, 0.85],
      [0.14, 0.035, 0.034, 0.036, 0.9, 0.9],
      [0.22, 0.05, 0.048, 0.044, 1.0, 0.95],
      [0.34, 0.061, 0.06, 0.05, 1.05, 1.0],
      [0.48, 0.064, 0.063, 0.049, 1.05, 1.0],
      [0.6, 0.059, 0.058, 0.042, 1.1, 1.05],
      [0.7, 0.049, 0.048, 0.032, 1.15, 1.1],
      [0.79, 0.034, 0.033, 0.019, 1.15, 1.15],
      [0.83, 0.031, 0.03, 0.012, 1.15, 1.15],
      [0.85, 0.034, 0.033, 0.007, 1.15, 1.15],
    ],
    nose: 0.008,
    tailRound: 0.01,
    eye: { s: 0.108, y: 0.021, r: 0.014, up: 0.35, fwd: 0.25, embed: 0.55, iris: '#b0a048', irisOut: '#565020', ring: '#dccc6a', pupil: 0.13, irisEnd: 0.31 },
    mouth: { y0: 0.0, sJaw: 0.125, yJaw: -0.004, sag: 0.002, depth: 0.08 },
    gill: { s: 0.255, r0: 0.0, k: 0.06, step: 0.03 },
    lateral: [0.12, 0.0, 0.02],
    scales: { count: 150, color: 0.1, relief: 0.5 },
    wave: ESOX_WAVE,
    pores: 8,
    shade: [[-1, '#eeeadb'], [-0.6, '#e0dbc4'], [-0.3, '#bab790'], [0.0, '#a0a07a'], [0.35, '#86855f'], [0.7, '#626245'], [1, '#444430']],
    fins: {
      dorsal1: { s0: 0.645, s1: 0.77, h: [0.03, 0.054, 0.062, 0.062, 0.058, 0.05, 0.04, 0.028, 0.012], rake: [0.4, 1.0], rays: 17, spines: 0 },
      anal: { s0: 0.67, s1: 0.78, h: [0.03, 0.052, 0.058, 0.057, 0.052, 0.044, 0.032, 0.018], rake: [0.4, 1.0], rays: 15, spines: 0 },
      caudal: { spread: 0.58, fork: 0.32, roll: 0.06, rays: 19 },
      pectoral: { base: [[0.258, -0.7], [0.268, -0.86]], len: 0.07, shape: [0.85, 1.0, 0.95, 0.85, 0.72, 0.58], out: 0.6, down: 0.3, spread: 0.7, rays: 14 },
      pelvic: { base: [[0.5, -0.86], [0.525, -0.95]], len: 0.068, shape: [0.95, 1.0, 0.9, 0.72, 0.5], out: 0.32, down: 0.95, spread: 0.72, rays: 10 },
    },
    finLook: { membrane: '#8a6448', ray: '#503828', base: '#6a6448', aBase: 0.9, aTip: 0.55, pectoral: { membrane: '#b09070', ray: '#74583c', aBase: 0.65, aTip: 0.3 }, pelvic: { membrane: '#9c7254', ray: '#5e4430' } },
    mat: { rough: 0.36, clearcoat: 0.55, irid: 0.14, silver: 0.28 },
  },
};

// Unknown species: a generic, muted perch-like fish (shape of a bass, olive-grey skin, no species markings).
APPEARANCE.generic = {
  ...APPEARANCE.largemouth_bass,
  style: 'generic',
  eye: { ...APPEARANCE.largemouth_bass.eye, iris: '#9a8a60', irisOut: '#4e4630', ring: '#c8b888' },
  mouth: { ...APPEARANCE.largemouth_bass.mouth, sJaw: 0.1 },
  shade: [[-1, '#e6e4da'], [-0.6, '#d6d4c6'], [-0.3, '#a8aa94'], [0.0, '#868a70'], [0.4, '#63684f'], [1, '#383c2e']],
  finLook: { membrane: '#7e8068', ray: '#4a4c3a', base: '#6e7058', aBase: 0.9, aTip: 0.5 },
  mat: { rough: 0.42, clearcoat: 0.5, irid: 0.1, silver: 0.18 },
};

function resolveAppearanceId(id, name) {
  if (APPEARANCE[id] && id !== 'generic') return id;
  const t = `${id || ''} ${name || ''}`.toLowerCase();
  const rules = [
    [/largemouth/, 'largemouth_bass'], [/smallmouth|spotted bass|rock bass/, 'smallmouth_bass'], [/bass/, 'largemouth_bass'],
    [/musk|musky|muskie|tiger/, 'muskellunge'], [/pike|pickerel/, 'northern_pike'], [/cat|bullhead/, 'channel_catfish'],
    [/walleye|sauger|zander/, 'walleye'], [/perch/, 'yellow_perch'], [/trout|salmon|char|steelhead/, 'rainbow_trout'],
    [/gill|sunfish|pumpkinseed|crappie|bream/, 'bluegill'],
  ];
  for (const [re, target] of rules) if (re.test(t)) return target;
  return 'generic';
}

// ---------------------------------------------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------------------------------------------
// Monotone cubic (Fritsch-Carlson) interpolation: smooth, no overshoot between control points.
function monotone(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const d = new Float64Array(n - 1);
  const m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[lo + 1] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h * m[lo + 1];
  };
}
const arrCurve = (arr) => (arr.length === 1 ? () => arr[0] : monotone(arr.map((_, i) => i / (arr.length - 1)), arr));

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Body model: lofted cross-sections + surface arc-length tables (shared by geometry UVs and skin painting).
// Texture space of the body: u = s / sB (along the body), v = 0.5 + a / C where a is the signed arc length on the
// surface from the lateral midline (up = dorsal). Both flanks share the texture (mirrored), so painting is done
// like a side view, but in true surface distances (spots stay round, scales keep their size).
// ---------------------------------------------------------------------------------------------------------------
function buildModel(app) {
  const P = app.profile;
  const xs = P.map((p) => p[0]);
  const sB = xs[xs.length - 1];
  const fTop = monotone(xs, P.map((p) => p[1]));
  const fBot = monotone(xs, P.map((p) => p[2]));
  const fWid = monotone(xs, P.map((p) => p[3]));
  const fET = monotone(xs, P.map((p) => p[4]));
  const fEB = monotone(xs, P.map((p) => p[5]));
  const nose = app.nose;
  const tailR = app.tailRound;
  const kEnd = (s) => {
    let k = 1;
    if (s < nose) {
      const t = Math.max(0, s / nose);
      k = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    }
    const d = sB - s;
    if (d < tailR) {
      const t = Math.max(0, d / tailR);
      k *= Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    }
    return k;
  };
  const ring = (s) => ({ s, T: fTop(s), B: fBot(s), W: fWid(s), eT: fET(s), eB: fEB(s), k: kEnd(s) });
  const secR = (R, phi, out) => {
    const sp = Math.sin(phi);
    const cp = Math.max(0, Math.cos(phi));
    if (sp >= 0) {
      out.y = R.T * sp * R.k;
      out.x = R.W * Math.pow(cp, R.eT) * R.k;
    } else {
      out.y = R.B * sp * R.k;
      out.x = R.W * Math.pow(cp, R.eB) * R.k;
    }
    return out;
  };
  const sec = (s, phi, out) => secR(ring(s), phi, out);

  // arc-length table
  const NS = 240;
  const NP = 64;
  const arc = new Float32Array((NS + 1) * (NP + 1));
  const A = { x: 0, y: 0 };
  const Bp = { x: 0, y: 0 };
  let maxArc = 0;
  for (let i = 0; i <= NS; i++) {
    const R = ring((sB * i) / NS);
    const row = i * (NP + 1);
    arc[row + NP / 2] = 0;
    let acc = 0;
    secR(R, 0, A);
    for (let j = NP / 2 + 1; j <= NP; j++) {
      secR(R, -HALF_PI + (Math.PI * j) / NP, Bp);
      acc += Math.hypot(Bp.x - A.x, Bp.y - A.y);
      arc[row + j] = acc;
      A.x = Bp.x;
      A.y = Bp.y;
    }
    maxArc = Math.max(maxArc, acc);
    acc = 0;
    secR(R, 0, A);
    for (let j = NP / 2 - 1; j >= 0; j--) {
      secR(R, -HALF_PI + (Math.PI * j) / NP, Bp);
      acc += Math.hypot(Bp.x - A.x, Bp.y - A.y);
      arc[row + j] = -acc;
      A.x = Bp.x;
      A.y = Bp.y;
    }
    maxArc = Math.max(maxArc, acc);
  }
  const arcAt = (s, phi) => {
    const fi = clamp(s / sB, 0, 1) * NS;
    const fj = clamp((phi + HALF_PI) / Math.PI, 0, 1) * NP;
    const i0 = Math.min(NS - 1, Math.floor(fi));
    const j0 = Math.min(NP - 1, Math.floor(fj));
    const ti = fi - i0;
    const tj = fj - j0;
    const a00 = arc[i0 * (NP + 1) + j0];
    const a01 = arc[i0 * (NP + 1) + j0 + 1];
    const a10 = arc[(i0 + 1) * (NP + 1) + j0];
    const a11 = arc[(i0 + 1) * (NP + 1) + j0 + 1];
    return lerp(lerp(a00, a01, tj), lerp(a10, a11, tj), ti);
  };
  const C = 2 * maxArc * 1.03;
  const edgeTop = (s) => fTop(s) * kEnd(s);
  const edgeBot = (s) => fBot(s) * kEnd(s);
  return {
    sB,
    C,
    ring,
    secR,
    sec,
    kEnd,
    top: fTop,
    bot: fBot,
    wid: fWid,
    edgeTop,
    edgeBot,
    arcAt,
    aTop: (s) => arcAt(s, HALF_PI),
    aBot: (s) => -arcAt(s, -HALF_PI),
    // side-view height y (unit L) at station s -> surface arc coordinate a
    aFromY(s, y) {
      const h = y >= 0 ? edgeTop(s) : edgeBot(s);
      if (h <= 1e-6) return 0;
      return arcAt(s, Math.asin(clamp(y / h, -1, 1)));
    },
  };
}

// Opercle (gill cover) posterior margin: s of the edge at relative height r (-1 belly .. 1 back).
const gillEdgeS = (g, r) => g.s - g.k * (r - g.r0) * (r - g.r0);
const mouthY = (m, s) => {
  const t = clamp(s / m.sJaw, 0, 1);
  return lerp(m.y0, m.yJaw, t) - m.sag * Math.sin(Math.PI * t);
};

// ---------------------------------------------------------------------------------------------------------------
// Geometry builder (position, normal, uv, aAnim = [weight (unit-L distance for fins), channel, phase])
// channels: 0 body/eye, 1 pectoral, 2 pelvic, 3 median fins, 4 caudal, 5 gill cover, 6 barbels
// ---------------------------------------------------------------------------------------------------------------
class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.anim = [];
    this.idx = [];
  }
  get count() {
    return this.pos.length / 3;
  }
  vert(x, y, z, nx, ny, nz, u, v, w, ch, ph) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.anim.push(w, ch, ph);
    return this.pos.length / 3 - 1;
  }
  // Triangle whose winding agrees with the stored normal of vertex a (so DoubleSide lighting is right).
  triN(a, b, c) {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const n = this.nrm;
    const dot = cx * (n[a * 3] + n[b * 3] + n[c * 3]) + cy * (n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1]) + cz * (n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]);
    if (dot >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
  // Area-weighted smooth normals for the vertices in [v0, count) using the triangles from index i0 on.
  smoothNormals(v0, i0) {
    const p = this.pos;
    const n = this.nrm;
    for (let v = v0; v < this.count; v++) n[v * 3] = n[v * 3 + 1] = n[v * 3 + 2] = 0;
    for (let i = i0; i < this.idx.length; i += 3) {
      const a = this.idx[i], b = this.idx[i + 1], c = this.idx[i + 2];
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      for (const k of [a, b, c]) {
        n[k * 3] += cx;
        n[k * 3 + 1] += cy;
        n[k * 3 + 2] += cz;
      }
    }
    for (let v = v0; v < this.count; v++) {
      const l = Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]) || 1;
      n[v * 3] /= l;
      n[v * 3 + 1] /= l;
      n[v * 3 + 2] /= l;
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aAnim', new THREE.Float32BufferAttribute(this.anim, 3));
    g.setIndex(this.idx);
    // The swim wave moves vertices outside the rest pose: use a generous, fixed bound (unit length fish).
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -0.48), 0.7);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.35, -0.4, -1.05), new THREE.Vector3(0.35, 0.4, 0.05));
    return g;
  }
}

// UV mapper for a pixel rect R inside a canvas of size cw x ch: (u 0..1 across, v 0..1 bottom->top) -> texture uv
function rectUV(R, cw, ch) {
  return (u, v, out) => {
    out[0] = (R.x + u * R.w) / cw;
    out[1] = 1 - (R.y + (1 - v) * R.h) / ch;
    return out;
  };
}

function buildBody(B, model, app, nRing, nSeg, uvMap) {
  const sB = model.sB;
  const g = app.gill;
  const m = app.mouth;
  // ring stations: denser at the snout, around the gill cover and at the peduncle
  const N = 600;
  const cum = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const s = (sB * (i - 0.5)) / N;
    const dens = 1 + 2.4 * Math.exp(-s / 0.05) + 0.9 * Math.exp(-(((s - g.s) / 0.04) ** 2)) + 1.1 * Math.exp(-(sB - s) / 0.025);
    cum[i] = cum[i - 1] + dens;
  }
  const stations = [];
  for (let r = 0; r < nRing; r++) {
    const target = (cum[N] * r) / (nRing - 1);
    let i = 0;
    while (i < N && cum[i + 1] < target) i++;
    const f = cum[i + 1] > cum[i] ? (target - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    stations.push(clamp(((i + f) / N) * sB, 0, sB));
  }
  const v0 = B.count;
  const i0 = B.idx.length;
  const uvo = [0, 0];
  const pt = { x: 0, y: 0 };
  uvMap(0, 0.5, uvo);
  const tip = B.vert(0, 0, 0, 0, 0, 1, uvo[0], uvo[1], 0, 0, 0);
  const rings = [];
  for (let r = 1; r < nRing - 1; r++) {
    const s = stations[r];
    const R = model.ring(s);
    const idx = [];
    for (let j = 0; j < nSeg; j++) {
      const th = -HALF_PI + (TAU * j) / nSeg;
      const right = Math.cos(th) >= -1e-9;
      const phi = right ? th : Math.PI - th;
      model.secR(R, phi, pt);
      const rel = Math.sin(phi);
      let x = pt.x;
      const y = pt.y;
      let mod = 0;
      // mouth: a shallow crease along the gape
      if (s < m.sJaw * 1.12) {
        const ym = mouthY(m, s);
        const h = ym >= 0 ? R.T * R.k : R.B * R.k;
        const rm = h > 1e-5 ? clamp(ym / h, -1, 1) : 0;
        const fade = 1 - smoothstep(m.sJaw * 0.95, m.sJaw * 1.12, s);
        const env = fade * smoothstep(0.001, 0.01, s);
        mod += m.depth * Math.exp(-(((rel - rm) / 0.065) ** 2)) * env;
        // upper lip / maxilla stands slightly proud of the cheek
        mod -= (m.lip ?? 0.02) * Math.exp(-(((rel - rm - 0.16) / 0.08) ** 2)) * env;
      }
      // gill cover: the opercle overlaps the body, a small step just behind its margin
      const se = gillEdgeS(g, rel);
      const dd = s - se;
      if (rel > -0.95 && rel < 0.7 && dd > 0 && dd < 0.04) {
        mod += g.step * smoothstep(0, 0.003, dd) * (1 - smoothstep(0.006, 0.04, dd)) * (1 - smoothstep(0.52, 0.7, rel));
      }
      x *= 1 - mod;
      const a = model.arcAt(s, phi);
      uvMap(s / sB, 0.5 + a / model.C, uvo);
      // gill pulse weight: the rear half of the gill cover flares out
      let gw = 0;
      if (rel > -0.8 && rel < 0.6 && s > se - 0.08 && s < se + 0.002) {
        gw = 0.007 * smoothstep(se - 0.08, se - 0.006, s) * (1 - smoothstep(se - 0.002, se + 0.002, s)) * (1 - smoothstep(0.25, 0.6, Math.abs(rel - 0.05)));
      }
      idx.push(B.vert(right ? x : -x, y, -s, 0, 0, 0, uvo[0], uvo[1], gw, gw > 0 ? 5 : 0, 0));
    }
    rings.push(idx);
  }
  uvMap(1, 0.5, uvo);
  const tail = B.vert(0, 0, -sB, 0, 0, -1, uvo[0], uvo[1], 0, 0, 0);
  // Faces: determine the outward winding once from a quad on the right flank (x > 0).
  const pos = B.pos;
  const r0 = rings[Math.floor(rings.length / 2)];
  const r1 = rings[Math.floor(rings.length / 2) + 1];
  const jq = Math.floor(nSeg / 4);
  const P = (k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
  const pa = P(r0[jq]), pb = P(r0[jq + 1]), pc = P(r1[jq + 1]);
  const cxq = (pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]);
  const flip = cxq < 0; // cross.x should point outward (+x) on the right flank
  const tri = (a, b, c) => (flip ? B.idx.push(a, c, b) : B.idx.push(a, b, c));
  for (let j = 0; j < nSeg; j++) {
    const j1 = (j + 1) % nSeg;
    tri(tip, rings[0][j1], rings[0][j]);
    tri(tail, rings[rings.length - 1][j], rings[rings.length - 1][j1]);
    for (let r = 0; r < rings.length - 1; r++) {
      const a = rings[r][j], b = rings[r][j1], c = rings[r + 1][j1], d = rings[r + 1][j];
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  B.smoothNormals(v0, i0);
  // Safety net: the snout pole normal must point forward (+Z) if the winding above is outward.
  const nz = B.nrm[tip * 3 + 2];
  if (nz < 0) {
    for (let i = i0; i < B.idx.length; i += 3) {
      const t = B.idx[i + 1];
      B.idx[i + 1] = B.idx[i + 2];
      B.idx[i + 2] = t;
    }
    B.smoothNormals(v0, i0);
  }
  return { stations };
}

// Generic sheet (fin membrane) on a grid: pointAt(t, r, out[3]); uv via rect mapper; anim via callback.
function addSheet(B, nt, nr, pointAt, uvMap, animAt, hint) {
  const grid = [];
  const p = [0, 0, 0];
  for (let i = 0; i <= nt; i++) {
    for (let k = 0; k <= nr; k++) {
      pointAt(i / nt, k / nr, p);
      grid.push(p[0], p[1], p[2]);
    }
  }
  const G = (i, k, c) => grid[(i * (nr + 1) + k) * 3 + c];
  const uvo = [0, 0];
  const base = B.count;
  for (let i = 0; i <= nt; i++) {
    for (let k = 0; k <= nr; k++) {
      const ia = Math.max(0, i - 1), ib = Math.min(nt, i + 1);
      const ka = Math.max(0, k - 1), kb = Math.min(nr, k + 1);
      let tx = G(ib, k, 0) - G(ia, k, 0), ty = G(ib, k, 1) - G(ia, k, 1), tz = G(ib, k, 2) - G(ia, k, 2);
      let rx = G(i, kb, 0) - G(i, ka, 0), ry = G(i, kb, 1) - G(i, ka, 1), rz = G(i, kb, 2) - G(i, ka, 2);
      if (Math.hypot(rx, ry, rz) < 1e-9) {
        // degenerate ray (zero height): fall back to the fin-wide direction
        rx = G(i, nr, 0) - G(i, 0, 0) + 1e-6;
        ry = G(i, nr, 1) - G(i, 0, 1);
        rz = G(i, nr, 2) - G(i, 0, 2);
      }
      if (Math.hypot(tx, ty, tz) < 1e-9) {
        tx = G(nt, k, 0) - G(0, k, 0);
        ty = G(nt, k, 1) - G(0, k, 1);
        tz = G(nt, k, 2) - G(0, k, 2) + 1e-6;
      }
      let nx = ty * rz - tz * ry, ny = tz * rx - tx * rz, nz = tx * ry - ty * rx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      uvMap(i / nt, k / nr, uvo);
      const an = animAt(i / nt, k / nr);
      B.vert(G(i, k, 0), G(i, k, 1), G(i, k, 2), nx, ny, nz, uvo[0], uvo[1], an[0], an[1], an[2]);
    }
  }
  for (let i = 0; i < nt; i++) {
    for (let k = 0; k < nr; k++) {
      const a = base + i * (nr + 1) + k;
      const b = base + (i + 1) * (nr + 1) + k;
      const c = base + (i + 1) * (nr + 1) + k + 1;
      const d = base + i * (nr + 1) + k + 1;
      B.triN(a, b, c);
      B.triN(a, c, d);
    }
  }
}

const _anim = [0, 0, 0];
function animOut(w, ch, ph) {
  _anim[0] = w;
  _anim[1] = ch;
  _anim[2] = ph;
  return _anim;
}

function addMedianFin(B, model, spec, dorsal, uvMap, nt, nr, channel, wScale) {
  const H = arrCurve(spec.h);
  const up = dorsal ? 1 : -1;
  const rk0 = spec.rake[0];
  const rk1 = spec.rake[1];
  const pointAt = (t, r, out) => {
    const s = lerp(spec.s0, spec.s1, t);
    const edge = dorsal ? model.edgeTop(s) : model.edgeBot(s);
    const y0 = up * edge * 0.975;
    const h = Math.max(0.0005, H(t));
    const rake = lerp(rk0, rk1, t);
    out[0] = 0;
    out[1] = y0 + up * Math.cos(rake) * h * r;
    out[2] = -s - Math.sin(rake) * h * r - h * 0.07 * r * r;
    return out;
  };
  addSheet(B, nt, nr, pointAt, uvMap, (t, r) => animOut(H(t) * r * wScale, channel, t * 2.0), [1, 0, 0]);
}

function addAdipose(B, model, spec, uvMap, nt, nr) {
  const pointAt = (t, r, out) => {
    const s = lerp(spec.s0, spec.s1, t);
    const y0 = model.edgeTop(s) * 0.97;
    const h = spec.h * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.75) + 0.0004;
    const rake = lerp(0.7, 1.25, t);
    out[0] = 0;
    out[1] = y0 + Math.cos(rake) * h * r;
    out[2] = -s - Math.sin(rake) * h * r;
    return out;
  };
  addSheet(B, nt, nr, pointAt, uvMap, (t, r) => animOut(spec.h * r * 0.5, 3, t), [1, 0, 0]);
}

function caudalShape(spec) {
  return (t) => {
    const c = Math.abs(2 * t - 1); // 0 middle rays .. 1 outer rays
    let f = 1 - spec.fork * Math.pow(1 - c, 1.25);
    // lobe tips: rounded (roll > 0) or pointed (roll ~ 0)
    f *= 1 - spec.roll * Math.pow(smoothstep(0.55, 1, c), 2);
    // procurrent rays at the very edges are short
    f *= 0.25 + 0.75 * smoothstep(1.0, 0.9, c);
    return f;
  };
}

function addCaudal(B, model, spec, uvMap, nt, nr) {
  const sB = model.sB;
  const sBase = sB - 0.006;
  const tb = model.edgeTop(sBase - 0.01);
  const bb = model.edgeBot(sBase - 0.01);
  const shape = caudalShape(spec);
  let mx = 0;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    mx = Math.max(mx, shape(t) * Math.cos((t - 0.5) * 2 * spec.spread));
  }
  const L0 = (1 - sBase) / Math.max(0.2, mx);
  const fwd = 0.035;
  const pointAt = (t, r, out) => {
    const c = Math.abs(2 * t - 1);
    const w = Math.pow(Math.max(0, c - 0.75) / 0.25, 2);
    const s = sBase - fwd * w;
    const yLin = lerp(-bb, tb, t);
    const yEdge = t < 0.5 ? -model.edgeBot(s) * 0.96 : model.edgeTop(s) * 0.96;
    const y = lerp(yLin, yEdge, w);
    const th = (t - 0.5) * 2 * spec.spread;
    const len = L0 * shape(t) + fwd * w * 0.9;
    out[0] = 0;
    out[1] = y + Math.sin(th) * len * r;
    out[2] = -s - Math.cos(th) * len * r;
    return out;
  };
  addSheet(B, nt, nr, pointAt, uvMap, (t, r) => animOut(L0 * shape(t) * r, 4, 0), [1, 0, 0]);
  return L0;
}

// Paired fin (pectoral / pelvic) on one side (side = +1 right/+X, -1 left/-X).
function addPairedFin(B, model, spec, side, uvMap, nt, nr, channel, phase) {
  const pt = { x: 0, y: 0 };
  const basePoint = (t, out) => {
    const s = lerp(spec.base[0][0], spec.base[1][0], t);
    const rel = clamp(lerp(spec.base[0][1], spec.base[1][1], t), -0.99, 0.99);
    model.sec(s, Math.asin(rel), pt);
    out[0] = side * pt.x * 0.94;
    out[1] = pt.y;
    out[2] = -s;
    return out;
  };
  const b0 = basePoint(0, [0, 0, 0]);
  const b1 = basePoint(1, [0, 0, 0]);
  const d0 = new THREE.Vector3(side * Math.sin(spec.out) * Math.cos(spec.down), -Math.sin(spec.down), -Math.cos(spec.out) * Math.cos(spec.down)).normalize();
  const bd = new THREE.Vector3(b0[0] - b1[0], b0[1] - b1[1], b0[2] - b1[2]);
  const e = bd.clone().addScaledVector(d0, -bd.dot(d0));
  if (e.lengthSq() < 1e-10) e.set(0, 1, 0);
  e.normalize();
  const nP = new THREE.Vector3().crossVectors(d0, e).normalize();
  if (nP.x * side < 0) nP.negate();
  const shape = arrCurve(spec.shape);
  const bp = [0, 0, 0];
  const pointAt = (t, r, out) => {
    basePoint(t, bp);
    const al = (0.5 - t) * spec.spread;
    const ca = Math.cos(al), sa = Math.sin(al);
    const len = spec.len * shape(t);
    const dx = d0.x * ca + e.x * sa, dy = d0.y * ca + e.y * sa, dz = d0.z * ca + e.z * sa;
    const cup = -0.06 * len * r * r * Math.sin(Math.PI * t);
    out[0] = bp[0] + dx * len * r + nP.x * cup;
    out[1] = bp[1] + dy * len * r + nP.y * cup;
    out[2] = bp[2] + dz * len * r + nP.z * cup;
    return out;
  };
  addSheet(B, nt, nr, pointAt, uvMap, (t, r) => animOut(spec.len * shape(t) * r, channel, phase + t * 0.6), [nP.x, nP.y, nP.z]);
}

// Tapered tube along a quadratic Bezier (catfish barbels).
function addBarbel(B, spec, side, uvMap, nAlong, nAround) {
  const a = spec.a, b = spec.b, c = spec.c;
  const P = (t) => {
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1], -(u * u * a[2] + 2 * u * t * b[2] + t * t * c[2])];
  };
  const base = B.count;
  const uvo = [0, 0];
  let len = 0;
  let prev = P(0);
  const T = new THREE.Vector3();
  const N1 = new THREE.Vector3();
  const N2 = new THREE.Vector3();
  const ref = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= nAlong; i++) {
    const t = i / nAlong;
    const p = P(t);
    const q = P(Math.min(1, t + 0.02));
    const q0 = P(Math.max(0, t - 0.02));
    T.set(q[0] - q0[0], q[1] - q0[1], q[2] - q0[2]).normalize();
    N1.crossVectors(T, ref);
    if (N1.lengthSq() < 1e-8) N1.set(1, 0, 0);
    N1.normalize();
    N2.crossVectors(T, N1).normalize();
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
    const rad = spec.r * lerp(1, 0.18, Math.pow(t, 0.8));
    for (let j = 0; j <= nAround; j++) {
      const an = (TAU * j) / nAround;
      const nx = N1.x * Math.cos(an) + N2.x * Math.sin(an);
      const ny = N1.y * Math.cos(an) + N2.y * Math.sin(an);
      const nz = N1.z * Math.cos(an) + N2.z * Math.sin(an);
      uvMap(j / nAround, t, uvo);
      B.vert(side * (p[0] + nx * rad), p[1] + ny * rad, p[2] + nz * rad, side * nx, ny, nz, uvo[0], uvo[1], len, 6, side > 0 ? 0.3 : 1.9);
    }
  }
  for (let i = 0; i < nAlong; i++) {
    for (let j = 0; j < nAround; j++) {
      const q0 = base + i * (nAround + 1) + j;
      const q1 = base + (i + 1) * (nAround + 1) + j;
      B.triN(q0, q1, q1 + 1);
      B.triN(q0, q1 + 1, q0 + 1);
    }
  }
}

// Eye: a flattened sphere with its pole (the pupil, uv.v = 1) along the optical axis, set into the head.
function eyeFrame(model, eye) {
  const s = eye.s;
  const R = model.ring(s);
  const h = eye.y >= 0 ? R.T * R.k : R.B * R.k;
  const phi = Math.asin(clamp(eye.y / h, -0.98, 0.98));
  const p = { x: 0, y: 0 };
  const pa = { x: 0, y: 0 };
  const pb = { x: 0, y: 0 };
  model.secR(R, phi, p);
  model.secR(R, phi + 0.02, pa);
  model.secR(R, phi - 0.02, pb);
  const ps = { x: 0, y: 0 };
  const pm = { x: 0, y: 0 };
  model.sec(s + 0.004, phi, ps);
  model.sec(s - 0.004, phi, pm);
  const Tphi = new THREE.Vector3(pa.x - pb.x, pa.y - pb.y, 0);
  const Ts = new THREE.Vector3(ps.x - pm.x, ps.y - pm.y, -0.008);
  const n = new THREE.Vector3().crossVectors(Ts, Tphi).normalize();
  if (n.x < 0) n.negate();
  const axis = n.clone();
  axis.z += eye.fwd;
  axis.y += eye.up;
  axis.normalize();
  const surf = new THREE.Vector3(p.x, p.y, -s);
  return { surf, axis };
}

function addEye(B, model, eye, side, uvMap, nLat, nLon) {
  const { surf, axis } = eyeFrame(model, eye);
  const r = eye.r;
  const flat = 0.8;
  const embed = eye.embed ?? 0.42;
  const center = surf.clone().addScaledVector(axis, -embed * r);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const uvo = [0, 0];
  const base = B.count;
  for (let i = 0; i <= nLat; i++) {
    const th = (Math.PI * i) / nLat; // 0 = pupil centre
    for (let j = 0; j <= nLon; j++) {
      const ph = (TAU * j) / nLon;
      const sx = Math.sin(th) * Math.cos(ph);
      const sy = Math.sin(th) * Math.sin(ph);
      const sz = Math.cos(th);
      v.set(sx * r, sy * r, sz * r * flat).applyQuaternion(q).add(center);
      n.set(sx, sy, sz / flat).normalize().applyQuaternion(q);
      uvMap(j / nLon, 1 - i / nLat, uvo);
      B.vert(side * v.x, v.y, v.z, side * n.x, n.y, n.z, uvo[0], uvo[1], 0, 0, 0);
    }
  }
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const a = base + i * (nLon + 1) + j;
      const b = base + (i + 1) * (nLon + 1) + j;
      B.triN(a, b, b + 1);
      B.triN(a, b + 1, a + 1);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Canvas painting
// ---------------------------------------------------------------------------------------------------------------
// Every canvas is CPU-backed (willReadFrequently): thousands of tiny stamps + one texture upload are much cheaper
// in software than through an accelerated canvas that must be flushed and read back.
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext('2d', { willReadFrequently: true });
  return c;
}
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mixHex(h1, h2, t) {
  const a = hexRgb(h1);
  const b = hexRgb(h2);
  const c = a.map((v, i) => Math.round(lerp(v, b[i], t)));
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}

// Irregular blob path (current transform units), filled with the current fillStyle.
function blob(g, x, y, rx, ry, jit, rng, rot = 0) {
  const n = 9;
  const px = new Array(n);
  const py = new Array(n);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n;
    const k = 1 + (rng() - 0.5) * 2 * jit;
    const ox = Math.cos(a) * rx * k;
    const oy = Math.sin(a) * ry * k;
    px[i] = x + ox * cr - oy * sr;
    py[i] = y + ox * sr + oy * cr;
  }
  g.beginPath();
  g.moveTo((px[n - 1] + px[0]) / 2, (py[n - 1] + py[0]) / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    g.quadraticCurveTo(px[i], py[i], (px[i] + px[j]) / 2, (py[i] + py[j]) / 2);
  }
  g.closePath();
  g.fill();
}

function noiseCanvas(cw, ch, rng) {
  const c = makeCanvas(cw, ch);
  const g = c.getContext('2d');
  const img = g.createImageData(c.width, c.height);
  for (let i = 0; i < c.width * c.height; i++) {
    const v = (rng() * 255) | 0;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Paint kit: coordinate helpers for normalized (s, q) space and iso (s, a) space.
function makeKit(model, app, rng, res) {
  const g = app.gill;
  return {
    model,
    app,
    rng,
    res,
    sB: model.sB,
    C: model.C,
    gillS: g.s,
    aQ: (s, q) => (q >= 0 ? q * model.aTop(s) : q * model.aBot(s)),
    aY: (s, y) => model.aFromY(s, y),
  };
}

// Scratch layer the same size as a target canvas that shares its transform; stamp() composites it back with blur.
// Layers are pooled per size (every layer is stamped before the next one is requested) and the pool is dropped
// after each asset build, so painting a 2k skin does not churn through dozens of 8 MB canvases.
const _layerPool = new Map();
function layerLike(canvas, transform) {
  const key = `${canvas.width}x${canvas.height}`;
  let c = _layerPool.get(key);
  if (!c) {
    c = makeCanvas(canvas.width, canvas.height);
    _layerPool.set(key, c);
  }
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.clearRect(0, 0, c.width, c.height);
  g.setTransform(...transform);
  return { c, g };
}
// rect: optional [x, y, w, h] (layer pixels) that holds everything drawn on the layer; only that part is
// composited (and blurred), which is much cheaper for small markings on a 2k layer. Pad it by ~3x the blur.
function stamp(target, L, { blur = 0, alpha = 1, op = 'source-over', x = 0, y = 0, rect = null } = {}) {
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalAlpha = alpha;
  target.globalCompositeOperation = op;
  if (blur > 0.3) target.filter = `blur(${blur.toFixed(2)}px)`;
  if (rect) {
    const W = L.c.width;
    const H = L.c.height;
    const x0 = clamp(Math.floor(rect[0]), 0, W);
    const y0 = clamp(Math.floor(rect[1]), 0, H);
    const x1 = clamp(Math.ceil(rect[0] + rect[2]), 0, W);
    const y1 = clamp(Math.ceil(rect[1] + rect[3]), 0, H);
    if (x1 > x0 && y1 > y0) target.drawImage(L.c, x0, y0, x1 - x0, y1 - y0, x + x0, y + y0, x1 - x0, y1 - y0);
  } else target.drawImage(L.c, x, y);
  target.restore();
}

// Species-specific markings. N(n, K, T): normalized space (s, q) canvas n with transform T.
// I(g, K, T): iso space (s, a) on the skin canvas (transform T, already clipped).
const STYLES = {
  generic: {},
  largemouth: {
    N(n, K, T) {
      const L = layerLike(n.canvas, T);
      L.g.fillStyle = '#212a17';
      let s = K.gillS + 0.004;
      while (s < K.sB - 0.012) {
        const w = 0.01 + K.rng() * 0.016;
        const hq = (0.09 + K.rng() * 0.12) * smoothstep(K.gillS - 0.02, K.gillS + 0.06, s);
        const q = 0.05 + (K.rng() - 0.5) * 0.1;
        blob(L.g, s, q, w, hq, 0.35, K.rng);
        if (K.rng() < 0.55) blob(L.g, s + (K.rng() - 0.5) * 0.012, q + (K.rng() < 0.5 ? 1 : -1) * (hq + 0.04), w * 0.55, hq * 0.5, 0.45, K.rng);
        s += w * (1.15 + K.rng() * 0.6);
      }
      blob(L.g, K.sB - 0.018, 0.04, 0.02, 0.32, 0.2, K.rng);
      stamp(n, L, { blur: 2.5 * K.res, alpha: 0.72 });
      // dark mottling on the upper flank
      const M = layerLike(n.canvas, T);
      M.g.fillStyle = '#28311a';
      for (let i = 0; i < 90; i++) {
        const ss = K.gillS - 0.02 + K.rng() * (K.sB - K.gillS - 0.02);
        blob(M.g, ss, 0.3 + K.rng() * 0.62, 0.005 + K.rng() * 0.012, 0.04 + K.rng() * 0.07, 0.5, K.rng);
      }
      stamp(n, M, { blur: 3 * K.res, alpha: 0.3 });
    },
    I(g, K, T) {
      // dark oblique streaks across the cheek and gill cover
      const e = K.app.eye;
      const L = layerLike(g.canvas, T);
      L.g.strokeStyle = '#27301c';
      L.g.lineCap = 'round';
      const streaks = [
        [e.s + e.r * 1.1, e.y - e.r * 0.3, K.gillS - 0.01, e.y - 0.022, 0.011],
        [e.s + e.r * 1.6, e.y - e.r * 1.6, K.gillS - 0.05, e.y - 0.06, 0.009],
      ];
      for (const [s0, y0, s1, y1, w] of streaks) {
        L.g.lineWidth = w;
        L.g.beginPath();
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const s = lerp(s0, s1, t);
          const a = K.aY(s, lerp(y0, y1, t) + Math.sin(t * 5) * 0.002);
          if (i === 0) L.g.moveTo(s, a);
          else L.g.lineTo(s, a);
        }
        L.g.stroke();
      }
      stamp(g, L, { blur: 6 * K.res, alpha: 0.35 });
    },
  },
  smallmouth: {
    N(n, K, T) {
      const L = layerLike(n.canvas, T);
      L.g.fillStyle = '#33271a';
      const nb = 12;
      for (let i = 0; i < nb; i++) {
        const s = K.gillS + 0.015 + (i * (K.sB - K.gillS - 0.05)) / (nb - 1) + (K.rng() - 0.5) * 0.008;
        let q = 0.92;
        while (q > -0.5) {
          const hq = 0.08 + K.rng() * 0.1;
          blob(L.g, s + (K.rng() - 0.5) * 0.006, q - hq / 2, 0.006 + K.rng() * 0.006, hq * 0.62, 0.3, K.rng);
          q -= hq * (0.75 + K.rng() * 0.5);
        }
      }
      stamp(n, L, { blur: 5 * K.res, alpha: 0.5 });
      const M = layerLike(n.canvas, T);
      M.g.fillStyle = '#2e2718';
      for (let i = 0; i < 60; i++) blob(M.g, K.gillS + K.rng() * (K.sB - K.gillS), 0.45 + K.rng() * 0.5, 0.006 + K.rng() * 0.01, 0.05 + K.rng() * 0.06, 0.5, K.rng);
      stamp(n, M, { blur: 3 * K.res, alpha: 0.25 });
    },
    I(g, K, T) {
      const e = K.app.eye;
      const L = layerLike(g.canvas, T);
      L.g.strokeStyle = '#2b2215';
      L.g.lineCap = 'round';
      // three bars radiating back from the eye across the cheek
      const bars = [
        [e.y + e.r * 0.1, e.y - 0.004, 0.01],
        [e.y - e.r * 0.7, e.y - 0.03, 0.011],
        [e.y - e.r * 1.3, e.y - 0.055, 0.009],
      ];
      for (const [y0, y1, w] of bars) {
        L.g.lineWidth = w;
        L.g.beginPath();
        for (let i = 0; i <= 10; i++) {
          const t = i / 10;
          const s = lerp(e.s + e.r * 0.9, lerp(e.s, K.gillS, 0.8), t);
          const a = K.aY(s, lerp(y0, y1, t));
          if (i === 0) L.g.moveTo(s, a);
          else L.g.lineTo(s, a);
        }
        L.g.stroke();
      }
      stamp(g, L, { blur: 5 * K.res, alpha: 0.55 });
      flecks(g, K, 500, '#c9a45a', 0.22, 0.0012, 0.0028, -0.5, 0.8);
    },
  },
  bluegill: {
    N(n, K, T) {
      const G = layerLike(n.canvas, T);
      G.g.fillStyle = '#dc8a2c';
      blob(G.g, 0.2, -0.85, 0.15, 0.5, 0.1, K.rng);
      blob(G.g, 0.38, -0.9, 0.14, 0.35, 0.1, K.rng);
      stamp(n, G, { blur: 30 * K.res, alpha: 0.62 });
      const L = layerLike(n.canvas, T);
      L.g.fillStyle = '#243027';
      for (let i = 0; i < 7; i++) {
        const s = 0.3 + i * 0.07 + (K.rng() - 0.5) * 0.01;
        L.g.beginPath();
        L.g.moveTo(s - 0.022, 1.05);
        L.g.lineTo(s + 0.022, 1.05);
        L.g.lineTo(s + 0.014, -0.2);
        L.g.lineTo(s + 0.004, -0.6);
        L.g.lineTo(s - 0.012, -0.2);
        L.g.closePath();
        L.g.fill();
      }
      stamp(n, L, { blur: 9 * K.res, alpha: 0.32 });
      // faint violet-blue cast on the upper flank
      const V = layerLike(n.canvas, T);
      V.g.fillStyle = '#5c5f86';
      V.g.fillRect(0.12, 0.15, K.sB, 0.75);
      stamp(n, V, { blur: 20 * K.res, alpha: 0.2, op: 'soft-light' });
    },
    I(g, K, T) {
      const gl = K.app.gill;
      // blue cheek lines from the chin toward the gill margin
      const L = layerLike(g.canvas, T);
      L.g.strokeStyle = '#6f8fb8';
      L.g.lineCap = 'round';
      L.g.lineWidth = 0.0035;
      for (const [y0, y1] of [[-0.006, -0.02], [-0.02, -0.05]]) {
        L.g.beginPath();
        for (let i = 0; i <= 10; i++) {
          const t = i / 10;
          const s = lerp(0.03, gl.s - 0.03, t);
          const a = K.aY(s, lerp(y0, y1, t) - Math.sin(t * Math.PI) * 0.006);
          if (i === 0) L.g.moveTo(s, a);
          else L.g.lineTo(s, a);
        }
        L.g.stroke();
      }
      stamp(g, L, { blur: 1.5 * K.res, alpha: 0.5 });
      // the black "ear" flap at the rear of the gill cover
      // the opercular "ear" flap: a black tab continuing the gill cover backward, with a thin pale rim
      const E = layerLike(g.canvas, T);
      const yE = 0.02;
      const sE = gillEdgeS(gl, yE / K.model.edgeTop(gl.s));
      const aE = K.aY(sE, yE);
      E.g.fillStyle = 'rgba(190,176,120,1)';
      E.g.beginPath();
      E.g.ellipse(sE + 0.004, aE, 0.02, 0.0135, -0.08, 0, TAU);
      E.g.fill();
      E.g.fillStyle = '#060708';
      E.g.beginPath();
      E.g.ellipse(sE + 0.002, aE, 0.018, 0.0115, -0.08, 0, TAU);
      E.g.fill();
      E.g.beginPath();
      E.g.ellipse(sE - 0.012, aE, 0.014, 0.012, 0, 0, TAU);
      E.g.fill();
      stamp(g, E, { blur: 0.8 * K.res, alpha: 0.95 });
    },
  },
  perch: {
    N(n, K, T) {
      const L = layerLike(n.canvas, T);
      L.g.fillStyle = '#323d17';
      const nb = 7;
      for (let i = 0; i < nb; i++) {
        const s = K.gillS + 0.015 + (i * (K.sB - K.gillS - 0.075)) / (nb - 1) + (K.rng() - 0.5) * 0.012;
        const w = 0.02 + K.rng() * 0.008;
        const qb = i % 2 === 0 ? -0.42 - K.rng() * 0.08 : -0.18 - K.rng() * 0.1;
        L.g.beginPath();
        L.g.moveTo(s - w, 1.05);
        L.g.lineTo(s + w, 1.05);
        L.g.bezierCurveTo(s + w * 0.9, 0.5, s + w * 0.35, 0.1, s + w * 0.05, qb);
        L.g.bezierCurveTo(s - w * 0.2, 0.1, s - w * 0.75, 0.5, s - w, 1.05);
        L.g.fill();
      }
      stamp(n, L, { blur: 4.5 * K.res, alpha: 0.8 });
    },
  },
  trout: {
    N(n, K, T) {
      const L = layerLike(n.canvas, T);
      L.g.fillStyle = '#c86b7a';
      L.g.beginPath();
      const s0 = K.gillS - 0.07;
      L.g.moveTo(s0, 0.1);
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        L.g.lineTo(lerp(s0, K.sB + 0.01, t), 0.2 - 0.05 * t + 0.03 * Math.sin(t * 9));
      }
      for (let i = 20; i >= 0; i--) {
        const t = i / 20;
        L.g.lineTo(lerp(s0, K.sB + 0.01, t), -0.16 + 0.04 * t + 0.02 * Math.sin(t * 7 + 1));
      }
      L.g.closePath();
      L.g.fill();
      stamp(n, L, { blur: 12 * K.res, alpha: 0.62 });
    },
    I(g, K, T) {
      const gl = K.app.gill;
      // rosy gill cover
      const R = layerLike(g.canvas, T);
      R.g.fillStyle = '#c9707a';
      blob(R.g, gl.s - 0.045, K.aY(gl.s - 0.045, 0.0), 0.04, 0.035, 0.15, K.rng);
      stamp(g, R, { blur: 10 * K.res, alpha: 0.55 });
      // small black spots: dense on the back and toward the tail, sparse below the band
      const S = layerLike(g.canvas, T);
      S.g.fillStyle = '#16181a';
      let placed = 0;
      for (let i = 0; i < 8000 && placed < 520; i++) {
        const s = 0.04 + K.rng() * (K.sB - 0.04);
        const q = K.rng() * 2 - 1;
        const tail = s / K.sB;
        const dens = q > 0.12 ? 0.55 + 0.45 * tail : q > -0.2 ? 0.22 * tail : 0.05 * tail;
        if (K.rng() > dens || (s < 0.12 && q < 0.4)) continue;
        const a = K.aQ(s, q);
        const r = 0.0012 + K.rng() * 0.0022;
        blob(S.g, s, a, r * (1 + K.rng() * 0.5), r, 0.45, K.rng, K.rng() * 3);
        placed++;
      }
      stamp(g, S, { blur: 0.7 * K.res, alpha: 0.85 });
    },
  },
  walleye: {
    N(n, K, T) {
      const L = layerLike(n.canvas, T);
      L.g.fillStyle = '#26240f';
      const xs = [0.29, 0.4, 0.5, 0.6, 0.69, 0.78];
      for (const x of xs) {
        const s = x + (K.rng() - 0.5) * 0.015;
        const w = 0.026 + K.rng() * 0.01;
        const qb = 0.02 + K.rng() * 0.15;
        L.g.beginPath();
        L.g.moveTo(s - w, 1.05);
        L.g.lineTo(s + w, 1.05);
        L.g.bezierCurveTo(s + w * 1.1, 0.5, s + w * 0.6, qb + 0.1, s, qb);
        L.g.bezierCurveTo(s - w * 0.6, qb + 0.1, s - w * 1.1, 0.5, s - w, 1.05);
        L.g.fill();
      }
      stamp(n, L, { blur: 6 * K.res, alpha: 0.45 });
      const M = layerLike(n.canvas, T);
      M.g.fillStyle = '#2a2814';
      for (let i = 0; i < 120; i++) blob(M.g, 0.1 + K.rng() * (K.sB - 0.1), -0.1 + K.rng() * 1.0, 0.004 + K.rng() * 0.008, 0.03 + K.rng() * 0.05, 0.5, K.rng);
      stamp(n, M, { blur: 2 * K.res, alpha: 0.28 });
    },
    I(g, K) {
      flecks(g, K, 900, '#d9bf6a', 0.3, 0.001, 0.0024, -0.35, 0.85);
    },
  },
  catfish: {
    I(g, K, T) {
      const S = layerLike(g.canvas, T);
      S.g.fillStyle = '#121416';
      let placed = 0;
      for (let i = 0; i < 2000 && placed < 55; i++) {
        const s = 0.18 + K.rng() * (K.sB - 0.24);
        const q = -0.35 + K.rng() * 0.95;
        const a = K.aQ(s, q);
        const r = 0.0028 + K.rng() * 0.0035;
        blob(S.g, s, a, r, r * (0.8 + K.rng() * 0.4), 0.3, K.rng);
        placed++;
      }
      stamp(g, S, { blur: 1 * K.res, alpha: 0.8 });
    },
  },
  pike: {
    I(g, K, T) {
      // pale, bean-shaped spots in loose horizontal rows (light markings on a dark body)
      const S = layerLike(g.canvas, T);
      S.g.fillStyle = '#cfcd98';
      const rows = [-0.5, -0.32, -0.14, 0.04, 0.22, 0.4, 0.58, 0.74];
      rows.forEach((q, ri) => {
        let s = K.gillS + 0.006 + (ri % 2) * 0.008 + K.rng() * 0.008;
        while (s < K.sB - 0.015) {
          const a = K.aQ(s, q + (K.rng() - 0.5) * 0.07);
          const len = 0.0055 + K.rng() * 0.005;
          const ht = 0.0022 + K.rng() * 0.0014;
          if (K.rng() > 0.1) blob(S.g, s, a, len, ht, 0.3, K.rng, (K.rng() - 0.5) * 0.3);
          s += len * 2 + 0.004 + K.rng() * 0.008;
        }
      });
      stamp(g, S, { blur: 1.1 * K.res, alpha: 0.62 });
      flecks(g, K, 900, '#c9bf78', 0.3, 0.0007, 0.0013, -0.6, 0.9);
      jawPores(g, K);
    },
  },
  musky: {
    N(n, K, T) {
      const L = layerLike(n.canvas, T);
      L.g.fillStyle = '#34321d';
      let s = K.gillS + 0.01;
      while (s < K.sB - 0.015) {
        let q = 0.88;
        const w = 0.004 + K.rng() * 0.004;
        const lean = (K.rng() - 0.5) * 0.02;
        while (q > -0.55) {
          const hq = 0.05 + K.rng() * 0.12;
          if (K.rng() > 0.2) blob(L.g, s + lean * (1 - q), q - hq / 2, w * (0.8 + K.rng() * 0.6), hq * 0.55, 0.35, K.rng);
          q -= hq * (0.9 + K.rng() * 0.5);
        }
        s += 0.024 + K.rng() * 0.012;
      }
      stamp(n, L, { blur: 1.8 * K.res, alpha: 0.68 });
    },
    I(g, K, T) {
      const S = layerLike(g.canvas, T);
      S.g.fillStyle = '#3a3822';
      for (let i = 0; i < 40; i++) {
        const s = 0.04 + K.rng() * (K.gillS - 0.06);
        const a = K.aQ(s, K.rng() * 1.6 - 0.5);
        blob(S.g, s, a, 0.002 + K.rng() * 0.002, 0.002 + K.rng() * 0.002, 0.3, K.rng);
      }
      stamp(g, S, { blur: 0.8 * K.res, alpha: 0.6 });
      jawPores(g, K);
    },
  },
};

function flecks(g, K, count, color, alpha, r0, r1, q0, q1) {
  const n = Math.round(count * Math.min(1, K.res * 1.2 + 0.1));
  g.save();
  g.fillStyle = color;
  g.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    const s = K.gillS - 0.02 + K.rng() * (K.sB - K.gillS);
    const a = K.aQ(s, lerp(q0, q1, K.rng()));
    const r = lerp(r0, r1, K.rng());
    g.beginPath();
    g.ellipse(s, a, r * 1.3, r, 0, 0, TAU);
    g.fill();
  }
  g.restore();
}

function jawPores(g, K) {
  const m = K.app.mouth;
  const n = K.app.pores || 5;
  g.save();
  g.fillStyle = '#1b1d14';
  g.globalAlpha = 0.7;
  for (let i = 0; i < n; i++) {
    const s = lerp(0.025, m.sJaw * 0.8, i / Math.max(1, n - 1));
    const y = mouthY(m, s) - 0.006 - 0.004 * (s / m.sJaw);
    g.beginPath();
    g.ellipse(s, K.aY(s, y), 0.0016, 0.0012, 0, 0, TAU);
    g.fill();
  }
  g.restore();
}

// Scale sprites (drawn once, stamped thousands of times).
let _scaleSprites = null;
function scaleSprites() {
  if (_scaleSprites) return _scaleSprites;
  const col = makeCanvas(64, 64);
  const c = col.getContext('2d');
  c.translate(32, 32);
  // exposed field: faint light sheen, darker pigmented posterior rim
  const rg = c.createRadialGradient(-6, 0, 2, 0, 0, 28);
  rg.addColorStop(0, 'rgba(255,255,240,0.28)');
  rg.addColorStop(0.7, 'rgba(255,255,240,0.05)');
  rg.addColorStop(1, 'rgba(255,255,240,0)');
  c.fillStyle = rg;
  c.beginPath();
  c.arc(0, 0, 27, 0, TAU);
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.lineWidth = 4.5;
  c.beginPath();
  c.arc(-3, 0, 25, -1.25, 1.25);
  c.stroke();
  const hgt = makeCanvas(64, 64);
  const h = hgt.getContext('2d');
  h.translate(32, 32);
  const lg = h.createLinearGradient(-28, 0, 26, 0);
  lg.addColorStop(0, '#5a5a5a');
  lg.addColorStop(0.75, '#a8a8a8');
  lg.addColorStop(1, '#b8b8b8');
  h.fillStyle = lg;
  h.beginPath();
  h.arc(0, 0, 28, 0, TAU);
  h.fill();
  _scaleSprites = { col, hgt };
  return _scaleSprites;
}

// Canvas 2D defers drawing until the canvas is read: reading one pixel makes the pending work happen now, so
// each build step pays for its own painting instead of piling it onto the step that first reads the canvas.
function flush(...ctxs) {
  for (const c of ctxs) {
    if (!c) continue;
    try {
      c.getImageData(0, 0, 1, 1);
    } catch {
      /* ignore */
    }
  }
}

// Run a step generator to completion (synchronous build) and return its value.
function drain(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

// Paint the body skin into rect R of context g (colour), optionally the height (relief) map into hg (rect HR).
// A generator: it yields between phases (never while a pooled scratch layer is checked out) so the hooked-fish
// assets can be painted a few milliseconds per frame; drain() runs it in one go.
function* paintSkinGen(g, R, model, app, rng, hg, HR) {
  const W = R.w;
  const H = R.h;
  const sB = model.sB;
  const C = model.C;
  const res = W / 2048;
  const K = makeKit(model, app, rng, res);
  const style = STYLES[app.style] || STYLES.generic;

  // --- 1) normalized (s, q) canvas: countershading + markings that follow the body outline
  const hN = Math.max(64, Math.round(H / 2));
  const N = makeCanvas(W, hN);
  const n = N.getContext('2d');
  const TN = [W / sB, 0, 0, -hN / 2, 0, hN / 2];
  n.setTransform(...TN);
  const grad = n.createLinearGradient(0, -1, 0, 1);
  for (const [q, c] of app.shade) grad.addColorStop((q + 1) / 2, c);
  n.fillStyle = grad;
  n.fillRect(-0.1, -1.1, sB + 0.2, 2.2);
  // head: slightly darker, warmer top; the snout/lips a little paler below
  const HL = layerLike(N, TN);
  const hgr = HL.g.createLinearGradient(0, 0, K.gillS, 0);
  hgr.addColorStop(0, 'rgba(0,0,0,0.22)');
  hgr.addColorStop(1, 'rgba(0,0,0,0)');
  HL.g.fillStyle = hgr;
  HL.g.fillRect(0, 0.2, K.gillS, 0.9);
  stamp(n, HL, { blur: 6 * res, alpha: 0.8 });
  flush(n);
  yield 'skin:base';
  if (style.N) {
    style.N(n, K, TN);
    flush(n);
    yield 'skin:styleN';
  }
  // large-scale mottling (soft-light noise)
  const nz = noiseCanvas(48, 10, rng);
  n.save();
  n.setTransform(1, 0, 0, 1, 0, 0);
  n.globalCompositeOperation = 'soft-light';
  n.globalAlpha = 0.22;
  n.filter = `blur(${(5 * res).toFixed(1)}px)`;
  n.drawImage(nz, 0, 0, W, hN);
  n.restore();
  flush(n);
  yield 'skin:noise';
  // --- 2) warp the normalized canvas onto the iso (true surface distance) layout, column by column
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = true;
  const half = hN / 2;
  const yMid = R.y + H / 2;
  for (let px = 0; px < W; px++) {
    if (px > 0 && (px & 255) === 0) {
      flush(g);
      yield 'skin:warp';
    }
    const s = ((px + 0.5) / W) * sB;
    const yT = yMid - (model.aTop(s) / C) * H;
    const yB = yMid + (model.aBot(s) / C) * H;
    const x = R.x + px;
    g.drawImage(N, px, 0, 1, 1, x, R.y, 1, Math.max(0, yT - R.y) + 1);
    g.drawImage(N, px, hN - 1, 1, 1, x, yB - 1, 1, R.y + H - yB + 1);
    g.drawImage(N, px, 0, 1, half, x, yT, 1, Math.max(0.5, yMid - yT));
    g.drawImage(N, px, half, 1, half, x, yMid, 1, Math.max(0.5, yB - yMid));
  }
  g.restore();
  flush(g);
  yield 'skin:warped';
  // --- 3) iso painting
  const TI = [W / sB, 0, 0, -H / C, R.x, R.y + H / 2];
  g.save();
  g.beginPath();
  g.rect(R.x, R.y, R.w, R.h);
  g.clip();
  g.setTransform(...TI);
  // fine mottling
  const nz2 = noiseCanvas(160, 40, rng);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'soft-light';
  g.globalAlpha = 0.22;
  g.filter = `blur(${(1.5 * res + 0.3).toFixed(1)}px)`;
  g.drawImage(nz2, R.x, R.y, W, H);
  g.restore();

  // species markings on the true surface (spots, flaps, cheek bars)
  if (style.I) {
    // iso layers are made relative to the canvas origin, so give them the full transform
    style.I(g, K, TI);
  }
  flush(g);
  yield 'skin:styleI';
  const eye = app.eye;
  const mouth = app.mouth;
  const gl = app.gill;
  const HT = hg ? [HR.w / sB, 0, 0, -HR.h / C, HR.x, HR.y + HR.h / 2] : null;
  if (hg) {
    hg.save();
    hg.setTransform(1, 0, 0, 1, 0, 0);
    hg.fillStyle = '#808080';
    hg.fillRect(HR.x, HR.y, HR.w, HR.h);
    hg.beginPath();
    hg.rect(HR.x, HR.y, HR.w, HR.h);
    hg.clip();
    hg.setTransform(...HT);
  }

  // scales
  const sc = app.scales;
  if (sc && sc.count > 0) {
    const Ls = (sB - gl.s) / sc.count;
    const rowH = Ls * 0.8;
    const pxPerScale = (Ls / sB) * W;
    const spr = scaleSprites();
    const cols = Math.ceil(sB / Ls);
    const maxRows = Math.ceil(C / 2 / rowH) + 1;
    const drawColour = pxPerScale >= 4;
    const drawHeight = hg && (Ls / sB) * HR.w >= 3;
    if (drawColour) g.globalAlpha = sc.color;
    for (let ci = cols; ci >= 0; ci--) {
      if (ci !== cols && ci % 12 === 0) {
        flush(g, hg);
        yield 'skin:scales';
      }
      const s = ci * Ls;
      if (s > sB - 0.004) continue;
      const aT = model.aTop(s);
      const aB = model.aBot(s);
      for (let ri = -maxRows; ri <= maxRows; ri++) {
        const a = (ri + (ci % 2) * 0.5) * rowH;
        if (a > aT - rowH * 0.3 || a < -aB + rowH * 0.3) continue;
        // head: scales only behind the gill cover (and faintly on the cheek)
        const yRel = a >= 0 ? a / Math.max(1e-4, aT) : a / Math.max(1e-4, aB);
        const se = gillEdgeS(gl, yRel);
        if (s < se - 0.004) {
          const cheek = s > eye.s + eye.r * 1.4 && s < se - 0.012 && yRel < 0.35 && yRel > -0.5;
          if (!cheek || app.style === 'trout' || app.style === 'catfish') continue;
          if (drawColour) {
            g.globalAlpha = sc.color * 0.5;
            g.drawImage(spr.col, s - Ls * 0.4, a - rowH * 0.5, Ls * 0.8, rowH);
            g.globalAlpha = sc.color;
          }
          continue;
        }
        const fadeEdge = 1 - smoothstep(0.82, 1.0, Math.abs(yRel));
        // pigmented scale margins are strongest on the back, faint on the pale belly; break up the grid a little
        const js = (rng() - 0.5) * Ls * 0.16;
        const ja = (rng() - 0.5) * rowH * 0.16;
        const var_ = 0.7 + rng() * 0.6;
        if (drawColour) {
          g.globalAlpha = sc.color * (0.35 + 0.65 * fadeEdge) * lerp(0.4, 1.15, (yRel + 1) / 2) * var_;
          g.drawImage(spr.col, s + js - Ls * 0.62, a + ja - rowH * 0.72, Ls * 1.3, rowH * 1.44);
        }
        if (drawHeight) {
          hg.globalAlpha = 0.9 * sc.relief;
          hg.drawImage(spr.hgt, s + js - Ls * 0.66, a + ja - rowH * 0.74, Ls * 1.34, rowH * 1.48);
        }
      }
    }
    g.globalAlpha = 1;
    if (hg) hg.globalAlpha = 1;
    flush(g, hg);
    yield 'skin:scales-done';
  } else {
    // scaleless (catfish): fine skin grain
    const nz3 = noiseCanvas(512, 128, rng);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'soft-light';
    g.globalAlpha = 0.12;
    g.drawImage(nz3, R.x, R.y, W, H);
    g.restore();
    if (hg) {
      hg.save();
      hg.setTransform(1, 0, 0, 1, 0, 0);
      hg.globalAlpha = 0.25;
      hg.filter = 'blur(1px)';
      hg.drawImage(nz3, HR.x, HR.y, HR.w, HR.h);
      hg.restore();
    }
  }
  // lateral line
  const [q0, q1, arch] = app.lateral;
  const llQ = (s) => {
    const t = clamp((s - gl.s) / (sB - gl.s), 0, 1);
    return lerp(q0, q1, t) + arch * Math.sin(Math.PI * Math.pow(t, 0.7)) * (1 - t * 0.3);
  };
  const Lsl = sc && sc.count ? (sB - gl.s) / sc.count : 0.01;
  g.save();
  g.lineCap = 'round';
  g.strokeStyle = app.style === 'catfish' ? 'rgba(210,214,218,0.18)' : 'rgba(235,232,210,0.26)';
  g.lineWidth = 0.0016;
  g.beginPath();
  for (let s = gl.s + 0.004; s <= sB - 0.008; s += 0.004) {
    const a = K.aQ(s, llQ(s));
    if (s === gl.s + 0.004) g.moveTo(s, a);
    else g.lineTo(s, a);
  }
  g.stroke();
  if (app.style !== 'catfish') {
    g.fillStyle = 'rgba(30,30,20,0.35)';
    for (let s = gl.s + 0.006; s <= sB - 0.01; s += Lsl) {
      g.beginPath();
      g.ellipse(s, K.aQ(s, llQ(s)), Lsl * 0.28, Lsl * 0.1, 0, 0, TAU);
      g.fill();
    }
  }
  g.restore();
  if (hg) {
    hg.save();
    hg.strokeStyle = 'rgba(60,60,60,0.8)';
    hg.lineWidth = 0.0018;
    hg.beginPath();
    for (let s = gl.s + 0.004; s <= sB - 0.008; s += 0.004) {
      const a = K.aQ(s, llQ(s));
      if (s === gl.s + 0.004) hg.moveTo(s, a);
      else hg.lineTo(s, a);
    }
    hg.stroke();
    hg.restore();
  }

  flush(g, hg);
  yield 'skin:lateral';
  // gill cover (opercle) margin + preopercle
  const opPath = (ctx, ds) => {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const r = lerp(0.46, -0.92, i / 40);
      const s = gillEdgeS(gl, r) + ds;
      const y = r >= 0 ? r * model.edgeTop(s) : r * model.edgeBot(s);
      const a = model.aFromY(s, y);
      if (i === 0) ctx.moveTo(s, a);
      else ctx.lineTo(s, a);
    }
  };
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(14,14,8,0.42)';
  g.lineWidth = 0.003;
  opPath(g, 0.0012);
  g.stroke();
  g.strokeStyle = 'rgba(255,250,225,0.16)';
  g.lineWidth = 0.0022;
  opPath(g, -0.0022);
  g.stroke();
  // preopercle: vertical limb behind the eye, lower limb curving forward toward the jaw angle
  const sPre = lerp(eye.s + eye.r, gl.s, 0.42);
  const sPreLow = Math.max(mouth.sJaw + 0.008, sPre - 0.05);
  g.strokeStyle = 'rgba(20,18,10,0.14)';
  g.lineWidth = 0.0022;
  g.beginPath();
  for (let i = 0; i <= 30; i++) {
    const r = lerp((eye.y - eye.r * 0.6) / model.edgeTop(sPre), -0.9, i / 30);
    const s = lerp(sPre, sPreLow, Math.pow(smoothstep(-0.25, -0.9, r), 1.5));
    const y = r >= 0 ? r * model.edgeTop(s) : r * model.edgeBot(s);
    const a = model.aFromY(s, y);
    if (i === 0) g.moveTo(s, a);
    else g.lineTo(s, a);
  }
  g.stroke();

  // mouth: gape line, lip highlight, maxilla outline
  const mouthPath = (ctx, dy, s0 = 0.002, s1 = mouth.sJaw) => {
    ctx.beginPath();
    for (let i = 0; i <= 30; i++) {
      const s = lerp(s0, s1, i / 30);
      const a = model.aFromY(s, mouthY(mouth, s) + dy);
      if (i === 0) ctx.moveTo(s, a);
      else ctx.lineTo(s, a);
    }
  };
  // lower jaw and throat are paler than the cheek
  {
    const LJ = layerLike(g.canvas, TI);
    LJ.g.fillStyle = mixHex(app.shade[0][1], '#ffffff', 0.25);
    LJ.g.beginPath();
    let sMax = 0;
    let aMin = Infinity;
    let aMax = -Infinity;
    const pt = (s, a) => {
      LJ.g.lineTo(s, a);
      sMax = Math.max(sMax, s);
      aMin = Math.min(aMin, a);
      aMax = Math.max(aMax, a);
    };
    for (let i = 0; i <= 24; i++) {
      const s = lerp(0.0, mouth.sJaw * 1.05, i / 24);
      pt(s, model.aFromY(s, mouthY(mouth, s) - 0.003));
    }
    for (let i = 24; i >= 0; i--) {
      const s = lerp(0.0, gl.s - 0.05, i / 24);
      pt(s, -model.aBot(s) - 0.01);
    }
    LJ.g.closePath();
    LJ.g.fill();
    // only the jaw's corner of the layer is blurred and composited (a small part of a 2k skin)
    const blurPx = 14 * res;
    const pad = blurPx * 3 + 2;
    const px0 = R.x - pad;
    const px1 = R.x + (sMax * W) / sB + pad;
    const py0 = R.y + H / 2 - (aMax * H) / C - pad;
    const py1 = R.y + H / 2 - (aMin * H) / C + pad;
    stamp(g, LJ, { blur: blurPx, alpha: mouth.wide ? 0.2 : 0.38, rect: [px0, py0, px1 - px0, py1 - py0] });
  }
  flush(g);
  yield 'skin:jaw';
  g.strokeStyle = 'rgba(18,14,10,0.8)';
  g.lineWidth = mouth.wide ? 0.004 : 0.0034;
  mouthPath(g, 0);
  g.stroke();
  g.strokeStyle = 'rgba(235,228,205,0.12)';
  g.lineWidth = 0.0024;
  mouthPath(g, -0.004);
  g.stroke();
  if (!mouth.wide) {
    g.strokeStyle = 'rgba(20,18,10,0.3)';
    g.lineWidth = 0.0016;
    mouthPath(g, 0.0075, mouth.sJaw * 0.35, mouth.sJaw * 0.98);
    g.stroke();
    // rounded rear of the maxilla
    g.beginPath();
    const sj = mouth.sJaw;
    g.ellipse(sj - 0.004, model.aFromY(sj, mouthY(mouth, sj) + 0.004), 0.006, 0.0045, 0, -HALF_PI, HALF_PI);
    g.stroke();
  }
  // nostrils
  g.fillStyle = 'rgba(12,12,10,0.7)';
  for (const [ds, dy, rr] of [[-1.7, 0.25, 0.0022], [-1.25, 0.45, 0.0018]]) {
    const s = eye.s + ds * eye.r;
    g.beginPath();
    g.ellipse(s, model.aFromY(s, eye.y + dy * eye.r), rr * 1.2, rr, 0, 0, TAU);
    g.fill();
  }
  // eye socket: soft dark ring under the eyeball rim
  const ea = model.aFromY(eye.s, eye.y);
  const er = g.createRadialGradient(eye.s, ea, eye.r * 0.75, eye.s, ea, eye.r * 1.2);
  er.addColorStop(0, 'rgba(10,10,8,0.7)');
  er.addColorStop(0.6, 'rgba(10,10,8,0.3)');
  er.addColorStop(1, 'rgba(10,10,8,0)');
  g.fillStyle = er;
  g.beginPath();
  g.arc(eye.s, ea, eye.r * 1.25, 0, TAU);
  g.fill();
  g.restore();

  if (hg) {
    // gill cover edge as a relief step, mouth as a groove
    hg.lineCap = 'round';
    hg.strokeStyle = 'rgba(30,30,30,0.9)';
    hg.lineWidth = 0.003;
    opPath(hg, 0.0015);
    hg.stroke();
    hg.strokeStyle = 'rgba(200,200,200,0.6)';
    hg.lineWidth = 0.003;
    opPath(hg, -0.002);
    hg.stroke();
    hg.strokeStyle = 'rgba(20,20,20,0.9)';
    hg.lineWidth = 0.003;
    mouthPath(hg, 0);
    hg.stroke();
    // maxilla plate outline and the preopercle edge: shallow bony steps on the cheek
    if (!mouth.wide) {
      hg.strokeStyle = 'rgba(70,70,70,0.7)';
      hg.lineWidth = 0.002;
      mouthPath(hg, 0.0075, mouth.sJaw * 0.35, mouth.sJaw * 0.98);
      hg.stroke();
    }
    hg.strokeStyle = 'rgba(80,80,80,0.6)';
    hg.lineWidth = 0.0025;
    hg.beginPath();
    for (let i = 0; i <= 30; i++) {
      const r = lerp((eye.y - eye.r * 0.6) / model.edgeTop(sPre), -0.9, i / 30);
      const s = lerp(sPre, sPreLow, Math.pow(smoothstep(-0.25, -0.9, r), 1.5)) + 0.0015;
      const y = r >= 0 ? r * model.edgeTop(s) : r * model.edgeBot(s);
      const a = model.aFromY(s, y);
      if (i === 0) hg.moveTo(s, a);
      else hg.lineTo(s, a);
    }
    hg.stroke();
    // orbit rim
    hg.strokeStyle = 'rgba(175,175,175,0.6)';
    hg.lineWidth = eye.r * 0.22;
    hg.beginPath();
    hg.arc(eye.s, ea, eye.r * 1.12, 0, TAU);
    hg.stroke();
    hg.restore();
  }
  g.restore();
}

// Roughness (G) / metalness (B) map for the showcase body, derived from the painted skin: the pale lower
// flanks and the gill cover carry guanine "silvering" (metallic sheen); pigment and the back stay dielectric.
function* paintRoughMetalGen(skinCanvas, model, app, w, h) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.drawImage(skinCanvas, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const sB = model.sB;
  const C = model.C;
  const silver = app.mat.silver ?? 0.2;
  const rBack = app.mat.rough;
  const rFlank = Math.max(0.2, app.mat.rough - 0.14);
  const gS = app.gill.s;
  const aT = new Float32Array(w);
  const aB = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const s = ((x + 0.5) / w) * sB;
    aT[x] = Math.max(1e-4, model.aTop(s));
    aB[x] = Math.max(1e-4, model.aBot(s));
  }
  for (let y = 0; y < h; y++) {
    if (y > 0 && (y & 127) === 0) yield 'roughmetal';
    const a = (0.5 - (y + 0.5) / h) * C;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const q = a >= 0 ? a / aT[x] : a / aB[x];
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      const belly = smoothstep(0.55, -0.35, q);
      const s = ((x + 0.5) / w) * sB;
      const cover = s < gS && s > gS - 0.12 ? smoothstep(gS - 0.12, gS - 0.06, s) * smoothstep(0.7, 0.1, q) : 0;
      const metal = silver * Math.max(belly, cover * 0.9) * smoothstep(0.25, 0.7, lum);
      const rough = lerp(rBack, rFlank, Math.max(belly, cover));
      d[i] = 255;
      d[i + 1] = clamp(rough, 0, 1) * 255;
      d[i + 2] = clamp(metal, 0, 1) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function* heightToNormalGen(hc, strength) {
  const w = hc.width;
  const h = hc.height;
  const src = hc.getContext('2d').getImageData(0, 0, w, h).data;
  const out = makeCanvas(w, h);
  const og = out.getContext('2d');
  const img = og.createImageData(w, h);
  const d = img.data;
  const H = (x, y) => src[(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    if (y > 0 && (y & 127) === 0) yield 'normal';
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      let nx = -dx;
      let ny = dy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

// --- fins -----------------------------------------------------------------------------------------------------
const FIN_SLOTS = {
  caudal: [0.0, 0.0, 0.5, 0.5],
  dorsal1: [0.5, 0.0, 0.5, 0.25],
  dorsal2: [0.5, 0.25, 0.5, 0.25],
  anal: [0.0, 0.5, 0.5, 0.25],
  pectoral: [0.5, 0.5, 0.5, 0.25],
  pelvic: [0.0, 0.75, 0.25, 0.25],
  adipose: [0.25, 0.75, 0.25, 0.125],
  barbel: [0.25, 0.875, 0.25, 0.125],
  eye: [0.5, 0.75, 0.25, 0.25],
};
function slotRect(area, name, pad) {
  const f = FIN_SLOTS[name];
  return { x: area.x + f[0] * area.w + pad, y: area.y + f[1] * area.h + pad, w: f[2] * area.w - 2 * pad, h: f[3] * area.h - 2 * pad };
}

function finLookFor(app, name) {
  const base = app.finLook;
  const o = base[name] || {};
  return {
    membrane: o.membrane || base.membrane,
    ray: o.ray || base.ray,
    base: o.base || base.base || base.membrane,
    aBase: o.aBase ?? base.aBase,
    aTip: o.aTip ?? base.aTip,
  };
}

// Paint one fin into rect R: (u across the fin base 0..1, v base 0 -> tip 1).
function paintFin(g, R, name, spec, app, rng, minAlpha) {
  const look = finLookFor(app, name);
  const rays = spec ? spec.rays || 12 : 12;
  const spines = spec ? spec.spines || 0 : 0;
  const T = [R.w, 0, 0, -R.h, R.x, R.y + R.h];
  g.save();
  g.beginPath();
  g.rect(R.x, R.y, R.w, R.h);
  g.clip();
  g.setTransform(...T);
  g.clearRect(-0.1, -0.1, 1.2, 1.2);
  const aB = Math.max(minAlpha, look.aBase);
  const aT = Math.max(minAlpha, look.aTip);
  if (name === 'barbel') {
    // u across the tube. Left half: dark barbels (darker than the slate head so they read against it);
    // right half: pale chin barbels (read against dark water under the head).
    const gr = g.createLinearGradient(0, 0, 0.5, 0);
    gr.addColorStop(0, '#0c0d0f');
    gr.addColorStop(0.5, '#2a2d31');
    gr.addColorStop(1, '#0c0d0f');
    g.fillStyle = gr;
    g.fillRect(-0.1, -0.1, 0.6, 1.2);
    const gp = g.createLinearGradient(0.5, 0, 1, 0);
    gp.addColorStop(0, '#8d8f8a');
    gp.addColorStop(0.5, '#dcdad0');
    gp.addColorStop(1, '#8d8f8a');
    g.fillStyle = gp;
    g.fillRect(0.5, -0.1, 0.6, 1.2);
    g.restore();
    return;
  }
  if (name === 'adipose') {
    const gr = g.createLinearGradient(0, 0, 0, 1);
    gr.addColorStop(0, rgba(look.base, 0.97));
    gr.addColorStop(1, rgba(mixHex(look.base, look.membrane, 0.5), Math.max(minAlpha, 0.8)));
    g.fillStyle = gr;
    g.fillRect(-0.1, -0.1, 1.2, 1.2);
    if (app.style === 'trout') {
      g.fillStyle = 'rgba(20,20,22,0.85)';
      for (let i = 0; i < 6; i++) blob(g, 0.15 + rng() * 0.7, 0.2 + rng() * 0.6, 0.05, 0.08, 0.3, rng);
    }
    edgeFade(g, 0.9, minAlpha);
    g.restore();
    return;
  }
  // membrane: fleshy and more opaque at the base, clear toward the margin
  const gr = g.createLinearGradient(0, 0, 0, 1);
  gr.addColorStop(0, rgba(look.base, aB));
  gr.addColorStop(0.18, rgba(mixHex(look.base, look.membrane, 0.7), lerp(aB, aT, 0.3)));
  gr.addColorStop(0.6, rgba(look.membrane, lerp(aB, aT, 0.75)));
  gr.addColorStop(1, rgba(look.membrane, aT));
  g.fillStyle = gr;
  g.fillRect(-0.1, -0.1, 1.2, 1.2);

  // species markings under the rays
  finMarks(g, name, spec, app, rng, minAlpha);

  const du = 1 / rays;
  const px = 1 / R.w;
  // spines: membrane incised between the tips
  for (let i = 0; i < spines && i < rays - 1; i++) {
    const u0 = (i + 0.5) * du;
    const u1 = (i + 1.5) * du;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = `rgba(0,0,0,${minAlpha > 0.3 ? 0.5 : 0.88})`;
    g.beginPath();
    g.moveTo(u0 + du * 0.12, 1.02);
    g.quadraticCurveTo((u0 + u1) / 2, 0.72, u1 - du * 0.12, 1.02);
    g.closePath();
    g.fill();
    g.restore();
  }
  // rays
  const rayCol = look.ray;
  for (let i = 0; i < rays; i++) {
    const u = (i + 0.5) * du;
    const spine = i < spines;
    const bend = (rng() - 0.5) * du * 0.15;
    const w0 = Math.max(px * 1.2, du * (spine ? (spec && spec.stout && i === 0 ? 0.3 : 0.2) : 0.16));
    if (spine) {
      g.fillStyle = rgba(rayCol, 0.92);
      g.beginPath();
      g.moveTo(u - w0 / 2, 0);
      g.lineTo(u + w0 / 2, 0);
      g.lineTo(u + bend + px * 0.3, 1.0);
      g.lineTo(u + bend - px * 0.3, 1.0);
      g.closePath();
      g.fill();
      // specular edge on the spine
      g.fillStyle = 'rgba(255,250,230,0.25)';
      g.fillRect(u - w0 * 0.1, 0.05, Math.max(px * 0.6, w0 * 0.2), 0.8);
    } else {
      // soft ray: segmented, branching in the outer half
      g.strokeStyle = rgba(rayCol, 0.8);
      g.lineWidth = w0;
      g.lineCap = 'butt';
      g.beginPath();
      g.moveTo(u, 0);
      g.lineTo(u + bend * 0.5, 0.5);
      g.stroke();
      g.lineWidth = w0 * 0.65;
      g.strokeStyle = rgba(rayCol, 0.62);
      const spread = du * 0.22;
      for (const sgn of [-1, 1]) {
        g.beginPath();
        g.moveTo(u + bend * 0.5, 0.5);
        g.quadraticCurveTo(u + bend + sgn * spread * 0.3, 0.75, u + bend + sgn * spread, 0.99);
        g.stroke();
      }
      g.fillStyle = 'rgba(255,250,230,0.10)';
      for (let v = 0.16; v < 0.95; v += 0.055) g.fillRect(u - w0, v, w0 * 2, 0.006);
    }
  }
  edgeFade(g, 0.93, minAlpha);
  g.restore();
}
function edgeFade(g, v0, minAlpha) {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  const e = g.createLinearGradient(0, v0, 0, 1.0);
  e.addColorStop(0, 'rgba(0,0,0,0)');
  e.addColorStop(1, `rgba(0,0,0,${minAlpha > 0.3 ? 0.3 : 0.7})`);
  g.fillStyle = e;
  g.fillRect(-0.1, v0, 1.2, 1.2 - v0);
  g.restore();
}

function finMarks(g, name, spec, app, rng, minAlpha) {
  const st = app.style;
  const dot = (u, v, r, col, a) => {
    g.fillStyle = rgba(col, a);
    blob(g, u, v, r, r * 1.6, 0.35, rng);
  };
  const band = (v0, v1, col, a) => {
    const gr = g.createLinearGradient(0, v0, 0, v1);
    gr.addColorStop(0, rgba(col, 0));
    gr.addColorStop(0.35, rgba(col, a));
    gr.addColorStop(0.65, rgba(col, a));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr;
    g.fillRect(-0.1, v0, 1.2, v1 - v0);
  };
  const soft = (u, v, ru, rv, col, a) => {
    g.save();
    g.translate(u, v);
    g.scale(ru, rv);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    rg.addColorStop(0, rgba(col, a));
    rg.addColorStop(0.6, rgba(col, a * 0.7));
    rg.addColorStop(1, rgba(col, 0));
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0, 0, 1, 0, TAU);
    g.fill();
    g.restore();
  };
  if (st === 'largemouth' || st === 'generic') {
    if (name === 'dorsal2' || name === 'caudal' || name === 'anal') band(0.1, 0.55, '#3a4028', 0.25);
  } else if (st === 'smallmouth') {
    if (name === 'dorsal2' || name === 'caudal' || name === 'anal') {
      band(0.15, 0.45, '#3a2c18', 0.3);
      band(0.55, 0.8, '#3a2c18', 0.2);
    }
  } else if (st === 'bluegill') {
    if (name === 'dorsal2') soft(0.86, 0.22, 0.2, 0.32, '#0c0d0c', 0.85);
    if (name === 'anal' || name === 'pelvic') band(0.35, 1.05, '#1e2019', 0.4);
  } else if (st === 'perch') {
    if (name === 'dorsal1') soft(0.86, 0.45, 0.18, 0.5, '#15170c', 0.75);
    if (name === 'caudal' || name === 'dorsal2') band(0.2, 0.8, '#3c3a1e', 0.2);
  } else if (st === 'trout') {
    if (name === 'dorsal1' || name === 'caudal') {
      const n = name === 'caudal' ? 60 : 22;
      for (let i = 0; i < n; i++) dot(0.05 + rng() * 0.9, 0.08 + rng() * 0.85, name === 'caudal' ? 0.012 : 0.022, '#141618', 0.9);
    }
    if (name === 'anal' || name === 'pelvic') {
      g.fillStyle = 'rgba(245,242,232,0.85)';
      g.fillRect(-0.1, -0.1, 0.16, 1.2);
    }
  } else if (st === 'walleye') {
    if (name === 'dorsal1') soft(0.92, 0.18, 0.18, 0.35, '#0e0f08', 0.9);
    if (name === 'dorsal1' || name === 'dorsal2' || name === 'caudal') {
      for (const v of [0.22, 0.45, 0.68]) {
        for (let i = 0; i < 26; i++) dot(rng(), v + (rng() - 0.5) * 0.08, 0.012, '#26220f', 0.55);
      }
    }
    if (name === 'caudal') soft(0.02, 0.92, 0.22, 0.3, '#f4f2ea', 0.95);
    if (name === 'anal' || name === 'pelvic') soft(0.1, 0.9, 0.3, 0.35, '#f4f2ea', 0.85);
  } else if (st === 'catfish') {
    band(0.8, 1.1, '#23282e', 0.45);
  } else if (st === 'pike' || st === 'musky') {
    if (name === 'dorsal1' || name === 'anal' || name === 'caudal') {
      const n = name === 'caudal' ? 70 : 34;
      const col = st === 'pike' ? '#2c2410' : '#2a1d12';
      for (let i = 0; i < n; i++) dot(rng(), 0.08 + rng() * 0.85, st === 'pike' ? 0.02 : 0.013, col, 0.55);
    }
  }
  void spec;
  void minAlpha;
}

function paintEye(g, R, eye) {
  const T = [R.w, 0, 0, R.h, R.x, R.y]; // (u across, p = polar fraction 0 (pupil centre, top) .. 1)
  g.save();
  g.beginPath();
  g.rect(R.x, R.y, R.w, R.h);
  g.clip();
  g.setTransform(...T);
  const p = eye.pupil;
  const ie = eye.irisEnd;
  const gr = g.createLinearGradient(0, 0, 0, 1);
  const pc = eye.pupilCol || '#050607';
  const pcore = eye.pupilCore || '#0b1418';
  gr.addColorStop(0, pcore);
  gr.addColorStop(p * 0.7, pc);
  gr.addColorStop(p * 0.97, pc);
  gr.addColorStop(p * 1.05, eye.ring);
  gr.addColorStop(p * 1.25, eye.iris);
  gr.addColorStop(ie * 0.85, mixHex(eye.iris, eye.irisOut, 0.5));
  gr.addColorStop(ie, eye.irisOut);
  gr.addColorStop(Math.min(0.99, ie + 0.04), '#141410');
  gr.addColorStop(1, '#141410');
  g.fillStyle = gr;
  g.fillRect(0, 0, 1, 1);
  // radial iris texture: streaks + flecks
  const rng = makeRng(hashString(eye.iris));
  for (let i = 0; i < 90; i++) {
    const u = rng();
    g.fillStyle = rng() < 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,240,200,0.12)';
    g.fillRect(u, p * 1.1, 0.004 + rng() * 0.006, (ie - p * 1.1) * (0.5 + rng() * 0.5));
  }
  // darker upper iris (pigment) on half the circumference
  const ug = g.createLinearGradient(0, 0, 1, 0);
  ug.addColorStop(0, 'rgba(0,0,0,0.25)');
  ug.addColorStop(0.5, 'rgba(0,0,0,0)');
  ug.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = ug;
  g.fillRect(0, p * 1.1, 1, ie - p * 1.1);
  g.restore();
}

// ---------------------------------------------------------------------------------------------------------------
// Assets (geometry + textures) per species/detail/quality, reference counted.
// ---------------------------------------------------------------------------------------------------------------
const DETAIL_CFG = {
  high: {
    high: { ring: 150, seg: 64, finT: 26, finR: 7, eyeLat: 22, eyeLon: 32, bar: [12, 8], tex: 2048, fin: 1024, eyeTex: 256 },
    medium: { ring: 110, seg: 48, finT: 18, finR: 5, eyeLat: 16, eyeLon: 24, bar: [8, 6], tex: 1024, fin: 512, eyeTex: 128 },
    low: { ring: 80, seg: 36, finT: 12, finR: 4, eyeLat: 12, eyeLon: 18, bar: [6, 5], tex: 1024, fin: 512, eyeTex: 128 },
  },
  medium: {
    high: { ring: 60, seg: 22, finT: 10, finR: 3, eyeLat: 8, eyeLon: 12, bar: [5, 4], atlas: 1024 },
    medium: { ring: 48, seg: 18, finT: 8, finR: 2, eyeLat: 6, eyeLon: 10, bar: [4, 4], atlas: 1024 },
    low: { ring: 40, seg: 16, finT: 7, finR: 2, eyeLat: 6, eyeLon: 8, bar: [4, 3], atlas: 512 },
  },
  low: {
    high: { ring: 34, seg: 14, finT: 7, finR: 2, eyeLat: 5, eyeLon: 8, bar: [3, 3], atlas: 512 },
    medium: { ring: 28, seg: 12, finT: 6, finR: 2, eyeLat: 4, eyeLon: 7, bar: [3, 3], atlas: 512 },
    low: { ring: 22, seg: 10, finT: 5, finR: 1, eyeLat: 4, eyeLon: 6, bar: [2, 3], atlas: 256 },
  },
};

const _assets = new Map();

function buildFins(B, model, app, cfg, uvFor) {
  const f = app.fins;
  const nt = cfg.finT;
  const nr = cfg.finR;
  if (f.dorsal1) addMedianFin(B, model, f.dorsal1, true, uvFor('dorsal1'), nt, nr, 3, f.dorsal1.spines >= f.dorsal1.rays ? 0.35 : 1);
  if (f.dorsal2) addMedianFin(B, model, f.dorsal2, true, uvFor('dorsal2'), nt, nr, 3, 1);
  if (f.anal) addMedianFin(B, model, f.anal, false, uvFor('anal'), nt, nr, 3, 1);
  if (f.adipose) addAdipose(B, model, f.adipose, uvFor('adipose'), Math.max(4, nt >> 1), Math.max(1, nr >> 1));
  if (f.caudal) addCaudal(B, model, f.caudal, uvFor('caudal'), Math.max(8, Math.round(nt * 1.2)), nr);
  for (const side of [1, -1]) {
    if (f.pectoral) addPairedFin(B, model, f.pectoral, side, uvFor('pectoral'), Math.max(4, nt >> 1), nr, 1, side > 0 ? 0 : 0.7);
    if (f.pelvic) addPairedFin(B, model, f.pelvic, side, uvFor('pelvic'), Math.max(3, nt >> 2), Math.max(1, nr - 1), 2, side > 0 ? 0.4 : 1.3);
  }
  if (app.barbels) {
    // dark barbels use the left half of the barbel slot, pale ones the right half (see paintFin)
    const uv = uvFor('barbel');
    const dark = (u, v, o) => uv(0.04 + u * 0.42, v, o);
    const pale = (u, v, o) => uv(0.54 + u * 0.42, v, o);
    for (const side of [1, -1]) for (const bspec of app.barbels) addBarbel(B, bspec, side, bspec.pale ? pale : dark, cfg.bar[0], cfg.bar[1]);
  }
}

function makeTexture(canvas, color) {
  const t = new THREE.CanvasTexture(canvas);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// Build the geometry + textures for one species / detail / quality. A generator that yields between steps of a
// few milliseconds each (skin phases, relief, roughness, each fin, each geometry) so hooked-fish assets can be
// prepared over several frames (prepareFishAssets); buildAssets() runs it synchronously.
function* buildAssetsGen(appId, detail, quality) {
  const app = APPEARANCE[appId];
  const cfg = DETAIL_CFG[detail][quality];
  const model = buildModel(app);
  const rng = makeRng(hashString(appId) ^ 0x9e3779b9);
  const out = { model, geos: [], textures: [] };
  yield 'model';

  if (detail === 'high') {
    // colour skin + relief (normal map at half resolution)
    const bw = cfg.tex;
    const bh = bw / 2;
    const bodyC = makeCanvas(bw, bh);
    const hC = makeCanvas(bw / 2, bh / 2);
    yield* paintSkinGen(bodyC.getContext('2d'), { x: 0, y: 0, w: bw, h: bh }, model, app, rng, hC.getContext('2d'), { x: 0, y: 0, w: bw / 2, h: bh / 2 });
    flush(bodyC.getContext('2d'), hC.getContext('2d'));
    yield 'skin-done';
    const nC = yield* heightToNormalGen(hC, 1.7);
    yield 'normal-done';
    const rmC = yield* paintRoughMetalGen(bodyC, model, app, bw / 2, bh / 2);
    yield 'roughmetal-done';
    const fw = cfg.fin;
    const finC = makeCanvas(fw, fw);
    const fg = finC.getContext('2d');
    const area = { x: 0, y: 0, w: fw, h: fw };
    const pad = Math.max(2, fw / 256);
    for (const name of ['caudal', 'dorsal1', 'dorsal2', 'anal', 'pectoral', 'pelvic', 'adipose', 'barbel']) {
      paintFin(fg, slotRect(area, name, pad), name, app.fins[name] || null, app, rng, 0.02);
      flush(fg);
      yield 'fin';
    }
    const ew = cfg.eyeTex;
    const eyeC = makeCanvas(ew, ew / 2);
    paintEye(eyeC.getContext('2d'), { x: 0, y: 0, w: ew, h: ew / 2 }, app.eye);
    out.bodyMap = makeTexture(bodyC, true);
    out.bodyNormal = makeTexture(nC, false);
    out.bodyRM = makeTexture(rmC, false);
    out.finMap = makeTexture(finC, true);
    out.eyeMap = makeTexture(eyeC, true);
    out.eyeMap.wrapS = THREE.RepeatWrapping;
    out.textures.push(out.bodyMap, out.bodyNormal, out.bodyRM, out.finMap, out.eyeMap);
    yield 'textures';

    const bodyB = new GeoBuilder();
    const uvBody = rectUV({ x: 0, y: 0, w: bw, h: bh }, bw, bh);
    buildBody(bodyB, model, app, cfg.ring, cfg.seg, uvBody);
    out.bodyGeo = bodyB.build();
    yield 'body-geo';
    const finB = new GeoBuilder();
    buildFins(finB, model, app, cfg, (name) => rectUV(slotRect(area, name, pad + 1), fw, fw));
    const eyeB = new GeoBuilder();
    const uvEye = rectUV({ x: 0, y: 0, w: ew, h: ew / 2 }, ew, ew / 2);
    for (const side of [1, -1]) addEye(eyeB, model, app.eye, side, uvEye, cfg.eyeLat, cfg.eyeLon);
    out.finGeo = finB.build();
    out.eyeGeo = eyeB.build();
    out.geos.push(out.bodyGeo, out.finGeo, out.eyeGeo);
  } else {
    // single atlas: body in the top half, fins + eye below; ONE geometry
    const S = cfg.atlas;
    const atlasC = makeCanvas(S, S);
    const ag = atlasC.getContext('2d');
    const bodyR = { x: 0, y: 0, w: S, h: S / 2 };
    yield* paintSkinGen(ag, bodyR, model, app, rng, null, null);
    flush(ag);
    yield 'atlas-skin-done';
    const area = { x: 0, y: S / 2, w: S, h: S / 2 };
    const pad = Math.max(2, S / 128);
    for (const name of ['caudal', 'dorsal1', 'dorsal2', 'anal', 'pectoral', 'pelvic', 'adipose', 'barbel']) {
      paintFin(ag, slotRect(area, name, pad), name, app.fins[name] || null, app, rng, 0.45);
    }
    paintEye(ag, slotRect(area, 'eye', pad), app.eye);
    out.atlas = makeTexture(atlasC, true);
    out.textures.push(out.atlas);
    yield 'atlas';
    const B = new GeoBuilder();
    // keep body UVs half a texel inside the rect
    buildBody(B, model, app, cfg.ring, cfg.seg, rectUV({ x: 0.5, y: 0.5, w: S - 1, h: S / 2 - 1 }, S, S));
    buildFins(B, model, app, cfg, (name) => rectUV(slotRect(area, name, pad + 1), S, S));
    const eR = slotRect(area, 'eye', pad + 1);
    for (const side of [1, -1]) addEye(B, model, app.eye, side, rectUV(eR, S, S), cfg.eyeLat, cfg.eyeLon);
    out.geo = B.build();
    out.geos.push(out.geo);
  }
  _layerPool.clear();
  return out;
}

// Recently used showcase / hooked-fish (non-'low') asset sets stay cached (LRU) so a repeat catch of the same
// species does not repaint 2k textures; older ones are freed with their last fish. Population atlases ('low')
// are always kept.
const LRU_KEEP = 2;
const _recent = [];
function touchRecent(e) {
  if (e.placeholder || e.key.split('|')[1] === 'low') return;
  const i = _recent.indexOf(e);
  if (i >= 0) _recent.splice(i, 1);
  _recent.push(e);
  e.keep = true;
  while (_recent.length > LRU_KEEP) {
    const old = _recent.shift();
    old.keep = false;
    if (old.refs === 0) disposeEntry(old);
  }
}

const _jobs = new Map(); // key -> incremental build in progress (see prepareFishAssets)

function registerEntry(key, detail, data) {
  const e = { key, refs: 0, keep: detail === 'low', data };
  _assets.set(key, e);
  touchRecent(e);
  return e;
}

function acquireAssets(appId, detail, quality) {
  const key = `${appId}|${detail}|${quality}`;
  let e = _assets.get(key);
  if (!e) {
    const job = _jobs.get(key);
    if (job) job.finishNow(); // a build already in progress: finish it now instead of starting over
    e = _assets.get(key);
    // population atlases (256-512 px) stay cached; showcase / hooked-fish assets follow the LRU above
    if (!e) e = registerEntry(key, detail, drain(buildAssetsGen(appId, detail, quality)));
  } else touchRecent(e);
  e.refs++;
  return e;
}
function releaseAssets(e) {
  e.refs = Math.max(0, e.refs - 1);
  if (e.refs === 0 && !e.keep) disposeEntry(e);
}
function disposeEntry(e) {
  if (e.disposed) return;
  e.disposed = true;
  const i = _recent.indexOf(e);
  if (i >= 0) _recent.splice(i, 1);
  for (const g of e.data.geos) g.dispose();
  for (const t of e.data.textures) t.dispose();
  if (_assets.get(e.key) === e) _assets.delete(e.key);
}

// Stand-in assets with the same material slots as the 'high' detail (1-px textures, one triangle per mesh):
// createFishProgramKeeper() uses them to compile the hooked-fish shader programs ahead of time.
function placeholderEntry() {
  const tex = (color) => makeTexture(makeCanvas(2, 2), color);
  const tri = () => {
    const B = new GeoBuilder();
    B.vert(0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0);
    B.vert(0, 0.02, -0.02, 1, 0, 0, 0, 1, 0, 0, 0);
    B.vert(0, -0.02, -0.02, 1, 0, 0, 1, 0, 0, 0, 0);
    B.idx.push(0, 1, 2);
    return B.build();
  };
  const data = { bodyMap: tex(true), bodyNormal: tex(false), bodyRM: tex(false), finMap: tex(true), eyeMap: tex(true), bodyGeo: tri(), finGeo: tri(), eyeGeo: tri() };
  data.textures = [data.bodyMap, data.bodyNormal, data.bodyRM, data.finMap, data.eyeMap];
  data.geos = [data.bodyGeo, data.finGeo, data.eyeGeo];
  return { key: 'placeholder', refs: 0, keep: false, placeholder: true, data };
}

// ---------------------------------------------------------------------------------------------------------------
// Swim shader (injected into standard / physical / depth materials)
// ---------------------------------------------------------------------------------------------------------------
const SWIM_GLSL = /* glsl */ `
attribute vec3 aAnim;
uniform float uPhase;
uniform float uAmp;
uniform float uWaveK;
uniform vec3 uEnv;
uniform float uBend;
uniform float uFinPhase;
uniform float uFinAmp;
uniform float uFinTuck;
uniform float uMedPhase;
uniform float uMedAmp;
uniform float uGill;
uniform float uCaudFlex;
float fishLateral(float s) {
  float e = uEnv.x + uEnv.y * s + uEnv.z * s * s;
  return uAmp * e * sin(uPhase - uWaveK * s) + uBend * s * s;
}
float fishSlope(float s) {
  float e = uEnv.x + uEnv.y * s + uEnv.z * s * s;
  float de = uEnv.y + 2.0 * uEnv.z * s;
  float ph = uPhase - uWaveK * s;
  return uAmp * (de * sin(ph) - e * uWaveK * cos(ph)) + 2.0 * uBend * s;
}
vec3 fishLocal(vec3 p, vec3 n) {
  float w = aAnim.x;
  float ch = aAnim.y;
  if (ch > 0.5 && ch < 1.5) {
    float a = uFinAmp * sin(uFinPhase + aAnim.z - w * 18.0) - uFinTuck;
    p += n * (w * a);
  } else if (ch > 1.5 && ch < 2.5) {
    p += n * (w * 0.45 * uFinAmp * sin(uFinPhase * 0.8 + aAnim.z - w * 20.0));
  } else if (ch > 2.5 && ch < 3.5) {
    p += n * (w * uMedAmp * sin(uMedPhase + p.z * 28.0 + aAnim.z));
  } else if (ch > 3.5 && ch < 4.5) {
    p.x -= w * uCaudFlex * cos(uPhase - uWaveK * 0.95);
  } else if (ch > 4.5 && ch < 5.5) {
    p += n * (w * uGill);
  } else if (ch > 5.5) {
    p.x += w * 0.3 * sin(uMedPhase * 0.7 + aAnim.z);
    p.y += w * 0.12 * cos(uMedPhase * 0.9 + aAnim.z);
  }
  return p;
}
vec3 fishDeform(vec3 p, vec3 n) {
  p = fishLocal(p, n);
  float s = clamp(-p.z, 0.0, 1.05);
  p.x += fishLateral(s);
  return p;
}
vec3 fishNormal(vec3 p, vec3 n) {
  float s = clamp(-p.z, 0.0, 1.05);
  return normalize(vec3(n.x, n.y, n.z + fishSlope(s) * n.x));
}
`;

function applySwim(material, U) {
  material.onBeforeCompile = (shader) => {
    for (const k in U) shader.uniforms[k] = U[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SWIM_GLSL}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n\tobjectNormal = fishNormal(position, objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed = fishDeform(position, normal);');
  };
  material.customProgramCacheKey = () => 'lla-fish-swim-v1';
  return material;
}

function makeSwimUniforms(app) {
  const w = app.wave;
  return {
    uPhase: { value: 0 },
    uAmp: { value: 0.01 },
    uWaveK: { value: w.k },
    uEnv: { value: new THREE.Vector3(w.env[0], w.env[1], w.env[2]) },
    uBend: { value: 0 },
    uFinPhase: { value: 0 },
    uFinAmp: { value: 0.3 },
    uFinTuck: { value: 0 },
    uMedPhase: { value: 0 },
    uMedAmp: { value: 0.1 },
    uGill: { value: 0 },
    uCaudFlex: { value: 0 },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------
export function createFishMesh(species, lengthCm, opts = {}) {
  opts = opts || {};
  const rawId = species && typeof species.id === 'string' ? species.id : '';
  const appId = resolveAppearanceId(rawId, species && species.name);
  const app = APPEARANCE[appId];
  let L = Number(lengthCm) / 100;
  if (!Number.isFinite(L) || L <= 0) L = 0.3;
  L = clamp(L, 0.03, 2.5);
  const detail = opts.detail === 'low' || opts.detail === 'medium' ? opts.detail : 'high';
  const quality = opts.quality === 'medium' || opts.quality === 'low' ? opts.quality : 'high';
  const girth = clamp(Number.isFinite(opts.girth) ? opts.girth : 1, 0.8, 1.25);
  const rng = makeRng(Number.isFinite(opts.seed) ? opts.seed : (Math.random() * 0xffffffff) >>> 0);
  const entry = opts.programKeeper && detail === 'high' ? placeholderEntry() : acquireAssets(appId, detail, quality);
  const A = entry.data;
  const U = makeSwimUniforms(app);
  const materials = [];

  const object3d = new THREE.Group();
  object3d.name = `fish:${rawId || appId}`;
  const pivot = new THREE.Group();
  pivot.name = 'fish-roll';
  object3d.add(pivot);
  const meshes = [];
  const castShadow = !!opts.castShadow;
  // shadow casters use a depth material with the same swim deformation (and the fin alpha cut-out)
  const depthMat = (map) => {
    const d = applySwim(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: map || null, alphaTest: map ? 0.3 : 0 }), U);
    materials.push(d);
    return d;
  };
  const addMesh = (geo, mat, name, order = 0, shadow = castShadow) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.scale.set(L * girth, L * girth, L);
    m.renderOrder = order;
    m.castShadow = shadow;
    m.receiveShadow = true;
    pivot.add(m);
    meshes.push(m);
    return m;
  };

  if (detail === 'high') {
    const noIrid = quality === 'low';
    const bodyMat = applySwim(
      new THREE.MeshPhysicalMaterial({
        map: A.bodyMap,
        normalMap: A.bodyNormal,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughnessMap: A.bodyRM,
        metalnessMap: A.bodyRM,
        roughness: 1,
        metalness: 1,
        clearcoat: app.mat.clearcoat,
        clearcoatRoughness: 0.07,
        iridescence: noIrid ? 0 : app.mat.irid,
        iridescenceIOR: 1.33,
        iridescenceThicknessRange: [180, 420],
        specularIntensity: 0.85,
        envMap: opts.envMap || null,
      }),
      U
    );
    const finMat = applySwim(
      new THREE.MeshStandardMaterial({
        map: A.finMap,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.45,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        alphaTest: 0.015,
        envMap: opts.envMap || null,
      }),
      U
    );
    const eyeMat = applySwim(
      new THREE.MeshPhysicalMaterial({
        map: A.eyeMap,
        roughness: 0.18,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        specularIntensity: 1,
        envMap: opts.envMap || null,
      }),
      U
    );
    materials.push(bodyMat, finMat, eyeMat);
    const body = addMesh(A.bodyGeo, bodyMat, 'fish-body', 0);
    addMesh(A.eyeGeo, eyeMat, 'fish-eyes', 0, false);
    const fins = addMesh(A.finGeo, finMat, 'fish-fins', 1);
    if (castShadow) {
      body.customDepthMaterial = depthMat(null);
      fins.customDepthMaterial = depthMat(A.finMap);
    }
  } else {
    const mat = applySwim(
      new THREE.MeshStandardMaterial({
        map: A.atlas,
        roughness: app.mat.rough + 0.04,
        metalness: 0.0,
        side: THREE.DoubleSide,
        alphaToCoverage: true,
        envMap: opts.envMap || null,
      }),
      U
    );
    materials.push(mat);
    const m = addMesh(A.geo, mat, 'fish', 0);
    if (castShadow) m.customDepthMaterial = depthMat(A.atlas);
  }

  object3d.traverse((o) => o.layers.enable(LAYERS.UNDERWATER));
  object3d.userData = { speciesId: rawId || appId, appearance: appId, lengthM: L, centerZ: -0.42 * L, detail };

  // --- animation state
  let phase = rng() * TAU;
  let finPhase = rng() * TAU;
  let medPhase = rng() * TAU;
  let gillPhase = rng() * TAU;
  let freq = 1;
  let amp = 0.015;
  let bend = 0;
  let finAmp = 0.3;
  let tuck = 0;
  let medAmp = 0.1;
  let roll = 0;
  let exhS = 0;
  let clock = rng() * 100;
  let kick = 0;
  let kickTimer = 2 + rng() * 4;
  const rollSide = rng() < 0.5 ? -1 : 1;
  let disposed = false;

  function update(dt, swimSpeedMps = 0, turnRate = 0, exhaustion01 = 0) {
    if (disposed) return;
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    const speed = Number.isFinite(swimSpeedMps) ? Math.abs(swimSpeedMps) : 0;
    const turn = Number.isFinite(turnRate) ? clamp(turnRate, -8, 8) : 0;
    const exh = Number.isFinite(exhaustion01) ? clamp(exhaustion01, 0, 1) : 0;
    clock += dt;
    exhS = damp(exhS, exh, 2.5, dt);
    const bl = Math.min(8, speed / L); // body lengths per second
    const vigor = 1 - 0.7 * exhS;

    // occasional feeble kicks from a spent fish (landing / in hand)
    if (exhS > 0.55) {
      kickTimer -= dt;
      if (kickTimer <= 0) {
        kick = 1;
        kickTimer = 2.5 + rng() * 5;
      }
    }
    kick = Math.max(0, kick - dt * 1.4);

    // tail beat: ~1 Hz idle sway .. ~4 Hz burst; amplitude grows with speed
    const fTarget = (bl < 0.04 ? 0.75 : clamp(0.9 + 1.1 * bl, 0.9, 4.2)) * (1 - 0.55 * exhS) + kick * 2.2;
    const aTarget = (0.014 + 0.075 * (1 - Math.exp(-bl * 0.9))) * (1 - 0.45 * exhS) + kick * 0.06;
    freq = damp(freq, fTarget, 3, dt);
    amp = damp(amp, aTarget, 3, dt);
    phase = (phase + TAU * freq * dt) % TAU;
    bend = damp(bend, clamp(turn * 0.06, -0.14, 0.14) * vigor, 6, dt);

    // pectorals scull when hovering and fold back when swimming fast; limp when spent
    const fold = smoothstep(0.4, 2.2, bl);
    finAmp = damp(finAmp, (0.32 * (1 - fold) + 0.05) * vigor, 3, dt);
    tuck = damp(tuck, 0.28 * fold - 0.1 * exhS, 3, dt);
    finPhase = (finPhase + TAU * (1.5 + 0.6 * fold) * (1 - 0.4 * exhS) * dt) % TAU;
    medAmp = damp(medAmp, (0.12 * (1 - smoothstep(0.3, 1.6, bl)) + 0.02) * vigor, 3, dt);
    medPhase = (medPhase + TAU * 1.3 * dt) % TAU;

    // breathing: gill covers pulse ~1.1 Hz, deeper and slower when exhausted
    gillPhase = (gillPhase + TAU * (1.1 - 0.35 * exhS) * dt) % TAU;
    const gp = Math.max(0, Math.sin(gillPhase));
    U.uGill.value = (0.35 + 0.65 * exhS) * gp * Math.sqrt(gp);

    U.uPhase.value = phase;
    U.uAmp.value = amp;
    U.uBend.value = bend;
    U.uFinPhase.value = finPhase;
    U.uFinAmp.value = finAmp;
    U.uFinTuck.value = tuck;
    U.uMedPhase.value = medPhase;
    U.uMedAmp.value = medAmp;
    U.uCaudFlex.value = clamp(amp * 3.2, 0, 0.35);

    // exhaustion rolls the fish onto its side, with a slow wobble
    const rTarget = rollSide * Math.pow(exhS, 1.4) * 1.3 + Math.sin(clock * 0.9) * 0.08 * exhS;
    roll = damp(roll, rTarget, 2, dt);
    pivot.rotation.z = roll;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (object3d.parent) object3d.parent.remove(object3d);
    for (const m of materials) m.dispose();
    if (entry.placeholder) disposeEntry(entry);
    else releaseAssets(entry);
  }

  update(0, 0, 0, 0);
  return { object3d, update, dispose };
}

// Build (and keep) the shared assets for a set of species so the first spawn does not hitch.
export function prewarmFishMeshes(speciesIds = SPECIES_IDS, opts = {}) {
  opts = opts || {};
  const detail = opts.detail === 'high' || opts.detail === 'medium' ? opts.detail : 'low';
  const quality = opts.quality === 'medium' || opts.quality === 'low' ? opts.quality : 'high';
  for (const id of speciesIds) {
    const e = acquireAssets(resolveAppearanceId(id, ''), detail, quality);
    e.keep = true;
    e.refs--;
  }
}

// Free every cached geometry / texture. Fish still alive keep rendering (three re-uploads on demand).
export function disposeFishMeshCache() {
  for (const job of [..._jobs.values()]) job.cancel();
  for (const e of [..._assets.values()]) disposeEntry(e);
}

const _now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
function assetKeyFor(species, detail, quality) {
  const rawId = species && typeof species.id === 'string' ? species.id : typeof species === 'string' ? species : '';
  const appId = resolveAppearanceId(rawId, species && species.name);
  const d = detail === 'low' || detail === 'medium' ? detail : 'high';
  const q = quality === 'medium' || quality === 'low' ? quality : 'high';
  return { appId, detail: d, quality: q, key: `${appId}|${d}|${q}` };
}

// Are the assets createFishMesh(species, _, { detail, quality }) needs already built (no paint on create)?
export function fishAssetsReady(species, opts = {}) {
  const k = assetKeyFor(species, opts && opts.detail, opts && opts.quality);
  return _assets.has(k.key);
}

// Build the assets for createFishMesh(species, _, { detail, quality }) a few milliseconds at a time, so a hooked
// fish can be upgraded to the high-detail model without a hitch at the hookset. Returns a job:
//   { key, speciesId, done, step(budgetMs = 4) -> done, finishNow(), cancel() }
// step() runs whole build steps until the budget is used up (at least one), then, when opts.renderer is given,
// uploads one texture per step (renderer.initTexture) so the first frame that draws the fish has nothing left to
// do. createFishMesh() on the same key while a job is running finishes the job synchronously. The finished assets
// enter the LRU cache (the two most recent showcase / hooked-fish species stay built).
export function prepareFishAssets(species, opts = {}) {
  opts = opts || {};
  const k = assetKeyFor(species, opts.detail, opts.quality);
  const running = _jobs.get(k.key);
  if (running) {
    if (opts.renderer && !running.renderer) running.renderer = opts.renderer;
    return running;
  }
  const renderer = opts.renderer || null;
  let gen = null;
  let uploads = null;
  let entry = null;
  const job = {
    key: k.key,
    speciesId: k.appId,
    detail: k.detail,
    quality: k.quality,
    done: false,
    cancelled: false,
    failed: false,
    renderer,
    maxStepMs: 0,
    maxStepLabel: '',
    label: '',
    steps: 0,
    get phase() {
      return job.done ? 'done' : uploads ? 'upload' : 'build';
    },
    step(budgetMs = 4) {
      if (job.done || job.cancelled) return job.done;
      const t0 = _now();
      do {
        const t1 = _now();
        try {
          advance();
        } catch (err) {
          console.warn('[fish-mesh] asset build failed', err);
          job.failed = true;
          job.cancel();
        }
        job.steps++;
        const ms = _now() - t1;
        if (ms > job.maxStepMs) {
          job.maxStepMs = ms;
          job.maxStepLabel = job.label;
        }
      } while (!job.done && !job.cancelled && _now() - t0 < budgetMs);
      return job.done;
    },
    finishNow() {
      // everything but the texture uploads (the renderer does those on first use)
      while (!job.done && !job.cancelled && !uploads) advance();
      if (!job.done && !job.cancelled) finish();
    },
    cancel() {
      if (job.done || job.cancelled) return;
      job.cancelled = true;
      if (gen) {
        try {
          gen.return();
        } catch {
          /* ignore */
        }
      }
      gen = null;
      if (_jobs.get(job.key) === job) _jobs.delete(job.key);
    },
  };
  function finish() {
    job.done = true;
    gen = null;
    uploads = null;
    if (_jobs.get(job.key) === job) _jobs.delete(job.key);
  }
  function advance() {
    if (!uploads) {
      if (_assets.has(job.key)) {
        // built meanwhile by a synchronous createFishMesh
        const e = _assets.get(job.key);
        touchRecent(e);
        entry = e;
        uploads = job.renderer ? e.data.textures.slice() : [];
        if (gen) {
          try {
            gen.return();
          } catch {
            /* ignore */
          }
          gen = null;
        }
        return;
      }
      if (!gen) gen = buildAssetsGen(k.appId, k.detail, k.quality);
      const r = gen.next();
      job.label = r.done ? 'finish' : r.value;
      if (r.done) {
        gen = null;
        const e = registerEntry(job.key, k.detail, r.value);
        entry = e;
        uploads = job.renderer ? e.data.textures.slice() : [];
        if (!uploads.length) finish();
      }
      return;
    }
    if (!entry || entry.disposed) {
      finish(); // evicted meanwhile: nothing left to upload
      return;
    }
    const t = uploads.shift();
    job.label = 'upload';
    if (t && job.renderer && typeof job.renderer.initTexture === 'function') {
      try {
        job.renderer.initTexture(t);
      } catch (err) {
        console.warn('[fish-mesh] texture upload failed', err);
      }
    }
    if (!uploads.length) finish();
  }
  if (_assets.has(k.key)) {
    // already built (and uploaded by whoever drew it)
    job.done = true;
    touchRecent(_assets.get(k.key));
    return job;
  }
  _jobs.set(k.key, job);
  return job;
}

// A tiny stand-in fish with exactly the materials of a 'high' detail fish (body with clearcoat / iridescence /
// normal + roughness-metalness maps, translucent fins, glossy eyes, swim-deformed shadow depth materials) on
// 1-px textures. Add it to the scene for a few rendered frames (frustumCulled is off) so every pass compiles the
// hooked-fish shader programs up front, and keep it (hidden, not disposed) so the programs stay alive.
// Returns { object3d, dispose }.
export function createFishProgramKeeper(opts = {}) {
  opts = opts || {};
  const h = createFishMesh({ id: 'largemouth_bass' }, 30, { detail: 'high', quality: opts.quality, castShadow: opts.castShadow !== false, seed: 1, programKeeper: true });
  h.object3d.name = 'fish-program-keeper';
  h.object3d.traverse((o) => {
    o.frustumCulled = false;
    o.layers.disable(LAYERS.UNDERWATER);
  });
  return { object3d: h.object3d, dispose: h.dispose };
}
