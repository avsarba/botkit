// Phone with touch (390x844 portrait by default; also run it at 667x375 / 640x360 landscape). Title, Start
// by tap, an aim drag on the canvas, a cast by holding the big touch button (with the landing ring on the
// water), the Slow chip, a hookset tap, then the catch card: a bottom sheet with the fish framed above it
// in portrait, a side panel with the fish beside it on short landscape phones.
//   node tools/harness.mjs --scenario tools/scenarios/mobile.mjs --out out/mobile --mobile
//   node tools/harness.mjs --scenario tools/scenarios/mobile.mjs --out out/mobile-667 --mobile --size 667x375
import { makeLib } from './lib.mjs';

export default async (h) => {
  const { page, log } = h;
  const L = makeLib(h);
  const { dbg, stats, still, assert, T } = L;
  const vp = page.viewportSize();
  const W = vp.width;
  const H = vp.height;
  const landscape = W > H;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const tapEl = async (sel) => {
    const b = await page.locator(sel).boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  };

  await L.waitStartEnabled();
  await L.waitFrames(2);
  await h.shot('01-title');
  await tapEl('#btn-start');
  await L.waitFrames(1);
  assert((await L.state()) === 'ready', 'tap Start -> READY');
  await dbg('setQuality("high")');
  await dbg('setPixelRatio(1)');
  const input = await page.evaluate(() => document.getElementById('ui').dataset.input);
  assert(input === 'touch', `touch layout active (${input})`);
  await L.waitFrames(2);
  await h.shot('02-ready');

  // aim: drag right across the open lake (look right)
  const y0 = (await stats()).view.yawDeg;
  const dx0 = W * 0.38;
  const dy0 = H * 0.42;
  await touch('touchStart', dx0, dy0);
  for (let k = 1; k <= 6; k++) {
    await touch('touchMove', dx0 + k * W * 0.045, dy0);
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
  let s = await L.waitFor((x) => x.state === 'charging' && x.input.charge01 > 0.55, { gameS: 10, every: 100, label: 'charge > 0.55' });
  assert(s.state === 'charging', `holding the touch button charges the cast (${s.input.charge01.toFixed(2)})`);
  await dbg('setTimeScale(1)');
  await dbg('setPixelRatio(1)');
  await L.waitFrames(2);
  const ring = await L.g('(() => { const r = window.__game.debug.modules().scene.getObjectByName("cast-aim-ring"); return r ? { visible: r.visible, opacity: r.material.opacity, p: r.position.toArray().map((v) => +v.toFixed(2)) } : null; })()');
  log(T(), 'aim ring', JSON.stringify(ring));
  assert(ring && ring.visible && ring.opacity > 0.05, 'landing ring on the water while charging');
  await h.shot('03-charging');
  await touch('touchEnd');
  await L.waitFrames(1);
  s = await stats();
  assert(s.state === 'casting' || s.state === 'waiting', `release casts (${s.state})`);
  await dbg('setTimeScale(8)');
  await dbg('setPixelRatio(0.5)');
  s = await L.waitState('waiting', { gameS: 30 });
  log(T(), 'lure out', JSON.stringify(s.lure));
  assert(!(await L.g('window.__game.debug.modules().scene.getObjectByName("cast-aim-ring").visible')), 'landing ring gone after the cast');

  // the Slow chip (touch has no Shift): a slow retrieve while it is on
  await dbg('setTimeScale(1)');
  const slowShown = await page.evaluate(() => {
    const b = document.getElementById('btn-slow');
    return !!b && getComputedStyle(b).display !== 'none';
  });
  assert(slowShown, 'Slow chip shown beside the big button');
  await tapEl('#btn-slow');
  await L.waitFrames(1);
  assert((await page.evaluate(() => document.getElementById('btn-slow').getAttribute('aria-pressed'))) === 'true', 'Slow chip toggles on');
  await dbg('setReeling(true)');
  s = await L.waitFor((x) => x.input.reelSpeed01 > 0.4, { gameS: 5, label: 'slow reel speed' });
  await L.waitFrames(2);
  s = await stats();
  log(T(), 'slow reel speed', s.input.reelSpeed01);
  assert(s.input.reelSpeed01 > 0.4 && s.input.reelSpeed01 < 0.6, `Slow chip: half-speed retrieve (${s.input.reelSpeed01.toFixed(2)})`);
  await dbg('setReeling(false)');
  await still('04-waiting', { pr: 1, frames: 1 });
  await tapEl('#btn-slow');
  await L.waitFrames(1);
  assert((await page.evaluate(() => document.getElementById('btn-slow').getAttribute('aria-pressed'))) === 'false', 'Slow chip toggles off');

  // a bite, hookset by tapping the canvas, then the catch card
  await dbg('setPixelRatio(0.5)');
  await dbg('setTimeScale(2)');
  await dbg('forceBite("bluegill")');
  await L.waitState('strike', { gameS: 60, every: 100 });
  await touch('touchStart', W * 0.5, H * 0.3);
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
  const framing = await L.g('window.__game.debug.modules().showcase.framing');
  log(T(), 'card box', JSON.stringify(card), 'fish framing', JSON.stringify(framing));
  if (landscape && H <= 520) {
    assert(card && card.x > W * 0.4 && card.height > H * 0.6, 'short landscape: the catch card is a side panel');
    assert(framing.mode === 'side' && framing.cx + framing.spanPx / 2 <= card.x + 4, 'the fish is framed beside the card');
  } else {
    assert(card && card.y > H * 0.3, 'catch card is a bottom sheet');
    assert(framing.mode === 'sheet' && framing.cy < card.y, 'the fish is framed above the sheet');
  }
  await tapEl('#btn-keep');
  await L.waitFrames(1);
  assert((await L.state()) === 'ready', 'Keep -> READY');
  await L.expectNoNaN();
};
