// Soak: several minutes of scripted play (casts with every lure, retrieves, time presets, pause /
// resume, the journal, units, bites, fights and catches). Checks that GPU memory (geometries,
// textures) stays bounded, the frame never carries NaN and nothing logs an error.
//   node tools/harness.mjs --scenario tools/scenarios/soak.mjs --out out/soak --size 960x540
import { makeLib } from './lib.mjs';

const SOAK_S = Number(process.env.SOAK_S || 200); // real seconds of play (after warm-up)

export default async (h) => {
  const { page, log, sleep } = h;
  const L = makeLib(h);
  const { dbg, stats, assert, expectNoNaN, T } = L;
  await dbg('skipTitle()');
  await dbg('setQuality("low")');
  await dbg('setPixelRatio(0.5)');
  const lures = ['bobber', 'spinner', 'crankbait', 'topwater'];
  const presets = [5.75, 9, 12.5, 19 + 40 / 60, 22.5];
  let cycle = 0;
  let catches = 0;
  let bites = 0;
  let base = null;
  const mem = [];
  const tStart = Date.now();
  const game0 = (await stats()).time;

  while (Date.now() - tStart < SOAK_S * 1000 || cycle < 8) {
    cycle++;
    const lure = lures[cycle % 4];
    await dbg(`setLure("${lure}")`);
    if (cycle % 3 === 0) await dbg(`setTime(${presets[(cycle / 3) % presets.length | 0]})`);
    if (cycle % 5 === 0) {
      // runtime quality switches (water grid, passes, shadows) must not leak either
      await dbg(`setQuality("${cycle % 10 === 0 ? 'high' : 'medium'}")`);
      await L.waitFrames(2);
      await dbg('setQuality("low")');
      await dbg('setPixelRatio(0.5)');
    }
    await dbg('setTimeScale(10)');
    const yaw = ((cycle * 37) % 120) - 60;
    const power = 0.45 + ((cycle * 13) % 50) / 100;
    const r = await dbg(`cast(${power.toFixed(2)}, ${yaw})`);
    if (cycle % 4 === 1) await dbg(`forceBite(${cycle % 8 === 1 ? '"yellow_perch"' : 'null'})`);
    // retrieve for a while (stop and go), strike if something bites
    await dbg('setTimeScale(4)');
    let s = await stats();
    for (let k = 0; k < 90; k++) {
      s = await stats();
      if (s.state === 'strike') {
        bites++;
        await dbg('strike()');
        s = await stats();
        break;
      }
      if (s.state !== 'waiting') break;
      await dbg(`setReeling(${lure === 'bobber' ? k > 30 : s.time % 3 < 2.2})`);
      await sleep(150);
    }
    await dbg('setReeling(false)');
    if (s.state === 'fighting') {
      const tFight = s.time;
      const res = await L.playFight({ drag: 0.5, scale: 8, timeoutS: 240 });
      const ev = (await dbg(`events(${tFight})`)).filter((e) => /escaped|snap|catch|hooked/.test(e.type) || e.to === 'landing');
      log(T(), `  fight -> ${res.state}: ${ev.map((e) => e.type + (e.reason ? ':' + e.reason : '') + (e.to ? ':' + e.to : '')).join(', ')}`);
      if (res.state === 'fighting') await dbg('landNow()');
      const c = await L.waitState(['caught', 'ready', 'snapped', 'escaped', 'waiting'], { timeoutS: 200 });
      if (c.state === 'caught') {
        catches++;
        await L.waitFrames(2);
        if (catches % 2) await page.click('#btn-keep');
        else await page.click('#btn-release');
      }
    }
    // bring the lure home if it's still out
    s = await stats();
    if (s.state === 'waiting' || s.state === 'escaped') {
      await dbg('setTimeScale(12)');
      await dbg('setReeling(true)');
      await L.waitState(['ready', 'strike', 'fighting'], { timeoutS: 200 }).catch(() => null);
      await dbg('setReeling(false)');
      s = await stats();
      if (s.state !== 'ready') await dbg('setLure("bobber")'); // forces a re-tie back to READY
    }
    // UI round trips
    if (cycle % 4 === 2) {
      await page.keyboard.press('Escape');
      await L.waitFrames(1);
      assert((await stats()).paused, 'Esc pauses');
      const t0 = (await stats()).time;
      await sleep(1500);
      assert((await stats()).time === t0, 'simulation frozen while paused');
      await page.click('#btn-resume');
      await L.waitFrames(1);
      assert(!(await stats()).paused, 'Resume');
    }
    if (cycle % 5 === 3) {
      await page.keyboard.press('KeyJ');
      await L.waitFrames(1);
      await page.keyboard.press('KeyJ');
      await page.keyboard.press('KeyU');
    }
    await expectNoNaN();
    s = await stats();
    mem.push({ cycle, geometries: s.geometries, textures: s.textures, state: s.state });
    if (cycle === 3) base = { geometries: s.geometries, textures: s.textures };
    log(T(), `cycle ${cycle} ${lure} cast ${JSON.stringify(r)} -> ${s.state}; bites ${bites} catches ${catches}; geo ${s.geometries} tex ${s.textures}; hours ${s.hours}`);
  }
  const s = await stats();
  log(T(), 'game time played', (s.time - game0).toFixed(0), 's; memory', JSON.stringify(mem.map((m) => [m.geometries, m.textures])));
  assert(s.time - game0 > 180, 'more than 3 minutes of game time');
  assert(catches >= 1, `at least one catch (${catches})`);
  assert(s.geometries <= base.geometries + 40, `geometries bounded (${base.geometries} -> ${s.geometries})`);
  assert(s.textures <= base.textures + 16, `textures bounded (${base.textures} -> ${s.textures})`);
  const tail = mem.slice(-4);
  assert(tail.every((m) => m.geometries <= tail[0].geometries + 20), 'no steady geometry growth at the end');
  await L.still('soak-end', { pr: 1, frames: 1 });
};
