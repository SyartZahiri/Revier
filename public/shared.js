// Shared by browser and server: the map, weapons, movement physics, ray tests.
// Positions are [x, y, z] in metres, y is up, pos is the centre of the feet.

export const MAX_PLAYERS = 10;
export const WIN_KILLS = 20;
export const SKINS = 10;                             // ten characters, every player in a room wears a different one
export const R = 0.35, HEIGHT = 1.8, CROUCH_HEIGHT = 1.1, EYE = 1.6, CROUCH_EYE = 0.95;
export const MAX_ARMOR = 100, ARMOR_PICKUP = 50;

// melee: reach in metres (no bullets). range: [full damage until, minimum from, minimum factor].
// zoom: field-of-view divisor when aiming. mag 0 = never reloads.
export const WEAPONS = [
  { name: 'Messer', short: 'Messer', dmg: 55, head: 1, interval: 0.5, melee: 2.3, spread: 0, adsSpread: 0, mag: 0, reload: 0, zoom: 1 },
  { name: 'Pistole', short: 'Pistole', dmg: 28, head: 2, interval: 0.2, spread: 0.008, adsSpread: 0.002, mag: 12, reload: 1.4, zoom: 1.25, range: [18, 45, 0.6] },
  { name: 'Maschinenpistole', short: 'MP', dmg: 17, head: 1.5, interval: 0.07, spread: 0.013, adsSpread: 0.005, mag: 30, reload: 1.8, zoom: 1.2, range: [14, 35, 0.5] },
  { name: 'Sturmgewehr', short: 'Gewehr', dmg: 24, head: 2, interval: 0.1, spread: 0.006, adsSpread: 0.0012, mag: 30, reload: 2.0, zoom: 1.35, range: [25, 60, 0.7] },
];
export const RIFLE = 3;                              // what bots carry and what everybody starts with

export function falloff(W, dist) {
  if (!W.range) return 1;
  const [full, far, min] = W.range;
  return dist <= full ? 1 : dist >= far ? min : 1 - (1 - min) * (dist - full) / (far - full);
}

// ---------- map ----------
// A map is a square arena of side 2 * half: boxes to collide with, marks that are only drawn
// (craters, smoke, writing, the duck), places where armour vests appear, and spawn points along the edge.
// Everything "random" comes from a fixed seed, so browser and server build exactly the same ruins.
function makeMap(name, ground, half, build) {
  const boxes = [], marks = [], pickups = [];
  let seed = 20261117;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const box = (cx, cz, w, d, h, mat = 'concrete', y0 = 0, tint = 0) =>
    boxes.push({ min: [cx - w / 2, y0, cz - d / 2], max: [cx + w / 2, y0 + h, cz + d / 2], mat, tint });
  const mark = (type, x, z, extra = {}) => marks.push({ type, x, z, y: 0, ...extra });
  for (const s of [-1, 1]) {
    box(0, s * (half + 0.5), 2 * half + 2, 1, 6, 'wall');
    box(s * (half + 0.5), 0, 1, 2 * half + 2, 6, 'wall');
  }
  build({
    box, mark, rand,
    pickup: (x, y, z) => pickups.push([x, y, z]),
    // Steps of 0.3 m rising along +x (dir 1) or -x (dir -1): players simply walk up.
    stairs(x0, cz, dir, n, width, mat = 'concrete') {
      for (let i = 0; i < n; i++) box(x0 + dir * i * 0.4, cz, 0.4, width, 0.3 * (i + 1), mat);
    },
    // A shelled house: four walls in pieces. Each piece is solid, a window, a stub, or a doorway.
    // doors: sides with a doorway in the middle, any of 'n' (-z), 's' (+z), 'w' (-x), 'e' (+x).
    ruin(cx, cz, w, d, h, doors, mat = 'plaster') {
      const T = 0.5;
      const side = (name, alongX, fixed, from, to) => {
        const len = to - from, n = Math.max(2, Math.round(len / 2.2)), piece = len / n;
        for (let i = 0; i < n; i++) {
          const mid = from + piece * (i + 0.5), put = (hh, y0 = 0) => (alongX ? box(mid, fixed, piece, T, hh, mat, y0) : box(fixed, mid, T, piece, hh, mat, y0));
          if (doors.includes(name) && i === Math.floor(n / 2)) continue;          // doorway
          const r = rand(), top = h * (rand() < 0.45 ? 0.55 + rand() * 0.35 : 1);
          if (i === 0 || i === n - 1 || r > 0.55) put(top);                       // solid, corners always stand
          else if (r > 0.2) { put(1.0); if (top > 2.7) put(top - 2.3, 2.3); }     // window: sill and lintel
          else put(0.4 + rand() * 0.7);                                           // shot away down to a stub
        }
      };
      side('n', true, cz - d / 2 + T / 2, cx - w / 2, cx + w / 2);
      side('s', true, cz + d / 2 - T / 2, cx - w / 2, cx + w / 2);
      side('w', false, cx - w / 2 + T / 2, cz - d / 2 + T, cz + d / 2 - T);
      side('e', false, cx + w / 2 - T / 2, cz - d / 2 + T, cz + d / 2 - T);
    },
    // A heap of broken masonry: low enough to climb over, good to crouch behind.
    rubble(cx, cz, n, spread) {
      for (let i = 0; i < n; i++) {
        const s = 0.5 + rand() * 0.9;
        box(cx + (rand() - 0.5) * spread, cz + (rand() - 0.5) * spread, s, 0.5 + rand() * 0.8, 0.25 + rand() * 0.6, i % 2 ? 'plaster' : 'concrete');
      }
    },
    // An oil drum: drawn round, collides as a box. A burning one smokes.
    barrel(x, z, burning) {
      box(x, z, 0.6, 0.6, 0.9, 'none');
      mark('barrel', x, z, { burning });
      if (burning) mark('smoke', x, z, { y: 1 });
    },
    // A grave: a mound to step over and a stone at its far (+z) end. The writing faces -z, towards whoever walks up.
    grave(x, z, text, open) {
      if (open) mark('crater', x, z, { w: 0.5, d: 1.0, grave: true }); else box(x, z, 0.9, 1.9, 0.18, 'dirt');
      box(x, z + 1.15, 0.75, 0.2, 0.95, 'stone');
      if (text) mark('text', x, z + 1.04, { y: 0.55, w: 0.68, facing: 0, text });
    },
  });
  // Spawn points: a ring of candidates near the edge, minus the ones something stands on.
  const spawns = [], r = half - 3, m = R + 0.6;
  for (const s of [-1, 1]) for (let i = -2; i <= 2; i++) {
    for (const [x, z] of [[s * r, i * r * 0.4], [i * r * 0.4, s * r]]) {
      const free = !boxes.some((b) => b.max[1] > 0.45 && b.min[1] < 2.4 && x + m > b.min[0] && x - m < b.max[0] && z + m > b.min[2] && z - m < b.max[2]);
      if (free) spawns.push([x, z]);
    }
  }
  return { name, ground, half, boxes, marks, pickups, spawns };
}

// One map on purpose: everybody learns the same ground. The code takes more, rounds would rotate through them.
export const MAPS = [
  makeMap('Ruinen', 'mud', 34, ({ box, mark, pickup, stairs, ruin, rubble, barrel, grave }) => {     // a shelled village
    // knocked-out tank in the middle: hull, turret, gun barrel
    box(0, 0, 3.4, 7, 1.5, 'steel'); box(0, -0.4, 2.4, 2.8, 0.8, 'steel', 1.5); box(0, -4.2, 0.26, 5, 0.26, 'steel', 1.78);
    box(-1.95, 0, 0.5, 7.2, 0.95, 'steel', 0, 1); box(1.95, 0, 0.5, 7.2, 0.95, 'steel', 0, 1);          // tracks
    mark('smoke', 0, 2.4, { y: 1.6 });
    pickup(0, 2.3, -0.4);                                                             // on the turret

    // big house, north-west: an upper floor is left on one half, reached over a ramp of rubble steps
    ruin(-19, -17, 14, 11, 5.6, ['s', 'e']);
    box(-22.2, -17, 6.6, 10, 0.3, 'concrete', 3.0);
    stairs(-14.7, -20.5, -1, 11, 1.6, 'plaster');                                     // rises towards -x, the top step meets the floor edge
    mark('duck', -24.8, -21.4, { y: 3.3 });                                           // easter egg: the last duck of Quak Arena
    pickup(-23, 3.3, -14);
    mark('text', -11.98, -21, { y: 1.9, w: 1.9, facing: 1, text: '404:\nHaus nicht\ngefunden', paint: true });   // on the corner that still stands

    ruin(18, -19, 11, 10, 4.6, ['s', 'w']);                                           // north-east
    box(19, -20, 1.4, 1.4, 1.4, 'wood'); box(20.4, -20, 1.4, 1.4, 1.4, 'wood');
    ruin(-20, 17, 10, 12, 4.3, ['n', 'e']);                                           // south-west
    box(-21.5, 19, 2.2, 1, 0.8, 'wood');
    pickup(-20, 0, 17);
    ruin(19.5, 10.5, 8, 7, 5.2, ['s', 'w'], 'wall');                                  // chapel by the graveyard
    mark('text', 16.5, 14.02, { y: 1.9, w: 1.8, facing: 2, text: 'Kaltstart\nwar hier', paint: true });

    // graveyard, south-east, behind a low wall with a gap as its gate
    for (const [x, z, w, d] of [[18.3, 18, 5.6, 0.4], [28.2, 18, 6.6, 0.4], [15.5, 25, 0.4, 14], [31.5, 25, 0.4, 14], [23.5, 32, 16.4, 0.4]]) box(x, z, w, d, 0.9, 'stone');
    const EPITAPH = ['Bot Günther\n† Feierabend', 'Hier ruht\ndein K/D', 'Lag\n2009 – 2026', 'Kam ohne\nWeste', 'AFK', 'Nachladen\nvergessen', null, 'Frei.\nBewirb dich.'];
    let g = 0;
    for (const z of [22.4, 27.6]) for (const x of [18, 21.4, 24.8, 28.2]) { grave(x, z, EPITAPH[g], g === 7); g++; }   // the last one is still open
    box(30.2, 20.4, 0.45, 0.45, 4.6, 'bark'); box(30.9, 20.4, 1.5, 0.22, 0.22, 'bark', 3.1); box(29.7, 20.9, 0.22, 1.3, 0.22, 'bark', 3.8);   // dead tree
    pickup(23, 0, 21);

    // cover in the open: sandbags, rubble, drums, a few more dead trees
    for (const [x, z, w, d] of [[-7, 6.5, 4.4, 0.8], [7, -6.5, 4.4, 0.8], [-6.5, -9, 0.8, 4.4], [6.5, 9, 0.8, 4.4], [0, 22, 5, 0.8], [0, -24, 5, 0.8], [-28, 0, 0.8, 5], [27, -3, 0.8, 5]]) box(x, z, w, d, 1.0, 'sandbag');
    rubble(-10, -8, 7, 4); rubble(10, 1, 6, 3.5); rubble(-9, 12, 6, 3.5); rubble(6, 21, 5, 3); rubble(-27, -27, 6, 4); rubble(28, -28, 5, 3.5); rubble(-1, -14, 5, 3);
    barrel(-4, 12, true); barrel(-3.2, 12.5, false); barrel(11, -12, true); barrel(-29, 9, false); barrel(26, 4, true);
    for (const [x, z, h] of [[-12, 2, 4.2], [13, -27, 3.6], [-30, -8, 4.8], [4, 29, 3.9]]) { box(x, z, 0.4, 0.4, h, 'bark'); box(x + 0.5, z, 1.1, 0.2, 0.2, 'bark', h * 0.7); }
    for (const [x, z, w] of [[-4, -5, 2.2], [9, 14, 2.8], [-15, 6, 2], [14, -4, 2.4], [-2, 16, 1.8], [22, -8, 2.6], [-24, 28, 2.2], [3, -29, 2]]) mark('crater', x, z, { w, d: w });
    pickup(-3, 0, -20); pickup(12, 0, 26);
  }),
];

// ---------- ray tests ----------
export function rayAABB(o, d, min, max) {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < min[i] || o[i] > max[i]) return Infinity; continue; }
    let a = (min[i] - o[i]) / d[i], b = (max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

// Distance along the ray to the first wall or the floor of `map`, at most `max`.
export function rayBoxes(o, d, max, map) {
  let t = max;
  if (d[1] < 0) t = Math.min(t, -o[1] / d[1]);
  for (const b of map.boxes) t = Math.min(t, rayAABB(o, d, b.min, b.max));
  return t;
}

export const playerBox = (pos, crouch) => ({
  min: [pos[0] - R, pos[1], pos[2] - R],
  max: [pos[0] + R, pos[1] + (crouch ? CROUCH_HEIGHT : HEIGHT), pos[2] + R],
});

// ---------- movement ----------
const G = 24, JUMP = 8.2, RUN = 7.5, CROUCH_SPEED = 3.6, ACCEL = 10, FRICTION = 6, STOP = 2.5;
const AIR_CAP = 1.2, AIR_ACCEL = 90;                 // low cap + high accel = air strafing, bunny hops
const SLIDE_SPEED = 11.5, SLIDE_FRICTION = 0.7, SLIDE_TIME = 0.9, SLIDE_CD = 1.2;
const WALL_KICK = 6.5, WALL_TIME = 0.2;
const STEP = 0.45;                                   // rubble and stairs up to this height are walked up, not jumped
const E = 1e-6;

export const newBody = (pos = [0, 0, 0]) => ({
  pos: [...pos], vel: [0, 0, 0], ground: false, crouch: false,
  slide: 0, slideCd: 0, jumpHeld: false,
  wallT: 0, wallN: [0, 0], lastWall: 0,     // wall jump: time since touching a wall, its normal, the wall used last
});

const overlaps = (b, pos, h) =>
  pos[0] + R > b.min[0] + E && pos[0] - R < b.max[0] - E &&
  pos[1] + h > b.min[1] + E && pos[1] < b.max[1] - E &&
  pos[2] + R > b.min[2] + E && pos[2] - R < b.max[2] - E;

function moveAxis(p, axis, delta, h, boxes) {
  p.pos[axis] += delta;
  for (const b of boxes) {
    if (!overlaps(b, p.pos, h)) continue;
    if (axis === 1) {
      if (delta > 0) p.pos[1] = b.min[1] - h; else { p.pos[1] = b.max[1]; p.ground = true; }
    } else {
      const lift = b.max[1] - p.pos[1], y = p.pos[1];
      if (lift <= STEP) {                              // low enough: step up, if there is room on top
        p.pos[1] = b.max[1];
        if (!boxes.some((o) => overlaps(o, p.pos, h))) continue;
        p.pos[1] = y;
      }
      p.pos[axis] = delta > 0 ? b.min[axis] - R : b.max[axis] + R;
      const n = delta > 0 ? -1 : 1;
      p.wallT = WALL_TIME; p.wallN = axis === 0 ? [n, 0] : [0, n];
    }
    p.vel[axis] = 0;
  }
}

function accelerate(v, wx, wz, wishSpeed, amount) {
  const add = wishSpeed - (v[0] * wx + v[2] * wz);
  if (add <= 0) return;
  const a = Math.min(amount, add);
  v[0] += a * wx; v[2] += a * wz;
}

function friction(v, f, stop, dt) {
  const speed = Math.hypot(v[0], v[2]);
  if (speed < 0.01) { v[0] = v[2] = 0; return; }
  const k = Math.max(speed - Math.max(speed, stop) * f * dt, 0) / speed;
  v[0] *= k; v[2] *= k;
}

function startSlide(p) {
  const speed = Math.hypot(p.vel[0], p.vel[2]);
  if (speed < 5) return null;
  p.slide = SLIDE_TIME;
  if (p.slideCd <= 0 && speed < SLIDE_SPEED) {       // boost only once per cooldown
    p.vel[0] *= SLIDE_SPEED / speed; p.vel[2] *= SLIDE_SPEED / speed;
    p.slideCd = SLIDE_CD;
  }
  return 'slide';
}

// inp: { f, s: -1..1, yaw, jump, crouch, speed?: multiplier }
function step(p, inp, dt, map) {
  let ev = null;
  const boxes = map.boxes, v = p.vel, sin = Math.sin(inp.yaw), cos = Math.cos(inp.yaw);
  let wx = -sin * inp.f + cos * inp.s, wz = -cos * inp.f - sin * inp.s;
  const wl = Math.hypot(wx, wz);
  if (wl > 0) { wx /= wl; wz /= wl; }

  if (inp.crouch && !p.crouch) { p.crouch = true; if (p.ground) ev = startSlide(p); }
  else if (!inp.crouch && p.crouch && !boxes.some((b) => overlaps(b, p.pos, HEIGHT))) { p.crouch = false; p.slide = 0; }
  p.slideCd -= dt; p.wallT -= dt;

  // Jump runs before friction, so holding jump keeps your speed (bunny hop).
  if (inp.jump) {
    const wall = p.wallN[0] * 2 + p.wallN[1];          // one number per wall direction
    if (p.ground) { v[1] = JUMP; p.ground = false; p.slide = 0; ev = 'jump'; }
    else if (!p.jumpHeld && p.wallT > 0 && wall !== p.lastWall) {
      // Wall jump: kick away from the wall. The same wall twice in a row is not allowed, so no climbing one wall.
      v[1] = JUMP; v[0] += p.wallN[0] * WALL_KICK; v[2] += p.wallN[1] * WALL_KICK;
      p.wallT = 0; p.lastWall = wall; ev = 'wjump';
    }
  }
  p.jumpHeld = !!inp.jump;

  const max = (p.crouch ? CROUCH_SPEED : RUN) * (inp.speed ?? 1);
  if (p.ground) {
    if (p.slide > 0) {
      p.slide -= dt;
      friction(v, SLIDE_FRICTION, 0, dt);
      if (wl > 0) accelerate(v, wx, wz, AIR_CAP, AIR_ACCEL * dt);
      if (Math.hypot(v[0], v[2]) < 4) p.slide = 0;
    } else {
      friction(v, FRICTION, STOP, dt);
      if (wl > 0) accelerate(v, wx, wz, max, ACCEL * max * dt);
    }
  } else if (wl > 0) accelerate(v, wx, wz, Math.min(max, AIR_CAP), AIR_ACCEL * dt);
  v[1] -= G * dt;

  const h = p.crouch ? CROUCH_HEIGHT : HEIGHT, was = p.ground;
  p.ground = false;
  moveAxis(p, 0, v[0] * dt, h, boxes); moveAxis(p, 2, v[2] * dt, h, boxes); moveAxis(p, 1, v[1] * dt, h, boxes);
  if (p.pos[1] <= 0) { p.pos[1] = 0; if (v[1] < 0) v[1] = 0; p.ground = true; }
  const lim = map.half - R;                             // nobody leaves the arena, even flying over the walls
  p.pos[0] = Math.min(lim, Math.max(-lim, p.pos[0])); p.pos[2] = Math.min(lim, Math.max(-lim, p.pos[2]));

  if (p.ground && !was) { p.lastWall = 0; ev = (p.crouch && startSlide(p)) || ev || 'land'; }
  return ev;
}

// Advance a body by dt in small sub-steps on `map`. Returns the last movement event (for sounds) or null.
export function simulate(p, inp, dt, map) {
  const n = Math.max(1, Math.ceil(dt / 0.0085));
  let ev = null;
  for (let i = 0; i < n; i++) ev = step(p, inp, dt / n, map) || ev;
  return ev;
}
