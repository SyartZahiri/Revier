// Vercel Function: the game server. Vercel takes the exported http server, runs it, and hands it
// WebSocket connections and plain requests to /api/ws. Everything else lives in ../game-server.js.
export { server as default } from '../game-server.js';
