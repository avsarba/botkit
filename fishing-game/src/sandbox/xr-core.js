// Sandbox for src/xr/session.js: feature detection never throws (no navigator.xr, false, rejection, SecurityError,
// a synchronous throw), the `local` fallback when `local-floor` is refused, and repeated enter / exit without
// leaking listeners. Needs the harness' --xr (IWER) for the session parts.
//   node build.mjs --entry src/sandbox/xr-core.js --out dist/sandbox-xr-core.html --template none
//   node tools/harness.mjs --xr --file dist/sandbox-xr-core.html --out out/xr-core/sandbox --size 480x270 --eval "window.__results"
import * as THREE from 'three';
import { detectXR, createXRSession } from '../xr/session.js';

const results = { detect: {}, sessions: [], done: false };
window.__results = results;

async function withXR(fake, fn) {
  const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'xr') || Object.getOwnPropertyDescriptor(navigator, 'xr');
  const own = Object.getOwnPropertyDescriptor(navigator, 'xr');
  Object.defineProperty(navigator, 'xr', { value: fake, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (own) Object.defineProperty(navigator, 'xr', own);
    else {
      delete navigator.xr;
      if (!('xr' in navigator) && desc) Object.defineProperty(navigator, 'xr', desc);
    }
  }
}

async function run() {
  const real = navigator.xr;
  const secErr = () => new DOMException('xr-spatial-tracking is not allowed', 'SecurityError');
  results.detect.none = await withXR(undefined, () => detectXR());
  results.detect.falsy = await withXR({ isSessionSupported: async () => false, requestSession() {} }, () => detectXR());
  results.detect.nonBoolean = await withXR({ isSessionSupported: async () => 'yes', requestSession() {} }, () => detectXR());
  results.detect.rejects = await withXR({ isSessionSupported: () => Promise.reject(secErr()), requestSession() {} }, () => detectXR());
  results.detect.throws = await withXR(
    {
      isSessionSupported() {
        throw secErr();
      },
      requestSession() {},
    },
    () => detectXR()
  );
  results.detect.real = await detectXR();

  if (!real) {
    results.done = true;
    return;
  }
  const renderer = new THREE.WebGLRenderer();
  renderer.setSize(480, 270);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0x3377aa })));
  renderer.setAnimationLoop(() => renderer.render(scene, camera));

  // count the listeners sessions get, per type, to see that every add is matched by a remove
  const live = new Map();
  const origAdd = EventTarget.prototype.addEventListener;
  const origRemove = EventTarget.prototype.removeEventListener;
  const kind = (t) => (window.XRSession && t instanceof window.XRSession ? 'session' : window.XRReferenceSpace && t instanceof window.XRReferenceSpace ? 'space' : null);
  results.eventTargetPatched = !!(window.XRSession && window.XRSession.prototype instanceof EventTarget);
  EventTarget.prototype.addEventListener = function (type, fn, o) {
    const k = kind(this);
    if (k) live.set(`${k}:${type}`, (live.get(`${k}:${type}`) || 0) + 1);
    return origAdd.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, o) {
    const k = kind(this);
    if (k) live.set(`${k}:${type}`, (live.get(`${k}:${type}`) || 0) - 1);
    return origRemove.call(this, type, fn, o);
  };

  let starts = 0;
  let ends = 0;
  const xs = createXRSession({
    renderer,
    onStart: () => starts++,
    onEnd: () => ends++,
  });
  // 1) local-floor refused -> local
  const origReq = real.requestSession.bind(real);
  real.requestSession = (mode, init) => {
    if (init && init.requiredFeatures && init.requiredFeatures.includes('local-floor')) return Promise.reject(new DOMException('local-floor unsupported', 'NotSupportedError'));
    return origReq(mode, init);
  };
  const ok1 = await xs.enter({ framebufferScale: 0.75, foveation: 1 });
  results.sessions.push({ ok: ok1, ref: xs.referenceSpaceType, presenting: renderer.xr.isPresenting });
  await xs.exit();
  await new Promise((r) => setTimeout(r, 300));
  real.requestSession = origReq;
  // 2) three normal rounds
  for (let i = 0; i < 3; i++) {
    const ok = await xs.enter({ framebufferScale: 0.9, foveation: 0.8 });
    results.sessions.push({ ok, ref: xs.referenceSpaceType, presenting: renderer.xr.isPresenting });
    await new Promise((r) => setTimeout(r, 200));
    await xs.exit();
    await new Promise((r) => setTimeout(r, 300));
  }
  // 3) a refused session (SecurityError): false, no throw
  real.requestSession = () => Promise.reject(new DOMException('no activation', 'SecurityError'));
  results.refused = await xs.enter({});
  real.requestSession = origReq;
  results.starts = starts;
  results.ends = ends;
  results.presentingAfter = renderer.xr.isPresenting;
  // net adds per session event type (0 = every listener added was removed again; three's own included)
  results.listeners = Object.fromEntries(live.entries());
  EventTarget.prototype.addEventListener = origAdd;
  EventTarget.prototype.removeEventListener = origRemove;
  results.done = true;
}

run().catch((err) => {
  results.error = String((err && err.stack) || err);
  results.done = true;
});
