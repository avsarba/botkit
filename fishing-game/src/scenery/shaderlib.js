// Shared uniforms and onBeforeCompile patches for scenery materials. All patches keep three's
// lighting, shadows and fog intact (they only add code around the standard chunks).
import * as THREE from 'three';
import { GLSL_NOISE } from './noise.js';

export function createSharedUniforms() {
  return {
    uTime: { value: 0 },
    uWind: { value: 0.25 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) }, // sun color * intensity (linear)
  };
}

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const NORMAL_BEGIN_NOFLIP = THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');

// opts:
//   sway: { amp, freq, wave, invH, flutter }  world-space wind bend (instanced meshes)
//   noFlip: true           keep crown normals on back faces of double-sided cards
//   alphaMip: 0.25         keep alpha-tested coverage in lower mips
//   transl: 0.5            sun translucency through leaves / blades
//   impostor: true         per-instance atlas cell (aCell) + captured normals (uImpNormal)
//   cellUV: true           per-instance atlas cell (aCell) only
//   worldPos: true         vSWorld varying (world position) for procedural shading
//   fragColor: glsl        code run after color_fragment (diffuseColor, vSWorld available)
//   fragRough: glsl        code run after roughnessmap_fragment
//   bump: glsl expr        height function of vSWorld -> perturbs the normal
//   fragHeader: glsl       extra functions/uniforms for the fragment shader
//   wrap: 0.2              normal-independent share of sunlight (foliage multiple scattering)
//   haze: true             custom aerial perspective: mix toward uHazeColor by uHaze
//   extraUniforms: {}      additional uniforms (shared by reference)
export function patchMaterial(material, shared, opts = {}) {
  const key = JSON.stringify(opts, (k, v) => (k === 'extraUniforms' ? Object.keys(v) : v));
  material.customProgramCacheKey = () => key;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    if (opts.extraUniforms) Object.assign(shader.uniforms, opts.extraUniforms);
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;
    let vHead = 'uniform float uTime;\nuniform float uWind;\nuniform vec2 uWindDir;\n';
    let fHead = 'uniform vec3 uSunDir;\nuniform vec3 uSunColor;\nuniform float uTime;\n';
    if (opts.worldPos || opts.fragColor || opts.bump) {
      vHead += 'varying vec3 vSWorld;\n';
      fHead += 'varying vec3 vSWorld;\n';
    }
    if (opts.fragColor || opts.bump || opts.fragHeader) fHead += GLSL_NOISE;
    if (opts.fragHeader) fHead += opts.fragHeader + '\n';
    if (opts.cellUV && !opts.impostor) vHead += 'attribute vec4 aCell;\n';
    if (opts.impostor) {
      vHead += 'attribute vec4 aCell;\nvarying vec3 vImpR;\nvarying vec3 vImpU;\nvarying vec3 vImpF;\n';
      fHead += 'uniform sampler2D uImpNormal;\nvarying vec3 vImpR;\nvarying vec3 vImpU;\nvarying vec3 vImpF;\n';
    }
    if (opts.sway && opts.sway.flutter) vHead += 'attribute float aSway;\n';
    if (opts.haze) fHead += 'uniform float uHaze;\nuniform vec3 uHazeColor;\n';

    vs = vs.replace('#include <common>', '#include <common>\n' + vHead);
    fs = fs.replace('#include <common>', '#include <common>\n' + fHead);

    // ---- vertex: position (+ sway)
    let proj = 'vec4 mvPosition = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\nmvPosition = instanceMatrix * mvPosition;\nvec3 swB = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;\n#else\nvec3 swB = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;\n#endif\n';
    if (opts.sway) {
      const s = opts.sway;
      proj += `{
  float hN = clamp(position.y * ${f(s.invH)}, 0.0, 1.5);
  float ph = dot(swB.xz, vec2(0.173, 0.211));
  float travel = dot(swB.xz, uWindDir) * ${f(s.wave || 0.05)};
  float gust = 0.5 + 0.5 * sin(uTime * 0.31 - travel * 0.37 + ph * 0.2) * sin(uTime * 0.17 + ph * 0.1 + 1.3);
  float osc = sin(uTime * ${f(s.freq)} - travel + ph) + 0.35 * sin(uTime * ${f(s.freq * 2.37)} + ph * 1.7);
  float bend = uWind * (0.35 + 0.65 * gust) * (0.62 + 0.38 * osc);
  vec3 disp = vec3(uWindDir.x, 0.0, uWindDir.y) * (bend * ${f(s.amp)} * hN * hN);
  ${
    s.flutter
      ? `float fl = aSway * uWind * (0.4 + gust) * ${f(s.flutter)};
  disp += fl * vec3(sin(uTime * 6.1 + position.x * 3.3 + ph * 7.0), 0.5 * sin(uTime * 7.3 + position.y * 2.9 + ph * 5.0), cos(uTime * 5.3 + position.z * 3.1 + ph * 3.0));`
      : ''
  }
  mvPosition.xyz += disp;
}\n`;
    }
    if (opts.worldPos || opts.fragColor || opts.bump) proj += 'vSWorld = (modelMatrix * mvPosition).xyz;\n';
    proj += 'mvPosition = modelViewMatrix * mvPosition;\ngl_Position = projectionMatrix * mvPosition;\n';
    if (opts.impostor) {
      proj += `{
  #ifdef USE_INSTANCING
  mat3 im = mat3(modelViewMatrix) * mat3(instanceMatrix);
  #else
  mat3 im = mat3(modelViewMatrix);
  #endif
  vImpR = normalize(im * vec3(1.0, 0.0, 0.0));
  vImpU = normalize(im * vec3(0.0, 1.0, 0.0));
  vImpF = normalize(im * vec3(0.0, 0.0, 1.0));
}\n`;
      vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = aCell.xy + uv * aCell.zw;');
    }
    if (opts.cellUV && !opts.impostor) vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = aCell.xy + uv * aCell.zw;');
    vs = vs.replace('#include <project_vertex>', proj);

    // ---- fragment
    if (opts.impostor) {
      fs = fs.replace(
        '#include <map_fragment>',
        'vec4 impTex = texture2D(map, vMapUv);\ndiffuseColor.rgb *= impTex.rgb * impTex.rgb;\ndiffuseColor.a *= impTex.a;'
      );
    }
    if (opts.alphaMip) {
      fs = fs.replace(
        '#include <alphatest_fragment>',
        `#ifdef USE_MAP
{
  vec2 tsz = vec2(textureSize(map, 0));
  vec2 ddx = dFdx(vMapUv * tsz);
  vec2 ddy = dFdy(vMapUv * tsz);
  float lod = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
  diffuseColor.a *= 1.0 + lod * ${f(opts.alphaMip)};
}
#endif
#include <alphatest_fragment>`
      );
    }
    if (opts.fragColor) fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + opts.fragColor);
    if (opts.fragRough) fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + opts.fragRough);
    if (opts.noFlip || opts.impostor) fs = fs.replace('#include <normal_fragment_begin>', NORMAL_BEGIN_NOFLIP);
    let nrm = '';
    if (opts.impostor) {
      nrm += `{
  vec3 nT = texture2D(uImpNormal, vMapUv).xyz * 2.0 - 1.0;
  normal = normalize(nT.x * vImpR + nT.y * vImpU + nT.z * vImpF);
}\n`;
    }
    if (opts.bump) {
      nrm += `{
  vec3 dpdx = dFdx(-vViewPosition);
  vec3 dpdy = dFdy(-vViewPosition);
  float hh = ${opts.bump};
  float dhx = dFdx(hh);
  float dhy = dFdy(hh);
  vec3 r1 = cross(dpdy, normal);
  vec3 r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  normal = normalize(abs(det) * normal - grad);
}\n`;
    }
    if (nrm) fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + nrm);
    if (opts.transl) {
      fs = fs.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float bl = pow(max(dot(normalize(-vViewPosition), sunV), 0.0), 3.0);
  float sunUp = smoothstep(-0.02, 0.08, uSunDir.y);
  reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * (bl * sunUp * ${f(opts.transl)} * RECIPROCAL_PI);
}`
      );
    }
    if (opts.wrap) {
      // foliage: light scattered through the canopy softens the Lambert falloff
      fs = fs.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  float sunUpW = smoothstep(-0.02, 0.1, uSunDir.y);
  reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * (${f(opts.wrap)} * sunUpW * RECIPROCAL_PI);
}`
      );
    }
    if (opts.haze) {
      fs = fs.replace('#include <fog_fragment>', '#include <fog_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, uHaze);');
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  material.needsUpdate = true;
  return material;
}
