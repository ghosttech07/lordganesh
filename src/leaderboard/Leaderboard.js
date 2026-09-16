// Leaderboard with pluggable persistence, built to stay calm under load:
//   - reads hit best-per-player views with `limit 100` (never the raw table);
//   - responses are cached for 60 s and concurrent requests are coalesced;
//   - failures back off exponentially and never throw into the game loop;
//   - submissions that fail (offline, 429, 5xx) are queued in localStorage
//     and retried later, so a bad connection can never lose a score or crash.
// Adapters: LocalAdapter (per-browser) and SupabaseAdapter (REST, no SDK).

import { validateSubmission, dailySeed, weekKey } from './validate.js';
import { localClaim } from './Identity.js';

const LOCAL_KEY = 'endless-modak.scores.v1';
const FRIENDS_KEY = 'endless-modak.friends.v1';
const QUEUE_KEY = 'endless-modak.pending.v1';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class LocalAdapter {
  constructor() {
    this.rows = [];
    try {
      this.rows = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    } catch {
      this.rows = [];
    }
  }
  async claimName(name, secret) {
    return localClaim(name, secret);
  }
  async submit(row) {
    this.rows.push(row);
    this.rows.sort((a, b) => b.score - a.score);
    if (this.rows.length > 2000) this.rows.length = 2000;
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.rows));
    } catch {
      /* ignore */
    }
    return { ok: true };
  }
  async fetch(board, mode, limit) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const wk = weekKey(now);
    // Best per player, like the server views.
    const best = new Map();
    for (const r of this.rows) {
      if ((r.mode || 'free') !== mode) continue;
      if (board === 'daily' && r.day !== today) continue;
      if (board === 'weekly' && r.week !== wk) continue;
      const k = r.name.toLowerCase();
      if (!best.has(k) || best.get(k).score < r.score) best.set(k, r);
    }
    const rows = [...best.values()].sort((a, b) => b.score - a.score);
    return { rows: rows.slice(0, limit), total: rows.length };
  }
  async rank(nameKey, board, mode) {
    const { rows } = await this.fetch(board, mode, 100000);
    const i = rows.findIndex((r) => r.name.toLowerCase() === nameKey);
    return { rank: i >= 0 ? i + 1 : -1, total: rows.length, best: i >= 0 ? rows[i].score : null };
  }
}

export class SupabaseAdapter {
  constructor(url, anonKey) {
    this.url = url.replace(/\/$/, '');
    this.key = anonKey;
  }
  _headers() {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' };
  }
  async claimName(name, secret) {
    let res;
    try {
      res = await withTimeout(fetch(`${this.url}/functions/v1/claim-name`, { method: 'POST', headers: this._headers(), body: JSON.stringify({ name, secret }) }), FETCH_TIMEOUT_MS);
    } catch {
      return { ok: false, reason: 'offline' };
    }
    if (res.status === 409) return { ok: false, reason: 'taken' };
    if (res.status === 422) return { ok: false, reason: 'invalid' };
    if (!res.ok) return { ok: false, reason: 'offline' };
    const data = await res.json();
    return { ok: true, name: data.name };
  }
  async submit(row) {
    const res = await withTimeout(fetch(`${this.url}/functions/v1/submit-score`, { method: 'POST', headers: this._headers(), body: JSON.stringify(row) }), FETCH_TIMEOUT_MS);
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => res.statusText);
    // 422 = validation rejected for good (don't retry); 403 = identity problem.
    return { ok: false, reason: text || res.statusText, retry: res.status === 429 || res.status >= 500 };
  }
  async fetch(board, mode, limit) {
    const view = board === 'daily' ? 'leaderboard_daily' : board === 'weekly' ? 'leaderboard_weekly' : 'leaderboard_alltime';
    const now = new Date();
    let filter = `&mode=eq.${mode}`;
    if (board === 'daily') filter += `&day=eq.${now.toISOString().slice(0, 10)}`;
    if (board === 'weekly') filter += `&week=eq.${weekKey(now)}`;
    const res = await withTimeout(
      fetch(`${this.url}/rest/v1/${view}?select=*&order=score.desc,created_at.asc&limit=${limit}${filter}`, { headers: { ...this._headers(), Prefer: 'count=exact' } }),
      FETCH_TIMEOUT_MS
    );
    if (!res.ok) throw new Error(`leaderboard fetch failed: ${res.status}`);
    const rows = await res.json();
    const range = res.headers.get('content-range') || '';
    const total = parseInt(range.split('/')[1], 10);
    return { rows, total: Number.isFinite(total) ? total : rows.length };
  }
  async rank(nameKey, board, mode) {
    const res = await withTimeout(
      fetch(`${this.url}/rest/v1/rpc/player_rank`, { method: 'POST', headers: this._headers(), body: JSON.stringify({ p_name_key: nameKey, p_board: board, p_mode: mode }) }),
      FETCH_TIMEOUT_MS
    );
    if (!res.ok) return { rank: -1, total: 0, best: null };
    const [row] = await res.json();
    return row && row.best !== null ? { rank: Number(row.rank), total: Number(row.total), best: row.best } : { rank: -1, total: Number(row?.total || 0), best: null };
  }
}

export class Leaderboard {
  constructor() {
    const url = import.meta.env?.VITE_SUPABASE_URL;
    const key = import.meta.env?.VITE_SUPABASE_ANON_KEY;
    this.adapter = url && key ? new SupabaseAdapter(url, key) : new LocalAdapter();
    this.backend = url && key ? 'supabase' : 'local';
    this.cache = new Map();     // key → { at, data }
    this.inflight = new Map();  // key → promise
    this.backoffUntil = 0;
    this.backoffMs = 1000;
    this.friends = new Set();
    try {
      for (const f of JSON.parse(localStorage.getItem(FRIENDS_KEY) || '[]')) this.friends.add(f);
    } catch {
      /* ignore */
    }
    this.queue = [];
    try {
      this.queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch {
      this.queue = [];
    }
  }

  static dailySeed() {
    return dailySeed();
  }

  addFriend(name) {
    this.friends.add(name.trim());
    this._saveFriends();
  }
  removeFriend(name) {
    this.friends.delete(name);
    this._saveFriends();
  }
  _saveFriends() {
    try {
      localStorage.setItem(FRIENDS_KEY, JSON.stringify([...this.friends]));
    } catch {
      /* ignore */
    }
  }
  _saveQueue() {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue.slice(0, 50)));
    } catch {
      /* ignore */
    }
  }

  /** Validate locally (fast feedback), then persist; failures are queued. */
  async submit(payload, secret) {
    const v = validateSubmission(payload);
    if (!v.ok) return { ok: false, reason: v.reason };
    const now = new Date();
    const row = { ...payload, secret, day: now.toISOString().slice(0, 10), week: weekKey(now), created_at: now.toISOString() };
    let res;
    try {
      res = await this.adapter.submit(row);
    } catch (e) {
      res = { ok: false, reason: String(e.message || e), retry: true };
    }
    if (!res.ok && res.retry !== false && (res.retry || /timeout|fetch/i.test(res.reason || ''))) {
      this.queue.push(row);
      this._saveQueue();
      res.queued = true;
    }
    this.cache.clear();
    return res;
  }

  /** Retry queued submissions (call from the menu; never from the frame loop). */
  async flushQueue() {
    if (this.queue.length === 0 || Date.now() < this.backoffUntil) return;
    const row = this.queue[0];
    let res;
    try {
      res = await this.adapter.submit(row);
    } catch {
      res = { ok: false, retry: true };
    }
    if (res.ok || res.retry === false) {
      this.queue.shift();
      this._saveQueue();
      this.backoffMs = 1000;
      this.cache.clear();
    } else {
      this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
      this.backoffUntil = Date.now() + this.backoffMs;
    }
  }

  /**
   * @param board 'daily' | 'weekly' | 'alltime'
   * @param opts  { friendsOnly, playerName, mode }
   * @returns {{rows, playerRank, playerRow, total}}
   */
  async fetch(board = 'alltime', opts = {}) {
    const mode = opts.mode || 'free';
    const key = `${board}:${mode}`;
    const cached = this.cache.get(key);
    let data;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      data = cached.data;
    } else if (this.inflight.has(key)) {
      data = await this.inflight.get(key);
    } else if (Date.now() < this.backoffUntil && cached) {
      data = cached.data; // backing off: serve stale rather than hammer
    } else {
      const p = this.adapter
        .fetch(board, mode, 100)
        .then((d) => {
          this.cache.set(key, { at: Date.now(), data: d });
          this.backoffMs = 1000;
          return d;
        })
        .catch((e) => {
          this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
          this.backoffUntil = Date.now() + this.backoffMs;
          if (cached) return cached.data;
          throw e;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
      data = await p;
    }

    let playerRank = -1;
    let playerRow = null;
    if (opts.playerName) {
      const nk = opts.playerName.toLowerCase();
      const i = data.rows.findIndex((r) => (r.name_key || r.name.toLowerCase()) === nk);
      if (i >= 0) {
        playerRank = i + 1;
        playerRow = data.rows[i];
      } else if (data.total > data.rows.length) {
        // Not in the top 100: ask the server for the exact rank (one cheap RPC).
        try {
          const r = await this.adapter.rank(nk, board, mode);
          playerRank = r.rank;
        } catch {
          /* leave unknown */
        }
      }
    }
    let visible = data.rows;
    if (opts.friendsOnly) visible = visible.filter((r) => this.friends.has(r.name) || r.name === opts.playerName);
    return { rows: visible, playerRank, playerRow, total: data.total };
  }
}
