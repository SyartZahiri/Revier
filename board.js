// The weekly leaderboard: kills per name. Every Monday a new list starts; within the week it lasts.
// It lives in one of two places:
//   Redis (Upstash, over its REST API)  where one is configured. Needed on Vercel, where nothing on disk lasts
//                                       and several server instances must add to the same list.
//   a JSON file                         everywhere else (npm start on your own machine).
// ponytail: names are not accounts, anyone can type any name. Logins, once the ranking starts to matter.
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { weekKey } from './public/sim.js';

const KEEP = 14 * 24 * 3600;      // seconds an old week stays in Redis before it deletes itself
const MAX_NAMES = 5000;           // the list never grows beyond this many names
const SAVE_EVERY = 2000;          // ms: kills are collected and written together, however many there were
const READ_EVERY = 5000;          // ms: the list is read from Redis at most this often, also after an error

export function createBoard({ file, redisUrl, redisToken, log = console.error }) {
  const useRedis = !!(redisUrl && redisToken);
  const mem = { week: weekKey(), kills: new Map() };   // a Map, so a name like "__proto__" is just a name
  const thisWeek = () => {
    const week = weekKey();
    if (mem.week !== week) { mem.week = week; mem.kills.clear(); }       // Monday: start over
    return mem;
  };
  const key = () => `revier:kills:${weekKey()}`;                          // one Redis key per week

  // Sends several commands in one request. Returns their results, throws if any failed.
  async function redis(commands) {
    const res = await fetch(`${redisUrl}/pipeline`, {
      method: 'POST', headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands), signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Redis antwortet mit ${res.status}`);
    const out = await res.json();
    const bad = out.find((r) => r.error);
    if (bad) throw new Error(bad.error);
    return out.map((r) => r.result);
  }

  const ready = useRedis ? Promise.resolve() : readFile(file, 'utf8').then((text) => {
    const saved = JSON.parse(text);
    if (saved?.week !== mem.week || !saved.kills || typeof saved.kills !== 'object') return;
    for (const [name, k] of Object.entries(saved.kills)) if (Number.isInteger(k) && k > 0) mem.kills.set(name, k);
  }).catch(() => { /* no file yet, or unreadable: start an empty week */ });

  // Kills wait here until the next save. One save runs at a time, so a burst of kills never becomes a burst of requests.
  const pending = new Map();
  let saveTimer = null, saving = false;
  async function save() {
    saveTimer = null;
    if (saving) { saveTimer = setTimeout(save, SAVE_EVERY); return; }
    saving = true;
    const batch = [...pending];
    pending.clear();
    try {
      if (useRedis) {
        await redis([...batch.map(([name, n]) => ['ZINCRBY', key(), n, name]),
          ['EXPIRE', key(), KEEP], ['ZREMRANGEBYRANK', key(), 0, -MAX_NAMES - 1]]);     // keep two weeks, and only the top 5000
      } else {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ week: mem.week, kills: Object.fromEntries(mem.kills) }));
      }
    } catch (e) {
      log('Rangliste nicht gespeichert:', e.message);
      // Not written: put the kills back for the next try (the file version writes everything anyway).
      if (useRedis) for (const [name, n] of batch) if (pending.has(name) || pending.size < MAX_NAMES) pending.set(name, (pending.get(name) ?? 0) + n);
    }
    saving = false;
    if (pending.size) saveTimer ??= setTimeout(save, SAVE_EVERY);
  }

  function count(name) {
    const m = thisWeek();
    if (m.kills.has(name) || m.kills.size < MAX_NAMES) m.kills.set(name, (m.kills.get(name) ?? 0) + 1);
    if (pending.has(name) || pending.size < MAX_NAMES) pending.set(name, (pending.get(name) ?? 0) + 1);
    saveTimer ??= setTimeout(save, SAVE_EVERY);
  }

  let cache = null, cachedAt = 0, reading = null;
  async function top() {
    const m = thisWeek();
    const own = () => [...m.kills].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([name, k]) => ({ name, k }));
    if (!useRedis) return { week: m.week, store: 'file', top: own() };
    if (cache?.week === m.week && Date.now() - cachedAt < READ_EVERY) return cache;       // the menu asks often
    // Everybody who asks while a read is under way shares that one read. Its answer is kept for a moment,
    // good or bad, so a Redis that is down is not asked again and again.
    reading ??= redis([['ZREVRANGE', key(), 0, 9, 'WITHSCORES']]).then(([list]) => {
      // Redis answers name, score, name, score ... (some setups answer in pairs): take both.
      const flat = (list ?? []).flat(), rows = [];
      for (let i = 0; i + 1 < flat.length; i += 2) rows.push({ name: String(flat[i]), k: Math.round(Number(flat[i + 1])) || 0 });
      return { week: m.week, store: 'redis', top: rows };
    }).catch((e) => {
      log('Rangliste nicht lesbar:', e.message);
      return { week: m.week, store: 'memory', top: own() };                              // what this instance has seen itself
    }).then((result) => { cache = result; cachedAt = Date.now(); reading = null; return result; });
    return reading;
  }

  return { count, top, ready };
}
