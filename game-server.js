// Multiplayer server: connects players over WebSockets to the game rules in public/sim.js and keeps
// the weekly leaderboard. Runs two ways:
//   npm start   a normal Node server that also delivers the files in public/
//   Vercel      imported by api/ws.js as a function; Vercel itself delivers public/
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createGame, weekKey, TICK_MS } from './public/sim.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const ON_VERCEL = !!process.env.VERCEL;
// On Vercel only the temp folder can be written, and it lives as long as the function instance does.
const BOARD_FILE = process.env.LEADERBOARD_FILE ?? path.join(ON_VERCEL ? os.tmpdir() : path.join(ROOT, 'data'), 'leaderboard.json');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8',
};

// ---------- weekly leaderboard ----------
// ponytail: one JSON file, names are not accounts (anyone can type any name). On Vercel the file is
// lost whenever the function instance is replaced. Move to a database (with logins) once the ranking matters.
const board = { week: weekKey(), kills: new Map() };   // a Map, so a name like "__proto__" is just a name
try {
  const saved = JSON.parse(await readFile(BOARD_FILE, 'utf8'));
  if (saved?.week === board.week && saved.kills && typeof saved.kills === 'object') {
    for (const [name, k] of Object.entries(saved.kills)) if (Number.isInteger(k) && k > 0) board.kills.set(name, k);
  }
} catch { /* no file yet, or unreadable: start an empty week */ }

function currentBoard() {
  const week = weekKey();
  if (board.week !== week) { board.week = week; board.kills.clear(); }
  return board;
}
let saveTimer = null;
function countKill(name) {
  const b = currentBoard();
  if (!b.kills.has(name) && b.kills.size >= 5000) return;          // cap the file size
  b.kills.set(name, (b.kills.get(name) ?? 0) + 1);
  saveTimer ??= setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(path.dirname(BOARD_FILE), { recursive: true });
      await writeFile(BOARD_FILE, JSON.stringify({ week: b.week, kills: Object.fromEntries(b.kills) }));
    } catch (e) { console.error('Rangliste nicht gespeichert:', e.message); }
  }, 2000);
}
function topList() {
  const b = currentBoard();
  const top = [...b.kills].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([name, k]) => ({ name, k }));
  return { week: b.week, top };
}

// ---------- plain requests ----------
// /api/ws is one address for both: a WebSocket connects to the game, a normal GET returns the leaderboard.
// (One address, so on Vercel both end up in the same function and see the same memory.)
export const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/api/ws') {
      // Readable from any site, so a copy of the game hosted elsewhere can show this server's ranking.
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(topList()));
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC + path.sep)) throw new Error('outside');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/assets/') ? 'max-age=604800' : 'no-cache',   // textures never change
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Nicht gefunden');
  }
});

// ---------- players ----------
const game = createGame({
  send: (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
  onKill: countKill,
});
export const rooms = game.rooms;

const wss = new WebSocketServer({ server, maxPayload: 1024 });
wss.on('connection', (ws) => {
  let p = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (p) return game.message(p, m);
    if (m?.t === 'join') p = game.join(ws, m.name, m.skin, m.token);     // first message: name, wished character, and the token when coming back
  });
  ws.on('close', () => { if (p?.conn === ws) game.detach(p); });         // their place is kept for a moment
  ws.on('error', () => ws.close());
});

setInterval(game.tick, TICK_MS);
// Vercel starts the server itself (see api/ws.js). Everywhere else it listens right away.
export const ready = ON_VERCEL ? null : new Promise((resolve) => {
  server.listen(process.env.PORT ?? 3000, () => {
    const { port } = server.address();
    console.log(`Spiel läuft auf http://localhost:${port}`);
    resolve(port);
  });
});
