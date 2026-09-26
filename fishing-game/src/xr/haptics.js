// Controller haptics (XR.md "Haptics"). Pulses go to `gamepad.hapticActuators[0].pulse(intensity, ms)`, falling back
// to `gamepad.vibrationActuator.playEffect('dual-rumble', ...)`; every call is guarded (no actuator, a rejected
// promise, a browser without either) and nothing fires unless a VR session is running.
//
//   nibble          rod   0.25 x 35 ms          bite / float under   rod   0.7 x 110 ms
//   hookset         rod   1.0 x 60 ms           lure lands           rod   0.2 x 25 ms
//   fight           rod   continuous 0.08 + 0.55 * tension01, re-pulsed every ~50 ms; 0.9 x 40 ms on head shakes / jumps
//   drag slipping   reel  0.35 x 12 ms per ~3 cm of line paid out (<= 30 Hz)
//   reeling         reel  0.05 tick per handle turn (~0.52 m of line, the reel's gear)
//   line snap       rod   1.0 x 180 ms, then silence
//   UI hover/press  that hand 0.1 x 10 ms       bail opens (cast hold)  rod 0.15 x 15 ms
import { STATES, TACKLE, clamp } from '../config.js';
import { CRANK_M_PER_REV } from './input.js';

export const HAPTICS = {
  nibble: [0.25, 35],
  bite: [0.7, 110],
  hookset: [1.0, 60],
  landed: [0.2, 25],
  spike: [0.9, 40],
  dragClick: [0.35, 12],
  reelTick: [0.05, 15],
  snap: [1.0, 180],
  ui: [0.1, 10],
  bail: [0.15, 15],
};
const RUMBLE_EVERY_S = 0.05;
const RUMBLE_MS = 70; // a little longer than the re-pulse period so the buzz is continuous
const DRAG_CLICK_M = 0.03;
const DRAG_CLICK_MAX_HZ = 30;
const SNAP_SILENCE_S = 0.9;
const SHAKE_ON = 0.55;
const SHAKE_OFF = 0.35;

export function createHaptics({ events, getGamepad }) {
  let active = false;
  let clock = 0;
  let silentUntil = -1;
  let rumbleT = 0;
  let dragAcc = 0;
  let lastClick = -1;
  let reelAcc = 0;
  let shaking = false;
  const log = []; // recent pulses, for debugging / tests: { t, role, v, ms, kind }
  let count = 0;

  function send(gp, v, ms) {
    if (!gp) return false;
    try {
      const act = gp.hapticActuators && gp.hapticActuators[0];
      if (act && typeof act.pulse === 'function') {
        const p = act.pulse(v, ms);
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return true;
      }
      const va = gp.vibrationActuator;
      if (va && typeof va.playEffect === 'function') {
        const p = va.playEffect('dual-rumble', { duration: ms, strongMagnitude: v, weakMagnitude: v * 0.6, startDelay: 0 });
        if (p && typeof p.catch === 'function') p.catch(() => {});
        return true;
      }
    } catch {
      /* an actuator that refuses: ignore */
    }
    return false;
  }

  // role: 'rod' | 'reel', or a physical hand 'left' | 'right'
  function pulse(role, v, ms, kind = '', force = false) {
    if (!active) return false;
    if (!force && clock < silentUntil) return false;
    v = clamp(Number(v) || 0, 0, 1);
    ms = Math.max(1, Math.round(Number(ms) || 0));
    const ok = send(getGamepad(role), v, ms);
    count++;
    log.push({ t: +clock.toFixed(3), role, v: +v.toFixed(3), ms, kind, ok });
    if (log.length > 48) log.shift();
    return ok;
  }
  const fire = (role, kind) => pulse(role, HAPTICS[kind][0], HAPTICS[kind][1], kind);

  const offs = [];
  const on = (type, fn) => {
    if (events && typeof events.on === 'function') {
      const off = events.on(type, fn);
      if (typeof off === 'function') offs.push(off);
    }
  };
  on('fish:nibble', () => fire('rod', 'nibble'));
  on('state', (e) => {
    if (e && e.to === STATES.STRIKE) fire('rod', 'bite');
  });
  on('strike', (e) => {
    if (e && e.success) fire('rod', 'hookset');
  });
  on('fish:jump', () => fire('rod', 'spike'));
  on('lure:landed', () => fire('rod', 'landed'));
  on('tackle:snap', () => {
    pulse('rod', HAPTICS.snap[0], HAPTICS.snap[1], 'snap', true);
    silentUntil = clock + SNAP_SILENCE_S;
  });

  // Continuous feedback, once per rendered frame while presenting (dt = the frame's game time).
  function update(dt, frame) {
    if (!active || !frame) return;
    dt = Math.max(0, Math.min(0.1, dt || 0));
    clock += dt;
    const st = frame.state;
    const fighting = (st === STATES.FIGHTING || st === STATES.LANDING) && frame.hooked;
    if (fighting && clock >= silentUntil) {
      rumbleT -= dt;
      if (rumbleT <= 0) {
        rumbleT = RUMBLE_EVERY_S;
        pulse('rod', 0.08 + 0.55 * clamp(frame.tension01 || 0, 0, 1), RUMBLE_MS, 'fight');
      }
      const hs = frame.hooked.headShake01 || 0;
      if (!shaking && hs > SHAKE_ON) {
        shaking = true;
        fire('rod', 'spike');
      } else if (shaking && hs < SHAKE_OFF) shaking = false;
    } else {
      rumbleT = 0;
      shaking = false;
    }
    // drag clicks on the reel hand while line pays out
    const slip = frame.slipMps > 0 ? frame.slipMps : 0;
    if (slip > 0) {
      dragAcc += slip * dt;
      if (dragAcc >= DRAG_CLICK_M) {
        if (clock - lastClick >= 1 / DRAG_CLICK_MAX_HZ) {
          fire('reel', 'dragClick');
          lastClick = clock;
        }
        dragAcc = Math.min(dragAcc - DRAG_CLICK_M, DRAG_CLICK_M);
      }
    } else dragAcc = 0;
    // a faint tick per handle turn while reeling line in
    const inp = frame.input;
    if (inp && inp.reeling && inp.reelSpeed01 > 0.01 && slip <= 0) {
      reelAcc += inp.reelSpeed01 * TACKLE.reelRetrieveMps * dt;
      if (reelAcc >= CRANK_M_PER_REV) {
        reelAcc -= CRANK_M_PER_REV;
        fire('reel', 'reelTick');
      }
    }
  }

  function setActive(on) {
    active = !!on;
    rumbleT = 0;
    dragAcc = 0;
    reelAcc = 0;
    shaking = false;
    silentUntil = -1;
  }

  return {
    pulse,
    fire,
    update,
    setActive,
    get active() {
      return active;
    },
    get log() {
      return log.slice();
    },
    get count() {
      return count;
    },
    dispose() {
      for (const off of offs) off();
      offs.length = 0;
    },
  };
}
