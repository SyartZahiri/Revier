// The game rules: rooms, the bot, damage, armour, rounds. No network and no files in here,
// so the same code runs in the Node server (multiplayer) and in the browser (solo play on a static host).
// ponytail: players report their own position and what they hit. The rules below check that a hit is
// plausible (a shot was fired from where the player stands, towards the target, with nothing solid in between),
// but they do not replay the movement. Upgrade path: simulate players here from their inputs and rewind for hits.
import * as S from './shared.js';

export const TICK_MS = 50;
const RESPAWN = 2500, BOT_DMG = 11, PICKUP_RESPAWN = 20000;
const PROTECT = 1500;   // ms of invulnerability after (re)spawning; ends early when you shoot
const REACH = 3;        // a shot may start this far from where the server last saw the shooter (m): one tick of sprinting plus the eye height
const LAG = 1.2;        // how far a target may be from where the shooter saw it (m)
const TOP_SPEED = 18;   // m/s over the ground: nobody is faster, not even sliding into a bunny hop
const MOVE_CAP = 20;    // metres a player may have saved up after a pause (lag, hidden tab)
const BOT_NAME = 'Bot Günther';
const ADJ = ['Stiller', 'Schneller', 'Kalter', 'Grauer', 'Wacher', 'Rauer', 'Leiser', 'Harter'];
const NOUN = ['Falke', 'Wolf', 'Luchs', 'Rabe', 'Dachs', 'Marder', 'Bussard', 'Keiler'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const isNum = (...v) => v.every((n) => typeof n === 'number' && Number.isFinite(n));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const vec3 = (a) => Array.isArray(a) && a.length === 3 && isNum(...a);

export function weekKey(d = new Date()) {              // ISO week, e.g. 2026-W47; a new week starts Monday 00:00 UTC
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// Text from strangers: names keep letters, digits and a few signs, 2 to 16 characters.
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFKC').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
  return n.length >= 2 && !/^bot\b/i.test(n) ? n : null;
}
// Chat lines lose control characters and are cut to 80 characters. Shown as plain text, never as HTML.
export function cleanChat(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.normalize('NFKC').replace(/\p{C}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return t || null;
}

// ---------- path finding for the bot ----------
// A grid of 1 m cells per map. A breadth-first search from the target fills every reachable cell
// with its distance; the bot always steps to the neighbour with the smallest number.
function buildGrid(map) {
  const N = map.half * 2, blocked = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const x = (i % N) - map.half + 0.5, z = Math.floor(i / N) - map.half + 0.5;
    // Things up to 1.25 m are hopped over; anything taller that reaches below head height blocks the cell.
    blocked[i] = map.boxes.some((b) => b.max[1] > 1.25 && b.min[1] < 1.8 &&
      x + 0.5 + S.R > b.min[0] && x - 0.5 - S.R < b.max[0] && z + 0.5 + S.R > b.min[2] && z - 0.5 - S.R < b.max[2]) ? 1 : 0;
  }
  const cellOf = (x, z) => clamp(Math.floor(z + map.half), 0, N - 1) * N + clamp(Math.floor(x + map.half), 0, N - 1);
  return { N, blocked, cellOf };
}
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function flowField({ N, blocked, cellOf }, tx, tz) {
  const dist = new Int16Array(N * N).fill(-1), queue = [cellOf(tx, tz)];
  dist[queue[0]] = 0;                                   // the target cell counts as reachable even if it is blocked
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], cx = c % N, cz = (c - cx) / N;
    for (const [dx, dz] of NEIGHBOURS) {
      const nx = cx + dx, nz = cz + dz, n = nz * N + nx;
      if (nx < 0 || nz < 0 || nx >= N || nz >= N || blocked[n] || dist[n] >= 0) continue;
      dist[n] = dist[c] + 1; queue.push(n);
    }
  }
  return dist;
}

// Is `target` where this shot could have hit it? The shot is the line from shot.o along shot.d.
// Returns { dist, head } or null. Allowed slack: the body's size, the weapon's spread, and lag.
function onTarget(shot, target, W, map) {
  const h = target.crouch ? S.CROUCH_HEIGHT : S.HEIGHT, o = shot.o, d = shot.d;
  const c = [target.pos[0] - o[0], target.pos[1] + h / 2 - o[1], target.pos[2] - o[2]];
  const dist = Math.hypot(...c), along = c[0] * d[0] + c[1] * d[1] + c[2] * d[2];
  if (along <= 0) return null;                                              // behind the shooter
  if (W.melee && dist > W.melee + LAG) return null;                         // a knife does not reach across the yard
  const off = Math.sqrt(Math.max(0, dist * dist - along * along));          // how far the target is from the aim line
  if (off > h / 2 + 0.6 + LAG + along * (W.spread * 2 + 0.08)) return null;
  // Something solid in between? Look at head, middle and feet; one free line is enough.
  const seen = [h - 0.15, h / 2, 0.2].some((y) => {
    const v = [target.pos[0] - o[0], target.pos[1] + y - o[1], target.pos[2] - o[2]], l = Math.hypot(...v);
    return S.rayBoxes(o, v.map((n) => n / l), l, map) >= l - 0.6;
  });
  if (!seen) return null;
  return { dist, head: o[1] + d[1] * along > target.pos[1] + h - 0.9 };      // headshot only if the aim line is up there
}

// send(conn, msg) delivers a message object to one player's connection.
// onKill(name) is called when a human scores (for the leaderboard).
export function createGame({ send, onKill = () => {} }) {
  const rooms = [], grids = S.MAPS.map(buildGrid);
  let nextId = 1;
  const humans = (room) => [...room.players.values()].filter((p) => !p.bot);
  const mapOf = (room) => S.MAPS[room.map];
  const tell = (p, msg) => { if (p.conn) send(p.conn, msg); };
  const broadcast = (room, msg, except) => { for (const p of room.players.values()) if (p !== except) tell(p, msg); };

  function pickSpawn(room, self) {
    let best = null, bestD = -1;
    for (const sp of mapOf(room).spawns) {
      let d = 1000 + Math.random();                    // jitter breaks ties
      for (const q of room.players.values()) if (q !== self && !q.dead) d = Math.min(d, Math.hypot(q.pos[0] - sp[0], q.pos[2] - sp[1]));
      if (d > bestD) { bestD = d; best = sp; }
    }
    return [best[0], 0.4, best[1]];                     // a little above the ground: lands on whatever is there
  }

  // Every player in a room wears a different character: the one they asked for if it is free, else the next free one.
  function freeSkin(room, want) {
    const taken = new Set([...room.players.values()].map((q) => q.skin));
    if (Number.isInteger(want) && want >= 0 && want < S.SKINS && !taken.has(want)) return want;
    for (let i = 0; i < S.SKINS; i++) if (!taken.has(i)) return i;
    return 0;
  }

  function addPlayer(room, conn, name, bot = false, skin) {
    const p = {
      ...S.newBody(), id: nextId++, conn, bot, name, skin: freeSkin(room, skin),
      yaw: 0, pitch: 0, hp: 100, armor: 0, w: S.RIFLE, k: 0, d: 0, dead: false, respawnAt: 0, hurtAt: 0, safeUntil: Date.now() + PROTECT,
      lastShot: S.WEAPONS.map(() => 0), shot: null, chatAt: 0, reach: 3, movedAt: Date.now(),
      ai: { until: 0, s: 1, stuck: 0, dodge: 0, seenAt: 0, fireAt: 0, flow: null, flowAt: 0 },
    };
    p.pos = pickSpawn(room, p);
    room.players.set(p.id, p);
    return p;
  }

  // Exactly one human in the room -> one bot keeps them company. Zero or two and more -> no bot.
  function syncBot(room) {
    const n = humans(room).length;
    if (n === 0) { rooms.splice(rooms.indexOf(room), 1); return; }
    if (n === 1 && !room.bot) {
      room.bot = addPlayer(room, null, BOT_NAME, true);
      broadcast(room, { t: 'info', text: `${BOT_NAME} springt ein, bis jemand kommt` });
    } else if (n > 1 && room.bot) {
      room.players.delete(room.bot.id);
      room.bot = null;
      broadcast(room, { t: 'info', text: `${BOT_NAME} hat Feierabend` });
    }
  }

  function join(conn, rawName, skin) {
    let room = rooms.find((r) => humans(r).length < S.MAX_PLAYERS);
    if (!room) {
      let id = 1;
      while (rooms.some((r) => r.id === id)) id++;       // lowest free room number
      const map = (id - 1) % S.MAPS.length;
      room = { id, map, players: new Map(), bot: null, pickups: S.MAPS[map].pickups.map(() => 0) };
      rooms.push(room);
    }
    const p = addPlayer(room, conn, cleanName(rawName) ?? `${pick(ADJ)} ${pick(NOUN)}`, false, skin);
    p.room = room;
    tell(p, { t: 'hello', id: p.id, room: room.id, map: room.map, p: p.pos, name: p.name, skin: p.skin });
    broadcast(room, { t: 'info', text: `${p.name} ist da` }, p);
    syncBot(room);
    return p;
  }

  function leave(p) {
    const room = p.room;
    if (!room.players.delete(p.id)) return;
    broadcast(room, { t: 'info', text: `${p.name} ist weg` });
    syncBot(room);
  }

  // ---------- combat ----------
  function damage(room, victim, attacker, amount, w) {
    if (victim.dead || amount <= 0 || Date.now() < victim.safeUntil) return;
    let left = Math.round(amount);
    const absorbed = Math.min(victim.armor, left);     // the vest takes the hit first
    victim.armor -= absorbed; left -= absorbed;
    victim.hp -= left; victim.hurtAt = Date.now();
    if (victim.hp > 0) return;
    Object.assign(victim, { hp: 0, armor: 0, dead: true, respawnAt: Date.now() + RESPAWN, shot: null });
    victim.d++;
    if (attacker !== victim) {
      attacker.k++;
      if (!attacker.bot) onKill(attacker.name);
    }
    broadcast(room, { t: 'kill', killer: attacker.id, victim: victim.id, w });
    if (attacker.k >= S.WIN_KILLS) nextRound(room, attacker);
  }

  // Round over: announce the winner, everybody starts fresh (on the next map, if there were more than one).
  function nextRound(room, winner) {
    room.map = (room.map + 1) % S.MAPS.length;
    room.pickups = mapOf(room).pickups.map(() => 0);
    broadcast(room, { t: 'win', name: winner.name, map: room.map });
    for (const q of room.players.values()) {
      Object.assign(q, { k: 0, d: 0, hp: 100, armor: 0, dead: false, shot: null, vel: [0, 0, 0], reach: 3, movedAt: Date.now(), safeUntil: Date.now() + PROTECT });
      q.ai.flow = null;
      q.pos = pickSpawn(room, q);
      tell(q, { t: 'spawn', p: q.pos });
    }
  }

  function message(p, m) {
    const room = p.room, now = Date.now();
    if (!m || typeof m !== 'object' || !room.players.has(p.id)) return;
    if (m.t === 'chat') {
      const text = cleanChat(m.text);
      if (!text || now - p.chatAt < 800) return;         // at most one line every 0.8 s
      p.chatAt = now;
      return broadcast(room, { t: 'chat', id: p.id, text });
    }
    if (p.dead) return;
    const map = mapOf(room), half = map.half;
    if (m.t === 's') {
      if (!isNum(m.x, m.y, m.z, m.yaw, m.pitch)) return;
      // The position is the player's own claim. It is taken only if they could have got there:
      // no faster than TOP_SPEED since the last accepted step, and not inside a wall.
      const next = [clamp(m.x, -half, half), clamp(m.y, 0, 60), clamp(m.z, -half, half)];
      p.reach = Math.min(MOVE_CAP, p.reach + TOP_SPEED * (now - p.movedAt) / 1000); p.movedAt = now;
      const dist = Math.hypot(next[0] - p.pos[0], next[2] - p.pos[2]);
      if (dist > p.reach || S.blocked(map, next, !!m.c)) return tell(p, { t: 'pos', p: p.pos });   // put them back
      p.reach -= dist; p.pos = next;
      p.yaw = m.yaw; p.pitch = clamp(m.pitch, -1.6, 1.6); p.crouch = !!m.c;
      if (Number.isInteger(m.w) && S.WEAPONS[m.w]) p.w = m.w;
    } else if (m.t === 'shot') {                           // "I pulled the trigger": from where, in which direction
      const W = S.WEAPONS[m.w];
      if (!W || !Number.isInteger(m.w) || !vec3(m.o) || !vec3(m.d)) return;
      if (now - p.lastShot[m.w] < W.interval * 700) return;      // 30 % slack for network jitter
      const len = Math.hypot(...m.d);
      // A shot starts at the shooter's own eye, not somewhere convenient on the other side of a wall.
      if (len < 0.5 || len > 1.5 || Math.hypot(m.o[0] - p.pos[0], m.o[1] - p.pos[1] - 1.3, m.o[2] - p.pos[2]) > REACH) return;
      p.lastShot[m.w] = now; p.safeUntil = 0;
      p.shot = { w: m.w, o: m.o, d: m.d.map((n) => n / len), at: now, left: 1 };   // one bullet, one possible hit
      broadcast(room, { t: 'shot', id: p.id, w: m.w, o: m.o, d: p.shot.d }, p);
    } else if (m.t === 'hit') {                            // "that shot hit this player": believed only if it could have
      const target = room.players.get(m.id), shot = p.shot;
      if (!shot || shot.left < 1 || now - shot.at > 1000 || !target || target === p || target.dead) return;
      shot.left = 0;
      const W = S.WEAPONS[shot.w], aim = onTarget(shot, target, W, map);
      if (!aim) return;
      damage(room, target, p, W.dmg * (m.head && aim.head ? W.head : 1) * S.falloff(W, aim.dist), shot.w);
    }
  }

  // ---------- bot ----------
  function updateBot(room, bot, dt, now) {
    const ai = bot.ai, map = mapOf(room), grid = grids[room.map], N = grid.N;
    let target = null, best = Infinity;
    for (const q of room.players.values()) {
      const d = Math.hypot(q.pos[0] - bot.pos[0], q.pos[2] - bot.pos[2]);
      if (q !== bot && !q.dead && d < best) { best = d; target = q; }
    }
    if (now > ai.until) { ai.until = now + 600 + Math.random() * 800; ai.s = Math.random() < 0.5 ? -1 : 1; ai.jump = Math.random() < 0.15; }
    const inp = { f: 1, s: 0, yaw: bot.yaw, jump: false, crouch: false, speed: 0.8 };
    let los = false, dir = null, dist = 0;
    const eye = [bot.pos[0], bot.pos[1] + S.EYE, bot.pos[2]];
    if (target) {
      const to = [target.pos[0] - eye[0], target.pos[1] + (target.crouch ? 0.6 : 1) - eye[1], target.pos[2] - eye[2]];
      dist = Math.hypot(...to); dir = to.map((n) => n / (dist || 1));
      los = S.rayBoxes(eye, dir, dist, map) >= dist - 0.01;
      if (los && dist < 14) {                              // in a fight: face the target, strafe, keep some distance
        bot.yaw = inp.yaw = Math.atan2(-dir[0], -dir[2]);
        inp.f = dist < 5 ? -1 : 0; inp.s = ai.s; inp.jump = ai.jump;
      } else {                                             // otherwise walk the shortest path towards the target
        if (!ai.flow || now - ai.flowAt > 400) { ai.flow = flowField(grid, target.pos[0], target.pos[2]); ai.flowAt = now; }
        const c = grid.cellOf(bot.pos[0], bot.pos[2]), cx = c % N, cz = (c - cx) / N;
        let bx = 0, bz = 0, bd = ai.flow[c] >= 0 ? ai.flow[c] : Infinity;
        for (const [dx, dz] of NEIGHBOURS) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
          const d = ai.flow[nz * N + nx];
          if (d >= 0 && d < bd) { bd = d; bx = nx - map.half + 0.5 - bot.pos[0]; bz = nz - map.half + 0.5 - bot.pos[2]; }
        }
        if (bx || bz) bot.yaw = inp.yaw = Math.atan2(-bx, -bz);
        else bot.yaw = inp.yaw = Math.atan2(-dir[0], -dir[2]);          // no path (target on a roof): walk straight at it
      }
      bot.pitch = los ? Math.asin(clamp(dir[1], -1, 1)) : 0;
    } else bot.yaw = inp.yaw = bot.yaw + dt * 0.6;         // nobody to fight: wander in a circle

    const before = [bot.pos[0], bot.pos[2]];
    if (ai.stuck > 0.25) { ai.stuck = 0; ai.dodge = now + 500; }       // blocked by something low: hop over it
    if (now < ai.dodge) inp.jump = true;
    S.simulate(bot, inp, dt, map);
    const moved = Math.hypot(bot.pos[0] - before[0], bot.pos[2] - before[1]);
    ai.stuck = (inp.f || inp.s) && moved < 1.5 * dt ? ai.stuck + dt : 0;

    if (!los) { ai.seenAt = 0; return; }
    if (!ai.seenAt) { ai.seenAt = now; ai.fireAt = now + 450; }     // reaction time, so peeking is fair
    if (now < ai.fireAt) return;
    ai.fireAt = now + 300;
    const hit = Math.random() < clamp(0.7 - dist * 0.02, 0.15, 0.55);
    const d = hit ? dir : dir.map((n) => n + (Math.random() - 0.5) * 0.12);
    broadcast(room, { t: 'shot', id: bot.id, w: S.RIFLE, o: eye, d });
    if (hit) damage(room, target, bot, BOT_DMG, S.RIFLE);
  }

  // ---------- loop: call every TICK_MS ----------
  function tick() {
    const now = Date.now(), r2 = (n) => Math.round(n * 100) / 100;
    for (const room of [...rooms]) {
      const vests = mapOf(room).pickups;
      for (const p of [...room.players.values()]) {
        if (!p.dead && p.hp < 100 && now - p.hurtAt > 5000) p.hp = Math.min(100, p.hp + 1);   // heal after 5 s of peace
        if (p.dead && now >= p.respawnAt) {
          p.dead = false; p.hp = 100; p.pos = pickSpawn(room, p); p.vel = [0, 0, 0]; p.safeUntil = now + PROTECT;
          p.reach = 3; p.movedAt = now;
          tell(p, { t: 'spawn', p: p.pos });
        }
        if (p.bot && !p.dead) updateBot(room, p, TICK_MS / 1000, now);
        if (p.dead || p.armor >= S.MAX_ARMOR) continue;
        vests.forEach(([x, y, z], i) => {                    // walk over a vest to put it on
          if (now < room.pickups[i] || p.armor >= S.MAX_ARMOR) return;
          if (Math.hypot(p.pos[0] - x, p.pos[2] - z) > 1.3 || Math.abs(p.pos[1] - y) > 1.5) return;
          p.armor = Math.min(S.MAX_ARMOR, p.armor + S.ARMOR_PICKUP);
          room.pickups[i] = now + PICKUP_RESPAWN;
          broadcast(room, { t: 'pick', i, id: p.id });
        });
      }
      broadcast(room, {
        t: 'snap', room: room.id, pk: room.pickups.map((at) => (now >= at ? 1 : 0)),
        players: [...room.players.values()].map((p) => ({
          id: p.id, name: p.name, bot: p.bot, skin: p.skin, x: r2(p.pos[0]), y: r2(p.pos[1]), z: r2(p.pos[2]),
          yaw: r2(p.yaw), pitch: r2(p.pitch), hp: p.hp, a: p.armor, c: p.crouch, w: p.w, k: p.k, d: p.d,
        })),
      });
    }
  }

  return { rooms, join, leave, message, tick };
}
