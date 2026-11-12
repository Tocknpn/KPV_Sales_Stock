# KPV Goldsmith & Retail Inventory

Mobile-first stock app for KPV's gold desks: daily desk counts, linked
transfers between desks, documents and purchase proposals, dashboard and
movement report. **The Lao user manual (`ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html`) is the
specification**; `app.md` is the original brief and is kept for history only.

## Stack

- **Cloudflare Workers** — one Worker serves the SPA (`/public`) and the JSON
  API (`/api/*`), built with [Hono](https://hono.dev). Same origin, no CORS.
- **Supabase (Postgres)** — accessed only by the Worker with the service-role
  key. Row Level Security is on with no policies, so the public key reaches
  nothing.
- **Vanilla ES modules + Tailwind** on the frontend (`npm run build:css`).
- **Demo store** — without Supabase credentials the Worker runs on an
  in-memory demo dataset (`src/demoData.ts`) with exactly the same rules.

## Layout

```
src/
  index.ts            mounts the route modules, maps errors to HTTP
  app.ts              shared route helpers: access scoping, the date rule, day locks
  routes/             auth · stock · transfers · documents · insights · settings
  logic.ts            every computation: closing, reorder point, value, dashboard, report
  store.ts            Store interface — SupabaseStore (PostgREST) and DemoStore
  time.ts             Laos business date (UTC+7), month ranges
  auth.ts             PIN hashing, session tokens, lockout constants
  demoData.ts         demo dataset (relative to today)
supabase/
  schema.sql          tables, Done-day lock trigger, counters, views
  base.sql            production starting data: branches, config, types, sizes
  seed.sql            demo data for testing a Supabase project (wipes app data)
scripts/gen-sql.ts    regenerates base.sql / seed.sql; prints first-admin SQL
test/                 vitest — rule tests and end-to-end API tests
public/               SPA
```

## Commands

```bash
npm install
npm run dev          # local, demo data unless .dev.vars has Supabase keys
npm test             # 49 tests: logic + every API rule end to end
npm run typecheck
npm run db:sql       # regenerate supabase/base.sql and seed.sql
npm run db:admin -- "Owner name" 1234   # print SQL that creates the first admin
npm run deploy
```

## The rules (as the manual describes them)

- **Two roles.** Staff see and change only their own branch. Admin sees every
  branch and alone can: delete documents, approve/reject purchase proposals,
  change SKUs / types / sizes, run rates, gold price, manage users, reopen a
  Done day.
- **Login.** Branch → name → 4-digit PIN; session lasts 30 days. 5 wrong PINs
  lock the account for 15 minutes (admin can unlock). Resetting a PIN, moving
  a branch or deactivating ends that person's sessions.
- **Desk day:** not started → check-in → final stock → ✓ done, forward only.
  - Check-in is refused while an earlier day of that desk is not Done.
  - Next day's opening = the physical count of the last Done day.
  - Done is refused unless every row is counted, every difference has a note,
    every destock has a reason, and no closing is below zero.
  - A Done day is locked in the database itself. Admin can reopen only the
    desk's latest Done day, with a reason (written to the audit log); the next
    day's openings follow the correction.
- **Dates** are Laos dates. Staff record today (or finish an unfinished day);
  admin may record past dates; nobody records the future.
- **Out / Move** pick a destination desk (Out = another branch, Move = same
  branch). The gold is *in transit* until the receiving desk confirms; it
  stays in the company total meanwhile and never blocks anyone's closing.
- **Reorder point** per desk = avg/day × (lead time + safety buffer); SKUs
  without avg/day use their fixed reorder level.
- **Value** = Baht weight × gold price (admin enters it in Settings); items
  without gold weight use their unit price.
- **Dashboard** is computed from each desk's latest recorded day — no stored
  snapshot. Report: opening + in − out + count adjustments = closing.

Going live: see [docs/GO-LIVE.md](docs/GO-LIVE.md).
