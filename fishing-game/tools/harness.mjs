// Headless test harness: loads a built page the way the Artifact viewer would
// (publish skeleton + approximate CSP), serves three.js from node_modules in
// place of the CDN, prints console output / errors, and takes screenshots.
//
//   node tools/harness.mjs [--file dist/index.html] [--out out/run] [--size 1280x720]
//                          [--mobile] [--wait 4000] [--shots 3000,6000]
//                          [--scenario tools/scenarios/foo.mjs] [--eval "js expr"]
//                          [--timeout 120000] [--quiet] [--xr]
//
// A scenario module exports `default async function ({ page, shot, sleep, log, game })`.
//   shot(name)          -> saves out/<run>/<name>.png
//   game(expr)          -> evaluates `expr` in the page (string), returns JSON value
// Exit code is 1 when the page threw an uncaught error or logged console.error.
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

// Playwright is installed globally in this environment; fall back to the global root.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  ({ chromium } = await import(pathToFileURL(join(globalRoot, 'playwright/index.mjs')).href));
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const file = arg('--file', 'dist/index.html');
const outDir = arg('--out', 'out/run');
const mobile = has('--mobile');
const [w, h] = arg('--size', mobile ? '390x844' : '1280x720').split('x').map(Number);
const wait = Number(arg('--wait', '4000'));
const shots = arg('--shots', '').split(',').filter(Boolean).map(Number);
const scenario = arg('--scenario', null);
const evalExpr = arg('--eval', null);
const timeout = Number(arg('--timeout', '900000')); // per Playwright action; software-rendered frames can take seconds
const quiet = has('--quiet');
// --xr installs IWER (Meta's Immersive Web Emulation Runtime, a dev-only WebXR emulator) as navigator.xr
// before any page script runs, emulating a Meta Quest 3 with two controllers. Scenarios drive it through
// window.__xrDevice (see node_modules/iwer/lib/device/XRDevice.d.ts / XRController.d.ts).
const xr = has('--xr');

const ROOT = resolve('.');
const THREE_DIR = join(ROOT, 'node_modules/three');
const ORIGIN = 'https://game.local';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
].join('; ');

const SKELETON_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px/1.4 system-ui,sans-serif;background:#fafaf9}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>`;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html' };

const problems = [];
const log = (...m) => console.log(...m);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: w, height: h },
  deviceScaleFactor: mobile ? 2 : 1,
  isMobile: mobile,
  hasTouch: mobile,
});
const page = await context.newPage();
if (xr) {
  const iwerSrc = await readFile(join(ROOT, 'node_modules/iwer/build/iwer.min.js'), 'utf8');
  await page.addInitScript({
    content: `${iwerSrc}
;(function () {
  try {
    const dev = new IWER.XRDevice(IWER.metaQuest3);
    dev.installRuntime({ forceInstall: true });
    window.__xrDevice = dev;
    window.__IWER = IWER;
  } catch (e) { console.error('[harness] IWER install failed', e); }
})();`,
  });
}
page.setDefaultTimeout(timeout);

await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (url === `${ORIGIN}/` || url === `${ORIGIN}/index.html`) {
    const body = SKELETON_HEAD + (await readFile(file, 'utf8')) + '</body></html>';
    return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': CSP }, body });
  }
  const m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/);
  if (m) {
    const p = join(THREE_DIR, m[1].split('?')[0]);
    if (existsSync(p)) {
      return route.fulfill({ status: 200, contentType: MIME[extname(p)] || 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: await readFile(p) });
    }
    problems.push(`404 on CDN path ${url}`);
    return route.fulfill({ status: 404, body: 'not found' });
  }
  if (/fonts\.(googleapis|gstatic)\.com/.test(url)) {
    // No network here; fonts fall back. Answer fast so layout isn't blocked.
    return route.fulfill({ status: 200, contentType: url.includes('googleapis') ? 'text/css' : 'font/woff2', body: '' });
  }
  if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  problems.push(`request to non-allowed/unavailable host: ${url}`);
  return route.abort();
});

page.on('console', (msg) => {
  const t = msg.type();
  const text = msg.text();
  if (t === 'error') problems.push(`console.error: ${text}`);
  if (!quiet || t === 'error' || t === 'warning') log(`[console.${t}] ${text}`);
});
page.on('pageerror', (err) => {
  problems.push(`pageerror: ${err.message}`);
  log(`[pageerror] ${err.stack || err.message}`);
});

await mkdir(outDir, { recursive: true });
const shot = async (name) => {
  const p = join(outDir, `${name}.png`);
  await page.screenshot({ path: p });
  log(`[shot] ${p}`);
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const game = (expr) => page.evaluate(`(async () => { const r = (${expr}); return r && r.then ? await r : r; })()`);

const t0 = Date.now();
await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
log(`[harness] loaded in ${Date.now() - t0} ms (${w}x${h}${mobile ? ', mobile' : ''})`);

try {
  if (scenario) {
    const mod = await import(pathToFileURL(resolve(scenario)).href);
    await mod.default({ page, shot, sleep, log, game, outDir });
  } else {
    await sleep(wait);
    if (evalExpr) log('[eval]', JSON.stringify(await game(evalExpr), null, 2));
    if (shots.length) {
      let last = 0;
      for (const t of shots) {
        await sleep(Math.max(0, t - last));
        last = t;
        await shot(`t${t}`);
      }
    } else {
      await shot('final');
    }
  }
  const stats = await page.evaluate(() => (window.__game && window.__game.debug && window.__game.debug.stats ? window.__game.debug.stats() : null)).catch(() => null);
  if (stats) log('[stats]', JSON.stringify(stats));
} catch (e) {
  problems.push(`harness/scenario error: ${e.stack || e.message}`);
}

await browser.close();
if (problems.length) {
  log(`\n[harness] ${problems.length} problem(s):`);
  for (const p of problems) log('  - ' + p);
  process.exit(1);
}
log('[harness] no errors');
