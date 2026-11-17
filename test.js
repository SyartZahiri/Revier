// Self-check: node test.js. Starts the real server on a free port and checks the rules
// that matter: names, characters, bots only while alone, rooms of 10, hits need a shot,
// leaderboard, the solo mode without network, armour, and the physics.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import * as S from './public/shared.js';
import { createGame, cleanChat } from './public/sim.js';

const boardFile = path.join(os.tmpdir(), `leaderboard-test-${process.pid}.json`);
process.env.PORT = '0';
process.env.LEADERBOARD_FILE = boardFile;
const { ready, rooms } = await import('./server.js');
const port = await ready;

function connect(name, skin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const c = { ws, id: 0, name: '', skin: -1, snap: null, chat: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, skin })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'hello') { c.id = m.id; c.name = m.name; c.skin = m.skin; resolve(c); }
      if (m.t === 'snap') c.snap = m;
      if (m.t === 'chat') c.chat.push(m.text);
    });
  });
}
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const say = (c, m) => c.ws.send(JSON.stringify(m));
const me = (c, id = c.id) => c.snap.players.find((p) => p.id === id);
const board = async () => (await fetch(`http://localhost:${port}/api/leaderboard`)).json();

// --- names: cleaned up, never trusted ---
const a = await connect('  <b>Syart</b> der   Erste!!  ', 3);
assert.equal(a.name, 'bSyartb der Erst', 'tags and signs removed, spaces collapsed, cut to 16');
assert.equal(a.skin, 3, 'the character I asked for');
const proto = await connect('__proto__', 'quatsch');
assert.equal(proto.name, '__proto__');
assert.ok(Number.isInteger(proto.skin) && proto.skin !== 3, 'nonsense character: the server picks a free one');
const anon = await connect(42);
assert.ok(anon.name.length >= 2, 'no usable name: the server makes one up');
proto.ws.close(); anon.ws.close();
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
say(a, { t: 's', x: pb.x + 2, y: 0, z: pb.z, yaw: 0, pitch: 0, c: false, w: RIFLE });
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
last.ws.close();
await wait();
assert.equal(rooms.length, 1, 'empty room removed');
for (const c of [b, ...more.slice(0, -1)]) c.ws.close();
await wait();
assert.equal(a.snap.players.filter((p) => p.bot).length, 1, 'alone again: bot is back');

// --- solo mode: the same rules without any network (this is what runs on GitHub Pages) ---
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
const [vx, vy, vz] = map.pickups[0];
solo.message(hero, { t: 's', x: vx, y: vy, z: vz, yaw: 0, pitch: 0 });
solo.tick();
assert.equal(hero.armor, S.ARMOR_PICKUP, 'vest picked up');
assert.equal(inbox.findLast((m) => m.t === 'snap').pk[0], 0, 'the vest is gone for a while');
const foe = [...solo.rooms[0].players.values()].find((p) => p.bot);
const duel = (x, z, w, d = [-1, 0, 0]) => {                    // hero stands at x,z and fires weapon w along d, claiming a hit
  solo.message(hero, { t: 's', x, y: foe.pos[1], z, yaw: 0, pitch: 0 });
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

// --- the leaderboard is written to disk a moment after a kill ---
await wait(2300);
const saved = JSON.parse(await readFile(boardFile, 'utf8'));
assert.equal(saved.kills[a.name], 1, 'kill saved to the leaderboard file');
await rm(boardFile, { force: true });
console.log('Alle Tests bestanden');
process.exit(0);
