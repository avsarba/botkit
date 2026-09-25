// Line break and a thrown hook:
//  1) a 6 kg northern pike on a locked-down drag (setDrag(1)) with continuous cranking through its
//     runs: the drag lag + cranking push the tension past 12 lb -> SNAPPED -> re-tie -> READY.
//  2) a largemouth given slack line: slack + head shakes throw the hook -> ESCAPED -> reel in -> READY.
//   node tools/harness.mjs --scenario tools/scenarios/snap.mjs --out out/snap --size 960x540
import { makeLib } from './lib.mjs';

export default async (h) => {
  const { log, sleep } = h;
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
  const end = Date.now() + 900 * 1000;
  while (s.state === 'fighting' && Date.now() < end) {
    maxT = Math.max(maxT, s.tensionN);
    if (!shot && s.tensionN > 38) {
      shot = true;
      await pretty('pike-heavy');
      await dbg('setTimeScale(4)');
    }
    await sleep(250);
    s = await stats();
  }
  log(T(), 'pike fight ended in', s.state, 'max tension seen', maxT.toFixed(1));
  const snapEv = (await dbg('events()')).filter((e) => e.type === 'tackle:snap');
  assert(s.state === 'snapped' || snapEv.length > 0, `line snapped (state ${s.state})`);
  await pretty('snapped');
  await dbg('setTimeScale(4)');
  const r = await waitState('ready', { timeoutS: 300 });
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
  for (let i = 0; i < 600; i++) {
    s = await stats();
    if (s.state !== 'fighting') break;
    // the angler drops the rod and feeds line whenever it comes tight: the line stays slack
    if (s.tensionN > 0.3) await dbg('slack(2)');
    await sleep(200);
  }
  s = await stats();
  esc = (await dbg('events()')).filter((e) => e.type === 'escaped').slice(-1)[0];
  log(T(), 'slack fight ended in', s.state, JSON.stringify(esc));
  assert(esc && (esc.reason === 'headshake' || esc.reason === 'slack'), `hook thrown on slack line (${esc && esc.reason})`);
  await pretty('escaped');
  await dbg('setTimeScale(8)');
  await dbg('setReeling(true)');
  const r2 = await waitState('ready', { timeoutS: 400 });
  await dbg('setReeling(false)');
  assert(r2.state === 'ready', 'lure reeled home -> READY');
  await expectNoNaN();
  log(T(), 'final', JSON.stringify(await stats()));
};
