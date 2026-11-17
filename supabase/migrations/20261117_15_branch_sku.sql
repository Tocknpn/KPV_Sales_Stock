-- Per-branch SKU values (decided 2026-11-17, after migration 14). Idempotent; safe to re-run.
--
--   * Average sell/day and lead time are kept per branch. Each company-wide
--     rule (branch_id null) is copied into every branch, then deleted. An
--     existing branch rule keeps its own values and only takes the company
--     value for a field it had blank.
--   * branch_sku: whether a branch carries a SKU. A missing row = not carried.
--     Every existing (branch, SKU) pair starts carried (first run only).
-- The role guards for both tables live in users_roles.sql.

-- 1. The carries switch.
create table if not exists branch_sku (
  branch_id   text not null references branches(branch_id) on delete cascade,
  sku_id      text not null references master_sku(sku_id) on delete cascade,
  carried     boolean not null default true,
  updated_by  uuid default kpv_actor_id(),
  updated_at  timestamptz not null default now(),
  primary key (branch_id, sku_id)
);

drop trigger if exists trg_branch_sku_touch on branch_sku;
create trigger trg_branch_sku_touch before update on branch_sku
  for each row execute function touch_updated_at();

-- No row audit trigger: seeding writes one row per (branch, SKU), and the
-- Worker records each change as a semantic audit entry (sku.carried, sku.import).

revoke all on branch_sku from anon, authenticated;
alter table branch_sku enable row level security;

-- One-time seed: only while the table is still empty, so a re-run never
-- switches back on a SKU that a branch turned off or never carried.
insert into branch_sku (branch_id, sku_id, carried)
select b.branch_id, m.sku_id, true
  from branches b cross join master_sku m
 where not exists (select 1 from branch_sku)
on conflict (branch_id, sku_id) do nothing;

-- 2. Company rules -> branch rules.
update replenishment_rule r
   set avg_daily_sell = coalesce(r.avg_daily_sell, c.avg_daily_sell),
       lead_time_days = coalesce(r.lead_time_days, c.lead_time_days)
  from replenishment_rule c
 where c.branch_id is null
   and r.branch_id is not null
   and r.scope = c.scope
   and r.scope_key = c.scope_key
   and ((r.avg_daily_sell is null and c.avg_daily_sell is not null)
     or (r.lead_time_days is null and c.lead_time_days is not null));

insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days, is_seed)
select c.scope, c.scope_key, b.branch_id, c.avg_daily_sell, c.lead_time_days, c.is_seed
  from replenishment_rule c
  cross join branches b
 where c.branch_id is null
   and not exists (
     select 1 from replenishment_rule r
      where r.scope = c.scope and r.scope_key = c.scope_key and r.branch_id = b.branch_id);

delete from replenishment_rule where branch_id is null;
