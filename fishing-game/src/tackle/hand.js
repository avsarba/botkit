// Right hand in a dark neoprene fishing glove, gripping the reel seat of a spinning rod the usual way:
// palm on the right of the handle, fingers wrapped underneath with the reel stem between the middle
// and ring fingers, thumb along the top of the handle, forearm and jacket cuff running back along the
// rear grip. Built in rod-local coordinates (+Y along the rod, -Z toward the reel, +X right).
import * as THREE from 'three';
import { smoothstep, makeRng } from '../config.js';
import { sweepTube, mergeParts } from './geom.js';

function fabricBump() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 128, 128);
  const rng = makeRng(5);
  for (let i = 0; i < 2600; i++) {
    const v = 90 + Math.floor(rng() * 80);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rng() * 128, rng() * 128, 1 + rng() * 2, 1);
  }
  // knit rows
  g.strokeStyle = 'rgba(40,40,40,0.35)';
  for (let y = 0; y < 128; y += 4) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(128, y + 1);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

// point at angle phi (0 = +X, 90deg = -Z / under the handle, 180 = -X, 270 = +Z / top) and radius r
const P = (phi, r, y) => new THREE.Vector3(Math.cos(phi) * r, y, -Math.sin(phi) * r);
const D = Math.PI / 180;

export function createHand({ quality = 'high' } = {}) {
  const radial = quality === 'low' ? 7 : 10;
  const bump = fabricBump();
  const glove = new THREE.MeshStandardMaterial({ color: 0x3d423b, roughness: 0.78, metalness: 0, bumpMap: bump, bumpScale: 1.2 });
  const palmPatch = new THREE.MeshStandardMaterial({ color: 0x252825, roughness: 0.7, bumpMap: bump, bumpScale: 0.8 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x263240, roughness: 0.9, bumpMap: bump, bumpScale: 1.6 });
  const parts = [];
  const RH = 0.0108; // handle radius under the fingers

  // fingers: [y, finger radius, end angle, forward drift]
  const fingers = [
    [0.035, 0.0084, 186 * D, 0.012], // index, a little more open
    [0.0145, 0.0087, 204 * D, 0.004], // middle (stem sits behind it)
    [-0.0185, 0.0082, 204 * D, -0.002], // ring
    [-0.0375, 0.0072, 196 * D, -0.004], // pinky
  ];
  for (const [y, rf, phiEnd, drift] of fingers) {
    const pts = [];
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const phi = -8 * D + (phiEnd + 8 * D) * t;
      const lift = 0.013 * (1 - smoothstep(0, 0.32, t)); // knuckle sits out on the palm
      pts.push(P(phi, RH + rf * 0.92 + lift, y + drift * t));
    }
    const geo = sweepTube(
      pts,
      (i, t) => {
        const joint = 1 + 0.045 * Math.exp(-Math.pow((t - 0.47) / 0.05, 2)) + 0.03 * Math.exp(-Math.pow((t - 0.76) / 0.045, 2));
        const tipRound = t > 0.93 ? Math.sqrt(Math.max(0.05, 1 - Math.pow((t - 0.93) / 0.075, 2))) : 1;
        return rf * (1 - 0.14 * t) * joint * tipRound;
      },
      radial,
      { capStart: true, capEnd: true }
    );
    parts.push({ geometry: geo, group: 0 });
  }

  // back of the hand / palm: a flattened mass on the right side of the handle spanning the knuckles
  {
    const g = new THREE.SphereGeometry(1, 20, 14);
    g.scale(0.0155, 0.049, 0.027);
    g.rotateY(-0.2);
    g.rotateZ(0.1);
    g.translate(RH + 0.0165, -0.004, -0.003);
    parts.push({ geometry: g, group: 0 });
    // heel of the palm under the thumb
    const h = new THREE.SphereGeometry(1, 16, 12);
    h.scale(0.016, 0.026, 0.017);
    h.translate(0.013, -0.036, 0.012);
    parts.push({ geometry: h, group: 1 });
  }

  // thumb along the top of the handle, pointing up the rod
  {
    const pts = [
      new THREE.Vector3(0.022, -0.046, 0.012),
      new THREE.Vector3(0.016, -0.03, 0.018),
      new THREE.Vector3(0.008, -0.01, 0.0195),
      new THREE.Vector3(0.002, 0.008, 0.0193),
      new THREE.Vector3(-0.002, 0.022, 0.0182),
      new THREE.Vector3(-0.0032, 0.031, 0.0168),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const sp = curve.getPoints(18);
    parts.push({
      geometry: sweepTube(
        sp,
        (i, t) => {
          const base = 0.0118 - 0.0034 * t;
          const joint = 1 + 0.06 * Math.exp(-Math.pow((t - 0.55) / 0.06, 2));
          const tipRound = t > 0.9 ? Math.sqrt(Math.max(0.05, 1 - Math.pow((t - 0.9) / 0.1, 2))) : 1;
          return base * joint * tipRound;
        },
        radial,
        { capStart: true, capEnd: true }
      ),
      group: 0,
    });
  }

  // wrist and forearm running back along the rear grip, then the jacket cuff
  {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      pts.push(new THREE.Vector3(0.026 + 0.03 * t, -0.04 - 0.26 * t, 0.008 + 0.02 * t - 0.03 * t * t));
    }
    parts.push({
      geometry: sweepTube(pts, (i, t) => 0.026 + 0.012 * smoothstep(0.1, 1, t), radial + 2, { capStart: true, capEnd: false }),
      group: 0,
    });
    const cuff = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      cuff.push(new THREE.Vector3(0.049 + 0.04 * t, -0.235 - 0.25 * t, 0.018 - 0.05 * t));
    }
    parts.push({
      geometry: sweepTube(cuff, (i, t) => (i === 0 ? 0.041 : 0.047 + 0.006 * t), radial + 4, { capStart: true, capEnd: false }),
      group: 2,
    });
  }

  const merged = mergeParts(parts).geometry;
  const mesh = new THREE.Mesh(merged, [glove, palmPatch, sleeve]);
  mesh.name = 'hand';
  return {
    object: mesh,
    materials: [glove, palmPatch, sleeve],
    dispose() {
      merged.dispose();
      bump.dispose();
      glove.dispose();
      palmPatch.dispose();
      sleeve.dispose();
    },
  };
}

