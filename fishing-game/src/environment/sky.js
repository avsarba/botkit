// Sky dome (three/addons Preetham Sky, extended with twilight, night gradient, moon glow and
// a Milky Way glow), a star field, the moon disc and a procedural cloud layer.
// Everything here is drawn at the far plane (z = w) and centered on whichever camera renders
// it, so the planar-reflection camera and the PMREM cube camera see it correctly too.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeRng } from '../config.js';
import { CELESTIAL_POLE, worldDirection } from './astro.js';
import { DITHER_GLSL } from './dither.js';

const SKY_SCALE = 2000; // box half-size 1000 m: corners at 1732 m, inside the 2500 m far plane

// ---------------------------------------------------------------------------------------
// CPU port of the (patched) sky shader so fog / light / cloud colors match the rendered sky.
// ---------------------------------------------------------------------------------------
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000;
const NIGHT_ADD = [0, 0.0003, 0.00075];

export class SkyModel {
  constructor() {
    this.sun = new THREE.Vector3(0, 1, 0);
    this.betaR = [0, 0, 0];
    this.betaM = [0, 0, 0];
    this.sunE = 0;
    this.sunfade = 1;
    this.mieG = 0.8;
    this.gain = 1;
    this.nightZenith = new THREE.Color(0, 0, 0);
    this.nightHorizon = new THREE.Color(0, 0, 0);
    this.twilight = new THREE.Color(0, 0, 0);
    this.belt = new THREE.Color(0, 0, 0);
    this.shadow = 0;
    this.sunXZ = new THREE.Vector2(1, 0);
    this._fex = [0, 0, 0];
  }
  set(sunDir, turbidity, rayleigh, mie, mieG) {
    this.sun.copy(sunDir);
    const y = Math.max(-1, Math.min(1, sunDir.y));
    this.sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF - Math.acos(y)) / STEEPNESS)));
    this.sunfade = 1 - Math.max(0, Math.min(1, 1 - Math.exp(sunDir.y / 450000)));
    const rc = rayleigh - (1 - this.sunfade);
    const c = 0.2 * turbidity * 10e-18;
    for (let i = 0; i < 3; i++) {
      this.betaR[i] = TOTAL_RAYLEIGH[i] * rc;
      this.betaM[i] = 0.434 * c * MIE_CONST[i] * mie;
    }
    this.mieG = mieG;
    const l = Math.hypot(sunDir.x, sunDir.z);
    if (l > 1e-5) this.sunXZ.set(sunDir.x / l, sunDir.z / l);
  }
  // Scene-referred radiance (before exposure / tone mapping) in direction (dx, dy, dz).
  radiance(dx, dy, dz, out) {
    const cz = Math.max(0, dy);
    const zen = Math.acos(cz);
    const inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - (zen * 180) / Math.PI, -1.253));
    const sR = 8.4e3 * inv;
    const sM = 1.25e3 * inv;
    const s = this.sun;
    const cosT = dx * s.x + dy * s.y + dz * s.z;
    const rp = cosT * 0.5 + 0.5;
    const rPhase = 0.05968310365946075 * (1 + rp * rp);
    const g = this.mieG;
    const g2 = g * g;
    const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * g * cosT + g2, 1.5));
    const mixT = Math.max(0, Math.min(1, Math.pow(1 - s.y, 5)));
    const gammaInv = 1 / (1.2 + 1.2 * this.sunfade);
    const rgb = this._fex;
    for (let i = 0; i < 3; i++) {
      const bR = this.betaR[i];
      const bM = this.betaM[i];
      const fex = Math.exp(-(bR * sR + bM * sM));
      const ratio = (bR * rPhase + bM * mPhase) / (bR + bM);
      let lin = Math.pow(Math.max(0, this.sunE * ratio * (1 - fex)), 1.5);
      lin *= 1 + (Math.pow(Math.max(0, this.sunE * ratio * fex), 0.5) - 1) * mixT;
      const tex = (lin + 0.1 * fex) * 0.04 + NIGHT_ADD[i];
      rgb[i] = Math.pow(tex, gammaInv) * this.gain;
    }
    // night gradient + twilight glow (same formulas as the shader)
    const h = Math.max(0, Math.min(1, dy));
    const k = Math.sqrt(h);
    const lxz = Math.hypot(dx, dz);
    const side = lxz > 1e-4 ? ((dx / lxz) * this.sunXZ.x + (dz / lxz) * this.sunXZ.y) * 0.5 + 0.5 : 0.5;
    const tw = Math.exp(-h * 6) * (0.05 + 0.95 * side * side * side * side);
    const bh = (h - 0.12) / 0.07;
    const anti = 1 - side;
    const bw = Math.exp(-bh * bh) * anti * Math.sqrt(anti);
    // earth's shadow: a blue-grey band hugging the anti-sun horizon
    const esw = this.shadow * anti * anti * Math.exp(-h * 14);
    const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    rgb[0] += (lum * 0.5 - rgb[0]) * esw;
    rgb[1] += (lum * 0.6 - rgb[1]) * esw;
    rgb[2] += (lum * 0.86 - rgb[2]) * esw;
    const nz = this.nightZenith;
    const nh = this.nightHorizon;
    const t = this.twilight;
    const bl = this.belt;
    out.r = rgb[0] + nh.r + (nz.r - nh.r) * k + t.r * tw + bl.r * bw;
    out.g = rgb[1] + nh.g + (nz.g - nh.g) * k + t.g * tw + bl.g * bw;
    out.b = rgb[2] + nh.b + (nz.b - nh.b) * k + t.b * tw + bl.b * bw;
    return out;
  }
}

const acesFit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// three.js ACESFilmicToneMapping, ported (display-referred linear result, 0..1).
export function toneMapACES(c, exposure, out) {
  const e = exposure / 0.6;
  const r = c.r * e;
  const g = c.g * e;
  const b = c.b * e;
  let x = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  let y = 0.076 * r + 0.90834 * g + 0.01566 * b;
  let z = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  x = acesFit(x);
  y = acesFit(y);
  z = acesFit(z);
  out.r = clamp01(1.60475 * x - 0.53108 * y - 0.07367 * z);
  out.g = clamp01(-0.10208 * x + 1.10813 * y - 0.00605 * z);
  out.b = clamp01(-0.00327 * x - 0.07276 * y + 1.07602 * z);
  return out;
}

// ---------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------
const SKY_EXTRA_UNIFORMS = /* glsl */ `
uniform float uSkyGain;
uniform float uSunDisk;
uniform vec3 uNightZenith;
uniform vec3 uNightHorizon;
uniform vec3 uTwilight;
uniform vec3 uBelt;
uniform float uEarthShadow;
uniform vec2 uSunXZ;
uniform vec3 uMoonDir;
uniform vec3 uMoonGlow;
uniform vec3 uMilkyPole;
uniform float uMilky;
float skyHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float skyNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skyHash(i + vec3(0, 0, 0)), skyHash(i + vec3(1, 0, 0)), f.x),
                 mix(skyHash(i + vec3(0, 1, 0)), skyHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(skyHash(i + vec3(0, 0, 1)), skyHash(i + vec3(1, 0, 1)), f.x),
                 mix(skyHash(i + vec3(0, 1, 1)), skyHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

const SKY_COMPOSE = /* glsl */ `
	vec3 col = retColor * uSkyGain;
	float hh = clamp( direction.y, 0.0, 1.0 );
	float lxz = length( direction.xz );
	float side = lxz > 1e-4 ? dot( direction.xz / lxz, uSunXZ ) * 0.5 + 0.5 : 0.5;
	float tw = exp( -hh * 6.0 ) * ( 0.05 + 0.95 * side * side * side * side );
	float bh = ( hh - 0.12 ) / 0.07;
	float anti = 1.0 - side;
	float esw = uEarthShadow * anti * anti * exp( -hh * 14.0 );
	col = mix( col, dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) * vec3( 0.5, 0.6, 0.86 ), esw );
	col += mix( uNightHorizon, uNightZenith, sqrt( hh ) ) + uTwilight * tw + uBelt * ( exp( -bh * bh ) * anti * sqrt( anti ) );
	float md = max( dot( direction, uMoonDir ), 0.0 );
	col += uMoonGlow * ( pow( md, 1400.0 ) * 0.45 + pow( md, 120.0 ) * 0.07 + pow( md, 12.0 ) * 0.012 );
	if ( uMilky > 0.0005 ) {
		float gl = dot( direction, uMilkyPole );
		float band = exp( -gl * gl * 22.0 );
		float n = skyNoise( direction * 7.0 ) * 0.55 + skyNoise( direction * 17.0 ) * 0.3 + skyNoise( direction * 41.0 ) * 0.15;
		float lanes = smoothstep( 0.35, 0.75, skyNoise( direction * 11.0 + 3.7 ) ) * exp( -gl * gl * 90.0 );
		float mw = band * ( 0.35 + 0.9 * n ) * ( 1.0 - 0.6 * lanes );
		col += uMilky * mw * vec3( 0.82, 0.86, 1.0 ) * smoothstep( 0.0, 0.25, direction.y );
	}
	gl_FragColor = vec4( col, 1.0 );
`;

// Everything below uses this pattern: a camera-centred mesh pushed to the far plane.
const FAR_VERT = /* glsl */ `
varying vec3 vWorldPosition;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;
}
`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D tNoise;
uniform vec2 uOffset;
uniform vec2 uWind;
uniform float uCoverage;
uniform float uSoft;
uniform float uStretch;
uniform float uScale;
uniform float uOpacity;
uniform float uHeight;
uniform float uHaze;
uniform vec3 uSunDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uHorizon;
uniform float uForward;
varying vec3 vWorldPosition;

uniform float uCumulus;
uniform float uThick;
uniform float uTopErode;
// Fair-weather cumulus: clustered puffs of mixed sizes gated by a low-frequency fbm and a very broad
// "weather" field (clear stretches of sky between cloud streets); billowy edge erosion.
// Streaks (dawn / dusk): stretched fbm bands.
float dens( vec2 q ) {
  float w = texture2D( tNoise, q * 0.19 + vec2( 0.31, 0.72 ) ).r;
  float r = texture2D( tNoise, q * 0.61 ).r;
  float g = texture2D( tNoise, q + vec2( 0.11, 0.37 ) ).g;
#ifdef CLOUD_DETAIL
  // a second, rotated and non-integer-scaled sample hides the tile period
  vec2 qr = vec2( q.x * 0.8 - q.y * 0.6, q.x * 0.6 + q.y * 0.8 ) * 1.73;
  g = max( g, texture2D( tNoise, qr + vec2( 0.61, 0.29 ) ).g * 0.9 );
#endif
  float b = texture2D( tNoise, q * 2.9 + vec2( 0.53, 0.21 ) ).b;
#ifdef CLOUD_DETAIL
  float a = texture2D( tNoise, q * 6.7 + vec2( 0.77, 0.19 ) ).a;
#else
  float a = 0.62;
#endif
  // high-contrast weather mask: clusters and cloud streets with wide clear gaps between them
  float gate = smoothstep( 0.46, 0.6, r * 0.6 + w * 0.55 ); // ~22% cover at the day preset, as before
  float cu = g * ( 0.05 + 1.15 * gate * gate ) + ( b - 0.5 ) * 0.22 + ( a - 0.62 ) * 0.16;
  float st = r * 0.6 + w * 0.35 + ( b - 0.5 ) * 0.3 + ( a - 0.62 ) * 0.1;
  return mix( st, cu, uCumulus );
}

void main() {
  vec3 dir = normalize( vWorldPosition - cameraPosition );
  if ( dir.y < 0.004 ) discard;
  float dy = max( dir.y, 0.03 );
  vec2 W = uWind;
  vec2 Wp = vec2( -W.y, W.x );
  vec2 sxz = vec2( dot( uSunDir.xz, W ) / uStretch, dot( uSunDir.xz, Wp ) );
  float sl = length( sxz );
  vec2 ls = sl > 1e-4 ? sxz / sl * 0.02 : vec2( 0.0 );
  float mu = max( dot( dir, uSunDir ), 0.0 );
  float fwd = uForward * pow( mu, 10.0 ) * 1.8;
  // March a thin slab (flat bases at uHeight, tops at uHeight + uThick) front to back, so
  // clouds toward the horizon show their sunlit sides and tops above darker bases.
  vec3 acc = vec3( 0.0 );
  float alpha = 0.0;
  float tFirst = 0.0;
  for ( int k = 0; k < CLOUD_SLICES; k++ ) {
    float f = CLOUD_SLICES > 1 ? float( k ) / float( CLOUD_SLICES - 1 ) : 0.35;
    float t = ( uHeight + uThick * f ) / dy;
    vec2 P = dir.xz * t;
    vec2 q = vec2( dot( P, W ) / uStretch, dot( P, Wp ) ) * uScale + uOffset;
    float d = dens( q ) - f * uTopErode;
    float c = smoothstep( uCoverage, uCoverage + uSoft, d );
    if ( c < 0.003 ) continue;
    if ( alpha < 0.003 ) tFirst = t;
    float d1 = dens( q + ls );
    float occl = max( 0.0, d1 - uCoverage ) * 2.2;
    float thick = smoothstep( uCoverage, uCoverage + uSoft * 2.4, d );
    float lightT = exp( -occl * 2.4 ) * ( 1.0 - 0.35 * thick * ( 1.0 - f ) ) * ( 0.7 + 0.4 * f ) + 0.08;
    vec3 col = uShade + ( uLit - uShade ) * clamp( lightT, 0.0, 1.2 );
    col += uLit * fwd * ( 1.0 - thick );
    float a = c * ( 1.0 - alpha );
    acc += col * a;
    alpha += a;
    if ( alpha > 0.985 ) break;
  }
  if ( alpha < 0.003 ) discard;
  vec3 col = acc / alpha;
  float haze = 1.0 - exp( -tFirst * uHaze );
  col = mix( col, uHorizon, haze );
  gl_FragColor = vec4( col, alpha * uOpacity * smoothstep( 0.004, 0.09, dir.y ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${DITHER_GLSL}
}
`;

const STAR_VERT = /* glsl */ `
attribute float aBright;
attribute vec3 aColor;
attribute float aSeed;
uniform float uTime;
uniform float uVis;
uniform float uSize;
varying vec3 vColor;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vec3 dir = normalize( wp.xyz - cameraPosition );
  float el = dir.y;
  float ext = smoothstep( -0.01, 0.22, el );
  float scint = 0.08 + 0.3 * ( 1.0 - smoothstep( 0.05, 0.6, el ) );
  float tw = 1.0 + scint * sin( uTime * ( 2.1 + aSeed * 5.3 ) + aSeed * 41.0 ) * sin( uTime * ( 1.3 + aSeed * 2.9 ) + aSeed * 17.0 );
  float b = aBright * tw * ext * uVis;
  vColor = aColor * b;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w;
  gl_PointSize = uSize * ( 1.0 + 1.4 * clamp( aBright * 0.6, 0.0, 1.0 ) );
  if ( b < 0.0008 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot( c, c ) * 4.0;
  float a = exp( -r2 * 3.2 ) - 0.04;
  if ( a <= 0.0 ) discard;
  gl_FragColor = vec4( vColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const MOON_VERT = /* glsl */ `
uniform vec3 uMoonDir;
uniform float uMoonSize;
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  vec3 fwd = uMoonDir;
  vec3 rx = cross( fwd, vec3( 0.0, 1.0, 0.0 ) );
  vec3 right = dot( rx, rx ) > 1e-8 ? normalize( rx ) : vec3( 1.0, 0.0, 0.0 );
  vec3 up = cross( right, fwd );
  float R = 1000.0;
  vec3 wp = cameraPosition + fwd * R + ( right * position.x + up * position.y ) * 2.0 * R * tan( uMoonSize );
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
  gl_Position.z = gl_Position.w;
}
`;
const MOON_FRAG = /* glsl */ `
uniform vec3 uMoonDir;
uniform vec3 uSunDir;
uniform vec3 uMoonColor;
uniform float uOcclude;
uniform vec3 uBehind;
varying vec2 vUv;
float mh( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float mn( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mh( i ), mh( i + vec2( 1, 0 ) ), f.x ), mix( mh( i + vec2( 0, 1 ) ), mh( i + vec2( 1, 1 ) ), f.x ), f.y );
}
void main() {
  float r2 = dot( vUv, vUv );
  float aa = fwidth( r2 ) * 1.5 + 1e-4;
  float edge = 1.0 - smoothstep( 1.0 - aa, 1.0, r2 );
  if ( edge <= 0.0 ) discard;
  vec3 fwd = uMoonDir;
  vec3 rx = cross( fwd, vec3( 0.0, 1.0, 0.0 ) );
  vec3 right = dot( rx, rx ) > 1e-8 ? normalize( rx ) : vec3( 1.0, 0.0, 0.0 );
  vec3 up = cross( right, fwd );
  vec3 n = normalize( right * vUv.x + up * vUv.y - fwd * sqrt( max( 0.0, 1.0 - r2 ) ) );
  float lit = smoothstep( -0.06, 0.1, dot( n, uSunDir ) );
  // maria (dark basalt plains) concentrated on one side, bright highlands, crater speckle
  vec2 p = vUv * 1.7 + vec2( 0.3, -0.2 );
  float m = mn( p * 1.6 ) * 0.6 + mn( p * 3.4 + 5.0 ) * 0.3 + mn( p * 7.0 + 9.0 ) * 0.1;
  float maria = smoothstep( 0.46, 0.62, m ) * smoothstep( 0.9, -0.3, vUv.x + vUv.y * 0.4 );
  float speck = mn( vUv * 22.0 ) * 0.5 + mn( vUv * 47.0 ) * 0.5;
  float alb = mix( 1.0, 0.58, maria ) * ( 0.9 + 0.2 * speck );
  float limb = 0.82 + 0.18 * sqrt( max( 0.0, 1.0 - r2 ) );
  vec3 col = ( uMoonColor * alb * limb * ( lit + 0.012 ) + uBehind ) * edge;
  gl_FragColor = vec4( col, edge * uOcclude );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Centre on the eye from camera.matrixWorld, not camera.position: in VR three draws each eye with its
// own camera whose .position is in the reference space (rig-local), and the user camera is a child of
// the player rig. onBeforeRender runs per eye, so each eye gets a dome centred on itself (no parallax).
const _eye = new THREE.Vector3();
function followCamera(obj) {
  obj.frustumCulled = false;
  obj.onBeforeRender = (renderer, scene, camera) => {
    obj.position.copy(_eye.setFromMatrixPosition(camera.matrixWorld));
    obj.updateMatrixWorld();
  };
}

// ---------------------------------------------------------------------------------------
export function createSkySystem({ quality, cloudNoise }) {
  const group = new THREE.Group();
  group.name = 'env-sky';

  // --- Preetham sky, patched ---
  const sky = new Sky();
  sky.name = 'env-sky-dome';
  sky.scale.setScalar(SKY_SCALE);
  const su = sky.material.uniforms;
  Object.assign(su, {
    uSkyGain: { value: 1 },
    uSunDisk: { value: 1 },
    uNightZenith: { value: new THREE.Color(0, 0, 0) },
    uNightHorizon: { value: new THREE.Color(0, 0, 0) },
    uTwilight: { value: new THREE.Color(0, 0, 0) },
    uBelt: { value: new THREE.Color(0, 0, 0) },
    uEarthShadow: { value: 0 },
    uSunXZ: { value: new THREE.Vector2(1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonGlow: { value: new THREE.Color(0, 0, 0) },
    uMilkyPole: { value: new THREE.Vector3(0, 0, 1) },
    uMilky: { value: 0 },
  });
  let frag = sky.material.fragmentShader;
  frag = frag.replace('uniform vec3 up;', 'uniform vec3 up;\n' + SKY_EXTRA_UNIFORMS);
  frag = frag.replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', 'L0 += ( vSunE * 19000.0 * Fex ) * sundisk * uSunDisk;');
  frag = frag.replace('gl_FragColor = vec4( retColor, 1.0 );', SKY_COMPOSE);
  frag = frag.replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\n' + DITHER_GLSL);
  if (!frag.includes('uSunDisk;') || !frag.includes('uMilkyPole') || !frag.includes('52.9829189')) console.warn('[environment] sky shader patch did not apply');
  sky.material.fragmentShader = frag;
  sky.material.needsUpdate = true;
  followCamera(sky);
  sky.renderOrder = -100;
  group.add(sky);

  // A second dome that shares the material, for the environment-map bake (origin-centred).
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.setScalar(50);
  envSky.frustumCulled = false;

  // --- stars ---
  const starCount = quality === 'high' ? 3200 : quality === 'medium' ? 2200 : 1200;
  const rng = makeRng(4242);
  const pole = new THREE.Vector3(...CELESTIAL_POLE);
  // Galactic plane: at ~22:30 in August the Milky Way climbs from the SSW horizon through the
  // zenith toward the NE. Build its pole in world space for 22:30, then store it in the
  // star frame (hours = 0).
  const a = worldDirection(205, 0, new THREE.Vector3());
  const b = worldDirection(50, 62, new THREE.Vector3());
  const galPoleWorld = new THREE.Vector3().crossVectors(a, b).normalize();
  const q0 = new THREE.Quaternion().setFromAxisAngle(pole, (22.5 * 15 * Math.PI) / 180);
  const galPole = galPoleWorld.clone().applyQuaternion(q0); // star frame
  const e1 = new THREE.Vector3().crossVectors(galPole, new THREE.Vector3(0.3, 0.9, 0.2)).normalize();
  const e2 = new THREE.Vector3().crossVectors(galPole, e1).normalize();

  const pos = new Float32Array(starCount * 3);
  const bright = new Float32Array(starCount);
  const color = new Float32Array(starCount * 3);
  const seed = new Float32Array(starCount);
  const v = new THREE.Vector3();
  const palette = [
    [0.78, 0.86, 1.0, 0.12],
    [0.9, 0.94, 1.0, 0.3],
    [1.0, 1.0, 1.0, 0.25],
    [1.0, 0.95, 0.86, 0.18],
    [1.0, 0.84, 0.66, 0.1],
    [1.0, 0.74, 0.55, 0.05],
  ];
  const mMin = -1.4;
  const mMax = 6.3;
  const kmin = Math.pow(10, 0.5 * (mMin - mMax));
  for (let i = 0; i < starCount; i++) {
    if (rng() < 0.42) {
      // concentrate faint stars toward the galactic plane
      const phi = rng() * Math.PI * 2;
      const u1 = Math.max(1e-6, rng());
      const gb = Math.sqrt(-2 * Math.log(u1)) * Math.cos(rng() * Math.PI * 2) * 0.16;
      v.copy(e1).multiplyScalar(Math.cos(phi) * Math.cos(gb)).addScaledVector(e2, Math.sin(phi) * Math.cos(gb)).addScaledVector(galPole, Math.sin(gb));
    } else {
      const z = rng() * 2 - 1;
      const phi = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      v.set(r * Math.cos(phi), z, r * Math.sin(phi));
    }
    v.normalize().multiplyScalar(1000);
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
    const u = rng();
    const mag = mMax + 2 * Math.log10(u + (1 - u) * kmin);
    const flux = Math.pow(10, -0.4 * mag);
    bright[i] = Math.pow(flux, 0.58) * 2.4;
    let pick = rng();
    let p = palette[0];
    for (const c of palette) {
      p = c;
      pick -= c[3];
      if (pick <= 0) break;
    }
    color[i * 3] = p[0];
    color[i * 3 + 1] = p[1];
    color[i * 3 + 2] = p[2];
    seed[i] = rng();
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  starGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const starMat = new THREE.ShaderMaterial({
    name: 'env-stars',
    uniforms: { uTime: { value: 0 }, uVis: { value: 0 }, uSize: { value: 2.2 } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.name = 'env-stars';
  stars.renderOrder = -90;
  stars.frustumCulled = false;
  const starQuat = new THREE.Quaternion();
  stars.onBeforeRender = (renderer, scene, camera) => {
    stars.position.setFromMatrixPosition(camera.matrixWorld); // per eye in VR (see followCamera)
    stars.quaternion.copy(starQuat);
    stars.updateMatrixWorld();
  };
  group.add(stars);

  // --- moon ---
  const moonMat = new THREE.ShaderMaterial({
    name: 'env-moon',
    uniforms: {
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonSize: { value: (0.62 * Math.PI) / 180 }, // angular radius (~2.3x the real moon)
      uMoonColor: { value: new THREE.Color(1, 1, 1) },
      uOcclude: { value: 1 },
      uBehind: { value: new THREE.Color(0, 0, 0) },
    },
    vertexShader: MOON_VERT,
    fragmentShader: MOON_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), moonMat);
  moon.name = 'env-moon';
  moon.frustumCulled = false;
  moon.renderOrder = -80;
  group.add(moon);

  // --- clouds ---
  const cloudMat = new THREE.ShaderMaterial({
    name: 'env-clouds',
    defines: quality === 'low' ? { CLOUD_SLICES: 1 } : { CLOUD_DETAIL: 1, CLOUD_SLICES: quality === 'high' ? 3 : 2 },
    uniforms: {
      tNoise: { value: cloudNoise },
      uOffset: { value: new THREE.Vector2(0.13, 0.71) },
      uWind: { value: new THREE.Vector2(0, 1) },
      uCoverage: { value: 0.6 },
      uCumulus: { value: 1 },
      uThick: { value: 700 },
      uTopErode: { value: 0.1 },
      uSoft: { value: 0.12 },
      uStretch: { value: 1 },
      uScale: { value: 1 / 11000 },
      uOpacity: { value: 1 },
      uHeight: { value: 1600 },
      uHaze: { value: 1 / 60000 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uLit: { value: new THREE.Color(1, 1, 1) },
      uShade: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uHorizon: { value: new THREE.Color(0.7, 0.7, 0.7) },
      uForward: { value: 1 },
    },
    vertexShader: FAR_VERT,
    fragmentShader: CLOUD_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
  const clouds = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMat);
  clouds.name = 'env-clouds';
  clouds.scale.setScalar(SKY_SCALE * 0.9);
  clouds.renderOrder = -70;
  followCamera(clouds);
  group.add(clouds);

  return {
    group,
    sky,
    envSky,
    skyUniforms: su,
    stars,
    starMaterial: starMat,
    starQuaternion: starQuat,
    galPole,
    moon,
    moonMaterial: moonMat,
    clouds,
    cloudMaterial: cloudMat,
    dispose() {
      sky.geometry.dispose();
      sky.material.dispose();
      starGeo.dispose();
      starMat.dispose();
      moon.geometry.dispose();
      moonMat.dispose();
      clouds.geometry.dispose();
      cloudMat.dispose();
    },
  };
}
