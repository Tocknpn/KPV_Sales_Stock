# KPV Goldsmith & Retail Inventory

Mobile-first stock app for KPV's gold desks: daily desk counts, instant moves
between cases, linked transfers between branches, documents and purchase
proposals, replenishment runway, dashboard, movement report and an audit
history. **The Lao user manual (`ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html`) is the
specification** for everything v2 does not change; where the v2 design
(`docs/superpowers/specs/2026-11-12-khamphouvong-stock-v2-design.md`) differs
(moves, the day flow, roles), v2 wins. `app.md` is the original brief and is
kept for history only.

## Stack

- **Cloudflare Worker, not Pages; no browser Supabase key.** One Worker serves
  the SPA (`/public`, as Static Assets) and the JSON API (`/api/*`), built with
  [Hono](https://hono.dev). Same origin, no CORS. The browser only ever talks
  to the Worker, which checks the session on every request.
- **Supabase (Postgres)**, reached only by the Worker with the service-role key.
  Row Level Security is on with no permissive policies and `anon` /
  `authenticated` are revoked, so a public key would reach nothing (and none is
  shipped). Business rules are checked in the Worker with friendly errors and
  again in Postgres (triggers, RPCs) as hard guarantees.
- **Vanilla ES modules + Tailwind 3** on the frontend (`npm run build:css`).
  No React, no Vite, no `VITE_*` variables.
- **Demo store**: without Supabase credentials the Worker runs on an in-memory
  dataset (`src/demoData.ts`) with the same rules.

## Layout

```
src/
  index.ts            mounts the route modules, maps errors to HTTP
  app.ts              shared route helpers: access scoping, the date rule, day locks
  routes/             auth · meta · stock · moves · transfers · documents · insights
                      · settings · cases · replenishment · audit
  dataMode.ts         test / production / demo, and the seed-account rule
  logic.ts            closing, value, dashboard, report
  replenishment.ts    velocity, runway, alert rules
  store.ts            Store interface: SupabaseStore (PostgREST) and DemoStore
  time.ts             Laos business date (UTC+7)
  auth.ts             password hashing, session tokens, role guards
  demoData.ts         demo dataset (relative to today)
supabase/
  schema.sql                       v1 baseline (never edited; its header comment
                                   still mentions seed.sql, which no longer exists)
  migrations/20261112_01 … 20261113_08   v2 changes, additive and idempotent
  users_roles.sql                  roles, role guard triggers, RLS lockdown
  base.sql                         production starting data (generated)
  seed_mock_data.sql               tagged mock data for test projects (optional)
  purge_seed_data.sql              removes every is_seed row, nothing else
  tests/verify_v2.sql              self-check for a real test project
scripts/gen-sql.ts                 generates base.sql; prints first-admin SQL
test/                              vitest: rule tests, API tests, test/sql (PGlite)
public/                            the SPA
docs/GO-LIVE.md                    setup, deploy, switch to production
```

## Commands

```bash
npm install
npm run dev          # local; demo data unless .dev.vars holds Supabase values
npm test             # everything: logic, API end to end, and the SQL suite
npm run test:sql     # only test/sql: the real SQL files on in-process Postgres (PGlite)
npm run typecheck
npm run deploy       # build CSS, then wrangler deploy
npm run db:sql       # regenerate supabase/base.sql (and only that)
npm run db:admin -- "Owner name" owner 'a-long-password'   # print SQL that creates the first admin
npm run db:pin -- 'a-password'          # print one password hash
```

## SQL files and run order

Fresh Supabase project, in the SQL editor:

1. `supabase/schema.sql`
2. `supabase/migrations/20261112_01_foundation.sql` … `20261113_08_username_login.sql`, in name order
3. `supabase/users_roles.sql`
4. `supabase/base.sql`
5. Test projects only: `supabase/seed_mock_data.sql`, then `supabase/tests/verify_v2.sql` (prints `VERIFY_V2 OK`)

On an existing project always re-run the whole sequence 01 to 07 and then
`users_roles.sql`, never a single earlier migration file (migration 07
redefines a function that migration 01 also defines, so a lone re-run of 01
would put the older body back). Re-run `users_roles.sql` after any future
migration so new tables are locked down too. `supabase/purge_seed_data.sql` deletes only rows tagged `is_seed`.
`schema.sql` is the v1 baseline and is never edited; changes go in new
migration files. Step by step: [docs/GO-LIVE.md](docs/GO-LIVE.md).

## Environment

There is no `.env` / `VITE_*` file. Locally the Worker reads `.dev.vars`
(copy `.dev.vars.example`); in Cloudflare the same names are Variables and
Secrets. Do not add a `VITE_` file: nothing in the browser reads one.

| Name | Value | Local | Cloudflare |
|---|---|---|---|
| `SUPABASE_URL` | `https://tpekfhbjbosbeikawkys.supabase.co` (was `VITE_SUPABASE_URL`) | `.dev.vars` | Variable (text) |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key, server side only. There is no anon key (was `VITE_SUPABASE_ANON_KEY`) | `.dev.vars` | Secret |
| `AUTH_SECRET` | 32+ random bytes; signs sessions | `.dev.vars` | Secret |
| `KPV_DATA_MODE` | `test` or `production`; default `production` when Supabase is set, `demo` otherwise | `.dev.vars` | Variable (text) |

Never commit `.dev.vars` (it is git-ignored) or paste the key or `AUTH_SECRET`
anywhere.

### Data mode

- `test`: a "TEST DATA" strip on every screen. Mock accounts can log in.
- `production`: accounts tagged `is_seed` cannot log in (`403
  SEED_ACCOUNT_DISABLED`), are hidden from the login list, and any session they
  already hold stops working. If mock rows are still in the database, admins
  see a strip saying how many.
- `GET /api/meta` (public) returns `{ dataMode, seedRows }`. `seedRows` is the
  total from the `kpv_seed_counts()` RPC and is shown only to a signed-in admin;
  everyone else gets 0. The signed-in screen data (branches, desks, config,
  today, user) moved to `GET /api/app-meta`.

## Roles

Three roles. Staff and managers see only their own branch; admin sees all.

| Action | staff | manager | admin |
|---|---|---|---|
| Day entries, counts, close, moves, receive transfers (own branch) | yes | yes | yes, all branches |
| Take / hand over cases | self / own | own branch | all |
| Reopen a Done day | no | own branch, latest, within 3 days | latest |
| Replenishment rules | read | own branch rules | all |
| Closed days | read | own branch | all |
| Unlock a locked account | no | own branch staff | yes |
| Users (create, role, branch, username, password reset) | no | no | yes |
| SKUs, types, sizes, gold price, config | no (gold price is readable) | no (gold price is readable) | yes |
| Approve / reject proposals, delete documents | no | no | yes |
| Audit history | own case, today | own branch | all |

The Worker returns friendly errors; the database refuses the same actions
through triggers keyed on the acting staff member (the Worker sends
`X-KPV-Actor-Id` on every write).

## The rules

- **Login.** Username + password (stored in Supabase `staff_accounts`:
  `username`, password hash in `pin_hash`); the session lasts 30 days. New
  passwords need 6+ characters; old 4-digit PINs keep working until reset.
  5 wrong passwords lock the account for 15 minutes. Resetting a password,
  moving a branch or deactivating ends that person's sessions.
- **Desk day** (a "case"): not started, check-in, final stock, done, forward
  only. Check-in is refused while an earlier day of that case is not Done. The
  next opening is the physical count of the last Done day. Done needs every row
  counted, a note on every difference and a reason on every destock. A Done day
  is locked in the database; reopening is limited as in the table above and is
  written to the audit log.
- **Dates** are Laos dates (UTC+7). The server decides "today"; a phone's clock
  cannot shift a day. Nobody records the future.
- **Moves** inside a branch are instant, with an Undo for a few seconds.
  **Transfers** to another branch are *in transit* until the receiving case
  confirms; the gold stays in the company total meanwhile.
- **Quantities** are whole pieces, 0 to 99 999. Stock can never go negative.
- **Replenishment.** Avg/day and lead time come from rules (SKU, group or type,
  company-wide or per branch) or are measured from the ledger. The runway tells
  how many days of stock are left; alerts fire inside the lead time plus margin.
- **Value** = Baht weight x gold price (Settings, Gold price; admin edits, others
  read); items without gold weight use their unit price.
- **Dashboard** is computed from each case's latest recorded day. Report:
  opening + in - out + count adjustments = closing.
- **Audit history.** Every change is written by a database trigger and cannot
  be edited. `GET /api/audit` pages newest first with a `before` cursor of the
  form `<created_at>|<id>`: pass the `next` value of the previous page as
  `before`. (The v2 spec calls this parameter `cursor`; the code uses `before`.)

Going live: see [docs/GO-LIVE.md](docs/GO-LIVE.md).
