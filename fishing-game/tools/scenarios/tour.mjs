// Tour: the lake from the dock at dawn, noon, dusk and night, looking out, at the weedy cove (left),
// at the rocky point (right) and down at the deck and the shallow bed beside the dock.
//   node tools/harness.mjs --scenario tools/scenarios/tour.mjs --out out/tour --size 960x540
import { makeLib } from './lib.mjs';

const TIMES = [
  ['dawn', 6 + 10 / 60],
  ['noon', 12.5],
  ['dusk', 19.75],
  ['night', 22.5],
];
const VIEWS = [
  ['out', 0, -6],
  ['cove', -78, -9],
  ['point', 58, -7],
  ['down', 8, -52],
];

export default async (h) => {
  const { log } = h;
  const L = makeLib(h);
  const { dbg, still, assert, T } = L;
  await dbg('skipTitle()');
  await dbg('setQuality("high")');
  await dbg('setPixelRatio(1)');
  await h.page.evaluate(() => {
    // screenshots of the scene, not the HUD
    document.getElementById('hud').style.visibility = 'hidden';
  });
  // TOUR_TIMES=dawn,noon TOUR_VIEWS=down re-shoot a subset
  const times = process.env.TOUR_TIMES ? process.env.TOUR_TIMES.split(',') : null;
  const views = process.env.TOUR_VIEWS ? process.env.TOUR_VIEWS.split(',') : null;
  for (const [name, hours] of TIMES) {
    if (times && !times.includes(name)) continue;
    await dbg(`setTime(${hours})`);
    // let the lake settle into this hour's breeze (the wave amplitude eases over a few game seconds): run
    // ~10 s of game time fast at low resolution
    await dbg('setQuality("low")');
    await dbg('setPixelRatio(0.5)');
    await dbg('setTimeScale(20)');
    await L.waitFor(() => true, { gameS: 1 });
    const t0 = (await L.stats()).time;
    await L.waitFor((s) => s.time - t0 >= 10, { gameS: 30, label: 'waves settle' });
    await dbg(`setTime(${hours})`);
    await dbg('setQuality("high")');
    for (const [view, yaw, pitch] of VIEWS) {
      if (views && !views.includes(view)) continue;
      await dbg(`look(${yaw}, ${pitch})`);
      await dbg('setTimeScale(1)');
      await L.waitFrames(2);
      await still(`${name}-${view}`, { pr: 1, frames: 1 });
      const s = await L.stats();
      log(T(), name, view, JSON.stringify({ calls: s.drawCalls, tris: s.triangles, passes: s.passes, hours: s.hours }));
    }
    // the catch showcase at the exposure extremes (bright noon, night with a headlamp key light)
    if ((name === 'noon' || name === 'night') && (!views || views.includes('catch'))) {
      await dbg('look(0, -6)');
      await dbg(`hookFish("${name === 'noon' ? 'smallmouth_bass' : 'channel_catfish'}", ${name === 'noon' ? 1.4 : 3.2})`);
      await dbg('landNow()');
      await h.page.evaluate(() => {
        document.getElementById('hud').style.visibility = '';
      });
      await L.waitFrames(2);
      await still(`${name}-catch`, { pr: 1, frames: 2 });
      await dbg('release()');
      await h.page.evaluate(() => {
        document.getElementById('hud').style.visibility = 'hidden';
      });
      const c = await L.stats();
      assert(c.state === 'ready', 'release after the showcase -> READY');
      assert(await L.g('document.getElementById("catch").hidden'), 'catch card closed after release');
    }
  }
  await h.page.evaluate(() => {
    document.getElementById('hud').style.visibility = '';
  });
  await L.expectNoNaN();
  const s = await L.stats();
  assert(s.drawCalls < 400, `draw calls in budget-ish range (${s.drawCalls})`);
};
