-- Sizes built from units (decided 2026-11-25). Idempotent; safe to re-run.
--
--   * sku_unit: a unit and the grams in 1 of it (ບາດ = 15.244 g). The admin
--     keeps this list in Settings > SKU > Units.
--   * sku_weight.parts: a size is up to 4 "qty unit" parts, biggest unit
--     first: [{"unit":"ບາດ","qty":4},{"unit":"ສະຫຼຶງ","qty":2}] = "4 ບາດ 2 ສະຫຼຶງ".
--     The SKU form picks the parts; the app finds or makes the matching size.
--     gram_value stays the one number every calculation uses (sum of the
--     parts' grams). qty / unit stay filled for one-part sizes.
-- Re-run users_roles.sql after this file (any role may now add a size, as
-- adding a SKU may need a new one; units stay admin only).

-- 1. Units.
create table if not exists sku_unit (
  unit        text primary key check (length(trim(unit)) between 1 and 30),
  gram_value  numeric(12,4) not null check (gram_value > 0),
  active      boolean not null default true,
  sort_order  int not null default 0
);

revoke all on sku_unit from anon, authenticated;
alter table sku_unit enable row level security;
select kpv_attach_audit('sku_unit'::regclass);

-- Every unit already used by a size, its grams from the size closest to 1 of
-- it (the shop may count 15 g a ບາດ), then the usual Lao units.
insert into sku_unit (unit, gram_value, sort_order)
select unit, round(gram_value / qty, 4), 0
  from (
    select distinct on (trim(unit)) trim(unit) as unit, gram_value, qty
      from sku_weight
     where unit is not null and trim(unit) <> '' and qty > 0
     order by trim(unit), abs(qty - 1), qty
  ) used
on conflict (unit) do nothing;

insert into sku_unit (unit, gram_value) values
  ('ກິໂລ', 1000), ('ບາດ', 15.244), ('ສະຫຼຶງ', 3.811), ('ຫຸນ', 0.3811), ('ກລາມ', 1)
on conflict (unit) do nothing;

-- Biggest unit first.
with ranked as (select unit, row_number() over (order by gram_value desc, unit) as n from sku_unit)
update sku_unit u set sort_order = ranked.n from ranked where u.unit = ranked.unit and u.sort_order is distinct from ranked.n;

-- 2. Size parts.
alter table sku_weight add column if not exists parts jsonb;

update sku_weight
   set parts = jsonb_build_array(jsonb_build_object('unit', trim(unit), 'qty', trim_scale(qty)))
 where parts is null and unit is not null and trim(unit) <> '' and qty > 0;
