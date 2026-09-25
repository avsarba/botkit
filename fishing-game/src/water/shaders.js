// GLSL for the lake surface. The same vertex/fragment pair is compiled twice:
//
//  PASS_MUL  multiplies what is already in the framebuffer (lake bed, fish,
//            pilings, drawn opaque before the water) by the per-channel
//            Beer-Lambert transmittance (red dies first) and (1 - Fresnel).
//  PASS_ADD  adds reflection (planar mirror or sky fallback), the water body's
//            own scattered light, the sun glint, splash foam and fog.
//
// Both passes blend in display space (the framebuffer holds tone-mapped sRGB).
// Quality levels only flip uniforms (uUseRefl / uUseDepth): every path is compiled
// in, so a runtime quality change never recompiles the water programs.
// They estimate the radiance under the water (uBedEst) so that
// dst * M + S reproduces display(bed * T + A) for that estimate; for other bed
// brightnesses the error is small because the display curve is close to a
// power law (multiplying by M is then exact).
import { WAVE_COUNT } from './waves.js';
import { MAX_RINGS } from './ripples.js';

const common = /* glsl */ `
#define NW ${WAVE_COUNT}
#define MAX_RINGS ${MAX_RINGS}
uniform vec4 uWaveA[NW];   // dir.x, dir.z, k, amplitude
uniform vec4 uWaveB[NW];   // phase, Q, wavelength, -
uniform vec4 uRingA[MAX_RINGS]; // x, z, age, amplitude (m)
uniform vec4 uRingB[MAX_RINGS]; // speed, max radius, k, foam (>= 0: impact; -1 - foam: no crater)
uniform int uRingCount;
uniform sampler2D tEnvDepth;
uniform vec4 uEnvDepthXf;   // minX, minZ, 1/width, 1/depth
uniform float uEnvDepthMode;// 0: R = depth/12 (environment), 1: R = sqrt(depth/12) (fallback)

float envDepthAt(vec2 xz) {
  vec2 uv = (xz - uEnvDepthXf.xy) * uEnvDepthXf.zw;
  float r = texture2D(tEnvDepth, clamp(uv, vec2(0.0), vec2(1.0))).r;
  return uEnvDepthMode > 0.5 ? r * r * 12.0 : r * 12.0;
}
`;

export const waterVertex = /* glsl */ `
${common}
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aCell;
uniform vec2 uWindDir;      // unit (x, z): where the wind blows toward
varying vec3 vWorld;
varying vec2 vX0;
varying vec3 vViewPos;
varying float vLee;

// Sheltered water: with land a short way upwind the wind has had no fetch to raise
// ripples, and the treeline puts the strip along the windward shore in its wind
// shadow, so it stays glassy and mirrors the forest. 1 = fully sheltered.
float landAt(vec2 xz) {
  return 1.0 - smoothstep(0.03, 0.4, envDepthAt(xz));
}
float leeAt(vec2 x0) {
  vec2 up = -uWindDir;
  float s = landAt(x0 + up * 16.0);
  s = max(s, 0.8 * landAt(x0 + up * 40.0));
  s = max(s, 0.55 * landAt(x0 + up * 75.0));
  s = max(s, 0.3 * landAt(x0 + up * 120.0));
  return s;
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 x0 = wp.xz;
  vec3 disp = vec3(0.0);
  for (int i = 0; i < NW; i++) {
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    // drop components this part of the grid cannot resolve (flat far away)
    float fade = 1.0 - smoothstep(0.18 * B.z, 0.42 * B.z, aCell);
    float amp = A.w * fade;
    float th = A.z * dot(A.xy, x0) - B.x;
    disp.xz += (B.y * amp * cos(th)) * A.xy;
    disp.y += amp * sin(th);
  }
  // splash crater, then rebound, at the centre of strong rings
  for (int i = 0; i < MAX_RINGS; i++) {
    if (i >= uRingCount) break;
    vec4 R = uRingA[i];
    if (R.w < 0.003 || R.z > 2.0 || uRingB[i].w < 0.0) continue;
    vec2 dv = x0 - R.xy;
    float s2 = 0.09 + 0.1 * R.z;
    float d2 = dot(dv, dv);
    if (d2 > 9.0 * s2) continue;
    disp.y -= R.w * 2.0 * exp(-R.z * 2.5) * cos(R.z * 9.0) * exp(-d2 / s2);
  }
  wp.xyz += disp;
  vWorld = wp.xyz;
  vX0 = x0;
  vLee = leeAt(x0);
  vec4 mvPosition = viewMatrix * wp;
  vViewPos = mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

export const waterFragment = /* glsl */ `
${common}
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

#ifdef ENVMAP_TYPE_CUBE_UV
  #include <cube_uv_reflection_fragment>
  uniform sampler2D tEnv;
  uniform float uEnvIntensity;
#endif

uniform vec3 uSunDir;
uniform vec3 uSunRad;       // sun irradiance (colour * intensity * skyline visibility), 0 below the horizon
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uSigma;        // attenuation (1/m) per channel
uniform float uDownK;       // extra path factor for light going down to the bed
uniform vec3 uBodyRad;      // radiance of optically deep water (in-scatter)
uniform vec3 uBedEst;       // estimate of the radiance under the surface (compositing)
uniform vec3 uFoamRad;
uniform sampler2D tDetail;
uniform vec4 uDet0;         // cos, sin, 1/tile, slope strength
uniform vec4 uDet1;
uniform vec4 uDet2;
uniform vec4 uDetOff01;     // scroll offsets layer 0 (xy), layer 1 (zw)
uniform vec4 uDetOff2P;     // scroll offset layer 2 (xy), wind patches (zw)
uniform float uPatchScale;
uniform float uRuffle;
uniform vec2 uResolution;
uniform float uReflClamp;
uniform float uSpreadCap;   // max mirror blur (radians): light airs cannot smear the treeline much

// depth pre-pass (high / medium) or the environment depth map (low)
uniform float uUseDepth;
uniform sampler2D tSceneDepth;
uniform vec2 uDepthTexel;
uniform float uCamNear;     // near / far of the (range-limited) pre-pass camera
uniform float uCamFar;

// planar reflection (high / medium) or the sky with a dark far-shore band (low)
uniform float uUseRefl;
uniform sampler2D tRefl;
uniform sampler2D tReflDepth;
uniform mat4 uTexMatrix;
uniform mat4 uReflProjInv;
uniform mat4 uReflCamWorld;  // mirror camera -> world
uniform vec4 uReflProjXY;    // mirror projection e0, e5, e8, e9
uniform float uReflPxPerRad; // reflection-target pixels per radian
uniform vec2 uReflTexel;
uniform vec3 uShoreColor;
uniform float uShoreElev;
// VR: the band follows the real skyline. tSkyline per azimuth atan2(x, -z): R = occluder top (world y),
// G = its distance from the dock
uniform float uShoreProfile;
uniform sampler2D tSkyline;

varying vec3 vWorld;
varying vec2 vX0;
varying vec3 vViewPos;
varying float vLee;

vec3 toDisplay(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}

// Slope (dh/dx, dh/dz) of all Gerstner components at the undisplaced point.
// Components shorter than the pixel footprint are dropped and their slope
// variance moves into the glint roughness instead (no shimmering far away).
vec2 gerstnerSlope(vec2 x0, float foot, float calm, inout float var) {
  float a = 0.0, b = 0.0, c = 0.0, px = 0.0, pz = 0.0;
  for (int i = 0; i < NW; i++) {
    vec4 A = uWaveA[i];
    vec4 B = uWaveB[i];
    float w = 1.0 - smoothstep(0.1 * B.z, 0.4 * B.z, foot);
    float kA = A.z * A.w;
    // (sheltered / calm-patch water is smoother than the average wave field)
    var += (1.0 - w) * 0.5 * kA * kA * calm;
    kA *= w;
    float th = A.z * dot(A.xy, x0) - B.x;
    float s = sin(th);
    float co = cos(th);
    float qk = B.y * kA * s;
    a += qk * A.x * A.x;
    b += qk * A.x * A.y;
    c += qk * A.y * A.y;
    px += kA * A.x * co;
    pz += kA * A.y * co;
  }
  vec3 n = vec3(-(b * pz + (1.0 - c) * px), (1.0 - a) * (1.0 - c) - b * b, -(b * px + (1.0 - a) * pz));
  return -n.xz / max(n.y, 0.2);
}

vec2 detailSlope(vec2 p, vec4 L, vec2 off, float strength, inout float var) {
  vec2 uv = vec2(L.x * p.x - L.y * p.y, L.y * p.x + L.x * p.y) * L.z + off;
  vec3 n = texture2D(tDetail, uv).xyz * 2.0 - 1.0;
  float len = max(length(n), 1e-3);
  vec2 s = -n.xy / max(n.z, 0.15);
  float st = L.w * strength;
  // Toksvig: mip-averaged normals are shorter; that lost detail becomes roughness
  var += 2.0 * st * st * clamp((1.0 - len) / len, 0.0, 2.0);
  return vec2(L.x * s.x + L.y * s.y, -L.y * s.x + L.x * s.y) * st;
}

vec2 rippleSlope(vec2 x0, float foot, inout float var, inout float foam) {
  vec2 sl = vec2(0.0);
  for (int i = 0; i < MAX_RINGS; i++) {
    if (i >= uRingCount) break;
    vec4 R = uRingA[i];
    vec4 S = uRingB[i];
    vec2 dv = x0 - R.xy;
    float d = length(dv);
    float age = R.z;
    float rf = S.x * age;
    float lam = 6.2831853 / S.z;
    if (d > rf + 2.0 * lam + 1.2) continue;
    float crater = S.w >= 0.0 ? 1.0 : 0.0;
    float fo = S.w >= 0.0 ? S.w : -S.w - 1.0;
    if (fo > 0.0) {
      float fr = (0.2 + 0.45 * fo) * (1.0 + 0.9 * age);
      // fresh white water is thrown out into a ring around a dark, disturbed
      // hole; the hole fills in over the first ~0.3 s
      float hole = mix(1.0, smoothstep(0.2 * fr, 0.7 * fr, d), exp(-age * 3.0));
      foam += fo * exp(-age * 0.45) * (1.0 - smoothstep(0.3 * fr, fr, d)) * hole;
    }
    float x = d - rf;
    float wdt = x > 0.0 ? 0.5 * lam : lam * (1.0 + 2.0 * age); // trailing crests
    float env = exp(-(x * x) / (wdt * wdt));
    float fade = 1.0 - smoothstep(0.6, 1.0, rf / S.y);
    // spreading (1/sqrt r) plus viscous/capillary damping that grows with k
    float amp = R.w * exp(-age * (0.12 + 0.0065 * S.z)) * fade / sqrt(1.0 + 3.0 * rf);
    float aa = 1.0 - smoothstep(0.12 * lam, 0.5 * lam, foot);
    float slope = amp * env * S.z;
    var += (1.0 - aa) * 0.5 * slope * slope;
    float s2 = 0.09 + 0.1 * age;
    float cr = -crater * R.w * 2.0 * exp(-age * 2.5) * cos(age * 9.0) * exp(-d * d / s2);
    float crSlope = cr * (-2.0 * d / s2);
    sl += (dv / max(d, 1e-4)) * (slope * aa * cos(S.z * x) + crSlope);
  }
  return sl;
}

float smithG1(float ndx, float a2) {
  float c = ndx / (sqrt(a2) * sqrt(max(1.0 - ndx * ndx, 1e-6)));
  return c < 1.6 ? (3.535 * c + 2.181 * c * c) / (1.0 + 2.276 * c + 2.577 * c * c) : 1.0;
}

vec3 skyFallback(vec3 R) {
  vec3 c;
  #ifdef ENVMAP_TYPE_CUBE_UV
    c = textureCubeUV(tEnv, R, 0.04).rgb * uEnvIntensity;
  #else
    c = mix(uHorizonColor, uSkyColor, pow(clamp(R.y, 0.0, 1.0), 0.5));
  #endif
  // the dark band of the forested far shore just above the horizon
  float band = 1.0 - smoothstep(uShoreElev * 0.3, uShoreElev, R.y);
  if (uShoreProfile > 0.5) {
    // the treeline / hills that form the skyline along this azimuth, seen from this point of the
    // surface (the occluder sits at a known distance from the dock): the mirror image of the real
    // skyline instead of a fixed height
    float lxz = length(R.xz);
    if (lxz > 1e-4) {
      vec2 dir = R.xz / lxz;
      float az = atan(dir.x, -dir.y);
      vec2 sk = texture2D(tSkyline, vec2(az * 0.1591549 + 0.5, 0.5)).rg;
      float dp = max(sk.y - dot(vWorld.xz, dir), 2.0);
      float tS = (sk.x - vWorld.y) / dp; // tangent of the skyline's elevation from here
      float tR = R.y / lxz;
      band = 1.0 - smoothstep(tS - 0.012, tS + 0.004, tR);
    }
  }
  return mix(c, uShoreColor, band * 0.92);
}

// NaN / Inf by bit pattern: a fast-math shader compiler may fold isnan() to
// false and let min / max / clamp pass NaN through as 0 or NaN, but it cannot
// reason integer bit tests away.
bool nanBits(float x) {
  uint u = floatBitsToUint(x);
  return (u & 0x7f800000u) == 0x7f800000u && (u & 0x007fffffu) != 0u;
}
bool anyNaN(vec3 c) {
  return nanBits(c.r) || nanBits(c.g) || nanBits(c.b) || any(isnan(c));
}
// clamp to [0, hi]; +Inf -> hi, -Inf -> 0 (NaN excluded by the caller)
float finiteClamp(float x, float hi) {
  uint u = floatBitsToUint(x);
  if ((u & 0x7f800000u) == 0x7f800000u) return (u >> 31u) != 0u ? 0.0 : hi;
  return clamp(x, 0.0, hi);
}
vec3 finiteClamp(vec3 c, float hi) {
  return vec3(finiteClamp(c.r, hi), finiteClamp(c.g, hi), finiteClamp(c.b, hi));
}

// The mirror is rendered from one camera below the surface, so a texel whose
// mirror ray crosses the water plane over land looks up through the (single-
// sided) terrain from inside and shows sky or haze. Taps land there when rough
// facets near a shore tilt the reflected ray down: the true ray from the facet
// hits the bank and the trunks at the waterline, not the sky. Without this the
// blur lifts a pale band along every far shore.
bool mirrorThroughLand(vec2 uv) {
  if (textureLod(tReflDepth, uv, 0.0).r < 0.99999) return false; // something was drawn: a real image
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 d = mat3(uReflCamWorld) * vec3((ndc.x + uReflProjXY.z) / uReflProjXY.x, (ndc.y + uReflProjXY.w) / uReflProjXY.y, -1.0);
  vec3 o = uReflCamWorld[3].xyz;
  if (d.y <= 1e-6 || o.y >= 0.0) return true; // never reaches the surface in front of the mirror camera
  vec2 hit = o.xz + d.xz * (-o.y / d.y);
  return envDepthAt(hit) < 0.05;
}

// One tap of the mirror image. A NaN texel (a broken normal somewhere in the
// scene, spread into a block by the mip chain and the blur) is dropped instead
// of being shown; Inf (half-float overflow at the sun disc) and anything
// brighter than the clamp read as the brightest allowed value.
void reflTap(vec2 uv, float lod, float w, inout vec3 acc, inout float wsum) {
  uv = clamp(uv, vec2(0.001), vec2(0.999));
  vec3 c = textureLod(tRefl, uv, lod).rgb;
  if (anyNaN(c)) return;
  c = finiteClamp(c, uReflClamp);
  if (mirrorThroughLand(uv)) c = uShoreColor;
  acc += c * w;
  wsum += w;
}

// Real glints are thousands of times brighter than a screen; clipped per
// channel after the tone curve they turn into flat white shapes. Compress the
// brightest channel with a soft knee (in exposure-scaled units) and scale all
// channels together, so the core keeps the key light's hue (gold at dusk,
// silver under the moon) and the lobe keeps its falloff. The peak follows the
// key light's own display level: sun glitter tops out near white (~0.93 after
// ACES), the moon path at a softer silver instead of a floodlight.
vec3 glintKnee(vec3 g) {
  float ex = 1.0;
  #ifdef TONE_MAPPING
    ex = toneMappingExposure;
  #endif
  float key = max(max(uSunRad.r, uSunRad.g), uSunRad.b) * ex;
  float km = clamp(1.3 * key, 0.7, 2.6); // asymptotic peak
  float kt = 0.35 * km;                  // untouched below this
  float m = max(max(g.r, g.g), g.b) * ex;
  if (!(m > kt)) return g;
  float mk = kt + (km - kt) * (1.0 - exp(-(m - kt) / (km - kt)));
  return g * (mk / m);
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 toEye = cameraPosition - vWorld;
  float dist = max(length(toEye), 1e-3);
  vec3 V = toEye / dist;
  float foot = max(length(dFdx(vX0)), length(dFdy(vX0)));

  // ---- surface normal ------------------------------------------------------
  float var = 0.0; // slope variance the pixel cannot resolve (grows with distance)
  float windPatch = texture2D(tDetail, vX0 * uPatchScale + uDetOff2P.zw).a;
  // wind patches ("cat's paws"), sheltered shallows and the lee of the windward
  // shore vary the roughness
  float lee = clamp(vLee, 0.0, 1.0);
  float calm = mix(0.25, 1.3, smoothstep(0.25, 0.75, windPatch)) * mix(0.25, 1.0, smoothstep(0.15, 1.4, envDepthAt(vX0)))
             * (1.0 - 0.8 * lee);
  float ruffle = uRuffle * calm;
  vec2 sl = gerstnerSlope(vX0, foot, calm * calm, var) * (1.0 - 0.6 * lee);
  sl += detailSlope(vX0, uDet0, uDetOff01.xy, ruffle, var);
  sl += detailSlope(vX0, uDet1, uDetOff01.zw, ruffle, var);
  sl += detailSlope(vX0, uDet2, uDetOff2P.xy, ruffle, var);
  float foam = 0.0;
  sl += rippleSlope(vX0, foot, var, foam);
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  // Facets turned away from the eye are hidden behind the crests in front of
  // them; keep N.V at least half the flat surface's (which is tiny far away,
  // so the far-shore mirror is not lifted into the sky).
  float nv = dot(N, V);
  float minNV = 0.5 * clamp(V.y, 0.0, 0.06);
  if (nv < minNV) N = normalize(N + V * (minNV - nv));
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // ---- water thickness in front of whatever lies below ----------------------
  float cosI = clamp(V.y, 0.02, 1.0);
  float cosT = sqrt(1.0 - (1.0 - cosI * cosI) / 1.7689); // refracted ray (n = 1.33)
  float dv;
  if (uUseDepth > 0.5) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    float z0 = texture2D(tSceneDepth, suv + vec2(-0.5, -0.5) * uDepthTexel).r;
    float z1 = texture2D(tSceneDepth, suv + vec2(0.5, -0.5) * uDepthTexel).r;
    float z2 = texture2D(tSceneDepth, suv + vec2(-0.5, 0.5) * uDepthTexel).r;
    float z3 = texture2D(tSceneDepth, suv + vec2(0.5, 0.5) * uDepthTexel).r;
    float zmax = max(max(z0, z1), max(z2, z3)); // thickest wins: no clear halos at silhouettes
    if (zmax > 0.9999999) {
      // nothing under water registered here (or beyond the pre-pass range, where
      // Fresnel leaves only a few percent of transmission anyway)
      dv = envDepthAt(vX0) + 0.5;
    } else {
      float sceneDist = -perspectiveDepthToViewZ(zmax, uCamNear, uCamFar) * dist / max(-vViewPos.z, 1e-3);
      dv = max(cosI * (sceneDist - dist), 0.0);
    }
  } else {
    dv = envDepthAt(vX0);
  }
  float Lv = dv / cosT;
  vec3 T = exp(-uSigma * (Lv + dv * uDownK));
  // Soft edge where the water meets land. It only matters close by (the seam
  // is sub-pixel far away, where the mirror must reach right to the waterline).
  float shore = smoothstep(0.0, 0.14 * clamp(V.y * 4.0, 0.03, 1.0), dv);

  float foamC = 0.0;
  if (foam > 0.001) {
    // aerated water: bubble clumps at three scales under a high-contrast mask.
    // Fresh foam covers most of its patch; as it fades the covered fraction
    // shrinks into scattered clumps instead of the whole patch dimming.
    float fn = texture2D(tDetail, vX0 * 3.1 + vec2(0.37, 0.11)).a * 0.5
             + texture2D(tDetail, vX0 * 0.83).a * 0.3
             + texture2D(tDetail, vX0 * 9.7 + vec2(0.71, 0.29)).a * 0.2;
    float thr = 0.74 - 0.36 * clamp(foam, 0.0, 1.0);
    foamC = smoothstep(thr - 0.07, thr + 0.07, fn) * smoothstep(0.03, 0.35, foam);
  }

  vec3 Teff = mix(vec3(1.0), (1.0 - F) * T * (1.0 - foamC), shore);
  float fogF = 0.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif

  vec3 base = uBedEst * Teff;
  vec3 pBase = toDisplay(base);
  vec3 M = clamp(pBase / max(toDisplay(uBedEst), vec3(1e-4)), 0.0, 1.0);

#ifdef PASS_MUL
  gl_FragColor = vec4(M, 1.0);
  #ifdef WATER_DEBUG
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  #endif
#else
  // ---- reflection -----------------------------------------------------------
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.004);
  R = normalize(R);
  vec3 refl;
  if (uUseRefl > 0.5) {
    // Offset the mirror lookup by how far the tilted facet turns the reflected
    // ray, at the distance of what is mirrored there (reflection depth): near
    // posts wobble gently, the far treeline breaks up more.
    vec3 R0 = vec3(-V.x, V.y, -V.z);
    vec4 pc = uTexMatrix * vec4(vWorld, 1.0);
    vec2 uv0 = clamp(pc.xy / pc.w, vec2(0.0), vec2(1.0));
    // distance from this point of the surface to what it mirrors
    float rz = texture2D(tReflDepth, uv0).r;
    float dR = 600.0;
    if (rz < 0.99999) {
      vec4 vp = uReflProjInv * vec4(uv0 * 2.0 - 1.0, rz * 2.0 - 1.0, 1.0);
      if (abs(vp.w) > 1e-6) dR = clamp(length(vp.xyz / vp.w) - dist, 0.25, 600.0);
    }
    vec4 pa = uTexMatrix * vec4(vWorld + R * dR, 1.0);
    vec4 pb = uTexMatrix * vec4(vWorld + R0 * dR, 1.0);
    vec2 ruv = uv0;
    if (pa.w > 0.01 && pb.w > 0.01) ruv += pa.xy / pa.w - pb.xy / pb.w;
    // Unresolved ripples blur the mirror image. Facets tilt the reflected ray
    // mostly up/down in a grazing view, so the blur is a vertical streak.
    float spreadV = min(0.85 * sqrt(var), uSpreadCap) * uReflPxPerRad; // ~1 sigma, target pixels
    float spreadH = spreadV * clamp(V.y * 4.0, 0.12, 1.0);
    float lod = log2(max(1.0, max(spreadH, spreadV * 0.4)));
    vec2 uvc = clamp(ruv, vec2(0.001), vec2(0.999));
    vec2 dy = vec2(0.0, spreadV * uReflTexel.y);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    reflTap(uvc, lod, 0.36, acc, wsum);
    reflTap(uvc + dy, lod, 0.24, acc, wsum);
    reflTap(uvc - dy, lod, 0.24, acc, wsum);
    reflTap(uvc + 2.0 * dy, lod, 0.08, acc, wsum);
    reflTap(uvc - 2.0 * dy, lod, 0.08, acc, wsum);
    refl = wsum > 0.0 ? acc / wsum : uHorizonColor;
  } else {
    refl = skyFallback(R);
  }
  // A NaN never turns into a white slab; Inf (half-float sky at the sun disc) is
  // the brightest allowed value. The sun itself comes from the glint term.
  if (anyNaN(refl)) refl = uHorizonColor;
  refl = finiteClamp(refl, uReflClamp);

  // ---- sun glint (Beckmann lobe; roughness = unresolved slope variance) -----
  vec3 L = uSunDir;
  vec3 hv = L + V;
  vec3 H = hv * inversesqrt(max(dot(hv, hv), 1e-8));
  float NdH = clamp(dot(N, H), 1e-4, 1.0);
  float NdL = dot(N, L);
  float VdH = clamp(dot(V, H), 0.0, 1.0);
  float a2 = 2.0 * (var + 0.0003); // + sun disc and sub-texel roughness
  float c2 = NdH * NdH;
  float D = exp((c2 - 1.0) / (c2 * a2)) / (PI * a2 * c2 * c2);
  float FH = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
  float G = smithG1(NdV, a2) * smithG1(clamp(NdL, 0.0, 1.0), a2);
  vec3 glint = NdL > 0.0 ? glintKnee(uSunRad * (FH * D * G / (4.0 * max(NdV, 0.05)))) : vec3(0.0);

  vec3 inscat = uBodyRad * (vec3(1.0) - T);
  vec3 A = F * shore * refl
         + shore * ((1.0 - F) * inscat * (1.0 - foamC) + glint * (1.0 - foamC) + uFoamRad * foamC);
  vec3 S = (1.0 - fogF) * (toDisplay(base + A) - pBase);
  #ifdef USE_FOG
    S += fogF * fogColor * (vec3(1.0) - M);
  #endif
  gl_FragColor = vec4(max(S, vec3(0.0)), 1.0);
  #ifdef WATER_DEBUG
    // Integration aid (compile-time only): 1 reflection, 2 depth of water over the
    // visible under-water point (1 = 5 m), 3 transmittance, 4 normal, 5 glint,
    // 6 lee (r) / calm (g) / unresolved slope (b).
    #if WATER_DEBUG == 1
      gl_FragColor.rgb = toDisplay(refl);
    #elif WATER_DEBUG == 2
      gl_FragColor.rgb = vec3(dv / 5.0, shore, 0.0);
    #elif WATER_DEBUG == 3
      gl_FragColor.rgb = T;
    #elif WATER_DEBUG == 4
      gl_FragColor.rgb = N * 0.5 + 0.5;
    #elif WATER_DEBUG == 6
      gl_FragColor.rgb = vec3(lee, clamp(calm / 1.3, 0.0, 1.0), clamp(sqrt(var) * 4.0, 0.0, 1.0));
    #else
      gl_FragColor.rgb = toDisplay(glint);
    #endif
    if (any(isnan(gl_FragColor.rgb))) gl_FragColor.rgb = vec3(1.0, 0.0, 1.0);
  #endif
#endif
}
`;
