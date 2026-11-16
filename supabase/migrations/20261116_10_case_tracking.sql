-- ============================================================================
-- 20261116_10 — gold price history + frozen case origin. Additive, idempotent.
-- gold_prices is owned by the owner's job: create-if-missing only, never rewritten.
-- Re-run supabase/users_roles.sql afterwards to lock down gold_price_history.
-- ============================================================================

create table if not exists gold_prices (
  id                int4 primary key,
  price_baht_sell   numeric,
  price_baht_buy    numeric,
  price_gram_sell   numeric,
  price_gram_buy    numeric,
  updated_at        timestamptz,
  price_updated_at  text,
  fetched_at_utc7   text
);

create table if not exists gold_price_history (
  price_date       date primary key,
  price_baht_sell  numeric not null,
  price_baht_buy   numeric,
  captured_at      timestamptz not null default now()
);

create or replace function kpv_gold_price_snapshot() returns trigger
language plpgsql as $$
declare
  v_date date := coalesce((new.updated_at at time zone 'Asia/Vientiane')::date, kpv_today());
begin
  if new.price_baht_sell is null then
    return new;
  end if;
  insert into gold_price_history (price_date, price_baht_sell, price_baht_buy, captured_at)
  values (v_date, new.price_baht_sell, new.price_baht_buy, now())
  on conflict (price_date) do update
    set price_baht_sell = excluded.price_baht_sell,
        price_baht_buy  = excluded.price_baht_buy,
        captured_at     = excluded.captured_at;
  return new;
end $$;

drop trigger if exists trg_gold_price_snapshot on gold_prices;
create trigger trg_gold_price_snapshot after insert or update on gold_prices
  for each row execute function kpv_gold_price_snapshot();

-- Snapshot the current row (if any).
insert into gold_price_history (price_date, price_baht_sell, price_baht_buy)
select coalesce((updated_at at time zone 'Asia/Vientiane')::date, kpv_today()), price_baht_sell, price_baht_buy
  from gold_prices
 where price_baht_sell is not null
on conflict (price_date) do nothing;

-- ---------------------------------------------------------------------------
-- Frozen case origin
-- ---------------------------------------------------------------------------
alter table desks add column if not exists created_by uuid references staff_accounts(id);
alter table desks add column if not exists initial_stock jsonb;

-- Fills desks whose initial_stock is still null. Safe to re-run.
create or replace function kpv_backfill_desk_origin() returns int
language plpgsql as $$
declare
  d record;
  v_skus jsonb;
  v_creator uuid;
  v_pcs int;
  v_baht numeric;
  v_n int := 0;
begin
  for d in select desk_id from desks where initial_stock is null loop
    v_skus := null;
    v_creator := null;

    -- 1) the Worker's desk.create audit row (earliest wins)
    select a.actor_id, a.detail -> 'opening'
      into v_creator, v_skus
      from audit_log a
     where a.action = 'desk.create' and a.target = d.desk_id
       and jsonb_typeof(a.detail -> 'opening') = 'object'
     order by a.created_at
     limit 1;

    if v_skus is not null then
      -- keep only positive integer quantities (matches the ledger path's opening_qty > 0)
      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
        into v_skus
        from jsonb_each(v_skus) e
       where jsonb_typeof(e.value) = 'number'
         and e.value::text ~ '^[0-9]+$'
         and e.value::text::numeric > 0;
    end if;

    -- 2) no audit row: opening quantities of the earliest day
    if v_skus is null then
      v_creator := null;
      select coalesce(jsonb_object_agg(l.sku_id, l.opening_qty), '{}'::jsonb)
        into v_skus
        from daily_stock_ledger l
       where l.desk_id = d.desk_id
         and l.opening_qty > 0
         and l.ledger_date = (select min(dd.ledger_date) from desk_days dd where dd.desk_id = d.desk_id);
      -- nothing to freeze from: leave the origin null
      if v_skus = '{}'::jsonb then
        continue;
      end if;
    end if;

    select coalesce(sum(e.value::int), 0),
           coalesce(sum(e.value::int * coalesce(m.baht_weight, 0)), 0)
      into v_pcs, v_baht
      from jsonb_each_text(v_skus) e
      left join master_sku m on m.sku_id = e.key;

    update desks
       set created_by = v_creator,
           initial_stock = jsonb_build_object('skus', v_skus, 'total_pcs', v_pcs, 'total_baht', v_baht)
     where desk_id = d.desk_id and initial_stock is null;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

select kpv_backfill_desk_origin();

-- Immutability last, so the backfill above is never blocked.
create or replace function kpv_desk_origin_immutable() returns trigger
language plpgsql as $$
begin
  if (old.created_by is not null and new.created_by is distinct from old.created_by)
     or (old.initial_stock is not null and new.initial_stock is distinct from old.initial_stock) then
    raise exception 'INITIAL_IMMUTABLE: case origin is frozen once set' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_desk_origin_immutable on desks;
create trigger trg_desk_origin_immutable before update on desks
  for each row execute function kpv_desk_origin_immutable();
