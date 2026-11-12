# KPV Goldsmith & Retail Inventory

Mobile-first inventory web app for a gold jewelry retail chain — daily desk
stock audits, restock requisitions, executive analytics, stock-movement
reporting, and system configuration. Built on **Cloudflare Workers** (Hono
API + static assets) with **Supabase/Postgres** as the database, styled with
**Tailwind CSS**.

Implements the 5 views from `app.md`: **Daily Stock**, **Orders & Reorder**,
**Dashboard**, **Report**, **Settings**.

## Stack

- **Cloudflare Workers** — serves the static SPA (`/public`) and a JSON API
  (`/api/*`) from one Worker, via [Hono](https://hono.dev).
- **Supabase (Postgres)** — schema in `supabase/schema.sql`, demo data in
  `supabase/seed.sql`. Accessed server-side only, via PostgREST, using the
  service-role key — the browser never talks to Supabase directly.
- **Tailwind CSS** — compiled ahead of time (`npm run build:css`), not the
  runtime CDN build.
- **Vanilla ES modules** on the frontend (no framework) — `public/js/*`.
- **Demo data fallback** — if `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
  aren't configured, the Worker transparently serves an in-memory dataset
  (`src/demoData.ts`) that mirrors `supabase/seed.sql` exactly, so the app is
  fully explorable out of the box with zero setup.

## Project layout

```
src/                  Worker source (TypeScript)
  index.ts            Hono routes (/api/*)
  store.ts            Store interface: SupabaseStore (PostgREST) + DemoStore
  demoData.ts          In-memory seed data (mirrors supabase/seed.sql)
  logic.ts             Pure aggregation/business logic shared by both stores
  types.ts             Shared types
  styles/input.css     Tailwind source
public/                Static assets served by the Worker
  index.html           App shell (bottom nav + 5 view containers)
  css/app.css          Compiled Tailwind output (generated, gitignored)
  js/                  Vanilla ES module frontend
    app.js             Router / boot
    state.js           Shared in-memory app state
    api.js              fetch() wrapper for /api/*
    ui.js               Toast + bottom-sheet modal helpers
    charts.js            Inline-SVG donut + cluster-bar + capacity-bar charts
    util.js               Formatting + icon helpers
    views/*.js            One module per screen
supabase/
  schema.sql           Full Postgres schema (mirrors the original Sheets tabs)
  seed.sql             Demo dataset matching src/demoData.ts
```

## Setup

```bash
npm install
```

### Run locally (demo data, no Supabase needed)

```bash
npm run dev
```

Opens on `http://localhost:8787`. Without Supabase credentials configured,
every screen runs against the built-in demo dataset — fully interactive
(check-in/finalize desks, create requisitions, edit settings), just not
persisted to a real database.

### Connect a real Supabase project

1. Create a Supabase project, open the SQL editor, and run
   `supabase/schema.sql` then `supabase/seed.sql` (seed is optional — it
   gives you the same demo data the in-memory fallback uses, so the two
   stay interchangeable).
2. Copy `.dev.vars.example` to `.dev.vars` and fill in your project's URL and
   **service role key** (Project Settings → API). The service role key stays
   server-side in the Worker and is never sent to the browser.
3. `npm run dev` again — the Worker now reads/writes Supabase instead of the
   in-memory store (confirmed by the "Connected to Supabase" indicator on the
   Settings screen, and by the absence of the "Demo mode" toast on load).

### Deploy

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npm run deploy
```

Omit the `secret put` steps to deploy running on the demo dataset.

## Data model

`supabase/schema.sql` mirrors the five Google Sheets tabs from the original
spec as Postgres tables: `master_sku`, `desks_staff` (+ `branches`),
`daily_stock_ledger`, `orders_requisitions` (+ `order_items`), and
`system_config`. Two more tables, `portfolio_snapshot` and `branch_targets`,
back the Dashboard's enterprise-wide hero card and branch safety-stock
targets — in a production system these would be populated by a nightly
valuation job; here they're seeded directly, decoupled from the day-to-day
desk ledger (the same way the original spec's example figures are
illustrative, not derived from the handful of desk-level demo rows).

Each of the 4 branches (Morning Market, Talat Sao, ITECC, Vangthong) runs its
own 4 desks (Desk 01–04), so the Daily Stock branch selector narrows a
16-desk network down to the 4-card grid the spec describes.

## Notable implementation choices

- **"Download Requisition PDF / Print Order"** is implemented as a
  print-friendly HTML route (`GET /api/orders/:id/print`) opened in a new
  tab — the browser's native "Print → Save as PDF" produces the PDF, rather
  than bundling a PDF-generation library into the Worker.
- **Donut chart categorical colors** (Gold Bars / Necklaces / Bracelets /
  Rings & Accessories) were chosen and validated for colorblind-safe
  adjacent-pair contrast using the project's data-viz palette validator
  before use (amber `#b45309`, teal `#0d9488`, violet `#7c3aed`, rose
  `#e11d48`).
- **Report screen formula fields**: the spec's Wholesale and Transfer/Out
  terms are combined into a single "Whsl/Xfer" input on the Daily Stock entry
  card to keep the touch UI usable on a ~390px screen; the formula legend
  above the entry rows still states the full breakdown.
- The Dashboard/Settings example figures from `app.md` (1,480.5 Baht Gold,
  1,240 Pcs, 88/9/3% stock status, 45/28/15/12% category split, 94/82/68/42%
  branch targets) are reproduced **exactly** in the seed/demo data — the
  underlying counts (1,091/112/37 SKUs, etc.) are generated deterministically
  so the totals always add up.
