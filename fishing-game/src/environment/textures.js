// Procedural textures baked once on the GPU into repeat-wrapped, mipmapped render targets.
// All channels hold data (not color), so they stay in linear / NoColorSpace.
import * as THREE from 'three';

const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Tileable noise primitives. `P` is the period in lattice cells.
const NOISE_LIB = /* glsl */ `
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gnoise(vec2 p, float P) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = hash22(mod(i, P)) * 2.0 - 1.0;
  vec2 g10 = hash22(mod(i + vec2(1.0, 0.0), P)) * 2.0 - 1.0;
  vec2 g01 = hash22(mod(i + vec2(0.0, 1.0), P)) * 2.0 - 1.0;
  vec2 g11 = hash22(mod(i + vec2(1.0, 1.0), P)) * 2.0 - 1.0;
  float a = dot(g00, f);
  float b = dot(g10, f - vec2(1.0, 0.0));
  float c = dot(g01, f - vec2(0.0, 1.0));
  float d = dot(g11, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.45;
}
float vnoise(vec2 p, float P) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, P));
  float b = hash12(mod(i + vec2(1.0, 0.0), P));
  float c = hash12(mod(i + vec2(0.0, 1.0), P));
  float d = hash12(mod(i + vec2(1.0, 1.0), P));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbmP(vec2 uv, float P, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * gnoise(uv * P, P);
    n += a;
    a *= 0.5;
    P *= 2.0;
  }
  return s / n;
}
// Worley F1 with per-cell data: returns (distance, cell random, second random)
vec3 worley(vec2 uv, float P) {
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float best = 9.0;
  float r1 = 0.0, r2 = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 cell = mod(i + o, P);
    vec2 h = hash22(cell);
    vec2 d = o + h * 0.8 + 0.1 - f;
    float dd = dot(d, d);
    if (dd < best) { best = dd; r1 = hash12(cell + 17.0); r2 = hash12(cell + 71.0); }
  }
  return vec3(sqrt(best), r1, r2);
}
`;

const DETAIL_FRAG = /* glsl */ `
varying vec2 vUv;
${NOISE_LIB}
// short strokes (grass blades / pine needles) in a periodic cell grid
float strokes(vec2 uv, float P, float len, float width) {
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 cell = mod(i + o, P);
    for (int k = 0; k < 2; k++) {
      vec2 h = hash22(cell + float(k) * 13.7);
      float ang = hash12(cell + float(k) * 5.1) * 6.2831853;
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 c = o + h - f;
      float t = clamp(dot(-c, dir), -len, len);
      vec2 q = -c - dir * t;
      float taper = 1.0 - abs(t) / len;
      float w = width * (0.35 + 0.65 * taper);
      float v = 1.0 - smoothstep(w * 0.4, w, length(q));
      acc = max(acc, v * (0.45 + 0.55 * hash12(cell + float(k) * 3.3)));
    }
  }
  return acc;
}
void main() {
  vec2 uv = vUv;
  // R: broad fbm (0..1)
  float r = fbmP(uv, 4.0, 6) * 0.5 + 0.5;
  // G: pebbles / gravel domes with per-stone brightness packed in the height
  vec3 w1 = worley(uv, 18.0);
  float rad1 = 0.28 + 0.2 * w1.y;
  float peb1 = sqrt(max(0.0, 1.0 - (w1.x * w1.x) / (rad1 * rad1)));
  vec3 w2 = worley(uv + 0.37, 46.0);
  float rad2 = 0.22 + 0.2 * w2.y;
  float peb2 = sqrt(max(0.0, 1.0 - (w2.x * w2.x) / (rad2 * rad2))) * 0.75;
  float g = max(peb1 * (0.55 + 0.45 * w1.z), peb2 * (0.5 + 0.5 * w2.z));
  // B: fibres (grass blades, needles)
  float b = max(strokes(uv, 40.0, 0.5, 0.06), strokes(uv + 0.5, 72.0, 0.45, 0.07) * 0.8);
  b = b * 0.8 + 0.2 * vnoise(uv * 256.0, 256.0);
  // A: granite: crystal grain + dark veins
  float grain = vnoise(uv * 256.0, 256.0) * 0.55 + vnoise(uv * 128.0 + 3.1, 128.0) * 0.45;
  float vein = 1.0 - abs(gnoise(uv * 12.0, 12.0) + 0.5 * gnoise(uv * 24.0, 24.0));
  vein = smoothstep(0.9, 1.0, vein);
  float a = clamp(grain * 0.85 - vein * 0.45 + 0.1, 0.0, 1.0);
  gl_FragColor = vec4(r, g, b, a);
}
`;

// Cumulus puffs: every jittered cell point carries a puff with its own radius, about a third of
// the cells carry none, and neighbouring puffs merge (soft union over the 3 x 3 cells around the
// pixel, which covers every puff that can reach it). Unlike a Worley F1 field this gives clusters
// and gaps without straight cell-border seams.
const CLOUD_PUFFS = /* glsl */ `
float puffs(vec2 uv, float P, float seed) {
  vec2 p = uv * P;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 cell = mod(i + o, P);
    vec2 h = hash22(cell + seed);
    vec2 d = o + h * 0.8 + 0.1 - f;
    float rad = mix(0.45, 1.15, hash12(cell + seed + 17.0)) * 0.85;
    float keep = step(0.35, hash12(cell + seed + 71.0));
    float v = (1.0 - smoothstep(0.0, rad, length(d))) * keep;
    acc = acc + v - acc * v;
  }
  return acc;
}
`;

const CLOUD_FRAG = /* glsl */ `
varying vec2 vUv;
${NOISE_LIB}
${CLOUD_PUFFS}
void main() {
  vec2 uv = vUv;
  // R: billowy low octaves, G: clustered cumulus puffs (two scales), B/A: detail octaves
  float r = fbmP(uv, 4.0, 4) * 0.5 + 0.5;
  float g = max(puffs(uv, 5.0, 3.0), puffs(uv + 0.37, 11.0, 11.0) * 0.85);
  float b = fbmP(uv + 0.31, 16.0, 3) * 0.5 + 0.5;
  float a = 1.0 - abs(fbmP(uv + 0.77, 8.0, 4));
  gl_FragColor = vec4(r, g, b, a);
}
`;

function bake(renderer, fragmentShader, size, anisotropy, target) {
  const rt = target || new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false,
  });
  if (!target) rt.texture.anisotropy = anisotropy;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const prev = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(prev);
  renderer.autoClear = prevAutoClear;
  geometry.dispose();
  material.dispose();
  return rt;
}

// Pass `target` (a render target returned earlier) to re-bake in place, e.g. after a
// WebGL context loss wiped render-target contents.
export function bakeDetailTexture(renderer, quality, target) {
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), quality === 'high' ? 8 : quality === 'medium' ? 4 : 2);
  return bake(renderer, DETAIL_FRAG, quality === 'low' ? 256 : 512, aniso, target);
}

export function bakeCloudNoise(renderer, target) {
  return bake(renderer, CLOUD_FRAG, 256, 1, target);
}
