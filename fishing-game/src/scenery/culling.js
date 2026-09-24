// Azimuth / elevation sector culling for chunked scenery (static chunks around the dock).
// Chunks are wedges around the dock (the fixed viewpoint), so their bounding spheres usually
// contain the camera and three's frustum test never rejects them. Each frame we compare every
// chunk's azimuth range and elevation-angle range (as seen from the eye) with the camera's view
// cone instead. If the camera is ever far from the dock (a cinematic or debug camera), everything
// is shown and three's own frustum culling applies.
import * as THREE from 'three';

const TWO_PI = Math.PI * 2;
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();

// azimuth convention used by the scenery: 0 = straight out over the lake (-Z), +pi/2 = +X
export const azimuthOf = (x, z) => Math.atan2(x, -z);

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
    update(camera) {
      if (!camera || !items.length) return;
      camera.getWorldPosition(_pos);
      const all = Math.hypot(_pos.x, _pos.z) > 6;
      let azC = 0;
      let half = Math.PI;
      let elTop = Math.PI;
      let elBot = -Math.PI;
      if (!all) {
        camera.getWorldDirection(_dir);
        azC = Math.atan2(_dir.x, -_dir.z);
        const pitch = Math.asin(Math.max(-1, Math.min(1, _dir.y)));
        const vHalf = THREE.MathUtils.degToRad((camera.fov || 60) * 0.5);
        const hHalf = Math.atan(Math.tan(vHalf) * (camera.aspect || 1.78));
        const e = Math.abs(pitch) + vHalf;
        // horizontal half-angle, widened toward the top/bottom rows (+ margin: crowns overhang
        // sector edges); steep views can see every azimuth near the feet
        if (e < 1.4) half = Math.atan(Math.tan(hHalf) / Math.cos(e)) + 0.2;
        elTop = pitch + vHalf + 0.08;
        elBot = pitch - vHalf - 0.08;
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
        // mirror image in the water (planar reflection) counts too
        const b = it.b;
        if ((b.max < elBot || b.min > elTop) && (b.mMax < elBot || b.mMin > elTop)) {
          it.obj.visible = false;
          continue;
        }
        // angular distance from the view centre to the sector (wrapping)
        const mid = (it.a0 + it.a1) * 0.5;
        const hw = (it.a1 - it.a0) * 0.5;
        let d = Math.abs(mid - azC) % TWO_PI;
        if (d > Math.PI) d = TWO_PI - d;
        it.obj.visible = d <= hw + half;
      }
    },
  };
}
