# Per-branch SKU values, roles and xlsx import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Branch users run their own SKU numbers (avg sell/day, lead time, which SKUs the branch carries), everyone can export/import SKUs as .xlsx with Lao text, and the app is renamed "KPV Stock Tracking".

**Architecture:** The SKU catalogue (`master_sku`) stays company-wide. The per-branch data is two things. First, `replenishment_rule` rows with a `branch_id`: the column already exists, and company rules (`branch_id is null`) are retired. Second, a new `branch_sku` table holds the "carries" switch. The browser reads and writes the .xlsx with vendored SheetJS. The Worker receives parsed rows as JSON on the existing `/skus/import` route, so it never handles the binary file. Permissions are enforced twice: in the Hono routes, and again in the Postgres guard triggers in `supabase/users_roles.sql`.

**Tech Stack:** Cloudflare Worker + Hono, Supabase Postgres (PostgREST), vanilla ES modules in `public/js`, vitest (+ PGlite for SQL), SheetJS Community Edition 0.20.3 (vendored file).

**Spec:** memory note `roles-branch-sku-decisions` (owner decisions, 2026-11-17, grilling session). It supersedes the "company-wide rules, admin only" part of `sku-simplify-decisions`. The Lao manual `ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html` is the user-facing spec and is updated in Task 9.

## Global Constraints

- Roles stay `staff | manager | admin`. Manager = staff + unlock staff accounts, reopen a Done day, edit recent past days. Nothing else is manager-only.
- Staff and manager see and write only their own `branch_id`. A non-admin who sends another `branchId` gets their own branch (`scopeBranch`) on reads and `403 BRANCH_DENIED` on writes.
- Only admin may rename an SKU, change its type or size, deactivate it, or create/edit Types and Sizes (`sku_type`, `sku_weight`).
- There is no company-wide rule after migration 15. `resolveParams` reads only rules whose `branch_id` equals the branch being computed: SKU rule, then Type rule, then auto velocity / `default_lead_time_days`.
- A missing `branch_sku` row means **not carried**. Migration 15 seeds `carried = true` for every (branch, SKU) pair.
- A SKU created by a staff or manager is carried in their branch only. A SKU created by an admin is carried in every branch. (Assumption: the owner decided only the branch-user case. Confirm when reviewing this plan.)
- A row in a confirmed import turns `carried` on for that SKU in that row's branch.
- Switching `carried` off when the branch's on-hand stock or inbound transfers for that SKU are above 0 → `409 STOCK_HELD`.
- App shell name, exactly: `KPV Stock Tracking` (all UI languages). Printed document sheets and the Lao manual's `<title>`/`<h1>` keep their current text.
- xlsx header row, exactly (column order fixed; the parser matches by the text after ` / `, case-insensitive):
  `ລະຫັດ SKU / sku_id` · `ຊື່ສິນຄ້າ* / name` · `ປະເພດ* / type` · `ນ້ຳໜັກ (ກຣາມ)* / grams` · `ຂາຍສະເລ່ຍ/ມື້ / avg_daily_sell` · `ໄລຍະສັ່ງ (ມື້) / lead_time_days` · `ສາຂາ / branch_id` · `ນ້ຳໜັກ (ລາວ) / size_lo`
- `size_lo` is export-only and is ignored on import. `branch_id` is filled only in an admin "all branches" export, and it is required only in an all-branches import.
- `grams` must equal an existing `sku_weight.gram_value` within 0.001. An unknown type or size is a row error, never a new Type or Size.
- Import: at most 500 rows (`MAX_IMPORT_ROWS`). Any error row blocks the whole import (`422 IMPORT_INVALID`). It never deletes or deactivates anything.
- For a non-admin, changes to name, type or size of an existing SKU are ignored, never an error. The preview lists each ignored cell.
- The CSV import is removed: `public/js/csv.js`, its UI and its template. The files in `sku-import/*.csv` stay as they are.
- Every DB change ships as an idempotent migration `supabase/migrations/20261117_15_branch_sku.sql`, plus guard changes in `supabase/users_roles.sql`. Fresh-project order: `schema.sql -> migrations/* -> users_roles.sql -> base.sql`.
- Work on `main`; commit per task; do not deploy (live Worker is on a different Cloudflare account).

## Review Focus

1. **A staff user edits a URL or a request body to reach another branch.** Expect 403 on writes, and only their own branch's rows on reads. → test in Task 4 (`staff cannot write another branch's rule`) and in Task 5 (`staff import is forced to own branch`).
2. **A Lao text cell that Excel stored as a shared string or rich text, or with trailing spaces or a non-breaking space.** The name and type must still match. → test in Task 8 (`sheetRowsToImport trims and reads rich text`).
3. **Excel stores grams as a float (`0.9999999`) or as text (`"15.244"`).** Expect a match within 0.001. → test in Task 6 (`grams from float and text match the size`).
4. **The same SKU code appears twice in one file, or one sheet holds rows for two branches when it was imported as one branch.** Expect a row error naming both lines. → test in Task 6 (`duplicate code is an error`, `branch_id mismatch is an error`).
5. **A carried-off SKU still has a transfer on the way to that branch.** The switch must refuse, and the reorder row must still show. → test in Task 3 (`carried off but inbound still shows`) and Task 5 (`carried off refused while inbound`).

---

### Task 1: Rename the app to "KPV Stock Tracking"

**Files:**
- Modify: `public/index.html:6-7`, `index.html:7`, `public/manifest.webmanifest:2-3`, `package.json` (`description`), `public/js/i18n.js` (`login.subtitle` Lao line 102 and English line 817)
- Test: `test/appName.test.ts` (new)

- [ ] **Step 1: Write the failing test** `test/appName.test.ts`: read each file above as text. Assert none of them contains `Goldsmith & Retail Inventory`, `Goldsmith &amp; Retail Inventory` or `KPV Inventory`. Assert `public/index.html` contains `<title>KPV Stock Tracking</title>`. Assert the manifest JSON has `name === "KPV Stock Tracking"` and `short_name === "KPV Stock"`. Assert both `login.subtitle` strings start with `KPV Stock Tracking — `.
- [ ] **Step 2: Run** `npx vitest run test/appName.test.ts` → FAIL.
- [ ] **Step 3: Edit the strings.** Meta description: `KPV Stock Tracking — daily stock, documents, dashboard and reporting for gold cases.` Lao subtitle: `KPV Stock Tracking — ໃສ່ຊື່ຜູ້ໃຊ້ ແລະ ລະຫັດຜ່ານຂອງທ່ານ`. English subtitle: `KPV Stock Tracking — enter your username and password`.
- [ ] **Step 4: Run** `npx vitest run test/appName.test.ts test/i18n.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: rename app to KPV Stock Tracking`.

---

### Task 2: Migration 15 + guards (per-branch rules, `branch_sku`, who may write)

**Files:**
- Create: `supabase/migrations/20261117_15_branch_sku.sql`
- Modify: `supabase/users_roles.sql` (`guard_master_data` for `master_sku`; `guard_replenishment_rule`; new `guard_branch_sku`)
- Test: `test/sql/branch_sku.test.ts` (new), `test/sql/roles.test.ts` (extend)

**Interfaces:**
- Produces table `branch_sku (branch_id text references branches, sku_id text references master_sku on delete cascade, carried boolean not null default true, updated_at timestamptz not null default now(), primary key (branch_id, sku_id))`.

- [ ] **Step 1: Write failing migration test** in `test/sql/branch_sku.test.ts`. Model it on `test/sql/sku_simplify.test.ts`: use `freshDb({ upTo: '20261117_14_sku_simplify', withBase: true })`. Seed company rules `('sku','NK-1',null,1.5,7)` and `('type','GOLD_BARS',null,1,null)`, plus an existing branch rule `('sku','NK-1','B-MM',9,null)`. Run the migration twice. Assert:
  - every active branch has a copy of each company rule;
  - the B-MM rule for NK-1 keeps `avg 9` and gains `lead 7`, because an existing branch value wins and only a blank field is filled;
  - no rule has `branch_id is null`;
  - `branch_sku` has `count = branches × skus`, all `carried`;
  - the second run changes nothing.
- [ ] **Step 2: Write failing guard tests** in `test/sql/roles.test.ts`, in a new `describe('branch values guard')`. Use the existing actor helpers in that file.
  - Staff of B-MM may insert a B-MM rule and a B-MM `branch_sku` row.
  - Staff of B-MM gets `ROLE_DENIED` on a B-VT rule.
  - Staff may insert into `master_sku`.
  - Staff gets `ROLE_DENIED` on `update master_sku set name_lo=...` and on `insert into sku_type`.
  - Admin may do all of the above.
- [ ] **Step 3: Run** `npm run test:sql` → new tests FAIL.
- [ ] **Step 4: Write the migration.** Do this in order:
  1. Run `create table if not exists branch_sku`.
  2. Fill blank fields of existing branch rules from the matching company rule.
  3. Insert the missing (branch × company rule) copies with `on conflict do nothing` semantics, using `not exists`, the same way migration 14 does.
  4. Run `delete from replenishment_rule where branch_id is null`.
  5. Insert every (active branch × SKU) pair into `branch_sku` with `on conflict do nothing`.

  Header comment: copy the style of migration 14 and say what it decides.
- [ ] **Step 5: Change the guards.**
  - `guard_replenishment_rule`: `branch_id is null` → `{admin}`; otherwise → `{admin,manager,staff}` with that branch, for both old and new.
  - `guard_master_data` on `master_sku`: allow INSERT for `{admin,manager,staff}`. Keep UPDATE and DELETE as `{admin}`. Keep `sku_type`, `sku_weight` and `system_config` as `{admin}`.
  - New `guard_branch_sku`: `{admin,manager,staff}` of `coalesce(new.branch_id, old.branch_id)`. Add trigger `trg_guard_branch_sku`.
  - Grant the same table privileges to `branch_sku` that `replenishment_rule` has.
- [ ] **Step 6: Run** `npm run test:sql` → PASS (all SQL tests).
- [ ] **Step 7: Commit** `feat(db): per-branch rules and branch_sku carries switch`.

---

### Task 3: Engine + Store read per-branch values and `carried`

**Files:**
- Modify: `src/types.ts` (add `BranchSku`), `src/store.ts` (`Store`, `DemoStore`, `SupabaseStore`), `src/demoData.ts` (seed `branchSkus`: all carried; demo rules move to branch rules), `src/replenishment.ts`
- Test: `test/replenishment.test.ts`

**Interfaces:**
- Produces: `interface BranchSku { branch_id: string; sku_id: string; carried: boolean }`
- Produces on `Store`: `branchSkus(filter?: { branchId?: string }): Promise<BranchSku[]>` and `setCarried(rows: BranchSku[]): Promise<void>` (upsert on the primary key).
- Changes: `resolveParams(sku, rules, config, autoAvg, branchId: string)` matches only `r.branch_id === branchId`.
- Produces: `export function heldBySku(latestRows: LedgerRow[], latestDays: DeskDay[], desks: Desk[], inTransit: Transfer[], branchId: string): Map<string, { onHand: number; inbound: number }>`. Extract it from the start of `buildBranchRows`, which then uses it.
- Changes: `buildBranchRows` input gains `carried: Set<string>` (SKU ids carried by the branch). A SKU that is not carried and has `position <= 0` gets no row.

- [ ] **Step 1: Failing tests** in `test/replenishment.test.ts`:
  - `resolveParams uses only the branch's rules`: a B-MM rule `avg 2` and a B-VT rule `avg 5`. For B-MM, expect 2 with source `sku`. A rule with a `null` branch is ignored and gives source `auto`.
  - `carried off but inbound still shows`: not carried, onHand 0, inbound 3 → a row exists.
  - `carried off and empty is hidden`.
- [ ] **Step 2: Run** `npx vitest run test/replenishment.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Update `resolveParams`, `heldBySku` and `buildBranchRows`. `loadBranchRows` and `loadBranchStatuses` fetch `store.branchSkus({ branchId })` and pass `carried`. DemoStore keeps `db.branchSkus`. SupabaseStore reads `branch_sku?select=*&branch_id=eq.X`, and `setCarried` POSTs with `Prefer: resolution=merge-duplicates`. Update the header comment of `resolveParams`: the precedence was "decided 2026-11-17" and is now per-branch.
- [ ] **Step 4: Run** `npm test` → PASS. Existing tests that relied on company rules must be moved to branch rules, not deleted.
- [ ] **Step 5: Commit** `feat: reorder engine reads per-branch values and carried SKUs`.

---

### Task 4: Rules API per branch, open to every role

**Files:**
- Modify: `src/routes/replenishment.ts`
- Test: `test/replenishment.api.test.ts`

**Interfaces:**
- `GET /replenishment/rules?branchId=`: `branchId = scopeBranch(user, query)`. Required, so an admin with none gets `400 BRANCH_REQUIRED`. Returns that branch's sku/type rules.
- `PUT /replenishment/rules` body `{ scope, key, branchId, avgDailySell, leadTimeDays, allBranches? }`.
- `POST /replenishment/rules/bulk` takes the same `branchId` / `allBranches?`.
- `allBranches: true` is admin only (`403 ROLE_DENIED` otherwise). It writes the same value into every active branch.
- Non-admin with `branchId` ≠ own → `403 BRANCH_DENIED` (use `assertBranchAccess` from `src/auth.ts`).
- Audit target: `${scope}:${key}@${branchId|"*"}`.

- [ ] **Step 1: Failing tests:**
  - `staff sets own branch rule` → 200, and `GET /replenishment?branchId=B-MM` reflects it with source `sku`.
  - `staff cannot write another branch's rule` → 403 `BRANCH_DENIED`.
  - `staff cannot use allBranches` → 403.
  - `admin allBranches writes every branch`.
  - `bulk type set-all stays inside one branch`: the B-VT SKU rules are untouched.
- [ ] **Step 2: Run** `npx vitest run test/replenishment.api.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Drop `requireAdmin`. Every `branch_id: null` becomes the resolved branch, or a loop over the branches. Update the file's header comment.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(api): reorder values per branch, editable by branch users`.

---

### Task 5: SKU API — branch users add SKUs, set their values, switch carried

**Files:**
- Modify: `src/routes/settings.ts` (`/skus` routes, `writeSkuRule`)
- Test: `test/api.test.ts` (new `describe("SKU per branch")`)

**Interfaces:**
- `writeSkuRule(store, skuId, branchIds: string[], avg, lead)`.
- `GET /skus?branchId=`: each SKU gains `carried: boolean` and `plan: { avg: number|null, lead: number|null }`, taken from that branch's SKU rule. `branchId = scopeBranch(...)`. An admin with no branchId gets `carried: null, plan: null`.
- `POST /skus`: any role. Non-admin → carried and rule in own branch only. Admin → carried in every active branch, and a rule only if `branchId` or `allBranches` is given.
- `PATCH /skus/:id`: `name`, `type_id`, `weight_id`, `active` → admin only, else `403 ROLE_DENIED`. `avg_daily_sell` / `lead_time_days` → any role, with `branchId` (non-admin forced to own) or admin `allBranches`.
- New `PUT /skus/:id/carried` body `{ branchId, carried }`. Turning it off with `heldBySku` onHand+inbound > 0 → `409 STOCK_HELD`. Audit `sku.carried`.
- `sku-types` and `sku-weights` writes stay `requireAdmin`.

- [ ] **Step 1: Failing tests:**
  - `staff creates SKU carried only in own branch`.
  - `admin creates SKU carried everywhere`.
  - `staff rename is refused` → 403.
  - `staff sets own avg; other branch unchanged`.
  - `carried off refused while stock held` → 409 `STOCK_HELD`, using a demo SKU with stock in B-MM.
  - `carried off refused while inbound` → put a transfer in transit to the branch, then expect 409.
  - `carried off allowed at zero` → 200, and the SKU then has `carried: false` in `GET /skus?branchId`.
- [ ] **Step 2: Run** `npx vitest run test/api.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `src/routes/settings.ts`. Update the file header comment: "every change is admin only" is no longer true.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(api): branch users add SKUs and run their own values`.

---

### Task 6: Import/export API (replaces CSV import)

**Files:**
- Modify: `src/routes/settings.ts` (`POST /skus/import`, new `GET /skus/export`)
- Test: `test/skuImport.api.test.ts` (new)

**Interfaces:**
- `GET /skus/export?branchId=<id>|all` returns `{ rows: ExportRow[] }`. `all` is admin only. Non-admin gets their own branch. A branch export includes only carried SKUs. `all` gives one row per (carried branch, SKU).
  `ExportRow = { sku_id, name, type: string /* type name_lo || name_en */, grams: number|null, avg_daily_sell: number|null, lead_time_days: number|null, branch_id: string|null /* only for all */ }`
- `POST /skus/import` body `{ branchId: string | "all", fileName: string, rows: ImportRow[], dryRun: boolean }`. `ImportRow` has the same keys as `ExportRow`, all values unknown. `branchId: "all"` is admin only, and each row needs `branch_id`.
- The response is the same for dryRun and commit:
  `{ created: number, updated: number, unchanged: number, ignored: { line: number, field: "name"|"type"|"grams" }[], errors: { line: number, error: string }[] }`.
  `line` = sheet row number (header is row 1). Any error → `422 IMPORT_INVALID` with `{ errors }`, and nothing is written.
- Row rules:
  - Blank `sku_id` → new SKU (id from `newSkuId()`).
  - Known `sku_id` → update.
  - Unknown non-blank `sku_id` → error `unknown sku_id X`. A code can only come from an export.
  - The same `sku_id` twice in one branch → error naming both lines.
  - In a single-branch import, a non-blank `branch_id` that differs from the branch → error.
- Type matches `name_lo` or `name_en` (trimmed, case-insensitive). Size matches `grams` against `sku_weight.gram_value` within 0.001. `Number(String(x).trim())` accepts text.
- Commit:
  - creates the new SKUs (one `createSkus` call);
  - applies admin-only fields for an admin;
  - writes the branch rules;
  - sets `carried = true` for every row's (branch, SKU).

  Audit: `sku.import_row` per created/updated SKU with `{ branch_id, before, after }`, then one `sku.import` with `{ fileName, branchId, created, updated, unchanged }`.

- [ ] **Step 1: Failing tests:**
  - `dry run previews and writes nothing`.
  - `commit creates and updates`.
  - `one bad row imports nothing`.
  - `unknown type is an error`.
  - `grams from float and text match the size` (`15.2439999`, `" 15.244 "`).
  - `duplicate code is an error`.
  - `branch_id mismatch is an error`.
  - `staff import is forced to own branch`: body `branchId: "B-VT"` → 403 `BRANCH_DENIED`.
  - `staff name change is ignored and listed`.
  - `staff cannot import all`.
  - `export only carried SKUs`.
  - `audit has one row per SKU plus a summary`.
- [ ] **Step 2: Run** `npx vitest run test/skuImport.api.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Reuse `buildSku` and `planNumbers`. Weight lookup by grams replaces lookup by weight name for import. Delete the old CSV-shaped route body.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(api): SKU import/export per branch with preview`.

---

### Task 7: Client — SKU screen and picker per branch and role

**Files:**
- Modify: `public/js/views/settings/sku.js`, `public/js/views/sku-picker.js`, `public/js/api.js`, `public/js/i18n.js` (Lao + English keys)
- Test: `test/i18n.test.ts` (new keys exist in both languages); manual check in `npm run dev`

**Interfaces:**
- Consumes: Tasks 4-6 routes.
- `api.js` adds `skus({ branchId })`, `setCarried(skuId, branchId, carried)`, `exportSkus(branchId)`, `importSkus({ branchId, fileName, rows, dryRun })`. It also updates `putRule` and `bulkRule` to send `branchId` / `allBranches`.

- [ ] **Step 1:** Replace `canEdit = () => isAdmin(state.user)` with two helpers: `canEditCatalogue()`, which is admin, and `canEditBranch()`, which is any logged-in user.
  - Admin sees a branch select at the top of the SKU tab. It defaults to the first branch, and the choice is remembered in `state`. Non-admin users are fixed to their own branch.
  - Each SKU row gets the carries `toggleSwitch`. On `STOCK_HELD`, show the toast `settings.carriedHeld`.
  - Non-admin users don't see the name, type and size fields or the deactivate control. The Type and Size tabs are read-only for them.
  - The avg/lead sheet and Type set-all sheet gain an admin-only checkbox `settings.applyAllBranches`.
  - Non-admin users see only carried SKUs. Admin sees all SKUs with each one's carried state.
- [ ] **Step 2:** In `sku-picker.js`, offer only SKUs carried by the case's branch. "Create SKU" is shown to every role.
- [ ] **Step 3:** Add i18n keys in Lao and English: `settings.carried` (ລາວ: `ສາຂານີ້ມີຂາຍ`), `settings.carriedHeld` (`ຍັງມີສະຕັອກ ຫຼື ກຳລັງໂອນມາ — ປິດບໍ່ໄດ້`), `settings.applyAllBranches` (`ໃຊ້ກັບທຸກສາຂາ`), `settings.branchPick` (`ສາຂາ`).
- [ ] **Step 4: Run** `npm test` → PASS. Then `npm run dev`, log in as staff, as manager and as admin, and check each bullet in Step 1.
- [ ] **Step 5: Commit** `feat(client): SKU settings per branch and role`.

---

### Task 8: Client — xlsx export/import with Lao text

**Files:**
- Create: `public/js/vendor/xlsx.full.min.js` (SheetJS CE 0.20.3, from `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`; put a comment line at the top with version + URL), `public/js/sku-xlsx.js`
- Delete: `public/js/csv.js` and its import/use in `sku.js`
- Modify: `public/js/views/settings/sku.js` (import sheet → xlsx), `public/js/i18n.js`
- Test: `test/skuXlsx.test.ts` (new; imports `public/js/sku-xlsx.js` the way `test/saveQueue.test.ts` imports client modules)

**Interfaces:**
- `export const SKU_HEADERS: string[]`: the 8 header strings from Global Constraints, in order.
- `export function exportRowsToSheet(rows: ExportRow[], sizeLabel: (grams) => string): (string|number|null)[][]`: header row plus one row per SKU. The `size_lo` column is filled with `sizeLabel(grams)` (pass `weightLabel` from `sku-groups.js`).
- `export function sheetRowsToImport(aoa: unknown[][]): { rows: ImportRow[]; error: string|null }`. It finds columns by the header key after ` / `, so reordered columns still work. A missing required header (`name`, `type`, `grams`) → `error: "missing column <key>"`. Each cell becomes a trimmed string; NBSP becomes a space; a rich-text cell object `{ t, v, r }` uses `v`. Fully blank rows are skipped, but line numbers keep the sheet row.
- `export async function loadXlsx(): Promise<XLSX>`: injects the vendored script once and resolves `window.XLSX`.

- [ ] **Step 1: Failing tests:**
  - `headers are exact`.
  - `export puts Lao size label`.
  - `sheetRowsToImport maps by header text`.
  - `sheetRowsToImport trims and reads rich text`: cells `"ຄຳແທ່ງ  "` and `{ v: "ສາຍຄໍ", r: "<r>…" }`.
  - `blank rows skipped, line numbers kept`.
  - `missing grams column is an error`.
- [ ] **Step 2: Run** `npx vitest run test/skuXlsx.test.ts` → FAIL.
- [ ] **Step 3: Implement** `sku-xlsx.js`. Then the sheet in `sku.js`, which every role sees:
  - **Export:** `XLSX.utils.aoa_to_sheet` → `XLSX.writeFile(wb, "kpv-sku-<branch|all>-<date>.xlsx")`. SheetJS writes UTF-8 shared strings, so Lao text stays intact.
  - **Template:** the same export with zero data rows.
  - **Import:** `XLSX.read(await file.arrayBuffer())` → first sheet → `sheet_to_json(ws, { header: 1, raw: true, defval: null })` → `sheetRowsToImport` → `importSkus({ dryRun: true })`. Then show the preview: counts, ignored cells, errors per line. The Confirm button sends `dryRun: false`. It is disabled while there are errors.
  - Admin gets a branch-or-"all" select for export and import.
  - `accept=".xlsx"`.
- [ ] **Step 4: Run** `npm test`, then `npm run dev`. Export, open the file in Excel, and check that the Lao text is correct. Edit one name, add one row, and re-import. The preview must show 1 created and 1 updated. Confirm, then check the list.
- [ ] **Step 5: Commit** `feat(client): SKU xlsx export/import replaces CSV`.

---

### Task 9: Branch-scoped reports check + Lao manual + docs

**Files:**
- Test: `test/api.test.ts` (new `describe("branch scope")`)
- Modify (only if a test fails): `src/routes/insights.ts`, `src/routes/audit.ts`, `src/routes/stock.ts`
- Modify: `ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html` (line 159 subtitle → `KPV Stock Tracking · ສຳລັບ ພະນັກງານສາຂາ ແລະ ເຈົ້າຂອງ / ແອດມິນ`; role table; SKU section: per-branch values, carries switch, xlsx import/export steps), `app.md`, `PRODUCT.md`, `README.md` (name + roles)

- [ ] **Step 1: Failing or pinning tests:**
  - `staff dashboard only has own branch`.
  - `manager report only has own branch`.
  - `staff audit only has own branch`.
  - `admin dashboard reorder count = sum of per-branch counts`: give B-MM and B-VT different avg rules for the same SKU, and check that each branch status follows its own rule.
- [ ] **Step 2: Run** `npm test`. Fix only the routes whose test fails.
- [ ] **Step 3: Update the manual and docs.** Manual: the `<title>` and `<h1>` stay unchanged. Write in the manual's existing Lao style, and use the screen words from Task 7 so the manual matches the UI.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run test:sql` → all PASS.
- [ ] **Step 5: Commit** `docs: manual and docs for branch SKU values, roles, xlsx import`.
