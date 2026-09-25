// Boot: the title paints before the lake is ready (Start disabled with progress), the live lake renders
// behind it, the real Start button starts the game, the HUD appears and the first frames are sane.
//   node tools/harness.mjs --scenario tools/scenarios/boot.mjs --out out/boot --size 960x540
import { makeLib } from './lib.mjs';

export default async (h) => {
  const { page, log, sleep } = h;
  const L = makeLib(h);
  const { dbg, stats, assert, T } = L;

  // the static title is in the template: it is up immediately, Start disabled while building
  const early = await page.evaluate(() => {
    const b = document.getElementById('btn-start');
    return { title: !document.getElementById('title').hidden, disabled: !!(b && b.disabled), text: b && b.textContent };
  });
  log(T(), 'early title', JSON.stringify(early));
  assert(early.title, 'title visible at load');
  assert(early.disabled, 'Start disabled while the lake is prepared');
  await h.shot('01-loading');

  // wait until the button says Start
  let text = '';
  for (let i = 0; i < 600; i++) {
    text = await page.evaluate(() => document.getElementById('btn-start').textContent);
    if (text === 'Start fishing') break;
    await sleep(250);
  }
  log(T(), 'ready:', text, JSON.stringify(await L.g('window.__game.buildTimes')));
  assert(text === 'Start fishing', 'Start enabled once the lake is ready');
  assert((await L.state()) === 'title', 'state TITLE behind the title card');

  // the live lake: a couple of frames rendered, camera drifting slowly
  const a = await stats();
  await L.waitFrames(3);
  const b = await stats();
  log(T(), 'title stats', JSON.stringify({ fps: b.fps, drawCalls: b.drawCalls, triangles: b.triangles, view: b.view }));
  assert(b.drawCalls > 20 && b.triangles > 10000, 'the lake is rendering behind the title');
  assert(b.time > a.time, 'title scene is live (time advances)');
  assert(Math.abs(b.hours - 6.1) < 0.01, 'dawn on the title (time of day held)');
  await h.shot('02-title');

  // click the real Start button
  await page.click('#btn-start');
  await L.waitFrames(2);
  const s = await stats();
  const ui = await page.evaluate(() => ({ title: !document.getElementById('title').hidden, hud: !document.getElementById('hud').hidden }));
  log(T(), 'after start', s.state, JSON.stringify(ui));
  assert(s.state === 'ready', 'Start button -> READY');
  assert(!ui.title && ui.hud, 'title hidden, HUD shown');
  const audio = await L.g('(() => { const a = window.__game.debug.modules().audio; return a && a.started; })()');
  assert(audio, 'audio started from the Start click');
  const h0 = await L.g('window.__game.frame.hours');
  await L.waitFrames(4);
  const s2 = await stats();
  const h1 = await L.g('window.__game.frame.hours');
  assert(h1 > h0, `time of day advances after Start (${h0.toFixed(4)} -> ${h1.toFixed(4)})`);
  await L.expectNoNaN();
  await h.shot('03-ready');
  log(T(), 'stats', JSON.stringify(s2));

  // ---- real input: pointer edge-steering (no pointer lock), dead zone in the middle
  const vp = page.viewportSize();
  await page.mouse.move(vp.width * 0.5, vp.height * 0.5);
  await L.waitFrames(3);
  const yawC0 = (await stats()).view.yawDeg;
  await L.waitFrames(3);
  const yawC1 = (await stats()).view.yawDeg;
  assert(Math.abs(yawC1 - yawC0) < 0.5, `pointer in the dead zone holds the view (${yawC0} -> ${yawC1})`);
  // (the lower right is the tension gauge: over HUD panels the view holds still)
  await page.mouse.move(vp.width * 0.97, vp.height * 0.3, { steps: 4 });
  await L.waitFrames(6);
  const yawR = (await stats()).view.yawDeg;
  assert(yawR > yawC1 + 2, `pointer at the right edge turns the view right (${yawC1} -> ${yawR})`);
  await page.mouse.move(vp.width * 0.5, vp.height * 0.5, { steps: 4 });
  await L.waitFrames(4);

  // ---- keyboard: D turns right, A left
  const k0 = (await stats()).view.yawDeg;
  await page.keyboard.down('KeyA');
  await L.waitFrames(5);
  await page.keyboard.up('KeyA');
  const k1 = (await stats()).view.yawDeg;
  assert(k1 < k0 - 2, `A turns left (${k0} -> ${k1})`);

  // ---- hold the left button on the canvas to charge, release to cast
  await dbg('setTimeScale(6)');
  await page.mouse.move(vp.width * 0.55, vp.height * 0.45);
  await page.mouse.down();
  let c = await stats();
  for (let i = 0; i < 60 && !(c.state === 'charging' && c.input.charge01 > 0.5); i++) {
    await sleep(200);
    c = await stats();
  }
  assert(c.state === 'charging' && c.input.charge01 > 0.5, `holding the mouse charges the cast (${c.state} ${c.input.charge01})`);
  await page.mouse.up();
  await L.waitFrames(1);
  c = await stats();
  assert(c.state === 'casting' || c.state === 'waiting', `releasing the mouse casts (${c.state})`);
  c = await L.waitState('waiting', { timeoutS: 200 });
  log(T(), 'mouse cast landed', JSON.stringify(c.lure));
  assert(c.lure.distanceM > 6, 'the cast went out over the water');

  // ---- hold Space to reel the lure in
  await dbg('setTimeScale(12)');
  const line0 = c.lineOutM;
  await page.keyboard.down('Space');
  await L.waitFrames(4);
  const c2 = await stats();
  assert(c2.input.reeling && c2.lineOutM < line0, `holding Space reels (${line0} -> ${c2.lineOutM})`);
  await L.waitState('ready', { timeoutS: 400 });
  await page.keyboard.up('Space');
  log(T(), 'reeled home -> READY');

  // ---- lure keys, drag keys, mute, units
  await page.keyboard.press('Digit3');
  await L.waitFrames(1);
  assert((await stats()).lure.id === 'crankbait', 'key 3 ties on the crankbait');
  const d0 = (await stats()).dragN;
  await page.keyboard.press('BracketRight');
  await L.waitFrames(1);
  assert((await stats()).dragN > d0, '] tightens the drag');
  await page.keyboard.press('KeyM');
  await L.waitFrames(1);
  assert(await L.g('window.__game.debug.modules().audio.muted'), 'M mutes');
  await page.keyboard.press('KeyM');
  await dbg('setTimeScale(1)');
  await L.expectNoNaN();
};
