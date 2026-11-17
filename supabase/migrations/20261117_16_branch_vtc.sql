-- ============================================================================
-- Migration 16 -- branch names, and Talat Sao becomes Vientiane Center.
--
-- Decided 2026-11-17 (the owner):
--   B-MM  ຕະຫລາດເຊົ້າ   Morning Market
--   B-TS  ->  B-VTC  ວຽງຈັນເຊັນເຕີ  Vientiane Center  (cases TS-Dxx -> VTC-Dxx)
--   B-IT  ໄອເຕັກ        ITECC
--   B-VT  ວັງທອງ        Vangthong
--   Order unchanged: MM 1, VTC 2, IT 3, VT 4.
--
-- The B-TS -> B-VTC move rewrites the branch and case codes in EVERY table
-- that holds one (found by column name: branch_id / *_branch_id, desk_id /
-- *_desk_id), except audit_log: it is append-only, so entries written before
-- this keep B-TS / TS-Dxx. The app reads those as the same branch / case
-- (src/legacyCodes.ts). Document numbers already issued (DOC-TS-...) keep
-- their number; the counter carries on, so the next one is DOC-VTC-<year>-<n+1>.
--
-- While the rows move, the user triggers on those tables are switched off
-- (done-day locks, "case origin is frozen", the assignment history guard, the
-- per-row audit) and switched back on before the end; one audit entry records
-- the move instead. All in one transaction: it moves everything or nothing.
--
-- Safe to run again: the move only happens while B-TS exists and B-VTC does
-- not. Run in the Supabase SQL editor, then re-run users_roles.sql.
-- ============================================================================

begin;

update branches set name_lo = 'ຕະຫລາດເຊົ້າ', name_en = 'Morning Market', sort_order = 1 where branch_id = 'B-MM';
update branches set name_lo = 'ໄອເຕັກ',      name_en = 'ITECC',          sort_order = 3 where branch_id = 'B-IT';
update branches set name_lo = 'ວັງທອງ',      name_en = 'Vangthong',      sort_order = 4 where branch_id = 'B-VT';

do $$
declare
  c record;
  t text;
  tables text[];
  deferred text[] := '{}';
  n_desks int;
begin
  if not exists (select 1 from branches where branch_id = 'B-TS') or exists (select 1 from branches where branch_id = 'B-VTC') then
    raise notice 'branch_vtc: nothing to move (B-TS absent or B-VTC present)';
    return;
  end if;

  -- Every table holding a branch or case code (audit_log stays as written).
  select array_agg(distinct table_name::text) into tables
    from information_schema.columns
   where table_schema = 'public'
     and table_name <> 'audit_log'
     and table_name in (select tablename from pg_tables where schemaname = 'public')
     and (column_name ~ '(^|_)branch_id$' or column_name ~ '(^|_)desk_id$');
  tables := array(select distinct unnest(tables || array['branches', 'desks']));

  foreach t in array tables loop
    execute format('alter table %I disable trigger user', t);
  end loop;

  -- Some keys span two moved tables (a ledger row points at its case day by
  -- desk_id + date), so no update order satisfies them row by row. Their
  -- foreign keys are checked once, after every row has moved.
  for c in
    select con.conname::text as name, rel.relname::text as tbl
      from pg_constraint con join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public' and con.contype = 'f' and not con.condeferrable
       and rel.relname::text = any (tables)
  loop
    execute format('alter table %I alter constraint %I deferrable initially immediate', c.tbl, c.name);
    deferred := deferred || array[c.tbl || '.' || c.name];
  end loop;
  set constraints all deferred;

  -- The new branch and its cases, copied column for column.
  insert into branches
  select (jsonb_populate_record(null::branches, to_jsonb(b) || jsonb_build_object(
           'branch_id', 'B-VTC', 'name_en', 'Vientiane Center', 'name_lo', 'ວຽງຈັນເຊັນເຕີ', 'sort_order', 2))).*
    from branches b where b.branch_id = 'B-TS';

  insert into desks
  select (jsonb_populate_record(null::desks, to_jsonb(d) || jsonb_build_object(
           'desk_id', 'VTC-' || substr(d.desk_id, 4), 'branch_id', 'B-VTC'))).*
    from desks d where d.branch_id = 'B-TS' and d.desk_id like 'TS-%';
  get diagnostics n_desks = row_count;
  if exists (select 1 from desks where branch_id = 'B-TS' and desk_id not like 'TS-%') then
    raise exception 'branch_vtc: a B-TS case does not start with TS-; rename it by hand first';
  end if;

  -- Point every row at the new codes.
  for c in
    select table_name::text as tbl, column_name::text as col
      from information_schema.columns
     where table_schema = 'public'
       and table_name <> all (array['audit_log', 'branches', 'desks'])
       and table_name in (select tablename from pg_tables where schemaname = 'public')
       and (column_name ~ '(^|_)branch_id$' or column_name ~ '(^|_)desk_id$')
  loop
    if c.col ~ 'branch_id$' then
      execute format('update %I set %I = %L where %I = %L', c.tbl, c.col, 'B-VTC', c.col, 'B-TS');
    else
      execute format('update %I set %I = %L || substr(%I, 4) where %I like %L', c.tbl, c.col, 'VTC-', c.col, c.col, 'TS-%');
    end if;
  end loop;

  -- Nothing may still point at the old codes (the foreign keys refuse it too).
  delete from desks where branch_id = 'B-TS';
  delete from branches where branch_id = 'B-TS';

  -- Check every key now (fails the whole migration if anything still points
  -- at B-TS / TS-Dxx), then put the keys and triggers back as they were.
  set constraints all immediate;
  foreach t in array deferred loop
    execute format('alter table %I alter constraint %I not deferrable', split_part(t, '.', 1), split_part(t, '.', 2));
  end loop;
  foreach t in array tables loop
    execute format('alter table %I enable trigger user', t);
  end loop;

  insert into audit_log (actor_name, action, target, table_name, op, branch_id, source, detail)
  values ('system', 'branch.rename', 'B-TS -> B-VTC', 'branches', 'UPDATE', 'B-VTC', 'migration',
          jsonb_build_object('from', 'B-TS', 'to', 'B-VTC', 'name_lo', 'ວຽງຈັນເຊັນເຕີ', 'cases', n_desks,
                             'case_codes', 'TS-Dxx -> VTC-Dxx'));
end $$;

commit;
