// Pure aggregation / business logic shared by every route. Operates only on
// plain arrays returned by the Store interface, so it behaves identically
// whether the data came from Supabase or the in-memory demo store.
import type { Branch, Desk, MasterSku, SkuWeight, LedgerRow, DocumentRecord, BranchTarget, SystemConfig, DeskStatus, CardStatus, StaffAccount } from "./types";

const DONUT_CATEGORIES = ["Gold Bars", "Necklaces", "Bracelets", "Rings & Accessories"] as const;

// A SKU with closing qty beyond reorder_level * this multiplier is flagged
// overstocked on the dashboard watchlist. No separate "max par" field exists
// in the schema, so this rides on the reorder_level the business already sets.
const OVERSTOCK_MULTIPLIER = 3;
const AGING_LOOKBACK_DAYS = 90;

export function computeClosing(row: {
  opening_qty: number;
  stock_in: number;
  retail_sale: number;
  wholesale: number;
  transfer_out: number;
  destock: number;
  move: number;
}) {
  return row.opening_qty + row.stock_in - row.retail_sale - row.wholesale - row.transfer_out - row.destock - row.move;
}

// A desk/date with zero non-excluded rows hasn't been touched yet today
// ("not_started" — never stored, only derived). Otherwise a desk's rows for
// one date are expected to share a single status (the transition route
// updates them together), but this is computed defensively rather than
// trusting that invariant blindly.
export function deskStatusFromRows(rows: LedgerRow[]): CardStatus {
  const active = rows.filter((r) => !r.excluded);
  if (active.length === 0) return "not_started";
  if (active.every((r) => r.desk_status === "done")) return "done";
  if (active.every((r) => r.desk_status !== "check_in")) return "final_stock";
  return "check_in";
}

export function buildDeskCards(desks: Desk[], branches: Branch[], skus: MasterSku[], ledgerRows: LedgerRow[], staffAccounts: StaffAccount[]) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const staffById = new Map(staffAccounts.map((s) => [s.id, s]));
  return desks.map((desk) => {
    const allRows = ledgerRows.filter((r) => r.desk_id === desk.desk_id);
    const rows = allRows.filter((r) => !r.excluded);
    const status = deskStatusFromRows(allRows);
    const totalPcs = rows.reduce((sum, r) => sum + r.closing_qty, 0);
    const totalBaht = rows.reduce((sum, r) => sum + r.closing_baht, 0);
    const lowStockCount = rows.filter((r) => {
      const sku = skuById.get(r.sku_id);
      const threshold = sku?.reorder_level ?? 5;
      return r.closing_qty < threshold;
    }).length;
    const branch = branchById.get(desk.branch_id);
    const lastRow = rows.reduce<LedgerRow | null>((latest, r) => (!latest || r.updated_at > latest.updated_at ? r : latest), null);
    const lastActorName = lastRow?.performed_by ? staffById.get(lastRow.performed_by)?.display_name ?? null : null;
    return {
      desk_id: desk.desk_id,
      branch_id: desk.branch_id,
      branch_name: branch?.name_en ?? desk.branch_id,
      branch_name_lo: branch?.name_lo ?? null,
      display_name: desk.display_name,
      lastActorName,
      status,
      totalPcs,
      totalBaht: round2(totalBaht),
      skuCount: rows.length,
      lowStockCount,
    };
  });
}

export function buildDeskDetail(
  desk: Desk,
  branch: Branch | undefined,
  skus: MasterSku[],
  ledgerRows: LedgerRow[],
  staffAccounts: StaffAccount[],
  config: SystemConfig,
  weights: SkuWeight[] = []
) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const staffById = new Map(staffAccounts.map((s) => [s.id, s]));
  const weightById = new Map(weights.map((w) => [w.weight_id, w]));
  const visibleRows = ledgerRows.filter((r) => !r.excluded);
  const rows = visibleRows.map((r) => {
    const sku = skuById.get(r.sku_id);
    const liveClosingQty = computeClosing(r);
    const bahtWeight = sku?.baht_weight ?? 0;
    const closingBaht = round4(liveClosingQty * bahtWeight);
    const closingGram = round3(liveClosingQty * (sku?.std_gram_weight ?? 0));
    const threshold = sku?.reorder_level ?? 5;
    const variance = r.counted_qty != null ? r.counted_qty - liveClosingQty : null;
    // Est. days of stock left at the SKU's average sell rate — flagged when
    // it would run out before a reorder placed today could arrive (i.e.
    // shorter than the SKU's own order lead time), so the desk screen can
    // surface exactly which items need attention now rather than later.
    const avgDailySales = sku?.avg_daily_sales ?? null;
    const orderLeadTimeDays = sku?.order_lead_time_days ?? null;
    const estLifetimeDays = avgDailySales && avgDailySales > 0 ? round1(liveClosingQty / avgDailySales) : null;
    const lifetimeAlert = estLifetimeDays !== null && orderLeadTimeDays !== null && estLifetimeDays < orderLeadTimeDays;
    return {
      sku_id: r.sku_id,
      name_en: sku?.name_en ?? r.sku_id,
      name_lo: sku?.name_lo ?? null,
      category: sku?.category ?? "Supplies",
      weight_name: sku?.weight_id ? weightById.get(sku.weight_id)?.name_en ?? null : null,
      purity: sku?.purity ?? null,
      icon: sku?.icon ?? "ring",
      opening_qty: r.opening_qty,
      stock_in: r.stock_in,
      retail_sale: r.retail_sale,
      wholesale: r.wholesale,
      transfer_out: r.transfer_out,
      destock: r.destock,
      destock_note: r.destock_note,
      move: r.move,
      closing_qty: liveClosingQty,
      closing_baht: closingBaht,
      closing_gram: closingGram,
      counted_qty: r.counted_qty,
      counted_note: r.counted_note,
      variance,
      hasVariance: variance !== null && variance !== 0,
      baht_weight_each: bahtWeight,
      gram_weight_each: sku?.std_gram_weight ?? 0,
      unit_price_lak: sku?.unit_price_lak ?? 0,
      value_lak: round2(liveClosingQty * (sku?.unit_price_lak ?? 0)),
      low_stock: liveClosingQty < threshold,
      threshold,
      audit_verified: r.audit_verified,
      safe_drop_note: r.safe_drop_note,
      avg_daily_sales: avgDailySales,
      order_lead_time_days: orderLeadTimeDays,
      est_lifetime_days: estLifetimeDays,
      lifetime_alert: lifetimeAlert,
    };
  });
  const totals = rows.reduce(
    (acc, r) => {
      acc.pcs += r.closing_qty;
      acc.baht += r.closing_baht;
      acc.gram += r.closing_gram;
      acc.valueLak += r.value_lak;
      return acc;
    },
    { pcs: 0, baht: 0, gram: 0, valueLak: 0 }
  );
  const lastRow = visibleRows.reduce<LedgerRow | null>((latest, r) => (!latest || r.updated_at > latest.updated_at ? r : latest), null);
  const lastActorName = lastRow?.performed_by ? staffById.get(lastRow.performed_by)?.display_name ?? null : null;
  return {
    desk_id: desk.desk_id,
    branch_id: desk.branch_id,
    branch_name: branch?.name_en ?? desk.branch_id,
    display_name: desk.display_name,
    lastActorName,
    status: deskStatusFromRows(ledgerRows),
    rows,
    totals: {
      pcs: totals.pcs,
      baht: round2(totals.baht),
      gram: round2(totals.gram),
      valueLak: round2(totals.valueLak),
      valueUsd: round2(totals.valueLak / (config.usd_to_lak_rate || 1)),
    },
    lowStockItems: rows.filter((r) => r.low_stock).length,
    stockHealth: buildStockHealth(rows),
  };
}

function buildStockHealth(rows: { sku_id: string; name_en: string; icon: string; est_lifetime_days: number | null; order_lead_time_days: number | null; lifetime_alert: boolean }[]) {
  const withLifetime = rows.filter((r) => r.est_lifetime_days !== null);
  const avgLifetimeDays = withLifetime.length ? round1(withLifetime.reduce((s, r) => s + (r.est_lifetime_days ?? 0), 0) / withLifetime.length) : null;
  const alertSkus = rows
    .filter((r) => r.lifetime_alert)
    .sort((a, b) => (a.est_lifetime_days ?? 0) - (b.est_lifetime_days ?? 0))
    .map((r) => ({ sku_id: r.sku_id, name_en: r.name_en, icon: r.icon, est_lifetime_days: r.est_lifetime_days, order_lead_time_days: r.order_lead_time_days }));
  return { avgLifetimeDays, alertSkus };
}

export interface CalendarDay {
  date: string;
  touchedDesks: number;
  totalActiveDesks: number;
  pct: number;
}

// One cell per day of the month: how many of this branch's Desks (active as
// of that day, using created_at as the cutoff so a Desk created mid-month
// doesn't retroactively make earlier days look incomplete) have any
// non-excluded ledger row that date.
export function buildCalendarMonth(monthDates: string[], desks: Desk[], ledgerRows: LedgerRow[]): CalendarDay[] {
  return monthDates.map((date) => {
    const totalActiveDesks = desks.filter((d) => d.active && d.created_at.slice(0, 10) <= date).length;
    const touchedDeskIds = new Set(
      ledgerRows.filter((r) => r.ledger_date === date && !r.excluded).map((r) => r.desk_id)
    );
    const touchedDesks = [...touchedDeskIds].filter((id) => desks.some((d) => d.desk_id === id)).length;
    return {
      date,
      touchedDesks,
      totalActiveDesks,
      pct: totalActiveDesks > 0 ? round1((touchedDesks / totalActiveDesks) * 100) : 0,
    };
  });
}

export function enrichDocuments(docs: DocumentRecord[], branches: Branch[], desks: Desk[]) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const deskById = new Map(desks.map((d) => [d.desk_id, d]));
  return docs.map((doc) => {
    const rows = doc.rows ?? [];
    const totalWeightG = round2(rows.reduce((s, r) => s + (r.weight_g ?? 0), 0));
    return {
      ...doc,
      rows,
      branch_name: branchById.get(doc.branch_id)?.name_en ?? doc.branch_id,
      branch_name_lo: branchById.get(doc.branch_id)?.name_lo ?? null,
      desk_name: doc.desk_id ? deskById.get(doc.desk_id)?.display_name ?? null : null,
      rowCount: rows.length,
      totalWeightG,
    };
  });
}

export interface DashboardFilter {
  branchId?: string;
  deskId?: string;
  category?: string;
  stockFlag?: "low" | "over";
}

interface WatchItem {
  sku_id: string;
  name_en: string;
  name_lo: string | null;
  category: string;
  closing: number;
  reorder_level: number;
}

export function buildWatchlist(skus: MasterSku[], snapshotRows: LedgerRow[], filter: DashboardFilter) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const closingBySku = new Map<string, number>();
  for (const r of snapshotRows) closingBySku.set(r.sku_id, (closingBySku.get(r.sku_id) ?? 0) + r.closing_qty);

  const low: WatchItem[] = [];
  const over: WatchItem[] = [];
  for (const [sku_id, closing] of closingBySku) {
    const sku = skuById.get(sku_id);
    if (!sku || !sku.active) continue;
    if (filter.category && sku.category !== filter.category) continue;
    const threshold = sku.reorder_level ?? 5;
    const item: WatchItem = { sku_id, name_en: sku.name_en, name_lo: sku.name_lo, category: sku.category, closing, reorder_level: threshold };
    if (closing < threshold) low.push(item);
    else if (closing > threshold * OVERSTOCK_MULTIPLIER) over.push(item);
  }
  low.sort((a, b) => b.reorder_level - b.closing - (a.reorder_level - a.closing));
  over.sort((a, b) => b.closing - b.reorder_level * OVERSTOCK_MULTIPLIER - (a.closing - a.reorder_level * OVERSTOCK_MULTIPLIER));

  return { lowCount: low.length, overCount: over.length, allLow: low, allOver: over };
}

interface AgingItem {
  sku_id: string;
  name_en: string;
  name_lo: string | null;
  category: string;
  desk_id: string;
  branch_id: string;
  estDays: number;
}

// "Days in stock" has no lot/batch tracking in the schema — this is an
// estimate: days since the last time this (desk, sku) ledger closed at zero,
// scanning backward through AGING_LOOKBACK_DAYS of history.
export function buildAging(skus: MasterSku[], agingRows: LedgerRow[], filter: DashboardFilter) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const groups = new Map<string, LedgerRow[]>();
  for (const r of agingRows) {
    const key = `${r.desk_id}__${r.sku_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const items: AgingItem[] = [];
  for (const groupRows of groups.values()) {
    const sorted = [...groupRows].sort((a, b) => b.ledger_date.localeCompare(a.ledger_date));
    const latest = sorted[0];
    if (latest.closing_qty <= 0) continue;
    const sku = skuById.get(latest.sku_id);
    if (!sku || !sku.active) continue;
    if (filter.category && sku.category !== filter.category) continue;

    let runStart = latest;
    for (const row of sorted) {
      if (row.closing_qty <= 0) break;
      runStart = row;
    }
    const latestDate = new Date(`${latest.ledger_date}T00:00:00Z`).getTime();
    const startDate = new Date(`${runStart.ledger_date}T00:00:00Z`).getTime();
    const estDays = Math.max(1, Math.round((latestDate - startDate) / 86400000) + 1);

    items.push({
      sku_id: latest.sku_id,
      name_en: sku.name_en,
      name_lo: sku.name_lo,
      category: sku.category,
      desk_id: latest.desk_id,
      branch_id: latest.branch_id,
      estDays,
    });
  }

  const avgDays = items.length ? round1(items.reduce((s, i) => s + i.estDays, 0) / items.length) : 0;
  const topAged = [...items].sort((a, b) => b.estDays - a.estDays).slice(0, 5);
  return { avgDays, topAged };
}

export function buildMovement(movementRows: LedgerRow[], skus: MasterSku[]) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  let inPcs = 0,
    inLak = 0,
    outPcs = 0,
    outLak = 0;
  for (const r of movementRows) {
    const price = skuById.get(r.sku_id)?.unit_price_lak ?? 0;
    inPcs += r.stock_in;
    inLak += r.stock_in * price;
    const out = r.retail_sale + r.wholesale + r.transfer_out + r.destock + r.move;
    outPcs += out;
    outLak += out * price;
  }
  return { inPcs, inLak: round2(inLak), outPcs, outLak: round2(outLak) };
}

export function buildDashboard(
  skus: MasterSku[],
  branches: Branch[],
  branchTargets: BranchTarget[],
  snapshotRows: LedgerRow[],
  movementRows: LedgerRow[],
  agingRows: LedgerRow[],
  portfolio: { total_baht_gold: number; total_pcs: number; usd_value: number; lak_value: number; audit_balanced_pct: number },
  config: SystemConfig,
  filter: DashboardFilter = {}
) {
  const watchlist = buildWatchlist(skus, snapshotRows, filter);
  const aging = buildAging(skus, agingRows, filter);
  const movement = buildMovement(movementRows, skus);

  let scopedSkuIds: Set<string> | null = null;
  if (filter.stockFlag === "low") scopedSkuIds = new Set(watchlist.allLow.map((i) => i.sku_id));
  else if (filter.stockFlag === "over") scopedSkuIds = new Set(watchlist.allOver.map((i) => i.sku_id));

  const donutUniverse = skus.filter((s) => {
    if (!(DONUT_CATEGORIES as readonly string[]).includes(s.category)) return false;
    if (filter.category && s.category !== filter.category) return false;
    if (scopedSkuIds && !scopedSkuIds.has(s.sku_id)) return false;
    return true;
  });
  const total = donutUniverse.length || 1;

  const statusCounts = { in_stock: 0, low_stock: 0, depleted: 0 };
  for (const s of donutUniverse) statusCounts[s.status]++;
  const capacity = [
    { key: "in_stock", label: "In Stock", count: statusCounts.in_stock, pct: round1((statusCounts.in_stock / total) * 100), color: "success" },
    { key: "low_stock", label: "Low Stock", count: statusCounts.low_stock, pct: round1((statusCounts.low_stock / total) * 100), color: "warning" },
    { key: "depleted", label: "Depleted", count: statusCounts.depleted, pct: round1((statusCounts.depleted / total) * 100), color: "danger" },
  ];

  const categoryCounts = new Map<string, number>();
  for (const cat of DONUT_CATEGORIES) categoryCounts.set(cat, 0);
  for (const s of donutUniverse) categoryCounts.set(s.category, (categoryCounts.get(s.category) ?? 0) + 1);
  const donut = DONUT_CATEGORIES.map((cat) => ({
    category: cat,
    count: categoryCounts.get(cat) ?? 0,
    pct: round1(((categoryCounts.get(cat) ?? 0) / total) * 100),
  }));

  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const scopedTargets = branchTargets.filter((t) => !filter.branchId || t.branch_id === filter.branchId);
  const branchCluster = scopedTargets.map((t) => ({
    branch_id: t.branch_id,
    name: branchById.get(t.branch_id)?.name_en ?? t.branch_id,
    current: t.current_baht,
    target: t.target_baht,
    pct: round1((t.current_baht / t.target_baht) * 100),
  }));

  const branchCards = scopedTargets.map((t) => {
    const branch = branchById.get(t.branch_id);
    const liveFloorBaht = round2(
      snapshotRows.filter((r) => r.branch_id === t.branch_id).reduce((sum, r) => sum + r.closing_baht, 0)
    );
    return {
      branch_id: t.branch_id,
      name: branch?.name_en ?? t.branch_id,
      name_lo: branch?.name_lo ?? null,
      remainingBaht: t.current_baht,
      liveFloorBaht,
      targetBaht: t.target_baht,
      pct: round1((t.current_baht / t.target_baht) * 100),
      health: t.health_state,
    };
  });

  return {
    portfolio: {
      ...portfolio,
      spotLakPerBaht: config.spot_lak_per_baht,
      usdToLakRate: config.usd_to_lak_rate,
    },
    capacity,
    donut,
    branchCluster,
    branchCards,
    movement,
    watchlist: {
      lowCount: watchlist.lowCount,
      overCount: watchlist.overCount,
      topLow: watchlist.allLow.slice(0, 5),
      topOver: watchlist.allOver.slice(0, 5),
    },
    aging: {
      avgDays: aging.avgDays,
      topAged: aging.topAged,
    },
  };
}

export interface ReportFilter {
  period?: string; // "YYYY-MM"
  branchId?: string;
  deskId?: string;
  q?: string;
}

export function buildReport(
  filteredRows: LedgerRow[],
  skus: MasterSku[],
  desks: Desk[],
  filter: ReportFilter,
  config: SystemConfig
) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  let rows = filteredRows;
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((r) => {
      const sku = skuById.get(r.sku_id);
      return (
        r.sku_id.toLowerCase().includes(q) ||
        sku?.name_en.toLowerCase().includes(q) ||
        (sku?.name_lo ?? "").toLowerCase().includes(q)
      );
    });
  }

  // earliest/latest row per (desk,sku) group within the filtered range —
  // with a single seeded demo day these coincide; across a real multi-day
  // Supabase ledger this naturally spans the period.
  const groups = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const key = `${r.desk_id}__${r.sku_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  let openingPcs = 0,
    inPcs = 0,
    outPcs = 0,
    closingPcs = 0;
  let openingLak = 0,
    inLak = 0,
    outLak = 0,
    closingLak = 0;

  for (const groupRows of groups.values()) {
    const sorted = [...groupRows].sort((a, b) => a.ledger_date.localeCompare(b.ledger_date));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const price = skuById.get(first.sku_id)?.unit_price_lak ?? 0;

    openingPcs += first.opening_qty;
    openingLak += first.opening_qty * price;
    closingPcs += last.closing_qty;
    closingLak += last.closing_qty * price;
    for (const r of sorted) {
      inPcs += r.stock_in;
      inLak += r.stock_in * price;
      const out = r.retail_sale + r.wholesale + r.transfer_out + r.destock + r.move;
      outPcs += out;
      outLak += out * price;
    }
  }

  const items = [...groups.entries()].map(([key, groupRows]) => {
    const sorted = [...groupRows].sort((a, b) => a.ledger_date.localeCompare(b.ledger_date));
    const last = sorted[sorted.length - 1];
    const sku = skuById.get(last.sku_id);
    const inSum = sorted.reduce((s, r) => s + r.stock_in, 0);
    const outSum = sorted.reduce((s, r) => s + r.retail_sale + r.wholesale + r.transfer_out + r.destock + r.move, 0);
    const delta = inSum - outSum;
    const capacity = (sku?.reorder_level ?? 5) * 4;
    return {
      key,
      sku_id: last.sku_id,
      name_en: sku?.name_en ?? last.sku_id,
      name_lo: sku?.name_lo ?? null,
      icon: sku?.icon ?? "ring",
      category: sku?.category ?? "Supplies",
      delta,
      closing_qty: last.closing_qty,
      unit_price_lak: sku?.unit_price_lak ?? 0,
      fillPct: Math.max(0, Math.min(100, round1((last.closing_qty / Math.max(capacity, 1)) * 100))),
      desk_id: last.desk_id,
    };
  });

  const allVerified = rows.length > 0 && rows.every((r) => r.audit_verified);

  return {
    kpi: {
      opening: { lak: round2(openingLak), pcs: openingPcs },
      in: { lak: round2(inLak), pcs: inPcs },
      out: { lak: round2(outLak), pcs: outPcs },
      closing: { lak: round2(closingLak), pcs: closingPcs },
    },
    items: items.sort((a, b) => b.closing_qty - a.closing_qty),
    ledgerRows: rows
      .map((r) => ({
        ...r,
        name_en: skuById.get(r.sku_id)?.name_en ?? r.sku_id,
      }))
      .sort((a, b) => b.ledger_date.localeCompare(a.ledger_date)),
    audit: {
      verified: allVerified,
    },
    netClosingLak: round2(closingLak),
  };
}

export function skuSummary(skus: MasterSku[]) {
  const active = skus.filter((s) => s.active);
  const purity9999 = active.filter((s) => s.purity === "99.99%").length;
  const purity965 = active.filter((s) => s.purity === "96.5%").length;
  const byCategory = new Map<string, number>();
  for (const s of active) byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
  return {
    total: active.length,
    purity9999,
    purity965,
    categories: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
  };
}

export function staffAccountSummary(staffAccounts: StaffAccount[], branches: Branch[]) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const roleCounts: Record<string, number> = { staff: 0, admin: 0 };
  for (const a of staffAccounts) roleCounts[a.role] = (roleCounts[a.role] ?? 0) + 1;
  return {
    roleCounts,
    accounts: staffAccounts.map((a) => ({
      id: a.id,
      branch_name: a.branch_id ? branchById.get(a.branch_id)?.name_en ?? a.branch_id : "All branches",
      display_name: a.display_name,
      role: a.role,
      active: a.active,
    })),
  };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
export function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}
