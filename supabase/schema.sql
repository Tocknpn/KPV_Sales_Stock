-- ============================================================================
-- KPV Goldsmith & Retail Inventory — Supabase schema (production phase)
--
-- Run once in the Supabase SQL editor on an EMPTY project, then run
-- supabase/base.sql (branches + config) and either supabase/seed.sql (demo
-- data for testing) or load real data through the app.
--
-- Design rules:
--   * Business rules live in the Worker (src/). The database supplies only
--     integrity (keys, checks), atomic primitives (functions below) and two
--     hard guarantees: a Done day's ledger rows cannot change, and closing_qty
--     is always the formula.
--   * Once real data exists, future changes must be additive
--     (`alter table ... add column if not exists`), appended at the bottom.
-- ============================================================================

-- gen_random_uuid() is built into Postgres 13+ (no extension needed).

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest on every UPDATE.
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
create table branches (
  branch_id    text primary key,
  name_en      text not null,
  name_lo      text,
  sort_order   int not null default 0
);

-- ---------------------------------------------------------------------------
-- Desks ("Cases" / ຕູ້) — persistent, Branch-owned.
-- ---------------------------------------------------------------------------
create table desks (
  desk_id      text primary key,            -- 'MM-D01'..
  branch_id    text not null references branches(branch_id),
  display_name text not null,
  active       boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);
create index idx_desks_branch on desks(branch_id);

-- ---------------------------------------------------------------------------
-- Staff accounts — scoped to one branch; role 'admin'
-- accounts have branch_id null (all branches).
-- ---------------------------------------------------------------------------
create table staff_accounts (
  id              uuid primary key default gen_random_uuid(),
  branch_id       text references branches(branch_id),
  display_name    text not null,
  pin_hash        text not null,              -- 'pbkdf2$<iters>$<saltHex>$<hashHex>'
  role            text not null check (role in ('staff','admin')),
  active          boolean not null default true,
  token_version   int not null default 0,     -- bump to invalidate all issued tokens
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  constraint staff_branch_required check (role = 'admin' or branch_id is not null)
);
create index idx_staff_accounts_branch on staff_accounts(branch_id);

-- ---------------------------------------------------------------------------
-- SKU master data
-- ---------------------------------------------------------------------------
create table sku_type (
  type_id     text primary key,
  name_en     text not null,
  name_lo     text,
  icon        text not null default 'ring',
  active      boolean not null default true,
  sort_order  int not null default 0
);

create table sku_weight (
  weight_id   text primary key,
  name_en     text not null,
  gram_value  numeric(12,4) not null check (gram_value > 0),
  active      boolean not null default true,
  sort_order  int not null default 0
);

create table master_sku (
  sku_id               text primary key,
  name_en              text not null,
  name_lo              text,
  category             text not null,          -- mirror of sku_type.name_en
  type_id              text references sku_type(type_id),
  weight_id            text references sku_weight(weight_id),
  purity               text check (purity in ('96.5%','99.99%')),
  std_gram_weight      numeric(10,3),
  baht_weight          numeric(10,4),
  unit_cost_lak        numeric(14,2) not null default 0,
  unit_price_lak       numeric(14,2) not null default 0,
  reorder_level        int not null default 5 check (reorder_level >= 0),
  avg_daily_sales      numeric(10,3) check (avg_daily_sales >= 0),
  order_lead_time_days numeric(5,1) check (order_lead_time_days >= 0),
  active               boolean not null default true,
  icon                 text not null default 'ring'
);
create index idx_master_sku_type on master_sku(type_id);

-- ---------------------------------------------------------------------------
-- Desk days — one row per desk per business date. The ONLY place a day's
-- status lives: check_in -> final_stock -> done. No row = "not started".
-- ---------------------------------------------------------------------------
create table desk_days (
  desk_id         text not null references desks(desk_id),
  ledger_date     date not null,
  branch_id       text not null references branches(branch_id),
  status          text not null default 'check_in' check (status in ('check_in','final_stock','done')),
  safe_drop_note  text,
  checked_in_by   uuid references staff_accounts(id),
  done_by         uuid references staff_accounts(id),
  done_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (desk_id, ledger_date)
);
create index idx_desk_days_date on desk_days(ledger_date);
create index idx_desk_days_branch_date on desk_days(branch_id, ledger_date);
create trigger trg_desk_days_touch before update on desk_days
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Daily stock ledger — one row per desk / date / SKU.
-- closing_qty is generated, so it can never drift from the formula.
-- ---------------------------------------------------------------------------
create table daily_stock_ledger (
  id              uuid primary key default gen_random_uuid(),
  ledger_date     date not null,
  desk_id         text not null,
  branch_id       text not null references branches(branch_id),
  sku_id          text not null references master_sku(sku_id),
  opening_qty     int not null default 0 check (opening_qty >= 0),
  stock_in        int not null default 0 check (stock_in >= 0),
  transfer_in     int not null default 0 check (transfer_in >= 0),   -- confirmed incoming transfers/moves
  retail_sale     int not null default 0 check (retail_sale >= 0),
  wholesale       int not null default 0 check (wholesale >= 0),
  transfer_out    int not null default 0 check (transfer_out >= 0),
  destock         int not null default 0 check (destock >= 0),
  destock_note    text,
  move            int not null default 0 check (move >= 0),
  closing_qty     int generated always as
                    (opening_qty + stock_in + transfer_in - retail_sale - wholesale - transfer_out - destock - move) stored,
  counted_qty     int check (counted_qty >= 0),
  counted_note    text,
  performed_by    uuid references staff_accounts(id),
  excluded        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (ledger_date, desk_id, sku_id),
  foreign key (desk_id, ledger_date) references desk_days(desk_id, ledger_date)
);
create index idx_ledger_date on daily_stock_ledger(ledger_date);
create index idx_ledger_branch_date on daily_stock_ledger(branch_id, ledger_date);
create index idx_ledger_desk_date on daily_stock_ledger(desk_id, ledger_date);
create trigger trg_ledger_touch before update on daily_stock_ledger
  for each row execute function touch_updated_at();

-- Hard guarantee: once a desk day is Done its ledger rows are frozen. The
-- Worker checks this too (for friendly errors); this is the backstop that
-- holds even when two tablets race.
create or replace function ledger_guard_done() returns trigger
language plpgsql as $$
declare
  v_desk text;
  v_date date;
  v_status text;
begin
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
create trigger trg_ledger_guard_done before insert or update or delete on daily_stock_ledger
  for each row execute function ledger_guard_done();

-- ---------------------------------------------------------------------------
-- Latest recorded day per desk — what "stock right now" means everywhere
-- (Dashboard totals, low-stock lists). A desk that has not checked in today
-- still counts with its most recent day.
-- ---------------------------------------------------------------------------
create view desk_latest_day as
  select distinct on (desk_id) desk_id, ledger_date, branch_id, status
  from desk_days
  order by desk_id, ledger_date desc;

create view ledger_latest as
  select l.*
  from daily_stock_ledger l
  join desk_latest_day d on d.desk_id = l.desk_id and d.ledger_date = l.ledger_date;

-- ---------------------------------------------------------------------------
-- Linked transfers (other desk, any branch) and moves (other desk, same
-- branch). The sender's ledger row carries the quantity in transfer_out /
-- move; the receiver's transfer_in is credited when they confirm.
-- ---------------------------------------------------------------------------
create table transfers (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('transfer','move')),
  from_desk_id    text not null references desks(desk_id),
  from_branch_id  text not null references branches(branch_id),
  to_desk_id      text not null references desks(desk_id),
  to_branch_id    text not null references branches(branch_id),
  sku_id          text not null references master_sku(sku_id),
  qty             int not null check (qty > 0),
  sent_date       date not null,
  sent_by         uuid references staff_accounts(id),
  status          text not null default 'in_transit' check (status in ('in_transit','received','cancelled')),
  received_date   date,
  received_by     uuid references staff_accounts(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (from_desk_id <> to_desk_id)
);
create index idx_transfers_to on transfers(to_desk_id, status);
create index idx_transfers_from on transfers(from_desk_id, sent_date);
create index idx_transfers_status on transfers(status);
create trigger trg_transfers_touch before update on transfers
  for each row execute function touch_updated_at();

-- Atomic "add delta to one movement column" — used by transfers so two
-- tablets can never lose each other's increments. Returns the new value.
create or replace function ledger_add(
  p_date date, p_desk text, p_sku text, p_field text, p_delta int, p_actor uuid
) returns int
language plpgsql as $$
declare v_new int;
begin
  if p_field not in ('transfer_in','transfer_out','move') then
    raise exception 'ledger_add: field % not allowed', p_field;
  end if;
  execute format(
    'update daily_stock_ledger set %1$I = %1$I + $1, performed_by = coalesce($2, performed_by), excluded = false
       where ledger_date = $3 and desk_id = $4 and sku_id = $5 returning %1$I', p_field)
    into v_new using p_delta, p_actor, p_date, p_desk, p_sku;
  return v_new;   -- null when the row does not exist
end $$;

-- ---------------------------------------------------------------------------
-- Documents + rows. kind 'proposal' carries an approval status.
-- ---------------------------------------------------------------------------
create table documents (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,       -- 'DOC-VT-2026-0001'
  title           text not null,
  branch_id       text not null references branches(branch_id),
  desk_id         text references desks(desk_id),
  created_by      text not null,
  doc_date        date not null,
  created_at      timestamptz not null default now(),
  notes           text,
  kind            text not null default 'document' check (kind in ('document','proposal')),
  status          text check (status in ('pending','approved','rejected')),
  decided_by      text,
  decided_at      timestamptz,
  check ((kind = 'proposal') = (status is not null))
);
create index idx_documents_branch on documents(branch_id);
create index idx_documents_desk on documents(desk_id);
create index idx_documents_date on documents(doc_date);
create index idx_documents_kind_status on documents(kind, status);

create table document_rows (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  sort_order      int not null default 0,
  item            text not null default '',
  qty             numeric(12,3),
  weight_g        numeric(12,3),
  note            text
);
create index idx_document_rows_doc on document_rows(document_id);

-- Document numbers come from a counter, not from counting rows, so a deleted
-- document or two simultaneous saves can never produce a duplicate number.
create table doc_counters (
  branch_id  text not null references branches(branch_id),
  year       int not null,
  last_seq   int not null default 0,
  primary key (branch_id, year)
);

create or replace function next_doc_seq(p_branch text, p_year int) returns int
language sql as $$
  insert into doc_counters (branch_id, year, last_seq) values (p_branch, p_year, 1)
  on conflict (branch_id, year) do update set last_seq = doc_counters.last_seq + 1
  returning last_seq;
$$;

-- ---------------------------------------------------------------------------
-- System config (single row)
-- ---------------------------------------------------------------------------
create table system_config (
  id                  int primary key default 1 check (id = 1),
  safety_buffer_days  numeric(5,1) not null default 2.0 check (safety_buffer_days >= 0),
  spot_lak_per_baht   numeric(14,2) not null default 0 check (spot_lak_per_baht >= 0),
  usd_to_lak_rate     numeric(10,2) not null default 0 check (usd_to_lak_rate >= 0),
  updated_at          timestamptz not null default now()
);
create trigger trg_config_touch before update on system_config
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log — who did what to master data, users, locked days, documents.
-- ---------------------------------------------------------------------------
create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_name  text not null,
  action      text not null,       -- e.g. 'desk_day.reopen', 'user.reset_pin'
  target      text not null,       -- e.g. 'MM-D01/2026-11-12'
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index idx_audit_created on audit_log(created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Every read/write goes through the Worker with the service-role key, which
-- bypasses RLS. RLS is enabled with no policies so the public anon key can
-- reach nothing.
-- ---------------------------------------------------------------------------
alter table branches            enable row level security;
alter table desks               enable row level security;
alter table staff_accounts      enable row level security;
alter table sku_type            enable row level security;
alter table sku_weight          enable row level security;
alter table master_sku          enable row level security;
alter table desk_days           enable row level security;
alter table daily_stock_ledger  enable row level security;
alter table transfers           enable row level security;
alter table documents           enable row level security;
alter table document_rows       enable row level security;
alter table doc_counters        enable row level security;
alter table system_config       enable row level security;
alter table audit_log           enable row level security;

-- Views must not become a side door around RLS.
alter view desk_latest_day set (security_invoker = true);
alter view ledger_latest   set (security_invoker = true);

-- Functions are callable only by the service role.
revoke execute on function ledger_add(date, text, text, text, int, uuid) from public, anon, authenticated;
revoke execute on function next_doc_seq(text, int) from public, anon, authenticated;
