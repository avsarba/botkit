// Catch flow: float rig + forced largemouth bite, hookset, a real-physics fight to the net, the
// catch showcase + card, release back to READY. Then a crankbait retrieve that draws a natural bite.
// Gameplay runs at low quality / half resolution with the debug time scale (SwiftShader is slow);
// screenshots are taken at high quality and full resolution.
//   node tools/harness.mjs --scenario tools/scenarios/catch.mjs --out out/catch --size 960x540
import { makeLib } from './lib.mjs';

export default async (h) => {
  const { log } = h;
  const L = makeLib(h);
  const { dbg, stats, waitState, still, assert, playFight, expectNoNaN, T } = L;
  const fast = async () => {
    await dbg('setQuality("low")');
    await dbg('setPixelRatio(0.5)');
  };
  const pretty = async (name, frames = 2) => {
    await dbg('setQuality("high")');
    await still(name, { pr: 1, frames, scale: 1 });
  };

  await dbg('skipTitle()');
  await fast();
  await dbg('setTime(6.3)');
  assert((await L.state()) === 'ready', 'Start leads to READY');

  // ---- float rig, forced largemouth bite
  await dbg('setLure("bobber")');
  await dbg('setTimeScale(8)');
  const landed = await dbg('cast(0.7, -10)');
  log(T(), 'cast landed', JSON.stringify(landed));
  assert(landed && landed.onWater, 'float landed on the water');
  assert((await L.state()) === 'waiting', 'WAITING after the float lands');
  await dbg('forceBite("largemouth_bass")');
  const sb = await waitState('strike', { gameS: 60, every: 100 });
  log(T(), 'bite opened at game time', sb.time);
  await dbg('strike()');
  const s1 = await stats();
  assert(s1.state === 'fighting' && s1.hooked && s1.hooked.speciesId === 'largemouth_bass', `hookset -> FIGHTING with a largemouth (${JSON.stringify(s1.hooked)})`);

  // ---- fight with the real physics (reel, stop cranking while the drag slips)
  let fightShot = false;
  const res = await playFight({
    drag: 0.45,
    scale: 8,
    gameS: 900,
    onTick: async (s) => {
      if (!fightShot && s.time - s1.time > 3 && s.tensionN > 8 && s.hooked && s.hooked.distanceM > 7) {
        fightShot = true;
        await dbg('setReeling(true)');
        await pretty('fight', 2);
        log(T(), 'fight shot', JSON.stringify({ T: s.tensionN, line: s.lineOutM, fish: s.hooked }));
        await fast();
        await dbg('setTimeScale(8)');
      }
    },
  });
  log(T(), 'fight ended', res.state, 'max tension', res.maxT.toFixed(1), 'N');
  assert(res.state === 'landing' || res.state === 'caught', `fight ends in LANDING/CAUGHT (got ${res.state})`);
  await dbg('setTimeScale(1)');
  const sc = await waitState('caught', { gameS: 30, every: 300 });
  assert(sc.records >= 1, 'catch recorded');
  const rec = (await dbg('records()')).slice(-1)[0];
  log(T(), 'record', JSON.stringify(rec));
  assert(rec.speciesId === 'largemouth_bass' && rec.weightKg > 0 && rec.lengthCm > 0 && rec.lureId === 'bobber' && rec.caughtAt, 'record has the contract fields');
  await pretty('catch-card', 3);
  const cardVisible = await L.g('!document.getElementById("catch").hidden');
  assert(cardVisible, 'catch card shown');
  await expectNoNaN();

  // release with the real button
  await L.click('#btn-release');
  await L.waitFrames(2);
  assert((await L.state()) === 'ready', 'Release -> READY');
  const stored = await L.g('(() => { try { return JSON.parse(localStorage.getItem("loonlake.v1")).records.length; } catch (e) { return -1; } })()');
  assert(stored >= 1, `record persisted in localStorage (${stored})`);

  // ---- crankbait on the rocky point at dawn, stop-and-go retrieve, natural bite (no forceBite)
  await fast();
  await dbg('setTime(6.2)');
  await dbg('setLure("crankbait")');
  let bit = false;
  const t0 = (await stats()).time;
  for (let cast = 0; cast < 6 && !bit; cast++) {
    await dbg('setTimeScale(10)');
    const yaw = [36, 44, 30, 40, 26, 48][cast];
    const r = await dbg(`cast(0.95, ${yaw})`);
    log(T(), `crank cast ${cast + 1} at ${yaw} deg`, JSON.stringify(r));
    await dbg('setTimeScale(12)');
    const tl = (await stats()).time;
    for (;;) {
      const s = await stats();
      if (s.state === 'strike') {
        bit = true;
        await dbg('strike()');
        break;
      }
      if (s.state !== 'waiting' || s.time - tl > 120) break;
      // 2.4 s cranking, 0.9 s pause (the pause after a run is a strike trigger)
      await dbg(`setReeling(${(s.time - tl) % 3.3 < 2.4})`);
      await h.sleep(100);
    }
    await dbg('setReeling(false)');
    const s = await stats();
    log(T(), `  -> ${s.state} after ${(s.time - tl).toFixed(1)} s of retrieve`);
    if (!bit && s.state === 'waiting') {
      await dbg('setReeling(true)');
      await dbg('setTimeScale(20)');
      await waitState(['ready', 'strike'], { gameS: 240 });
      await dbg('setReeling(false)');
      if ((await L.state()) === 'strike') {
        bit = true;
        await dbg('strike()');
      }
    }
  }
  const s2 = await stats();
  const ev = (await dbg('events()')).filter((e) => e.type === 'fish:bite').slice(-1)[0];
  log(T(), 'crankbait result', s2.state, JSON.stringify(s2.hooked), JSON.stringify(ev), 'after', (s2.time - t0).toFixed(1), 's of game time');
  assert(bit, 'a natural bite on the crankbait');
  if (s2.state === 'fighting') {
    await pretty('crank-fight', 2);
    await fast();
    const res2 = await playFight({ drag: 0.5, scale: 10, gameS: 900 });
    log(T(), 'crank fight ended', res2.state);
    if (res2.state === 'fighting') await dbg('landNow()');
    const c = await waitState(['caught', 'ready', 'waiting', 'escaped', 'snapped'], { gameS: 60 });
    if (c.state === 'caught') {
      await pretty('crank-catch', 3);
      await L.click('#btn-keep');
      await L.waitFrames(1);
      assert((await L.state()) === 'ready', 'Keep -> READY');
      const last = (await dbg('records()')).slice(-1)[0];
      assert(last.kept === true && last.lureId === 'crankbait', 'kept crankbait fish recorded');
    }
  }
  await expectNoNaN();
  log(T(), 'final', JSON.stringify(await stats()));
};
