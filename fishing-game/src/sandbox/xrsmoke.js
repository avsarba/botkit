import * as THREE from 'three';
const r = new THREE.WebGLRenderer({ antialias: true });
r.setSize(innerWidth, innerHeight);
r.xr.enabled = true;
document.body.appendChild(r.domElement);
const s = new THREE.Scene();
s.background = new THREE.Color(0x335577);
const c = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);
s.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0xcc6633 }));
box.position.set(0, 1.5, -1.2);
s.add(box);
const grip = r.xr.getControllerGrip(1);
grip.add(new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.6).rotateX(Math.PI / 2).translate(0, 0, -0.3), new THREE.MeshStandardMaterial({ color: 0x22aa44 })));
s.add(grip);
const ctrl1 = r.xr.getController(1);
s.add(ctrl1);
let frames = 0, xrFrames = 0, info = {};
ctrl1.addEventListener('connected', (e) => (info.handedness1 = e.data.handedness));
r.setAnimationLoop((t, xrFrame) => {
  frames++;
  if (xrFrame) xrFrames++;
  box.rotation.y += 0.02;
  r.render(s, c);
});
window.__game = {
  debug: {
    stats: () => ({ frames, xrFrames, presenting: r.xr.isPresenting, info, grip: grip.position.toArray().map((v) => +v.toFixed(3)) }),
    async enter() {
      const sup = await navigator.xr.isSessionSupported('immersive-vr');
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      await r.xr.setSession(session);
      return { sup, presenting: r.xr.isPresenting };
    },
  },
};
