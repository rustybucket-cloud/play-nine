import { put, list, del } from '@vercel/blob';
import { createHash, randomBytes } from 'node:crypto';

const sha = (t) => createHash('sha256').update(t).digest('hex');
const rid = (n) => randomBytes(n).toString('base64url').replace(/[-_]/g, 'a');

// Latest version of a game: games/{id}/{version}.json (immutable per version)
async function head(id) {
  const { blobs } = await list({ prefix: `games/${id}/`, limit: 1000 });
  let version = 0, url = null;
  for (const b of blobs) {
    const m = b.pathname.match(/\/(\d+)\.json$/);
    if (m && +m[1] > version) { version = +m[1]; url = b.url; }
  }
  return version ? { version, url } : null;
}

async function readState(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('state fetch failed');
  return r.json();
}

async function write(id, version, state) {
  await put(`games/${id}/${version}.json`, JSON.stringify(state), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

// keep only the last few versions per game
async function cleanup(id, latest) {
  if (latest <= 6) return;
  try {
    const { blobs } = await list({ prefix: `games/${id}/`, limit: 1000 });
    const old = blobs.filter((b) => {
      const m = b.pathname.match(/\/(\d+)\.json$/);
      return m && +m[1] <= latest - 5;
    });
    if (old.length) await del(old.map((b) => b.url));
  } catch { /* best effort */ }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const { id, since } = req.query;
      if (!id || !/^[A-Za-z0-9]{4,20}$/.test(id)) return res.status(400).json({ error: 'bad id' });
      const h = await head(id);
      if (!h) return res.status(404).json({ error: 'game not found' });
      if (since && h.version <= +since) return res.json({ version: h.version, unchanged: true });
      const state = await readState(h.url);
      return res.json({ version: h.version, state });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const body = req.body || {};
    const { action } = body;

    if (action === 'create') {
      const { state } = body;
      if (!state || typeof state !== 'object') return res.status(400).json({ error: 'missing state' });
      const id = rid(6);
      const token = rid(16);
      state.seats = [sha(token), null];
      await write(id, 1, state);
      return res.json({ id, player: 0, token, version: 1 });
    }

    if (action === 'join') {
      const { id, name } = body;
      const h = await head(id ?? '');
      if (!h) return res.status(404).json({ error: 'game not found' });
      const state = await readState(h.url);
      if (state.seats[1]) return res.status(403).json({ error: 'game is full' });
      const token = rid(16);
      state.seats[1] = sha(token);
      state.names[1] = String(name || 'Player 2').slice(0, 16);
      const version = h.version + 1;
      await write(id, version, state);
      return res.json({ player: 1, token, version, state });
    }

    if (action === 'move') {
      const { id, token, baseVersion, state } = body;
      if (!state || typeof state !== 'object') return res.status(400).json({ error: 'missing state' });
      const h = await head(id ?? '');
      if (!h) return res.status(404).json({ error: 'game not found' });
      const current = await readState(h.url);
      const player = current.seats.indexOf(sha(String(token || '')));
      if (player === -1) return res.status(403).json({ error: 'not a player in this game' });
      if (h.version !== +baseVersion) {
        return res.status(409).json({ error: 'out of date', version: h.version, state: current });
      }
      state.seats = current.seats; // seats are server-owned
      const version = h.version + 1;
      await write(id, version, state);
      cleanup(id, version).catch(() => {});
      return res.json({ version });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server error' });
  }
}
