# Project Name: KPV Goldsmith & Retail Inventory Mobile Web App
**Architecture**: Cloudflare as FrontEnd and Supabase as the Database, both Free Plan
**Target Platform**: Mobile Web / PWA (responsive portrait ~390px, senior-friendly, touch-first)
**Design System**: Warm golds & deep amber accents (`#b45309`), clean elevated cards, readable typography (`Plus Jakarta Sans`), minimal text, high visual indicators (progress bars, status chips, donut charts).
**Languages**: Lao (ລາວ) and English dual-readability.

---

## 1. System Overview & Architecture
The application runs as a responsive Web App hosted entirely via **Google Apps Script** (`doGet`, `doPost`), storing and reading data from connected **Google Sheets** tabs. It handles high-value gold jewelry inventory, physical desk stocktaking, daily closing audits, purchase orders/requisitions, and executive analytics.

### Google Sheets Database Tabs:
1. `Master_SKU`: SKU ID, Item Name (Lao/Eng), Category, Unit Purity (96.5% / 99.99%), Standard Gram Weight, Baht Weight, Unit Cost, Unit Price, Active Status.
2. `Desks_Staff`: Desk ID (e.g. Desk 01–04), Branch Name (Morning Market, Talat Sao, ITECC, Vangthong), Assigned Staff/Cashier, Role (Admin, Cashier, Auditor).
3. `Daily_Stock_Ledger`: Date, Desk ID, Branch, SKU, Opening Qty, Stock In, Stock Out (Retail Sales, Wholesale, Transfers), Closing Qty, Closing Gram/Baht Weight, Audit Verified Status, Timestamp.
4. `Orders_Requisitions`: PO/Requisition ID, Date, Branch, Requesting Staff/Desk, Item SKU, Order Qty, Status (Pending, Draft, Approved, Dispatched), PDF Export URL.
5. `System_Config`: Refinery Order Lead Time (days), Average Daily Burn Rate (Baht/day), Safety Buffer Reserve (days), Sheet Auto-Sync interval.

---

## 2. Core App Navigation (Bottom Bar & Main Views)
The app is organized into 5 primary modules accessible via a persistent mobile bottom navigation bar:

1. **Daily Stock (ການກວດນັບປະຈຳວັນ)** — Desk card overview & settlement.
2. **Orders & Reorder (ສັ່ງຊື້ ແລະ ເຕີມສະຕັອກ)** — Requisition sheets & PDF order records.
3. **Dashboard (ສະຫຼຸບພາບລວມ)** — Real-time analytics, donut chart & branch cluster bar chart.
4. **Report (ລາຍງານການເຄື່ອນໄຫວ)** — Visual stock movement ledger & branch/desk filtering.
5. **Settings (ຕັ້ງຄ່າລະບົບ)** — SKU manager, staff permissions, lead times & sales burn rate.

---

## 3. Screen Specifications & UI Requirements

### Screen 1: Daily Stock Tracking (Daily Stock Menu)
- **Header**: Active date selector (`Oct 24 ▾`), branch selector (`Morning Market ▾`), and quick status badges.
- **Top Action**: Quick `+ Check-In My Desk (Desk 01)` banner.
- **Filter Tabs**: `All Desks`, `Check In`, `Pending`.
- **Card Grid Layout**:
  - 2-column or max 4-desk visual card row displaying Desk 01, Desk 02, Desk 03, Desk 04.
  - Minimal text; shows staff avatar/initials, gold weight in Baht, total item count, and real-time status pill (`Active`, `Complete`).
  - Action button per card: `Finalize Stock / Done`.
- **Detail Screen (Desk Audit & Entry)**:
  - Morning Check-in vs. Evening Settlement toggle.
  - Formula computation row: `Closing = Opening + Stock In - Retail Sale - Wholesale - Transfer/Out`.
  - Live calculated remaining pieces and remaining value in Baht and USD/LAK.
  - Low stock visual alerts (`< 5 pcs remaining`).
  - Safe drop notes & `Submit Final Closing` button.

### Screen 2: Order Tracking & Reorder (Orders Menu)
- **Purpose**: Document-driven restock approvals and requisition records.
- **Layout**:
  - Filter by Branch (`Morning Market ▾`) and Status chips (`All`, `Pending`, `Approved`).
  - **Quick Action**: `+ New Requisition` which generates a new restock request based on current available desk stock.
  - **Ledger Record Table**: Interactive preview of submitted requisitions grouped by Desk and Timestamp (e.g. Desk 01 • 24 Oct 10:45 AM).
  - Shows SKU items, requested quantities, total gold weight (Baht/g), and current approval status.
  - Quick action to click through the record and **Download Requisition PDF / Print Order**.

### Screen 3: Stock Dashboard (Analytics Menu)
- **Top Hero Card**:
  - Total Physical Gold Stock remaining (e.g., `1,480.5 Baht Gold / 1,240 Pcs`).
  - Portfolio valuation (`$3.85M USD / 125.2B LAK`) with `100% Balanced` audit badge.
  - Real-time spot price ticker: `1 Baht Gold = 32,500,000 LAK`.
- **Inventory Status Card**:
  - Visual 3-color segmented capacity bar: `In Stock 88%` (1,091 SKUs), `Low Stock 9%` (112 SKUs), `Depleted 3%` (37 SKUs).
- **Category Donut / Pie Chart**:
  - Interactive SVG Donut chart displaying share by ornament type: Gold Bars (45%), Necklaces (28%), Bracelets (15%), Rings & Accessories (12%).
- **Branch Stock vs. Safety Target Cluster Chart**:
  - Clustered comparison bar chart across branches: Morning Market (94%), Talat Sao (82%), ITECC (68%), Vangthong (42%).
- **Branch Operations Cards**:
  - Cards for each branch showing remaining Baht volume, health state (`Optimal`, `Restock Needed`, `Alert`), and direct `Review & Reorder Stock` action.

### Screen 4: Stock Movement Report (Report Menu)
- **Purpose**: High-level visual reconciliation adapted from the traditional Excel/Sheets movement ledger.
- **Filtering**: Period dropdown (`Sep 2026 ▾`), Branch dropdown (`Morning Market ▾`), Desk dropdown (`All Desks 01–04 ▾`), with quick search.
- **Visual KPI Metric Strip**:
  - Opening Balance (`₭182.4M` / `6,437 pcs`)
  - Stock In (`+₭26.6M` / `+460 pcs`) in green
  - Stock Out (`-₭55.8M` / `-1,238 pcs`) in amber
  - Closing Balance (`₭153.2M` / `5,659 pcs`)
- **Visual Item Breakdown Cards**:
  - Cards with item icons (pens, coffee mugs, gold jewelry bags, packaging), color-coded delta chips (`+50`, `-120`), unit price, and mini horizontal stock fill bars.
  - Toggle between **Cards View** and **Ledger Table View**.
- **Audit Verification & Floating Footer**:
  - Auditor verification badge (`Vilayphone N. • Verified`).
  - Sticky bottom floating bar showing Net Closing Value (`₭153.2M`) and `Adjust` trigger.

### Screen 5: Settings & Master Config (ຕັ້ງຄ່າລະບົບ)
- **Menu Sections**:
  1. **Google Sheets Sync**: Real-time connected spreadsheet indicator, `Force Sync Now`, and `Open Sheet` direct links.
  2. **SKU & Product Master**: Summary of 1,240 SKUs, purity badges (99.99% & 96.5%), `+ Add New SKU`, and CSV import.
  3. **Staff & Desk Allocation**: Role counts (Admins, Cashiers, Auditors), staff avatar clusters, desk assignment controls.
  4. **Lead Time & Reorder Parameters**:
     - Filled text box for **Refinery Order Lead Time** (e.g. `3.5 Days`) with `+` / `-` touch steppers.
     - Filled text box for **Average Daily Sell Rate** (e.g. `38.2 Baht/day`).
     - Filled text box for **Safety Buffer Reserve** (e.g. `2.0 Days`).
     - Toggle switch: `Auto-Draft Foundry PO`.
     - Primary button: `Save & Recalculate Run Rates`.

---

## 4. UI/UX Style Guidelines for the AI Agent
- **Less Text, More Visual**: Use status chips, icons, progress bars, and badges instead of wordy paragraphs.
- **Touch-Friendly Controls**: Minimum 44px tap targets, large numeric steppers for physical store staff.
- **Color Palette**:
  - Primary / Brand: `#b45309` (Warm Amber / Gold)
  - Success / In-Stock: `#10b981` (Emerald Green)
  - Warning / Reorder: `#f59e0b` (Amber Orange)
  - Danger / Depleted: `#ef4444` (Crimson Red)
  - Backgrounds: `#faf8ff` / `#ffffff` with subtle borders (`#e5e7eb`).