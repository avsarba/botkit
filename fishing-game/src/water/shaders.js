// GLSL for the lake surface. The same vertex/fragment pair is compiled twice:
//
//  PASS_MUL  multiplies what is already in the framebuffer (lake bed, fish,
//            pilings, drawn opaque before the water) by the per-channel
//            Beer-Lambert transmittance (red dies first) and (1 - Fresnel).
//  PASS_ADD  adds reflection (planar mirror or sky fallback), the water body's
//            own scattered light, the sun glint, splash foam and fog.
//
// Both passes blend in display space (the framebuffer holds tone-mapped sRGB).
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
uniform vec4 uRingB[MAX_RINGS]; // speed, max radius, k, foam
uniform int uRingCount;
`;

export const waterVertex = /* glsl */ `
${common}
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute float aCell;
varying vec3 vWorld;
varying vec2 vX0;
varying vec3 vViewPos;

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
    if (R.w < 0.003 || R.z > 2.0) continue;
    vec2 dv = x0 - R.xy;
    float s2 = 0.09 + 0.1 * R.z;
    float d2 = dot(dv, dv);
    if (d2 > 9.0 * s2) continue;
    disp.y -= R.w * 2.0 * exp(-R.z * 2.5) * cos(R.z * 9.0) * exp(-d2 / s2);
  }
  wp.xyz += disp;
  vWorld = wp.xyz;
  vX0 = x0;
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
uniform vec3 uSunRad;       // sun irradiance (colour * intensity), 0 below the horizon
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
uniform sampler2D tEnvDepth;
uniform vec4 uEnvDepthXf;   // minX, minZ, 1/width, 1/depth
uniform float uEnvDepthMode;// 0: R = depth/12 (environment), 1: R = sqrt(depth/12) (fallback)
uniform float uReflClamp;

#ifdef USE_DEPTH_PREPASS
  uniform sampler2D tSceneDepth;
  uniform vec2 uDepthTexel;
  uniform float uCamNear;
  uniform float uCamFar;
#endif

#ifdef USE_REFLECTION
  uniform sampler2D tRefl;
  uniform sampler2D tReflDepth;
  uniform mat4 uTexMatrix;
  uniform mat4 uReflProjInv;
  uniform float uReflPxPerRad; // reflection-target pixels per radian
  uniform vec2 uReflTexel;
#else
  uniform vec3 uShoreColor;
  uniform float uShoreElev;
#endif

varying vec3 vWorld;
varying vec2 vX0;
varying vec3 vViewPos;

vec3 toDisplay(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}

float envDepthAt(vec2 xz) {
  vec2 uv = (xz - uEnvDepthXf.xy) * uEnvDepthXf.zw;
  float r = texture2D(tEnvDepth, clamp(uv, vec2(0.0), vec2(1.0))).r;
  return uEnvDepthMode > 0.5 ? r * r * 12.0 : r * 12.0;
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
    if (S.w > 0.0) {
      float fr = (0.2 + 0.45 * S.w) * (1.0 + 0.9 * age);
      foam += S.w * exp(-age * 0.45) * (1.0 - smoothstep(0.3 * fr, fr, d));
    }
    float x = d - rf;
    float wdt = x > 0.0 ? 0.5 * lam : lam * (1.0 + 2.0 * age); // trailing crests
    float env = exp(-(x * x) / (wdt * wdt));
    float fade = 1.0 - smoothstep(0.6, 1.0, rf / S.y);
    float amp = R.w * exp(-age * 0.7) * fade / sqrt(1.0 + 3.0 * rf);
    float aa = 1.0 - smoothstep(0.12 * lam, 0.5 * lam, foot);
    float slope = amp * env * S.z;
    var += (1.0 - aa) * 0.5 * slope * slope;
    float s2 = 0.09 + 0.1 * age;
    float cr = -R.w * 2.0 * exp(-age * 2.5) * cos(age * 9.0) * exp(-d * d / s2);
    float crSlope = cr * (-2.0 * d / s2);
    sl += (dv / max(d, 1e-4)) * (slope * aa * cos(S.z * x) + crSlope);
  }
  return sl;
}

float smithG1(float ndx, float a2) {
  float c = ndx / (sqrt(a2) * sqrt(max(1.0 - ndx * ndx, 1e-6)));
  return c < 1.6 ? (3.535 * c + 2.181 * c * c) / (1.0 + 2.276 * c + 2.577 * c * c) : 1.0;
}

#ifndef USE_REFLECTION
vec3 skyFallback(vec3 R) {
  vec3 c;
  #ifdef ENVMAP_TYPE_CUBE_UV
    c = textureCubeUV(tEnv, R, 0.04).rgb * uEnvIntensity;
  #else
    c = mix(uHorizonColor, uSkyColor, pow(clamp(R.y, 0.0, 1.0), 0.5));
  #endif
  // the dark band of the forested far shore just above the horizon
  float band = 1.0 - smoothstep(uShoreElev * 0.3, uShoreElev, R.y);
  return mix(c, uShoreColor, band * 0.92);
}
#endif

void main() {
  #include <logdepthbuf_fragment>
  vec3 toEye = cameraPosition - vWorld;
  float dist = max(length(toEye), 1e-3);
  vec3 V = toEye / dist;
  float foot = max(length(dFdx(vX0)), length(dFdy(vX0)));

  // ---- surface normal ------------------------------------------------------
  float var = 0.0; // slope variance the pixel cannot resolve (grows with distance)
  float windPatch = texture2D(tDetail, vX0 * uPatchScale + uDetOff2P.zw).a;
  // wind patches ("cat's paws") and sheltered shallows vary the roughness
  float calm = mix(0.25, 1.3, smoothstep(0.25, 0.75, windPatch)) * mix(0.25, 1.0, smoothstep(0.15, 1.4, envDepthAt(vX0)));
  float ruffle = uRuffle * calm;
  vec2 sl = gerstnerSlope(vX0, foot, calm * calm, var);
  sl += detailSlope(vX0, uDet0, uDetOff01.xy, ruffle, var);
  sl += detailSlope(vX0, uDet1, uDetOff01.zw, ruffle, var);
  sl += detailSlope(vX0, uDet2, uDetOff2P.xy, ruffle, var);
  float foam = 0.0;
  sl += rippleSlope(vX0, foot, var, foam);
  vec3 N = normalize(vec3(-sl.x, 1.0, -sl.y));
  float nv = dot(N, V);
  if (nv < 0.03) N = normalize(N + V * (0.03 - nv)); // facets turned away are hidden
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // ---- water thickness in front of whatever lies below ----------------------
  float cosI = clamp(V.y, 0.02, 1.0);
  float cosT = sqrt(1.0 - (1.0 - cosI * cosI) / 1.7689); // refracted ray (n = 1.33)
  float dv;
  #ifdef USE_DEPTH_PREPASS
    vec2 suv = gl_FragCoord.xy / uResolution;
    float z0 = texture2D(tSceneDepth, suv + vec2(-0.5, -0.5) * uDepthTexel).r;
    float z1 = texture2D(tSceneDepth, suv + vec2(0.5, -0.5) * uDepthTexel).r;
    float z2 = texture2D(tSceneDepth, suv + vec2(-0.5, 0.5) * uDepthTexel).r;
    float z3 = texture2D(tSceneDepth, suv + vec2(0.5, 0.5) * uDepthTexel).r;
    float zmax = max(max(z0, z1), max(z2, z3)); // thickest wins: no clear halos at silhouettes
    if (zmax > 0.9999999) {
      dv = envDepthAt(vX0) + 0.5; // nothing under-water registered here
    } else {
      float sceneDist = -perspectiveDepthToViewZ(zmax, uCamNear, uCamFar) * dist / max(-vViewPos.z, 1e-3);
      dv = max(cosI * (sceneDist - dist), 0.0);
    }
  #else
    dv = envDepthAt(vX0);
  #endif
  float Lv = dv / cosT;
  vec3 T = exp(-uSigma * (Lv + dv * uDownK));
  // Soft edge where the water meets land. It only matters close by (the seam
  // is sub-pixel far away, where the mirror must reach right to the waterline).
  float shore = smoothstep(0.0, 0.14 * clamp(V.y * 4.0, 0.03, 1.0), dv);

  float foamC = 0.0;
  if (foam > 0.001) {
    // aerated water: clumpy, with bubbles; breaks up as it fades
    float fn = texture2D(tDetail, vX0 * 3.1 + vec2(0.37, 0.11)).a * 0.65 + texture2D(tDetail, vX0 * 0.83).a * 0.35;
    foamC = smoothstep(0.08, 0.6, foam * (0.35 + 1.1 * fn));
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
  #ifdef USE_REFLECTION
    // Offset the mirror lookup by how far the tilted facet turns the reflected
    // ray, for content ~uReflDist away (ripples streak the reflection).
    vec3 R0 = vec3(-V.x, V.y, -V.z);
    vec4 pc = uTexMatrix * vec4(vWorld, 1.0);
    vec2 uv0 = clamp(pc.xy / pc.w, vec2(0.0), vec2(1.0));
    // distance from this point of the surface to what it mirrors
    float rz = texture2D(tReflDepth, uv0).r;
    float dR = 600.0;
    if (rz < 0.99999) {
      vec4 vp = uReflProjInv * vec4(uv0 * 2.0 - 1.0, rz * 2.0 - 1.0, 1.0);
      dR = clamp(length(vp.xyz / vp.w) - dist, 0.25, 600.0);
    }
    vec4 pa = uTexMatrix * vec4(vWorld + R * dR, 1.0);
    vec4 pb = uTexMatrix * vec4(vWorld + R0 * dR, 1.0);
    vec2 ruv = uv0;
    if (pa.w > 0.01 && pb.w > 0.01) ruv += pa.xy / pa.w - pb.xy / pb.w;
    // Unresolved ripples blur the mirror image. Facets tilt the reflected ray
    // mostly up/down in a grazing view, so the blur is a vertical streak.
    float spreadV = 1.1 * sqrt(var) * uReflPxPerRad;            // 1 sigma, target pixels
    float spreadH = spreadV * clamp(V.y * 4.0, 0.12, 1.0);
    float lod = log2(max(1.0, max(spreadH, spreadV * 0.4)));
    vec2 uvc = clamp(ruv, vec2(0.001), vec2(0.999));
    vec2 dy = vec2(0.0, spreadV * uReflTexel.y);
    refl = textureLod(tRefl, uvc, lod).rgb * 0.36
         + (textureLod(tRefl, clamp(uvc + dy, vec2(0.001), vec2(0.999)), lod).rgb
          + textureLod(tRefl, clamp(uvc - dy, vec2(0.001), vec2(0.999)), lod).rgb) * 0.24
         + (textureLod(tRefl, clamp(uvc + 2.0 * dy, vec2(0.001), vec2(0.999)), lod).rgb
          + textureLod(tRefl, clamp(uvc - 2.0 * dy, vec2(0.001), vec2(0.999)), lod).rgb) * 0.08;
  #else
    refl = skyFallback(R);
  #endif
  refl = min(refl, vec3(uReflClamp)); // the sun disc comes from the glint term

  // ---- sun glint (Beckmann lobe; roughness = unresolved slope variance) -----
  vec3 L = uSunDir;
  vec3 H = normalize(L + V);
  float NdH = clamp(dot(N, H), 1e-4, 1.0);
  float NdL = dot(N, L);
  float VdH = clamp(dot(V, H), 0.0, 1.0);
  float a2 = 2.0 * (var + 0.0003); // + sun disc and sub-texel roughness
  float c2 = NdH * NdH;
  float D = exp((c2 - 1.0) / (c2 * a2)) / (PI * a2 * c2 * c2);
  float FH = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
  float G = smithG1(NdV, a2) * smithG1(clamp(NdL, 0.0, 1.0), a2);
  vec3 glint = NdL > 0.0 ? uSunRad * (FH * D * G / (4.0 * max(NdV, 0.05))) : vec3(0.0);

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
    // visible under-water point (1 = 5 m), 3 transmittance, 4 normal, 5 glint.
    #if WATER_DEBUG == 1
      gl_FragColor.rgb = toDisplay(refl);
    #elif WATER_DEBUG == 2
      gl_FragColor.rgb = vec3(dv / 5.0, shore, 0.0);
    #elif WATER_DEBUG == 3
      gl_FragColor.rgb = T;
    #elif WATER_DEBUG == 4
      gl_FragColor.rgb = N * 0.5 + 0.5;
    #else
      gl_FragColor.rgb = toDisplay(glint);
    #endif
    if (any(isnan(gl_FragColor.rgb))) gl_FragColor.rgb = vec3(1.0, 0.0, 1.0);
  #endif
#endif
}
`;
