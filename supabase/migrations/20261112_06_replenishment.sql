-- Replenishment: product group, per-scope rules, config knobs and the branch
-- sales-velocity RPC. Idempotent. The rule role guard lives in users_roles.sql.

-- ---------------------------------------------------------------------------
-- Product group (free text, e.g. "Plain ring"); lets one rule cover all sizes.
-- ---------------------------------------------------------------------------
alter table master_sku add column if not exists group_name text;
create index if not exists idx_master_sku_group on master_sku(group_name);

-- ---------------------------------------------------------------------------
-- Rules: average daily sell and/or lead time for a SKU, group or type, either
-- company-wide (branch_id null) or for one branch. A null value inherits.
-- ---------------------------------------------------------------------------
create table if not exists replenishment_rule (
  id              uuid primary key default gen_random_uuid(),
  scope           text not null check (scope in ('sku', 'group', 'type')),
  scope_key       text not null,
  branch_id       text references branches(branch_id),
  avg_daily_sell  numeric(10,3) check (avg_daily_sell >= 0),
  lead_time_days  numeric(5,1) check (lead_time_days >= 0),
  updated_by      uuid default kpv_actor_id(),
  updated_at      timestamptz not null default now(),
  is_seed         boolean not null default false,
  check (avg_daily_sell is not null or lead_time_days is not null)
);

create unique index if not exists uq_rule_scope
  on replenishment_rule (scope, scope_key, coalesce(branch_id, '*'));

drop trigger if exists trg_replenishment_rule_touch on replenishment_rule;
create trigger trg_replenishment_rule_touch before update on replenishment_rule
  for each row execute function touch_updated_at();
drop trigger if exists trg_replenishment_rule_seed on replenishment_rule;
create trigger trg_replenishment_rule_seed before insert on replenishment_rule
  for each row execute function kpv_inherit_seed();

select kpv_attach_audit('replenishment_rule'::regclass);

revoke all on replenishment_rule from anon, authenticated;
alter table replenishment_rule enable row level security;

-- ---------------------------------------------------------------------------
-- Config knobs
-- ---------------------------------------------------------------------------
alter table system_config
  add column if not exists default_lead_time_days numeric(5,1) not null default 7,
  add column if not exists warning_margin_days    numeric(5,1) not null default 3,
  add column if not exists velocity_window_days   int not null default 28
    check (velocity_window_days between 7 and 120);

-- ---------------------------------------------------------------------------
-- One-time copy of the old per-SKU values into company-wide SKU rules. A SKU
-- that already has a company-wide sku rule is left alone, so re-running the
-- migration never overwrites edits.
-- ---------------------------------------------------------------------------
insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days, is_seed)
select 'sku', m.sku_id, null, m.avg_daily_sales, m.order_lead_time_days, m.is_seed
  from master_sku m
 where (m.avg_daily_sales is not null or m.order_lead_time_days is not null)
   and not exists (
     select 1 from replenishment_rule r
      where r.scope = 'sku' and r.scope_key = m.sku_id and r.branch_id is null);

-- ---------------------------------------------------------------------------
-- branch_velocity: units sold per in-stock day, per SKU, for one branch.
-- Window p_to - p_days .. p_to - 1. Only Done days of the branch, never closed
-- days, never excluded rows. Per date and SKU the branch's desks are summed; a
-- date is "in stock" when opening + stock_in + transfer_in > 0. Moves and
-- destock do not count as sales. Fewer than 7 in-stock days gives no velocity.
-- ---------------------------------------------------------------------------
create or replace function branch_velocity(p_branch text, p_to date, p_days int)
returns table (sku_id text, sold int, in_stock_days int, velocity numeric)
language sql stable as $$
  with per_day as (
    select l.ledger_date, l.sku_id,
           sum(l.opening_qty + l.stock_in + l.transfer_in) as stocked,
           sum(l.retail_sale + l.wholesale) as sold
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
