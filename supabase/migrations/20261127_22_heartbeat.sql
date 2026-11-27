-- Heartbeat (added 2026-11-27). Idempotent; safe to re-run.
--
-- Supabase pauses a free project after 7 days with no activity. The Worker's
-- GitHub Action (daily) and the Worker cron (every 3 days) update this one
-- row, so the project never goes 7 days quiet. Nothing in the app reads it.
create table if not exists heartbeat (
  id      int primary key default 1 check (id = 1),
  beat_at timestamptz not null default now(),
  beats   bigint not null default 0,
  source  text not null default 'cron'
);
alter table heartbeat enable row level security;
insert into heartbeat (id) values (1) on conflict (id) do nothing;

-- Called by the GitHub Action (.github/workflows/supabase-awake.yml) with the
-- anon key, and by the Worker cron. It only bumps this one row, so anon may run it.
create or replace function heartbeat_beat(p_source text default 'cron')
returns heartbeat language sql security definer set search_path = public as $$
  update heartbeat set beat_at = now(), beats = beats + 1, source = coalesce(p_source, 'cron')
   where id = 1
  returning *;
$$;
revoke all on function heartbeat_beat(text) from public, authenticated;
grant execute on function heartbeat_beat(text) to anon;
