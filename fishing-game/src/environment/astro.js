// Sun, moon and star-field geometry for a northern lake (46.5 N, mid-August).
// Sunrise / sunset match DAY in config.js. World axes: -Z is the view down the dock,
// which faces compass bearing FORWARD_AZIMUTH (west by south), so the sun sets a little
// right of straight ahead and rises behind the player.
import { DAY } from '../config.js';
import { FORWARD_AZIMUTH } from './terrainField.js';

const DEG = Math.PI / 180;
export const LATITUDE_DEG = 46.5;
const LAT = LATITUDE_DEG * DEG;
const SIN_LAT = Math.sin(LAT);
const COS_LAT = Math.cos(LAT);

export const SOLAR_NOON = (DAY.sunriseHours + DAY.sunsetHours) / 2;

// Declination that puts the sun's upper limb on the horizon (-0.833 deg with refraction)
// exactly at DAY.sunriseHours / DAY.sunsetHours.
const SUN_DECL = (() => {
  const H0 = ((DAY.sunsetHours - DAY.sunriseHours) / 2) * 15 * DEG;
  const target = Math.sin(-0.833 * DEG);
  let lo = -23.4 * DEG;
  let hi = 23.4 * DEG;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const f = Math.sin(LAT) * Math.sin(mid) + Math.cos(LAT) * Math.cos(mid) * Math.cos(H0) - target;
    if (f > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
})();

// A waxing gibbous moon, low in the south-west late in the evening (left of forward at 22:30).
const MOON_DECL = -16 * DEG;
const MOON_TRANSIT = 19.5;

// Horizontal world unit vectors for compass north / east.
function bearing(azDeg) {
  const rel = (azDeg - FORWARD_AZIMUTH) * DEG;
  return [Math.sin(rel), -Math.cos(rel)]; // (x, z)
}
const NORTH = bearing(0);
const EAST = bearing(90);

function body(hours, decl, transit, out) {
  let dh = hours - transit;
  dh = ((((dh + 12) % 24) + 24) % 24) - 12;
  const H = dh * 15 * DEG;
  const cd = Math.cos(decl);
  const sd = Math.sin(decl);
  const E = -cd * Math.sin(H);
  const N = sd * COS_LAT - cd * SIN_LAT * Math.cos(H);
  const U = sd * SIN_LAT + cd * COS_LAT * Math.cos(H);
  out.x = E * EAST[0] + N * NORTH[0];
  out.y = U;
  out.z = E * EAST[1] + N * NORTH[1];
  return out;
}

export const sunDirectionAt = (hours, out) => body(hours, SUN_DECL, SOLAR_NOON, out);
export const moonDirectionAt = (hours, out) => body(hours, MOON_DECL, MOON_TRANSIT, out);

// North celestial pole (world, unit). Stars turn about it by -15 deg per hour.
export const CELESTIAL_POLE = [COS_LAT * NORTH[0], SIN_LAT, COS_LAT * NORTH[1]];
export const siderealAngle = (hours) => -hours * 15 * DEG;

export function worldDirection(azDeg, elDeg, out) {
  const b = bearing(azDeg);
  const ce = Math.cos(elDeg * DEG);
  out.x = b[0] * ce;
  out.y = Math.sin(elDeg * DEG);
  out.z = b[1] * ce;
  return out;
}
