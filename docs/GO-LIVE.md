# Go-live checklist

One Supabase project (free plan) is used. You test it with mock data, remove
the mock data with one script, then work with real data. The schema is never
dropped.

Names used below: Supabase project `https://tpekfhbjbosbeikawkys.supabase.co`;
Cloudflare Worker `kpv-goldsmith-inventory`. Keys and secrets are never written
in this repo; wherever a value is needed you paste it into `.dev.vars` or the
Cloudflare dashboard yourself.

## 1. Test run on Supabase (mock data)

For a new, empty Supabase project. (A project that already holds real data:
skip to section 2.)

1. In **SQL Editor**, run these files in this order:
   1. `supabase/schema.sql`
   2. `supabase/migrations/20261112_01_foundation.sql` to `20261112_07_seed_tools.sql`, in name order
   3. `supabase/users_roles.sql`
   4. `supabase/base.sql`
   5. `supabase/seed_mock_data.sql` (mock data; every row is tagged `is_seed`)
   6. `supabase/tests/verify_v2.sql` (read-only; must end by printing `VERIFY_V2 OK`)
2. Copy `.dev.vars.example` to `.dev.vars`. Fill in `SUPABASE_SERVICE_ROLE_KEY`
   (Project Settings, API, service_role) and a long random `AUTH_SECRET`
   (`openssl rand -hex 32`). Leave `KPV_DATA_MODE=test`. A yellow "TEST DATA"
   strip then shows on every screen.
3. `npm run dev`, then walk through every change on a phone. Mock logins: the
   branch "Test Branch", PIN **1234** for every mock account (a "Test Admin", a
   manager and staff).
   - Daily cycle: check in a case, record movements, try Done with a missing
     count (refused, the cells turn red), count, add notes, Done; the next day
     opens with the counted figure. Leave a day unfinished: the next check-in
     points back to it.
   - Same-branch move between two cases: instant, with Undo.
   - Cross-branch transfer: shows *in transit*; confirm on the receiving case.
   - Cards: streaks and tiers (the mock T1-4 case is overdue and pinned), the
     closed day 10 days ago does not break streaks.
   - Cases: take over, hand over, Switch user.
   - Replenishment: runway chips, alerts, the "Snake Necklace" rule, a bulk rule.
   - Roles: staff cannot see another branch or change master data; a manager
     reopens only their own branch's latest Done day, within 3 days; only an
     admin edits users, SKUs and the gold price.
   - Audit history tab: staff see their case today, managers their branch,
     admin everything.
   - 5 wrong PINs lock an account; an admin (or the branch manager) unlocks it.
4. Compare one branch: Baht and pcs on the case cards equal the Dashboard and
   the Report closing.
5. Run the automatic checks on your machine too: `npm test` (includes the SQL
   suite, `npm run test:sql`) and `npm run typecheck`.

### Warnings while mock data is loaded

- A mock admin with a **known PIN (1234)** exists. Never leave the project in
  this state in front of real users. Production mode refuses mock logins, and
  the purge deletes the accounts.
- The mock data creates a company-wide replenishment rule for the group
  **"Snake Necklace"**. If your real SKUs use that group name, the rule applies
  to them until the purge.
- Never move gold between a real case and a mock case. The app refuses it
  (`MIXED_TEST_TRANSFER`), and the purge refuses to run (`PURGE_MIXED_TRANSFER`,
  nothing is deleted) if such a transfer already exists, listing each one so you
  can resolve it by hand (receive or cancel it, or correct the real ledger) and
  run the purge again.

## 2. An existing live project (before deploying v2)

Do these in order, **before** the new code is deployed.

1. Receive every transfer that is still in transit and is a same-branch move:
   in the SQL editor,
   `select * from transfers where kind = 'move' and status = 'in_transit';`
   Open each one in the old app and confirm it on the receiving case (v2 moves
   are instant and have no in-transit state), until the query returns nothing.
2. Find open-day rows whose closing is already negative. Migration 01 prints
   them as notices (`NEGATIVE open row: desk … date … sku … closing …`) when it
   runs, and you can run the query yourself:
   ```sql
   select l.desk_id, l.ledger_date, l.sku_id, l.closing_qty
   from daily_stock_ledger l
   join desk_days d on d.desk_id = l.desk_id and d.ledger_date = l.ledger_date
   where d.status <> 'done' and l.closing_qty < 0;
   ```
   Fix every row (correct the count or the entry in the old app). After v2 such
   a row can only be corrected, never pushed further down.
3. Run `supabase/migrations/20261112_01_foundation.sql` to `20261112_07_seed_tools.sql`
   in name order, then `supabase/users_roles.sql`. All are safe to run twice, but
   always re-run the **whole** sequence 01 to 07 and then `users_roles.sql`,
   never a single earlier file (migration 07 redefines a function that
   migration 01 also defines).

   > **Warning: the old (v1) app stops saving as soon as these migrations have
   > run.** Every write it makes fails with `AUDIT_ACTOR_MISSING` or
   > `ROLE_DENIED`, including PIN lockouts. Nobody may use the app between
   > running the migrations and deploying v2. Deploy v2 (section 3) immediately
   > after the migrations.
4. **Re-run `supabase/users_roles.sql` after any future migration**, so new
   tables and functions are locked down too.
5. Do not run `seed_mock_data.sql` on a project holding real data unless you
   want mock data next to it (it is tagged and removable, but see the warnings
   in section 1).

## 3. Cloudflare

1. **Workers & Pages, kpv-goldsmith-inventory, Settings, Variables and Secrets**:

   | Name | Type |
   |---|---|
   | `SUPABASE_URL` | Text: `https://tpekfhbjbosbeikawkys.supabase.co` |
   | `KPV_DATA_MODE` | Text: `test` for the test run, `production` for go-live |
   | `SUPABASE_SERVICE_ROLE_KEY` | Secret |
   | `AUTH_SECRET` | Secret (changing it logs everyone out) |

   `wrangler.jsonc` sets `keep_vars`, so a deploy does not wipe variables you
   typed into the dashboard.
2. Deploy with `npm run deploy` (builds the CSS, then `wrangler deploy`), or
   connect the GitHub repo under **Settings, Builds**: build command
   `npm ci && npm run build:css`, deploy command `npx wrangler deploy`.
3. Secrets can also be set from a terminal: `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`,
   `npx wrangler secret put AUTH_SECRET`.

The Worker refuses to sign sessions if `AUTH_SECRET` is missing while Supabase
is configured.

## 4. Switch to production

1. Make sure nobody is using the app. Run `supabase/purge_seed_data.sql` in the
   SQL editor. It lists what it will delete, removes every `is_seed` row in one
   transaction (it rolls back entirely if any real row would change), and
   writes one permanent `seed.purge` audit entry. It does not drop the schema
   and is safe to run twice. A real row that pointed at a mock person (for
   example a case a mock admin checked in) is kept; only that reference is set
   to empty.
2. Create the first real admin: `npm run db:admin -- "Owner name" <PIN>` and
   run the printed SQL. This is the only account made by hand.
3. Set `KPV_DATA_MODE=production` in Cloudflare and redeploy (or save the
   variable; a new version is deployed).
4. Check that no mock rows remain. The primary check is on screen: sign in as
   the admin and reload; the **red strip must be absent**. Or, in the SQL
   editor, run `select * from kpv_seed_counts();`: every `seed_rows` must be 0.
   (`/api/meta` shows `dataMode: "production"` to everyone, but `seedRows` is
   `null`, meaning unknown, unless an admin is signed in, so an anonymous call
   proves nothing.) A red strip or a non-zero count means mock rows remain: run
   the purge again.
5. Log in as the admin and load real data:
   - **Settings, Gold price**: gold price per Baht and the USD rate.
   - **Settings, SKU**: check types and sizes, then **Import CSV** (template
     button in the import sheet). One bad row imports nothing and lists the
     lines to fix.
   - **Settings, Replenishment**: avg sold per day and lead time per SKU or
     group, company-wide or per branch.
   - **Settings, Users**: add every staff member and branch manager, with branch and PIN.
6. Day one at each case: create the case (**+** on Daily Stock) with its
   starting stock, or for existing cases check in and add each SKU with its
   opening count (allowed only on a case's first day).

## 5. Lao manual: what v2 changes

The manual's screenshots show data from before v2. These parts of the text are
out of date; v2 wins where they differ.

| Manual section | Change in v2 |
|---|---|
| ສິດທີ່ມີໃນລະບົບ | A third role, **ຜູ້ຈັດການສາຂາ (manager)**, for one branch: manages that branch's cases, reopens its latest Done day (within 3 days), edits its replenishment rules and closed days, unlocks its staff's PIN, reads its audit history. Admin keeps users, SKUs, gold price, proposals and deleting documents. Staff cannot create SKUs. |
| ການເຂົ້າສູ່ລະບົບ | 5 wrong PINs lock the account for 15 minutes; admin or the branch manager unlocks. There is also **ປ່ຽນຜູ້ໃຊ້ (Switch user)** on a shared phone. |
| ວົງຈອນປະຈຳວັນ | One screen for the whole day, with a count mode (no sideways scrolling). A day must be ✓ Done before the next check-in; the opening is the counted figure of the last Done day. Done is refused (cells turn red) until every row is counted, differences have notes and destocks have reasons. A card shows the **streak** and the **tier** (done today, on track, behind, overdue; overdue cases are pinned). Holidays are set as **closed days (ວັນປິດຮ້ານ)** and do not break streaks. |
| ຍ້າຍ (Move, same branch) | Instant: choose the destination case and quantity, and the gold moves at once. There is **no in-transit state and no confirmation** for a same-branch move; **Undo** is shown for a few seconds. |
| ອອກ (Out, other branch) | Still a transfer: stays *in transit* until the receiving case taps **ຮັບແລ້ວ**; its ເຂົ້າ cell shows `+n⇄`. |
| ວົງຈອນປະຈຳວັນ (case assignment) | A staff member can be assigned several cases; a case shows its holder, and a handover during the day is recorded. |
| ຕັ້ງຄ່າ, ເຕີມສະຕັອກ | A **Replenishment** screen replaces the old "lead time and avg. RR" screen: rules per SKU, group (such as Snake Necklace) or type, runway in days, and alerts when the runway falls inside the lead time plus margin. Quantities are whole pieces, 0 to 99 999. |
| ຕັ້ງຄ່າ, ປະຫວັດການແກ້ໄຂ (new) | A new Settings entry: who changed what and when. Staff see their case for today, managers their branch, admin everything. Entries cannot be edited or deleted. |
| ກົດ ✓ ແລ້ວ ແຕ່ບັນທຶກຜິດ | Admin reopens the latest Done day; a branch manager may do so for their own branch within 3 days. A reason is required and is logged. |
| ຂັ້ນຕອນການສັ່ງຊື້ເພີ່ມ | A saved proposal shows **ລໍຖ້າອະນຸມັດ**; admin approves or rejects. Low stock is judged from the runway and the lead time. |
| ພາບລວມ | Value uses the gold price from Settings. A new "in transit" card; branch cards show cases done today; runway chips. |
| ຕັ້ງຄ່າ, menu | Menu now: SKU, Replenishment, **Gold price** (back as its own entry: admin edits, others read), Users, ວັນປິດຮ້ານ closed days and ປະຫວັດການແກ້ໄຂ audit history (managers and admin), Language. |
| (new, no manual section) | A "TEST DATA" strip means the database holds mock data. Real work starts only after the purge (section 4); never delete the schema to start over. |
