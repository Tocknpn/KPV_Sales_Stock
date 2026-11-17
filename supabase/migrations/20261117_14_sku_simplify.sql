-- SKU simplification (decided 2026-11-17). Idempotent; safe to re-run.
--
--   * Product group is gone: each group rule becomes per-SKU rules for the
--     SKUs in that group (an existing SKU rule keeps its own values and only
--     takes the group's value where it had none), then group rules are deleted.
--   * Rules are company-wide only: a branch rule becomes the company-wide rule
--     when there is none yet, then branch rules are deleted.
--   * Every SKU is gold: baht_weight follows the size (grams / 15.244).
--   * One Lao name: a SKU without name_lo gets its name_en.
--   * Stock-out mode is fixed to 'dynamic' (the setting is hidden).
-- No column is dropped: purity, unit_price_lak, reorder_level, group_name stay unused.

-- 1. Group rules -> SKU rules, at the same branch level.
update replenishment_rule r
   set avg_daily_sell = coalesce(r.avg_daily_sell, g.avg_daily_sell),
       lead_time_days = coalesce(r.lead_time_days, g.lead_time_days)
  from replenishment_rule g
  join master_sku m on m.group_name = g.scope_key
 where g.scope = 'group'
   and r.scope = 'sku'
   and r.scope_key = m.sku_id
   and coalesce(r.branch_id, '*') = coalesce(g.branch_id, '*')
   and ((r.avg_daily_sell is null and g.avg_daily_sell is not null)
     or (r.lead_time_days is null and g.lead_time_days is not null));

insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days, is_seed)
select 'sku', m.sku_id, g.branch_id, g.avg_daily_sell, g.lead_time_days, g.is_seed
  from replenishment_rule g
  join master_sku m on m.group_name = g.scope_key
 where g.scope = 'group'
   and not exists (
     select 1 from replenishment_rule r
      where r.scope = 'sku' and r.scope_key = m.sku_id
        and coalesce(r.branch_id, '*') = coalesce(g.branch_id, '*'));

delete from replenishment_rule where scope = 'group';

-- 2. Branch rules -> company-wide (first branch by id when several differ).
insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days, is_seed)
select distinct on (b.scope, b.scope_key) b.scope, b.scope_key, null, b.avg_daily_sell, b.lead_time_days, b.is_seed
  from replenishment_rule b
 where b.branch_id is not null
   and not exists (
     select 1 from replenishment_rule r
      where r.scope = b.scope and r.scope_key = b.scope_key and r.branch_id is null)
 order by b.scope, b.scope_key, b.branch_id;

delete from replenishment_rule where branch_id is not null;

-- 3. Baht weight from the size.
update master_sku
   set baht_weight = round(std_gram_weight / 15.244, 4)
 where std_gram_weight > 0
   and baht_weight is distinct from round(std_gram_weight / 15.244, 4);

-- 4. One Lao name.
update master_sku set name_lo = name_en where name_lo is null or btrim(name_lo) = '';

-- 5. Stock-out mode fixed to the full layout.
update system_config set stock_out_mode = 'dynamic' where stock_out_mode is distinct from 'dynamic';
