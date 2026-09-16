// Supabase Edge Function: validates a score submission server-side and inserts
// it with the service role. The validation is a verbatim copy of
// src/leaderboard/validate.js — keep the two in sync.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const MIN_SECONDS_BETWEEN_SUBMITS = 20;

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const POINTS_PER_MODAK = 100;
const STREAK_BONUSES: Record<number, number> = { 3: 50, 5: 150, 10: 500 };
const MAX_MODAKS_PER_MINUTE = 10;
const GRACE_MODAKS = 3;

function validateSubmission(s: any): { ok: boolean; reason?: string } {
  if (!s || typeof s !== 'object') return { ok: false, reason: 'bad payload' };
  const name = String(s.name || '').trim();
  if (name.length < 1 || name.length > 24) return { ok: false, reason: 'name length' };
  for (const k of ['score', 'modaks_collected', 'longest_streak', 'play_duration', 'world_seed']) {
    if (!Number.isInteger(s[k]) || s[k] < 0) return { ok: false, reason: `bad ${k}` };
  }
  if (typeof s.accuracy_pct !== 'number' || s.accuracy_pct < 0 || s.accuracy_pct > 100) {
    return { ok: false, reason: 'bad accuracy' };
  }
  if (!Array.isArray(s.bonus_events)) return { ok: false, reason: 'bad bonus_events' };
  const modaks = s.modaks_collected;
  const counts: Record<number, number> = { 3: 0, 5: 0, 10: 0 };
  let bonusTotal = 0;
  for (const e of s.bonus_events) {
    if (!(e in STREAK_BONUSES)) return { ok: false, reason: 'bad bonus event' };
    counts[e]++;
    bonusTotal += STREAK_BONUSES[e];
  }
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

function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400, headers: cors });
  }
  const v = validateSubmission(body);
  if (!v.ok) return new Response(`rejected: ${v.reason}`, { status: 422, headers: cors });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const nameKey = String(body.name).trim().toLowerCase();

  // Identity: the submitting device must hold the secret that claimed the name.
  const { data: player } = await supabase.from('players').select('name, secret_hash').eq('name_key', nameKey).maybeSingle();
  if (!player) return new Response('unknown player: claim the name first', { status: 403, headers: cors });
  if (player.secret_hash !== (await sha256(String(body.secret || '')))) return new Response('name belongs to another player', { status: 403, headers: cors });

  // Rate limit: one submission per player per MIN_SECONDS_BETWEEN_SUBMITS.
  const { data: last } = await supabase.from('scores').select('created_at').eq('name_key', nameKey).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.created_at).getTime() < MIN_SECONDS_BETWEEN_SUBMITS * 1000) {
    return new Response('too many submissions', { status: 429, headers: cors });
  }

  const now = new Date();
  const { error } = await supabase.from('scores').insert({
    name: player.name,
    name_key: nameKey,
    score: body.score,
    modaks_collected: body.modaks_collected,
    accuracy_pct: body.accuracy_pct,
    longest_streak: body.longest_streak,
    play_duration: body.play_duration,
    world_seed: body.world_seed,
    bonus_events: body.bonus_events,
    mode: body.mode === 'hunt' ? 'hunt' : 'free',
    day: now.toISOString().slice(0, 10),
    week: weekKey(now),
  });
  if (error) return new Response(error.message, { status: 500, headers: cors });
  await supabase.from('players').update({ last_seen: now.toISOString() }).eq('name_key', nameKey);
  return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
