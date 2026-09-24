// Mix levels (linear gain) in one place so the whole mix can be calibrated from the sandbox
// measurements (src/sandbox/audio.js renders every sound offline and logs peak / RMS).
// Target: one-shots peak around -6 dBFS after the master compressor, ambience well below that.

export const MIX = {
  master: 0.85, // master gain when unmuted
  amb: 1.0, // ambience bus
  sfx: 1.0, // event one-shots
  tackle: 1.0, // reel / drag / line
  reverb: 1.0, // lake reverb return
};

// Per-sound trims (multiplied into the sound's own envelope peaks).
export const LV = {
  cast: 1.65,
  plop: 1.8,
  thud: 1.3,
  twitch: 1.5,
  nibble: 1.4,
  plunk: 1.24,
  tap: 1.07,
  swirl: 1.9,
  splash: 1.6,
  strike: 1.9,
  hooked: 0.6,
  snap: 1.6,
  escaped: 2.7,
  catch: 0.245,
  ui: 2.3,
  creak: 2.7,
  // continuous tackle
  reel: 0.4,
  drag: 0.23,
  hum: 0.11,
  // ambience
  water: 0.17,
  cluck: 0.18,
  wind: 0.12,
  insects: 0.16,
  crickets: 0.035,
  bird: 0.062,
  loon: 0.075,
  owl: 0.052,
  frog: 0.072,
  peeper: 0.052,
};
