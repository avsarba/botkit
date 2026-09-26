// XR input (XR.md "Hands and input"): two tracked controllers -> per-hand buttons / sticks with edge detection, the
// real rod pose, the rod-tip velocity used for casting and the hookset, and the reel-crank gesture.
//
// Hands are addressed two ways: physically ('left' | 'right', one stable Group pair per hand, children of the rig)
// and by role ('rod' | 'reel', which physical hand holds what; the menu can swap them). The grip / ray Groups never
// change identity, so the tackle, the HUD and the showcase can hold on to them across sessions and reconnects; each
// frame their `matrix` is the pose of that hand's grip / target-ray space in the reference space (the rig adds the
// dock position and snap turns).
//
// Everything velocity-like is measured in GAME time (the frame's clamped dt, <= 50 ms): identical to real time on a
// headset (11-14 ms frames), and it keeps gestures meaningful under a slow software renderer.
import * as THREE from 'three';
import { TACKLE, clamp } from '../config.js';

const DEG = Math.PI / 180;
export const ROD_TILT_RAD = 20 * DEG; // the blank points along the grip's forward axis tilted this much up
const TRIGGER_ON = 0.5; // digital use of the trigger (cast hold): press above, release below TRIGGER_OFF
const TRIGGER_OFF = 0.25;
export const REEL_DEAD_ZONE = 0.08;
const VEL_WINDOW_S = 0.06; // rod-tip velocity / rod rates are differences over this much time
const HIST = 16;
export const HOOK_TIP_MPS = 2.2; // rod tip sweeping up / back faster than this sets the hook
export const HOOK_PITCH_RATE = 3; // ... or the rod rising faster than this (rad/s)
const STICK_ON = 0.7;
const STICK_OFF = 0.3;
const DRAG_REPEAT_S = 0.25;
const CRANK_NEAR_M = 0.25; // the reel hand must be this close to the reel handle
const CRANK_MIN_RPS = 0.5;
export const CRANK_M_PER_REV = TACKLE.reelRetrieveMps / TACKLE.reelTurnsPerS; // line per handle turn (~0.52 m, the reel's)
const CRANK_MIN_HAND_MPS = 0.1; // below this the hand isn't moving enough to tell a circle
const CRANK_HOLD_S = 0.25; // crank stays "on" this long through a sample that can't tell
const LIFT_FULL_RAD = 60 * DEG;
const SIDE_FULL = 0.75; // sin of the rod's angle off the line (times its horizontal share) that is full side pressure
// cast mapping (XR.md): power from rod-tip speed at release, direction from its horizontal part, launch pitch from its
// elevation or, in an overhead cast, from the rod's own elevation at release less rodReleaseRad (whichever is higher).
// A rod swinging forward past vertical moves its tip downward, so the tip's path alone would launch every overhead cast
// at the 8 deg floor; the rod unloading as the line is let go lifts the lure: let go at "11 o'clock" (rod ~55 deg up)
// and it flies out at ~30 deg (the desktop's launch pitch), earlier goes higher, later lower.
export const CAST = { minMps: 1.2, spanMps: 10, minPower: 0.08, lobPower: 0.12, stillMps: 0.5, lobPitchRad: 25 * DEG, pitchMinRad: 8 * DEG, pitchMaxRad: 55 * DEG, rodReleaseRad: 25 * DEG, minHorizMps: 1, behindRad: 110 * DEG };
// "behind the player": measured from the lake direction (the rig's -Z at session start; snap turns don't move it)
const LAKE = new THREE.Vector3(0, 0, -1);

export function castPowerFromSpeed(speed) {
  if (!(speed >= CAST.stillMps)) return CAST.lobPower;
  return clamp((speed - CAST.minMps) / CAST.spanMps, CAST.minPower, 1);
}

function makeButtonState() {
  return { held: false, down: false, up: false };
}

function makeHand(handedness, rig) {
  const grip = new THREE.Group();
  grip.name = `xr-grip-${handedness}`;
  grip.matrixAutoUpdate = false;
  grip.visible = false;
  const ray = new THREE.Group();
  ray.name = `xr-ray-${handedness}`;
  ray.matrixAutoUpdate = false;
  ray.visible = false;
  grip.userData.handedness = ray.userData.handedness = handedness;
  rig.add(grip, ray);
  return {
    handedness,
    grip,
    ray,
    source: null,
    gamepad: null,
    connected: false,
    isHand: false, // hand tracking (no gamepad): a pinch is the trigger
    profile: '',
    pinch: false,
    // analog / digital state, edges valid for the current frame
    trigger: 0, // 0..1 raw
    squeeze: 0,
    triggerB: makeButtonState(), // digital use (hysteresis)
    primaryB: makeButtonState(), // A / X
    secondaryB: makeButtonState(), // B / Y
    stickB: makeButtonState(), // thumbstick click
    stickX: 0,
    stickY: 0,
    // world pose (after the rig), velocity of the grip (smoothed, game time)
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    prevPos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    hasPrev: false,
    // stick gestures
    turnArmed: true,
    dragHeld: 0,
    dragT: 0,
  };
}

// xr-standard gamepad button i: analog value / pressed
const btnValue = (b, i) => (b[i] ? (Number.isFinite(b[i].value) && b[i].value > 0 ? b[i].value : b[i].pressed ? 1 : 0) : 0);
const btnPressed = (b, i) => !!(b[i] && (b[i].pressed || b[i].value > 0.5));

function setButton(b, pressed) {
  b.down = pressed && !b.held;
  b.up = !pressed && b.held;
  b.held = pressed;
}

export function createXRInput({ rig }) {
  const hands = { left: makeHand('left', rig), right: makeHand('right', rig) };
  const HANDS = [hands.left, hands.right];
  let rodHand = 'right';
  const roleHand = (role) => hands[role === 'rod' ? rodHand : rodHand === 'right' ? 'left' : 'right'];

  // ---- snapshot handed to the game / the HUD each frame (reused)
  const makeRole = (role) => ({
    role,
    hand: '', // 'left' | 'right'
    present: false, // an input source is there (it may be untracked for a moment)
    connected: false, // ... and tracked
    trigger: 0,
    triggerHeld: false,
    triggerDown: false,
    triggerUp: false,
    primaryDown: false,
    secondaryDown: false,
    stickDown: false,
    stickX: 0,
    stickY: 0,
    squeeze: 0,
    position: new THREE.Vector3(),
    consumed: false, // this trigger press was taken by a panel (swallowed until release)
  });
  const xin = {
    presenting: false,
    rodHand: 'right',
    reelHand: 'left',
    head: { position: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, -1), yaw: 0, pitch: 0 },
    rod: Object.assign(makeRole('rod'), {
      base: new THREE.Vector3(),
      dir: new THREE.Vector3(0, 0.34, -0.94),
      tip: new THREE.Vector3(),
      tipVel: new THREE.Vector3(),
      tipSpeed: 0,
      pitch: 0,
      yaw: 0,
      pitchRate: 0,
      yawRate: 0,
      lift01: 0,
      fromTackle: false,
    }),
    reel: Object.assign(makeRole('reel'), {
      trigger01: 0, // analog retrieve from the trigger (after the dead zone)
      crank: { active: false, near: false, revPerSec: 0, speed01: 0, distanceM: NaN, handle: new THREE.Vector3() },
    }),
    reelSpeed01: 0, // max(trigger, crank)
    castPower01: 0, // live estimate while the rod trigger is held
    hookGesture: false, // rising edge of an up / back sweep this frame
    hookMetric: { tipUpBack: 0, pitchRate: 0 },
    snapTurn: 0, // -1 left / +1 right (one per flick)
    dragStep: 0, // +1 tighter / -1 looser
    lureStep: 0, // +1 next / -1 previous
    menu: false, // reel-hand thumbstick click
  };

  // ---- rod-tip history (game time)
  const hT = new Float64Array(HIST);
  const hP = new Float32Array(HIST * 3);
  const hPitch = new Float32Array(HIST);
  const hYaw = new Float32Array(HIST);
  let hHead = 0;
  let hCount = 0;
  let clock = 0;
  let yawUnwrapped = 0;
  let lastYaw = NaN;
  let hookWasOn = false;
  let crankAngle = NaN;
  let crankRate = 0;
  let crankHoldT = 0;
  const crankV = new THREE.Vector3();

  const _m = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const ROD_LOCAL = new THREE.Vector3(0, Math.sin(ROD_TILT_RAD), -Math.cos(ROD_TILT_RAD));

  function resetHistory() {
    hHead = 0;
    hCount = 0;
    lastYaw = NaN;
    yawUnwrapped = 0;
    hookWasOn = false;
    crankAngle = NaN;
    crankRate = 0;
    crankHoldT = 0;
    crankV.set(0, 0, 0);
    for (const h of HANDS) {
      h.hasPrev = false;
      h.vel.set(0, 0, 0);
      h.turnArmed = true;
      h.dragHeld = 0;
      h.dragT = 0;
    }
  }

  // hand-tracking pinches arrive as select events
  function onSelect(e, on) {
    const src = e && e.inputSource;
    if (!src || src.gamepad) return;
    const h = hands[src.handedness];
    if (h) h.pinch = on;
  }
  const onSelectStart = (e) => onSelect(e, true);
  const onSelectEnd = (e) => onSelect(e, false);
  let boundSession = null;
  function bindSession(s) {
    unbindSession();
    if (!s) return;
    boundSession = s;
    s.addEventListener('selectstart', onSelectStart);
    s.addEventListener('selectend', onSelectEnd);
  }
  function unbindSession() {
    if (!boundSession) return;
    boundSession.removeEventListener('selectstart', onSelectStart);
    boundSession.removeEventListener('selectend', onSelectEnd);
    boundSession = null;
  }

  // 1) poses and raw buttons from the XR frame (before the rig's world matrices are refreshed)
  function updateSources(xrFrame, refSpace, session) {
    for (const h of HANDS) h.connected = false;
    const sources = session && session.inputSources;
    if (!sources || !xrFrame || !refSpace) {
      for (const h of HANDS) h.grip.visible = h.ray.visible = false;
      return;
    }
    for (const src of sources) {
      const h = hands[src.handedness];
      if (!h || h.connected) continue;
      h.connected = true;
      h.source = src;
      h.gamepad = src.gamepad || null;
      h.isHand = !!src.hand && !src.gamepad;
      h.profile = (src.profiles && src.profiles[0]) || '';
      let rayPose = null;
      let gripPose = null;
      try {
        rayPose = src.targetRaySpace ? xrFrame.getPose(src.targetRaySpace, refSpace) : null;
        gripPose = src.gripSpace ? xrFrame.getPose(src.gripSpace, refSpace) : null;
      } catch {
        /* a pose that can't be had this frame */
      }
      if (rayPose) {
        h.ray.matrix.fromArray(rayPose.transform.matrix);
        h.ray.visible = true;
      } else h.ray.visible = false;
      const gp = gripPose || rayPose;
      if (gp) {
        h.grip.matrix.fromArray(gp.transform.matrix);
        h.grip.visible = true;
      } else h.grip.visible = false;
    }
    for (const h of HANDS) {
      if (!h.connected) {
        h.source = null;
        h.gamepad = null;
        h.grip.visible = h.ray.visible = false;
        h.pinch = false;
      }
    }
  }

  function readButtons(h) {
    const gp = h.gamepad;
    if (gp && gp.buttons) {
      const b = gp.buttons;
      h.trigger = btnValue(b, 0);
      h.squeeze = btnValue(b, 1);
      setButton(h.stickB, btnPressed(b, 3));
      setButton(h.primaryB, btnPressed(b, 4));
      setButton(h.secondaryB, btnPressed(b, 5));
      const ax = gp.axes || [];
      const xi = ax.length >= 4 ? 2 : 0;
      h.stickX = Number.isFinite(ax[xi]) ? ax[xi] : 0;
      h.stickY = Number.isFinite(ax[xi + 1]) ? ax[xi + 1] : 0;
    } else {
      h.trigger = h.pinch ? 1 : 0;
      h.squeeze = 0;
      setButton(h.stickB, false);
      setButton(h.primaryB, false);
      setButton(h.secondaryB, false);
      h.stickX = h.stickY = 0;
    }
    if (!h.connected) h.trigger = 0;
    const on = h.triggerB.held ? h.trigger > TRIGGER_OFF : h.trigger >= TRIGGER_ON;
    setButton(h.triggerB, on);
  }

  function fillRole(r, h) {
    r.hand = h.handedness;
    r.present = h.connected;
    r.connected = h.connected && h.grip.visible;
    r.trigger = h.trigger;
    r.squeeze = h.squeeze;
    r.primaryDown = h.primaryB.down;
    r.secondaryDown = h.secondaryB.down;
    r.stickDown = h.stickB.down;
    r.stickX = h.stickX;
    r.stickY = h.stickY;
    r.position.copy(h.pos);
    // a press a panel took stays swallowed until the trigger is let go
    if (r.consumed) {
      r.triggerDown = false;
      r.triggerHeld = false;
      r.triggerUp = false;
      r.trigger = 0;
      if (!h.triggerB.held) r.consumed = false;
    } else {
      r.triggerDown = h.triggerB.down;
      r.triggerHeld = h.triggerB.held;
      r.triggerUp = h.triggerB.up;
    }
  }

  // world rod direction (unit) from a grip's world orientation
  function rodDirFromGrip(h, out) {
    return out.copy(ROD_LOCAL).applyQuaternion(h.quat).normalize();
  }

  function pushTip(tip, pitch, yaw) {
    hT[hHead] = clock;
    hP[hHead * 3] = tip.x;
    hP[hHead * 3 + 1] = tip.y;
    hP[hHead * 3 + 2] = tip.z;
    hPitch[hHead] = pitch;
    hYaw[hHead] = yaw;
    hHead = (hHead + 1) % HIST;
    hCount = Math.min(HIST, hCount + 1);
  }
  // index of the newest sample at least VEL_WINDOW_S old (or the oldest one there is)
  function windowStart() {
    const newest = (hHead - 1 + HIST) % HIST;
    let pick = -1;
    for (let k = 1; k < hCount; k++) {
      const i = (hHead - 1 - k + HIST * 2) % HIST;
      pick = i;
      if (hT[newest] - hT[i] >= VEL_WINDOW_S - 1e-6) break;
    }
    return pick;
  }

  // 2) derived values; call after the rig / grips have fresh world matrices and the camera has the head pose.
  // ctx: { dt, camera, getRodTip(out) -> bool, getRodBase(out) -> bool, getReelHandle(out) -> bool,
  //        lineTarget: Vector3|null (lure / fish), allowSticks: bool }
  function derive(ctx) {
    const dt = Math.max(0, Math.min(0.05, ctx.dt || 0));
    clock += dt;
    xin.presenting = true;
    xin.rodHand = rodHand;
    xin.reelHand = rodHand === 'right' ? 'left' : 'right';
    for (const h of HANDS) {
      readButtons(h);
      if (h.grip.visible) {
        h.grip.matrixWorld.decompose(h.pos, h.quat, _s);
        if (h.hasPrev && dt > 1e-5) {
          _v.subVectors(h.pos, h.prevPos).multiplyScalar(1 / dt);
          h.vel.lerp(_v, 1 - Math.exp(-dt / 0.03));
        }
        h.prevPos.copy(h.pos);
        h.hasPrev = true;
      } else {
        h.hasPrev = false;
        h.vel.set(0, 0, 0);
      }
    }
    const rodH = roleHand('rod');
    const reelH = roleHand('reel');
    const rod = xin.rod;
    const reel = xin.reel;
    fillRole(rod, rodH);
    fillRole(reel, reelH);

    // head
    const cam = ctx.camera;
    if (cam) {
      cam.matrixWorld.decompose(xin.head.position, _q, _s);
      xin.head.direction.set(0, 0, -1).applyQuaternion(_q);
      const d = xin.head.direction;
      xin.head.yaw = Math.atan2(-d.x, -d.z);
      xin.head.pitch = Math.asin(clamp(d.y, -1, 1));
    }

    // ---- rod pose (the unbent blank: grip orientation + the mounting tilt)
    if (rodH.grip.visible) {
      rodDirFromGrip(rodH, rod.dir);
      if (!(ctx.getRodBase && ctx.getRodBase(rod.base))) rod.base.copy(rodH.pos);
      rod.fromTackle = !!(ctx.getRodTip && ctx.getRodTip(rod.tip));
      if (!rod.fromTackle) rod.tip.copy(rod.base).addScaledVector(rod.dir, TACKLE.rodLengthM);
      rod.pitch = Math.asin(clamp(rod.dir.y, -1, 1));
      const yaw = Math.atan2(-rod.dir.x, -rod.dir.z);
      if (Number.isFinite(lastYaw)) {
        let dy = yaw - lastYaw;
        if (dy > Math.PI) dy -= 2 * Math.PI;
        else if (dy < -Math.PI) dy += 2 * Math.PI;
        yawUnwrapped += dy;
      } else yawUnwrapped = yaw;
      lastYaw = yaw;
      rod.yaw = yaw;
      if (dt > 0) pushTip(rod.tip, rod.pitch, yawUnwrapped);
      const i0 = windowStart();
      const newest = (hHead - 1 + HIST) % HIST;
      const span = i0 >= 0 ? hT[newest] - hT[i0] : 0;
      if (span > 1e-4) {
        rod.tipVel.set(hP[newest * 3] - hP[i0 * 3], hP[newest * 3 + 1] - hP[i0 * 3 + 1], hP[newest * 3 + 2] - hP[i0 * 3 + 2]).multiplyScalar(1 / span);
        rod.pitchRate = (hPitch[newest] - hPitch[i0]) / span;
        rod.yawRate = (hYaw[newest] - hYaw[i0]) / span;
      } else {
        rod.tipVel.set(0, 0, 0);
        rod.pitchRate = rod.yawRate = 0;
      }
      rod.tipSpeed = rod.tipVel.length();
      rod.lift01 = clamp(rod.pitch / LIFT_FULL_RAD, 0, 1);
    } else {
      rod.tipVel.set(0, 0, 0);
      rod.tipSpeed = rod.pitchRate = rod.yawRate = 0;
      hCount = 0;
      lastYaw = NaN;
    }
    xin.castPower01 = rod.triggerHeld ? castPowerFromSpeed(rod.tipSpeed) : 0;

    // ---- hookset gesture: tip speed up / back (away from the line) or the rod rising fast
    let back = 0;
    if (ctx.lineTarget) {
      _v.subVectors(ctx.lineTarget, rod.base).setY(0);
      if (_v.lengthSq() > 1e-6) back = -rod.tipVel.dot(_v.normalize());
    } else {
      _v.copy(rod.dir).setY(0);
      if (_v.lengthSq() > 1e-6) back = -rod.tipVel.dot(_v.normalize());
    }
    const upBack = Math.hypot(Math.max(0, rod.tipVel.y), Math.max(0, back));
    xin.hookMetric.tipUpBack = upBack;
    xin.hookMetric.pitchRate = rod.pitchRate;
    const hookOn = rod.connected && (upBack > HOOK_TIP_MPS || rod.pitchRate > HOOK_PITCH_RATE);
    xin.hookGesture = hookOn && !hookWasOn;
    hookWasOn = hookOn;

    // ---- reel: analog trigger, or turning the handle for real
    const t = reel.trigger;
    reel.trigger01 = t <= REEL_DEAD_ZONE ? 0 : clamp((t - REEL_DEAD_ZONE) / (1 - REEL_DEAD_ZONE), 0, 1);
    const cr = reel.crank;
    let haveHandle = !!(ctx.getReelHandle && ctx.getReelHandle(cr.handle));
    if (!haveHandle && rodH.grip.visible) {
      // no reel handle from the tackle: a spinning reel hangs under the blank just ahead of the rod hand, the
      // handle on the reel hand's side
      _right.crossVectors(rod.dir, UP);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0).applyQuaternion(rodH.quat);
      _right.normalize();
      _up.crossVectors(_right, rod.dir).normalize();
      const side = rodHand === 'right' ? -1 : 1;
      cr.handle.copy(rod.base).addScaledVector(rod.dir, 0.06).addScaledVector(_up, -0.1).addScaledVector(_right, 0.07 * side);
      haveHandle = true;
    }
    cr.distanceM = haveHandle && reelH.grip.visible ? reelH.pos.distanceTo(cr.handle) : NaN;
    cr.near = cr.distanceM <= CRANK_NEAR_M;
    let rps = 0;
    if (cr.near && rodH.grip.visible && dt > 1e-5) {
      // the knob circles about the reel's axle (the rod's sideways axis): follow how fast the hand's velocity
      // direction turns in the plane of the rod and its "up" (independent of where the circle's centre is)
      _fwd.copy(rod.dir);
      _right.crossVectors(_fwd, UP);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0).applyQuaternion(rodH.quat);
      _right.normalize();
      _up.crossVectors(_right, _fwd).normalize();
      crankV.lerp(reelH.vel, 1 - Math.exp(-dt / 0.03));
      const vf = crankV.dot(_fwd);
      const vu = crankV.dot(_up);
      if (Math.hypot(vf, vu) > CRANK_MIN_HAND_MPS) {
        const a = Math.atan2(vu, vf);
        if (Number.isFinite(crankAngle)) {
          let da = a - crankAngle;
          if (da > Math.PI) da -= 2 * Math.PI;
          else if (da < -Math.PI) da += 2 * Math.PI;
          crankRate += (da / dt - crankRate) * (1 - Math.exp(-dt / 0.12));
        }
        crankAngle = a;
        crankHoldT = CRANK_HOLD_S;
      } else {
        crankHoldT -= dt;
        if (crankHoldT <= 0) {
          crankAngle = NaN;
          crankRate *= Math.exp(-dt / 0.1);
        }
      }
      rps = Math.abs(crankRate) / (2 * Math.PI);
    } else {
      crankAngle = NaN;
      crankRate = 0;
      crankHoldT = 0;
    }
    cr.revPerSec = rps;
    cr.active = rps > CRANK_MIN_RPS;
    cr.speed01 = cr.active ? clamp((rps * CRANK_M_PER_REV) / TACKLE.reelRetrieveMps, 0, 1) : 0;
    xin.reelSpeed01 = Math.max(reel.trigger01, cr.speed01);

    // ---- sticks: rod hand turns (x) and sets the drag (y); reel hand opens the menu / picks lures
    xin.snapTurn = 0;
    xin.dragStep = 0;
    xin.lureStep = 0;
    xin.menu = reel.stickDown;
    if (ctx.allowSticks !== false) {
      const sx = rodH.stickX;
      const sy = rodH.stickY;
      if (!rodH.turnArmed && Math.abs(sx) < STICK_OFF) rodH.turnArmed = true;
      if (rodH.turnArmed && Math.abs(sx) > STICK_ON && Math.abs(sx) >= Math.abs(sy)) {
        xin.snapTurn = Math.sign(sx);
        rodH.turnArmed = false;
      }
      if (Math.abs(sy) > STICK_ON && Math.abs(sy) > Math.abs(sx)) {
        const dir = sy < 0 ? 1 : -1; // pushed forward (up, y < 0) tightens
        if (rodH.dragHeld !== dir) {
          rodH.dragHeld = dir;
          rodH.dragT = DRAG_REPEAT_S;
          xin.dragStep = dir;
        } else {
          rodH.dragT -= dt;
          if (rodH.dragT <= 0) {
            rodH.dragT += DRAG_REPEAT_S;
            xin.dragStep = dir;
          }
        }
      } else if (Math.abs(sy) < STICK_OFF) rodH.dragHeld = 0;
      if (reel.primaryDown) xin.lureStep = 1;
      else if (reel.secondaryDown) xin.lureStep = -1;
    }
    return xin;
  }

  // Cast from the tip velocity at trigger release (XR.md "Rod-tip cast mapping").
  const castOut = { power01: 0, direction: new THREE.Vector3(0, 0, -1), pitchRad: 0, speed: 0, elevRad: 0, rodRad: 0, behind: false, lob: false, angleFromLakeRad: 0 };
  function castFromRelease() {
    const v = xin.rod.tipVel;
    const speed = v.length();
    const h = Math.hypot(v.x, v.z);
    castOut.speed = speed;
    castOut.lob = !(speed >= CAST.stillMps);
    castOut.power01 = castPowerFromSpeed(speed);
    if (h >= CAST.minHorizMps) castOut.direction.set(v.x / h, 0, v.z / h);
    else {
      _v2.copy(xin.rod.dir).setY(0);
      if (_v2.lengthSq() < 1e-4) _v2.copy(xin.head.direction).setY(0);
      if (_v2.lengthSq() < 1e-6) _v2.copy(LAKE);
      castOut.direction.copy(_v2.normalize());
    }
    castOut.elevRad = Math.atan2(v.y, Math.max(h, 1e-6)); // the tip's path
    castOut.rodRad = xin.rod.pitch; // the (unbent) rod's elevation
    const launch = Math.max(castOut.elevRad, castOut.rodRad - CAST.rodReleaseRad);
    castOut.pitchRad = castOut.lob ? CAST.lobPitchRad : clamp(launch, CAST.pitchMinRad, CAST.pitchMaxRad);
    castOut.angleFromLakeRad = castOut.direction.angleTo(LAKE);
    castOut.behind = castOut.angleFromLakeRad > CAST.behindRad;
    return castOut;
  }

  // Side pressure: the rod's lateral offset from the line toward `point` (+ = rod swept to the angler's right).
  function sideToward(point) {
    if (!point || !xin.rod.connected) return 0;
    _v.subVectors(point, xin.rod.base).setY(0);
    const l = _v.length();
    if (l < 0.2) return 0;
    _v.multiplyScalar(1 / l);
    // right of the line direction (dx, dz) is (-dz, dx)
    const lat = xin.rod.dir.x * -_v.z + xin.rod.dir.z * _v.x;
    return clamp(lat / SIDE_FULL, -1, 1);
  }

  // The rig jumped (snap turn, recenter): the poses before it are not a motion. Velocities restart from here.
  function teleported() {
    hCount = 0;
    lastYaw = NaN;
    crankAngle = NaN;
    crankRate = 0;
    for (const h of HANDS) {
      h.hasPrev = false;
      h.vel.set(0, 0, 0);
    }
  }

  function setRodHand(h) {
    const next = h === 'left' ? 'left' : 'right';
    if (next === rodHand) return false;
    rodHand = next;
    xin.rod.consumed = xin.reel.consumed = false;
    resetHistory();
    return true;
  }

  function reset() {
    resetHistory();
    xin.presenting = false;
    xin.rod.consumed = xin.reel.consumed = false;
    for (const h of HANDS) {
      h.connected = false;
      h.source = h.gamepad = null;
      h.pinch = false;
      h.grip.visible = h.ray.visible = false;
      h.triggerB.held = h.primaryB.held = h.secondaryB.held = h.stickB.held = false;
    }
  }

  return {
    hands,
    xin,
    updateSources,
    derive,
    castFromRelease,
    sideToward,
    setRodHand,
    teleported,
    bindSession,
    unbindSession,
    reset,
    get rodHand() {
      return rodHand;
    },
    grip: (role) => roleHand(role).grip,
    ray: (role) => roleHand(role).ray,
    gamepad: (role) => roleHand(role).gamepad,
    handOf: (role) => roleHand(role),
  };
}
