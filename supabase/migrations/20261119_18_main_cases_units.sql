-- Main cases, free weight units, one type name (decided 2026-11-19). Idempotent; safe to re-run.
--
--   * staff_main_case: the cases a staff member mainly looks after. Ordering
--     only (they come first on that person's Daily stock list); anyone in the
--     branch can still open every case. Many-to-many. Set by an admin or the
--     manager of the branch (guard in users_roles.sql).
--   * sku_weight.qty + unit: a size is "qty unit" with the grams typed by the
--     user (8 ບາດ = 120 g). gram_value stays the one number every calculation
--     uses; the unit carries no conversion. Existing sizes are filled from
--     their grams; name_en (the label) becomes "qty unit".
--   * sku_type: one name. name_lo and name_en hold the same text; each SKU's
--     category mirror follows it.
-- Re-run users_roles.sql after this file.

-- 1. Main cases.
create table if not exists staff_main_case (
  staff_id    uuid not null references staff_accounts(id) on delete cascade,
  desk_id     text not null references desks(desk_id) on delete cascade,
  created_by  uuid default kpv_actor_id(),
  created_at  timestamptz not null default now(),
  primary key (staff_id, desk_id)
);
create index if not exists idx_staff_main_case_desk on staff_main_case(desk_id);

revoke all on staff_main_case from anon, authenticated;
alter table staff_main_case enable row level security;

-- Replaces one person's main cases in one transaction (the guard checks each row).
create or replace function set_main_cases(p_staff uuid, p_desks text[]) returns void
language plpgsql as $$
begin
  delete from staff_main_case where staff_id = p_staff and not (desk_id = any (coalesce(p_desks, '{}')));
  insert into staff_main_case (staff_id, desk_id)
  select p_staff, d from unnest(coalesce(p_desks, '{}')) as d
  on conflict (staff_id, desk_id) do nothing;
end $$;

-- 2. Weight sizes: qty + unit.
alter table sku_weight add column if not exists qty numeric(12,4);
alter table sku_weight add column if not exists unit text;

-- Fill existing sizes from their grams, as the old form split them:
-- a whole number of hun -> ບາດ / ສະຫຼຶງ / ຫຸນ, else ກິໂລ from 1000 g, else ກລາມ.
with s as (
  select weight_id, gram_value,
         gram_value / (15.244 / 40) as hun,
         round(gram_value / (15.244 / 40)) as h
    from sku_weight
   where qty is null or unit is null
), split as (
  select weight_id,
         case
           when h > 0 and abs(hun - h) < 0.005 and mod(h, 40) = 0 then h / 40
           when h > 0 and abs(hun - h) < 0.005 and mod(h, 10) = 0 then h / 10
           when h > 0 and abs(hun - h) < 0.005 then h
           when gram_value >= 1000 then round(gram_value / 1000, 2)
           else round(gram_value, 2)
         end as qty,
         case
           when h > 0 and abs(hun - h) < 0.005 and mod(h, 40) = 0 then 'ບາດ'
           when h > 0 and abs(hun - h) < 0.005 and mod(h, 10) = 0 then 'ສະຫຼຶງ'
           when h > 0 and abs(hun - h) < 0.005 then 'ຫຸນ'
           when gram_value >= 1000 then 'ກິໂລ'
           else 'ກລາມ'
         end as unit
    from s
)
update sku_weight w
   set qty = split.qty,
       unit = split.unit,
       name_en = trim_scale(split.qty)::text || ' ' || split.unit
  from split
 where w.weight_id = split.weight_id;

-- 3. One type name (Lao first, as productName shows it).
update sku_type
   set name_lo = coalesce(nullif(trim(name_lo), ''), name_en),
       name_en = coalesce(nullif(trim(name_lo), ''), name_en)
 where name_lo is null or trim(name_lo) = '' or name_en is distinct from name_lo;

update master_sku m
   set category = t.name_en
  from sku_type t
 where m.type_id = t.type_id and m.category is distinct from t.name_en;
