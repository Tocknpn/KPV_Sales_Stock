-- ============================================================================
-- 20261116_11 — stock-out mode + Move in/out. Additive, idempotent.
--
--   * system_config.stock_out_mode: 'dynamic' (retail / wholesale / destock)
--     or 'single' (one total). Admin setting, company-wide.
--   * desk_days.stock_out_mode: stamped from system_config when the case-day
--     is created, so flipping the setting only affects days opened later.
--   * daily_stock_ledger.stock_out_single: the total typed on a single-mode day.
--   * daily_stock_ledger.stock_out (generated): retail + wholesale + destock +
--     stock_out_single, i.e. the day's stock-out in either mode.
--   * daily_stock_ledger.move_qty: signed Move in/out typed by staff (−8 / +8).
--     Replaces linked moves/transfers for new days; transfer_in, transfer_out
--     and move stay for past days.
--   * closing_qty is re-generated with the new formula. Generated values need
--     no backfill, so no Done-day row is ever rewritten.
-- ============================================================================

-- Nothing may be left in transit: the send/receive flow is retired.
do $$
begin
  if exists (select 1 from transfers where status = 'in_transit') then
    raise exception 'MIGRATION_11: % transfer(s) still in transit; receive or cancel them first',
      (select count(*) from transfers where status = 'in_transit');
  end if;
end $$;

alter table system_config add column if not exists stock_out_mode text not null default 'dynamic';
alter table desk_days     add column if not exists stock_out_mode text not null default 'dynamic';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'system_config_stock_out_mode_check') then
    alter table system_config add constraint system_config_stock_out_mode_check check (stock_out_mode in ('dynamic','single'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'desk_days_stock_out_mode_check') then
    alter table desk_days add constraint desk_days_stock_out_mode_check check (stock_out_mode in ('dynamic','single'));
  end if;
end $$;

-- A new case-day takes the company setting of that moment.
create or replace function desk_days_stamp_stock_out_mode() returns trigger
language plpgsql as $$
begin
  new.stock_out_mode := coalesce((select stock_out_mode from system_config where id = 1), 'dynamic');
  return new;
end $$;
drop trigger if exists trg_desk_days_stock_out_mode on desk_days;
create trigger trg_desk_days_stock_out_mode before insert on desk_days
  for each row execute function desk_days_stamp_stock_out_mode();

alter table daily_stock_ledger add column if not exists stock_out_single int not null default 0;
alter table daily_stock_ledger add column if not exists move_qty int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'daily_stock_ledger_stock_out_single_check') then
    alter table daily_stock_ledger add constraint daily_stock_ledger_stock_out_single_check check (stock_out_single >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'daily_stock_ledger_move_qty_check') then
    alter table daily_stock_ledger add constraint daily_stock_ledger_move_qty_check check (move_qty between -99999 and 99999);
  end if;
end $$;

alter table daily_stock_ledger add column if not exists stock_out int
  generated always as (retail_sale + wholesale + destock + stock_out_single) stored;

-- closing_qty with the new formula. A generated expression cannot be altered
-- in place, so the column (and the view built on it) is dropped and re-added
-- once; a re-run finds move_qty in the expression and skips this.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'daily_stock_ledger'
       and column_name = 'closing_qty' and generation_expression like '%move_qty%'
  ) then
    drop view if exists ledger_latest;
    alter table daily_stock_ledger drop column closing_qty;
    alter table daily_stock_ledger add column closing_qty int generated always as
      (opening_qty + stock_in + transfer_in - transfer_out - move
       - retail_sale - wholesale - destock - stock_out_single + move_qty) stored;
  end if;
end $$;

create or replace view ledger_latest as
  select l.*
  from daily_stock_ledger l
  join desk_latest_day d on d.desk_id = l.desk_id and d.ledger_date = l.ledger_date;
alter view ledger_latest set (security_invoker = true);

-- Negative-stock guard, same rule as before with the new formula.
create or replace function ledger_guard_negative() returns trigger
language plpgsql as $$
declare
  v int;
begin
  v := new.opening_qty + new.stock_in + new.transfer_in - new.transfer_out - new.move
       - new.retail_sale - new.wholesale - new.destock - new.stock_out_single + new.move_qty;
  if v < 0 and (tg_op = 'INSERT' or v < old.closing_qty) then
    raise exception 'NEGATIVE_CLOSING: available %',
      case when tg_op = 'INSERT' then 0 else old.closing_qty end
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Done lock (body from migration 07); the purge comparison now also skips the
-- generated stock_out, which BEFORE triggers do not see recomputed.
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
       and (to_jsonb(new) - 'performed_by' - 'updated_at' - 'closing_qty' - 'stock_out')
         = (to_jsonb(old) - 'performed_by' - 'updated_at' - 'closing_qty' - 'stock_out') then
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

-- Compare-and-set edits (body from migration 03) accept the two new fields.
create or replace function ledger_apply(p_date date, p_desk text, p_sku text, p_changes jsonb)
returns jsonb
language plpgsql as $$
declare
  c jsonb;
  v_row daily_stock_ledger%rowtype;
  v_field text;
  v_stored text;
  v_sets text[] := '{}';
  v_int text[] := array['stock_in','retail_sale','wholesale','destock','stock_out_single','move_qty','counted_qty'];
  v_txt text[] := array['destock_note','counted_note'];
begin
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'ledger_apply: changes must be an array';
  end if;
  for c in select * from jsonb_array_elements(p_changes) loop
    v_field := c->>'field';
    if v_field is null or not (v_field = any (v_int) or v_field = any (v_txt)) then
      raise exception 'ledger_apply: field % not allowed', coalesce(v_field, '(none)');
    end if;
  end loop;

  select * into v_row from daily_stock_ledger
   where ledger_date = p_date and desk_id = p_desk and sku_id = p_sku
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ROW_NOT_FOUND');
  end if;

  for c in select * from jsonb_array_elements(p_changes) loop
    v_field := c->>'field';
    v_stored := to_jsonb(v_row) ->> v_field;
    if c ? 'from'
       and v_stored is distinct from (c->>'from')
       and v_stored is distinct from (c->>'to') then
      return jsonb_build_object('ok', false, 'code', 'ROW_CHANGED', 'row', to_jsonb(v_row));
    end if;
  end loop;

  for c in select * from jsonb_array_elements(p_changes) loop
    v_field := c->>'field';
    v_sets := v_sets || format('%I = %L::%s', v_field, c->>'to', case when v_field = any (v_int) then 'int' else 'text' end);
  end loop;

  if cardinality(v_sets) > 0 then
    execute format(
      'update daily_stock_ledger set %s, performed_by = coalesce(kpv_actor_id(), performed_by)
        where ledger_date = $1 and desk_id = $2 and sku_id = $3', array_to_string(v_sets, ', '))
      using p_date, p_desk, p_sku;
  end if;

  select * into v_row from daily_stock_ledger where ledger_date = p_date and desk_id = p_desk and sku_id = p_sku;
  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end $$;
revoke execute on function ledger_apply(date, text, text, jsonb) from public, anon, authenticated;
grant execute on function ledger_apply(date, text, text, jsonb) to service_role;

-- Velocity (body from migration 06): a single-mode day's typed total counts as
-- sold (it cannot be split), and a positive Move in/out counts as stocked.
create or replace function branch_velocity(p_branch text, p_to date, p_days int)
returns table (sku_id text, sold int, in_stock_days int, velocity numeric)
language sql stable as $$
  with per_day as (
    select l.ledger_date, l.sku_id,
           sum(l.opening_qty + l.stock_in + l.transfer_in + greatest(l.move_qty, 0)) as stocked,
           sum(l.retail_sale + l.wholesale + l.stock_out_single) as sold
      from daily_stock_ledger l
      join desk_days dd on dd.desk_id = l.desk_id and dd.ledger_date = l.ledger_date
     where l.branch_id = p_branch
       and dd.branch_id = p_branch
       and dd.status = 'done'
       and not l.excluded
       and l.ledger_date >= p_to - p_days
       and l.ledger_date <= p_to - 1
       and not exists (
         select 1 from branch_closed_day c
          where c.branch_id = p_branch and c.closed_date = l.ledger_date)
     group by l.ledger_date, l.sku_id
  ), agg as (
    select d.sku_id,
           sum(d.sold)::int as sold,
           (count(*) filter (where d.stocked > 0))::int as in_stock_days
      from per_day d
     group by d.sku_id
  )
  select a.sku_id, a.sold, a.in_stock_days,
         case when a.in_stock_days >= 7 then round(a.sold::numeric / a.in_stock_days, 3) end
    from agg a
$$;
revoke execute on function branch_velocity(text, date, int) from public, anon, authenticated;
grant execute on function branch_velocity(text, date, int) to service_role;
