// WebXR (VR) mode: the player rig, the session lifecycle, controller input, haptics, the XR quality profile and the
// wiring of every other module's XR API (XR.md). The game core (src/game/game.js) owns what the input MEANS: it calls
// beginFrame() once per XR frame and turns the returned snapshot into casts, reeling, hooksets and menu actions.
//
// Rig: a Group at (0, DOCK.deckY, 0) facing -Z (plus 1.6 m on a `local` reference space). While presenting the camera
// and the per-hand grip / ray Groups are its children, so the headset and controller poses are relative to the deck.
// On the first frame (and after a reference-space reset) the rig slides so the head starts above the dock end,
// wherever the player stands in their room. Snap turns rotate it about the head. Nothing else moves the XR view.
//
// Other modules' XR APIs are optional (they may land later) and every call is guarded:
//   tackle.setXRMode(on, { rodGrip, reelGrip }), tackle.getRodBase(v), tackle.getReelHandle(v), tackle.getRodTip(v)
//   showcase.setXR(on, { holdGrip })
//   createXRHud(ctx) from ./hud.js -> setActive / update / select / strikeCue / showCatch / openMenu / toast ...
import * as THREE from 'three';
import { DOCK, LAYERS, damp, smoothstep } from '../config.js';
import * as HudModule from './hud.js';
import { createXRSession, LOCAL_STANDING_HEIGHT_M } from './session.js';
import { createXRInput } from './input.js';
import { createHaptics } from './haptics.js';
import { createXRAdaptive, XR_PROFILES } from '../game/quality.js';

export { detectXR } from './session.js';
export { castPowerFromSpeed, CAST, HOOK_TIP_MPS, HOOK_PITCH_RATE } from './input.js';
export { HAPTICS } from './haptics.js';

const DEG = Math.PI / 180;
export const SNAP_TURN_RAD = 30 * DEG;
const FADE_START_M = 0.6; // the head this far outside the deck starts the fade to dark
const FADE_FULL_M = 0.95;
const FADE_MAX = 0.92;

export function createXR({ renderer, scene, camera, events, qm, species = [], getHandlers, getModules, getConfig, hooks = {} }) {
  renderer.xr.enabled = true; // cheap when not presenting

  const rig = new THREE.Group();
  rig.name = 'xr-rig';
  rig.position.set(0, DOCK.deckY, 0);
  scene.add(rig);

  const input = createXRInput({ rig });
  // (pulses address a role, 'rod' | 'reel', or a physical hand, 'left' | 'right': the HUD uses the latter)
  const haptics = createHaptics({ events, getGamepad: (who) => (who === 'left' || who === 'right' ? input.hands[who].gamepad : input.gamepad(who)) });
  const adaptive = createXRAdaptive({ qm, renderer, getFrameRate: () => session.frameRate });

  // comfort fade: a dark shell around the head, drawn over everything
  const fadeMat = new THREE.MeshBasicMaterial({ color: 0x05080a, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.BackSide, fog: false, toneMapped: false });
  const fade = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 10), fadeMat);
  fade.name = 'xr-deck-fade';
  fade.renderOrder = 1e6;
  fade.frustumCulled = false;
  fade.visible = false;
  fade.layers.enable(LAYERS.NO_REFLECT);
  let fadeOpacity = 0;
  let fadeHinted = false;

  let hud = null;
  let hudTried = false;
  let tackleXR = false;
  let savedCam = null;
  let needRecenter = false;
  let frames = 0;
  let lastCast = null;
  let visibility = 'visible';
  const frameWaiters = [];
  const frameHooks = []; // tests: fn(frames) after each XR frame's input; return false to drop it

  const call = (obj, name, ...a) => {
    if (!obj || typeof obj[name] !== 'function') return undefined;
    try {
      return obj[name](...a);
    } catch (err) {
      console.error(`[xr] ${name} failed`, err);
      return undefined;
    }
  };
  const mods = () => (typeof getModules === 'function' ? getModules() || {} : {});

  function ensureHud() {
    if (hud || hudTried) return hud;
    hudTried = true;
    const factory = HudModule && HudModule.createXRHud;
    if (typeof factory !== 'function') return null;
    try {
      hud = factory({
        renderer,
        scene,
        camera,
        events,
        handlers: typeof getHandlers === 'function' ? getHandlers() : {},
        species,
        config: typeof getConfig === 'function' ? getConfig() : {},
        haptics, // extra: the HUD's hover / press ticks go through haptics.pulse(hand, intensity, ms)
      });
    } catch (err) {
      console.error('[xr] the VR HUD could not be created', err);
      hud = null;
    }
    return hud;
  }

  function grips() {
    return { rodGrip: input.grip('rod'), reelGrip: input.grip('reel'), rodRay: input.ray('rod'), reelRay: input.ray('reel'), rig };
  }

  // hand the grips to the tackle / showcase / HUD (again after a rod-hand swap)
  function attachModules(on) {
    const { tackle, showcase } = mods();
    const g = grips();
    tackleXR = false;
    if (tackle && typeof tackle.setXRMode === 'function') {
      try {
        const r = tackle.setXRMode(on, { rodGrip: g.rodGrip, reelGrip: g.reelGrip, rodHand: input.rodHand });
        tackleXR = on && r !== false;
      } catch (err) {
        console.error('[xr] tackle.setXRMode failed', err);
      }
    }
    call(showcase, 'setXR', on, { holdGrip: g.reelGrip });
    if (on) {
      ensureHud();
      call(hud, 'setActive', true, g);
    } else call(hud, 'setActive', false);
  }

  // ---------------------------------------------------------------- session
  const session = createXRSession({
    renderer,
    onStart({ referenceSpaceType, session: s }) {
      input.reset();
      input.bindSession(s);
      rig.position.set(0, DOCK.deckY + (referenceSpaceType === 'local' ? LOCAL_STANDING_HEIGHT_M : 0), 0);
      rig.rotation.set(0, 0, 0);
      rig.updateMatrixWorld(true);
      needRecenter = true;
      savedCam = { parent: camera.parent, fov: camera.fov, zoom: camera.zoom };
      rig.add(camera);
      camera.add(fade);
      fadeOpacity = 0;
      fadeMat.opacity = 0;
      fade.visible = false;
      fadeHinted = false;
      visibility = 'visible';
      haptics.setActive(true);
      attachModules(true);
      if (typeof hooks.onStart === 'function') hooks.onStart({ referenceSpaceType, level: adaptive.profile });
    },
    onEnd() {
      haptics.setActive(false);
      // the desktop camera first (the tackle rebuilds its camera-space view model from it)
      camera.remove(fade);
      const parent = savedCam && savedCam.parent && savedCam.parent !== rig ? savedCam.parent : scene;
      parent.add(camera);
      if (savedCam) {
        camera.fov = savedCam.fov;
        camera.zoom = savedCam.zoom;
      }
      camera.updateProjectionMatrix();
      savedCam = null;
      if (typeof hooks.onCameraRestored === 'function') hooks.onCameraRestored();
      camera.updateMatrixWorld(true);
      attachModules(false);
      input.unbindSession();
      input.reset();
      adaptive.stop();
      while (frameWaiters.length) frameWaiters.shift().resolve(false);
      frameHooks.length = 0;
      if (typeof hooks.onEnd === 'function') hooks.onEnd();
    },
    onVisibility(state) {
      visibility = state;
      if (typeof hooks.onVisibility === 'function') hooks.onVisibility(state);
    },
    onReset() {
      needRecenter = true;
    },
    onAvailability(ok) {
      if (typeof hooks.onAvailability === 'function') hooks.onAvailability(ok);
    },
  });

  // Called from a click (the Enter VR button): requestSession runs synchronously inside.
  function enter({ level } = {}) {
    if (session.presenting || session.starting) return Promise.resolve(session.presenting);
    const prof = adaptive.start(XR_PROFILES[level] ? level : 'medium');
    return session.enter({ framebufferScale: prof.framebufferScale, foveation: prof.foveation }).then((ok) => {
      if (!ok) adaptive.stop();
      return ok;
    });
  }

  // ---------------------------------------------------------------- per frame
  const _h = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  function refreshPoses() {
    rig.updateMatrixWorld(true);
    renderer.xr.updateCamera(camera);
  }

  function snapTurn(angle) {
    camera.getWorldPosition(_h);
    _v.set(rig.position.x - _h.x, 0, rig.position.z - _h.z).applyAxisAngle(UP, angle);
    rig.position.x = _h.x + _v.x;
    rig.position.z = _h.z + _v.z;
    rig.rotation.y += angle;
  }

  function routeSelect(role, xin) {
    const r = xin[role];
    if (!r.triggerDown || !hud || typeof hud.select !== 'function') return;
    let took = false;
    try {
      took = !!hud.select(role);
    } catch (err) {
      console.error('[xr] hud.select failed', err);
    }
    if (!took) return;
    r.consumed = true;
    r.triggerDown = r.triggerHeld = r.triggerUp = false;
    r.trigger = 0;
    if (role === 'reel') {
      r.trigger01 = 0;
      xin.reelSpeed01 = r.crank.speed01;
    }
    // (the HUD gives the press its own 0.1 x 10 ms tick)
  }

  function updateFade(dt, xin) {
    const hp = xin.head.position;
    const dx = Math.max(0, Math.abs(hp.x) - DOCK.width / 2);
    const dz = Math.max(0, DOCK.endZ - hp.z, hp.z - DOCK.shoreZ);
    const out = Math.hypot(dx, dz);
    const target = FADE_MAX * smoothstep(FADE_START_M, FADE_FULL_M, out);
    fadeOpacity = damp(fadeOpacity, target, 5, Math.min(dt, 0.1));
    if (fadeOpacity < 0.004 && target === 0) fadeOpacity = 0;
    fadeMat.opacity = fadeOpacity;
    fade.visible = fadeOpacity > 0.004;
    if (target > 0.15 && !fadeHinted) {
      fadeHinted = true;
      call(hud, 'toast', 'Step back onto the dock', 'info');
    } else if (out < 0.3) fadeHinted = false;
  }

  // the tackle's rod / reel points while it holds the rod in the grip (else the input falls back to the grip)
  const fromTackle = (name) => (out) => {
    const { tackle } = mods();
    if (!tackleXR || !tackle || typeof tackle[name] !== 'function') return false;
    tackle[name](out);
    return Number.isFinite(out.x);
  };
  const deriveCtx = {
    dt: 0,
    camera,
    getRodTip: fromTackle('getRodTip'),
    getRodBase: fromTackle('getRodBase'),
    getReelHandle: fromTackle('getReelHandle'),
    lineTarget: null,
    allowSticks: true,
  };

  // Once per XR frame, before the simulation. ctx: { dt (game time), frame, lineTarget, allowSticks, allowTurn }
  function beginFrame(xrFrame, ctx = {}) {
    if (!session.presenting) return null;
    frames++;
    while (frameWaiters.length && frames >= frameWaiters[0].at) frameWaiters.shift().resolve(true);
    const dt = Math.max(0, Math.min(0.05, ctx.dt || 0));
    input.updateSources(xrFrame, renderer.xr.getReferenceSpace(), session.session);
    refreshPoses();
    if (needRecenter) {
      const cams = renderer.xr.getCamera().cameras;
      if (cams && cams.length) {
        camera.getWorldPosition(_h);
        rig.position.x -= _h.x;
        rig.position.z -= _h.z;
        needRecenter = false;
        refreshPoses();
        input.teleported();
      }
    }
    deriveCtx.dt = dt;
    deriveCtx.lineTarget = ctx.lineTarget || null;
    deriveCtx.allowSticks = ctx.allowSticks !== false;
    const xin = input.derive(deriveCtx);
    // panels get trigger presses first
    routeSelect('rod', xin);
    routeSelect('reel', xin);
    if (xin.snapTurn && ctx.allowTurn !== false) {
      snapTurn(-xin.snapTurn * SNAP_TURN_RAD);
      refreshPoses();
      input.teleported();
      xin.head.position.setFromMatrixPosition(camera.matrixWorld);
    }
    updateFade(dt, xin);
    haptics.update(dt, ctx.frame);
    for (let i = frameHooks.length - 1; i >= 0; i--) {
      let keep = false;
      try {
        keep = frameHooks[i](frames) !== false;
      } catch (err) {
        console.error('[xr] frame hook failed', err);
      }
      if (!keep) frameHooks.splice(i, 1);
    }
    return xin;
  }

  function waitFrames(n = 1) {
    if (!session.presenting) return Promise.resolve(false);
    return new Promise((resolve) => {
      frameWaiters.push({ at: frames + Math.max(1, n | 0), resolve });
      frameWaiters.sort((a, b) => a.at - b.at);
    });
  }

  function setRodHand(h) {
    if (!input.setRodHand(h)) return false;
    if (session.presenting) attachModules(true);
    return true;
  }

  // world position of the rod butt / reel seat (tackle when it knows, else the rod-hand grip)
  function getRodBase(out) {
    const { tackle } = mods();
    if (tackleXR && tackle && typeof tackle.getRodBase === 'function') {
      tackle.getRodBase(out);
      if (Number.isFinite(out.x)) return out;
    }
    return out.copy(input.xin.rod.base);
  }

  const r2 = (v) => Math.round(v * 100) / 100;
  const vec = (p) => [r2(p.x), r2(p.y), r2(p.z)];
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const vec3 = (p) => [r3(p.x), r3(p.y), r3(p.z)];
  function status() {
    const xin = input.xin;
    const handInfo = (h) => ({ connected: h.connected, tracked: h.grip.visible, profile: h.profile, gamepad: !!h.gamepad, hand: h.isHand, position: vec(h.pos) });
    const q = adaptive.status;
    let over = null;
    try {
      over = hud ? hud.pointerOverPanel ?? null : null;
    } catch {
      over = null;
    }
    return {
      available: session.available,
      presenting: session.presenting,
      starting: session.starting,
      referenceSpace: session.referenceSpaceType,
      visibility: session.presenting ? visibility : null,
      profile: session.presenting ? q.profile : null,
      level: q.level,
      framebufferScale: session.presenting ? q.framebufferScale : null,
      foveation: session.presenting ? q.foveation : null,
      xrFps: q.fps,
      targetFps: session.presenting ? q.targetFps : null,
      hands: { left: handInfo(input.hands.left), right: handInfo(input.hands.right) },
      rodHand: input.rodHand,
      lastCast,
      pointerOverPanel: over,
      hud: !!hud,
      tackleXR,
      frames,
      rig: { position: vec(rig.position), yawDeg: r2(rig.rotation.y / DEG), cameraInRig: camera.parent === rig },
      head: { position: vec(xin.head.position), yawDeg: r2(xin.head.yaw / DEG), pitchDeg: r2(xin.head.pitch / DEG) },
      rod: {
        connected: xin.rod.connected,
        base: vec(xin.rod.base),
        tip: vec(xin.rod.tip),
        fromTackle: xin.rod.fromTackle,
        dir: vec3(xin.rod.dir),
        pitchDeg: r2(xin.rod.pitch / DEG),
        yawDeg: r2(xin.rod.yaw / DEG),
        lift01: r2(xin.rod.lift01),
        tipVel: vec(xin.rod.tipVel),
        tipSpeed: r2(xin.rod.tipSpeed),
        pitchRate: r2(xin.rod.pitchRate),
        trigger: r2(xin.rod.trigger),
        triggerHeld: xin.rod.triggerHeld,
      },
      reel: {
        connected: xin.reel.connected,
        trigger: r2(xin.reel.trigger),
        trigger01: r2(xin.reel.trigger01),
        position: vec(xin.reel.position),
        crank: { active: xin.reel.crank.active, near: xin.reel.crank.near, revPerSec: r2(xin.reel.crank.revPerSec), speed01: r2(xin.reel.crank.speed01), distanceM: r2(xin.reel.crank.distanceM), handle: vec3(xin.reel.crank.handle) },
        reelSpeed01: r2(xin.reelSpeed01),
      },
      castPower01: r2(xin.castPower01),
      hookMetric: { tipUpBack: r2(xin.hookMetric.tipUpBack), pitchRate: r2(xin.hookMetric.pitchRate) },
      fade: r2(fadeOpacity),
      ui: hud && session.presenting && typeof hud.status === 'function' ? hud.status() : null,
      haptics: { count: haptics.count, recent: haptics.log.slice(-12) },
    };
  }

  // tests: a VR panel button's centre (world, and in the rig's frame, which is the XR reference space the emulator's
  // controller poses are given in), for pointing a controller ray at it. null when the panel / button isn't up.
  const _pt = new THREE.Vector3();
  function panelTarget(panelName, buttonId) {
    const P = hud && session.presenting ? hud.debugPanels : null;
    const panel = P && P[panelName];
    if (!panel || !panel.mesh || !panel.mesh.visible) return null;
    const b = (panel.buttons || []).find((x) => x.id === buttonId);
    if (!b) return null;
    const u = (b.x + b.w / 2) / panel.W;
    const v = 1 - (b.y + b.h / 2) / panel.usedH;
    panel.mesh.updateWorldMatrix(true, false);
    _pt.set((u - 0.5) * panel.widthM, (v - 0.5) * panel.heightM, 0).applyMatrix4(panel.mesh.matrixWorld);
    const world = vec3(_pt);
    rig.updateMatrixWorld(true);
    const local = vec3(rig.worldToLocal(_pt));
    return { world, local, disabled: !!b.disabled };
  }

  return {
    rig,
    input,
    haptics,
    panelTarget,
    adaptive,
    get xin() {
      return input.xin;
    },
    detect: () => session.detect(),
    enter,
    exit: () => session.exit(),
    beginFrame,
    waitFrames,
    // tests: run fn(frames) once per XR frame (after the input is read) until it returns false. Poses set from it
    // reach the next frame exactly, however slowly frames render.
    onFrame(fn) {
      if (typeof fn === 'function') frameHooks.push(fn);
    },
    castFromRelease: () => input.castFromRelease(),
    sideToward: (p) => input.sideToward(p),
    getRodBase,
    setRodHand,
    get rodHand() {
      return input.rodHand;
    },
    get presenting() {
      return session.presenting;
    },
    get starting() {
      return session.starting;
    },
    get available() {
      return session.available;
    },
    get visibility() {
      return visibility;
    },
    get hud() {
      return session.presenting ? hud : null;
    },
    // call an XR HUD method while presenting (a no-op otherwise, or when the HUD lacks it)
    hudCall(name, ...args) {
      if (!session.presenting || !hud) return undefined;
      return call(hud, name, ...args);
    },
    sampleQuality: (realDt) => adaptive.sample(realDt),
    setLastCast(c) {
      lastCast = c;
    },
    status,
    dispose() {
      session.dispose();
      haptics.dispose();
      call(hud, 'dispose');
      scene.remove(rig);
      fade.geometry.dispose();
      fadeMat.dispose();
    },
  };
}
