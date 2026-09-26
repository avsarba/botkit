// Catch showcase: the landed fish held up in front of the camera while the catch card is open.
// It is drawn in its own small scene after the main pass (depth cleared), so it never clips into the
// rod, the dock or the water. Its key light follows the scene's sun (or moon) and colour, with a
// headlamp look at night; the fill follows the scene's sky / ground light.
//
// Framing: the fish sits in the part of the screen the catch card leaves free (beside a side-panel
// card, above a bottom sheet), measured from the UI's getCatchRect() so the two always agree, and its
// on-screen size follows its real length: a 20 cm bluegill is held small, a 1 m pike fills the space.
//
// Shader programs: the showcase lights differ from the lake's, so its fish needs its own program variants.
// They are compiled without blocking before the fish appears (compileAsync), and kept alive between
// catches by tiny never-drawn stand-ins (the fish's materials are disposed on hide(), which would
// otherwise delete the programs and make every catch compile them again).
//
// VR (setXR(true, { holdGrip })): show() puts the high-detail fish in the hold grip (the reel hand) at
// real size, held by the lower jaw, the body hanging under its own weight (a damped pendulum from the
// jaw that swings when the hand moves, twisting with the wrist so the flank faces the eyes), gently
// flexing and breathing. It is part of the lake scene, lit by its sun, sky and environment map (the
// same programs as the hooked fish), so render() draws nothing: no overlay pass, no depth clear.
import * as THREE from 'three';
import { DOCK, clamp, damp, lerp, smoothstep } from '../config.js';

// VR hold
const XR_JAW_GRIP = new THREE.Vector3(0, 0.012, -0.075); // grip space: thumb / index pinch just ahead of the fist
const XR_JAW_CAMERA = new THREE.Vector3(-0.17, -0.32, -0.42); // camera space: when no grip was given
const XR_EXHAUSTION = 0.35; // tired, not spent: slow fins, gills working, a slight roll
const XR_JAW_STIFF = 18; // 1/s^2: the gripped jaw's resistance to swinging, on top of gravity
const XR_DAMP = 0.32; // share of critical damping of the swing
const XR_FLOOR_CLEAR = 0.05; // m: the tail stays this far above the deck (long fish lean out instead)

// Bottom sheet vs side panel: the same rule as the card's CSS (width <= 720 px unless <= 520 px tall, or
// aspect <= 0.85). Only used when the UI can't report the card's rect.
const SHEET_MAX_W = 720;
const SHEET_MIN_H = 521;
const SHEET_MAX_ASPECT = 0.85;
const RECT_TTL_S = 0.15;

// Optional provider of the catch card's rect (viewport CSS px), set by main.js from the UI.
let catchRectSource = null;
export function setCatchRectSource(fn) {
  catchRectSource = typeof fn === 'function' ? fn : null;
}
// Optional factory of a stand-in fish with the showcase fish's materials (fish/mesh.js
// createFishProgramKeeper), set by main.js: the showcase compiles its programs once, at load.
let standInFactory = null;
export function setShowcaseStandIn(fn) {
  standInFactory = typeof fn === 'function' ? fn : null;
}

export function createShowcase({ renderer, camera, createFishMesh, getCatchRect = null }) {
  const scene = new THREE.Scene();
  scene.name = 'showcase';
  const rig = new THREE.Group(); // follows the camera
  rig.matrixAutoUpdate = false;
  scene.add(rig);
  const holder = new THREE.Group();
  rig.add(holder);

  const key = new THREE.DirectionalLight(0xfff1de, 1);
  key.position.set(-0.7, 0.9, 1.1);
  const keyTarget = new THREE.Object3D();
  keyTarget.position.set(0, 0, -1);
  rig.add(key, keyTarget);
  key.target = keyTarget;
  const rim = new THREE.DirectionalLight(0xd6e6ff, 1);
  rim.position.set(0.9, 0.7, -1.6);
  rig.add(rim);
  rim.target = keyTarget;
  const fill = new THREE.HemisphereLight(0xdfe9f2, 0x3b3426, 1);
  rig.add(fill);

  let fish = null;
  let t = 0;
  let appear = 0;
  let lengthM = 0.3;
  let ready = true; // programs compiled: the fish may be drawn
  let showToken = 0;
  // A fish whose compileAsync is still being polled must not have its materials disposed before it settles:
  // three.js' readiness check would then read a disposed material and throw ("reading 'isReady'"). hide()
  // detaches such a fish at once and disposes it when its compile settles.
  const compiling = new WeakMap(); // fish handle -> promise that settles with its compile
  let snap = true; // next layout jumps straight to its target
  const frameInfo = { cx: 0, cy: 0, d: 1, spanPx: 0, mode: 'side' };
  const cur = { x: 0, y: 0, d: 1 };
  const _v = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _c = new THREE.Color();
  const WHITE = new THREE.Color(1, 1, 1);
  const HEADLAMP = new THREE.Color(1, 0.95, 0.88);
  const HEAD_DIR = new THREE.Vector3(-0.35, 0.45, 1).normalize();
  const FILL_SKY = new THREE.Color(0xdfe9f2);
  const FILL_GROUND = new THREE.Color(0x3b3426);
  const RIM = new THREE.Color(0xd6e6ff);

  // ---- where the card is (cached briefly: reading layout every frame would force a reflow)
  let rect = null;
  let rectAt = -1;
  let rectW = 0;
  let rectH = 0;
  function cardRect(W, H) {
    const now = performance.now() / 1000;
    if (rectAt >= 0 && now - rectAt < RECT_TTL_S && W === rectW && H === rectH) return rect;
    rectAt = now;
    rectW = W;
    rectH = H;
    rect = null;
    const src = getCatchRect || catchRectSource;
    if (src) {
      try {
        const r = src();
        if (r && r.width > 0 && r.height > 0) rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      } catch {
        rect = null;
      }
    }
    return rect;
  }

  // Free region (CSS px) for the fish: left of a side-panel card, or above a bottom sheet.
  function freeRegion(W, H, out) {
    const top = Math.max(56, H * 0.1); // below the clock / tool bar
    let r = cardRect(W, H);
    if (!r) {
      // no rect from the UI: assume the card's CSS rule (bottom sheet on narrow / portrait screens)
      if ((W <= SHEET_MAX_W && H >= SHEET_MIN_H) || W / H <= SHEET_MAX_ASPECT) r = { left: 0, right: W, top: H * 0.42, bottom: H };
      else {
        const cw = H <= 520 ? Math.min(380, W * 0.46) : Math.min(392, W * 0.42);
        r = { left: W - 28 - cw, right: W - 28, top: 24, bottom: H - 24 };
      }
    }
    const side = { x0: W * 0.03, x1: r.left - 24, y0: top, y1: H - Math.max(24, H * 0.06) };
    const sheet = { x0: W * 0.05, x1: W * 0.95, y0: top, y1: r.top - 12 };
    // pick whichever lets a horizontal fish (about half as tall as long, fins and all) be longest
    const fit = (g) => Math.min(g.x1 - g.x0, 1.9 * (g.y1 - g.y0));
    const g = fit(side) >= fit(sheet) ? side : sheet;
    out.mode = g === side ? 'side' : 'sheet';
    out.x0 = g.x0;
    out.x1 = Math.max(g.x0 + 40, g.x1);
    out.y0 = g.y0;
    out.y1 = Math.max(g.y0 + 30, g.y1);
    return out;
  }
  const _reg = { x0: 0, x1: 0, y0: 0, y1: 0, mode: 'side' };

  // Target placement: region centre, size from the real length (angular size roughly constant across
  // screens: relative to the larger of the width and 1.2x the height), capped by the free region.
  function layoutTarget() {
    const el = renderer.domElement;
    const W = Math.max(1, el.clientWidth || window.innerWidth);
    const H = Math.max(1, el.clientHeight || window.innerHeight);
    const reg = freeRegion(W, H, _reg);
    const regW = reg.x1 - reg.x0;
    const regH = reg.y1 - reg.y0;
    const ref = Math.max(W, 1.2 * H);
    let span = lerp(0.19, 0.5, smoothstep(0.12, 1.1, lengthM)) * ref;
    span = Math.min(span, 0.92 * regW, 1.9 * regH);
    span = Math.max(span, Math.min(0.12 * ref, 0.92 * regW));
    const aspect = Math.max(0.2, camera.aspect || W / H);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * aspect;
    const d = clamp((lengthM * W) / (span * 2 * tanH), 0.2, 6);
    frameInfo.mode = reg.mode;
    frameInfo.spanPx = span;
    frameInfo.d = d;
    frameInfo.cx = (reg.x0 + reg.x1) * 0.5;
    frameInfo.cy = (reg.y0 + reg.y1) * 0.5;
    const ndcX = (frameInfo.cx / W) * 2 - 1;
    const ndcY = 1 - (frameInfo.cy / H) * 2;
    return { x: ndcX * d * tanH, y: ndcY * d * tanV, d };
  }

  function layout(dt) {
    const tg = layoutTarget();
    if (snap || !(dt > 0)) {
      cur.x = tg.x;
      cur.y = tg.y;
      cur.d = tg.d;
      snap = false;
    } else {
      // resize / card change: glide there
      cur.x = damp(cur.x, tg.x, 8, dt);
      cur.y = damp(cur.y, tg.y, 8, dt);
      cur.d = damp(cur.d, tg.d, 8, dt);
    }
    holder.position.set(cur.x, cur.y, -cur.d);
  }

  // ---- program keeper: stand-ins that hold a reference to every showcase program ever used
  const keeperRoot = new THREE.Group();
  keeperRoot.name = 'showcase-program-keepers';
  const keptKeys = new Set();
  const placeholders = new Map();
  let prewarmHandle = null;
  let prewarmTried = false;
  function placeholderTex(src) {
    const ch = src.channel || 0;
    let tex = placeholders.get(ch);
    if (!tex) {
      tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      tex.channel = ch;
      placeholders.set(ch, tex);
    }
    return tex;
  }
  function tinyGeometry(src) {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) {
      const a = src.attributes[name];
      g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(a.itemSize * 3), a.itemSize));
    }
    for (const name of Object.keys(src.morphAttributes || {})) {
      g.morphAttributes[name] = src.morphAttributes[name].map((a) => new THREE.BufferAttribute(new Float32Array(a.itemSize * 3), a.itemSize));
    }
    g.morphTargetsRelative = !!src.morphTargetsRelative;
    return g;
  }
  function keeperMaterial(m) {
    const k = m.clone();
    k.onBeforeCompile = m.onBeforeCompile;
    k.customProgramCacheKey = m.customProgramCacheKey;
    for (const p of Object.keys(k)) {
      const v = k[p];
      if (v && v.isTexture) k[p] = placeholderTex(v);
    }
    return k;
  }
  // Before the shown fish's materials are disposed: stand-ins for any program not kept yet.
  function keepPrograms(object3d) {
    const props = renderer.properties;
    if (!props || typeof props.get !== 'function') return;
    const added = [];
    object3d.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const progs = props.get(o.material).programs;
      if (!progs || !progs.size) return;
      let fresh = false;
      for (const k of progs.keys()) if (!keptKeys.has(k)) fresh = true;
      if (!fresh) return;
      for (const k of progs.keys()) keptKeys.add(k);
      const km = new THREE.Mesh(tinyGeometry(o.geometry), keeperMaterial(o.material));
      km.frustumCulled = false;
      keeperRoot.add(km);
      added.push(km);
    });
    if (!added.length) return;
    // compile the stand-ins against the showcase lights: the programs exist, so this only adds references
    const tmp = new THREE.Group();
    for (const km of added) tmp.add(km);
    try {
      renderer.compile(tmp, camera, scene);
    } catch (err) {
      console.warn('[showcase] program keeper failed', err);
    }
    for (const km of added) keeperRoot.add(km);
  }

  // Warm-up at load: compile the showcase programs for a stand-in fish so even the first catch doesn't
  // compile. The stand-in is kept (never drawn), which also keeps those programs alive.
  function prewarm(makeStandIn = standInFactory) {
    if (prewarmHandle || typeof makeStandIn !== 'function') return false;
    if (typeof renderer.getRenderTarget === 'function' && renderer.getRenderTarget() !== null) return false;
    prewarmTried = true;
    try {
      const h = makeStandIn();
      if (!h || !h.object3d) return false;
      prewarmHandle = h;
      h.object3d.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = false;
          o.frustumCulled = false;
        }
      });
      holder.add(h.object3d);
      camera.updateMatrixWorld();
      rig.matrix.copy(camera.matrixWorld);
      rig.matrixWorldNeedsUpdate = true;
      const p = typeof renderer.compileAsync === 'function' ? renderer.compileAsync(scene, camera) : (renderer.compile(scene, camera), Promise.resolve());
      holder.remove(h.object3d); // compile() already collected the materials
      h.object3d.traverse((o) => {
        const progs = o.isMesh && o.material && !Array.isArray(o.material) && renderer.properties ? renderer.properties.get(o.material).programs : null;
        if (progs) for (const k of progs.keys()) keptKeys.add(k);
      });
      return Promise.resolve(p).then(
        () => true,
        () => false
      );
    } catch (err) {
      console.warn('[showcase] prewarm failed', err);
      return false;
    }
  }

  // ---- VR: the fish held in the hand ------------------------------------------------------------
  let xrOn = false;
  let xrAuto = false; // switched on by update() because a session presents and nobody called setXR
  let xrGrip = null;
  let lastShow = null; // { species, lengthCm, opts } of the fish up now (re-shown on a mode switch)
  const xrHang = new THREE.Group(); // the jaw pinch point; its world axes are the fish's
  xrHang.name = 'showcase-xr-hold';
  const xrJaw = new THREE.Vector3(); // pinch point on the fish (fish space)
  const X = {
    init: false,
    a: new THREE.Vector3(), // jaw (world)
    aPrev: new THREE.Vector3(),
    c: new THREE.Vector3(), // body point one lever arm down the body (world)
    vc: new THREE.Vector3(),
    d: new THREE.Vector3(0, -1, 0), // jaw -> tail (world, unit)
    dPrev: new THREE.Vector3(0, -1, 0),
    side: new THREE.Vector3(0, 0, 1), // the fish's +X (left flank normal), world
    wrigT: 0,
    wrigNext: 2.5,
    wrigSign: 1,
  };
  const _xp = new THREE.Vector3();
  const _xq = new THREE.Quaternion();
  const _xs = new THREE.Vector3();
  const _xq2 = new THREE.Quaternion();
  const _xm = new THREE.Matrix4();
  const _t = new THREE.Vector3();
  const _f = new THREE.Vector3();
  const _u = new THREE.Vector3();
  const _y = new THREE.Vector3();
  const _z = new THREE.Vector3();
  const _va = new THREE.Vector3();
  const _ai = new THREE.Vector3();
  const _co = new THREE.Vector3();
  const _w = new THREE.Vector3();
  const _cam = new THREE.Vector3();

  function holdParent() {
    return xrGrip || camera;
  }

  function showXR(species, lengthCm, opts) {
    const q = opts.quality || 'high';
    // the hooked fish's settings: same programs as the fight model that was just in the lake
    const handle = createFishMesh(species, lengthCm, { detail: 'high', quality: q, seed: opts.seed, girth: opts.girth, castShadow: q !== 'low' });
    fish = handle;
    const o = handle.object3d;
    lengthM = (o.userData && o.userData.lengthM) || lengthCm / 100;
    // lower lip, just behind the snout tip and below the snout axis
    xrJaw.set(0, -0.03 * lengthM, -0.025 * lengthM);
    o.position.copy(xrJaw).negate();
    xrHang.add(o);
    xrHang.position.copy(xrGrip ? XR_JAW_GRIP : XR_JAW_CAMERA);
    holdParent().add(xrHang);
    X.init = false;
    X.wrigT = 0;
    X.wrigNext = 1.5 + Math.random() * 2;
    t = 0;
    appear = 1;
    ready = true;
    showToken++;
  }

  // One frame of the hold: jaw from the grip pose (three updated it for this XR frame before the
  // loop), body direction from a damped pendulum, twist from the wrist, then the fish's own flex.
  function updateXR(dt) {
    const parent = xrHang.parent;
    if (!parent || !fish) return;
    parent.updateWorldMatrix(true, false);
    parent.matrixWorld.decompose(_xp, _xq, _xs);
    const a = X.a.copy(xrHang.position).applyMatrix4(parent.matrixWorld);
    _f.set(0, 0, -1).applyQuaternion(_xq); // grip forward (along the fist)
    _u.set(0, 1, 0).applyQuaternion(_xq); // grip up
    const L = Math.max(0.05, lengthM);
    const lc = 0.45 * L; // lever arm: jaw -> centre of mass

    // where the body wants to hang: gravity, a little of the gripped jaw's own direction, and never
    // through the deck (a long fish held low leans out, away from the angler)
    _t.set(0, -1, 0).addScaledVector(_u, -0.35).normalize();
    let floorY = DOCK.deckY;
    const rig = xrGrip && xrGrip.parent;
    if (rig && !rig.isScene) floorY = _co.setFromMatrixPosition(rig.matrixWorld).y;
    const hmax = clamp((a.y - floorY - XR_FLOOR_CLEAR) / L, 0, 1);
    if (-_t.y > hmax) {
      _w.set(_t.x, 0, _t.z);
      if (_w.lengthSq() < 1e-6) {
        _cam.setFromMatrixPosition(camera.matrixWorld);
        _w.set(a.x - _cam.x, 0, a.z - _cam.z);
        if (_w.lengthSq() < 1e-6) _w.set(-_f.x, 0, -_f.z);
        if (_w.lengthSq() < 1e-6) _w.set(0, 0, -1);
      }
      _w.normalize().multiplyScalar(Math.sqrt(1 - hmax * hmax));
      _t.set(_w.x, -hmax, _w.z);
    }

    if (!X.init || a.distanceToSquared(X.aPrev) > 0.36) {
      // first frame (or a jump: snap turn, tracking loss): hang straight, no swing
      X.init = true;
      X.c.copy(a).addScaledVector(_t, lc);
      X.vc.set(0, 0, 0);
      X.aPrev.copy(a);
      X.d.copy(_t);
      X.dPrev.copy(_t);
      _co.set(-_f.x, -_f.y, -_f.z);
      X.side.copy(_co).addScaledVector(X.d, -_co.dot(X.d));
      if (X.side.lengthSq() < 1e-6) X.side.crossVectors(X.d, Math.abs(X.d.y) < 0.9 ? _w.set(0, 1, 0) : _w.set(1, 0, 0));
      X.side.normalize();
    }
    X.dPrev.copy(X.d);
    if (dt > 0) {
      // pendulum: gravity (g / lever) plus the jaw's stiffness toward _t; the hand's motion drags the
      // jaw and the body lags behind it (position-based constraint keeps the lever length)
      const K = 9.81 / lc + XR_JAW_STIFF;
      const C = XR_DAMP * 2 * Math.sqrt(K);
      const n = Math.min(4, Math.max(1, Math.ceil(dt / 0.017)));
      const h = dt / n;
      _va.subVectors(a, X.aPrev).divideScalar(dt);
      for (let i = 1; i <= n; i++) {
        _ai.lerpVectors(X.aPrev, a, i / n);
        _co.copy(X.c);
        _w.copy(_ai).addScaledVector(_t, lc).sub(X.c).multiplyScalar(K); // spring
        _w.addScaledVector(_va, C).addScaledVector(X.vc, -C); // damping of the relative motion
        X.vc.addScaledVector(_w, h);
        X.c.addScaledVector(X.vc, h);
        _w.subVectors(X.c, _ai);
        const len = _w.length();
        if (len > 1e-6) X.c.copy(_ai).addScaledVector(_w, lc / len);
        else X.c.copy(_ai).addScaledVector(_t, lc);
        X.vc.subVectors(X.c, _co).divideScalar(h);
      }
      X.aPrev.copy(a);
      X.d.subVectors(X.c, a);
      if (X.d.lengthSq() > 1e-10) X.d.normalize();
      else X.d.copy(_t);
    }
    const d = X.d;

    // twist: the left flank toward the angler, turning with the wrist (the gripped jaw can't spin);
    // a bit of the last frame's side keeps it steady when the fist points along the body
    _co.set(-_f.x, -_f.y, -_f.z);
    _co.addScaledVector(d, -_co.dot(d));
    _w.copy(X.side).addScaledVector(d, -X.side.dot(d));
    _co.addScaledVector(_w, 0.15);
    if (_co.lengthSq() > 1e-8) {
      _co.normalize();
      const k = dt > 0 ? 1 - Math.exp(-14 * dt) : 1;
      X.side.lerp(_co, k);
    }
    X.side.addScaledVector(d, -X.side.dot(d));
    if (X.side.lengthSq() < 1e-8) X.side.crossVectors(d, Math.abs(d.y) < 0.9 ? _w.set(0, 1, 0) : _w.set(1, 0, 0)); // any perpendicular
    X.side.normalize();

    // fish axes (world): +Z snout (up the body), +X left flank, +Y dorsal
    _z.copy(d).negate();
    _y.crossVectors(_z, X.side).normalize();
    _xm.makeBasis(X.side, _y, _z);
    _xq2.setFromRotationMatrix(_xm);
    xrHang.quaternion.copy(_xq).invert().multiply(_xq2);

    // flex: the tail lags a swing (bend against the swing's rate about the dorsal axis), and now and
    // then the fish wriggles in the hand
    let speed = 0.05;
    let turn = 0;
    if (dt > 0) {
      _w.crossVectors(X.dPrev, d).divideScalar(dt);
      turn = clamp(-_w.dot(_y) * 0.9, -3, 3);
      X.wrigNext -= dt;
      if (X.wrigNext <= 0) {
        X.wrigT = 0.9;
        X.wrigNext = 3.5 + Math.random() * 5;
        X.wrigSign = Math.random() < 0.5 ? -1 : 1;
      }
      if (X.wrigT > 0) {
        X.wrigT = Math.max(0, X.wrigT - dt);
        const k = Math.sin(Math.PI * (1 - X.wrigT / 0.9));
        speed += 0.85 * k;
        turn += X.wrigSign * 2.2 * k * Math.sin(t * 13);
      }
    }
    t += dt;
    fish.update(dt, speed, turn, XR_EXHAUSTION);
  }

  // on: VR presents. holdGrip: the controller grip (an Object3D in the scene, e.g. the reel hand's
  // renderer.xr.getControllerGrip(i), a child of the player rig) the fish is held in; without one it
  // hangs from a point low in front of the camera. A fish that is up is shown again in the new mode.
  function setXR(on, opts = {}) {
    setXRMode(!!on, on && opts && opts.holdGrip && opts.holdGrip.isObject3D ? opts.holdGrip : null);
    xrAuto = false;
  }
  function setXRMode(on, grip) {
    if (on === xrOn && grip === xrGrip) return;
    const again = lastShow;
    if (fish) hide();
    xrOn = on;
    xrGrip = on ? grip : null;
    xrHang.removeFromParent();
    if (!again) return;
    try {
      show(again.species, again.lengthCm, again.opts);
    } catch (err) {
      console.warn('[showcase] re-show after a VR switch failed', err);
    }
  }

  function show(species, lengthCm, opts = {}) {
    hide();
    lastShow = { species, lengthCm, opts: opts || {} };
    if (xrOn) {
      showXR(species, lengthCm, opts || {});
      return;
    }
    const handle = createFishMesh(species, lengthCm, { detail: 'high', quality: opts.quality || 'high', seed: opts.seed, girth: opts.girth });
    fish = handle;
    const o = handle.object3d;
    lengthM = (o.userData && o.userData.lengthM) || lengthCm / 100;
    const cz = o.userData && Number.isFinite(o.userData.centerZ) ? o.userData.centerZ : -0.42 * lengthM;
    o.position.set(0, 0, -cz); // pivot about the centre of mass
    o.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = false;
        c.receiveShadow = false;
        c.frustumCulled = false;
      }
    });
    holder.add(o);
    t = 0;
    appear = 0;
    snap = true; // placed on its first drawn frame, once the UI has put the card up
    rectAt = -1;
    // compile without blocking (parallel shader compile), then let the fish appear
    const token = ++showToken;
    ready = true;
    if (typeof renderer.compileAsync === 'function') {
      ready = false;
      const done = () => {
        if (token !== showToken || ready) return;
        ready = true;
        t = 0;
        appear = 0;
        snap = true;
        rectAt = -1;
      };
      try {
        camera.updateMatrixWorld();
        rig.matrix.copy(camera.matrixWorld);
        rig.matrixWorldNeedsUpdate = true;
        const settled = renderer.compileAsync(scene, camera).then(done, done);
        compiling.set(handle, settled);
        settled.then(() => compiling.delete(handle));
      } catch {
        ready = true;
      }
      setTimeout(done, 2500); // never wait longer than this
    }
  }

  function hide() {
    lastShow = null;
    if (!fish) return;
    showToken++;
    // (VR: the fish drew with the lake's programs, which the fish system keeps alive)
    if (!xrOn) {
      try {
        keepPrograms(fish.object3d);
      } catch (err) {
        console.warn('[showcase] keeping programs failed', err);
      }
    }
    const f = fish;
    fish = null;
    ready = true;
    xrHang.removeFromParent();
    const pending = compiling.get(f);
    if (pending) {
      f.object3d.removeFromParent();
      pending.then(() => f.dispose());
    } else f.dispose();
  }

  function syncEnvironment(env, scene0) {
    scene.environment = (scene0 && scene0.environment) || (env && env.envMap) || null;
    scene.environmentIntensity = scene0 && Number.isFinite(scene0.environmentIntensity) ? scene0.environmentIntensity : 1;
  }

  // Lights that belong to the lake's light: the key from the sun (moon at night) direction and colour,
  // turned toward the camera side so the flank we see is lit; a headlamp look when it is dark.
  function light(env) {
    const exposure = renderer.toneMappingExposure || 1;
    const night = env && Number.isFinite(env.nightFactor) ? env.nightFactor : 0;
    const head = smoothstep(0.45, 0.7, night);
    const vis = env && Number.isFinite(env.sunVisibility) ? clamp(env.sunVisibility, 0, 1) : 1;
    // direction (rig / camera space)
    if (env && env.sunDirection) {
      _v.copy(env.sunDirection).transformDirection(camera.matrixWorldInverse);
      _v.z = Math.max(_v.z, 0.3); // from the camera's side
      _v.y = Math.max(_v.y, 0.18); // from above
      _v.normalize();
    } else _v.copy(HEAD_DIR);
    _dir.copy(_v).lerp(HEAD_DIR, head).normalize();
    keyTarget.position.copy(holder.position);
    key.position.copy(holder.position).add(_dir);
    // colour: the sun's, halfway to white; the headlamp's warm white at night
    if (env && env.sunColor) {
      _c.copy(env.sunColor);
      _c.multiplyScalar(1 / Math.max(1e-3, _c.r, _c.g, _c.b));
      _c.lerp(WHITE, 0.5);
    } else _c.copy(WHITE);
    key.color.copy(_c).lerp(HEADLAMP, head);
    key.intensity = ((1.7 + 0.6 * night) * lerp(0.7 + 0.3 * vis, 1, head)) / exposure;
    // fill: the scene's sky / ground light, softened toward neutral
    if (env && env.hemiLight) {
      fill.color.copy(FILL_SKY).lerp(env.hemiLight.color, 0.45);
      fill.groundColor.copy(FILL_GROUND).lerp(env.hemiLight.groundColor, 0.45);
    }
    fill.intensity = (0.55 + 0.25 * night + 0.15 * (1 - vis) * (1 - head)) / exposure;
    rim.color.copy(RIM);
    if (env && env.skyColor) rim.color.lerp(env.skyColor, 0.35);
    rim.intensity = 0.9 / exposure;
  }

  // env: the Environment module (sun, sky light, environment map, exposure).
  function update(dt, env, scene0) {
    syncEnvironment(env, scene0); // every frame, so a compile at show() uses the same environment
    // safety net: a session presents but nobody called setXR -> hold the fish in front of the camera
    // rather than drawing the desktop overlay into the headset
    const presenting = !!(renderer.xr && renderer.xr.isPresenting);
    if (presenting && !xrOn) {
      setXRMode(true, null);
      xrAuto = true;
    } else if (!presenting && xrOn && xrAuto) {
      setXRMode(false, null);
      xrAuto = false;
    }
    if (xrOn) {
      if (fish) updateXR(Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0);
      return;
    }
    if (!fish) {
      if (!prewarmTried && standInFactory && scene.environment) prewarm();
      return;
    }
    camera.updateMatrixWorld();
    rig.matrix.copy(camera.matrixWorld);
    rig.matrixWorldNeedsUpdate = true;
    if (!ready) return;
    t += dt;
    appear = damp(appear, 1, 5, dt);
    layout(dt);
    // head to the left, left flank to the camera, turning slowly back and forth
    holder.rotation.set(0.12 + 0.05 * Math.sin(t * 0.7), -Math.PI / 2 + 0.62 * Math.sin(t * 0.42), 0.04 * Math.sin(t * 0.9));
    const s = 0.92 + 0.08 * appear;
    holder.scale.setScalar(s);
    holder.position.y -= (1 - appear) * 0.06 * Math.max(0.5, cur.d);
    fish.update(dt, 0.05, 0, 0.35);
    light(env);
  }

  function render() {
    if (xrOn || !fish || !ready) return; // VR: the fish is part of the lake scene, drawn with it
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, camera);
    renderer.autoClear = auto;
  }

  return {
    show,
    hide,
    update,
    render,
    prewarm,
    setXR,
    get xr() {
      return xrOn;
    },
    get active() {
      return !!fish;
    },
    get object() {
      return fish ? fish.object3d : null;
    },
    // debugging / tests: where and how big the fish is framed (CSS px); in VR where it hangs (world)
    get framing() {
      if (xrOn) {
        const o = fish ? fish.object3d : null;
        const p = o ? o.getWorldPosition(new THREE.Vector3()) : null;
        return { mode: 'xr', lengthM, ready, jaw: X.a.toArray(), snout: p ? p.toArray() : null, bodyDir: X.d.toArray(), grip: !!xrGrip };
      }
      return { ...frameInfo, lengthM, ready };
    },
    scene,
  };
}
