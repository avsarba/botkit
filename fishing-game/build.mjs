// Bundles an entry module into a single self-contained HTML page.
// three.js itself stays on the CDN (the Artifact CSP allows cdn.jsdelivr.net/npm);
// three/addons modules are small and get bundled in.
//
//   node build.mjs                                  -> dist/index.html  (game, the Artifact version: no skeleton tags)
//   node build.mjs --standalone                     -> dist/play.html   (the same page in a full <!doctype html>
//                                                      skeleton, for any HTTPS static host / a VR headset browser)
//   node build.mjs --entry src/sandbox/water.js --out dist/sandbox-water.html
//   --stub src/xr/hud.js[,more]                     build with those optional modules replaced by empty stubs
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const THREE_VERSION = '0.170.0';
export const THREE_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.min.js`;

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const standalone = args.includes('--standalone');
const entry = arg('--entry', 'src/main.js');
const out = arg('--out', standalone ? 'dist/play.html' : 'dist/index.html');
const template = arg('--template', 'src/index.template.html');
const minify = !args.includes('--no-minify');

const threeCdn = {
  name: 'three-cdn',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: THREE_URL, external: true }));
  },
};

// Modules that parts of the game import but that another piece of work provides: until the file exists (or when
// --stub names it) the build substitutes a stub whose exports are null, and the importer's guards skip it.
const OPTIONAL = { 'src/xr/hud.js': 'export const createXRHud = null;\n' };
const stubbed = new Set((arg('--stub', '') || '').split(',').filter(Boolean).map((p) => resolve(p)));
const optionalModules = {
  name: 'optional-modules',
  setup(b) {
    const byPath = new Map(Object.entries(OPTIONAL).map(([p, stub]) => [resolve(p), stub]));
    b.onResolve({ filter: /\.js$/ }, (a) => {
      if (a.kind === 'entry-point' || !a.path.startsWith('.')) return undefined;
      const p = resolve(a.resolveDir, a.path);
      if (byPath.has(p) && (stubbed.has(p) || !existsSync(p))) return { path: p, namespace: 'optional-stub' };
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'optional-stub' }, (a) => ({ contents: byPath.get(a.path) || 'export {};\n', loader: 'js' }));
  },
};

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify,
  write: false,
  legalComments: 'none',
  plugins: [threeCdn, optionalModules],
  logLevel: 'warning',
});
let js = result.outputFiles[0].text;
// Never let the bundle close the surrounding <script> tag early.
js = js.replace(/<\/script/gi, '<\\/script');

let html;
try {
  html = await readFile(template, 'utf8');
} catch {
  html = '<title>Sandbox</title>\n<style>html,body{height:100%;margin:0;background:#000;overflow:hidden}</style>\n<!--BUNDLE-->\n';
}
if (!html.includes('<!--BUNDLE-->')) throw new Error(`${template} is missing the <!--BUNDLE--> marker`);
html = html.replace('<!--BUNDLE-->', () => `<script type="module">\n${js}\n</script>`);

// Standalone: the skeleton the Artifact viewer would wrap the page in (charset, viewport with viewport-fit=cover and
// the same small reset), with the page's <title> moved into the head. Everything else (fonts link, styles, markup,
// script) stays in the body, where it sits in the Artifact too.
if (standalone) {
  let title = '<title>Loon Lake Angler</title>';
  html = html.replace(/<title>[\s\S]*?<\/title>\s*/i, (m) => {
    title = m.trim();
    return '';
  });
  html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    `${title}\n` +
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
    'body{margin:0;font:14px/1.4 system-ui,sans-serif;background:#fafaf9}img{max-width:100%}[hidden]{display:none!important}</style>\n' +
    '</head>\n<body>\n' +
    html.trim() +
    '\n</body>\n</html>\n';
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`built ${out} (${(html.length / 1024).toFixed(1)} KB) from ${entry}`);
