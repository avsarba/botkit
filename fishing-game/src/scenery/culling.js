// Azimuth / elevation sector culling for chunked scenery (static chunks around the dock).
// Chunks are wedges around the dock (the fixed viewpoint), so their bounding spheres usually
// contain the camera and three's frustum test never rejects them. Each frame we compare every
// chunk's azimuth range and elevation-angle range (as seen from the eye) with the camera's view
// cone instead. If the camera is ever far from the dock (a cinematic or debug camera), everything
// is shown and three's own frustum culling applies.
import * as THREE from 'three';

const TWO_PI = Math.PI * 2;
const XR_MARGIN = 0.12; // rad: a fast head turn (~500 deg/s at 72 Hz) between an XR frame's update and render
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();

// azimuth convention used by the scenery: 0 = straight out over the lake (-Z), +pi/2 = +X
export const azimuthOf = (x, z) => Math.atan2(x, -z);

// XR: the azimuth half-extent (rad, from the view azimuth) of the circular view cone of radius r around a view
// direction at pitch p, over the elevations [e0, e1] (rad) that a chunk spans. A point at elevation e and azimuth
// offset d is in the cone when sin p sin e + cos p cos e cos d >= cos r, so cos d >= (cos r - sin p sin e) /
// (cos p cos e). The widest offset over [e0, e1] is at an end or at the cone's widest elevation, sin e* = sin p / cos r.
// Returns -1 when no elevation of the chunk is inside the cone, PI when every azimuth is.
export function coneAzimuthExtent(p, r, e0, e1) {
  const lo = Math.max(e0, p - r);
  const hi = Math.min(e1, p + r);
  if (lo > hi) return -1;
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const cr = Math.cos(r);
  let best = -1;
  const at = (e) => {
    const c = cp * Math.cos(e);
    if (c < 1e-4) return Math.PI; // (straight up / down: every azimuth)
    const x = (cr - sp * Math.sin(e)) / c;
    if (x <= -1) return Math.PI;
    if (x >= 1) return x - 1 < 1e-9 ? 0 : -1;
    return Math.acos(x);
  };
  best = Math.max(best, at(lo), at(hi));
  if (Math.abs(sp) < cr) {
    const es = Math.asin(sp / cr);
    if (es > lo && es < hi) best = Math.max(best, at(es));
  }
  return best;
}

// Exact elevation-angle range of a static chunk as seen from the eye (x = z = 0, y = EYE_Y),
// for the object itself and for its mirror image in the water (y -> -y).
const EYE_Y = 2.2;
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
function elevationRange(obj) {
  const r = { min: Infinity, max: -Infinity, mMin: Infinity, mMax: -Infinity };
  const add = (x, y, z) => {
    const d = Math.max(0.5, Math.hypot(x, z));
    const e = Math.atan2(y - EYE_Y, d);
    const m = Math.atan2(-y - EYE_Y, d);
    if (e < r.min) r.min = e;
    if (e > r.max) r.max = e;
    if (m < r.mMin) r.mMin = m;
    if (m > r.mMax) r.mMax = m;
  };
  obj.updateWorldMatrix(true, false);
  const g = obj.geometry;
  if (obj.isInstancedMesh) {
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    for (let i = 0; i < obj.count; i++) {
      obj.getMatrixAt(i, _m);
      _m.premultiply(obj.matrixWorld);
      for (let c = 0; c < 8; c++) {
        _v.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z).applyMatrix4(_m);
        add(_v.x, _v.y, _v.z);
      }
    }
  } else {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(obj.matrixWorld);
      add(_v.x, _v.y, _v.z);
    }
  }
  return r;
}

export function createSectorCuller() {
  const items = []; // { obj, a0, a1, b } with a0 < a1 (radians)
  return {
    add(obj, a0, a1) {
      items.push({ obj, a0, a1, b: elevationRange(obj) });
    },
    // sector index s of S -> azimuth range
    addSector(obj, s, S) {
      const a0 = -Math.PI + (s / S) * TWO_PI;
      items.push({ obj, a0, a1: a0 + TWO_PI / S, b: elevationRange(obj) });
    },
    // xr: an XR session is presenting. `camera` is then the user camera three keeps on the head pose
    // (updated at render time, so one frame old here) with the stereo union projection, while its
    // .aspect is still the desktop canvas's. The cone comes from the projection instead, as a circle
    // of the half-diagonal (the head can roll) plus a margin for head turns between frames.
    update(camera, xr = false) {
      if (!camera || !items.length) return;
      camera.getWorldPosition(_pos);
      const all = Math.hypot(_pos.x, _pos.z) > 6;
      let azC = 0;
      let half = Math.PI;
      let elTop = Math.PI;
      let elBot = -Math.PI;
      let pitch = 0;
      let coneR = 0; // XR: the view cone's radius (azimuth extents are per chunk, from its elevation range)
      if (!all) {
        camera.getWorldDirection(_dir);
        azC = Math.atan2(_dir.x, -_dir.z);
        pitch = Math.asin(Math.max(-1, Math.min(1, _dir.y)));
        if (xr) {
          // circular cone of radius r around the view direction (the head can roll), plus the elevation margin
          const pm = camera.projectionMatrix.elements;
          const tH = pm[0] > 1e-6 ? (1 + Math.abs(pm[8])) / pm[0] : 3;
          const tV = pm[5] > 1e-6 ? (1 + Math.abs(pm[9])) / pm[5] : 3;
          const r = Math.min(1.45, Math.atan(Math.hypot(tH, tV)) + XR_MARGIN);
          coneR = r + 0.08;
          elTop = pitch + r + 0.08;
          elBot = pitch - r - 0.08;
        } else {
          const vHalf = THREE.MathUtils.degToRad((camera.fov || 60) * 0.5);
          const hHalf = Math.atan(Math.tan(vHalf) * (camera.aspect || 1.78));
          const e = Math.abs(pitch) + vHalf;
          // horizontal half-angle, widened toward the top/bottom rows (+ margin: crowns overhang
          // sector edges); steep views can see every azimuth near the feet
          if (e < 1.4) half = Math.atan(Math.tan(hHalf) / Math.cos(e)) + 0.2;
          elTop = pitch + vHalf + 0.08;
          elBot = pitch - vHalf - 0.08;
        }
      }
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.obj.userData.sceneryHidden) {
          it.obj.visible = false;
          continue;
        }
        if (all) {
          it.obj.visible = true;
          continue;
        }
        // chunk entirely above or below the view (e.g. the far forest while looking down); its
        // mirror image in the water (planar reflection) counts too (not in VR: no planar mirror there)
        const b = it.b;
        const outside = b.max < elBot || b.min > elTop;
        if (outside && (xr || b.mMax < elBot || b.mMin > elTop)) {
          it.obj.visible = false;
          continue;
        }
        // angular distance from the view centre to the sector (wrapping)
        const mid = (it.a0 + it.a1) * 0.5;
        const hw = (it.a1 - it.a0) * 0.5;
        let d = Math.abs(mid - azC) % TWO_PI;
        if (d > Math.PI) d = TWO_PI - d;
        if (xr) {
          // the cone's azimuth extent over this chunk's own elevations (looking down at the reel, a horizon chunk
          // needs about +-65 deg, not every azimuth)
          const ext = coneAzimuthExtent(pitch, coneR, b.min, b.max);
          it.obj.visible = ext >= 0 && d <= hw + ext + 0.2;
        } else it.obj.visible = d <= hw + half;
      }
    },
  };
}
