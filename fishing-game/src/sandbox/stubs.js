// Minimal, contract-shaped stand-ins so each module can be developed and
// screenshotted on its own before integration (see CONTRACT.md).
// Sandboxes: `node build.mjs --entry src/sandbox/<name>.js --out dist/sandbox-<name>.html`
import * as THREE from 'three';
import { createEmitter, DOCK, PLAYER, WATER_LEVEL, STATES } from '../config.js';

export function makeSandbox({ quality = 'high' } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  (document.getElementById('stage') || document.body).appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 2500);
  camera.position.set(PLAYER.position[0], PLAYER.position[1] + PLAYER.eyeHeight, PLAYER.position[2]);
  camera.rotation.order = 'YXZ';
  camera.rotation.x = -0.12;
  scene.add(camera);
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const events = createEmitter();
  const frame = {
    dt: 0,
    time: 0,
    hours: 7.5,
    camera,
    state: STATES.READY,
    quality,
    lure: null,
    hooked: null,
    tension01: 0,
    input: { aimYaw: 0, aimPitch: 0, reeling: false, charge01: 0 },
  };
  const ctx = { renderer, scene, camera, events, quality };
  return { renderer, scene, camera, events, frame, ctx };
}

// Bowl-shaped lake with the dock at the origin. Shore is ~z=+16 behind the player.
export function stubEnvironment({ scene, renderer }) {
  const sunDirection = new THREE.Vector3(0.35, 0.28, -0.9).normalize();
  const sunColor = new THREE.Color(1.0, 0.86, 0.7);
  const horizonColor = new THREE.Color(0.75, 0.82, 0.88);
  const skyColor = new THREE.Color(0.42, 0.6, 0.85);
  scene.background = skyColor.clone();
  scene.fog = new THREE.Fog(horizonColor.getHex(), 80, 900);
  const sun = new THREE.DirectionalLight(sunColor, 2.2);
  sun.position.copy(sunDirection).multiplyScalar(80);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(skyColor, 0x4a4a30, 0.8));

  const getTerrainHeight = (x, z) => {
    const r = Math.hypot(x / 1.4, z + 150);
    return -Math.min(11, Math.max(-6, (166 - r) * 0.12)) + (z > 16 ? (z - 16) * 0.08 : 0);
  };
  const size = 800;
  const seg = 160;
  const g = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, getTerrainHeight(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x5d6b3a, roughness: 1 }));
  scene.add(ground);

  const dock = new THREE.Mesh(
    new THREE.BoxGeometry(DOCK.width, 0.12, DOCK.shoreZ - DOCK.endZ),
    new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 })
  );
  dock.position.set(0, DOCK.deckY - 0.06, (DOCK.shoreZ + DOCK.endZ) / 2);
  scene.add(dock);

  const depthAt = (x, z) => Math.max(0, WATER_LEVEL - getTerrainHeight(x, z));
  return {
    update() {},
    setTimeOfDay() {},
    sunDirection,
    sunColor,
    sunIntensity: 2.2,
    skyColor,
    horizonColor,
    envMap: null,
    windStrength: 0.3,
    windDirection: new THREE.Vector2(1, -0.3).normalize(),
    getTerrainHeight,
    getDepth: depthAt,
    isWater: (x, z) => depthAt(x, z) > 0.05,
    getHabitat: (x, z) => ({ depth: depthAt(x, z), weeds: x < -15 && z < 12 ? 0.8 : 0.1, rocks: x > 20 ? 0.7 : 0.1, wood: 0 }),
    depthMap: null,
  };
}

// Flat water with no waves.
export function stubWater({ scene }) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x1d4a55, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.85 })
  );
  mesh.renderOrder = 10;
  scene.add(mesh);
  return {
    mesh,
    update() {},
    getHeight: () => WATER_LEVEL,
    getNormal: (x, z, target = new THREE.Vector3()) => target.set(0, 1, 0),
    addRipple() {},
    splash() {},
    wake() {},
    clarityM: 3,
  };
}
