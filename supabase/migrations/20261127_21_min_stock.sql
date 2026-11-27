-- Min-stock alerts (decided 2026-11-27). Idempotent; safe to re-run.
--
--   * replenishment_rule.min_qty: the minimum pieces a branch keeps of a SKU
--     (or of every SKU of a Type). At or below it the app says "Order now".
--     It replaces the average daily sell, which is no longer read (the column
--     stays so older migrations still re-run; the app writes null to it).
--   * master_sku.detail: optional note under a SKU name (length, ring sizes,
--     "ລາຍລະ10ເສັ້ນ" ...).

-- 1. Minimum stock on the rules.
alter table replenishment_rule add column if not exists min_qty int;

do $$
declare c record;
begin
  -- Drop the old "avg or lead" check, whatever Postgres named it.
  for c in
    select conname from pg_constraint
     where conrelid = 'replenishment_rule'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%avg_daily_sell IS NOT NULL%lead_time_days IS NOT NULL%'
  loop
    execute format('alter table replenishment_rule drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'replenishment_rule'::regclass and conname = 'replenishment_rule_min_check') then
    alter table replenishment_rule add constraint replenishment_rule_min_check check (min_qty is null or min_qty >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'replenishment_rule'::regclass and conname = 'replenishment_rule_value_check') then
    -- A rule holding only the old average says nothing any more.
    delete from replenishment_rule where min_qty is null and lead_time_days is null;
    alter table replenishment_rule add constraint replenishment_rule_value_check
      check (min_qty is not null or lead_time_days is not null or avg_daily_sell is not null);
  end if;
end $$;

-- 2. SKU detail line.
alter table master_sku add column if not exists detail text;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'master_sku'::regclass and conname = 'master_sku_detail_len') then
    alter table master_sku add constraint master_sku_detail_len check (detail is null or length(detail) <= 200);
  end if;
end $$;
