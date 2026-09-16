// Score validation — pure, dependency-free, and copied verbatim into the
// Supabase Edge Function so client and server agree exactly.

export const POINTS_PER_MODAK = 100;
export const STREAK_BONUSES = { 3: 50, 5: 150, 10: 500 };
// Ring minimum is 60 u; sprint is 22 u/s; a question takes ≥ ~2 s. Ten per
// minute is already above what a human can sustain; +3 covers the first
// seconds of a short run.
export const MAX_MODAKS_PER_MINUTE = 10;
export const GRACE_MODAKS = 3;

/**
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateSubmission(s) {
  if (!s || typeof s !== 'object') return { ok: false, reason: 'bad payload' };
  const name = String(s.name || '').trim();
  if (name.length < 1 || name.length > 24) return { ok: false, reason: 'name length' };

  const ints = ['score', 'modaks_collected', 'longest_streak', 'play_duration', 'world_seed'];
  for (const k of ints) {
    if (!Number.isInteger(s[k]) || s[k] < 0) return { ok: false, reason: `bad ${k}` };
  }
  if (typeof s.accuracy_pct !== 'number' || s.accuracy_pct < 0 || s.accuracy_pct > 100) {
    return { ok: false, reason: 'bad accuracy' };
  }
  if (!Array.isArray(s.bonus_events)) return { ok: false, reason: 'bad bonus_events' };

  const modaks = s.modaks_collected;
  const counts = { 3: 0, 5: 0, 10: 0 };
  let bonusTotal = 0;
  for (const e of s.bonus_events) {
    if (!(e in STREAK_BONUSES)) return { ok: false, reason: 'bad bonus event' };
    counts[e]++;
    bonusTotal += STREAK_BONUSES[e];
  }

  // A bonus at streak N requires N correct answers in a row, so at most
  // floor(modaks / N) such bonuses can exist, and none if the longest streak
  // never reached N.
  for (const n of [3, 5, 10]) {
    if (counts[n] > Math.floor(modaks / n)) return { ok: false, reason: `too many ${n}-streak bonuses` };
    if (counts[n] > 0 && s.longest_streak < n) return { ok: false, reason: `streak too short for ${n}-bonus` };
  }
  if (s.longest_streak > modaks) return { ok: false, reason: 'streak exceeds modaks' };

  const expected = modaks * POINTS_PER_MODAK + bonusTotal;
  if (s.score !== expected) return { ok: false, reason: `score ${s.score} != expected ${expected}` };

  const minutes = s.play_duration / 60;
  if (modaks > MAX_MODAKS_PER_MINUTE * minutes + GRACE_MODAKS) {
    return { ok: false, reason: 'modaks per minute exceeds physical limit' };
  }
  return { ok: true };
}

/** Shared daily seed: everyone playing on the same UTC date gets the same world. */
export function dailySeed(date = new Date()) {
  const key = date.toISOString().slice(0, 10); // YYYY-MM-DD
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
