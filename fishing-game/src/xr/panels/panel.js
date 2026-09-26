// A world-space UI panel: a canvas drawn with the DOM UI's tokens, shown on an unlit plane.
// The canvas is redrawn only when something it shows changed (invalidate), and at most ~15 times a
// second (minMs); the texture uploads only after a redraw. Buttons are rectangles in canvas pixels that the
// controller rays hit-test through the plane's UV.
//
// A headset's eye buffer shows these canvases 2-4x smaller than drawn, so the texture is mipmapped (trilinear; the
// HUD adds a little anisotropy): plain bilinear minification skips texels, and thin strokes and small text crawl as
// the head and hands move. The canvas uploads premultiplied (its own format), blended as premultiplied color with
// the fade folded into the color as well, so the mip levels never darken the edges toward the empty canvas' black.
// `pxScale` draws the same pxW x pxH layout on a smaller (or larger) canvas.
import * as THREE from 'three';

export const REDRAW_MIN_MS = 1000 / 15;
export const PANEL_RENDER_ORDER = 950; // after the scene's transparent passes (water, splashes, line)

export function createPanel({ name, widthM, heightM, pxW, pxH, draw, interactive = false, renderOrder = PANEL_RENDER_ORDER, pxScale = 1, minMs = REDRAW_MIN_MS }) {
  const canvas = document.createElement('canvas');
  const scale = Number.isFinite(pxScale) && pxScale > 0 ? pxScale : 1;
  canvas.width = Math.max(1, Math.round(pxW * scale));
  canvas.height = Math.max(1, Math.round(pxH * scale));
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.premultiplyAlpha = true;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false,
    fog: false,
    depthTest: true,
    depthWrite: true,
    alphaTest: 0.02, // the empty canvas around pills / rounded corners neither draws nor writes depth
    side: THREE.FrontSide,
    // premultiplied texels: src + dst * (1 - src alpha); the opacity (fades) scales the color too (setOpacity)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const geometry = new THREE.PlaneGeometry(widthM, heightM);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false; // tiny and always wanted when visible; skip the per-eye culling work
  // `object` is what callers place and animate; `mesh` inside it is cropped to the drawn height
  const object = new THREE.Group();
  object.name = `${name}-root`;
  object.add(mesh);

  const panel = {
    name,
    object,
    mesh,
    canvas,
    ctx,
    texture,
    material,
    W: pxW,
    H: pxH,
    widthM,
    heightM,
    usedH: pxH,
    interactive,
    buttons: [], // rebuilt by each draw: { id, x, y, w, h, disabled, press() }
    hover: new Set(), // button ids under a ray
    pressId: null,
    pressUntil: 0,
    dirty: true,
    drawn: false,
    want: false, // the owner wants it visible
    lastDraw: -1e9,
    opacity: 1,
    invalidate() {
      panel.dirty = true;
    },
    // Redraw if invalidated and the rate limit allows (force: ignore the limit, e.g. on open).
    flush(now, force = false) {
      if (!panel.dirty) return false;
      if (!force && now - panel.lastDraw < minMs) return false;
      panel.dirty = false;
      panel.lastDraw = now;
      panel.buttons.length = 0;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, pxW, pxH);
      ctx.save();
      let used;
      try {
        used = draw(ctx, panel, now);
      } catch (err) {
        console.warn(`[xr-hud] ${name} draw failed`, err);
      }
      ctx.restore();
      panel.setUsedHeight(Number.isFinite(used) ? used : pxH);
      texture.needsUpdate = true;
      panel.drawn = true;
      panel.syncVisible();
      return true;
    },
    // Show only the top `h` canvas pixels (content-sized cards); the plane shrinks around its centre.
    setUsedHeight(h) {
      h = Math.max(8, Math.min(pxH, Math.round(h)));
      if (h === panel.usedH && mesh.scale.y === h / pxH) return;
      panel.usedH = h;
      const f = h / pxH;
      texture.repeat.set(1, f);
      texture.offset.set(0, 1 - f);
      mesh.scale.y = f;
    },
    get heightUsedM() {
      return (heightM * panel.usedH) / pxH;
    },
    setWanted(on) {
      panel.want = !!on;
      panel.syncVisible();
    },
    syncVisible() {
      mesh.visible = panel.want && panel.drawn && panel.opacity > 0.004;
    },
    setOpacity(a) {
      a = Math.max(0, Math.min(1, a));
      if (a === panel.opacity) return;
      panel.opacity = a;
      material.opacity = a;
      // (premultiplied: the color fades with the alpha; the shader decodes / encodes sRGB around it, so scale by the
      // decoded factor to keep color and coverage in step)
      material.color.setRGB(a, a, a, THREE.SRGBColorSpace);
      panel.syncVisible();
    },
    // uv (0..1 over the visible plane) -> canvas px
    uvToPx(uv, out) {
      out.x = uv.x * pxW;
      out.y = (1 - uv.y) * panel.usedH;
      return out;
    },
    buttonAt(x, y) {
      for (let i = panel.buttons.length - 1; i >= 0; i--) {
        const b = panel.buttons[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
      }
      return null;
    },
    addButton(b) {
      panel.buttons.push(b);
      return b;
    },
    isHover(id) {
      return panel.hover.has(id);
    },
    isPressed(id, now) {
      return panel.pressId === id && now < panel.pressUntil;
    },
    dispose() {
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      canvas.width = canvas.height = 1;
    },
  };
  mesh.userData.panel = panel;
  mesh.visible = false;
  return panel;
}
