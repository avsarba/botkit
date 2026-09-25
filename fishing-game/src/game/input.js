// Input: mouse aim without pointer lock (the view turns toward the pointer once it leaves a dead zone
// in the middle of the screen), hold-to-act on the canvas / Space, keyboard shortcuts, touch drags.
// Canvas listeners live on the canvas (bubble phase) so presses on UI controls never reach them.
import { clamp } from '../config.js';

const DEAD_X = 0.34; // fraction of the half-width around the centre where the view holds still
const DEAD_Y = 0.42;

export function createInput({ canvas, handlers }) {
  const pointer = { nx: 0, ny: 0, inside: false, armed: false, type: 'mouse' };
  const keys = new Set();
  const touch = { id: null, x: 0, y: 0, sx: 0, sy: 0, dx: 0, dy: 0, moved: 0 };
  let mouseHeld = false;
  let mouseId = null;
  let spaceHeld = false;
  let shift = false;
  let lastType = 'mouse';

  const call = (name, ...a) => {
    const fn = handlers[name];
    if (typeof fn === 'function') fn(...a);
  };

  function setPointer(e) {
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    pointer.nx = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    pointer.ny = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
  }

  function onPointerDown(e) {
    lastType = e.pointerType === 'touch' || e.pointerType === 'pen' ? 'touch' : 'mouse';
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      setPointer(e);
      pointer.inside = true;
      pointer.armed = true;
      if (mouseHeld) return;
      mouseHeld = true;
      mouseId = e.pointerId;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
      call('actionDown', 'mouse');
      return;
    }
    // touch / pen: aim drags (the UI's big button is the action)
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
    if (e.pointerType === 'mouse') {
      setPointer(e);
      pointer.inside = true;
      pointer.armed = true;
      lastType = 'mouse';
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
    if (e.pointerType === 'mouse') {
      if (!mouseHeld || (mouseId !== null && e.pointerId !== mouseId)) return;
      mouseHeld = false;
      mouseId = null;
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
    if (e.pointerType === 'mouse' && !mouseHeld) pointer.inside = false;
  }

  let wheelAcc = 0;
  function onWheel(e) {
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    while (Math.abs(wheelAcc) >= 60) {
      const s = Math.sign(wheelAcc);
      wheelAcc -= s * 60;
      call('dragStep', -s); // wheel up tightens, like the UI's gauge
    }
  }

  const isTyping = (t) => t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]');
  function onKeyDown(e) {
    if (e.defaultPrevented && e.key !== ' ') return;
    if (isTyping(e.target)) return;
    shift = e.shiftKey;
    if (e.key === ' ' || e.code === 'Space') {
      // a focused button owns Space (the UI activates it); gameplay ignores it
      if (e.target && e.target.closest && e.target.closest('button')) return;
      if (handlers.isModalOpen && handlers.isModalOpen()) return;
      e.preventDefault();
      if (e.repeat || spaceHeld) return;
      spaceHeld = true;
      lastType = 'mouse';
      call('actionDown', 'key');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code || '';
    if (/^(KeyA|KeyD|KeyW|KeyS|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(code)) {
      if (handlers.isModalOpen && handlers.isModalOpen()) return;
      keys.add(code);
      if (code.startsWith('Arrow')) e.preventDefault();
      return;
    }
    if (e.repeat) return;
    call('key', code, e);
  }

  function onKeyUp(e) {
    shift = e.shiftKey;
    if (e.key === ' ' || e.code === 'Space') {
      if (!spaceHeld) return;
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
    pointer.inside = false;
  }
  const onVisibility = () => {
    if (document.hidden) releaseAll();
  };
  const onContext = (e) => e.preventDefault();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', (e) => {
    if (e.pointerType !== 'mouse' && e.pointerId === touch.id) endTouch();
  });
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseAll);
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
    // horizontal/vertical steering in -1..1 (+x = turn right, +y = look down) from the mouse
    mouseSteer(out) {
      if (!pointer.inside || !pointer.armed || lastType !== 'mouse') {
        out.x = 0;
        out.y = 0;
        return out;
      }
      out.x = edge(pointer.nx, DEAD_X);
      out.y = edge(pointer.ny, DEAD_Y);
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
    },
    releaseAll,
    get touchActive() {
      return touch.id !== null;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
