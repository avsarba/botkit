// Lake depth texture for water shading (and the mist mask).
// RGBA8, linear filtered, texel (u, v) = ((x - minX) / (maxX - minX), (z - minZ) / (maxZ - minZ)),
// row 0 at minZ. R = depth / 12 m (0 on land), G = distance from shore / 32 m (0 on land),
// B = weed cover (0..1), A = 1.
import * as THREE from 'three';

export function createDepthMap(field, bounds, size) {
  const { minX, minZ, maxX, maxZ } = bounds;
  const data = new Uint8Array(size * size * 4);
  const hab = {};
  for (let j = 0; j < size; j++) {
    const z = minZ + ((j + 0.5) / size) * (maxZ - minZ);
    for (let i = 0; i < size; i++) {
      const x = minX + ((i + 0.5) / size) * (maxX - minX);
      const o = (j * size + i) * 4;
      data[o + 3] = 255;
      const d = field.lakeDistance(x, z);
      if (d < -1) continue; // land: all zero
      field.habitat(x, z, hab, d);
      const depth = hab.depth;
      if (depth <= 0) continue;
      data[o] = Math.min(255, Math.round((depth / 12) * 255));
      data[o + 1] = Math.min(255, Math.max(0, Math.round((d / 32) * 255)));
      data[o + 2] = Math.round(hab.weeds * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'env-depth-map';
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, bounds: { minX, minZ, maxX, maxZ } };
}
