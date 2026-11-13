// Replenishment: which average daily sell and lead time apply to a SKU at a
// branch, how many days of stock the branch has, and the alert that follows.
// Pure functions first (shared by the API, the desk cards and the dashboard),
// then the loader that gathers a branch's data from the Store.
import type { Desk, DeskDay, LedgerRow, MasterSku, ReplenishmentRule, SystemConfig, Transfer } from "./types";
import type { Store } from "./store";
import { currentQty } from "./logic";

export type ParamSource = "sku-branch" | "sku" | "group-branch" | "group" | "type-branch" | "type" | "auto" | "default" | "none";
export type RunwayStatus = "critical" | "warning" | "ok" | "no_data";

// Fewer in-stock days than this gives no automatic velocity (mirrors branch_velocity).
export const MIN_VELOCITY_DAYS = 7;
// "Review" needs at least this many in-stock days behind the automatic figure.
export const REVIEW_MIN_DAYS = 14;
export const REVIEW_TOLERANCE = 0.5;

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Rule precedence (spec 2.3): SKU+branch, SKU, group+branch, group, type+branch,
// type. Average and lead time each take the first rule that has a value for
// them; no average rule falls back to the automatic velocity, no lead time to
// the configured default.
// ---------------------------------------------------------------------------
export function resolveParams(
  sku: Pick<MasterSku, "sku_id" | "type_id" | "group_name">,
  branchId: string,
  rules: ReplenishmentRule[],
  config: Pick<SystemConfig, "default_lead_time_days">,
  autoAvg: number | null
): { avg: { value: number | null; source: ParamSource }; lead: { value: number; source: ParamSource } } {
  const steps: { scope: ReplenishmentRule["scope"]; key: string | null; branch: boolean; source: ParamSource }[] = [
    { scope: "sku", key: sku.sku_id, branch: true, source: "sku-branch" },
    { scope: "sku", key: sku.sku_id, branch: false, source: "sku" },
    { scope: "group", key: sku.group_name, branch: true, source: "group-branch" },
    { scope: "group", key: sku.group_name, branch: false, source: "group" },
    { scope: "type", key: sku.type_id, branch: true, source: "type-branch" },
    { scope: "type", key: sku.type_id, branch: false, source: "type" },
  ];
  let avg: { value: number | null; source: ParamSource } | null = null;
  let lead: { value: number; source: ParamSource } | null = null;
  for (const step of steps) {
    if (step.key == null || step.key === "") continue;
    const rule = rules.find((r) => r.scope === step.scope && r.scope_key === step.key && (step.branch ? r.branch_id === branchId : r.branch_id === null));
    if (!rule) continue;
    if (!avg && rule.avg_daily_sell != null) avg = { value: rule.avg_daily_sell, source: step.source };
    if (!lead && rule.lead_time_days != null) lead = { value: rule.lead_time_days, source: step.source };
    if (avg && lead) break;
  }
  return {
    avg: avg ?? (autoAvg != null ? { value: autoAvg, source: "auto" } : { value: null, source: "none" }),
    lead: lead ?? { value: config.default_lead_time_days, source: "default" },
  };
}

// ---------------------------------------------------------------------------
// Runway and alert (spec 2.9 - 2.13)
// ---------------------------------------------------------------------------
export function runwayStatus(input: {
  position: number;
  avg: number | null;
  lead: number;
  margin: number;
  reorderLevel: number;
  onHand: number;
}): { runwayDays: number | null; status: RunwayStatus; fixedLevel: boolean; suggestedQty: number } {
  const { position, avg, lead, margin, reorderLevel, onHand } = input;
  if (avg == null) {
    // New SKU with nothing to plan from: only the old fixed level can warn.
    const fixed = reorderLevel > 0 && onHand < reorderLevel;
    return { runwayDays: null, status: fixed ? "warning" : "no_data", fixedLevel: fixed, suggestedQty: 0 };
  }
  // A manual 0 means "does not sell": nothing to run out of.
  if (avg <= 0) return { runwayDays: null, status: "ok", fixedLevel: false, suggestedQty: 0 };
  const runway = position / avg;
  const status: RunwayStatus = position <= 0 || runway <= lead ? "critical" : runway <= lead + margin ? "warning" : "ok";
  return {
    runwayDays: round1(Math.max(runway, 0)),
    status,
    fixedLevel: false,
    suggestedQty: Math.max(0, Math.ceil(avg * (lead + margin)) - position),
  };
}

// A manual figure that the automatic one disagrees with by more than 50%.
export function needsReview(input: { source: ParamSource; manual: number | null; autoAvg: number | null; inStockDays: number }): boolean {
  const { source, manual, autoAvg, inStockDays } = input;
  if (source === "auto" || source === "none" || source === "default") return false;
  if (manual == null || manual <= 0 || autoAvg == null || inStockDays < REVIEW_MIN_DAYS) return false;
  return Math.abs(autoAvg - manual) / manual > REVIEW_TOLERANCE;
}

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
    cur.stocked += r.opening_qty + r.stock_in + r.transfer_in;
    cur.sold += r.retail_sale + r.wholesale;
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
  group: string | null;
  type: string;
  onHand: number;
  inbound: number;
  position: number;
  avg: { value: number | null; source: ParamSource };
  autoAvg: { value: number | null; inStockDays: number };
  lead: { value: number; source: ParamSource };
  runwayDays: number | null;
  status: RunwayStatus;
  fixedLevel: boolean;
  suggestedQty: number;
  review: boolean;
}

const STATUS_ORDER: Record<RunwayStatus, number> = { critical: 0, warning: 1, ok: 2, no_data: 3 };

export function buildBranchRows(input: {
  branchId: string;
  skus: MasterSku[];
  rules: ReplenishmentRule[];
  config: SystemConfig;
  desks: Desk[];
  latestDays: DeskDay[];
  latestRows: LedgerRow[];
  inTransit: Transfer[];
  velocity: VelocityRow[];
}): ReplenishmentRow[] {
  const { branchId, skus, rules, config } = input;
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const activeDesks = new Set(input.desks.filter((d) => d.branch_id === branchId && d.active).map((d) => d.desk_id));
  const statusByDesk = new Map(input.latestDays.map((d) => [d.desk_id, d.status]));
  const velocityBySku = new Map(input.velocity.map((v) => [v.sku_id, v]));

  const onHand = new Map<string, number>();
  for (const r of input.latestRows) {
    if (r.excluded || r.branch_id !== branchId || !activeDesks.has(r.desk_id)) continue;
    onHand.set(r.sku_id, (onHand.get(r.sku_id) ?? 0) + currentQty(r, statusByDesk.get(r.desk_id)));
  }
  const inbound = new Map<string, number>();
  for (const t of input.inTransit) {
    if (t.status !== "in_transit" || t.to_branch_id !== branchId || t.from_branch_id === branchId) continue;
    inbound.set(t.sku_id, (inbound.get(t.sku_id) ?? 0) + t.qty);
  }

  const rows: ReplenishmentRow[] = [];
  for (const skuId of new Set([...onHand.keys(), ...inbound.keys()])) {
    const sku = skuById.get(skuId);
    if (!sku || !sku.active) continue;
    const hand = onHand.get(skuId) ?? 0;
    const inc = inbound.get(skuId) ?? 0;
    const position = hand + inc;
    const v = velocityBySku.get(skuId);
    const auto = v?.velocity ?? null;
    const params = resolveParams(sku, branchId, rules, config, auto);
    const run = runwayStatus({
      position,
      avg: params.avg.value,
      lead: params.lead.value,
      margin: config.warning_margin_days,
      reorderLevel: sku.reorder_level,
      onHand: hand,
    });
    rows.push({
      sku_id: skuId,
      name: sku.name_en,
      name_lo: sku.name_lo,
      group: sku.group_name,
      type: sku.category,
      onHand: hand,
      inbound: inc,
      position,
      avg: params.avg,
      autoAvg: { value: auto, inStockDays: v?.in_stock_days ?? 0 },
      lead: params.lead,
      ...run,
      review: needsReview({ source: params.avg.source, manual: params.avg.value, autoAvg: auto, inStockDays: v?.in_stock_days ?? 0 }),
    });
  }
  return rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.runwayDays ?? Infinity) - (b.runwayDays ?? Infinity) ||
      a.sku_id.localeCompare(b.sku_id)
  );
}

export async function loadBranchRows(store: Store, branchId: string, today: string, shared?: { skus: MasterSku[]; rules: ReplenishmentRule[]; config: SystemConfig; desks: Desk[] }): Promise<ReplenishmentRow[]> {
  const [skus, rules, config, desks] = shared
    ? [shared.skus, shared.rules, shared.config, shared.desks]
    : await Promise.all([store.skus(), store.rules(), store.config(), store.desks()]);
  const [latestDays, latestRows, inTransit, velocity] = await Promise.all([
    store.latestDeskDays({ branchId }),
    store.ledgerLatest({ branchId }),
    store.transfers({ branchId, status: "in_transit" }),
    store.branchVelocity(branchId, today, config.velocity_window_days),
  ]);
  return buildBranchRows({ branchId, skus, rules, config, desks, latestDays, latestRows, inTransit, velocity });
}

// Status of every (branch, SKU) pair, for the desk cards and the dashboard.
export async function loadBranchStatuses(store: Store, branchIds: string[], today: string): Promise<Map<string, ReplenishmentRow>> {
  const [skus, rules, config, desks] = await Promise.all([store.skus(), store.rules(), store.config(), store.desks()]);
  const out = new Map<string, ReplenishmentRow>();
  const perBranch = await Promise.all(branchIds.map((b) => loadBranchRows(store, b, today, { skus, rules, config, desks })));
  branchIds.forEach((b, i) => {
    for (const row of perBranch[i]) out.set(statusKey(b, row.sku_id), row);
  });
  return out;
}

export const statusKey = (branchId: string, skuId: string) => `${branchId}|${skuId}`;
