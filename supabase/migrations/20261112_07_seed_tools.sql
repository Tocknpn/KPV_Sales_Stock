-- ============================================================================
-- Migration 07 (v2): seed tooling. Idempotent.
--   * kpv_seed_counts(): seed vs real row counts for every table with is_seed.
--   * ledger_guard_done(): purge-aware, now also allowing the one repair the
--     purge needs (see below). Supersedes the definition in migration 01.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Seed vs real row counts, one line per base table that has an is_seed column
-- (found from the catalog, so a table added later is covered automatically).
-- ---------------------------------------------------------------------------
create or replace function kpv_seed_counts()
returns table (table_name text, seed_rows bigint, real_rows bigint)
language plpgsql stable as $$
declare
  t text;
  s bigint;
  r bigint;
begin
  for t in
    select c.relname::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'is_seed' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by c.relname
  loop
    execute format(
      'select count(*) filter (where is_seed), count(*) filter (where not is_seed) from public.%I', t)
      into s, r;
    table_name := t;
    seed_rows := s;
    real_rows := r;
    return next;
  end loop;
end $$;

revoke execute on function kpv_seed_counts() from public, anon, authenticated;
grant execute on function kpv_seed_counts() to service_role;

-- ---------------------------------------------------------------------------
-- Done lock. While kpv.purging = 'on' it allows exactly two things:
--   1. deleting a seed row (migration 01);
--   2. on a NON-seed ledger row, setting performed_by to null when it
--      currently names a seed staff member, and changing nothing else. This
--      lets the purge remove a seed admin who once worked on a real case
--      without deleting or otherwise editing the real row.
-- Everything else about a Done day stays locked.
-- ---------------------------------------------------------------------------
create or replace function ledger_guard_done() returns trigger
language plpgsql as $$
declare
  v_desk text;
  v_date date;
  v_status text;
begin
  if kpv_is_purging() then
    if tg_op = 'DELETE' and old.is_seed then return old; end if;
    if tg_op = 'UPDATE'
       and not old.is_seed and not new.is_seed
       and old.performed_by is not null and new.performed_by is null
       and exists (select 1 from staff_accounts s where s.id = old.performed_by and s.is_seed)
       and (to_jsonb(new) - 'performed_by' - 'updated_at' - 'closing_qty')
         = (to_jsonb(old) - 'performed_by' - 'updated_at' - 'closing_qty') then
      return new;
    end if;
  end if;

  if tg_op = 'DELETE' then
    v_desk := old.desk_id; v_date := old.ledger_date;
  else
    v_desk := new.desk_id; v_date := new.ledger_date;
  end if;
  select status into v_status from desk_days where desk_id = v_desk and ledger_date = v_date;
  if v_status = 'done' then
    raise exception 'DAY_LOCKED: % % is Done', v_desk, v_date using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
