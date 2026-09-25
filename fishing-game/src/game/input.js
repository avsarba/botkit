// Input: mouse aim without pointer lock (the view turns toward the pointer once it rests outside a dead
// zone in the middle of the screen), hold-to-act on the canvas / Space, keyboard shortcuts, touch drags.
// Canvas listeners live on the canvas (bubble phase) so presses on UI controls never reach them.
//
// A pen behaves like a mouse (press on the lake = hold to cast / reel / strike). Touch aims with drags and
// uses the UI's big hold button for actions.
//
// `pointer` is the EFFECTIVE pointer the game reads for rod control in a fight (nx/ny in -1..1):
//  - it follows the real pointer over the lake;
//  - while the pointer is over or near a HUD control (reaching for the drag buttons, a lure chip, the
//    clock), it holds the spot where the pointer was before that reach started, so the trip there does
//    not drop or sweep the rod;
//  - when the pointer leaves the canvas for good (out of the page), it moves to NEUTRAL, which maps to
//    a neutral rod-up pose, instead of freezing wherever the pointer crossed the edge.
// `pointer.inside` is true whenever those values are meaningful for mouse play.
//
// suspend(true) (a VR session is presenting: the controllers are the input) releases every hold and ignores
// canvas presses, Space and the steering keys until suspend(false); other key shortcuts (M, J, Esc...) still work.
import { clamp } from '../config.js';

const DEAD_X = 0.34; // fraction of the half-width around the centre where the view holds still
const DEAD_Y = 0.42;
const EDGE_DWELL_S = 0.15; // the pointer must stay in the edge zone this long before the view turns
const UI_GUARD_PX = 24; // aim steering and rod targets freeze this close to a HUD control
const UI_RECT_TTL_S = 0.3; // HUD control rects are re-measured at most this often
const NEUTRAL = Object.freeze({ nx: 0, ny: -0.2 }); // slightly above centre: rod up, no side pressure
const UI_CONTROLS = 'button, input, select, textarea, a[href], summary, [role="button"], [role="slider"], [role="switch"], [role="checkbox"]';
const HIST = 96; // pointer samples kept
const REACH_MAX_S = 1.5; // a reach toward the HUD is looked for this far back...
const REACH_MIN_SAMPLES = 12; // ...(at least this many samples, however slowly they came)
const REACH_TOL_PX = 8; // hand jitter tolerated while tracing a reach back

export function createInput({ canvas, handlers }) {
  const pointer = { nx: 0, ny: 0, inside: false, armed: false, type: 'mouse' };
  const raw = { nx: 0, ny: 0, x: 0, y: 0, inside: false, seen: false };
  const keys = new Set();
  const touch = { id: null, x: 0, y: 0, sx: 0, sy: 0, dx: 0, dy: 0, moved: 0 };
  let mouseHeld = false;
  let mouseId = null;
  let spaceHeld = false;
  let shift = false;
  let lastType = 'mouse';
  let suspended = false;
  let guard = false; // pointer over / near a HUD control
  const anchor = { nx: 0, ny: 0 };
  let edgeSince = -1;

  const now = () => performance.now() / 1000;
  const call = (name, ...a) => {
    const fn = handlers[name];
    if (typeof fn === 'function') fn(...a);
  };
  // pens (Surface, Wacom, Apple Pencil) act like a mouse; synthetic events may carry no type
  const mouseLike = (e) => e.pointerType === 'mouse' || e.pointerType === 'pen' || !e.pointerType;

  // ---- recent pointer path (to find where a reach toward the HUD started)
  const hT = new Float64Array(HIST);
  const hX = new Float32Array(HIST);
  const hY = new Float32Array(HIST);
  const hNX = new Float32Array(HIST);
  const hNY = new Float32Array(HIST);
  let hHead = 0;
  let hCount = 0;
  const hIdx = (k) => (hHead - 1 - k + HIST * 2) % HIST; // k = 0 is the newest sample
  function pushHistory(t) {
    hT[hHead] = t;
    hX[hHead] = raw.x;
    hY[hHead] = raw.y;
    hNX[hHead] = raw.nx;
    hNY[hHead] = raw.ny;
    hHead = (hHead + 1) % HIST;
    hCount = Math.min(HIST, hCount + 1);
  }
  // Where the pointer was before the current reach toward the HUD: walking back from the end of the
  // reach, the pointer keeps getting farther from where it ended up until the reach started; the
  // farthest point of that run is where the player had it. (Pauses between samples don't matter, so
  // this works for quick flicks and slow, deliberate reaches alike.)
  function setAnchorFromHistory(t) {
    let best = -1;
    let bestD = -1;
    for (let k = 0; k < hCount; k++) {
      const i = hIdx(k);
      if (k >= REACH_MIN_SAMPLES && t - hT[i] > REACH_MAX_S) break;
      const d = Math.hypot(hX[i] - raw.x, hY[i] - raw.y);
      if (d < bestD - REACH_TOL_PX) break; // came from somewhere nearer: the reach starts after this
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    anchor.nx = best >= 0 ? hNX[best] : raw.nx;
    anchor.ny = best >= 0 ? hNY[best] : raw.ny;
  }

  // ---- HUD control rects (CSS px, viewport space), re-measured lazily
  let uiRoot = null;
  const rects = [];
  let rectsAt = -1;
  function measureControls(t) {
    rectsAt = t;
    rects.length = 0;
    if (!uiRoot || !uiRoot.isConnected) uiRoot = document.getElementById('ui');
    if (!uiRoot) return;
    for (const el of uiRoot.querySelectorAll(UI_CONTROLS)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (el.closest('[inert], [hidden]')) continue;
      const cs = window.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || cs.display === 'none') continue;
      rects.push(r.left, r.top, r.right, r.bottom);
    }
  }
  function nearControl(x, y, t) {
    if (rectsAt < 0 || t - rectsAt > UI_RECT_TTL_S) measureControls(t);
    const m = UI_GUARD_PX;
    for (let i = 0; i < rects.length; i += 4) {
      if (x >= rects[i] - m && x <= rects[i + 2] + m && y >= rects[i + 1] - m && y <= rects[i + 3] + m) return true;
    }
    return false;
  }
  const invalidateRects = () => {
    rectsAt = -1;
  };
  const inUi = (el) => {
    if (!el || el === canvas) return false;
    if (!uiRoot || !uiRoot.isConnected) uiRoot = document.getElementById('ui');
    return !!(uiRoot && uiRoot.contains(el));
  };

  function setGuard(on, t) {
    if (on && !guard) setAnchorFromHistory(t);
    guard = on;
    if (on) edgeSince = -1;
  }

  // effective pointer (see the header)
  function syncPointer() {
    if (guard && !mouseHeld) {
      pointer.nx = anchor.nx;
      pointer.ny = anchor.ny;
      pointer.inside = true;
    } else if (raw.inside || mouseHeld) {
      pointer.nx = raw.nx;
      pointer.ny = raw.ny;
      pointer.inside = true;
    } else if (raw.seen) {
      pointer.nx = NEUTRAL.nx;
      pointer.ny = NEUTRAL.ny;
      pointer.inside = true;
    } else pointer.inside = false;
  }

  function setRaw(e) {
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    raw.x = e.clientX;
    raw.y = e.clientY;
    raw.nx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    raw.ny = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    raw.seen = true;
    return true;
  }

  // A click on the lake takes keyboard focus back from any HUD control (the mouse pointerdown below is
  // preventDefault-ed, which would otherwise leave focus on it, and Space would keep pressing it).
  function dropFocus() {
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement && a !== canvas && typeof a.blur === 'function') a.blur();
  }

  function onPointerDown(e) {
    if (suspended) return;
    if (mouseLike(e)) {
      lastType = 'mouse';
      if (e.button !== 0) return;
      dropFocus();
      const t = now();
      if (setRaw(e)) pushHistory(t);
      raw.inside = true;
      pointer.armed = true;
      guard = false;
      if (mouseHeld) {
        syncPointer();
        return;
      }
      mouseHeld = true;
      mouseId = e.pointerId;
      syncPointer();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
      call('actionDown', 'mouse');
      return;
    }
    // touch: aim drags (the UI's big button is the action)
    dropFocus();
    lastType = 'touch';
    if (touch.id !== null) return;
    touch.id = e.pointerId;
    touch.x = touch.sx = e.clientX;
    touch.y = touch.sy = e.clientY;
    touch.dx = touch.dy = 0;
    touch.moved = 0;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    call('touchStart');
  }

  function onPointerMove(e) {
    if (mouseLike(e)) {
      const t = now();
      if (!setRaw(e)) return;
      pushHistory(t);
      raw.inside = true;
      pointer.armed = true;
      lastType = 'mouse';
      if (!mouseHeld) setGuard(nearControl(e.clientX, e.clientY, t), t);
      syncPointer();
      return;
    }
    if (e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    touch.x = e.clientX;
    touch.y = e.clientY;
    touch.dx += dx;
    touch.dy += dy;
    touch.moved += Math.abs(dx) + Math.abs(dy);
  }

  function onPointerUp(e) {
    if (mouseLike(e)) {
      if (!mouseHeld || (mouseId !== null && e.pointerId !== mouseId)) return;
      mouseHeld = false;
      mouseId = null;
      syncPointer();
      call('actionUp', 'mouse');
      return;
    }
    if (e.pointerId !== touch.id) return;
    endTouch();
  }

  function endTouch() {
    if (touch.id === null) return;
    touch.id = null;
    call('touchEnd');
  }

  function onPointerLeave(e) {
    if (!mouseLike(e) || mouseHeld) return;
    raw.inside = false;
    edgeSince = -1;
    // onto a HUD control: hold the rod where it was before the reach; out of the page: rod up
    if (inUi(e.relatedTarget)) setGuard(true, now());
    else guard = false;
    syncPointer();
  }

  let wheelAcc = 0;
  function onWheel(e) {
    e.preventDefault();
    if (suspended) return;
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    while (Math.abs(wheelAcc) >= 60) {
      const s = Math.sign(wheelAcc);
      wheelAcc -= s * 60;
      call('dragStep', -s); // wheel up tightens, like the UI's gauge
    }
  }

  const isTyping = (t) => t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');
  const isSpace = (e) => e.key === ' ' || e.code === 'Space';
  // Space belongs to a focused control only in dialogs (pause, journal, catch card) and on the title.
  // A HUD control that kept focus (a lure chip, a time preset, the sound button) must not swallow the
  // game's main action: there Space casts / reels / strikes and Enter still presses the control.
  function spaceOwnedByControl(target) {
    if (!target || typeof target.closest !== 'function') return false;
    const ctl = target.closest(UI_CONTROLS);
    if (!ctl) return false;
    return !(ctl.closest('#hud') && !ctl.closest('[role="dialog"], dialog, .modal'));
  }
  function onKeyDown(e) {
    if (e.defaultPrevented && !isSpace(e)) return;
    if (isTyping(e.target)) return;
    shift = e.shiftKey;
    if (isSpace(e)) {
      if (suspended) return;
      if (spaceOwnedByControl(e.target)) return;
      if (handlers.isModalOpen && handlers.isModalOpen()) return;
      e.preventDefault(); // also keeps a focused HUD button from being pressed
      if (e.repeat || spaceHeld) return;
      spaceHeld = true;
      lastType = 'mouse';
      call('actionDown', 'key');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code || '';
    if (/^(KeyA|KeyD|KeyW|KeyS|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(code)) {
      if (suspended || (handlers.isModalOpen && handlers.isModalOpen())) return;
      keys.add(code);
      if (code.startsWith('Arrow')) e.preventDefault();
      return;
    }
    if (e.repeat) return;
    call('key', code, e);
  }

  function onKeyUp(e) {
    shift = e.shiftKey;
    if (isSpace(e)) {
      if (!spaceHeld) return;
      e.preventDefault(); // a focused button would otherwise "click" on keyup
      spaceHeld = false;
      call('actionUp', 'key');
      return;
    }
    keys.delete(e.code);
  }

  // Forced release (blur, hidden tab, pause, dialogs): holds end without acting (no cast).
  function releaseAll() {
    if (mouseHeld) {
      mouseHeld = false;
      mouseId = null;
      call('actionUp', 'mouse', true);
    }
    if (spaceHeld) {
      spaceHeld = false;
      call('actionUp', 'key', true);
    }
    keys.clear();
    shift = false;
    endTouch();
    raw.inside = false;
    guard = false;
    edgeSince = -1;
    syncPointer();
  }
  const onVisibility = () => {
    if (document.hidden) releaseAll();
  };
  const onContext = (e) => e.preventDefault();
  const onLostCapture = (e) => {
    if (!mouseLike(e) && e.pointerId === touch.id) endTouch();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerenter', invalidateRects);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
  window.addEventListener('resize', invalidateRects);
  document.addEventListener('visibilitychange', onVisibility);

  // Aim steering from the pointer position: 0 inside the dead zone, easing up to +-1 at the edges.
  function edge(v, dead) {
    const a = Math.abs(v);
    if (a <= dead) return 0;
    const t = (a - dead) / (1 - dead);
    return Math.sign(v) * t * t * (1.6 - 0.6 * t);
  }

  return {
    pointer,
    touch,
    get shift() {
      return shift;
    },
    get lastType() {
      return lastType;
    },
    // true while the pointer is over or near a HUD control
    get overUi() {
      return guard && !mouseHeld;
    },
    // horizontal/vertical steering in -1..1 (+x = turn right, +y = look down) from the mouse. Nothing
    // while the pointer is over / near a HUD control, and only after it has rested in the edge zone for
    // EDGE_DWELL_S, so passing through the edge on the way to a control does not turn the view.
    mouseSteer(out) {
      out.x = 0;
      out.y = 0;
      if (!raw.inside || !pointer.armed || lastType !== 'mouse' || (guard && !mouseHeld)) {
        edgeSince = -1;
        return out;
      }
      const x = edge(raw.nx, DEAD_X);
      const y = edge(raw.ny, DEAD_Y);
      if (!x && !y) {
        edgeSince = -1;
        return out;
      }
      const t = now();
      if (edgeSince < 0) edgeSince = t;
      if (t - edgeSince < EDGE_DWELL_S) return out;
      out.x = x;
      out.y = y;
      return out;
    },
    keyAxis(out) {
      out.x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      out.y = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
      return out;
    },
    // pixels dragged since the last call (touch aim)
    takeTouchDelta(out) {
      out.x = touch.dx;
      out.y = touch.dy;
      touch.dx = 0;
      touch.dy = 0;
      return out;
    },
    // Disarm edge steering until the pointer moves again (after Start, dialogs, etc.).
    disarm() {
      pointer.armed = false;
      edgeSince = -1;
      invalidateRects();
    },
    releaseAll,
    // VR: the controllers take over (see the header)
    suspend(on) {
      on = !!on;
      if (on === suspended) return;
      if (on) releaseAll();
      suspended = on;
      pointer.armed = false;
      edgeSince = -1;
      invalidateRects();
    },
    get suspended() {
      return suspended;
    },
    get touchActive() {
      return touch.id !== null;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerenter', invalidateRects);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('resize', invalidateRects);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
