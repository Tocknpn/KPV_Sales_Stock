# SKU Picker Redesign, Skeleton Loading & Write-Failure Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Create case" and "Case > Add SKU" work again on the live Supabase, replace the one-at-a-time SKU list with a grouped, multi-select grid, show skeletons instead of "Loading…" text everywhere, and let Settings > SKU collapse/expand type groups.

**Architecture:** Server: one new store error class (`SCHEMA`) so a database that is missing a migration answers with a clear, translated message instead of "Something went wrong", plus a batch form of `POST /stock/desk/:deskId/sku`. Client: two new pure modules (`sku-groups.js`, `skeleton.js`) with unit tests, one new view module (`views/sku-picker.js`) that owns the picker and the "create new SKU" form (moved out of `stock.js`), then wiring in `stock.js`, `day/index.js`, `settings/sku.js` and every loading placeholder.

**Tech Stack:** Cloudflare Worker + Hono (TypeScript), Supabase PostgREST, vanilla ES-module SPA in `public/js`, Tailwind 3 (`src/styles/input.css` → `public/css/app.css`), Vitest (node env; client modules tested as pure functions).

**Spec:** The owner's request of 2026-11-17 (7 points, restated in "Requirements" below). Lao manual rules still apply (memory: manual is the spec).

## Requirements (from the owner, 2026-11-17)

1. SKU list grouped by SKU **type**, with a way to jump to a type ("like a shopping app").
2. SKUs shown as a **grid**; each card shows the full SKU name and its size.
3. **Multi-select** SKUs → "Add" → then enter opening balances.
4. RCA + fix: creating a case fails with "Something went wrong — try again" although SKUs load.
5. Replace every loading spinner/text with **skeleton** loading.
6. RCA + fix: creating a user fails the same way ("every write is blocked").
7. Settings > SKU: group headers with an arrow to **collapse/expand** each type group.

## Root cause (items 4 & 6) — what the code says

- Both failures show `err.SERVER_ERROR`, which the Worker only sends from the catch-all in [src/index.ts:66-67](../../../src/index.ts) — i.e. Supabase answered with an error that `SupabaseStore.send` ([src/store.ts:1135-1170](../../../src/store.ts)) does not classify, so it throws a plain `Error`.
- `POST /desks` writes `desks.initial_stock` + `created_by` (added by migration **10**). `POST /users` writes `staff_accounts.password_plain` (added by migration **13**). Saving stock writes `stock_out_single` / `move_qty` (migration **11**).
- If those migrations have not been run on the live project (or PostgREST's schema cache was not reloaded after them), PostgREST answers `400 {"code":"PGRST204","message":"Could not find the 'initial_stock' column of 'desks' in the schema cache"}`. `PGRST204` matches none of the mapped codes → plain `Error` → 500 `SERVER_ERROR`. Reads keep working (SKUs load) because `select=*` does not name the new columns.
- Memory note: *"Any DB migration must run in Supabase before a push that deploys code needing it."* Commits `d54490b`, `94058d6` (migrations 12, 13) and the case-tracking work (10, 11) were pushed on 2026-11-16; Workers Builds deployed them.
- **This is the leading hypothesis, not yet proven** — no local credentials exist. Task 1 Step 1 proves or disproves it before any fix is called done.

## Global Constraints

- Work and commit on `main` only; no branches/PRs (memory: work-on-main-only). Commit only when the step says so; push only when the owner asks.
- SKU and SKU-type names always shown with `productName(name_en, name_lo)` from `public/js/i18n.js`, whatever the UI language (memory: product-names-lao).
- Every new user-facing string gets both a `lo` and an `en` entry in `public/js/i18n.js`; every new API error code gets `err.<CODE>` in both (enforced by `test/errCodes.test.ts` for `HttpError` codes).
- Opening stock above 0 may only be set on a case's first day (`OPENING_LOCKED` rule in `src/routes/stock.ts:652-663`) — keep it.
- Only an admin may create a new master SKU from the picker (`isAdmin(state.user)`).
- Mobile first: the sheet is `max-w-[430px]`; nothing may scroll horizontally except the type-chip row.
- Animations respect `prefers-reduced-motion: reduce` (skeleton shimmer stops).
- `npm test` and `npm run typecheck` stay green after every task.

## Review Focus

1. **Selection survives filtering** — select 3 SKUs, type in search so 2 are hidden, clear search: all 3 still ticked and the button still says "Add (3)". Test: Task 3 `toggleSelection`/`filterSkus` tests; manual check in Task 5.
2. **Add SKU on a case that is not on its first day** — no opening prompt appears and the SKUs are added with opening 0; on the first day the prompt lists every selected SKU. Test: Task 2 `items` with `opening_qty > 0` on a later day → `OPENING_LOCKED`, with 0 → 200.
3. **Re-adding a SKU that was removed from the case today** (row exists with `excluded=true`) inside a batch together with new SKUs — it comes back, the new ones are inserted, nothing duplicates. Test: Task 2 "batch re-includes an excluded row".
4. **SKU with no type, or whose type is inactive** — still shown; no-type SKUs go in a last "—" group, inactive-type SKUs stay under their type. Test: Task 3 `groupSkusByType` cases.
5. **Missing-migration database** — the toast names the cause ("database needs an update") in Lao and English, and the Worker log names the missing column. Test: Task 1 `SCHEMA_OUTDATED` mapping test.

---

### Task 1: Prove the write-failure cause, make it self-explaining

**Files:**
- Modify: `src/store.ts:48` (`StoreErrorCode`), `src/store.ts:1150-1168` (`SupabaseStore.send` error mapping)
- Modify: `src/index.ts:35` (`STORE_STATUS`), `src/index.ts:38-62` (message + code)
- Modify: `public/js/i18n.js` (`err.SCHEMA_OUTDATED` in `lo` and `en`)
- Modify: `docs/GO-LIVE.md` (new short section "If every save fails with 'database needs an update'")
- Test: `test/schemaErrors.test.ts` (new)

**Interfaces:**
- Produces: `StoreErrorCode` gains `"SCHEMA"`; API answers `503 { code: "SCHEMA_OUTDATED", error: "The database needs an update. Ask the admin to run the latest migrations." }`.

- [ ] **Step 1 (owner, in Supabase SQL editor — proves the RCA): run**

```sql
select t.tbl, t.col, (c.column_name is not null) as present
from (values ('desks','initial_stock'), ('desks','created_by'),
             ('daily_stock_ledger','move_qty'), ('daily_stock_ledger','stock_out_single'),
             ('desk_days','stock_out_mode'), ('staff_accounts','password_plain')) t(tbl, col)
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.col;
```

Expected if the hypothesis holds: at least `password_plain` (and likely `initial_stock`) shows `present = false`. Also read the Worker log (Cloudflare dashboard, account e4cf6d09…, Worker `kpv-sales-stock` → Logs) for the failing request: the `Supabase desks failed (400): … PGRST204 …` line names the column. Record the result in the commit message of Step 7. **If every column is present**, stop and report the Worker log line instead — the fix below is then only the hardening, and the real cause needs a new diagnosis.

- [ ] **Step 2 (owner, the actual fix): run in the SQL editor, in order:** `supabase/migrations/20261116_10_case_tracking.sql` (do the GO-LIVE §"case tracking" pre-check first), `20261116_11_stock_grid_modes.sql` (GO-LIVE: nothing in transit), `20261116_12_admin_passwords.sql`, `20261116_13_plain_passwords.sql`, then `supabase/users_roles.sql`, then `notify pgrst, 'reload schema';`. Re-run the Step 1 query: every row `present = true`. Then create a case and a user in the live app: both succeed.

- [ ] **Step 3: Write the failing test** `test/schemaErrors.test.ts`, using the fetch-stub pattern from `test/audit.test.ts:224-236`:

```ts
it.each([
  ["PGRST204", 400, "Could not find the 'initial_stock' column of 'desks' in the schema cache"],
  ["42703", 400, 'column "password_plain" does not exist'],
  ["PGRST202", 404, "Could not find the function public.ledger_apply"],
  ["42883", 404, "function ledger_apply(date, text) does not exist"],
])("Supabase %s becomes StoreError SCHEMA", async (code, status, message) => {
  // stub fetch → new Response(JSON.stringify({ code, message }), { status })
  // store = getStore({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as any, { id: "u1" })
  await expect(store.createStaffAccount({} as any)).rejects.toMatchObject({ code: "SCHEMA" });
});
it("an unmapped Supabase error is still a plain Error", /* code "XX000" → not StoreError */);
```

Plus: `storeErrorResponse(new StoreError("SCHEMA", "x"))` returns `{ status: 503, body: { code: "SCHEMA_OUTDATED", error: "The database needs an update. Ask the admin to run the latest migrations." } }`, and `storeErrorResponse(new StoreError("NEGATIVE", "x", 4))` returns `{ status: 409, body: { code: "NEGATIVE_CLOSING", available: 4, error: "This would make the stock negative" } }` (guards the refactor).

- [ ] **Step 4: Run** `npx vitest run test/schemaErrors.test.ts` — Expected: FAIL (code is undefined / plain Error).

- [ ] **Step 5: Implement.** In `SupabaseStore.send`, before the generic fallback: `if (pgCode === "PGRST204" || pgCode === "PGRST202" || pgCode === "42703" || pgCode === "42883") throw new StoreError("SCHEMA", body);`. In `src/index.ts`: move the StoreError branch of `app.onError` into an exported `storeErrorResponse(err: StoreError): { status: number; body: Record<string, unknown> }` (console.error stays in `onError`); `STORE_STATUS.SCHEMA = 503`, message "The database needs an update. Ask the admin to run the latest migrations.", response code `SCHEMA_OUTDATED`; the existing `console.error(\`[store ${err.code}] ${err.message}\`)` already logs the body (which names the column). i18n:
  - en `"err.SCHEMA_OUTDATED": "The database needs an update — ask the admin to run the latest migrations"`
  - lo `"err.SCHEMA_OUTDATED": "ຖານຂໍ້ມູນຕ້ອງອັບເດດ — ແຈ້ງແອັດມິນໃຫ້ລັນ migration ລ່າສຸດ"`

  GO-LIVE: 5-line section with the Step 1 query, the Step 2 order and the `notify pgrst` line.

- [ ] **Step 6: Run** `npm test && npm run typecheck` — Expected: all PASS.

- [ ] **Step 7: Commit** `fix: name a missing migration instead of "Something went wrong"` (body: Step 1 result).

---

### Task 2: Add several SKUs to a case in one request

**Files:**
- Modify: `src/routes/stock.ts:632-666` (`POST /stock/desk/:deskId/sku`)
- Modify: `public/js/api.js:90` (add `addDeskSkus`)
- Test: `test/api.test.ts` (new `describe("add SKUs in a batch")` next to the tests at ~line 275)

**Interfaces:**
- Produces: request body `{ date, items: [{ sku_id: string, opening_qty?: number }] }` (1–200 items). The old body `{ date, sku_id, opening_qty }` keeps working (treated as `items: [{ sku_id, opening_qty }]`). Response `{ ok: true, added: number, restored: number }`.
- Produces (client): `api.addDeskSkus(deskId, { date, items })`.

- [ ] **Step 1: Write the failing tests** (demo store, `call()` helper, `MM-D01`, `TODAY`):
  - `items: [{sku_id:"SP-904"},{sku_id:<another active SKU not on MM-D01>}]` → 200, `added === 2`, both rows appear in `GET /stock/desk/MM-D01?date=TODAY`.
  - on a desk with earlier days, any item with `opening_qty: 9` → 409 `OPENING_LOCKED`, **and no row from the batch was inserted**.
  - one unknown/inactive `sku_id` in the batch → 400 `BAD_SKU`, nothing inserted.
  - duplicate `sku_id` in `items` → one row (last `opening_qty` wins), `added === 1`.
  - batch re-includes an excluded row: remove `SP-904` (DELETE route), then batch `[SP-904, new SKU]` → `restored === 1`, `added === 1`.
  - `items: []` → 400 `BAD_SKU`; 201 items → 400 `BAD_SKU`.
  - the old single-SKU body still returns 200 (existing tests at lines 275/282/644 stay unchanged and green).

- [ ] **Step 2: Run** `npx vitest run test/api.test.ts -t "batch"` — Expected: FAIL.

- [ ] **Step 3: Implement.** Normalise to a `Map<sku_id, opening>`; validate every item (active SKU, `parseQty`) before any write; check `OPENING_LOCKED` once if any opening > 0; split into existing rows (patch `excluded:false` where excluded, count `restored`) and new rows (one `store.insertLedgerRows` call, count `added`). No `audit()` call: the route has none today and the ledger trigger already audits each inserted/patched row.

- [ ] **Step 4: Run** `npm test` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(api): add several SKUs to a case at once`.

---

### Task 3: Pure SKU grouping/selection helpers

**Files:**
- Create: `public/js/sku-groups.js`
- Test: `test/skuGroups.test.ts`

**Interfaces:**
- Produces:
  - `groupSkusByType(skus, types, weights) → Array<{ typeId: string|null, type: SkuType|null, items: Sku[] }>` — groups by `type_id`; group order = `type.sort_order` (then array order); SKUs with no/unknown type last as `typeId: null`; items ordered by weight `sort_order`, then `baht_weight`, then `productName`. Inactive types still form their group.
  - `filterSkus(skus, query) → Sku[]` — case-insensitive match on `name_lo`, `name_en`, `sku_id`; empty/blank query returns all.
  - `toggleSelection(selected: Set<string>, skuId) → Set<string>` — returns a new Set.
  - `skuSizeLabel(sku) → string` — `sku.weight_name` if set, else `"<baht_weight> Baht"` if `baht_weight > 0`, else `""`.

- [ ] **Step 1: Write the failing tests** covering each bullet above, including: a SKU with `type_id: null` lands in the last group; an inactive type keeps its SKUs; `toggleSelection` does not mutate its input; `filterSkus(skus, "  ")` returns all; Lao query `"ສາຍຄໍ"` matches `name_lo`.
- [ ] **Step 2: Run** `npx vitest run test/skuGroups.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `public/js/sku-groups.js` (no DOM; only import is `productName` from `./i18n.js`, already loaded in node by `test/i18n.test.ts`).
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(client): SKU grouping and selection helpers`.

---

### Task 4: Skeleton building blocks

**Files:**
- Create: `public/js/skeleton.js`
- Modify: `src/styles/input.css` (`@layer components`: `.skeleton`, `@keyframes kpv-shimmer`, reduced-motion rule)
- Uses the existing `settings.loading` key for the screen-reader label (no new key)
- Test: `test/skeleton.test.ts`

**Interfaces:**
- Produces (each returns an HTML string wrapped in `<div role="status" aria-busy="true">` with a `<span class="sr-only">` loading label; blocks use class `skeleton`):
  - `skeletonCards(n = 4)` — case cards (Daily Stock list, documents list)
  - `skeletonList(n = 6)` — icon + two text lines rows (users, SKU settings rows, history, closed days, about)
  - `skeletonGrid(n = 9)` — 3-column SKU card grid with one section header bar
  - `skeletonDashboard()` — row of 3 stat tiles, one chart block, 4 list rows
  - `skeletonTable(rows = 6, cols = 4)` — report/grid tables, document proposal table
  - `skeletonCalendar()` — 7×5 day cells
- CSS: `.skeleton { @apply rounded-lg bg-gray-200; background-image: linear-gradient(90deg, transparent, rgba(255,255,255,.6), transparent); background-size: 200% 100%; animation: kpv-shimmer 1.2s linear infinite; }` and `@media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }`.

- [ ] **Step 1: Write the failing tests:** each function returns a string containing `role="status"` and `aria-busy="true"`; `skeletonCards(3)` has exactly 3 card blocks (count a `data-skel-item` marker); `skeletonGrid(9)` has 9 and uses `grid-cols-3`; `skeletonTable(2,3)` has 6 cells.
- [ ] **Step 2: Run** `npx vitest run test/skeleton.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `skeleton.js` and the CSS; shapes mirror the real layouts' heights (case card ≈ the real card height, so the page does not jump when data arrives).
- [ ] **Step 4: Run** `npm test && npm run build:css` — Expected: PASS, CSS builds.
- [ ] **Step 5: Commit** `feat(client): skeleton loading blocks`.

---

### Task 5: Grouped, multi-select SKU grid picker

**Files:**
- Create: `public/js/views/sku-picker.js` — moves `renderSkuPickerInto`, `renderCreateSkuFormInto` and `PURITY_OPTIONS` use out of `public/js/views/stock.js:434-543`
- Modify: `public/js/views/stock.js` (delete the moved code, import from `./sku-picker.js`)
- Modify: `public/js/i18n.js` (new keys below)

**Interfaces:**
- Consumes: `groupSkusByType`, `filterSkus`, `toggleSelection`, `skuSizeLabel` (Task 3); `skeletonGrid` (Task 4); `api.skus()`, `api.skuTypes()`, `api.skuWeights()`.
- Produces: `renderSkuPickerInto(container, { excludeSkuIds: string[], onAdd: (skus: Sku[]) => void, onCancel: () => void })`. `onAdd` receives full SKU objects in grid order. `openSkuPickerSheet` is removed from `stock.js`; Task 6 replaces its callers.

**Layout (decided):**
- Top, sticky inside `#sheet-body` (`sticky top-0 z-10 bg-white -mx-5 px-5 pb-2`): `← Back` + (admin) small "+ New SKU" text button on one line; a search input; a horizontally scrolling chip row, one chip per non-empty type group: `productName(type)` + count. Tapping a chip scrolls its section to the top of `#sheet-body` (`scrollIntoView({ block: "start" })` with `scroll-margin-top` = sticky header height). An `IntersectionObserver` (root = `#sheet-body`) marks the chip of the section in view as active and scrolls that chip into view in the chip row.
- Body: one section per group: header `productName(type) · count` (`text-[11px] font-extrabold uppercase text-gray-500`), then `grid grid-cols-3 gap-2`.
- Card (`button`, `aria-pressed`): small type icon top-left, name `productName(name_en, name_lo)` in `text-xs font-bold leading-snug break-words line-clamp-3` (no truncate), size `skuSizeLabel` below in `text-[10px] text-gray-500`; selected = `border-2 border-brand-600 bg-brand-50` + check badge top-right; min-height 84px.
- SKUs already on the case (`excludeSkuIds`) are shown greyed and disabled with a "In case" tag (not hidden), so staff see why one is missing.
- Bottom, sticky (`sticky bottom-0 -mx-5 px-5 py-3 bg-white border-t`): `btn-primary w-full` "Add (N)" / disabled "Select SKUs" when N = 0; a "Clear" text button when N > 0.
- Search filters cards with `filterSkus`; selection is kept for hidden cards; empty sections and their chips hide.
- Admin "+ New SKU" opens the create form (moved, unchanged fields); on success the new SKU is added to the selection and the grid re-renders with it ticked.
- Before data arrives: `skeletonGrid()`.
- i18n (lo/en): `picker.searchPlaceholder` "ຄົ້ນຫາ SKU…"/"Search SKU…", `picker.addN` "ເພີ່ມ ({n})"/"Add ({n})", `picker.selectSome` "ເລືອກ SKU"/"Select SKUs", `picker.clear` "ລ້າງ"/"Clear", `picker.inCase` "ມີໃນຕູ້ແລ້ວ"/"In case", `picker.newSku` "+ SKU ໃໝ່"/"+ New SKU". Check how `t()` interpolates (`{n}` vs other) in `i18n.js` and follow it.

- [ ] **Step 1: Implement** `public/js/views/sku-picker.js` per the layout above and remove the moved code from `stock.js` (temporarily keep `openSkuPickerSheet` compiling by adapting it to call `onAdd` with `skus[0]` — Task 6 replaces it).
- [ ] **Step 2: Verify in the browser:** `npm run dev`, log in as the demo admin, viewport 430×900. Check: types appear as sections in type order; chip tap jumps to the section; scrolling updates the active chip; long Lao names wrap to ≤3 lines without overflow; select 3 → search hides 2 → clear search → still 3 ticked, button "Add (3)"; no horizontal page scroll; keyboard: Tab reaches cards and Space toggles.
- [ ] **Step 3: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 4: Commit** `feat(client): grouped multi-select SKU grid picker`.

---

### Task 6: Use the picker in "Create case" and "Case > Add SKU"

**Files:**
- Modify: `public/js/views/stock.js:406-433` (`askOpeningQty` → `askOpeningQtys`), `:545-641` (`openCreateCaseSheet`), `:385-395` (`dayHooks`)
- Modify: `public/js/views/day/index.js:575-590` (`openMenu` "add" branch)
- Modify: `public/js/i18n.js` (keys below)

**Interfaces:**
- Consumes: `renderSkuPickerInto` (Task 5), `api.addDeskSkus` (Task 2).
- Produces: hook `openSkuPicker(excludeSkuIds, onAdd: (skus: Sku[]) => void)` (replaces the single-SKU `onPick`); `askOpeningQtys(skus: Sku[]) → Promise<Map<sku_id, number> | null>` (null when the sheet is closed without confirming).

**Behaviour (decided):**
- **Create case:** picker `onAdd` appends every chosen SKU to `rows` (opening 0) and returns to the form, focusing the first new opening input. The form's SKU rows are grouped under the same type headers (`groupSkusByType` on the rows' SKUs) with a header line "N SKUs · total pcs"; each row keeps icon, full name (wraps, no truncate), size, opening input, remove ×. The submit button stays `create-case-submit`; disable it and show "Creating…" while the request runs, re-enable on error (today a double tap can create two cases).
- **Add SKU on an open case:** first day (`detail.isFirstDay`) → `askOpeningQtys(skus)` sheet: one row per SKU (name, size, number input default 0, Enter moves to next), confirm button "Add (N)"; closing it adds nothing. Not first day → no prompt, opening 0. Then one `api.addDeskSkus(deskId, { date, items })` call and `hooks.reload()`; toast `picker.addedN` "ເພີ່ມ {n} SKU ແລ້ວ"/"Added {n} SKUs".

- [ ] **Step 1: Implement** the changes above; delete the single `askOpeningQty`.
- [ ] **Step 2: Verify in the browser** (demo data): create a case with 5 SKUs from 3 types → rows grouped, openings typed, case created with those openings. On that case today (its first day) add 2 SKUs → prompt lists both → opening saved. On a case with an earlier day add 2 SKUs → no prompt, rows appear with opening 0. Double-tap "Create case" → one case.
- [ ] **Step 3: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 4: Commit** `feat(client): pick several SKUs at once when creating or filling a case`.

---

### Task 7: Settings > SKU — collapsible type groups

**Files:**
- Modify: `public/js/views/settings/sku.js:211-330` (`renderSkuTab`, `renderSkuList`)
- Modify: `public/js/i18n.js` (`settings.expandAll` "ເປີດທັງໝົດ"/"Expand all", `settings.collapseAll` "ຫຍໍ້ທັງໝົດ"/"Collapse all")

**Interfaces:**
- Consumes: `groupSkusByType` (Task 3), `skeletonList` (Task 4).

**Behaviour (decided):**
- Each group header becomes a full-width `button` (`aria-expanded`, `aria-controls`): chevron (rotates 90° when open), `productName(type.name_en, type.name_lo)` (today it shows the English `type_name`), count pill; tapping toggles that group's card.
- Default: all groups **collapsed** (212 SKUs → a short list of types). State kept in a module-level `Set` of open type ids for the session (survives toggling an SKU switch and re-render).
- While a search query or a Group/Size filter is active, every matching group is shown open (the stored state is not changed).
- One text button "Expand all"/"Collapse all" at the right of the count line; the Group `<select>` stays (it filters; the headers navigate).
- Replace `renderSkuList`'s own grouping with `groupSkusByType`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify in the browser:** groups start collapsed; tap opens/closes with chevron; toggling an SKU's active switch keeps the open groups open; typing a search opens matching groups; clearing it restores the previous open set; Lao type names shown.
- [ ] **Step 3: Run** `npm test && npm run typecheck` — Expected: PASS.
- [ ] **Step 4: Commit** `feat(settings): collapse and expand SKU type groups`.

---

### Task 8: Skeletons in every loading spot

**Files (each line: location → skeleton):**
- `public/js/views/stock.js:127` calendar → `skeletonCalendar()`; `:157` case cards → `skeletonCards()`
- `public/js/views/day/index.js:87-90` `mountDay` — render `skeletonTable(8, 4)` into the day list host before `await api.deskDetail` (today the old screen stays frozen with no feedback)
- `public/js/views/day/history.js:199, 269` → `skeletonList(4)`
- `public/js/views/dashboard.js:141` → `skeletonDashboard()`
- `public/js/views/documents.js:143` → `skeletonCards(4)`; `:891` → `skeletonTable(5, 3)`
- `public/js/views/report.js:107` → `skeletonTable(8, 5)`; `:163` grid body → `skeletonTable(8, 5)`
- `public/js/views/settings/about.js:6`, `closed-days.js:16`, `users.js:15` → `skeletonList()`; `replenishment.js:40` → `skeletonTable(6, 4)`; `sku.js:55` → `skeletonList(8)`
- Leave as text: `settings/audit.js:98` "load more" status and `replenishment.js:276/293` preview line (inline status lines, not page loads).

- [ ] **Step 1: Replace each placeholder** listed above; remove i18n keys that become unused (`dashboard.loading`, `documents.loading`, `report.loading`, `stock.loadingDesks`, `documents.proposalLoading`) only if `grep` shows no other use.
- [ ] **Step 2: Verify in the browser** with DevTools network throttling "Slow 4G": every listed screen shows a skeleton of its own shape, no "Loading…"/"Calculating…" text remains (`grep -rn "Loading…\|loading\")" public/js/views` returns only the two kept spots), no layout jump larger than one row when data arrives, and with OS "reduce motion" on the shimmer is still.
- [ ] **Step 3: Run** `npm test && npm run typecheck` — Expected: PASS (`test/i18n.test.ts` catches removed keys still in use).
- [ ] **Step 4: Commit** `feat(client): skeleton loading on every screen`.

---

## Release order

1. Owner runs Task 1 Steps 1–2 in Supabase **before** anything is pushed (this alone should unblock case and user creation on the live app today).
2. Push `main` after Task 8 (Workers Builds deploys). No new migration is needed by Tasks 2–8.
