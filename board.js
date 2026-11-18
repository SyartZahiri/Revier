// The weekly leaderboard: kills per name, kept in ONE JSON file that rewrites itself.
//   { "week": "2026-W47", "updated": "2026-11-18T10:00:00.000Z", "kills": { "Ada": 12, "Bo": 3 } }
// Every Monday a new list starts: the week in the file no longer matches, so the file is written afresh.
// Where the file lives:
//   data/leaderboard.json   on your own machine (npm start)
//   Vercel Blob             on Vercel, where a normal file disappears whenever the server restarts.
//                           It is the same JSON file, only kept in Vercel's file storage.
// ponytail: names are not accounts, anyone can type any name. Logins, once the ranking starts to matter.
// ponytail: two server instances saving in the same second can lose one of the two batches (read, add, write is
//           not atomic). put() takes ifMatch with the file's etag, add that once the game is busy enough for it.
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { weekKey } from './public/sim.js';

const NAME = 'leaderboard.json';  // the file's name in Vercel Blob
const MAX_NAMES = 5000;           // the list never grows beyond this many names
const READ_EVERY = 60000;         // ms: in Blob, look into the file at most this often for what other instances wrote

// blob: the functions get and put of @vercel/blob, or nothing to use the local file.
// saveEvery: kills are collected and written together. In Blob slowly, because the free plan allows 2000 writes a month.
export function createBoard({ file, blob = null, saveEvery = blob ? 120000 : 2000, log = console.error }) {
  const net = () => ({ access: 'private', abortSignal: AbortSignal.timeout(5000) });
  // read: the file's text, nothing if there is no file yet. Any other trouble throws, so an unreadable file is never overwritten.
  const read = blob
    ? async () => { const f = await blob.get(NAME, { ...net(), useCache: false }); return f ? new Response(f.stream).text() : null; }
    : () => readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  const write = blob
    ? (text) => blob.put(NAME, text, { ...net(), allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 })
    : async (text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };

  let week = weekKey();
  let saved = new Map();          // what the file holds for this week. A Map, so a name like "__proto__" is just a name
  const pending = new Map();      // kills that are not in the file yet
  let ok = true, readAt = 0, wroteAt = 0;
  const monday = () => { if (week !== weekKey()) { week = weekKey(); saved = new Map(); pending.clear(); } };   // start over
  const add = (map, name, n) => { if (map.has(name) || map.size < MAX_NAMES) map.set(name, (map.get(name) ?? 0) + n); };

  // Takes over what the file says. A file from another week, or one that is not valid JSON, counts as empty.
  async function load() {
    const text = await read();
    monday();
    let data = null;
    try { data = JSON.parse(text); } catch { /* broken file: begin an empty week */ }
    saved = new Map();
    if (data?.week === week && data.kills && typeof data.kills === 'object')
      for (const [name, k] of Object.entries(data.kills)) if (Number.isInteger(k) && k > 0) add(saved, name, k);
  }

  // One read or one save runs at a time. Whoever asks meanwhile shares it.
  let reading = null, saving = null, timer = null;
  const refresh = () => saving ?? (reading ??= load()
    .then(() => { ok = true; }, (e) => { ok = false; log('Rangliste nicht lesbar:', e.message); })
    .finally(() => { readAt = Date.now(); reading = null; }));

  function save() {
    clearTimeout(timer); timer = null;
    return saving ??= (async () => {
      await reading;
      const batch = [...pending];
      pending.clear();
      try {
        await load();                                         // somebody else may have written since: add to what is there now
        const next = new Map(saved);
        for (const [name, n] of batch) add(next, name, n);
        const kills = Object.fromEntries([...next].sort((x, y) => y[1] - x[1]));
        await write(JSON.stringify({ week, updated: new Date().toISOString(), kills }, null, 1));
        saved = next; ok = true; readAt = wroteAt = Date.now();
      } catch (e) {
        ok = false;
        log('Rangliste nicht gespeichert:', e.message);
        for (const [name, n] of batch) add(pending, name, n);  // not written: they wait for the next try
      }
      saving = null;
      if (pending.size) timer ??= setTimeout(save, saveEvery);
    })();
  }

  function count(name) {
    monday();
    add(pending, name, 1);
    timer ??= setTimeout(save, saveEvery);
  }

  // Saves right now instead of at the next turn, for when the server is about to go quiet. Never more often than
  // twice per saveEvery, so nobody can use up the monthly writes by joining and leaving.
  const flush = () => (pending.size && Date.now() - wroteAt >= saveEvery / 2 ? save() : undefined);

  async function top() {
    if (blob && Date.now() - readAt > READ_EVERY) await refresh();
    monday();
    const all = new Map(saved);
    for (const [name, n] of pending) add(all, name, n);
    // store: where the list is kept. "memory" means the file could not be reached and this is only what this instance knows.
    return { week, store: !ok ? 'memory' : blob ? 'blob' : 'file',
      top: [...all].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([name, k]) => ({ name, k })) };
  }

  return { count, top, flush, ready: refresh() };
}
