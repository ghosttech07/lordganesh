-- Fast path: claim-name and submit-score as single-round-trip Postgres
-- functions, callable through PostgREST with the anon key. They run as
-- SECURITY DEFINER so anon never needs table privileges; every rule the Edge
-- Functions enforce (validation, identity secret, rate limit) lives here too.

create extension if not exists pgcrypto;

create or replace function public.claim_name(p_name text, p_secret text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_name text := btrim(regexp_replace(p_name, '\s+', ' ', 'g'));
  v_key  text;
  v_hash text;
  v_row  players%rowtype;
begin
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 24 or v_name ~ '[\x00-\x1F\x7F]' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_secret is null or char_length(p_secret) < 16 or char_length(p_secret) > 128 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  v_key  := lower(v_name);
  v_hash := encode(digest(p_secret, 'sha256'), 'hex');

  select * into v_row from players where name_key = v_key;
  if found then
    if v_row.secret_hash = v_hash then
      update players set last_seen = now() where name_key = v_key;
      return jsonb_build_object('ok', true, 'name', v_row.name);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end if;

  begin
    insert into players (name, name_key, secret_hash) values (v_name, v_key, v_hash);
  exception when unique_violation then
    -- Lost a race with another device claiming the same name this instant.
    return jsonb_build_object('ok', false, 'reason', 'taken');
  end;
  return jsonb_build_object('ok', true, 'name', v_name);
end $$;

create or replace function public.submit_score(p jsonb, p_secret text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key      text;
  v_player   players%rowtype;
  v_modaks   int;
  v_score    int;
  v_streak   int;
  v_dur      int;
  v_bonus    int := 0;
  v_c3       int := 0;
  v_c5       int := 0;
  v_c10      int := 0;
  v_e        jsonb;
  v_mode     text;
  v_last     timestamptz;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad payload'); end if;
  v_key := lower(btrim(coalesce(p->>'name', '')));
  if char_length(v_key) < 2 then return jsonb_build_object('ok', false, 'reason', 'name'); end if;

  -- Identity: the device must hold the secret that claimed the name.
  select * into v_player from players where name_key = v_key;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown player: claim the name first', 'status', 403); end if;
  if v_player.secret_hash <> encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex') then
    return jsonb_build_object('ok', false, 'reason', 'name belongs to another player', 'status', 403);
  end if;

  -- Validation (mirrors src/leaderboard/validate.js).
  begin
    v_modaks := (p->>'modaks_collected')::int;
    v_score  := (p->>'score')::int;
    v_streak := (p->>'longest_streak')::int;
    v_dur    := (p->>'play_duration')::int;
  exception when others then return jsonb_build_object('ok', false, 'reason', 'bad numbers'); end;
  if v_modaks < 0 or v_score < 0 or v_streak < 0 or v_dur < 0 then return jsonb_build_object('ok', false, 'reason', 'negative'); end if;
  if (p->>'accuracy_pct')::numeric < 0 or (p->>'accuracy_pct')::numeric > 100 then return jsonb_build_object('ok', false, 'reason', 'bad accuracy'); end if;
  if jsonb_typeof(p->'bonus_events') <> 'array' then return jsonb_build_object('ok', false, 'reason', 'bad bonus_events'); end if;
  for v_e in select * from jsonb_array_elements(p->'bonus_events') loop
    case v_e::text
      when '3'  then v_c3  := v_c3  + 1; v_bonus := v_bonus + 50;
      when '5'  then v_c5  := v_c5  + 1; v_bonus := v_bonus + 150;
      when '10' then v_c10 := v_c10 + 1; v_bonus := v_bonus + 500;
      else return jsonb_build_object('ok', false, 'reason', 'bad bonus event');
    end case;
  end loop;
  if v_c3 > v_modaks / 3 or v_c5 > v_modaks / 5 or v_c10 > v_modaks / 10 then return jsonb_build_object('ok', false, 'reason', 'too many streak bonuses'); end if;
  if (v_c3 > 0 and v_streak < 3) or (v_c5 > 0 and v_streak < 5) or (v_c10 > 0 and v_streak < 10) then return jsonb_build_object('ok', false, 'reason', 'streak too short for bonus'); end if;
  if v_streak > v_modaks then return jsonb_build_object('ok', false, 'reason', 'streak exceeds modaks'); end if;
  if v_score <> v_modaks * 100 + v_bonus then return jsonb_build_object('ok', false, 'reason', format('score %s != expected %s', v_score, v_modaks * 100 + v_bonus)); end if;
  if v_modaks > 10 * (v_dur / 60.0) + 3 then return jsonb_build_object('ok', false, 'reason', 'modaks per minute exceeds physical limit'); end if;

  -- Rate limit: one submission per player per 20 s.
  select max(created_at) into v_last from scores where name_key = v_key;
  if v_last is not null and now() - v_last < interval '20 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'too many submissions', 'status', 429);
  end if;

  v_mode := case when p->>'mode' = 'hunt' then 'hunt' else 'free' end;
  insert into scores (name, name_key, score, modaks_collected, accuracy_pct, longest_streak, play_duration, world_seed, bonus_events, mode, day, week)
  values (v_player.name, v_key, v_score, v_modaks, (p->>'accuracy_pct')::numeric, v_streak, v_dur, (p->>'world_seed')::bigint, p->'bonus_events', v_mode,
          (now() at time zone 'utc')::date, to_char(now() at time zone 'utc', 'IYYY-"W"IW'));
  update players set last_seen = now() where name_key = v_key;
  return jsonb_build_object('ok', true);
end $$;

-- Rank on one board only (no UNION over all three views).
create or replace function public.player_rank(p_name_key text, p_board text, p_mode text)
returns table(rank bigint, total bigint, best integer)
language plpgsql stable as $$
declare v_best int; v_total bigint; v_rank bigint;
begin
  if p_board = 'daily' then
    select score into v_best from leaderboard_daily where mode = p_mode and day = (now() at time zone 'utc')::date and name_key = p_name_key;
    select count(*) into v_total from leaderboard_daily where mode = p_mode and day = (now() at time zone 'utc')::date;
    select count(*) + 1 into v_rank from leaderboard_daily where mode = p_mode and day = (now() at time zone 'utc')::date and score > coalesce(v_best, -1);
  elsif p_board = 'weekly' then
    select score into v_best from leaderboard_weekly where mode = p_mode and week = to_char(now() at time zone 'utc', 'IYYY-"W"IW') and name_key = p_name_key;
    select count(*) into v_total from leaderboard_weekly where mode = p_mode and week = to_char(now() at time zone 'utc', 'IYYY-"W"IW');
    select count(*) + 1 into v_rank from leaderboard_weekly where mode = p_mode and week = to_char(now() at time zone 'utc', 'IYYY-"W"IW') and score > coalesce(v_best, -1);
  else
    select score into v_best from leaderboard_alltime where mode = p_mode and name_key = p_name_key;
    select count(*) into v_total from leaderboard_alltime where mode = p_mode;
    select count(*) + 1 into v_rank from leaderboard_alltime where mode = p_mode and score > coalesce(v_best, -1);
  end if;
  return query select case when v_best is null then null::bigint else v_rank end, v_total, v_best;
end $$;

revoke all on function public.claim_name(text, text) from public;
revoke all on function public.submit_score(jsonb, text) from public;
grant execute on function public.claim_name(text, text) to anon, authenticated;
grant execute on function public.submit_score(jsonb, text) to anon, authenticated;
grant execute on function public.player_rank(text, text, text) to anon, authenticated;
