// Life on the lake: a common loon that drifts 60-130 m out, dives and resurfaces elsewhere;
// a few distant birds (ring-billed gulls, a raven, a bald eagle) gliding in wide circles; and
// dragonflies darting over the reeds near the dock in daylight. All per-frame work reuses scratch
// objects; geometry is tiny.
import * as THREE from 'three';
import { makeRng, clamp, smoothstep, damp, LAYERS } from '../config.js';
import { MeshBuilder } from './geo.js';
import { builderFromGeometry } from './props.js';
import { dataTexture } from './texutil.js';

const srgb = (r, g, b) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);

// ---------------------------------------------------------------- loon
function makeLoonTexture() {
  // 128 x 64: left half = body (u around, v top->bottom), right half = neck collar stripes
  const W = 128;
  const H = 64;
  const d = new Uint8Array(W * H * 4);
  const rng = makeRng(99);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let c = 14;
      if (x < 64) {
        // back and flanks: rows of small white spots in a checker pattern (breeding plumage)
        const v = y / H;
        const row = Math.floor(v * 22);
        const col = Math.floor(((x + (row % 2) * 1.5) / 64) * 32);
        const inRow = (v * 22) % 1;
        const inCol = (((x + (row % 2) * 1.5) / 64) * 32) % 1;
        if (v > 0.12 && v < 0.62 && inRow > 0.35 && inRow < 0.75 && inCol > 0.25 && inCol < 0.75 && rng() > 0.08) c = 205 + ((col * 7 + row * 3) % 5) * 6;
        // white breast below the waterline side
        if (v > 0.8) c = 215;
      } else {
        // collar: narrow vertical white stripes on a black band
        const v = y / H;
        const u = (x - 64) / 64;
        if (v > 0.4 && v < 0.62 && (u * 40) % 1 < 0.45) c = 220;
      }
      d[i] = d[i + 1] = d[i + 2] = c;
      d[i + 3] = 255;
    }
  }
  return dataTexture(d, W, H, { srgb: true, anisotropy: 2 });
}

function buildLoonGeometry() {
  const B = new MeshBuilder({ colors: true });
  const black = [1, 1, 1];
  // body: sphere with UVs into the left half; the long axis is +z (forward = -z)
  const body = new THREE.SphereGeometry(1, 18, 12);
  body.scale(0.13, 0.11, 0.31);
  const uv = body.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5, 1 - uv.getY(i));
  body.translate(0, 0.012, 0.02);
  B.append(builderFromGeometry(body, null, black));
  body.dispose();
  // tail
  const tail = new THREE.ConeGeometry(0.05, 0.12, 6);
  tail.rotateX(Math.PI / 2);
  tail.scale(1, 0.45, 1);
  tail.translate(0, 0.03, 0.34);
  const tb = builderFromGeometry(tail, null, black);
  for (let i = 0; i < tb.count; i++) tb.uv[i * 2] = 0.05;
  B.append(tb);
  tail.dispose();
  // neck with collar stripes (right half of the texture)
  const neck = new THREE.CylinderGeometry(0.036, 0.052, 0.17, 10, 1, true);
  const nuv = neck.attributes.uv;
  for (let i = 0; i < nuv.count; i++) nuv.setXY(i, 0.5 + nuv.getX(i) * 0.5, 1 - nuv.getY(i));
  neck.rotateX(0.35);
  neck.translate(0, 0.12, -0.2);
  B.append(builderFromGeometry(neck, null, [0.9, 0.95, 0.95]));
  neck.dispose();
  // head (black with a green gloss) + dagger bill + red eyes
  const head = new THREE.SphereGeometry(1, 12, 9);
  head.scale(0.05, 0.052, 0.07);
  const huv = head.attributes.uv;
  for (let i = 0; i < huv.count; i++) huv.setXY(i, 0.02, 0.02);
  head.translate(0, 0.205, -0.25);
  B.append(builderFromGeometry(head, null, [0.85, 1.25, 1.05]));
  head.dispose();
  const bill = new THREE.ConeGeometry(0.014, 0.1, 6);
  bill.rotateX(-Math.PI / 2 - 0.08);
  bill.scale(1, 0.8, 1);
  bill.translate(0, 0.196, -0.355);
  const bb = builderFromGeometry(bill, null, [0.9, 0.9, 0.9]);
  for (let i = 0; i < bb.count; i++) {
    bb.uv[i * 2] = 0.02;
    bb.uv[i * 2 + 1] = 0.02;
  }
  B.append(bb);
  bill.dispose();
  for (const sx of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.009, 6, 4);
    eye.translate(sx * 0.042, 0.215, -0.275);
    const eb = builderFromGeometry(eye, null, [0.85, 0.05, 0.04]);
    for (let i = 0; i < eb.count; i++) {
      eb.uv[i * 2] = 0.25;
      eb.uv[i * 2 + 1] = 0.92;
    }
    B.append(eb);
    eye.dispose();
  }
  return B.build();
}

// ---------------------------------------------------------------- birds
function buildBirdGeometry(kind) {
  // unit bird, wingspan ~1 m, flying toward -z. Wing vertices are recomputed per frame.
  const B = new MeshBuilder({ colors: true });
  const cols = {
    gull: { body: srgb(236, 236, 232), wing: srgb(170, 176, 182), tip: srgb(24, 24, 26), head: srgb(240, 240, 236) },
    raven: { body: srgb(18, 18, 22), wing: srgb(20, 20, 24), tip: srgb(14, 14, 16), head: srgb(16, 16, 20) },
    eagle: { body: srgb(52, 36, 24), wing: srgb(46, 32, 22), tip: srgb(30, 22, 16), head: srgb(236, 232, 222) },
  }[kind];
  const body = new THREE.SphereGeometry(1, 8, 6);
  body.scale(0.06, 0.06, kind === 'eagle' ? 0.26 : 0.22);
  B.append(builderFromGeometry(body, null, [cols.body.r, cols.body.g, cols.body.b]));
  body.dispose();
  const head = new THREE.SphereGeometry(1, 7, 5);
  head.scale(0.045, 0.045, 0.06);
  head.translate(0, 0.02, -0.22);
  B.append(builderFromGeometry(head, null, [cols.head.r, cols.head.g, cols.head.b]));
  head.dispose();
  // tail
  const tailCol = kind === 'eagle' ? cols.head : cols.body;
  const t0 = B.vert([-0.05, 0, 0.16], [0, 1, 0], [0, 0], [tailCol.r, tailCol.g, tailCol.b]);
  const t1 = B.vert([0.05, 0, 0.16], [0, 1, 0], [0, 0], [tailCol.r, tailCol.g, tailCol.b]);
  const t2 = B.vert([0.07, 0, 0.3], [0, 1, 0], [0, 0], [tailCol.r, tailCol.g, tailCol.b]);
  const t3 = B.vert([-0.07, 0, 0.3], [0, 1, 0], [0, 0], [tailCol.r, tailCol.g, tailCol.b]);
  B.quad(t0, t1, t2, t3);
  const wingStart = B.count;
  // each wing: root (2 verts), elbow (2), tip (1)
  for (const side of [-1, 1]) {
    const c = (col) => [col.r, col.g, col.b];
    const r0 = B.vert([0, 0, -0.08], [0, 1, 0], [0, 0], c(cols.wing));
    const r1 = B.vert([0, 0, 0.06], [0, 1, 0], [0, 0], c(cols.wing));
    const e0 = B.vert([side * 0.24, 0, -0.07], [0, 1, 0], [0, 0], c(cols.wing));
    const e1 = B.vert([side * 0.24, 0, 0.07], [0, 1, 0], [0, 0], c(cols.wing));
    const tp = B.vert([side * 0.5, 0, 0.04], [0, 1, 0], [0, 0], c(cols.tip));
    const tp2 = B.vert([side * 0.44, 0, 0.1], [0, 1, 0], [0, 0], c(cols.tip));
    if (side < 0) {
      B.quad(r0, e0, e1, r1);
      B.quad(e0, tp, tp2, e1);
    } else {
      B.quad(r0, r1, e1, e0);
      B.quad(e0, e1, tp2, tp);
    }
  }
  const g = B.build();
  g.userData.wingStart = wingStart;
  return g;
}

function setWings(geo, flap, fold) {
  // flap: -1..1 (up..down) angle of the wing, fold: 0..1 outer panel bend
  const pos = geo.attributes.position;
  const s = geo.userData.wingStart;
  const a = flap * 0.6;
  const b = a * (1 + fold * 0.8);
  for (let w = 0; w < 2; w++) {
    const side = w === 0 ? -1 : 1;
    const o = s + w * 6;
    const ex = Math.cos(a) * 0.24;
    const ey = Math.sin(a) * 0.24;
    pos.setXYZ(o + 2, side * ex, ey, -0.07);
    pos.setXYZ(o + 3, side * ex, ey, 0.07);
    pos.setXYZ(o + 4, side * (ex + Math.cos(b) * 0.26), ey + Math.sin(b) * 0.26, 0.04);
    pos.setXYZ(o + 5, side * (ex + Math.cos(b) * 0.2), ey + Math.sin(b) * 0.2, 0.1);
  }
  pos.needsUpdate = true;
}

// ---------------------------------------------------------------- dragonflies
function buildDragonflyGeometry() {
  const B = new MeshBuilder({ colors: true });
  const thorax = srgb(58, 96, 52);
  const abdomen = srgb(40, 70, 120);
  const body = new THREE.CylinderGeometry(0.0022, 0.003, 0.055, 5);
  body.rotateX(Math.PI / 2);
  body.translate(0, 0, 0.018);
  B.append(builderFromGeometry(body, null, [abdomen.r, abdomen.g, abdomen.b]));
  body.dispose();
  const th = new THREE.SphereGeometry(0.0055, 6, 4);
  th.scale(1, 1, 1.4);
  th.translate(0, 0, -0.012);
  B.append(builderFromGeometry(th, null, [thorax.r, thorax.g, thorax.b]));
  th.dispose();
  const wing = srgb(200, 206, 210);
  for (const [z, len] of [
    [-0.014, 0.042],
    [-0.004, 0.038],
  ]) {
    for (const side of [-1, 1]) {
      const a = B.vert([0, 0.002, z - 0.004], [0, 1, 0], [0, 0], [wing.r, wing.g, wing.b]);
      const b = B.vert([side * len, 0.003, z - 0.002], [0, 1, 0], [0, 0], [wing.r, wing.g, wing.b]);
      const c = B.vert([side * len, 0.003, z + 0.004], [0, 1, 0], [0, 0], [wing.r, wing.g, wing.b]);
      const d = B.vert([0, 0.002, z + 0.004], [0, 1, 0], [0, 0], [wing.r, wing.g, wing.b]);
      B.quad(a, b, c, d);
    }
  }
  return B.build();
}

// ---------------------------------------------------------------- system
export function buildWildlife({ env, quality, events, grid, reedAnchors }) {
  const group = new THREE.Group();
  group.name = 'wildlife';
  const rng = makeRng(31337);
  const depthAt = (x, z) => {
    const d = env.getDepth ? env.getDepth(x, z) : -env.getTerrainHeight(x, z);
    return Number.isFinite(d) ? d : 0;
  };

  // --- loon
  const loonMat = new THREE.MeshStandardMaterial({ map: makeLoonTexture(), vertexColors: true, roughness: 0.42, metalness: 0 });
  loonMat.name = 'scenery.loon';
  const loon = new THREE.Mesh(buildLoonGeometry(), loonMat);
  loon.name = 'wildlife.loon';
  loon.layers.enable(LAYERS.UNDERWATER);
  group.add(loon);
  const L = {
    pos: new THREE.Vector3(),
    heading: 0,
    speed: 0.2,
    state: 'swim',
    t: 0,
    next: 20 + rng() * 40,
    target: new THREE.Vector3(),
    pitch: 0,
    bob: 0,
    ok: false,
    scale: 0.95 + rng() * 0.1,
  };
  // valid spot: deep enough, inside the visible arc, 60-130 m out
  const _cand = new THREE.Vector3();
  function findLoonSpot(out, near = null) {
    for (let i = 0; i < 60; i++) {
      let x;
      let z;
      if (near && i < 40) {
        const a = rng() * Math.PI * 2;
        const r = 25 + rng() * 35;
        x = near.x + Math.cos(a) * r;
        z = near.z + Math.sin(a) * r;
      } else {
        const az = (rng() - 0.5) * 2 * 1.2; // within about +-70 degrees of straight out
        const r = 60 + rng() * 70;
        x = Math.sin(az) * r;
        z = -Math.cos(az) * r;
      }
      const R = Math.hypot(x, z);
      const az = Math.atan2(x, -z);
      if (R < 55 || R > 140 || Math.abs(az) > 1.35) continue;
      if (depthAt(x, z) < 2.2) continue;
      out.set(x, 0, z);
      return true;
    }
    return false;
  }
  L.ok = findLoonSpot(L.pos);
  L.heading = rng() * Math.PI * 2;
  loon.visible = L.ok;

  function loonDive() {
    if (L.state !== 'swim') return;
    L.state = 'diving';
    L.t = 0;
  }
  const offs = [];
  if (events && events.on) {
    offs.push(
      events.on('lure:landed', (e) => {
        if (e && e.position && L.ok && L.state === 'swim' && e.position.distanceTo(L.pos) < 14) loonDive();
      })
    );
    offs.push(
      events.on('fish:jump', (e) => {
        if (e && e.position && L.ok && L.state === 'swim' && e.position.distanceTo(L.pos) < 20) loonDive();
      })
    );
  }

  // --- birds
  const birds = [];
  const kinds = quality === 'low' ? ['gull', 'raven'] : ['gull', 'gull', 'raven', 'eagle'];
  const birdMats = {};
  for (const kind of kinds) {
    if (!birdMats[kind]) {
      birdMats[kind] = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      birdMats[kind].name = 'scenery.bird';
    }
    const geo = buildBirdGeometry(kind);
    const mesh = new THREE.Mesh(geo, birdMats[kind]);
    mesh.name = `wildlife.${kind}`;
    const span = kind === 'eagle' ? 2.0 : kind === 'raven' ? 1.2 : 1.25;
    mesh.scale.setScalar(span);
    mesh.frustumCulled = true;
    mesh.layers.enable(LAYERS.NO_REFLECT);
    group.add(mesh);
    const az = (rng() - 0.5) * 2.4;
    const R = 160 + rng() * 260;
    birds.push({
      kind,
      mesh,
      geo,
      c: new THREE.Vector3(Math.sin(az) * R, 0, -Math.cos(az) * R),
      drift: new THREE.Vector2(rng() - 0.5, rng() - 0.5).normalize().multiplyScalar(0.6 + rng()),
      r: kind === 'eagle' ? 70 + rng() * 60 : 35 + rng() * 70,
      alt: kind === 'eagle' ? 90 + rng() * 60 : 25 + rng() * 45,
      speed: kind === 'eagle' ? 8 : kind === 'raven' ? 10.5 : 9.5,
      dir: rng() < 0.5 ? 1 : -1,
      ang: rng() * Math.PI * 2,
      flapT: rng() * 5,
      flapping: 0,
      phase: rng() * 10,
    });
  }

  // --- dragonflies around reed clumps close to the dock
  const dfCount = quality === 'high' ? 5 : quality === 'medium' ? 3 : 0;
  const anchors = (reedAnchors || []).filter((a) => Math.hypot(a.x, a.z) < 32).slice(0, 12);
  if (!anchors.length) {
    // fall back to the waterline beside the dock's shore end
    anchors.push({ x: -2.5, y: 0, z: 14 }, { x: 2.5, y: 0, z: 13 });
  }
  const dfMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  dfMat.name = 'scenery.dragonfly';
  const dfMesh = new THREE.InstancedMesh(buildDragonflyGeometry(), dfMat, Math.max(1, dfCount));
  dfMesh.name = 'wildlife.dragonflies';
  dfMesh.frustumCulled = false;
  dfMesh.layers.enable(LAYERS.NO_REFLECT);
  dfMesh.count = dfCount;
  if (dfCount > 0) group.add(dfMesh);
  const flies = [];
  for (let i = 0; i < dfCount; i++) {
    const a = anchors[i % anchors.length];
    flies.push({
      pos: new THREE.Vector3(a.x, 0.6, a.z),
      from: new THREE.Vector3(a.x, 0.6, a.z),
      to: new THREE.Vector3(a.x, 0.6, a.z),
      t: 1,
      dur: 0.5,
      wait: rng() * 2,
      yaw: rng() * 6.28,
      anchor: i % anchors.length,
    });
  }

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _s = new THREE.Vector3();
  const _p = new THREE.Vector3();

  function updateLoon(dt, time, water) {
    if (!L.ok) return;
    L.t += dt;
    const wy = water && water.getHeight ? water.getHeight(L.pos.x, L.pos.z) : Math.sin(time * 0.9 + L.pos.x) * 0.01;
    const surfaceY = Number.isFinite(wy) ? wy : 0;
    if (L.state === 'swim') {
      // gentle random-walk heading, steer back toward the good band
      L.heading += (Math.sin(time * 0.07 + 1.3) * 0.5 + (rng() - 0.5) * 0.6) * dt * 0.35;
      const R = Math.hypot(L.pos.x, L.pos.z);
      const az = Math.atan2(L.pos.x, -L.pos.z);
      const ahead = depthAt(L.pos.x - Math.sin(L.heading) * 8, L.pos.z - Math.cos(L.heading) * 8);
      if (R > 135 || R < 58 || Math.abs(az) > 1.3 || ahead < 2.2) {
        // turn toward a point ~95 m straight out
        const want = Math.atan2(L.pos.x - Math.sin(az * 0.5) * 95, L.pos.z + Math.cos(az * 0.5) * 95);
        let dh = want - L.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        L.heading += clamp(dh, -0.4 * dt, 0.4 * dt);
      }
      L.speed = damp(L.speed, 0.12 + 0.12 * (0.5 + 0.5 * Math.sin(time * 0.05)), 0.5, dt);
      L.pos.x -= Math.sin(L.heading) * L.speed * dt;
      L.pos.z -= Math.cos(L.heading) * L.speed * dt;
      L.pitch = damp(L.pitch, 0, 3, dt);
      L.bob = surfaceY;
      if (water && water.wake) water.wake(L.pos.x, L.pos.z, -Math.sin(L.heading), -Math.cos(L.heading), L.speed);
      if (L.t > L.next) loonDive();
    } else if (L.state === 'diving') {
      // lunge forward and slip under head-first
      const k = clamp(L.t / 1.3, 0, 1);
      L.pitch = Math.sin(k * Math.PI * 0.5) * 0.55;
      L.bob = surfaceY - k * k * 0.75;
      L.pos.x -= Math.sin(L.heading) * 0.6 * dt;
      L.pos.z -= Math.cos(L.heading) * 0.6 * dt;
      if (k >= 1) {
        if (water && water.addRipple) water.addRipple(L.pos.x, L.pos.z, 0.45, 2.5);
        L.state = 'under';
        L.t = 0;
        L.next = 18 + rng() * 32;
        if (!findLoonSpot(L.target, L.pos)) L.target.copy(L.pos);
      }
    } else if (L.state === 'under') {
      if (L.t > L.next) {
        L.pos.copy(L.target);
        L.heading = rng() * Math.PI * 2;
        L.state = 'surfacing';
        L.t = 0;
        if (water && water.addRipple) water.addRipple(L.pos.x, L.pos.z, 0.35, 2);
      }
    } else if (L.state === 'surfacing') {
      const k = clamp(L.t / 0.9, 0, 1);
      L.pitch = (1 - k) * -0.3;
      L.bob = surfaceY - (1 - k) * (1 - k) * 0.5;
      if (k >= 1) {
        L.state = 'swim';
        L.t = 0;
        L.next = 25 + rng() * 60;
      }
    }
    loon.visible = L.state !== 'under';
    // gentle wave rocking
    const rock = Math.sin(time * 1.3 + L.pos.x * 0.1) * 0.03;
    _e.set(L.pitch + rock, L.heading, Math.sin(time * 1.1 + 2) * 0.03, 'YXZ');
    loon.position.set(L.pos.x, L.bob, L.pos.z);
    loon.rotation.copy(_e);
    loon.scale.setScalar(L.scale);
  }

  function updateBirds(dt, time, hours) {
    const day = hours > 5.3 && hours < 21.2;
    for (const b of birds) {
      b.mesh.visible = day;
      if (!day) continue;
      b.c.x += b.drift.x * dt;
      b.c.z += b.drift.y * dt;
      const R = Math.hypot(b.c.x, b.c.z);
      if (R > 480 || R < 140) {
        // drift back into the band over the lake
        b.drift.set(-b.c.x, -b.c.z).normalize().multiplyScalar(R > 480 ? 1 : -1);
      }
      b.ang += (b.dir * b.speed * dt) / b.r;
      const x = b.c.x + Math.cos(b.ang) * b.r;
      const z = b.c.z + Math.sin(b.ang) * b.r;
      const y = b.alt + Math.sin(time * 0.13 + b.phase) * 6;
      // heading along the circle; bank into the turn
      const hx = -Math.sin(b.ang) * b.dir;
      const hz = Math.cos(b.ang) * b.dir;
      const yaw = Math.atan2(-hx, -hz);
      b.flapT -= dt;
      if (b.flapT <= 0) {
        b.flapping = b.kind === 'eagle' ? 1.2 : b.kind === 'raven' ? 2.5 : 1.6 + rng() * 1.5;
        b.flapT = (b.kind === 'eagle' ? 14 : 4) + rng() * 8;
      }
      let flap = -0.12;
      let fold = 0.3;
      if (b.flapping > 0) {
        b.flapping -= dt;
        const f = b.kind === 'eagle' ? 2.2 : b.kind === 'raven' ? 3.4 : 3.0;
        flap = Math.sin(time * f * Math.PI * 2 + b.phase) * 0.9;
        fold = 0.6;
      } else if (b.kind === 'eagle') {
        flap = -0.2; // soaring dihedral
        fold = -0.2;
      }
      setWings(b.geo, flap, fold);
      b.mesh.position.set(x, y, z);
      b.mesh.rotation.set(0, yaw, -b.dir * 0.28, 'YXZ');
    }
  }

  function updateFlies(dt, time, hours, wind) {
    if (!flies.length) return;
    const active = hours > 8.5 && hours < 19 && wind < 0.75;
    dfMesh.visible = active;
    if (!active) return;
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / f.dur);
        const k = f.t * f.t * (3 - 2 * f.t);
        f.pos.lerpVectors(f.from, f.to, k);
        f.pos.y += Math.sin(f.t * Math.PI) * 0.15;
      } else {
        f.wait -= dt;
        f.pos.x += Math.sin(time * 9 + i) * 0.004;
        f.pos.y += Math.sin(time * 7 + i * 2) * 0.003;
        if (f.wait <= 0) {
          // dart to a new hover point near an anchor (sometimes switch anchors)
          if (rng() < 0.25) f.anchor = Math.floor(rng() * anchors.length);
          const a = anchors[f.anchor];
          f.from.copy(f.pos);
          f.to.set(a.x + (rng() - 0.5) * 5, 0.3 + rng() * 1.1, a.z + (rng() - 0.5) * 5);
          const d = f.from.distanceTo(f.to);
          f.dur = Math.max(0.15, d / (4 + rng() * 4));
          f.t = 0;
          f.wait = 0.4 + rng() * 2.6;
          f.yaw = Math.atan2(-(f.to.x - f.from.x), -(f.to.z - f.from.z));
        }
      }
      const flick = 0.75 + 0.5 * Math.abs(Math.sin(time * 90 + i * 13));
      _q.setFromEuler(_e.set(0, f.yaw + Math.sin(time * 3 + i) * 0.1, 0, 'YXZ'));
      _s.set(flick, 1, 1);
      _p.copy(f.pos);
      _m.compose(_p, _q, _s);
      dfMesh.setMatrixAt(i, _m);
    }
    dfMesh.instanceMatrix.needsUpdate = true;
  }

  return {
    group,
    loonPosition: () => L.pos,
    update(frame, water) {
      const dt = frame && Number.isFinite(frame.dt) ? clamp(frame.dt, 0, 0.1) : 0.016;
      const time = frame && Number.isFinite(frame.time) ? frame.time : 0;
      const hours = frame && Number.isFinite(frame.hours) ? frame.hours : 12;
      const wind = Number.isFinite(env.windStrength) ? env.windStrength : 0.25;
      updateLoon(dt, time, water);
      updateBirds(dt, time, hours);
      updateFlies(dt, time, hours, wind);
    },
    dispose() {
      for (const off of offs) if (typeof off === 'function') off();
    },
  };
}
