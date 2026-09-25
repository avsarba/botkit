// Head-lazy prompt strip, STRIKE cue and toasts.
// - The strip rides an anchor that follows the head's position and, lazily, its heading: it sits ~1.6 m
//   ahead and ~22 degrees below eye level and swings back in front (a critically damped spring, so it
//   never jerks) once the head has turned more than 35 degrees away from it.
// - Toasts stack above the horizon on the same anchor (the DOM's top-of-screen lane).
// - The STRIKE cue flashes above the horizon straight ahead of where the head points at that moment,
//   clear of the float, world-fixed for its ~1.2 s (the DOM cue's timing and motion).
// The prompt fades like the DOM prompt: steady info / good hints while waiting or fighting fade after
// 4 s; warnings and dangers stay.
import * as THREE from 'three';
import { createPanel } from './panel.js';
import { setFont, text, box, dot, textWidth, wrapBalanced } from './draw.js';

const DEG = Math.PI / 180;
const DIST = 1.6;
const DROP = 22 * DEG;
const RECENTER = 35 * DEG;
const SETTLE = 4 * DEG;
const OMEGA = 4.2; // spring stiffness (rad/s): ~1 s to swing back into place
const QUIET_AFTER_MS = 4000;
const FADE_MS = 400;
const TOAST_MAX = 3;
const TOAST_EL = 12 * DEG; // top of the toast stack, above the horizon
const STRIKE_EL = 7 * DEG;
const STRIKE_DIST = 1.75;
const STRIKE_MS = 1150;

// px per meter: ~1 mm per canvas pixel at 1.6 m is about one headset pixel (Quest 3 ~ 25 px / degree)
const PROMPT_W = 1200;
const PROMPT_H = 168;
const TOAST_W = 1040;
const TOAST_H = 84;
const STRIKE_W = 1200;
const STRIKE_H = 360;

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createPromptStrip(tk) {
  const c = tk.c;
  const F = tk.font;

  const anchor = new THREE.Group();
  anchor.name = 'xr-prompt-anchor';

  // ---------- prompt pill ----------
  const pv = { text: '', kind: 'info' };
  const PROMPT_FONT = 38; // 3.8 cm em at 1.6 m: cap height ~2.6 cm
  function drawPrompt(ctx) {
    if (!pv.text) return PROMPT_H;
    setFont(ctx, 600, PROMPT_FONT, F.ui, { spacing: 0.02 });
    const maxText = PROMPT_W - 2 * 8 - 60 - 22;
    let lines = [pv.text];
    if (textWidth(ctx, pv.text) > maxText) lines = wrapBalanced(ctx, pv.text, maxText).slice(0, 2);
    const lh = PROMPT_FONT * 1.28;
    const tw = Math.max(...lines.map((l) => textWidth(ctx, l)));
    const padL = 60;
    const padR = 30;
    const w = Math.min(PROMPT_W - 16, tw + padL + padR);
    const h = lines.length * lh + 34;
    const x = (PROMPT_W - w) / 2;
    const y = (PROMPT_H - h) / 2;
    const border = pv.kind === 'warn' ? c['amber-soft'] : pv.kind === 'danger' ? c['red-soft'] : c.hair;
    box(ctx, x, y, w, h, Math.min(h / 2, 40), { fill: c['glass-strong'], stroke: border, lineWidth: pv.kind === 'warn' || pv.kind === 'danger' ? 3 : 2 });
    const dotColor = pv.kind === 'ready' || pv.kind === 'good' ? c.line : pv.kind === 'warn' ? c.amber : pv.kind === 'danger' ? c.red : c.muted;
    const blinkDim = pv.kind === 'danger' && pv.blink;
    ctx.globalAlpha = blinkDim ? 0.25 : 1;
    dot(ctx, x + 34, PROMPT_H / 2, 8, dotColor);
    ctx.globalAlpha = 1;
    setFont(ctx, 600, PROMPT_FONT, F.ui, { spacing: 0.02 });
    const y0 = PROMPT_H / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => text(ctx, l, x + padL + (w - padL - padR) / 2, y0 + i * lh, { color: c.text, align: 'center', baseline: 'middle' }));
    return PROMPT_H;
  }
  const prompt = createPanel({ name: 'xr-prompt', widthM: PROMPT_W / 1000, heightM: PROMPT_H / 1000, pxW: PROMPT_W, pxH: PROMPT_H, draw: drawPrompt });
  prompt.object.position.set(0, -DIST * Math.sin(DROP), -DIST * Math.cos(DROP));
  prompt.object.rotation.x = -DROP;
  anchor.add(prompt.object);

  // fade state (DOM: .prompt.is-quiet -> opacity 0 over 400 ms)
  let shownAt = 0;
  let quiet = false;
  let quietEligible = false;
  let alpha = 0;
  let target = 0;

  // ---------- toasts ----------
  const toasts = [];
  function makeToast() {
    const t = { text: '', kind: 'info', born: 0, ms: 3400, out: 0, y: 0, alive: false };
    t.panel = createPanel({
      name: 'xr-toast',
      widthM: TOAST_W / 1000,
      heightM: TOAST_H / 1000,
      pxW: TOAST_W,
      pxH: TOAST_H,
      draw: (ctx) => {
        setFont(ctx, 500, 32, F.ui);
        const maxText = TOAST_W - 16 - 58 - 28;
        let s = t.text;
        while (s.length > 4 && textWidth(ctx, s) > maxText) s = `${s.slice(0, -2).trimEnd()}…`;
        const w = Math.min(TOAST_W - 16, textWidth(ctx, s) + 58 + 28);
        const h = 66;
        const x = (TOAST_W - w) / 2;
        const y = (TOAST_H - h) / 2;
        box(ctx, x, y, w, h, 16, { fill: c['glass-strong'], stroke: t.kind === 'bad' ? c['red-soft'] : c.hair, lineWidth: 2 });
        dot(ctx, x + 30, TOAST_H / 2, 7, t.kind === 'good' ? c.line : t.kind === 'bad' ? c.red : c.muted);
        text(ctx, s, x + 54, TOAST_H / 2 + 1, { color: c.text, baseline: 'middle' });
        return TOAST_H;
      },
    });
    t.panel.object.rotation.x = TOAST_EL;
    anchor.add(t.panel.object);
    return t;
  }
  const pool = Array.from({ length: TOAST_MAX }, makeToast);
  function toast(textIn, kind = 'info', ms = 3400, now = performance.now()) {
    if (!textIn) return;
    let t = pool.find((p) => !p.alive);
    if (!t) {
      t = toasts.shift(); // drop the oldest (DOM: at most three)
    }
    t.text = String(textIn);
    t.kind = kind === 'good' || kind === 'bad' ? kind : 'info';
    t.born = now;
    t.ms = Number.isFinite(ms) && ms > 0 ? ms : 3400;
    t.out = 0;
    t.alive = true;
    t.y = NaN; // placed on the next update
    t.panel.invalidate();
    toasts.push(t);
  }

  // ---------- STRIKE ----------
  const sv = { sub: '' };
  function drawStrike(ctx) {
    ctx.shadowColor = c['shadow-deep'];
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 4;
    setFont(ctx, 800, 236, F.display, { spacing: 0.05 });
    text(ctx, 'STRIKE', STRIKE_W / 2, 232, { color: c.red, align: 'center', maxWidth: STRIKE_W - 60 });
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 2;
    setFont(ctx, 600, 38, F.ui, { spacing: 0.16 });
    text(ctx, sv.sub.toUpperCase(), STRIKE_W / 2, 308, { color: c.text, align: 'center', maxWidth: STRIKE_W - 60 });
    return STRIKE_H;
  }
  const strike = createPanel({ name: 'xr-strike', widthM: STRIKE_W / 1000, heightM: STRIKE_H / 1000, pxW: STRIKE_W, pxH: STRIKE_H, draw: drawStrike });
  const strikeGroup = new THREE.Group();
  strikeGroup.name = 'xr-strike-anchor';
  strikeGroup.add(strike.object);
  strike.object.position.set(0, STRIKE_DIST * Math.sin(STRIKE_EL), -STRIKE_DIST * Math.cos(STRIKE_EL));
  strike.object.rotation.x = STRIKE_EL;
  let strikeAt = -1;
  let strikeCutAt = -1;
  let strikeCutFrom = 1;
  let striking = false;

  // ---------- placement ----------
  const st = { init: false, yaw: 0, vel: 0, target: 0, tracking: false, pos: new THREE.Vector3() };
  function place(headPos, headYaw, dt, snap = false) {
    if (!st.init || snap) {
      st.init = true;
      st.yaw = st.target = headYaw;
      st.vel = 0;
      st.tracking = false;
      st.pos.copy(headPos);
    }
    const off = wrapAngle(headYaw - st.target);
    if (!st.tracking && Math.abs(off) > RECENTER) st.tracking = true;
    if (st.tracking) {
      st.target = st.target + off; // follow the head until it settles in front again
      if (Math.abs(wrapAngle(headYaw - st.yaw)) < SETTLE) st.tracking = false;
    }
    // critically damped spring toward the target heading (continuous velocity: never jerky)
    const h = Math.min(dt, 0.05);
    if (h > 0) {
      const err = wrapAngle(st.target - st.yaw);
      const acc = OMEGA * OMEGA * err - 2 * OMEGA * st.vel;
      st.vel += acc * h;
      st.yaw = wrapAngle(st.yaw + st.vel * h);
      // position follows the head (the player may walk along the deck), softly
      const k = 1 - Math.exp(-5 * h);
      st.pos.lerp(headPos, k);
    }
    anchor.position.copy(st.pos);
    anchor.rotation.set(0, st.yaw, 0);
  }

  // ---------- per-frame ----------
  function setPrompt(textIn, kind, { eligibleQuiet = false, now = performance.now(), blink = false } = {}) {
    const t = textIn || '';
    const changed = t !== pv.text;
    if (changed || kind !== pv.kind) {
      if (changed) {
        shownAt = now;
        quiet = false;
      }
      pv.text = t;
      pv.kind = kind;
      prompt.invalidate();
    }
    if (pv.blink !== blink) {
      pv.blink = blink;
      if (pv.kind === 'danger') prompt.invalidate();
    }
    quietEligible = !!(t && eligibleQuiet);
    if (!quietEligible) quiet = false;
    else if (!quiet && now - shownAt >= QUIET_AFTER_MS) quiet = true;
    target = t && !quiet ? 1 : 0;
  }

  function strikeCue(sub, headPos, headYaw, now = performance.now()) {
    sv.sub = sub || '';
    strike.invalidate();
    strikeGroup.position.copy(headPos);
    strikeGroup.rotation.set(0, headYaw, 0);
    strikeAt = now;
    strikeCutAt = -1;
    striking = true;
    strike.setWanted(true);
  }
  // the window closed (hook set, missed): clear the word quickly instead of letting it linger
  function cutStrike(now = performance.now()) {
    if (!striking || strikeCutAt >= 0) return;
    strikeCutAt = now;
    strikeCutFrom = strike.opacity;
  }
  function endStrike() {
    striking = false;
    strikeAt = -1;
    strikeCutAt = -1;
    strike.setWanted(false);
  }

  // visible: the prompt (hidden under the menu / on the catch card); toastsVisible: the toast lane
  function update(now, dt, visible, toastsVisible = visible) {
    // prompt fade (400 ms like the DOM transition; the first appearance fades in quickly)
    const want = visible ? target : 0;
    const rate = dt / (FADE_MS / 1000);
    alpha = want > alpha ? Math.min(want, alpha + rate * 2) : Math.max(want, alpha - rate);
    prompt.setWanted(alpha > 0.004 && !!pv.text);
    prompt.setOpacity(alpha);

    // toasts: fade/slide in 240 ms, out 320 ms after their time; newest at the bottom of the stack
    for (let i = toasts.length - 1; i >= 0; i--) {
      const t = toasts[i];
      const age = now - t.born;
      if (age > t.ms + 340) {
        t.alive = false;
        t.panel.setWanted(false);
        toasts.splice(i, 1);
      }
    }
    for (let i = 0; i < toasts.length; i++) {
      const t = toasts[i];
      const age = now - t.born;
      const aIn = Math.min(1, age / 240);
      const aOut = age > t.ms ? Math.max(0, 1 - (age - t.ms) / 320) : 1;
      const slot = -i * 0.092;
      t.y = Number.isNaN(t.y) ? slot + 0.012 : t.y + (slot - t.y) * (1 - Math.exp(-12 * Math.min(dt, 0.05)));
      const lift = (1 - aIn) * 0.012 + (1 - aOut) * 0.01;
      const r = DIST + 0.02;
      t.panel.object.position.set(0, r * Math.sin(TOAST_EL) + t.y + lift, -r * Math.cos(TOAST_EL));
      t.panel.setWanted(toastsVisible);
      t.panel.setOpacity(aIn * aOut);
    }

    // strike: scale 1.07 -> 1 in the first 10 %, hold, fade out from 74 % (the DOM keyframes)
    if (striking) {
      const age = now - strikeAt;
      let a;
      let sc = 1;
      if (strikeCutAt >= 0) {
        a = strikeCutFrom * Math.max(0, 1 - (now - strikeCutAt) / 160);
      } else {
        const p = age / STRIKE_MS;
        a = p < 0.74 ? 1 : Math.max(0, 1 - (p - 0.74) / 0.26);
        sc = p < 0.1 ? 1.07 - 0.07 * (p / 0.1) * (p / 0.1) : 1;
      }
      strike.object.scale.setScalar(sc);
      strike.setOpacity(a);
      if (a <= 0.004 || age > STRIKE_MS + 200) endStrike();
    }
  }

  return {
    anchor,
    strikeGroup,
    panels: [prompt, strike, ...pool.map((t) => t.panel)],
    place,
    setPrompt,
    strikeCue,
    cutStrike,
    toast,
    update,
    get striking() {
      return striking;
    },
    get promptText() {
      return pv.text;
    },
    get promptAlpha() {
      return alpha;
    },
    clearToasts() {
      for (const t of toasts) {
        t.alive = false;
        t.panel.setWanted(false);
      }
      toasts.length = 0;
    },
    reset() {
      st.init = false;
      endStrike();
      alpha = 0;
      prompt.setWanted(false);
    },
    dispose() {
      anchor.removeFromParent();
      strikeGroup.removeFromParent();
      prompt.dispose();
      strike.dispose();
      for (const t of pool) t.panel.dispose();
    },
  };
}
