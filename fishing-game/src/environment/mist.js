// Low steam-fog sheets over the water at dawn (cold air over warm water), gone by ~8:30.
// A few stacked horizontal layers; their optical path grows at grazing angles so they
// pile up into a soft band toward the far shore while staying thin underfoot.
import * as THREE from 'three';
import { DITHER_GLSL } from './dither.js';

const VERT = /* glsl */ `
varying vec3 vWPos;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FRAG = /* glsl */ `
uniform sampler2D tNoise;
uniform sampler2D tDepth;
uniform vec4 uDepthBounds;
uniform vec2 uOffset;
uniform float uAmount;
uniform float uLayer;
uniform vec3 uAmb;
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vWPos;
void main() {
  vec2 duv = ( vWPos.xz - uDepthBounds.xy ) * uDepthBounds.zw;
  float inside = step( 0.0, duv.x ) * step( duv.x, 1.0 ) * step( 0.0, duv.y ) * step( duv.y, 1.0 );
  vec4 dm = texture2D( tDepth, clamp( duv, 0.0, 1.0 ) );
  float water = smoothstep( 0.0, 0.06, dm.g ) * inside;
  if ( water <= 0.001 ) discard;
  vec3 V = vWPos - cameraPosition;
  float dist = length( V );
  vec3 dir = V / dist;
  vec2 p = vWPos.xz;
  // patchy banks (tens of meters) broken into wisps (a few meters), drifting with the air
  float bank = texture2D( tNoise, p * 0.0071 + uOffset * 0.6 + uLayer * 0.37 ).r;
  float n = texture2D( tNoise, p * 0.031 + uOffset + uLayer * 0.61 ).r * 0.6
          + texture2D( tNoise, p * 0.083 - uOffset * 1.7 + uLayer * 0.23 ).b * 0.4;
  float wisps = smoothstep( 0.4, 0.75, n ) * smoothstep( 0.3, 0.62, bank );
  float path = min( 1.0 / max( abs( dir.y ), 0.02 ), 40.0 );
  float a = uAmount * wisps * water * ( 1.0 - exp( -0.09 * path ) );
  a *= smoothstep( 3.0, 22.0, dist ) * ( 1.0 - smoothstep( 520.0, 700.0, dist ) );
  if ( a <= 0.002 ) discard;
  float mu = max( dot( dir, uSunDir ), 0.0 );
  vec3 col = uAmb + uSun * ( 0.25 + 1.6 * pow( mu, 6.0 ) );
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${DITHER_GLSL}
}
`;

export function createMist({ quality, cloudNoise, depthMap }) {
  const layers = quality === 'high' ? 3 : quality === 'medium' ? 2 : 1;
  const group = new THREE.Group();
  group.name = 'env-mist';
  const b = depthMap.bounds;
  const shared = {
    tNoise: { value: cloudNoise },
    tDepth: { value: depthMap.texture },
    uDepthBounds: { value: new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ)) },
    uOffset: { value: new THREE.Vector2() },
    uAmount: { value: 0 },
    uAmb: { value: new THREE.Color(0.5, 0.5, 0.5) },
    uSun: { value: new THREE.Color(0.2, 0.15, 0.1) },
    uSunDir: { value: new THREE.Vector3(0, 0.1, 1) },
  };
  const geo = new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ, 1, 1).rotateX(-Math.PI / 2);
  const heights = [0.35, 0.95, 1.55];
  const materials = [];
  for (let i = 0; i < layers; i++) {
    const mat = new THREE.ShaderMaterial({
      name: 'env-mist',
      uniforms: { ...shared, uLayer: { value: i } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    materials.push(mat);
    const m = new THREE.Mesh(geo, mat);
    m.position.set((b.minX + b.maxX) / 2, heights[i], (b.minZ + b.maxZ) / 2);
    m.renderOrder = 30 + i;
    m.frustumCulled = false;
    group.add(m);
  }
  group.visible = false;
  return {
    group,
    uniforms: shared,
    dispose() {
      geo.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
