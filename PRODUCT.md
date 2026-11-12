# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: desk staff (Cashiers, Auditors, and desk Admins) physically stationed
at one of KPV's four branches (Morning Market, Talat Sao, ITECC, Vangthong),
each running 4 desks. They perform a morning check-in and an evening
settlement for every desk, every day — entering stock-in, retail sale,
wholesale, and transfer movements for physical gold jewelry and a handful of
retail supplies. This is a live, in-person, time-pressured task done at a
market counter, often by senior/non-technical staff.

Secondary: branch/shop owners and auditors who review the Dashboard and
Report screens for oversight — portfolio valuation, branch health versus
safety-stock targets, and stock-movement reconciliation — and who approve
restock requisitions.

When desk-floor speed and dashboard polish conflict, desk staff needs win.

## Product Purpose

Digitizes KPV's daily physical gold inventory reconciliation, purchase
requisition/reorder tracking, and executive analytics, replacing manual desk
ledgers / spreadsheet tracking. Success means: every desk's daily closing
reconciles accurately with minimal entry errors, low stock is caught and
reordered before a stockout, and owners can trust the real-time valuation and
branch health figures without needing to audit the underlying ledger
themselves.

## Positioning

Purpose-built for physical gold-weight retail, not a generic inventory tool:
tracks stock in Baht-weight units (alongside grams) and purity grade
(96.5% / 99.99%) the way a goldsmith actually counts a desk, ships fully
bilingual (Lao + English) on every staff-facing screen, and runs on a
Cloudflare Workers + Supabase free-tier architecture rather than a
heavyweight ERP.

## Operating Context

- 4 branches, each with its own 4 desks (Desk 01–04); roles are Admin,
  Cashier, Auditor.
- Daily ritual: morning check-in (verify opening stock, receive stock-in),
  evening settlement (record sales/wholesale/transfers, compute closing,
  submit for audit verification).
- Closing formula desk staff work against: Closing = Opening + Stock In −
  Retail Sale − Wholesale − Transfer/Out.
- Restock requisitions are drafted (often from a desk's current low-stock
  items), move through Draft → Pending → Approved → Dispatched, and are
  printed/exported for the foundry/refinery.
- Gold spot price and portfolio valuation are shown in LAK and USD alongside
  Baht-weight gold.

## Capabilities and Constraints

- Must run entirely on Cloudflare Workers (Hono API + static assets) and
  Supabase, both on free-tier plans.
- Supabase is accessed server-side only (service-role key in the Worker);
  the browser never talks to Supabase directly.
- App currently ships with an in-memory demo dataset that mirrors the
  intended Supabase schema exactly, so it runs fully interactive before a
  real Supabase project is connected — undecided/open: a real Supabase
  project is not yet provisioned.
- Low-stock alert threshold is a per-SKU reorder level (desk demo data uses
  <5 pcs).
- Requisition PDF/print is served as a print-friendly HTML page (browser
  "Print → Save as PDF"), not a bundled PDF library.
- Open/undecided: the real branch staff roster, full SKU/product catalog,
  and a live gold spot-price feed are not yet connected — current data is
  placeholder/demo, seeded to match illustrative figures from the original
  spec (`app.md`), not real KPV figures.

## Brand Commitments

- Name: **KPV Goldsmith & Retail Inventory**.
- Palette (confirmed 2026-11-02, superseding the earlier amber brand):
  primary/brand deep maroon `#990000` (full `brand` 50–900 ramp in
  `tailwind.config.js`, HSL(0°,100%,L) anchored at 600); success `#10b981`;
  warning `#f59e0b`; danger `#ee552b` (text-safe shade `#c0330c`) —
  deliberately pulled off brand maroon's hue so error/shortage states never
  read as "just the theme color"; backgrounds `#fdf4f3` (blush-white canvas)
  / `#ffffff` surface with `#e5e7eb` hairline borders. The "Gold Bars" chart
  category keeps literal amber `#b45309` — that's the material, not brand
  chrome.
- Typeface: Plus Jakarta Sans for Latin text, Noto Sans Lao for Lao script.
- Visual language: committed deep-maroon accents on a soft blush ground,
  clean elevated cards, minimal text, high visual indicators (status chips,
  progress bars, donut and cluster charts) over dense paragraphs. Direction
  reference: `.impeccable/surfaces/public-index-html.md`.
- Every staff-facing screen carries both Lao and English labels.

## Evidence on Hand

`app.md` at the project root is the original governing requirements
document (screen-by-screen spec) and remains authoritative for scope.
No real logos, product photography, real SKU catalog, real staff roster, or
real financial figures exist yet. All current branch names, staff names,
SKU list, portfolio valuation, and spot price are demo/placeholder data
seeded to reproduce `app.md`'s illustrative example figures exactly, pending
real data from KPV. Future work must not present this demo data as
confirmed real-world fact without flagging it as such.

## Product Principles

1. **Desk-floor speed first.** Every interaction a cashier performs during a
   live count or sale stays fast and error-resistant, even when it costs the
   Dashboard some polish — confirmed as the tiebreaker when desk operations
   and oversight views pull in different directions.
2. **Trustworthy numbers.** Valuations, closings, and audit status are
   always traceable to real ledger entries, never silently approximated —
   this is money (gold) reconciliation.
3. **Bilingual by default.** Lao and English labels ship together on every
   screen desk staff touch, not as a later localization pass.
4. **Free-tier architecture is a constraint, not a phase.** New features
   should keep working within Cloudflare Workers + Supabase free-tier
   limits.
5. **Senior-friendly, accessible touch UI is baseline.** Large tap targets
   and WCAG 2.1 AA compliance are non-negotiable, not a nice-to-have.

## Accessibility & Inclusion

WCAG 2.1 AA is a confirmed formal requirement (contrast ratios, focus
states, and screen-reader support must meet AA), on top of app.md's
senior-friendly baseline: minimum 44px tap targets, high contrast, minimal
small text, and visual indicators (chips/bars) preferred over dense
paragraphs.
