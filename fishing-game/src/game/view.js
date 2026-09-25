// First-person view: the camera sits at the angler's eye on the dock end. Yaw/pitch are smoothed toward
// targets set by the pointer, keys, touch drags or the game (title drift, following a hooked fish).
// Yaw uses three.js' convention (camera.rotation.y; + turns left); yaw 0 looks down -Z over the lake.
import * as THREE from 'three';
import { PLAYER, clamp, damp } from '../config.js';

const DEG = Math.PI / 180;
export const DEFAULT_PITCH = -7 * DEG;

export function createView(camera) {
  const eye = new THREE.Vector3(PLAYER.position[0], PLAYER.position[1] + PLAYER.eyeHeight, PLAYER.position[2]);
  const yawLim = PLAYER.yawLimitDeg * DEG;
  const pMin = PLAYER.pitchMinDeg * DEG;
  const pMax = PLAYER.pitchMaxDeg * DEG;
  const v = { yaw: 0, pitch: DEFAULT_PITCH, tYaw: 0, tPitch: DEFAULT_PITCH, rateX: 0, rateY: 0 };
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
  function aimAt(p, pitchScale = 0.75, pitchBias = 0) {
    const dx = p.x - eye.x;
    const dz = p.z - eye.z;
    const h = Math.hypot(dx, dz);
    if (h > 0.05) v.tYaw = Math.atan2(-dx, -dz);
    v.tPitch = Math.atan2(p.y - eye.y, Math.max(h, 0.3)) * pitchScale + pitchBias;
    clampTargets();
  }

  function update(dt, lambda = 14) {
    v.yaw = damp(v.yaw, v.tYaw, lambda, dt);
    v.pitch = damp(v.pitch, v.tPitch, lambda, dt);
    apply();
  }

  function apply() {
    camera.position.copy(eye);
    camera.rotation.set(v.pitch, v.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  }

  // horizontal unit direction the player is aiming
  function aimDir(out) {
    return out.set(-Math.sin(v.yaw), 0, -Math.cos(v.yaw));
  }

  apply();
  return { v, eye, steer, nudge, set, aimAt, update, apply, aimDir, yawLim, pMin, pMax };
}
