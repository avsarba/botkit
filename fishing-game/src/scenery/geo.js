// Tiny incremental geometry builder (positions / normals / uvs / colors / extra float attribs).
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

export class MeshBuilder {
  constructor({ colors = false, extra = null } = {}) {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.c = colors ? [] : null;
    this.extra = extra ? Object.fromEntries(Object.entries(extra).map(([k, size]) => [k, { size, data: [] }])) : null;
    this.idx = [];
    this.count = 0;
  }

  // p, n: [x,y,z]; uv: [u,v]; c: [r,g,b]; ex: { name: number | array }
  vert(p, n, uv, c, ex) {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.uv.push(uv ? uv[0] : 0, uv ? uv[1] : 0);
    if (this.c) this.c.push(c ? c[0] : 1, c ? c[1] : 1, c ? c[2] : 1);
    if (this.extra) {
      for (const k in this.extra) {
        const e = this.extra[k];
        const v = ex ? ex[k] : undefined;
        if (e.size === 1) e.data.push(v === undefined ? 0 : v);
        else for (let i = 0; i < e.size; i++) e.data.push(v ? v[i] : 0);
      }
    }
    return this.count++;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  quad(a, b, c, d) {
    // a-b-c-d counter-clockwise seen from the front
    this.idx.push(a, b, c, a, c, d);
  }

  // Append another builder's content transformed by a Matrix4 (normals by its normal matrix).
  append(other, matrix = null, colorMul = null) {
    const base = this.count;
    if (matrix) _nm.getNormalMatrix(matrix);
    for (let i = 0; i < other.count; i++) {
      _v.set(other.p[i * 3], other.p[i * 3 + 1], other.p[i * 3 + 2]);
      _n.set(other.n[i * 3], other.n[i * 3 + 1], other.n[i * 3 + 2]);
      if (matrix) {
        _v.applyMatrix4(matrix);
        _n.applyMatrix3(_nm).normalize();
      }
      this.p.push(_v.x, _v.y, _v.z);
      this.n.push(_n.x, _n.y, _n.z);
      this.uv.push(other.uv[i * 2], other.uv[i * 2 + 1]);
      if (this.c) {
        const r = other.c ? other.c[i * 3] : 1;
        const g = other.c ? other.c[i * 3 + 1] : 1;
        const b = other.c ? other.c[i * 3 + 2] : 1;
        if (colorMul) this.c.push(r * colorMul[0], g * colorMul[1], b * colorMul[2]);
        else this.c.push(r, g, b);
      }
      if (this.extra) {
        for (const k in this.extra) {
          const e = this.extra[k];
          const src = other.extra && other.extra[k];
          for (let j = 0; j < e.size; j++) e.data.push(src ? src.data[i * e.size + j] : 0);
        }
      }
    }
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + base);
    this.count += other.count;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (this.extra) for (const k in this.extra) g.setAttribute(k, new THREE.Float32BufferAttribute(this.extra[k].data, this.extra[k].size));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Axis-aligned box in local space with a UV callback per face.
// uvFn(face, a, b) -> [u, v] where face in 'px','nx','py','ny','pz','nz' and a,b in [0,1].
// Returns nothing; vertices are transformed by `m` (Matrix4) if given.
const FACES = {
  px: { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  py: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  ny: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  nz: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
};
const _bm = new THREE.Matrix4();
export function addBox(builder, sx, sy, sz, m, uvFn, color, skip = null) {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const h = [hx, hy, hz];
  if (m) _nm.getNormalMatrix(m);
  for (const f in FACES) {
    if (skip && skip.includes(f)) continue;
    const F = FACES[f];
    const ids = [];
    for (let k = 0; k < 4; k++) {
      const a = k === 1 || k === 2 ? 1 : 0;
      const b = k >= 2 ? 1 : 0;
      const p = [0, 0, 0];
      for (let j = 0; j < 3; j++) p[j] = F.n[j] * h[j] + F.u[j] * (a * 2 - 1) * h[j] + F.v[j] * (b * 2 - 1) * h[j];
      _v.set(p[0], p[1], p[2]);
      _n.set(F.n[0], F.n[1], F.n[2]);
      if (m) {
        _v.applyMatrix4(m);
        _n.applyMatrix3(_nm).normalize();
      }
      ids.push(builder.vert([_v.x, _v.y, _v.z], [_n.x, _n.y, _n.z], uvFn ? uvFn(f, a, b) : [a, b], color));
    }
    builder.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

export { _bm as scratchMatrix };
