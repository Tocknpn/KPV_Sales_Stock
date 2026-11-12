// Pure business logic shared by every route. Operates only on plain arrays
// returned by the Store interface, so it behaves identically whether the data
// came from Supabase or the in-memory demo store. Every screen that shows a
// reorder point, a value or a weight gets it from the functions in this file,
// so the numbers cannot disagree between screens.
import type {
  Branch,
  Desk,
  MasterSku,
  SkuWeight,
  DeskDay,
  LedgerRow,
  DocumentRecord,
  SystemConfig,
  CardStatus,
  StaffAccount,
  Transfer,
} from "./types";

// A SKU holding more than this many times its reorder point is "overstocked".
const OVERSTOCK_MULTIPLIER = 3;
export const AGING_LOOKBACK_DAYS = 90;
export const MAX_QTY = 99999;

// ---------------------------------------------------------------------------
// Core per-row / per-SKU computations
// ---------------------------------------------------------------------------
export function computeClosing(row: {
  opening_qty: number;
  stock_in: number;
  transfer_in: number;
  retail_sale: number;
  wholesale: number;
  transfer_out: number;
  destock: number;
  move: number;
}) {
  return row.opening_qty + row.stock_in + row.transfer_in - row.retail_sale - row.wholesale - row.transfer_out - row.destock - row.move;
}

export function movementIn(row: Pick<LedgerRow, "stock_in" | "transfer_in">) {
  return row.stock_in + row.transfer_in;
}

export function movementOut(row: Pick<LedgerRow, "retail_sale" | "wholesale" | "transfer_out" | "destock" | "move">) {
  return row.retail_sale + row.wholesale + row.transfer_out + row.destock + row.move;
}

// What a closed day hands to the next day: the physical count when there is
// one, otherwise the calculated closing.
export function carryQty(row: Pick<LedgerRow, "closing_qty" | "counted_qty">) {
  return row.counted_qty ?? row.closing_qty;
}

// Stock "right now" for a ledger row: a Done day is settled at its count; an
// open day is still at its running closing.
export function currentQty(row: Pick<LedgerRow, "closing_qty" | "counted_qty">, dayStatus: CardStatus | undefined) {
  return dayStatus === "done" ? carryQty(row) : row.closing_qty;
}

// Reorder point for one desk's stock of a SKU: enough to cover sales during
// the order lead time plus the safety buffer. Until the admin has filled in
// avg/day and lead time, the SKU's fixed reorder_level is used instead.
export function reorderPoint(
  sku: Pick<MasterSku, "avg_daily_sales" | "order_lead_time_days" | "reorder_level"> | undefined,
  config: Pick<SystemConfig, "safety_buffer_days">
) {
  if (!sku) return 5;
  if (sku.avg_daily_sales != null && sku.avg_daily_sales > 0 && sku.order_lead_time_days != null) {
    return Math.ceil(sku.avg_daily_sales * (sku.order_lead_time_days + (config.safety_buffer_days ?? 0)));
  }
  return sku.reorder_level ?? 5;
}

export function isLowStock(qty: number, point: number) {
  return qty < point;
}

export function bahtOf(sku: Pick<MasterSku, "baht_weight"> | undefined, qty: number) {
  return qty * (sku?.baht_weight ?? 0);
}

export function gramOf(sku: Pick<MasterSku, "std_gram_weight"> | undefined, qty: number) {
  return qty * (sku?.std_gram_weight ?? 0);
}

// Value of `qty` pieces: gold is valued at Baht weight x the gold price the
// admin entered; items with no gold weight (supplies) at their unit price.
export function valueLak(
  sku: Pick<MasterSku, "baht_weight" | "unit_price_lak"> | undefined,
  qty: number,
  config: Pick<SystemConfig, "spot_lak_per_baht">
) {
  if (!sku) return 0;
  const baht = sku.baht_weight ?? 0;
  if (baht > 0) return qty * baht * (config.spot_lak_per_baht ?? 0);
  return qty * (sku.unit_price_lak ?? 0);
}

export function estLifetimeDays(sku: Pick<MasterSku, "avg_daily_sales"> | undefined, qty: number) {
  const avg = sku?.avg_daily_sales ?? null;
  return avg && avg > 0 ? round1(qty / avg) : null;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
// Whole pieces only, never negative. Returns null when the value is not valid.
export function parseQty(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_QTY) return null;
  return value;
}

export type DayRule = "negative_closing" | "destock_note_missing" | "count_missing" | "variance_note_missing";

export interface DayFailure {
  sku_id: string;
  rule: DayRule;
}

function hasText(s: string | null | undefined) {
  return Boolean(s && s.trim());
}

// Everything that must be true before a desk day may be marked Done.
export function validateDeskDay(rows: LedgerRow[]): DayFailure[] {
  const failures: DayFailure[] = [];
  for (const r of rows) {
    if (r.excluded) continue;
    const closing = computeClosing(r);
    if (closing < 0) failures.push({ sku_id: r.sku_id, rule: "negative_closing" });
    if (r.destock > 0 && !hasText(r.destock_note)) failures.push({ sku_id: r.sku_id, rule: "destock_note_missing" });
    if (r.counted_qty == null) failures.push({ sku_id: r.sku_id, rule: "count_missing" });
    else if (r.counted_qty !== closing && !hasText(r.counted_note)) failures.push({ sku_id: r.sku_id, rule: "variance_note_missing" });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Daily Stock
// ---------------------------------------------------------------------------
function lastActor(rows: LedgerRow[], day: DeskDay | undefined, staffById: Map<string, StaffAccount>) {
  const lastRow = rows.reduce<LedgerRow | null>((latest, r) => (!latest || r.updated_at > latest.updated_at ? r : latest), null);
  const actorId = lastRow?.performed_by ?? day?.done_by ?? day?.checked_in_by ?? null;
  return actorId ? staffById.get(actorId)?.display_name ?? null : null;
}

export function buildDeskCards(
  desks: Desk[],
  branches: Branch[],
  skus: MasterSku[],
  days: DeskDay[],
  ledgerRows: LedgerRow[],
  staffAccounts: StaffAccount[],
  config: SystemConfig
) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const staffById = new Map(staffAccounts.map((s) => [s.id, s]));
  const dayByDesk = new Map(days.map((d) => [d.desk_id, d]));
  return desks
    .filter((desk) => desk.active || dayByDesk.has(desk.desk_id))
    .map((desk) => {
      const day = dayByDesk.get(desk.desk_id);
      const status: CardStatus = day?.status ?? "not_started";
      const rows = ledgerRows.filter((r) => r.desk_id === desk.desk_id && !r.excluded);
      let totalPcs = 0;
      let totalBaht = 0;
      let lowStockCount = 0;
      for (const r of rows) {
        const sku = skuById.get(r.sku_id);
        const qty = currentQty(r, status);
        totalPcs += qty;
        totalBaht += bahtOf(sku, qty);
        if (isLowStock(qty, reorderPoint(sku, config))) lowStockCount++;
      }
      const branch = branchById.get(desk.branch_id);
      return {
        desk_id: desk.desk_id,
        branch_id: desk.branch_id,
        branch_name: branch?.name_en ?? desk.branch_id,
        branch_name_lo: branch?.name_lo ?? null,
        display_name: desk.display_name,
        lastActorName: lastActor(rows, day, staffById),
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
  day: DeskDay | undefined,
  skus: MasterSku[],
  ledgerRows: LedgerRow[],
  staffAccounts: StaffAccount[],
  config: SystemConfig,
  weights: SkuWeight[] = []
) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const staffById = new Map(staffAccounts.map((s) => [s.id, s]));
  const weightById = new Map(weights.map((w) => [w.weight_id, w]));
  const status: CardStatus = day?.status ?? "not_started";
  const visibleRows = ledgerRows.filter((r) => !r.excluded);
  const rows = visibleRows.map((r) => {
    const sku = skuById.get(r.sku_id);
    const closing = computeClosing(r);
    const threshold = reorderPoint(sku, config);
    const variance = r.counted_qty != null ? r.counted_qty - closing : null;
    const lifetime = estLifetimeDays(sku, closing);
    const leadTime = sku?.order_lead_time_days ?? null;
    return {
      sku_id: r.sku_id,
      name_en: sku?.name_en ?? r.sku_id,
      name_lo: sku?.name_lo ?? null,
      category: sku?.category ?? "",
      weight_name: sku?.weight_id ? weightById.get(sku.weight_id)?.name_en ?? null : null,
      purity: sku?.purity ?? null,
      icon: sku?.icon ?? "ring",
      opening_qty: r.opening_qty,
      stock_in: r.stock_in,
      transfer_in: r.transfer_in,
      retail_sale: r.retail_sale,
      wholesale: r.wholesale,
      transfer_out: r.transfer_out,
      destock: r.destock,
      destock_note: r.destock_note,
      move: r.move,
      closing_qty: closing,
      closing_baht: round4(bahtOf(sku, closing)),
      closing_gram: round3(gramOf(sku, closing)),
      counted_qty: r.counted_qty,
      counted_note: r.counted_note,
      variance,
      hasVariance: variance !== null && variance !== 0,
      baht_weight_each: sku?.baht_weight ?? 0,
      gram_weight_each: sku?.std_gram_weight ?? 0,
      value_lak: round2(valueLak(sku, closing, config)),
      low_stock: isLowStock(closing, threshold),
      threshold,
      avg_daily_sales: sku?.avg_daily_sales ?? null,
      order_lead_time_days: leadTime,
      est_lifetime_days: lifetime,
      lifetime_alert: lifetime !== null && leadTime !== null && lifetime < leadTime,
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
  const withLifetime = rows.filter((r) => r.est_lifetime_days !== null);
  return {
    desk_id: desk.desk_id,
    branch_id: desk.branch_id,
    branch_name: branch?.name_en ?? desk.branch_id,
    display_name: desk.display_name,
    date: day?.ledger_date ?? null,
    lastActorName: lastActor(visibleRows, day, staffById),
    status,
    safe_drop_note: day?.safe_drop_note ?? null,
    rows,
    totals: {
      pcs: totals.pcs,
      baht: round2(totals.baht),
      gram: round2(totals.gram),
      valueLak: round2(totals.valueLak),
      valueUsd: config.usd_to_lak_rate > 0 ? round2(totals.valueLak / config.usd_to_lak_rate) : 0,
    },
    lowStockItems: rows.filter((r) => r.low_stock).length,
    stockHealth: {
      avgLifetimeDays: withLifetime.length ? round1(withLifetime.reduce((s, r) => s + (r.est_lifetime_days ?? 0), 0) / withLifetime.length) : null,
      alertSkus: rows
        .filter((r) => r.lifetime_alert)
        .sort((a, b) => (a.est_lifetime_days ?? 0) - (b.est_lifetime_days ?? 0))
        .map((r) => ({ sku_id: r.sku_id, name_en: r.name_en, icon: r.icon, est_lifetime_days: r.est_lifetime_days, order_lead_time_days: r.order_lead_time_days })),
    },
  };
}

export interface CalendarDay {
  date: string;
  touchedDesks: number;
  doneDesks: number;
  totalActiveDesks: number;
  // 0 = nothing recorded, 100 = every active desk is Done, in between = partial.
  pct: number;
}

// One cell per day of the month. A desk created mid-month does not make
// earlier days look incomplete (created_at is the cutoff).
export function buildCalendarMonth(monthDates: string[], desks: Desk[], days: DeskDay[]): CalendarDay[] {
  const deskIds = new Set(desks.map((d) => d.desk_id));
  return monthDates.map((date) => {
    const totalActiveDesks = desks.filter((d) => d.active && d.created_at.slice(0, 10) <= date).length;
    const onDate = days.filter((d) => d.ledger_date === date && deskIds.has(d.desk_id));
    const doneDesks = onDate.filter((d) => d.status === "done").length;
    const touchedDesks = onDate.length;
    let pct = 0;
    if (totalActiveDesks > 0 && touchedDesks > 0) {
      // A started-but-unfinished desk counts half, so the ring only closes
      // when every desk is actually Done.
      pct = doneDesks >= totalActiveDesks ? 100 : Math.min(99, round1(((doneDesks + (touchedDesks - doneDesks) * 0.5) / totalActiveDesks) * 100));
    }
    return { date, touchedDesks, doneDesks, totalActiveDesks, pct };
  });
}

export function enrichDocuments(docs: DocumentRecord[], branches: Branch[], desks: Desk[]) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const deskById = new Map(desks.map((d) => [d.desk_id, d]));
  return docs.map((doc) => {
    const rows = doc.rows ?? [];
    return {
      ...doc,
      rows,
      branch_name: branchById.get(doc.branch_id)?.name_en ?? doc.branch_id,
      branch_name_lo: branchById.get(doc.branch_id)?.name_lo ?? null,
      desk_name: doc.desk_id ? deskById.get(doc.desk_id)?.display_name ?? null : null,
      rowCount: rows.length,
      totalWeightG: round2(rows.reduce((s, r) => s + Number(r.weight_g ?? 0), 0)),
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboard — every figure comes from the ledger.
// ---------------------------------------------------------------------------
export interface DashboardFilter {
  branchId?: string;
  deskId?: string;
  category?: string;
  stockFlag?: "low" | "over";
}

export interface DashboardInput {
  today: string;
  skus: MasterSku[];
  branches: Branch[];
  desks: Desk[];
  // Each desk's most recent day and that day's rows = stock right now.
  latestDays: DeskDay[];
  latestRows: LedgerRow[];
  // Rows of the movement period (today or month-to-date).
  movementRows: LedgerRow[];
  // Rows of the aging look-back window.
  agingRows: LedgerRow[];
  inTransit: Transfer[];
  config: SystemConfig;
  filter: DashboardFilter;
}

interface Position {
  desk_id: string;
  branch_id: string;
  sku: MasterSku;
  qty: number;
  point: number;
}

export function buildDashboard(input: DashboardInput) {
  const { today, skus, branches, desks, latestDays, latestRows, movementRows, agingRows, inTransit, config, filter } = input;
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const statusByDesk = new Map(latestDays.map((d) => [d.desk_id, d.status]));
  const categoryOk = (sku: MasterSku | undefined) => Boolean(sku) && (!filter.category || sku!.category === filter.category);

  const positions: Position[] = [];
  for (const r of latestRows) {
    if (r.excluded) continue;
    const sku = skuById.get(r.sku_id);
    if (!sku || !categoryOk(sku)) continue;
    positions.push({
      desk_id: r.desk_id,
      branch_id: r.branch_id,
      sku,
      qty: currentQty(r, statusByDesk.get(r.desk_id)),
      point: reorderPoint(sku, config),
    });
  }

  const low = positions.filter((p) => isLowStock(p.qty, p.point)).sort((a, b) => b.point - b.qty - (a.point - a.qty));
  const over = positions
    .filter((p) => p.point > 0 && p.qty > p.point * OVERSTOCK_MULTIPLIER)
    .sort((a, b) => b.qty - b.point * OVERSTOCK_MULTIPLIER - (a.qty - a.point * OVERSTOCK_MULTIPLIER));
  const watchItem = (p: Position) => ({
    sku_id: p.sku.sku_id,
    name_en: p.sku.name_en,
    name_lo: p.sku.name_lo,
    category: p.sku.category,
    desk_id: p.desk_id,
    branch_id: p.branch_id,
    closing: p.qty,
    reorder_level: p.point,
  });

  // The stock-flag filter narrows the totals/status/donut to just those lines.
  const scoped = filter.stockFlag === "low" ? low : filter.stockFlag === "over" ? over : positions;

  const transit = inTransit.filter((t) => {
    if (!categoryOk(skuById.get(t.sku_id))) return false;
    if (filter.deskId) return t.to_desk_id === filter.deskId;
    if (filter.branchId) return t.to_branch_id === filter.branchId;
    return true;
  });
  let transitPcs = 0;
  let transitBaht = 0;
  let transitLak = 0;
  for (const t of transit) {
    const sku = skuById.get(t.sku_id);
    transitPcs += t.qty;
    transitBaht += bahtOf(sku, t.qty);
    transitLak += valueLak(sku, t.qty, config);
  }

  let pcs = 0;
  let baht = 0;
  let lak = 0;
  for (const p of scoped) {
    pcs += p.qty;
    baht += bahtOf(p.sku, p.qty);
    lak += valueLak(p.sku, p.qty, config);
  }
  // Gold between two desks is still KPV's gold, so it stays in the total.
  if (!filter.stockFlag) {
    pcs += transitPcs;
    baht += transitBaht;
    lak += transitLak;
  }

  const scopedDesks = desks.filter((d) => d.active && (!filter.branchId || d.branch_id === filter.branchId) && (!filter.deskId || d.desk_id === filter.deskId));
  const doneToday = (deskId: string) => latestDays.some((d) => d.desk_id === deskId && d.ledger_date === today && d.status === "done");

  const statusCounts = { in_stock: 0, low_stock: 0, depleted: 0 };
  for (const p of scoped) {
    if (p.qty <= 0) statusCounts.depleted++;
    else if (isLowStock(p.qty, p.point)) statusCounts.low_stock++;
    else statusCounts.in_stock++;
  }
  const lineTotal = scoped.length || 1;
  const capacity = [
    { key: "in_stock", label: "In Stock", count: statusCounts.in_stock, pct: round1((statusCounts.in_stock / lineTotal) * 100), color: "success" },
    { key: "low_stock", label: "Low Stock", count: statusCounts.low_stock, pct: round1((statusCounts.low_stock / lineTotal) * 100), color: "warning" },
    { key: "depleted", label: "Depleted", count: statusCounts.depleted, pct: round1((statusCounts.depleted / lineTotal) * 100), color: "danger" },
  ];

  // Gold by type, as a share of Baht weight (supplies carry no gold weight).
  const bahtByCategory = new Map<string, { baht: number; pcs: number }>();
  for (const p of scoped) {
    const b = bahtOf(p.sku, p.qty);
    if (b <= 0) continue;
    const cur = bahtByCategory.get(p.sku.category) ?? { baht: 0, pcs: 0 };
    cur.baht += b;
    cur.pcs += p.qty;
    bahtByCategory.set(p.sku.category, cur);
  }
  const goldBaht = [...bahtByCategory.values()].reduce((s, v) => s + v.baht, 0);
  const donut = [...bahtByCategory.entries()]
    .map(([category, v]) => ({ category, baht: round2(v.baht), pcs: v.pcs, pct: goldBaht > 0 ? round1((v.baht / goldBaht) * 100) : 0 }))
    .sort((a, b) => b.baht - a.baht);

  const branchCards = branches
    .filter((b) => !filter.branchId || b.branch_id === filter.branchId)
    .map((b) => {
      const mine = scoped.filter((p) => p.branch_id === b.branch_id);
      const myDesks = scopedDesks.filter((d) => d.branch_id === b.branch_id);
      return {
        branch_id: b.branch_id,
        name: b.name_en,
        name_lo: b.name_lo,
        baht: round2(mine.reduce((s, p) => s + bahtOf(p.sku, p.qty), 0)),
        pcs: mine.reduce((s, p) => s + p.qty, 0),
        lakValue: round2(mine.reduce((s, p) => s + valueLak(p.sku, p.qty, config), 0)),
        lowCount: mine.filter((p) => isLowStock(p.qty, p.point)).length,
        desksTotal: myDesks.length,
        desksDoneToday: myDesks.filter((d) => doneToday(d.desk_id)).length,
      };
    });

  return {
    asOf: today,
    portfolio: {
      total_baht_gold: round2(baht),
      total_pcs: pcs,
      lak_value: round2(lak),
      usd_value: config.usd_to_lak_rate > 0 ? round2(lak / config.usd_to_lak_rate) : 0,
      spotLakPerBaht: config.spot_lak_per_baht,
      usdToLakRate: config.usd_to_lak_rate,
      desksTotal: scopedDesks.length,
      desksDoneToday: scopedDesks.filter((d) => doneToday(d.desk_id)).length,
    },
    transit: {
      count: transit.length,
      pcs: transitPcs,
      baht: round2(transitBaht),
      items: transit.slice(0, 20).map((t) => ({
        id: t.id,
        kind: t.kind,
        sku_id: t.sku_id,
        name_en: skuById.get(t.sku_id)?.name_en ?? t.sku_id,
        qty: t.qty,
        from_desk_id: t.from_desk_id,
        to_desk_id: t.to_desk_id,
        sent_date: t.sent_date,
      })),
    },
    capacity,
    donut,
    branchCards,
    movement: buildMovement(movementRows.filter((r) => categoryOk(skuById.get(r.sku_id))), skus, config),
    watchlist: {
      lowCount: low.length,
      overCount: over.length,
      topLow: low.slice(0, 5).map(watchItem),
      topOver: over.slice(0, 5).map(watchItem),
    },
    aging: buildAging(skus, agingRows, filter),
  };
}

export function buildMovement(movementRows: LedgerRow[], skus: MasterSku[], config: SystemConfig) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  let inPcs = 0,
    inLak = 0,
    outPcs = 0,
    outLak = 0;
  for (const r of movementRows) {
    if (r.excluded) continue;
    const sku = skuById.get(r.sku_id);
    inPcs += movementIn(r);
    inLak += valueLak(sku, movementIn(r), config);
    const out = movementOut(r);
    outPcs += out;
    outLak += valueLak(sku, out, config);
  }
  return { inPcs, inLak: round2(inLak), outPcs, outLak: round2(outLak) };
}

// "Days in stock" is an estimate (there is no lot tracking): days since this
// desk last closed the SKU at zero, looking back AGING_LOOKBACK_DAYS.
export function buildAging(skus: MasterSku[], agingRows: LedgerRow[], filter: DashboardFilter) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const groups = new Map<string, LedgerRow[]>();
  for (const r of agingRows) {
    if (r.excluded) continue;
    const key = `${r.desk_id}__${r.sku_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const items: { sku_id: string; name_en: string; name_lo: string | null; category: string; desk_id: string; branch_id: string; estDays: number }[] = [];
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
    items.push({
      sku_id: latest.sku_id,
      name_en: sku.name_en,
      name_lo: sku.name_lo,
      category: sku.category,
      desk_id: latest.desk_id,
      branch_id: latest.branch_id,
      estDays: Math.max(1, Math.round((latestDate - startDate) / 86400000) + 1),
    });
  }

  const avgDays = items.length ? round1(items.reduce((s, i) => s + i.estDays, 0) / items.length) : 0;
  return { avgDays, topAged: [...items].sort((a, b) => b.estDays - a.estDays).slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Report — stock movement over a month.
// Identity: opening + in - out + count adjustments = closing.
// ---------------------------------------------------------------------------
export interface ReportFilter {
  q?: string;
}

export function buildReport(periodRows: LedgerRow[], periodDays: DeskDay[], skus: MasterSku[], filter: ReportFilter, config: SystemConfig) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const statusByDay = new Map(periodDays.map((d) => [`${d.desk_id}__${d.ledger_date}`, d.status]));
  const statusOf = (r: LedgerRow) => statusByDay.get(`${r.desk_id}__${r.ledger_date}`);

  let rows = periodRows.filter((r) => !r.excluded);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((r) => {
      const sku = skuById.get(r.sku_id);
      return r.sku_id.toLowerCase().includes(q) || sku?.name_en.toLowerCase().includes(q) || (sku?.name_lo ?? "").toLowerCase().includes(q);
    });
  }

  const groups = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const key = `${r.desk_id}__${r.sku_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const kpi = {
    opening: { lak: 0, pcs: 0 },
    in: { lak: 0, pcs: 0 },
    out: { lak: 0, pcs: 0 },
    adjust: { lak: 0, pcs: 0 },
    closing: { lak: 0, pcs: 0 },
  };
  const add = (bucket: { lak: number; pcs: number }, sku: MasterSku | undefined, qty: number) => {
    bucket.pcs += qty;
    bucket.lak += valueLak(sku, qty, config);
  };

  const items = [...groups.entries()].map(([key, groupRows]) => {
    const sorted = [...groupRows].sort((a, b) => a.ledger_date.localeCompare(b.ledger_date));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const sku = skuById.get(last.sku_id);
    let inSum = 0;
    let outSum = 0;
    let adjustSum = 0;
    for (const r of sorted) {
      inSum += movementIn(r);
      outSum += movementOut(r);
      // A count adjustment only exists once the day is settled.
      if (statusOf(r) === "done" && r.counted_qty != null) adjustSum += r.counted_qty - r.closing_qty;
    }
    const closing = currentQty(last, statusOf(last));
    add(kpi.opening, sku, first.opening_qty);
    add(kpi.in, sku, inSum);
    add(kpi.out, sku, outSum);
    add(kpi.adjust, sku, adjustSum);
    add(kpi.closing, sku, closing);
    const capacity = Math.max(reorderPoint(sku, config) * 4, 1);
    return {
      key,
      sku_id: last.sku_id,
      name_en: sku?.name_en ?? last.sku_id,
      name_lo: sku?.name_lo ?? null,
      icon: sku?.icon ?? "ring",
      category: sku?.category ?? "",
      delta: inSum - outSum + adjustSum,
      adjust: adjustSum,
      closing_qty: closing,
      value_lak: round2(valueLak(sku, closing, config)),
      fillPct: Math.max(0, Math.min(100, round1((closing / capacity) * 100))),
      desk_id: last.desk_id,
    };
  });

  for (const bucket of Object.values(kpi)) bucket.lak = round2(bucket.lak);
  const doneDays = periodDays.filter((d) => d.status === "done").length;

  return {
    kpi,
    items: items.sort((a, b) => b.closing_qty - a.closing_qty),
    ledgerRows: rows
      .map((r) => ({
        ...r,
        name_en: skuById.get(r.sku_id)?.name_en ?? r.sku_id,
        day_status: statusOf(r) ?? "check_in",
      }))
      .sort((a, b) => b.ledger_date.localeCompare(a.ledger_date) || a.desk_id.localeCompare(b.desk_id)),
    audit: {
      verified: periodDays.length > 0 && doneDays === periodDays.length,
      doneDays,
      totalDays: periodDays.length,
    },
    netClosingLak: kpi.closing.lak,
  };
}

// ---------------------------------------------------------------------------
// Settings summaries
// ---------------------------------------------------------------------------
export function skuSummary(skus: MasterSku[]) {
  const active = skus.filter((s) => s.active);
  const byCategory = new Map<string, number>();
  for (const s of active) byCategory.set(s.category, (byCategory.get(s.category) ?? 0) + 1);
  return {
    total: active.length,
    purity9999: active.filter((s) => s.purity === "99.99%").length,
    purity965: active.filter((s) => s.purity === "96.5%").length,
    categories: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
  };
}

export function staffAccountSummary(staffAccounts: StaffAccount[], branches: Branch[], nowIso: string) {
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const roleCounts: Record<string, number> = { staff: 0, manager: 0, admin: 0 };
  for (const a of staffAccounts) if (a.active) roleCounts[a.role] = (roleCounts[a.role] ?? 0) + 1;
  return {
    roleCounts,
    accounts: staffAccounts.map((a) => ({
      id: a.id,
      branch_id: a.branch_id,
      branch_name: a.branch_id ? branchById.get(a.branch_id)?.name_en ?? a.branch_id : "All branches",
      display_name: a.display_name,
      role: a.role,
      active: a.active,
      locked: Boolean(a.locked_until && a.locked_until > nowIso),
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
