// Shared helpers for the harness scenarios (tools/harness.mjs --scenario tools/scenarios/<name>.mjs).
// SwiftShader renders the full scene at well under 1 fps, so scenarios run the simulation with the
// debug time scale (several fixed simulation frames per rendered frame) and a reduced pixel ratio,
// and switch back to full resolution / real time only for screenshots and precise moments.
//
// Every wait is measured in GAME time (frame.time: it advances only while frames render, faster with
// the debug time scale) or in rendered frames, never in wall-clock time: how many real seconds a
// software-rendered frame takes depends on the resolution, the quality level and the machine's load.
// Wall-clock limits are only a generous backstop against a page that stopped rendering altogether.
export const WALL_BACKSTOP_S = 3600; // a single wait never takes longer than this in real time
export const STALL_S = 900; // ... and throws if not one frame advanced the game clock for this long

export function makeLib({ page, shot, sleep, log, game }) {
  const t0 = Date.now();
  const T = () => ((Date.now() - t0) / 1000).toFixed(1);
  const g = (expr) => game(expr);
  const dbg = (call) => game(`window.__game.debug.${call}`);
  const state = () => game('window.__game.state');
  const stats = () => dbg('stats()');

  // Poll until pred(stats) is true. `gameS` is the budget in game seconds (`timeoutS` is accepted as an
  // alias). The clock must keep moving: while the game is paused on purpose, use waitWall instead.
  async function waitFor(pred, { gameS, timeoutS, every = 250, label = 'condition', stallS = STALL_S, wallS = WALL_BACKSTOP_S } = {}) {
    const budget = gameS ?? timeoutS ?? 300;
    const first = await stats();
    const g0 = first.time;
    const wallEnd = Date.now() + wallS * 1000;
    let lastTime = g0;
    let lastMove = Date.now();
    for (let s = first; ; s = await stats()) {
      if (await pred(s)) return s;
      if (s.time - g0 > budget) throw new Error(`timed out waiting for ${label} after ${(s.time - g0).toFixed(1)} s of game time (state ${s.state}, time ${s.time})`);
      if (s.time !== lastTime) {
        lastTime = s.time;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > stallS * 1000) throw new Error(`waiting for ${label}: the game clock stood still for ${stallS} s (state ${s.state}, paused ${s.paused})`);
      if (Date.now() > wallEnd) throw new Error(`waiting for ${label}: wall-clock backstop (${wallS} s) hit (state ${s.state}, time ${s.time})`);
      await sleep(every);
    }
  }
  const waitState = (states, opts = {}) => {
    const set = Array.isArray(states) ? states : [states];
    return waitFor((s) => set.includes(s.state), { label: `state ${set.join('|')}`, ...opts });
  };
  // A page-side condition that does not depend on the game clock (DOM, loading): polled with a wall-clock
  // backstop only.
  async function waitWall(fn, { every = 250, label = 'condition', wallS = WALL_BACKSTOP_S } = {}) {
    const end = Date.now() + wallS * 1000;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label} (${wallS} s wall-clock backstop)`);
      await sleep(every);
    }
  }
  // The title's Start button is enabled once the lake is built and warmed up.
  const waitStartEnabled = () =>
    waitWall(() => page.evaluate(() => document.getElementById('btn-start').textContent === 'Start fishing' && !document.getElementById('btn-start').disabled), {
      label: 'Start enabled',
      every: 250,
    });

  // Screenshot at full resolution: wait a couple of rendered frames at pixel ratio 1.
  async function still(name, { pr = 1, frames = 2, scale = 1 } = {}) {
    await dbg(`setTimeScale(${scale})`);
    await dbg(`setPixelRatio(${pr})`);
    await waitFrames(frames);
    return shot(name);
  }

  async function waitFrames(n) {
    await g(`new Promise((res) => { let k = ${n}; const tick = () => (--k <= 0 ? res(true) : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`);
  }

  // Real DOM clicks wait for the element to be stable across animation frames: allow for slow frames.
  const click = (sel) => page.click(sel, { timeout: WALL_BACKSTOP_S * 1000 });

  async function expectNoNaN() {
    const s = await stats();
    const bad = [];
    const walk = (o, p) => {
      if (typeof o === 'number' && !Number.isFinite(o)) bad.push(p);
      else if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], `${p}.${k}`);
    };
    walk(await g('(() => { const f = window.__game.frame; return { dt: f.dt, time: f.time, hours: f.hours, tensionN: f.tensionN, tension01: f.tension01, dragN: f.dragN, lineOutM: f.lineOutM, slipMps: f.slipMps, input: f.input, lure: { p: f.lure.position.toArray(), v: f.lure.velocity.toArray(), d: f.lure.depthM, s: f.lure.speedMps, l: f.lure.lineOutM }, hooked: f.hooked ? { p: f.hooked.position.toArray(), v: f.hooked.velocity.toArray(), st: f.hooked.stamina01 } : null, cam: window.__game.frame.camera.matrixWorld.elements.slice() }; })()'), 'frame');
    if (bad.length) throw new Error(`NaN/Infinity in frame: ${bad.join(', ')}`);
    return s;
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(`assertion failed: ${msg}`);
    log(`  ok: ${msg}`);
  }

  // Play a hooked fish with the real fight physics: hold the reel, stop cranking while the drag
  // slips (a careful angler), keep the rod up. Resolves with the final state. The budget is game time.
  async function playFight({ drag = 0.45, scale = 6, gameS = 600, timeoutS, onTick = null, careful = true } = {}) {
    const budget = gameS ?? timeoutS;
    await dbg(`setDrag(${drag})`);
    await dbg('setRod(null)');
    await dbg(`setTimeScale(${scale})`);
    let s = await stats();
    const g0 = s.time;
    let maxT = 0;
    let lastTime = s.time;
    let lastMove = Date.now();
    while (s.state === 'fighting' && s.time - g0 < budget) {
      const reel = careful ? !(s.slipMps > 0.15 || s.tensionN > s.dragN * 0.95) : true;
      await dbg(`setReeling(${reel})`);
      maxT = Math.max(maxT, s.tensionN);
      if (onTick) await onTick(s);
      await sleep(200);
      s = await stats();
      if (s.time !== lastTime) {
        lastTime = s.time;
        lastMove = Date.now();
      } else if (Date.now() - lastMove > STALL_S * 1000) throw new Error('playFight: the game clock stood still');
    }
    await dbg('setReeling(false)');
    return { state: s.state, maxT, stats: s, gameS: s.time - g0 };
  }

  return { T, g, dbg, state, stats, waitFor, waitState, waitWall, waitStartEnabled, still, waitFrames, click, expectNoNaN, assert, playFight };
}
