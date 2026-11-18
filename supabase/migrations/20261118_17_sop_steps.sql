-- ============================================================================
-- 20261118_17 — SOP steps: withdraw column, 'opening' day status, reopen-from.
-- Additive, idempotent.
--
--   * daily_stock_ledger.withdraw: units withdrawn on the day (>= 0). Counts in
--     stock_out and lowers closing; counts as sold in velocity (destock does not).
--   * desk_days.status gains 'opening' (the new default): opening -> check_in ->
--     final_stock -> done. Existing rows keep their status.
--   * stock_out and closing_qty (generated) are re-generated with withdraw.
--     Generated values need no backfill, so no Done-day row is rewritten.
--   * ledger_apply accepts withdraw and opening_qty.
--   * desk_reopen_from(desk, date): reopens that day and every later day.
-- ============================================================================

alter table daily_stock_ledger add column if not exists withdraw int not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'daily_stock_ledger_withdraw_check') then
    alter table daily_stock_ledger add constraint daily_stock_ledger_withdraw_check check (withdraw >= 0);
  end if;
end $$;

-- Status check: the inline constraint was auto-named, so find it by definition.
do $$
declare
  r record;
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'desk_days'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%status%' and pg_get_constraintdef(oid) like '%opening%'
  ) then
    for r in
      select conname from pg_constraint
       where conrelid = 'desk_days'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) like '%status%' and pg_get_constraintdef(oid) like '%check_in%'
    loop
      execute format('alter table desk_days drop constraint %I', r.conname);
    end loop;
    alter table desk_days add constraint desk_days_status_check
      check (status in ('opening','check_in','final_stock','done'));
  end if;
end $$;
alter table desk_days alter column status set default 'opening';

-- stock_out and closing_qty with withdraw. A generated expression cannot be
-- altered in place, so both columns (and the view on them) are dropped and
-- re-added once; a re-run finds withdraw in the expression and skips this.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'daily_stock_ledger'
       and column_name = 'closing_qty' and generation_expression like '%withdraw%'
  ) then
    drop view if exists ledger_latest;
    alter table daily_stock_ledger drop column closing_qty;
    alter table daily_stock_ledger drop column stock_out;
    alter table daily_stock_ledger add column stock_out int generated always as
      (retail_sale + wholesale + destock + withdraw + stock_out_single) stored;
    alter table daily_stock_ledger add column closing_qty int generated always as
      (opening_qty + stock_in + transfer_in - transfer_out - move
       - retail_sale - wholesale - destock - withdraw - stock_out_single + move_qty) stored;
  end if;
end $$;

create or replace view ledger_latest as
  select l.*
  from daily_stock_ledger l
  join desk_latest_day d on d.desk_id = l.desk_id and d.ledger_date = l.ledger_date;
alter view ledger_latest set (security_invoker = true);

create or replace function ledger_guard_negative() returns trigger
language plpgsql as $$
declare
  v int;
begin
  v := new.opening_qty + new.stock_in + new.transfer_in - new.transfer_out - new.move
       - new.retail_sale - new.wholesale - new.destock - new.withdraw - new.stock_out_single + new.move_qty;
  if v < 0 and (tg_op = 'INSERT' or v < old.closing_qty) then
    raise exception 'NEGATIVE_CLOSING: available %',
      case when tg_op = 'INSERT' then 0 else old.closing_qty end
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Compare-and-set edits (body from migration 11) accept withdraw and opening_qty.
create or replace function ledger_apply(p_date date, p_desk text, p_sku text, p_changes jsonb)
returns jsonb
language plpgsql as $$
declare
  c jsonb;
  v_row daily_stock_ledger%rowtype;
  v_field text;
  v_stored text;
  v_sets text[] := '{}';
  v_int text[] := array['stock_in','retail_sale','wholesale','destock','withdraw','stock_out_single','move_qty','counted_qty','opening_qty'];
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

-- Velocity (body from migration 11): withdraw counts as sold; destock (Return) does not.
create or replace function branch_velocity(p_branch text, p_to date, p_days int)
returns table (sku_id text, sold int, in_stock_days int, velocity numeric)
language sql stable as $$
  with per_day as (
    select l.ledger_date, l.sku_id,
           sum(l.opening_qty + l.stock_in + l.transfer_in + greatest(l.move_qty, 0)) as stocked,
           sum(l.retail_sale + l.wholesale + l.withdraw + l.stock_out_single) as sold
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

-- Reopen a day and every later day of the desk: status back to 'opening', Done
-- stamps and typed counts cleared. Status first, because ledger_guard_done
-- blocks ledger writes on a Done day. Returns the reopened dates.
create or replace function desk_reopen_from(p_desk text, p_date date)
returns setof date
language plpgsql as $$
declare
  v_dates date[];
begin
  update desk_days
     set status = 'opening', done_by = null, done_at = null
   where desk_id = p_desk and ledger_date >= p_date;
  select coalesce(array_agg(ledger_date order by ledger_date), '{}') into v_dates
    from desk_days where desk_id = p_desk and ledger_date >= p_date;

  update daily_stock_ledger
     set counted_qty = null, counted_note = null
   where desk_id = p_desk and ledger_date = any (v_dates)
     and (counted_qty is not null or counted_note is not null);

  return query select unnest(v_dates) order by 1;
end $$;
revoke execute on function desk_reopen_from(text, date) from public, anon, authenticated;
grant execute on function desk_reopen_from(text, date) to service_role;
