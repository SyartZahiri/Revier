// Multiplayer server: connects players over WebSockets to the game rules in public/sim.js and keeps
// the weekly leaderboard. Runs two ways:
//   npm start   a normal Node server that also delivers the files in public/
//   Vercel      imported by api/ws.js as a function; Vercel itself delivers public/
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createGame, TICK_MS } from './public/sim.js';
import { createBoard } from './board.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const ON_VERCEL = !!process.env.VERCEL;
// The file is only used without Redis. On Vercel only the temp folder can be written, and it does not last.
const BOARD_FILE = process.env.LEADERBOARD_FILE ?? path.join(ON_VERCEL ? os.tmpdir() : path.join(ROOT, 'data'), 'leaderboard.json');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8',
};

// ---------- weekly leaderboard ----------
// Lasting for the week in Redis where one is set up (Vercel: Storage > Upstash Redis), in a file otherwise. See board.js.
const board = createBoard({
  file: BOARD_FILE,
  redisUrl: process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN,
});
await board.ready;
// ---------- plain requests ----------
// /api/ws is one address for both: a WebSocket connects to the game, a normal GET returns the leaderboard.
export const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/api/ws') {
      // Readable from any site, so a copy of the game hosted elsewhere can show this server's ranking.
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(await board.top()));
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
  onKill: board.count,
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
