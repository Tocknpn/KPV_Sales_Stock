// Pure business logic shared by every route. Operates only on plain arrays
// returned by the Store interface, so it behaves identically whether the data
// came from Supabase or the in-memory demo store. Every screen that shows a
// reorder point, a value or a weight gets it from the functions in this file,
// so the numbers cannot disagree between screens.
import { skuLabel } from "./skuName";
import type {
  Branch,
  Desk,
  MasterSku,
  SkuWeight,
  SkuType,
  DeskDay,
  LedgerRow,
  DocumentRecord,
  SystemConfig,
  CardStatus,
  StaffAccount,
  Transfer,
  DeskStatus,
  StockOutMode,
} from "./types";
import type { LedgerChangeField } from "./store";

// A SKU holding more than this many times its reorder point is "overstocked".
const OVERSTOCK_MULTIPLIER = 3;
export const AGING_LOOKBACK_DAYS = 90;
export const MAX_QTY = 99999;

// ---------------------------------------------------------------------------
// Core per-row / per-SKU computations
// ---------------------------------------------------------------------------
type ClosingInput = Pick<
  LedgerRow,
  "opening_qty" | "stock_in" | "transfer_in" | "retail_sale" | "wholesale" | "transfer_out" | "destock" | "move"
> & { stock_out_single?: number; move_qty?: number; withdraw?: number };

// Same formula as the generated closing_qty column (migration 11).
export function computeClosing(row: ClosingInput) {
  return (
    row.opening_qty + row.stock_in + row.transfer_in - row.transfer_out - row.move -
    stockOutOf(row) + (row.move_qty ?? 0)
  );
}

// The day's stock-out in either mode (= the generated stock_out column).
export function stockOutOf(row: Pick<LedgerRow, "retail_sale" | "wholesale" | "destock"> & { stock_out_single?: number; withdraw?: number }) {
  return row.retail_sale + row.wholesale + row.destock + (row.withdraw ?? 0) + (row.stock_out_single ?? 0);
}

// Units sold: retail + wholesale on a dynamic day; on a single-mode day the
// typed total, which cannot be split.
export function soldOf(row: Pick<LedgerRow, "retail_sale" | "wholesale"> & { stock_out_single?: number; withdraw?: number }) {
  return row.retail_sale + row.wholesale + (row.withdraw ?? 0) + (row.stock_out_single ?? 0);
}

// Signed net of every move column: old linked moves/transfers and Move in/out.
export function netMoveOf(row: Pick<LedgerRow, "transfer_in" | "transfer_out" | "move"> & { move_qty?: number }) {
  return row.transfer_in - row.transfer_out - row.move + (row.move_qty ?? 0);
}

export function movementIn(row: Pick<LedgerRow, "stock_in" | "transfer_in"> & { move_qty?: number }) {
  return row.stock_in + row.transfer_in + Math.max(row.move_qty ?? 0, 0);
}

export function movementOut(
  row: Pick<LedgerRow, "retail_sale" | "wholesale" | "transfer_out" | "destock" | "move"> & { stock_out_single?: number; move_qty?: number; withdraw?: number }
) {
  return stockOutOf(row) + row.transfer_out + row.move + Math.max(-(row.move_qty ?? 0), 0);
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

// Reorder point from a branch status: enough to cover sales during the lead
// time plus the warning margin (the level that clears the warning). 0 = not
// known yet (no avg/day), so nothing can be "over" it either.
export function reorderPoint(
  st: { avg: { value: number | null }; lead: { value: number } } | undefined,
  config: Pick<SystemConfig, "warning_margin_days">
) {
  const avg = st?.avg.value ?? null;
  if (avg == null || avg <= 0) return 0;
  return Math.ceil(avg * (st!.lead.value + (config.warning_margin_days ?? 0)));
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

// Value of `qty` pieces: every SKU is gold (decided 2026-11-17), valued at its
// Baht weight x the gold price passed in (resolved by resolveGoldPrice).
export function valueLak(sku: Pick<MasterSku, "baht_weight"> | undefined, qty: number, lakPerBaht: number) {
  if (!sku) return 0;
  return qty * (sku.baht_weight ?? 0) * (lakPerBaht ?? 0);
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

// Signed whole pieces for Move in/out (−MAX_QTY..MAX_QTY).
export function parseSignedQty(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > MAX_QTY) return null;
  return value;
}

export type DayRule = "negative_closing";

export interface DayFailure {
  sku_id: string;
  rule: DayRule;
}

// Fields staff may change in each step of the day (single mode swaps the four outs for one total).
export function stepFields(status: DeskStatus, mode: StockOutMode): readonly LedgerChangeField[] {
  if (status === "opening") return ["stock_in", "opening_qty"];
  if (status === "check_in" || status === "final_stock") {
    return mode === "single" ? ["stock_in", "stock_out_single"] : ["stock_in", "retail_sale", "wholesale", "destock", "withdraw"];
  }
  return [];
}

// Everything that must be true before a desk day may be marked Done.
export function validateDeskDay(rows: LedgerRow[]): DayFailure[] {
  const failures: DayFailure[] = [];
  for (const r of rows) {
    if (r.excluded) continue;
    const closing = computeClosing(r);
    if (closing < 0) failures.push({ sku_id: r.sku_id, rule: "negative_closing" });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Daily Stock
// ---------------------------------------------------------------------------
// Who touched the case last and when, from the same row that gave the name:
// the newest ledger row, else the day's done_by / checked_in_by stamp.
function lastActor(rows: LedgerRow[], day: DeskDay | undefined, staffById: Map<string, StaffAccount>): { name: string; at: string | null } | null {
  const lastRow = rows.reduce<LedgerRow | null>((latest, r) => (!latest || r.updated_at > latest.updated_at ? r : latest), null);
  let actorId: string | null;
  let at: string | null;
  if (lastRow?.performed_by) [actorId, at] = [lastRow.performed_by, lastRow.updated_at];
  else if (day?.done_by) [actorId, at] = [day.done_by, day.done_at ?? null];
  else [actorId, at] = [day?.checked_in_by ?? null, day?.created_at ?? null];
  const name = actorId ? staffById.get(actorId)?.display_name : undefined;
  return name ? { name, at } : null;
}

// Branch-wide replenishment status of a SKU, keyed "branchId|skuId". Structural
// so logic.ts does not depend on replenishment.ts (which depends on it).
export type BranchStatuses = Map<string, { status: "critical" | "warning" | "ok" | "no_data"; position: number; onHand: number; avg: { value: number | null }; lead: { value: number }; runwayDays: number | null }>;

export function buildDeskCards(
  desks: Desk[],
  branches: Branch[],
  skus: MasterSku[],
  days: DeskDay[],
  ledgerRows: LedgerRow[],
  staffAccounts: StaffAccount[],
  _config: SystemConfig,
  // Branch-wide status per "branchId|skuId" (see loadBranchStatuses).
  statuses: BranchStatuses = new Map(),
  // Today's resolved gold price, for each card's value in LAK.
  lakPerBaht = 0,
  // Each desk's most recent EARLIER day (rows + that day's status). A case not
  // checked in yet shows what it last held instead of 0.
  carried: Map<string, { rows: LedgerRow[]; status: CardStatus | undefined }> = new Map()
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
      const own = ledgerRows.filter((r) => r.desk_id === desk.desk_id && !r.excluded);
      const prior = own.length === 0 && status === "not_started" ? carried.get(desk.desk_id) : undefined;
      const rows = prior ? prior.rows.filter((r) => !r.excluded) : own;
      const qtyStatus = prior ? prior.status : status;
      let totalPcs = 0;
      let totalBaht = 0;
      let totalLak = 0;
      // SKUs on this case whose BRANCH-wide runway is Critical (a case alone says nothing).
      let criticalCount = 0;
      for (const r of rows) {
        const sku = skuById.get(r.sku_id);
        const qty = currentQty(r, qtyStatus);
        totalPcs += qty;
        totalBaht += bahtOf(sku, qty);
        totalLak += valueLak(sku, qty, lakPerBaht);
        if (statuses.get(`${desk.branch_id}|${r.sku_id}`)?.status === "critical") criticalCount++;
      }
      const branch = branchById.get(desk.branch_id);
      const actor = lastActor(own, day, staffById);
      return {
        desk_id: desk.desk_id,
        branch_id: desk.branch_id,
        branch_name: branch?.name_en ?? desk.branch_id,
        branch_name_lo: branch?.name_lo ?? null,
        display_name: desk.display_name,
        lastActorName: actor?.name ?? null,
        lastActorAt: actor?.at ?? null,
        status,
        totalPcs,
        totalBaht: round2(totalBaht),
        valueLak: round2(totalLak),
        skuCount: rows.length,
        criticalCount,
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
  weights: SkuWeight[] = [],
  // Branch-wide status per "branchId|skuId"; the only source of low-stock alerts.
  statuses: BranchStatuses = new Map(),
  lakPerBaht: number,
  types: SkuType[] = []
) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const typeById = new Map(types.map((ty, i) => [ty.type_id, { ty, order: ty.sort_order ?? i }]));
  const staffById = new Map(staffAccounts.map((s) => [s.id, s]));
  const weightById = new Map(weights.map((w) => [w.weight_id, w]));
  const status: CardStatus = day?.status ?? "not_started";
  const visibleRows = ledgerRows.filter((r) => !r.excluded);
  const rows = visibleRows.map((r) => {
    const sku = skuById.get(r.sku_id);
    const closing = computeClosing(r);
    const branchRow = statuses.get(`${desk.branch_id}|${r.sku_id}`);
    const avg = branchRow?.avg.value ?? null;
    const variance = r.counted_qty != null ? r.counted_qty - closing : null;
    const lifetime = avg != null && avg > 0 ? round1(closing / avg) : null;
    const leadTime = avg != null ? branchRow?.lead.value ?? null : null;
    return {
      sku_id: r.sku_id,
      name_en: sku?.name_en ?? r.sku_id,
      name_lo: sku?.name_lo ?? null,
      category: sku?.category ?? "",
      weight_name: sku?.weight_id ? weightById.get(sku.weight_id)?.name_en ?? null : null,
      // The day grid groups by Type, labelled in Lao.
      type_id: sku?.type_id ?? null,
      type_label: (sku?.type_id && (typeById.get(sku.type_id)?.ty.name_lo || typeById.get(sku.type_id)?.ty.name_en)) || sku?.category || "",
      type_order: (sku?.type_id && typeById.get(sku.type_id)?.order) ?? 999,
      // for the Lao size label (ບາດ / ສະລຶງ / ຫຸນ / ກລາມ)
      baht_weight: sku?.baht_weight ?? null,
      std_gram_weight: sku?.std_gram_weight ?? null,
      icon: sku?.icon ?? "ring",
      opening_qty: r.opening_qty,
      stock_in: r.stock_in,
      transfer_in: r.transfer_in,
      retail_sale: r.retail_sale,
      wholesale: r.wholesale,
      transfer_out: r.transfer_out,
      destock: r.destock,
      withdraw: r.withdraw ?? 0,
      move: r.move,
      stock_out_single: r.stock_out_single ?? 0,
      stock_out: stockOutOf(r),
      move_qty: r.move_qty ?? 0,
      legacy_move: netMoveOf(r),
      closing_qty: closing,
      closing_baht: round4(bahtOf(sku, closing)),
      closing_gram: round3(gramOf(sku, closing)),
      counted_qty: r.counted_qty,
      counted_note: r.counted_note,
      variance,
      hasVariance: variance !== null && variance !== 0,
      baht_weight_each: sku?.baht_weight ?? 0,
      gram_weight_each: sku?.std_gram_weight ?? 0,
      value_lak: round2(valueLak(sku, closing, lakPerBaht)),
      branch_status: branchRow?.status ?? "no_data",
      runway_days: branchRow?.runwayDays ?? null,
      avg_daily_sales: avg,
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
    lastActorName: lastActor(visibleRows, day, staffById)?.name ?? null,
    status,
    stock_out_mode: day?.stock_out_mode ?? config.stock_out_mode ?? "dynamic",
    safe_drop_note: day?.safe_drop_note ?? null,
    // For the "Closed 18:42 by Noy" banner and the "Changed by Noy" conflict prompt.
    closed_at: day?.done_at ?? null,
    closed_by_name: day?.done_by ? staffById.get(day.done_by)?.display_name ?? null : null,
    // Only people who touched this desk's day, not every account company-wide.
    actors: Object.fromEntries(
      [...new Set([...ledgerRows.map((r) => r.performed_by), day?.done_by, day?.checked_in_by])]
        .filter((id): id is string => Boolean(id) && staffById.has(id as string))
        .map((id) => [id, staffById.get(id)!.display_name])
    ),
    rows,
    totals: {
      pcs: totals.pcs,
      baht: round2(totals.baht),
      gram: round2(totals.gram),
      valueLak: round2(totals.valueLak),
      valueUsd: config.usd_to_lak_rate > 0 ? round2(totals.valueLak / config.usd_to_lak_rate) : 0,
    },
    criticalItems: rows.filter((r) => r.branch_status === "critical").length,
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
  // Branch-wide status per "branchId|skuId"; decides what counts as low stock.
  statuses?: BranchStatuses;
  // Resolved gold price (see goldPrice.ts) used for every LAK value.
  lakPerBaht: number;
}

interface LowItem {
  sku: MasterSku;
  branchId: string;
  deskId: string;
  st: BranchStatuses extends Map<string, infer V> ? V : never;
}

interface Position {
  desk_id: string;
  branch_id: string;
  sku: MasterSku;
  qty: number;
  point: number;
}

export function buildDashboard(input: DashboardInput) {
  const { today, skus, branches, desks, latestDays, latestRows, movementRows, agingRows, inTransit, config, filter, lakPerBaht } = input;
  const statuses = input.statuses ?? new Map();
  // Low = the SKU's runway at this BRANCH is Critical or Warning.
  const branchStatus = (p: { branch_id: string; sku: MasterSku }) => statuses.get(`${p.branch_id}|${p.sku.sku_id}`);
  const isLow = (p: { branch_id: string; sku: MasterSku }) => {
    const st = branchStatus(p)?.status;
    return st === "critical" || st === "warning";
  };
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
      point: reorderPoint(statuses.get(`${r.branch_id}|${sku.sku_id}`), config),
    });
  }

  const low = positions.filter(isLow);
  // Watchlist: one line per branch and SKU, built from the branch statuses so a SKU that
  // is only on a truck (nothing on hand anywhere) still shows. Worst runway first.
  const deskBranch = filter.deskId ? desks.find((d) => d.desk_id === filter.deskId)?.branch_id : undefined;
  const lowItems: LowItem[] = [];
  for (const [key, st] of statuses) {
    if (st.status !== "critical" && st.status !== "warning") continue;
    const [branchId, skuId] = key.split("|");
    const sku = skuById.get(skuId);
    if (!sku || !categoryOk(sku)) continue;
    if (filter.branchId && branchId !== filter.branchId) continue;
    const held = positions.filter((p) => p.branch_id === branchId && p.sku.sku_id === skuId).sort((a, b) => b.qty - a.qty);
    if (filter.deskId && (branchId !== deskBranch || !held.some((p) => p.desk_id === filter.deskId))) continue;
    const deskId = filter.deskId ?? held[0]?.desk_id ?? inTransit.find((t) => t.sku_id === skuId && t.to_branch_id === branchId)?.to_desk_id ?? "";
    lowItems.push({ sku, branchId, deskId, st });
  }
  lowItems.sort((a, b) => (a.st.status === "critical" ? 0 : 1) - (b.st.status === "critical" ? 0 : 1) || (a.st.runwayDays ?? 0) - (b.st.runwayDays ?? 0));
  const over = positions
    .filter((p) => p.point > 0 && p.qty > p.point * OVERSTOCK_MULTIPLIER)
    .sort((a, b) => b.qty - b.point * OVERSTOCK_MULTIPLIER - (a.qty - a.point * OVERSTOCK_MULTIPLIER));
  const lowItem = ({ sku, branchId, deskId, st }: LowItem) => {
    return {
      sku_id: sku.sku_id,
      name_en: sku.name_en,
      name_lo: sku.name_lo,
      baht_weight: sku.baht_weight ?? null,
      std_gram_weight: sku.std_gram_weight ?? null,
      category: sku.category,
      desk_id: deskId,
      branch_id: branchId,
      // The branch position against the level that clears the warning.
      closing: st.position,
      reorder_level: reorderPoint(st, config),
      status: st.status,
      runway_days: st.runwayDays,
    };
  };
  const watchItem = (p: Position) => ({
    sku_id: p.sku.sku_id,
    name_en: p.sku.name_en,
    name_lo: p.sku.name_lo,
    baht_weight: p.sku.baht_weight ?? null,
    std_gram_weight: p.sku.std_gram_weight ?? null,
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
    transitLak += valueLak(sku, t.qty, lakPerBaht);
  }

  let pcs = 0;
  let baht = 0;
  let lak = 0;
  for (const p of scoped) {
    pcs += p.qty;
    baht += bahtOf(p.sku, p.qty);
    lak += valueLak(p.sku, p.qty, lakPerBaht);
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
    else if (isLow(p)) statusCounts.low_stock++;
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
        lakValue: round2(mine.reduce((s, p) => s + valueLak(p.sku, p.qty, lakPerBaht), 0)),
        lowCount: new Set(mine.filter(isLow).map((p) => p.sku.sku_id)).size,
        criticalCount: new Set(mine.filter((p) => branchStatus(p)?.status === "critical").map((p) => p.sku.sku_id)).size,
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
      spotLakPerBaht: lakPerBaht,
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
    movement: buildMovement(movementRows.filter((r) => categoryOk(skuById.get(r.sku_id))), skus, lakPerBaht),
    watchlist: {
      lowCount: lowItems.length,
      overCount: over.length,
      topLow: lowItems.slice(0, 5).map(lowItem),
      topOver: over.slice(0, 5).map(watchItem),
    },
    aging: buildAging(skus, agingRows, filter),
  };
}

export function buildMovement(movementRows: LedgerRow[], skus: MasterSku[], lakPerBaht: number) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  let inPcs = 0,
    inLak = 0,
    outPcs = 0,
    outLak = 0;
  for (const r of movementRows) {
    if (r.excluded) continue;
    const sku = skuById.get(r.sku_id);
    inPcs += movementIn(r);
    inLak += valueLak(sku, movementIn(r), lakPerBaht);
    const out = movementOut(r);
    outPcs += out;
    outLak += valueLak(sku, out, lakPerBaht);
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

  const items: { sku_id: string; name_en: string; name_lo: string | null; baht_weight: number | null; std_gram_weight: number | null; category: string; desk_id: string; branch_id: string; estDays: number }[] = [];
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
      baht_weight: sku.baht_weight ?? null,
      std_gram_weight: sku.std_gram_weight ?? null,
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

export function buildReport(periodRows: LedgerRow[], periodDays: DeskDay[], skus: MasterSku[], filter: ReportFilter, config: SystemConfig, lakPerBaht: number) {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const statusByDay = new Map(periodDays.map((d) => [`${d.desk_id}__${d.ledger_date}`, d.status]));
  const statusOf = (r: LedgerRow) => statusByDay.get(`${r.desk_id}__${r.ledger_date}`);

  let rows = periodRows.filter((r) => !r.excluded);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((r) => {
      const sku = skuById.get(r.sku_id);
      return r.sku_id.toLowerCase().includes(q) || sku?.name_en.toLowerCase().includes(q) || (sku?.name_lo ?? "").toLowerCase().includes(q) || (sku ? skuLabel(sku).toLowerCase().includes(q) : false);
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
    bucket.lak += valueLak(sku, qty, lakPerBaht);
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
    return {
      key,
      sku_id: last.sku_id,
      name_en: sku?.name_en ?? last.sku_id,
      name_lo: sku?.name_lo ?? null,
      baht_weight: sku?.baht_weight ?? null,
      std_gram_weight: sku?.std_gram_weight ?? null,
      icon: sku?.icon ?? "ring",
      category: sku?.category ?? "",
      delta: inSum - outSum + adjustSum,
      adjust: adjustSum,
      closing_qty: closing,
      value_lak: round2(valueLak(sku, closing, lakPerBaht)),
      fillPct: 0, // set below, against the biggest closing in the list
      desk_id: last.desk_id,
    };
  });

  // Fill bar: each line's closing against the biggest closing in the report.
  const biggest = Math.max(1, ...items.map((it) => it.closing_qty));
  for (const it of items) it.fillPct = Math.max(0, Math.min(100, round1((it.closing_qty / biggest) * 100)));
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
    categories: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
  };
}

// withPassword (admin): adds has_password, whether the plain password is known.
export function staffAccountSummary(staffAccounts: StaffAccount[], branches: Branch[], nowIso: string, withPassword = false) {
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
      username: a.username,
      role: a.role,
      active: a.active,
      locked: Boolean(a.locked_until && a.locked_until > nowIso),
      ...(withPassword ? { has_password: Boolean(a.password_plain) } : {}),
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
