// Terminal tackle at true scale (meters). Lure local frame: nose = +Z, back = +Y.
// The float's local frame: line enters at the top clip (+Y) and leaves at the bottom clip (-Y).
import * as THREE from 'three';
import { clamp, smoothstep } from '../config.js';
import { sweepTube, lathe, loftBody, trebleGeometry, hookArmGeometry, mergeParts } from './geom.js';
import { makeFloatTexture, makeWormTexture, makePerchCrankTexture, makeBoneChartTexture, makeEyeTexture } from './textures.js';

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _prevT = new THREE.Vector3();
const _axis = new THREE.Vector3();

function makeMaterials() {
  const eyeTex = makeEyeTexture('#d9a91a');
  return {
    hook: new THREE.MeshStandardMaterial({ color: 0x3a3128, metalness: 1, roughness: 0.34 }),
    blackNickel: new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 1, roughness: 0.26 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 1, roughness: 0.2 }),
    lead: new THREE.MeshStandardMaterial({ color: 0x6d7074, metalness: 0.35, roughness: 0.62 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc8a24a, metalness: 1, roughness: 0.28 }),
    blade: new THREE.MeshStandardMaterial({ color: 0xf4f5f6, metalness: 1, roughness: 0.3, side: THREE.DoubleSide }),
    float: new THREE.MeshPhysicalMaterial({ map: makeFloatTexture(), roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.12 }),
    floatRed: new THREE.MeshPhysicalMaterial({ color: 0xb3161c, roughness: 0.35, clearcoat: 0.6 }),
    worm: new THREE.MeshPhysicalMaterial({ map: makeWormTexture(), roughness: 0.42, clearcoat: 0.75, clearcoatRoughness: 0.28 }),
    crank: new THREE.MeshPhysicalMaterial({ map: makePerchCrankTexture(), roughness: 0.38, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.04 }),
    topwater: new THREE.MeshPhysicalMaterial({ map: makeBoneChartTexture(), roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.05 }),
    lip: new THREE.MeshPhysicalMaterial({
      color: 0xd9e2df,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 1,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    eye: new THREE.MeshPhysicalMaterial({ map: eyeTex, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02 }),
  };
}

// Eye dome: a spherical cap whose pole faces +Z, with planar UVs so the iris texture is centered.
function eyeGeometry(r) {
  const g = new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, 1.05);
  g.rotateX(Math.PI / 2);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  const rr = r * Math.sin(1.05);
  for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 + (p.getX(i) / rr) * 0.5, 0.5 + (p.getY(i) / rr) * 0.5);
  g.translate(0, 0, -r * Math.cos(1.05));
  return g;
}

function placeEye(mesh, x, y, z, side) {
  mesh.position.set(x, y, z);
  // pole looks sideways (+/-X) and a little forward
  mesh.lookAt(x + side, y + 0.1, z + 0.35);
}

// ---------- dynamic tube (worm) ----------
function createDynamicTube(samples, radial) {
  const ring = radial + 1;
  const count = samples * ring;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const idx = [];
  for (let i = 0; i < samples; i++) {
    for (let k = 0; k <= radial; k++) {
      uv[(i * ring + k) * 2] = k / radial;
      uv[(i * ring + k) * 2 + 1] = i / (samples - 1);
    }
  }
  for (let i = 0; i < samples - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * ring + k;
      const b = (i + 1) * ring + k;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  const pts = [];
  for (let i = 0; i < samples; i++) pts.push(new THREE.Vector3());
  // Rebuild from a curve with parallel transport; allocation free.
  function update(curve, radiusFn) {
    for (let i = 0; i < samples; i++) curve.getPoint(i / (samples - 1), pts[i]);
    _n.set(0, 0, 0);
    for (let i = 0; i < samples; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(samples - 1, i + 1)];
      _t.subVectors(b, a);
      if (_t.lengthSq() < 1e-14) _t.set(0, 1, 0);
      _t.normalize();
      if (i === 0) {
        _v.set(Math.abs(_t.x) < 0.9 ? 1 : 0, Math.abs(_t.x) < 0.9 ? 0 : 1, 0);
        _n.crossVectors(_t, _v).normalize();
      } else {
        _axis.crossVectors(_prevT, _t);
        const l = _axis.length();
        if (l > 1e-9) _n.applyAxisAngle(_axis.divideScalar(l), Math.acos(clamp(_prevT.dot(_t), -1, 1)));
        _n.addScaledVector(_t, -_n.dot(_t)).normalize();
      }
      _prevT.copy(_t);
      _b.crossVectors(_t, _n);
      const r = radiusFn(i / (samples - 1));
      for (let k = 0; k <= radial; k++) {
        const ang = (k / radial) * Math.PI * 2;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const nx = _n.x * c + _b.x * s;
        const ny = _n.y * c + _b.y * s;
        const nz = _n.z * c + _b.z * s;
        const o = (i * ring + k) * 3;
        pos[o] = pts[i].x + nx * r;
        pos[o + 1] = pts[i].y + ny * r;
        pos[o + 2] = pts[i].z + nz * r;
        nor[o] = nx;
        nor[o + 1] = ny;
        nor[o + 2] = nz;
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
  }
  return { geometry: g, update };
}

// ---------- float rig ----------
function makeFloatRig(mats, q) {
  const float = new THREE.Group();
  float.name = 'float';
  const R = 0.015;
  const body = new THREE.Mesh(new THREE.SphereGeometry(R, Math.round(28 * q), Math.round(18 * q)), mats.float);
  float.add(body);
  // push button on top + wire hook clips top and bottom
  const button = new THREE.Mesh(lathe([[0.0034, R - 0.001], [0.0034, R + 0.0022], [0.0026, R + 0.0034], [0, R + 0.0036]], 14), mats.floatRed);
  float.add(button);
  const wireParts = [];
  const topHook = sweepTube(
    [new THREE.Vector3(0, R + 0.0034, 0), new THREE.Vector3(0, R + 0.0052, 0), new THREE.Vector3(0.0012, R + 0.0062, 0), new THREE.Vector3(0.0024, R + 0.0054, 0), new THREE.Vector3(0.0022, R + 0.0042, 0)],
    0.00038,
    5
  );
  wireParts.push({ geometry: topHook, group: 0 });
  const botHook = sweepTube(
    [new THREE.Vector3(0, -R + 0.001, 0), new THREE.Vector3(0, -R - 0.0028, 0), new THREE.Vector3(0.0012, -R - 0.004, 0), new THREE.Vector3(0.0024, -R - 0.003, 0), new THREE.Vector3(0.0022, -R - 0.0018, 0)],
    0.00038,
    5
  );
  wireParts.push({ geometry: botHook, group: 0 });
  float.add(new THREE.Mesh(mergeParts(wireParts).geometry, mats.steel));
  const topClip = new THREE.Vector3(0.0012, R + 0.006, 0);
  const bottomClip = new THREE.Vector3(0.0012, -R - 0.0038, 0);

  // bait: #6 bait hook (eye at the origin, shank down -Y, bend toward +X) + coiled nightcrawler
  const bait = new THREE.Group();
  bait.name = 'bait';
  const hookParts = [
    { geometry: hookArmGeometry(0.024, 0.0092, 0.00042, 6, { shankFrac: 0.74, pointFrac: 0.4 }), group: 0 },
    { geometry: new THREE.TorusGeometry(0.0013, 0.00036, 5, 12).rotateY(Math.PI / 2).translate(0, 0.0012, 0), group: 0 },
  ];
  bait.add(new THREE.Mesh(mergeParts(hookParts).geometry, mats.hook));
  // nightcrawler threaded three times on the shank ("gob"), both ends dangling, hook point exposed
  const rest = [
    [-0.006, -0.05, 0.006],
    [-0.007, -0.036, 0.005],
    [-0.005, -0.022, 0.004],
    [-0.0025, -0.009, 0.002],
    [0.0, -0.0035, 0.0],
    [0.0045, -0.003, 0.0085],
    [0.0085, -0.0075, 0.006],
    [0.0015, -0.0095, 0.0],
    [-0.0065, -0.011, -0.007],
    [-0.0085, -0.0155, -0.002],
    [-0.001, -0.0165, 0.0],
    [0.0035, -0.0218, 0.0],
    [0.0076, -0.0152, 0.0],
    [0.0115, -0.021, -0.003],
    [0.013, -0.034, -0.004],
    [0.0115, -0.047, -0.003],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const ctrl = rest.map((v) => v.clone());
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const wormTube = createDynamicTube(Math.round(64 * q), q < 0.8 ? 6 : 8);
  const wormR = (s) => {
    const ends = smoothstep(0, 0.1, s) * smoothstep(1, 0.9, s);
    const clit = 1 + 0.14 * Math.exp(-Math.pow((s - 0.2) / 0.035, 2));
    return 0.0031 * (0.35 + 0.65 * ends) * clit;
  };
  wormTube.update(curve, wormR);
  const worm = new THREE.Mesh(wormTube.geometry, mats.worm);
  bait.add(worm);
  const shot = new THREE.Mesh(new THREE.SphereGeometry(0.0029, 10, 8), mats.lead);
  shot.name = 'splitshot';
  let wormT = 0;
  let wormAcc = 0;
  return {
    id: 'bobber',
    object: float,
    bait,
    shot,
    topClip,
    bottomClip,
    radius: R,
    tieLocal: new THREE.Vector3(0, 0.0012, 0), // hook eye in bait space
    size: 0.03,
    // info: { dt, inWater, speed, active (near camera) }
    update(info) {
      wormT += info.dt;
      wormAcc += info.dt;
      if (!info.active || wormAcc < 1 / 40) return;
      wormAcc = 0;
      const amp = info.inWater ? 0.0065 : 0.0022;
      const f = info.inWater ? 1.35 : 0.8;
      for (let i = 0; i < ctrl.length; i++) {
        const endA = i <= 3 ? (3 - i) / 3 : 0;
        const endB = i >= 13 ? (i - 12) / 3 : 0;
        const w = Math.max(endA, endB);
        const ph = wormT * f * Math.PI * 2 + i * 0.9 + (endB > 0 ? 1.7 : 0);
        ctrl[i].set(rest[i].x + Math.sin(ph) * amp * w, rest[i].y + Math.sin(ph * 0.7 + 0.5) * amp * 0.35 * w, rest[i].z + Math.cos(ph * 1.1) * amp * w);
      }
      wormTube.update(curve, wormR);
    },
  };
}

// ---------- inline spinner ----------
function makeSpinner(mats, q) {
  const root = new THREE.Group();
  root.name = 'spinner';
  const steel = [];
  steel.push({ geometry: sweepTube([new THREE.Vector3(0, 0, 0.031), new THREE.Vector3(0, 0, -0.0335)], 0.00042, 5), group: 0 });
  // nose eye and tail loop (wire loops in the YZ plane)
  steel.push({ geometry: new THREE.TorusGeometry(0.0021, 0.00042, 5, 14).rotateY(Math.PI / 2).translate(0, 0, 0.0332), group: 0 });
  steel.push({ geometry: new THREE.TorusGeometry(0.0019, 0.00042, 5, 14).rotateY(Math.PI / 2).translate(0, 0, -0.0352), group: 0 });
  // clevis (tiny U) holding the blade
  steel.push({
    geometry: sweepTube(
      [new THREE.Vector3(0, 0.0012, 0.0235), new THREE.Vector3(0, 0.0026, 0.0226), new THREE.Vector3(0, 0.0034, 0.0212), new THREE.Vector3(0, 0.0026, 0.0198), new THREE.Vector3(0, 0.0012, 0.019)],
      0.00032,
      4
    ),
    group: 0,
  });
  root.add(new THREE.Mesh(mergeParts(steel).geometry, mats.steel));
  // brass body: beads + bullet weight
  const brass = [];
  for (const [z, r] of [
    [0.0172, 0.0019],
    [0.0141, 0.0021],
    [0.0109, 0.0023],
  ])
    brass.push({ geometry: new THREE.SphereGeometry(r, 10, 8).translate(0, 0, z), group: 0 });
  const bullet = lathe(
    [
      [0.0006, -0.0215],
      [0.0024, -0.0205],
      [0.0036, -0.017],
      [0.0043, -0.009],
      [0.0042, -0.001],
      [0.0034, 0.0055],
      [0.0018, 0.0085],
      [0.0006, 0.009],
    ],
    16
  );
  bullet.rotateX(Math.PI / 2);
  brass.push({ geometry: bullet, group: 0 });
  root.add(new THREE.Mesh(mergeParts(brass).geometry, mats.brass));
  // blade: cupped French-style ellipse, hung from the clevis, trailing back and flared out
  const bladeGeo = (() => {
    const L = 0.031;
    const W = 0.0185;
    const nr = 8;
    const na = Math.round(20 * q);
    const pos = [0, 0, 0];
    const uv = [0.5, 0.5];
    const idx = [];
    for (let i = 1; i <= nr; i++) {
      const r = i / nr;
      for (let k = 0; k < na; k++) {
        const a = (k / na) * Math.PI * 2;
        const x = Math.cos(a) * r * W * 0.5;
        const zz = Math.sin(a) * r * L * 0.5;
        // pear shape: narrower toward the clevis end (+z)
        const narrow = 1 - 0.28 * clamp(zz / (L * 0.5), 0, 1);
        const y = 0.0032 * r * r; // cup depth
        pos.push(x * narrow, y, zz);
        uv.push(0.5 + Math.cos(a) * r * 0.5, 0.5 + Math.sin(a) * r * 0.5);
      }
    }
    for (let k = 0; k < na; k++) idx.push(0, 1 + ((k + 1) % na), 1 + k);
    for (let i = 1; i < nr; i++) {
      for (let k = 0; k < na; k++) {
        const a = 1 + (i - 1) * na + k;
        const b = 1 + (i - 1) * na + ((k + 1) % na);
        const c = 1 + i * na + k;
        const d = 1 + i * na + ((k + 1) % na);
        idx.push(a, b, d, a, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // attach point (front tip of the ellipse) at the origin
    g.translate(0, 0, -L * 0.5);
    return g;
  })();
  const bladePivot = new THREE.Group(); // spins about the shaft (Z)
  bladePivot.position.set(0, 0, 0.0212);
  const blade = new THREE.Mesh(bladeGeo, mats.blade);
  blade.position.set(0, 0.0035, 0);
  blade.rotation.x = 0.55; // trailing edge flares away from the shaft
  bladePivot.add(blade);
  root.add(bladePivot);
  // treble #10 trailing from the rear loop
  const treble = new THREE.Mesh(trebleGeometry(0.0135, 0.0058, 0.00036, 5), mats.blackNickel);
  treble.rotation.x = Math.PI / 2 - 0.25;
  treble.position.set(0, 0, -0.0366);
  root.add(treble);
  let spin = 0;
  return {
    id: 'spinner',
    object: root,
    tieLocal: new THREE.Vector3(0, 0, 0.0352),
    size: 0.068,
    update(info) {
      // blade rev rate ~ 17 rev/s at 1 m/s; flutters slowly while sinking
      const rate = info.inWater ? Math.max(info.speed * 105, info.sinking ? 18 : 0) : info.flying ? 6 : 0.6;
      spin += rate * info.dt;
      bladePivot.rotation.z = spin;
      treble.rotation.x = Math.PI / 2 - 0.25 + clamp(0.4 - info.speed, 0, 0.4) * 0.4 * Math.sin(spin * 0.07);
    },
  };
}

// ---------- crankbait ----------
function makeCrank(mats, q) {
  const root = new THREE.Group();
  root.name = 'crankbait';
  const L = 0.07;
  const bodyGeo = loftBody(
    L,
    (t) => {
      const e = Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 2)));
      const tail = 0.34 + 0.66 * smoothstep(0.0, 0.6, t);
      const nose = 1 - 0.18 * smoothstep(0.82, 1, t);
      return {
        h: 0.0112 * Math.pow(e, 0.72) * tail * nose,
        w: 0.0066 * Math.pow(e, 0.62) * (0.5 + 0.5 * smoothstep(0, 0.55, t)),
        c: -0.0012 * e + 0.0008 * smoothstep(0.7, 1, t),
      };
    },
    Math.round(40 * q),
    Math.round(24 * q)
  );
  root.add(new THREE.Mesh(bodyGeo, mats.crank));
  // clear diving lip: rounded plate from the chin, angled ~35 deg down
  const shape = new THREE.Shape();
  const lw = 0.0092;
  const ll = 0.024;
  shape.moveTo(-lw * 0.72, 0);
  shape.lineTo(-lw, ll * 0.55);
  shape.quadraticCurveTo(-lw, ll, 0, ll);
  shape.quadraticCurveTo(lw, ll, lw, ll * 0.55);
  shape.lineTo(lw * 0.72, 0);
  shape.lineTo(-lw * 0.72, 0);
  const lipGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.0011, bevelEnabled: false, curveSegments: 8 });
  lipGeo.translate(0, 0, -0.00055);
  const lipPivot = new THREE.Group();
  lipPivot.position.set(0, -0.0045, 0.0318);
  lipPivot.rotation.x = Math.PI / 2 + 0.6; // plate length (+Y) rotated to point forward and ~35 deg down
  const lip = new THREE.Mesh(lipGeo, mats.lip);
  lip.renderOrder = 2;
  lipPivot.add(lip);
  root.add(lipPivot);
  // line tie on the lip (~40% out)
  const tie = new THREE.Vector3(0, ll * 0.42, -0.0012);
  lipPivot.updateMatrix();
  tie.applyMatrix4(lipPivot.matrix);
  const steel = [];
  steel.push({ geometry: new THREE.TorusGeometry(0.0017, 0.00042, 5, 12).rotateY(Math.PI / 2).translate(tie.x, tie.y + 0.0008, tie.z), group: 0 });
  // hook hangers + split rings
  const bellyEye = new THREE.Vector3(0, -0.0128, 0.006);
  const tailEye = new THREE.Vector3(0, -0.0012, -0.0362);
  for (const e of [bellyEye, tailEye]) steel.push({ geometry: new THREE.TorusGeometry(0.0026, 0.00045, 5, 14).rotateY(Math.PI / 2).translate(e.x, e.y - 0.0018, e.z), group: 0 });
  root.add(new THREE.Mesh(mergeParts(steel).geometry, mats.steel));
  const trebleGeo = trebleGeometry(0.0185, 0.0082, 0.00047, 5);
  const t1 = new THREE.Mesh(trebleGeo, mats.blackNickel);
  t1.position.set(bellyEye.x, bellyEye.y - 0.0042, bellyEye.z);
  const t2 = new THREE.Mesh(trebleGeo, mats.blackNickel);
  t2.position.set(tailEye.x, tailEye.y - 0.0036, tailEye.z - 0.0012);
  t2.rotation.x = 0.9;
  root.add(t1, t2);
  const eGeo = eyeGeometry(0.0032);
  const eL = new THREE.Mesh(eGeo, mats.eye);
  const eR = new THREE.Mesh(eGeo, mats.eye);
  placeEye(eL, 0.0049, 0.0036, 0.0232, 1);
  placeEye(eR, -0.0049, 0.0036, 0.0232, -1);
  root.add(eL, eR);
  return {
    id: 'crankbait',
    object: root,
    tieLocal: tie.clone().add(new THREE.Vector3(0, 0.0018, 0.0006)),
    size: 0.075,
    update(info) {
      const s = clamp(info.speed / 0.8, 0, 1.3);
      t1.rotation.x = 0.15 + s * 0.7;
      t2.rotation.x = 0.9 + s * 0.5;
    },
  };
}

// ---------- walking topwater ----------
function makeTopwater(mats, q) {
  const root = new THREE.Group();
  root.name = 'topwater';
  const L = 0.114;
  const bodyGeo = loftBody(
    L,
    (t) => {
      const e = Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 2)));
      const r = 0.0096 * Math.pow(e, 0.78) * (0.62 + 0.38 * smoothstep(0, 0.62, t)) * (1 - 0.1 * smoothstep(0.85, 1, t));
      return { h: r, w: r * 0.97, c: 0 };
    },
    Math.round(44 * q),
    Math.round(22 * q)
  );
  root.add(new THREE.Mesh(bodyGeo, mats.topwater));
  const steel = [];
  steel.push({ geometry: new THREE.TorusGeometry(0.0021, 0.00045, 5, 14).rotateY(Math.PI / 2).translate(0, 0.0004, L / 2 + 0.0016), group: 0 });
  const bellyEye = new THREE.Vector3(0, -0.0094, 0.012);
  const tailEye = new THREE.Vector3(0, 0, -L / 2 - 0.0012);
  for (const e of [bellyEye, tailEye]) steel.push({ geometry: new THREE.TorusGeometry(0.0028, 0.00046, 5, 14).rotateY(Math.PI / 2).translate(e.x, e.y - 0.0019, e.z), group: 0 });
  root.add(new THREE.Mesh(mergeParts(steel).geometry, mats.steel));
  const trebleGeo = trebleGeometry(0.019, 0.0085, 0.00048, 5);
  const t1 = new THREE.Mesh(trebleGeo, mats.blackNickel);
  t1.position.set(bellyEye.x, bellyEye.y - 0.0045, bellyEye.z);
  const t2 = new THREE.Mesh(trebleGeo, mats.blackNickel);
  t2.position.set(tailEye.x, tailEye.y - 0.0038, tailEye.z - 0.0008);
  t2.rotation.x = 0.7;
  root.add(t1, t2);
  const eGeo = eyeGeometry(0.0034);
  const eL = new THREE.Mesh(eGeo, mats.eye);
  const eR = new THREE.Mesh(eGeo, mats.eye);
  placeEye(eL, 0.0066, 0.0026, 0.0405, 1);
  placeEye(eR, -0.0066, 0.0026, 0.0405, -1);
  root.add(eL, eR);
  return {
    id: 'topwater',
    object: root,
    tieLocal: new THREE.Vector3(0, 0.0004, L / 2 + 0.0035),
    size: 0.114,
    update(info) {
      const s = clamp(info.speed / 0.8, 0, 1.3);
      t1.rotation.x = 0.1 + s * 0.5;
      t2.rotation.x = 0.7 + s * 0.4;
    },
  };
}

export function createLureModels({ quality = 'high' } = {}) {
  const q = quality === 'low' ? 0.6 : quality === 'medium' ? 0.8 : 1;
  const mats = makeMaterials();
  const models = {
    bobber: makeFloatRig(mats, q),
    spinner: makeSpinner(mats, q),
    crankbait: makeCrank(mats, q),
    topwater: makeTopwater(mats, q),
  };
  return {
    models,
    materials: mats,
    dispose() {
      for (const m of Object.values(models)) {
        for (const o of [m.object, m.bait, m.shot]) {
          if (!o) continue;
          o.traverse((c) => c.geometry && c.geometry.dispose());
        }
      }
      for (const mat of Object.values(mats)) {
        if (mat.map) mat.map.dispose();
        mat.dispose();
      }
    },
  };
}
