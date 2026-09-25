// Spot checks of review fixes in the real build (960x540): water without white/black blocks, the dusk glint
// (no clipped white, none once the sun is behind the treeline), the prompt pill clear of the float and a
// hooked fish, the STRIKE cue above the float, the line at dusk / night and in READY, the float's nibble dip
// at ~20 m, the cast landing ring, the rig hidden while CAUGHT, the showcase framed beside the card and
// sized by real length, Space after clicking a HUD button then the lake, the pause menu's quality buttons,
// and the rod blank at night.
//   node tools/harness.mjs --scenario tools/scenarios/spot.mjs --out out/spot --size 960x540
//   SPOT=water,glint re-runs a subset
import { makeLib } from './lib.mjs';

export default async (h) => {
  const { page, log } = h;
  const L = makeLib(h);
  const { dbg, stats, still, assert, T, g } = L;
  const only = process.env.SPOT ? process.env.SPOT.split(',') : null;
  const want = (k) => !only || only.includes(k);
  const vp = page.viewportSize();
  const fast = async () => {
    await dbg('setQuality("low")');
    await dbg('setPixelRatio(0.5)');
  };
  const pretty = async (name, frames = 2) => {
    await dbg('setQuality("high")');
    return still(name, { pr: 1, frames, scale: 1 });
  };
  const hideHud = (hide) => page.evaluate((v) => (document.getElementById('hud').style.visibility = v ? 'hidden' : ''), hide);
  // Count clipped-white / black pixels in a screenshot region (decoded in the page: img-src allows data:).
  async function pixelStats(file, region) {
    const { readFile } = await import('node:fs/promises');
    const b64 = (await readFile(file)).toString('base64');
    return page.evaluate(
      async ({ b64, region }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const [rx, ry, rw, rh] = region.map((v, i) => Math.round(v * (i % 2 ? img.height : img.width)));
        const d = x.getImageData(rx, ry, rw, rh).data;
        let white = 0;
        let black = 0;
        let max = 0;
        for (let i = 0; i < d.length; i += 4) {
          const m = Math.min(d[i], d[i + 1], d[i + 2]);
          const M = Math.max(d[i], d[i + 1], d[i + 2]);
          if (m >= 253) white++;
          if (M <= 2) black++;
          if (m > max) max = m;
        }
        return { white, black, n: d.length / 4, maxMin: max };
      },
      { b64, region }
    );
  }
  // world point -> CSS px
  const project = (expr) =>
    g(`(() => { const p = (${expr}); if (!p) return null; const cam = window.__game.frame.camera; const v = p.clone().project(cam); const c = window.__game.debug.modules().renderer.domElement; return v.z < 1 ? { x: (v.x + 1) / 2 * c.clientWidth, y: (1 - v.y) / 2 * c.clientHeight } : null; })()`);
  // layout box of an element that is shown (a prompt faded to quiet still counts: it can come back)
  const rectOf = (sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e || e.hidden || e.closest('[hidden]')) return null;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    const r = e.getBoundingClientRect();
    return r.width > 0 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
  }, sel);
  // Freeze the simulation (pause without the pause card) so a transient moment can be screenshot even when a
  // software-rendered frame takes seconds; frozen(false) resumes.
  const frozen = async (on) => {
    await dbg(`pause(${on})`);
    await page.evaluate((v) => (document.getElementById('pause-modal').style.display = v ? 'none' : ''), on);
  };
  const inside = (p, r, m = 4) => !!(p && r && p.x > r.l - m && p.x < r.r + m && p.y > r.t - m && p.y < r.b + m);
  const floatExpr = 'window.__game.debug.modules().tackle.debug.models.bobber.object.getWorldPosition(window.__game.debug.modules().tackle.getRodTip())';

  await dbg('skipTitle()');
  await fast();

  // ---- water: no white / black blocks (noon toward yaw 55, 9:00 toward yaw -12)
  if (want('water')) {
    await hideHud(true);
    for (const [name, hours, yaw] of [['water-noon-y55', 12.5, 55], ['water-0900-ym12', 9, -12]]) {
      await dbg(`setTime(${hours})`);
      await dbg(`look(${yaw}, -6)`);
      const f = await pretty(name, 2);
      const px = await pixelStats(f, [0, 0.45, 1, 0.55]);
      log(T(), name, JSON.stringify(px));
      assert(px.white < px.n * 0.002 && px.black < px.n * 0.002, `${name}: no clipped white / black blocks in the water (${px.white} white, ${px.black} black)`);
    }
    await hideHud(false);
    await fast();
  }

  // ---- dusk glint: never pure white; gone once the sun is behind the treeline
  if (want('glint')) {
    await hideHud(true);
    const env = 'window.__game.debug.modules().env';
    const samples = [];
    for (let hh = 18.8; hh <= 20.4; hh += 0.2) {
      await dbg(`setTime(${hh.toFixed(2)})`);
      samples.push(await g(`(() => { const e = ${env}; const d = e.sunDirection; return { h: ${hh.toFixed(2)}, vis: +e.sunVisibility.toFixed(3), I: +e.sunIntensity.toFixed(3), el: +e.sunElevationDeg.toFixed(2), yaw: +(-Math.atan2(-d.x, -d.z) * 180 / Math.PI).toFixed(1) }; })()`));
    }
    log(T(), 'sun at dusk', JSON.stringify(samples));
    const lit = samples.filter((s) => s.vis > 0.5 && s.el > 0).slice(-1)[0];
    const hidden = samples.find((s) => s.vis < 0.02 && s.el > -1);
    for (const [name, s] of [['glint-dusk-lit', lit], ['glint-dusk-behind-trees', hidden]]) {
      if (!s) {
        log(T(), `  (no sample for ${name})`);
        continue;
      }
      await dbg(`setTime(${s.h})`);
      const yaw = Math.max(-95, Math.min(95, s.yaw)); // (s.yaw is already in look() degrees: + = right)
      await dbg(`look(${yaw}, -4)`);
      const f = await pretty(name, 2);
      const px = await pixelStats(f, [0, 0.45, 1, 0.55]);
      log(T(), name, JSON.stringify({ ...s, lookYaw: yaw, px }));
      assert(px.white < 12, `${name}: no clipped pure-white glint (${px.white} px)`);
      if (name === 'glint-dusk-behind-trees') {
        const sunI = await g(`${env}.sunIntensity`);
        assert(sunI < 0.05 * (lit ? lit.I : 1) + 0.02, `sun behind the treeline: key light off the lake (${sunI})`);
      }
    }
    await hideHud(false);
    await fast();
  }

  // ---- READY: the line near the rod (no bright leader stripe), the rod blank at night
  if (want('ready')) {
    await dbg('setLure("bobber")');
    for (const [name, hours] of [['ready-dawn', 6.2], ['ready-noon', 12.5], ['ready-night', 22.5]]) {
      await dbg(`setTime(${hours})`);
      await dbg('look(0, -7)');
      await pretty(name, 3);
    }
    await fast();
  }

  // ---- the cast landing ring while charging
  if (want('ring')) {
    await dbg('setTime(7.5)');
    await dbg('look(-5, -7)');
    await dbg('setLure("spinner")');
    await dbg('setTimeScale(1)');
    await dbg('action(true)'); // hold: CHARGING
    await L.waitFor((s) => s.state === 'charging' && s.input.charge01 > 0.6, { gameS: 10, every: 100, label: 'charge' });
    await dbg('setQuality("high")');
    await dbg('setPixelRatio(1)');
    await L.waitFrames(2);
    const ring = await g('(() => { const r = window.__game.debug.modules().scene.getObjectByName("cast-aim-ring"); return { visible: r.visible, opacity: +r.material.opacity.toFixed(3), p: r.position.toArray().map((v) => +v.toFixed(2)), s: +r.scale.x.toFixed(2) }; })()');
    const pred = await g('(() => { const t = window.__game.debug.modules().tackle; const p = t.predictLanding(window.__game.frame.input.charge01); return p ? p.toArray().map((v) => +v.toFixed(2)) : null; })()');
    log(T(), 'aim ring', JSON.stringify(ring), 'predicted', JSON.stringify(pred), 'charge', (await stats()).input.charge01);
    assert(ring.visible && ring.opacity > 0.1, 'faint landing ring while charging');
    await h.shot('ring-charging');
    // release (cast) and the prediction for exactly the released charge, in one step
    const rel = await g('(() => { const c = window.__game.frame.input.charge01; const p = window.__game.debug.modules().tackle.predictLanding(c); window.__game.debug.action(false); return { c, p: p ? p.toArray() : null }; })()');
    await fast();
    await dbg('setTimeScale(8)');
    const w = await L.waitState('waiting', { gameS: 30 });
    const dx = w.lure.position[0] - rel.p[0];
    const dz = w.lure.position[2] - rel.p[2];
    log(T(), 'landed at', JSON.stringify(w.lure.position), 'predicted', JSON.stringify(rel.p.map((v) => +v.toFixed(2))), 'miss', Math.hypot(dx, dz).toFixed(2), 'm', 'charge', rel.c.toFixed(3));
    assert(Math.hypot(dx, dz) < Math.max(3, 0.15 * w.lure.distanceM), `the lure came down near the ring (${Math.hypot(dx, dz).toFixed(2)} m)`);
    assert(!(await g('window.__game.debug.modules().scene.getObjectByName("cast-aim-ring").visible')), 'ring gone after the cast');
    await dbg('setLure("bobber")');
  }

  // ---- float at ~20 m: the prompt pill stays clear of it, the nibble dip reads, STRIKE above it
  if (want('float')) {
    await dbg('setTime(6.3)');
    await dbg('setLure("bobber")');
    await dbg('setTimeScale(8)');
    const landed = await dbg('cast(0.72, -8)');
    log(T(), 'float cast', JSON.stringify(landed));
    await dbg('setTimeScale(1)');
    await dbg('look(-8, -7)');
    await dbg('setQuality("high")');
    await dbg('setPixelRatio(1)');
    await L.waitFrames(3);
    const s = await stats();
    const fp = await project(floatExpr);
    const pr = await rectOf('#prompt');
    log(T(), 'float', JSON.stringify(s.lure.bobber), 'px', JSON.stringify(fp), 'prompt', JSON.stringify(pr), 'dist', s.lure.distanceM);
    assert(fp && !inside(fp, pr), 'the prompt pill does not cover the float');
    await h.shot('float-waiting');
    // nibble dip: sample the drawn float for a few frames after a tap
    const tk = 'window.__game.debug.modules().tackle';
    const ys = [];
    const base = await project(floatExpr);
    await g(`${tk}.nibble(0.5)`);
    for (let k = 0; k < 6; k++) {
      await L.waitFrames(1);
      const p = await project(floatExpr);
      ys.push(p ? +(p.y - base.y).toFixed(2) : null);
    }
    // the same dip, frozen on its first frame for a screenshot
    await L.waitFrames(20);
    await g(`${tk}.nibble(0.5)`);
    await L.waitFrames(1);
    await frozen(true);
    await dbg('render()');
    await L.waitFrames(2);
    await h.shot('float-nibble');
    await frozen(false);
    log(T(), 'nibble dip (px below rest, per frame)', JSON.stringify(ys));
    assert(Math.max(...ys.map((v) => Math.abs(v || 0))) >= 1.5, `the nibble dip is visible at ${s.lure.distanceM} m (${Math.max(...ys.map((v) => Math.abs(v || 0)))} px)`);
    // strike cue above the float
    await dbg('forceBite("yellow_perch")');
    await L.waitState('strike', { gameS: 60, every: 100 });
    // the cue lasts ~1.2 real seconds, less than one software-rendered frame: freeze, then show it again
    await frozen(true);
    await g('window.__game.debug.modules().ui.strikeCue({ reelSet: false })');
    const sr = await rectOf('#strike');
    const fp2 = await project(floatExpr);
    await h.shot('float-strike');
    log(T(), 'strike cue', JSON.stringify(sr), 'float px', JSON.stringify(fp2), 'sub-line', await page.evaluate(() => document.getElementById('strike-sub').textContent));
    await g('window.__game.debug.modules().ui.strikeCue({ reelSet: true })');
    const sub = await page.evaluate(() => document.getElementById('strike-sub').textContent);
    assert(sub === 'Keep reeling!', `reel set: the STRIKE sub-line says "${sub}"`);
    await frozen(false);
    assert(sr && fp2 && sr.b < fp2.y - 8, 'the STRIKE cue sits above the float');
    assert(!inside(fp2, await rectOf('#prompt')), 'no prompt over the float on a bite');
    await dbg('strike()');
    // a hooked fish: the prompt stays clear of it
    let fishCovered = 0;
    let samples = 0;
    await fast();
    await dbg('setTimeScale(2)');
    for (let k = 0; k < 12 && (await L.state()) === 'fighting'; k++) {
      const hp = await project('window.__game.frame.hooked && window.__game.frame.hooked.position.clone().setY(Math.max(window.__game.frame.hooked.position.y, 0))');
      const r = await rectOf('#prompt');
      samples++;
      if (inside(hp, r, 0)) fishCovered++;
      await L.waitFrames(2);
    }
    log(T(), 'fight: prompt over the fish in', fishCovered, 'of', samples, 'samples');
    assert(fishCovered === 0, 'the prompt pill never covers the hooked fish');
    await dbg('setTimeScale(1)');
  }

  // ---- line at dusk and night with the float out
  if (want('line')) {
    for (const [name, hours] of [['line-dusk', 19.75], ['line-night', 22.5]]) {
      if ((await L.state()) !== 'waiting') {
        await fast();
        await dbg('setLure("bobber")');
        await dbg('setTimeScale(8)');
        await dbg('cast(0.7, -6)');
      }
      await dbg(`setTime(${hours})`);
      await dbg('look(-4, -8)');
      await pretty(name, 3);
    }
    await fast();
  }

  // ---- CAUGHT: rig hidden, the showcase fish beside the card and sized by its real length
  if (want('showcase')) {
    await dbg('setTime(10)');
    const spans = {};
    for (const [sp, kg] of [['bluegill', 0.2], ['northern_pike', 5]]) {
      await dbg('look(0, -6)');
      await dbg(`hookFish("${sp}", ${kg})`);
      await dbg('landNow()');
      await dbg('setQuality("high")');
      await dbg('setPixelRatio(1)');
      await L.waitFrames(3);
      const rig = await g('(() => { const t = window.__game.debug.modules().tackle; const vis = []; window.__game.debug.modules().scene.traverse((o) => { if (o.visible && (o.name === "fishing-line" || o.name === "fishing-line-tail")) vis.push(o.name); }); for (const [k, m] of Object.entries(t.debug.models)) { for (const o of [m.object, m.bait, m.shot]) if (o && o.visible) vis.push(k); } return vis; })()');
      const fr = await g('window.__game.debug.modules().showcase.framing');
      const card = await rectOf('#catch');
      log(T(), sp, 'framing', JSON.stringify(fr), 'card', JSON.stringify(card), 'visible rig parts', JSON.stringify(rig));
      assert(rig.length === 0, `${sp}: line / float / lure hidden during CAUGHT`);
      assert(fr.ready && card && fr.cx + fr.spanPx / 2 <= card.l + 2, `${sp}: fish framed beside the card`);
      spans[sp] = fr.spanPx;
      await h.shot(`showcase-${sp}`);
      await dbg('release()');
      await fast();
    }
    assert(spans.northern_pike > spans.bluegill * 1.6, `sized by real length (pike ${spans.northern_pike.toFixed(0)} px vs bluegill ${spans.bluegill.toFixed(0)} px)`);
  }

  // ---- Space works after clicking a HUD button, then the lake
  if (want('space')) {
    await dbg('setLure("bobber")');
    await dbg('setTimeScale(1)');
    assert((await L.state()) === 'ready', 'READY');
    await page.click('#lures .lure[data-lure="spinner"]', { timeout: 900000 });
    await L.waitFrames(1);
    await page.mouse.click(vp.width * 0.5, vp.height * 0.42);
    await L.waitFrames(2);
    const active = await page.evaluate(() => (document.activeElement ? document.activeElement.tagName + '#' + (document.activeElement.id || '') : null));
    log(T(), 'after chip + lake click: state', await L.state(), 'focus', active);
    await page.keyboard.down('Space');
    const c = await L.waitFor((s) => s.state === 'charging', { gameS: 5, every: 100, label: 'Space charges' });
    assert(c.state === 'charging', 'Space charges a cast after a HUD click and a lake click');
    await L.waitFor((s) => s.input.charge01 > 0.3, { gameS: 5, every: 100, label: 'charge' });
    await page.keyboard.up('Space');
    await L.waitFrames(1);
    assert(['casting', 'waiting'].includes(await L.state()), 'releasing Space casts');
    await fast();
    await dbg('setTimeScale(8)');
    await L.waitState('waiting', { gameS: 30 });
    await dbg('setLure("bobber")');
  }

  // ---- pause menu quality buttons
  if (want('quality')) {
    await dbg('setTimeScale(1)');
    await page.keyboard.press('Escape');
    await L.waitFrames(1);
    assert((await stats()).paused, 'Esc pauses');
    for (const q of ['low', 'medium', 'high', 'auto']) {
      await page.click(`#pause .seg button[data-quality="${q}"]`, { timeout: 900000 });
      await L.waitFrames(2);
      const s = await stats();
      const pressed = await page.evaluate((qq) => document.querySelector(`#pause .seg button[data-quality="${qq}"]`).getAttribute('aria-pressed'), q);
      log(T(), `quality ${q} ->`, s.quality, 'auto', s.autoQuality, 'pressed', pressed);
      assert(pressed === 'true' && (q === 'auto' ? s.autoQuality : s.quality === q && !s.autoQuality), `pause menu quality ${q}`);
    }
    await h.shot('pause-menu');
    await L.click('#btn-resume');
    await L.waitFrames(3);
    assert(!(await stats()).paused, 'Resume');
  }
  await L.expectNoNaN();
};
