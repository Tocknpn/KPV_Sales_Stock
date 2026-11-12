-- ============================================================================
-- KPV Goldsmith & Retail Inventory — Supabase schema
-- Mirrors the original Google Sheets tabs described in app.md, reworked for
-- the Daily Stock Menu rework (Desks are Branch-owned, not staff-owned; real
-- staff login; Destock/Move/Final-Stock-recount fields).
-- Run this once in the Supabase SQL editor (or `supabase db execute -f supabase/schema.sql`).
--
-- No migration tool exists for this project and no live data exists yet, so
-- this file is a clean rewrite. Once a real project has real rows, FUTURE
-- edits to this file should become idempotent `alter table ... add column if
-- not exists` / `create table if not exists` blocks appended below, rather
-- than rewriting table definitions in place.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Branches (Morning Market, Talat Sao, ITECC, Vangthong)
-- ---------------------------------------------------------------------------
create table if not exists branches (
  branch_id    text primary key,
  name_en      text not null,
  name_lo      text,
  sort_order   int not null default 0
);

-- ---------------------------------------------------------------------------
-- Desks ("Cases" / ตู้ / ຕູ້) — persistent, Branch-owned. No longer tied to a
-- single staff member; any logged-in staff of the branch can work any Desk.
-- ---------------------------------------------------------------------------
create table if not exists desks (
  desk_id      text primary key,            -- 'MM-D01'..
  branch_id    text not null references branches(branch_id),
  display_name text not null,                -- 'Desk 01' / 'ตู้ 01'
  active       boolean not null default true, -- denominator for calendar completion %
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Staff accounts — individual login per staff member (name + PIN), scoped to
-- one branch; role 'admin' accounts have branch_id null (cross-branch access).
-- ---------------------------------------------------------------------------
create table if not exists staff_accounts (
  id             uuid primary key default gen_random_uuid(),
  branch_id      text references branches(branch_id),   -- null = admin
  display_name   text not null,
  pin_hash       text not null,              -- 'pbkdf2$<iters>$<saltHex>$<hashHex>'
  role           text not null check (role in ('staff','admin')),
  active         boolean not null default true,
  token_version  int not null default 0,     -- bump to invalidate all issued tokens
  failed_attempts int not null default 0,
  locked_until   timestamptz,
  created_at     timestamptz not null default now(),
  constraint staff_branch_required check (role = 'admin' or branch_id is not null)
);

create index if not exists idx_staff_accounts_branch on staff_accounts(branch_id);

-- ---------------------------------------------------------------------------
-- Master_SKU
-- ---------------------------------------------------------------------------
create table if not exists master_sku (
  sku_id          text primary key,
  name_en         text not null,
  name_lo         text,
  category        text not null check (category in ('Gold Bars','Necklaces','Bracelets','Rings & Accessories','Supplies')),
  purity          text check (purity in ('96.5%','99.99%', null)),
  std_gram_weight numeric(10,3),
  baht_weight     numeric(10,4),             -- weight expressed in Baht-gold unit
  unit_cost_lak   numeric(14,2) not null default 0,
  unit_price_lak  numeric(14,2) not null default 0,
  reorder_level   int not null default 5,    -- "< 5 pcs remaining" low-stock alert
  active          boolean not null default true,
  -- Bulk catalog status used for the portfolio-wide capacity bar on the Dashboard.
  -- For the handful of "desk" SKUs this is kept in sync with live ledger qty;
  -- for the bulk generated catalog rows it represents the nightly stock-status snapshot.
  status          text not null default 'in_stock' check (status in ('in_stock','low_stock','depleted')),
  is_desk_item    boolean not null default false,
  icon            text not null default 'ring'
);

create index if not exists idx_master_sku_category on master_sku(category);
create index if not exists idx_master_sku_status on master_sku(status);

-- ---------------------------------------------------------------------------
-- Daily_Stock_Ledger
-- Status lifecycle: check_in -> final_stock -> done (done is locked, enforced
-- server-side by the Worker, not just the UI). A desk/date with no rows is
-- the implicit "not_started" state and is never written to this table.
-- ---------------------------------------------------------------------------
create table if not exists daily_stock_ledger (
  id              uuid primary key default gen_random_uuid(),
  ledger_date     date not null,
  desk_id         text not null references desks(desk_id),
  branch_id       text not null references branches(branch_id),
  sku_id          text not null references master_sku(sku_id),
  opening_qty     int not null default 0,
  stock_in        int not null default 0,
  retail_sale     int not null default 0,
  wholesale       int not null default 0,
  transfer_out    int not null default 0,
  destock         int not null default 0,    -- loss/damage/write-off/internal use
  destock_note    text,
  move            int not null default 0,    -- intra-branch relocation, single-sided
  closing_qty     int not null default 0,    -- calculated: opening+in-sale-wholesale-transfer-destock-move
  closing_gram    numeric(12,3) not null default 0,
  closing_baht    numeric(12,4) not null default 0,
  counted_qty     int,                       -- physical recount entered at Final Stock (nullable until then)
  counted_note    text,                      -- staff note on variance vs. calculated closing
  performed_by    uuid references staff_accounts(id),
  excluded        boolean not null default false, -- soft-hidden from this date's working list
  audit_verified  boolean not null default false,
  desk_status     text not null default 'check_in' check (desk_status in ('check_in','final_stock','done')),
  safe_drop_note  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (ledger_date, desk_id, sku_id)
);

create index if not exists idx_ledger_date on daily_stock_ledger(ledger_date);
create index if not exists idx_ledger_branch on daily_stock_ledger(branch_id);
create index if not exists idx_ledger_desk on daily_stock_ledger(desk_id);

-- ---------------------------------------------------------------------------
-- Documents + rows — free-form, timestamped, locked-once-saved records (e.g.
-- a goldsmith weighing/production sheet). No approval workflow: create, save,
-- print. Not linked to master_sku — rows are free text, not stock movements.
-- ---------------------------------------------------------------------------
create table if not exists documents (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text not null unique,       -- e.g. 'DOC-VT-2026-0001'
  title           text not null,
  branch_id       text not null references branches(branch_id),
  desk_id         text references desks(desk_id),
  created_by      text not null,              -- stamped server-side from the session
  doc_date        date not null default current_date,
  created_at      timestamptz not null default now(),
  notes           text
);

create table if not exists document_rows (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references documents(id) on delete cascade,
  sort_order      int not null default 0,
  item            text not null default '',
  qty             numeric(12,3),
  weight_g        numeric(12,3),
  note            text
);

create index if not exists idx_document_rows_doc on document_rows(document_id);
create index if not exists idx_documents_branch on documents(branch_id);
create index if not exists idx_documents_desk on documents(desk_id);
create index if not exists idx_documents_date on documents(doc_date);

-- ---------------------------------------------------------------------------
-- System_Config (single row)
-- ---------------------------------------------------------------------------
create table if not exists system_config (
  id                      int primary key default 1,
  lead_time_days          numeric(5,1) not null default 3.5,
  avg_daily_burn_rate     numeric(10,2) not null default 38.2,  -- Baht/day
  safety_buffer_days      numeric(5,1) not null default 2.0,
  auto_draft_po           boolean not null default false,
  sync_interval_min       int not null default 15,
  spot_lak_per_baht       numeric(14,2) not null default 32500000,
  usd_to_lak_rate         numeric(10,2) not null default 20800,
  last_synced_at          timestamptz not null default now(),
  check (id = 1)
);

-- ---------------------------------------------------------------------------
-- Portfolio snapshot — nightly-computed enterprise-wide valuation
-- (hero card on the Dashboard; decoupled from the per-desk floor-stock ledger)
-- ---------------------------------------------------------------------------
create table if not exists portfolio_snapshot (
  snapshot_date       date primary key,
  total_baht_gold     numeric(12,2) not null,
  total_pcs           int not null,
  usd_value           numeric(14,2) not null,
  lak_value           numeric(18,2) not null,
  audit_balanced_pct  numeric(5,2) not null default 100
);

-- ---------------------------------------------------------------------------
-- Branch safety-stock targets (drives the Dashboard cluster chart + branch cards)
-- ---------------------------------------------------------------------------
create table if not exists branch_targets (
  branch_id        text primary key references branches(branch_id),
  current_baht     numeric(12,2) not null,
  target_baht      numeric(12,2) not null,
  health_state     text not null default 'Optimal' check (health_state in ('Optimal','Restock Needed','Alert'))
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- All reads/writes in this app go through the Cloudflare Worker using the
-- Supabase service-role key, which bypasses RLS. RLS is still enabled here so
-- that no table is ever reachable by the public anon key.
-- ---------------------------------------------------------------------------
alter table branches            enable row level security;
alter table desks               enable row level security;
alter table staff_accounts      enable row level security;
alter table master_sku          enable row level security;
alter table daily_stock_ledger  enable row level security;
alter table documents           enable row level security;
alter table document_rows       enable row level security;
alter table system_config       enable row level security;
alter table portfolio_snapshot  enable row level security;
alter table branch_targets      enable row level security;

-- ============================================================================
-- Settings rework — SKU Type/Weight master data + per-SKU run rate
-- Additive-only per the note at the top of this file: no live data existed
-- when these tables were added, but later edits should still follow this
-- `if not exists` / `add column if not exists` shape.
-- ============================================================================

-- Editable product grouping ("Gold Bar", "Jewelry", ...). Seeded from the old
-- fixed master_sku.category check-constraint list so nothing breaks; the
-- `category` column stays in place and in sync, driven off this table going
-- forward via the Worker.
create table if not exists sku_type (
  type_id     text primary key,
  name_en     text not null,
  name_lo     text,
  icon        text not null default 'ring',
  active      boolean not null default true,
  sort_order  int not null default 0
);

-- Editable size/weight definition ("Baht", "1g", "3.75g", "1kg", ...).
create table if not exists sku_weight (
  weight_id   text primary key,
  name_en     text not null,
  gram_value  numeric(12,4) not null,
  active      boolean not null default true,
  sort_order  int not null default 0
);

-- category used to be a fixed enum; sku_type is now the editable source of
-- truth and category is just a mirror of the type's name_en for the existing
-- report/dashboard grouping code, so a newly-added Type must not be rejected.
alter table master_sku drop constraint if exists master_sku_category_check;

alter table master_sku add column if not exists type_id text references sku_type(type_id);
alter table master_sku add column if not exists weight_id text references sku_weight(weight_id);
alter table master_sku add column if not exists avg_daily_sales numeric(10,3);
alter table master_sku add column if not exists order_lead_time_days numeric(5,1);

create index if not exists idx_master_sku_type on master_sku(type_id);

-- Superseded by per-SKU avg_daily_sales/order_lead_time_days above — neither
-- column was ever read by any computation, only displayed, so dropping is safe.
alter table system_config drop column if exists lead_time_days;
alter table system_config drop column if exists avg_daily_burn_rate;

alter table sku_type   enable row level security;
alter table sku_weight enable row level security;
