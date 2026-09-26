// VR (WebXR, XR.md) end to end in the emulated Meta Quest 3 (IWER), through the real controls: the title's Enter VR
// button -> READY in the headset; casts from scripted forward swings of the rod controller (trigger held, let go
// mid-swing) at three swing speeds and to the left / right, a lob and a cast behind the player; every lure from the
// reel-hand X / Y; reeling with the analog reel trigger and with a crank gesture of the reel hand; a forced bite set
// with an upward flick, fought with the real rod lift / side and the reel trigger to CAUGHT, the fish in the reel hand
// with the card, kept with A; a second catch hooked with A and released with B; the VR menu from the reel-stick click
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
// orientations are given as the target ray's pitch (+ up) and yaw (+ left); the rod blank points ~65 deg above the
// ray (the Touch grip is ~45 deg below the ray, the rod sits 20 deg above the grip). Every gesture is played one pose
// per XR frame from the game's frame hook (debug.xr.everyFrame), so SwiftShader's slow frames don't distort speeds:
// each frame is 50 ms of game time (the loop's dt clamp).
//
// XR_ONLY=enter,lures,casts,reel,catch1,catch2,menu,desktop,reenter runs a subset while developing (each section
// starts from READY in VR, except desktop / reenter, which follow menu's Exit VR).
import { makeLib } from './lib.mjs';

const DEG = Math.PI / 180;
const FRAME_S = 0.05; // game time per XR frame under a slow software renderer (the loop's dt clamp)

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
        if (i > 0) out.push({ state: st.state, tipSpeed: st.rod.tipSpeed, pitchRate: st.rod.pitchRate, trigger: st.rod.trigger, power: st.castPower01 });
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
  // and its "up" (the crank axis is the rod's sideways axis). Returns the input's crank readings per frame.
  const crank = (hand, rps, frames, radius = 0.05) =>
    g(`new Promise((res) => {
      const dx = window.__game.debug.xr, c = window.__xrDevice.controllers.${hand};
      const st0 = dx.status();
      const hL = dx.toRig(st0.reel.crank.handle); // the handle knob, in the reference space
      const f = st0.rod.dir; // rod direction (the rig has no yaw here)
      let r = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; // f x up
      let rl = Math.hypot(r[0], r[1], r[2]); r = r.map((v) => v / rl);
      let u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]; // right x f
      rl = Math.hypot(u[0], u[1], u[2]); u = u.map((v) => v / rl);
      const step = 2 * Math.PI * ${rps} * ${FRAME_S};
      let a = 0, i = 0; const out = [];
      dx.everyFrame(() => {
        const st = dx.status();
        if (i > 0) out.push({ rps: st.reel.crank.revPerSec, active: st.reel.crank.active, near: st.reel.crank.near, d: st.reel.crank.distanceM, speed01: st.reel.crank.speed01, reel: st.reelSpeed01 });
        if (i++ >= ${frames}) { res(out); return false; }
        a += step;
        const k = Math.cos(a) * ${radius}, m = Math.sin(a) * ${radius};
        c.position.set(hL[0] + k * f[0] + m * u[0], hL[1] + k * f[1] + m * u[1], hL[2] + k * f[2] + m * u[2]);
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

  // resting poses: rod up ~45 deg out over the water, the reel hand beside the reel
  const REST = { rod: { pitch: -20, pos: [0.2, 1.3, -0.35] }, reel: { pitch: -10, pos: [-0.13, 1.24, -0.32] } };
  const restHands = async () => {
    const side = rodHand === 'right' ? 1 : -1;
    await pose(rodHand, REST.rod.pitch, [side * REST.rod.pos[0], REST.rod.pos[1], REST.rod.pos[2]]);
    await pose(reelHand(), REST.reel.pitch, [side * REST.reel.pos[0], REST.reel.pos[1], REST.reel.pos[2]]);
  };
  // back to READY with the rig home (no reeling needed): re-tie the current lure
  const resetToReady = async () => {
    const id = (await L.stats()).lure.id;
    await dbg(`setLure('${id}')`);
    await xf(2);
  };

  // A forward swing of the rod controller with the trigger held, let go as the ray passes `releasePitch` (the rod
  // ~55 deg up, as the tip whips through). `degPerFrame` is the wrist speed (x 20 = deg/s), yaw the swing's bearing
  // (+ left), `hand` the rod hand. Resolves with the cast the game made.
  async function swingCast({ degPerFrame, yawDeg = 0, hand = rodHand, releasePitch = -10, label = '' }) {
    const side = hand === 'right' ? 1 : -1;
    const fx = -Math.sin(yawDeg * DEG);
    const fz = -Math.cos(yawDeg * DEG);
    const base = [side * 0.22 * Math.cos(yawDeg * DEG), 1.62, 0];
    const at = (fwd, down) => [+(base[0] + fx * fwd).toFixed(4), +(base[1] - down).toFixed(4), +(base[2] + fz * fwd).toFixed(4)];
    // wind up: the rod back over the shoulder (~105 deg up), trigger pulled (finger on the line, bail open)
    await pose(hand, 40, at(0.25, 0), yawDeg); // (ray 40 deg up, 25 cm ahead of the shoulder)
    await xf(2);
    await button(hand, 'trigger', 1);
    await xf(2);
    const s0 = await xs();
    assert(s0.state === 'charging' && s0.rod.triggerHeld, `${label}: rod trigger held in READY -> CHARGING, bail open (${s0.state})`);
    const steps = [];
    let released = false;
    for (let p = 40 - degPerFrame, i = 1; p >= -40; p -= degPerFrame, i++) {
      const k = (40 - p) / 10; // tens of degrees swept
      const st = { pitch: +p.toFixed(2), yaw: yawDeg, pos: at(0.25 + 0.04 * k, 0.015 * k) };
      if (!released && p <= releasePitch) {
        st.trigger = 0;
        released = true;
      }
      steps.push(st);
      if (released && steps.length > 2 && p < releasePitch - 2 * degPerFrame) break;
    }
    const trace = await drive(hand, steps);
    const s = await xs();
    log(T(), `${label} swing`, JSON.stringify(trace.map((x) => [x.state[0] + x.state[1], x.tipSpeed, x.trigger])));
    log(T(), `${label} cast`, JSON.stringify(s.lastCast), s.state);
    return s.lastCast;
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
  const audio0 = await g('(() => { const a = window.__game.debug.modules().audio; return { started: a.started, state: a.context && a.context.state }; })()');
  assert(audio0.started && audio0.state === 'running', `audio started from the Enter VR click (${JSON.stringify(audio0)})`);
  let ui = await pageUI();
  assert(ui.inert && ui.xr && ui.note && !ui.title, `the page UI behind the headset is inert with a "playing in VR" note (${JSON.stringify(ui)})`);
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
    for (const [name, spec] of [
      ['low', { degPerFrame: 4 }],
      ['medium', { degPerFrame: 6.5 }],
      ['high', { degPerFrame: 11 }],
      ['left', { degPerFrame: 6.5, yawDeg: 25 }],
      ['right', { degPerFrame: 6.5, yawDeg: -25 }],
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
    assert(low.power01 <= 0.45 && high.power01 >= 0.7, `slow swing short, fast swing long (${low.power01}, ${high.power01})`);
    assert(low.dist < medium.dist && medium.dist < high.dist, `distance follows (${low.dist} < ${medium.dist} < ${high.dist} m)`);
    for (const c of [low, medium, high]) assert(Math.abs(c.yawDeg) < 8 && Math.abs(c.bearing) < 10, `straight swing -> straight out (${c.yawDeg} deg, landed at ${c.bearing} deg)`);
    assert(left.yawDeg < -12 && left.bearing < -10, `swing to the left -> cast left (${left.yawDeg} deg, landed at ${left.bearing} deg)`);
    assert(right.yawDeg > 12 && right.bearing > 10, `swing to the right -> cast right (${right.yawDeg} deg, landed at ${right.bearing} deg)`);
    for (const c of Object.values(casts)) {
      assert(c.pitchDeg >= 20 && c.pitchDeg <= 40, `overhead cast let go with the rod ~${c.rodDeg} deg up: launched at ${c.pitchDeg} deg (the tip itself moving ${c.tipElevDeg} deg)`);
    }

    // turned around toward the shore: a swing over the dock is not a cast
    const behind = await swingCast({ degPerFrame: 6.5, yawDeg: 180, label: 'behind' });
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
    const c = await swingCast({ degPerFrame: 7, label: 'reel-test' });
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
    // turning the reel for real
    const turns = {};
    for (const [rps, frames] of [[1.0, 26], [1.5, 26], [0.3, 30]]) {
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
    await pose(rodHand, 0, at, -bear);
    await xf(6);
    let x = await xs();
    const high = x.rodLift01;
    await pose(rodHand, -50, at, -bear);
    await xf(6);
    x = await xs();
    const low = x.rodLift01;
    assert(high > 0.85 && low < 0.4, `rod lift from the rod's elevation (high ${high}, low ${low})`);
    // swept right / left of the line
    await pose(rodHand, -20, at, -bear - 50);
    await xf(6);
    const sr = (await xs()).rodSide;
    await pose(rodHand, -20, at, -bear + 50);
    await xf(6);
    const sl = (await xs()).rodSide;
    assert(sr > 0.3 && sl < -0.3, `side pressure from the rod's sweep (right ${sr}, left ${sl})`);
    await pose(rodHand, -10, at, -bear);
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
    await dev("d.updateVisibilityState('visible')");
    await xf(2);
    await tap(reelHand(), 'thumbstick');
    x = await xs();
    assert(!x.paused && !x.ui.menuOpen && x.state === 'fighting', 'reel-stick click: resumed, still fighting');
  }

  if (want('catch1')) {
    log(T(), 'catch 1');
    s = await xs();
    if ((await L.stats()).state !== 'waiting') {
      const c = await swingCast({ degPerFrame: 7, label: 'catch1-cast' });
      assert(c && !c.lob, 'cast out');
      await waitLanded();
    }
    const side = rodHand === 'right' ? 1 : -1;
    await pose(rodHand, -20, [side * 0.2, 1.2, -0.33]);
    await xf(2);
    const tBite = (await L.stats()).time;
    // an upward flick of the rod hand, as soon as the float goes under (after the STRIKE screenshot)
    const flick = strikeThen(rodHand, [
      { pitch: -20, pos: [side * 0.2, 1.2, -0.33] },
      { pitch: -2, pos: [side * 0.2, 1.24, -0.31] },
      { pitch: 22, pos: [side * 0.2, 1.3, -0.27] },
      { pitch: 30, pos: [side * 0.2, 1.33, -0.24] },
      { pitch: 30, pos: [side * 0.2, 1.33, -0.24] },
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
    assert(s.state === 'fighting', `an upward flick of the rod sets the hook (${s.state}, tip up/back ${s.hookMetric.tipUpBack} m/s, pitch rate ${s.hookMetric.pitchRate} rad/s)`);
    assert(flickTrace.some((e) => e.haptics.includes('rod:hookset')), 'hookset pulse on the rod hand');
    await pose(rodHand, -10, [side * 0.2, 1.2, -0.35]);
    await xf(4);
    assert((await xs()).haptics.recent.some((p) => p.kind === 'fight'), 'fight rumble on the rod hand');
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
    const n0 = (await dbg('records()')).length;
    await tap(rodHand, rodHand === 'right' ? 'a-button' : 'x-button');
    s = await xs();
    const recs = await dbg('records()');
    assert(s.state === 'ready' && !s.ui.catchOpen, `A keeps it: READY, card gone (${s.state})`);
    assert(recs.length === n0 && recs[recs.length - 1].kept === true && recs[recs.length - 1].speciesId === 'bluegill', 'the bluegill is in the log as kept');
    await headPose([0, 1.6, 0], 0, 0);
    await restHands();
    await xf(2);
  }

  // ------------------------------------------------------------------ catch 2: hookset with A, released with B
  if (want('catch2')) {
    log(T(), 'catch 2');
    const c = await swingCast({ degPerFrame: 7, yawDeg: -15, label: 'catch2-cast' });
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

  // ------------------------------------------------------------------ the VR menu, rod hand swap, snap turn, Exit VR
  if (want('menu')) {
    log(T(), 'menu');
    await headPose([0, 1.6, 0], 0, 0);
    await restHands();
    await xf(1);
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
    assert(s.journalOpen && s.ui.journalOpen && !s.ui.menuOpen, 'Journal: the journal replaces the menu');
    await monoShot('10-vr-journal');
    s = await press(rodHand, 'journal', 'close');
    assert(!s.journalOpen && !s.ui.journalOpen && s.ui.menuOpen && s.paused, 'Close: back to the menu, still paused');
    s = await press(rodHand, 'menu', 'hand:left');
    rodHand = 'left';
    const tk = await g('(() => { const t = window.__game.debug.modules().tackle.debug.xr; return { hand: t.rodHand, mount: t.rodMount.parent && t.rodMount.parent.name }; })()');
    assert(s.rodHand === 'left' && s.settings.rodHand === 'left' && tk.hand === 'left' && tk.mount === 'xr-grip-left', `Rod hand: left (the rod moves to the left grip: ${JSON.stringify(tk)})`);
    s = await press('right', 'menu', 'resume');
    assert(!s.paused && !s.ui.menuOpen && s.state === 'ready', 'Resume');
    await restHands();
    await xf(3);
    await monoShot('11-vr-left-handed');

    // left-handed: the left trigger holds the line; letting go with the rod still drops a short lob
    await button('left', 'trigger', 1);
    await xf(3);
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
    await monoShot('12-vr-snap-turned');
    await stick('left', 1, 0);
    await xf(3);
    s = await xs();
    assert(Math.abs(s.rig.yawDeg + 30) < 0.5, 'holding the stick over: one step per flick');
    await stick('left', 0, 0);
    await xf(1);
    await flick('left', -1, 0);
    s = await xs();
    assert(Math.abs(s.rig.yawDeg) < 0.5, `and back (${s.rig.yawDeg})`);
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
    ui = await pageUI();
    assert(ui.inert && ui.note, 'page UI inert again');
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
    const left = await g(`(() => { const m = window.__game.debug.modules(); const n = {}; m.scene.traverse((o) => { if (/^xr-(rig|hud)$/.test(o.name)) n[o.name] = (n[o.name] || 0) + 1; }); return { n, camParent: m.camera.parent === m.scene, fade: m.camera.children.filter((c) => c.name === 'xr-deck-fade').length, tackleXR: m.tackle.xrMode }; })()`);
    log(T(), 'after session.end()', JSON.stringify({ left, ui, state: st.state, paused: st.paused, quality: st.quality, pr: st.pixelRatio }));
    assert(!s.presenting && st.state === 'ready' && !st.paused && ui.hud && !ui.inert && !ui.note, 'session.end() from the headset: back on the desktop, READY, not paused, page UI live');
    assert(st.quality === desk1.quality && st.autoQuality === desk1.autoQuality && st.pixelRatio === desk1.pixelRatio, `the desktop quality comes back again (${st.quality}/${st.autoQuality}/${st.pixelRatio} vs ${desk1.quality}/${desk1.autoQuality}/${desk1.pixelRatio})`);
    assert(left.n['xr-rig'] === 1 && left.n['xr-hud'] === 1 && left.camParent && left.fade === 0 && !left.tackleXR, `no leftovers after two sessions (${JSON.stringify(left)})`);
    await L.waitFrames(2);
    await h.shot('16-desktop-after-headset-exit');
  }

  assert(sizeWarnings.length === 0, `no "Can't change size while VR device is presenting" warnings (${sizeWarnings.length})`);
  await L.expectNoNaN();
  log(T(), 'done');
};
