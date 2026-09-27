import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const S = window.SHARED;
const $ = id => document.getElementById(id);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angLerp = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };

// =============================================================== Renderer / scene
const canvas = $('game');
let HQ = store.get('wt_hq') != null ? store.get('wt_hq') === '1' : !matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 900);
scene.fog = new THREE.Fog(0xdff4ff, 85, 200);

// strong sky fill + gentle sun = soft, light shadows (clean look)
const hemi = new THREE.HemisphereLight(0xf2f8ff, 0x9cc77a, 2.0);
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 1, far: 260 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(hemi, sun, sun.target);
const torch = new THREE.PointLight(0xffb060, 0, 20, 1.2);
const coreLight = new THREE.PointLight(0xffc070, 0, 32, 1.2);
coreLight.position.set(S.CORE.x, 7, S.CORE.z);
scene.add(torch, coreLight);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.2, 0.5, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, HQ ? 2 : 1));
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// =============================================================== Mesh helpers
const matCache = new Map(), geoCache = new Map();
// 3-step toon ramp: flat, clean colour blocks instead of noisy lambert gradients
const toonRamp = (() => {
  const t = new THREE.DataTexture(new Uint8Array([150, 205, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t;
})();
const mat = c => { let m = matCache.get(c); if (!m) { m = new THREE.MeshToonMaterial({ color: c, gradientMap: toonRamp }); matCache.set(c, m); } return m; };
const glow = (c, k = 1) => { const key = 'g' + c + '_' + k; let m = matCache.get(key); if (!m) { m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) }); matCache.set(key, m); } return m; };
const geo = (k, fn) => { let g = geoCache.get(k); if (!g) { g = fn(); geoCache.set(k, g); } return g; };
function mesh(g, c, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(g, typeof c === 'number' ? mat(c) : c);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
}
const BOX = new THREE.BoxGeometry(1, 1, 1);
const box = (w, h, d, c, x, y, z) => { const m = mesh(BOX, c, x, y, z); m.scale.set(w, h, d); return m; };
const cyl = (rt, rb, h, c, seg = 8) => mesh(geo(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), c);
const cone = (r, h, c, seg = 7) => mesh(geo(`k${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg)), c);
const ball = (r, c, d = 1) => mesh(geo(`s${r},${d}`, () => new THREE.IcosahedronGeometry(r, d)), c);
const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
const noShadow = m => { m.traverse(o => { o.castShadow = false; }); return m; };

// value noise for terrain/props
function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi, u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// 0..1 how much bare dirt a spot has (paths, plaza, work yards)
function dirtAt(x, z) {
  let d = 1 - smooth(6.5, 8, Math.hypot(x - S.CORE.x, z - S.CORE.z));
  d = Math.max(d, (1 - smooth(2.2, 3.2, Math.abs(x))) * smooth(3, 5, z) * (1 - smooth(76, 80, z)));
  d = Math.max(d, (1 - smooth(1.8, 2.8, Math.abs(z - 8.2))) * (1 - smooth(11, 13, Math.abs(x))));
  for (const sx of [-10, 10]) d = Math.max(d, (1 - smooth(4.5, 6, Math.abs(x - sx))) * (1 - smooth(3.5, 5, Math.abs(z + 3.5))));
  d = Math.max(d, (1 - smooth(5.5, 7, Math.abs(x))) * (1 - smooth(3, 4.5, Math.abs(z + 13.8))));
  return d;
}
const inPond = (x, z, pad = 0) => S.PONDS.some(p => Math.hypot(p.x - x, p.z - z) < p.r + pad);

// =============================================================== Sky
const skyU = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, bot: { value: new THREE.Color(0x9cd67a) } };
const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
  uniforms: skyU, side: THREE.BackSide, depthWrite: false,
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 bot; varying vec3 vP;
    void main(){ float h = normalize(vP).y; vec3 c = h > 0.0 ? mix(hor, top, pow(h, 0.6)) : mix(hor, bot, clamp(-h*4.0,0.0,1.0));
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    }`,
}));
sky.renderOrder = -1;
scene.add(sky);
const stars = (() => {
  const n = 500, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2 + 0.25;
    p[i * 3] = Math.cos(a) * Math.cos(e) * 380; p[i * 3 + 1] = Math.sin(e) * 380; p[i * 3 + 2] = Math.sin(a) * Math.cos(e) * 380;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(m); return m;
})();
const PAL = {
  day: { top: new THREE.Color(0x7cc8ff), hor: new THREE.Color(0xe3f5ff), sun: new THREE.Color(0xfff4e0), hemi: 2.0, sunI: 1.6 },
  dusk: { top: new THREE.Color(0x9a8ce0), hor: new THREE.Color(0xffc4a0), sun: new THREE.Color(0xffb890), hemi: 1.5, sunI: 1.2 },
  night: { top: new THREE.Color(0x1a2050), hor: new THREE.Color(0x3a4a8a), sun: new THREE.Color(0x9aa8ff), hemi: 0.75, sunI: 0.55 },
};

// =============================================================== Terrain
function buildTerrain() {
  const SEG = 180, SIZE = 280;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2);
  const pos = g.attributes.position, cols = new Float32Array(pos.count * 3), c = new THREE.Color();
  const grassA = new THREE.Color(0x8fd16a), grassB = new THREE.Color(0x9ddb74), forest = new THREE.Color(0x7cc460),
    town = new THREE.Color(0xa8e07e), dirt = new THREE.Color(0xf2dcaa), dirtD = new THREE.Color(0xe8cc92), sand = new THREE.Color(0xf6e6b4);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z);
    const n = vnoise(x * 0.035, z * 0.035);
    c.copy(grassA).lerp(grassB, smooth(0.35, 0.65, n));
    c.lerp(forest, smooth(34, 50, r) * 0.6);
    c.lerp(town, (1 - smooth(27, 30, r)) * 0.6);
    const dd = dirtAt(x, z);
    if (dd > 0) c.lerp(tmp.copy(dirt).lerp(dirtD, vnoise(x * 0.12, z * 0.12) * 0.5), smooth(0.2, 0.6, dd));
    for (const p of S.PONDS) { const pd = Math.hypot(p.x - x, p.z - z); c.lerp(sand, (1 - smooth(p.r, p.r + 2, pd))); }
    if (r > 95) pos.setY(i, (r - 95) * 0.4 * (0.6 + vnoise(x * 0.05, z * 0.05)));
    cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  scene.add(ground);

  for (let i = 0; i < 40; i++) {
    const a = i / 40 * Math.PI * 2 + hash(i, 3) * 0.1, r = 100 + hash(i, 7) * 20, h = 18 + hash(i, 9) * 26;
    const m = cone(10 + hash(i, 1) * 10, h, i % 3 ? 0x86c79a : 0xa6bdd6, 6);
    m.position.set(Math.cos(a) * r, h / 2 + 4, Math.sin(a) * r); m.castShadow = false;
    scene.add(m);
    if (h > 34) { const cap = cone(4, 6, 0xffffff, 6); cap.position.set(m.position.x, h + 1.5, m.position.z); cap.castShadow = false; scene.add(cap); }
  }
}
buildTerrain();

// ---- water
const waterU = { uTime: { value: 0 } };
const waterMat = new THREE.ShaderMaterial({
  uniforms: waterU, transparent: true,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform float uTime; varying vec2 vUv;
    void main(){ vec2 p = vUv - 0.5; float d = length(p) * 2.0;
      float rip = sin(d * 26.0 - uTime * 1.6) * 0.5 + 0.5; float sp = sin(p.x * 40.0 + uTime) * sin(p.y * 37.0 - uTime * 1.3);
      vec3 deep = vec3(0.22, 0.62, 0.9), shallow = vec3(0.6, 0.92, 0.96);
      vec3 c = mix(deep, shallow, smoothstep(0.55, 1.0, d)) + rip * 0.04 + smoothstep(0.85, 1.0, sp) * 0.25;
      gl_FragColor = vec4(c, 0.9 * (1.0 - smoothstep(0.96, 1.0, d)));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
for (const p of S.PONDS) {
  const w = new THREE.Mesh(new THREE.CircleGeometry(p.r + 0.6, 40).rotateX(-Math.PI / 2), waterMat);
  w.position.set(p.x, 0.05, p.z); scene.add(w);
  for (let i = 0; i < 6; i++) {
    const a = hash(p.x + i, 1) * 6.28, r = hash(i, p.z) * p.r * 0.8;
    const lily = mesh(geo('lily', () => new THREE.CircleGeometry(0.45, 8, 0.4, 5.6).rotateX(-Math.PI / 2)), 0x6cc46a, p.x + Math.cos(a) * r, 0.08, p.z + Math.sin(a) * r);
    lily.castShadow = false; scene.add(lily);
    if (i % 2 === 0) scene.add(noShadow(at(ball(0.12, 0xff8fc0, 0), lily.position.x, 0.16, lily.position.z)));
  }
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2 + hash(i, p.x), r = p.r + 0.4 + hash(i, 5) * 0.6;
    const reed = cyl(0.04, 0.05, 1 + hash(i, 2), 0x6a8f3a, 4);
    reed.position.set(p.x + Math.cos(a) * r, 0.5, p.z + Math.sin(a) * r); reed.castShadow = false; scene.add(reed);
  }
}

// ---- ground decor: a few tidy flower patches, soft tufts & mushrooms (no noisy grass blades)
const windU = { value: 0 };
function windMaterial(opts) {
  const m = new THREE.MeshToonMaterial({ gradientMap: toonRamp, ...opts });
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = windU;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float hh = max(position.y, 0.0);
      #ifdef USE_INSTANCING
        vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      #else
        vec4 wp = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      #endif
      float wv = sin(uTime * 1.7 + wp.x * 0.35 + wp.z * 0.22) * 0.6 + sin(uTime * 3.3 + wp.x * 0.9 - wp.z * 0.4) * 0.25;
      transformed.x += wv * hh * 0.12; transformed.z += wv * hh * 0.06;`);
  };
  return m;
}
let decor = [];
function buildDecor() {
  for (const m of decor) scene.remove(m);
  decor = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  const free = (x, z, pad = 1) => dirtAt(x, z) < 0.05 && !inPond(x, z, pad) && Math.abs(Math.hypot(x, z) - 28) > 2.5; // keep walls/paths clear
  const spot = (rMin, rMax) => { for (let k = 0; k < 30; k++) { const a = Math.random() * 6.28, r = rMin + Math.random() * (rMax - rMin), x = Math.cos(a) * r, z = Math.sin(a) * r; if (free(x, z, 1.5)) return [x, z]; } return null; };
  const add = m => { m.receiveShadow = true; scene.add(m); decor.push(m); return m; };

  // soft grass tufts: 3 rounded blades, colour only a touch lighter than the ground so they read as texture, not clutter
  const tuftGeo = (() => {
    const parts = [];
    for (let k = 0; k < 3; k++) {
      const g = new THREE.ConeGeometry(0.09, 0.34 + k * 0.05, 5).translate(0, 0.17 + k * 0.025, 0);
      g.rotateZ((k - 1) * 0.35); g.translate((k - 1) * 0.08, 0, (k % 2) * 0.05); parts.push(g);
    }
    return mergeGeos(parts);
  })();
  const nT = HQ ? 260 : 140, tufts = add(new THREE.InstancedMesh(tuftGeo, windMaterial({ color: 0xffffff }), nT));
  let ti = 0;
  for (let i = 0; i < nT; i++) {
    const s0 = spot(10, 80); if (!s0) continue;
    p.set(s0[0], 0, s0[1]); q.setFromAxisAngle(up, Math.random() * 6.28); sc.setScalar(0.9 + Math.random() * 0.6);
    tufts.setMatrixAt(ti, m4.compose(p, q, sc)); tufts.setColorAt(ti, c.setHSL(0.27 + Math.random() * 0.03, 0.5, 0.62 + Math.random() * 0.06)); ti++;
  }
  tufts.count = ti;

  // flower patches: small clusters so the meadow looks cute and intentional, not speckled
  const petal = new THREE.IcosahedronGeometry(0.12, 1).translate(0, 0.24, 0);
  const FC = [0xffffff, 0xffb3cc, 0xffe36e, 0xc9b3ff, 0xffc79a];
  const patches = HQ ? 46 : 26, nF = patches * 6, flowers = add(new THREE.InstancedMesh(petal, windMaterial({ color: 0xffffff }), nF));
  let fi = 0;
  for (let k = 0; k < patches; k++) {
    const s0 = spot(12, 78); if (!s0) continue;
    const col = FC[k % FC.length];
    for (let j = 0; j < 6; j++) {
      const x = s0[0] + (Math.random() - 0.5) * 1.8, z = s0[1] + (Math.random() - 0.5) * 1.8;
      p.set(x, 0, z); q.identity(); sc.setScalar(0.8 + Math.random() * 0.5);
      flowers.setMatrixAt(fi, m4.compose(p, q, sc)); flowers.setColorAt(fi, c.setHex(j === 0 ? 0xffe36e : col)); fi++;
    }
  }
  flowers.count = fi;

  // a handful of toadstools out in the woods
  const nM = HQ ? 22 : 12;
  const stems = add(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 8).translate(0, 0.11, 0), mat(0xfff6e8), nM));
  const caps = add(new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.75, 1).translate(0, 0.2, 0), mat(0xffffff), nM));
  let mi = 0;
  for (let i = 0; i < nM; i++) {
    const s0 = spot(34, 80); if (!s0) continue;
    p.set(s0[0], 0, s0[1]); q.identity(); sc.setScalar(0.9 + Math.random() * 0.7); m4.compose(p, q, sc);
    stems.setMatrixAt(mi, m4); caps.setMatrixAt(mi, m4); caps.setColorAt(mi, c.setHex(i % 3 ? 0xff7a85 : 0xffb46b)); mi++;
  }
  stems.count = caps.count = mi;
}
function mergeGeos(list) {
  const pos = [], nor = [];
  for (const g of list) { const n = g.toNonIndexed(); pos.push(...n.attributes.position.array); nor.push(...n.attributes.normal.array); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
buildDecor();
// a few decorative bushes & flowers inside town (clear of pads)
for (const [x, z] of [[-18, 14], [18, 14], [-20, -6], [20, -6], [-9, 16], [9, 16], [-19, -16], [19, -16], [-6, -21], [6, -21]]) {
  const b = new THREE.Group();
  b.add(at(ball(0.7, 0x5cc46a, 2), 0, 0.5, 0)); b.add(at(ball(0.5, 0x7ad37a, 2), 0.5, 0.45, 0.2)); b.add(at(ball(0.13, 0xffb3cc, 1), 0.2, 1.08, 0.3)); b.add(at(ball(0.11, 0xffffff, 1), -0.35, 0.95, 0.35));
  b.position.set(x, 0, z); scene.add(b);
}

// ---- clouds
const clouds = [], CLOUD_Y = 85; // must stay above the camera's max height
for (let i = 0; i < 12; i++) {
  const g = new THREE.Group();
  const n = 3 + Math.floor(hash(i, 4) * 3);
  for (let k = 0; k < n; k++) {
    const b = ball(2 + hash(i, k) * 2.2, 0xffffff, 1);
    b.position.set(k * 2.6 - n * 1.3, hash(k, i) * 1.2, (hash(i * 3, k) - 0.5) * 2.5); b.receiveShadow = false;
    g.add(b);
  }
  g.position.set((hash(i, 1) - 0.5) * 240, CLOUD_Y + hash(i, 2) * 10, (hash(i, 3) - 0.5) * 200);
  g.scale.set(2, 1, 1.6);
  scene.add(g); clouds.push(g);
}

// ---- lamp posts (glow at night)
const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });
const LAMPS = [[-3.5, 12.5], [3.5, 12.5], [-3.5, 22], [3.5, 22], [-12.5, 11], [12.5, 11], [-6, -8.5], [6, -8.5], [-16, -5], [16, -5]];
for (const [x, z] of LAMPS) {
  scene.add(at(cyl(0.07, 0.1, 2.8, 0x3a3a44, 6), x, 1.4, z));
  scene.add(at(box(0.35, 0.08, 0.35, 0x3a3a44), x, 2.85, z));
  const b = new THREE.Mesh(geo('bulb', () => new THREE.IcosahedronGeometry(0.18, 1)), bulbMat); b.position.set(x, 2.7, z); scene.add(b);
}
for (const [x, z, t] of [[-14.5, -6, 0], [-14.5, -4.8, 0], [14.5, -6, 1], [5.2, 10.6, 1], [-5.2, 10.6, 0], [-3, -6.5, 1], [3.2, -6.8, 0], [15.5, -3, 1], [-2.2, 16, 1]]) {
  if (t) scene.add(at(box(0.8, 0.8, 0.8, 0xb58450), x, 0.4, z));
  else scene.add(at(cyl(0.38, 0.38, 0.9, 0x8a5a30, 10), x, 0.45, z));
}

// =============================================================== Buildings
function makeCore() {
  const g = new THREE.Group();
  g.add(box(6.2, 0.5, 6.2, 0x8f877a, 0, 0.25, 0));
  g.add(box(5.4, 2.6, 5.4, 0xc9c0b0, 0, 1.5, 0));
  for (let k = -1; k <= 1; k++) {
    g.add(box(0.5, 0.5, 0.5, 0xbdb3a2, k * 1.2, 3.05, 2.5)); g.add(box(0.5, 0.5, 0.5, 0xbdb3a2, k * 1.2, 3.05, -2.5));
    g.add(box(0.5, 0.5, 0.5, 0xbdb3a2, 2.5, 3.05, k * 1.2)); g.add(box(0.5, 0.5, 0.5, 0xbdb3a2, -2.5, 3.05, k * 1.2));
  }
  for (const sx of [-2.6, 2.6]) for (const sz of [-2.6, 2.6]) {
    g.add(at(cyl(0.95, 1.05, 4.4, 0xd6cdbd, 10), sx, 2.2, sz));
    g.add(at(cone(1.3, 1.8, 0xc0392b, 10), sx, 5.3, sz));
    g.add(box(0.25, 0.4, 0.06, 0x2a2a35, sx, 3.2, sz + Math.sign(sz) * 1.0));
  }
  g.add(box(3.2, 2.6, 3.2, 0xe2d9c9, 0, 4.1, 0));
  const roof = at(cone(2.6, 2.3, 0x2c6fbb, 4), 0, 6.55, 0); roof.rotation.y = Math.PI / 4; g.add(roof);
  g.add(at(cyl(0.06, 0.06, 2), 0, 8.4, 0));
  g.add(box(1.1, 0.6, 0.04, 0xff4040, 0.55, 9, 0));
  g.add(box(1.5, 2, 0.14, 0x5a3a1c, 0, 1.25, 2.72));
  for (const sx of [-1.4, 1.4]) g.add(box(0.5, 0.7, 0.06, glow(0xffc060, 1.2), sx, 4.2, 1.62));
  g.position.set(S.CORE.x, 0, S.CORE.z);
  return g;
}
function makeGrill() {
  const g = new THREE.Group();
  g.add(box(3.4, 1, 2.8, 0x8d8d8d, 0, 0.5, 0));
  for (let i = 0; i < 5; i++) g.add(box(0.7, 0.35, 0.05, 0x777777, -1.4 + i * 0.7, 0.3 + (i % 2) * 0.35, 1.41));
  g.add(box(3.1, 0.08, 2.5, 0x222222, 0, 1.05, 0));
  const fire = box(2.7, 0.05, 2.1, glow(0xff7a1a, 2.2), 0, 1.0, 0); fire.castShadow = false; g.add(fire);
  for (let i = 0; i < 4; i++) g.add(box(0.5, 0.2, 0.4, 0x8a4a1c, -0.9 + i * 0.6, 1.18, (i % 2) * 0.6 - 0.3));
  g.add(at(cyl(0.3, 0.38, 2.6, 0x6d6d6d, 8), 1.2, 2.3, -1));
  g.add(at(cyl(0.4, 0.3, 0.3, 0x555555, 8), 1.2, 3.65, -1));
  for (const sx of [-1.6, 1.6]) g.add(at(cyl(0.07, 0.07, 2.4, 0x6b4a2b), sx, 1.2, 1.3));
  const roof = box(3.6, 0.1, 1.6, 0xb03a2e, 0, 2.45, 0.9); roof.rotation.x = -0.25; g.add(roof);
  g.userData.smoke = [1.2, 3.9, -1];
  return g;
}
function makeSaw() {
  const g = new THREE.Group();
  g.add(box(3.6, 0.3, 3.2, 0x8f877a, 0, 0.15, 0));
  g.add(box(3.4, 2.2, 3, 0xa0703c, 0, 1.4, 0));
  for (let i = 0; i < 6; i++) g.add(box(0.06, 2.2, 3.02, 0x8b5e30, -1.6 + i * 0.64, 1.4, 0));
  const roof = at(cone(2.95, 1.6, 0x7a4a24, 4), 0, 3.3, 0); roof.rotation.y = Math.PI / 4; g.add(roof);
  g.add(box(1.2, 1.6, 0.1, 0x5a3a1c, 0, 1.1, 1.52));
  g.add(box(2.4, 0.8, 1, 0x6b4a2b, 0, 0.4, 2.1));
  g.add(at(mesh(geo('logSaw', () => new THREE.CylinderGeometry(0.22, 0.22, 2, 8).rotateZ(Math.PI / 2)), 0x8b5a2b), 0, 1.02, 2.1));
  const disc = at(cyl(0.65, 0.65, 0.05, 0xe6e6e6, 16), 0, 1.0, 2.1); disc.rotation.z = Math.PI / 2; g.add(disc);
  g.userData.spin = disc;
  return g;
}
function signTexture(text, bg) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.beginPath(); x.roundRect(2, 2, 252, 60, 12); x.fill();
  x.fillStyle = '#fff'; x.font = 'bold 34px Kanit, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function makeShop(c1, c2, text) {
  const g = new THREE.Group();
  g.add(box(3.6, 1.1, 1.2, 0xb07a45, 0, 0.55, 0));
  for (let i = 0; i < 5; i++) g.add(box(0.05, 1.1, 1.22, 0x94623a, -1.6 + i * 0.8, 0.55, 0));
  g.add(box(3.9, 0.1, 1.4, 0xd9a066, 0, 1.12, 0));
  for (const sx of [-1.85, 1.85]) for (const sz of [-0.65, 0.65]) g.add(at(cyl(0.07, 0.07, 2.7, 0x6b4a2b), sx, 1.35, sz));
  for (let i = 0; i < 7; i++) { const s = box(0.58, 0.08, 1.9, i % 2 ? c1 : c2, -1.74 + i * 0.58, 2.72, 0); s.rotation.x = 0.12; g.add(s); }
  for (let i = 0; i < 7; i++) { const f = at(cone(0.29, 0.3, i % 2 ? c1 : c2, 3), -1.74 + i * 0.58, 2.5, 0.98); f.rotation.x = Math.PI; g.add(f); }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), new THREE.MeshBasicMaterial({ map: signTexture(text, '#' + new THREE.Color(c1).getHexString()) }));
  sign.position.set(0, 3.25, 0.2); sign.rotation.x = -0.25; g.add(sign);
  return g;
}
function makeWall(def, idx, stone) {
  const [ax, az, bx, bz] = def.seg, len = Math.hypot(bx - ax, bz - az);
  const g = new THREE.Group();
  if (!stone) {
    const n = Math.floor(len / 0.62);
    for (let i = 0; i < n; i++) {
      const h = 2 + hash(i, idx) * 0.4, x = -len / 2 + (i + 0.5) * len / n;
      g.add(at(cyl(0.3, 0.32, h, i % 2 ? 0x8b5a2b : 0x9a6a38, 6), x, h / 2, 0));
      g.add(at(cone(0.3, 0.5, 0xa87840, 6), x, h + 0.25, 0));
    }
    g.add(box(len, 0.22, 0.2, 0x6b4020, 0, 0.8, 0.33));
    g.add(box(len, 0.22, 0.2, 0x6b4020, 0, 1.6, 0.33));
  } else {
    g.add(box(len, 2.6, 1.1, 0x9aa0a6, 0, 1.3, 0));
    g.add(box(len + 0.1, 0.4, 1.3, 0x80868c, 0, 0.2, 0));
    const n = Math.floor(len / 1.2);
    for (let i = 0; i < n; i++) g.add(box(0.7, 0.55, 1.1, 0xa9afb5, -len / 2 + (i + 0.5) * len / n, 2.85, 0));
    for (let i = 0; i < n * 2; i++) g.add(box(0.9, 0.05, 0.02, 0x7d8388, -len / 2 + hash(i, idx) * len, 0.5 + hash(idx, i) * 1.8, 0.56));
  }
  if (idx === 2) g.add(box(3.2, 2, 1.2, stone ? 0x4a3020 : 0x5a3a1c, 0, 1, 0));
  g.position.set((ax + bx) / 2, 0, (az + bz) / 2);
  g.rotation.y = -Math.atan2(bz - az, bx - ax);
  return g;
}
function makeTower(stone) {
  const g = new THREE.Group();
  if (!stone) {
    for (const sx of [-0.9, 0.9]) for (const sz of [-0.9, 0.9]) g.add(at(cyl(0.14, 0.18, 4.2, 0x7a5230), sx, 2.1, sz));
    for (const y of [1.3, 2.8]) { g.add(box(1.9, 0.12, 0.12, 0x6b4a2b, 0, y, 0.9)); g.add(box(1.9, 0.12, 0.12, 0x6b4a2b, 0, y, -0.9)); }
    g.add(box(2.6, 0.3, 2.6, 0xa0703c, 0, 4.2, 0));
    for (const [x, z, w, d] of [[0, 1.25, 2.6, 0.1], [0, -1.25, 2.6, 0.1], [1.25, 0, 0.1, 2.6], [-1.25, 0, 0.1, 2.6]]) g.add(box(w, 0.6, d, 0x8b5a2b, x, 4.6, z));
    for (const sx of [-1.2, 1.2]) for (const sz of [-1.2, 1.2]) g.add(at(cyl(0.07, 0.07, 1.5, 0x7a5230), sx, 5.1, sz));
    const roof = at(cone(2.1, 1.4, 0x2c6fbb, 4), 0, 6.5, 0); roof.rotation.y = Math.PI / 4; g.add(roof);
  } else {
    g.add(at(cyl(1.3, 1.6, 5, 0x9aa0a6, 10), 0, 2.5, 0));
    g.add(at(cyl(1.7, 1.7, 0.5, 0xa9afb5, 10), 0, 5.2, 0));
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; g.add(box(0.5, 0.5, 0.5, 0xa9afb5, Math.cos(a) * 1.5, 5.7, Math.sin(a) * 1.5)); }
    g.add(at(cone(1.6, 2, 0x8e2b2b, 10), 0, 7.4, 0));
    g.add(box(0.6, 0.9, 0.05, 0x2a2a35, 0, 2.6, 1.45));
    g.add(at(cyl(0.05, 0.05, 1.4), 0, 9, 0)); g.add(box(0.8, 0.45, 0.04, 0xffd54a, 0.4, 9.4, 0));
  }
  const archer = makePerson({ body: 0x2c6fbb, hat: 0x2c6fbb, bowOut: true });
  archer.g.scale.setScalar(0.7); archer.g.position.y = stone ? 5.45 : 4.35; g.add(archer.g);
  return g;
}
function makeCannon() {
  const g = new THREE.Group();
  g.add(at(cyl(1.4, 1.6, 1.2, 0x9aa0a6, 10), 0, 0.6, 0));
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; g.add(box(0.45, 0.4, 0.45, 0xa9afb5, Math.cos(a) * 1.3, 1.4, Math.sin(a) * 1.3)); }
  const turret = new THREE.Group(); turret.position.y = 1.5;
  turret.add(box(1.1, 0.5, 1.1, 0x6b4a2b, 0, 0.1, 0));
  for (const sx of [-0.6, 0.6]) { const w = at(cyl(0.35, 0.35, 0.12, 0x4a3020, 10), sx, 0.1, 0); w.rotation.z = Math.PI / 2; turret.add(w); }
  const barrel = at(cyl(0.22, 0.3, 1.8, 0x2a2a30, 10), 0, 0.55, 0.4); barrel.rotation.x = Math.PI / 2 - 0.35; turret.add(barrel);
  g.add(turret); g.userData.turret = turret; g.userData.recoil = 0;
  for (let i = 0; i < 4; i++) g.add(at(ball(0.2, 0x222222, 0), 0.9 + (i % 2) * 0.35, 0.2 + Math.floor(i / 2) * 0.3, 1.3));
  return g;
}
function makeHut(roof) {
  const g = new THREE.Group();
  g.add(box(2.4, 0.2, 2.2, 0x8f877a, 0, 0.1, 0));
  g.add(box(2.2, 1.6, 2, 0xe0c090, 0, 1, 0));
  const r = at(cone(1.9, 1.3, roof, 4), 0, 2.45, 0); r.rotation.y = Math.PI / 4; g.add(r);
  g.add(box(0.7, 1.1, 0.08, 0x5a3a1c, 0, 0.75, 1.02));
  g.add(box(0.45, 0.45, 0.06, glow(0xffd27a), 0.7, 1.2, 1.02));
  return g;
}

scene.add(makeCore());
{ const bin = new THREE.Group(); bin.add(at(cyl(0.4, 0.33, 0.9, 0x4f7a55, 10), 0, 0.45, 0)); bin.add(at(cyl(0.45, 0.45, 0.1, 0x3d6343, 10), 0, 0.95, 0)); bin.position.set(-6, 0, 1.6); scene.add(bin); }

const buildings = S.PLOTS.map((def, i) => {
  const place = (g, x = def.x, z = def.z) => { g.position.set(x, 0, z); g.visible = false; scene.add(g); return g; };
  if (def.id === 'grill') return { lv: [null, place(makeGrill())] };
  if (def.id === 'saw') return { lv: [null, place(makeSaw())] };
  if (def.id === 'meat') return { lv: [null, place(makeShop(0xe74c3c, 0xffffff, 'ร้านสเต็ก'))] };
  if (def.id === 'wood') return { lv: [null, place(makeShop(0x2e9e4f, 0xffffff, 'ร้านขายไม้'))] };
  if (def.kind === 'wall') {
    const a = makeWall(def, i - S.PI.w0, false), b = makeWall(def, i - S.PI.w0, true);
    a.visible = b.visible = false; scene.add(a, b); return { lv: [null, a, b] };
  }
  if (def.kind === 'tower') return { lv: [null, place(makeTower(false)), place(makeTower(true))] };
  if (def.kind === 'cannon') return { lv: [null, place(makeCannon())] };
  if (def.kind === 'hire') {
    const g = makeHut({ lumber: 0xc0392b, hunter: 0x2e7d32, runner: 0x2c6fbb, cashier: 0xf1c40f }[def.worker]);
    return { lv: [null, place(g, def.x + Math.sign(def.x) * 2.9, def.z)], hut: true };
  }
  return null;
});
function showBuilding(i, level) {
  const b = buildings[i]; if (!b) return;
  const vis = b.hut ? Math.min(level, 1) : level;
  b.lv.forEach((g, k) => { if (g) g.visible = k === vis; });
}

// ---- solid footprints the local player can't walk through
function solids(L) {
  const out = [{ c: [S.CORE.x, S.CORE.z, S.CORE.r + 0.3] }];
  out.push({ b: [-11.8, -8.2, -6.6, -3.4] }, { b: [8.3, 11.7, -6.4, -3.6] }, { b: [5.1, 8.9, 7.9, 9.3] }, { c: [-6, 1.6, 0.5] });
  if (L[S.PI.wood]) out.push({ b: [-8.9, -5.1, 7.9, 9.3] });
  S.PLOTS.forEach((def, i) => {
    if (!L[i]) return;
    if (def.kind === 'tower') out.push({ c: [def.x, def.z, L[i] > 1 ? 1.7 : 1.3] });
    else if (def.kind === 'cannon') out.push({ c: [def.x, def.z, 1.6] });
    else if (def.kind === 'hire') out.push({ b: [def.x + Math.sign(def.x) * 2.9 - 1.2, def.x + Math.sign(def.x) * 2.9 + 1.2, def.z - 1.1, def.z + 1.1] });
  });
  for (const p of S.PONDS) out.push({ c: [p.x, p.z, p.r - 0.3] });
  for (const r of rocks) if (r.stone > 0) out.push({ c: [r.x, r.z, 0.9 * r.s] });
  return out;
}
function collide(x, z, L) {
  const R = 0.4;
  for (const s of solids(L)) {
    if (s.c) {
      const [cx, cz, cr] = s.c, dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
      if (d < cr + R && d > 1e-4) { x = cx + dx / d * (cr + R); z = cz + dz / d * (cr + R); }
    } else {
      const [x0, x1, z0, z1] = s.b, px = clamp(x, x0, x1), pz = clamp(z, z0, z1), dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
      if (d < R) {
        if (d > 1e-4) { x = px + dx / d * R; z = pz + dz / d * R; }
        else { const l = x - x0, r = x1 - x, t = z - z0, b = z1 - z, m = Math.min(l, r, t, b); if (m === l) x = x0 - R; else if (m === r) x = x1 + R; else if (m === t) z = z0 - R; else z = z1 + R; }
      }
    }
  }
  return [x, z];
}

// ---- items
const ITEM_H = { L: 0.34, P: 0.13, M: 0.27, S: 0.23, R: 0.3, $: 0.08 };
function itemMesh(k) {
  let m;
  if (k === 'L') {
    m = new THREE.Group();
    m.add(mesh(geo('logG', () => new THREE.CylinderGeometry(0.17, 0.17, 0.8, 7).rotateZ(Math.PI / 2)), 0x8b5a2b));
    m.add(mesh(geo('logEnds', () => new THREE.CylinderGeometry(0.145, 0.145, 0.81, 7).rotateZ(Math.PI / 2)), 0xe0b070));
  } else if (k === 'P') m = box(0.8, 0.12, 0.4, 0xe8c07a);
  else if (k === 'M') { m = new THREE.Group(); m.add(box(0.5, 0.26, 0.4, 0xe05a5a)); m.add(box(0.12, 0.27, 0.41, 0xfff0e8, 0.12, 0, 0)); }
  else if (k === 'S') { m = new THREE.Group(); m.add(box(0.5, 0.22, 0.4, 0x8a4a1c)); m.add(box(0.52, 0.04, 0.1, 0x3a1a08, 0, 0.1, 0)); m.add(box(0.52, 0.04, 0.1, 0x3a1a08, 0, 0.1, -0.13)); }
  else if (k === 'R') m = mesh(geo('stoneG', () => new THREE.DodecahedronGeometry(0.2, 0)), 0x9aa0a6);
  else m = mesh(geo('coinG', () => new THREE.CylinderGeometry(0.2, 0.2, 0.07, 12)), glow(0xffcc33, 1.3));
  m.traverse(o => { o.castShadow = false; });
  return m;
}
function setStack(grp, str) {
  if (grp.userData.key === str) return;
  const prevLen = (grp.userData.key || '').length;
  grp.userData.key = str;
  while (grp.children.length) grp.remove(grp.children[0]);
  let y = 0;
  for (let i = 0; i < Math.min(str.length, 30); i++) {
    const k = str[i], m = itemMesh(k);
    m.position.y = y + ITEM_H[k] / 2; y += ITEM_H[k];
    if (i >= prevLen) { m.scale.setScalar(1.6); m.userData.pop = true; }
    grp.add(m);
  }
}
class Pile {
  constructor(kind, x, y, z, cols, rows, max) {
    this.g = new THREE.Group(); this.g.position.set(x, y, z); this.items = [];
    const dx = kind === 'L' || kind === 'P' ? 0.85 : kind === '$' ? 0.45 : 0.55, dz = 0.45;
    for (let i = 0; i < max; i++) {
      const layer = Math.floor(i / (cols * rows)), j = i % (cols * rows);
      const m = itemMesh(kind);
      m.position.set(((j % cols) - (cols - 1) / 2) * dx, layer * ITEM_H[kind] + ITEM_H[kind] / 2, (Math.floor(j / cols) - (rows - 1) / 2) * dz);
      m.visible = false; this.g.add(m); this.items.push(m);
    }
    scene.add(this.g);
  }
  set(n) { this.items.forEach((m, i) => { m.visible = i < n; }); }
}
// index matches server stock array S: [sawIn, sawOut, grillIn, grillOut, meat, wood, cashM, cashW]
const PILES = [
  { pile: new Pile('L', -13.8, 0, -3.3, 2, 2, 24), plot: 'saw' },
  { pile: new Pile('P', -6.2, 0, -3.3, 2, 2, 32), plot: 'saw' },
  { pile: new Pile('M', 6.2, 0, -3.3, 2, 2, 28), plot: 'grill' },
  { pile: new Pile('S', 13.8, 0, -3.3, 2, 2, 28), plot: 'grill' },
  { pile: new Pile('S', 7, 1.17, 8.6, 6, 2, 36), plot: 'meat' },
  { pile: new Pile('P', -7, 1.17, 8.6, 4, 2, 32), plot: 'wood' },
  { pile: new Pile('$', 10.4, 0.05, 7.4, 3, 3, 45), plot: 'meat', coin: true },
  { pile: new Pile('$', -10.4, 0.05, 7.4, 3, 3, 45), plot: 'wood', coin: true },
];

// ---- pads
const PADK = {
  sawIn: { icon: '🪵', col: '#4aa3ff', tip: 'ใส่ 🪵 ไม้ซุงเข้าโรงเลื่อย' },
  sawOut: { icon: '🪚', col: '#5fd068', tip: 'รับ 🪚 ไม้แผ่นที่เลื่อยเสร็จ' },
  grillIn: { icon: '🥩', col: '#4aa3ff', tip: 'ใส่ 🥩 เนื้อดิบลงเตาย่าง' },
  grillOut: { icon: '🍖', col: '#5fd068', tip: 'รับ 🍖 สเต็กที่ย่างเสร็จ' },
  meatShop: { icon: '🍖', col: '#ff9f1c', tip: 'วาง 🍖 สเต็กขายให้ชาวบ้าน' },
  woodShop: { icon: '🪚', col: '#ff9f1c', tip: 'วาง 🪚 ไม้แผ่นขายให้ชาวบ้าน' },
  cashM: { icon: '💰', col: '#ffd54a', tip: 'เก็บเงินจากร้านสเต็ก' },
  cashW: { icon: '💰', col: '#ffd54a', tip: 'เก็บเงินจากร้านขายไม้' },
  repair: { icon: '🔧', col: '#c07cff', tip: 'ใช้ 🪚 ไม้แผ่นซ่อมศาลากลาง (+40 ต่อแผ่น)' },
  trash: { icon: '🗑️', col: '#ff5a5a', tip: '🗑️ ยืนนิ่งเพื่อทิ้งของ (ทิ้งทีละชิ้นจากบนสุด)' },
  plot: { icon: '🔨', col: '#ffffff' },
};
const padTex = new Map();
function padTexture(k) {
  if (padTex.has(k)) return padTex.get(k);
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), info = PADK[k];
  x.fillStyle = k === 'plot' ? '#ffffff30' : info.col + '66';
  x.strokeStyle = k === 'plot' ? '#ffffffee' : '#ffffffdd';
  x.lineWidth = 8;
  if (k === 'plot') x.setLineDash([14, 9]);
  x.beginPath(); x.roundRect(6, 6, 116, 116, 22); x.fill(); x.stroke();
  x.setLineDash([]);
  x.font = '58px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(info.icon, 64, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  padTex.set(k, t); return t;
}
const padGroup = new THREE.Group(); scene.add(padGroup);
const PAD_GEO = new THREE.PlaneGeometry(3.3, 3.3).rotateX(-Math.PI / 2);
const FILL_GEO = new THREE.PlaneGeometry(2.9, 2.9).rotateX(-Math.PI / 2).translate(0, 0, -1.45);
const fillMat = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.45, depthWrite: false });
let pads = [], levelsKey = '';
function rebuildPads(L) {
  while (padGroup.children.length) padGroup.remove(padGroup.children[0]);
  pads = S.getPads(L);
  for (const p of pads) {
    const m = new THREE.Mesh(PAD_GEO, new THREE.MeshBasicMaterial({ map: padTexture(p.k), transparent: true, depthWrite: false }));
    m.position.set(p.x, 0.06, p.z); m.renderOrder = 1; padGroup.add(m); p.mesh = m;
    if (p.k === 'plot') {
      const f = new THREE.Mesh(FILL_GEO, fillMat); f.position.set(p.x, 0.055, p.z + 1.45); f.scale.z = 0.001; padGroup.add(f); p.fill = f;
    }
  }
}

// ---- trees & rocks
const trees = [], rocks = [];
const natureGroup = new THREE.Group(); scene.add(natureGroup);
const leafMat = [0x4fb866, 0x62c872, 0x76d27c, 0x8edc86, 0x45a85e, 0xffb3cc, 0xffd0dd].map(c => windMaterial({ color: c }));
function buildNature(treeList, rockList) {
  while (natureGroup.children.length) natureGroup.remove(natureGroup.children[0]);
  trees.length = 0; rocks.length = 0;
  treeList.forEach(([x, z, s], i) => {
    const g = new THREE.Group(), pivot = new THREE.Group(), top = new THREE.Group();
    pivot.add(at(cyl(0.2, 0.3, 1.7, 0xb07a50, 8), 0, 0.85, 0));
    const v = i % 9 === 4 ? 2 : i % 3 === 0 ? 1 : 0;
    if (v === 0) { // round, puffy tree
      top.add(mesh(geo('tb1', () => new THREE.IcosahedronGeometry(1.35, 2)), leafMat[2], 0, 2.75, 0));
      top.add(mesh(geo('tb2', () => new THREE.IcosahedronGeometry(0.85, 2)), leafMat[3], 0.75, 3.3, 0.25));
      top.add(mesh(geo('tb3', () => new THREE.IcosahedronGeometry(0.75, 2)), leafMat[1], -0.7, 3.0, -0.2));
    } else if (v === 1) { // soft pine
      top.add(mesh(geo('tp1', () => new THREE.ConeGeometry(1.3, 1.9, 10)), leafMat[4], 0, 2.2, 0));
      top.add(mesh(geo('tp2', () => new THREE.ConeGeometry(1.0, 1.6, 10)), leafMat[0], 0, 3.1, 0));
      top.add(mesh(geo('tp3', () => new THREE.ConeGeometry(0.68, 1.3, 10)), leafMat[1], 0, 3.9, 0));
    } else { // blossom
      top.add(mesh(geo('tb1', () => new THREE.IcosahedronGeometry(1.35, 2)), leafMat[5], 0, 2.75, 0));
      top.add(mesh(geo('tb2', () => new THREE.IcosahedronGeometry(0.85, 2)), leafMat[6], 0.75, 3.3, 0.25));
      top.add(mesh(geo('tb3', () => new THREE.IcosahedronGeometry(0.75, 2)), leafMat[6], -0.7, 3.0, -0.2));
    }
    pivot.add(top);
    const stump = at(cyl(0.3, 0.36, 0.4, 0xb07a50, 8), 0, 0.2, 0); stump.visible = false;
    stump.add(at(cyl(0.29, 0.29, 0.02, 0xf2d3a0, 8), 0, 0.21, 0));
    g.add(pivot, stump);
    g.position.set(x, 0, z); g.scale.setScalar(s); g.rotation.y = i * 1.7;
    natureGroup.add(g);
    trees.push({ g, pivot, top, stump, x, z, s, wood: 4, shake: 0, fall: 0, fallDir: 1 });
  });
  rockList.forEach(([x, z, s], i) => {
    const g = new THREE.Group(), body = new THREE.Group();
    const cols = [0xc3cad6, 0xd2d8e2, 0xb4bccb];
    for (let k = 0; k < 3; k++) {
      const m = mesh(geo('rk' + k, () => {
        const gg = new THREE.DodecahedronGeometry(0.8 - k * 0.18, 0), p = gg.attributes.position;
        for (let j = 0; j < p.count; j++) p.setXYZ(j, p.getX(j) * 1.1, p.getY(j) * 0.8, p.getZ(j));
        gg.computeVertexNormals(); return gg;
      }), cols[k]);
      m.position.set(k === 0 ? 0 : (k === 1 ? 0.7 : -0.6), (0.6 - k * 0.15) * 0.8, k === 2 ? 0.4 : (k === 1 ? -0.2 : 0));
      m.rotation.set(hash(i, k) * 3, hash(k, i) * 3, 0);
      body.add(m);
    }
    body.add(at(box(0.5, 0.08, 0.4, 0x8fd16a), 0.1, 1.05, 0.1));
    const rubble = new THREE.Group(); rubble.visible = false;
    for (let k = 0; k < 4; k++) rubble.add(at(ball(0.15, 0xc3cad6, 0), (hash(k, i) - 0.5) * 1.2, 0.08, (hash(i, k) - 0.5) * 1.2));
    g.add(body, rubble);
    g.position.set(x, 0, z); g.scale.setScalar(s); g.rotation.y = i * 2.3;
    natureGroup.add(g);
    rocks.push({ g, body, rubble, x, z, s, stone: 6, shake: 0 });
  });
}
function setTreeWood(t, w) {
  if (t.wood === w) return;
  if (w > 0 && t.wood === 0) { t.pivot.visible = true; t.pivot.rotation.set(0, 0, 0); t.stump.visible = false; t.top.scale.setScalar(0.15); t.grow = true; t.fall = 0; }
  if (w === 0 && t.wood > 0) { t.fall = 0.001; t.fallDir = Math.random() < 0.5 ? 1 : -1; t.stump.visible = true; }
  t.wood = w;
}
function setRockStone(r, n) {
  if (r.stone === n) return;
  if (n === 0) puff(r.x, 0.8, r.z, 0x9aa0a6, 14, 4);
  r.stone = n;
  r.body.visible = n > 0; r.rubble.visible = n === 0;
  r.body.scale.setScalar(0.55 + 0.45 * n / 6);
}

// =============================================================== Characters
function limb(w, h, d, c, x, y) { const pv = new THREE.Group(); pv.position.set(x, y, 0); pv.add(box(w, h, d, c, 0, -h / 2, 0)); return pv; }
function makeTools() {
  const axe = new THREE.Group();
  axe.add(cyl(0.035, 0.035, 0.75, 0x6b4a2b, 5));
  axe.add(box(0.05, 0.22, 0.28, 0xd0d4d8, 0, 0.28, 0.12));
  const pick = new THREE.Group();
  pick.add(cyl(0.035, 0.035, 0.75, 0x6b4a2b, 5));
  pick.add(box(0.05, 0.08, 0.6, 0x9aa0a6, 0, 0.33, 0));
  const bow = new THREE.Mesh(geo('bowG', () => new THREE.TorusGeometry(0.38, 0.03, 4, 12, Math.PI)), mat(0x6b4a2b));
  bow.rotation.y = Math.PI / 2;
  for (const t of [axe, pick, bow]) { t.visible = false; t.traverse(o => { o.castShadow = false; }); }
  return { axe, pick, bow };
}
function makePerson(o) {
  const g = new THREE.Group(), body = new THREE.Group();
  const skin = o.skin ?? 0xf2c9a0, legs = o.legs ?? 0x3b3b55;
  const legL = limb(0.2, 0.5, 0.24, legs, -0.13, 0.52), legR = limb(0.2, 0.5, 0.24, legs, 0.13, 0.52);
  const armL = limb(0.15, 0.5, 0.17, o.body, -0.38, 1.15), armR = limb(0.15, 0.5, 0.17, o.body, 0.38, 1.15);
  body.add(box(0.58, 0.62, 0.38, o.body, 0, 0.84, 0));
  body.add(box(0.6, 0.08, 0.4, 0x3a2a1a, 0, 0.56, 0));
  const head = new THREE.Group(); head.position.set(0, 1.5, 0);
  head.add(ball(0.34, skin, 1));
  if (o.eyes != null) { head.add(box(0.09, 0.09, 0.04, glow(o.eyes, 2), -0.12, 0.04, 0.32)); head.add(box(0.09, 0.09, 0.04, glow(o.eyes, 2), 0.12, 0.04, 0.32)); }
  else { head.add(box(0.07, 0.1, 0.03, 0x1a1a22, -0.12, 0.03, 0.325)); head.add(box(0.07, 0.1, 0.03, 0x1a1a22, 0.12, 0.03, 0.325)); head.add(box(0.1, 0.03, 0.03, 0xd08070, 0, -0.12, 0.32)); }
  if (o.hair != null) { const h = ball(0.36, o.hair, 1); h.scale.set(1, 0.6, 1); h.position.set(0, 0.14, -0.04); head.add(h); }
  if (o.hat != null) { head.add(at(cyl(0.44, 0.44, 0.05, o.hat, 10), 0, 0.22, 0)); head.add(at(cyl(0.26, 0.3, 0.26, o.hat, 10), 0, 0.36, 0)); }
  if (o.crown) head.add(at(cyl(0.2, 0.24, 0.2, glow(0xffcc33, 1.3), 6), 0, 0.4, 0));
  if (o.ears) for (const sx of [-1, 1]) { const e = at(cone(0.09, 0.4, skin, 4), sx * 0.36, 0.05, 0); e.rotation.z = -sx * 1.2; head.add(e); }
  if (o.horns) for (const sx of [-1, 1]) { const e = at(cone(0.08, 0.38, 0xf5f0e0, 5), sx * 0.2, 0.36, 0); e.rotation.z = -sx * 0.4; head.add(e); }
  body.add(head);
  g.add(legL, legR, armL, armR, body);
  const tools = makeTools();
  tools.axe.position.set(0, -0.5, 0.15); tools.axe.rotation.x = Math.PI / 2; armR.add(tools.axe);
  tools.pick.position.set(0, -0.5, 0.15); tools.pick.rotation.x = Math.PI / 2; armR.add(tools.pick);
  tools.bow.position.set(0, -0.5, 0.1); armL.add(tools.bow);
  if (o.bowOut) tools.bow.visible = true;
  if (o.club) { const c = at(cyl(0.06, 0.13, 0.75, 0x6b4a2b, 5), 0, -0.6, 0.15); c.rotation.x = 1.2; armR.add(c); }
  const stack = new THREE.Group(); stack.position.set(0, 0.7, -0.4); body.add(stack);
  return { g, body, head, legL, legR, armL, armR, stack, tools, walk: 0, swing: 0, shoot: 0, toolT: 0, slam: 0 };
}
function makeQuad(o) {
  const g = new THREE.Group(), s = o.size, body = new THREE.Group();
  const legs = [];
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const l = limb(0.18 * s, 0.45 * s, 0.18 * s, o.leg, x * 0.3 * s, 0.45 * s); l.position.z = z * 0.5 * s; legs.push(l); g.add(l);
  }
  body.add(box(0.8 * s, 0.6 * s, 1.4 * s, o.body, 0, 0.7 * s, 0));
  body.add(box(0.55 * s, 0.5 * s, 0.55 * s, o.head ?? o.body, 0, 0.8 * s, 0.9 * s));
  if (o.snout) body.add(box(0.3 * s, 0.25 * s, 0.2 * s, o.snout, 0, 0.72 * s, 1.25 * s));
  if (o.tusks) for (const sx of [-1, 1]) body.add(box(0.06 * s, 0.2 * s, 0.06 * s, 0xfff8e0, sx * 0.18 * s, 0.68 * s, 1.22 * s));
  if (o.ears) for (const sx of [-1, 1]) body.add(at(cone(0.1 * s, 0.3 * s, o.body, 4), sx * 0.2 * s, 1.15 * s, 0.85 * s));
  if (o.eyes != null) for (const sx of [-1, 1]) body.add(box(0.09 * s, 0.09 * s, 0.04 * s, glow(o.eyes, 2.5), sx * 0.15 * s, 0.9 * s, 1.18 * s));
  else for (const sx of [-1, 1]) body.add(box(0.07 * s, 0.07 * s, 0.03 * s, 0x111111, sx * 0.15 * s, 0.92 * s, 1.18 * s));
  if (o.tail) body.add(box(0.12 * s, 0.12 * s, 0.6 * s, o.body, 0, 0.9 * s, -0.9 * s));
  if (o.mane) body.add(box(0.85 * s, 0.3 * s, 0.6 * s, o.mane, 0, 1.05 * s, 0.35 * s));
  g.add(body);
  return { g, body, legs, walk: 0 };
}
const MON_MAKERS = {
  goblin: () => { const p = makePerson({ body: 0x6b4a2b, skin: 0x6abf3a, legs: 0x4a3520, eyes: 0xffee33, ears: true, club: true }); p.g.scale.setScalar(0.85); return p; },
  wolf: () => makeQuad({ size: 1.1, body: 0x3f4550, leg: 0x2e333b, eyes: 0xff3030, ears: true, tail: true, mane: 0x2a2e36 }),
  ogre: () => { const p = makePerson({ body: 0x5a3d7a, skin: 0x9a7ac0, legs: 0x3a2850, eyes: 0xff5020, club: true, horns: true }); p.g.scale.setScalar(1.8); return p; },
  boss: () => { const p = makePerson({ body: 0x5a0e0e, skin: 0xa82a2a, legs: 0x2a0606, eyes: 0xffee00, horns: true, club: true, crown: true }); p.g.scale.setScalar(3.2); return p; },
};
const VIL_COLORS = [0xe57373, 0x64b5f6, 0x81c784, 0xffb74d, 0xba68c8, 0x4dd0e1, 0xf06292, 0xaed581];
const HAIR = [0x3b2a1a, 0x1a1a1a, 0xc8a060, 0x8a3a1a, 0x6a4a2a];
const WORKER = {
  lumber: { hat: 0xc0392b, body: 0x8e3b2e, icon: '🪓' },
  hunter: { hat: 0x2e7d32, body: 0x3f6b3a, icon: '🏹' },
  runner: { hat: 0x2c6fbb, body: 0x2f5c8f, icon: '📦' },
  cashier: { hat: 0xf1c40f, body: 0xb8860b, icon: '💵' },
};
function useTool(e, name, t) {
  if (!e.tools) return;
  e.tools.axe.visible = name === 'axe'; e.tools.pick.visible = name === 'pick'; e.tools.bow.visible = name === 'bow';
  e.toolT = t;
}
function animPerson(e, dt, speed) {
  if (!e.legL) {
    if (e.legs) { e.walk += dt * speed * 3; const s = Math.sin(e.walk) * Math.min(1, speed) * 0.7; e.legs[0].rotation.x = s; e.legs[3].rotation.x = s; e.legs[1].rotation.x = -s; e.legs[2].rotation.x = -s; e.body.position.y = Math.abs(Math.sin(e.walk)) * 0.05 * Math.min(1, speed); }
    return;
  }
  e.walk += dt * speed * 2.2;
  const m = Math.min(1, speed / 3), s = Math.sin(e.walk) * m * 0.8;
  e.legL.rotation.x = s; e.legR.rotation.x = -s;
  e.armL.rotation.x = -s * 0.8; e.armR.rotation.x = s * 0.8;
  e.body.position.y = Math.abs(Math.cos(e.walk)) * 0.06 * m;
  e.stack.rotation.x = lerp(e.stack.rotation.x, -m * 0.12 + Math.sin(e.walk * 2) * 0.03 * m, Math.min(1, dt * 8));
  if (e.swing > 0) { e.swing -= dt; e.armR.rotation.x = -2.4 + Math.sin(e.swing * 22) * 1.0; }
  if (e.shoot > 0) { e.shoot -= dt; e.armL.rotation.x = -1.55; e.armR.rotation.x = -1.35; }
  if (e.toolT > 0) { e.toolT -= dt; if (e.toolT <= 0) useTool(e, null, 0); }
  if (e.slam > 0) { e.slam -= dt; e.g.position.y = Math.max(0, Math.sin((0.4 - e.slam) / 0.4 * Math.PI)) * 1.2; if (e.slam <= 0) e.g.position.y = 0; }
  for (const c of e.stack.children) if (c.userData.pop) { const k = Math.max(1, c.scale.x - dt * 6); c.scale.setScalar(k); if (k === 1) c.userData.pop = false; }
}

const RING_GEO = new THREE.RingGeometry(0.55, 0.72, 24).rotateX(-Math.PI / 2);

// ---- "stand still" charge ring under the local player
const chargeU = { uProg: { value: 0 } };
const charge = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.1, 48).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
  uniforms: chargeU, transparent: true, depthWrite: false,
  vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform float uProg; varying vec3 vP;
    void main(){ float a = atan(vP.x, vP.z) / 6.28318 + 0.5;
      if (a > uProg) { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.3); return; }
      gl_FragColor = vec4(1.0, 0.85, 0.3, 0.95); }`,
}));
charge.visible = false; charge.renderOrder = 2; scene.add(charge);

// =============================================================== Entity sync
const ents = { P: new Map(), A: new Map(), M: new Map(), V: new Map(), W: new Map() };
function syncSet(map, list, create, apply) {
  const seen = new Set();
  for (const d of list) {
    const id = d[0]; seen.add(id);
    let e = map.get(id);
    if (!e) { e = create(d); e.x = e.tx = d[e.xi]; e.z = e.tz = d[e.xi + 1]; e.r = e.tr = d[e.xi + 2]; map.set(id, e); scene.add(e.g); e.g.position.set(e.x, 0, e.z); }
    e.tx = d[e.xi]; e.tz = d[e.xi + 1]; e.tr = d[e.xi + 2];
    apply(e, d);
  }
  for (const [id, e] of map) if (!seen.has(id)) { scene.remove(e.g); map.delete(id); }
}

// ---- portals
const portalU = { uTime: { value: 0 } };
const portalMat = new THREE.ShaderMaterial({
  uniforms: portalU, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform float uTime; varying vec2 vUv;
    void main(){ vec2 p = vUv - 0.5; float r = length(p) * 2.0; float a = atan(p.y, p.x);
      float sw = sin(a * 5.0 + r * 12.0 - uTime * 4.0) * 0.5 + 0.5;
      vec3 c = mix(vec3(0.5, 0.1, 1.0), vec3(1.0, 0.4, 1.0), sw) * (1.6 - r) * 1.8;
      gl_FragColor = vec4(c, (1.0 - smoothstep(0.85, 1.0, r)) * 0.9); }`,
});
const portalGroup = new THREE.Group(); scene.add(portalGroup);
let portalKey = '';
function syncPortals(po) {
  const key = JSON.stringify(po || []);
  if (key === portalKey) return;
  portalKey = key;
  while (portalGroup.children.length) portalGroup.remove(portalGroup.children[0]);
  for (const [x, z] of po || []) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(geo('pdisc', () => new THREE.CircleGeometry(2.2, 32)), portalMat); disc.position.y = 2.6; g.add(disc);
    const ring = new THREE.Mesh(geo('pring', () => new THREE.TorusGeometry(2.3, 0.28, 8, 32)), glow(0xb05cff, 2.5)); ring.position.y = 2.6; g.add(ring);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; g.add(at(cone(0.35, 1.4, 0x3a2a4a, 5), Math.cos(a) * 3, 0.5, Math.sin(a) * 3)); }
    const base = new THREE.Mesh(geo('pbase', () => new THREE.CircleGeometry(3.4, 32).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color: 0x7a2aff, transparent: true, opacity: 0.35, depthWrite: false }));
    base.position.y = 0.07; g.add(base);
    g.position.set(x, 0, z); g.rotation.y = Math.atan2(-x, -z);
    g.userData.ring = ring; g.userData.disc = disc;
    portalGroup.add(g);
  }
}

// =============================================================== FX
const particles = [];
const PGEO = new THREE.BoxGeometry(0.16, 0.16, 0.16);
function puff(x, y, z, color, n = 10, spd = 3, material) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(PGEO, material || mat(color));
    m.position.set(x, y, z);
    scene.add(m);
    particles.push({ m, vx: (Math.random() - 0.5) * spd, vy: Math.random() * spd + 1, vz: (Math.random() - 0.5) * spd, life: 0.6 + Math.random() * 0.4 });
  }
}
const smokes = [];
function smoke(x, y, z, color = 0xdddddd, size = 1, life = 2) {
  if (smokes.length > 160) return;
  const m = new THREE.Mesh(geo('smokeG', () => new THREE.IcosahedronGeometry(0.3, 0)), new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false }));
  m.position.set(x, y, z); m.scale.setScalar(size); scene.add(m);
  smokes.push({ m, life, max: life, size });
}
const rings = [];
function shockwave(x, z, r, color = 0xfff0a0) {
  const m = new THREE.Mesh(geo('swave', () => new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 1, depthWrite: false }));
  m.position.set(x, 0.15, z); scene.add(m);
  rings.push({ m, t: 0, r });
}
const arrows = [];
const ARROW_GEO = new THREE.BoxGeometry(0.06, 0.06, 0.9);
function shootArrow(f, t) {
  const m = new THREE.Mesh(ARROW_GEO, glow(0xfff3c4, 1.5));
  const from = new THREE.Vector3(f[0], f[1], f[2]), to = new THREE.Vector3(t[0], 0.8, t[1]);
  m.position.copy(from); m.lookAt(to); scene.add(m);
  arrows.push({ m, from, to, t: 0, dur: Math.max(0.08, from.distanceTo(to) / 45), arc: 0.6 });
}
function cannonBall(f, t, dur) {
  const m = mesh(geo('cball', () => new THREE.IcosahedronGeometry(0.3, 1)), 0x1a1a1a);
  const from = new THREE.Vector3(f[0], f[1], f[2]), to = new THREE.Vector3(t[0], 0.3, t[1]);
  m.position.copy(from); scene.add(m);
  arrows.push({ m, from, to, t: 0, dur, arc: 6, ball: true });
  smoke(f[0], f[1] + 0.8, f[2], 0xcccccc, 1.4, 1);
  S.PLOTS.forEach((def, i) => {
    if (def.kind === 'cannon' && Math.abs(def.x - f[0]) < 0.3 && Math.abs(def.z - f[2]) < 0.3) {
      const g = buildings[i].lv[1]; g.userData.turret.rotation.y = Math.atan2(t[0] - def.x, t[1] - def.z); g.userData.recoil = 0.3;
    }
  });
}
const flyers = [];
function resolvePt(p) {
  if (Array.isArray(p)) return { x: p[0], y: 1, z: p[1] };
  if (p === myId) return { x: me.x, y: 1.5, z: me.z };
  const e = ents.P.get(p);
  return e ? { x: e.g.position.x, y: 1.5, z: e.g.position.z } : null;
}
function fly(kind, a, b) {
  const A = resolvePt(a); if (!A) return;
  const m = itemMesh(kind);
  m.position.set(A.x, A.y, A.z); scene.add(m);
  flyers.push({ m, a: A, b, t: 0, dur: 0.35 });
}
const floats = []; let floatId = 0;
function floatText(html, x, y, z, cls, life = 1) { floats.push({ key: 'ft' + floatId++, html, x, y, z, cls, t: 0, life }); }
let shake = 0;
function addShake(a, x, z) { const d = Math.hypot(x - me.x, z - me.z); shake = Math.max(shake, a * clamp(1 - d / 30, 0, 1)); }

const fireflies = (() => {
  const n = 90, p = new Float32Array(n * 3), seeds = [];
  for (let i = 0; i < n; i++) seeds.push([Math.random() * 60 - 30, Math.random() * 60 - 30, Math.random() * 6.28]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(0xd8ff70).multiplyScalar(3), size: 0.22, transparent: true, opacity: 0, depthWrite: false }));
  m.frustumCulled = false;
  scene.add(m); m.userData.seeds = seeds; return m;
})();

// ---- guide arrow
const guide = new THREE.Group();
{
  const arrowMat = glow(0xffd54a, 1.6);
  const a = new THREE.Mesh(geo('gcone', () => new THREE.ConeGeometry(0.5, 1, 4)), arrowMat); a.rotation.x = Math.PI; a.position.y = 3.2; guide.add(a);
  const s = new THREE.Mesh(geo('gshaft', () => new THREE.BoxGeometry(0.25, 0.8, 0.25)), arrowMat); s.position.y = 4.1; guide.add(s);
}
guide.visible = false; scene.add(guide);
const pointer = new THREE.Mesh(geo('gptr', () => { const sh = new THREE.Shape(); sh.moveTo(0, 0.7); sh.lineTo(0.45, 0); sh.lineTo(0.16, 0); sh.lineTo(0.16, -0.5); sh.lineTo(-0.16, -0.5); sh.lineTo(-0.16, 0); sh.lineTo(-0.45, 0); sh.closePath(); return new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2); }),
  new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
pointer.visible = false; pointer.renderOrder = 2; scene.add(pointer);

// =============================================================== Labels (DOM projected)
const labelRoot = $('labels'), labels = new Map(), _v = new THREE.Vector3();
let labelFrame = 0;
function label(key, html, x, y, z, cls, op) {
  let L = labels.get(key);
  if (!L) {
    const el = document.createElement('div'); el.className = 'lbl ' + (cls || '');
    labelRoot.appendChild(el); L = { el, html: null }; labels.set(key, L);
  }
  if (L.html !== html) { L.el.innerHTML = html; L.html = html; }
  L.x = x; L.y = y; L.z = z; L.f = labelFrame; L.op = op;
}
function flushLabels() {
  const w = innerWidth, h = innerHeight;
  for (const [k, L] of labels) {
    if (L.f !== labelFrame) { L.el.remove(); labels.delete(k); continue; }
    _v.set(L.x, L.y, L.z).project(camera);
    if (_v.z > 1 || Math.abs(_v.x) > 1.15 || Math.abs(_v.y) > 1.15) { L.el.style.display = 'none'; continue; }
    L.el.style.display = '';
    L.el.style.transform = `translate(${((_v.x * 0.5 + 0.5) * w).toFixed(1)}px,${((-_v.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%,-100%)`;
    L.el.style.opacity = L.op == null ? '' : L.op;
  }
  labelFrame++;
}
const hpBar = (pct, cls = '') => `<div class="hp ${pct < 35 ? 'bad' : ''} ${cls}"><i style="width:${pct}%"></i></div>`;

// =============================================================== Sound
let actx = null, sfxBus = null, musicBus = null;
const lastSnd = {};
const audioPref = { music: store.get('wt_music') !== '0', sfx: store.get('wt_sfx') !== '0' };
const MUSIC_VOL = 0.34;
// AudioContext needs a user gesture: start on the first click/key so the title screen already has music
function initAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume().catch(() => {}); return; }
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; return; }
  const master = actx.createGain(), comp = actx.createDynamicsCompressor();
  master.gain.value = 0.9; master.connect(comp).connect(actx.destination);
  sfxBus = actx.createGain(); sfxBus.gain.value = audioPref.sfx ? 1 : 0; sfxBus.connect(master);
  musicBus = actx.createGain(); musicBus.gain.value = 0; musicBus.connect(master);
  Music.start();
}
addEventListener('pointerdown', initAudio);
addEventListener('keydown', initAudio);
function beep(f, d = 0.08, type = 'square', v = 0.05, slide = 0, delay = 0) {
  if (!actx) return;
  const t0 = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, f + slide), t0 + d);
  g.gain.setValueAtTime(v, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  o.connect(g).connect(sfxBus); o.start(t0); o.stop(t0 + d + 0.02);
}
function noise(d = 0.3, v = 0.1, f = 800) {
  if (!actx) return;
  const n = Math.floor(actx.sampleRate * d), buf = actx.createBuffer(1, n, actx.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  const src = actx.createBufferSource(), g = actx.createGain(), fl = actx.createBiquadFilter();
  fl.type = 'lowpass'; fl.frequency.value = f; src.buffer = buf; g.gain.value = v;
  src.connect(fl).connect(g).connect(sfxBus); src.start();
}

// ---- background music: tiny step sequencer, fully synthesized (no audio files)
const _ = null;
const SONGS = {
  // bright & bouncy, C major: C Am F G
  day: {
    bpm: 108, swing: 0.1,
    chords: [[48, [60, 64, 67]], [45, [57, 60, 64]], [41, [57, 60, 65]], [43, [55, 59, 62]],
      [48, [60, 64, 67]], [45, [57, 60, 64]], [41, [57, 60, 65]], [43, [55, 59, 62]]],
    mel: [
      [76, 79, 84, 79, 76, _, 74, 76], [72, 76, 81, 76, 72, _, 71, 72], [69, 72, 77, 81, 79, 77, 76, 74], [71, 74, 79, _, 77, 76, 74, _],
      [76, 79, 84, 86, 88, 86, 84, 79], [81, 79, 76, 72, 76, 79, 81, _], [77, 81, 84, 81, 79, 77, 76, 74], [79, 77, 74, _, 71, _, _, _]],
    bass: [0, _, _, _, 7, _, _, _], stab: [2, 6], hat: [1, 3, 5, 7], kick: [0], snap: [4],
  },
  // tense but still cute, A minor: Am F Dm E
  night: {
    bpm: 92, swing: 0,
    chords: [[45, [57, 60, 64]], [41, [57, 60, 65]], [38, [57, 62, 65]], [40, [56, 59, 64]],
      [45, [57, 60, 64]], [41, [57, 60, 65]], [38, [57, 62, 65]], [40, [56, 59, 64]]],
    mel: [
      [69, _, 72, _, 76, _, 74, 72], [69, _, _, _, 65, _, 67, 69], [74, _, 77, _, 81, _, 79, 77], [76, _, _, 68, 71, _, 76, _],
      [81, _, 79, _, 76, _, 72, 74], [76, _, _, _, 72, _, 69, _], [74, 76, 77, _, 74, _, 69, _], [68, _, 71, _, 76, _, 75, _]],
    bass: [0, 0, 12, 0, 0, 12, 0, 7], stab: [], hat: [1, 3, 5, 7], kick: [0, 4], snap: [2, 6],
  },
};
const Music = (() => {
  let song = 'day', want = 'day', step = 0, loop = 0, nextT = 0, timer = null, echo = null, noiseBuf = null;
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  function voice(t, f, dur, type, vol, attack = 0.006, wet = 0) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(musicBus);
    if (wet) { const w = actx.createGain(); w.gain.value = wet; g.connect(w).connect(echo); }
    o.start(t); o.stop(t + dur + 0.05);
  }
  const pluck = (t, m, vol) => { voice(t, hz(m), 0.5, 'triangle', vol, 0.005, 0.5); voice(t, hz(m) * 2, 0.22, 'sine', vol * 0.35, 0.004, 0.5); };
  const bell = (t, m, vol) => { voice(t, hz(m), 0.9, 'sine', vol, 0.004, 0.7); voice(t, hz(m) * 3, 0.3, 'sine', vol * 0.18, 0.003, 0.4); };
  const bass = (t, m, len, vol) => voice(t, hz(m), len, 'triangle', vol, 0.01);
  const pad = (t, notes, len, vol) => { for (const m of notes) { voice(t, hz(m) * 0.998, len, 'sine', vol, 0.35); voice(t, hz(m) * 1.003, len, 'sine', vol * 0.6, 0.4); } };
  function hit(t, vol, freq, len, type) {
    const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
    src.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(musicBus); src.start(t, Math.random() * 0.5, len + 0.02);
  }
  function kick(t, vol) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.14);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(musicBus); o.start(t); o.stop(t + 0.2);
  }
  function playStep(S_, st, t, e8) {
    const bars = S_.chords.length, bi = Math.floor(st / 8) % bars, k = st % 8, [root, chord] = S_.chords[bi];
    const night = S_ === SONGS.night, sectionB = loop % 2 === 1;
    if (k === 0) pad(t, chord, e8 * 8.2, night ? 0.016 : 0.012);
    const b = S_.bass[k]; if (b != null) bass(t, root + b, night ? e8 * 0.9 : e8 * 3, night ? 0.1 : 0.12);
    if (S_.stab.includes(k)) for (const m of chord) voice(t, hz(m + 12), 0.14, 'triangle', 0.018, 0.004);
    if (S_.hat.includes(k)) hit(t, night ? 0.025 : 0.03, 7000, 0.035, 'highpass');
    if (S_.kick.includes(k)) kick(t, night ? 0.22 : 0.16);
    if (S_.snap.includes(k)) hit(t, night ? 0.05 : 0.04, 1800, 0.07, 'bandpass');
    const m = S_.mel[bi][k];
    if (!sectionB) { if (m != null) (night ? bell : pluck)(t, m, night ? 0.06 : 0.07); }
    else if (night) { if (m != null && k % 2 === 0) bell(t, m - 12, 0.05); }
    else { const arp = [0, 1, 2, 1]; bell(t, chord[arp[k % 4]] + 24, k % 2 ? 0.022 : 0.034); } // music-box arpeggio section
  }
  function tick() {
    if (!actx) return;
    const now = actx.currentTime;
    if (nextT < now - 0.25) nextT = now + 0.05; // tab was asleep: resync instead of bursting
    while (nextT < now + 0.15) {
      const S_ = SONGS[song], e8 = 60 / S_.bpm / 2;
      playStep(S_, step, nextT, e8);
      nextT += e8 * (1 + (step % 2 ? -S_.swing : S_.swing));
      step++;
      if (step % (8 * S_.chords.length) === 0) loop++;
      if (step % 8 === 0 && want !== song) { // change theme on a bar line with a soft dip
        song = want; step = 0; loop = 0;
        if (audioPref.music) { const g = musicBus.gain; g.cancelScheduledValues(nextT); g.setValueAtTime(MUSIC_VOL * 0.25, nextT); g.linearRampToValueAtTime(MUSIC_VOL, nextT + 2); }
      }
    }
  }
  return {
    start() {
      if (timer) return;
      noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
      const ch = noiseBuf.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      // soft echo gives the synth a warm, music-box room feel
      echo = actx.createGain();
      const dl = actx.createDelay(1), fb = actx.createGain(), lp = actx.createBiquadFilter(), wet = actx.createGain();
      dl.delayTime.value = 0.42; fb.gain.value = 0.28; lp.type = 'lowpass'; lp.frequency.value = 2400; wet.gain.value = 0.22;
      echo.connect(dl); dl.connect(lp).connect(fb).connect(dl); lp.connect(wet).connect(musicBus);
      song = want; nextT = actx.currentTime + 0.1;
      this.apply();
      timer = setInterval(tick, 40);
    },
    setTheme(t) { want = t; },
    apply() {
      if (!actx) return;
      const g = musicBus.gain, t = actx.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(audioPref.music ? MUSIC_VOL : 0, t + 0.8);
      sfxBus.gain.setValueAtTime(audioPref.sfx ? 1 : 0, t);
    },
  };
})();
function sfx(name) {
  const now = performance.now();
  if (now - (lastSnd[name] || 0) < 45) return;
  lastSnd[name] = now;
  switch (name) {
    case 'chop': beep(200, 0.07, 'square', 0.04, -90); break;
    case 'mine': beep(900, 0.05, 'square', 0.03, -300); beep(1400, 0.04, 'triangle', 0.02, 0, 0.02); break;
    case 'shoot': beep(700, 0.06, 'triangle', 0.03, -400); break;
    case 'coin': beep(988, 0.06, 'square', 0.025); beep(1319, 0.08, 'square', 0.025, 0, 0.05); break;
    case 'pick': beep(520 + Math.random() * 80, 0.04, 'sine', 0.04); break;
    case 'hurt': beep(160, 0.18, 'sawtooth', 0.06, -90); break;
    case 'kill': beep(300, 0.12, 'square', 0.04, -200); break;
    case 'boom': noise(0.5, 0.25, 500); beep(90, 0.3, 'sine', 0.12, -50); break;
    case 'slam': noise(0.4, 0.3, 350); beep(70, 0.35, 'sine', 0.15, -30); break;
    case 'tree': noise(0.35, 0.12, 1200); beep(120, 0.2, 'triangle', 0.06, -60, 0.1); break;
    case 'build': [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.12, 'square', 0.035, 0, i * 0.08)); break;
    case 'night': beep(220, 0.6, 'sawtooth', 0.04, -100); beep(165, 0.8, 'sawtooth', 0.04, -60, 0.3); break;
    case 'day': [392, 523, 659].forEach((f, i) => beep(f, 0.2, 'triangle', 0.05, 0, i * 0.12)); break;
    case 'win': [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => beep(f, i === 6 ? 0.6 : 0.16, 'triangle', 0.07, 0, i * 0.13)); break;
    case 'lose': [392, 370, 330, 262].forEach((f, i) => beep(f, i === 3 ? 0.8 : 0.3, 'triangle', 0.07, 0, i * 0.28)); break;
  }
}

// =============================================================== Input
const keys = new Set();
addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') { if (e.key === 'Enter') join(); return; }
  keys.add(e.code);
  if (joined) initAudio();
  if (e.code === 'Space') { e.preventDefault(); useSkill(); }
  if (e.code === 'KeyM') toggleMusic();
  const em = { Digit1: '👋', Digit2: '❤️', Digit3: '🆘', Digit4: '😂' }[e.code];
  if (em) sendEmote(em);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
let zoom = 1.15;
addEventListener('wheel', e => { zoom = clamp(zoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.6, 1.8); }, { passive: true });

const joy = { on: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
const joyEl = $('joy'), joyKnob = joyEl.querySelector('i');
canvas.addEventListener('pointerdown', e => {
  if (joy.on) return;
  joy.on = true; joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.dx = joy.dy = 0;
  joyEl.style.left = e.clientX + 'px'; joyEl.style.top = e.clientY + 'px'; joyEl.classList.remove('hidden');
  joyKnob.style.transform = '';
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!joy.on || e.pointerId !== joy.id) return;
  let dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
  const d = Math.hypot(dx, dy), max = 50;
  if (d > max) { dx *= max / d; dy *= max / d; }
  joy.dx = dx / max; joy.dy = dy / max;
  joyKnob.style.transform = `translate(${dx}px,${dy}px)`;
});
const joyEnd = e => { if (e.pointerId !== joy.id) return; joy.on = false; joy.dx = joy.dy = 0; joyEl.classList.add('hidden'); };
canvas.addEventListener('pointerup', joyEnd);
canvas.addEventListener('pointercancel', joyEnd);

// =============================================================== Network & game state
let ws = null, myId = null, state = null, joined = false, nightK = 0, duskK = 0, coreAlertT = 0, shownMoney = 0;
const me = { x: 0, z: 5, r: Math.PI, tp: 0, dead: false, moving: false, carry: '', skill: 0, stillT: 0 };
let selDays = 5;
// reconnect: the server's token (kept per tab in sessionStorage, survives a refresh) reclaims the same player
let myName = '', retries = 0, retryTimer = 0, lastMsgAt = 0, kicked = false;
const sess = {
  get() { try { return sessionStorage.getItem('wt_token'); } catch (e) { return null; } },
  set(v) { try { if (v) sessionStorage.setItem('wt_token', v); else sessionStorage.removeItem('wt_token'); } catch (e) { /* ignore */ } },
};
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const setNet = s => { const el = $('netMsg'); if (!el) return; el.textContent = s; el.classList.toggle('hidden', !s); };
function join() {
  if (joined || ws) return;
  myName = $('nameInput').value.trim() || 'ผู้เล่น' + Math.floor(Math.random() * 100);
  store.set('wt_name', myName);
  initAudio();
  $('joinBtn').disabled = true; $('joinErr').textContent = 'กำลังเชื่อมต่อ...';
  connect();
}
function connect() {
  clearTimeout(retryTimer);
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws = sock;
  sock.onopen = () => { lastMsgAt = performance.now(); sock.send(JSON.stringify({ t: 'join', name: myName, token: sess.get() })); };
  sock.onmessage = e => {
    if (ws !== sock) return;
    lastMsgAt = performance.now();
    try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };
  sock.onclose = () => { if (ws === sock) connectionLost(); };
}
function connectionLost() {
  const old = ws; ws = null;
  if (old) { old.onclose = null; try { old.close(); } catch (e) { /* ignore */ } }
  if (!joined) {
    $('joinErr').textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ต้องเปิดผ่าน node server.js'; $('joinBtn').disabled = false;
    return;
  }
  if (kicked) return;
  retries++;
  setNet(`📡 หลุดการเชื่อมต่อ — กำลังเชื่อมต่อใหม่... (ครั้งที่ ${retries})`);
  retryTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** (retries - 1)));
}
// back from a background tab / network returns: retry right away instead of waiting for the backoff
const retryNow = () => { if (joined && !ws && !kicked) { retries = 0; connect(); } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retryNow(); });
addEventListener('online', retryNow);
addEventListener('pointerdown', () => { if (joined) initAudio(); });

$('nameInput').value = store.get('wt_name') || '';
$('joinBtn').onclick = join;
$('startBtn').onclick = () => send({ t: 'start', days: selDays });
$('againBtn').onclick = () => send({ t: 'restart' });
$('daysSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
  selDays = +b.dataset.d;
  $('daysSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
});
document.querySelectorAll('#emotes button[data-e]').forEach(b => b.onclick = () => { sendEmote(b.dataset.e); $('emotes').classList.add('hidden'); });
$('emoteBtn').onclick = () => $('emotes').classList.toggle('hidden');
$('skillBtn').onclick = () => useSkill();
const syncAudioBtns = () => { $('musicBtn').classList.toggle('off', !audioPref.music); $('sfxBtn').classList.toggle('off', !audioPref.sfx); };
function toggleMusic() { audioPref.music = !audioPref.music; store.set('wt_music', audioPref.music ? '1' : '0'); syncAudioBtns(); Music.apply(); }
$('musicBtn').onclick = toggleMusic;
$('sfxBtn').onclick = () => { audioPref.sfx = !audioPref.sfx; store.set('wt_sfx', audioPref.sfx ? '1' : '0'); syncAudioBtns(); Music.apply(); };
syncAudioBtns();
const qBtn = $('qualityBtn');
const setQualityLabel = () => { qBtn.textContent = HQ ? '✨' : '⚡'; qBtn.title = HQ ? 'กราฟิกสูง (กดเพื่อเปลี่ยนเป็นโหมดลื่น)' : 'โหมดลื่น (กดเพื่อเปลี่ยนเป็นกราฟิกสูง)'; };
setQualityLabel();
qBtn.onclick = () => { HQ = !HQ; store.set('wt_hq', HQ ? '1' : '0'); setQualityLabel(); resize(); buildDecor(); };
function sendEmote(s) { if (joined) send({ t: 'emote', s }); }
function useSkill() { if (joined && me.skill <= 0 && !me.dead) send({ t: 'skill' }); }
// refreshed mid-game: rejoin automatically with this tab's token
if (sess.get() && $('nameInput').value) { join(); $('joinErr').textContent = 'กำลังกลับเข้าเกม...'; }

function onMsg(m) {
  if (m.t === 'welcome') {
    if (joined) toast(m.id === myId ? '✅ เชื่อมต่อกลับแล้ว — ของในกระเป๋ายังอยู่ครบ' : '✅ เชื่อมต่อกลับแล้ว (หลุดนานเกินไป เริ่มเป็นผู้เล่นใหม่)');
    myId = m.id; joined = true; sess.set(m.token);
    me.tp = -1; lastSent = ''; retries = 0; setNet(''); // -1: snap to the server's position on the next snapshot
    $('joinOverlay').classList.add('hidden'); $('hud').classList.remove('hidden');
    $('nameInput').blur(); // otherwise WASD keeps typing into the hidden name field
  } else if (m.t === 'kicked') {
    kicked = true; sess.set(null);
    setNet('🔒 ตัวละครนี้ถูกเปิดในแท็บ/เครื่องอื่นแล้ว — รีเฟรชหน้าเพื่อเข้าเป็นผู้เล่นใหม่');
  } else if (m.t === 'world') buildNature(m.trees, m.rocks || []);
  else if (m.t === 's') onState(m);
}

function toast(s) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = s;
  const box = $('toasts'); box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => el.remove(), 4500);
}

function onState(s) {
  const prev = state; state = s;
  const L = s.B.map(b => b[0]);
  const key = L.join(',');
  if (key !== levelsKey) {
    levelsKey = key; rebuildPads(L);
    L.forEach((lv, i) => showBuilding(i, lv));
  }
  for (const p of pads) if (p.fill) {
    const b = s.B[p.plot], cost = S.costOf(p.plot, b[0]), tot = cost.c + cost.p + cost.r;
    p.fill.scale.z = Math.max(0.001, tot ? (b[1] + b[2] + (b[4] || 0)) / tot : 0);
  }
  s.T.forEach((w, i) => trees[i] && setTreeWood(trees[i], w));
  (s.R || []).forEach((n, i) => rocks[i] && setRockStone(rocks[i], n));
  PILES.forEach((p, i) => { const n = s.S[i]; p.pile.set(L[S.PI[p.plot]] > 0 ? (p.coin ? Math.ceil(n / 2) : n) : 0); });
  syncPortals(s.po);

  syncSet(ents.P, s.P, d => {
    const col = new THREE.Color(d[2]).getHex();
    const p = makePerson({ body: col, hair: HAIR[d[0] % HAIR.length] });
    const ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(1.6), transparent: true, opacity: 0.8, depthWrite: false }));
    ring.position.y = 0.07; p.g.add(ring);
    return Object.assign(p, { xi: 3, name: d[1], color: d[2], tp: d[9] });
  }, (e, d) => {
    e.name = d[1]; e.hp = d[6]; e.dead = d[7]; e.carry = d[8];
    e.g.visible = !e.dead;
    if (e.tp !== d[9]) { e.tp = d[9]; e.x = e.tx; e.z = e.tz; }
    setStack(e.stack, e.carry);
  });
  const mine = s.P.find(p => p[0] === myId);
  if (mine) {
    me.dead = mine[7] > 0; me.carry = mine[8]; me.hp = mine[6]; me.skill = mine[10] || 0;
    if (mine[9] !== me.tp) { me.tp = mine[9]; me.x = mine[3]; me.z = mine[4]; }
  }

  syncSet(ents.A, s.A, () => Object.assign(makeQuad({ size: 0.9, body: 0x7a4e2d, leg: 0x5a381f, snout: 0xe8a0a0, tusks: true, ears: true, mane: 0x5a381f }), { xi: 1 }),
    (e, d) => { e.hp = d[4]; });
  syncSet(ents.M, s.M, d => Object.assign(MON_MAKERS[d[1]](), { xi: 2, type: d[1] }), (e, d) => { e.hp = d[5]; });
  syncSet(ents.V, s.V, d => {
    const p = makePerson({ body: VIL_COLORS[d[6]], hair: HAIR[d[6] % HAIR.length], hat: !d[9] && d[6] % 3 === 0 ? VIL_COLORS[(d[6] + 3) % 8] : undefined, crown: !!d[9] });
    p.g.scale.setScalar(0.88);
    return Object.assign(p, { xi: 1, vip: d[9] });
  }, (e, d) => {
    e.want = d[4]; e.got = d[5]; e.shop = d[7]; e.qi = d[8];
    setStack(e.stack, (e.shop ? 'P' : 'S').repeat(e.got));
  });
  syncSet(ents.W, s.W, d => {
    const w = WORKER[d[1]], p = makePerson({ body: w.body, hat: w.hat });
    return Object.assign(p, { xi: 2, type: d[1] });
  }, (e, d) => { setStack(e.stack, d[5]); });

  for (const v of s.ev) handleEvent(v);

  if (prev && prev.n !== s.n && s.ph === 'play') sfx(s.n ? 'night' : 'day');
  Music.setTheme(s.ph === 'play' && s.n ? 'night' : 'day');
  updateHUD(s, L);
}

function entPos(pid) {
  if (pid === myId) return { x: me.x, z: me.z };
  const e = ents.P.get(pid); return e ? { x: e.g.position.x, z: e.g.position.z } : null;
}
function nearEnt(x, z) {
  for (const map of [ents.P, ents.W]) for (const [id, e] of map) {
    const mine = map === ents.P && id === myId, px = mine ? me.x : e.g.position.x, pz = mine ? me.z : e.g.position.z;
    if (Math.abs(px - x) < 0.6 && Math.abs(pz - z) < 0.6) return e;
  }
  return null;
}
function nearWorker(x, z) {
  let best = null, bd = 9;
  for (const e of ents.W.values()) { const d = (e.g.position.x - x) ** 2 + (e.g.position.z - z) ** 2; if (d < bd) { bd = d; best = e; } }
  return best;
}
function handleEvent(v) {
  switch (v.k) {
    case 'c': {
      const t = trees[v.i];
      if (t) { t.shake = 0.25; puff(t.x, 1.2, t.z, 0xc49a6c, 3, 2); }
      const e = v.p ? ents.P.get(v.p) : (t && nearWorker(t.x, t.z));
      if (e) { e.swing = 0.25; useTool(e, 'axe', 0.6); }
      if (v.p === myId) sfx('chop');
      break;
    }
    case 'r': {
      const r = rocks[v.i];
      if (r) { r.shake = 0.2; puff(r.x, 0.8, r.z, 0xb0b6bc, 3, 2.5); puff(r.x, 1, r.z, 0, 2, 3, glow(0xffe080, 2)); }
      const e = ents.P.get(v.p); if (e) { e.swing = 0.25; useTool(e, 'pick', 0.6); }
      if (v.p === myId) sfx('mine');
      break;
    }
    case 'a': {
      shootArrow(v.f, v.t);
      if (Math.hypot(v.f[0] - me.x, v.f[2] - me.z) < 3) sfx('shoot');
      const e = nearEnt(v.f[0], v.f[2]); if (e) { e.shoot = 0.3; useTool(e, 'bow', 0.5); }
    } break;
    case 'k': cannonBall(v.f, v.t, v.d); if (Math.hypot(v.f[0] - me.x, v.f[2] - me.z) < 25) beep(110, 0.15, 'square', 0.05, -60); break;
    case 'x': {
      puff(v.x, 0.6, v.z, 0x444444, 10, 5); puff(v.x, 0.8, v.z, 0, 8, 6, glow(0xff9030, 2.5));
      smoke(v.x, 0.8, v.z, 0x888888, 2.5, 1.2); shockwave(v.x, v.z, 3.4, 0xff9a40);
      addShake(0.35, v.x, v.z); if (Math.hypot(v.x - me.x, v.z - me.z) < 30) sfx('boom');
    } break;
    case 'sk': {
      shockwave(v.x, v.z, S.SKILL_R); puff(v.x, 0.3, v.z, 0xd9c29a, 18, 7);
      for (let i = 0; i < 8; i++) smoke(v.x + Math.cos(i) * 2, 0.4, v.z + Math.sin(i) * 2, 0xd9c29a, 1.6, 0.8);
      const e = ents.P.get(v.p); if (e) e.slam = 0.4;
      addShake(v.p === myId ? 0.6 : 0.3, v.x, v.z); sfx('slam');
    } break;
    case 'f': fly(v.i, v.a, v.b); if (v.a === myId || v.b === myId) sfx('pick'); break;
    case 'h': if (v.p === myId) floatText(String(Math.round(v.d)), v.x + (Math.random() - 0.5), 2.2, v.z, 'float dmg', 0.6); break;
    case 'd': {
      const col = { boar: 0x7a4e2d, goblin: 0x6abf3a, wolf: 0x3f4550, ogre: 0x9a7ac0, boss: 0xa82a2a, player: 0xffffff, struct: 0x8b5a2b }[v.t] || 0xffffff;
      const big = v.t === 'boss' || v.t === 'struct';
      puff(v.x, 1, v.z, col, big ? 40 : 12, big ? 8 : 4);
      if (v.t !== 'boar' && v.t !== 'player' && v.t !== 'struct') puff(v.x, 1, v.z, 0, 6, 3, glow(0xc080ff, 2.5));
      if (big) addShake(0.5, v.x, v.z);
      if (Math.hypot(v.x - me.x, v.z - me.z) < 14) sfx('kill');
    } break;
    case '$': floatText(`+$${v.a}`, v.x, 2, v.z, 'float gold', 1); if (v.p === myId || Math.hypot(v.x - me.x, v.z - me.z) < 6) sfx('coin'); break;
    case 'm': toast(v.s); break;
    case 'b': {
      const def = S.PLOTS[v.i]; puff(def.x, 1.5, def.z, 0xffd54a, 24, 6); puff(def.x, 2, def.z, 0, 12, 7, glow(0xffe080, 2)); shockwave(def.x, def.z, 4, 0xffe080); sfx('build');
    } break;
    case 'ph': {
      const p = entPos(v.p); if (p) floatText('-' + v.d, p.x, 2.6, p.z, 'float hurt', 0.8);
      if (v.p === myId) { sfx('hurt'); addShake(0.25, me.x, me.z); const vg = $('vignette'); vg.style.boxShadow = 'inset 0 0 140px rgba(255,0,0,.6)'; setTimeout(() => { vg.style.boxShadow = ''; }, 180); }
    } break;
    case 'ch': if (performance.now() - coreAlertT > 6000) { coreAlertT = performance.now(); toast('🏰 ศาลากลางถูกโจมตี!'); } break;
    case 'e': floatText(v.s, v.x, 3, v.z, 'float emote', 1.6); break;
  }
}

// =============================================================== HUD
const fmtT = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const setHTML = (el, h) => { if (el._h !== h) { el._h = h; el.innerHTML = h; } };
const setText = (el, t) => { t = String(t); if (el.textContent !== t) el.textContent = t; };
let wasEnd = false;
function updateHUD(s, L) {
  const cp = s.ch / S.CORE.hp * 100;
  setText($('coreText'), `${s.ch}/${S.CORE.hp}`);
  $('coreBar').firstElementChild.style.width = cp + '%';
  $('coreBar').classList.toggle('low', cp < 35 && s.ph === 'play');
  const lobby = s.ph === 'lobby', night = !lobby && !!s.n;
  $('hud').classList.toggle('night', night);
  $('lobbyPanel').classList.toggle('hidden', !lobby);
  if (lobby) {
    setText($('phaseIco'), '⛺');
    setText($('dayText'), 'รอเริ่มเกม');
    setText($('timeLbl'), 'ผู้เล่น'); setText($('timeText'), `${s.P.length} คน`);
    $('phaseBar').firstElementChild.style.width = '0%';
    setHTML($('totalText'), '');
    $('topbar').classList.remove('warn');
  } else {
    const segs = S.segments(s.days), seg = segs.find(g => g.day === s.day && !!g.night === !!s.n) || segs[0];
    const left = s.se - s.tm, frac = 1 - left / (seg.end - seg.start);
    setText($('phaseIco'), night ? '🌙' : '☀️');
    setText($('dayText'), `${night ? 'คืนที่' : 'วันที่'} ${s.day} จาก ${s.days}`);
    setText($('timeLbl'), night ? 'เช้าใน' : 'ค่ำใน'); setText($('timeText'), fmtT(left));
    $('phaseBar').firstElementChild.style.width = (clamp(frac, 0, 1) * 100) + '%';
    let dots = '';
    for (let d = 1; d <= s.days; d++) dots += `<i class="${d < s.day ? 'done' : d === s.day ? 'now' : ''}"></i>`;
    setHTML($('totalText'), `<span class="days">${dots}</span>${night && s.M.length ? `<span class="mobs">👾 ${s.M.length}</span>` : ''}`);
    $('topbar').classList.toggle('warn', !s.n && left < 15 && s.ph === 'play');
  }

  const cap = S.STATS.cap(L), c = me.carry || '', cnt = {};
  for (const ch of c) cnt[ch] = (cnt[ch] || 0) + 1;
  const parts = Object.keys(S.ITEMS).filter(k => cnt[k]).map(k => `<span class="it" title="${S.ITEMS[k].name}">${S.ITEMS[k].icon}<b>${cnt[k]}</b></span>`);
  setHTML($('carry'), `<span class="bag">🎒 ${c.length}/${cap}</span>${parts.length ? parts.join('') : '<span class="empty">กระเป๋าว่าง</span>'}`);
  $('carry').classList.toggle('full', c.length >= cap);

  setHTML($('plist'), s.P.map(p => `<div class="${p[0] === myId ? 'me' : ''}">${p[7] ? '💤 ' : ''}${escapeHtml(p[1])}<i style="background:${p[2]}"></i></div>`).join(''));

  const dm = $('deadMsg');
  const mine = s.P.find(p => p[0] === myId);
  if (mine && mine[7] > 0) { dm.classList.remove('hidden'); setText(dm, `💫 สลบไปแป๊บ... ฟื้นใน ${mine[7]}`); } else dm.classList.add('hidden');

  const sb = $('skillBtn');
  sb.classList.toggle('cd', me.skill > 0);
  sb.style.setProperty('--cd', (me.skill / S.SKILL_CD * 100) + '%');
  setText(sb.querySelector('small'), me.skill > 0 ? Math.ceil(me.skill) + 's' : 'Space');

  const end = s.ph === 'end' && s.res;
  $('endOverlay').classList.toggle('hidden', !end);
  if (end && !wasEnd) sfx(s.res.win ? 'win' : 'lose');
  wasEnd = !!end;
  if (end) {
    const r = s.res;
    setText($('endTitle'), r.win ? '🏆 เย้! เมืองรอดแล้ว' : '🥺 ศาลากลางพังซะแล้ว');
    setText($('endSub'), r.win ? `รอดครบ ${r.days} วัน · รายได้รวม $${r.earned} · ปราบมอนสเตอร์ ${r.kills} ตัว · สร้าง ${r.built} อย่าง`
      : `พังในวันที่ ${r.day}/${r.days} · รายได้รวม $${r.earned} · ปราบมอนสเตอร์ ${r.kills} ตัว`);
    setHTML($('endTable'), '<tr><th>ผู้เล่น</th><th>🪵</th><th>🪨</th><th>🐗</th><th>👾</th><th>💰</th><th>🔨</th></tr>' +
      r.players.map(p => `<tr><td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${p.color};margin-right:5px"></span>${escapeHtml(p.name)}</td><td>${p.wood}</td><td>${p.stone || 0}</td><td>${p.boar}</td><td>${p.kills}</td><td>${p.cash}</td><td>${p.build}</td></tr>`).join(''));
  }
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function plotInfo(i, s) {
  const def = S.PLOTS[i], b = s.B[i], cost = S.costOf(i, b[0]), max = def.max || 1;
  const needC = Math.max(0, cost.c - b[1]), needP = Math.max(0, cost.p - b[2]), needR = Math.max(0, cost.r - (b[4] || 0));
  let lv = max > 1 ? ` Lv.${b[0]}→${b[0] + 1}` : '';
  if ((def.kind === 'wall' || def.kind === 'tower') && b[0] === 1) lv = ' → หิน 🪨';
  return { def, needC, needP, needR, lv };
}
const needStr = (n, sep = ' + ') => [n.needC ? `💰 ${n.needC}` : '', n.needP ? `🪚 ${n.needP}` : '', n.needR ? `🪨 ${n.needR}` : ''].filter(Boolean).join(sep);

// ---- guidance: where should I go next?
function nearestPlot(s, fn) {
  let best = null, bd = 1e9;
  for (const p of pads) {
    if (p.k !== 'plot') continue;
    if (!fn(plotInfo(p.plot, s), p)) continue;
    const d = (p.x - me.x) ** 2 + (p.z - me.z) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
const padOf = k => pads.find(p => p.k === k);
function guideTarget(s, L) {
  if (!joined || me.dead || s.ph !== 'play') return null;
  const c = me.carry, cap = S.STATS.cap(L), full = c.length >= cap, st = s.S;
  const go = (p, text) => p ? { x: p.x, z: p.z, text } : null;
  const nearestOf = (list, ok) => { let b = null, bd = 1e9; for (const e of list) { if (ok && !ok(e)) continue; const d = (e.x - me.x) ** 2 + (e.z - me.z) ** 2; if (d < bd) { bd = d; b = e; } } return b; };
  if (s.n && s.M.length && !c.length) {
    let m = null, bd = 1e9; for (const e of ents.M.values()) { const d = (e.x - S.CORE.x) ** 2 + (e.z - S.CORE.z) ** 2; if (d < bd) { bd = d; m = e; } }
    if (m) return { x: m.x, z: m.z, text: '🌙 มอนสเตอร์บุก! ไปยิงตัวที่ใกล้ศาลากลางที่สุด (Space = ฟาดพื้น)', mob: true };
  }
  if (c.includes('S')) return go(padOf('meatShop'), '🍖 เอาสเต็กไปวางขายที่ร้านสเต็ก');
  if (c.includes('M') && (full || c.length >= 6 || !ents.A.size)) return go(padOf('grillIn'), '🥩 เอาเนื้อไปใส่เตาย่าง');
  if (c.includes('L')) return go(padOf('sawIn'), '🪵 เอาไม้ซุงไปใส่โรงเลื่อย');
  if (c.includes('P')) {
    const p = nearestPlot(s, n => n.needP > 0);
    if (p) return go(p, `🪚 เอาไม้แผ่นไปสร้าง "${S.PLOTS[p.plot].name}"`);
    if (L[S.PI.wood]) return go(padOf('woodShop'), '🪚 เอาไม้แผ่นไปวางขายที่ร้านไม้');
    return go(padOf('repair'), '🪚 ใช้ไม้แผ่นซ่อมศาลากลาง หรือทิ้งที่ถังขยะ');
  }
  if (c.includes('R')) {
    const p = nearestPlot(s, n => n.needR > 0);
    if (p) return go(p, `🪨 เอาหินไปอัปเกรด "${S.PLOTS[p.plot].name}"`);
    return go(padOf('trash'), '🪨 ยังไม่มีที่ใช้หิน — สร้างกำแพง/หอธนูไม้ก่อน หรือทิ้งที่ถังขยะ');
  }
  if (c.includes('M')) {
    const b = nearestOf(ents.A.values());
    if (b) return { x: b.x, z: b.z, text: `🐗 ล่าต่ออีกหน่อย (มีเนื้อ ${c.length} ชิ้น) หรือเอาไปย่างเลยก็ได้`, mob: true };
    return go(padOf('grillIn'), '🥩 เอาเนื้อไปใส่เตาย่าง');
  }
  if (st[3] >= 2 && !full) return go(padOf('grillOut'), '🍖 สเต็กสุกแล้ว! ไปรับที่เตา');
  if (st[6] >= 8) return go(padOf('cashM'), '💰 มีเงินรอเก็บที่ร้านสเต็ก!');
  if (st[7] >= 8) return go(padOf('cashW'), '💰 มีเงินรอเก็บที่ร้านไม้!');
  const afford = nearestPlot(s, n => !n.needP && !n.needR && n.needC > 0 && n.needC <= s.$);
  if (afford) return go(afford, `🔨 เงินพอแล้ว! ไปสร้าง "${S.PLOTS[afford.plot].name}"`);
  if (st[1] > 0 && nearestPlot(s, n => n.needP > 0)) return go(padOf('sawOut'), '🪚 รับไม้แผ่นไปใช้สร้างของ');
  // only send people mining once stone is actually useful (upgrading built walls/towers, or cannon nearly affordable)
  if (nearestPlot(s, (n, p) => n.needR > 0 && !n.needP && (L[p.plot] > 0 || s.$ >= n.needC * 0.6))) {
    const r = nearestOf(rocks, k => k.stone > 0);
    if (r) return { x: r.x, z: r.z, text: '⛏️ ไปขุดหิน 🪨 (ยืนนิ่งข้างก้อนหิน) มาอัปเกรดเป็นหิน' };
  }
  const b = nearestOf(ents.A.values());
  if (b) return { x: b.x, z: b.z, text: '🐗 ไปล่าหมูป่า (เข้าใกล้ = ยิงอัตโนมัติ)', mob: true };
  return null;
}
let guideT = null;
function updateGuide(t) {
  const s = state; if (!s) return;
  const L = s.B.map(b => b[0]);
  guideT = guideTarget(s, L);
  const pad = pads.find(p => Math.hypot(p.x - me.x, p.z - me.z) < S.PAD_R);
  let txt = '';
  if (pad) {
    if (pad.k === 'plot') {
      const n = plotInfo(pad.plot, s), need = needStr(n);
      txt = `🔨 ${n.def.name}${n.lv} — ต้องการ ${need || 'ครบแล้ว!'}`;
      if (n.needP && !me.carry.includes('P')) txt += ' (ต้องถือไม้แผ่นมา)';
      else if (n.needR && !me.carry.includes('R')) txt += ' (ต้องถือหินมา)';
      else if (n.needC && s.$ <= 0) txt += ' (เงินทีมหมด)';
      else txt += ' · ยืนนิ่งเพื่อจ่าย';
    } else txt = PADK[pad.k].tip;
  } else if (guideT) txt = guideT.text;
  else if (me.carry.length >= S.STATS.cap(L)) txt = '🎒 กระเป๋าเต็ม!';
  const el = $('hint'); el.textContent = txt; el.classList.toggle('hidden', !txt);

  const dist = guideT ? Math.hypot(guideT.x - me.x, guideT.z - me.z) : 0;
  const show = guideT && !pad && dist > 2.2;
  guide.visible = !!show && !guideT.mob;
  pointer.visible = !!show && dist > 5;
  if (show) {
    guide.position.set(guideT.x, Math.sin(t * 5) * 0.35, guideT.z);
    guide.rotation.y = t * 2;
    const a = Math.atan2(guideT.x - me.x, guideT.z - me.z);
    pointer.position.set(me.x + Math.sin(a) * 1.8, 0.1, me.z + Math.cos(a) * 1.8);
    pointer.rotation.y = a + Math.PI;
    pointer.material.opacity = 0.55 + Math.sin(t * 6) * 0.3;
  }
}

// charge ring: shows how long until standing still triggers an action
function updateCharge() {
  if (!state || !joined || me.dead || state.ph !== 'play') { charge.visible = false; return; }
  const L = state.B.map(b => b[0]);
  let need = 0;
  const pad = pads.find(p => Math.hypot(p.x - me.x, p.z - me.z) < S.PAD_R);
  if (pad) need = S.stillNeeded(pad.k);
  else if (me.carry.length < S.STATS.cap(L) && (trees.some(t => t.wood > 0 && Math.hypot(t.x - me.x, t.z - me.z) < 2.6) || rocks.some(r => r.stone > 0 && Math.hypot(r.x - me.x, r.z - me.z) < 2.2 + r.s))) need = S.STILL;
  if (!need) { charge.visible = false; return; }
  const prog = me.stillT / need;
  charge.visible = prog < 1;
  chargeU.uProg.value = me.moving ? 0 : prog;
  charge.position.set(me.x, 0.1, me.z);
}

// =============================================================== Minimap
const mm = $('minimap'), mctx = mm.getContext('2d');
let mmT = 0;
function drawMinimap(t) {
  const W = mm.width, sc = W / 2 / 76, cx = W / 2;
  const P = (x, z) => [cx + x * sc, cx + z * sc];
  mctx.clearRect(0, 0, W, W);
  mctx.save();
  mctx.beginPath(); mctx.arc(cx, cx, cx - 2, 0, Math.PI * 2); mctx.clip();
  mctx.fillStyle = '#8fcf6a'; mctx.fillRect(0, 0, W, W);
  mctx.fillStyle = '#b4e48a'; mctx.beginPath(); mctx.arc(cx, cx, 29 * sc, 0, Math.PI * 2); mctx.fill();
  mctx.fillStyle = '#7cc8f0';
  for (const p of S.PONDS) { const [x, y] = P(p.x, p.z); mctx.beginPath(); mctx.arc(x, y, p.r * sc, 0, 7); mctx.fill(); }
  mctx.fillStyle = '#5aae5e';
  for (const tr of trees) if (tr.wood > 0) { const [x, y] = P(tr.x, tr.z); mctx.beginPath(); mctx.arc(x, y, 2.6, 0, 7); mctx.fill(); }
  mctx.fillStyle = '#e4e8f0';
  for (const r of rocks) if (r.stone > 0) { const [x, y] = P(r.x, r.z); mctx.fillRect(x - 3, y - 3, 6, 6); }
  if (state) {
    S.PLOTS.forEach((def, i) => {
      const lv = state.B[i][0];
      if (lv <= 0) return;
      if (def.kind === 'wall') { mctx.strokeStyle = lv > 1 ? '#c8ccd0' : '#c89050'; mctx.lineWidth = lv > 1 ? 7 : 5; const a = P(def.seg[0], def.seg[1]), b = P(def.seg[2], def.seg[3]); mctx.beginPath(); mctx.moveTo(...a); mctx.lineTo(...b); mctx.stroke(); }
      else { const [x, y] = P(def.x, def.z); mctx.fillStyle = def.kind === 'tower' || def.kind === 'cannon' ? '#4aa3ff' : '#e8d4a0'; mctx.fillRect(x - 4, y - 4, 8, 8); }
    });
    const [kx, ky] = P(S.CORE.x, S.CORE.z); mctx.fillStyle = '#ff8fb1'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 3; mctx.beginPath(); mctx.roundRect(kx - 8, ky - 8, 16, 16, 5); mctx.fill(); mctx.stroke();
    for (const [x0, z0] of state.po || []) { const [x, y] = P(x0, z0); mctx.strokeStyle = '#c05cff'; mctx.lineWidth = 4; mctx.beginPath(); mctx.arc(x, y, 9 + Math.sin(t * 6) * 2, 0, 7); mctx.stroke(); }
    mctx.fillStyle = '#c48a5a';
    for (const e of ents.A.values()) { const [x, y] = P(e.g.position.x, e.g.position.z); mctx.beginPath(); mctx.arc(x, y, 3.5, 0, 7); mctx.fill(); }
    mctx.fillStyle = '#7a3a8a';
    for (const e of ents.M.values()) { const [x, y] = P(e.g.position.x, e.g.position.z); mctx.beginPath(); mctx.arc(x, y, e.type === 'boss' ? 9 : 4, 0, 7); mctx.fill(); }
    if (guideT) { const [x, y] = P(guideT.x, guideT.z); mctx.strokeStyle = '#ffd54a'; mctx.lineWidth = 3; mctx.beginPath(); mctx.arc(x, y, 7, 0, 7); mctx.stroke(); }
    for (const [id, e] of ents.P) {
      if (e.dead) continue;
      const isMe = id === myId, px = isMe ? me.x : e.g.position.x, pz = isMe ? me.z : e.g.position.z;
      const [x, y] = P(px, pz); mctx.fillStyle = e.color; mctx.strokeStyle = '#fff'; mctx.lineWidth = isMe ? 3 : 1.5;
      mctx.beginPath(); mctx.arc(x, y, isMe ? 7 : 5, 0, 7); mctx.fill(); mctx.stroke();
    }
  }
  mctx.restore();
}

// =============================================================== Main loop
const camLook = new THREE.Vector3(0, 0, 5), camPos = new THREE.Vector3(0, 30, 30);
let sendT = 0, lastSent = '', smokeT = 0, dustT = 0, clock = 0, T = 0;

function updateLocal(dt) {
  if (!state || !joined) return;
  let ix = 0, iz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iz -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iz += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  if (joy.on) { ix += joy.dx; iz += joy.dy; }
  const len = Math.hypot(ix, iz);
  me.moving = len > 0.1 && !me.dead && state.ph !== 'end';
  if (me.moving) {
    me.stillT = 0;
    const L = state.B.map(b => b[0]), spd = S.STATS.speed(L) * Math.min(1, len);
    ix /= len; iz /= len;
    let nx = clamp(me.x + ix * spd * dt, -S.MAP, S.MAP), nz = clamp(me.z + iz * spd * dt, -S.MAP, S.MAP);
    [nx, nz] = collide(nx, nz, L);
    me.x = nx; me.z = nz;
    me.r = angLerp(me.r, Math.atan2(ix, iz), Math.min(1, dt * 14));
    dustT -= dt;
    if (dustT <= 0) { dustT = 0.18; smoke(me.x - ix * 0.4, 0.15, me.z - iz * 0.4, dirtAt(me.x, me.z) > 0.3 ? 0xd8c3a0 : 0xc8d8b0, 0.6, 0.6); }
  } else me.stillT += dt;
  sendT -= dt;
  if (sendT <= 0 && ws && ws.readyState === 1) {
    sendT = 0.05;
    const d = [Math.round(me.x * 100) / 100, Math.round(me.z * 100) / 100, Math.round(me.r * 100) / 100, me.tp];
    const k = d.join(',');
    if (k !== lastSent) { lastSent = k; send({ t: 'p', d }); }
  }
}

function updateEntities(dt) {
  const k = Math.min(1, dt * 10);
  for (const [name, map] of Object.entries(ents)) {
    for (const [id, e] of map) {
      const px = e.x, pz = e.z;
      if (name === 'P' && id === myId) { e.x = me.x; e.z = me.z; e.r = me.r; }
      else { e.x = lerp(e.x, e.tx, k); e.z = lerp(e.z, e.tz, k); e.r = angLerp(e.r, e.tr, k); }
      e.g.position.x = e.x; e.g.position.z = e.z; e.g.rotation.y = e.r;
      const spd = Math.hypot(e.x - px, e.z - pz) / Math.max(dt, 1e-3);
      animPerson(e, dt, spd);
    }
  }
  for (const [id, e] of ents.P) {
    if (e.dead) continue;
    const isMe = id === myId;
    label('p' + id, `<div class="nm"><i style="background:${e.color}"></i>${escapeHtml(e.name)}${isMe ? ' ⭐' : ''}</div>${e.hp < 100 ? hpBar(e.hp) : ''}`, e.x, 2.45, e.z, 'name');
  }
  for (const [id, e] of ents.A) if (e.hp < 100) label('a' + id, hpBar(e.hp), e.x, 1.6, e.z, 'bar');
  for (const [id, e] of ents.M) {
    const h = { goblin: 2.1, wolf: 1.7, ogre: 3.9, boss: 7.2 }[e.type];
    if (e.type === 'boss') label('m' + id, `<div class="nm boss">👑 ${S.MONSTERS.boss.name}</div>${hpBar(e.hp)}`, e.x, h, e.z, 'name');
    else if (e.hp < 100) label('m' + id, hpBar(e.hp), e.x, h, e.z, 'bar');
  }
  for (const [id, e] of ents.V) if (e.qi >= 0 && e.qi < 3) label('v' + id, `${e.vip ? '👑 ' : ''}${e.shop ? '🪚' : '🍖'} ${e.got}/${e.want}`, e.x, 2.3, e.z, e.vip ? 'bub vip' : 'bub');
  for (const [id, e] of ents.W) label('w' + id, WORKER[e.type].icon, e.x, 2.5, e.z, 'pad');
}

function updateWorldLabels() {
  if (!state) return;
  const s = state, cx = camLook.x, cz = camLook.z;
  const near = (x, z, r = 36) => Math.abs(x - cx) < r && Math.abs(z - cz) < r;
  for (const p of pads) {
    if (!near(p.x, p.z)) continue;
    if (p.k === 'plot') {
      // keep the screen clean: full cost labels only for nearby plots or the one the guide points at
      const isGuide = guideT && guideT.x === p.x && guideT.z === p.z;
      if (!isGuide && Math.hypot(p.x - me.x, p.z - me.z) > 11) continue;
      const n = plotInfo(p.plot, s);
      label('pl' + p.plot, `<b>${n.def.name}</b><span class="lk">${n.lv}</span><br>${needStr(n, ' ')}`, p.x, 0.3, p.z + 1.2, 'plot');
    } else if (p.k === 'trash') label('trash', '🗑️ ถังขยะ', p.x, 0.3, p.z + 1.5, 'pad');
  }
  const st = s.S, L = s.B.map(b => b[0]);
  const stn = (id, html, x, y, z) => { if (L[S.PI[id]] > 0 && near(x, z)) label('st' + id, html, x, y, z, 'pad'); };
  const q = shop => { let n = 0; for (const v of ents.V.values()) if (v.shop === shop && v.qi >= 0) n++; return n; };
  stn('saw', `โรงเลื่อย 🪵${st[0]} ➜ 🪚${st[1]}`, -10, 4.6, -5);
  stn('grill', `เตาย่าง 🥩${st[2]} ➜ 🍖${st[3]}`, 10, 4.3, -5);
  stn('meat', `🍖${st[4]} · คิว ${q(0)}`, 7, 3.9, 8.6);
  stn('wood', `🪚${st[5]} · คิว ${q(1)}`, -7, 3.9, 8.6);
  if (st[6] > 0 && L[S.PI.meat] > 0) label('cashM', `💰${st[6]}`, 10.4, 1.4, 7.4, 'pad');
  if (st[7] > 0 && L[S.PI.wood] > 0) label('cashW', `💰${st[7]}`, -10.4, 1.4, 7.4, 'pad');
  if (s.ch < S.CORE.hp) label('core', `🏰 ${hpBar(s.ch / S.CORE.hp * 100)}`, S.CORE.x, 10, S.CORE.z, 'bar');
  S.PLOTS.forEach((def, i) => {
    const kind = def.kind, lv = s.B[i][0];
    if ((kind === 'wall' || kind === 'tower' || kind === 'cannon') && lv > 0 && s.B[i][3] < S.hpOf(i, lv) && near(def.x, def.z))
      label('bh' + i, hpBar(s.B[i][3] / S.hpOf(i, lv) * 100), def.x, kind === 'wall' ? 3.4 : 8, def.z, 'bar');
  });
}

function updateFx(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt;
    p.vy -= 12 * dt; p.m.position.x += p.vx * dt; p.m.position.y = Math.max(0.08, p.m.position.y + p.vy * dt); p.m.position.z += p.vz * dt;
    p.m.rotation.x += dt * 5; p.m.scale.setScalar(Math.max(0.01, p.life));
    if (p.life <= 0) { scene.remove(p.m); particles.splice(i, 1); }
  }
  for (let i = smokes.length - 1; i >= 0; i--) {
    const p = smokes[i]; p.life -= dt;
    const k = 1 - p.life / p.max;
    p.m.position.y += dt * 1.1; p.m.position.x += dt * 0.3; p.m.scale.setScalar(p.size * (1 + k * 1.8)); p.m.material.opacity = (1 - k) * 0.6;
    if (p.life <= 0) { scene.remove(p.m); p.m.material.dispose(); smokes.splice(i, 1); }
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i]; r.t += dt / 0.4;
    r.m.scale.setScalar(0.5 + r.t * r.r); r.m.material.opacity = Math.max(0, 1 - r.t);
    if (r.t >= 1) { scene.remove(r.m); r.m.material.dispose(); rings.splice(i, 1); }
  }
  for (let i = arrows.length - 1; i >= 0; i--) {
    const a = arrows[i]; a.t += dt / a.dur;
    const t = Math.min(1, a.t);
    a.m.position.lerpVectors(a.from, a.to, t); a.m.position.y += Math.sin(t * Math.PI) * a.arc;
    if (!a.ball) { const t2 = Math.min(1, t + 0.05); a.m.lookAt(lerp(a.from.x, a.to.x, t2), lerp(a.from.y, a.to.y, t2) + Math.sin(t2 * Math.PI) * a.arc, lerp(a.from.z, a.to.z, t2)); }
    if (a.t >= 1) { scene.remove(a.m); arrows.splice(i, 1); }
  }
  for (let i = flyers.length - 1; i >= 0; i--) {
    const f = flyers[i]; f.t += dt / f.dur;
    const B = resolvePt(f.b) || f.a, t = Math.min(1, f.t);
    f.m.position.set(lerp(f.a.x, B.x, t), lerp(f.a.y, B.y, t) + Math.sin(t * Math.PI) * 1.4, lerp(f.a.z, B.z, t));
    f.m.rotation.y += dt * 10;
    if (f.t >= 1) { scene.remove(f.m); flyers.splice(i, 1); }
  }
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i]; f.t += dt;
    if (f.t >= f.life) { floats.splice(i, 1); continue; }
    label(f.key, f.html, f.x, f.y + f.t * 1.5, f.z, f.cls, 1 - Math.pow(f.t / f.life, 3));
  }
  for (const t of trees) {
    if (t.fall > 0) {
      t.fall += dt * 1.6;
      t.pivot.rotation.z = t.fallDir * Math.min(1.5, t.fall * t.fall * 1.5);
      if (t.fall > 1.1) { t.pivot.visible = false; t.fall = 0; puff(t.x, 0.6, t.z, 0x3aa447, 12, 4); if (Math.hypot(t.x - me.x, t.z - me.z) < 10) sfx('tree'); }
      continue;
    }
    if (t.shake > 0) { t.shake -= dt; t.top.rotation.z = Math.sin(t.shake * 60) * 0.12; t.top.rotation.x = Math.cos(t.shake * 50) * 0.06; }
    else if (t.top.rotation.z) { t.top.rotation.z = 0; t.top.rotation.x = 0; }
    if (t.grow) { const sc = Math.min(1, t.top.scale.x + dt * 1.5); t.top.scale.setScalar(sc); if (sc >= 1) t.grow = false; }
  }
  for (const r of rocks) if (r.shake > 0) { r.shake -= dt; r.body.position.x = Math.sin(r.shake * 80) * 0.06; } else if (r.body.position.x) r.body.position.x = 0;
  if (state) {
    const saw = buildings[S.PI.saw].lv[1];
    if (saw.visible && state.S[0] > 0) { saw.userData.spin.rotation.x += dt * 20; if (Math.random() < dt * 8) puff(-10, 1.1, -2.9, 0xe8c07a, 1, 2); }
    smokeT -= dt;
    const grill = buildings[S.PI.grill].lv[1];
    if (smokeT <= 0 && grill.visible) {
      smokeT = state.S[2] > 0 ? 0.3 : 1.2;
      const [x, y, z] = grill.userData.smoke; smoke(grill.position.x + x, y, grill.position.z + z);
    }
    S.PLOTS.forEach((def, i) => {
      if (def.kind !== 'cannon') return;
      const g = buildings[i].lv[1];
      if (g.userData.recoil > 0) { g.userData.recoil -= dt; g.userData.turret.scale.setScalar(1 + Math.max(0, g.userData.recoil) * 0.4); }
    });
  }
  for (const g of portalGroup.children) {
    g.userData.ring.rotation.z += dt * 1.5; g.userData.disc.rotation.z -= dt * 2;
    if (Math.random() < dt * 6) puff(g.position.x + (Math.random() - 0.5) * 3, 2.6, g.position.z + (Math.random() - 0.5) * 3, 0, 1, 2, glow(0xc080ff, 2.5));
  }
  const ff = fireflies, pa = ff.geometry.attributes.position, seeds = ff.userData.seeds;
  ff.material.opacity = nightK;
  if (nightK > 0.05) {
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      pa.setXYZ(i, camLook.x + s[0] + Math.sin(T * 0.5 + s[2]) * 2, 1 + Math.sin(T * 1.3 + s[2] * 3) * 0.5, camLook.z + s[1] + Math.cos(T * 0.4 + s[2]) * 2);
    }
    pa.needsUpdate = true;
  }
  for (const c of clouds) { c.position.x += dt * 1.6; if (c.position.x > 130) c.position.x = -130; }
}

const _hc = new THREE.Color(), _bc = new THREE.Color();
function updateLighting(dt) {
  const s = state, playing = s && s.ph === 'play';
  const nightT = playing && s.n ? 1 : 0;
  let duskT = 0;
  if (playing && !s.n) duskT = 1 - smooth(4, 22, s.se - s.tm);
  if (playing && s.n) duskT = 1 - smooth(0, 8, s.se - s.tm); // dawn glow
  nightK = lerp(nightK, nightT, Math.min(1, dt * 0.9));
  duskK = lerp(duskK, duskT, Math.min(1, dt * 1.5));
  const a = PAL.day, b = PAL.dusk, c = PAL.night;
  const mixC = (k, out) => out.copy(a[k]).lerp(b[k], duskK * (1 - nightK)).lerp(c[k], nightK * (1 - duskK * 0.4));
  mixC('top', skyU.top.value); mixC('hor', skyU.hor.value);
  scene.fog.color.copy(skyU.hor.value);
  mixC('sun', sun.color);
  hemi.intensity = lerp(lerp(a.hemi, b.hemi, duskK), c.hemi, nightK);
  sun.intensity = lerp(lerp(a.sunI, b.sunI, duskK), c.sunI, nightK);
  hemi.color.copy(_hc.setHex(0xf2f8ff)).lerp(_bc.setHex(0x9aa4ff), nightK);
  stars.material.opacity = nightK;
  torch.intensity = nightK * 22; torch.position.set(me.x, 3.5, me.z);
  coreLight.intensity = nightK * 30;
  bulbMat.color.setHex(0x9a8a70).lerp(_bc.setHex(0xffd890).multiplyScalar(3), nightK);
  bloom.strength = 0.12 + nightK * 0.6;
  windU.value = T; waterU.uTime.value = T; portalU.uTime.value = T;
}

function updateCamera(dt) {
  let tx, tz;
  if (joined) { tx = me.x; tz = me.z; }
  else { clock += dt * 0.08; tx = Math.sin(clock) * 12; tz = Math.cos(clock) * 8; }
  camLook.x = lerp(camLook.x, tx, Math.min(1, dt * 6));
  camLook.z = lerp(camLook.z, tz, Math.min(1, dt * 6));
  const dist = (joined ? zoom : 1.5) * (camera.aspect < 1 ? 1.4 : 1); // portrait screens need a wider view
  camPos.set(camLook.x, 24 * dist, camLook.z + 18 * dist);
  camera.position.lerp(camPos, Math.min(1, dt * 8));
  shake = Math.max(0, shake - dt * 1.8);
  camera.lookAt(camLook.x + (Math.random() - 0.5) * shake, 0.5 + (Math.random() - 0.5) * shake, camLook.z);
  sun.position.set(camLook.x + 57, 120, camLook.z + 44);
  sun.target.position.set(camLook.x, 0, camLook.z);
  sky.position.copy(camera.position);
}

let lastT = performance.now();
const moneyEl = $('money');
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now; T += dt;
  // server sends ~10 snapshots/s; silence means a dead link (e.g. after the device slept) — reconnect
  if (joined && ws && ws.readyState === 1 && now - lastMsgAt > 6000) connectionLost();
  updateLocal(dt);
  updateEntities(dt);
  updateFx(dt);
  updateWorldLabels();
  updateGuide(T);
  updateCharge();
  updateLighting(dt);
  updateCamera(dt);
  if (state && shownMoney !== state.$) {
    const up = state.$ > shownMoney;
    shownMoney = Math.abs(state.$ - shownMoney) < 1 ? state.$ : lerp(shownMoney, state.$, Math.min(1, dt * 8));
    moneyEl.textContent = Math.round(shownMoney).toLocaleString();
    if (up && !moneyEl.classList.contains('pop')) { moneyEl.classList.add('pop'); setTimeout(() => moneyEl.classList.remove('pop'), 200); }
  }
  mmT -= dt;
  if (mmT <= 0 && joined) { mmT = 0.1; drawMinimap(T); }
  flushLabels();
  if (HQ) composer.render(); else renderer.render(scene, camera);
}
requestAnimationFrame(frame);
