// Bundles an entry module into a single self-contained HTML page.
// three.js itself stays on the CDN (the Artifact CSP allows cdn.jsdelivr.net/npm);
// three/addons modules are small and get bundled in.
//
//   node build.mjs                                  -> dist/index.html  (game)
//   node build.mjs --entry src/sandbox/water.js --out dist/sandbox-water.html
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const THREE_VERSION = '0.170.0';
export const THREE_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.min.js`;

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const entry = arg('--entry', 'src/main.js');
const out = arg('--out', 'dist/index.html');
const template = arg('--template', 'src/index.template.html');
const minify = !args.includes('--no-minify');

const threeCdn = {
  name: 'three-cdn',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: THREE_URL, external: true }));
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
  plugins: [threeCdn],
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

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
console.log(`built ${out} (${(html.length / 1024).toFixed(1)} KB) from ${entry}`);
