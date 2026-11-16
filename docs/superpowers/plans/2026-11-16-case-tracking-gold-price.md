# Case Tracking, History & Gold Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> On approval, copy this file to `docs/superpowers/plans/2026-11-16-case-tracking-gold-price.md` and commit it. Work on `main`; no branches/PRs.

**Goal:** Make cases easy to track for months: a frozen "Case info" (creator, created date, original stock), a readable day-by-day history per case and across cases, uniform compact case cards, no case ownership, and stock valued at today's gold **sell** price from `gold_prices`.

**Architecture:** One additive migration (`20261116_10_case_tracking.sql`) adds `gold_price_history` (filled by a trigger on the owner's `gold_prices` table) and freezes `desks.created_by` / `desks.initial_stock`. The pure functions in `src/` (`goldPrice.ts`, `caseHistory.ts`) do the valuation and the history and issue logic. Routes expose them. The vanilla-JS views in `public/js/views/` render them. The case-assignment UI and routes are retired, but the table stays.

**Tech Stack:** Cloudflare Worker (TypeScript, Hono-style routes in `src/routes/`), Supabase Postgres via REST + RPC, vanilla JS front end, Vitest 3 (`unit` + `sql` with PGlite).

**Spec:** the grilling decisions below (2026-11-16). They amend `docs/superpowers/specs/2026-11-12-khamphouvong-stock-v2-design.md` (case assignment reversed; gold price source changed).

## Decisions (the spec)
1. **Gold price.** Value = Baht weight × `gold_prices.price_baht_sell` (row id=1, written daily by a service_role job). It replaces `system_config.spot_lak_per_baht` everywhere (cards, day header, Report, Dashboard). If the row is missing or unreachable, fall back to `spot_lak_per_baht`. If `updated_at` is more than 1 Laos day old, show "price may be outdated".
2. **Past prices.** `gold_price_history` keeps one row per Laos date, upserted by a trigger on `gold_prices`. A past day is valued at the latest snapshot on or before that date. Days before the first snapshot use the earliest one. Cards use today's price.
3. **No ownership.** Remove "My cases", "Switch user", "Take this case", "No one assigned", release and hand-over. Any staff member of the branch works any case, and their name is stamped. The card shows `Last: <name> · HH:mm`. The `desk_assignment` table stays, unused.
4. **Header.** Row 1: `Daily Stock` + date chip + overdue/active badges. Row 2: the branch name as small grey text, which is a tappable chip only for an admin.
5. **Cards.** One compact row style for every case, overdue sorted first, shown with a red left bar plus a warning line (not a bigger card). Contents: name, status chip, `Baht · pcs`, `≈ LAK` in small grey, last stamp, one action button.
6. **Case info.** ⋯ menu → "Case info" sheet: created by, created date, original stock per SKU + total Baht/pcs, and the value at today's price. This is stored once on `desks` and is immutable.
7. **Case History tab.** A day-per-row table, newest first, 30 days + "Load more". Columns: Date, Open, In, Out, Close, Count, Diff (Baht), By. Flags: `count_diff`, `chain_break`, `missed`, `reopened`, shown red. Tapping a row shows that day's SKU breakdown + changes in readable form (names, not UUIDs).
8. **Report grid.** Cases × days for the selected month. Cell: ✓ clean Done, red Baht diff, ⚠ chain break or reopened, `·` not checked, blank for a closed day. Tapping a cell opens that case/day.
9. **Settings.** A one-line strip between the profile card and the menu: `Gold (sell) 43,230,000 LAK/Baht · updated 16/11 08:58`, amber when stale. The "Gold price" menu item is removed.
10. **Docs.** README, GO-LIVE §5 (Lao manual text to change), and an addendum to the v2 spec.

## Global Constraints
- Laos time (`Asia/Vientiane`, `kpv_today()` in SQL) defines "a day" everywhere.
- Migrations are additive and idempotent. After the migration, re-run `supabase/users_roles.sql` on live (it locks down the new table automatically).
- `gold_prices` is owned by the owner's job. The migration must use `create table if not exists` with the **live columns exactly**: `id int4 pk, price_baht_sell numeric, price_baht_buy numeric, price_gram_sell numeric, price_gram_buy numeric, updated_at timestamptz, price_updated_at text, fetched_at_utc7 text`. Never alter or rewrite its rows.
- Do not attach audit (`kpv_attach_audit`) to `gold_prices` or `gold_price_history`, since daily price updates would add noise.
- Money is in LAK and displayed with thousands separators. Baht shows 2 decimals in tables and the day header, 1 on cards (existing `fmtBaht`).
- All new UI strings go through i18n (en + lo) in the existing i18n file.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Empty or missing `gold_prices` row** (fresh DB, tests, outage): values fall back to `spot_lak_per_baht` with source `manual`, and nothing crashes. Test in Task 2.
2. **Case whose first day is today and is still open**: history shows one `open` row, not `missed`. A case with no days at all shows an empty state. Test in Task 4.
3. **Branch closed day between two checked days**: not flagged `missed`, and the chain check compares across the gap. Test in Task 4.
4. **Pre-migration cases with no `desk.create` audit entry**: backfill falls back to the first day's opening and leaves `created_by` null. Case info shows "—". Test in Task 1.
5. **A SKU added to a case after day 1** (opening 0 on the day it appears): not a chain break. Test in Task 4.

## File Map
- Create `supabase/migrations/20261116_10_case_tracking.sql`: tables, triggers, backfill.
- Create `src/goldPrice.ts`: price resolution + history lookup (pure).
- Create `src/caseHistory.ts`: day rows, flags, month grid (pure).
- Modify `src/types.ts`, `src/store.ts` (interface + memory + REST), `src/demoData.ts`, `src/logic.ts` (`valueLak`, `lastActor`, card value).
- Modify `src/routes/stock.ts` (cards, create, new info/history routes), `src/routes/insights.ts` (report grid, valuation), `src/routes/settings.ts`, `src/routes/auth.ts` (`/app-meta` gold), and remove `src/routes/cases.ts` from routing.
- Modify `public/js/views/stock.js`, `public/js/views/day/index.js`, `public/js/views/day/history.js`, `public/js/views/report.js`, `public/js/views/settings/index.js`, `public/js/views/login.js`, `public/js/api.js`, and the i18n file. Delete `public/js/views/cases-switcher.js` and `public/js/views/settings/gold-price.js`.
- Tests: `test/sql/case_tracking.test.ts`, `test/goldPrice.test.ts`, `test/caseHistory.test.ts`, plus updates to existing stock/route tests.

---

### Task 1: Migration — gold price history + frozen case origin

**Files:**
- Create: `supabase/migrations/20261116_10_case_tracking.sql`
- Test: `test/sql/case_tracking.test.ts` (use `freshDb({ withRoles: true, withBase: true })` from `test/sql/db.ts`)

**Interfaces:**
- Produces: table `gold_price_history(price_date date pk, price_baht_sell numeric not null, price_baht_buy numeric, captured_at timestamptz not null default now())`. Trigger `trg_gold_price_snapshot` (after insert or update on `gold_prices`) upserts `price_date = (new.updated_at at time zone 'Asia/Vientiane')::date`, falling back to `kpv_today()` when `updated_at` is null.
- Produces: `desks.created_by uuid null references staff_accounts(id)` and `desks.initial_stock jsonb null` with shape `{"skus": {"<sku_id>": <qty int>}, "total_pcs": int, "total_baht": numeric}`.
- Produces: trigger `trg_desk_origin_immutable` (before update on desks), which raises `INITIAL_IMMUTABLE` if `created_by` or `initial_stock` changes once it is non-null.

- [ ] **Step 1: Write failing SQL tests**
  - `snapshot_on_update`: insert into `gold_prices` (id 1, sell 43230000, updated_at '2026-11-16 02:00+00'), then update sell to 43300000 with the same date. Expect `gold_price_history` to have 1 row for 2026-11-16 with sell 43300000.
  - `snapshot_new_day`: update with updated_at on 2026-11-17. Expect 2 rows.
  - `origin_immutable`: set `initial_stock` on a desk, then try to change it. Expect an error matching `/INITIAL_IMMUTABLE/`. Setting it from null succeeds.
  - `backfill_from_audit`: a desk with a `desk.create` audit row (`actor_id` U, `detail.opening {"RG-031":3}`) gets `created_by = U` and `initial_stock.skus = {"RG-031":3}`, `total_pcs 3` after the migration's backfill block is re-run.
  - `backfill_from_first_day` (Review Focus 4): a desk without an audit row gets its skus from the earliest `desk_days` date's `daily_stock_ledger.opening_qty`, and `created_by` stays null.
- [ ] **Step 2: Run** `npx vitest run --project sql test/sql/case_tracking.test.ts`. Expected: FAIL (relation `gold_price_history` does not exist).
- [ ] **Step 3: Write the migration.** Order: `create table if not exists gold_prices` (live columns), `gold_price_history`, the snapshot function + trigger, a snapshot of the current `gold_prices` row (`insert … on conflict do nothing`), the `desks` columns, then the backfill. The backfill is a `do` block that updates only rows where `initial_stock is null`. `total_baht` = Σ qty × `master_sku.baht_weight`. Add the immutability trigger last, so the backfill isn't blocked.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `npm run test:sql`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(db): gold price history snapshots and frozen case origin`.

### Task 2: Gold price resolution + valuation switch

**Files:**
- Create: `src/goldPrice.ts`
- Modify: `src/types.ts`, `src/store.ts` (interface ~L196, memory impl, REST impl), `src/demoData.ts`, `src/logic.ts:89-98` and its callers (L566, report/dashboard builders), `src/routes/auth.ts:79-85`
- Test: `test/goldPrice.test.ts`

**Interfaces:**
- Produces types: `GoldPriceRow { price_baht_sell: number; price_baht_buy: number | null; updated_at: string | null; price_updated_at: string | null }` and `GoldPriceSnapshot { price_date: string; price_baht_sell: number }`.
- Produces store methods: `goldPrice(): Promise<GoldPriceRow | null>` (REST: `gold_prices?id=eq.1`, returns null on error or empty) and `goldPriceHistory(from: string, to: string): Promise<GoldPriceSnapshot[]>` (ascending; it also returns the latest row before `from`, so the first day resolves).
- Produces in `src/goldPrice.ts`:
  - `resolveGoldPrice(row: GoldPriceRow | null, config: Pick<SystemConfig,"spot_lak_per_baht">, today: string): ResolvedPrice` where `ResolvedPrice = { lakPerBaht: number; source: "gold_prices" | "manual"; asOf: string | null; stale: boolean }`. `stale` is true when the Laos date of `updated_at` is before `today` minus 1 day.
  - `priceOn(date: string, snapshots: GoldPriceSnapshot[], fallback: number): number`.
- Changes `valueLak(row, sku, lakPerBaht: number)`: the 3rd parameter is now a number instead of the config object. Every caller passes the resolved price.
- `/app-meta` adds `gold: ResolvedPrice` for the client.

- [ ] **Step 1: Failing tests:**
  - `resolveGoldPrice(null, {spot_lak_per_baht: 32500000}, "2026-11-16")` → `{lakPerBaht: 32500000, source: "manual", asOf: null, stale: false}`.
  - Row with sell 43230000 and updated_at `2026-11-16T02:00:04Z` → `source "gold_prices"`, `stale false`. The same row with today "2026-11-18" → `stale true`.
  - `priceOn("2026-11-10", [{price_date:"2026-11-12",price_baht_sell:1},{price_date:"2026-11-15",price_baht_sell:2}], 9)` → 1 (earliest). For "2026-11-14" → 1, for "2026-11-20" → 2, and for `[]` → 9.
  - `valueLak` with baht_weight 0.5, qty 2, price 43230000 → 43230000.
- [ ] **Step 2: Run** `npx vitest run test/goldPrice.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `goldPrice.ts`, the store methods (memory store: seed demo row sell 43230000 in `demoData.ts`) and the `valueLak` signature change. In Report/Dashboard builders, resolve the price once per request. Report months use `priceOn(lastDayOfRange, …)`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS (update existing Report/Dashboard expectations that relied on `spot_lak_per_baht` only where the demo gold row now applies).
- [ ] **Step 5: Commit** `feat: value stock at gold_prices sell price with daily history`.

### Task 3: Case origin on create + Case info sheet

**Files:**
- Modify: `src/store.ts` (`createDesk` input gains `created_by: string; initial_stock: InitialStock`, L146/L331/L1137), `src/types.ts` (`Desk` gains `created_by`, `initial_stock`), `src/routes/stock.ts:203-236`
- Modify: `public/js/views/day/index.js` (`openMenu` L548-571), `public/js/api.js`, i18n
- Test: the existing stock route test file (search `desk.create` in `test/`)

**Interfaces:**
- Produces: `InitialStock = { skus: Record<string, number>; total_pcs: number; total_baht: number }`.
- Produces: `GET /desks/:deskId/info` → `{ deskId, displayName, branchId, createdAt, createdBy: { id, name } | null, initial: InitialStock & { valueLak: number } }`. `valueLak` uses today's resolved price. Branch access goes through `assertBranchAccess`.
- Client: `api.deskInfo(deskId)`.

- [ ] **Step 1: Failing tests:** `POST /desks` with openings `{RG-031:3, NK-011:15}` stores `created_by` = caller and `initial_stock.total_pcs = 18`. `GET /desks/:id/info` returns `createdBy.name` and `initial.skus`. Staff from another branch get 403.
- [ ] **Step 2: Run** `npx vitest run <that test file>`. Expected: FAIL.
- [ ] **Step 3: Implement** the route and store changes. In the ⋯ menu, add "Case info" as the **first** item, and show the ⋯ button even on Done days (only Case info is enabled there). The sheet is plain: a two-column list with "Created by", "Created", "Original stock" (SKU · qty rows), and "Total" (`Baht · pcs · ≈ LAK`), using "—" for null.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: freeze case origin and add Case info sheet`.

### Task 4: Case history engine

**Files:**
- Create: `src/caseHistory.ts`
- Test: `test/caseHistory.test.ts`

**Interfaces:**
- Consumes: `LedgerRow`, `DeskDay`, `ClosedDay`, `MasterSku` (types.ts) and `priceOn` (Task 2).
- Produces:
  ```ts
  type DayFlag = "count_diff" | "chain_break" | "missed" | "reopened";
  interface CaseDayRow {
    date: string; state: "done" | "open" | "missed" | "closed";
    openBaht: number; inBaht: number; outBaht: number; closeBaht: number;
    countBaht: number | null; diffBaht: number | null; pcsClose: number;
    valueLak: number | null; by: string | null; flags: DayFlag[];
  }
  buildCaseHistory(input: {
    from: string; to: string; today: string;
    days: DeskDay[]; ledger: LedgerRow[]; closed: ClosedDay[];
    skus: Map<string, MasterSku>; staffNames: Map<string, string>;
    reopenedDates: Set<string>; snapshots: GoldPriceSnapshot[]; fallbackPrice: number;
  }): CaseDayRow[]   // newest first; only dates >= the case's first day
  buildIssueGrid(input: { month: string; desks: Desk[]; perDesk: Map<string, CaseDayRow[]> }):
    { dates: string[]; rows: { deskId: string; name: string; cells: (GridCell | null)[] }[] }
  type GridCell = { kind: "ok" | "diff" | "warn" | "unchecked"; diffBaht?: number };  // null = closed day
  ```
- Rules (pinned):
  - in = `stock_in + transfer_in + max(move,0)`.
  - out = `retail_sale + wholesale + transfer_out + destock + max(-move,0)` (verify the sign convention of `move` in `logic.ts` before coding, and adjust the test if it is stored differently).
  - Excluded rows are ignored.
  - diff = Σ(counted − closing) × baht_weight over rows with counted set; `count_diff` when |diff| ≥ 0.005.
  - `chain_break` when any SKU's opening ≠ its closing on the previous **recorded** day. A SKU absent on the previous day must have opening 0.
  - `missed` = a date between the first day and `to` with no desk_days row, not a closed day, and not `today`.
  - `by` = `done_by` name, else `checked_in_by` name.
  - A grid cell is `diff` if count_diff, else `warn` if chain_break/reopened, else `ok` for done, `unchecked` for missed/open, and null for closed.

- [ ] **Step 1: Failing tests:**
  - `clean_day`: done, counted = closing → flags [], diff 0.
  - `count_diff`: counted 2 vs closing 3 on a 0.5-Baht SKU → diffBaht −0.5.
  - `chain_break`: day 2 opening 4 vs day 1 closing 3.
  - `new_sku_not_break` (RF5).
  - `closed_gap_not_missed` (RF3): closing carries across a closed day with no break.
  - `missed_day` is flagged. `today_open_not_missed` (RF2): returns state `open` with no `missed`. A case with no days → [].
  - `reopened` comes from `reopenedDates`.
  - `value_uses_day_price` uses `priceOn`.
  - `grid_cells` maps each kind.
- [ ] **Step 2: Run** `npx vitest run test/caseHistory.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `src/caseHistory.ts` (pure, no I/O).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: case day-by-day history and issue grid engine`.

### Task 5: History + grid routes

**Files:**
- Modify: `src/routes/stock.ts` (new route), `src/routes/insights.ts` (new route), `public/js/api.js`
- Test: the existing route test files for stock/insights

**Interfaces:**
- Consumes: `buildCaseHistory`, `buildIssueGrid` (Task 4), `store.goldPriceHistory`, and `store.audit`/the audit query for reopen detection (audit rows with `table_name='desk_days'`, `op='UPDATE'`, `old_values->>status='done'`, `new_values->>status<>'done'`).
- Produces:
  - `GET /desks/:deskId/history?to=YYYY-MM-DD&days=30` → `{ rows: CaseDayRow[], nextTo: string | null }`. `days` is capped at 90. `nextTo` = the day before the window, or null when it reaches the first day.
  - `GET /report/grid?branch=&month=YYYY-MM` → the `buildIssueGrid` result.
  - Staff: their own branch only (`assertBranchAccess`), any date range. This is read-only, and is unlike `/audit`'s today-only staff limit, because spotting old issues is the point.
  - Client: `api.deskHistory(deskId, to, days)`, `api.reportGrid(branch, month)`.

- [ ] **Step 1: Failing tests:** history for a demo desk returns newest-first rows with `nextTo`. Another branch → 403. The grid returns one row per active desk of the branch and one column per day of the month.
- [ ] **Step 2: Run** the route tests. Expected: FAIL (404).
- [ ] **Step 3: Implement** the routes. The ledger/day/closed-day queries use the existing store filters, with one range read per request (not one per day).
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: case history and report grid endpoints`.

### Task 6: History tab + Report grid UI

**Files:**
- Modify: `public/js/views/day/history.js` (`renderHistory` L100-159, `auditSentence` L37-75), `public/js/views/report.js`, i18n

**Interfaces:**
- Consumes: `api.deskHistory`, `api.reportGrid` (Task 5).

- [ ] **Step 1: Rebuild the History tab** with this structure, top to bottom:
  - A day table (decision 7), with sticky header and right-aligned numbers. A flagged cell is red, and the row gets a small flag icon with a tooltip/label per flag. "Load more" calls with `nextTo`.
  - Tapping a row expands it in place: a SKU table (SKU, Open, In, Out, Close, Count) + that day's MOVES + CHANGES (the existing calls with `from=to=date`).
- [ ] **Step 2: Make CHANGES readable.** `auditSentence` maps actor/staff UUIDs to names via `state.meta` staff names (fallback "—"), and field names to i18n labels (`checked_in_by` → "Checked in by", `opening` → "Opening"…). The `—→` arrow form becomes `old → new`, and a bare `→ new` for inserts. No raw UUIDs are ever rendered.
- [ ] **Step 3: Report grid section** in `report.js`, under the existing month picker. A horizontally scrollable table with sticky first column (case name), and cells per decision 8. Tapping a cell navigates to the day view for that desk/date (reuse the existing route used by cards).
- [ ] **Step 4: Verify in the browser** (`npm run dev`, the `run` skill): open Desk 02 → History shows rows with no UUIDs. Report → the grid renders for Nov 2026 at 390px width without page-level horizontal scroll.
- [ ] **Step 5: Commit** `feat: readable case history table and report issue grid`.

### Task 7: Remove ownership, new header, compact cards

**Files:**
- Modify: `public/js/views/stock.js` (`renderTopbar` L47-96, `renderCard` L270-322, `renderGrid` L324-374, `canTake` L253-257, `TIER_STYLE` L228-233), `public/js/views/login.js:28-37` (remove `switchUser` and its export), `src/routes/stock.ts:119-186` (drop holder fields; add `valueLak`, `lastActorAt`), `src/logic.ts:143` (`lastActor` → `{ name, at } | null`), the router file that mounts `src/routes/cases.ts`
- Delete: `public/js/views/cases-switcher.js`, `src/routes/cases.ts` and its tests
- Test: the existing stock-cards route test

**Interfaces:**
- Produces: card JSON drops `holder`/`canTake` and adds `lastActorName`, `lastActorAt: string | null` (ISO, from the same row that gave the name: ledger `updated_at` / `done_at` / day `created_at`) and `valueLak: number` (totalBaht × today's resolved price).
- Store `assignDesk`/`releaseDesk`/`activeAssignments` stay in the interface (the table stays) but have no callers. Add a comment saying so.

- [ ] **Step 1: Failing test:** `GET /stock/desks` cards contain `valueLak` and `lastActorAt` and have no `holder` key. `POST /cases/assign` → 404.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement the server side**, then the UI:
  - Header per decision 4. The `stock.js` summary line ("4 cases · 0 checked today · 2 overdue") stays.
  - A single `#desk-list` (`flex-col gap-2`) replaces `#overdue-strip` + `#desk-grid`.
  - Every card uses one `renderCard` layout (decision 5). Overdue only adds a red left border + the `tierText` line.
  - Remove the avatar initials bubble and the "Take this case" / "No one assigned" lines.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Then check in the browser at 390px: 4 cards with identical height structure, no My cases/Switch user, and the date chip on the title row. As admin, the branch chip switches branches.
- [ ] **Step 5: Commit** `feat: drop case ownership, compact uniform case cards, one-line header`.

### Task 8: Settings gold price strip

**Files:**
- Modify: `public/js/views/settings/index.js` (`MENU` L12-19, `renderMenu` L98-132), `src/routes/settings.ts:305-309` (stop accepting `spotLakPerBaht` from the UI; keep the column as the silent fallback), i18n
- Delete: `public/js/views/settings/gold-price.js`

- [ ] **Step 1:** Render the strip between `profileCard()` and the menu card from `state.meta.gold`. The format is `Gold (sell) 43,230,000 LAK/Baht · updated 16/11 08:58` (the time is the Laos-local form of `asOf`). When `stale`, show amber with "price may be outdated". When `source === "manual"`, show "Gold price feed unavailable — using last manual price".
- [ ] **Step 2:** Remove the Gold price menu entry and its sub-page. Make the settings test's expectation of the `spotLakPerBaht` field 400/ignored, matching the chosen behavior.
- [ ] **Step 3: Run** `npm test`, then view in the browser: Settings shows the strip, and the Dashboard "1 Baht = X LAK" shows the same number.
- [ ] **Step 4: Commit** `feat: read-only gold price strip in Settings`.

### Task 9: Docs + live rollout notes

**Files:**
- Modify: `README.md`, `docs/GO-LIVE.md` (§5 manual text list + a rollout step), `docs/superpowers/specs/2026-11-12-khamphouvong-stock-v2-design.md` (append "Addendum 2026-11-16")

- [ ] **Step 1:** The addendum lists decisions 1-10, stating that case assignment (v2 CR) is reversed and the gold price source has changed.
- [ ] **Step 2:** GO-LIVE adds these rollout steps:
  1. Run migration 10 in the Supabase SQL editor.
  2. Re-run `users_roles.sql`.
  3. Confirm the `gold_price_history` row for today exists.
  4. After the next daily fetch, confirm `gold_prices.updated_at` advanced and a new history row appeared (the fetcher uses service_role, so RLS does not block it).
  5. Deploy the Worker to the owner's Cloudflare account.
- [ ] **Step 3:** In §5, list the manual sections to update (Daily Stock header/cards, case ownership removed, Case info, History tab, Report grid, Settings gold price).
- [ ] **Step 4: Commit** `docs: case tracking, history and gold price addendum`.

---

## Verification (end to end)
1. `npm test && npm run test:sql && npm run typecheck`: all green.
2. `npm run dev` and log in as staff (branch Morning Market):
   - The header is one line, with no My cases/Switch user.
   - All cards are the same compact style, each with `≈ LAK`.
   - Desk 02 → ⋯ → Case info shows the creator, date and original stock.
   - The History tab shows the day table, and an injected count diff renders red.
   - Report → the grid shows that day red, and tapping it opens the day.
   - Settings shows the gold strip with 43,230,000.
3. Log in as admin: the branch chip switches branches and the cards reload.
4. On live, after the rollout steps in GO-LIVE: the next day a second `gold_price_history` row exists.
