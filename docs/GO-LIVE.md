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
   2. `supabase/migrations/20261112_01_foundation.sql` to `20261118_17_sop_steps.sql`, in name order
   3. `supabase/users_roles.sql`
   4. `supabase/base.sql`
   5. `supabase/real_skus.sql` (the real product list; real rows, kept by the purge;
      safe to run again, also after the mock data)
   6. `supabase/seed_mock_data.sql` (mock data; every row is tagged `is_seed`)
   7. `supabase/tests/verify_v2.sql` (read-only; must end by printing `VERIFY_V2 OK`)
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
   - Cards: streaks and tiers (the mock T1-4 case is overdue and sorted first), the
     closed day 10 days ago does not break streaks.
   - Cases: Case info, History tab, Report grid (no take over / Switch user).
   - Replenishment: runway chips, alerts, the "Snake Necklace" rule, a bulk rule.
   - Roles: staff cannot see another branch or change master data; a manager
     reopens only their own branch's latest Done day, within 3 days; only an
     admin edits users, SKUs and the exchange rate.
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
3. Run `supabase/migrations/20261112_01_foundation.sql` to `20261118_17_sop_steps.sql`
   in name order, then `supabase/users_roles.sql`. All are safe to run twice, but
   always re-run the **whole** sequence 01 to 17 and then `users_roles.sql`,
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
2. The live Worker deploys **by pushing to `main`**: the GitHub repo is
   connected under **Settings, Builds** (Cloudflare Workers Builds on the
   owner's account; build command `npm ci && npm run build:css`, deploy command
   `npx wrangler deploy`). `npm run deploy` from a developer machine deploys to
   whatever account that machine's wrangler is logged in to, which is **not**
   the owner's account, so it does **not** update the live site. Where a
   section below says "Deploy the Worker (`npm run deploy`) to the owner's
   Cloudflare account", that now means: push to `main` and wait for the
   Workers Builds deploy.
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
   - **Settings, Exchange rate**: the USD rate (the gold price per Baht comes from the daily fetch).
   - **Settings, SKU**: the real products are already there from
     `supabase/real_skus.sql`. Check them; add new ones by hand or with
     **Import CSV** (template button in the import sheet). One bad row imports
     nothing and lists the lines to fix.
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
| ສິດທີ່ມີໃນລະບົບ | A third role, **ຜູ້ຈັດການສາຂາ (manager)**, for one branch: manages that branch's cases, reopens its latest Done day (within 3 days), edits its replenishment rules and closed days, unlocks its staff's PIN, reads its audit history. Admin keeps users, SKUs, the exchange rate, proposals and deleting documents. The gold price comes from the daily feed; nobody edits it by hand (manual price only as the fallback when the feed cannot be read). Staff cannot create SKUs. |
| ການເຂົ້າສູ່ລະບົບ | 5 wrong PINs lock the account for 15 minutes; admin or the branch manager unlocks. **ປ່ຽນຜູ້ໃຊ້ (Switch user)** is removed; use Log out. |
| ວົງຈອນປະຈຳວັນ | One screen for the whole day, with a count mode (no sideways scrolling). A day must be ✓ Done before the next check-in; the opening is the counted figure of the last Done day. Done is refused (cells turn red) until every row is counted, differences have notes and destocks have reasons. A card shows the **streak** and the **tier** (done today, on track, behind, overdue; overdue cases are sorted first and show only a red warning line). Holidays are set as **closed days (ວັນປິດຮ້ານ)** and do not break streaks. |
| ຍ້າຍ (Move, same branch) | Instant: choose the destination case and quantity, and the gold moves at once. There is **no in-transit state and no confirmation** for a same-branch move; **Undo** is shown for a few seconds. |
| ອອກ (Out, other branch) | Still a transfer: stays *in transit* until the receiving case taps **ຮັບແລ້ວ**; its ເຂົ້າ cell shows `+n⇄`. |
| ຕັ້ງຄ່າ, ເຕີມສະຕັອກ | A **Replenishment** screen replaces the old "lead time and avg. RR" screen: rules per SKU, group (such as Snake Necklace) or type, runway in days, and alerts when the runway falls inside the lead time plus margin. Quantities are whole pieces, 0 to 99 999. |
| ຕັ້ງຄ່າ, ປະຫວັດການແກ້ໄຂ (new) | A new Settings entry: who changed what and when. Staff see their case for today, managers their branch, admin everything. Entries cannot be edited or deleted. |
| ກົດ ✓ ແລ້ວ ແຕ່ບັນທຶກຜິດ | Admin reopens the latest Done day; a branch manager may do so for their own branch within 3 days. A reason is required and is logged. |
| ຂັ້ນຕອນການສັ່ງຊື້ເພີ່ມ | A saved proposal shows **ລໍຖ້າອະນຸມັດ**; admin approves or rejects. Low stock is judged from the runway and the lead time. |
| ພາບລວມ | Value uses the daily `gold_prices` sell price (a past day uses that day's snapshot). A new "in transit" card; branch cards show cases done today; runway chips. |
| ຕັ້ງຄ່າ, menu | Menu now: SKU, Replenishment, **Exchange rate** (admin only), Users, ວັນປິດຮ້ານ closed days and ປະຫວັດການແກ້ໄຂ audit history (managers and admin), Language. There is no "Gold price" item: a read-only strip above the menu shows the current price. |
| ວົງຈອນປະຈຳວັນ (header, cards) | The header is one line (no My cases, no Switch user: use Log out). All case cards are one compact style, each with its `≈ LAK` value. |
| ວົງຈອນປະຈຳວັນ (case ownership) | Replaces the manual's text on case assignment: case ownership is **removed** (no taking, no handover, no holder on cards). |
| Case info (new, ⋯ menu) | Shows the creator, creation date and original stock (the openings entered when the case was created). Old cases without a record show "—". |
| History tab (case) | A day table with missed days (no check-in, not a closed day) and chain breaks (opening differs from the previous count) marked red. |
| ລາຍງານ (Report) | A month grid of cases x days; a red day is a problem, tap it to open the day. |
| ຕັ້ງຄ່າ, ລາຄາຄຳ | **Gold price** is now a read-only strip (the price comes from the daily fetch). The admin-only **Exchange rate** page edits the USD to LAK rate. |
| (new, no manual section) | A "TEST DATA" strip means the database holds mock data. Real work starts only after the purge (section 4); never delete the schema to start over. |

## 6. Rollout: case tracking and gold price (2026-11-16)

On the live project, in this order:

1. Run `supabase/migrations/20261116_10_case_tracking.sql` in the Supabase SQL editor.
2. **Pre-check before re-running `users_roles.sql`** (it locks down `gold_prices`):
   ```sql
   select grantee, privilege_type from information_schema.role_table_grants where table_name = 'gold_prices';
   select * from pg_policies where tablename = 'gold_prices';
   ```
   If anything other than `service_role` / `postgres` uses the table, stop and ask
   before running the lockdown. Then re-run `supabase/users_roles.sql`.
3. Confirm a `gold_price_history` row for today exists:
   `select * from gold_price_history order by 1 desc limit 3;`
4. Deploy the Worker (`npm run deploy`) to the **owner's Cloudflare account**. It
   differs from the account the local wrangler is logged in to, so check the
   account before deploying.
5. After the next daily gold fetch, confirm `gold_prices.updated_at` advanced and
   a second `gold_price_history` row appeared (the fetcher uses service_role, so
   RLS does not block it).

## 7. Rollout: stock grid, stock-out mode, Move in/out (2026-11-16)

The case screen becomes one typed grid; stock-out is **single** (one total) or
**dynamic** (retail / wholesale / destock), chosen by an admin; the linked
Move / Transfer is replaced by one signed **Move in/out** number per case.

On the live project, in this order:

1. Check nothing is in transit (the migration refuses otherwise):
   `select count(*) from transfers where status = 'in_transit';`
2. Run `supabase/migrations/20261116_11_stock_grid_modes.sql` in the SQL editor.
   It adds `stock_out_mode` (system_config, desk_days), `stock_out_single`,
   `move_qty` and the generated `stock_out`, and re-generates `closing_qty`
   with the new formula (no stored value changes; no Done row is written).
3. Check: `select count(*) from daily_stock_ledger where closing_qty <> opening_qty + stock_in + transfer_in - transfer_out - move - stock_out + move_qty;` returns 0.
4. Deploy the Worker (`npm run deploy`) to the **owner's Cloudflare account**.
   `wrangler.jsonc` now serves `index.html` for deep links such as
   `/daily_stock` and `/settings/users`.
5. The default mode is **dynamic** (same as before). An admin switches it in
   ຕັ້ງຄ່າ → ແບບສະຕັອກອອກ; it applies to case-days opened after the switch.

## 8. Rollout: passwords kept as plain text (2026-11-16)

Owner's decision, risk accepted: every password is stored as **plain text** in
`staff_accounts.password_plain`, and an admin reads it in Settings, Users
(masked, eye button to show, copy button; the edit form shows it too). Login
still checks the pbkdf2 hash in `pin_hash`; `password_plain` is only for
reading. Anyone with the service-role key, a Supabase dashboard login or a
database backup can read every password. The audit log never records it.

On the live project, in this order:

1. Run `supabase/migrations/20261116_12_admin_passwords.sql` (if not run yet),
   then `supabase/migrations/20261116_13_plain_passwords.sql`, in the SQL
   editor. Migration 13 adds `password_plain` and drops the unused
   `password_enc`.
2. Re-run `supabase/users_roles.sql` (a login may fill an empty
   `password_plain`, never replace one).
3. Deploy the Worker (`npm run deploy`) to the **owner's Cloudflare account**.
   No secret is needed.
4. Check: Settings, Users shows "not known yet" for people whose password was
   set earlier. Each row fills in at that person's next successful sign-in,
   or at once when an admin sets a new password.

Locked out with no admin password: `npm run db:admin -- "Owner" owner 'a-password'`
prints an insert (with `password_plain`) to paste into the SQL editor.

## 9. Rollout: simpler SKUs, reorder settings in SKU setting (2026-11-17)

What changes for people:

- A SKU is now **Name (Lao) + Type + Size**, plus optional **avg sell/day** and
  **order lead time**. English name, purity, price, group, Baht weight and the
  fixed reorder level are gone from the forms. The Baht weight follows the size
  (grams / 15.244), so every SKU counts as gold.
- Sizes show in Lao everywhere (ບາດ, ສະຫຼຶງ, ຫຸນ, ກລາມ, ກິໂລ). New sizes are
  typed as amount + unit in Settings, SKU, Weight.
- Settings, SKU lists SKUs by Type. Each Type has **ຕັ້ງຄ່າທັງໝົດ** (set all):
  the avg/day and lead time typed there apply to every SKU in the Type. The
  separate Replenishment menu is gone. Rules are company-wide and admin only.
- A SKU with no avg/day (none typed and too little sales history) shows no
  alert; the old fixed reorder level no longer warns.
- Settings no longer lists Closed days or Stock-out mode. Closed days already
  saved still count; every day uses the full stock-out layout.
- Move in/out takes a signed number: `-5` = 5 moved out, `5` = 5 moved in. The
  ± button flips the sign (for phones whose keypad has no minus).

On the live project, in this order:

1. Run `supabase/migrations/20261117_14_sku_simplify.sql` in the SQL editor
   (safe to re-run). It turns group rules into per-SKU rules, branch rules
   into company-wide ones, sets each SKU's Baht weight from its size, copies
   the English name into an empty Lao name, and sets stock-out mode to
   `dynamic`. No column is dropped.
2. Deploy the Worker (`npm run deploy`) to the **owner's Cloudflare account**.
3. Check: Settings, SKU lists SKUs under their Type with "set all"; a SKU's
   sizes read in Lao; the day grid accepts `-5` in Move in/out.

## 10. If saving fails with "The database needs an update"

The Worker is newer than the database: a migration has not been run, or
PostgREST has not reloaded its schema. The Worker log names the missing column
or function. Check which columns are there:

```sql
select t.tbl, t.col, (c.column_name is not null) as present
from (values ('desks','initial_stock'), ('desks','created_by'),
             ('daily_stock_ledger','move_qty'), ('daily_stock_ledger','stock_out_single'),
             ('desk_days','stock_out_mode'), ('staff_accounts','password_plain')) t(tbl, col)
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.col;
```

For any row with `present = false`: run the missing migrations in name order
(read sections 6–9 first for their pre-checks), then `supabase/users_roles.sql`,
then `notify pgrst, 'reload schema';`. Run the query again: every row `true`.

## Per-branch SKU values (migration 15, 2026-11-17)

Migration 15 moves avg/day and lead time from company-wide rules to one copy
per branch, and adds `branch_sku` (which SKUs each branch sells). The old
Worker reads only company-wide rules; the new Worker needs `branch_sku`. Do
these three steps together, one right after the other, outside shop hours:

1. In SQL Editor run `supabase/migrations/20261117_15_branch_sku.sql`.
2. Run `supabase/users_roles.sql` again (it adds the `branch_sku` guard and
   lets staff write their own branch's values; before this step staff get
   ROLE_DENIED).
3. Deploy the new Worker (`npm run deploy`).

Between step 1 and step 3 the old Worker shows every SKU's avg/day as
automatic. Between a new Worker and a missing step 1, SKU and reorder screens
return errors. Re-running 01 to 15 later is safe: once migration 15 has run,
06 and 14 no longer touch rules and 15 no longer re-seeds `branch_sku`.

## Branch names, Vientiane Center and product-only SKU names (migration 16, 2026-11-17)

Decided by the owner:

| Code | Lao name | English name |
|---|---|---|
| B-MM | ຕະຫລາດເຊົ້າ | Morning Market |
| **B-VTC** (was B-TS, Talat Sao) | ວຽງຈັນເຊັນເຕີ | Vientiane Center |
| B-IT | ໄອເຕັກ | ITECC |
| B-VT | ວັງທອງ | Vangthong |

The cases of that branch become VTC-D01, VTC-D02, … (were TS-Dxx).

Migration 16 moves B-TS / TS-Dxx to the new codes in every table, in one
transaction, **except audit_log** (append-only): entries written before the
move keep B-TS / TS-Dxx. History screens treat the old codes as the same
branch and case (`src/legacyCodes.ts`), so the branch's history stays in one
list. Document numbers already issued (DOC-TS-2026-…) keep their number; the
next one is DOC-VTC-2026-<next>. One audit entry, `branch.rename`, records the
move.

SKU names are now the **product only** ("ຄຳແທ່ງ", not "ຄຳແທ່ງ 1 ສະຫຼຶງ"): the
size is the SKU's weight, and the app shows it beside the name. `real_skus.sql`
already has the short names. A size typed into a name (form or Excel import)
is dropped when saved.

On the live project, together and outside shop hours:

1. In SQL Editor run `supabase/migrations/20261117_16_branch_vtc.sql` (safe to
   re-run; it does nothing once B-VTC exists).
2. Run `supabase/users_roles.sql` again.
3. Deploy the new Worker (`npm run deploy`) to the owner's Cloudflare account.
4. Ask Vientiane Center staff to reload the app once (it reloads their
   account, now on B-VTC). Nobody needs to log in again.
5. Check: the branch list reads ຕະຫລາດເຊົ້າ, ວຽງຈັນເຊັນເຕີ, ໄອເຕັກ, ວັງທອງ;
   Vientiane Center's cases read VTC-D…; its History still shows entries from
   before the move.
6. If the real SKUs are not loaded yet, run `supabase/real_skus.sql` now. If an
   older copy with long names was already run, running this one again
   replaces the names (it updates existing SKUs).

## Day steps: Opening, Check in, Close, Withdraw (migration 17, 2026-11-18)

Run the migration **before** pushing the code. There is one deploy path: the
live Worker deploys by pushing to `main` (Cloudflare Workers Builds on the
owner's account), so the new code goes live a minute after the push and needs
the new column and status. `npm run deploy` from this machine does **not**
update the live site (its wrangler is logged in to a different account).

1. **Pre-checks** (Supabase **SQL Editor**, read-only). Run both and keep the
   lists:

   (i) Days not Done that still hold an old physical count. The new app no
   longer shows counts; when such a day is closed, its counts are cleared and
   the next day opens with the calculated closing (not the count). Tell the
   staff of these cases, so a count that differs from the calculated closing
   is fixed as a sale, stock-in or Return before closing:

   ```sql
   select l.desk_id, l.ledger_date, d.status, l.sku_id,
          l.closing_qty, l.counted_qty, l.counted_note
     from daily_stock_ledger l
     join desk_days d on d.desk_id = l.desk_id and d.ledger_date = l.ledger_date
    where d.status <> 'done'
      and (l.counted_qty is not null or l.counted_note is not null)
    order by l.desk_id, l.ledger_date, l.sku_id;
   ```

   (ii) Cases with a day that is not Done before a later day of the same case.
   The new app refuses to work the later day (`EARLIER_DAY_OPEN`, "an earlier
   day is not Done — close it first") until the earlier one is closed, so close
   the listed days first, in date order:

   ```sql
   select d.desk_id, d.ledger_date as open_day, d.status,
          (select min(x.ledger_date) from desk_days x
            where x.desk_id = d.desk_id and x.ledger_date > d.ledger_date) as later_day
     from desk_days d
    where d.status <> 'done'
      and exists (select 1 from desk_days x
                   where x.desk_id = d.desk_id and x.ledger_date > d.ledger_date)
    order by d.desk_id, d.ledger_date;
   ```
2. In Supabase **SQL Editor** run `supabase/migrations/20261118_17_sop_steps.sql`
   (outside shop hours). It is safe to run twice.
3. Re-run `supabase/users_roles.sql` (the rule in section 2: re-run it after
   every migration, so every table and function stays locked down).
4. Then push to `main` and wait for the Workers Builds deploy.
5. Ask staff to reload the app once.

Days that are open at deploy time:

- A day already in `check_in` stays in Check in (its opening review is
  skipped); staff carry on and close it.
- An existing `final_stock` day keeps working like Check in: the same columns
  can be typed and it closes with ② Close day.

Rollback: if the Worker is rolled back to the previous version, first run

```sql
update desk_days set status = 'check_in' where status = 'opening';
```

because the old Worker cannot handle the `opening` status (such days would be
stuck). The migration itself can stay: the old Worker ignores the `withdraw`
column (a Withdraw already typed still counts in the closing, but the old
screen does not show it).

What changes for staff:

- A day now has steps: **Opening** (review yesterday's closing as today's
  opening, add a SKU with its opening, enter the first stock-in, then confirm
  check-in), **Check in** (stock-in, retail, wholesale, Return, Withdraw),
  **Close** (no physical count), then Done. Home cards show
  [1 Check in] [2 Close day] and a status icon.
- Columns: **Return** is the old destock, now without a note. **Withdraw**
  (ຖອນ) is gold taken out of the Easy Gold app as physical gold; it counts as
  sold for reorder velocity, Return does not. Move in/out and Count are no
  longer shown (old days keep their values).
- Reopen: a manager can reopen a day up to 3 days back (admin any day). That
  day and every later day of the case go back to Opening; staff redo them in
  date order, because a day cannot be worked while an earlier day is not Done.
- The dashboard warning "moves do not add up" is removed (it was for Move in/out).
- Check: open a case, the day starts at Opening; do a Withdraw of 1, close; the
  History row shows Opening + In - Out = Closing.

