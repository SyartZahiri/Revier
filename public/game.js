// Browser client: rendering, menu, input, own movement, shooting, effects, HUD, networking.
// All paths are relative, so the folder works from any address (localhost, a server, GitHub Pages).
import * as THREE from './vendor/three.module.js';
import { HDRLoader } from './vendor/addons/loaders/HDRLoader.js';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from './vendor/addons/utils/SkeletonUtils.js';
import * as S from './shared.js';
import { createGame, weekKey, TICK_MS } from './sim.js';
import { SERVER } from './config.js';

const $ = (id) => document.getElementById(id);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const lerp = (a, b, t) => a + (b - a) * t;
const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const rnd = (n = 1) => (Math.random() - 0.5) * 2 * n;
const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const store = {                              // localStorage can be blocked: then the defaults simply stay
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// ---------- renderer, light, sky ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.autoClear = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const FOV = 90, HAZE = 0x9a9c9b;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HAZE, 22, 115);                   // smoke and dust hang over the ruins
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 400);
camera.rotation.order = 'YXZ';
const hemi = new THREE.HemisphereLight(0xdfe7f2, 0x57503f, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.castShadow = true;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun);
const flashLight = new THREE.PointLight(0xffc27a, 0, 14);   // lights the surroundings for a moment when I fire
scene.add(flashLight);

// The gun is drawn in its own pass so it never pokes through walls.
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
const vmSun = new THREE.DirectionalLight(0xfff0d8, 2.2);
vmSun.position.set(1, 2, 1.5);
vmScene.add(new THREE.HemisphereLight(0xdfe7f2, 0x6b6558, 2.4), vmSun);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = vmCamera.aspect = innerWidth / innerHeight;
  // Keep the gun the same share of the screen width in tall windows.
  vmCamera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(1.2445 / Math.min(camera.aspect, 1.7778)));
  camera.updateProjectionMatrix(); vmCamera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------- textures drawn in code: placeholders and everything without a photo ----------
function canvasTex(size, draw) {
  const cv = el('canvas', { width: size, height: size });
  draw(cv.getContext('2d'), size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}
function speckle(c, s, n, colors, max = 2) {
  for (let i = 0; i < n; i++) {
    c.fillStyle = colors[i % colors.length]; c.globalAlpha = 0.04 + Math.random() * 0.14;
    c.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * max, 1 + Math.random() * max);
  }
  c.globalAlpha = 1;
}
const flat = (base, n, colors, extra) => canvasTex(256, (c, s) => {
  c.fillStyle = base; c.fillRect(0, 0, s, s);
  speckle(c, s, n, colors);
  extra?.(c, s);
});
const seams = (alpha, every = 256) => (c, s) => {
  c.globalAlpha = alpha; c.fillStyle = '#000';
  for (let a = 0; a < s; a += every) { c.fillRect(0, a, s, 2); c.fillRect(a, 0, 2, s); }
  c.globalAlpha = 1;
};
const TEX = {
  concrete: flat('#8f918f', 2600, ['#fff', '#000', '#5d5d5d'], seams(0.28)),
  plaster: flat('#c4b89f', 2200, ['#fff', '#6e5f45', '#000']),
  // sandbags: four rows of bags per tile, every second row shifted by half a bag
  sandbag: canvasTex(256, (c, s) => {
    c.fillStyle = '#a08c63'; c.fillRect(0, 0, s, s);
    speckle(c, s, 2600, ['#fff', '#5c4d33', '#000'], 2);
    c.strokeStyle = '#4a3e29'; c.lineWidth = 4; c.globalAlpha = 0.7;
    for (let row = 0; row < 4; row++) for (let x = row % 2 ? -64 : 0; x < s; x += 128) c.strokeRect(x + 2, row * 64 + 2, 124, 60);
    c.globalAlpha = 1;
  }),
  mud: flat('#5f5244', 5000, ['#000', '#8a7a66', '#3a3128']),
  wall: flat('#6c7074', 2600, ['#fff', '#000', '#3f4245'], (c, s) => { c.globalAlpha = 0.3; c.fillStyle = '#000'; for (let y = 0; y < s; y += 64) c.fillRect(0, y, s, 2); c.globalAlpha = 1; }),
  wood: canvasTex(256, (c, s) => {
    c.fillStyle = '#9a7446'; c.fillRect(0, 0, s, s);
    speckle(c, s, 1800, ['#5c3f22', '#c79b62'], 9);
    c.fillStyle = '#4d351d'; c.globalAlpha = 0.6; for (let y = 32; y < s; y += 32) c.fillRect(0, y, s, 2); c.globalAlpha = 1;
    c.strokeStyle = '#6a4a28'; c.lineWidth = 26; c.strokeRect(13, 13, s - 26, s - 26);
  }),
};
const SOFT = (() => {                       // soft round blob for smoke, flashes and bullet holes
  const cv = el('canvas', { width: 64, height: 64 }), c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();

const sky = (() => { // a big dome with a gradient, hazy at the horizon. Replaced by the photo sky once that has loaded.
  const cv = el('canvas', { width: 2, height: 256 }), c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#55749a'); g.addColorStop(0.42, '#a3b4c6'); g.addColorStop(0.5, '#b4bdc6'); g.addColorStop(1, '#b4bdc6');
  c.fillStyle = g; c.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 12), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }));
  scene.add(dome);
  return dome;
})();

// Photo textures and sky from Poly Haven (CC0, see assets/QUELLEN.txt). The drawn textures above stay as
// the placeholder until a photo has loaded, and as the fallback if it never does.
const PHOTO = { concrete: 'concrete_wall_008', wall: 'cracked_concrete_wall', plaster: 'plastered_wall', wood: 'weathered_brown_planks' };
const PHOTO_GROUND = { mud: 'sand_01' };
const SOOT = { plaster: '#b3aca0', concrete: '#a9a9a6', mud: '#84735f' };     // photos are multiplied with these: a little dirtier, sand turns to mud
const texLoader = new THREE.TextureLoader();
function usePhoto(mat, id, repeat = 1, paint = null) {
  for (const [kind, slot] of [['diff', 'map'], ['nor_gl', 'normalMap']]) {
    texLoader.load(`./assets/${id}_${kind}_1k.jpg`, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.repeat.set(repeat, repeat);
      if (slot === 'map') { t.colorSpace = THREE.SRGBColorSpace; if (paint) mat.color.set(paint); }
      mat[slot] = t; mat.needsUpdate = true;
    });
  }
}
new HDRLoader().load('./assets/overcast_soil_puresky_1k.hdr', (t) => {
  t.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = t; scene.environment = vmScene.environment = t;          // real sky, and its light on everything
  scene.environmentIntensity = 0.38; scene.backgroundIntensity = 0.6; hemi.intensity = 0.12;
  renderer.toneMappingExposure = 0.84;                                         // a grey, heavy day
  scene.remove(sky);
});

const std = (color, roughness = 0.85, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
const boxGeo = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ---------- map ----------
const mats = new Map();
const PLAIN = { stone: [0x80837f, 0.95, 0], dirt: [0x4f4337, 1, 0], bark: [0x241c15, 1, 0] };   // colour, roughness, metalness
function boxMaterial(b) {
  const key = b.mat === 'steel' ? `steel${b.tint}` : b.mat;
  if (mats.has(key)) return mats.get(key);
  let mat;
  if (b.mat === 'steel') mat = std(b.tint ? 0x1d1f1b : 0x3f4638, 0.6, 0.5);                 // tank: green armour, dark tracks
  else if (PLAIN[b.mat]) mat = std(...PLAIN[b.mat]);
  else if (b.mat === 'sandbag') mat = new THREE.MeshStandardMaterial({ map: TEX.sandbag, roughness: 1 });
  else {
    mat = new THREE.MeshStandardMaterial({ map: TEX[b.mat], roughness: 0.95 });
    usePhoto(mat, PHOTO[b.mat], 1, SOOT[b.mat] ?? null);
  }
  mats.set(key, mat);
  return mat;
}
function groundMaterial(key, size) {
  const id = `ground-${key}-${size}`;
  if (!mats.has(id)) {
    const drawn = TEX[key].clone(); drawn.repeat.set(size / 4, size / 4); drawn.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: drawn, roughness: 1 });
    usePhoto(mat, PHOTO_GROUND[key], size / 3, SOOT[key] ?? null);
    mats.set(id, mat);
  }
  return mats.get(id);
}
// Box faces come with 0..1 texture coordinates. Stretch them to the face size so textures tile in metres.
function tileUV(geo, w, h, d, tu, tv, fitHeight) {
  const uv = geo.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i, side = f !== 2 && f !== 3;
    uv.setXY(k, uv.getX(k) * dims[f][0] / tu, fitHeight && side ? uv.getY(k) : uv.getY(k) * dims[f][1] / tv);
  }
}
const TILE = { concrete: [3, 3], plaster: [3, 3], wall: [4, 4], sandbag: [1, 0.8] };   // metres per texture tile
const flatOnGround = (extra) => new THREE.MeshStandardMaterial({ roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...extra });
const CRATER = flatOnGround({ color: 0x1d1915, transparent: true, opacity: 0.8 }), PIT = flatOnGround({ color: 0x0c0a08 });
const DRUM = std(0x6b3a28, 0.75, 0.35), EMBERS = new THREE.MeshBasicMaterial({ color: 0xff7a1a });
const FACING = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];      // text on a wall looks north, east, south or west

// Writing on a wall or a gravestone: sprayed in red (paint) or cut into the stone.
function writing(k) {
  const lines = k.text.split('\n'), lineH = k.paint ? 0.34 : 0.17, h = lines.length * lineH + 0.06;
  const cv = el('canvas', { width: 512, height: Math.round(512 * h / k.w) }), c = cv.getContext('2d');
  let px = cv.height / lines.length * 0.72;
  const font = () => { c.font = `${k.paint ? 'italic 900' : '700'} ${px}px ${k.paint ? '"Segoe Print", "Comic Sans MS", cursive' : 'Georgia, serif'}`; };
  for (font(); Math.max(...lines.map((l) => c.measureText(l).width)) > 480 && px > 8; px *= 0.92) font();
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = k.paint ? '#a51f1a' : '#1f1f1e';
  lines.forEach((l, i) => c.fillText(l, 256, cv.height * (i + 0.5) / lines.length));
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const m = mesh(new THREE.PlaneGeometry(k.w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: k.paint ? 0.85 : 0.9 }), k.x, k.y, k.z);
  m.rotation.y = FACING[k.facing];
  return m;
}
function makeDuck() {                        // easter egg: the last duck from when this game was called Quak Arena
  const g = new THREE.Group(), yellow = std(0xffd93b, 0.5);
  const body = mesh(new THREE.SphereGeometry(0.16, 12, 8), yellow); body.scale.set(1, 0.8, 1.3);
  const beak = mesh(new THREE.ConeGeometry(0.045, 0.12, 8), std(0xff8c1a, 0.5), 0, 0.14, -0.26); beak.rotation.x = -Math.PI / 2;
  g.add(body, mesh(new THREE.SphereGeometry(0.1, 12, 8), yellow, 0, 0.15, -0.14), beak);
  return g;
}

let curMap = S.MAPS[0], mapGroup = null, mapLayer = null, duck = null, smokers = [];
const vests = [];                            // one mesh per armour pickup of the current map
function buildMap(i) {
  if (mapGroup) { scene.remove(mapGroup); mapGroup.traverse((o) => o.geometry?.dispose()); }
  for (const d of decals.splice(0)) scene.remove(d);
  curMap = S.MAPS[i];
  const half = curMap.half, size = half * 2 + 2;
  mapGroup = new THREE.Group();
  const ground = mesh(new THREE.PlaneGeometry(size, size), groundMaterial(curMap.ground, size));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  mapGroup.add(ground);
  for (const b of curMap.boxes) {
    if (b.mat === 'none') continue;          // collides, but something else is drawn in its place (a drum)
    const [w, h, d] = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
    const geo = boxGeo(w, h, d);
    if (TILE[b.mat]) tileUV(geo, w, h, d, ...TILE[b.mat], false);
    const m = mesh(geo, boxMaterial(b), ...[0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2));
    m.castShadow = m.receiveShadow = true;
    mapGroup.add(m);
  }
  duck = null; smokers = [];
  for (const k of curMap.marks) {            // things that are only drawn
    if (k.type === 'crater') {
      const m = mesh(k.grave ? new THREE.PlaneGeometry(k.w * 2 - 0.1, k.d * 2 - 0.1) : new THREE.CircleGeometry(k.w, 22), k.grave ? PIT : CRATER, k.x, 0.015, k.z);
      m.rotation.x = -Math.PI / 2;
      mapGroup.add(m);
    } else if (k.type === 'barrel') {
      const m = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 14), DRUM, k.x, 0.45, k.z);
      m.castShadow = m.receiveShadow = true;
      mapGroup.add(m);
      if (k.burning) { const fire = mesh(new THREE.CircleGeometry(0.26, 14), EMBERS, k.x, 0.905, k.z); fire.rotation.x = -Math.PI / 2; mapGroup.add(fire); }
    } else if (k.type === 'smoke') smokers.push(new THREE.Vector3(k.x, k.y, k.z));
    else if (k.type === 'text') mapGroup.add(writing(k));
    else if (k.type === 'duck') { duck = makeDuck(); duck.position.set(k.x, k.y + 0.13, k.z); duck.rotation.y = 2.2; mapGroup.add(duck); }
  }
  vests.length = 0;
  for (const [x, y, z] of curMap.pickups) {
    const v = new THREE.Group();
    v.add(mesh(boxGeo(0.5, 0.56, 0.2), std(0x4f6b3a, 0.8)), mesh(boxGeo(0.34, 0.3, 0.24), std(0x2f3d27, 0.8), 0, -0.04, 0), mesh(boxGeo(0.52, 0.06, 0.22), std(0xc8ccc0), 0, 0.2, 0));
    v.position.set(x, y + 0.85, z); v.base = y + 0.85;
    v.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    mapGroup.add(v); vests.push(v);
  }
  scene.add(mapGroup);

  // light and shadows sized to the map
  const n = half > 35 ? 4096 : 2048, reach = half * 1.5;
  sun.position.set(0.56, 0.84, 0.32).multiplyScalar(half * 1.7);
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: half * 4.5 });
  sun.shadow.camera.updateProjectionMatrix();
  if (sun.shadow.mapSize.x !== n) { sun.shadow.mapSize.set(n, n); sun.shadow.map?.dispose(); sun.shadow.map = null; }

  // minimap background: everything tall enough to be cover, seen from above
  mapLayer = el('canvas', { width: half * 2 * MM, height: half * 2 * MM });
  const c = mapLayer.getContext('2d');
  c.fillStyle = '#23272b'; c.fillRect(0, 0, mapLayer.width, mapLayer.height);
  for (const b of curMap.boxes) {
    if (b.max[1] < 1.2 || b.min[1] > 2) continue;
    c.fillStyle = b.mat === 'steel' ? '#59634f' : b.mat === 'wall' ? '#3a3f44' : '#6b7178';
    c.fillRect((b.min[0] + half) * MM, (b.min[2] + half) * MM, (b.max[0] - b.min[0]) * MM, (b.max[2] - b.min[2]) * MM);
  }
}

// ---------- models ----------
const GUN = std(0x33373c, 0.45, 0.3), POLY = std(0x1d1e20, 0.75);
const barrel = (r, len) => new THREE.CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2);   // lies along z

const STEEL = std(0xb9bec4, 0.3, 0.7);
// Weapons point down -z. g.muzzle is the z of the front end, g.sight the height of the sight line.
function gunModel(i) {
  const g = new THREE.Group();
  const add = (geo, mat, y, z, rx = 0) => { const m = mesh(geo, mat, 0, y, z); m.rotation.x = rx; g.add(m); return m; };
  if (i === 0) {                                                            // knife: handle, guard, blade
    add(boxGeo(0.028, 0.034, 0.12), POLY, 0, 0.05);
    add(boxGeo(0.05, 0.016, 0.014), GUN, 0, -0.012);
    add(boxGeo(0.006, 0.036, 0.19), STEEL, 0.002, -0.115);
    g.muzzle = -0.21; g.sight = 0;
  } else if (i === 1) {                                                     // pistol: slide, frame, grip, front sight
    add(boxGeo(0.03, 0.036, 0.19), GUN, 0.02, -0.03);
    add(boxGeo(0.028, 0.022, 0.15), POLY, -0.006, -0.02);
    add(boxGeo(0.03, 0.11, 0.042), POLY, -0.06, 0.04, -0.22);
    add(boxGeo(0.006, 0.012, 0.008), GUN, 0.044, -0.115);
    g.muzzle = -0.13; g.sight = 0.046;
  } else {
    add(boxGeo(0.036, 0.1, 0.045), POLY, -0.085, 0.11, -0.3);               // grip
    if (i === 2) {                                                          // submachine gun: short, straight magazine, wire stock
      add(boxGeo(0.05, 0.075, 0.26), GUN, 0, 0);
      add(barrel(0.013, 0.1), GUN, 0.005, -0.18);
      add(boxGeo(0.03, 0.17, 0.04), GUN, -0.11, -0.03);
      add(boxGeo(0.02, 0.025, 0.2), GUN, 0.02, 0.22);
      add(boxGeo(0.008, 0.02, 0.01), GUN, 0.047, -0.11);
      g.muzzle = -0.23; g.sight = 0.057;
    } else {                                                                // assault rifle
      add(boxGeo(0.05, 0.08, 0.34), GUN, 0, 0);
      add(boxGeo(0.046, 0.056, 0.22), POLY, -0.005, -0.27);
      add(barrel(0.012, 0.2), GUN, 0.005, -0.47);
      add(boxGeo(0.036, 0.15, 0.065), GUN, -0.11, -0.04, 0.25);
      add(boxGeo(0.04, 0.07, 0.2), POLY, -0.01, 0.27);
      add(boxGeo(0.01, 0.035, 0.012), GUN, 0.057, -0.34);
      for (const sx of [-1, 1]) add(boxGeo(0.007, 0.022, 0.02), GUN, 0.062, 0.1).position.x = sx * 0.011;   // rear sight: a notch to look through
      g.muzzle = -0.57; g.sight = 0.075;
    }
  }
  return g;
}

function nameSprite(text) {
  const cv = el('canvas', { width: 256, height: 64 }), cx = cv.getContext('2d');
  cx.font = '600 28px Bahnschrift, "Segoe UI", sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.lineWidth = 5; cx.strokeStyle = '#000'; cx.strokeText(text, 128, 32);
  cx.fillStyle = '#fff'; cx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set(2, 0.5, 1); sp.position.y = 2.2;
  return sp;
}

// ---------- characters ----------
// Ten soldiers. They share one body ("SWAT" by Quaternius, CC0, see assets/QUELLEN.txt);
// colours and gear make each one different. Every player in a room wears a different one.
const SKIN = [
  { name: 'Wolf', cloth: 0x4b5257, gear: 0x1b1d20, visor: 0x0b0f12, skin: 0xc59b7c, extra: ['nvg'] },
  { name: 'Sahara', cloth: 0xb39b72, gear: 0x5e5140, visor: 0x2a1c10, skin: 0x9c6b47, extra: ['scarf'], accent: 0x8a744d },
  { name: 'Tundra', cloth: 0xd3d8db, gear: 0x7d868c, visor: 0x24323b, skin: 0xe0b89c, extra: ['pack'], accent: 0xb9c0c4 },
  { name: 'Dschungel', cloth: 0x4f6a3a, gear: 0x2b3320, visor: 0x10140c, skin: 0x7a5236, extra: ['pack', 'antenna'], accent: 0x39472b },
  { name: 'Marine', cloth: 0x27384f, gear: 0x11161d, visor: 0x0a2a3a, skin: 0xc59b7c, extra: ['beret'], accent: 0x16233a },
  { name: 'Rost', cloth: 0x7a4a34, gear: 0x2a211c, visor: 0x3a0d08, skin: 0xb8875f, extra: ['mask'], accent: 0x1c1a18 },
  { name: 'Geist', cloth: 0x15171a, gear: 0x0b0c0d, visor: 0xdfe6ea, skin: 0xd9d9d9, extra: ['scarf'], accent: 0xe4e4e0 },
  { name: 'Sani', cloth: 0x6b705c, gear: 0x30332b, visor: 0x101010, skin: 0xe0b89c, extra: ['cross', 'pack'], accent: 0x4d5142 },
  { name: 'Funker', cloth: 0x5d5f3f, gear: 0x26281c, visor: 0x0f1a14, skin: 0x9c6b47, extra: ['pack', 'antenna', 'headset'], accent: 0x3b3d28 },
  { name: 'Veteran', cloth: 0x3d3a34, gear: 0x1a1815, visor: 0x14100c, skin: 0xb8875f, extra: ['beret'], accent: 0x8c1c1c },
];
const kits = new Map();                      // character number -> its four materials, made once
function kit(i) {
  if (!kits.has(i)) {
    const k = SKIN[i];
    kits.set(i, { Swat: std(k.cloth, 0.85), Swat_Black: std(k.gear, 0.7, 0.1), Skin: std(k.skin, 0.75), Visor: std(k.visor, 0.2, 0.6), accent: std(k.accent ?? k.gear, 0.8) });
  }
  return kits.get(i);
}

// Gear that tells the characters apart. Positions are metres on a 1.8 m soldier who looks down -z.
// Each piece is: which bone carries it, and the meshes.
function gearFor(i) {
  const m = kit(i), dark = m.Swat_Black, out = [];
  const tube = (r, len) => new THREE.CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2);
  for (const e of SKIN[i].extra) {
    if (e === 'nvg') out.push(['Head', ...[-0.045, 0.045].map((x) => mesh(tube(0.03, 0.1), dark, x, 1.71, -0.19))]);
    else if (e === 'beret') { const b = mesh(new THREE.SphereGeometry(0.19, 14, 8), m.accent, 0.03, 1.86, 0); b.scale.set(1, 0.3, 1); b.rotation.z = -0.25; out.push(['Head', b]); }
    else if (e === 'mask') out.push(['Head', mesh(tube(0.05, 0.1), dark, 0, 1.55, -0.2), mesh(tube(0.035, 0.07), m.accent, 0.07, 1.53, -0.17)]);
    else if (e === 'headset') out.push(['Head', mesh(boxGeo(0.05, 0.1, 0.08), dark, 0.17, 1.64, 0), mesh(boxGeo(0.05, 0.1, 0.08), dark, -0.17, 1.64, 0), mesh(boxGeo(0.012, 0.012, 0.14), dark, 0.15, 1.57, -0.09)]);
    else if (e === 'scarf') out.push(['Chest', mesh(boxGeo(0.36, 0.11, 0.32), m.accent, 0, 1.45, -0.01)]);
    else if (e === 'pack') out.push(['Chest', mesh(boxGeo(0.36, 0.46, 0.17), m.accent, 0, 1.2, 0.22), mesh(boxGeo(0.3, 0.14, 0.06), dark, 0, 1.08, 0.33)]);
    else if (e === 'antenna') out.push(['Chest', mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.75, 6), dark, 0.14, 1.78, 0.27)]);
    else if (e === 'cross') {
      const white = std(0xe9e9e4, 0.8), red = std(0xb3261e, 0.8);
      out.push(['Chest', mesh(boxGeo(0.15, 0.15, 0.012), white, -0.09, 1.34, -0.17), mesh(boxGeo(0.11, 0.035, 0.016), red, -0.09, 1.34, -0.172), mesh(boxGeo(0.035, 0.11, 0.016), red, -0.09, 1.34, -0.172)]);
    }
  }
  return out;
}

// Fallback soldier built from boxes, shown until the real model has loaded. Local -z is "forward".
function makeSoldier(skin, name, parent = scene) {
  if (swat) return makeSwat(skin, name, parent);
  const g = new THREE.Group(), inner = new THREE.Group(), upper = new THREE.Group(), m = kit(skin);
  g.legs = [-1, 1].map((sx) => {
    const leg = new THREE.Group();
    leg.position.set(sx * 0.11, 0.92, 0);
    leg.add(mesh(boxGeo(0.17, 0.92, 0.2), m.Swat, 0, -0.46, 0), mesh(boxGeo(0.19, 0.12, 0.3), m.Swat_Black, 0, -0.86, -0.04));
    inner.add(leg);
    return leg;
  });
  inner.add(mesh(boxGeo(0.4, 0.16, 0.24), m.Swat, 0, 0.95, 0));
  upper.position.y = 1;
  upper.add(mesh(boxGeo(0.44, 0.62, 0.26), m.Swat, 0, 0.22, 0), mesh(boxGeo(0.48, 0.42, 0.31), m.Swat_Black, 0, 0.26, 0),
    mesh(new THREE.SphereGeometry(0.13, 12, 10), m.Skin, 0, 0.66, 0),
    mesh(new THREE.SphereGeometry(0.158, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), m.Swat_Black, 0, 0.69, 0));
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.rotation.order = 'YXZ';
    arm.position.set(sx * 0.27, 0.47, 0);
    arm.rotation.set(1.25, sx > 0 ? 0.15 : -0.5, 0);      // arms reach forward to the rifle
    arm.add(mesh(boxGeo(0.12, 0.5, 0.13), m.Swat, 0, -0.25, 0));
    upper.add(arm);
  }
  const rifle = gunModel(S.RIFLE);
  rifle.position.set(0.14, 0.27, -0.34);
  upper.add(rifle);
  inner.add(upper);
  g.label = nameSprite(name);
  g.add(inner, g.label);
  g.inner = inner; g.upper = upper;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  parent.add(g);
  return g;
}

let swat = null;      // { scene, clips, scale, floor } once the model has loaded
new GLTFLoader().load('./assets/swat.glb', (gltf) => {
  gltf.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(gltf.scene), h = box.max.y - box.min.y;
  if (!(h > 0.1)) return;                                // unusable size: keep the box soldiers
  swat = { scene: gltf.scene, clips: new Map(gltf.animations.map((c) => [c.name.split('|').pop(), c])), scale: S.HEIGHT / h, floor: box.min.y };
  for (const r of remotes.values()) { scene.remove(r.g); r.g = makeSoldier(r.skin, r.name); }   // swap players already in view
  if (self.g) { scene.remove(self.g); self.g = null; }
  showSkin(mySkin);
});

// Where the hands go, per weapon, in the weapon's own coordinates: [right hand, left hand].
// The knife is held in one hand, the pistol in both, the long guns at the grip and under the magazine well.
const at = (y, z) => new THREE.Vector3(0, y, z), X_AXIS = new THREE.Vector3(1, 0, 0);
const HOLD = [[at(0, 0.06), null], [at(-0.07, 0.04), at(-0.09, 0.03)], [at(-0.07, 0.1), at(-0.07, -0.05)], [at(-0.07, 0.1), at(-0.06, -0.14)]];
const ANIMS = ['Idle', 'Run', 'Death'];
function makeSwat(skin, name, parent) {
  const g = new THREE.Group(), inner = new THREE.Group(), model = cloneSkinned(swat.scene), m = kit(skin);
  model.scale.setScalar(swat.scale); model.position.y = -swat.floor * swat.scale;
  model.rotation.y = Math.PI;                             // the model looks down +z, the game uses -z as forward
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.frustumCulled = false;
    if (m[o.material.name]) o.material = m[o.material.name];
  });
  inner.add(model); g.add(inner);
  // The rifle sits at the right shoulder and is carried by the chest bone, so it moves with the body.
  // Gear and rifle are first placed in metres on the standing model, then handed to their bone.
  const bone = (n) => model.getObjectByName(n);
  const rifle = new THREE.Group();                        // holds one model per weapon, only the one in use is shown
  g.guns = S.WEAPONS.map((_, i) => gunModel(i));
  rifle.add(...g.guns);
  rifle.position.set(0.13, 1.37, -0.3);
  const loose = [['Chest', rifle], ...gearFor(skin)];
  for (const [, ...parts] of loose) inner.add(...parts);
  g.updateMatrixWorld(true);
  for (const [to, ...parts] of loose) for (const part of parts) {
    part.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    (bone(to) ?? inner).attach(part);
  }
  if (bone('Chest') && bone('WristR') && bone('WristL')) {
    g.rifle = rifle; g.rifleBase = rifle.quaternion.clone();
    g.arms = [[[bone('LowerArmR'), bone('UpperArmR')], bone('WristR')], [[bone('LowerArmL'), bone('UpperArmL')], bone('WristL')]];   // right, left
  }
  g.mixer = new THREE.AnimationMixer(model);
  g.actions = Object.fromEntries(ANIMS.filter((n) => swat.clips.has(n)).map((n) => [n, g.mixer.clipAction(swat.clips.get(n))]));
  if (g.actions.Death) { g.actions.Death.setLoop(THREE.LoopOnce); g.actions.Death.clampWhenFinished = true; }
  g.play = (n) => {
    if (n === g.anim || !g.actions[n]) return;
    g.actions[g.anim]?.fadeOut(0.15);
    g.actions[n].reset().fadeIn(0.15).play();
    g.anim = n;
  };
  g.label = nameSprite(name);
  g.add(g.label);
  g.inner = inner;
  parent.add(g);
  return g;
}

// Turns the arm bones so the hand ends up at `target` (a point in the world). Works from the hand inwards,
// a few rounds: each joint is turned so that the hand swings towards the target.
const _j = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion();
function reach(joints, hand, target) {
  for (let round = 0; round < 6; round++) for (const j of joints) {
    j.getWorldPosition(_j);
    hand.getWorldPosition(_a).sub(_j).normalize();
    _b.copy(target).sub(_j).normalize();
    _q.setFromUnitVectors(_a, _b);                         // the turn, seen from outside
    j.parent.getWorldQuaternion(_pq);
    j.quaternion.premultiply(_pq).premultiply(_q).premultiply(_pq.invert());   // the same turn, in the joint's own terms
    j.updateMatrixWorld(true);
  }
}

// Moves one soldier model for this frame. st: { spd, down, crouch, shotT, pitch, phase, fall }
function animateSoldier(g, st, dt, ease) {
  g.inner.scale.y += ((st.crouch ? S.CROUCH_HEIGHT / S.HEIGHT : 1) - g.inner.scale.y) * ease;
  st.shotT = Math.max(0, (st.shotT ?? 0) - dt);
  if (g.mixer) {                                                      // real model: legs and body from its animations
    g.play(st.down ? 'Death' : st.spd > 1.2 ? 'Run' : 'Idle');
    if (g.actions.Run) g.actions.Run.timeScale = clamp(st.spd / 6.5, 0.6, 1.5);
    g.mixer.update(dt);
    const w = st.w ?? S.RIFLE;
    g.guns?.forEach((gun, i) => { gun.visible = i === w; });
    if (g.rifle && !st.down) {                                        // arms: hands on the weapon, which follows the aim
      g.rifle.quaternion.copy(g.rifleBase).multiply(_q.setFromAxisAngle(X_AXIS, clamp(st.pitch ?? 0, -0.6, 0.6) + (st.shotT > 0.28 ? 0.05 : 0)));
      g.rifle.updateWorldMatrix(true, false);
      HOLD[w].forEach((at, k) => { if (at) reach(...g.arms[k], g.rifle.localToWorld(_t.copy(at))); });
    }
  } else {                                                            // box soldier: swing legs, tilt, fall over
    const walk = st.down ? 0 : clamp(st.spd / 6, 0, 1);
    st.phase = (st.phase ?? 0) + dt * st.spd * 1.5;
    g.legs[0].rotation.x = Math.sin(st.phase) * 0.65 * walk; g.legs[1].rotation.x = -g.legs[0].rotation.x;
    g.upper.rotation.x = (st.pitch ?? 0) * 0.7;
    st.fall = st.down ? Math.min(1, (st.fall ?? 0) + dt * 3.5) : 0;
    g.inner.rotation.x = st.fall * 1.45; g.inner.position.y = st.fall * 0.15;
  }
}

// view model: one model per weapon, hanging off the gun camera
const vm = new THREE.Group();
vmScene.add(vm);
const vmModels = S.WEAPONS.map((_, i) => gunModel(i));
vm.add(...vmModels);
const HIP = new THREE.Vector3(0.23, -0.21, -0.5);
const muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: SOFT, color: 0xffd9a0, transparent: true, depthTest: false }));
muzzleFlash.visible = false;
vm.add(muzzleFlash);

// ---------- effects ----------
const fx = [];        // each entry: (dt) => still alive?
const decals = [];
const DECAL = new THREE.SpriteMaterial({ map: SOFT, color: 0x0d0d0d, transparent: true, opacity: 0.9, depthWrite: false });
const unitBox = boxGeo(1, 1, 1);

function tracer(from, to) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe9b8, transparent: true, opacity: 0.55 });
  const m = mesh(unitBox, mat);
  m.position.copy(from).lerp(to, 0.5); m.lookAt(to); m.scale.set(0.018, 0.018, from.distanceTo(to));
  scene.add(m);
  let life = 0.06;
  fx.push((dt) => { life -= dt; mat.opacity = 0.55 * life / 0.06; if (life > 0) return true; scene.remove(m); mat.dispose(); });
}

function puff(pos, size, life, color = 0x9a9a9a, rise = 0.6, grow = 1.5, opacity = 0.5) {
  if (fx.length > 220) return;
  const mat = new THREE.SpriteMaterial({ map: SOFT, color, transparent: true, opacity, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.position.copy(pos); s.scale.setScalar(size);
  scene.add(s);
  let t = 0;
  fx.push((dt) => {
    t += dt / life; s.position.y += rise * dt; s.scale.setScalar(size * (1 + grow * t)); mat.opacity = opacity * (1 - t);
    if (t < 1) return true;
    scene.remove(s); mat.dispose();
  });
}

function sparks(pos, n, color, power = 4, life = 0.35) {
  const P = new Float32Array(n * 3), vel = [];
  for (let i = 0; i < n; i++) { P.set([pos.x, pos.y, pos.z], i * 3); vel.push([rnd(power), Math.random() * power, rnd(power)]); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  const mat = new THREE.PointsMaterial({ size: 0.06, color, transparent: true });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  let t = life;
  fx.push((dt) => {
    t -= dt;
    for (let i = 0; i < n; i++) { const v = vel[i]; v[1] -= 14 * dt; for (let k = 0; k < 3; k++) P[i * 3 + k] += v[k] * dt; }
    geo.attributes.position.needsUpdate = true; mat.opacity = t / life;
    if (t > 0) return true;
    scene.remove(pts); geo.dispose(); mat.dispose();
  });
}

// A bullet hits the world: hole, sparks, a little dust.
function impact(p, dir) {
  const q = p.clone().addScaledVector(dir, -0.03);
  const d = decals.length < 60 ? new THREE.Sprite(DECAL) : decals.shift();
  d.scale.setScalar(0.13); d.position.copy(q);
  scene.add(d); decals.push(d);
  sparks(q, 5, 0xffc36b);
  puff(q, 0.22, 0.5, 0xb8b0a4, 0.3, 2, 0.35);
  if (duck && q.distanceTo(duck.position) < 0.6 && performance.now() > quackAt) {     // easter egg: shoot the duck
    quackAt = performance.now() + 1500;
    sfx.quack(camera.position.distanceTo(duck.position)); feed(['Quak.']);
  }
}

// ---------- sound (all synthesised, no files) ----------
let ac = null;
const near = (dist = 0) => clamp(1 - dist / 60, 0, 1);
function tone(f, dur, type = 'square', vol = 0.06, to = f) {
  if (!ac || vol <= 0) return;
  const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
  o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur);
}
function noise(dur, vol, cutoff = 4000) {
  if (!ac || vol <= 0) return;
  const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rnd() * (1 - i / d.length) ** 2;
  const src = ac.createBufferSource(), lp = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = buf; lp.type = 'lowpass'; lp.frequency.value = cutoff; g.gain.value = vol;
  src.connect(lp).connect(g).connect(ac.destination); src.start();
}
const SHOT = [null, [0.14, 0.22, 3000, 150], [0.09, 0.15, 3900, 200], [0.12, 0.2, 3400, 170]];   // per gun: length, volume, brightness, thump
const sfx = {
  shot: (w, dist) => {
    if (!SHOT[w]) return noise(0.13, 0.07 * near(dist * 3), 5200);      // knife: a swish, heard only close by
    const [dur, vol, cut, thump] = SHOT[w], v = near(dist);
    noise(dur, vol * v, cut * (0.35 + 0.65 * v)); tone(thump, dur * 0.9, 'sine', vol * 0.8 * v, thump * 0.4);
  },
  hit: (head) => (head ? tone(1900, 0.08, 'triangle', 0.1) : tone(1100, 0.04, 'triangle', 0.07)),
  kill: () => { tone(520, 0.09, 'triangle', 0.09); setTimeout(() => tone(780, 0.16, 'triangle', 0.09), 80); },
  hurt: () => { noise(0.09, 0.14, 600); tone(140, 0.12, 'sine', 0.1, 70); },
  step: (dist) => noise(0.05, 0.04 * near(dist * 3), 700),
  jump: () => noise(0.05, 0.03, 900),
  wjump: () => noise(0.07, 0.06, 1400),
  land: () => { noise(0.08, 0.07, 400); tone(90, 0.07, 'sine', 0.06, 50); },
  slide: () => noise(0.45, 0.06, 1200),
  reload: () => { tone(1700, 0.015, 'square', 0.035); setTimeout(() => tone(1300, 0.02, 'square', 0.035), 220); },
  reloaded: () => { tone(2100, 0.02, 'square', 0.045); setTimeout(() => tone(900, 0.03, 'square', 0.04), 70); },
  vest: () => { noise(0.12, 0.08, 2500); tone(420, 0.12, 'triangle', 0.07, 640); },
  quack: (dist) => { const v = near(dist); tone(520, 0.08, 'sawtooth', 0.1 * v, 760); setTimeout(() => tone(600, 0.13, 'sawtooth', 0.1 * v, 340), 80); },
};

// ---------- state ----------
const me = S.newBody();
let myId = 0, myName = '', joined = false, solo = false, dead = false, hp = 100, armor = 0, yaw = 0, pitch = 0, weapon = S.RIFLE;
let eyeH = S.EYE, roll = 0, kickP = 0, kickY = 0, vmKick = 0, nextFire = 0, firing = false, locked = false;
let ads = false, adsT = 0, spread = 0, burst = 0, lastShotAt = 0, stepDist = 0, flashT = 0, stepOff = 0;
let third = store.get('third') === '1', tpT = 0, chatting = false;
let mySkin = clamp(Math.floor(Number(store.get('skin')) || 0), 0, S.SKINS - 1), smokeT = 0, quackAt = 0;
const self = { g: null, spd: 0, down: false, crouch: false, shotT: 0 };   // my own body, shown in shoulder view
const remotes = new Map();   // id -> { g, pos, target, yaw, tyaw, pitch, tpitch, crouch, hp, name, k, d, spd, down, radar }
const names = new Map();
const keys = {};
let myStats = { name: '', k: 0, d: 0 }, pickupsOn = [];
const ammo = S.WEAPONS.map((w) => w.mag);
let reloadAt = 0, shake = 0, streak = 0, bannerTimer = 0;
const STREAKS = { 2: 'Doppelkill', 3: 'Dreifachkill', 5: 'Amoklauf', 8: 'Unaufhaltsam' };
const crossBars = [...$('cross').children].slice(0, 4);
const eye = new THREE.Vector3(), aimDir = new THREE.Vector3();

let sens = Number(store.get('sens')) || 4;
$('sens').value = sens;
$('sens').addEventListener('input', (e) => { sens = Number(e.target.value); store.set('sens', sens); });

// ---------- HUD ----------
$('weapons').append(...S.WEAPONS.map((w, i) => el('span', { textContent: `${i + 1} ${w.short}` })));
function renderGun() {
  const W = S.WEAPONS[weapon];
  $('ammo').replaceChildren(...(W.mag ? [String(ammo[weapon]), el('small', { textContent: ` / ${W.mag}` })] : ['–']));
  $('wname').textContent = reloadAt ? `${W.name} · lädt nach` : W.name;
  [...$('weapons').children].forEach((e, k) => e.classList.toggle('on', k === weapon));
  vmModels.forEach((m, k) => { m.visible = k === weapon; });
}
function setWeapon(i) {
  weapon = (i + S.WEAPONS.length) % S.WEAPONS.length;
  reloadAt = 0;                              // switching cancels a reload
  renderGun();
}
function reload() {
  if (reloadAt || dead || ammo[weapon] === S.WEAPONS[weapon].mag) return;      // also true for the knife: 0 of 0
  reloadAt = performance.now() / 1000 + S.WEAPONS[weapon].reload;
  sfx.reload(); renderGun();
}
setWeapon(S.RIFLE);

function banner(text, ms) {
  $('banner').textContent = text; $('banner').style.display = 'block';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { $('banner').style.display = 'none'; }, ms);
}
function dmgNumber(n, head) {
  const e = el('span', { textContent: n, className: head ? 'head' : '' });
  e.style.left = `calc(50% + ${Math.round(24 + Math.random() * 40)}px)`;
  e.style.top = `calc(50% - ${Math.round(20 + Math.random() * 30)}px)`;
  $('dmg').append(e);
  setTimeout(() => e.remove(), 700);
}
function feed(nodes, mine) {
  const e = el('div', { className: mine ? 'mine' : '' }, ...nodes);
  $('feed').append(e);
  while ($('feed').children.length > 6) $('feed').firstChild.remove();
  setTimeout(() => e.remove(), 6000);
}
function flash(id, cls = 'on') {
  const e = $(id); e.className = cls;
  requestAnimationFrame(() => requestAnimationFrame(() => { e.className = ''; }));
}
const tableRow = (cells, tag, mine) => el('tr', { className: mine ? 'me' : '' }, ...cells.map((c) => el(tag, { textContent: c })));
function scoreboard(show) {
  $('score').style.display = show ? 'table' : 'none';
  if (!show) return;
  const rows = [{ ...myStats, me: true }, ...remotes.values()].sort((a, b) => b.k - a.k || a.d - b.d);
  $('score').replaceChildren(tableRow(['Spieler', 'Kills', 'Tode'], 'th'), ...rows.map((r) => tableRow([r.name, r.k, r.d], 'td', r.me)));
}

// Minimap: turns with me (my view is always up). Enemies only show up for a moment after they fire.
const MM = 3;                                // pixels per metre in the pre-drawn map
const mm = $('map'), mctx = mm.getContext('2d');
function drawMinimap() {
  const c = mm.width / 2, k = (c / 40) / MM;                   // the circle shows 40 m around me
  mctx.clearRect(0, 0, mm.width, mm.height);
  mctx.save();
  mctx.beginPath(); mctx.arc(c, c, c - 2, 0, Math.PI * 2); mctx.clip();
  mctx.fillStyle = '#0e1012'; mctx.fillRect(0, 0, mm.width, mm.height);
  mctx.translate(c, c); mctx.rotate(yaw); mctx.scale(k, k);
  mctx.translate(-me.pos[0] * MM, -me.pos[2] * MM);
  mctx.globalAlpha = 0.85; mctx.drawImage(mapLayer, -curMap.half * MM, -curMap.half * MM); mctx.globalAlpha = 1;
  const dot = (x, z, color, r) => { mctx.fillStyle = color; mctx.beginPath(); mctx.arc(x * MM, z * MM, r / k, 0, Math.PI * 2); mctx.fill(); };
  curMap.pickups.forEach(([x, , z], i) => { if (pickupsOn[i]) dot(x, z, '#7da25c', 5); });
  for (const r of remotes.values()) if (r.radar > 0 && !r.down) dot(r.pos.x, r.pos.z, '#e5484d', 6);
  mctx.restore();
  mctx.fillStyle = '#fff'; mctx.beginPath(); mctx.moveTo(c, c - 11); mctx.lineTo(c + 8, c + 8); mctx.lineTo(c, c + 3); mctx.lineTo(c - 8, c + 8); mctx.fill();
  mctx.strokeStyle = '#ffffff40'; mctx.lineWidth = 3; mctx.beginPath(); mctx.arc(c, c, c - 2, 0, Math.PI * 2); mctx.stroke();
}

// ---------- menu: name, weekly leaderboard, online or solo ----------
const BASE = SERVER || location.origin;
const forceSolo = new URLSearchParams(location.search).has('solo');
let serverOk = false;
const nameInput = $('name');
nameInput.value = store.get('name') ?? '';
function status(text, bad = false) { $('status').textContent = text; $('status').className = bad ? 'bad' : ''; }
function soloBoard() {                       // my own kills against bots this week, kept in this browser
  let b = null;
  try { b = JSON.parse(store.get('soloBoard')); } catch { /* broken entry: start over */ }
  return b?.week === weekKey() && b.kills && typeof b.kills === 'object' ? b : { week: weekKey(), kills: {} };
}
function showBoard(b, title) {
  $('boardTitle').textContent = title;
  $('week').textContent = `· KW ${Number(b.week.slice(-2))}`;
  $('empty').hidden = b.top.length > 0;
  $('board').replaceChildren(...(b.top.length ? [tableRow(['#', 'Name', 'Kills'], 'th')] : []),
    ...b.top.map((r, i) => tableRow([i + 1, r.name, r.k], 'td', r.name === myName)));
}
// GitHub Pages only delivers files. Without a server address in config.js there is nothing to ask there.
const noServer = !SERVER && location.hostname.endsWith('github.io');
async function loadBoard() {
  if (!solo && !forceSolo && !noServer) {
    try {
      const res = await fetch(`${BASE}/api/leaderboard`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) throw new Error(res.status);
      showBoard(await res.json(), 'Rangliste der Woche');
      serverOk = true;
      $('mode').textContent = 'Mehrspieler: Server erreichbar.';
      return;
    } catch { serverOk = false; }
  }
  const b = soloBoard();
  showBoard({ week: b.week, top: Object.entries(b.kills).filter(([, k]) => Number.isInteger(k)).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([name, k]) => ({ name, k })) }, 'Deine Woche gegen Bots');
  $('mode').textContent = 'Solo gegen einen Bot: kein Server erreichbar. Das Spiel läuft ganz in deinem Browser.';
}
const boardReady = loadBoard();

// Character preview in the menu: its own small 3D view, so you see who you are before you go in.
const pv = { renderer: new THREE.WebGLRenderer({ canvas: $('preview'), antialias: true, alpha: true }), scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(30, $('preview').width / $('preview').height, 0.1, 20), g: null, st: { spd: 0, down: false, pitch: 0 } };
pv.renderer.toneMapping = THREE.ACESFilmicToneMapping;
pv.renderer.toneMappingExposure = 1.25;
pv.camera.position.set(0, 1.15, 3.95); pv.camera.lookAt(0, 0.96, 0);
const pvSun = new THREE.DirectionalLight(0xfff0d8, 3.2);
pvSun.position.set(2, 3, 4);
pv.scene.add(new THREE.HemisphereLight(0xeef3fa, 0x8a8478, 2.8), pvSun);
function showSkin(i) {
  mySkin = (i + S.SKINS) % S.SKINS;
  if (!joined) store.set('skin', mySkin);
  $('skinName').textContent = `${SKIN[mySkin].name} · ${mySkin + 1} von ${S.SKINS}`;
  if (pv.g) pv.scene.remove(pv.g);
  pv.g = makeSoldier(mySkin, '', pv.scene);
  pv.g.label.visible = false;
}
showSkin(mySkin);
$('prevSkin').addEventListener('click', () => showSkin(mySkin - 1));
$('nextSkin').addEventListener('click', () => showSkin(mySkin + 1));

async function start(name) {
  ac ??= new AudioContext();
  canvas.requestPointerLock()?.catch?.(() => status('Maus liess sich nicht fangen. Nochmal auf Spielen klicken.', true));
  if (link) return;
  store.set('name', name);
  await boardReady;
  if (!link) (serverOk ? connect : startSolo)(name);
}
$('join').addEventListener('submit', (e) => { e.preventDefault(); start(nameInput.value.trim()); });

// ---------- input ----------
addEventListener('keydown', (e) => {
  if (!locked || chatting) return;           // while the menu or the chat is open, keys belong to the text field
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); scoreboard(true); }
  if (e.code === 'Space') e.preventDefault();
  const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
  if (n >= 0) setWeapon(n);
  if (e.code === 'KeyR') reload();
  if (e.code === 'KeyV') { third = !third; store.set('third', third ? '1' : '0'); }
  if (e.code === 'Enter') { e.preventDefault(); openChat(); }
});
addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'Tab') scoreboard(false); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; firing = ads = false; });
addEventListener('wheel', (e) => { if (locked) setWeapon(weapon + Math.sign(e.deltaY)); });
addEventListener('mousedown', (e) => { if (!locked) return; if (e.button === 0) firing = true; if (e.button === 2) ads = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; if (e.button === 2) ads = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', (e) => {
  if (!locked) return;
  const k = sens * 0.0005 * camera.fov / FOV;            // slower while zoomed in
  yaw -= e.movementX * k;
  pitch = clamp(pitch - e.movementY * k, -1.55, 1.55);
});
function setLocked(on) {
  locked = on;
  $('overlay').classList.toggle('hidden', on);
  if (!on) { firing = ads = false; for (const k in keys) keys[k] = false; closeChat(); loadBoard(); }
}
document.addEventListener('pointerlockchange', () => setLocked(document.pointerLockElement === canvas));

const chatInput = $('chat');
function openChat() {
  if (solo) return feed(['Chat gibt es nur im Mehrspieler.']);
  chatting = true; firing = ads = false;
  for (const k in keys) keys[k] = false;
  chatInput.hidden = false; chatInput.value = ''; chatInput.focus();
}
function closeChat() { chatting = false; chatInput.hidden = true; chatInput.blur(); }
chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { const text = chatInput.value.trim(); if (text) send({ t: 'chat', text }); closeChat(); }
  else if (e.key === 'Escape') closeChat();
});
chatInput.addEventListener('keyup', (e) => e.stopPropagation());

// ---------- network: a real server, or the same rules running in this browser ----------
let link = null;                             // { send(msg) } once a game is running
const send = (m) => link?.send(m);
function connect(name) {
  status('Verbinde...');
  const ws = new WebSocket(BASE.replace(/^http/, 'ws'));
  link = { send: (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); } };
  ws.onopen = () => send({ t: 'join', name, skin: mySkin });
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (!joined) { link = null; return startSolo(name); }        // server gone before we got in: play solo instead
    joined = false; link = null; document.exitPointerLock();
    status('Verbindung weg. Lade neu...', true);
    setTimeout(() => location.reload(), 2500);
  };
}
function startSolo(name) {
  solo = true;
  const game = createGame({
    send: (_, m) => queueMicrotask(() => onMessage(m)),
    onKill(who) { const b = soloBoard(); b.kills[who] = (Number.isInteger(b.kills[who]) ? b.kills[who] : 0) + 1; store.set('soloBoard', JSON.stringify(b)); },
  });
  const player = game.join({}, name, mySkin);
  link = { send: (m) => game.message(player, m) };
  setInterval(game.tick, TICK_MS);
}
const nameOf = (id) => (id === myId ? myName : names.get(id) ?? 'Jemand');

function onMessage(m) {
  if (m.t === 'hello') {
    myId = m.id; myName = m.name; me.pos = [...m.p]; joined = true;
    buildMap(m.map);
    nameInput.value = m.name; nameInput.disabled = true; $('play').textContent = 'Weiter';
    $('prevSkin').disabled = $('nextSkin').disabled = true;       // the character is fixed for this visit
    const wished = SKIN[mySkin].name;
    if (m.skin !== mySkin) showSkin(m.skin);
    $('hud').classList.remove('menu');
    status(`Du spielst als ${m.name}, Charakter ${SKIN[m.skin].name}${wished !== SKIN[m.skin].name ? ` (${wished} war schon vergeben)` : ''}${solo ? ', solo gegen einen Bot' : ''}.`);
  } else if (m.t === 'snap') onSnap(m);
  else if (m.t === 'shot') onRemoteShot(m);
  else if (m.t === 'pos') { me.pos = [...m.p]; me.vel = [0, 0, 0]; }      // the game did not accept where I said I was
  else if (m.t === 'spawn') {
    me.pos = [...m.p]; me.vel = [0, 0, 0]; dead = false; $('dead').style.display = 'none';
    S.WEAPONS.forEach((w, i) => { ammo[i] = w.mag; });
    reloadAt = 0; renderGun();
  } else if (m.t === 'info') feed([m.text]);
  else if (m.t === 'chat') feed([el('b', { textContent: `${nameOf(m.id)}:` }), m.text], m.id === myId);
  else if (m.t === 'pick') { if (m.id === myId) { sfx.vest(); feed(['Weste angelegt'], true); } }
  else if (m.t === 'win') {
    banner(`${m.name} gewinnt · Neue Runde`, 4500);
    buildMap(m.map); streak = 0;
  } else if (m.t === 'kill') {
    const own = m.killer === m.victim, mine = m.killer === myId || m.victim === myId;
    feed([nameOf(m.killer), el('em', { textContent: S.WEAPONS[m.w]?.short ?? '' }), nameOf(m.victim)], mine);
    if (m.killer === myId && !own) {
      sfx.kill(); flash('hitmark', 'on head');
      if (STREAKS[++streak]) banner(STREAKS[streak], 1600);
    }
    if (m.victim === myId) {
      dead = true; firing = ads = false; streak = 0; reloadAt = 0;
      $('dead').textContent = `Ausgeschaltet von ${nameOf(m.killer)}. Gleich geht es weiter.`;
      $('dead').style.display = 'block';
    }
  }
}

function onSnap(m) {
  const seen = new Set();
  pickupsOn = m.pk;
  for (const p of m.players) {
    names.set(p.id, p.name);
    if (p.id === myId) {
      if (p.hp < hp || p.a < armor) { flash('vignette'); sfx.hurt(); shake = Math.max(shake, 0.05); }
      hp = p.hp; armor = p.a; myStats = { name: `${p.name} (du)`, k: p.k, d: p.d };
      continue;
    }
    seen.add(p.id);
    let r = remotes.get(p.id);
    if (!r) {
      r = { g: makeSoldier(p.skin, p.name), skin: p.skin, pos: new THREE.Vector3(p.x, p.y, p.z), yaw: p.yaw, pitch: 0, steps: 0, down: false, radar: 0 };
      remotes.set(p.id, r);
    }
    r.spd = r.target ? Math.hypot(p.x - r.target[0], p.z - r.target[2]) / (TICK_MS / 1000) : 0;
    if (p.hp > 0 && r.down) r.pos.set(p.x, p.y, p.z);          // back up at the new spawn
    Object.assign(r, { target: [p.x, p.y, p.z], tyaw: p.yaw, tpitch: p.pitch, crouch: p.c, w: p.w, hp: p.hp, name: p.name, k: p.k, d: p.d, down: p.hp <= 0 });
  }
  for (const [id, r] of remotes) if (!seen.has(id) && id < 9000) { scene.remove(r.g); remotes.delete(id); }   // 9000+: local preview dummy
  const humans = m.players.filter((p) => !p.bot).length;
  $('room').textContent = solo ? `${curMap.name} · Solo gegen einen Bot` : `${curMap.name} · Raum ${m.room} · ${humans}/${S.MAX_PLAYERS} Spieler`;
}

function onRemoteShot(m) {
  const o = V(m.o), d = V(m.d).normalize(), W = S.WEAPONS[m.w];
  if (!W) return;
  const shooter = remotes.get(m.id);
  if (shooter) { shooter.shotT = 0.35; if (!W.melee) shooter.radar = 2.5; }      // attack animation; gunfire shows on the minimap
  sfx.shot(m.w, camera.position.distanceTo(o));
  if (W.melee) return;
  const t = S.rayBoxes(m.o, d.toArray(), 120, curMap), end = o.clone().addScaledVector(d, t);
  tracer(o.clone().addScaledVector(d, 0.6).setY(o.y - 0.25), end);
  if (t < 120) impact(end, d);
}

// ---------- shooting ----------
const jitter = (dir, s) => dir.clone().add(new THREE.Vector3(rnd(s), rnd(s), rnd(s))).normalize();
const KICK = [0, 0.035, 0.014, 0.02];

// Bullets leave from my eye. In shoulder view they fly to whatever the crosshair is on.
function aimFromEye() {
  camera.getWorldDirection(aimDir);
  if (tpT < 0.05) return;
  const co = camera.position.toArray(), cd = aimDir.toArray();
  let t = S.rayBoxes(co, cd, 150, curMap);
  for (const r of remotes.values()) {
    if (r.hp <= 0) continue;
    const b = S.playerBox(r.pos.toArray(), r.crouch);
    t = Math.min(t, S.rayAABB(co, cd, b.min, b.max));
  }
  const to = camera.position.clone().addScaledVector(aimDir, t).sub(eye);
  if (to.length() > 2 && to.dot(aimDir) > 0) aimDir.copy(to.normalize());
}

function fire(now) {
  const W = S.WEAPONS[weapon];
  if (now < nextFire || reloadAt || (W.mag && ammo[weapon] <= 0)) return;
  nextFire = now + W.interval;
  if (W.mag) { ammo[weapon]--; renderGun(); }
  burst = now - lastShotAt < 0.3 ? burst + 1 : 0; lastShotAt = now;
  aimFromEye();
  const o = eye.clone(), dir = W.melee ? aimDir.clone() : jitter(aimDir, spread + (weapon === S.RIFLE ? Math.min(burst, 10) * 0.0012 : 0));
  send({ t: 'shot', w: weapon, o: o.toArray(), d: dir.toArray() });   // the bullet's real line: the game checks a hit against it
  sfx.shot(weapon, 0);
  self.shotT = 0.35;

  const oa = o.toArray(), da = dir.toArray(), reach = W.melee ?? 150;
  let t = S.rayBoxes(oa, da, reach, curMap), target = null, head = false;
  for (const [id, r] of remotes) {
    if (r.hp <= 0) continue;
    const b = S.playerBox(r.pos.toArray(), r.crouch);
    if (W.melee) for (const k of [0, 2]) { b.min[k] -= 0.35; b.max[k] += 0.35; }      // a knife is swung, not aimed
    const tt = S.rayAABB(oa, da, b.min, b.max);
    if (tt < t) { t = tt; target = id; head = oa[1] + da[1] * tt > b.max[1] - 0.4; }
  }
  const end = o.clone().addScaledVector(dir, t);
  if (W.melee) {
    vmKick = -0.24;                                      // the blade lunges forward
    if (target === null && t < reach) sparks(end, 4, 0xffc36b);
  } else {
    // Recoil: the view climbs and drifts, then settles. Holding the trigger means pulling down.
    const k = KICK[weapon] * (ads ? 0.7 : 1);
    kickP += k; kickY += rnd(k * 0.3) + (weapon === S.RIFLE ? Math.sin(burst * 0.7) * 0.004 : 0);
    vmKick = 0.05 + k; flashT = 0.045; flashLight.intensity = 14;
    const muzzle = tpT > 0.5 ? o.clone().addScaledVector(dir, 0.7).setY(o.y - 0.25)
      : new THREE.Vector3(0, 0.005, vmModels[weapon].muzzle).add(vm.position).applyMatrix4(camera.matrixWorld);
    tracer(muzzle, end);
    if (target === null) { if (t < reach) impact(end, dir); } else puff(end, 0.18, 0.35, 0xd8d2c8, 0.2, 2, 0.4);
  }
  if (target === null) return;
  head &&= W.head > 1;
  send({ t: 'hit', id: target, head });
  flash('hitmark', head ? 'on head' : 'on'); sfx.hit(head);
  dmgNumber(Math.round(W.dmg * (head ? W.head : 1) * S.falloff(W, t)), head);
}

// ---------- main loop ----------
let last = performance.now(), sendAt = 0;
function frame(t) {
  requestAnimationFrame(frame);
  step(t);
}
function step(t) {
  const dt = clamp((t - last) / 1000, 0, 0.05), now = t / 1000;
  last = t;
  const W = S.WEAPONS[weapon], ease = 1 - Math.exp(-dt * 14);

  let strafe = 0, speed = 0;
  if (joined && !dead) {
    const k = (c) => (locked && !chatting && keys[c] ? 1 : 0);
    strafe = k('KeyD') - k('KeyA');
    const aiming = ads && !reloadAt && !W.melee;
    // Aiming slows you down, the knife in your hand makes you a little faster.
    const inp = { f: k('KeyW') - k('KeyS'), s: strafe, yaw, jump: !!k('Space'), crouch: !!(k('ShiftLeft') || k('KeyC')), speed: aiming ? 0.6 : W.melee ? 1.12 : 1 };
    const before = [...me.pos];
    const ev = S.simulate(me, inp, dt, curMap);
    if (ev) sfx[ev]?.();
    speed = Math.hypot(me.vel[0], me.vel[2]);
    const rise = me.pos[1] - before[1];
    if (me.ground && rise > 0.05 && rise < 0.5) stepOff -= rise;        // kerb or stair: glide up instead of popping
    if (me.ground && me.slide <= 0) {                                  // footsteps
      stepDist += Math.hypot(me.pos[0] - before[0], me.pos[2] - before[2]);
      if (stepDist > 2.3) { stepDist = 0; if (!me.crouch) sfx.step(0); }
    }
    adsT += ((aiming ? 1 : 0) - adsT) * (1 - Math.exp(-dt * 16));
    // Accuracy: best standing still and aiming, worse running, worst in the air. Crouching steadies.
    const move = me.ground ? speed * 0.0022 : 0.03;
    spread = (lerp(W.spread, W.adsSpread, adsT) + move) * (me.crouch && me.slide <= 0 ? 0.6 : 1);
    if (reloadAt && now >= reloadAt) { ammo[weapon] = W.mag; reloadAt = 0; sfx.reloaded(); renderGun(); }
    if (W.mag && ammo[weapon] <= 0) reload();            // empty magazine reloads by itself
    const fov = lerp(FOV + clamp((speed - 7.5) * 1.4, 0, 18), FOV / W.zoom, adsT);
    camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * 12));
    camera.updateProjectionMatrix();
    $('speed').textContent = `${Math.round(speed * 3.6)} km/h`;
    $('cross').style.setProperty('--gap', `${3 + (W.melee ? 0 : spread * 420)}px`);
    for (const b of crossBars) b.style.opacity = 1 - adsT;
    $('vitals').classList.toggle('low', hp <= 35);
  }

  if (joined) {
    eyeH += ((me.crouch ? S.CROUCH_EYE : S.EYE) - eyeH) * ease;
    roll += (-strafe * 0.012 - (me.slide > 0 ? 0.05 : 0) - roll) * ease;
    kickP *= Math.exp(-dt * 7); kickY *= Math.exp(-dt * 7); stepOff *= Math.exp(-dt * 14);
    eye.set(me.pos[0], me.pos[1] + eyeH + stepOff, me.pos[2]);
    // Shoulder view: the camera sits behind and beside me, pulled in when a wall is in the way or when I aim.
    tpT += ((third ? (dead ? 1 : 1 - adsT) : 0) - tpT) * ease;
    camera.position.copy(eye);
    camera.rotation.set(pitch + kickP, yaw + kickY, roll);
    if (tpT > 0.01) {
      camera.updateMatrixWorld();
      const off = new THREE.Vector3(0.55, 0.3, 3.2).multiplyScalar(tpT).applyQuaternion(camera.quaternion), len = off.length();
      const room = S.rayBoxes(eye.toArray(), off.clone().normalize().toArray(), len + 0.3, curMap) - 0.3;
      camera.position.addScaledVector(off, clamp(room / len, 0, 1));
    }
    camera.position.x += rnd(shake); camera.position.y += rnd(shake); camera.position.z += rnd(shake);
    camera.updateMatrixWorld();
    if (!dead && firing && locked && !chatting) fire(now);
  } else {                                   // menu: slow flight around the map
    const r = curMap.half * 1.25;
    camera.position.set(Math.cos(now * 0.05) * r, curMap.half * 0.6, Math.sin(now * 0.05) * r);
    camera.lookAt(0, 3, 0);
    camera.updateMatrixWorld();
  }
  shake *= Math.exp(-dt * 9);
  sky.position.copy(camera.position);
  flashLight.position.copy(eye); flashLight.intensity *= Math.exp(-dt * 30);

  // my own body, only in shoulder view
  const showBody = joined && tpT > 0.3;
  if (showBody && !self.g) { self.g = makeSoldier(mySkin, myName); self.g.label.visible = false; }
  if (self.g) {
    self.g.visible = showBody;
    if (showBody) {
      Object.assign(self, { spd: speed, down: dead, crouch: me.crouch, pitch, w: weapon });
      self.g.position.set(me.pos[0], me.pos[1], me.pos[2]); self.g.rotation.y = yaw;
      animateSoldier(self.g, self, dt, ease);
    }
  }

  // view model: hip or aiming pose, dips for reloading, kicks back when firing
  const model = vmModels[weapon];
  vmKick *= Math.exp(-dt * 16);
  vm.position.set(lerp(HIP.x, 0, adsT), lerp(HIP.y, -model.sight, adsT) - (reloadAt ? 0.22 : 0) * (1 - adsT), lerp(HIP.z, -0.3, adsT) + vmKick);
  vm.rotation.set(vmKick * 0.9 + (reloadAt ? -0.5 : 0), lerp(0.04, 0, adsT), 0);
  flashT -= dt;
  muzzleFlash.visible = flashT > 0;
  if (flashT > 0) { muzzleFlash.position.set(0, 0.005, model.muzzle - 0.04); muzzleFlash.scale.setScalar(0.16 + Math.random() * 0.1); }

  for (const r of remotes.values()) {
    // ponytail: simple smoothing toward the last snapshot. Buffered interpolation if it ever looks rubbery.
    r.pos.lerp(V(r.target), 1 - Math.exp(-dt * 16));
    r.yaw += Math.atan2(Math.sin(r.tyaw - r.yaw), Math.cos(r.tyaw - r.yaw)) * ease;
    r.pitch += (r.tpitch - r.pitch) * ease;
    r.radar = Math.max(0, r.radar - dt);
    r.g.position.copy(r.pos); r.g.rotation.y = r.yaw;
    animateSoldier(r.g, r, dt, ease);
    r.g.label.visible = !r.down;
    r.steps += r.down || r.crouch ? 0 : r.spd * dt;
    if (r.steps > 2.3) { r.steps = 0; sfx.step(camera.position.distanceTo(r.pos)); }
  }
  smokeT += dt;
  if (smokeT > 0.4) {                        // wrecks and burning drums keep smoking
    smokeT = 0;
    for (const p of smokers) puff(p.clone().add(new THREE.Vector3(rnd(0.15), 0, rnd(0.15))), 0.8, 3.2, 0x1c1b1a, 1.5, 2.8, 0.5);
  }
  if (!locked && pv.g) {                     // menu open: turn the character preview
    pv.g.rotation.y = Math.PI + Math.sin(now * 0.5) * 0.9;
    animateSoldier(pv.g, pv.st, dt, ease);
    pv.renderer.render(pv.scene, pv.camera);
  }
  vests.forEach((v, i) => { v.visible = !!pickupsOn[i]; v.rotation.y = now * 1.5; v.position.y = v.base + Math.sin(now * 2.5 + i) * 0.08; });
  for (let i = fx.length - 1; i >= 0; i--) if (!fx[i](dt)) fx.splice(i, 1);

  if (joined && !dead && t > sendAt) {
    sendAt = t + TICK_MS;
    const r2 = (n) => Math.round(n * 100) / 100;
    send({ t: 's', x: r2(me.pos[0]), y: r2(me.pos[1]), z: r2(me.pos[2]), yaw: r2(yaw), pitch: r2(pitch), c: me.crouch, w: weapon });
  }
  if (joined) {
    $('hp').textContent = hp; $('hpbar').style.setProperty('--hp', `${hp}%`);
    $('arbar').style.setProperty('--a', `${armor}%`); $('vest').textContent = armor ? `Weste ${armor}` : '';
    drawMinimap();
  }

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  if (joined && !dead && tpT < 0.3) renderer.render(vmScene, vmCamera);
}
buildMap(0);
requestAnimationFrame(frame);

// Debug handle for the browser console and automated checks (pointer lock needs a real click).
window.game = {
  me, remotes, keys, setWeapon, reload,
  get state() {
    return { myId, joined, solo, dead, hp, armor, weapon, yaw, pitch, locked, ads, third, map: curMap.name,
      model: swat ? { scale: +swat.scale.toFixed(3), clips: swat.clips.size } : null, ammo: [...ammo], reloading: !!reloadAt, ...myStats };
  },
  async join(name) { await boardReady; if (!link) (serverOk ? connect : startSolo)(name); },
  drive(on) { setLocked(on); },
  look(y, p) { yaw = y; pitch = p; },
  shoot(on) { firing = on; },
  aim(on) { ads = on; },
  shoulder(on) { third = on; },
  map(i) { buildMap(i); },                  // preview a map locally (the game keeps its own)
  // Puts a soldier that only I can see 3 m in front of me, to look at the model. pose: 'run', 'shoot', 'dead' or nothing.
  dummy(pose) {
    const id = 9000, x = me.pos[0] - Math.sin(yaw) * 3, z = me.pos[2] - Math.cos(yaw) * 3;
    let r = remotes.get(id);
    if (!r) { r = { g: makeSoldier((mySkin + 1) % S.SKINS, 'Modell'), skin: (mySkin + 1) % S.SKINS, pos: new THREE.Vector3(), pitch: 0, steps: 0, radar: 0, k: 0, d: 0, name: 'Modell' }; remotes.set(id, r); }
    Object.assign(r, { target: [x, me.pos[1], z], yaw: yaw + Math.PI * 0.8, tyaw: yaw + Math.PI * 0.8, tpitch: 0, crouch: false,
      hp: pose === 'dead' ? 0 : 100, down: pose === 'dead', spd: pose === 'run' ? 6 : 0, shotT: pose === 'shoot' ? 99 : 0 });
    r.pos.set(x, me.pos[1], z);
    if (r.g.mixer) { r.g.play(pose === 'dead' ? 'Death' : pose === 'run' ? 'Run' : 'Idle'); r.g.mixer.update(pose === 'dead' ? 1.2 : 0.3); }
  },
  skin(i) { showSkin(i); },
  steps(n) { for (let i = 0; i < n; i++) step(last + 16); },     // run n frames right now (a hidden tab gets almost none)
};
