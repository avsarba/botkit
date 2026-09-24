// Small inline-SVG illustrations of the four terminal-tackle rigs (keys 1-4).
// These are pictures of real painted/plated tackle, so their paint colors are literal
// (like an image), while every UI color comes from the template's :root tokens.
// viewBox 0 0 64 32, drawn at ~60x30 CSS px. Gradient ids are prefixed "lli-" to stay unique.

const HOOK = '#8b918a';
const WIRE = '#aab1a9';

// A treble hook hanging from (x, y); `down` hangs it below a belly hanger, otherwise it trails right.
function treble(x, y, down) {
  if (down) {
    return (
      `<path d="M${x} ${y}v2.4" stroke="${WIRE}" stroke-width="0.8"/>` +
      `<path d="M${x} ${y + 2.4}c-2.8 0.2-3.8 2.6-2.2 4.6M${x} ${y + 2.4}c2.8 0.2 3.8 2.6 2.2 4.6M${x} ${y + 2.4}v5.2" ` +
      `fill="none" stroke="${HOOK}" stroke-width="0.95" stroke-linecap="round"/>`
    );
  }
  return (
    `<path d="M${x} ${y}h2.6" stroke="${WIRE}" stroke-width="0.8"/>` +
    `<path d="M${x + 2.6} ${y}c3.4 0 4.4-2.4 2.8-4.4M${x + 2.6} ${y}c3.4 0 4.4 2.4 2.8 4.4M${x + 2.6} ${y}h5.6" ` +
    `fill="none" stroke="${HOOK}" stroke-width="0.95" stroke-linecap="round"/>`
  );
}

// Red-and-white plastic float with a nightcrawler on a bait hook below it.
const bobber =
  '<svg viewBox="0 0 64 32" aria-hidden="true">' +
  '<defs>' +
  '<radialGradient id="lli-fr" cx="0.36" cy="0.3" r="0.8"><stop offset="0" stop-color="#ef7a5e"/><stop offset="0.55" stop-color="#cf3f26"/><stop offset="1" stop-color="#86220f"/></radialGradient>' +
  '<radialGradient id="lli-fw" cx="0.36" cy="0" r="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#e2e5de"/><stop offset="1" stop-color="#979c94"/></radialGradient>' +
  '</defs>' +
  `<path d="M22 1.2v5" stroke="${WIRE}" stroke-width="1.5" stroke-linecap="round"/>` +
  '<path d="M13 14a9 9 0 0 1 18 0z" fill="url(#lli-fr)"/>' +
  '<path d="M13 14a9 9 0 0 0 18 0z" fill="url(#lli-fw)"/>' +
  '<path d="M13 14h18" stroke="#2c2f2a" stroke-width="1"/>' +
  '<path d="M17 9.2c1.2-1.8 3-2.7 4.6-2.8" stroke="rgba(255,255,255,0.5)" stroke-width="1" fill="none" stroke-linecap="round"/>' +
  `<path d="M22 23v1.6" stroke="${WIRE}" stroke-width="1.2"/>` +
  '<path d="M22 24.6C24 28.2 31 28.6 40 27.8" fill="none" stroke="#c9dd5a" stroke-width="0.7" opacity="0.85"/>' +
  `<path d="M40 27.8h7.2c2.8 0 3.2-3.8 0.8-4.3" fill="none" stroke="${HOOK}" stroke-width="1" stroke-linecap="round"/>` +
  '<path d="M41.5 26.6c1.8-3.4 4.6-3.2 5.8-0.4s3.8 2.8 5.2-0.2 4.2-3.4 6.4-0.6" fill="none" stroke="#9c5a50" stroke-width="2.6" stroke-linecap="round"/>' +
  '<path d="M41.5 26.6c1.8-3.4 4.6-3.2 5.8-0.4s3.8 2.8 5.2-0.2 4.2-3.4 6.4-0.6" fill="none" stroke="#c98274" stroke-width="0.9" stroke-linecap="round" opacity="0.7"/>' +
  '</svg>';

// Inline spinner: gold French blade on a clevis, brass beads, black body, dressed treble.
const spinner =
  '<svg viewBox="0 0 64 32" aria-hidden="true">' +
  '<defs>' +
  '<linearGradient id="lli-sb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff2c4"/><stop offset="0.45" stop-color="#d8b05a"/><stop offset="1" stop-color="#83601f"/></linearGradient>' +
  '<linearGradient id="lli-sbd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#666b63"/><stop offset="0.4" stop-color="#23271f"/><stop offset="1" stop-color="#0e100d"/></linearGradient>' +
  '</defs>' +
  `<circle cx="4" cy="17" r="1.8" fill="none" stroke="${WIRE}" stroke-width="0.9"/>` +
  `<path d="M5.8 17H44" stroke="${WIRE}" stroke-width="0.9"/>` +
  `<path d="M11 16.8l2.6-4" stroke="${WIRE}" stroke-width="0.8"/>` +
  '<ellipse cx="19" cy="10.2" rx="9.8" ry="4.6" transform="rotate(-15 19 10.2)" fill="url(#lli-sb)" stroke="#6c511e" stroke-width="0.5"/>' +
  '<path d="M12.5 11.4c3-2.6 8-3.8 12.5-3.2" stroke="rgba(255,255,255,0.55)" stroke-width="0.8" fill="none"/>' +
  '<circle cx="24.6" cy="17" r="1.7" fill="#c29a56"/><circle cx="28.2" cy="17" r="2.1" fill="#d0ab64"/>' +
  '<path d="M30.2 13.8C35.5 13.4 40.5 15 43 17c-2.5 2-7.5 3.6-12.8 3.2z" fill="url(#lli-sbd)"/>' +
  '<path d="M31.5 15c3.8-0.2 6.6 0.5 8.8 1.4" stroke="rgba(255,255,255,0.35)" stroke-width="0.7" fill="none"/>' +
  '<path d="M45 17C49 12.6 55 13.6 60 15.4M45 17C49 21.4 55 20.4 60 18.6M45 17h15" stroke="#e7dfca" stroke-width="0.55" fill="none" opacity="0.75"/>' +
  treble(44, 17, false) +
  '</svg>';

// Medium-diving crankbait in a shad pattern: olive back, silver flanks, clear lip, two trebles.
const crankbait =
  '<svg viewBox="0 0 64 32" aria-hidden="true">' +
  '<defs>' +
  '<linearGradient id="lli-cb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4429"/><stop offset="0.32" stop-color="#6d7b52"/><stop offset="0.52" stop-color="#c7cdc1"/><stop offset="1" stop-color="#f0f0e9"/></linearGradient>' +
  '</defs>' +
  '<path d="M13.2 15.8L3 22.4l2.6 3.2 10.4-6.8z" fill="rgba(214,232,238,0.5)" stroke="rgba(236,244,240,0.85)" stroke-width="0.6"/>' +
  `<circle cx="4.6" cy="23.6" r="0.9" fill="none" stroke="${WIRE}" stroke-width="0.7"/>` +
  '<path d="M12 15C12 9 20 6.4 30 6.9c8 0.5 14 3 18 7.1-4 4-10 7-18 7.5C20 22 12 20 12 15z" fill="url(#lli-cb)"/>' +
  '<path d="M16 9.6c5-2 11-2.4 17-1.6" stroke="rgba(255,255,255,0.35)" stroke-width="0.8" fill="none"/>' +
  '<path d="M22.2 10.2c1.5 2.6 1.5 6 0 8.8" stroke="#b5503e" stroke-width="0.8" fill="none" opacity="0.75"/>' +
  '<circle cx="17.6" cy="13" r="2.3" fill="#e6cf62"/><circle cx="17.9" cy="13" r="1.15" fill="#111"/>' +
  treble(29, 21.4, true) +
  treble(48, 14, false) +
  '</svg>';

// Walking topwater ("pencil" style): long bone-colored body with a smoky back, two trebles.
const topwater =
  '<svg viewBox="0 0 64 32" aria-hidden="true">' +
  '<defs>' +
  '<linearGradient id="lli-tw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#474b43"/><stop offset="0.3" stop-color="#b3ae9b"/><stop offset="0.56" stop-color="#e9e2cd"/><stop offset="1" stop-color="#f6f1e2"/></linearGradient>' +
  '</defs>' +
  `<circle cx="3.6" cy="16" r="0.9" fill="none" stroke="${WIRE}" stroke-width="0.7"/>` +
  '<path d="M4.6 16c0-3.2 5-4.6 15-4.8L44 12c6 0.6 10.4 2.2 11.8 4-1.4 1.8-5.8 3.4-11.8 4l-24.4 0.8C9.6 20.6 4.6 19.2 4.6 16z" fill="url(#lli-tw)"/>' +
  '<path d="M9 13.2c8-1.3 22-1.3 34-0.4" stroke="rgba(255,255,255,0.35)" stroke-width="0.7" fill="none"/>' +
  '<path d="M8.4 18.6c2 1 4 1.1 5.4 0.5" stroke="#b5503e" stroke-width="1" fill="none" opacity="0.7"/>' +
  '<circle cx="10.2" cy="14.6" r="1.7" fill="#e3c24c"/><circle cx="10.4" cy="14.6" r="0.85" fill="#111"/>' +
  treble(25, 20.6, true) +
  treble(55.8, 16, false) +
  '</svg>';

export const LURE_ICONS = Object.freeze({ bobber, spinner, crankbait, topwater });
