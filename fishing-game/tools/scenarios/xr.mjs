// VR (WebXR, XR.md) end to end in the emulated Meta Quest 3 (IWER), through the real controls: the title's Enter VR
// button -> READY in the headset; casts from scripted forward swings of the rod controller (trigger held, let go
// mid-swing) at three swing speeds and to the left / right, a lob and a cast behind the player; every lure from the
// reel-hand X / Y; reeling with the analog reel trigger and with a crank gesture of the reel hand; a forced bite set
// with an upward flick, fought with the real rod lift / side and the reel trigger to CAUGHT, the fish in the reel hand
// with the card (clear of the resting rod; no shader compile), kept with A; a second catch hooked with A and released
// with B; a spinner bite with the rod held still (no hookset by itself) and a STRIKE while looking down; sidearm and
// three-quarter casts; reverse cranking (no retrieve); pausing mid-fight with the rod moving; the VR menu from the reel-stick click
// (time preset, units, sound, journal, rod hand) and resume; a left-handed lob and snap turns; Exit VR from the menu,
// the desktop working again; re-entry from the pause menu and a headset-side session.end(). Along the way: the page
// losing focus / being hidden, a window resize and the headset's system menu while presenting, audio from the Enter VR
// click, the XR quality profile and its switch back on exit, the page UI inert while presenting. Per-eye (stereo)
// screenshots at the key moments.
//
//   npm run build
//   node tools/harness.mjs --xr --scenario tools/scenarios/xr.mjs --out out/xr --size 960x540
//
// Poses are in the emulator's reference space (local-floor; the game's rig maps it onto the dock). Controller
// orientations are given as the target ray's pitch (+ up) and yaw (+ left); the rod blank points ~45 deg above the
// ray (the Touch grip is ~45 deg above the ray and the rod runs straight through the fist: config XR_ROD_TILT_RAD 0).
// Every gesture is played one pose
// per XR frame from the game's frame hook (debug.xr.everyFrame), so SwiftShader's slow frames don't distort speeds:
// each frame is exactly 50 ms of game time (debug.setFixedDt(0.05); without it an emulated frame that comes early
// would make that frame's pose step look faster).
//
// XR_ONLY=enter,lures,casts,reel,catch1,catch2,strike,menu,desktop,reenter runs a subset while developing (each section
// starts from READY in VR, except desktop / reenter, which follow menu's Exit VR).
import { makeLib } from './lib.mjs';

const DEG = Math.PI / 180;
const FRAME_S = 0.05; // game time per XR frame (debug.setFixedDt, below)

export default async (h) => {
  const { page, log } = h;
  const L = makeLib(h);
  const { g, dbg, assert, T } = L;
  const only = (process.env.XR_ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const want = (name) => !only.length || only.includes(name);

  // three.js refuses (with a warning) any drawing-buffer resize while the headset presents
  const sizeWarnings = [];
  page.on('console', (m) => {
    if (/change size while VR/i.test(m.text())) sizeWarnings.push(m.text());
  });

  // ------------------------------------------------------------------ helpers
  const xs = () => g('window.__game.debug.xr.status()');
  const xf = (n = 1) => g(`window.__game.debug.xr.waitFrames(${n})`);
  const dev = (js) => g(`(() => { const d = window.__xrDevice; ${js}; return true; })()`);
  const ctl = (hand, js) => dev(`const c = d.controllers.${hand}; ${js}`);
  // quaternion (x, y, z, w) of a ray pitched up by pitchDeg after turning left by yawDeg
  const qOf = (pitchDeg, yawDeg = 0) => {
    const p = (pitchDeg * DEG) / 2;
    const y = (yawDeg * DEG) / 2;
    return [Math.cos(y) * Math.sin(p), Math.sin(y) * Math.cos(p), -Math.sin(y) * Math.sin(p), Math.cos(y) * Math.cos(p)];
  };
  const pose = (hand, pitchDeg, pos, yawDeg = 0) => ctl(hand, `c.quaternion.set(${qOf(pitchDeg, yawDeg).join(',')}); c.position.set(${pos.join(',')})`);
  const headPose = (pos, pitchDeg = 0, yawDeg = 0) => dev(`d.position.set(${pos.join(',')}); d.quaternion.set(${qOf(pitchDeg, yawDeg).join(',')})`);
  const button = (hand, id, v) => ctl(hand, `c.updateButtonValue('${id}', ${v})`);
  const stick = (hand, x, y) => ctl(hand, `c.updateAxes('thumbstick', ${x}, ${y})`);
  const tap = async (hand, id) => {
    await button(hand, id, 1);
    await xf(1);
    await button(hand, id, 0);
    await xf(1);
  };
  const flick = async (hand, x, y) => {
    await stick(hand, x, y);
    await xf(1);
    await stick(hand, 0, 0);
    await xf(1);
  };
  const stereoShot = async (name) => {
    await dev('d.stereoEnabled = true');
    await xf(2);
    await h.shot(name);
    await dev('d.stereoEnabled = false');
    await xf(1);
  };
  const monoShot = async (name) => {
    await xf(1);
    return h.shot(name);
  };
  const presenting = () => g('window.__game.debug.xr.status().presenting');
  // every xr-* object in the scene, by name (to compare two sessions: nothing duplicated, nothing left behind)
  const xrNodes = () => g(`(() => { const n = {}; window.__game.debug.modules().scene.traverse((o) => { if (/^xr-/.test(o.name)) n[o.name] = (n[o.name] || 0) + 1; }); return Object.fromEntries(Object.entries(n).sort()); })()`);
  const pageUI = () =>
    page.evaluate(() => {
      const ui = document.getElementById('ui');
      const vis = (id) => {
        const e = document.getElementById(id);
        return !!(e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');
      };
      return { inert: !!ui.inert, xr: ui.hasAttribute('data-xr'), note: vis('xr-note'), hud: vis('hud'), pause: vis('pause'), title: vis('title') };
    });

  // One pose per XR frame on one controller: steps [{ pitch, yaw, pos, trigger }]. Returns a per-frame trace.
  const drive = (hand, steps) =>
    g(`new Promise((res) => {
      const c = window.__xrDevice.controllers.${hand}, dx = window.__game.debug.xr, steps = ${JSON.stringify(steps)};
      let i = 0; const out = [];
      dx.everyFrame(() => {
        const st = dx.status();
        if (i > 0) out.push({ state: st.state, tipSpeed: st.rod.tipSpeed, pitchRate: st.rod.pitchRate, trigger: st.rod.trigger, power: st.castPower01, dt: +window.__game.frame.dt.toFixed(3) });
        if (i >= steps.length) { res(out); return false; }
        const s = steps[i++];
        const p = s.pitch * Math.PI / 360, y = (s.yaw || 0) * Math.PI / 360;
        c.quaternion.set(Math.cos(y) * Math.sin(p), Math.sin(y) * Math.cos(p), -Math.sin(y) * Math.sin(p), Math.cos(y) * Math.cos(p));
        c.position.set(s.pos[0], s.pos[1], s.pos[2]);
        if (s.trigger != null) c.updateButtonValue('trigger', s.trigger);
        return true;
      });
    })`);

  // The reel hand circling the reel handle at `rps` turns per second for `frames` XR frames, in the plane of the rod
  // and its "up" (the crank axis is the rod's sideways axis), forward (over the top toward the rod tip, as a spinning
  // reel is cranked) for rps > 0, backward for rps < 0. Returns the input's crank readings per frame.
  const crank = (hand, rps, frames, radius = 0.05) =>
    g(`new Promise((res) => {
      const dx = window.__game.debug.xr, c = window.__xrDevice.controllers.${hand};
      const st0 = dx.status();
      // the grip (the hand, which sits a few cm off the controller's pose) circles the crank's pivot, as the knob does
      // (4.65 cm), in the reference space; the controller keeps its orientation, so its pose circles the pivot less
      // that fixed offset
      const sc = window.__game.debug.modules().scene;
      const wpos = (o) => { o.updateWorldMatrix(true, false); const e = o.matrixWorld.elements; return dx.toRig([e[12], e[13], e[14]]); };
      const pv = wpos(window.__game.debug.modules().tackle.debug.rod.crank);
      const gp = wpos(sc.getObjectByName('xr-grip-${hand}'));
      const hL = [pv[0] - (gp[0] - c.position.x), pv[1] - (gp[1] - c.position.y), pv[2] - (gp[2] - c.position.z)];
      const f = st0.rod.dir; // rod direction (the rig has no yaw here)
      let r = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; // f x up
      let rl = Math.hypot(r[0], r[1], r[2]); r = r.map((v) => v / rl);
      let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]; // right x f
      rl = Math.hypot(u[0], u[1], u[2]); u = u.map((v) => v / rl);
      const step = -2 * Math.PI * ${rps} * ${FRAME_S}; // (the angle runs from the rod's forward axis toward its up)
      const at = (a) => { const k = Math.cos(a) * ${radius}, m = Math.sin(a) * ${radius}; return [hL[0] + k * f[0] + m * u[0], hL[1] + k * f[1] + m * u[1], hL[2] + k * f[2] + m * u[2]]; };
      // the hand glides onto the handle (4 frames) and rests there (6 frames) before it starts turning, so neither a
      // jump nor the reach itself reads as a turn
      const p0 = [c.position.x, c.position.y, c.position.z], s0 = at(0), LEAD = 10;
      let a = 0, i = 0, j = 0; const out = [];
      dx.everyFrame(() => {
        if (j < LEAD) {
          const w = Math.min(1, ++j / 4);
          c.position.set(p0[0] + (s0[0] - p0[0]) * w, p0[1] + (s0[1] - p0[1]) * w, p0[2] + (s0[2] - p0[2]) * w);
          return true;
        }
        const st = dx.status();
        if (i > 0) out.push({ rps: st.reel.crank.revPerSec, active: st.reel.crank.active, near: st.reel.crank.near, d: st.reel.crank.distanceM, speed01: st.reel.crank.speed01, reel: st.reelSpeed01 });
        if (i++ >= ${frames}) { res(out); return false; }
        a += step;
        const q = at(a);
        c.position.set(q[0], q[1], q[2]);
        return true;
      });
    })`);

  // Set the hook the moment a bite opens, from the frame hook (a forced bite holds the bait for well under a second of
  // game time, and a software frame can take seconds): wait for STRIKE, hold up to `holdFrames` frames (or until
  // strikeGo() after the STRIKE screenshot), then play `steps` one per frame on `hand` ({ pitch, yaw, pos } poses and /
  // or { btn: [id, value] } presses). Returns { promise, seen(), go() }.
  function strikeThen(hand, steps, { holdFrames = 10 } = {}) {
    const promise = g(`new Promise((res) => {
      const c = window.__xrDevice.controllers.${hand}, dx = window.__game.debug.xr, steps = ${JSON.stringify(steps)};
      window.__strike = { seen: false, go: false };
      let phase = 'wait', seenAt = 0, i = 0; const out = [];
      dx.everyFrame((n) => {
        const st = dx.status();
        if (phase === 'wait') {
          if (st.state !== 'strike') return true;
          phase = 'hold'; seenAt = n; window.__strike.seen = true;
          out.push({ n, state: st.state, t: window.__game.frame.time, haptics: st.haptics.recent.map((p) => p.role + ':' + p.kind) });
        }
        if (phase === 'hold') {
          if (!window.__strike.go && n - seenAt < ${holdFrames}) return true;
          phase = 'play';
        } else out.push({ n, state: st.state, tipUpBack: st.hookMetric.tipUpBack, pitchRate: st.hookMetric.pitchRate, haptics: st.haptics.recent.slice(-3).map((p) => p.role + ':' + p.kind) });
        if (i >= steps.length) { res(out); return false; }
        const s = steps[i++];
        if (s.pos) {
          const p = s.pitch * Math.PI / 360, y = (s.yaw || 0) * Math.PI / 360;
          c.quaternion.set(Math.cos(y) * Math.sin(p), Math.sin(y) * Math.cos(p), -Math.sin(y) * Math.sin(p), Math.cos(y) * Math.cos(p));
          c.position.set(s.pos[0], s.pos[1], s.pos[2]);
        }
        if (s.btn) c.updateButtonValue(s.btn[0], s.btn[1]);
        return true;
      });
    })`);
    return {
      promise,
      seen: () => g('!!(window.__strike && window.__strike.seen)'),
      go: () => g('(() => { if (window.__strike) window.__strike.go = true; return true; })()'),
    };
  }

  // Point a controller's ray at a VR panel button (from where the controller is), check the hover, pull its trigger.
  let rodHand = 'right';
  const reelHand = () => (rodHand === 'right' ? 'left' : 'right');
  const roleOf = (hand) => (hand === rodHand ? 'rod' : 'reel');
  async function aim(hand, panel, id) {
    const t = await g(`window.__game.debug.xr.panelTarget('${panel}', '${id}')`);
    if (!t) throw new Error(`VR panel button ${panel}/${id} is not up`);
    const c = await g(`(() => { const c = window.__xrDevice.controllers.${hand}; return [c.position.x, c.position.y, c.position.z]; })()`);
    const d = [t.local[0] - c[0], t.local[1] - c[1], t.local[2] - c[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const pitch = Math.asin(d[1] / len) / DEG;
    const yaw = Math.atan2(-d[0], -d[2]) / DEG;
    await ctl(hand, `c.quaternion.set(${qOf(pitch, yaw).join(',')})`);
    await xf(2);
    const s = await xs();
    const hv = s.ui && s.ui.hover[roleOf(hand)];
    if (!hv || hv.button !== id) throw new Error(`the ${hand} ray does not hover ${panel}/${id} (${JSON.stringify(s.ui && s.ui.hover)})`);
    return s;
  }
  async function press(hand, panel, id) {
    await aim(hand, panel, id);
    await button(hand, 'trigger', 1);
    await xf(1);
    await button(hand, 'trigger', 0);
    await xf(2);
    return xs();
  }

  // resting poses: rod up ~45 deg out over the water (the ray level), the reel hand beside the reel
  const REST = { rod: { pitch: 0, pos: [0.2, 1.3, -0.35] }, reel: { pitch: -10, pos: [-0.13, 1.24, -0.32] } };
  const restHands = async () => {
    const side = rodHand === 'right' ? 1 : -1;
    await pose(rodHand, REST.rod.pitch, [side * REST.rod.pos[0], REST.rod.pos[1], REST.rod.pos[2]]);
    await pose(reelHand(), REST.reel.pitch, [side * REST.reel.pos[0], REST.reel.pos[1], REST.reel.pos[2]]);
  };
  // both hands glide to the resting poses over `frames` XR frames (a one-frame jump of the rod hand would jerk the tip
  // and fling the hanging rig for a moment, as a real 10 deg wrist flick in 1/20 s would)
  const glideRest = (frames = 6) => {
    const side = rodHand === 'right' ? 1 : -1;
    const tgt = {
      [rodHand]: { q: qOf(REST.rod.pitch), p: [side * REST.rod.pos[0], REST.rod.pos[1], REST.rod.pos[2]] },
      [reelHand()]: { q: qOf(REST.reel.pitch), p: [side * REST.reel.pos[0], REST.reel.pos[1], REST.reel.pos[2]] },
    };
    return g(`new Promise((res) => {
      const d = window.__xrDevice, dx = window.__game.debug.xr, tgt = ${JSON.stringify(tgt)}, n = ${frames};
      const from = {}; for (const h of Object.keys(tgt)) { const c = d.controllers[h]; from[h] = { q: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w], p: [c.position.x, c.position.y, c.position.z] }; }
      let i = 0;
      dx.everyFrame(() => {
        i++; const u = Math.min(1, i / n), e = u * u * (3 - 2 * u);
        for (const h of Object.keys(tgt)) {
          const c = d.controllers[h], f = from[h], t = tgt[h];
          c.position.set(f.p[0] + (t.p[0] - f.p[0]) * e, f.p[1] + (t.p[1] - f.p[1]) * e, f.p[2] + (t.p[2] - f.p[2]) * e);
          // (normalized lerp of the orientation, the short way round)
          const sg = f.q[0] * t.q[0] + f.q[1] * t.q[1] + f.q[2] * t.q[2] + f.q[3] * t.q[3] < 0 ? -1 : 1;
          const q = [0, 1, 2, 3].map((k) => f.q[k] * (1 - e) + sg * t.q[k] * e);
          const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
          c.quaternion.set(q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql);
        }
        if (i >= n) { res(true); return false; }
        return true;
      });
    })`);
  };
  // back to READY with the rig home (no reeling needed): re-tie the current lure
  const resetToReady = async () => {
    const id = (await L.stats()).lure.id;
    await dbg(`setLure('${id}')`);
    await xf(2);
  };

  // Casts are played at 25 ms steps (debug.setFixedDt(0.025) for the gesture, back to 50 ms after): a fast stroke then
  // still has enough poses for the rod to load and whip through as it would at a headset's 72-90 Hz.
  const CAST_DT = 0.025;
  const castSteps = (s) => Math.max(1, Math.round(s / CAST_DT));
  // A forward overhead stroke of the rod controller with the trigger held, let go as the ray passes `releasePitch`
  // (the rod ~55 deg up, as the tip whips through). The wrist accelerates through the stroke (a real cast does; a
  // stroke starting at full speed would load the rod with a huge acceleration spike and leave it ringing) and peaks at
  // `peakDegPerS` at the release. yawDeg: the swing's bearing (+ left); hand: the rod hand. Resolves with the cast.
  async function swingCast({ peakDegPerS, yawDeg = 0, hand = rodHand, releasePitch = 10, label = '' }) {
    const side = hand === 'right' ? 1 : -1;
    const fx = -Math.sin(yawDeg * DEG);
    const fz = -Math.cos(yawDeg * DEG);
    const base = [side * 0.22 * Math.cos(yawDeg * DEG), 1.62, 0];
    const at = (fwd, down) => [+(base[0] + fx * fwd).toFixed(4), +(base[1] - down).toFixed(4), +(base[2] + fz * fwd).toFixed(4)];
    await dbg(`setFixedDt(${CAST_DT})`);
    // wind up: a backswing from the resting pose over 0.4 s (a pose jump would load the rod with a huge acceleration
    // spike and leave it ringing), the rod back over the shoulder (~105 deg up, ray 60 deg up, 25 cm ahead of the
    // shoulder), then the trigger pulled (finger on the line, bail open) and a pause while the rod settles
    const r0 = { pitch: REST.rod.pitch, pos: [side * REST.rod.pos[0], REST.rod.pos[1], REST.rod.pos[2]] };
    const top = 60;
    const r1 = { pitch: top, pos: at(0.25, 0) };
    const back = [];
    const nb = castSteps(0.4);
    for (let i = 1; i <= nb; i++) {
      const u = i / nb;
      const e = u * u * (3 - 2 * u);
      const mix = (a, b) => +(a + (b - a) * e).toFixed(4);
      back.push({ pitch: mix(r0.pitch, r1.pitch), yaw: +(yawDeg * e).toFixed(3), pos: [0, 1, 2].map((k) => mix(r0.pos[k], r1.pos[k])) });
    }
    for (let i = 0; i < castSteps(0.2); i++) back.push({ ...r1, yaw: yawDeg });
    back.push({ ...r1, yaw: yawDeg, trigger: 1 });
    for (let i = 0; i < castSteps(0.4); i++) back.push({ ...r1, yaw: yawDeg });
    await drive(hand, back);
    const s0 = await xs();
    assert(s0.state === 'charging' && s0.rod.triggerHeld, `${label}: rod trigger held in READY -> CHARGING, bail open (${s0.state})`);
    // the stroke: pitch(t) = top - arc (1 - cos(pi t / 2T)), whose angular speed rises from 0 to its peak
    // (arc pi / 2T) at t = T, where the ray passes releasePitch; then 2 more steps at the peak speed
    const arc = top - releasePitch;
    const Tst = (arc * Math.PI) / (2 * peakDegPerS);
    const n = castSteps(Tst);
    const steps = [];
    const put = (p, trigger) => {
      const k = (top - p) / 10; // tens of degrees swept
      const st = { pitch: +p.toFixed(3), yaw: yawDeg, pos: at(0.25 + 0.04 * k, 0.015 * k) };
      if (trigger != null) st.trigger = trigger;
      steps.push(st);
    };
    for (let i = 1; i <= n; i++) put(top - arc * (1 - Math.cos((Math.PI / 2) * (i / n))), i === n ? 0 : null);
    for (let i = 1; i <= 2; i++) put(releasePitch - peakDegPerS * CAST_DT * i);
    const trace = await drive(hand, steps);
    const s = await xs();
    await dbg('setFixedDt(0.05)');
    log(T(), `${label} swing`, JSON.stringify(trace.map((x) => [x.state[0] + x.state[1], x.tipSpeed, x.trigger])));
    log(T(), `${label} cast`, JSON.stringify(s.lastCast), s.state);
    return s.lastCast;
  }
  // A sweep of the rod about the hand from `from` to `to` ({ pitch, yaw } of the ray) at a constant rate over `secs`
  // seconds, the trigger let go at `releaseFrac` of it (after a backswing into `from` and a settle, as swingCast
  // does). The head looks straight out (yaw 0). Resolves with the cast the game made.
  async function sweepCast({ from, to, secs, releaseFrac, pos, label }) {
    await dbg(`setFixedDt(${CAST_DT})`);
    const r0 = { pitch: REST.rod.pitch, pos: [REST.rod.pos[0], REST.rod.pos[1], REST.rod.pos[2]] };
    const back = [];
    const nb = castSteps(0.4);
    for (let i = 1; i <= nb; i++) {
      const u = i / nb;
      const e = u * u * (3 - 2 * u);
      const mix = (a, b) => +(a + (b - a) * e).toFixed(4);
      back.push({ pitch: mix(r0.pitch, from.pitch), yaw: mix(0, from.yaw), pos: [0, 1, 2].map((k) => mix(r0.pos[k], pos[k])) });
    }
    for (let i = 0; i < castSteps(0.2); i++) back.push({ ...from, pos });
    back.push({ ...from, pos, trigger: 1 });
    for (let i = 0; i < castSteps(0.4); i++) back.push({ ...from, pos });
    await drive(rodHand, back);
    const steps = [];
    const frames = castSteps(secs);
    const releaseAt = Math.round(frames * releaseFrac);
    for (let i = 1; i <= frames; i++) {
      const u = i / frames;
      const st = { pitch: +(from.pitch + (to.pitch - from.pitch) * u).toFixed(3), yaw: +(from.yaw + (to.yaw - from.yaw) * u).toFixed(3), pos };
      if (i === releaseAt) st.trigger = 0;
      steps.push(st);
    }
    const trace = await drive(rodHand, steps);
    const s1 = await xs();
    await dbg('setFixedDt(0.05)');
    log(T(), `${label} sweep`, JSON.stringify(trace.map((x) => [x.state[0] + x.state[1], x.tipSpeed, x.trigger])));
    log(T(), `${label} cast`, JSON.stringify(s1.lastCast), s1.state);
    return s1.lastCast;
  }
  const waitLanded = async () => {
    await dbg('setTimeScale(4)');
    const s = await L.waitState(['waiting', 'ready'], { gameS: 30 });
    await dbg('setTimeScale(1)');
    return s;
  };
  const bearingDeg = (p) => Math.atan2(p[0], -p[2]) / DEG; // + = right of the lake axis

  // ------------------------------------------------------------------ title -> Enter VR -> READY in the headset
  await L.waitStartEnabled();
  log(T(), 'lake ready');
  // every rendered frame is exactly 50 ms of game time (an emulated XR frame can come early), so the scripted gestures
  // (one pose per frame) have exact speeds
  assert((await dbg('setFixedDt(0.05)')) === 0.05, 'fixed 50 ms game step per frame');
  assert((await g('window.__game.debug.xr.available()')) === true, 'VR available (IWER Quest 3 as navigator.xr)');
  const vrBtn = await page.evaluate(() => {
    const b = document.getElementById('btn-vr');
    return b ? { visible: !b.hidden && b.offsetParent !== null, disabled: b.disabled, text: b.textContent.trim() } : null;
  });
  assert(vrBtn && vrBtn.visible && !vrBtn.disabled && /enter vr/i.test(vrBtn.text), `the title shows an enabled Enter VR button (${JSON.stringify(vrBtn)})`);
  const desk0 = await L.stats();
  log(T(), 'desktop quality before VR', desk0.quality, 'auto', desk0.autoQuality, 'pixel ratio', desk0.pixelRatio);
  await h.shot('00-title');

  await L.click('#btn-vr');
  await L.waitWall(presenting, { label: 'presenting', every: 500 });
  await restHands();
  await xf(3);
  let s = await xs();
  log(T(), 'in VR', JSON.stringify({ ref: s.referenceSpace, profile: s.profile, fb: s.framebufferScale, fov: s.foveation, rig: s.rig, head: s.head, state: s.state, quality: s.quality, tackleXR: s.tackleXR }));
  assert(s.presenting && s.referenceSpace === 'local-floor', 'the real Enter VR button: presenting on a local-floor reference space');
  assert(s.state === 'ready' && !s.paused, 'entering VR from the title starts the game (READY)');
  assert(s.rig.cameraInRig && Math.abs(s.rig.position[1] - 0.55) < 0.01, 'the camera is in the rig, which stands on the deck');
  assert(Math.abs(s.head.position[0]) < 0.05 && Math.abs(s.head.position[2]) < 0.05, 'the head starts over the dock end');
  assert(s.hands.right.connected && s.hands.left.connected && s.tackleXR && s.hud, 'both controllers tracked, the rod in the hand, the VR HUD up');
  assert(s.profile === 'low' && s.framebufferScale === 0.75 && s.foveation === 1 && s.quality === 'low', 'standalone headset: XR profile low (framebuffer 0.75, foveation 1, scene low)');
  assert(s.targetFps === 72, `the low profile asks the headset for 72 Hz (the Quest 3 default is 90; now ${s.targetFps})`);
  assert(desk0.quality === 'low', `a Quest's 2D page builds the lake at 'low' (the headset profile's level; ${desk0.quality})`);
  assert(/right trigger/.test((s.ui && s.ui.prompt) || ''), `the READY prompt names the hand (${s.ui && s.ui.prompt})`);
  const audio0 = await g('(() => { const a = window.__game.debug.modules().audio; return { started: a.started, state: a.context && a.context.state }; })()');
  assert(audio0.started && audio0.state === 'running', `audio started from the Enter VR click (${JSON.stringify(audio0)})`);
  let ui = await pageUI();
  assert(ui.inert && ui.xr && ui.note && !ui.title, `the page UI behind the headset is inert with a "playing in VR" note (${JSON.stringify(ui)})`);
  const nodesVR1 = await xrNodes();
  log(T(), 'xr objects in the scene', JSON.stringify(nodesVR1));
  await stereoShot('01-vr-ready-stereo');

  // ------------------------------------------------------------------ lures: reel-hand X (next) / Y (previous)
  if (want('lures')) {
    log(T(), 'lures');
    const seen = [(await L.stats()).lure.id];
    for (let i = 0; i < 4; i++) {
      await tap(reelHand(), 'x-button');
      seen.push((await L.stats()).lure.id);
    }
    log(T(), 'X cycle', seen.join(' > '));
    assert(new Set(seen.slice(0, 4)).size === 4 && seen[4] === seen[0], `reel-hand X steps through all four lures and wraps (${seen.join(', ')})`);
    await tap(reelHand(), 'x-button');
    await tap(reelHand(), 'x-button');
    const two = (await L.stats()).lure.id;
    await tap(reelHand(), 'y-button');
    const back = (await L.stats()).lure.id;
    assert(two === seen[2] && back === seen[1], `reel-hand Y steps back (${two} -> ${back})`);
    const tackleLure = await g('window.__game.debug.modules().tackle.getLure().id');
    assert(tackleLure === back, 'the tackle ties on the picked lure');
    s = await xs();
    assert(s.settings.lureId === back, 'the game setting follows');
    await monoShot('02-vr-lure-spinner');
    await tap(reelHand(), 'y-button'); // back to the worm & float
    assert((await L.stats()).lure.id === 'bobber', 'Y again: back to the worm & float');
  }

  // ------------------------------------------------------------------ casts: swing speed -> power, bearing -> direction
  let lastCastLanded = null;
  if (want('casts')) {
    log(T(), 'casts');
    const casts = {};
    // peak wrist speeds 100, 220 and 520 deg/s: a gentle flip, a relaxed swing, a hard one (XR.md cast mapping)
    for (const [name, spec] of [
      ['low', { peakDegPerS: 100 }],
      ['medium', { peakDegPerS: 220 }],
      ['high', { peakDegPerS: 520 }],
      ['left', { peakDegPerS: 220, yawDeg: 25 }],
      ['right', { peakDegPerS: 220, yawDeg: -25 }],
    ]) {
      const c = await swingCast({ ...spec, label: name });
      assert(c && !c.behind && !c.lob, `${name}: a real cast from the swing (not a lob, not behind)`);
      if (name === 'high') await stereoShot('03-vr-cast-high-stereo');
      const landed = await waitLanded();
      const fl = landed.lure.bobber || landed.lure.position;
      const dist = Math.hypot(fl[0], fl[2]);
      casts[name] = { ...c, dist: +dist.toFixed(1), bearing: +bearingDeg(fl).toFixed(1) };
      log(T(), name, JSON.stringify(casts[name]));
      assert(landed.lure.state === 'water', `${name}: the rig lands on the water (${dist.toFixed(1)} m out, bearing ${casts[name].bearing} deg)`);
      await resetToReady();
      await restHands();
      await xf(1);
    }
    const { low, medium, high, left, right } = casts;
    assert(low.power01 < medium.power01 && medium.power01 < high.power01, `power grows with the swing speed (${low.power01} < ${medium.power01} < ${high.power01})`);
    assert(low.power01 <= 0.2 && medium.power01 >= 0.2 && medium.power01 <= 0.5 && high.power01 >= 0.5, `gentle swing short, relaxed swing mid-range, hard swing long (${low.power01}, ${medium.power01}, ${high.power01})`);
    assert(low.dist < medium.dist && medium.dist < high.dist, `distance follows (${low.dist} < ${medium.dist} < ${high.dist} m)`);
    for (const c of [low, medium, high]) assert(Math.abs(c.yawDeg) < 8 && Math.abs(c.bearing) < 10, `straight swing -> straight out (${c.yawDeg} deg, landed at ${c.bearing} deg)`);
    assert(left.yawDeg < -12 && left.bearing < -10, `swing to the left -> cast left (${left.yawDeg} deg, landed at ${left.bearing} deg)`);
    assert(right.yawDeg > 12 && right.bearing > 10, `swing to the right -> cast right (${right.yawDeg} deg, landed at ${right.bearing} deg)`);
    for (const c of Object.values(casts)) {
      // launch pitch = the higher of the tip's path and the rod's elevation less 25 deg (XR.md), near the desktop's ~30
      const want = Math.min(55, Math.max(8, c.tipElevDeg, c.rodDeg - 25));
      assert(c.pitchDeg >= 15 && c.pitchDeg <= 40 && Math.abs(c.pitchDeg - want) < 0.6, `overhead cast let go with the rod ${c.rodDeg} deg up: launched at ${c.pitchDeg} deg (the tip itself moving ${c.tipElevDeg} deg)`);
    }

    // a flat sidearm sweep (the rod ~20 deg up, 400 deg/s from the right across the front, let go with it pointing
    // ahead) and a three-quarter one (the swing plane tilted ~45 deg): without a rod load to time the release by, the
    // lure would fly off along the tip's sideways path (70+ deg left); it goes mostly where the player looks
    for (const [label, spec] of [
      ['sidearm', { from: { pitch: -25, yaw: -100 }, to: { pitch: -25, yaw: 40 }, secs: 0.35, releaseFrac: 5 / 7, pos: [0.28, 1.2, -0.12] }],
      ['three-quarter', { from: { pitch: 45, yaw: -60 }, to: { pitch: -25, yaw: 30 }, secs: 0.35, releaseFrac: 5 / 7, pos: [0.25, 1.4, -0.1] }],
    ]) {
      const c = await sweepCast({ ...spec, label });
      assert(c && !c.behind && !c.lob, `${label}: a real cast (not a lob, not behind)`);
      assert(Math.abs(c.yawDeg) < (label === 'sidearm' ? 35 : 40), `${label} let go with the rod pointing ahead: the cast goes roughly where the player looks (${c.yawDeg} deg off)`);
      const landed = await waitLanded();
      const fl = landed.lure.bobber || landed.lure.position;
      log(T(), label, JSON.stringify({ ...c, dist: +Math.hypot(fl[0], fl[2]).toFixed(1), bearing: +bearingDeg(fl).toFixed(1) }));
      assert(landed.lure.state === 'water', `${label}: the rig lands on the water (bearing ${bearingDeg(fl).toFixed(1)} deg)`);
      await resetToReady();
      await restHands();
      await xf(1);
    }

    // turned around toward the shore: a swing over the dock is not a cast
    const behind = await swingCast({ peakDegPerS: 220, yawDeg: 180, label: 'behind' });
    await xf(1);
    s = await xs();
    assert(behind && behind.behind && s.state === 'ready', `a cast toward the shore behind is refused, back to READY (${behind && behind.yawDeg} deg)`);
    assert((await g('window.__game.debug.modules().tackle.getLure().state')) === 'home', 'the rig stays home');
    await restHands();
    await xf(1);
    lastCastLanded = casts;
  }

  // ------------------------------------------------------------------ reel: analog trigger, crank gesture
  if (want('reel')) {
    log(T(), 'reel');
    const c = await swingCast({ peakDegPerS: 220, label: 'reel-test' });
    assert(c && !c.lob, 'cast out for the retrieve');
    await waitLanded();
    await restHands();
    await xf(2);
    const lineAt = async () => (await L.stats()).lineOutM;
    const R = reelHand();
    // dead zone
    await button(R, 'trigger', 0.05);
    await xf(4);
    s = await xs();
    let st = await L.stats();
    assert(!st.input.reeling && s.reel.trigger01 === 0, `reel trigger 0.05: inside the dead zone, no retrieve (${s.reel.trigger01})`);
    // analog levels
    const lv = {};
    for (const v of [0.3, 0.6, 1]) {
      const lo0 = await lineAt();
      await button(R, 'trigger', v);
      await xf(6);
      st = await L.stats();
      s = await xs();
      lv[v] = { trigger01: s.reel.trigger01, speed: +st.input.reelSpeed01.toFixed(2), in: +(lo0 - st.lineOutM).toFixed(2) };
      const expect = (v - 0.08) / 0.92;
      assert(st.input.reeling && Math.abs(st.input.reelSpeed01 - expect) < 0.08, `reel trigger ${v}: analog retrieve ${st.input.reelSpeed01.toFixed(2)} (expected ${expect.toFixed(2)})`);
      assert(st.lineOutM < lo0, `line comes in (${lo0} -> ${st.lineOutM} m)`);
    }
    log(T(), 'analog', JSON.stringify(lv));
    assert(lv[0.3].in < lv[0.6].in && lv[0.6].in < lv[1].in, 'more trigger, faster retrieve');
    await button(R, 'trigger', 0);
    await xf(3);
    await monoShot('04-vr-retrieve');
    // the reel hand on the reel handle (as the prompts ask: "or turn the reel"), the head looking at the wrist gauge:
    // the rod's handle and the rod glove do not hide it (it sits back along the forearm)
    {
      const st0 = await xs();
      const hl = await g(`window.__game.debug.xr.toRig([${st0.reel.crank.handle.join(',')}])`);
      await pose(R, -10, [hl[0] - 0.004, hl[1] + 0.016, hl[2] - 0.05]);
      await xf(3);
      const wp = await g("(() => { let o = null; window.__game.debug.modules().scene.traverse((x) => { if (x.name === 'xr-wrist' && !o) o = x; }); o.updateWorldMatrix(true, false); return window.__game.debug.xr.toRig([o.matrixWorld.elements[12], o.matrixWorld.elements[13], o.matrixWorld.elements[14]]); })()");
      const dv = [wp[0], wp[1] - 1.6, wp[2]];
      const dl = Math.hypot(dv[0], dv[1], dv[2]);
      await headPose([0, 1.6, 0], Math.asin(dv[1] / dl) / DEG, Math.atan2(-dv[0], -dv[2]) / DEG);
      await xf(3);
      const wocc = await g(`(() => {
        const m = window.__game.debug.modules(); let o = null; m.scene.traverse((x) => { if (x.name === 'xr-wrist' && !o) o = x; });
        if (!o || !o.visible) return { shown: false };
        const P = o.userData.panel, cam = m.camera, V = cam.position.constructor; cam.updateMatrixWorld(true); o.updateWorldMatrix(true, false);
        const eye = new V().setFromMatrixPosition(cam.matrixWorld), base = m.tackle.getRodBase(new V()), d = window.__game.debug.xr.status().rod.dir, D = new V(d[0], d[1], d[2]);
        const inv = o.matrixWorld.clone().invert(), eL = eye.clone().applyMatrix4(inv); let n = 0;
        for (let i = 0; i <= 60; i++) {
          const p = base.clone().addScaledVector(D, -0.375 + 2.13 * i / 60).applyMatrix4(inv);
          if (!(p.z > 0 && eL.z > p.z)) continue;
          const t = eL.z / (eL.z - p.z), x = eL.x + (p.x - eL.x) * t, y = eL.y + (p.y - eL.y) * t;
          if (Math.abs(x) <= P.widthM / 2 + 0.01 && Math.abs(y) <= P.heightM / 2 + 0.01) n++;
        }
        return { shown: true, occludedSamples: n, dist: +new V().setFromMatrixPosition(o.matrixWorld).distanceTo(eye).toFixed(2) };
      })()`);
      log(T(), 'wrist gauge, reel hand on the handle', JSON.stringify(wocc));
      assert(wocc.shown && wocc.occludedSamples === 0, `reel hand on the reel handle: the rod does not cross the wrist gauge (${wocc.occludedSamples} rod samples over it)`);
      await monoShot('04b-vr-wrist-hand-on-reel');
      await headPose([0, 1.6, 0], 0, 0);
      await restHands();
      await xf(2);
    }
    // turning the reel for real
    const turns = {};
    for (const [rps, frames] of [[1.0, 26], [1.5, 26], [0.3, 30], [-1.0, 26]]) {
      const lo0 = await lineAt();
      const tr = await crank(R, rps, frames);
      const tail = tr.slice(-8);
      const avg = (k) => tail.reduce((a, x) => a + (typeof x[k] === 'boolean' ? (x[k] ? 1 : 0) : x[k]), 0) / tail.length;
      const lo1 = await lineAt();
      turns[rps] = { rps: +avg('rps').toFixed(2), active: avg('active'), near: avg('near'), d: +avg('d').toFixed(2), speed01: +avg('speed01').toFixed(2), reel: +avg('reel').toFixed(2), in: +(lo0 - lo1).toFixed(2), lock: await g('window.__game.debug.modules().tackle.debug.xr.crankLock') };
      log(T(), `crank ${rps} rev/s`, JSON.stringify(turns[rps]));
      await restHands();
      await xf(4);
    }
    const mPerTurn = 0.78 / 1.5;
    assert(turns[1].near === 1 && turns[1].active === 1 && Math.abs(turns[1].rps - 1) < 0.2, `hand circling the reel handle at 1 rev/s: the crank is read (${turns[1].rps} rev/s, ${turns[1].d} m from the handle)`);
    assert(Math.abs(turns[1].speed01 - (1 * mPerTurn) / 0.78) < 0.12 && turns[1].in > 0.3, `... and reels ${mPerTurn.toFixed(2)} m per turn (speed ${turns[1].speed01}, ${turns[1].in} m in)`);
    assert(turns[1.5].active === 1 && turns[1.5].speed01 > 0.9 && turns[1.5].in > turns[1].in, `1.5 rev/s: full retrieve (${turns[1.5].speed01}, ${turns[1.5].in} m in)`);
    assert(turns[0.3].active === 0 && turns[0.3].reel === 0, `0.3 rev/s is below the 0.5 rev/s threshold: no retrieve (${turns[0.3].rps} rev/s)`);
    assert(turns[-1].active === 0 && turns[-1].reel === 0 && turns[-1].in < 0.05, `circling the handle backward is anti-reverse: no retrieve (${JSON.stringify(turns[-1])})`);
    assert(turns[1].lock && turns[1.5].lock && !turns[-1].lock, `the drawn reel handle follows the hand cranking forward, not backward (locked: ${turns[1].lock}, ${turns[1.5].lock}, ${turns[-1].lock})`);
    // the larger of trigger and crank wins
    await button(R, 'trigger', 0.3);
    const both = await crank(R, 1.0, 20);
    const tailB = both.slice(-6);
    const reelB = tailB.reduce((a, x) => a + x.reel, 0) / tailB.length;
    assert(reelB > 0.5, `trigger 0.3 + crank 1 rev/s: the crank's speed wins (${reelB.toFixed(2)})`);
    await button(R, 'trigger', 0);
    await restHands();
    await xf(2);
  }

  // ------------------------------------------------------------------ catch 1: flick hookset, fight with the real rod, keep with A
  async function fightToCaught({ label, checks = false }) {
    const R = reelHand();
    await dbg('setTimeScale(8)');
    const t0 = (await L.stats()).time;
    let maxT = 0;
    let s1 = await L.stats();
    let probed = !checks;
    for (;;) {
      s1 = await L.stats();
      if (s1.state !== 'fighting') break;
      if (s1.time - t0 > 400) throw new Error(`${label}: fight took too long`);
      maxT = Math.max(maxT, s1.tensionN);
      if (!probed && s1.time - t0 > 1.5) {
        probed = true;
        await button(R, 'trigger', 0);
        await dbg('setTimeScale(1)');
        await rodChecks();
        await dbg('setTimeScale(8)');
      }
      const reel = !(s1.slipMps > 0.15 || s1.tensionN > s1.dragN * 0.95);
      await button(R, 'trigger', reel ? 1 : 0);
      await xf(1);
    }
    await button(R, 'trigger', 0);
    await dbg('setTimeScale(1)');
    log(T(), `${label}: fight over`, s1.state, 'max tension', maxT.toFixed(1));
    return L.waitState('caught', { gameS: 30 });
  }

  // rod lift / side from the real rod pose, the page losing focus, a resize and the headset's system menu mid-fight
  async function rodChecks() {
    const st = await L.stats();
    const bear = bearingDeg(st.hooked.position); // + = right
    const side = rodHand === 'right' ? 1 : -1;
    const at = [side * 0.2, 1.2, -0.35];
    // rod high (~65 deg), then low (~15 deg), pointing at the fish
    await pose(rodHand, 20, at, -bear);
    await xf(6);
    let x = await xs();
    const high = x.rodLift01;
    await pose(rodHand, -30, at, -bear);
    await xf(6);
    x = await xs();
    const low = x.rodLift01;
    assert(high > 0.85 && low < 0.4, `rod lift from the rod's elevation (high ${high}, low ${low})`);
    // swept right / left of the line
    await pose(rodHand, 0, at, -bear - 50);
    await xf(6);
    const sr = (await xs()).rodSide;
    await pose(rodHand, 0, at, -bear + 50);
    await xf(6);
    const sl = (await xs()).rodSide;
    assert(sr > 0.3 && sl < -0.3, `side pressure from the rod's sweep (right ${sr}, left ${sl})`);
    await pose(rodHand, 10, at, -bear);
    await xf(2);
    await stereoShot('06-vr-fight-stereo');

    // the 2D page loses focus / is hidden (the headset took over) and the window resizes: nothing pauses
    const size0 = await g('(() => { const r = window.__game.debug.modules().renderer; return [r.domElement.width, r.domElement.height]; })()');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      window.dispatchEvent(new Event('blur'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('resize'));
    });
    const tA = (await L.stats()).time;
    await xf(4);
    x = await xs();
    const tB = (await L.stats()).time;
    const aud = await g('(() => { const a = window.__game.debug.modules().audio; return a.context && a.context.state; })()');
    const size1 = await g('(() => { const r = window.__game.debug.modules().renderer; return [r.domElement.width, r.domElement.height]; })()');
    assert(!x.paused && x.state === 'fighting' && tB > tA, `page blur + hidden while presenting: the fight goes on (${x.state}, paused ${x.paused})`);
    assert(aud === 'running', `... and the sound keeps playing (${aud})`);
    assert(size1[0] === size0[0] && size1[1] === size0[1] && sizeWarnings.length === 0, `a window resize while presenting leaves the XR drawing buffer alone (${size0} -> ${size1}, ${sizeWarnings.length} warnings)`);
    await page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    // the headset's system menu (session visibility: visible-blurred) pauses the fight into the VR menu
    await dev("d.updateVisibilityState('visible-blurred')");
    await xf(3);
    x = await xs();
    assert(x.paused && x.visibility === 'visible-blurred' && x.ui && x.ui.menuOpen, `headset system menu mid-fight: paused into the VR menu (${x.visibility})`);
    // the rod hand moves while the game is halted (reaching for the menu): the line stays on the rod tip, and the move
    // does not read as a swing on resume
    await pose(rodHand, 30, [at[0], at[1] + 0.15, at[2] + 0.05], -bear);
    await xf(3);
    const gap = await g(`(() => { const t = window.__game.debug.modules().tackle, rod = t.debug.rod, V = rod.object.position.constructor; rod.object.updateWorldMatrix(true, false); const live = rod.tipLocal.clone().applyMatrix4(rod.object.matrixWorld); return { rope0: +t.debug.rope.getPoint(0, new V()).distanceTo(live).toFixed(3), tip: +t.getRodTip(new V()).distanceTo(live).toFixed(3) }; })()`);
    assert(gap.rope0 < 0.02 && gap.tip < 0.02, `paused, rod hand moved 15 cm: the line stays on the rod tip (${JSON.stringify(gap)})`);
    await dev("d.updateVisibilityState('visible')");
    await xf(2);
    await tap(reelHand(), 'thumbstick');
    x = await xs();
    const tv = await g('window.__game.debug.modules().tackle.debug.xr.tipVel.length()');
    assert(!x.paused && !x.ui.menuOpen && x.state === 'fighting', 'reel-stick click: resumed, still fighting');
    // (the rigid blank's tip, from the controller pose: the bent tip-top also jitters under the fish's head shakes)
    assert(x.rod.rigidTipSpeed < 0.5 && x.hookMetric.tipUpBack < 2.2 && tv < 1, `... and the pause-time move is not a swing (rod tip ${x.rod.rigidTipSpeed} m/s, up / back ${x.hookMetric.tipUpBack} m/s, tackle ${tv.toFixed(2)} m/s)`);
    await pose(rodHand, 10, at, -bear);
    await xf(2);
  }

  if (want('catch1')) {
    log(T(), 'catch 1');
    s = await xs();
    if ((await L.stats()).state !== 'waiting') {
      const c = await swingCast({ peakDegPerS: 220, label: 'catch1-cast' });
      assert(c && !c.lob, 'cast out');
      await waitLanded();
    }
    const side = rodHand === 'right' ? 1 : -1;
    await pose(rodHand, 0, [side * 0.2, 1.2, -0.33]);
    await xf(2);
    const tBite = (await L.stats()).time;
    // an upward flick of the rod hand, as soon as the float goes under (after the STRIKE screenshot)
    const flick = strikeThen(rodHand, [
      { pitch: 0, pos: [side * 0.2, 1.2, -0.33] },
      { pitch: 18, pos: [side * 0.2, 1.24, -0.31] },
      { pitch: 42, pos: [side * 0.2, 1.3, -0.27] },
      { pitch: 50, pos: [side * 0.2, 1.33, -0.24] },
      { pitch: 50, pos: [side * 0.2, 1.33, -0.24] },
    ]);
    await dbg("forceBite('bluegill')");
    await dbg('setTimeScale(4)');
    await L.waitWall(flick.seen, { label: 'STRIKE', every: 200 });
    await dbg('setTimeScale(1)');
    await h.shot('05-vr-strike');
    await flick.go();
    const flickTrace = await flick.promise;
    log(T(), 'flick', JSON.stringify(flickTrace));
    log(T(), 'events', JSON.stringify(await dbg(`events(${tBite})`)));
    await xf(1);
    s = await xs();
    assert(flickTrace[0].haptics.includes('rod:bite'), 'the bite: a rod-hand pulse');
    const peak = (k) => Math.max(0, ...flickTrace.filter((e) => e.state === 'strike' || e.state === 'fighting').map((e) => e[k] || 0));
    assert(s.state === 'fighting', `an upward flick of the rod sets the hook (${s.state}; the flick peaked at ${peak('tipUpBack')} m/s up / back, ${peak('pitchRate')} rad/s)`);
    assert(flickTrace.some((e) => e.haptics.includes('rod:hookset')), 'hookset pulse on the rod hand');
    await pose(rodHand, 10, [side * 0.2, 1.2, -0.35]);
    await button(reelHand(), 'trigger', 1); // (reel: the line comes tight; slack line has no rumble)
    await xf(6);
    await button(reelHand(), 'trigger', 0);
    assert((await xs()).haptics.recent.some((p) => p.kind === 'fight'), 'fight rumble on the rod hand');
    const progFight = (await L.stats()).programs;
    await fightToCaught({ label: 'catch 1', checks: true });
    await xf(4);
    // look at the fish in the reel hand
    const rs = rodHand === 'right' ? -1 : 1;
    await headPose([0, 1.6, 0], -12, 0);
    await pose(reelHand(), -5, [rs * 0.1, 1.46, -0.44], rs * -10);
    await xf(6);
    s = await xs();
    const framing = await g('window.__game.debug.modules().showcase.framing');
    log(T(), 'caught', JSON.stringify({ ui: s.ui, framing }));
    assert(s.state === 'caught' && s.ui.catchOpen, 'CAUGHT: the catch card is up in the headset');
    assert(framing && framing.mode === 'xr' && framing.grip && framing.ready && framing.snout, 'the fish is in the reel hand (held by the jaw)');
    const pageCard = await page.evaluate(() => {
      const c = document.getElementById('catch');
      return !!(c && !c.hidden);
    });
    log(T(), 'page card (hidden behind the headset)', pageCard);
    await stereoShot('07-vr-catch-in-hand-stereo');
    // the rod resting out in front, the fish lifted to look at: the rod (seen from the eyes) stays clear of the card
    await pose(rodHand, REST.rod.pitch, [side * REST.rod.pos[0], REST.rod.pos[1], REST.rod.pos[2]]);
    await pose(reelHand(), 0, [rs * 0.12, 1.42, -0.42]);
    await headPose([0, 1.6, 0], -15, 0);
    await xf(10);
    const occ = await g(`(() => {
      const m = window.__game.debug.modules(); let card = null; m.scene.traverse((x) => { if (x.name === 'xr-card' && !card) card = x; });
      if (!card || !card.visible) return { card: false };
      const P = card.userData.panel, cam = m.camera, V = cam.position.constructor; cam.updateMatrixWorld(true); card.updateWorldMatrix(true, false);
      const eye = new V().setFromMatrixPosition(cam.matrixWorld), base = m.tackle.getRodBase(new V()), d = window.__game.debug.xr.status().rod.dir, D = new V(d[0], d[1], d[2]);
      const inv = card.matrixWorld.clone().invert(), eL = eye.clone().applyMatrix4(inv); let n = 0;
      for (let i = 0; i <= 60; i++) {
        const p = base.clone().addScaledVector(D, -0.375 + 2.13 * i / 60).applyMatrix4(inv);
        if (!(p.z > 0 && eL.z > p.z)) continue;
        const t = eL.z / (eL.z - p.z), x = eL.x + (p.x - eL.x) * t, y = eL.y + (p.y - eL.y) * t;
        if (Math.abs(x) <= P.widthM / 2 && Math.abs(y) <= P.heightM / 2) n++;
      }
      return { card: true, occludedSamples: n, cardAt: new V().setFromMatrixPosition(card.matrixWorld).toArray().map((v) => +v.toFixed(2)) };
    })()`);
    log(T(), 'card vs rod', JSON.stringify(occ));
    assert(occ.card && occ.occludedSamples === 0, `the resting rod does not cross the catch card (${occ.occludedSamples} rod samples over it)`);
    await stereoShot('07b-vr-catch-rod-resting-stereo');
    const progCaught = (await L.stats()).programs;
    const n0 = (await dbg('records()')).length;
    await tap(rodHand, rodHand === 'right' ? 'a-button' : 'x-button');
    s = await xs();
    const recs = await dbg('records()');
    const progKept = (await L.stats()).programs;
    assert(progCaught === progFight && progKept === progCaught, `no shader compiles for the fish in the hand, nor released on Keep (${progFight} -> ${progCaught} -> ${progKept})`);
    assert(s.state === 'ready' && !s.ui.catchOpen, `A keeps it: READY, card gone (${s.state})`);
    assert(recs.length === n0 && recs[recs.length - 1].kept === true && recs[recs.length - 1].speciesId === 'bluegill', 'the bluegill is in the log as kept');
    await headPose([0, 1.6, 0], 0, 0);
    await restHands();
    await xf(2);
  }

  // ------------------------------------------------------------------ catch 2: hookset with A, released with B
  if (want('catch2')) {
    log(T(), 'catch 2');
    const c = await swingCast({ peakDegPerS: 220, yawDeg: -15, label: 'catch2-cast' });
    assert(c && !c.lob, 'cast out');
    await waitLanded();
    await restHands();
    await xf(2);
    const key = rodHand === 'right' ? 'a-button' : 'x-button';
    const aPress = strikeThen(rodHand, [{ btn: [key, 1] }, { btn: [key, 0] }, {}], { holdFrames: 2 });
    await dbg("forceBite('yellow_perch')");
    await dbg('setTimeScale(4)');
    await L.waitWall(aPress.seen, { label: 'STRIKE', every: 200 });
    await dbg('setTimeScale(1)');
    const aTrace = await aPress.promise;
    log(T(), 'A press', JSON.stringify(aTrace));
    await xf(1);
    s = await xs();
    assert(aTrace[0].haptics.includes('rod:bite'), 'the bite: a rod-hand pulse');
    assert(s.state === 'fighting', `rod-hand A sets the hook too (${s.state})`);
    await fightToCaught({ label: 'catch 2' });
    await xf(3);
    s = await xs();
    assert(s.state === 'caught' && s.ui.catchOpen, 'second fish: CAUGHT, card up');
    await monoShot('08-vr-catch2');
    const n0 = (await dbg('records()')).length;
    await tap(rodHand, rodHand === 'right' ? 'b-button' : 'y-button');
    s = await xs();
    const recs = await dbg('records()');
    assert(s.state === 'ready' && !s.ui.catchOpen, `B releases it: READY (${s.state})`);
    assert(recs.length === n0 && recs[recs.length - 1].kept === false && recs[recs.length - 1].speciesId === 'yellow_perch', 'the perch is in the log as released');
    assert(!(await g('window.__game.debug.modules().showcase.object')), 'the fish is out of the hand');
  }

  // ------------------------------------------------------------------ strikes: a lure bite with the rod held still; looking down
  if (want('strike')) {
    log(T(), 'strike');
    await headPose([0, 1.6, 0], 0, 0);
    await restHands();
    // (a) spinner: cast, a short retrieve, stop; the bite comes with the rod frozen and no button pressed. Played at
    // 72 Hz steps (the headset's), where the tackle's bite load used to flick the bent tip across for one frame and
    // read as a 6-7 m/s sweep: the hookset reads the rigid blank, and the bend fades out instead of flipping.
    await dbg("setLure('spinner')");
    await xf(2);
    await dbg('setTimeScale(4)');
    await dbg('cast(0.45, 0)');
    await L.waitState('waiting', { gameS: 30 });
    await dbg('setTimeScale(1)');
    await dbg('setFixedDt(1/72)');
    await button(reelHand(), 'trigger', 0.6);
    await xf(30);
    await button(reelHand(), 'trigger', 0);
    await xf(3);
    const t0 = (await L.stats()).time;
    const still = g(`new Promise((res) => {
      const dx = window.__game.debug.xr, rod = window.__game.debug.modules().tackle.debug.rod; let seen = false, n = 0, prev = null, maxJump = 0, peak = 0, frames = 0;
      dx.everyFrame(() => {
        const st = dx.status(); n++;
        const tl = rod.tipLocal.clone();
        if (prev) maxJump = Math.max(maxJump, tl.distanceTo(prev));
        prev = tl;
        if (st.state === 'strike') { seen = true; frames++; peak = Math.max(peak, st.hookMetric.tipUpBack); }
        if ((seen && st.state !== 'strike') || n > 300) { res({ end: st.state, framesInStrike: frames, peakTipUpBack: peak, maxTipJumpM: +maxJump.toFixed(3) }); return false; }
        return true;
      });
    })`);
    await dbg("forceBite('smallmouth_bass')");
    const r = await still;
    const ev = (await dbg(`events(${t0})`)).filter((e) => /^(strike|hooked|fish:bite|fish:missed)$/.test(e.type));
    log(T(), 'spinner bite, rod still', JSON.stringify({ ...r, events: ev }));
    assert(r.framesInStrike > 0 && r.end !== 'fighting' && !ev.some((e) => e.type === 'hooked') && ev.some((e) => e.type === 'fish:missed'), `a lure bite with the rod held still does not set the hook by itself: STRIKE, then the fish lets go (${r.end})`);
    assert(r.maxTipJumpM < 0.1, `the bent tip never jumps more than 0.1 m in a frame under the bite load (${r.maxTipJumpM} m)`);
    await dbg('setFixedDt(0.05)');
    await dbg('setTimeScale(4)');
    await L.waitState(['waiting', 'ready'], { gameS: 20 });
    await dbg('setTimeScale(1)');
    // (b) the float goes under while the player looks down at the wrist gauge (head pitched 50 deg down): the STRIKE cue
    // comes down with the gaze, and the prompt strip keeps saying what to do
    await dbg("setLure('bobber')");
    await xf(2);
    await dbg('setTimeScale(4)');
    await dbg('cast(0.45, 0)');
    await L.waitState('waiting', { gameS: 30 });
    await dbg('setTimeScale(1)');
    await headPose([0, 1.6, 0], -50, 0);
    await xf(2);
    const cue = g(`new Promise((res) => {
      const dx = window.__game.debug.xr, m = window.__game.debug.modules(); let n = 0, strikeObj = null;
      m.scene.traverse((x) => { if (x.name === 'xr-strike' && !strikeObj) strikeObj = x; });
      dx.everyFrame(() => {
        const st = dx.status(); n++;
        if (st.state === 'strike' && st.ui && st.ui.striking) {
          const cam = m.camera, V = cam.position.constructor; cam.updateMatrixWorld(true); strikeObj.updateWorldMatrix(true, false);
          const hp = new V().setFromMatrixPosition(cam.matrixWorld), up = new V(0, 1, 0).transformDirection(cam.matrixWorld);
          const d = new V().setFromMatrixPosition(strikeObj.matrixWorld).sub(hp).normalize();
          res({ aboveCentreDeg: +(Math.asin(Math.max(-1, Math.min(1, d.dot(up)))) * 180 / Math.PI).toFixed(1), prompt: st.ui.prompt });
          return false;
        }
        if (n > 400) { res(null); return false; }
        return true;
      });
    })`);
    await dbg("forceBite('bluegill')");
    const c = await cue;
    log(T(), 'STRIKE looking down', JSON.stringify(c));
    assert(c && Math.abs(c.aboveCentreDeg) < 30, `looking down 50 deg: the STRIKE cue is inside the view (${c && c.aboveCentreDeg} deg above the view centre)`);
    assert(c && /strike/i.test(c.prompt || ''), `... and the prompt strip says it too (${c && c.prompt})`);
    await h.shot('08b-vr-strike-looking-down');
    await headPose([0, 1.6, 0], 0, 0);
    await dbg('setTimeScale(4)');
    await L.waitState(['waiting', 'ready'], { gameS: 20 });
    await dbg('setTimeScale(1)');
    await resetToReady();
    await restHands();
    await xf(2);
  }

  // ------------------------------------------------------------------ the VR menu, rod hand swap, snap turn, Exit VR
  if (want('menu')) {
    log(T(), 'menu');
    await headPose([0, 1.6, 0], 0, 0);
    await restHands();
    await xf(1);
    // a mouse / keyboard at the desk (PC VR): the hidden page's buttons can't be pressed and Space doesn't cast,
    // but Esc reaches the VR menu
    const pb = await page.evaluate(() => {
      const r = document.getElementById('btn-pause').getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    });
    await page.mouse.click(pb[0], pb[1]);
    await page.keyboard.down('Space');
    await xf(2);
    s = await xs();
    const spaceState = s.state;
    await page.keyboard.up('Space');
    await xf(1);
    s = await xs();
    assert(!s.paused && spaceState === 'ready' && s.state === 'ready', `the page's pause button under the mouse and Space do nothing while presenting (${spaceState}, paused ${s.paused})`);
    await page.keyboard.press('Escape');
    await xf(1);
    s = await xs();
    assert(s.paused && s.ui.menuOpen, 'Esc at the keyboard opens the VR menu');
    await page.keyboard.press('Escape');
    await xf(1);
    s = await xs();
    assert(!s.paused && !s.ui.menuOpen && s.state === 'ready', 'Esc again closes it');
    await tap(reelHand(), 'thumbstick');
    s = await xs();
    assert(s.paused && s.ui.menuOpen, 'reel-hand thumbstick click: the VR menu, paused');
    // point the rod hand's ray from in front of the chest
    await pose(rodHand, 0, [0.12, 1.3, -0.25]);
    await xf(1);
    const set0 = s.settings;
    s = await press(rodHand, 'menu', 'time:noon');
    assert(Math.abs(s.settings.hours - 12.5) < 0.05, `time preset Noon (${set0.hours} -> ${s.settings.hours})`);
    const toUnits = set0.units === 'metric' ? 'imperial' : 'metric';
    s = await press(rodHand, 'menu', `units:${toUnits}`);
    assert(s.settings.units === toUnits, `units -> ${toUnits}`);
    s = await press(rodHand, 'menu', 'sound:off');
    const mutedA = await g('window.__game.debug.modules().audio.muted');
    assert(s.settings.muted && mutedA, 'sound off (the audio mutes)');
    await stereoShot('09-vr-menu-stereo');
    s = await press(rodHand, 'menu', 'sound:on');
    assert(!s.settings.muted, 'sound back on');
    s = await press(rodHand, 'menu', 'journal');
    // (the menu stays open underneath: its panel is hidden while the journal page is up, and comes back on Close)
    const panelUp = (panel, id) => g(`!!window.__game.debug.xr.panelTarget('${panel}', '${id}')`);
    assert(s.journalOpen && s.ui.journalOpen && s.paused && !(await panelUp('menu', 'resume')) && (await panelUp('journal', 'close')), 'Journal: the journal page replaces the menu panel');
    await monoShot('10-vr-journal');
    s = await press(rodHand, 'journal', 'close');
    assert(!s.journalOpen && !s.ui.journalOpen && s.ui.menuOpen && s.paused && (await panelUp('menu', 'resume')), 'Close: back to the menu, still paused');
    s = await press(rodHand, 'menu', 'hand:left');
    rodHand = 'left';
    const tk = await g('(() => { const t = window.__game.debug.modules().tackle.debug.xr; return { hand: t.rodHand, mount: t.rodMount.parent && t.rodMount.parent.name }; })()');
    assert(s.rodHand === 'left' && s.settings.rodHand === 'left' && tk.hand === 'left' && tk.mount === 'xr-grip-left', `Rod hand: left (the rod moves to the left grip: ${JSON.stringify(tk)})`);
    s = await press('right', 'menu', 'resume');
    assert(!s.paused && !s.ui.menuOpen && s.state === 'ready', 'Resume');
    await glideRest(6);
    await xf(4);
    await monoShot('11-vr-left-handed');

    // left-handed: the left trigger holds the line; letting go with the rod still drops a short lob (a hold of at
    // least 0.15 s: a quicker tap with the rod still is not a cast)
    await button('left', 'trigger', 1);
    await xf(5);
    s = await xs();
    assert(s.state === 'charging', `left-handed: the left trigger opens the bail (${s.state})`);
    await button('left', 'trigger', 0);
    await xf(1);
    s = await xs();
    assert(s.lastCast && s.lastCast.lob && Math.abs(s.lastCast.power01 - 0.12) < 0.01, `let go with the rod still: a short lob (power ${s.lastCast && s.lastCast.power01})`);
    await waitLanded();
    const lob = await L.stats();
    const lobAt = lob.lure.bobber || lob.lure.position;
    log(T(), 'lob landed', JSON.stringify(lob.lure));
    assert(lob.lure.state === 'water' && Math.hypot(lobAt[0], lobAt[2]) < 9, `the lob lands just off the dock (${Math.hypot(lobAt[0], lobAt[2]).toFixed(1)} m)`);
    // the right hand (now the reel hand) reels
    await button('right', 'trigger', 1);
    await xf(4);
    assert((await L.stats()).input.reeling, 'left-handed: the right trigger reels');
    await button('right', 'trigger', 0);
    await resetToReady();

    // snap turn: the rod-hand (left) thumbstick, 30 deg per flick about the head; drag on the same stick
    const head0 = (await xs()).head.position;
    await flick('left', 1, 0);
    s = await xs();
    assert(Math.abs(s.rig.yawDeg + 30) < 0.5, `rod thumbstick right: snap turn 30 deg right (${s.rig.yawDeg})`);
    assert(Math.hypot(s.head.position[0] - head0[0], s.head.position[2] - head0[2]) < 0.02, 'about the head (it stays put)');
    // the rod tip jumped with the rig: the float rig re-hangs under it instead of being flung
    const hang = await g(`(() => { const t = window.__game.debug.modules().tackle, tip = t.getRodTip(), l = t.getLure(), f = l.bobberPosition || l.position; return { state: l.state, dx: +Math.hypot(f.x - tip.x, f.z - tip.z).toFixed(2), dy: +(f.y - tip.y).toFixed(2) }; })()`);
    assert(hang.state === 'home' && hang.dx < 0.25 && hang.dy < -0.1, `the float still hangs under the rod tip after the turn (${JSON.stringify(hang)})`);
    await monoShot('12-vr-snap-turned');
    // pushed over again and held there for several frames: one more step, not one per frame
    await stick('left', 1, 0);
    await xf(3);
    s = await xs();
    assert(Math.abs(s.rig.yawDeg + 60) < 0.5, `holding the stick over: one step per flick (${s.rig.yawDeg})`);
    await stick('left', 0, 0);
    await xf(1);
    await flick('left', -1, 0);
    await flick('left', -1, 0);
    s = await xs();
    assert(Math.abs(s.rig.yawDeg) < 0.5, `and back, one step per flick to the left (${s.rig.yawDeg})`);
    const d0 = (await L.stats()).dragN;
    await flick('left', 0, -1);
    const d1 = (await L.stats()).dragN;
    assert(d1 > d0 + 1, `rod thumbstick up: one drag step tighter (${d0} -> ${d1} N)`);
    await flick('left', 0, 1);

    // the menu from the new reel hand (right), back to right-handed, Exit VR
    await tap('right', 'thumbstick');
    s = await xs();
    assert(s.paused && s.ui.menuOpen, 'right-hand (reel) thumbstick click opens the menu now');
    await pose('left', 0, [-0.12, 1.3, -0.25]);
    await xf(1);
    s = await press('left', 'menu', 'hand:right');
    rodHand = 'right';
    assert(s.rodHand === 'right' && s.settings.rodHand === 'right', 'Rod hand: right again');
    await pose('right', 0, [0.12, 1.3, -0.25]);
    await xf(1);
    await aim('right', 'menu', 'exit');
    await button('right', 'trigger', 1);
    await xf(1);
    await button('right', 'trigger', 0);
    await L.waitWall(async () => !(await presenting()), { label: 'session end (Exit VR)' });
  }

  // ------------------------------------------------------------------ back on the desktop
  if (want('desktop') && !(await presenting())) {
    log(T(), 'desktop');
    await L.waitFrames(3);
    s = await xs();
    const st = await L.stats();
    const cam = await g('(() => { const m = window.__game.debug.modules(); return { parent: m.camera.parent === m.scene, pos: m.camera.position.toArray().map((v) => +v.toFixed(2)), fov: m.camera.fov }; })()');
    ui = await pageUI();
    log(T(), 'after Exit VR', JSON.stringify({ cam, ui, quality: st.quality, auto: st.autoQuality, pr: st.pixelRatio, state: st.state, paused: st.paused }));
    assert(!s.presenting && cam.parent && Math.abs(cam.pos[1] - 2.2) < 0.01 && cam.fov === 60, 'Exit VR (menu): the camera is back at the dock eye, fov 60');
    assert(st.state === 'ready' && st.paused && ui.pause, 'the game waits in the desktop pause menu (the VR menu was open)');
    assert(!ui.inert && !ui.xr && !ui.note && ui.hud, 'the page UI is live again (not inert, no VR note)');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert(focused === 'btn-resume', `the page pause menu has focus on Resume, as when it opens on the desktop (${focused})`);
    assert(st.quality === desk0.quality && st.autoQuality === desk0.autoQuality && st.pixelRatio === desk0.pixelRatio, `the desktop quality comes back (${st.quality}/${st.autoQuality}/${st.pixelRatio} vs ${desk0.quality}/${desk0.autoQuality}/${desk0.pixelRatio})`);
    const mods = await g('(() => { const t = window.__game.debug.modules().tackle; return { xrMode: t.xrMode, visible: t.object.visible }; })()');
    assert(!mods.xrMode && mods.visible, 'the desktop rod is back in view');
    const dom = await page.evaluate(() => ({ units: document.getElementById('units-label').textContent, sound: document.getElementById('btn-sound').getAttribute('aria-pressed') }));
    assert(dom.units === 'KG' || dom.units === 'LB', `the page shows the units picked in VR (${dom.units})`);
    await h.shot('13-desktop-after-exit');
    // resume from the page's own pause menu, then mouse and keyboard play
    await L.click('#btn-resume');
    await L.waitFrames(2);
    assert(!(await L.stats()).paused, 'the page Resume button works');
    const vp = page.viewportSize();
    await page.mouse.move(vp.width * 0.5, vp.height * 0.5);
    await L.waitFrames(2);
    const y0 = (await L.stats()).view.yawDeg;
    await page.mouse.move(vp.width * 0.97, vp.height * 0.3, { steps: 4 });
    await L.waitFrames(6);
    const y1 = (await L.stats()).view.yawDeg;
    assert(y1 > y0 + 2, `the mouse steers the desktop view again (${y0} -> ${y1})`);
    await page.mouse.move(vp.width * 0.5, vp.height * 0.5, { steps: 2 });
    await L.waitFrames(3);
    await page.keyboard.down('Space');
    await L.waitFrames(3);
    const ch = (await L.stats()).state;
    await page.keyboard.up('Space');
    await L.waitFrames(2);
    const cs = (await L.stats()).state;
    assert(ch === 'charging' && (cs === 'casting' || cs === 'waiting'), `Space charges and casts on the desktop again (${ch} -> ${cs})`);
    await dbg('setTimeScale(4)');
    await L.waitState('waiting', { gameS: 20 });
    await dbg('setTimeScale(1)');
    await L.waitFrames(2);
    await h.shot('14-desktop-cast');
    await resetToReadyDesktop();
  }
  async function resetToReadyDesktop() {
    const id = (await L.stats()).lure.id;
    await dbg(`setLure('${id}')`);
    await L.waitFrames(2);
  }

  // ------------------------------------------------------------------ re-enter from the pause menu, leave from the headset
  if (want('reenter') && !(await presenting())) {
    log(T(), 'reenter');
    const desk1 = await L.stats(); // (auto quality may have moved on the desktop meanwhile)
    await page.keyboard.press('Escape');
    await L.waitFrames(2);
    ui = await pageUI();
    assert(ui.pause, 'Esc: the page pause menu');
    const vpb = await page.evaluate(() => {
      const b = document.getElementById('btn-vr-pause');
      return b ? !b.hidden && b.offsetParent !== null : false;
    });
    assert(vpb, 'the pause menu offers Enter VR');
    await L.click('#btn-vr-pause');
    // (Quest: the 2D page can lose focus and be hidden as the headset takes over)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await L.waitWall(presenting, { label: 'presenting again', every: 500 });
    await restHands();
    await xf(3);
    s = await xs();
    log(T(), 'in VR again', JSON.stringify({ rig: s.rig, state: s.state, paused: s.paused, profile: s.profile, quality: s.quality, rodHand: s.rodHand }));
    assert(s.presenting && s.state === 'ready' && !s.paused, 'Enter VR from the pause menu: READY in the headset, not paused (the hidden page does not pause it)');
    assert(s.rig.cameraInRig && s.rig.yawDeg === 0 && s.profile === 'low' && s.quality === 'low', 'rig reset, XR profile low again');
    const nodesVR2 = await xrNodes();
    assert(JSON.stringify(nodesVR2) === JSON.stringify(nodesVR1), `the second session has the same xr objects as the first, none duplicated (${JSON.stringify(nodesVR2)})`);
    ui = await pageUI();
    assert(ui.inert && ui.note, 'page UI inert again');
    const aud2 = await g('(() => { const a = window.__game.debug.modules().audio; return a.context && a.context.state; })()');
    assert(aud2 === 'running', `the sound plays in the headset although the 2D page reports itself hidden (${aud2})`);
    await stereoShot('15-vr-again-stereo');
    await page.evaluate(() => {
      delete document.hidden;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // the headset's own exit (system menu / taking it off): the session just ends
    await g('window.__game.debug.modules().renderer.xr.getSession().end()');
    await L.waitWall(async () => !(await presenting()), { label: 'session end (headset)' });
    await L.waitFrames(3);
    s = await xs();
    const st = await L.stats();
    ui = await pageUI();
    const left = await g(`(() => { const m = window.__game.debug.modules(); return { camParent: m.camera.parent === m.scene, fade: m.camera.children.filter((c) => c.name === 'xr-deck-fade').length, tackleXR: m.tackle.xrMode }; })()`);
    left.n = await xrNodes();
    log(T(), 'after session.end()', JSON.stringify({ left, ui, state: st.state, paused: st.paused, quality: st.quality, pr: st.pixelRatio }));
    assert(!s.presenting && st.state === 'ready' && !st.paused && ui.hud && !ui.inert && !ui.note, 'session.end() from the headset: back on the desktop, READY, not paused, page UI live');
    assert(st.quality === desk1.quality && st.autoQuality === desk1.autoQuality && st.pixelRatio === desk1.pixelRatio, `the desktop quality comes back again (${st.quality}/${st.autoQuality}/${st.pixelRatio} vs ${desk1.quality}/${desk1.autoQuality}/${desk1.pixelRatio})`);
    // (the rig and its empty grip / ray groups stay for the next session; the HUD, the fade and the mounts go)
    const stay = ['xr-grip-left', 'xr-grip-right', 'xr-ray-left', 'xr-ray-right', 'xr-rig'];
    assert(JSON.stringify(Object.keys(left.n)) === JSON.stringify(stay) && Object.values(left.n).every((k) => k === 1) && left.camParent && left.fade === 0 && !left.tackleXR, `no leftovers after two sessions (${JSON.stringify(left)})`);
    await L.waitFrames(2);
    await h.shot('16-desktop-after-headset-exit');
  }

  assert(sizeWarnings.length === 0, `no "Can't change size while VR device is presenting" warnings (${sizeWarnings.length})`);
  await L.expectNoNaN();
  log(T(), 'done');
};
