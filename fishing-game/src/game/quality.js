// Adaptive quality: measures the frame rate over ~2 s windows; below 40 fps it first lowers the pixel
// ratio in steps, then the quality level (high -> medium -> low). A quality picked in the UI
// (pause menu) switches the automatic mode off.
const LEVELS = ['high', 'medium', 'low'];
const PR_CAP = { high: 1.75, medium: 1.5, low: 1.25 };
const PR_FLOOR = 0.75;
const WINDOW_S = 2;
const LOW_FPS = 40;

export function createQualityManager({ renderer, initial = 'high', auto = true, onQuality }) {
  const dpr = () => Math.max(0.5, window.devicePixelRatio || 1);
  let quality = LEVELS.includes(initial) ? initial : 'high';
  let autoMode = !!auto;
  let pr = Math.min(dpr(), PR_CAP[quality]);
  let acc = 0;
  let frames = 0;
  let grace = 1; // skip the first window after a change (shader compiles, texture uploads)
  let fps = 60;
  renderer.setPixelRatio(pr);

  function applyPR(next) {
    next = Math.round(next * 100) / 100;
    if (Math.abs(next - pr) < 0.01) return;
    pr = next;
    renderer.setPixelRatio(pr);
    // setPixelRatio resizes the drawing buffer to the current CSS size
    const c = renderer.domElement;
    renderer.setSize(c.clientWidth || window.innerWidth, c.clientHeight || window.innerHeight, false);
  }

  function setLevel(q) {
    if (!LEVELS.includes(q) || q === quality) return;
    quality = q;
    if (typeof onQuality === 'function') onQuality(q);
  }

  function stepDown() {
    const floor = Math.min(1, dpr());
    if (pr > floor + 0.01) {
      applyPR(Math.max(floor, pr - 0.25));
      return true;
    }
    const i = LEVELS.indexOf(quality);
    if (i < LEVELS.length - 1) {
      setLevel(LEVELS[i + 1]);
      return true;
    }
    if (pr > PR_FLOOR + 0.01) {
      applyPR(Math.max(PR_FLOOR, pr - 0.125));
      return true;
    }
    return false;
  }

  // Call once per rendered frame with the real (unclamped) frame time in seconds.
  function sample(realDt) {
    if (!(realDt > 0)) return;
    acc += Math.min(realDt, 1); // a very slow frame counts, a debugger pause doesn't dominate
    frames++;
    if (acc < WINDOW_S) return;
    fps = frames / acc;
    acc = 0;
    frames = 0;
    if (grace > 0) {
      grace--;
      return;
    }
    if (autoMode && fps < LOW_FPS && stepDown()) grace = 1;
  }

  function reset() {
    acc = 0;
    frames = 0;
    grace = 1;
  }

  return {
    sample,
    reset,
    // UI / debug choice: fixed level, full pixel ratio for that level, automatic mode off.
    setManual(q) {
      if (!LEVELS.includes(q)) return;
      autoMode = false;
      setLevel(q);
      applyPR(Math.min(dpr(), PR_CAP[q]));
      reset();
    },
    setAuto(on) {
      autoMode = !!on;
      reset();
    },
    setPixelRatio(p) {
      applyPR(Math.max(0.5, Math.min(p, 2)));
    },
    get quality() {
      return quality;
    },
    get pixelRatio() {
      return pr;
    },
    get fps() {
      return fps;
    },
    get auto() {
      return autoMode;
    },
  };
}
