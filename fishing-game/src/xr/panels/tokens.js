// Design tokens and fonts for the world-space (VR) panels. The DOM UI's :root custom properties in
// src/index.template.html are the source of truth: they are read at runtime, so the headset panels use
// exactly the same colors and font stacks. The literals below only fill in when the page has no
// template (a sandbox built with --template none) and must mirror the template's :root block.
const FALLBACK = {
  bg: '#0a1416',
  glass: 'rgba(10, 20, 22, 0.58)',
  'glass-strong': 'rgba(10, 20, 22, 0.8)',
  'glass-hi': 'rgba(236, 244, 240, 0.1)',
  'glass-press': 'rgba(236, 244, 240, 0.18)',
  hair: 'rgba(236, 244, 240, 0.14)',
  'hair-strong': 'rgba(236, 244, 240, 0.3)',
  text: '#ecf3ef',
  'text-soft': 'rgba(236, 243, 239, 0.84)',
  muted: '#9db1ad',
  dim: 'rgba(157, 177, 173, 0.62)',
  red: '#e0452b',
  'red-soft': 'rgba(224, 69, 43, 0.5)',
  line: '#d3ee4f',
  'line-hi': '#e0f77a',
  'line-ink': '#18210d',
  'line-soft': 'rgba(211, 238, 79, 0.22)',
  amber: '#f0a63a',
  'amber-soft': 'rgba(240, 166, 58, 0.55)',
  brass: '#c29a56',
  paper: '#eee3b0',
  'paper-edge': '#d9cc92',
  'grid-line': 'rgba(159, 180, 191, 0.5)',
  ink: '#33372f',
  'ink-soft': '#5d6152',
  'ink-hair': 'rgba(51, 55, 47, 0.28)',
  'ink-deep': '#22251f',
  'ink-wash': 'rgba(51, 55, 47, 0.08)',
  track: 'rgba(236, 244, 240, 0.14)',
  'fill-faint': 'rgba(236, 244, 240, 0.05)',
  shadow: 'rgba(0, 0, 0, 0.32)',
  'shadow-deep': 'rgba(0, 0, 0, 0.45)',
  'text-shadow': 'rgba(0, 0, 0, 0.35)',
  'red-wash': 'rgba(224, 69, 43, 0.24)',
  'f-display': '"Big Shoulders Stencil Display", "Big Shoulders Stencil", "Oswald", "Impact", "Haettenschweiler", "Arial Narrow Bold", "Arial Narrow", sans-serif',
  'f-ui': '"Barlow Semi Condensed", "Barlow", "Roboto Condensed", "Arial Narrow", "Helvetica Neue", "Liberation Sans", Arial, sans-serif',
  'f-mono': '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

// The face/weight combinations the panels draw with; loaded explicitly because some of them are never
// used by DOM text that is on screen while presenting (canvas text only picks up loaded faces).
const FACES = [
  '800 32px "Big Shoulders Stencil Display"',
  '700 32px "Big Shoulders Stencil Display"',
  '400 32px "Barlow Semi Condensed"',
  'italic 400 32px "Barlow Semi Condensed"',
  '500 32px "Barlow Semi Condensed"',
  '600 32px "Barlow Semi Condensed"',
  '700 32px "Barlow Semi Condensed"',
  '400 32px "IBM Plex Mono"',
  '500 32px "IBM Plex Mono"',
  '600 32px "IBM Plex Mono"',
];

export function readTokens() {
  const out = {};
  let cs = null;
  try {
    cs = typeof getComputedStyle === 'function' && typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  } catch {
    cs = null;
  }
  for (const k of Object.keys(FALLBACK)) {
    let v = '';
    try {
      v = cs ? cs.getPropertyValue(`--${k}`).trim() : '';
    } catch {
      v = '';
    }
    out[k] = v || FALLBACK[k];
  }
  return {
    c: out,
    font: { display: out['f-display'], ui: out['f-ui'], mono: out['f-mono'] },
  };
}

// Kick off loading of every face the panels use, then resolve once document.fonts is ready (or after a
// backstop, so a hanging fonts host never keeps the panels blank). Never rejects.
export function loadFonts(timeoutMs = 2500) {
  const fonts = typeof document !== 'undefined' ? document.fonts : null;
  if (!fonts) return Promise.resolve(false);
  for (const f of FACES) {
    try {
      const p = fonts.load(f);
      if (p && p.catch) p.catch(() => {});
    } catch {
      /* ignore */
    }
  }
  let timer = 0;
  const backstop = new Promise((res) => {
    timer = setTimeout(() => res(false), timeoutMs);
  });
  const ready = Promise.resolve(fonts.ready).then(
    () => true,
    () => false
  );
  return Promise.race([ready, backstop]).then((v) => {
    clearTimeout(timer);
    return v;
  });
}
