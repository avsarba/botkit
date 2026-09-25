// Shared helpers for the harness scenarios (tools/harness.mjs --scenario tools/scenarios/<name>.mjs).
// SwiftShader renders the full scene at well under 1 fps, so scenarios run the simulation with the
// debug time scale (several fixed simulation frames per rendered frame) and a reduced pixel ratio,
// and switch back to full resolution / real time only for screenshots and precise moments.
export function makeLib({ page, shot, sleep, log, game }) {
  const t0 = Date.now();
  const T = () => ((Date.now() - t0) / 1000).toFixed(1);
  const g = (expr) => game(expr);
  const dbg = (call) => game(`window.__game.debug.${call}`);
  const state = () => game('window.__game.state');
  const stats = () => dbg('stats()');

  async function waitFor(pred, { timeoutS = 600, every = 400, label = 'condition' } = {}) {
    const end = Date.now() + timeoutS * 1000;
    for (;;) {
      const s = await stats();
      if (await pred(s)) return s;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label} (state ${s.state}, time ${s.time})`);
      await sleep(every);
    }
  }
  const waitState = (states, opts = {}) => {
    const set = Array.isArray(states) ? states : [states];
    return waitFor((s) => set.includes(s.state), { label: `state ${set.join('|')}`, ...opts });
  };

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
  // slips (a careful angler), keep the rod up. Resolves with the final state.
  async function playFight({ drag = 0.45, scale = 6, timeoutS = 900, onTick = null, careful = true } = {}) {
    await dbg(`setDrag(${drag})`);
    await dbg('setRod(null)');
    await dbg(`setTimeScale(${scale})`);
    let s = await stats();
    const end = Date.now() + timeoutS * 1000;
    let maxT = 0;
    while (s.state === 'fighting' && Date.now() < end) {
      const reel = careful ? !(s.slipMps > 0.15 || s.tensionN > s.dragN * 0.95) : true;
      await dbg(`setReeling(${reel})`);
      maxT = Math.max(maxT, s.tensionN);
      if (onTick) await onTick(s);
      await sleep(300);
      s = await stats();
    }
    await dbg('setReeling(false)');
    return { state: s.state, maxT, stats: s };
  }

  return { T, g, dbg, state, stats, waitFor, waitState, still, waitFrames, expectNoNaN, assert, playFight };
}
