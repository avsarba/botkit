// Terrain meshes (static LOD rings around the dock) and the splatting material.
// The player never leaves the dock, so the LOD is fixed: a dense grid around the dock, a
// medium ring out past the far shore, and a coarse ring for the distant ridges. Edge vertices
// of each finer grid are snapped onto the coarser grid's edges (no T-junction cracks).
import * as THREE from 'three';
import { LAYERS } from '../config.js';

const LOD = {
  // step: vertex spacing (m). Bounds are multiples of the next ring's step.
  high: { s0: 1, s1: 4, s2: 32 },
  medium: { s0: 2, s1: 8, s2: 32 },
  low: { s0: 2, s1: 8, s2: 64 },
};
const B0 = { x0: -152, z0: -184, x1: 152, z1: 120 };
const B1 = { x0: -448, z0: -704, x1: 448, z1: 192 };
const B2 = { x0: -2048, z0: -2240, x1: 2048, z1: 1856 };

function buildGrid(field, b, step, hole, stitchStep) {
  const nx = Math.round((b.x1 - b.x0) / step) + 1;
  const nz = Math.round((b.z1 - b.z0) / step) + 1;
  const W = nx + 2;
  const hts = new Float32Array(W * (nz + 2));
  const dist = new Float32Array(W * (nz + 2));
  for (let j = -1; j <= nz; j++) {
    const z = b.z0 + j * step;
    for (let i = -1; i <= nx; i++) {
      const o = (j + 1) * W + (i + 1);
      hts[o] = field.height(b.x0 + i * step, z);
      dist[o] = field.lastDistance;
    }
  }
  const H = (i, j) => hts[(j + 1) * W + (i + 1)];
  const count = nx * nz;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const cover = new Uint8Array(count * 4);
  const r = stitchStep ? Math.round(stitchStep / step) : 1;
  const lc = {};
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = b.x0 + i * step;
      const z = b.z0 + j * step;
      let h = H(i, j);
      if (r > 1) {
        // snap outer-edge vertices onto the coarse neighbour's straight edge
        if ((j === 0 || j === nz - 1) && i % r !== 0) {
          const i0 = i - (i % r);
          const t = (i - i0) / r;
          h = H(i0, j) * (1 - t) + H(Math.min(i0 + r, nx - 1), j) * t;
        } else if ((i === 0 || i === nx - 1) && j % r !== 0) {
          const j0 = j - (j % r);
          const t = (j - j0) / r;
          h = H(i, j0) * (1 - t) + H(i, Math.min(j0 + r, nz - 1)) * t;
        }
      }
      position[k * 3] = x;
      position[k * 3 + 1] = h;
      position[k * 3 + 2] = z;
      const gx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
      const gz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
      const il = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      normal[k * 3] = -gx * il;
      normal[k * 3 + 1] = il;
      normal[k * 3 + 2] = -gz * il;
      field.landCover(x, z, h, il, lc, dist[(j + 1) * W + (i + 1)]);
      cover[k * 4] = Math.round(lc.forest * 255);
      cover[k * 4 + 1] = Math.round(lc.rock * 255);
      cover[k * 4 + 2] = Math.round(lc.muck * 255);
      cover[k * 4 + 3] = Math.round(lc.beach * 255);
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    const cz = b.z0 + (j + 0.5) * step;
    for (let i = 0; i < nx - 1; i++) {
      if (hole) {
        const cx = b.x0 + (i + 0.5) * step;
        if (cx > hole.x0 && cx < hole.x1 && cz > hole.z0 && cz < hole.z1) continue;
      }
      const a = j * nx + i;
      const bb = a + 1;
      const c = a + nx;
      const d = c + 1;
      // alternate the diagonal for a less directional look
      if ((i + j) & 1) {
        idx.push(a, c, bb, bb, c, d);
      } else {
        idx.push(a, c, d, a, d, bb);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('aCover', new THREE.BufferAttribute(cover, 4, true));
  g.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// --------------------------------------------------------------------------------------
const FRAG_COMMON = /* glsl */ `
uniform sampler2D tDetail;
uniform float uTime;
uniform float uCaustic;
uniform vec2 uCanopy;
uniform vec3 uFogSunDir;
uniform vec3 uSunDirW;
uniform vec3 uFogSun;
uniform vec3 uFogMid;
uniform vec3 uFogSide;
uniform vec3 uFogAway;
varying vec3 vWPos;
varying vec3 vWNormal;
varying vec4 vCover;

// "Tileable water caustic" (after joltz0r / D. Hoskins), 4 iterations.
float causticPattern( vec2 uv, float time ) {
  vec2 p = mod( uv * 6.2831853, 6.2831853 ) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for ( int n = 0; n < 4; n++ ) {
    float t = time * ( 1.0 - ( 3.5 / float( n + 1 ) ) );
    i = p + vec2( cos( t - i.x ) + sin( t + i.y ), sin( t - i.y ) + cos( t + i.x ) );
    c += 1.0 / length( vec2( p.x / ( sin( i.x + t ) / inten ), p.y / ( cos( i.y + t ) / inten ) ) );
  }
  c /= 4.0;
  c = 1.17 - pow( c, 1.4 );
  return pow( abs( c ), 8.0 );
}

vec3 bumpNormal( vec3 pos, vec3 n, float hgt ) {
  vec3 dpdx = dFdx( pos );
  vec3 dpdy = dFdy( pos );
  float dhdx = dFdx( hgt );
  float dhdy = dFdy( hgt );
  vec3 r1 = cross( dpdy, n );
  vec3 r2 = cross( n, dpdx );
  float det = dot( dpdx, r1 );
  vec3 grad = sign( det ) * ( dhdx * r1 + dhdy * r2 );
  vec3 res = abs( det ) * n - grad;
  float l = length( res );
  return l > 1e-8 ? res / l : n;
}
`;

// Albedo, roughness, bump height and caustic amount from world position + cover weights.
const SPLAT = /* glsl */ `
  vec3 wN = normalize( vWNormal );
  float h = vWPos.y;
  vec2 wp = vWPos.xz;
  float camDist = length( vWPos - cameraPosition );
  vec4 dA = texture2D( tDetail, wp * 0.41 );
  vec2 rp = vec2( wp.x * 0.788 - wp.y * 0.616, wp.x * 0.616 + wp.y * 0.788 );
  vec4 dB = texture2D( tDetail, rp * 0.083 + vec2( 0.37, 0.61 ) );
  vec4 dM = texture2D( tDetail, wp * 0.0047 + vec2( 0.5, 0.21 ) );
  vec4 dC = texture2D( tDetail, rp * 0.019 + vec2( 0.13, 0.87 ) );
  float macro = clamp( ( dM.r - 0.5 ) * 2.2 + 0.5, 0.0, 1.0 );
  float n1 = dA.r;
  float n2 = dB.r;
  float nMid = dC.r;
  float forest = vCover.x;
  float farT = smoothstep( 180.0, 700.0, camDist );
  float rockW = max( vCover.y, smoothstep( 0.8 - 0.2 * farT, 0.64 - 0.16 * farT, wN.y ) );
  float muck = vCover.z;
  float beach = vCover.w;

  // ---- land materials (linear albedo) ----
  // late-summer meadow: olive green with straw, clover-dark patches
  vec3 grassG = mix( vec3( 0.062, 0.092, 0.022 ), vec3( 0.105, 0.13, 0.036 ), n2 );
  grassG = mix( grassG, vec3( 0.045, 0.07, 0.02 ), smoothstep( 0.55, 0.75, nMid ) * 0.6 ); // lush, darker hollows
  vec3 straw = vec3( 0.2, 0.17, 0.085 );
  vec3 grass = mix( grassG, straw, smoothstep( 0.5, 0.9, macro * 0.7 + nMid * 0.55 ) * 0.6 );
  grass *= 0.62 + 0.7 * dA.b;
  // forest floor: needles, dark humus, moss
  vec3 needles = mix( vec3( 0.075, 0.045, 0.022 ), vec3( 0.11, 0.07, 0.036 ), dA.b );
  vec3 moss = vec3( 0.035, 0.05, 0.017 );
  vec3 floorC = mix( needles, moss, smoothstep( 0.5, 0.75, n2 * 0.6 + nMid * 0.6 ) * 0.7 );
  floorC *= 0.75 + 0.35 * n1;
  // distant conifer canopy (what the forest reads as from a few hundred meters)
  vec3 canopy = mix( vec3( 0.014, 0.024, 0.012 ), vec3( 0.03, 0.043, 0.02 ), smoothstep( 0.3, 0.7, nMid ) );
  canopy = mix( canopy, vec3( 0.045, 0.055, 0.024 ), smoothstep( 0.62, 0.85, macro ) * 0.6 ); // birch / aspen stands
  canopy *= 0.65 + 0.7 * dC.g;
  // granite: pink-grey feldspar, dark lichen crusts, pale weathered faces
  vec3 granite = mix( vec3( 0.1, 0.09, 0.085 ), vec3( 0.21, 0.185, 0.17 ), dA.a );
  granite = mix( granite, vec3( 0.24, 0.235, 0.22 ), smoothstep( 0.6, 0.85, n2 ) * 0.35 );  // pale weathered faces
  granite = mix( granite, vec3( 0.04, 0.042, 0.036 ), smoothstep( 0.5, 0.7, nMid ) * 0.6 );  // black lichen crusts
  granite = mix( granite, vec3( 0.12, 0.13, 0.09 ), smoothstep( 0.55, 0.8, dC.b ) * 0.35 );  // grey-green lichen
  granite = mix( granite, vec3( 0.26, 0.15, 0.05 ), smoothstep( 0.86, 0.93, dB.a ) * 0.3 );  // orange lichen
  granite = mix( granite, canopy * 1.4, farT * 0.35 );
  // sand / mud margin with pebbles
  vec3 sandC = mix( vec3( 0.2, 0.17, 0.12 ), vec3( 0.29, 0.25, 0.18 ), n2 );
  sandC = mix( sandC, vec3( 0.1, 0.085, 0.06 ), ( 1.0 - beach ) * 0.6 );
  // stones: a coarser sample of the pebble channel, gated into gravel patches; each stone is
  // shaded by its own dome height (lighter crown, darker toe), not per-pixel noise
  float pebH = texture2D( tDetail, wp * 0.21 + vec2( 0.27, 0.43 ) ).g;
  float peb = pebH * smoothstep( 0.45, 0.7, dC.r * 0.8 + dB.r * 0.4 );
  vec3 pebC = mix( vec3( 0.13, 0.12, 0.1 ), vec3( 0.3, 0.27, 0.23 ), smoothstep( 0.15, 0.9, pebH ) );
  sandC = mix( sandC, pebC, smoothstep( 0.15, 0.4, peb ) * 0.8 );

  float canopyW = smoothstep( uCanopy.x, uCanopy.y, camDist );
  vec3 land = mix( grass, mix( floorC, canopy, canopyW ), forest );
  land = mix( land, granite, rockW );
  // sandy band above the waterline, width varies with beach-ness
  float sandTop = mix( 0.12, 0.5, beach ) + ( nMid - 0.5 ) * 0.25;
  float sandW = 1.0 - smoothstep( sandTop - 0.12, sandTop + 0.12, h );
  land = mix( land, sandC, sandW * ( 1.0 - rockW * 0.7 ) );

  // ---- lake bed ----
  float depth = max( 0.0, -h );
  vec3 bedSand = mix( vec3( 0.14, 0.125, 0.085 ), vec3( 0.21, 0.185, 0.13 ), n2 * 0.7 + nMid * 0.3 );
  bedSand *= 0.92 + 0.16 * dA.r;
  bedSand = mix( bedSand, pebC * 0.8, smoothstep( 0.25, 0.5, peb ) * ( 1.0 - smoothstep( 0.8, 3.0, depth ) ) );
  // scattered organic debris / algae film in the shallows
  bedSand = mix( bedSand, vec3( 0.07, 0.075, 0.04 ), smoothstep( 0.6, 0.85, dC.r ) * 0.5 );
  vec3 silt = mix( vec3( 0.06, 0.055, 0.032 ), vec3( 0.095, 0.085, 0.05 ), n1 );
  vec3 muckC = mix( vec3( 0.03, 0.03, 0.017 ), vec3( 0.035, 0.05, 0.018 ), smoothstep( 0.4, 0.7, n2 ) );
  float siltW = smoothstep( 1.5, 3.8, depth + ( nMid - 0.5 ) * 1.6 ); // sandy shelf around the dock, silt deeper
  vec3 bed = mix( bedSand, silt, siltW );
  bed = mix( bed, muckC, muck );
  bed = mix( bed, granite * 0.75, rockW );
  // (the light's path down to the bed and back is absorbed by the Water shader, which knows the
  //  true water thickness; darkening it here as well made the shallows beside the dock read black)

  // wet band at the waterline and just above it
  float wet = 1.0 - smoothstep( 0.02, 0.28 + 0.1 * n1, h );
  vec3 albedo = mix( land, bed, smoothstep( 0.02, -0.06, h ) );
  albedo *= mix( 1.0, 0.58, wet * ( 1.0 - smoothstep( 0.0, -0.3, h ) ) );
  // a thin darker line of wrack / algae right at the waterline
  float wrack = ( h - 0.03 ) / 0.03;
  albedo *= 1.0 - 0.22 * exp( -wrack * wrack ) * smoothstep( 0.45, 0.75, n2 * 0.7 + dA.r * 0.5 ) * ( 1.0 - rockW );

  diffuseColor.rgb = albedo;

  // rough natural ground barely shows grazing-angle specular (micro-shadowing)
  float tSpec = mix( mix( 0.3, 0.6, rockW ), 0.55, wet ) * ( 1.0 - 0.7 * forest * canopyW );
  float tCanopy = forest * canopyW;
  float tRough = mix( 0.93, 0.8, rockW );
  tRough = mix( tRough, 0.7, wet * ( 1.0 - smoothstep( 0.0, -0.2, h ) ) );
  tRough = mix( tRough, 0.97, forest * canopyW );

  // bump height (meters): pebbles, granite grain, fibres; fades with distance (no aliasing)
  // fade fine bump once a pixel spans more than ~1 cm (no specular sparkle)
  float footprint = length( fwidth( wp ) );
  float fineFade = 1.0 - smoothstep( 0.005, 0.016, footprint );
  float midFade = 1.0 - smoothstep( 0.03, 0.12, footprint );
  float aboveWater = 1.0 - smoothstep( 0.05, -0.05, h );
  float ripples = 0.0;
  if ( h < 0.05 ) {
    vec2 rd = vec2( 0.8, 0.6 );
    float ph = dot( wp, rd ) * 52.0 + ( nMid - 0.5 ) * 9.0 + n2 * 4.0;
    ripples = ( 0.5 + 0.5 * sin( ph ) ) * ( 1.0 - smoothstep( 0.4, 2.2, depth ) ) * ( 1.0 - rockW ) * ( 1.0 - muck );
  }
  float tBump = ( peb * 0.011 * ( sandW * ( 1.0 - 0.7 * wet ) + ( 1.0 - aboveWater ) * 0.7 ) + ripples * 0.005
    + dA.a * 0.006 * rockW + dA.b * 0.005 * ( 1.0 - rockW ) * ( 1.0 - sandW ) ) * fineFade
    + ( n2 * 0.03 + dC.r * 0.06 ) * midFade;

  // caustics on the shallow bed
  float tCaustic = 0.0;
  if ( h < 0.0 && uCaustic > 0.001 ) {
    float cf = smoothstep( 0.0, 0.25, depth ) * ( 1.0 - smoothstep( 1.2, 4.0, depth ) );
    if ( cf > 0.0 ) {
      vec2 warp = ( dC.gb - 0.5 ) * 0.9 + ( dB.rb - 0.5 ) * 0.25;
      float ca = causticPattern( wp * 1.21 + warp, uTime * 0.6 ) * 0.7 + causticPattern( rp * 0.77 + 0.5 - warp * 0.7, uTime * 0.45 + 3.0 ) * 0.3;
      ca *= 1.0 - smoothstep( 0.02, 0.06, footprint );
      tCaustic = ca * cf * uCaustic;
    }
  }
`;

const NORMAL_INJECT = /* glsl */ `
normal = bumpNormal( - vViewPosition, normal, tBump );
// a conifer canopy is lit on the tree sides: under a low sun it glows, far brighter than flat ground
if ( tCanopy > 0.01 ) {
  vec3 sh = vec3( uSunDirW.x, 0.0, uSunDirW.z );
  float shl = length( sh );
  if ( shl > 1e-4 ) {
    vec3 sv = normalize( ( viewMatrix * vec4( sh / shl, 0.0 ) ).xyz );
    normal = normalize( normal + sv * tCanopy * 0.85 );
  }
}
`;
const LIGHT_INJECT = /* glsl */ `
reflectedLight.directDiffuse *= 1.0 + tCaustic * 2.2;
reflectedLight.directSpecular *= tSpec;
reflectedLight.indirectSpecular *= tSpec;
`;

const FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 fdir = vWPos - cameraPosition;
  vec2 fxz = fdir.xz;
  float fl = length( fxz );
  float cs = fl > 1e-4 ? dot( fxz / fl, uFogSunDir.xz ) : 0.0;
  vec3 fogC = cs > 0.0 ? mix( uFogSide, uFogMid, smoothstep( 0.0, 0.7071, cs ) ) : mix( uFogSide, uFogAway, -cs );
  fogC = cs > 0.7071 ? mix( uFogMid, uFogSun, smoothstep( 0.7071, 1.0, cs ) ) : fogC;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogC, fogFactor );
#endif
`;

export function createTerrain({ field, quality, detailTexture }) {
  const lod = LOD[quality] || LOD.high;
  const uniforms = {
    tDetail: { value: detailTexture },
    uTime: { value: 0 },
    uCaustic: { value: 0 },
    uCanopy: { value: new THREE.Vector2(140, 420) },
    uFogSunDir: { value: new THREE.Vector3(0, 0, -1) },
    uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
    uFogSun: { value: new THREE.Color(1, 1, 1) },
    uFogMid: { value: new THREE.Color(1, 1, 1) },
    uFogSide: { value: new THREE.Color(1, 1, 1) },
    uFogAway: { value: new THREE.Color(1, 1, 1) },
  };
  const material = new THREE.MeshStandardMaterial({ name: 'env-terrain', roughness: 0.92, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec4 aCover;\nvarying vec4 vCover;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;'
      )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvWNormal = normalize( mat3( modelMatrix ) * objectNormal );\nvCover = aCover;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_COMMON)
      .replace('#include <map_fragment>', SPLAT)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n' + NORMAL_INJECT
      )
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LIGHT_INJECT)
      .replace('#include <fog_fragment>', FOG);
  };
  material.customProgramCacheKey = () => 'env-terrain-1';

  const t0 = performance.now();
  const g0 = buildGrid(field, B0, lod.s0, null, lod.s1);
  const g1 = buildGrid(field, B1, lod.s1, B0, lod.s2);
  const g2 = buildGrid(field, B2, lod.s2, B1, 0);
  const buildMs = performance.now() - t0;

  const meshes = [g0, g1, g2].map((g, i) => {
    const m = new THREE.Mesh(g, material);
    m.name = `env-terrain-${i}`;
    m.receiveShadow = i === 0; // the shadow box (+-25 m around the dock) lies inside the dense grid
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.layers.enable(LAYERS.UNDERWATER);
    return m;
  });
  const triangles = meshes.reduce((s, m) => s + m.geometry.index.count / 3, 0);
  return {
    meshes,
    material,
    uniforms,
    buildMs,
    triangles,
    dispose() {
      for (const m of meshes) m.geometry.dispose();
      material.dispose();
    },
  };
}
