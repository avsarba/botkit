// Verlet fishing line rendered with Line2 (screen-space width). String-like: segments only resist
// stretching, pinned points are driven from outside (rod tip, float clips, lure tie, fish mouth).
// Points on the main line float on the water surface; "sink" points (the leader under a float) may
// hang below it. Long-range attachment constraints keep long ropes from over-stretching.
// Rendering: each point carries a tint + base opacity (hi-vis main line vs a clear leader); the
// optional `subdiv` renders a centripetal Catmull-Rom resample of the points so the line bends in
// smooth arcs instead of straight chords. enhanceLineMaterial() lights the line per segment in
// scene-referred units (sun by the angle to the line, sky fill), adds the thin specular glint that
// real mono shows, and fades the line with distance the way a 0.3 mm line vanishes.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { DOCK, G } from '../config.js';

const NO_SURF = -1e4;

const LN_VERT_DECL = /* glsl */ `
attribute vec2 instanceLnStart; // (opacity, dry)
attribute vec2 instanceLnEnd;
uniform vec3 uLnSunDir; // view space, toward the key light
uniform vec3 uLnSun; // key light colour * intensity * k
uniform vec3 uLnAmb; // sky fill
uniform vec2 uLnFade; // (full-opacity depth, min opacity)
varying vec3 vLnLight;
varying float vLnAlpha;
varying float vLnGlint;
`;
const LN_VERT_MAIN = /* glsl */ `
	{
		vec2 lnA = ( position.y < 0.5 ) ? instanceLnStart : instanceLnEnd;
		vec3 lnS = ( modelViewMatrix * vec4( instanceStart, 1.0 ) ).xyz;
		vec3 lnE = ( modelViewMatrix * vec4( instanceEnd, 1.0 ) ).xyz;
		vec3 lnP = ( position.y < 0.5 ) ? lnS : lnE;
		float lnFade = clamp( uLnFade.x / max( - lnP.z, uLnFade.x ), uLnFade.y, 1.0 );
		vec3 lnT = lnE - lnS;
		float lnTl = length( lnT );
		lnT = lnTl > 1e-6 ? lnT / lnTl : vec3( 0.0, 1.0, 0.0 );
		float lnPl = length( lnP );
		vec3 lnV = lnPl > 1e-6 ? - lnP / lnPl : vec3( 0.0, 0.0, 1.0 );
		// thin cylinder: diffuse ~ sin(angle between the line and the light)
		float lnTL = dot( lnT, uLnSunDir );
		float lnSin = sqrt( max( 0.0, 1.0 - lnTL * lnTL ) );
		vLnLight = uLnAmb + uLnSun * lnSin;
		// specular cone of a cylinder (reflects toward the eye when V.T = -L.T) + backlit forward scatter
		float lnK = dot( lnV, lnT ) + lnTL;
		vec3 lnH = lnV + uLnSunDir;
		vec3 lnHp = lnH - dot( lnH, lnT ) * lnT;
		float lnSpec = exp( - lnK * lnK * 240.0 ) * smoothstep( 0.1, 0.5, length( lnHp ) );
		float lnFwd = pow( max( 0.0, - dot( lnV, uLnSunDir ) ), 16.0 ) * lnSin;
		vLnGlint = ( lnSpec + 0.5 * lnFwd ) * lnA.y;
		vLnAlpha = lnA.x * lnFade;
	}
`;
const LN_FRAG_DECL = /* glsl */ `
uniform vec3 uLnGlint;
uniform float uLnGlintA;
varying vec3 vLnLight;
varying float vLnAlpha;
varying float vLnGlint;
`;
const LN_FRAG_OUT = 'gl_FragColor = vec4( diffuseColor.rgb, alpha );';
const LN_FRAG_NEW =
  'gl_FragColor = vec4( diffuseColor.rgb * vLnLight + uLnGlint * vLnGlint, alpha * clamp( vLnAlpha + vLnGlint * uLnGlintA, 0.0, 1.0 ) );';

// Patch a LineMaterial (vertexColors: true) used by createRope() lines. Returns the uniforms to drive
// each frame; `patched` stays false if the shader source did not match (then the caller lights the
// line through material.color instead, and the per-point opacity is ignored).
export function enhanceLineMaterial(material) {
  const u = {
    uLnSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uLnSun: { value: new THREE.Color(0, 0, 0) },
    uLnAmb: { value: new THREE.Color(1, 1, 1) },
    uLnFade: { value: new THREE.Vector2(4.5, 0.22) },
    uLnGlint: { value: new THREE.Color(0, 0, 0) },
    uLnGlintA: { value: 0 },
  };
  const state = { uniforms: u, patched: false };
  Object.assign(material.uniforms, u);
  material.onBeforeCompile = (shader) => {
    const vOk = shader.vertexShader.includes('void main() {') && shader.vertexShader.includes('attribute vec3 instanceStart;');
    const fOk = shader.fragmentShader.includes('void main() {') && shader.fragmentShader.includes(LN_FRAG_OUT);
    if (!vOk || !fOk) {
      state.patched = false;
      return;
    }
    shader.vertexShader = LN_VERT_DECL + shader.vertexShader.replace('void main() {', 'void main() {' + LN_VERT_MAIN);
    shader.fragmentShader = LN_FRAG_DECL + shader.fragmentShader.replace(LN_FRAG_OUT, LN_FRAG_NEW);
    state.patched = true;
  };
  material.customProgramCacheKey = () => 'fishing-line-v2';
  material.needsUpdate = true;
  return state;
}

export function createRope(n, material, { renderOrder = 12, subdiv = 1 } = {}) {
  const pos = new Float32Array(n * 3);
  const prev = new Float32Array(n * 3);
  const rest = new Float32Array(Math.max(1, n - 1));
  const cum = new Float32Array(n);
  const pinned = new Uint8Array(n);
  const sinks = new Uint8Array(n);
  const surf = new Float32Array(n).fill(NO_SURF);
  const ground = new Float32Array(n).fill(-50);
  const leftPin = new Int16Array(n).fill(-1);
  const rightPin = new Int16Array(n).fill(-1);
  let groundCursor = 0;
  let pinsDirty = true;

  // per-point look: tint (linear RGB) and base opacity
  const tint = new Float32Array(n * 3).fill(1);
  const baseAlpha = new Float32Array(n).fill(1);
  // render points: `sub` samples per segment (Catmull-Rom), plus the last point
  const sub = Math.max(1, Math.min(6, Math.round(subdiv) || 1));
  const nr = (n - 1) * sub + 1;
  const ptCol = new Float32Array(n * 3);
  const ptLn = new Float32Array(n * 2); // (opacity, dry) per simulated point
  const rp = new Float32Array(nr * 3);
  const rc = new Float32Array(nr * 3);
  const rl = new Float32Array(nr * 2);

  const geom = new LineGeometry();
  geom.setPositions(new Float32Array(nr * 3));
  geom.setColors(new Float32Array(nr * 3).fill(1));
  const lnBuf = new THREE.InstancedInterleavedBuffer(new Float32Array((nr - 1) * 4).fill(1), 4, 1);
  geom.setAttribute('instanceLnStart', new THREE.InterleavedBufferAttribute(lnBuf, 2, 0));
  geom.setAttribute('instanceLnEnd', new THREE.InterleavedBufferAttribute(lnBuf, 2, 2));
  const line = new Line2(geom, material);
  line.frustumCulled = false;
  line.renderOrder = renderOrder;
  line.matrixAutoUpdate = false;
  const posBuf = geom.attributes.instanceStart.data;
  const colBuf = geom.attributes.instanceColorStart.data;

  function refreshPins() {
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) last = i;
      leftPin[i] = pinned[i] ? i : last;
    }
    last = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (pinned[i]) last = i;
      rightPin[i] = pinned[i] ? i : last;
    }
    pinsDirty = false;
  }

  function refreshCum() {
    cum[0] = 0;
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + rest[i - 1];
  }

  const api = {
    n,
    pos,
    prev,
    rest,
    cum,
    pinned,
    sinks,
    surf,
    line,
    tint,
    baseAlpha,
    // Look of points [from..to]: color is a THREE.Color (linear), alpha the base opacity.
    setTint(from, to, color, alpha = 1) {
      const a = Math.max(0, from);
      const b = Math.min(n - 1, to);
      for (let i = a; i <= b; i++) {
        tint[i * 3] = color.r;
        tint[i * 3 + 1] = color.g;
        tint[i * 3 + 2] = color.b;
        baseAlpha[i] = alpha;
      }
    },
    setPinned(i, on) {
      const v = on ? 1 : 0;
      if (pinned[i] !== v) {
        pinned[i] = v;
        pinsDirty = true;
      }
    },
    clearPins() {
      pinned.fill(0);
      pinsDirty = true;
    },
    setPoint(i, x, y, z, keepVelocity = false) {
      const o = i * 3;
      if (keepVelocity) {
        prev[o] += x - pos[o];
        prev[o + 1] += y - pos[o + 1];
        prev[o + 2] += z - pos[o + 2];
      } else {
        prev[o] = x;
        prev[o + 1] = y;
        prev[o + 2] = z;
      }
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
    },
    // Pinned point: moves with its driver (prev follows so verlet sees its velocity).
    pin(i, v) {
      const o = i * 3;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      pos[o] = v.x;
      pos[o + 1] = v.y;
      pos[o + 2] = v.z;
    },
    getPoint(i, target) {
      const o = i * 3;
      return target.set(pos[o], pos[o + 1], pos[o + 2]);
    },
    // Lay every free point on straight lines between its neighbouring pins (no velocity).
    layStraight() {
      if (pinsDirty) refreshPins();
      refreshCum();
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        const a = leftPin[i];
        const b = rightPin[i];
        const o = i * 3;
        if (a < 0 && b < 0) continue;
        if (a < 0 || b < 0) {
          const p = (a < 0 ? b : a) * 3;
          const d = cum[i] - cum[a < 0 ? b : a];
          pos[o] = pos[p];
          pos[o + 1] = pos[p + 1] - Math.abs(d);
          pos[o + 2] = pos[p + 2];
        } else {
          const span = cum[b] - cum[a];
          const f = span > 1e-9 ? (cum[i] - cum[a]) / span : 0;
          pos[o] = pos[a * 3] + (pos[b * 3] - pos[a * 3]) * f;
          pos[o + 1] = pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * f;
          pos[o + 2] = pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * f;
        }
        prev[o] = pos[o];
        prev[o + 1] = pos[o + 1];
        prev[o + 2] = pos[o + 2];
      }
    },
    // Shift all free points by d weighted by arc-length fraction toward the far end (latency fix).
    shiftTowardEnd(dx, dy, dz) {
      refreshCum();
      const total = cum[n - 1] || 1;
      for (let i = 1; i < n; i++) {
        const w = cum[i] / total;
        const o = i * 3;
        pos[o] += dx * w;
        pos[o + 1] += dy * w;
        pos[o + 2] += dz * w;
        prev[o] += dx * w;
        prev[o + 1] += dy * w;
        prev[o + 2] += dz * w;
      }
    },
    // opts: { wind: Vector3 (m/s), water, env, iterations, airDrag, waterSurfaceOffset }
    step(dt, opts) {
      if (!(dt > 0)) return;
      if (pinsDirty) refreshPins();
      refreshCum();
      const { wind, water, env, iterations = 16 } = opts;
      const airK = opts.airDrag ?? 2.2;
      const subs = dt > 1 / 70 ? 2 : 1;
      const h = dt / subs;
      const h2 = h * h;
      // water surface under low points (once per frame), terrain round-robin cache
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        surf[i] = pos[o + 1] < 0.9 ? water.getHeight(pos[o], pos[o + 2]) : NO_SURF;
      }
      const per = Math.max(4, Math.ceil(n / 4));
      for (let k = 0; k < per; k++) {
        const i = groundCursor;
        groundCursor = (groundCursor + 1) % n;
        ground[i] = env.getTerrainHeight(pos[i * 3], pos[i * 3 + 2]);
      }
      const deckTop = DOCK.deckY + 0.004;
      const halfW = DOCK.width / 2 + 0.03;
      for (let s = 0; s < subs; s++) {
        for (let i = 0; i < n; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          const x = pos[o];
          const y = pos[o + 1];
          const z = pos[o + 2];
          const vx = x - prev[o];
          const vy = y - prev[o + 1];
          const vz = z - prev[o + 2];
          prev[o] = x;
          prev[o + 1] = y;
          prev[o + 2] = z;
          const under = y < surf[i];
          if (under) {
            // mono is barely denser than water: slow sink, heavy drag
            pos[o] = x + vx * 0.86;
            pos[o + 1] = y + vy * 0.86 - G * 0.06 * h2;
            pos[o + 2] = z + vz * 0.86;
          } else {
            const k = Math.min(1, airK * h);
            const ax = (wind.x - vx / h) * k;
            const ay = (wind.y - vy / h) * k;
            const az = (wind.z - vz / h) * k;
            pos[o] = x + vx * 0.998 + ax * h;
            pos[o + 1] = y + vy * 0.998 + ay * h - G * h2;
            pos[o + 2] = z + vz * 0.998 + az * h;
          }
        }
        for (let it = 0; it < iterations; it++) {
          const fwd = (it & 1) === 0;
          for (let q = 0; q < n - 1; q++) {
            const a = fwd ? q : n - 2 - q;
            const b = a + 1;
            const wa = pinned[a] ? 0 : 1;
            const wb = pinned[b] ? 0 : 1;
            const w = wa + wb;
            if (!w) continue;
            const oa = a * 3;
            const ob = b * 3;
            const dx = pos[ob] - pos[oa];
            const dy = pos[ob + 1] - pos[oa + 1];
            const dz = pos[ob + 2] - pos[oa + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            const r = rest[a];
            if (d2 <= r * r || d2 < 1e-18) continue; // string: no compression resistance
            const d = Math.sqrt(d2);
            const corr = (d - r) / (d * w);
            pos[oa] += dx * corr * wa;
            pos[oa + 1] += dy * corr * wa;
            pos[oa + 2] += dz * corr * wa;
            pos[ob] -= dx * corr * wb;
            pos[ob + 1] -= dy * corr * wb;
            pos[ob + 2] -= dz * corr * wb;
          }
        }
        // long-range attachments to the neighbouring pins
        for (let i = 0; i < n; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          for (let side = 0; side < 2; side++) {
            const p = side === 0 ? leftPin[i] : rightPin[i];
            if (p < 0) continue;
            const maxD = Math.abs(cum[i] - cum[p]) * 1.001;
            const op = p * 3;
            const dx = pos[o] - pos[op];
            const dy = pos[o + 1] - pos[op + 1];
            const dz = pos[o + 2] - pos[op + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > maxD * maxD && d2 > 1e-18) {
              const k = maxD / Math.sqrt(d2);
              pos[o] = pos[op] + dx * k;
              pos[o + 1] = pos[op + 1] + dy * k;
              pos[o + 2] = pos[op + 2] + dz * k;
            }
          }
        }
        // collisions: water surface (floating line), ground, dock deck
        for (let i = 0; i < n; i++) {
          if (pinned[i]) continue;
          const o = i * 3;
          const x = pos[o];
          const z = pos[o + 2];
          let y = pos[o + 1];
          const gy = ground[i];
          const sy = surf[i];
          if (sy !== NO_SURF && gy < sy - 0.01) {
            if (!sinks[i] && y < sy + 0.003) {
              y = sy + 0.003;
              // surface film: the line barely slides on the water
              prev[o] = x - (x - prev[o]) * 0.25;
              prev[o + 2] = z - (z - prev[o + 2]) * 0.25;
              prev[o + 1] = y;
            } else if (sinks[i] && y < gy + 0.01) {
              y = gy + 0.01;
            }
          } else if (y < gy + 0.006) {
            y = gy + 0.006;
            prev[o] = x - (x - prev[o]) * 0.2;
            prev[o + 2] = z - (z - prev[o + 2]) * 0.2;
            prev[o + 1] = y;
          }
          if (x > -halfW && x < halfW && z > DOCK.endZ - 0.03 && z < DOCK.shoreZ && y < deckTop && y > DOCK.deckY - 0.35) {
            y = deckTop;
            prev[o + 1] = y;
          }
          pos[o + 1] = y;
        }
      }
    },
    // Pull free points of [a..b] toward the straight line between pins a and b (both must be pinned
    // or valid points). t in 0..1; velocity is preserved. With `near` in (0, 1] the pull fades out
    // along the line: full strength at a, zero from that fraction of the arc length on.
    straighten(a, b, t, near = 0) {
      if (t <= 0 || b <= a + 1) return;
      refreshCum();
      const span = cum[b] - cum[a];
      if (span < 1e-9) return;
      const oa = a * 3;
      const ob = b * 3;
      for (let i = a + 1; i < b; i++) {
        const f = (cum[i] - cum[a]) / span;
        let w = t;
        if (near > 0) {
          if (f >= near) break;
          const q = 1 - f / near;
          w = t * q * q;
        }
        const o = i * 3;
        for (let c = 0; c < 3; c++) {
          const target = pos[oa + c] + (pos[ob + c] - pos[oa + c]) * f;
          const d = (target - pos[o + c]) * w;
          pos[o + c] += d;
          prev[o + c] += d;
        }
      }
    },
    // Upload to the GPU. dimUnderwater: points below the surface fade into the water (colour and
    // opacity) and lose the sun glint.
    write(dimUnderwater = true) {
      for (let i = 0; i < n; i++) {
        let r = tint[i * 3];
        let g = tint[i * 3 + 1];
        let b = tint[i * 3 + 2];
        let al = baseAlpha[i];
        let dry = 1;
        if (dimUnderwater && surf[i] !== NO_SURF) {
          const d = surf[i] - pos[i * 3 + 1];
          if (d > 0.002) {
            // below the surface the line quickly takes the murky water colour and fades
            const f = Math.exp(-d / 0.2);
            const k = 0.16 + 0.5 * f;
            r = r * k * 0.7 + 0.01 * (1 - f);
            g = g * k + 0.025 * (1 - f);
            b = b * k * 0.9 + 0.025 * (1 - f);
            al *= 0.3 + 0.55 * f;
            dry = 0;
          }
        }
        ptCol[i * 3] = r;
        ptCol[i * 3 + 1] = g;
        ptCol[i * 3 + 2] = b;
        ptLn[i * 2] = al;
        ptLn[i * 2 + 1] = dry;
      }
      if (sub === 1) {
        rp.set(pos);
        rc.set(ptCol);
        rl.set(ptLn);
      } else {
        for (let i = 0; i < n - 1; i++) {
          const o1 = i * 3;
          const o2 = o1 + 3;
          const o0 = i > 0 ? o1 - 3 : -1;
          const o3 = i + 2 < n ? o2 + 3 : -1;
          // centripetal parameterisation (no loops or cusps on uneven spacing)
          const p1x = pos[o1], p1y = pos[o1 + 1], p1z = pos[o1 + 2];
          const p2x = pos[o2], p2y = pos[o2 + 1], p2z = pos[o2 + 2];
          const p0x = o0 >= 0 ? pos[o0] : 2 * p1x - p2x;
          const p0y = o0 >= 0 ? pos[o0 + 1] : 2 * p1y - p2y;
          const p0z = o0 >= 0 ? pos[o0 + 2] : 2 * p1z - p2z;
          const p3x = o3 >= 0 ? pos[o3] : 2 * p2x - p1x;
          const p3y = o3 >= 0 ? pos[o3 + 1] : 2 * p2y - p1y;
          const p3z = o3 >= 0 ? pos[o3 + 2] : 2 * p2z - p1z;
          const d01 = Math.max(1e-4, Math.sqrt(Math.hypot(p1x - p0x, p1y - p0y, p1z - p0z)));
          const d12 = Math.max(1e-4, Math.sqrt(Math.hypot(p2x - p1x, p2y - p1y, p2z - p1z)));
          const d23 = Math.max(1e-4, Math.sqrt(Math.hypot(p3x - p2x, p3y - p2y, p3z - p2z)));
          const t1 = d01;
          const t2 = t1 + d12;
          const t3 = t2 + d23;
          const yMin = Math.min(p1y, p2y);
          // a chord between two adjacent pins (the float's clips) stays straight, inside the float
          const straight = pinned[i] && pinned[i + 1];
          for (let k = 0; k < sub; k++) {
            const u = k / sub;
            const j = i * sub + k;
            const oj = j * 3;
            if (k === 0 || straight) {
              rp[oj] = p1x + (p2x - p1x) * u;
              rp[oj + 1] = p1y + (p2y - p1y) * u;
              rp[oj + 2] = p1z + (p2z - p1z) * u;
            } else {
              const t = t1 + d12 * u;
              const a1 = (t1 - t) / t1;
              const b1 = t / t1;
              const a2 = (t2 - t) / d12;
              const b2 = (t - t1) / d12;
              const a3 = (t3 - t) / d23;
              const b3 = (t - t2) / d23;
              const c1 = (t2 - t) / t2;
              const e1 = t / t2;
              const c2 = (t3 - t) / (t3 - t1);
              const e2 = (t - t1) / (t3 - t1);
              let x, y, z;
              {
                const A1 = a1 * p0x + b1 * p1x, A2 = a2 * p1x + b2 * p2x, A3 = a3 * p2x + b3 * p3x;
                x = a2 * (c1 * A1 + e1 * A2) + b2 * (c2 * A2 + e2 * A3);
              }
              {
                const A1 = a1 * p0y + b1 * p1y, A2 = a2 * p1y + b2 * p2y, A3 = a3 * p2y + b3 * p3y;
                y = a2 * (c1 * A1 + e1 * A2) + b2 * (c2 * A2 + e2 * A3);
              }
              {
                const A1 = a1 * p0z + b1 * p1z, A2 = a2 * p1z + b2 * p2z, A3 = a3 * p2z + b3 * p3z;
                z = a2 * (c1 * A1 + e1 * A2) + b2 * (c2 * A2 + e2 * A3);
              }
              if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
                x = p1x + (p2x - p1x) * u;
                y = p1y + (p2y - p1y) * u;
                z = p1z + (p2z - p1z) * u;
              }
              // never dip below both ends (keeps floating line on the water film)
              rp[oj] = x;
              rp[oj + 1] = y < yMin ? yMin : y;
              rp[oj + 2] = z;
            }
            const u1 = 1 - u;
            rc[oj] = ptCol[o1] * u1 + ptCol[o2] * u;
            rc[oj + 1] = ptCol[o1 + 1] * u1 + ptCol[o2 + 1] * u;
            rc[oj + 2] = ptCol[o1 + 2] * u1 + ptCol[o2 + 2] * u;
            rl[j * 2] = ptLn[i * 2] * u1 + ptLn[i * 2 + 2] * u;
            rl[j * 2 + 1] = ptLn[i * 2 + 1] * u1 + ptLn[i * 2 + 3] * u;
          }
        }
        const oL = (n - 1) * 3;
        const jL = (nr - 1) * 3;
        rp[jL] = pos[oL];
        rp[jL + 1] = pos[oL + 1];
        rp[jL + 2] = pos[oL + 2];
        rc[jL] = ptCol[oL];
        rc[jL + 1] = ptCol[oL + 1];
        rc[jL + 2] = ptCol[oL + 2];
        rl[(nr - 1) * 2] = ptLn[(n - 1) * 2];
        rl[(nr - 1) * 2 + 1] = ptLn[(n - 1) * 2 + 1];
      }
      const a = posBuf.array;
      const c = colBuf.array;
      const l = lnBuf.array;
      for (let s = 0; s < nr - 1; s++) {
        const o = s * 3;
        const k = s * 6;
        a[k] = rp[o];
        a[k + 1] = rp[o + 1];
        a[k + 2] = rp[o + 2];
        a[k + 3] = rp[o + 3];
        a[k + 4] = rp[o + 4];
        a[k + 5] = rp[o + 5];
        c[k] = rc[o];
        c[k + 1] = rc[o + 1];
        c[k + 2] = rc[o + 2];
        c[k + 3] = rc[o + 3];
        c[k + 4] = rc[o + 4];
        c[k + 5] = rc[o + 5];
        const q = s * 4;
        l[q] = rl[s * 2];
        l[q + 1] = rl[s * 2 + 1];
        l[q + 2] = rl[s * 2 + 2];
        l[q + 3] = rl[s * 2 + 3];
      }
      posBuf.needsUpdate = true;
      colBuf.needsUpdate = true;
      lnBuf.needsUpdate = true;
    },
    hasNaN() {
      for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) return true;
      return false;
    },
    dispose() {
      geom.dispose();
    },
  };
  return api;
}
