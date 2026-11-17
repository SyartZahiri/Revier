// Self-check: node test.js. Starts the real server on a free port and checks the rules
// that matter: names, characters, bots only while alone, rooms of 10, hits need a shot,
// leaderboard, the solo mode without network, armour, and the physics.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import * as S from './public/shared.js';
import { createGame, cleanChat } from './public/sim.js';

const boardFile = path.join(os.tmpdir(), `leaderboard-test-${process.pid}.json`);
process.env.PORT = '0';
process.env.LEADERBOARD_FILE = boardFile;
const { ready, rooms } = await import('./game-server.js');
const port = await ready;

function connect(name, skin, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/ws`);
    const c = { ws, id: 0, name: '', skin: -1, snap: null, chat: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, skin, token })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'hello') { Object.assign(c, { id: m.id, name: m.name, skin: m.skin, token: m.token, back: !!m.back }); resolve(c); }
      if (m.t === 'snap') c.snap = m;
      if (m.t === 'chat') c.chat.push(m.text);
    });
  });
}
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const say = (c, m) => c.ws.send(JSON.stringify(m));
const bye = (c) => { say(c, { t: 'bye' }); c.ws.close(); };      // leave properly, like closing the tab
const me = (c, id = c.id) => c.snap.players.find((p) => p.id === id);
const board = async () => (await fetch(`http://localhost:${port}/api/ws`)).json();

// --- names: cleaned up, never trusted ---
const a = await connect('  <b>Syart</b> der   Erste!!  ', 3);
assert.equal(a.name, 'bSyartb der Erst', 'tags and signs removed, spaces collapsed, cut to 16');
assert.equal(a.skin, 3, 'the character I asked for');
const proto = await connect('__proto__', 'quatsch');
assert.equal(proto.name, '__proto__');
assert.ok(Number.isInteger(proto.skin) && proto.skin !== 3, 'nonsense character: the server picks a free one');
const anon = await connect(42);
assert.ok(anon.name.length >= 2, 'no usable name: the server makes one up');
bye(proto); bye(anon);
await wait();

// --- alone: one bot ---
assert.equal(a.snap.players.length, 2, 'alone: me + bot');
assert.equal(a.snap.players.filter((p) => p.bot).length, 1);

// --- second player: bot leaves, and nobody shares a character ---
const b = await connect('Zweiter', 3);
await wait();
assert.equal(a.snap.players.length, 2, 'two humans');
assert.equal(a.snap.players.filter((p) => p.bot).length, 0, 'bot left');
assert.notEqual(b.skin, 3, 'character 3 is taken, the second player gets another');

// --- chat: relayed as plain text, control characters and overlong lines cut ---
say(a, { t: 'chat', text: `hallo\u0000 <b>du</b>${'x'.repeat(200)}` });
await wait();
assert.equal(b.chat.length, 1);
assert.ok(b.chat[0].startsWith('hallo <b>du</b>x') && b.chat[0].length === 80);
assert.equal(cleanChat('   '), null);

// --- hits: believed only if a shot was fired from where the shooter stands, towards the target ---
const pb = me(a, b.id), RIFLE = S.RIFLE;
const eye = [pb.x + 2, 1.6, pb.z], atB = [-1, 0, 0];           // a stands 2 m beside b and aims at b's head
rooms[0].players.get(a.id).pos = [pb.x + 2, 0, pb.z];          // put a there on the server (walking over would take a while)
say(a, { t: 'hit', id: b.id });
await wait();
assert.equal(me(a, b.id).hp, 100, 'hit without shot is ignored');
say(a, { t: 'shot', w: RIFLE, o: eye, d: atB });
say(a, { t: 'hit', id: b.id });
await wait();
assert.equal(me(a, b.id).hp, 100, 'fresh spawn is protected');
await wait(1600);                                              // protection runs out
say(a, { t: 'shot', w: RIFLE, o: eye, d: atB });
say(a, { t: 'hit', id: b.id, head: true });
say(a, { t: 'hit', id: b.id, head: true });
await wait();
assert.equal(me(a, b.id).hp, 100 - 24 * 2, 'one bullet hits once, headshot doubles');
await wait(120);
say(a, { t: 'shot', w: RIFLE, o: [pb.x + 20, 1.6, pb.z], d: atB });   // "fired" from somewhere the shooter is not
say(a, { t: 'hit', id: b.id, head: true });
await wait(120);
say(a, { t: 'shot', w: RIFLE, o: eye, d: [1, 0, 0] });                // fired the other way
say(a, { t: 'hit', id: b.id, head: true });
say(a, { t: 'shot', w: RIFLE, o: ['x', 1, 0], d: [0, 0, -1] });       // garbage must not crash the server
say(a, 'quatsch');
a.ws.send('{kaputt');
await wait();
assert.equal(me(a, b.id).hp, 52, 'shots from elsewhere or in another direction do nothing');

// --- leaderboard: a kill counts for the killer's name in the current week ---
say(a, { t: 'shot', w: 1, o: eye, d: atB });
say(a, { t: 'hit', id: b.id, head: true });                    // pistol headshot: 56 damage
await wait();
assert.equal(me(a, b.id).hp, 0, 'b is down');
const lb = await board();
assert.match(lb.week, /^\d{4}-W\d{2}$/);
assert.deepEqual(lb.top, [{ name: a.name, k: 1 }]);
assert.equal(S.falloff(S.WEAPONS[RIFLE], 10), 1);
assert.ok(Math.abs(S.falloff(S.WEAPONS[RIFLE], 100) - 0.7) < 1e-9, 'rifle keeps 70 % at long range');

// --- rooms: ten players fill a room, each with a different character; the 11th opens room 2 and gets a bot ---
const more = [];
for (let i = 0; i < 9; i++) more.push(await connect(`Spieler ${i}`, 3));
await wait();
assert.equal(rooms.length, 2);
assert.equal(a.snap.players.length, 10, 'room 1 is full with 10 humans');
assert.equal(new Set(a.snap.players.map((p) => p.skin)).size, 10, 'ten players, ten different characters');
const last = more.at(-1);
assert.equal(last.snap.room, 2);
assert.equal(last.snap.players.filter((p) => p.bot).length, 1, 'alone in room 2: bot');

// --- leaving: empty room disappears, bot comes back when one is left ---
bye(last);
await wait();
assert.equal(rooms.length, 1, 'empty room removed');
for (const c of [b, ...more.slice(0, -1)]) bye(c);
await wait();
assert.equal(a.snap.players.filter((p) => p.bot).length, 1, 'alone again: bot is back');

// --- dropped connection (Vercel cuts every connection after a few minutes): the place is kept, the token brings you back ---
a.ws.close();
await wait();
assert.equal(rooms.length, 1, 'the room waits for the player');
const again = await connect('anderer Name', 5, a.token);
await wait();
assert.deepEqual([again.id, again.name, again.back, me(again).k], [a.id, a.name, true, 1], 'same player, same score');
const stranger = await connect('Fremder', 5, 'f'.repeat(24));
assert.notEqual(stranger.id, a.id, 'a made-up token gets a new player, not somebody else\'s place');
bye(stranger);
const brief = createGame({ send: () => {}, hold: 40 });
brief.detach(brief.join({}, 'Kurz'));
brief.tick();
assert.equal(brief.rooms.length, 1, 'held for a moment');
await wait(80);
brief.tick();
assert.equal(brief.rooms.length, 0, 'then given up');

// --- the Vercel function: api/ws.js hands over the same server, not yet listening, and answers /api/ws ---
const { execFile } = await import('node:child_process');
const vercelCheck = `
  const { default: server } = await import('./api/ws.js');
  if (server.listening) throw new Error('must not listen by itself on Vercel');
  await new Promise((r) => server.listen(0, r));
  const res = await fetch('http://localhost:' + server.address().port + '/api/ws');
  console.log(res.status, Object.keys(await res.json()).join(','));
  process.exit(0);`;
const out = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', vercelCheck],
  { env: { ...process.env, VERCEL: '1', LEADERBOARD_FILE: `${boardFile}.vercel` } }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))));
assert.equal(out, '200 week,store,top', 'the function serves the leaderboard');

// --- solo mode: the same rules without any network (the fallback when no server answers) ---
const map = S.MAPS[0];
const inbox = [];
const solo = createGame({ send: (conn, m) => conn.push(m) });
const hero = solo.join(inbox, 'Solo', 7);
solo.tick();
const snap = inbox.findLast((m) => m.t === 'snap');
assert.equal(snap.players.length, 2, 'me and one bot');
assert.equal(snap.players.filter((p) => p.bot).length, 1);
assert.notEqual(snap.players[0].skin, snap.players[1].skin, 'the bot wears another character');

// --- armour: walking over a vest puts it on, and it takes the next hit ---
hero.pos = [...map.pickups[0]];
solo.tick();
assert.equal(hero.armor, S.ARMOR_PICKUP, 'vest picked up');
assert.equal(inbox.findLast((m) => m.t === 'snap').pk[0], 0, 'the vest is gone for a while');
const foe = [...solo.rooms[0].players.values()].find((p) => p.bot);
const duel = (x, z, w, d = [-1, 0, 0]) => {                    // hero stands at x,z and fires weapon w along d, claiming a hit
  hero.pos = [x, foe.pos[1], z];
  hero.lastShot.fill(0);
  solo.message(hero, { t: 'shot', w, o: [x, foe.pos[1] + 1.6, z], d });
  solo.message(hero, { t: 'hit', id: foe.id });
};
Object.assign(foe, { armor: 50, safeUntil: 0 });
duel(foe.pos[0] + 2, foe.pos[2], S.RIFLE);
assert.deepEqual([foe.armor, foe.hp], [26, 100], 'the vest absorbs the bullet');

// --- knife: only within reach ---
duel(foe.pos[0] + 6, foe.pos[2], 0);
assert.deepEqual([foe.armor, foe.hp], [26, 100], 'a knife does not reach 6 m');
duel(foe.pos[0] + 2, foe.pos[2], 0);
assert.deepEqual([foe.armor, foe.hp], [0, 100 - (55 - 26)], 'a knife at 2 m cuts through the rest of the vest');

// --- cover: no hit through something solid (the tank stands between them) ---
Object.assign(foe, { pos: [-4, 0, 0], hp: 100 });
duel(4, 0, S.RIFLE);
assert.equal(foe.hp, 100, 'the tank stops the bullet');

// --- where a player says they are: a step is taken, a teleport or a place inside a wall is refused and corrected ---
const claim = (x, z) => { solo.message(hero, { t: 's', x, y: 0, z, yaw: 0, pitch: 0 }); return hero.pos[0]; };
Object.assign(hero, { pos: [10, 0, 16], reach: 3, movedAt: Date.now() });
inbox.length = 0;
assert.equal(claim(10.5, 16), 10.5, 'half a metre: fine');
assert.equal(claim(30, 16), 10.5, '20 metres in no time: refused');
assert.deepEqual(inbox.at(-1), { t: 'pos', p: [10.5, 0, 16] }, 'and the player is told where they really are');
for (let i = 0; i < 50; i++) claim(10.5 + i * 0.001, 16);       // sending faster does not buy more distance
assert.ok(claim(14, 16) < 11, 'no speed-up by flooding');
Object.assign(hero, { pos: [3, 0, 0], reach: 3 });
assert.equal(claim(1, 0), 3, 'inside the tank: refused');
solo.leave(hero);
assert.equal(solo.rooms.length, 0, 'room closes when the human leaves');

// --- the map: one map, free spawn points, everything inside the walls, vests reachable ---
assert.equal(S.MAPS.length, 1, 'one map');
const idle = { f: 0, s: 0, yaw: 0, jump: false, crouch: false };
assert.ok(map.spawns.length >= 8, 'at least 8 spawn points');
for (const [x, z] of map.spawns) {
  const sp = S.newBody([x, 0.4, z]);
  S.simulate(sp, idle, 1 / 60, map);
  assert.deepEqual([sp.pos[0], sp.pos[2]], [x, z], `spawn ${x},${z} is not inside a box`);
}
for (const [x, y, z] of map.pickups) {
  const vest = S.newBody([x, y + 0.05, z]);
  S.simulate(vest, idle, 1 / 60, map);
  assert.ok(Math.abs(vest.pos[0] - x) < 1e-6 && Math.abs(vest.pos[2] - z) < 1e-6 && Math.abs(vest.pos[1] - y) < 0.06, `vest ${x},${y},${z} lies on something, not inside it`);
}

// --- physics: you fall to the floor, walls stop you, jumping works, rays hit the tank ---
const body = S.newBody([10, 5, 16]);
for (let i = 0; i < 120; i++) S.simulate(body, idle, 1 / 60, map);
assert.equal(body.pos[1], 0); assert.ok(body.ground);
for (let i = 0; i < 600; i++) S.simulate(body, { ...idle, f: -1 }, 1 / 60, map);    // run +z into the outer wall
assert.ok(Math.abs(body.pos[2] - (map.half - S.R)) < 1e-6, 'ran to the outer wall and stopped there');
S.simulate(body, { ...idle, jump: true }, 1 / 60, map);
assert.ok(body.pos[1] > 0 && !body.ground, 'jump leaves the ground');
assert.ok(Math.abs(S.rayBoxes([0, 1, 10], [0, 0, -1], 100, map) - 6.5) < 1e-9, 'ray hits the tank hull at z=3.5');

// --- stepping up: a grave mound is walked over without jumping, and the rubble stairs lead to the upper floor ---
const walker = S.newBody([18, 0, 20]);
for (let i = 0; i < 60; i++) S.simulate(walker, { ...idle, f: -1 }, 1 / 60, map);     // +z, onto the grave and up to its stone
assert.ok(Math.abs(walker.pos[1] - 0.18) < 1e-6 && walker.pos[2] > 22, 'standing on the mound, stopped by the stone');
const climber = S.newBody([-13.6, 0, -20.5]);
let top = 0;
for (let i = 0; i < 120; i++) { S.simulate(climber, { ...idle, f: 1, yaw: Math.PI / 2 }, 1 / 60, map); top = Math.max(top, climber.pos[1]); }
assert.ok(Math.abs(top - 3.3) < 1e-6, 'walked up the stairs onto the upper floor');

// --- wall jump: in the air against the outer wall, a fresh jump press kicks you away, but only once per wall ---
const wj = S.newBody([10, 2, map.half - S.R - 0.01]);
S.simulate(wj, { ...idle, f: -1 }, 1 / 60, map);               // push +z into the wall while falling
S.simulate(wj, { ...idle, f: -1, jump: true }, 1 / 60, map);
assert.ok(wj.vel[2] < -3 && wj.vel[1] > 0, 'wall jump kicks away and up');
S.simulate(wj, idle, 1 / 60, map);                             // release the key
wj.pos[2] = map.half - S.R - 0.01; wj.vel[2] = 0;
S.simulate(wj, { ...idle, f: -1 }, 1 / 60, map);
const fallSpeed = wj.vel[1];
S.simulate(wj, { ...idle, f: -1, jump: true }, 1 / 60, map);
assert.ok(wj.vel[1] < fallSpeed, 'no second jump off the same wall');

// --- lasting leaderboard (Vercel): kills go to Redis over its REST API, a second server instance reads the same list ---
const { createBoard } = await import('./board.js');
const sets = new Map();                                        // a stand-in for Upstash Redis: key -> (name -> score)
let requests = 0;
const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests++;
  if (req.url !== '/pipeline' || req.headers.authorization !== 'Bearer geheim') return res.writeHead(401).end('{}');
  const out = JSON.parse(body).map(([cmd, key, ...args]) => {
    const set = sets.get(key) ?? sets.set(key, new Map()).get(key);
    if (cmd === 'ZINCRBY') { set.set(args[1], (set.get(args[1]) ?? 0) + Number(args[0])); return { result: String(set.get(args[1])) }; }
    if (cmd === 'ZREVRANGE') return { result: [...set].sort((x, y) => y[1] - x[1]).slice(0, 10).flatMap(([n, s]) => [n, String(s)]) };
    return { result: 1 };                                      // EXPIRE, ZREMRANGEBYRANK
  });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
});
await new Promise((r) => fake.listen(0, r));
const redisUrl = `http://localhost:${fake.address().port}`, quiet = () => {};
const one = createBoard({ redisUrl, redisToken: 'geheim', log: quiet });
for (const n of ['Ada', 'Ada', 'Bo', 'Ada']) one.count(n);
await wait(2300);
assert.equal(requests, 1, 'four kills, one request: they are written together');
const two = createBoard({ redisUrl, redisToken: 'geheim', log: quiet });          // a fresh instance with empty memory
assert.deepEqual(await two.top(), { week: lb.week, store: 'redis', top: [{ name: 'Ada', k: 3 }, { name: 'Bo', k: 1 }] }, 'the list outlives the instance');
assert.ok([...sets.keys()].every((k) => k === `revier:kills:${lb.week}`), 'one list per week, so a new week starts empty');
const locked = createBoard({ redisUrl, redisToken: 'falsch', log: quiet });
locked.count('Cy');
assert.deepEqual(await locked.top(), { week: lb.week, store: 'memory', top: [{ name: 'Cy', k: 1 }] }, 'Redis says no: show what this instance knows');
const asked = requests;
await Promise.all([locked.top(), locked.top(), locked.top()]);
assert.equal(requests, asked, 'a failed read is remembered for a moment too, not repeated on every request');
fake.close();

// --- the leaderboard is written to disk a moment after a kill ---
await wait(2300);
const saved = JSON.parse(await readFile(boardFile, 'utf8'));
assert.equal(saved.kills[a.name], 1, 'kill saved to the leaderboard file');
await rm(boardFile, { force: true }); await rm(`${boardFile}.vercel`, { force: true });
console.log('Alle Tests bestanden');
process.exit(0);
