// Supabase Edge Function: claim a globally unique player name.
// POST { name, secret } → { ok, name } | 409 "taken" | 422 invalid.
// The same device may re-claim its own name (secret matches) at any time.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400, headers: cors });
  }
  const name = String(body.name || '').trim();
  const secret = String(body.secret || '');
  // Any printable characters (letters, numbers, symbols); control chars refused.
  if (name.length < 2 || name.length > 24 || /[\p{C}]/u.test(name)) {
    return new Response('invalid name', { status: 422, headers: cors });
  }
  if (secret.length < 16 || secret.length > 128) return new Response('invalid secret', { status: 422, headers: cors });

  const key = name.toLowerCase();
  const hash = await sha256(secret);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: existing } = await supabase.from('players').select('name, secret_hash').eq('name_key', key).maybeSingle();
  if (existing) {
    if (existing.secret_hash === hash) {
      await supabase.from('players').update({ last_seen: new Date().toISOString() }).eq('name_key', key);
      return new Response(JSON.stringify({ ok: true, name: existing.name }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    return new Response('taken', { status: 409, headers: cors });
  }
  // Unique index on name_key makes a concurrent double-claim fail safely.
  const { error } = await supabase.from('players').insert({ name, name_key: key, secret_hash: hash });
  if (error) {
    if (String(error.code) === '23505') return new Response('taken', { status: 409, headers: cors });
    return new Response(error.message, { status: 500, headers: cors });
  }
  return new Response(JSON.stringify({ ok: true, name }), { headers: { ...cors, 'Content-Type': 'application/json' } });
});
