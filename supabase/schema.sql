-- Scores + player identities for "Ganesh & Unlimited Modak".
-- Apply this file first, then supabase/rpc.sql (fast claim/submit/rank functions).
--
-- Reads are public through the views below. Writes happen ONLY through the
-- Edge Functions (service role): `claim-name` creates a player identity and
-- `submit-score` re-validates every submission and checks the player's secret.

-- ---------------------------------------------------------------- players
-- A name is claimed once, globally, case-insensitively. The device that
-- claimed it holds a secret; only it can submit scores under that name.
create table if not exists public.players (
  id           bigint generated always as identity primary key,
  name         text not null check (char_length(name) between 2 and 24),
  name_key     text not null unique,            -- lower(trim(name))
  secret_hash  text not null,                   -- sha256(secret)
  created_at   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

-- ----------------------------------------------------------------- scores
create table if not exists public.scores (
  id               bigint generated always as identity primary key,
  name             text not null check (char_length(name) between 2 and 24),
  name_key         text not null references public.players(name_key) on delete cascade,
  score            integer not null check (score >= 0),
  modaks_collected integer not null check (modaks_collected >= 0),
  accuracy_pct     numeric(5,1) not null check (accuracy_pct between 0 and 100),
  longest_streak   integer not null check (longest_streak >= 0),
  play_duration    integer not null check (play_duration >= 0),
  world_seed       bigint not null,
  bonus_events     jsonb not null default '[]',
  mode             text not null default 'free' check (mode in ('free','hunt')),
  day              date not null default (now() at time zone 'utc')::date,
  week             text not null,
  created_at       timestamptz not null default now()
);

create index if not exists scores_best_idx      on public.scores (mode, name_key, score desc);
create index if not exists scores_day_best_idx  on public.scores (mode, day, name_key, score desc);
create index if not exists scores_week_best_idx on public.scores (mode, week, name_key, score desc);
create index if not exists scores_rate_idx      on public.scores (name_key, created_at desc);

alter table public.players enable row level security;
alter table public.scores  enable row level security;
-- No policies for anon on the base tables: reads go through the views,
-- writes through the Edge Functions (service role bypasses RLS).

-- ------------------------------------------------------------------ views
-- Best score per player per board. Clients read these with `limit 100`, so a
-- crowded day never returns more than 100 rows, regardless of player count.
create or replace view public.leaderboard_alltime as
  select distinct on (mode, name_key)
    name, name_key, mode, score, modaks_collected, accuracy_pct, longest_streak, play_duration, world_seed, day, week, created_at
  from public.scores
  order by mode, name_key, score desc, created_at asc;

create or replace view public.leaderboard_daily as
  select distinct on (mode, day, name_key)
    name, name_key, mode, score, modaks_collected, accuracy_pct, longest_streak, play_duration, world_seed, day, week, created_at
  from public.scores
  order by mode, day, name_key, score desc, created_at asc;

create or replace view public.leaderboard_weekly as
  select distinct on (mode, week, name_key)
    name, name_key, mode, score, modaks_collected, accuracy_pct, longest_streak, play_duration, world_seed, day, week, created_at
  from public.scores
  order by mode, week, name_key, score desc, created_at asc;

grant select on public.leaderboard_alltime, public.leaderboard_daily, public.leaderboard_weekly to anon, authenticated;

-- Rank of one player on a board without pulling the whole board.
create or replace function public.player_rank(p_name_key text, p_board text, p_mode text)
returns table(rank bigint, total bigint, best integer)
language sql stable as $$
  with board as (
    select name_key, score from public.leaderboard_alltime where mode = p_mode and p_board = 'alltime'
    union all
    select name_key, score from public.leaderboard_daily   where mode = p_mode and p_board = 'daily'  and day  = (now() at time zone 'utc')::date
    union all
    select name_key, score from public.leaderboard_weekly  where mode = p_mode and p_board = 'weekly' and week = to_char(now() at time zone 'utc', 'IYYY-"W"IW')
  ),
  me as (select score from board where name_key = p_name_key)
  select
    (select count(*) + 1 from board, me where board.score > me.score) as rank,
    (select count(*) from board) as total,
    (select score from me) as best;
$$;
grant execute on function public.player_rank(text, text, text) to anon, authenticated;
