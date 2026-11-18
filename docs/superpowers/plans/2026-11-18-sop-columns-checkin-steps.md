# SOP Columns, Check-in Step & Reopen Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daily case check follow the sales staff's confirmed SOP. The new columns are Opening | Stock In | Retail | Wholesale | Return | Withdraw | Closing. A day now has a real check-in step (review the opening balance, add SKUs or stock that came in before work) before any selling. Each home card shows two step buttons and a status icon, and a manager's reopen of a past day reopens every later day so staff redo them one by one.

**Architecture:** Migration 17 adds a `withdraw` ledger column (in the stock-out and closing formulas) and an `opening` day status (the day exists but is not checked in yet). It also adds an atomic `desk_reopen_from` function. Pure rules (which field may be typed at which step, closing, validation) live in `src/logic.ts` and its client mirror `public/js/views/day/row.js`. Routes in `src/routes/stock.ts` enforce them. The home card's step state comes from a pure client module `public/js/case-steps.js`.

**Tech Stack:** Cloudflare Worker + Hono (TypeScript), Supabase Postgres (PostgREST), vanilla-JS PWA with Tailwind, Vitest (+ PGlite for SQL tests).

**Spec:** the owner's SOP message of 2026-11-18 plus their answers in this session, both summarised in "Owner decisions" below. Earlier rules come from README.md and the memory notes (stock-grid-move-decisions, sku-simplify-decisions).

## Owner decisions (2026-11-18)

1. Columns: SKU, Opening, Stock In, Retail (sell), Wholesale (sell), Return, Withdraw, Closing. **Move in/out and Count are dropped** (closing is calculated, as on the paper sheet; there's no count and no variance note).
2. Stock leaves a case in 3 sell-type ways (retail, wholesale, withdraw) plus Return. **Return = the existing `destock` column, relabelled, with no note required.** Withdraw = gold taken out of the Easy Gold app as physical gold.
3. Day lifecycle: `opening` (review step) → `check_in` (working) → `done`.
   - In the review step, staff see yesterday's closing as Opening. They may add a SKU (typing its **opening**) and type **Stock In** (the first delivery). No selling columns yet.
   - "Confirm check-in" moves the day to `check_in`. Now Stock In (the second delivery, typed as a running total), Retail, Wholesale, Return and Withdraw are typed. A SKU added now takes a **Stock In** quantity. Its opening is locked at 0.
4. Home card: **[① Check in] [② Close day]** plus a status icon: not checked in = alert, checked in = pending, closed = done. The current step is coloured; finished steps and steps that can't happen yet are grey and can't be tapped.
5. Reopen: a manager may reopen a Done day up to 3 days back (admin: any day). **That day and every later day of the case go back to `opening`.** The numbers already typed are kept. Staff check in and close them in date order, because a day can't be worked while an earlier day of the case is not Done.
6. (Added at execution) SKU settings follow these rules. The per-branch avg sell/day and lead time also show on the case grid and in the report (Task 8).

## Global Constraints

- Work on `main` only; commit per task; never push unless the owner asks (memory: work-on-main-only).
- Migration file: `supabase/migrations/20261118_17_sop_steps.sql`. It is additive and idempotent (safe to re-run), and must never rewrite a Done day's typed values.
- Closing formula (DB generated column, `computeClosing`, and `closingOf` in row.js must stay identical):
  `opening_qty + stock_in + transfer_in - transfer_out - move - retail_sale - wholesale - destock - withdraw - stock_out_single + move_qty`
  (`move`, `transfer_*`, `move_qty`, `stock_out_single` stay in the formula for old days; the UI no longer offers them.)
- `stock_out` (generated) = `retail_sale + wholesale + destock + withdraw + stock_out_single`.
- Units "sold" for reorder velocity = `retail_sale + wholesale + withdraw + stock_out_single`. Withdraw empties stock that must be refilled, so it counts as sold; Return does not.
- Fields staff may change, by day status (dynamic mode; single mode swaps the four out-fields for `stock_out_single`):
  - `opening`: `stock_in`, plus `opening_qty` only on a row the case did not carry from its previous day
  - `check_in` / `final_stock`: `stock_in`, `retail_sale`, `wholesale`, `destock`, `withdraw`
  - The server refuses `move_qty`, `counted_qty`, `counted_note` and `destock_note` (400 `BAD_FIELD`). The columns stay in the DB for old days.
- `MANAGER_REOPEN_DAYS = 3` (unchanged); the reopen reason must be at least 3 characters (unchanged).
- Product names always use `productName()` (memory: product-names-lao). Every new UI string goes in both `lo` and `en` in `public/js/i18n.js`.
- Lao labels (the owner checks the wording): Return `ສົ່ງຄືນ`, Withdraw `ຖອນ`, status opening `ຍັງບໍ່ເຂົ້າວຽກ`, step 1 `① ເຂົ້າວຽກ`, step 2 `② ປິດມື້`, confirm `✓ ຢືນຢັນເຂົ້າວຽກ`, badge pending `ກຳລັງເຮັດ`, badge done `✓ ແລ້ວ`.
- Error codes the client must show in words: `FIELD_NOT_IN_STEP` (409), `OPENING_LOCKED` (409, existing), `EARLIER_DAY_OPEN` (409, existing), `NEXT_DAY_NEGATIVE` (409, existing).

## Review Focus

1. **A reopened old day that has a physical count.** `carryQty` prefers `counted_qty`, so a corrected sale would not reach the next day's opening. Reopen must clear `counted_qty`/`counted_note` on the reopened rows (Task 4 test `reopen clears old counts so the corrected closing carries`).
2. **The corrected carry makes a later reopened day negative.** Closing the earliest day must refuse with `NEXT_DAY_NEGATIVE` naming the SKU and date, and leave the day open (Task 4 test `closing a corrected day refuses when the next day would go negative`).
3. **Staff writing a past date after a cascade.** Staff (not only admin) must be able to check in, type and close D-3, D-2 and D-1 in order, and be refused on D-2 while D-3 is open (Task 4 test `staff redo reopened days in date order`).
4. **A second device sends an Opening edit after the first confirmed check-in.** It must get 409 `FIELD_NOT_IN_STEP` (not a silent write), and the save queue must show it and not retry it forever (Task 3 test `opening edit after confirm is refused`; Task 6 step for the save-queue toast).
5. **An old day with a hidden Move in/out or count is reopened or viewed.** Its closing still includes `move_qty`. The grid has no Move column, so the Closing cell must show the legacy move as a small `⇄ ±n` badge. Otherwise the numbers look wrong (Task 6 test `legacy move shows on the closing cell`).

---

### Task 1: Migration 17 — withdraw column, `opening` status, reopen function

**Files:**
- Create: `supabase/migrations/20261118_17_sop_steps.sql`
- Modify: `supabase/schema.sql:119` only if `test/sql/db.ts` load order needs it (it loads schema.sql and then every migration, so the migration alone should be enough; don't edit schema.sql unless a test proves it is needed)
- Test: `test/sql/sop_steps.test.ts`

**Interfaces:**
- Produces: `daily_stock_ledger.withdraw int not null default 0 check (withdraw >= 0)`; `desk_days.status` allows `'opening'` and defaults to `'opening'`; SQL `desk_reopen_from(p_desk text, p_date date) returns setof date`; `ledger_apply` accepts fields `withdraw` and `opening_qty`; `branch_velocity` counts withdraw as sold.

- [ ] **Step 1: Write the failing SQL tests** (copy the setup style of `test/sql/stock_grid.test.ts`; use `freshDb({ withBase: true })`)

```ts
it('withdraw lowers closing and counts in stock_out', async () => {
  // row opening 10, stock_in 2, retail 1, wholesale 1, destock 1, withdraw 3
  // expect closing_qty = 6, stock_out = 6
});
it('withdraw cannot be negative', /* expectPgError(..., 'withdraw') */);
it('negative guard includes withdraw', /* opening 2, withdraw 3 -> NEGATIVE_CLOSING */);
it('a new desk_day defaults to opening; status opening is allowed', ...);
it('ledger_apply sets withdraw and opening_qty', /* ok:true, row.withdraw = 4 */);
it('desk_reopen_from reopens the day and every later day, clears done stamps and counts', async () => {
  // days D1 done, D2 done, D3 check_in; counted_qty set on D1, D2 rows
  // select * from desk_reopen_from('MM-D01', D1) -> [D1, D2, D3]
  // all three status 'opening', done_by/done_at null; counted_qty/counted_note null on D1..D3 rows
  // a day before D1 is untouched
});
it('branch_velocity counts withdraw as sold, not destock', ...);
it('re-running the migration is a no-op', /* exec the file twice, no error */);
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/sql/sop_steps.test.ts`
Expected: FAIL (column `withdraw` does not exist)

- [ ] **Step 3: Write the migration.** Follow migration 11's pattern exactly:
  - add the column and a named check constraint inside `if not exists`;
  - drop and re-add the status check constraint with `('opening','check_in','final_stock','done')`, then `alter column status set default 'opening'`;
  - re-create the generated `stock_out` and `closing_qty`: drop `ledger_latest`, drop both columns, add them back with the Global Constraints formulas, re-create the view with `security_invoker`. Guard it with `generation_expression like '%withdraw%'` so a re-run skips it;
  - re-create `ledger_guard_negative` with the new formula;
  - re-create `ledger_apply` with `v_int` = `stock_in, retail_sale, wholesale, destock, withdraw, stock_out_single, move_qty, counted_qty, opening_qty` (the server-side allow-list lives in the Worker);
  - re-create `branch_velocity` with sold including `l.withdraw`;
  - `desk_reopen_from`: in one statement, update `desk_days` (status `'opening'`, `done_by` and `done_at` null) where `desk_id = p_desk and ledger_date >= p_date` returning `ledger_date`. Then null `counted_qty` and `counted_note` on those days' ledger rows. Make it `security definer`-free, and grant it to `service_role` only (revoke it from public, anon and authenticated, as in migration 11).
  - Add a header comment block in the style of migration 11.

- [ ] **Step 4: Run the SQL suite**

Run: `npm run test:sql`
Expected: PASS (new tests and every existing SQL test)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261118_17_sop_steps.sql test/sql/sop_steps.test.ts
git commit -m "feat(db): withdraw column, opening day status, reopen-from function"
```

---

### Task 2: Core rules — closing, sold, step fields, validation

**Files:**
- Modify: `src/types.ts` (`DeskStatus`, `LedgerRow`, `LedgerEntryPatch`)
- Modify: `src/logic.ts:30-75, 134-157, 241-300`
- Modify: `src/store.ts:60-81` (`LedgerChangeField`, `LEDGER_CHANGE_FIELDS`, `TEXT_CHANGE_FIELDS`)
- Test: `test/logic.test.ts`

**Interfaces:**
- Produces:
  - `type DeskStatus = "opening" | "check_in" | "final_stock" | "done"`; `LedgerRow.withdraw: number`
  - `computeClosing`, `stockOutOf` include `withdraw` (an optional field in their input types, `?? 0`); `soldOf` includes `withdraw`
  - `type DayRule = "negative_closing"` (the note and count rules are removed)
  - `stepFields(status: DeskStatus, mode: StockOutMode): readonly LedgerChangeField[]`. It returns exactly the per-status lists in Global Constraints (in `opening`, the list includes `opening_qty`; the route then narrows it to rows that were not carried)
  - `LedgerChangeField` = `stock_in | retail_sale | wholesale | destock | withdraw | stock_out_single | opening_qty`; `TEXT_CHANGE_FIELDS = []`
  - `buildDeskDetail` rows add `withdraw` and `legacy_move` (= `netMoveOf(row)`, which includes `move_qty`), and keep `counted_qty` for display

- [ ] **Step 1: Write failing tests in `test/logic.test.ts`**

```ts
it("closing subtracts withdraw and return", () =>
  expect(computeClosing(row({ opening_qty: 10, stock_in: 2, retail_sale: 1, wholesale: 1, destock: 1, withdraw: 3 }))).toBe(6));
it("soldOf counts withdraw but not return", () =>
  expect(soldOf(row({ retail_sale: 1, wholesale: 2, withdraw: 3, destock: 4 }))).toBe(6));
it("stepFields: opening allows stock_in and opening only", () =>
  expect(stepFields("opening", "dynamic")).toEqual(["stock_in", "opening_qty"]));
it("stepFields: check_in allows stock_in and the four outs", () =>
  expect(stepFields("check_in", "dynamic")).toEqual(["stock_in", "retail_sale", "wholesale", "destock", "withdraw"]));
it("stepFields: single mode check_in", () =>
  expect(stepFields("check_in", "single")).toEqual(["stock_in", "stock_out_single"]));
it("stepFields: done allows nothing", () => expect(stepFields("done", "dynamic")).toEqual([]));
it("validateDeskDay needs no count or return note", () =>
  expect(validateDeskDay([row({ opening_qty: 5, destock: 1, counted_qty: null, destock_note: null })])).toEqual([]));
it("validateDeskDay still refuses a negative closing", ...);
```

Delete or rewrite the existing tests that assert `count_missing`, `variance_note_missing` or `destock_note_missing`.

- [ ] **Step 2: Run** `npx vitest run test/logic.test.ts`. Expected: FAIL (`stepFields` is not exported)

- [ ] **Step 3: Implement** the Interfaces above. Update the `ClosingInput` type and the DemoStore row defaults in `src/store.ts:595-615` and `:870-880` (`withdraw: 0`), so `npm run typecheck` passes.

- [ ] **Step 4: Run** `npx vitest run test/logic.test.ts && npm run typecheck`. Expected: PASS, no type errors. (API tests may now fail on counting; Task 3 fixes the helpers.)

- [ ] **Step 5: Commit** `git commit -m "feat(logic): withdraw in closing/sold, per-step fields, close needs no count"`

---

### Task 3: Check-in step on the server

**Files:**
- Modify: `src/store.ts:203, 526-535, 1327-1333` (`insertDeskDay` inserts `status: "opening"` in both stores)
- Modify: `src/app.ts:93-99` (`requireOpenDay` gains the earlier-day guard)
- Modify: `src/routes/stock.ts` (entries, transition, `/sku`, `/desks`, `hasActivity`, `closeDeskDay`)
- Modify: `test/helpers.ts` (new `checkIn`, simplified `closeDay`), then fix the call sites in `test/*.test.ts`
- Test: `test/checkinStep.test.ts`

**Interfaces:**
- Consumes: `stepFields` (Task 2); `ledger_apply` accepting `withdraw` and `opening_qty` (Task 1)
- Produces:
  - `POST /stock/desk/:id/checkin {date}` creates the day in `opening` (carry-forward unchanged) and stays idempotent
  - `POST /stock/desk/:id/transition {date, toStatus: "check_in"}` moves `opening` → `check_in` (409 `BAD_TRANSITION` from any other status). The existing `final_stock`/`done` transitions stay.
  - `POST /stock/desk/:id/close` is refused from `opening` (409 `BAD_TRANSITION`)
  - `POST /stock/desk/:id/sku` items `{sku_id, opening_qty?, stock_in?}`. `opening_qty > 0` is allowed only while the day is `opening` (else 409 `OPENING_LOCKED`). This replaces the "first day only" rule. `stock_in` is allowed in `opening` and `check_in`, and is written after the insert or restore through `store.applyLedgerChanges`.
  - `requireOpenDay` throws 409 `EARLIER_DAY_OPEN {openDate}` when an earlier day of the case is not `done`
  - `POST /desks` creates the first day in `opening`
  - Detail rows add `opening_editable: boolean` (true only when the day is `opening` and the SKU had no non-excluded row on the case's previous day)
  - `test/helpers.ts`: `checkIn(session, deskId, date)` = POST checkin + POST transition `check_in`; `closeDay(session, deskId, date)` = POST close (no counting); `countEverything` is removed

- [ ] **Step 1: Write failing tests in `test/checkinStep.test.ts`** (use `freshApp`, `asStaff("B-MM")`, and a demo case whose yesterday is Done)

```ts
it("check-in opens the day in the opening step with yesterday's closing as opening", /* status "opening", rows' opening_qty = yesterday carry */);
it("opening step: stock_in saves, retail is refused", /* retail -> 409 FIELD_NOT_IN_STEP {field:"retail_sale", status:"opening"} */);
it("opening step: a newly added SKU takes an opening and it can be edited", /* POST /sku {opening_qty:4}; change opening_qty 4->6 ok */);
it("opening step: a carried row's opening cannot be edited", /* 409 OPENING_LOCKED */);
it("confirm moves opening -> check_in; then retail and withdraw save", ...);
it("opening edit after confirm is refused", /* change opening_qty on check_in day -> 409 FIELD_NOT_IN_STEP */);
it("adding a SKU after check-in: opening refused, stock_in accepted", /* {opening_qty:3} -> 409 OPENING_LOCKED; {stock_in:3} -> row stock_in 3, opening 0 */);
it("move_qty, counted_qty, destock_note are refused", /* 400 BAD_FIELD each */);
it("cannot close from the opening step", /* 409 BAD_TRANSITION */);
it("close needs no count", /* after confirm, POST close -> 200, status done */);
it("a new case starts in the opening step", /* POST /desks -> detail status "opening" */);
it("a day cannot be written while an earlier day is not Done", /* 409 EARLIER_DAY_OPEN with openDate */);
```

- [ ] **Step 2: Run** `npx vitest run test/checkinStep.test.ts`. Expected: FAIL

- [ ] **Step 3: Implement** the Interfaces. In the entries route, replace `offMode` with "the field is not in `stepFields(day.status, mode)`" → 409 `FIELD_NOT_IN_STEP {sku_id, field, status}`, keeping `WRONG_STOCK_OUT_MODE` for the mode case. Compute "carried SKUs" once per request from the latest earlier desk day's ledger. Add `withdraw` to `hasActivity`.

- [ ] **Step 4: Update the helpers and every test that checked in or counted.** Run `npm test`. Expected: PASS. Where an old test asserted count or variance behaviour, delete it (the owner dropped Count); don't re-implement counting.

- [ ] **Step 5: Commit** `git commit -m "feat(stock): opening review step before check-in; step-scoped fields"`

---

### Task 4: Reopen cascade

**Files:**
- Modify: `src/store.ts` (interface + DemoStore + Supabase: `reopenFrom`)
- Modify: `src/routes/stock.ts:478, 671-697` (`canReopen`, reopen route)
- Test: `test/reopenCascade.test.ts`

**Interfaces:**
- Consumes: SQL `desk_reopen_from` (Task 1); `checkIn`, `closeDay` helpers (Task 3)
- Produces:
  - `Store.reopenFrom(deskId: string, date: string): Promise<string[]>` returns the reopened dates, ascending. Supabase calls the RPC; DemoStore does the same in memory, logs each `desk_days` update and clears counts.
  - The reopen route: same checks for role, window, reason and `NOT_DONE`. The `NOT_LATEST_DONE` refusal is removed. It calls `reopenFrom` and audits `desk_day.reopen` with detail `{ reason, dates }`.
  - `canReopen` = `mayReopen(...) && day?.status === "done"` (the later-Done condition is dropped)

- [ ] **Step 1: Write failing tests** (dates relative to `TODAY` from helpers; build D-3..D-1 Done and today `check_in` with sales typed)

```ts
it("manager reopen of D-3 puts D-3..today back to opening and keeps typed numbers", ...);
it("manager cannot reopen D-4; admin can", /* 403 REOPEN_TOO_OLD; admin 200 */);
it("staff redo reopened days in date order", /* writing D-2 -> 409 EARLIER_DAY_OPEN{openDate:D-3}; checkIn+close D-3, then D-2, D-1, then today's retail saves */);
it("closing a corrected day carries the new closing into the next day's opening", /* D-3 retail +1 -> D-2 opening -1 */);
it("reopen clears old counts so the corrected closing carries", /* D-3 had counted_qty; after reopen + edit + close, D-2 opening = computed closing */);
it("closing a corrected day refuses when the next day would go negative", /* 409 NEXT_DAY_NEGATIVE {sku_id, date}; D-3 stays opening/check_in */);
it("reopen is audited once with every reopened date", ...);
```

- [ ] **Step 2: Run** `npx vitest run test/reopenCascade.test.ts`. Expected: FAIL

- [ ] **Step 3: Implement** the Interfaces.

- [ ] **Step 4: Run** `npm test`. Expected: PASS (fix older reopen tests that expected `NOT_LATEST_DONE` or a reopen to `check_in`)

- [ ] **Step 5: Commit** `git commit -m "feat(stock): manager reopen reopens every later day of the case"`

---

### Task 5: Home card step buttons

**Files:**
- Modify: `src/routes/stock.ts:199-245` (`openEarlierDate` is set for every card whose status is not `done`, not only `not_started`)
- Modify: `src/logic.ts` `buildDeskCards` (a card's status can be `opening`)
- Create: `public/js/case-steps.js`
- Modify: `public/js/views/stock.js:20-40, 225-300` (card markup, click handling)
- Modify: `public/js/util.js:100-110` (`statusPillClasses("opening")` uses the alert/danger tone), `public/js/audit-value.js:9` (an `opening` label), `public/js/i18n.js`
- Test: `test/caseSteps.test.ts`

**Interfaces:**
- Produces: `caseSteps(card: {status, openEarlierDate}) → { checkIn: "active"|"done"|"locked", close: "active"|"done"|"locked", badge: "alert"|"pending"|"done", goToDate: string|null }`

| card | checkIn | close | badge | goToDate |
|---|---|---|---|---|
| `not_started` / `opening`, no earlier open day | active | locked | alert | null |
| any non-`done` with `openEarlierDate` | active | locked | alert | openEarlierDate |
| `check_in` / `final_stock` | done | active | pending | null |
| `done` | done | done | done | null |

- [ ] **Step 1: Write failing tests**: one `it` per table row, asserting the whole returned object.

- [ ] **Step 2: Run** `npx vitest run test/caseSteps.test.ts`. Expected: FAIL (module not found)

- [ ] **Step 3: Implement `caseSteps`, then the card.** The card replaces the single action button with a row of two buttons and the status icon:
  - an `active` button is `btn-primary`;
  - `done` and `locked` buttons are grey with `disabled` and `aria-disabled="true"`, and `done` adds a ✓;
  - with `goToDate`, button ① reads `tf("stock.goToDate", …)` and jumps to that date (the existing behaviour).
  - Button ① calls the existing check-in flow and opens the day screen. Button ② opens the day screen and immediately runs its close flow (Task 6).
  - Icon: alert = red ⚠ with `stock.statusOpening`, pending = amber ⏳ `step.badgePending`, done = green ✓ `step.badgeDone`.
  - Tapping the card body still opens the day screen.
  - Add i18n keys `stock.statusOpening`, `step.checkIn`, `step.close`, `step.badgePending`, `step.badgeDone` in `lo` and `en`.

- [ ] **Step 4: Run** `npm test`. Expected: PASS (including `test/i18n.test.ts` key parity)

- [ ] **Step 5: Commit** `git commit -m "feat(ui): home cards show check-in / close steps with a status icon"`

---

### Task 6: Day screen — SOP columns, opening step, close without count

**Files:**
- Modify: `public/js/views/day/row.js` (columns, closing, legacy badge; drop the move cell and count input)
- Modify: `public/js/views/day/index.js` (step mode, bottom bar, add-SKU flow, close confirm, client validation at :69)
- Modify: `public/js/views/day/sheets.js` (remove the destock-reason sheet trigger)
- Modify: `public/js/views/day/save-queue.js` (a 409 `FIELD_NOT_IN_STEP` / `OPENING_LOCKED` is final: toast, revert the cell, no retry)
- Modify: `public/js/views/stock.js:407-455` (`askOpeningQtys` takes a label, so the same sheet asks for "Stock-in qty" after check-in)
- Modify: `public/js/i18n.js`
- Test: `test/dayGrid.test.ts`, `test/saveQueue.test.ts`

**Interfaces:**
- Consumes: detail rows with `withdraw`, `legacy_move`, `opening_editable` (Tasks 2–3); `caseSteps` (Task 5)
- Produces (row.js):
  - `columnsFor("dynamic")` = `["stock_in","retail_sale","wholesale","destock","withdraw"]`; `columnsFor("single")` = `["stock_in","stock_out_single"]`
  - `editableFor(status, mode, row) → Set<field>`, which mirrors `stepFields` and adds `"opening_qty"` only when `row.opening_editable`
  - `closingOf` matches the Global Constraints formula
  - `headerHtml(mode)` (the countMode option is removed)

- [ ] **Step 1: Write failing tests in `test/dayGrid.test.ts`**

```js
it("dynamic columns are In, Retail, Wholesale, Return, Withdraw", ...);
it("closingOf subtracts withdraw", ...);
it("opening step: only stock_in, plus opening on a new row", /* editableFor("opening","dynamic",{opening_editable:false}) = {stock_in} */);
it("check_in step: stock_in and the four outs; opening never", ...);
it("legacy move shows on the closing cell", /* rowHtml with legacy_move -3 contains "⇄ −3" */);
it("a past counted value shows as a note, never as an input", ...);
```

Add to `test/saveQueue.test.ts`: `it("FIELD_NOT_IN_STEP is not retried and reverts the cell")`.

- [ ] **Step 2: Run** `npx vitest run test/dayGrid.test.ts test/saveQueue.test.ts`. Expected: FAIL

- [ ] **Step 3: Implement.**
  - **Cells.** Each cell is an input only when its field is in `editableFor`; every other cell is a grey read-only box. The Opening cell becomes an input for `opening_editable` rows in the `opening` step.
  - **`opening` step.** A hint banner (`day.openingHint`). The bottom bar has [+ Add SKU] and a primary [`day.confirmCheckIn`] button, which POSTs the transition and reloads. Add SKU asks for opening.
  - **`check_in` step.** The bottom bar has [+ Add SKU] (asks for `day.stockInQty` and sends `stock_in`) and a primary [`day.closeDay`] button. Close shows a confirm sheet with the day's totals (pcs in, each out, closing), then POSTs close.
  - **`done`.** Read-only, as today; the reopen menu is unchanged.
  - **Removed.** The count-mode button, `data-count`, the Move column and ± strip, and the destock-reason prompt.
  - **Labels.** Relabel `grid.destock` → `ສົ່ງຄືນ` / `Return`; add `grid.withdraw` (`ຖອນ` / `Withdraw`), `day.openingHint`, `day.confirmCheckIn`, `day.stockInQty`, and the error text for `FIELD_NOT_IN_STEP`.

- [ ] **Step 4: Run** `npm test`, then `npm run dev` and check on a phone-width window (390 px): check-in, add a SKU with opening, stock-in, confirm, type retail and withdraw, add a SKU with stock-in, close, and see the home card go ✓.
  Expected: all tests pass. The grid fits with the name column pinned, and each step's buttons are greyed as in Task 5's table.

- [ ] **Step 5: Commit** `git commit -m "feat(ui): SOP grid columns, opening review step, close without count"`

---

### Task 7: Withdraw in history, report and velocity; docs

**Files:**
- Modify: `public/js/views/day/history.js:181-190` (the out total includes `withdraw`; the filter counts a non-zero `withdraw` as activity)
- Modify: `public/js/views/report.js:296` (uses `stock_out`, so check that the generated column now carries withdraw and touch the file only if needed)
- Modify: `src/replenishment.ts` (the DemoStore velocity uses `soldOf`, so check that it now includes withdraw)
- Modify: `src/demoData.ts` (give 1–2 demo rows a `withdraw` value so the demo shows the column; keep every existing test green)
- Modify: `README.md` (the day-lifecycle and column rules), `docs/GO-LIVE.md` (a new section: run migration 17 in the Supabase SQL editor **before** pushing; what changes for staff)
- Test: `test/replenishment.test.ts`

- [ ] **Step 1: Write the failing test.** Add `it("velocity counts withdraw as sold but not return")` to `test/replenishment.test.ts`.
- [ ] **Step 2: Run** `npx vitest run test/replenishment.test.ts`. Expected: FAIL if the demo velocity path still skips withdraw (otherwise it passes, which confirms Task 2 covered it).
- [ ] **Step 3: Implement** the file changes above.
- [ ] **Step 4: Run** `npm test && npm run test:sql && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `git commit -m "feat: withdraw in history, report and reorder velocity; docs for migration 17"`

---

### Task 8: Avg sell/day and lead time in the case and the report; SKU settings follow the SOP

Owner request, 2026-11-18: "ensure all the SKU settings apply to our new rules, and avg sell/day / avg order time also apply to the case and reporting too". Avg sell/day and lead time are the per-branch values from Settings > SKU (`resolveParams` in `src/replenishment.ts`). Where none is typed, the automatic velocity is used. After Tasks 1–2 that velocity counts withdraw as sold.

**Files:**
- Modify: `src/logic.ts` `buildReport` (new optional `statuses: BranchStatuses` parameter; per-item replenishment fields; the out split)
- Modify: `src/routes/insights.ts:90-111` (load `loadBranchStatuses` for the branches of the desks in the report and pass it in)
- Modify: `public/js/views/report.js` (KPI out split; per-item avg / lead / runway line)
- Modify: `public/js/views/day/row.js` (every row with an avg shows its runway line, not only Critical/Warning rows)
- Modify: `public/js/views/settings/sku.js` + `public/js/i18n.js` (the "auto" avg hint says it is computed from retail + wholesale + withdraw; no new fields)
- Test: `test/logic.test.ts` (or `test/report.test.ts` if logic.test is getting crowded), `test/dayGrid.test.ts`, `test/replenishment.api.test.ts`

**Interfaces:**
- Consumes: `BranchStatuses` (`src/logic.ts:177`, keyed `"branchId|skuId"`, with `avg.value`, `lead.value`, `runwayDays`, `status`, `suggestedQty`); `loadBranchStatuses(store, branchIds, today)`; `withdraw` on ledger rows (Task 2)
- Produces:
  - Each `buildReport(...).items[i]` adds `avg_daily_sell: number|null`, `lead_time_days: number|null`, `runway_days: number|null`, `branch_status: "critical"|"warning"|"ok"|"no_data"`, `suggested_qty: number`, plus per-period pcs sums `retail`, `wholesale`, `returned` (= destock), `withdrawn`. The branch is taken from the item's desk.
  - `buildReport(...).kpi` adds `retail`, `wholesale`, `returned`, `withdrawn` buckets (`{lak, pcs}`). `kpi.out` stays the total.
  - Detail rows (Task 2/3 payload) already carry `avg_daily_sales`, `order_lead_time_days`, `runway_days`, `branch_status`. The day grid now shows them for every row whose avg is known.

- [ ] **Step 1: Write failing tests**

```ts
it("report items carry the branch's avg/day, lead time, runway and status", /* statuses map with avg 2, lead 5, runwayDays 3, status critical -> item fields equal */);
it("report item with no rule and no history shows no_data and null avg", ...);
it("report splits stock-out into retail, wholesale, return and withdraw", /* rows retail 1, wholesale 2, destock 3, withdraw 4 -> kpi pcs 1/2/3/4, kpi.out.pcs 10 */);
it("GET /report items use the per-branch SKU setting", /* set a branch avg via the settings API, then GET /report -> avg_daily_sell equals it */);
```

In `test/dayGrid.test.ts`: `it("a row with an avg shows its runway line even when status is ok")` and `it("a row with no avg shows no runway line")`.

- [ ] **Step 2: Run** `npx vitest run test/logic.test.ts test/dayGrid.test.ts test/replenishment.api.test.ts`. Expected: FAIL

- [ ] **Step 3: Implement.**
  - **Day grid.** The line under the SKU name reads `tf("replen.runwayLine", {avg, lead, days})`: Lao `"{avg}/ວັນ · ສັ່ງ {lead} ວັນ · ພໍ ≈{days} ວັນ"`, English `"{avg}/day · order {lead} d · lasts ≈{days} d"`. Critical/Warning rows keep their coloured chip.
  - **Report.** Four small out tiles (Retail, Wholesale, Return, Withdraw) go under the existing Stock-out tile. Each item card gets the same runway line.
  - **Report table view.** Add the columns Avg/day, Lead, Runway.

- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS

- [ ] **Step 5: Commit** `git commit -m "feat: avg sell/day and lead time on the case grid and report; out split"`

**Out of scope (follow-up):** re-run the Lao guidebook scenario (`scripts/guidebook`) and rebuild the manual screenshots for the new steps and columns.
