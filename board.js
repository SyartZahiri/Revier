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

  let saveTimer = null;
  function count(name) {
    const m = thisWeek();
    if (m.kills.has(name) || m.kills.size < MAX_NAMES) m.kills.set(name, (m.kills.get(name) ?? 0) + 1);
    if (useRedis) {
      // One kill, one small request: add to the week's list, keep it for two weeks, drop everything below the top 5000.
      redis([['ZINCRBY', key(), 1, name], ['EXPIRE', key(), KEEP], ['ZREMRANGEBYRANK', key(), 0, -MAX_NAMES - 1]])
        .catch((e) => log('Rangliste nicht gespeichert:', e.message));
      return;
    }
    saveTimer ??= setTimeout(async () => {
      saveTimer = null;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ week: m.week, kills: Object.fromEntries(m.kills) }));
      } catch (e) { log('Rangliste nicht gespeichert:', e.message); }
    }, 2000);
  }

  let cache = null, cachedAt = 0;
  async function top() {
    const m = thisWeek();
    const own = () => [...m.kills].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([name, k]) => ({ name, k }));
    if (!useRedis) return { week: m.week, store: 'file', top: own() };
    if (cache?.week === m.week && Date.now() - cachedAt < 5000) return cache;     // the menu asks often
    try {
      const [list] = await redis([['ZREVRANGE', key(), 0, 9, 'WITHSCORES']]);
      // Redis answers name, score, name, score ... (some setups answer in pairs): take both.
      const flat = (list ?? []).flat(), rows = [];
      for (let i = 0; i + 1 < flat.length; i += 2) rows.push({ name: String(flat[i]), k: Math.round(Number(flat[i + 1])) || 0 });
      cache = { week: m.week, store: 'redis', top: rows }; cachedAt = Date.now();
      return cache;
    } catch (e) {
      log('Rangliste nicht lesbar:', e.message);
      return { week: m.week, store: 'memory', top: own() };                      // what this instance has seen itself
    }
  }

  return { count, top, ready };
}
