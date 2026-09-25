// First-person view: the camera sits at the angler's eye on the dock end. Yaw/pitch are smoothed toward
// targets set by the pointer, keys, touch drags or the game (title drift, following a hooked fish).
// Yaw uses three.js' convention (camera.rotation.y; + turns left); yaw 0 looks down -Z over the lake.
// While a VR session presents, the headset owns the camera: setBypass(true) keeps the targets and state updating
// but never writes the camera (no title drift, no follow camera, no fight camera in the headset).
import * as THREE from 'three';
import { PLAYER, clamp, damp } from '../config.js';

const DEG = Math.PI / 180;
export const DEFAULT_PITCH = -7 * DEG;

export function createView(camera) {
  const eye = new THREE.Vector3(PLAYER.position[0], PLAYER.position[1] + PLAYER.eyeHeight, PLAYER.position[2]);
  const yawLim = PLAYER.yawLimitDeg * DEG;
  const pMin = PLAYER.pitchMinDeg * DEG;
  const pMax = PLAYER.pitchMaxDeg * DEG;
  const v = { yaw: 0, pitch: DEFAULT_PITCH, tYaw: 0, tPitch: DEFAULT_PITCH, rateX: 0, rateY: 0, follow: false };
  let bypass = false;
  camera.rotation.order = 'YXZ';

  function clampTargets() {
    v.tYaw = clamp(v.tYaw, -yawLim, yawLim);
    v.tPitch = clamp(v.tPitch, pMin, pMax);
  }

  // steerX/steerY in -1..1 (+x = right, +y = down), maxima in rad/s; rates ease in and out
  function steer(dt, steerX, steerY, maxYaw, maxPitch) {
    v.rateX = damp(v.rateX, steerX * maxYaw, 7, dt);
    v.rateY = damp(v.rateY, steerY * maxPitch, 7, dt);
    v.tYaw -= v.rateX * dt;
    v.tPitch -= v.rateY * dt;
    // don't wind up past the limits
    if (Math.abs(v.tYaw) >= yawLim) v.rateX *= 0.5;
    clampTargets();
  }

  function nudge(dYaw, dPitch) {
    v.tYaw += dYaw;
    v.tPitch += dPitch;
    clampTargets();
  }

  function set(yaw, pitch, instant = false) {
    if (Number.isFinite(yaw)) v.tYaw = yaw;
    if (Number.isFinite(pitch)) v.tPitch = pitch;
    clampTargets();
    if (instant) {
      v.yaw = v.tYaw;
      v.pitch = v.tPitch;
      v.rateX = v.rateY = 0;
    }
  }

  // Aim targets toward a world point (pitchBias raises the view; pitchScale softens looking down).
  // The angler can't turn past +-yawLim, so a point behind them (e.g. a fish bulldogging under the deck)
  // pins the view to the limit on the side it is already turned toward. Re-clamping atan2 every frame
  // would flip the target between +lim and -lim whenever the point crosses the centre line behind the
  // eye and whip the camera (and the camera-mounted rod) ~200 degrees across the lake.
  function aimAt(p, pitchScale = 0.75, pitchBias = 0) {
    const dx = p.x - eye.x;
    const dz = p.z - eye.z;
    const h = Math.hypot(dx, dz);
    if (h > 0.05) {
      let t = Math.atan2(-dx, -dz);
      if (Math.abs(t) > yawLim) {
        // already turned well to one side: stay there; else take the nearer limit
        const side = Math.abs(v.tYaw) > 0.35 * yawLim ? Math.sign(v.tYaw) : Math.sign(t) || 1;
        t = side * yawLim;
      }
      v.tYaw = t;
    }
    v.tPitch = Math.atan2(p.y - eye.y, Math.max(h, 0.3)) * pitchScale + pitchBias;
    clampTargets();
    v.follow = true;
  }

  // Following a world point (aimAt) turns the view no faster than this, so when a fish comes back into
  // the arc on the far side the view sweeps across instead of snapping (pointer / touch aim is not capped).
  const FOLLOW_YAW_RATE = 150 * DEG;
  function update(dt, lambda = 14) {
    const yaw = damp(v.yaw, v.tYaw, lambda, dt);
    if (v.follow) {
      const maxStep = FOLLOW_YAW_RATE * dt;
      v.yaw = clamp(yaw, v.yaw - maxStep, v.yaw + maxStep);
      v.follow = false;
    } else v.yaw = yaw;
    v.pitch = damp(v.pitch, v.tPitch, lambda, dt);
    apply();
  }

  function apply() {
    if (bypass) return;
    camera.position.copy(eye);
    camera.rotation.set(v.pitch, v.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }

  // horizontal unit direction the player is aiming
  function aimDir(out) {
    return out.set(-Math.sin(v.yaw), 0, -Math.cos(v.yaw));
  }

  function setBypass(on) {
    bypass = !!on;
    if (!bypass) apply();
  }

  apply();
  return {
    v,
    eye,
    steer,
    nudge,
    set,
    aimAt,
    update,
    apply,
    aimDir,
    yawLim,
    pMin,
    pMax,
    setBypass,
    get bypass() {
      return bypass;
    },
  };
}
