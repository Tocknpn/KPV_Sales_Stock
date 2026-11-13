-- ============================================================================
-- KPV Stock v2 -- PURGE of the tagged mock data. Paste into the SQL editor and
-- run. Safe to run twice. Never touches schema, base data, real users or any
-- other real row.
--
--   1. Prints kpv_seed_counts() (dry-run view of what is about to go).
--   2. In ONE atomic DO block: turns the purge allowances on for this
--      transaction only, deletes every is_seed row child-first, and removes
--      references from real rows to seed staff (see below).
--   3. Asserts every seed count is 0 and that each table has exactly as many
--      real rows as before; otherwise it raises and EVERYTHING rolls back.
--   4. Writes one permanent audit entry "seed.purge" with the counts.
--   The last statement prints kpv_seed_counts() again (all seed_rows = 0).
--
-- Real rows that point at a seed staff member (for example a real case a seed
-- admin once checked in) are kept; only that reference (performed_by,
-- checked_in_by, done_by, sent_by, received_by) is set to null. That is the
-- only change a purge makes to a real row, and the number is reported in the
-- audit entry.
-- ============================================================================

-- 1. Dry-run view
select * from kpv_seed_counts() order by table_name;

do $$
declare
  -- child first: nothing is deleted while a row still references it
  c_order constant text[] := array[
    'audit_log', 'document_rows', 'documents', 'doc_counters', 'desk_assignment', 'transfers',
    'daily_stock_ledger', 'desk_days', 'branch_closed_day', 'replenishment_rule', 'desks',
    'master_sku', 'sku_weight', 'sku_type', 'staff_accounts', 'branches'];
  v_tables  text[];
  v_before  jsonb;
  v_after   jsonb;
  v_deleted jsonb := '{}'::jsonb;
  v_nulled  jsonb := '{}'::jsonb;
  v_total_nulled bigint := 0;
  v_total_deleted bigint := 0;
  v_bad     text;
  t         text;
  r         record;
  n         bigint;
begin
  -- 2. allowances on, for this transaction only
  perform set_config('kpv.purging', 'on', true);

  -- The list above must cover every table that has is_seed; a table added in
  -- a later migration must be added here, never silently left with seed rows.
  select array_agg(table_name order by table_name) into v_tables from kpv_seed_counts();
  select string_agg(x, ', ') into v_bad from (
    select unnest(v_tables) as x except select unnest(c_order)) m;
  if v_bad is not null then
    raise exception 'PURGE_TABLE_MISSING: add % to purge_seed_data.sql', v_bad using errcode = 'P0001';
  end if;

  select jsonb_object_agg(table_name, real_rows) into v_before from kpv_seed_counts();

  foreach t in array c_order loop
    if t = 'staff_accounts' then
      -- Detach real rows from seed staff first: every nullable FK column that
      -- points at staff_accounts, found from the catalog.
      for r in
        select cl.relname::text as tbl, a.attname::text as col
          from pg_constraint k
          join pg_class cl on cl.oid = k.conrelid
          join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
         where k.contype = 'f' and k.confrelid = 'public.staff_accounts'::regclass
           and array_length(k.conkey, 1) = 1
           and not a.attnotnull
         order by 1, 2
      loop
        execute format(
          'update public.%1$I set %2$I = null where not is_seed and %2$I in (select id from public.staff_accounts where is_seed)',
          r.tbl, r.col);
        get diagnostics n = row_count;
        if n > 0 then
          v_nulled := v_nulled || jsonb_build_object(r.tbl || '.' || r.col, n);
          v_total_nulled := v_total_nulled + n;
        end if;
      end loop;
    end if;

    execute format('delete from public.%I where is_seed', t);
    get diagnostics n = row_count;
    v_deleted := v_deleted || jsonb_build_object(t, n);
    v_total_deleted := v_total_deleted + n;
  end loop;

  -- 3. Assertions: nothing seed left, no real row gained or lost.
  select string_agg(table_name || '=' || seed_rows, ', ') into v_bad from kpv_seed_counts() where seed_rows > 0;
  if v_bad is not null then
    raise exception 'PURGE_INCOMPLETE: seed rows remain: %', v_bad using errcode = 'P0001';
  end if;
  select jsonb_object_agg(table_name, real_rows) into v_after from kpv_seed_counts();
  if v_after is distinct from v_before then
    raise exception 'PURGE_TOUCHED_REAL_ROWS: real row counts changed (before %, after %)', v_before, v_after
      using errcode = 'P0001';
  end if;

  -- 4. One permanent, non-seed audit entry (allowances off first).
  perform set_config('kpv.purging', 'off', true);
  insert into audit_log (actor_id, actor_name, action, target, detail, source, is_seed)
  values (kpv_actor_id(), kpv_actor_source(), 'seed.purge', 'seed',
          jsonb_build_object('deleted', v_deleted, 'deleted_total', v_total_deleted,
                             'nulled', v_nulled, 'nulled_total', v_total_nulled),
          kpv_actor_source(), false);

  raise notice 'Seed purge done: % rows deleted, % references to seed staff removed from real rows.',
    v_total_deleted, v_total_nulled;
end $$;

select * from kpv_seed_counts() order by table_name;
