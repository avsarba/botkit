// The wooden dock the player stands on: weathered cedar 2x6 decking with small gaps over 2x8
// stringers and headers on round pilings (dark wet band + algae at the waterline, X-braces under
// water), galvanized cleats and bolts, a coiled dock line, an old green tackle box and a minnow
// bucket by the player's feet. Real dimensions in meters.
import * as THREE from 'three';
import { DOCK, LAYERS, makeRng } from '../config.js';
import { MeshBuilder, addBox } from './geo.js';
import { makeDeckTextures, makePilingTextures, makeGalvanizedTextures, DECK_LAYOUT, pileV } from './dockTextures.js';
import { buildTackleBox, buildBucket, buildCleat, builderFromGeometry, makeRopeTextures, buildRopeCoil } from './props.js';

const PLANK = { w: 0.14, gap: 0.0062, thick: 0.038 };
const STRINGER = { w: 0.038, h: 0.184, xs: [-0.8, 0, 0.8] };
const BENT = { first: -0.72, spacing: 2.4, pileX: 0.95 };

export function buildDock({ env, quality, renderer }) {
  const group = new THREE.Group();
  group.name = 'dock';
  const rng = makeRng(2024);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4);
  const deckTex = makeDeckTextures(quality === 'low' ? 1024 : 2048, maxAniso);
  const { W, H, band, stripH } = deckTex.layout;

  const deckTopY = DOCK.deckY;
  const plankBot = deckTopY - PLANK.thick;
  const strTop = plankBot;
  const strBot = strTop - STRINGER.h;
  const hdrTop = strBot;
  const hdrBot = hdrTop - STRINGER.h;

  // ---------- UV helpers into the deck atlas
  const stripUV = (k, a, b, flipU, flipV) => {
    const u = flipU ? 1 - a : a;
    const bb = flipV ? 1 - b : b;
    return [(0.5 + u * (W - 1)) / W, (band + k * stripH + 0.5 + bb * (stripH - 1)) / H];
  };
  const texU = (x) => Math.min(1, Math.max(0, (x + 0.9) / 1.8));
  const endUV = (p, a, b) => [((p + 0.02 + a * 0.96) * (W / DECK_LAYOUT.endPatches)) / W, (0.5 + b * (band - 1)) / H];

  const wood = new MeshBuilder({ colors: true });
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  const _e = new THREE.Euler();

  // ---------- piling layout first (planks are notched around the posts)
  const bents = [];
  for (let z = BENT.first; z < DOCK.shoreZ - 0.3; z += BENT.spacing) bents.push(z);
  const pileSpecs = [];
  bents.forEach((zb, bi) => {
    for (const sx of [-1, 1]) {
      const r = 0.092 + rng() * 0.016;
      const x = sx * BENT.pileX;
      const bed = env.getTerrainHeight(x, zb);
      // tall mooring posts at the lake end, short stubs elsewhere
      const yTop = bi === 0 ? deckTopY + 0.5 + rng() * 0.08 : deckTopY + 0.07 + rng() * 0.12;
      if (!Number.isFinite(bed) || !(bed < yTop - 0.3)) continue;
      pileSpecs.push({ x, sx, z: zb, bi, r, bed, yTop, lean: [(rng() - 0.5) * 0.02, (rng() - 0.5) * 0.02], a0: rng() * Math.PI * 2 });
    }
  });
  const notchX = (side, z0, z1) => {
    let lim = 0.9;
    for (const p of pileSpecs) {
      if (p.sx !== side) continue;
      if (z1 < p.z - p.r - 0.004 || z0 > p.z + p.r + 0.004) continue;
      const dz = Math.max(0, Math.abs((z0 + z1) / 2 - p.z) - PLANK.w / 2);
      const half = Math.sqrt(Math.max(0, (p.r + 0.006) ** 2 - dz * dz));
      lim = Math.min(lim, BENT.pileX - half);
    }
    return lim;
  };

  // ---------- deck planks (run across the dock, x -0.9..0.9)
  const pitch = PLANK.w + PLANK.gap;
  const nPlanks = Math.floor((DOCK.shoreZ - DOCK.endZ + PLANK.gap) / pitch);
  for (let i = 0; i < nPlanks; i++) {
    const zc = DOCK.endZ + i * pitch + PLANK.w / 2;
    const k = Math.floor(rng() * DECK_LAYOUT.strips);
    const flipU = rng() < 0.5;
    const flipV = rng() < 0.5;
    const replaced = rng() < 0.03;
    const bright = 0.94 + rng() * 0.1;
    const tint = replaced ? [1.16 * bright, 1.0 * bright, 0.84 * bright] : [bright * (0.99 + rng() * 0.03), bright, bright * (0.98 + rng() * 0.03)];
    const dy = (rng() - 0.5) * 0.003;
    const cup = (rng() - 0.35) * 0.003; // + : edges lower than the middle
    const twist = (rng() - 0.5) * 0.004;
    const zA = zc - PLANK.w / 2;
    const zB = zc + PLANK.w / 2;
    const nl = notchX(-1, zA, zB);
    const nr = notchX(1, zA, zB);
    const x0 = nl < 0.9 ? -nl : -0.9 + (rng() - 0.5) * 0.014;
    const x1 = nr < 0.9 ? nr : 0.9 + (rng() - 0.5) * 0.014;
    _e.set(0, (rng() - 0.5) * 0.005, 0);
    _q.setFromEuler(_e);
    _p.set(0, 0, zc);
    _m.compose(_p, _q, _s);
    const pb = new MeshBuilder({ colors: true });
    const NA = 6;
    const NB = 3;
    const topY = (a, b) => deckTopY + dy - cup * (2 * b - 1) * (2 * b - 1) + twist * (a - 0.5) * (2 * b - 1);
    const hw = PLANK.w / 2;
    // top face grid
    const top = [];
    for (let ib = 0; ib < NB; ib++) {
      for (let ia = 0; ia < NA; ia++) {
        const a = ia / (NA - 1);
        const b = ib / (NB - 1);
        const x = x0 + (x1 - x0) * a;
        const z = -hw + b * PLANK.w; // local z
        const dydz = (-cup * 4 * (2 * b - 1) + twist * (a - 0.5) * 2) / PLANK.w;
        const dydx = (twist * (2 * b - 1)) / (x1 - x0);
        const nl = Math.hypot(dydx, 1, dydz);
        // texture u follows the real x so screw heads stay over the stringers on notched planks
        top.push(pb.vert([x, topY(a, b), z], [-dydx / nl, 1 / nl, -dydz / nl], stripUV(k, texU(x), 1 - b, flipU, flipV), tint));
      }
    }
    for (let ib = 0; ib < NB - 1; ib++) {
      for (let ia = 0; ia < NA - 1; ia++) {
        const a = top[ib * NA + ia];
        const b = top[ib * NA + ia + 1];
        const c = top[(ib + 1) * NA + ia + 1];
        const d = top[(ib + 1) * NA + ia];
        // b grows toward +z; the face points up
        pb.quad(d, c, b, a);
      }
    }
    // long edges (lake side at -z, shore side at +z)
    for (const side of [-1, 1]) {
      const b = side < 0 ? 0 : 1;
      const ids = [];
      for (let ia = 0; ia < NA; ia++) {
        const a = ia / (NA - 1);
        const x = x0 + (x1 - x0) * a;
        const yt = topY(a, b) - 0.0015;
        const z = side * hw;
        const t0 = pb.vert([x, yt, z], [0, 0, side], stripUV(k, texU(x), side < 0 ? 0.99 : 0.01, flipU, flipV), tint);
        const t1 = pb.vert([x, yt - PLANK.thick + 0.002, z], [0, 0, side], stripUV(k, texU(x), side < 0 ? 0.73 : 0.27, flipU, flipV), tint);
        ids.push([t0, t1]);
      }
      for (let ia = 0; ia < NA - 1; ia++) {
        const [a0, a1] = ids[ia];
        const [b0, b1] = ids[ia + 1];
        if (side > 0) pb.quad(a1, b1, b0, a0);
        else pb.quad(b1, a1, a0, b0);
      }
    }
    // ends: end grain
    const p = Math.floor(rng() * DECK_LAYOUT.endPatches);
    for (const side of [-1, 1]) {
      const x = side < 0 ? x0 : x1;
      const a = side < 0 ? 0 : 1;
      const yT0 = topY(a, 0) - 0.0015;
      const yT1 = topY(a, 1) - 0.0015;
      const v0 = pb.vert([x, yT0, -hw], [side, 0, 0], endUV(p, 0, 1), tint);
      const v1 = pb.vert([x, yT1, hw], [side, 0, 0], endUV(p, 1, 1), tint);
      const v2 = pb.vert([x, yT1 - PLANK.thick + 0.002, hw], [side, 0, 0], endUV(p, 1, 0), tint);
      const v3 = pb.vert([x, yT0 - PLANK.thick + 0.002, -hw], [side, 0, 0], endUV(p, 0, 0), tint);
      if (side > 0) pb.quad(v0, v1, v2, v3);
      else pb.quad(v3, v2, v1, v0);
    }
    // bottom (seen in the reflection)
    {
      const yb = deckTopY + dy - PLANK.thick;
      const v0 = pb.vert([x0, yb, -hw], [0, -1, 0], stripUV(k, texU(x0), 0.1, !flipU, flipV), tint);
      const v1 = pb.vert([x1, yb, -hw], [0, -1, 0], stripUV(k, texU(x1), 0.1, !flipU, flipV), tint);
      const v2 = pb.vert([x1, yb, hw], [0, -1, 0], stripUV(k, texU(x1), 0.9, !flipU, flipV), tint);
      const v3 = pb.vert([x0, yb, hw], [0, -1, 0], stripUV(k, texU(x0), 0.9, !flipU, flipV), tint);
      pb.quad(v0, v1, v2, v3);
    }
    wood.append(pb, _m);
  }

  // ---------- framing lumber (darker, less sun-bleached underside wood)
  const frameTint = [0.74, 0.68, 0.6];
  // box along an axis split into <= 1.8 m pieces mapped onto random strips
  const lumber = (cx, cy, cz, sx, sy, sz, tint = frameTint) => {
    const longAxis = sx >= sz ? 'x' : 'z';
    const len = Math.max(sx, sz);
    const pieces = Math.max(1, Math.ceil(len / 1.8));
    const plen = len / pieces;
    for (let i = 0; i < pieces; i++) {
      const k = Math.floor(rng() * DECK_LAYOUT.strips);
      const flip = rng() < 0.5;
      const off = -len / 2 + plen * (i + 0.5);
      const px = longAxis === 'x' ? cx + off : cx;
      const pz = longAxis === 'z' ? cz + off : cz;
      _m.makeTranslation(px, cy, pz);
      const ux = plen / 1.8;
      const uvFn = (f, a, b) => {
        // decide which face parameter runs along the board
        let along;
        let across;
        if (longAxis === 'x') {
          along = f === 'px' || f === 'nx' ? null : a;
          across = f === 'px' || f === 'nx' ? a : b;
          if (along === null) return endUV(k % DECK_LAYOUT.endPatches, a, b);
        } else {
          if (f === 'pz' || f === 'nz') return endUV(k % DECK_LAYOUT.endPatches, a, b);
          along = f === 'px' || f === 'nx' ? a : b;
          across = f === 'px' || f === 'nx' ? b : a;
        }
        return stripUV(k, along * ux, across, flip, false);
      };
      addBox(wood, longAxis === 'x' ? plen : sx, sy, longAxis === 'z' ? plen : sz, _m, uvFn, tint);
    }
  };
  const strZ0 = DOCK.endZ + 0.045;
  const strLen = DOCK.shoreZ - strZ0;
  for (const x of STRINGER.xs) lumber(x, (strTop + strBot) / 2, strZ0 + strLen / 2, STRINGER.w, STRINGER.h, strLen);
  // rim board across the lake end, just inside the plank ends
  lumber(0, (strTop + strBot) / 2, DOCK.endZ + 0.025, 1.8, STRINGER.h, STRINGER.w, [0.82, 0.78, 0.72]);

  // ---------- pilings + braces (piling material, world-y mapped texture)
  const pileTex = makePilingTextures(quality === 'low' ? 0.5 : 1);
  const piles = new MeshBuilder({ colors: false });
  const galv = new MeshBuilder({ colors: true });
  const segs = quality === 'low' ? 10 : 14;
  const boltGeo = new THREE.SphereGeometry(0.0135, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  boltGeo.scale(1, 0.45, 1);
  const boltB = builderFromGeometry(boltGeo);
  boltGeo.dispose();
  const rust = [0.55, 0.4, 0.3];
  const addBolt = (x, y, z, nx, ny, nz) => {
    _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, ny, nz));
    _p.set(x, y, z);
    _m.compose(_p, _q, _s);
    galv.append(boltB, _m, rust);
  };
  const pileInfo = [];
  bents.forEach((zb, bi) => {
    let wetBent = false;
    let bedMin = 0;
    for (const spec of pileSpecs) {
      if (spec.bi !== bi) continue;
      const { r, x, sx, bed, yTop, lean, a0 } = spec;
      const yBot = bed - 0.5;
      if (bed < -0.4) wetBent = true;
      bedMin = Math.min(bedMin, bed);
      pileInfo.push({ x, z: zb, r, bed, yTop });
      const ringsY = [yBot, Math.min(-0.3, (yBot + yTop) * 0.5), yTop - 0.014];
      if (ringsY[1] <= yBot + 0.05) ringsY.splice(1, 1);
      const ringIds = [];
      for (let ri = 0; ri < ringsY.length; ri++) {
        const y = ringsY[ri];
        const tt = (y - yBot) / (yTop - yBot);
        const ids = [];
        for (let j = 0; j <= segs; j++) {
          const ang = a0 + (j / segs) * Math.PI * 2;
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          const rr = r * (1 + Math.sin(ang * 3 + bi) * 0.025);
          ids.push(piles.vert([x + c * rr + lean[0] * tt, y, zb + s * rr + lean[1] * tt], [c, 0, s], [(j / segs) * 0.5, pileV(y)]));
        }
        ringIds.push(ids);
      }
      for (let ri = 0; ri < ringIds.length - 1; ri++) {
        for (let j = 0; j < segs; j++) {
          const a = ringIds[ri][j];
          const b = ringIds[ri][j + 1];
          const c = ringIds[ri + 1][j + 1];
          const d = ringIds[ri + 1][j];
          piles.quad(a, d, c, b);
        }
      }
      // chamfer + sawn top (end grain square in the right half of the texture)
      const ids0 = ringIds[ringIds.length - 1];
      const ids1 = [];
      const center = piles.vert([x + lean[0], yTop, zb + lean[1]], [0, 1, 0], [0.75, 0.125]);
      for (let j = 0; j <= segs; j++) {
        const ang = a0 + (j / segs) * Math.PI * 2;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        ids1.push(piles.vert([x + c * (r - 0.012) + lean[0], yTop, zb + s * (r - 0.012) + lean[1]], [c * 0.5, 0.86, s * 0.5], [(j / segs) * 0.5, pileV(yTop + 0.02)]));
      }
      for (let j = 0; j < segs; j++) piles.quad(ids0[j], ids1[j], ids1[j + 1], ids0[j + 1]);
      const capIds = [];
      for (let j = 0; j <= segs; j++) {
        const ang = a0 + (j / segs) * Math.PI * 2;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        capIds.push(piles.vert([x + c * (r - 0.012) + lean[0], yTop, zb + s * (r - 0.012) + lean[1]], [0, 1, 0], [0.75 + c * 0.24, 0.125 + s * 0.12]));
      }
      for (let j = 0; j < segs; j++) piles.tri(center, capIds[j + 1], capIds[j]);
      // through-bolts: header on the lake face, stringer through the pile
      addBolt(x, (hdrTop + hdrBot) / 2, zb - 0.1 - STRINGER.w - 0.001, 0, 0, -1);
      addBolt(x + sx * (r + 0.002), (strTop + strBot) / 2 + 0.03, zb, sx, 0, 0);
      addBolt(x + sx * (r + 0.002), (strTop + strBot) / 2 - 0.05, zb, sx, 0, 0);
    }
    // header across the bent (lake face of the pilings)
    lumber(0, (hdrTop + hdrBot) / 2, zb - 0.1 - STRINGER.w / 2, 2.14, STRINGER.h, STRINGER.w);
    // X-brace on the shore face of every other wet bent
    if (wetBent && bedMin < -0.9 && bi % 2 === 0) {
      const zf = zb + 0.108 + 0.019;
      const yHi = hdrBot - 0.05;
      const yLo = Math.max(bedMin + 0.35, -3.5);
      for (const dir of [-1, 1]) {
        const A = new THREE.Vector3(-dir * BENT.pileX, yHi, zf + (dir > 0 ? 0 : 0.04));
        const B = new THREE.Vector3(dir * BENT.pileX, yLo, zf + (dir > 0 ? 0 : 0.04));
        const d = new THREE.Vector3().subVectors(B, A);
        const len = d.length();
        d.normalize();
        _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
        _p.copy(A).add(B).multiplyScalar(0.5);
        _m.compose(_p, _q, _s);
        const start = piles.count;
        addBox(piles, len + 0.1, 0.14, 0.038, _m, (f, a) => [0.02 + a * 0.46, 0], null);
        for (let vi = start; vi < piles.count; vi++) {
          const y = piles.p[vi * 3 + 1];
          const along = (piles.p[vi * 3] - A.x) * d.x + (y - A.y) * d.y + (piles.p[vi * 3 + 2] - A.z) * d.z;
          piles.uv[vi * 2] = 0.02 + (along / len) * 0.46;
          piles.uv[vi * 2 + 1] = pileV(y);
        }
      }
    }
  });

  // ---------- meshes
  const deckMat = new THREE.MeshStandardMaterial({
    map: deckTex.map,
    normalMap: deckTex.normalMap,
    normalScale: new THREE.Vector2(1, 1),
    roughnessMap: deckTex.ormMap,
    metalnessMap: deckTex.ormMap,
    aoMap: deckTex.ormMap,
    aoMapIntensity: 0.9,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
  });
  deckMat.name = 'scenery.deck';
  const deckMesh = new THREE.Mesh(wood.build(), deckMat);
  deckMesh.name = 'dock.deck';
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  const pileMat = new THREE.MeshStandardMaterial({
    map: pileTex.map,
    normalMap: pileTex.normalMap,
    roughnessMap: pileTex.ormMap,
    aoMap: pileTex.ormMap,
    roughness: 1,
    metalness: 0,
  });
  pileMat.name = 'scenery.piling';
  const pileMesh = new THREE.Mesh(piles.build(), pileMat);
  pileMesh.name = 'dock.pilings';
  pileMesh.castShadow = true;
  pileMesh.receiveShadow = true;
  pileMesh.layers.enable(LAYERS.UNDERWATER);
  group.add(pileMesh);

  // ---------- props on the deck
  const cleatB = buildCleat();
  const cleats = [
    [-0.78, -0.56, 0],
    [0.78, -0.56, 0],
    [0.78, 3.05, 0],
    [-0.78, 9.1, 0],
  ];
  for (const [x, z, rot] of cleats) {
    _q.setFromEuler(_e.set(0, rot, 0));
    _p.set(x, deckTopY + 0.0005, z);
    _m.compose(_p, _q, _s);
    galv.append(cleatB, _m);
  }
  // minnow bucket by the right foot
  const bucketB = buildBucket();
  _q.setFromEuler(_e.set(0, 2.3, 0));
  _p.set(0.5, deckTopY + 0.0005, -0.36);
  _m.compose(_p, _q, _s);
  galv.append(bucketB, _m);

  const galvTex = makeGalvanizedTextures(256);
  const galvMat = new THREE.MeshStandardMaterial({
    map: galvTex.map,
    roughnessMap: galvTex.ormMap,
    metalnessMap: galvTex.ormMap,
    roughness: 1,
    metalness: 0.45,
    vertexColors: true,
    envMapIntensity: 0.7,
  });
  galvMat.name = 'scenery.galvanized';
  const galvMesh = new THREE.Mesh(galv.build(), galvMat);
  galvMesh.name = 'dock.hardware';
  galvMesh.layers.enable(LAYERS.NO_REFLECT); // small deck props: hidden by the deck in the mirror
  galvMesh.castShadow = true;
  galvMesh.receiveShadow = true;
  group.add(galvMesh);

  // tackle box at the left foot, lid facing up, latch toward the player
  const tb = buildTackleBox();
  const tbGroup = new THREE.Group();
  tbGroup.name = 'dock.tackleBox';
  tbGroup.position.set(-0.47, deckTopY + 0.0005, -0.3);
  tbGroup.rotation.y = 0.22;
  const tbPaintMat = new THREE.MeshStandardMaterial({
    map: tb.textures.map,
    normalMap: tb.textures.normalMap,
    roughnessMap: tb.textures.ormMap,
    metalnessMap: tb.textures.ormMap,
    roughness: 1,
    metalness: 1,
  });
  tbPaintMat.name = 'scenery.tacklebox';
  const tbPaint = new THREE.Mesh(tb.paint.build(), tbPaintMat);
  tbPaint.name = 'dock.tackleBox.paint';
  tbPaint.castShadow = true;
  tbPaint.layers.enable(LAYERS.NO_REFLECT);
  tbPaint.receiveShadow = true;
  tbGroup.add(tbPaint);
  const tbHw = new THREE.Mesh(tb.hardware.build(), galvMat);
  tbHw.name = 'dock.tackleBox.hardware';
  tbHw.castShadow = true;
  tbHw.layers.enable(LAYERS.NO_REFLECT);
  tbGroup.add(tbHw);
  group.add(tbGroup);

  // dock line coiled on the deck beside the player, tail around the end cleat
  const ropeTex = makeRopeTextures();
  const ropeGeo = buildRopeCoil(new THREE.Vector3(0.45, deckTopY, 0.2), new THREE.Vector3(0.78, deckTopY + 0.052, -0.56));
  const ropeMat = new THREE.MeshStandardMaterial({ map: ropeTex.map, normalMap: ropeTex.normalMap, roughness: 0.93, metalness: 0 });
  ropeMat.name = 'scenery.rope';
  const rope = new THREE.Mesh(ropeGeo, ropeMat);
  rope.name = 'dock.rope';
  rope.castShadow = true;
  rope.layers.enable(LAYERS.NO_REFLECT);
  rope.receiveShadow = true;
  group.add(rope);

  const metalMaterials = [galvMat, tbPaintMat];

  // Deck top (DOCK.deckY) over the deck footprint; the top of a post where a piling pokes up
  // through/beside the deck edge (lake-end mooring posts, stubs along the sides); else null.
  function dockTopAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (Math.abs(x) > 1.1 || z < DOCK.endZ - 0.2 || z > DOCK.shoreZ + 0.2) return null;
    for (let i = 0; i < pileSpecs.length; i++) {
      const p = pileSpecs[i];
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz <= p.r * p.r) return p.yTop;
    }
    if (Math.abs(x) <= DOCK.width / 2 && z >= DOCK.endZ && z <= DOCK.shoreZ) return DOCK.deckY;
    return null;
  }

  return { group, dockTopAt, metalMaterials, pileInfo, textures: [deckTex.map, deckTex.normalMap, deckTex.ormMap, pileTex.map, pileTex.normalMap, pileTex.ormMap, galvTex.map, galvTex.ormMap, tb.textures.map, tb.textures.normalMap, tb.textures.ormMap, ropeTex.map, ropeTex.normalMap] };
}
