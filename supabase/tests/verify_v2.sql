-- ============================================================================
-- KPV Stock v2 -- self-check for a real Supabase test project.
-- Run in the SQL editor AFTER supabase/seed_mock_data.sql. Read-only.
-- Every check is a plain "raise exception" block; the script ends by printing
-- VERIFY_V2 OK. Any failure stops with a message naming what is wrong.
-- ============================================================================

-- Tables, helpers and guards from the migrations are in place.
do $$
declare
  t text;
begin
  foreach t in array array['branch_closed_day', 'desk_assignment', 'replenishment_rule'] loop
    if to_regclass('public.' || t) is null then
      raise exception 'VERIFY_V2: table % is missing (run the migrations)', t;
    end if;
  end loop;
  if to_regprocedure('kpv_seed_counts()') is null or to_regprocedure('branch_velocity(text,date,integer)') is null then
    raise exception 'VERIFY_V2: kpv_seed_counts / branch_velocity missing (run the migrations)';
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity) then
    raise exception 'VERIFY_V2: a public table has row level security off: %',
      (select string_agg(tablename, ', ') from pg_tables where schemaname = 'public' and not rowsecurity);
  end if;
end $$;

-- Seed branches, cases, SKUs, staff.
do $$
begin
  if (select count(*) from branches where branch_id in ('B-TST1', 'B-TST2') and is_seed) <> 2 then
    raise exception 'VERIFY_V2: seed branches B-TST1 / B-TST2 missing';
  end if;
  if (select count(*) from desks where is_seed and branch_id = 'B-TST1') <> 4
     or (select count(*) from desks where is_seed and branch_id = 'B-TST2') <> 1 then
    raise exception 'VERIFY_V2: expected 4 cases in B-TST1 and 1 in B-TST2';
  end if;
  if (select count(*) from master_sku where is_seed and sku_id like 'SEED-%') <> 6
     or (select count(*) from master_sku where is_seed and group_name = 'Snake Necklace') <> 4 then
    raise exception 'VERIFY_V2: seed SKUs / group "Snake Necklace" are wrong';
  end if;
  if (select count(*) from staff_accounts where is_seed and role = 'admin' and display_name = 'Test Admin') <> 1
     or (select count(*) from staff_accounts where is_seed and role = 'manager') <> 1
     or (select count(*) from staff_accounts where is_seed and role = 'staff') <> 3 then
    raise exception 'VERIFY_V2: seed staff are wrong';
  end if;
  if not exists (select 1 from replenishment_rule
                  where is_seed and scope = 'group' and scope_key = 'Snake Necklace' and branch_id is null
                    and lead_time_days = 7 and avg_daily_sell = 100) then
    raise exception 'VERIFY_V2: group rule (lead 7, avg 100) missing';
  end if;
end $$;

-- T1-1 is Done today.
do $$
begin
  if not exists (select 1 from desk_days where desk_id = 'T1-1' and ledger_date = kpv_today() and status = 'done') then
    raise exception 'VERIFY_V2: T1-1 is not Done today';
  end if;
end $$;

-- T1-2 and T1-3: checked in today, 21 Done days before.
do $$
declare
  d text;
begin
  foreach d in array array['T1-2', 'T1-3'] loop
    if not exists (select 1 from desk_days where desk_id = d and ledger_date = kpv_today() and status = 'check_in') then
      raise exception 'VERIFY_V2: % is not checked in today', d;
    end if;
    if (select count(*) from desk_days where desk_id = d and status = 'done' and ledger_date < kpv_today()) <> 21 then
      raise exception 'VERIFY_V2: % should have 21 Done days before today', d;
    end if;
  end loop;
end $$;

-- T1-4: last Done = today - 4, nothing after it.
do $$
begin
  if (select max(ledger_date) from desk_days where desk_id = 'T1-4' and status = 'done') is distinct from kpv_today() - 4 then
    raise exception 'VERIFY_V2: T1-4 last Done day is not today - 4';
  end if;
  if exists (select 1 from desk_days where desk_id = 'T1-4' and ledger_date > kpv_today() - 4) then
    raise exception 'VERIFY_V2: T1-4 has a day after today - 4';
  end if;
end $$;

-- The closed day, and nobody worked it.
do $$
begin
  if not exists (select 1 from branch_closed_day where branch_id = 'B-TST1' and closed_date = kpv_today() - 10) then
    raise exception 'VERIFY_V2: B-TST1 closed day (today - 10) missing';
  end if;
  if exists (select 1 from desk_days where branch_id = 'B-TST1' and ledger_date = kpv_today() - 10) then
    raise exception 'VERIFY_V2: a B-TST1 desk day exists on the closed day';
  end if;
end $$;

-- Velocity for SEED-SNK-1 exists (>= 7 in-stock days) and skips the two zero-stock days.
do $$
declare
  v record;
begin
  select * into v from branch_velocity('B-TST1', kpv_today(), 28) where sku_id = 'SEED-SNK-1';
  if not found or v.velocity is null then
    raise exception 'VERIFY_V2: no velocity for SEED-SNK-1 in B-TST1';
  end if;
  if v.in_stock_days <> 19 then
    raise exception 'VERIFY_V2: SEED-SNK-1 should have 19 in-stock days, got %', v.in_stock_days;
  end if;
end $$;

-- Opening = previous recorded day's carried count, on every seed ledger row.
do $$
declare
  n int;
begin
  select count(*) into n
    from daily_stock_ledger l
    cross join lateral (
      select coalesce(p.counted_qty, p.closing_qty) as q
        from daily_stock_ledger p
       where p.desk_id = l.desk_id and p.sku_id = l.sku_id and p.ledger_date < l.ledger_date
       order by p.ledger_date desc limit 1) prev
   where l.is_seed and l.opening_qty <> prev.q;
  if n > 0 then
    raise exception 'VERIFY_V2: % seed ledger rows have an opening that is not the previous count', n;
  end if;
end $$;

-- Moves: two T1-1 -> T1-2 moves today, one undone by a reverse move.
do $$
begin
  if (select count(*) from transfers
       where is_seed and kind = 'move' and sent_date = kpv_today() and status = 'received'
         and from_desk_id in ('T1-1', 'T1-2')) <> 3 then
    raise exception 'VERIFY_V2: expected 3 move rows (two moves and one reverse) today';
  end if;
  if (select count(*) from transfers where is_seed and reverses_id is not null) <> 1 then
    raise exception 'VERIFY_V2: expected exactly one reverse move';
  end if;
end $$;

-- One cross-branch transfer still in transit.
do $$
begin
  if (select count(*) from transfers
       where is_seed and kind = 'transfer' and status = 'in_transit'
         and from_branch_id = 'B-TST1' and to_branch_id = 'B-TST2') <> 1 then
    raise exception 'VERIFY_V2: expected exactly one in-transit transfer B-TST1 -> B-TST2';
  end if;
end $$;

-- A handover on T1-2 (one ended row, one active), and the semantic audit example.
do $$
begin
  if (select count(*) from desk_assignment where desk_id = 'T1-2' and ended_at is not null) <> 1
     or (select count(*) from desk_assignment where desk_id = 'T1-2' and ended_at is null) <> 1 then
    raise exception 'VERIFY_V2: T1-2 should show one ended and one active assignment';
  end if;
  if not exists (select 1 from audit_log where is_seed and action = 'desk_day.reopen') then
    raise exception 'VERIFY_V2: seed desk_day.reopen audit entry missing';
  end if;
end $$;

-- Nothing the seed wrote is untagged: no real row points at a seed branch.
do $$
begin
  if exists (select 1 from desk_days where not is_seed and branch_id in ('B-TST1', 'B-TST2'))
     or exists (select 1 from daily_stock_ledger where not is_seed and branch_id in ('B-TST1', 'B-TST2'))
     or exists (select 1 from transfers where not is_seed
                  and (from_branch_id in ('B-TST1', 'B-TST2') or to_branch_id in ('B-TST1', 'B-TST2'))) then
    raise exception 'VERIFY_V2: a row on a seed branch is not tagged is_seed';
  end if;
end $$;

select 'VERIFY_V2 OK' as result;
