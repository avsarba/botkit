// Line break and a thrown hook:
//  1) a 6 kg northern pike on a locked-down drag (setDrag(1)) with continuous cranking through its
//     runs: the drag lag + cranking push the tension past 12 lb -> SNAPPED -> re-tie -> READY.
//  2) a largemouth given slack line: slack + head shakes throw the hook -> ESCAPED -> reel in -> READY.
//   node tools/harness.mjs --scenario tools/scenarios/snap.mjs --out out/snap --size 960x540
import { makeLib } from './lib.mjs';

export default async (h) => {
  const { log } = h;
  const L = makeLib(h);
  const { dbg, stats, waitState, still, assert, expectNoNaN, T } = L;

  const fast = async () => {
    await dbg('setQuality("low")');
    await dbg('setPixelRatio(0.5)');
  };
  const pretty = async (name) => {
    await dbg('setQuality("high")');
    await still(name, { pr: 1, frames: 2, scale: 1 });
    await fast();
  };
  await dbg('skipTitle()');
  await fast();
  await dbg('setTime(7)');

  // ---- 1) snap
  const hooked = await dbg('hookFish("northern_pike", 6)');
  log(T(), 'hooked', JSON.stringify(hooked));
  assert(hooked && hooked.speciesId === 'northern_pike', 'hookFish -> FIGHTING with a pike');
  assert((await L.state()) === 'fighting', 'state FIGHTING');
  await dbg('setDrag(1)');
  await dbg('setReeling(true)');
  await dbg('setRod(0, 0.1)'); // rod low, pointed down the line: no cushion
  await dbg('setTimeScale(4)');
  let maxT = 0;
  let shot = false;
  let s = await stats();
  // (game-time budget: every poll waits for the clock to move, see L.waitFor)
  const g0 = s.time;
  while (s.state === 'fighting' && s.time - g0 < 600) {
    maxT = Math.max(maxT, s.tensionN);
    if (!shot && s.tensionN > 38) {
      shot = true;
      await pretty('pike-heavy');
      await dbg('setTimeScale(4)');
    }
    const t = s.time;
    s = await L.waitFor((x) => x.time !== t || x.state !== 'fighting', { gameS: 60, every: 150, label: 'fight clock' });
  }
  log(T(), 'pike fight ended in', s.state, 'max tension seen', maxT.toFixed(1));
  const snapEv = (await dbg('events()')).filter((e) => e.type === 'tackle:snap');
  assert(s.state === 'snapped' || snapEv.length > 0, `line snapped (state ${s.state})`);
  await pretty('snapped');
  await dbg('setTimeScale(4)');
  const r = await waitState('ready', { gameS: 30 });
  assert(r.lure && r.lure.state === 'home' && !r.lure.lost, 're-tied: lure back at the rod tip');
  await dbg('setReeling(false)');
  await dbg('setRod(null)');
  await dbg('setDrag(0.45)');

  // ---- 2) slack line + head shakes throw the hook
  await dbg('setLure("spinner")');
  await dbg('setTimeScale(8)');
  await dbg('cast(0.6, 5)');
  const hk = await dbg('hookFish("largemouth_bass", 1.6)');
  assert(hk && (await L.state()) === 'fighting', 'second fish on');
  await dbg('setTimeScale(3)');
  let esc = null;
  s = await stats();
  const g1 = s.time;
  while (s.state === 'fighting' && s.time - g1 < 300) {
    // the angler drops the rod and feeds line whenever it comes tight: the line stays slack
    if (s.tensionN > 0.3) await dbg('slack(2)');
    const t = s.time;
    s = await L.waitFor((x) => x.time !== t || x.state !== 'fighting', { gameS: 60, every: 150, label: 'fight clock' });
  }
  s = await stats();
  esc = (await dbg('events()')).filter((e) => e.type === 'escaped').slice(-1)[0];
  log(T(), 'slack fight ended in', s.state, JSON.stringify(esc));
  assert(esc && (esc.reason === 'headshake' || esc.reason === 'slack'), `hook thrown on slack line (${esc && esc.reason})`);
  await pretty('escaped');
  await dbg('setTimeScale(8)');
  await dbg('setReeling(true)');
  await dbg('setTimeScale(20)');
  const r2 = await waitState('ready', { gameS: 240 });
  await dbg('setReeling(false)');
  assert(r2.state === 'ready', 'lure reeled home -> READY');

  // ---- 3) rod pointed down the line: head shakes and jumps on a tight line tear the hook out
  let pulled = null;
  for (let attempt = 0; attempt < 3 && !pulled; attempt++) {
    await dbg('setLure("crankbait")');
    await dbg('setTimeScale(8)');
    await dbg('cast(0.8, 10)');
    const hk3 = await dbg(`hookFish("${attempt % 2 ? 'smallmouth_bass' : 'largemouth_bass'}", 2.2)`);
    assert(hk3 && (await L.state()) === 'fighting', `fish on for the pull-out test (${hk3 && hk3.speciesId})`);
    await dbg('setDrag(0.7)');
    await dbg('setRod(0, 0)'); // rod low, pointed at the fish: no cushion
    await dbg('setReeling(true)');
    await dbg('setTimeScale(3)');
    s = await stats();
    const g2 = s.time;
    let minHold = 1;
    while (s.state === 'fighting' && s.time - g2 < 240) {
      const t = s.time;
      s = await L.waitFor((x) => x.time !== t || x.state !== 'fighting', { gameS: 60, every: 150, label: 'fight clock' });
      minHold = Math.min(minHold, (await dbg('fight')).hookHold);
    }
    const out = (await dbg('fight')).lastOut;
    log(T(), `pull-out attempt ${attempt + 1}: ${s.state}, outcome ${JSON.stringify(out)}, hook hold down to ${minHold.toFixed(2)}`);
    await dbg('setReeling(false)');
    await dbg('setRod(null)');
    if (out && out.type === 'escape' && out.pulled) pulled = out;
    else if (s.state === 'fighting') await dbg('landNow()');
    if ((await L.state()) === 'caught') await dbg('release()');
    await dbg('setLure("bobber")'); // re-tie back to READY
  }
  assert(pulled, 'the hook pulled out on a stiff rod (head shakes / jumps on a tight line)');
  const lastEsc = (await dbg('events()')).filter((e) => e.type === 'escaped').slice(-1)[0];
  assert(lastEsc && lastEsc.reason === 'headshake', `escaped event for the pull-out (${lastEsc && lastEsc.reason})`);
  await dbg('setDrag(0.45)');
  await expectNoNaN();
  log(T(), 'final', JSON.stringify(await stats()));
};
