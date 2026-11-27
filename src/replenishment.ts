// Replenishment (decided 2026-11-27): each SKU has a minimum stock per branch.
// When what the branch holds drops to that minimum or below, the SKU must be
// ordered now. Lead time stays: once a reorder proposal names the SKU it is
// "Ordered" until proposal date + lead time, then "Late". Avg/day is no longer
// used. Pure functions first, then the loader that gathers a branch's data.
import { skuLabel } from "./skuName";
import { addDays } from "./time";
import type { Desk, DeskDay, DocumentRecord, LedgerRow, MasterSku, ReplenishmentRule, SystemConfig, Transfer } from "./types";
import type { Store } from "./store";
import { currentQty, soldOf } from "./logic";

export type ParamSource = "sku" | "type" | "default" | "none";
// order_now / late need someone to act; ordered is on its way; no_min = no minimum set.
export type ReorderStatus = "order_now" | "late" | "ordered" | "ok" | "no_min";

// Fewer in-stock days than this gives no automatic velocity (mirrors branch_velocity).
export const MIN_VELOCITY_DAYS = 7;
// A proposal older than lead time + this many days no longer counts as the order.
export const LATE_GRACE_DAYS = 30;

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Rule precedence (per branch since migration 15): the branch's SKU rule, then
// the branch's Type rule. Min and lead time each take the first rule that has
// a value; no min = no alert, no lead time = the configured default.
// ---------------------------------------------------------------------------
export function resolveParams(
  sku: Pick<MasterSku, "sku_id" | "type_id">,
  rules: ReplenishmentRule[],
  config: Pick<SystemConfig, "default_lead_time_days">,
  branchId: string
): { min: { value: number | null; source: ParamSource }; lead: { value: number; source: ParamSource } } {
  const steps: { scope: ReplenishmentRule["scope"]; key: string | null; source: ParamSource }[] = [
    { scope: "sku", key: sku.sku_id, source: "sku" },
    { scope: "type", key: sku.type_id, source: "type" },
  ];
  let min: { value: number | null; source: ParamSource } | null = null;
  let lead: { value: number; source: ParamSource } | null = null;
  for (const step of steps) {
    if (step.key == null || step.key === "") continue;
    const rule = rules.find((r) => r.scope === step.scope && r.scope_key === step.key && r.branch_id === branchId);
    if (!rule) continue;
    if (!min && rule.min_qty != null) min = { value: rule.min_qty, source: step.source };
    if (!lead && rule.lead_time_days != null) lead = { value: rule.lead_time_days, source: step.source };
    if (min && lead) break;
  }
  return {
    min: min ?? { value: null, source: "none" },
    lead: lead ?? { value: config.default_lead_time_days, source: "default" },
  };
}

// The live reorder proposal of a branch that names this SKU: approved beats
// pending, then the newest; only from lead time + LATE_GRACE_DAYS back.
export interface OrderInfo {
  doc_no: string;
  doc_date: string;
  state: "pending" | "approved";
  qty: number;
  eta: string;
}
export function orderFor(proposals: DocumentRecord[], branchId: string, skuId: string, today: string, leadDays: number): OrderInfo | null {
  const since = addDays(today, -(Math.ceil(leadDays) + LATE_GRACE_DAYS));
  let best: DocumentRecord | null = null;
  let qty = 0;
  for (const d of proposals) {
    if (d.kind !== "proposal" || d.branch_id !== branchId) continue;
    if (d.status !== "pending" && d.status !== "approved") continue;
    if (d.doc_date < since || d.doc_date > today) continue;
    const lineQty = (d.rows ?? []).filter((r) => r.sku_id === skuId).reduce((s, r) => s + Number(r.qty ?? 0), 0);
    if (lineQty <= 0) continue;
    const better = !best || (d.status === "approved" && best.status !== "approved") || (d.status === best.status && d.doc_date > best.doc_date);
    if (better) {
      best = d;
      qty = lineQty;
    }
  }
  if (!best) return null;
  return { doc_no: best.doc_no, doc_date: best.doc_date, state: best.status as OrderInfo["state"], qty, eta: addDays(best.doc_date, Math.ceil(leadDays)) };
}

// At or below the minimum = order now (or ordered / late once a proposal names it).
export function reorderStatus(input: { position: number; min: number | null; order: OrderInfo | null; today: string }): { status: ReorderStatus; shortBy: number } {
  const { position, min, order, today } = input;
  if (min == null) return { status: "no_min", shortBy: 0 };
  if (position > min) return { status: "ok", shortBy: 0 };
  const shortBy = Math.max(1, min - position);
  if (!order) return { status: "order_now", shortBy };
  return { status: today > order.eta ? "late" : "ordered", shortBy };
}

// Needs someone to act today.
export const needsOrder = (status: string | undefined) => status === "order_now" || status === "late";
// At or below the minimum, whatever has been done about it.
export const isBelowMin = (status: string | undefined) => status === "order_now" || status === "late" || status === "ordered";

// ---------------------------------------------------------------------------
// Automatic velocity: the TypeScript twin of the branch_velocity RPC, used by
// the DemoStore. Window to-days .. to-1; only Done days of the branch; closed
// days and excluded rows ignored; the branch's desks summed per date and SKU;
// a date is in stock when opening + stock_in + transfer_in > 0; moves and
// destock are not sales.
// ---------------------------------------------------------------------------
export interface VelocityRow {
  sku_id: string;
  sold: number;
  in_stock_days: number;
  velocity: number | null;
}

export function computeVelocity(
  rows: LedgerRow[],
  days: DeskDay[],
  closedDates: Iterable<string>,
  to: string,
  windowDays: number
): VelocityRow[] {
  const closed = new Set(closedDates);
  const from = shift(to, -windowDays);
  const last = shift(to, -1);
  const done = new Set(days.filter((d) => d.status === "done").map((d) => `${d.desk_id}__${d.ledger_date}`));
  const perDay = new Map<string, { sku_id: string; stocked: number; sold: number }>();
  for (const r of rows) {
    if (r.excluded || r.ledger_date < from || r.ledger_date > last || closed.has(r.ledger_date)) continue;
    if (!done.has(`${r.desk_id}__${r.ledger_date}`)) continue;
    const key = `${r.ledger_date}__${r.sku_id}`;
    const cur = perDay.get(key) ?? { sku_id: r.sku_id, stocked: 0, sold: 0 };
    cur.stocked += r.opening_qty + r.stock_in + r.transfer_in + Math.max(r.move_qty ?? 0, 0);
    cur.sold += soldOf(r);
    perDay.set(key, cur);
  }
  const bySku = new Map<string, { sold: number; days: number }>();
  for (const d of perDay.values()) {
    const cur = bySku.get(d.sku_id) ?? { sold: 0, days: 0 };
    cur.sold += d.sold;
    if (d.stocked > 0) cur.days++;
    bySku.set(d.sku_id, cur);
  }
  return [...bySku.entries()].map(([sku_id, v]) => ({
    sku_id,
    sold: v.sold,
    in_stock_days: v.days,
    velocity: v.days >= MIN_VELOCITY_DAYS ? round3(v.sold / v.days) : null,
  }));
}

function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// One branch, every SKU it holds or has on a truck
// ---------------------------------------------------------------------------
export interface ReplenishmentRow {
  sku_id: string;
  name: string;
  name_lo: string | null;
  type: string;
  onHand: number;
  inbound: number;
  position: number;
  min: { value: number | null; source: ParamSource };
  lead: { value: number; source: ParamSource };
  status: ReorderStatus;
  shortBy: number;
  order: OrderInfo | null;
}

const STATUS_ORDER: Record<ReorderStatus, number> = { order_now: 0, late: 1, ordered: 2, ok: 3, no_min: 4 };

// What a branch still holds of each SKU: on hand in its active cases (latest
// day of each) and inbound on transfers from another branch.
export function heldBySku(
  latestRows: LedgerRow[],
  latestDays: DeskDay[],
  desks: Desk[],
  inTransit: Transfer[],
  branchId: string
): Map<string, { onHand: number; inbound: number }> {
  const activeDesks = new Set(desks.filter((d) => d.branch_id === branchId && d.active).map((d) => d.desk_id));
  const statusByDesk = new Map(latestDays.map((d) => [d.desk_id, d.status]));
  const out = new Map<string, { onHand: number; inbound: number }>();
  const entry = (skuId: string) => {
    let e = out.get(skuId);
    if (!e) out.set(skuId, (e = { onHand: 0, inbound: 0 }));
    return e;
  };
  for (const r of latestRows) {
    if (r.excluded || r.branch_id !== branchId || !activeDesks.has(r.desk_id)) continue;
    entry(r.sku_id).onHand += currentQty(r, statusByDesk.get(r.desk_id));
  }
  for (const t of inTransit) {
    if (t.status !== "in_transit" || t.to_branch_id !== branchId || t.from_branch_id === branchId) continue;
    entry(t.sku_id).inbound += t.qty;
  }
  return out;
}

export function buildBranchRows(input: {
  branchId: string;
  today: string;
  skus: MasterSku[];
  rules: ReplenishmentRule[];
  config: Pick<SystemConfig, "default_lead_time_days">;
  desks: Desk[];
  latestDays: DeskDay[];
  latestRows: LedgerRow[];
  inTransit: Transfer[];
  // Live (pending / approved) reorder proposals of the branch.
  proposals: DocumentRecord[];
  // SKU ids the branch carries (branch_sku). A carried SKU with a minimum is
  // listed even at 0 pcs; one it does not carry only while it still has stock.
  carried: Set<string>;
}): ReplenishmentRow[] {
  const { branchId, today, skus, rules, config } = input;
  const held = heldBySku(input.latestRows, input.latestDays, input.desks, input.inTransit, branchId);
  for (const id of input.carried) if (!held.has(id)) held.set(id, { onHand: 0, inbound: 0 });
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));

  const rows: ReplenishmentRow[] = [];
  for (const [skuId, h] of held) {
    const sku = skuById.get(skuId);
    if (!sku || !sku.active) continue;
    const position = h.onHand + h.inbound;
    if (!input.carried.has(skuId) && position <= 0) continue;
    const params = resolveParams(sku, rules, config, branchId);
    // A carried SKU at 0 with no minimum says nothing: leave it out.
    if (position <= 0 && params.min.value == null) continue;
    const below = params.min.value != null && position <= params.min.value;
    const order = below ? orderFor(input.proposals, branchId, skuId, today, params.lead.value) : null;
    rows.push({
      sku_id: skuId,
      name: skuLabel(sku),
      name_lo: sku.name_lo,
      type: sku.category,
      onHand: h.onHand,
      inbound: h.inbound,
      position,
      min: params.min,
      lead: params.lead,
      ...reorderStatus({ position, min: params.min.value, order, today }),
      order,
    });
  }
  return rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.shortBy - a.shortBy || a.sku_id.localeCompare(b.sku_id));
}

// Pending + approved proposals of a branch (or every branch) since a date, with rows.
export async function liveProposals(store: Store, branchId: string | undefined, dateFrom: string) {
  const out: DocumentRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const { rows, total } = await store.documents({ branchId, kind: "proposal", statusIn: ["pending", "approved"], dateFrom, page, pageSize: 100 });
    out.push(...rows);
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

// Long enough to cover any lead time a branch sets plus the late grace.
export const PROPOSAL_LOOKBACK_DAYS = 120;

// The lists every branch's rows need; a caller that already holds them passes them in.
export type BranchShared = { skus: MasterSku[]; rules: ReplenishmentRule[]; config: SystemConfig; desks: Desk[] };

export async function loadBranchRows(store: Store, branchId: string, today: string, shared?: BranchShared): Promise<ReplenishmentRow[]> {
  return (await loadBranch(store, branchId, today, shared)).rows;
}

// The rows plus the ledger rows of each case's latest day they were built from.
async function loadBranch(store: Store, branchId: string, today: string, shared?: BranchShared) {
  const [skus, rules, config, desks] = shared
    ? [shared.skus, shared.rules, shared.config, shared.desks]
    : await Promise.all([store.skus(), store.rules(), store.config(), store.desks()]);
  const hasMin = rules.some((r) => r.branch_id === branchId && r.min_qty != null);
  const [latestDays, latestRows, inTransit, proposals, branchSkus] = await Promise.all([
    store.latestDeskDays({ branchId }),
    store.ledgerLatest({ branchId }),
    store.transfers({ branchId, status: "in_transit" }),
    // No minimum anywhere in the branch = nothing can be ordered: skip the read.
    hasMin ? liveProposals(store, branchId, addDays(today, -PROPOSAL_LOOKBACK_DAYS)) : Promise.resolve([] as DocumentRecord[]),
    store.branchSkus({ branchId }),
  ]);
  const carried = new Set(branchSkus.filter((b) => b.carried).map((b) => b.sku_id));
  return { rows: buildBranchRows({ branchId, today, skus, rules, config, desks, latestDays, latestRows, inTransit, proposals, carried }), latestRows };
}

// heldBySku for one branch, loaded from the Store (the carries switch refuses
// "off" while a SKU is still held).
export async function loadHeld(store: Store, branchId: string) {
  const [desks, latestDays, latestRows, inTransit] = await Promise.all([
    store.desks(),
    store.latestDeskDays({ branchId }),
    store.ledgerLatest({ branchId }),
    store.transfers({ branchId, status: "in_transit" }),
  ]);
  return heldBySku(latestRows, latestDays, desks, inTransit, branchId);
}

// Status of every (branch, SKU) pair, for the desk cards and the dashboard.
export async function loadBranchStatuses(store: Store, branchIds: string[], today: string, shared?: BranchShared): Promise<Map<string, ReplenishmentRow>> {
  return (await loadBranchData(store, branchIds, today, shared)).statuses;
}

// The statuses plus every branch's latest-day ledger rows (ledgerLatest per
// branch), so a caller that also needs those does not read them again.
export async function loadBranchData(store: Store, branchIds: string[], today: string, shared?: BranchShared) {
  const lists = shared ?? (await Promise.all([store.skus(), store.rules(), store.config(), store.desks()]).then(([skus, rules, config, desks]) => ({ skus, rules, config, desks })));
  const statuses = new Map<string, ReplenishmentRow>();
  const latestRows: LedgerRow[] = [];
  const perBranch = await Promise.all(branchIds.map((b) => loadBranch(store, b, today, lists)));
  branchIds.forEach((b, i) => {
    for (const row of perBranch[i].rows) statuses.set(statusKey(b, row.sku_id), row);
    latestRows.push(...perBranch[i].latestRows);
  });
  return { statuses, latestRows };
}

export const statusKey = (branchId: string, skuId: string) => `${branchId}|${skuId}`;
