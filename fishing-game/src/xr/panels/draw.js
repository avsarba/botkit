// Canvas 2D helpers for the VR panels: fonts with the DOM's letter-spacing, pills and rounded boxes,
// word wrap, fit-to-width and the field-notebook paper. Everything works in canvas pixels.

const HAS_SPACING = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    return !!c && 'letterSpacing' in c;
  } catch {
    return false;
  }
})();

// font: '600', 24, family, 'italic'?; spacing in em (CSS letter-spacing)
export function setFont(ctx, weight, px, family, { style = '', spacing = 0 } = {}) {
  ctx.font = `${style ? `${style} ` : ''}${weight} ${Math.round(px * 10) / 10}px ${family}`;
  if (HAS_SPACING) ctx.letterSpacing = spacing ? `${(spacing * px).toFixed(2)}px` : '0px';
}

// Width without the trailing letter-spacing canvas adds after the last glyph.
export function textWidth(ctx, s) {
  const w = ctx.measureText(s).width;
  if (!HAS_SPACING || !s) return w;
  const ls = parseFloat(ctx.letterSpacing) || 0;
  return Math.max(0, w - ls);
}

// Draw text; align 'left' | 'center' | 'right' is handled here so letter-spacing stays centered.
export function text(ctx, s, x, y, { color, align = 'left', baseline = 'alphabetic', maxWidth } = {}) {
  if (s == null || s === '') return 0;
  s = String(s);
  const w = textWidth(ctx, s);
  let x0 = x;
  if (align === 'center') x0 = x - w / 2;
  else if (align === 'right') x0 = x - w;
  if (color) ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = baseline;
  if (maxWidth && w > maxWidth) {
    // squeeze rather than overflow (rare: very long species or lure names)
    ctx.save();
    ctx.translate(x0 + (align === 'center' ? (w - maxWidth) / 2 : align === 'right' ? w - maxWidth : 0), y);
    ctx.scale(maxWidth / w, 1);
    ctx.fillText(s, 0, 0);
    ctx.restore();
    return maxWidth;
  }
  ctx.fillText(s, x0, y);
  return w;
}

export function ellipsize(ctx, s, maxW) {
  s = String(s || '');
  if (textWidth(ctx, s) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(ctx, `${s.slice(0, mid).trimEnd()}…`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

// Greedy word wrap; a word longer than the line is broken by characters.
export function wrap(ctx, s, maxW) {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (textWidth(ctx, t) <= maxW || !line) {
      if (!line && textWidth(ctx, w) > maxW) {
        let part = '';
        for (const ch of w) {
          if (textWidth(ctx, part + ch) > maxW && part) {
            lines.push(part);
            part = ch;
          } else part += ch;
        }
        line = part;
      } else line = t;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Balanced wrap (CSS text-wrap: balance): the same number of lines as a greedy wrap, but even widths.
export function wrapBalanced(ctx, s, maxW) {
  const greedy = wrap(ctx, s, maxW);
  if (greedy.length < 2) return greedy;
  // never narrower than the longest word (a balanced wrap must not break words)
  const longest = Math.max(...String(s || '').split(/\s+/).map((w) => textWidth(ctx, w)));
  if (longest >= maxW) return greedy;
  let lo = Math.max(maxW * 0.4, longest);
  let hi = maxW;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (wrap(ctx, s, mid).length > greedy.length) lo = mid;
    else hi = mid;
  }
  return wrap(ctx, s, hi);
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export function box(ctx, x, y, w, h, r, { fill, stroke, lineWidth = 1 } = {}) {
  roundRect(ctx, x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    // keep hairlines inside the box
    roundRect(ctx, x + lineWidth / 2, y + lineWidth / 2, w - lineWidth, h - lineWidth, Math.max(0, r - lineWidth / 2));
    ctx.stroke();
  }
}

export function dot(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

export function hline(ctx, x0, x1, y, color, width = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(x0, Math.round(y - width / 2), x1 - x0, width);
}

// ---------- field-notebook paper (catch card, journal): paper color, fine noise, a blue-grey grid ----------
let noiseTile = null;
function paperNoise() {
  if (noiseTile) return noiseTile;
  const s = 160;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < s * s; i++) {
    // the template's feTurbulence + color matrix: brown-grey speckle at ~9 % opacity
    const v = rnd();
    img.data[i * 4] = 64;
    img.data[i * 4 + 1] = 56;
    img.data[i * 4 + 2] = 31;
    img.data[i * 4 + 3] = Math.round(v * v * 0.09 * 255 * 1.6);
  }
  g.putImageData(img, 0, 0);
  noiseTile = c;
  return c;
}

export function paper(ctx, x, y, w, h, r, c, gridPx) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.fillStyle = c.paper;
  ctx.fillRect(x, y, w, h);
  const pat = ctx.createPattern(paperNoise(), 'repeat');
  if (pat) {
    ctx.fillStyle = pat;
    ctx.fillRect(x, y, w, h);
  }
  ctx.fillStyle = c['grid-line'];
  const lw = Math.max(1, Math.round(gridPx / 18));
  for (let gx = x + gridPx - 1; gx < x + w; gx += gridPx) ctx.fillRect(Math.round(gx), y, lw, h);
  for (let gy = y + gridPx - 1; gy < y + h; gy += gridPx) ctx.fillRect(x, Math.round(gy), w, lw);
  ctx.restore();
}
