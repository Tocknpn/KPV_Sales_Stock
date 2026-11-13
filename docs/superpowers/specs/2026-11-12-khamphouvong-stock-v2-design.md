# Khamphouvong Gold Stock v2: design

Date: 2026-11-12 · Status: draft for approval · Scope: 6 change requests (CR1–CR6)

The owner asked for this to be written in autonomous mode: no clarifying round.
Every question below was raised and answered here. Each answer is marked
**[Owner]** when it comes straight from the request, or **[Call]** when it is a
design call made in this document that the owner can overturn.

---

## 0. Ground truth: what exists today

The request assumes "React/Vite + Tailwind + Supabase + Cloudflare Pages". The
repository is different, and that matters for every CR:

| Area | Today (commit `0122a5c`) |
|---|---|
| Hosting | **One Cloudflare Worker** (`wrangler.jsonc`) serves the SPA from `/public` (Workers Static Assets) and the JSON API at `/api/*` (Hono). Same origin, no CORS. |
| Frontend | Vanilla ES modules + Tailwind 3 (`public/js/**`), bilingual Lao/English (`public/js/i18n.js`). |
| Database access | **Only the Worker** talks to Supabase, using the service-role key over PostgREST (`src/store.ts` `SupabaseStore`). RLS is enabled on every table with **no policies**, so the public anon key reaches nothing. |
| Auth | Own login: branch → name → 4-digit PIN, PBKDF2 hashes, HMAC session tokens (`src/auth.ts`). Two roles: `staff` (one branch) and `admin` (all branches). Not Supabase Auth. |
| Rules | All business rules in `src/logic.ts` + `src/routes/*`. DB adds integrity: generated `closing_qty`, Done-day lock trigger, `ledger_add` atomic increment, document counter. |
| Day lifecycle | `desk_days.status`: `check_in → final_stock → done`, forward only; admin reopens latest Done day with a reason. Opening = previous Done day's count. |
| Ledger row | `opening, stock_in, transfer_in, retail_sale, wholesale, transfer_out, destock(+note), move, closing (generated), counted(+note)`. |
| Transfers | `transfers` table, kinds `transfer` (other branch) and `move` (same branch). **Both** are *in transit* until the receiver confirms. Written with compensating updates, **not one DB transaction**. |
| Day screen | `public/js/views/stock.js:396`: an 11–14 column grid (`152px + 10×40px…`) inside `overflow-x-auto`. **It scrolls sideways on a phone.** |
| Replenishment | `master_sku.avg_daily_sales`, `order_lead_time_days` (manual, per SKU, company-wide). Reorder point per **desk** = avg × (lead + safety buffer). `estLifetimeDays` exists but is per-row. |
| Audit | `audit_log` written by the Worker for a handful of admin actions only. Not immutable. |
| Seed | `supabase/seed.sql` **truncates every app table** then loads demo data. Dangerous on a live project. |
| Tests | Vitest: `test/logic.test.ts`, `test/api.test.ts` (49 tests) run the real Hono app against the in-memory `DemoStore`. |
| Spec authority | The Lao manual `ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html` is the spec (decided 2026-11-12). **This v2 document supersedes the manual where they differ**; §9 lists manual updates. |

"Case" (ຕູ້) in the requests = `desks` in the code. This document says *case* for people and `desk` for code.

---

## 1. Platform decisions (affect all CRs)

### D1. Keep the Worker + Hono + vanilla-JS stack. Do not rewrite to React/Vite. **[Call]**
- *Why:* the app is working, tested and in its production-database phase. A rewrite would cost weeks, throw away 49 passing rule tests, and deliver none of the six CRs sooner. Every CR is achievable in the current stack.
- *Anti-goal avoided:* "it technically works but it's a different app with new bugs in the gold ledger."
- Tailwind stays. New UI is written as new view modules alongside the existing ones.

### D2. Cloudflare **Workers** (Static Assets), not Cloudflare Pages. **[Call]**
- The current deploy (`wrangler deploy`) already serves static files + API from one Worker. Cloudflare now steers new full-stack projects to Workers; Pages would need Pages Functions to host the API, which is a migration with no gain.
- What the owner asked for in CR6 (a deploy workflow, env vars set in the Cloudflare dashboard, Git-connected builds) all exists for Workers: *Workers & Pages → kpv-goldsmith-inventory → Settings → Variables and Secrets*, and *Settings → Builds* to connect the GitHub repo.

### D3. The browser never receives any Supabase key. No `VITE_SUPABASE_ANON_KEY`. **[Call]**
- *Why:* this is a gold vault ledger. With the anon key in the browser, every rule (negative stock, Done lock, branch isolation, roles) must be re-implemented as RLS policies and any bug is directly exploitable from a phone's dev tools. Today the browser can only call the Worker's API, which checks the session on every request. That is strictly stronger than anon key + RLS.
- CR6's intent ("roles enforced in the database, cannot be bypassed from the frontend") is met by D4 + D5, not by RLS policies for browser clients.
- `users_roles.sql` still ships (CR6b) and still uses RLS, but its RLS is **explicit deny** for `anon`/`authenticated`, and the role rules are DB triggers keyed on the acting staff member (D4).

### D4. Every DB write carries the acting staff member: PostgREST request headers. **[Call]**
- The Worker adds `X-KPV-Actor-Id: <staff uuid>` to every PostgREST call made on behalf of a logged-in user, and `X-KPV-Actor-System: <tag>` (e.g. `login`, `cron`) for writes with no user.
- PostgREST exposes request headers to SQL as `current_setting('request.headers', true)::json`. A SQL helper `kpv_actor_id()` reads the header, falling back to the session GUC `kpv.actor_id` (used by SQL scripts and RPCs), then to `current_user` for people working in the SQL editor.
- Display names are **not** sent in headers (Lao text is not valid in HTTP headers); triggers look the name up in `staff_accounts`.
- **Enforcement:** if the JWT role is `service_role` and neither header is present, audited writes raise `AUDIT_ACTOR_MISSING`. A Worker bug cannot write anonymously.
- Store change: `getStore(env)` → `getStore(env, actor?)`; routes use a new helper `storeFor(c)` that binds the session user. `DemoStore` takes the same actor and writes the same audit rows (see CR4).

### D5. Defense in depth: friendly checks in the Worker, hard guarantees in Postgres.
This is the existing pattern (`ledger_guard_done`), extended. The Worker returns clear errors with codes; the database refuses the same thing even if the Worker has a bug or two tablets race. New hard guarantees:
1. No write may make `daily_stock_ledger.closing_qty` negative: trigger `ledger_guard_negative` refuses an INSERT with closing < 0, and an UPDATE whose new closing is < 0 **and** lower than the old closing (`NEGATIVE_CLOSING`). A trigger rather than a CHECK, so a row that is already negative from before v2 can still be corrected or counted, just never pushed further down.
2. Same-branch move is one transaction with row locks (CR1).
3. Audit rows are written by triggers and can never be updated or deleted (CR4).
4. Role-sensitive changes (reopen a Done day, change roles, change master data) check the actor's role in a trigger (CR6b).
5. No desk day may be created for a date after Laos today.

### D6. Time zone: Laos business date everywhere.
- Laos is UTC+7 with no daylight saving. The Worker already uses a fixed +7 offset (`src/time.ts`). SQL gets `kpv_today()` = `(now() at time zone 'Asia/Vientiane')::date`.
- The client never decides "today": every screen uses `today` returned by the API. A phone with a wrong clock cannot shift a day.
- Day boundary is Laos midnight. A day left unfinished after midnight is finished the next morning (existing rule: staff may keep working on an earlier *open* day).

### D7. SQL migrations are additive files, run in order. **[Call]**
- `supabase/schema.sql` stays as the v1 baseline (untouched).
- New: `supabase/migrations/20261112_01_*.sql … _07_*.sql`, then `supabase/users_roles.sql`, each idempotent (`if not exists`, `create or replace`, guarded `do` blocks), so they run safely on the live project **and** on a fresh one.
- Fresh project order: `schema.sql` → `migrations/*` (filename order) → `users_roles.sql` → `base.sql` → optionally `seed_mock_data.sql`.

### D8. Real Postgres in tests: PGlite. **[Call]**
- Triggers, RPCs, constraints and the seed/purge scripts are DB code; the DemoStore cannot prove them. Add dev dependency `@electric-sql/pglite` (in-process WASM Postgres with plpgsql) and a `test/sql/` suite that loads the real SQL files.
- PGlite is one connection, so true parallel races cannot be shown there; races are covered by design (row locks, CAS) and by DemoStore tests that fire overlapping requests with `Promise.all`.
- Fallback if PGlite cannot load a file: `supabase/tests/verify_v2.sql`, a self-checking script (raises on failure) run in the Supabase SQL editor of a test project.

---

## 2. CR1: Intra-day case-to-case transfer (Case A → Case B)

### Intent
Staff move pieces between display cases in the same branch during opening hours. Balances on both cases must change together, immediately, and each movement is traceable to both cases.

### Questions raised and answers
| # | Question (perspective) | Answer |
|---|---|---|
| 1.1 | Today a same-branch Move sits *in transit* until Case B confirms. Keep that? (Vault) | **No [Owner].** Same-branch move becomes **instant and atomic**: −qty on A, +qty on B in one transaction. Cross-branch *Transfer* keeps the in-transit + receive flow (gold physically leaves the building). |
| 1.2 | Race: two staff move the last 2 pieces of the same SKU out of Case A at once. (Architect) | RPC `move_stock` locks the source ledger row `FOR UPDATE`, re-reads its closing, refuses if `qty > closing` (`NOT_ENOUGH_STOCK`, returns `available`). The `ledger_guard_negative` trigger is the final backstop. |
| 1.3 | Deadlock: A→B and B→A at the same moment. (Architect) | The RPC locks the two `desk_days` rows, then ledger rows, always in `desk_id` order. |
| 1.4 | Double tap / network retry creates two moves. (Architect) | Client generates a `client_ref` UUID per move; `transfers.client_ref` is UNIQUE; a repeat call returns the existing move, no second effect. |
| 1.5 | Partial transfer. (Vault) | Any qty 1…available. Multiple SKUs/sizes can move in **one ticket** (`lines[]`), all-or-nothing: if one line lacks stock, nothing moves and the reply lists which line. |
| 1.6 | Mistake (wrong case, wrong qty). (Vault/Audit) | **No edit, no delete.** Undo creates a *reverse move* linked by `reverses_id`, allowed while both days are open. A 6-second Undo toast after every move; later, Undo is on the move in the case's movement list. |
| 1.7 | Case B has not checked in today. (Ops) | The Worker first runs B's normal check-in (idempotent, carries yesterday's count forward), then calls `move_stock`. If B *cannot* check in (earlier day unfinished), the move is refused with `DEST_NOT_OPEN` and the date to finish. |
| 1.8 | Case B already ✓ Done today. (Ops) | Refused `DEST_DAY_LOCKED`: "Case B is closed for today; ask a manager to reopen or move tomorrow." Same for A. |
| 1.9 | Who may move? Must the mover be assigned to Case A? (Ops/Sales) | Any active staff of that branch, manager or admin. Not restricted to the assignee: blocking a busy shop is worse than the risk, and every move is audited with the actor. |
| 1.10 | Past dates. (Analyst) | Staff: today only (or an earlier day still open on **both** cases). Admin: any open pair of days. |
| 1.11 | Ledger columns? (Analyst) | Unchanged meaning: A's row `move += qty`; B's row `transfer_in += qty`. One `transfers` row: `kind='move'`, `status='received'`, `received_date = sent_date`, `received_by = sent_by`. Reports keep working. |
| 1.12 | Existing in-transit moves at cutover? (Ops) | Go-live checklist: list them (`select … where kind='move' and status='in_transit'`) and receive them **before** deploying. The old receive path stays for any stragglers and for cross-branch transfers. |
| 1.13 | Velocity: is a move a sale? (Analyst) | Never. Only `retail_sale + wholesale` count as sales (CR2). |

### Mobile flow (target: 2 taps for 1 piece)
1. On the SKU row in the day screen, tap **⇄**. A bottom sheet opens: qty stepper preset to **1** (max = available, shown "of 5"), then one large button per other open case in the branch ("→ Case B · Noy"), most recently used first.
2. Tap the destination button. **That commits** the move. Toast: "Moved 1 × Snake 1 Baht → Case B · Undo".
   - To move more than one, adjust the stepper before step 2. To move several sizes, "+ Add another item" in the sheet builds a multi-line ticket; then a single "Move 4 items → Case B" button.
   - A second tab in the sheet, "Other branch", is the existing cross-branch transfer (in transit).

### Data and API
- `transfers` gains: `client_ref uuid unique`, `reverses_id uuid references transfers(id)`, `note text`, `ticket_id uuid` (groups lines of one ticket), `is_seed`.
- RPC `move_stock(p_date date, p_from text, p_to text, p_lines jsonb /*[{sku_id, qty}]*/, p_client_ref uuid, p_note text) returns jsonb` (security invoker, executable by `service_role` only).
- `POST /api/moves` `{date, fromDeskId, toDeskId, lines:[{skuId, qty}], clientRef, note?}` → `{ticketId, moves:[…]}`; codes: `NOT_ENOUGH_STOCK{skuId,available}`, `DEST_NOT_OPEN{openDate}`, `DEST_DAY_LOCKED`, `DAY_LOCKED`, `OTHER_BRANCH`, `SAME_DESK`.
- `POST /api/moves/:ticketId/undo` `{clientRef}` → reverse ticket.
- `POST /api/transfers` keeps serving cross-branch only; a same-branch destination there now returns `USE_MOVE` (400).

---

## 3. CR2: SKU avg daily sell, lead time and branch-wide runway

### Intent
Replenishment settings per SKU, or in bulk by product type or product group (e.g. all Snake Necklace sizes: lead 7 days, 100 pcs/day). Runway is computed on the **branch's** total stock across all its cases. Alerts: Critical when runway ≤ lead time; Warning when runway ≤ lead time + 3 days.

### Questions raised and answers
| # | Question | Answer |
|---|---|---|
| 2.1 | What is a "group"? Types today are broad (Necklaces); "Snake Necklace" is a product family across weights. (Data) | New column `master_sku.group_name text` (nullable), editable in Settings → SKU and the CSV import (`group` column). Bulk apply works by **type** or **group**. |
| 2.2 | Company-wide or per-branch numbers? A big market branch sells more than a mall kiosk. (Sales/Analyst) | Both. Rules can be company-wide (`branch_id null`) or for one branch. |
| 2.3 | Precedence between SKU, group, type, branch, auto? (Analyst) | Each of the two values (avg/day, lead time) resolves **independently**, first hit wins: **SKU+branch → SKU → group+branch → group → type+branch → type**. If no avg/day rule exists → **auto velocity** (2.5). If no lead time → `system_config.default_lead_time_days` (new, default 7). |
| 2.4 | Manual vs auto: which wins? (Sales vs Analyst) | **Manual wins when set [Call]**: the manual number is the planning target the owner sets. The screen always shows both, and flags **"Review"** when auto (with ≥14 in-stock days) differs from manual by more than ±50%. Clearing a manual value returns that SKU to auto. |
| 2.5 | Zero-stock days distort averages. (Analyst) | Auto velocity per branch per SKU = **sold ÷ in-stock days**, where: window = last `velocity_window_days` (default 28) **Done** days before today; a branch-date counts if ≥1 case of the branch is Done that date and the date is not a closed day (CR3); it is *in stock* if Σ(opening + stock_in + transfer_in) > 0 across those Done cases; sold = Σ(retail_sale + wholesale). Days with no record are unknown, not zero, so they are excluded. Moves and destock are not sales. |
| 2.6 | Too little data? (Analyst) | < 7 in-stock days → auto velocity is **null** ("Not enough data") and runway falls back as in 2.9. |
| 2.7 | Why not sum per-case rates? (Analyst) | Pieces move between cases (CR1); per-case rates double-count when a SKU alternates cases. Branch-day totals avoid that. |
| 2.8 | What counts as branch stock? (Vault/Ops) | **Position = on-hand + inbound in transit.** On-hand = Σ over the branch's active cases of each case's latest day (Done → count, open → running closing). Inbound = cross-branch transfers in transit *to* this branch (so nobody re-orders gold already on a truck). Both are shown separately. |
| 2.9 | No avg/day at all (new SKU)? (Ops) | Status **No data** (grey). If the legacy `reorder_level` > 0 and on-hand < it → **Warning (fixed level)**. |
| 2.10 | Exact alert rules? | `runway = position ÷ avg`. **Critical:** avg > 0 and runway ≤ lead. **Warning:** lead < runway ≤ lead + `warning_margin_days` (new config, default **3 [Owner]**). **OK** otherwise. Position = 0 with avg > 0 is Critical "Out of stock". |
| 2.11 | Old per-desk reorder point and `safety_buffer_days`? | Retired from alerts (per-desk thresholds with a branch velocity are wrong). The column stays in the schema, unused. Desk cards show "n critical" = SKUs on that case whose **branch** status is Critical. |
| 2.12 | Existing per-SKU manual values? | Migration copies non-null `master_sku.avg_daily_sales / order_lead_time_days` into SKU-scope company-wide rules. The old columns stay, no longer read. |
| 2.13 | Suggested order qty? (Sales) | `max(0, ceil(avg × (lead + margin)) − position)`, labelled "to clear the warning". Shown, not auto-ordered. |
| 2.14 | Bulk apply would wipe careful SKU overrides. (Ops) | Bulk apply writes **one group/type rule**, not values on each SKU. A checkbox "also clear N SKU overrides" (off by default) deletes the narrower rules. The sheet previews "affects 6 SKUs, 2 have their own numbers". |
| 2.15 | Who edits? | Admin: any rule. Branch manager: rules for **their branch** only. Staff: read only. |
| 2.16 | Performance: PostgREST returns at most 1000 rows. (Architect) | Velocity is computed in SQL by RPC `branch_velocity(p_branch, p_to, p_days)` returning one row per SKU. Never pull 28 days of ledger rows to the Worker. |

### Data and API
- `master_sku.group_name text`, index.
- `replenishment_rule(id uuid pk, scope text check in ('sku','group','type'), scope_key text, branch_id text null references branches, avg_daily_sell numeric(10,3) null check ≥0, lead_time_days numeric(5,1) null check ≥0, updated_by uuid, updated_at timestamptz, is_seed bool)`, unique on `(scope, scope_key, coalesce(branch_id,'*'))`.
- `system_config` gains `default_lead_time_days numeric(5,1) default 7`, `warning_margin_days numeric(5,1) default 3`, `velocity_window_days int default 28`.
- Pure functions in `src/logic.ts`: `resolveParams(sku, branchId, rules, config)`, `runwayStatus(position, avg, lead, margin, reorderLevel)`.
- `GET /api/replenishment?branchId=` → rows `{sku_id, name, group, onHand, inbound, position, avg:{value, source}, autoAvg:{value, inStockDays}, lead:{value, source}, runwayDays, status, suggestedQty, review}`. Sorted Critical → Warning → OK → No data, then by runway.
- `PUT /api/replenishment/rules` (one rule; null values = inherit); `POST /api/replenishment/rules/bulk` `{scope, key, branchId|null, avgDailySell?, leadTimeDays?, clearOverrides, dryRun}`.
- UI: Settings → Lead time becomes **Replenishment**: grouped by group (fallback: type), each group header has "Set for all sizes"; each SKU row shows effective values with a small source tag ("group", "auto", "SKU"). Dashboard gets a **Reorder** panel per branch (Critical/Warning counts, tap → list). The day screen shows a runway chip on rows that are Critical/Warning.

---

## 4. CR3: Card of the day: streak and latest check status

### Intent
Each case card shows its check streak and its latest check date and status, so branch staff and top management see at a glance whether every case in a shop was checked on the same working day. A case that has been missed stands out.

### Definitions [Call]
- **Required date** for a case: on or after the case's creation date, case active, and not a **closed day** for its branch.
- **Checked** on a date = that date's desk day is ✓ Done (completing it late still counts; history shows "closed late").
- **Streak** = consecutive required dates, all checked, ending at the *anchor*. Anchor = today if today is checked, otherwise yesterday. Closed days are skipped: they neither break nor extend the streak. Today still in progress therefore never breaks a streak.
- **Days behind** = number of required dates *d* with `lastDone < d < today`.
- **Tier:**
  | Tier | Rule | Look |
  |---|---|---|
  | `done_today` | today checked | green left bar, "✓ Checked 17:42 · Noy" |
  | `on_track` | not yet today, days behind = 0 | neutral; sub-status "Open since 08:10" or "Not opened yet" |
  | `behind_1` | days behind = 1 | amber bar + tint, "1 day behind · last 10 Nov" |
  | `overdue` | days behind ≥ 2 | red bar + tint, **pinned** to the top in a full-width strip, "Not checked 3 days · last 8 Nov" |
  Text always states the tier; colour is never the only signal.

### Questions raised and answers
| # | Question | Answer |
|---|---|---|
| 3.1 | Holidays and closed days? (Ops) | New table `branch_closed_day(branch_id, closed_date, reason, created_by, is_seed)`. Manager/admin add them; "All branches" creates one row per branch. Weekly off-days are not modelled (shops open daily); add them as closed days if needed. |
| 3.2 | A brand-new case? | Streak starts at 0; no "behind" before its creation date. |
| 3.3 | An unfinished earlier day (checked in, never Done)? | It is not checked; days behind counts it. The card's action becomes "Finish 10 Nov". |
| 3.4 | "Same working day" across a shop? (Management) | Branch header: "4 cases · 3 checked today · 1 overdue". Admin "All branches" view lists branches with the same counts and the worst tier, overdue branches first. |
| 3.5 | Should "not opened by 10:00" be flagged? | Not in v2 (no reliable opening hours per branch). `on_track` shows "Not opened yet" plainly. Listed as a future idea. |
| 3.6 | Cost: streak needs history. (Architect) | One query per branch: desk days of the last 400 days (4 cases × 400 ≈ 1.6k rows → paged), plus closed days. Pure function `buildDayStatus(desk, days, closedDays, today)` in `logic.ts`. A streak longer than 365 shows "365+". |
| 3.7 | Timezone? | `today` from the server (D6). |

### API
`GET /api/stock/desks` cards gain `{streak, lastDoneDate, lastDoneAt, lastDoneBy, daysBehind, tier, assignee}` and the response gains `branchSummary {cases, checkedToday, behind1, overdue}`. Sort: overdue first, then `sort_order`.

---

## 5. CR4: Immutable audit log and multi-case staff assignment

### 5a. Audit log

| # | Question | Answer |
|---|---|---|
| 4.1 | What is logged? | Every INSERT/UPDATE/DELETE on: `desks, staff_accounts, master_sku, sku_type, sku_weight, desk_days, daily_stock_ledger, transfers, documents, document_rows, system_config, replenishment_rule, desk_assignment, branch_closed_day`. Not `doc_counters` (counter noise) or `audit_log` itself. |
| 4.2 | How, so the frontend cannot skip it? | One generic `AFTER` row trigger `audit_row_change()` on each table. It records only **changed** columns (`old_values`, `new_values` jsonb), skips no-op updates, and ignores bookkeeping columns (`updated_at`, `performed_by`). `pin_hash` is redacted to `"changed"`. `staff_accounts.failed_attempts` alone is not logged (one row per wrong PIN would be noise); `locked_until` is. |
| 4.3 | Who? | `actor_id` from `kpv_actor_id()` (D4), `actor_name` and `actor_role` looked up at write time (a later rename does not rewrite history), `source` = `api` / `system:<tag>` / `sql:<db user>`. |
| 4.4 | Which case? | Columns `desk_id`, `branch_id` filled from the row when it has them (ledger, desk days, transfers: both ends, with `desk_id` = source). Filter by case is an index scan. |
| 4.5 | Immutable how? | `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger on `audit_log` raise `AUDIT_IMMUTABLE`. The only exception: deleting rows with `is_seed = true` while `kpv.purging = 'on'` (the seed purge, CR6c). `anon`/`authenticated` have no grants. Residual risk, stated plainly: the database owner can disable triggers; that is a Supabase owner-account control, outside the app. |
| 4.6 | Business-level events (reason for reopen, bulk apply) are not row diffs. | The Worker keeps writing semantic entries (`action`, `target`, `detail`) into the same table; these are insert-only too. The existing columns stay. |
| 4.7 | Volume. (Architect) | Estimate: ~5 branches × 4 cases × 30 SKUs × ~3 changes/day ≈ 2k rows/day, ≈ 250 MB/year. Fine for v2; the go-live doc says to watch DB size on the free plan (500 MB) and move to Pro or archive by export. No deletes. |
| 4.8 | Who reads it? | Admin: everything. Manager: own branch. Staff: their own case's entries for today (the "History" tab on the day screen). `GET /api/audit?deskId&branchId&from&to&actorId&cursor`, newest first, 50 per page. |
| 4.9 | Old → new readable on a phone? | Each entry renders as a one-line sentence: "Noy · 14:05 · Case B · Snake 1 Baht · Retail 3 → 4". Field names come from i18n. |

### 5b. Multi-case staff assignment

| # | Question | Answer |
|---|---|---|
| 4.10 | Model? | `desk_assignment(id, desk_id, staff_id, started_at, started_by, ended_at null, ended_by, note, is_seed)`. **At most one active row per case** (partial unique index `where ended_at is null`). One staff member may hold any number of cases. |
| 4.11 | Handover atomicity? | RPC `assign_desk(p_desk, p_staff, p_note)` locks the desk, ends the current active row (`ended_by` = actor), inserts the new one, in one transaction. `release_desk(p_desk)` ends without a successor. Full history stays (never updated except `ended_*`). |
| 4.12 | Who may assign? | Staff: take a case for themselves, or hand a case they hold to another active staff member of the same branch. Manager/admin: anyone in their scope. Cross-branch assignment is refused (trigger and Worker). |
| 4.13 | Must the receiver accept? (Vault) | No [Call]: an acceptance step would stall a busy counter. The receiver sees "You were given Case B by Noy" on their next load; everything is audited. A formal handover count is out of scope (§10). |
| 4.14 | Yesterday's assignment still active this morning? | Not auto-ended (no cron needed). If an active assignment started before today, the card shows it muted, "Last: Noy (yesterday)", with **Take this case**. |
| 4.15 | Deactivated staff? | A trigger on `staff_accounts` ends their active assignments when `active` becomes false. |
| 4.16 | Shared tablet: the logged-in user ≠ person at the case. | Actions are always attributed to the logged-in session. A **Switch user** button (top bar) opens the PIN login with the branch preselected, so a shared tablet changes hands in ~3 seconds. The assignment shows *responsibility*; the audit shows *who pressed*. |
| 4.17 | Switcher UX | Top-bar chip **"My cases · 2"** opens a sheet listing the branch's cases with the current holder and a toggle: tap an unheld case to take it; tap one held by someone else → confirm "Take over from Noy?"; tap your own → release or "Hand to…" (staff list). Each card shows the holder: "👤 Noy · since 13:05". |

---

## 6. CR5: Single-screen daily stock movement check (no sideways scroll)

### Intent
Replace the multi-column grid and the separate Final Stock step with one screen per case and day: **Opening | In | Out | Transfer | Closing (auto)**, plus the physical count at close. It fits a 375 px phone with vertical scrolling only, and handles many weight sizes per product.

### Layout at 375 px (343 px content inside 16 px gutters)
```
┌───────────────────────────────────────────┐
│ Case B · 12 Nov · Open      👤 Noy  ⋯     │ sticky top bar
│ 128 pcs · 41.25 Baht   ■ 2 critical       │ sticky totals
├───────────────────────────────────────────┤
│ ▾ Snake Necklace · 6 sizes · 42 pcs       │ group header (collapsible)
│ ┌───────────────────────────────────────┐ │
│ │ 1 Baht  ·96.5%          Closing  12   │ │ row 1: size + closing (large)
│ │ Open 10 │ In +3 │ Out −2 │ ⇄ +1       │ │ row 2: 4 equal cells, each a tap target
│ │ Count [ 12 ]  ✓ matches               │ │ row 3: only in count mode
│ └───────────────────────────────────────┘ │
│ …                                         │
├───────────────────────────────────────────┤
│ [ Start count ]        [ ✓ Close day ]    │ sticky footer
└───────────────────────────────────────────┘
```
- Row 2 is `grid grid-cols-4`, each cell `min-w-0`, ≥ 44 px tall, `tabular-nums`. 5-digit values (max 99 999) fit 80 px at 16 px text. No fixed pixel column widths anywhere; the outer containers drop `overflow-x-auto`.
- **Open** is read-only. **In** opens a numeric sheet (stepper ±1, keypad). **Out** opens a sheet with three steppers: Retail (focused), Wholesale, Destock (+ required reason); the cell shows their sum. **⇄** shows the net (`transfer_in − transfer_out − move`, signed) and opens the CR1 move sheet.
- Rows are grouped by `group_name` (fallback: type), sizes sorted by grams. Group header shows count and pieces; tap collapses. A search box filters by name; "Only rows with activity" toggle.
- Inputs use 16 px text (stops iOS zoom) and `inputmode="numeric"`.

### Questions raised and answers
| # | Question | Answer |
|---|---|---|
| 5.1 | Keep retail/wholesale/destock separately, or one "Out"? (Analyst) | Keep separate in the DB: velocity needs sales only, and destock needs a reason. The UI shows one Out cell; the sheet splits it. |
| 5.2 | Negative closing? (Vault) | Refused when entered: a change that would make closing < 0 returns `NEGATIVE_CLOSING {available}` and the sheet says "Only 3 available. Record Stock In first." The `ledger_guard_negative` trigger backs it (D5). |
| 5.3 | Two devices editing the same row. (Architect) | Every typed change is a **compare-and-set**: the client sends `{field, from, to}`; the server applies it only if the stored value still equals `from`. If the stored value already equals `to`, that is success (safe retry). Otherwise `409 ROW_CHANGED {row}`. Stepper taps are buffered locally for 600 ms and sent as one CAS; on `ROW_CHANGED` a stepper change is re-based automatically once (`to = current + (to − from)`), and a typed value shows "Changed by Noy to 4: keep yours?". |
| 5.4 | Final Stock step? | **Merged [Call].** The count is entered on the same screen in **count mode** (a UI toggle, not a DB status). Counts may be saved any time the day is open. `final_stock` remains a valid stored status for old rows and is treated as "open". |
| 5.5 | Close (Done) rules? | Unchanged: every row counted; a count ≠ closing needs a note; destock needs a reason; no negative closing. "✓ matches" sets count = closing for **one row per tap**. There is no "match all": a vault count must be physical. Before 15:30 Laos time, closing asks for confirmation (existing cutoff). |
| 5.6 | Lock and reopen? | After ✓, the screen is read-only with a banner "Closed 18:42 by Noy". Reopen: **admin** any case (latest Done day only, existing rule); **branch manager** own branch, latest Done day, at most 3 days old. A reason is always required. Reopen returns the day to open (`check_in`). The DB trigger refuses a reopen by anyone else (D5). |
| 5.7 | API shape? | `POST /stock/desk/:id/entries` accepts `changes:[{sku_id, field, from?, to}]` (fields: `stock_in, retail_sale, wholesale, destock, destock_note, counted_qty, counted_note`). The legacy `rows:[…]` body is still accepted during rollout (an old cached SPA), with the same negative check. New `POST /stock/desk/:id/close` validates and sets Done from `check_in` or `final_stock`. `/transition` stays for compatibility. |
| 5.8 | DB side of CAS? | RPC `ledger_apply(p_date, p_desk, p_sku, p_changes jsonb)`: `SELECT … FOR UPDATE`, compare, single UPDATE; the trigger raises `NEGATIVE_CLOSING`. |
| 5.9 | Verification of "no horizontal scroll"? | Manual check at 360 and 375 px widths with 10 sizes and 5-digit values: `document.documentElement.scrollWidth <= innerWidth` must be true on the day screen, both sheets, and the replenishment screen. Listed in the plan. |

---

## 7. CR6: Deployment, environment, roles file, safe seed data

### 7a. Environment [Call, mapped from the request]
| Requested | Actual | Where |
|---|---|---|
| `VITE_SUPABASE_URL` | `SUPABASE_URL = https://tpekfhbjbosbeikawkys.supabase.co` | `.dev.vars` locally; Cloudflare *Variables* (plain text) |
| `VITE_SUPABASE_ANON_KEY` | **not used** (D3). The **service-role** key is used, and only server-side: `SUPABASE_SERVICE_ROLE_KEY` | `.dev.vars` locally; Cloudflare *Secret* |
| (implicit) | `AUTH_SECRET` (signs sessions; 32+ random bytes) | `.dev.vars`; Cloudflare *Secret* |
| seed flag | `KPV_DATA_MODE = test \| production` (default `production` when Supabase is set) | `.dev.vars`; Cloudflare *Variables* |

- `.env.example` / `.env.local` are Vite conventions; this project uses Wrangler's `.dev.vars` (already git-ignored). `.dev.vars.example` is updated with the project URL and the new flag. A one-paragraph note in `README.md` explains the mapping so nobody adds a `VITE_` file.
- `KPV_DATA_MODE=test`: a yellow "TEST DATA · ທົດສອບ" strip on every screen.
- `KPV_DATA_MODE=production`: seed accounts (`is_seed`) **cannot log in**, and if any seed rows still exist, admins see a red strip "Mock data still in the database: run purge_seed_data.sql". `GET /api/meta` → `{dataMode, seedRows}` via RPC `kpv_seed_counts()`.
- Deploy: `npm run deploy` (builds CSS, `wrangler deploy`), or connect the GitHub repo under *Settings → Builds* with build command `npm ci && npm run build:css` and deploy command `npx wrangler deploy`. Secrets via dashboard or `wrangler secret put`.

### 7b. `supabase/users_roles.sql`
- Roles: `admin` (top management, all branches), **`manager`** (new; one branch), `staff` (one branch). Constraint: non-admin roles need `branch_id`.
- Permissions (Worker and DB agree):

| Action | staff | manager | admin |
|---|---|---|---|
| Day entries, counts, close, moves, receive transfers (own branch) | ✓ | ✓ | ✓ all |
| Take/hand over cases | self/own | branch | all |
| Reopen a Done day | – | own branch, latest, ≤3 days | latest |
| Replenishment rules | read | own branch rules | all |
| Closed days | read | own branch | all |
| Unlock a locked PIN | – | own branch staff | ✓ |
| Users (create, role, branch, PIN reset) | – | – | ✓ |
| SKUs, types, sizes, gold price, config | – | – | ✓ |
| Approve/reject proposals, delete documents | – | – | ✓ |
| Audit log | own case today | own branch | all |

- File contents: role constraint migration; helpers `kpv_actor_id()`, `kpv_actor()` (id, role, branch), `kpv_require(role[], branch)`; guard triggers for the DB-enforced rows of the table above (reopen, staff_accounts role/branch/PIN, master data, config, rules, closed days, assignments); RLS **enabled on every table** with no permissive policies plus `revoke all … from anon, authenticated` on tables, sequences and functions, and default privileges so future tables are closed too.
- The SQL editor (`postgres` user, no actor) is allowed through guards; it is the owner's console. Service-role calls without an actor are refused (D4).
- First admin: still `npm run db:admin -- "Owner" <PIN>` (prints an insert with a PBKDF2 hash). `users_roles.sql` documents it.

### 7c. Seed and purge
- **`is_seed boolean not null default false`** on every business table (branches, desks, staff_accounts, sku_type, sku_weight, master_sku, desk_days, daily_stock_ledger, transfers, documents, document_rows, doc_counters, audit_log, replenishment_rule, desk_assignment, branch_closed_day).
- **Seed inheritance trigger:** on insert, a row referencing a seed branch, desk, SKU, document or staff member is marked `is_seed = true`, even if a real admin created it while testing. So the purge is complete without guessing.
- **`supabase/seed_mock_data.sql`** (replaces `seed.sql`, which truncated everything and is deleted). Dates are relative to `kpv_today()`, so the file never needs regenerating. It refuses to run if `KPV`-seed rows already exist (purge first). Contents:
  - Seed branches **B-TST1 "Test Branch / ສາຂາທົດສອບ"** (4 cases) and **B-TST2** (1 case, to test branch isolation and a cross-branch transfer).
  - Cases T1-1…T1-4. **T1-1, T1-2, T1-3:** Done every required day for the last 21 days, checked in today → tier `on_track` with streak 21; T1-1 also ✓ Done today → `done_today`. **T1-4:** last Done = today − 4 → **3 days behind → overdue, pinned**.
  - One closed day (today − 10, "Boun That Luang test") so streaks visibly skip it.
  - Group **"Snake Necklace"** SKUs `SEED-SNK-025/-05/-1/-2` on base weights 0.25/0.5/1/2 Baht, plus two seed Ring SKUs. Ledger history of 28 days with realistic sales, two zero-stock days (velocity test) and consistent openings (= previous count).
  - Rules: group "Snake Necklace", company-wide: lead 7, avg 100 [Owner example]; one SKU+branch override; one SKU left on auto.
  - Moves T1-1 → T1-2 today (one undone by a reverse move), one cross-branch transfer in transit B-TST1 → B-TST2.
  - Staff: seed admin "Test Admin", seed manager + 2 staff (B-TST1), 1 staff (B-TST2), PIN **1234**, all `is_seed`; assignments including a mid-day handover on T1-2.
  - Audit entries arise naturally from the triggers (actor GUC `kpv.actor_id` = the seed admin, since only an admin may create SKUs), plus a semantic `desk_day.reopen` example.
- **`supabase/purge_seed_data.sql`** (one command: paste and run):
  1. Prints `kpv_seed_counts()` (dry-run view).
  2. In one transaction: `set local kpv.purging = 'on'`; deletes `is_seed` rows child-first (audit_log, document_rows, documents, doc_counters, desk_assignment, transfers, daily_stock_ledger, desk_days, branch_closed_day, replenishment_rule, desks, master_sku, sku_weight, sku_type, staff_accounts, branches). The Done-lock and audit-immutability triggers allow these deletes **only** for `is_seed` rows while purging.
  3. Asserts every seed count is 0 and that **no non-seed row was touched** (non-seed counts before = after); otherwise raises and the whole purge rolls back.
  4. Writes one permanent audit entry `seed.purge` with the counts.
  - Never touches schema, base data, real users or real rows. Safe to run twice.

---

## 8. Cross-cutting

- **i18n:** every new string in Lao and English in `public/js/i18n.js`.
- **Accessibility:** tiers stated in text, 44 px tap targets, focus visible, `prefers-reduced-motion` respected (no pulsing alerts).
- **Errors:** every new refusal has a `code`; the UI maps codes to Lao/English messages.
- **Performance:** the day screen loads one desk detail call (as now); the cards call adds one 400-day desk-day query per branch; replenishment is one RPC + latest rows.

## 9. Manual (Lao) updates to list in `docs/GO-LIVE.md`
Instant same-branch move with Undo; one-screen day with count mode; streak/tiers and closed days; branch manager role; case assignment and Switch user; replenishment screen and alert rules; audit history tab; seed purge instead of dropping the schema.

## 10. Non-goals and anti-goals
- **Non-goals:** React/Vite rewrite; Cloudflare Pages migration; Supabase Auth; offline mode; automatic purchase orders; weekly opening-hours calendar; formal handover counts; push notifications.
- **Anti-goals (failure even if it "works"):** any path where gold appears or disappears without a ledger + audit trace; a browser able to reach the database; a purge that can delete a real row; a day screen that needs sideways scrolling; alerts computed per case that disagree with branch totals.

## 11. Left to the builder
Exact Tailwind classes and icons; sheet animations; i18n wording (Lao reviewed by the owner later); internal function names beyond those named here; pagination mechanics of the audit list; how the 400-day desk-day query is paged.

## 12. Calls made in this document (for the owner to check)
D1 keep stack · D2 Workers not Pages · D3 no anon key in browser · D4 actor via headers · D7 migration files · D8 PGlite tests · 1.1 same-branch instant, cross-branch unchanged · 1.6 undo = reverse move · 1.7 auto check-in of destination · 1.9 any branch staff may move · 2.1 `group_name` column · 2.3 precedence order · 2.4 manual beats auto · 2.5 velocity definition · 2.8 position includes inbound · 2.11 per-case reorder point retired · 3 streak/tier definitions · 4.13 no acceptance step · 4.14 stale assignment display · 5.4 Final Stock merged · 5.5 no "match all" · 5.6 manager reopen ≤3 days · 7a `KPV_DATA_MODE` behaviour · 7c seed branches B-TST1/B-TST2, `seed.sql` deleted.
