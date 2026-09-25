// Controller rays for the world-space panels: a thin beam that fades along its length and a dot where it
// meets a panel, per hand, parented to the controller's target-ray space. Hit-testing is against the
// interactive panels that are showing (menu, journal, catch card) through the plane's UV -> canvas px.
import * as THREE from 'three';

const ROLES = ['rod', 'reel'];
const FREE_LEN = 1.4; // beam length when it points at nothing
const MAX_DIST = 6;

export function createRays(tk) {
  const c = tk.c;
  const raycaster = new THREE.Raycaster();
  raycaster.far = MAX_DIST;
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const px = { x: 0, y: 0 };
  const hitList = [];

  function makeVisual(role) {
    const group = new THREE.Group();
    group.name = `xr-ray-${role}`;
    // beam: an open cone along -Z from the controller, alpha fading toward the far end
    const geo = new THREE.CylinderGeometry(0.0008, 0.0017, 1, 8, 1, true);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -0.5);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 4);
    const base = new THREE.Color(c.text);
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, -pos.getZ(i))); // 0 at the controller, 1 at the end
      col[i * 4] = base.r;
      col[i * 4 + 1] = base.g;
      col[i * 4 + 2] = base.b;
      col[i * 4 + 3] = 0.75 * (1 - t) + 0.12 * t;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const beamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, fog: false });
    const beam = new THREE.Mesh(geo, beamMat);
    beam.renderOrder = 990;
    beam.frustumCulled = false;
    beam.scale.z = FREE_LEN;
    group.add(beam);
    // dot at the hit point (a halo ring behind it keeps it visible on the pale paper)
    const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c.text), transparent: true, depthWrite: false, toneMapped: false, fog: false });
    const haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x000000), transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false, fog: false });
    const dotGeo = new THREE.CircleGeometry(0.0055, 20);
    const haloGeo = new THREE.RingGeometry(0.0055, 0.0085, 24);
    const dot = new THREE.Group();
    const dm = new THREE.Mesh(dotGeo, dotMat);
    const hm = new THREE.Mesh(haloGeo, haloMat);
    dm.renderOrder = hm.renderOrder = 991;
    dm.frustumCulled = hm.frustumCulled = false;
    dot.add(hm, dm);
    dot.visible = false;
    group.add(dot);
    group.visible = false;
    return { role, group, beam, dot, dotMat, beamMat, geos: [geo, dotGeo, haloGeo], mats: [beamMat, dotMat, haloMat] };
  }
  const vis = { rod: makeVisual('rod'), reel: makeVisual('reel') };
  const hits = { rod: null, reel: null };
  const hitObj = { rod: { panel: null, button: null, distance: 0, x: 0, y: 0 }, reel: { panel: null, button: null, distance: 0, x: 0, y: 0 } };
  const lineColor = new THREE.Color(c.line);
  const textColor = new THREE.Color(c.text);

  let objs = { rod: null, reel: null };
  function attach(rodRay, reelRay) {
    for (const r of ROLES) vis[r].group.removeFromParent();
    objs = { rod: rodRay || null, reel: reelRay || null };
    for (const r of ROLES) if (objs[r] && objs[r].add) objs[r].add(vis[r].group);
  }
  function detach() {
    for (const r of ROLES) {
      vis[r].group.removeFromParent();
      vis[r].group.visible = false;
      hits[r] = null;
    }
    objs = { rod: null, reel: null };
  }

  // Hit-test each ray against `panels` (interactive, visible) and update the beams. show: rays wanted.
  function update(panels, show) {
    const meshes = hitList;
    meshes.length = 0;
    for (const p of panels) if (p.mesh.visible && p.interactive) meshes.push(p.mesh);
    for (const r of ROLES) {
      const o = objs[r];
      const v = vis[r];
      hits[r] = null;
      if (!o || !o.visible || !show) {
        v.group.visible = false;
        continue;
      }
      o.updateWorldMatrix(true, false);
      origin.setFromMatrixPosition(o.matrixWorld);
      dir.set(0, 0, -1).transformDirection(o.matrixWorld);
      let hit = null;
      if (meshes.length) {
        raycaster.set(origin, dir);
        const found = raycaster.intersectObjects(meshes, false);
        for (const f of found) {
          const panel = f.object.userData.panel;
          if (!panel || !f.uv) continue;
          panel.uvToPx(f.uv, px);
          const btn = panel.buttonAt(px.x, px.y);
          hit = hitObj[r]; // reused per hand: no per-frame garbage
          hit.panel = panel;
          hit.button = btn && !btn.disabled ? btn : null;
          hit.distance = f.distance;
          hit.x = px.x;
          hit.y = px.y;
          break;
        }
      }
      hits[r] = hit;
      v.group.visible = true;
      // distances along the ray in the ray object's space (it may carry scale in odd rigs: use world units)
      const s = o.matrixWorld.getMaxScaleOnAxis() || 1;
      if (hit) {
        v.beam.scale.z = Math.max(0.01, hit.distance / s - 0.004);
        v.dot.visible = true;
        v.dot.position.set(0, 0, -(hit.distance / s - 0.003));
        v.dotMat.color.copy(hit.button ? lineColor : textColor);
        v.dot.scale.setScalar(hit.button ? 1.25 : 1);
      } else {
        v.beam.scale.z = FREE_LEN / s;
        v.dot.visible = false;
      }
    }
    return hits;
  }

  return {
    attach,
    detach,
    update,
    hits,
    get objects() {
      return objs;
    },
    dispose() {
      detach();
      for (const r of ROLES) {
        for (const g of vis[r].geos) g.dispose();
        for (const m of vis[r].mats) m.dispose();
      }
    },
  };
}
