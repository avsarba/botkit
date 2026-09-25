// Phone: 390x844 portrait with touch. Title, Start by tap, a cast by holding the big touch button,
// an aim drag on the canvas, a hookset tap, then the catch card as a bottom sheet with the fish
// framed in the top part of the screen.
//   node tools/harness.mjs --scenario tools/scenarios/mobile.mjs --out out/mobile --mobile
import { makeLib } from './lib.mjs';

export default async (h) => {
  const { page, log, sleep } = h;
  const L = makeLib(h);
  const { dbg, stats, still, assert, T } = L;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });

  for (let i = 0; i < 600; i++) {
    const t = await page.evaluate(() => document.getElementById('btn-start').textContent);
    if (t === 'Start fishing') break;
    await sleep(250);
  }
  await L.waitFrames(2);
  await h.shot('01-title');
  const tb = await page.locator('#btn-start').boundingBox();
  await page.touchscreen.tap(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await L.waitFrames(1);
  assert((await L.state()) === 'ready', 'tap Start -> READY');
  await dbg('setQuality("high")');
  await dbg('setPixelRatio(1)');
  const input = await page.evaluate(() => document.getElementById('ui').dataset.input);
  assert(input === 'touch', `touch layout active (${input})`);
  await L.waitFrames(2);
  await h.shot('02-ready');

  // aim: drag right across the canvas (look right)
  const y0 = (await stats()).view.yawDeg;
  await touch('touchStart', 150, 380);
  for (let k = 1; k <= 6; k++) {
    await touch('touchMove', 150 + k * 18, 380);
    await L.waitFrames(1);
  }
  await touch('touchEnd');
  await L.waitFrames(2);
  const y1 = (await stats()).view.yawDeg;
  log(T(), 'yaw after drag', y0, '->', y1);
  assert(y1 > y0 + 5, 'dragging right turns the view right');

  // cast: hold the big button until the power meter is well up, then let go
  const ab = await page.locator('#action').boundingBox();
  const ax = ab.x + ab.width / 2;
  const ay = ab.y + ab.height / 2;
  await dbg('setTimeScale(6)');
  await dbg('setPixelRatio(0.5)');
  await touch('touchStart', ax, ay);
  let s = await stats();
  for (let i = 0; i < 200 && !(s.state === 'charging' && s.input.charge01 > 0.55); i++) {
    await sleep(150);
    s = await stats();
  }
  assert(s.state === 'charging', `holding the touch button charges the cast (${s.input.charge01.toFixed(2)})`);
  await dbg('setTimeScale(1)');
  await dbg('setPixelRatio(1)');
  await L.waitFrames(1);
  await h.shot('03-charging');
  await touch('touchEnd');
  await L.waitFrames(1);
  s = await stats();
  assert(s.state === 'casting' || s.state === 'waiting', `release casts (${s.state})`);
  await dbg('setTimeScale(8)');
  await dbg('setPixelRatio(0.5)');
  s = await L.waitState('waiting', { timeoutS: 300 });
  log(T(), 'lure out', JSON.stringify(s.lure));
  await still('04-waiting', { pr: 1, frames: 1 });

  // a bite, hookset by tapping the canvas, then the catch card
  await dbg('setPixelRatio(0.5)');
  await dbg('setTimeScale(2)');
  await dbg('forceBite("bluegill")');
  await L.waitState('strike', { timeoutS: 300, every: 150 });
  await touch('touchStart', 195, 300);
  await touch('touchEnd');
  await L.waitFrames(1);
  s = await stats();
  assert(s.state === 'fighting', `tap on a bite sets the hook (${s.state})`);
  await still('05-fight', { pr: 1, frames: 1 });
  await dbg('landNow()');
  await L.waitFrames(3);
  assert((await L.state()) === 'caught', 'CAUGHT');
  await still('06-catch', { pr: 1, frames: 3 });
  const card = await page.locator('#catch').boundingBox();
  log(T(), 'card box', JSON.stringify(card));
  assert(card && card.y > 844 * 0.3, 'catch card is a bottom sheet');
  const kb = await page.locator('#btn-keep').boundingBox();
  await page.touchscreen.tap(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await L.waitFrames(1);
  assert((await L.state()) === 'ready', 'Keep -> READY');
  await L.expectNoNaN();
};
