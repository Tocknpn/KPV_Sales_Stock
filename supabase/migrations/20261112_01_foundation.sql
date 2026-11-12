-- ============================================================================
-- Migration 01 (v2): seed flag, seed inheritance, negative-stock and
-- future-date guards, purge-aware Done lock. Idempotent.
-- ============================================================================

-- Business date in Laos.
create or replace function kpv_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Vientiane')::date
$$;

create or replace function kpv_is_purging() returns boolean
language sql stable as $$
  select coalesce(current_setting('kpv.purging', true), '') = 'on'
$$;

-- ---------------------------------------------------------------------------
-- is_seed on every v1 business table
-- ---------------------------------------------------------------------------
alter table branches            add column if not exists is_seed boolean not null default false;
alter table desks               add column if not exists is_seed boolean not null default false;
alter table staff_accounts      add column if not exists is_seed boolean not null default false;
alter table sku_type            add column if not exists is_seed boolean not null default false;
alter table sku_weight          add column if not exists is_seed boolean not null default false;
alter table master_sku          add column if not exists is_seed boolean not null default false;
alter table desk_days           add column if not exists is_seed boolean not null default false;
alter table daily_stock_ledger  add column if not exists is_seed boolean not null default false;
alter table transfers           add column if not exists is_seed boolean not null default false;
alter table documents           add column if not exists is_seed boolean not null default false;
alter table document_rows       add column if not exists is_seed boolean not null default false;
alter table doc_counters        add column if not exists is_seed boolean not null default false;
alter table audit_log           add column if not exists is_seed boolean not null default false;

-- ---------------------------------------------------------------------------
-- Seed inheritance: a new row is seed when any parent it references is seed.
-- ---------------------------------------------------------------------------
-- RULING: seed status flows only through branch, desk, sku, type, weight,
-- document and staff_id (desk assignments) references. Do NOT add actor
-- columns (performed_by, sent_by, received_by, created_by, decided_by,
-- actor_id): a seed admin acting on a real branch would otherwise mark real
-- rows as seed and a purge would delete them. audit_log.is_seed is set from
-- the audited row (Task 3), not here.
create or replace function kpv_inherit_seed() returns trigger
language plpgsql as $$
declare
  j jsonb := to_jsonb(new);
  maps text[][] := array[
    ['branch_id',    'branches',       'branch_id'],
    ['desk_id',      'desks',          'desk_id'],
    ['from_desk_id', 'desks',          'desk_id'],
    ['to_desk_id',   'desks',          'desk_id'],
    ['sku_id',       'master_sku',     'sku_id'],
    ['type_id',      'sku_type',       'type_id'],
    ['weight_id',    'sku_weight',     'weight_id'],
    ['document_id',  'documents',      'id'],
    ['staff_id',     'staff_accounts', 'id']
  ];
  v text;
  hit boolean;
  i int;
begin
  if new.is_seed then return new; end if;
  for i in 1 .. array_length(maps, 1) loop
    -- a column that is this table's own key is not a parent reference
    v := j ->> maps[i][1];
    continue when v is null;
    continue when maps[i][2] = tg_table_name;
    execute format('select coalesce(bool_or(is_seed), false) from %I where %I::text = $1', maps[i][2], maps[i][3])
      into hit using v;
    if hit then
      new.is_seed := true;
      return new;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists trg_desks_seed on desks;
create trigger trg_desks_seed before insert on desks
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_staff_accounts_seed on staff_accounts;
create trigger trg_staff_accounts_seed before insert on staff_accounts
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_desk_days_seed on desk_days;
create trigger trg_desk_days_seed before insert on desk_days
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_ledger_seed on daily_stock_ledger;
create trigger trg_ledger_seed before insert on daily_stock_ledger
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_transfers_seed on transfers;
create trigger trg_transfers_seed before insert on transfers
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_documents_seed on documents;
create trigger trg_documents_seed before insert on documents
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_document_rows_seed on document_rows;
create trigger trg_document_rows_seed before insert on document_rows
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_doc_counters_seed on doc_counters;
create trigger trg_doc_counters_seed before insert on doc_counters
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_master_sku_seed on master_sku;
create trigger trg_master_sku_seed before insert on master_sku
  for each row execute function kpv_inherit_seed();

-- ---------------------------------------------------------------------------
-- Negative-stock guard. Generated columns are not populated in BEFORE
-- triggers, so closing is computed from NEW's columns. A row that is already
-- negative may still be edited as long as closing does not drop further.
-- ---------------------------------------------------------------------------
create or replace function ledger_guard_negative() returns trigger
language plpgsql as $$
declare
  v int;
begin
  v := new.opening_qty + new.stock_in + new.transfer_in
       - new.retail_sale - new.wholesale - new.transfer_out - new.destock - new.move;
  if v < 0 and (tg_op = 'INSERT' or v < old.closing_qty) then
    raise exception 'NEGATIVE_CLOSING: available %',
      case when tg_op = 'INSERT' then 0 else old.closing_qty end
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_ledger_guard_negative on daily_stock_ledger;
create trigger trg_ledger_guard_negative before insert or update on daily_stock_ledger
  for each row execute function ledger_guard_negative();

-- ---------------------------------------------------------------------------
-- No desk day after today (Laos).
-- ---------------------------------------------------------------------------
create or replace function desk_days_guard_future() returns trigger
language plpgsql as $$
begin
  if new.ledger_date > kpv_today() then
    raise exception 'FUTURE_DATE: % is after today', new.ledger_date using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_desk_days_guard_future on desk_days;
create trigger trg_desk_days_guard_future before insert on desk_days
  for each row execute function desk_days_guard_future();

-- ---------------------------------------------------------------------------
-- Done lock, purge-aware: seed rows may be deleted while kpv.purging = 'on'.
-- ---------------------------------------------------------------------------
create or replace function ledger_guard_done() returns trigger
language plpgsql as $$
declare
  v_desk text;
  v_date date;
  v_status text;
begin
  if tg_op = 'DELETE' then
    if kpv_is_purging() and old.is_seed then return old; end if;
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

-- ---------------------------------------------------------------------------
-- Go-live visibility: list open-day rows that are already negative.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select l.desk_id, l.ledger_date, l.sku_id, l.closing_qty
    from daily_stock_ledger l
    join desk_days d on d.desk_id = l.desk_id and d.ledger_date = l.ledger_date
    where d.status <> 'done' and l.closing_qty < 0
  loop
    raise notice 'NEGATIVE open row: desk % date % sku % closing %', r.desk_id, r.ledger_date, r.sku_id, r.closing_qty;
  end loop;
end $$;
