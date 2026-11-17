# Lao Guidebook from a Live Test Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test the live KPV Stock Tracking site with one small, fenced-off scenario (case, stock in/out, move, adjust, check-in, routine, SKU, user, reports), screenshot every step, and rebuild the Lao guidebook `ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html` in its existing style from those screenshots. Then remove every test row.

**Architecture:** Playwright (`playwright-core` driving the installed Chrome, phone viewport) runs the scenario on production in small stage scripts that check state before writing, so a re-run never double-posts. Everything the test creates is named `TEST …`; right after creation the two test cases and the test SKU are tagged `is_seed` by SQL, so every later row and audit entry on them inherits the tag and the existing `supabase/purge_seed_data.sql` deletes them at the end. The guidebook is a source HTML with `shots/*.jpg` references; a build script inlines them as base64 into the single self-contained file at the repo root, like today's file.

**Tech Stack:** Node ESM scripts, `playwright-core` (system Chrome, `channel: "chrome"`), Supabase SQL editor, PGlite (`test/sql`) for the SQL tests, vitest.

**Spec:** The owner's request (2026-11-17): "create the updated guidebook of the current web app design in Lao text, in the existing style of the guidebook .html; our web is on production with real numbers; first test the web app with a simple scenario — Stock Tracking, Case creating, Stock move, stock adjust, how to check in, how the routine works, SKU set up, user set up, how to read the reporting and what reporting shows — so there is data, then snapshot the screens for the guidebook." Owner chose to test on the **live production site** (asked 2026-11-17). Style reference: the current `ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html` (commit 8bc3f5b). Facts about current behaviour: README.md, docs/GO-LIVE.md §5–§11, and memories `lao-manual-is-spec`, `stock-grid-move-decisions`, `sku-simplify-decisions`, `roles-branch-sku-decisions`, `branch-vtc-sku-names`.

## Global Constraints

- Branch: commit straight to `main`; no branches, no PRs. Commit only the files a task names. Do not push unless the owner asks (a push to `main` deploys).
- Production safety: every object the test creates has a name starting with `TEST ` (cases `TEST ຕູ້ A`, `TEST ຕູ້ B`; SKU `TEST ສິນຄ້າຄູ່ມື`; user `TEST ພະນັກງານຄູ່ມື`, username `test.guide`; document titles `TEST …`). Never type into, check in, move to/from, or mark done any non-TEST case.
- Test branch: `B-VT` (ວັງທອງ) unless the owner names another in Task 1. Every stage script reads it from one constant `TEST_BRANCH` in `scripts/guidebook/lib.mjs`.
- The agent never sees or types the owner's admin password: the owner signs in by hand in a headed window; the session is saved to the scratchpad, never to the repo.
- Owner-run SQL: the agent writes the SQL; the owner pastes it into the Supabase SQL editor and reports the printed result. The agent never holds the service-role key.
- Guidebook language: Lao for all prose; UI words written exactly as the app's Lao labels in `public/js/i18n.js` (e.g. `ເຂົ້າວຽກ`, `ຢືນຢັນວ່າແລ້ວ`, `ເລີ່ມນັບ`, `ຕັດສະຕັອກ`, `+ ສ້າງຕູ້ໃໝ່`). SKU names with size via `skuLabel()` form (e.g. `ຄຳແທ່ງ 1 ສະຫຼຶງ`); spelling `ສະຫຼຶງ`; branch names `ຕະຫລາດເຊົ້າ · ວຽງຈັນເຊັນເຕີ · ໄອເຕັກ · ວັງທອງ`.
- Guidebook title stays `ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ` (owner decision 2026-11-17); subtitle names the app "KPV Stock Tracking".
- Guidebook style: reuse the current file's `<style>` block verbatim (fonts embedded as base64 woff2, `--brand: #990000`, `.card`, `.flow/.step`, `.callout`, `.shots`/`figure` phone frame, `#zoom` click-to-zoom, print rules). Self-contained single file; every `<img>` is a `data:image/jpeg;base64,…` URI. Final size ≤ 6 MB.
- Screenshots: viewport 390×844, deviceScaleFactor 2, JPEG quality 78, Lao UI language, taken only after no skeleton placeholder remains on the page.
- No screenshot may show: a non-TEST case's numbers, company-wide or branch-wide gold value that includes real cases, any real person's password, or the "mock rows left" admin strip.

## Review Focus

1. **Re-running a stage after a crash double-posts on production** (e.g. creates a second `TEST ຕູ້ A`, or adds stock-in twice). Expected: each stage reads state first and skips work already done — pinned by the "second run is a no-op" step in Tasks 4 and 5.
2. **Tagging SQL touches a real row** (a real case whose name merely contains "TEST", a real SKU, a real user). Expected: only rows matching the exact `TEST ` prefix in `TEST_BRANCH`/test names are tagged — pinned by the PGlite tests in Task 3 with a real look-alike row (`Testing case`, `ຕູ້ TEST`).
3. **Tagging after a day is Done** fails (`DAY_LOCKED`) or leaves untagged rows. Expected: tag SQL runs right after the cases are created and before anything is marked done; the SQL raises if any test case day is already done — pinned in Task 3.
4. **Masking misses real data** (a real case card, branch total, the users list's plain passwords). Expected: shots show only TEST data — pinned by the `mask` self-test in Task 2 and the per-shot checklist in Tasks 4–6.
5. **Purge removes something real.** Expected: production `kpv_seed_counts()` is all zero before the test starts (Task 1 gate), so after the test the only seed rows are ours; purge's own "real row counts unchanged" assertion must pass — pinned in Task 3 (PGlite) and Task 7 (live counts before/after).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/guidebook/lib.mjs` | Constants (`TEST_BRANCH`, names, numbers), browser/session helpers, `shot()`, `mask()`, `api()` read helper, `findTestDesks()` |
| `scripts/guidebook/login.mjs` | Headed window; owner signs in as admin; saves storage state to the scratchpad |
| `scripts/guidebook/selftest.mjs` | Exercises `shot()` + `mask()` against the local demo server |
| `scripts/guidebook/stage1-setup.mjs` | Day 1 (admin): user, SKU, two TEST cases, their screenshots |
| `scripts/guidebook/stage2-day1-close.mjs` | Day 1 (test staff): count and mark both TEST cases done |
| `scripts/guidebook/stage3-day2.mjs` | Day 2 (test staff + admin): login, check-in, entries, move, destock, count variance, done, reopen |
| `scripts/guidebook/stage4-reports.mjs` | Day 2 (admin): dashboard, report, history, reorder proposal, settings screens |
| `scripts/guidebook/build.mjs` | Inlines `docs/guidebook/shots/*.jpg` into `docs/guidebook/guide.src.html` → root guidebook file |
| `scripts/guidebook/check.mjs` | Asserts the built guidebook's structure, images, size, wording |
| `supabase/guidebook_test_tag.sql` | Tags the TEST cases + TEST SKU (and rows already on them) `is_seed` |
| `supabase/guidebook_test_cleanup.sql` | Tags the TEST user; prints `kpv_seed_counts()` for the purge |
| `test/sql/guidebook_cleanup.test.ts` | PGlite tests for both SQL files together with `purge_seed_data.sql` |
| `docs/guidebook/guide.src.html` | Guidebook source (Lao), images referenced as `shots/NN-name.jpg` |
| `docs/guidebook/shots/*.jpg` | Screenshots (committed: they are the guidebook's inputs) |
| `docs/guidebook/2026-11-17-live-test-run.md` | Test log: scenario, expected, observed, pass/fail, shot file, bugs found |
| `package.json` | add devDependency `playwright-core` and script `guide:build` |

Shared constants in `lib.mjs` (every stage imports these; the numbers are the scenario):

```js
export const TEST_BRANCH = "B-VT";
export const NAMES = {
  caseA: "TEST ຕູ້ A", caseB: "TEST ຕູ້ B",
  sku: "TEST ສິນຄ້າຄູ່ມື", user: "TEST ພະນັກງານຄູ່ມື", username: "test.guide",
  destockReason: "TEST ເສຍຫາຍ", varianceNote: "TEST ນັບຂາດ 1", docTitle: "TEST ຂໍ້ສະເໜີສັ່ງຊື້",
};
// Day 1 opening (case creation). Two real SKUs carried by TEST_BRANCH, picked in Task 4 and written here.
export const OPENING = { A: { TEST_SKU: 10, REAL1: 5, REAL2: 5 }, B: { TEST_SKU: 4 } };
// Day 2 on the TEST SKU: A in +3, retail 2, wholesale 1, destock 1, move −2, count 6; B move +2, count 6.
export const EXPECT = { A_closing: 7, A_count: 6, A_variance: -1, B_closing: 6, B_count: 6 };
```

---

### Task 1: Pre-flight with the owner (no code)

**Files:** none.

- [ ] **Step 1: Confirm with the owner** (one message, wait for the answers): the live URL; test branch (default `B-VT`); a two-day window when that branch's shop is closed (Day 1 evening after close, Day 2 early morning or the next evening); that branch staff are told two `TEST` cases will appear for those two days.
- [ ] **Step 2: Gate — no seed rows in production.** Owner runs `select * from kpv_seed_counts() order by table_name;` in the Supabase SQL editor and pastes the output. Every `seed_rows` must be 0. If not, stop and ask the owner: a purge at the end would also delete those rows.
- [ ] **Step 3: Record** the URL, branch, window and the zero-count result at the top of `docs/guidebook/2026-11-17-live-test-run.md` (create it with headings `## Pre-flight`, `## Scenario results`, `## Bugs and surprises`, `## Cleanup`).

### Task 2: Screenshot tooling, tested on the local demo

**Files:**
- Create: `scripts/guidebook/lib.mjs`, `scripts/guidebook/login.mjs`, `scripts/guidebook/selftest.mjs`
- Modify: `package.json` (devDependency `playwright-core`; script `"guide:build": "node scripts/guidebook/build.mjs && node scripts/guidebook/check.mjs"`)

**Interfaces:**
- Produces (from `lib.mjs`):
  - `BASE_URL: string` — from env `KPV_URL`, default `http://localhost:8787`.
  - `STATE_DIR: string` — from env `KPV_GUIDE_STATE` (absolute path in the scratchpad); holds `admin.json`, `staff.json`, `test-user.json` (`{ username, password }`).
  - `openPhone(role: "admin" | "staff" | "anon"): Promise<{ browser, context, page }>` — `chromium.launch({ channel: "chrome", headless: true })`, viewport 390×844, DPR 2, locale `lo-LA`, storage state `${STATE_DIR}/${role}.json` unless `anon`.
  - `shot(page, name: string, opts?: { mask?: boolean }): Promise<string>` — waits for `networkidle` and for no `.skeleton`/`[data-skeleton]` element, applies `mask(page)` unless `mask: false`, writes `docs/guidebook/shots/${name}.jpg` (type jpeg, quality 78), returns the path.
  - `mask(page): Promise<number>` — returns the count of masked elements. Blurs (`filter: blur(6px)`) every case card, grid row, dashboard/report figure and users-list row whose text does not contain `TEST`, every password value in the users list, and hides the data-mode strip. Selectors live in one exported `MASK_RULES` array so later tasks can add to it.
  - `api(page, path: string): Promise<any>` — `page.request.get(BASE_URL + "/api" + path)`, throws on non-2xx, returns JSON.
  - `findTestDesks(page): Promise<{ A?: string, B?: string }>` — desk ids of `NAMES.caseA/caseB` in `TEST_BRANCH`, from `GET /api/stock/desks?branchId=…`.
  - `NAMES`, `OPENING`, `EXPECT`, `TEST_BRANCH` as above.
- `login.mjs <role>`: launches headed Chrome at `BASE_URL`, prints "Sign in, then press Enter here", waits for Enter, saves `context.storageState()` to `${STATE_DIR}/<role>.json`.

- [ ] **Step 1: Write `selftest.mjs`** — against `npm run dev` (demo, no `.dev.vars`): logs in through the UI as demo `owner`/`9999`, saves state as `admin`, opens `/daily_stock`, calls `shot(page, "_selftest")`. Asserts: file exists and is > 20 KB; `mask()` returned > 0 (demo cards have no `TEST`); a second `shot(page, "_selftest_nomask", { mask: false })` returns 0 masked. Deletes both files at the end.
- [ ] **Step 2: Run it and see it fail** — `npm run dev` in background, then `KPV_GUIDE_STATE=<scratchpad>/guide-state node scripts/guidebook/selftest.mjs`. Expected: fails (`lib.mjs` missing).
- [ ] **Step 3: Install and implement** — `npm i -D playwright-core`; write `lib.mjs` and `login.mjs` per the interfaces.
- [ ] **Step 4: Run it and see it pass.** Open the `_selftest.jpg` before it is deleted (comment out the delete once) and look at it: demo cards blurred, header readable, no skeletons.
- [ ] **Step 5: Commit** — `git add scripts/guidebook/lib.mjs scripts/guidebook/login.mjs scripts/guidebook/selftest.mjs package.json package-lock.json` · `git commit -m "chore(guidebook): screenshot tooling with masking"`.

### Task 3: Tag and cleanup SQL, proven on PGlite

**Files:**
- Create: `supabase/guidebook_test_tag.sql`, `supabase/guidebook_test_cleanup.sql`, `test/sql/guidebook_cleanup.test.ts`

**Interfaces:**
- Consumes: `freshDb`, `asActor` from `test/sql/db.ts`; `supabase/purge_seed_data.sql` unchanged.
- Produces:
  - `guidebook_test_tag.sql` — one `do $$` block: finds desks with `display_name in ('TEST ຕູ້ A','TEST ຕູ້ B')` and `branch_id = 'B-VT'` (one `\set`-free constant at the top of the file, `v_branch`, to edit if Task 1 chose another branch); raises `GUIDE_NOT_FOUND` if fewer than 2; raises `GUIDE_DAY_DONE` if any of their `desk_days` is `done`; sets `is_seed = true` on those desks, their `desk_days`, `daily_stock_ledger`, `documents` (+ `document_rows`) with that `desk_id`, the `master_sku` with `name_lo = 'TEST ສິນຄ້າຄູ່ມື'`, and `replenishment_rule` rows with `scope = 'sku' and scope_key` = that sku_id. Ends with `select * from kpv_seed_counts() order by table_name;`.
  - `guidebook_test_cleanup.sql` — sets `is_seed = true` on `staff_accounts where username = 'test.guide' and display_name = 'TEST ພະນັກງານຄູ່ມື'` (raises `GUIDE_USER_NOT_FOUND` if 0 rows, `GUIDE_USER_AMBIGUOUS` if > 1), then prints `kpv_seed_counts()`. The owner runs `purge_seed_data.sql` next.

- [ ] **Step 1: Write the failing tests** in `test/sql/guidebook_cleanup.test.ts` (`freshDb({ withBase: true })`, data inserted directly):
  - `tags only the two TEST cases, their rows and the TEST SKU` — setup: real desk `VT-D01` "ຕູ້ 1", look-alikes `ຕູ້ TEST` and `Testing case` in B-VT, `TEST ຕູ້ A` in **B-MM**, the two real TEST desks in B-VT with desk_days (status checked in) and ledger rows, a real SKU and the TEST SKU, a replenishment rule for each. After the tag file: only the two B-VT TEST desks, their days/ledger, the TEST SKU and its rule have `is_seed = true`; `select count(*) from … where is_seed` for every other row is 0.
  - `later rows on a tagged case inherit the tag` — after tagging, insert a ledger row on `TEST ຕູ້ A` for a real SKU and a ledger update as a real staff actor; expect the new ledger row and its audit entries `is_seed = true`.
  - `refuses when a test day is already done` — mark one TEST day `done`; running the tag file raises `GUIDE_DAY_DONE` and no row changed.
  - `cleanup + purge removes exactly the test rows` — tag, add the TEST user (and a real user `Test Person` with username `test.person`), insert ledger/audit as the TEST user on TEST cases, run cleanup then `purge_seed_data.sql`: TEST desks, days, ledger, SKU, rule, TEST user and their seed audit rows are gone; every real row count equals its count before the test began; the `seed.purge` audit entry exists.
- [ ] **Step 2: Run** `npx vitest run test/sql/guidebook_cleanup.test.ts` — expected FAIL (files missing).
- [ ] **Step 3: Write both SQL files** per the interfaces. Header comment in each: what it touches, that it must run in the order *create cases → tag → work → cleanup → purge*, and that it is safe to run twice.
- [ ] **Step 4: Run** the test file, then `npm run test:sql` — all PASS.
- [ ] **Step 5: Commit** — `git add supabase/guidebook_test_tag.sql supabase/guidebook_test_cleanup.sql test/sql/guidebook_cleanup.test.ts` · `git commit -m "feat(sql): tag and purge the guidebook test rows"`.

### Task 4: Live Day 1 — user, SKU and case set-up (admin), then Day 1 close

**Files:**
- Create: `scripts/guidebook/stage1-setup.mjs`, `scripts/guidebook/stage2-day1-close.mjs`
- Modify: `scripts/guidebook/lib.mjs` (fill `REAL1`/`REAL2` SKU ids in `OPENING`), `docs/guidebook/2026-11-17-live-test-run.md`
- Output: `docs/guidebook/shots/04…13-*.jpg`

**Interfaces:**
- Consumes: everything from Task 2's `lib.mjs`.
- Every write is preceded by a read: user exists (`GET /api/settings/summary` or the users list) → skip create; SKU named `NAMES.sku` exists (`GET /api/skus?branchId=`) → skip; `findTestDesks()` finds A/B → skip create.

- [ ] **Step 1: Owner signs in** — `KPV_URL=<live> node scripts/guidebook/login.mjs admin` (owner types their own password).
- [ ] **Step 2: Pick two real SKUs** carried by `TEST_BRANCH` with a gold type (read `GET /api/skus?branchId=B-VT`), write their ids into `OPENING`.
- [ ] **Step 3: Write and run `stage1-setup.mjs`** — through the UI only (clicks and typing, never direct API writes), in this order, taking these shots:
  - User set-up `/settings/users`: `04-users-list`, open the new-user form, fill `NAMES.user`, username `test.guide`, role staff, branch `TEST_BRANCH`, a 12-character random password (saved to `${STATE_DIR}/test-user.json`, never printed), `05-users-new`; save; `06-users-created`.
  - SKU set-up `/settings/sku` (branch `TEST_BRANCH`): `07-sku-list`; new SKU `NAMES.sku`, type = type of `REAL1`, size 1 ສະຫຼຶງ, admin "apply to every branch" **unticked**, `08-sku-new`; save; set its avg/day 1 and lead time 3, `09-sku-values`; open the ⬆ import/export sheet, `10-sku-import` (do not import).
  - Case creating `/daily_stock` → `+ ສ້າງຕູ້ໃໝ່`: Case A with `OPENING.A`, `11-case-new-form` before saving; Case B with `OPENING.B`; then `12-case-cards` (TEST cards only unmasked).
- [ ] **Step 4: Owner runs `supabase/guidebook_test_tag.sql`** (with `v_branch` matching Task 1) and pastes the output. Expected counts: `desks` 2, `master_sku` 1, `desk_days` 2, `daily_stock_ledger` 4, others 0 or the TEST rule rows. If it raises, stop and report.
- [ ] **Step 5: Test staff signs in** — `stage2-day1-close.mjs` logs in through the UI with `test-user.json` (anon context), saves `staff.json`, then on each TEST case: `ເລີ່ມນັບ`, enters counts equal to closing (A: 10/5/5, B: 4), `13-day1-count`, `ຢືນຢັນວ່າແລ້ວ` (accept the before-15:30 confirm if shown). Verify by API: both days `done`, closing as entered.
- [ ] **Step 6: Re-run both stage scripts.** Expected: they print "already done" for every step and change nothing (compare `GET /api/stock/desk/:id` JSON before/after).
- [ ] **Step 7: Log** each scenario (user set-up, SKU set-up, case creating, day 1 close) in the test run file: expected, observed, PASS/FAIL, shot names; anything unexpected under "Bugs and surprises" (do not fix app code in this plan).
- [ ] **Step 8: Commit** — scripts, `lib.mjs`, shots 04–13, test log · `git commit -m "test(guidebook): live day 1 set-up run and screenshots"`.

### Task 5: Live Day 2 — login, check-in, tracking, move, adjust (next business day)

**Files:**
- Create: `scripts/guidebook/stage3-day2.mjs`
- Modify: `docs/guidebook/2026-11-17-live-test-run.md`
- Output: shots `01…03`, `14…22`

**Interfaces:**
- Consumes: `lib.mjs`, `staff.json`, `admin.json`, `test-user.json`.
- Re-run guard: reads `GET /api/stock/desk/:id?date=<today>` and skips any field that already holds its target value.

- [ ] **Step 1: Write and run `stage3-day2.mjs`**, steps and shots:
  - Login (anon): `01-login-branch` (pick `TEST_BRANCH`), `02-login-name` (names masked except `NAMES.user`), `03-login-password` (password field empty in the shot, then typed).
  - Check-in: `/daily_stock` shows both TEST cards not started, `14-cards-not-started`; press `ເຂົ້າວຽກ` on A and B; open A, `15-checkin-opening` — verify by API opening of TEST SKU = 10 (carried from Day 1 closing).
  - Stock tracking on A, TEST SKU row: ເຂົ້າ 3, ຂາຍຍ່ອຍ 2, ຂາຍສົ່ງ 1, `16-grid-entries`.
  - Stock move: A move −2 `17-move-out-A`; B move +2 `18-move-in-B`.
  - Stock adjust: A ຕັດສະຕັອກ 1 with reason `NAMES.destockReason`, `19-destock-reason`; `ເລີ່ມນັບ`, A count 6 with note `NAMES.varianceNote`, `20-count-variance`; B count 6.
  - Done: `ຢືນຢັນວ່າແລ້ວ` on A and B, `21-done-locked`.
  - Reopen (admin context): admin opens A, reopens the day, `22-reopen`, then marks it done again without changes.
- [ ] **Step 2: Verify by API** (`GET /api/stock/desk/:id?date=`): A TEST SKU closing = `EXPECT.A_closing` (7), count 6, variance −1, destock note saved; B closing 6, count 6; both days `done`; the dashboard move-balance warning is **not** shown for today (moves sum to 0).
- [ ] **Step 3: Re-run the stage.** Expected: no change in the API JSON.
- [ ] **Step 4: Log** check-in, stock tracking, stock move, stock adjust, reopen in the test run file.
- [ ] **Step 5: Commit** — script, shots, log · `git commit -m "test(guidebook): live day 2 flow run and screenshots"`.

### Task 6: Reports, documents, routine screens (admin)

**Files:**
- Create: `scripts/guidebook/stage4-reports.mjs`
- Modify: `docs/guidebook/2026-11-17-live-test-run.md`
- Output: shots `23…30`

- [ ] **Step 1: Write and run `stage4-reports.mjs`** (admin), each filtered to `TEST_BRANCH` and case `TEST ຕູ້ A` wherever the screen has that filter:
  - `23-dashboard` (period today), `24-dashboard-watch` (ຈຸດທີ່ຕ້ອງເບິ່ງ / runway chips).
  - `25-report-summary` (this month: opening, closing, in, out), `26-report-rows` (rows with the count-adjust line `ປັບຕາມການນັບຈິງ`).
  - `27-case-history` (case A history tab), `28-audit` (`/settings/audit` filtered to case A).
  - Documents: new purchase proposal for case A titled `NAMES.docTitle`, `29-proposal` (low-stock rows highlighted); do not print.
  - `30-settings-menu` (`/settings`).
- [ ] **Step 2: Verify by API** that `/report` for case A this month shows stock in 3, out (2+1+1) = 4, count adjustment −1, and `/audit` for case A lists entries by `NAMES.user`.
- [ ] **Step 3: Review every shot 01–30 by eye** against the Global Constraints "no screenshot may show" list; re-take any that fail after adding a rule to `MASK_RULES`.
- [ ] **Step 4: Log** reports/dashboard/history/documents results; commit · `git commit -m "test(guidebook): reports and documents screenshots"`.

### Task 7: Remove the test data from production (same day as Task 5)

**Files:** Modify `docs/guidebook/2026-11-17-live-test-run.md`.

- [ ] **Step 1: Owner runs `supabase/guidebook_test_cleanup.sql`**, pastes the counts (staff_accounts seed 1, plus the rows from Task 4 Step 4 and everything written on the TEST cases since).
- [ ] **Step 2: Owner runs `supabase/purge_seed_data.sql`**; the final `kpv_seed_counts()` must be all 0 and the script must end without `PURGE_…` errors.
- [ ] **Step 3: Verify in the app** (admin context): no `TEST` card in `/daily_stock` for `TEST_BRANCH`, no `NAMES.sku` in `/api/skus`, no `test.guide` in the users list, today's dashboard for the branch shows no TEST case. Note in the log what stays by design: the few audit entries written before tagging (`desk.create` ×2, `sku.create`, `user.create`, and any written on Day 1 before Step 4 of Task 4).
- [ ] **Step 4: Commit** the log · `git commit -m "test(guidebook): live test data purged"`.

### Task 8: Write and build the Lao guidebook

**Files:**
- Create: `docs/guidebook/guide.src.html`, `scripts/guidebook/build.mjs`, `scripts/guidebook/check.mjs`
- Modify: `ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html` (rebuilt output)

**Interfaces:**
- `build.mjs`: reads `docs/guidebook/guide.src.html`, replaces each `src="shots/NAME.jpg"` with `data:image/jpeg;base64,…`, fails if a referenced file is missing, writes the root guidebook file.
- `check.mjs`: exits non-zero unless all checks below pass.

- [ ] **Step 1: Write `check.mjs`** with these assertions on the root file: `<html lang="lo">`; `<title>ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ</title>`; sections with ids `about, roles, login, workflow, checkin, tracking, newcase, move, adjust, sku, users, reports, documents, routine, trouble`, each with a TOC link; every `<img src>` starts with `data:image/jpeg;base64,`; at least 26 `<figure>`; every `<figure>` has a non-empty `<figcaption>`; file ≤ 6 MB; no text "demo" and no `src="shots/`; the strings `ເຂົ້າວຽກ`, `ຢືນຢັນວ່າແລ້ວ`, `ເລີ່ມນັບ`, `ຕັດສະຕັອກ`, `ປັບຕາມການນັບຈິງ` all appear.
- [ ] **Step 2: Run** `node scripts/guidebook/check.mjs` — expected FAIL on the current file (missing sections `checkin`, `tracking`, …).
- [ ] **Step 3: Write `guide.src.html`** — copy the current file's `<head>` (style + fonts) and the `#zoom` script verbatim; body sections in the id order above. Content per section, all from what the test run observed (the log), not from the old text:
  - `about`, `roles`, `login` (shots 01–03): carry over, updated; replace the "demo data" note with: screenshots come from the real system using `TEST` cases; other numbers are blurred.
  - `workflow`: the day cycle as the app now shows it, with the closing formula, the column table, and a `.flow` of the states seen in the run.
  - `checkin` (14–15), `tracking` (16), `newcase` (11–12), `move` (17–18; both sides typed, −/+, dashboard warns when a day's moves don't sum to 0), `adjust` (19–22; destock needs a reason, count variance needs a note, Done locks, manager/admin reopen within 3 days).
  - `sku` (07–10) and `users` (04–06; who can add/unlock/reset; passwords visible to admin only).
  - `reports` (23–28): what each card and figure means and how to read it, using the run's actual numbers as the worked example (opening 10 → in 3, out 4, move −2 → closing 7, counted 6, adjustment −1).
  - `documents` (29), `routine` (staff / manager / admin columns, morning–day–evening), `trouble` (carry over, updated).
- [ ] **Step 4: Build and check** — `npm run guide:build`. Expected: check PASS. Open the file in Chrome at phone and desktop widths; click a figure to confirm zoom; print-preview once.
- [ ] **Step 5: Commit** — `git add docs/guidebook/guide.src.html scripts/guidebook/build.mjs scripts/guidebook/check.mjs "ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html"` · `git commit -m "docs(manual): Lao guidebook rebuilt from the live test run"`.
- [ ] **Step 6: Report to the owner**: test results table (PASS/FAIL per scenario), bugs found, what audit entries remain, and the guidebook path. Ask before pushing.
