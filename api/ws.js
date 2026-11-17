// Vercel Function: the game server. Vercel takes the exported http server, runs it, and hands it
// WebSocket connections and plain requests to /api/ws. Everything else lives in ../server.js.
export { server as default } from '../server.js';
