# Khamphouvong Gold Stock v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver CR1–CR6: atomic same-branch case moves, branch-wide replenishment runway, case streak/tier cards, DB-enforced immutable audit plus case assignment, a one-screen day check with no sideways scroll, and a safe Supabase setup with a branch-manager role, tagged seed data and a one-command purge.

**Architecture:** The existing Cloudflare Worker (Hono) stays the only client of Supabase (service-role key). New hard rules live in Postgres (additive migration files, triggers, RPCs) and receive the acting staff member through PostgREST request headers. The Worker keeps friendly checks and pure logic in `src/logic.ts`, and `DemoStore` mirrors the DB behaviour for the existing Vitest API tests. A new PGlite suite runs the real SQL.

**Tech Stack:** Cloudflare Workers + Static Assets, Hono 4, TypeScript 5, Supabase Postgres (PostgREST), vanilla ES modules + Tailwind 3, Vitest 3, `@electric-sql/pglite` (new, dev only).

**Spec:** `docs/superpowers/specs/2026-11-12-khamphouvong-stock-v2-design.md`. Read it first: section numbers (D1–D8, 1.x–5.x, 7a–7c) are cited below instead of being repeated.

## Global Constraints

- No React/Vite, no Cloudflare Pages migration, no Supabase key in the browser, no `VITE_*` variables (D1–D3).
- Supabase project URL: `https://tpekfhbjbosbeikawkys.supabase.co`.
- Business date = Laos date: Worker `businessDate(env)`; SQL `kpv_today()` = `(now() at time zone 'Asia/Vientiane')::date`. The client never computes "today".
- `supabase/schema.sql` is never edited. All DB changes go in `supabase/migrations/20261112_0N_<name>.sql`, idempotent (`if not exists`, `create or replace`, guarded `do $$` blocks), plus `supabase/users_roles.sql`.
- Fresh-project order: `schema.sql` → `migrations/*` (name order) → `users_roles.sql` → `base.sql` → optional `seed_mock_data.sql`.
- Every new table gets: `is_seed boolean not null default false`, RLS enabled, the audit trigger (Task 3), the seed-inheritance trigger where it references a seed-able parent (Task 2), and `revoke all … from anon, authenticated`.
- Every new RPC: `revoke execute … from public, anon, authenticated`.
- Every new API refusal returns `{error, code}`; every new UI string has Lao and English entries in `public/js/i18n.js`.
- Tap targets ≥ 44 px; inputs 16 px text; tier/status stated in text, never colour alone; no animation without `prefers-reduced-motion: no-preference`.
- Quantities are whole pieces 0…99 999 (`MAX_QTY`); `parseQty` is the only parser.
- Config defaults: `default_lead_time_days = 7`, `warning_margin_days = 3`, `velocity_window_days = 28`; minimum auto-velocity in-stock days = 7; "Review" when |auto − manual| / manual > 0.5 with ≥ 14 in-stock days; manager reopen limit = 3 days; streak cap display "365+"; Undo toast 6 s; stepper buffer 600 ms; cutoff confirm before 15:30 Laos.
- Commit after each task on branch `v2-change-requests` (create it from `main` before Task 1). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A row already negative before v2** (open day): entering its count or a correction must still save; only a change that lowers closing further is refused → test in Task 2 (`allows updating an already-negative row when closing does not drop`).
2. **Undo after the destination has already sold the moved pieces**: the reverse move must be refused with `NOT_ENOUGH_STOCK`, never leave Case B negative → test in Task 8.
3. **Network retry after a successful save** (CAS where stored value already equals `to`; move with a repeated `clientRef`): must report success with no double effect → tests in Task 6 and Task 8.
4. **Staff moved to another branch or deactivated while holding cases**: their active assignments end, and the card never shows a person who cannot act there → test in Task 10.
5. **Closed day added for a date on which cases did check**: the date is skipped, so it neither breaks nor double-counts the streak → test in Task 11.

---

## File Structure

```
supabase/
  migrations/
    20261112_01_foundation.sql      is_seed cols, seed inheritance, kpv_today, date + negative guards, purge-aware Done lock
    20261112_02_audit.sql           actor helpers, audit_log columns, audit trigger, immutability
    20261112_03_ledger_apply.sql    CAS RPC ledger_apply
    20261112_04_moves.sql           transfers cols, move_stock, undo_move
    20261112_05_cases.sql           branch_closed_day, desk_assignment, assign_desk, release_desk
    20261112_06_replenishment.sql   group_name, replenishment_rule, config cols, branch_velocity, data copy
    20261112_07_seed_tools.sql      kpv_seed_counts
  users_roles.sql                   manager role, kpv_require, guard triggers, RLS deny + revokes
  seed_mock_data.sql                tagged mock data (replaces seed.sql)
  purge_seed_data.sql               one-command purge
  tests/verify_v2.sql               self-checking script for a real Supabase test project
src/
  actor.ts            (new) Actor type, header builder
  audit.ts            (new) auditDiff() shared by DemoStore; column ignore/redact lists
  replenishment.ts    (new) resolveParams, runwayStatus, computeVelocity (pure)
  dayStatus.ts        (new) buildDayStatus, streak/tier (pure)
  routes/moves.ts     (new) /moves, /moves/:ticketId/undo
  routes/cases.ts     (new) assignments, closed days
  routes/replenishment.ts (new)
  routes/audit.ts     (new)
  routes/meta.ts      (new) /meta (public)
  store.ts, app.ts, auth.ts, types.ts, logic.ts, routes/*.ts, index.ts   (modified)
public/js/views/
  day/ (new: index.js, row.js, sheets.js, move-sheet.js, history.js)  one-screen day check
  cases-switcher.js (new)
  settings/replenishment.js (replaces settings/leadtime.js), settings/closed-days.js (new), settings/audit.js (new)
  stock.js (modified: cards only; day screen moves to day/)
test/
  sql/db.ts (new loader), sql/*.test.ts (new)
  api.test.ts, logic.test.ts (extended), moves.test.ts, cases.test.ts, replenishment.test.ts, audit.test.ts (new)
```

---

## Phase A: Foundations

### Task 1: PGlite SQL test harness

**Files:**
- Modify: `package.json` (devDependency `@electric-sql/pglite`, pin the exact current version; script `"test:sql": "vitest run test/sql"`)
- Create: `test/sql/db.ts`, `test/sql/smoke.test.ts`

**Interfaces:**
- Produces: `freshDb(opts?: { upTo?: string; withRoles?: boolean; withBase?: boolean }): Promise<PGlite>` (loads `schema.sql`, then migrations in name order up to and including `upTo`, then `users_roles.sql` if `withRoles`, then `base.sql` if `withBase`). `asActor(db, actorId: string | null, opts?: { system?: string; jwtRole?: string }): Promise<void>` sets `request.headers` and `request.jwt.claims` via `set_config(..., false)` to mimic PostgREST. `expectPgError(p: Promise<unknown>, code: string): Promise<void>` asserts the error message contains `code`.

- [ ] **Step 1:** `git checkout -b v2-change-requests`.
- [ ] **Step 2: Write the failing test** `smoke.test.ts`: `freshDb({ withBase: true })` then `select count(*) from branches` = 4.
- [ ] **Step 3:** Run `npx vitest run test/sql/smoke.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement `db.ts`.** Before the SQL files run, create roles `anon`, `authenticated`, `service_role` (`do $$ … if not exists (select from pg_roles …) create role …`) because `schema.sql` revokes from them. Read files with `fs.readFileSync`; skip the migrations folder when absent.
- [ ] **Step 5:** Run `npx vitest run test/sql`. Expected: PASS. Then `npm test`: all 49 existing tests still pass.
- [ ] **Step 6: Commit** `test: PGlite harness that loads the real Supabase SQL`.

### Task 2: Migration 01: seed flag, inheritance, date and negative-stock guards

**Files:**
- Create: `supabase/migrations/20261112_01_foundation.sql`, `test/sql/foundation.test.ts`

**Interfaces:**
- Produces SQL: `kpv_today() returns date`; column `is_seed` on every v1 business table (spec 7c list minus the three tables created later); `kpv_inherit_seed()` trigger function; `ledger_guard_negative()`; `desk_days_guard_future()`; `ledger_guard_done()` replaced (purge-aware); `kpv_is_purging() returns boolean` (= `current_setting('kpv.purging', true) = 'on'`).
- Error tokens: `NEGATIVE_CLOSING`, `FUTURE_DATE`, `DAY_LOCKED` (unchanged).

- [ ] **Step 1: Write failing tests** in `foundation.test.ts`:
  - `refuses an insert with negative closing` (insert ledger row with `retail_sale` > opening → `NEGATIVE_CLOSING`).
  - `refuses an update that drops closing below zero`.
  - `allows updating an already-negative row when closing does not drop` (disable the trigger, create a −2 row, re-enable it; then setting `counted_qty = 0` succeeds; raising `retail_sale` fails).
  - `refuses a desk day after Laos today` (`FUTURE_DATE`).
  - `marks a ledger row seed when its desk is seed` (insert seed desk, ledger row without `is_seed` → row `is_seed = true`).
  - `Done lock allows deleting seed rows only while purging` (Done seed day: delete without flag → `DAY_LOCKED`; with `set local kpv.purging='on'` → ok; non-seed Done row with flag → still `DAY_LOCKED`).
- [ ] **Step 2:** Run `npx vitest run test/sql/foundation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the migration.**
  - `alter table <t> add column if not exists is_seed boolean not null default false` for: branches, desks, staff_accounts, sku_type, sku_weight, master_sku, desk_days, daily_stock_ledger, transfers, documents, document_rows, doc_counters, audit_log.
  - `kpv_inherit_seed()`: BEFORE INSERT; sets `new.is_seed := true` if any referenced parent is seed. The parent columns by table (use `TG_TABLE_NAME` + `to_jsonb(new)` to read them): branch_id → branches; desk_id, from_desk_id, to_desk_id → desks; sku_id → master_sku; document_id → documents; staff_id, actor_id → staff_accounts. Attach to desks, desk_days, daily_stock_ledger, transfers, documents, document_rows, doc_counters, master_sku (via type_id/weight_id: sku_type/sku_weight).
  - `ledger_guard_negative()`: BEFORE INSERT OR UPDATE on daily_stock_ledger; compute closing from the NEW columns (generated columns are not populated in BEFORE triggers): `v := new.opening_qty + new.stock_in + new.transfer_in - new.retail_sale - new.wholesale - new.transfer_out - new.destock - new.move`; raise `'NEGATIVE_CLOSING: available %', <old closing or 0>` (errcode `P0001`) when `v < 0 and (tg_op = 'INSERT' or v < old.closing_qty)`.
  - `desk_days_guard_future()`: BEFORE INSERT on desk_days; `new.ledger_date > kpv_today()` → `FUTURE_DATE`.
  - Replace `ledger_guard_done()`: on DELETE, return OLD when `kpv_is_purging() and old.is_seed`; otherwise the v1 behaviour.
  - End with a `do $$` block that `raise notice`s each open-day ledger row with closing < 0 (desk, date, sku) so the operator sees them (Go-live step in Task 18).
- [ ] **Step 4:** Run `npx vitest run test/sql`. Expected: PASS.
- [ ] **Step 5: Worker mapping.** In `SupabaseStore.send` (`src/store.ts`), map a body containing `NEGATIVE_CLOSING` to new `StoreErrorCode` `"NEGATIVE"` and `FUTURE_DATE` to `"INVALID"`; in `src/index.ts` `STORE_STATUS` add `NEGATIVE: 409` with message "This would make the stock negative" and code `NEGATIVE_CLOSING`. In `DemoStore.patchLedgerRows` / `insertLedgerRows` apply the same rule (throw `StoreError("NEGATIVE", …)`).
- [ ] **Step 6: API test** in `test/api.test.ts`: `refuses a sale larger than the stock with NEGATIVE_CLOSING` (POST entries with `retail_sale` > closing → 409, `code` `NEGATIVE_CLOSING`). Run `npm test`. Expected: PASS (fix any existing test that relied on a temporarily negative row by recording the In first).
- [ ] **Step 7: Commit** `feat(db): seed flag, seed inheritance, negative-stock and future-date guards`.

### Task 3: Migration 02: actor helpers and immutable audit trigger

**Files:**
- Create: `supabase/migrations/20261112_02_audit.sql`, `test/sql/audit.test.ts`

**Interfaces:**
- Produces SQL:
  - `kpv_actor_id() returns uuid`: header `x-kpv-actor-id` from `current_setting('request.headers', true)::json`, else GUC `kpv.actor_id`, else null. Invalid UUID → null.
  - `kpv_actor_source() returns text`: `'api'` when the header id is present, `'system:' || header x-kpv-actor-system` when that is present, `'sql:' || current_user` otherwise.
  - `kpv_jwt_role() returns text`: `current_setting('request.jwt.claims', true)::json->>'role'`.
  - `audit_log` new columns: `table_name text, op text, row_key jsonb, desk_id text, branch_id text, actor_role text, source text, old_values jsonb, new_values jsonb` (all nullable; `action`, `target`, `actor_name` keep their v1 NOT NULL: the trigger fills `action = lower(op) || ':' || table_name`, `target = row_key::text`). Index `(desk_id, created_at desc)`, `(branch_id, created_at desc)`.
  - `audit_row_change()`: AFTER INSERT/UPDATE/DELETE row trigger, generic.
  - `audit_log_immutable()` row trigger and `audit_log_no_truncate()` statement trigger.
  - `kpv_attach_audit(p_table regclass)` helper, also used by migrations 05 and 06.
- Error tokens: `AUDIT_ACTOR_MISSING`, `AUDIT_IMMUTABLE`.

- [ ] **Step 1: Write failing tests:**
  - `logs a ledger update as old → new with the header actor` (`asActor(db, staffId)`, update `stock_in` 0→3 → one audit row: `old_values = {"stock_in":0}`, `new_values = {"stock_in":3}`, `desk_id`, `branch_id`, `actor_id = staffId`, `actor_name` = that staff's display_name, `source = 'api'`).
  - `skips no-op updates and ignores updated_at / performed_by`.
  - `redacts pin_hash` (`new_values.pin_hash = "changed"`); `does not log failed_attempts alone`.
  - `refuses a service_role write without an actor` (`asActor(db, null, { jwtRole: 'service_role' })` → `AUDIT_ACTOR_MISSING`); `accepts a system-tagged write` (`{ system: 'login', jwtRole: 'service_role' }`).
  - `audit rows cannot be updated, deleted or truncated` (`AUDIT_IMMUTABLE`), `except seed rows while purging`.
  - `audit row of a seed row is seed` (`is_seed` copied from NEW/OLD).
  - `writes nothing while purging` (deleting seed rows under `kpv.purging` adds no audit rows).
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3: Write the migration.** Core of `audit_row_change()` (the part a builder could get wrong):
  ```sql
  if kpv_is_purging() then return null; end if;
  if kpv_actor_id() is null and kpv_jwt_role() = 'service_role'
     and coalesce(current_setting('request.headers', true)::json->>'x-kpv-actor-system','') = '' then
    raise exception 'AUDIT_ACTOR_MISSING: %', tg_table_name using errcode = 'P0001';
  end if;
  o := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  -- keep only keys whose values differ; drop updated_at, performed_by, created_at;
  -- staff_accounts: drop failed_attempts, token_version; pin_hash -> '"changed"'
  -- if UPDATE and no keys remain -> return null
  ```
  `row_key`: primary-key columns from `pg_index`/`pg_attribute` for `tg_relid` (cache-free lookup is fine at this volume). `desk_id` = `coalesce(n,o)->>'desk_id'` or `->>'from_desk_id'`; `branch_id` = `->>'branch_id'` or `->>'from_branch_id'`. `actor_name`/`actor_role` from `staff_accounts` by `kpv_actor_id()`, else `kpv_actor_source()`.
  Attach via `kpv_attach_audit` to: desks, staff_accounts, master_sku, sku_type, sku_weight, desk_days, daily_stock_ledger, transfers, documents, document_rows, system_config.
- [ ] **Step 4:** Run `npx vitest run test/sql`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): immutable row-level audit trail with actor from request headers`.

### Task 4: Worker sends the actor; DemoStore mirrors the audit trail

**Files:**
- Create: `src/actor.ts`, `src/audit.ts`, `test/audit.test.ts`
- Modify: `src/store.ts` (`getStore`, `SupabaseStore`, `DemoStore` mutators), `src/app.ts` (add `storeFor`), every `src/routes/*.ts` (replace `getStore(c.env)` with `storeFor(c)`), `src/routes/auth.ts` (system actor `login`), `src/types.ts` (`AuditEntry` new optional fields)

**Interfaces:**
- Consumes: Task 3's column names and ignore/redact lists.
- Produces:
  - `type Actor = { id: string } | { system: string }`; `actorHeaders(a: Actor | undefined): Record<string, string>` → `X-KPV-Actor-Id` or `X-KPV-Actor-System`.
  - `getStore(env: Env, actor?: Actor): Store`. `SupabaseStore` keeps the actor and adds its headers in `send`. `DemoStore` is still cached; `getStore` returns `demo.withActor(actor)`, a thin view sharing the same data.
  - `storeFor(c: Ctx): Store` in `src/app.ts`: `getStore(c.env, user ? { id: user.accountId } : undefined)`.
  - `auditDiff(table: string, op: "INSERT"|"UPDATE"|"DELETE", oldRow: object|null, newRow: object|null): { old_values, new_values } | null` in `src/audit.ts` (same rules as the SQL trigger; null = nothing to log).
  - `AuditEntry` gains optional `table_name, op, row_key, desk_id, branch_id, actor_role, source, old_values, new_values, is_seed`.

- [ ] **Step 1: Failing tests** in `test/audit.test.ts` (API level, DemoStore): `a ledger entry writes an audit row with the session actor, desk and old → new`; `login failures write nothing; a lockout writes locked_until with source system:login`; `auditDiff ignores updated_at and redacts pin_hash` (unit).
- [ ] **Step 2:** Run `npx vitest run test/audit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every DemoStore mutator that changes a row calls a private `log(table, op, old, new)` built on `auditDiff` (the DemoStore equivalent of the trigger). The DemoStore throws `AUDIT_ACTOR_MISSING` when mutated with no actor, so a route that forgot `storeFor` fails in tests. Login uses `getStore(env, { system: "login" })`.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: attribute every write to the acting staff member`.

---

## Phase B: Roles

### Task 5: Branch manager role and `users_roles.sql`

**Files:**
- Create: `supabase/users_roles.sql`, `test/sql/roles.test.ts`
- Modify: `src/types.ts` (`StaffRole = "staff" | "manager" | "admin"`), `src/auth.ts` (`requireManager`, `isManagerOf`), `src/app.ts` (`scopeBranch`: manager = own branch), `src/routes/settings.ts` (user create/update accepts `manager`; unlock allowed to manager for own-branch staff), `public/js/views/settings/users.js` (3-option role picker), `public/js/session.js` (role helpers), `public/js/i18n.js`, `test/api.test.ts`, `src/demoData.ts` (add `DEMO_MANAGER["B-MM"]`, PIN 5678)

**Interfaces:**
- Produces SQL: `kpv_actor() returns table(id uuid, role text, branch_id text)`; `kpv_require(p_roles text[], p_branch text default null) returns void` (no-op when `kpv_actor_id()` is null and `kpv_jwt_role()` is not `service_role`, i.e. the SQL editor; raises `ROLE_DENIED` otherwise when the role is not in `p_roles` or a non-admin's branch ≠ `p_branch`).
- Guard triggers (BEFORE): `guard_master_data` on master_sku, sku_type, sku_weight, system_config → `kpv_require('{admin}')`; `guard_staff_accounts` → admin, except a manager may change only `failed_attempts`/`locked_until` of own-branch staff; `guard_desk_day_reopen` on desk_days when `old.status = 'done' and new.status <> 'done'` → admin, or manager of the branch with `old.ledger_date >= kpv_today() - 3`. (Rule, closed-day and assignment guards are added with their tables in Tasks 10 and 13, using `kpv_require`.)
- Produces TS: `requireManager` (admin or manager) middleware; `isManagerOf(user, branchId): boolean`.

- [ ] **Step 1: Failing SQL tests** `roles.test.ts`: `staff cannot change a SKU` (`ROLE_DENIED`); `manager reopens own-branch Done day of 2 days ago`; `manager cannot reopen 4 days ago or another branch`; `manager can unlock own-branch staff but not change their role`; `SQL editor (no actor, not service_role) passes guards`; `anon has no table privileges` (`select has_table_privilege('anon','daily_stock_ledger','select')` = false for every public table).
- [ ] **Step 2: Failing API tests:** `manager sees only own branch`; `manager reopens latest Done day within 3 days with a reason`; `manager reopen of an older day → 403 REOPEN_TOO_OLD`; `manager cannot create users → 403`; `admin can create a manager; a manager without branch → 400`.
- [ ] **Step 3:** Run both. Expected: FAIL.
- [ ] **Step 4: Write `users_roles.sql`:** drop and re-add the role check (`'staff','manager','admin'`) and `staff_branch_required` (`role = 'admin' or branch_id is not null`); helpers; guard triggers; `alter table … enable row level security` for **every** table in `public` (loop over `pg_tables`); `revoke all on all tables/sequences/functions in schema public from anon, authenticated, public`; `alter default privileges in schema public revoke all on tables/functions from anon, authenticated, public`; `grant execute` on the v2 RPCs to `service_role`. Header comment: purpose, run order, and first-admin instructions (`npm run db:admin`).
- [ ] **Step 5: Implement the Worker side.** Reopen route: `requireManager`; a manager must have branch access and `date >= addDays(today, -3)` (else 403 `REOPEN_TOO_OLD`); reopen sets status `check_in` (spec 5.6). The users UI role picker shows Staff / Branch manager / Admin (Lao + EN).
- [ ] **Step 6:** Run `npm test`, `npm run test:sql`, `npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: branch manager role with database-enforced permissions`.

---

## Phase C: Day check engine and screen (CR5)

### Task 6: CAS entries, counts any time, `/close`

**Files:**
- Create: `supabase/migrations/20261112_03_ledger_apply.sql`, `test/sql/ledger_apply.test.ts`
- Modify: `src/store.ts` (`applyLedgerChanges`), `src/routes/stock.ts` (entries, new `/close`), `src/logic.ts` (no change to `validateDeskDay`), `test/api.test.ts`, `test/helpers.ts` (`closeDay` uses `/close`)

**Interfaces:**
- Produces SQL: `ledger_apply(p_date date, p_desk text, p_sku text, p_changes jsonb) returns jsonb`. `p_changes = [{field, from?, to}]`, fields limited to `stock_in, retail_sale, wholesale, destock, destock_note, counted_qty, counted_note`. Locks the row `FOR UPDATE`. For each change: if `from` is present, the stored value ≠ `from` and the stored value ≠ `to` → return `{"ok":false,"code":"ROW_CHANGED","row":<row>}` without writing. Otherwise one UPDATE. Returns `{"ok":true,"row":<row>}`. Missing row → `{"ok":false,"code":"ROW_NOT_FOUND"}`.
- Produces TS: `Store.applyLedgerChanges(key: LedgerKey, changes: LedgerChange[]): Promise<{ ok: true; row: LedgerRow } | { ok: false; code: "ROW_CHANGED" | "ROW_NOT_FOUND"; row?: LedgerRow }>`; `type LedgerChange = { field: LedgerChangeField; from?: number | string | null; to: number | string | null }`.
- API: `POST /stock/desk/:id/entries` body `{date, changes: [{sku_id, field, from?, to}], safe_drop_note?}` → `{ok, rows}` or `409 ROW_CHANGED {row}` / `409 NEGATIVE_CLOSING {available}`. Legacy `{rows:[…]}` still accepted. `POST /stock/desk/:id/close {date, safe_drop_note?}` → Done from `check_in` or `final_stock`; `422 DAY_INCOMPLETE {failures}`.

- [ ] **Step 1: Failing SQL tests:** `applies a change when from matches`; `returns ROW_CHANGED with the row when from is stale`; `treats stored == to as success (retry)`; `refuses a field outside the list`; `negative result raises NEGATIVE_CLOSING`.
- [ ] **Step 2: Failing API tests:** `two devices: the second stale change gets 409 ROW_CHANGED with the current row`; `a retried change that already applied returns ok`; `counted_qty saves while the day is check_in`; `close goes straight from check_in to done when everything is counted`; `close refuses with DAY_INCOMPLETE listing count_missing`.
- [ ] **Step 3:** Run them. Expected: FAIL.
- [ ] **Step 4: Implement** the migration, `SupabaseStore.applyLedgerChanges` (rpc), the `DemoStore` equivalent (synchronous body, so atomic), and the routes. Remove the "count only in final_stock" guard. `/close` reuses `validateDeskDay` and the carry-forward block from `/transition`; extract that block into `closeDeskDay(store, user, desk, date, note)` in `stock.ts` so both routes share it.
- [ ] **Step 5:** Run `npm test && npm run test:sql && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: compare-and-set day entries, counts any time, one-step close`.

### Task 7: One-screen day check UI (no sideways scroll)

**Files:**
- Create: `public/js/views/day/index.js` (screen, sticky totals and footer, groups, search, count mode), `public/js/views/day/row.js` (2/3-row SKU card), `public/js/views/day/sheets.js` (In sheet, Out sheet with Retail/Wholesale/Destock+reason, count note, reopen-with-reason), `public/js/views/day/save-queue.js` (600 ms stepper buffer, CAS send, one automatic rebase, conflict prompt)
- Modify: `public/js/views/stock.js` (remove the grid at lines ~390–950 and open `day/index.js` instead), `public/js/api.js` (`saveChanges`, `closeDay`), `public/js/i18n.js`, `src/styles/input.css` if utilities are needed

**Interfaces:**
- Consumes: Task 6 API; desk detail `GET /stock/desk/:id?date=` (unchanged shape plus `group_name` per row from Task 13; until then group by type `category`).
- Produces: `mountDay(deskCard, date)`, `unmountDay()`; `openMoveSheet(ctx)` is called from the ⇄ cell (implemented in Task 9; until then ⇄ opens the existing transfer sheet).

- [ ] **Step 1: Build the screen** to spec §6 layout: row 2 `grid grid-cols-4` with `min-w-0` cells, no fixed px widths, no `overflow-x-auto` anywhere in the day screen. Out cell shows `retail_sale + wholesale + destock`; ⇄ shows signed `transfer_in − transfer_out − move`; Open read-only; Closing large in row 1. Count mode toggle reveals row 3 with count input and "✓ matches" (sets that row only). The Done screen is read-only with the "Closed HH:mm by Name" banner and a Reopen button for admin/manager.
- [ ] **Step 2: Wire saving** through `save-queue.js`: steppers buffer 600 ms then send `{field, from, to}`; on `ROW_CHANGED`, a stepper change rebases once (`to = current + (to − from)`), a typed change shows "Changed by {name} to {n}: keep yours?"; on `NEGATIVE_CLOSING` the sheet shows "Only {available} available. Record Stock In first." and keeps the sheet open.
- [ ] **Step 3: Verify layout.** `npm run dev`; open the app in Chrome DevTools device mode at **360 px** and **375 px**; demo desk with ≥ 10 sizes; type 99 999 into In on one row. In the console, on the day screen, the In sheet, the Out sheet and count mode: `document.documentElement.scrollWidth <= window.innerWidth` → `true` each time. Take a 375 px screenshot for the PR.
- [ ] **Step 4: Verify flows by hand:** record In 3, Out 1 retail, count all with ✓, close (before 15:30 asks to confirm), reopen as manager with a reason, Lao and English labels.
- [ ] **Step 5:** `npm test` still passes (API unchanged). **Commit** `feat(ui): one-screen day check that fits a phone`.

---

## Phase D: Moves (CR1)

### Task 8: Atomic same-branch move with idempotency and undo

**Files:**
- Create: `supabase/migrations/20261112_04_moves.sql`, `test/sql/moves.test.ts`, `src/routes/moves.ts`, `test/moves.test.ts`
- Modify: `src/store.ts` (`moveStock`, `undoMove`), `src/types.ts` (`Transfer` gains `client_ref, reverses_id, ticket_id, note, is_seed`), `src/routes/transfers.ts` (same-branch destination → 400 `USE_MOVE`), `src/index.ts` (mount), `src/routes/stock.ts` (export the check-in body as `checkInDesk(store, user, desk, date, today): Promise<"created"|"exists">` for reuse)

**Interfaces:**
- Produces SQL:
  - columns on `transfers`: `client_ref uuid unique, reverses_id uuid references transfers(id), ticket_id uuid, note text` + index on `ticket_id`.
  - `move_stock(p_date date, p_from text, p_to text, p_lines jsonb, p_client_ref uuid, p_note text) returns jsonb`. Order: (1) if a transfer with `client_ref = p_client_ref` exists, return its ticket (`{"ok":true,"ticket_id":…,"replayed":true}`); (2) refuse `SAME_DESK`, `OTHER_BRANCH`; (3) lock both `desk_days` rows `FOR UPDATE` **ordered by desk_id**; missing → `DEST_NOT_OPEN`/`NOT_CHECKED_IN`; `done` → `DEST_DAY_LOCKED`/`DAY_LOCKED`; (4) lock source ledger rows `FOR UPDATE` ordered by sku_id; any `qty > closing` → return `{"ok":false,"code":"NOT_ENOUGH_STOCK","sku_id":…,"available":…}` (nothing written); (5) per line: source `move += qty`; destination row upsert (`opening_qty 0`) then `transfer_in += qty`; insert `transfers` row (`kind 'move'`, `status 'received'`, `received_date = p_date`, `received_by = sent_by = kpv_actor_id()`, shared `ticket_id`, first line carries `client_ref`). Returns `{"ok":true,"ticket_id":…,"moves":[…]}`.
  - `undo_move(p_ticket uuid, p_client_ref uuid) returns jsonb`: refuses `ALREADY_UNDONE` if a ticket already reverses it; calls `move_stock` with swapped desks, same date and lines; sets `reverses_id` on the new rows.
- Produces TS: `Store.moveStock(input: { date: string; fromDeskId: string; toDeskId: string; lines: { skuId: string; qty: number }[]; clientRef: string; note?: string }): Promise<MoveResult>`; `Store.undoMove(ticketId: string, clientRef: string): Promise<MoveResult>`; `type MoveResult = { ok: true; ticketId: string; moves: Transfer[]; replayed?: boolean } | { ok: false; code: string; skuId?: string; available?: number }`.
- API: `POST /api/moves` `{date, fromDeskId, toDeskId, lines:[{skuId, qty}], clientRef, note?}`; `POST /api/moves/:ticketId/undo {clientRef}`. HTTP: `NOT_ENOUGH_STOCK` 409, `DEST_NOT_OPEN` 409 (+`openDate`), `DEST_DAY_LOCKED`/`DAY_LOCKED` 423, `OTHER_BRANCH`/`SAME_DESK`/`BAD_QTY` 400.

- [ ] **Step 1: Failing SQL tests:** `moves stock between two open cases in one transaction`; `refuses more than available and writes nothing`; `multi-line ticket is all-or-nothing`; `same client_ref replays without a second effect`; `refuses when the destination day is Done`; `undo reverses and cannot be undone twice`.
- [ ] **Step 2: Failing API tests** (`test/moves.test.ts`): `moving 1 piece updates both cases immediately (A.move, B.transfer_in, both closings)`; `two simultaneous moves of the last pieces: one succeeds, one NOT_ENOUGH_STOCK` (`Promise.all`); `destination not checked in is checked in automatically with carried-forward openings`; `destination with an unfinished earlier day → DEST_NOT_OPEN with openDate`; `undo after the destination sold the pieces → NOT_ENOUGH_STOCK, nothing changes`; `a repeated clientRef returns the same ticket`; `staff cannot move to another branch's case via /moves (OTHER_BRANCH)`; `POST /transfers to a same-branch case → USE_MOVE`; `audit has one row per ledger change with the actor`.
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4: Implement.** Route: validate input with `parseQty` (qty ≥ 1), `requireDesk` both, `assertDateWritable` for the source; call `checkInDesk` for the destination when it has no day (catching `EARLIER_DAY_OPEN` → `DEST_NOT_OPEN`); then `store.moveStock`. DemoStore: one synchronous method, same steps.
- [ ] **Step 5:** `npm test && npm run test:sql && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: instant atomic case-to-case moves with undo`.

### Task 9: Move sheet (2 taps) and Undo toast

**Files:**
- Create: `public/js/views/day/move-sheet.js`
- Modify: `public/js/views/day/row.js` (⇄ opens it), `public/js/api.js` (`move`, `undoMove`), `public/js/ui.js` (toast with action button and timeout), `public/js/i18n.js`

**Interfaces:**
- Consumes: Task 8 API; desk cards (other open cases of the branch, holder names from Task 12 when present).
- Produces: `openMoveSheet({ desk, date, row, onDone })`.

- [ ] **Step 1: Build** per spec §2 Mobile flow: stepper preset 1 (max = available, label "of N"); one full-width button per other case of the branch, last-used first (remember in `localStorage` per branch, wrapped in try/catch); tapping a case **commits**; "+ Add another item" turns it into a ticket with one confirm button; tab "Other branch" shows the existing cross-branch transfer form. `clientRef = crypto.randomUUID()` created when the sheet opens, reused on retry.
- [ ] **Step 2:** Undo toast for 6 s calls `undoMove`; after that, Undo is on the move in the History tab (Task 16).
- [ ] **Step 3: Verify by hand** at 375 px: 1 piece A→B in 2 taps; both cases show new closings after reload; Undo restores; scroll-width check passes on the sheet.
- [ ] **Step 4: Commit** `feat(ui): two-tap move sheet with undo`.

---

## Phase E: Cases: assignment, closed days, streak cards (CR3, CR4b)

### Task 10: Closed days and case assignment (DB + API)

**Files:**
- Create: `supabase/migrations/20261112_05_cases.sql`, `test/sql/cases.test.ts`, `src/routes/cases.ts`, `test/cases.test.ts`
- Modify: `src/store.ts`, `src/types.ts`, `src/index.ts`, `supabase/users_roles.sql` (guards for the two tables)

**Interfaces:**
- Produces SQL:
  - `branch_closed_day(branch_id text references branches, closed_date date, reason text not null, created_by uuid, created_at timestamptz default now(), is_seed bool, primary key(branch_id, closed_date))`.
  - `desk_assignment(id uuid pk default gen_random_uuid(), desk_id text not null references desks, staff_id uuid not null references staff_accounts, started_at timestamptz not null default now(), started_by uuid, ended_at timestamptz, ended_by uuid, note text, is_seed bool)`; `create unique index uq_desk_assignment_active on desk_assignment(desk_id) where ended_at is null`; index `(staff_id) where ended_at is null`.
  - `assign_desk(p_desk text, p_staff uuid, p_note text) returns desk_assignment` (lock desk row; staff must be active and of the desk's branch, else `ASSIGN_OTHER_BRANCH`/`ASSIGN_INACTIVE`; ends the active row; inserts new; no-op when already that staff).
  - `release_desk(p_desk text) returns void`.
  - Trigger on `staff_accounts` AFTER UPDATE: when `active` becomes false **or** `branch_id` changes → end that staff's active assignments (`ended_by = kpv_actor_id()`).
  - Seed inheritance + audit attached to both tables. Guards in `users_roles.sql`: closed days → manager of branch or admin; assignment insert → staff only when `staff_id = actor` or the actor currently holds that desk, manager of branch, admin.
- Produces TS: `Store.closedDays(filter: { branchId?: string; from?: string; to?: string }): Promise<ClosedDay[]>`, `addClosedDays(rows: ClosedDay[])`, `removeClosedDay(branchId, date)`, `activeAssignments(filter: { branchId?: string }): Promise<DeskAssignment[]>`, `assignDesk(deskId, staffId, note?): Promise<DeskAssignment>`, `releaseDesk(deskId): Promise<void>`. Types `ClosedDay`, `DeskAssignment` mirror the tables.
- API: `GET/POST/DELETE /api/closed-days` (`POST {branchId|"all", date, reason}`); `POST /api/desks/:id/assign {staffId, note?}`, `POST /api/desks/:id/release`; `GET /api/my-cases`.

- [ ] **Step 1: Failing tests** (SQL + API): `one active holder per case; handover ends the previous row with ended_by`; `one staff can hold several cases`; `staff can take a free case and hand their own case to a branch colleague, but not take over another holder's case`; `manager assigns anyone in branch; cross-branch → ASSIGN_OTHER_BRANCH`; **`deactivating or moving a staff member to another branch ends their assignments`**; `staff cannot add a closed day; manager adds for own branch; admin "all" adds one row per branch`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** migration, guards, store methods (DemoStore mirrors the trigger in `updateStaffAccount`), routes. Staff taking over someone else's case → 403 `NOT_HOLDER` in the Worker (spec 4.12).
- [ ] **Step 4:** All suites + typecheck pass. **Commit** `feat: case assignment with handover history and branch closed days`.

### Task 11: Streak, days behind, tier (pure) and the cards API

**Files:**
- Create: `src/dayStatus.ts`, `test/dayStatus.test.ts`
- Modify: `src/routes/stock.ts` (`GET /stock/desks`), `src/logic.ts` (`buildDeskCards` accepts the extra fields), `test/api.test.ts`

**Interfaces:**
- Produces: `type Tier = "done_today" | "on_track" | "behind_1" | "overdue"`; `buildDayStatus(input: { deskCreatedDate: string; days: Pick<DeskDay,"ledger_date"|"status"|"done_at"|"done_by">[]; closedDates: Set<string>; today: string }): { streak: number; lastDoneDate: string | null; lastDoneAt: string | null; lastDoneBy: string | null; daysBehind: number; tier: Tier }`. Definitions exactly as spec §4 (anchor, required dates, closed dates skipped). Streak capped at 366 (UI prints "365+").
- Cards response adds per card `{streak, lastDoneDate, lastDoneAt, lastDoneByName, daysBehind, tier, assignee: {staffId, name, since, stale} | null}` and top-level `branchSummary: {cases, checkedToday, behind1, overdue}`; cards sorted overdue first, then `sort_order`.

- [ ] **Step 1: Failing unit tests:** `21 consecutive Done days, today open → on_track, streak 21`; `today Done → done_today, streak includes today`; `last Done today−2 → behind_1`; `last Done today−4 → overdue, daysBehind 3`; **`a closed day with Done records is skipped: streak neither breaks nor counts it`**; `a closed day in a gap is not counted as behind`; `new case created today → on_track, streak 0, behind 0`; `an unfinished (check_in) earlier day counts as behind`.
- [ ] **Step 2: Failing API test:** `cards: overdue case is first; branchSummary counts`; `assignee started yesterday is stale`.
- [ ] **Step 3:** Run. FAIL. **Step 4:** Implement; the route loads desk days `from = addDays(today, -400)` for the branch (paged by `restAll`) plus closed days and active assignments.
- [ ] **Step 5:** All pass. **Commit** `feat: case streak, days behind and tier on the cards API`.

### Task 12: Cards, overdue strip, My cases switcher, Switch user, closed-days settings

**Files:**
- Create: `public/js/views/cases-switcher.js`, `public/js/views/settings/closed-days.js`
- Modify: `public/js/views/stock.js` (`renderGrid`, `renderBadges`, top bar), `public/js/views/login.js` (open with a preselected branch), `public/js/views/settings/index.js`, `public/js/views/dashboard.js` (admin "All branches" list: checked today / behind / overdue, worst first), `public/js/api.js`, `public/js/i18n.js`

**Interfaces:**
- Consumes: Task 10 and Task 11 APIs.

- [ ] **Step 1: Cards** per spec §4 tier table: left bar + tint + text; overdue cards rendered in a full-width pinned strip above the grid ("Not checked {n} days · last {date}"); branch header line "4 cases · 3 checked today · 1 overdue"; streak with a flame icon from the existing icon set; holder line "👤 Noy · since 13:05" or muted "Last: Noy (yesterday)" with **Take this case**.
- [ ] **Step 2: Switcher:** top-bar chip "My cases · n" opens the sheet in spec 4.17 (take / take over with confirm / release / hand to…). **Switch user** opens login with the branch preselected and clears the session.
- [ ] **Step 3: Closed days settings** (manager/admin): list by month, add (date, reason, branch or all branches), remove.
- [ ] **Step 4: Verify by hand** against the seed later (Task 17), now against the demo: overdue strip on top, tiers readable in grayscale (DevTools "emulate achromatopsia"), scroll-width check at 375 px. **Commit** `feat(ui): case-of-day cards, case switcher, closed days`.

---

## Phase F: Replenishment (CR2)

### Task 13: Migration 06: rules, group, config, velocity RPC

**Files:**
- Create: `supabase/migrations/20261112_06_replenishment.sql`, `test/sql/replenishment.test.ts`
- Modify: `supabase/users_roles.sql` (guard for `replenishment_rule`)

**Interfaces:**
- Produces SQL:
  - `alter table master_sku add column if not exists group_name text`; index `(group_name)`.
  - `replenishment_rule` as spec §3 "Data and API", plus `create unique index uq_rule_scope on replenishment_rule(scope, scope_key, coalesce(branch_id,'*'))`, `check (avg_daily_sell is not null or lead_time_days is not null)`.
  - `system_config` columns `default_lead_time_days numeric(5,1) not null default 7`, `warning_margin_days numeric(5,1) not null default 3`, `velocity_window_days int not null default 28 check (velocity_window_days between 7 and 120)`.
  - Data copy (guarded so it runs once: skip SKUs that already have a `sku` company-wide rule): non-null `master_sku.avg_daily_sales / order_lead_time_days` → `scope 'sku'`, `branch_id null`.
  - `branch_velocity(p_branch text, p_to date, p_days int) returns table(sku_id text, sold int, in_stock_days int, velocity numeric)`, exactly spec 2.5: dates `p_to - p_days … p_to - 1`; only `desk_days.status = 'done'` of the branch; exclude `branch_closed_day`; group by date then SKU; a date is in stock when Σ(opening+stock_in+transfer_in) > 0; `velocity = sold / in_stock_days` when `in_stock_days >= 7`, else null.
  - Guard: rule with `branch_id null` → admin; with branch → admin or that branch's manager.

- [ ] **Step 1: Failing SQL tests:** `velocity ignores zero-stock days` (10 days in stock selling 2/day + 5 days out of stock → 2.0); `velocity ignores moves and destock`; `velocity is null below 7 in-stock days`; `closed days and non-Done days are excluded`; `data copy creates sku rules once`; `manager cannot write a company-wide rule`.
- [ ] **Step 2:** FAIL → implement → PASS (`npm run test:sql`). **Commit** `feat(db): replenishment rules, product group and branch velocity`.

### Task 14: Resolution, runway, alerts and the replenishment API

**Files:**
- Create: `src/replenishment.ts`, `test/replenishment.test.ts`, `src/routes/replenishment.ts`
- Modify: `src/store.ts` (`rules`, `upsertRule`, `deleteRules`, `branchVelocity`), `src/types.ts` (`ReplenishmentRule`, `SystemConfig` new fields, `MasterSku.group_name`), `src/logic.ts` (`buildDeskCards`: replace `lowStockCount` with `criticalCount` from branch statuses; dashboard low-stock uses branch statuses; remove `reorderPoint` uses), `src/routes/settings.ts` (SKU create/update + CSV accept `group`; `/settings/run-rate` removed in favour of the new API), `src/routes/insights.ts`, `src/index.ts`, `src/demoData.ts` (a "Snake Necklace" group on demo necklaces + a few rules)

**Interfaces:**
- Produces:
  - `resolveParams(sku: MasterSku, branchId: string, rules: ReplenishmentRule[], config: SystemConfig, autoAvg: number | null): { avg: { value: number | null; source: ParamSource }; lead: { value: number; source: ParamSource } }`, `ParamSource = "sku-branch"|"sku"|"group-branch"|"group"|"type-branch"|"type"|"auto"|"default"|"none"`. Each field resolves independently in the order of spec 2.3.
  - `runwayStatus(input: { position: number; avg: number | null; lead: number; margin: number; reorderLevel: number; onHand: number }): { runwayDays: number | null; status: "critical"|"warning"|"ok"|"no_data"; fixedLevel: boolean; suggestedQty: number }` per spec 2.9–2.13.
  - `computeVelocity(rows, days, closedDates, to, windowDays)`: the TS twin of `branch_velocity`, used by DemoStore.
  - `Store.branchVelocity(branchId, to, days): Promise<{ sku_id: string; sold: number; in_stock_days: number; velocity: number | null }[]>`.
  - API `GET /api/replenishment?branchId=` (staff: own branch) → `{ branchId, today, config:{lead default, margin, window}, rows:[…spec §3 fields…] }`; `PUT /api/replenishment/rules`; `POST /api/replenishment/rules/bulk` (`dryRun` → `{affected, overrides}`).

- [ ] **Step 1: Failing unit tests:** precedence (`sku-branch beats sku beats group-branch …`; `avg and lead resolve independently`; `no avg rule → auto`; `no lead rule → default 7`); `runway ≤ lead → critical`; `lead < runway ≤ lead+3 → warning`; `position 0 with avg → critical`; `no avg, below reorder_level → warning fixedLevel`; `suggestedQty = ceil(avg×(lead+margin)) − position, min 0`; `review flag when auto differs >50% with ≥14 days`.
- [ ] **Step 2: Failing API tests:** `branch position sums every case of the branch plus inbound in-transit`; `bulk apply by group writes one rule and keeps SKU overrides unless clearOverrides`; `dryRun reports affected and override counts`; `manager edits own-branch rules only; staff read-only`; `desk card criticalCount follows branch status`.
- [ ] **Step 3:** FAIL → implement → PASS (`npm test`, `npm run typecheck`). Fix existing tests that asserted `lowStockCount`.
- [ ] **Step 4: Commit** `feat: branch-wide runway with rule precedence and alerts`.

### Task 15: Replenishment screens

**Files:**
- Create: `public/js/views/settings/replenishment.js` (replaces `leadtime.js`, which is deleted)
- Modify: `public/js/views/settings/index.js`, `public/js/views/settings/sku.js` (Group field with suggestions from existing groups; CSV template gains `group`), `public/js/views/dashboard.js` (Reorder panel: Critical/Warning counts per branch → list), `public/js/views/day/row.js` (runway chip on Critical/Warning rows), `public/js/api.js`, `public/js/i18n.js`

- [ ] **Step 1: Build** per spec §3 UI: grouped list; group header "Set for all {n} sizes" opens a sheet (avg/day, lead, scope company / this branch, "also clear {k} SKU overrides" off by default, dry-run preview line); each SKU row shows effective values with a source tag and the auto value; "Review" chip.
- [ ] **Step 2: Verify by hand** at 375 px (scroll-width check) and that a bulk apply on "Snake Necklace" changes the runway of every size. **Commit** `feat(ui): replenishment settings, reorder panel, runway chips`.

---

## Phase G: Audit views (CR4a)

### Task 16: Audit API, History tab, admin audit screen

**Files:**
- Create: `src/routes/audit.ts`, `public/js/views/day/history.js`, `public/js/views/settings/audit.js`
- Modify: `src/store.ts` (`auditLog(filter: { deskId?; branchId?; from?; to?; actorId?; before?: string; limit: number })`), `src/index.ts`, `public/js/i18n.js` (field labels), `test/audit.test.ts`

**Interfaces:**
- API `GET /api/audit?deskId&branchId&from&to&actorId&before` → `{entries, next}` (50 per page, `before` = last `created_at` cursor). Scope per spec 4.8: staff → only `deskId` of own branch and today; manager → own branch; admin → all.
- Sentence format (spec 4.9): `{actor} · {HH:mm} · {case} · {sku} · {field} {old} → {new}`.

- [ ] **Step 1: Failing API tests:** `staff sees today's entries of a case in their branch only`; `manager cannot read another branch → 403`; `paging with before returns older entries`; `there is no route that updates or deletes audit entries` (PATCH/DELETE `/api/audit/x` → 404).
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** History tab on the day screen (moves listed with Undo while both days are open); admin/manager audit screen with filters. Scroll-width check at 375 px.
- [ ] **Step 4: Commit** `feat: audit history for cases and managers`.

---

## Phase H: Seed, environment, deploy (CR6)

### Task 17: Seed counts, mock data, purge

**Files:**
- Create: `supabase/migrations/20261112_07_seed_tools.sql`, `supabase/seed_mock_data.sql`, `supabase/purge_seed_data.sql`, `supabase/tests/verify_v2.sql`, `test/sql/seed.test.ts`
- Delete: `supabase/seed.sql`
- Modify: `scripts/gen-sql.ts` (stop writing seed.sql; add `pin-hash <PIN>` mode that prints a PBKDF2 hash, used once to fill the seed PIN constant), `package.json` (`"db:pin": …`)

**Interfaces:**
- Produces SQL: `kpv_seed_counts() returns table(table_name text, seed_rows bigint, real_rows bigint)` covering every table with `is_seed`.
- Seed contents: exactly spec 7c (ids `B-TST1`, `B-TST2`, cases `T1-1…T1-4`, `T2-1`, SKUs `SEED-SNK-025`, `SEED-SNK-05`, `SEED-SNK-1`, `SEED-SNK-2`, `SEED-RNG-1`, `SEED-RNG-2`, group "Snake Necklace", rules lead 7 / avg 100). All dates from `kpv_today()`. The script first inserts a seed admin "Test Admin" (`is_seed`, PIN 1234) and then runs as that admin, `set local kpv.actor_id = '<seed admin uuid>'`, inside one transaction (the Task 5 master-data guard refuses SKU inserts by anyone but an admin), and aborts with `SEED_ALREADY_PRESENT` if `kpv_seed_counts()` shows seed rows. History is generated in a `do $$` loop day by day so each opening = previous day's count.
- Purge: exactly spec 7c steps 1–4; table order child-first as listed there.

- [ ] **Step 1: Failing SQL tests** (`freshDb({ withRoles: true, withBase: true })`): `seed loads and produces the scenario` (via `buildDayStatus`-equivalent SQL or by reading desk_days: T1-1 Done today; T1-2/T1-3 checked in today with 21 Done days before; T1-4 last Done = today−4; one closed day at today−10; `branch_velocity('B-TST1', today, 28)` returns a non-null velocity for `SEED-SNK-1`); `seed refuses to run twice`; `purge removes every seed row and no real row` (insert a real branch/desk/ledger/audit row first, record `real_rows`, purge, seed_rows all 0 and real_rows unchanged, one `seed.purge` audit entry); `purge is safe to run twice`; `a real admin's action on a seed case is purged too` (inheritance).
- [ ] **Step 2:** FAIL → write the three SQL files → PASS.
- [ ] **Step 3:** Write `supabase/tests/verify_v2.sql`: the same assertions as `do $$ … raise exception …` blocks for a real Supabase test project (run after seed; prints `VERIFY_V2 OK`).
- [ ] **Step 4: Commit** `feat(db): tagged mock data and a one-command purge`.

### Task 18: Data mode, meta endpoint, environment and docs

**Files:**
- Create: `src/routes/meta.ts`
- Modify: `src/types.ts` (`Env.KPV_DATA_MODE?: "test" | "production"`), `src/routes/auth.ts` (production mode refuses `is_seed` accounts: 403 `SEED_ACCOUNT_DISABLED`; the account list hides them), `src/index.ts` (mount `/api/meta` before `requireAuth`), `public/js/app.js` (banner strip), `public/js/i18n.js`, `.dev.vars.example`, `README.md`, `docs/GO-LIVE.md`, `test/api.test.ts`
- Memory: update `C:\Users\advice\.claude\projects\c--Users-advice-KPV-Sale-Stock-Management\memory\lao-manual-is-spec.md`: the v2 spec supersedes the manual on moves, the day flow and roles.

**Interfaces:**
- `GET /api/meta` → `{ dataMode: "test"|"production"|"demo", seedRows: number }` (`seedRows` only for an admin session; otherwise 0). Default mode: `production` when Supabase is set, `demo` otherwise.

- [ ] **Step 1: Failing API tests:** `production mode refuses a seed account login`; `test mode allows it and meta says test`; `admin meta reports seedRows > 0 when seed rows exist`.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3: Environment file.** `.dev.vars.example`: `SUPABASE_URL=https://tpekfhbjbosbeikawkys.supabase.co`, `SUPABASE_SERVICE_ROLE_KEY=`, `AUTH_SECRET=`, `KPV_DATA_MODE=test`, with the comment that no `VITE_*`/anon key is used and why (spec D3).
- [ ] **Step 4: `docs/GO-LIVE.md` rewrite** to this order: (1) Supabase test run: run the SQL files in the fresh-project order, `seed_mock_data.sql`, `supabase/tests/verify_v2.sql`; set `KPV_DATA_MODE=test`; walk through every CR on a phone. (2) Existing live project: **before deploy**, receive all `kind='move' and status='in_transit'` transfers; fix every open-day row reported negative by migration 01; then run migrations 01–07 + `users_roles.sql`. (3) Cloudflare: Workers & Pages → kpv-goldsmith-inventory → Settings → Variables and Secrets: `SUPABASE_URL` (text), `KPV_DATA_MODE` (text), `SUPABASE_SERVICE_ROLE_KEY` and `AUTH_SECRET` (secrets); optional Settings → Builds: build `npm ci && npm run build:css`, deploy `npx wrangler deploy`. (4) Production switch: run `purge_seed_data.sql`, set `KPV_DATA_MODE=production`, redeploy, confirm `/api/meta` `seedRows` = 0. Replace the "drop schema" wipe with the purge. Update the manual-changes table with spec §9.
- [ ] **Step 5: README:** stack line ("Cloudflare Worker, not Pages; no browser Supabase key"), roles, new SQL files and run order, `npm run test:sql`, the env mapping table from spec 7a.
- [ ] **Step 6: Commit** `feat: test/production data mode; docs for setup, deploy and purge`.

### Task 19: Final verification

- [ ] **Step 1:** `npm run typecheck` → no errors. `npm test` → all pass (49 existing + new). `npm run test:sql` → all pass.
- [ ] **Step 2:** `npm run dev` on demo data; at 360 and 375 px run the scroll-width check on: cards, day screen (normal and count mode), In/Out/move sheets, switcher, replenishment, audit, closed days → all `true`.
- [ ] **Step 3:** On a Supabase **test** project (not production): run the fresh-project order + seed + `verify_v2.sql` → `VERIFY_V2 OK`; point `.dev.vars` at it; confirm T1-4 is pinned overdue, a move T1-1→T1-2 changes both cases, the audit shows the actor; run `purge_seed_data.sql` → seed counts 0.
- [ ] **Step 4:** Use superpowers:requesting-code-review on the branch, then superpowers:finishing-a-development-branch.
