// Executive overview: the numbers behind the CEO dashboard and the deep report
// tables. Pure: it works on plain arrays from the Store plus the branch
// replenishment rows (loadBranchData), so the dashboard and the report read
// the same figures and they cannot disagree.
//
// Every value is at one gold price (today's), so a value difference is always
// a weight difference. "Sold" is retail + wholesale + withdraw (+ a single-mode
// total), the same as the reorder velocity; "returned" (destock) is shown
// beside it but never counted as a sale.
import { bahtOf, gramOf, valueLak, currentQty, soldOf, round2 } from "./logic";
import { addDays } from "./time";
import type { Branch, Desk, DeskDay, DocumentRecord, LedgerRow, MasterSku, SkuType, SystemConfig } from "./types";
import type { ReplenishmentRow, ReorderStatus } from "./replenishment";

// Stock that lasts longer than this at its current selling rate is "too long".
export const SLOW_DAYS = 90;
export const PERIODS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIODS)[number];

// Where a branch's stock of one SKU stands against its minimum (decided
// 2026-11-27: the min-stock status itself; avg/day runway bands are gone).
export type CoverBand = ReorderStatus;
export const COVER_BANDS: CoverBand[] = ["order_now", "late", "ordered", "ok", "no_min"];

// What has been done about a SKU at its minimum: nothing yet, a reorder
// proposal waiting for approval, or an approved (ordered) proposal.
export type ActionState = "none" | "pending" | "approved";

export interface ExecutiveInput {
  today: string;
  periodDays: PeriodDays;
  skus: MasterSku[];
  types: SkuType[];
  branches: Branch[];
  desks: Desk[];
  // Branch-wide replenishment row per "branchId|skuId".
  statuses: Map<string, ReplenishmentRow>;
  // Each case's latest day and its rows = stock right now.
  latestDays: DeskDay[];
  latestRows: LedgerRow[];
  // Ledger rows from the start of the PREVIOUS period through today.
  ledger: LedgerRow[];
  // Pending + approved reorder proposals (with rows) of the recent past.
  proposals: DocumentRecord[];
  config?: Pick<SystemConfig, "usd_to_lak_rate">;
  lakPerBaht: number;
  branchIds: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function coverBand(row: Pick<ReplenishmentRow, "status">): CoverBand {
  return row.status;
}

interface Flow {
  sold: number;
  retail: number;
  wholesale: number;
  withdraw: number;
  returned: number;
  stockIn: number;
}
const emptyFlow = (): Flow => ({ sold: 0, retail: 0, wholesale: 0, withdraw: 0, returned: 0, stockIn: 0 });
function addFlow(f: Flow, r: LedgerRow) {
  f.sold += soldOf(r);
  f.retail += r.retail_sale;
  f.wholesale += r.wholesale;
  f.withdraw += r.withdraw ?? 0;
  f.returned += r.destock;
  f.stockIn += r.stock_in;
}

export function buildExecutive(input: ExecutiveInput) {
  const { today, periodDays, skus, types, branches, desks, statuses, latestDays, latestRows, ledger, lakPerBaht } = input;
  const inScope = new Set(input.branchIds);
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const typeById = new Map(types.map((t) => [t.type_id, t]));
  const branchById = new Map(branches.map((b) => [b.branch_id, b]));
  const deskById = new Map(desks.map((d) => [d.desk_id, d]));
  const from = addDays(today, -(periodDays - 1));
  const prevFrom = addDays(from, -periodDays);
  const value = (sku: MasterSku | undefined, qty: number) => valueLak(sku, qty, lakPerBaht);
  const typeKey = (sku: MasterSku) => sku.type_id ?? sku.category;
  const typeName = (key: string) => {
    const ty = typeById.get(key);
    return { name_en: ty?.name_en ?? key, name_lo: ty?.name_lo ?? null };
  };
  const skuFields = (sku: MasterSku) => ({
    sku_id: sku.sku_id,
    name_en: sku.name_en,
    name_lo: sku.name_lo,
    baht_weight: sku.baht_weight ?? null,
    std_gram_weight: sku.std_gram_weight ?? null,
    icon: sku.icon ?? "ring",
    type_key: typeKey(sku),
  });

  // --- Flows in the period (and the one before, for the comparison) -------
  const flowBySku = new Map<string, Flow>(); // key branch|sku, this period
  const prevSoldBySku = new Map<string, number>(); // key sku, previous period
  const flowByDesk = new Map<string, Flow & { soldLak: number }>();
  const daily = new Map<string, { sold: number; soldLak: number; stockIn: number }>();
  for (let d = from; d <= today; d = addDays(d, 1)) daily.set(d, { sold: 0, soldLak: 0, stockIn: 0 });
  const total = { ...emptyFlow(), soldLak: 0, soldBaht: 0, stockInLak: 0, prevSold: 0, prevSoldLak: 0 };
  for (const r of ledger) {
    if (r.excluded || !inScope.has(r.branch_id)) continue;
    const sku = skuById.get(r.sku_id);
    if (!sku) continue;
    if (r.ledger_date >= prevFrom && r.ledger_date < from) {
      const s = soldOf(r);
      prevSoldBySku.set(r.sku_id, (prevSoldBySku.get(r.sku_id) ?? 0) + s);
      total.prevSold += s;
      total.prevSoldLak += value(sku, s);
      continue;
    }
    if (r.ledger_date < from || r.ledger_date > today) continue;
    const key = `${r.branch_id}|${r.sku_id}`;
    const f = flowBySku.get(key) ?? emptyFlow();
    addFlow(f, r);
    flowBySku.set(key, f);
    const df = flowByDesk.get(r.desk_id) ?? { ...emptyFlow(), soldLak: 0 };
    addFlow(df, r);
    df.soldLak += value(sku, soldOf(r));
    flowByDesk.set(r.desk_id, df);
    addFlow(total, r);
    total.soldLak += value(sku, soldOf(r));
    total.soldBaht += bahtOf(sku, soldOf(r));
    total.stockInLak += value(sku, r.stock_in);
    const day = daily.get(r.ledger_date);
    if (day) {
      day.sold += soldOf(r);
      day.soldLak += value(sku, soldOf(r));
      day.stockIn += r.stock_in;
    }
  }

  // --- Positions: one line per branch and SKU ------------------------------
  const positions = [...statuses].flatMap(([key, st]) => {
    const [branchId, skuId] = key.split("|");
    if (!inScope.has(branchId)) return [];
    const sku = skuById.get(skuId);
    if (!sku) return [];
    const band = coverBand(st);
    const flow = flowBySku.get(key) ?? emptyFlow();
    const below = band === "order_now" || band === "late" || band === "ordered";
    const action: ActionState | null = below ? (st.order ? st.order.state : "none") : null;
    // Over three times the minimum = held well beyond what the case needs.
    const min = st.min.value;
    const excessQty = min != null && min > 0 ? Math.max(0, st.position - min * 3) : 0;
    return [{
      ...skuFields(sku),
      branch_id: branchId,
      on_hand: st.onHand,
      inbound: st.inbound,
      position: st.position,
      baht: round2(bahtOf(sku, st.position)),
      gram: round2(gramOf(sku, st.position)),
      value_lak: round2(value(sku, st.position)),
      min_qty: min,
      min_source: st.min.source,
      lead_days: st.lead.value,
      status: st.status,
      band,
      short_by: st.shortBy,
      eta: st.order?.eta ?? null,
      sold: flow.sold,
      returned: flow.returned,
      excess_qty: excessQty,
      excess_lak: round2(value(sku, excessQty)),
      action,
      action_doc: st.order?.doc_no ?? null,
      action_date: st.order?.doc_date ?? null,
      action_qty: st.order?.qty ?? 0,
    }];
  });

  // --- Headline ------------------------------------------------------------
  let pcs = 0, onHand = 0, inbound = 0, baht = 0, gram = 0, lak = 0;
  let coveredLak = 0, dailyLak = 0;
  for (const p of positions) {
    pcs += p.position;
    onHand += p.on_hand;
    inbound += p.inbound;
    baht += p.baht;
    gram += p.gram;
    lak += p.value_lak;
  }
  // Days the stock lasts at the current selling rate, value-weighted: the
  // value of everything that sells, over the value sold per day.
  const coverDays = dailyLak > 0 ? r1(coveredLak / dailyLak) : null;

  // --- Runway ribbon: value and lines per band -------------------------------
  const ribbon = COVER_BANDS.map((band) => {
    const mine = positions.filter((p) => p.band === band);
    const v = mine.reduce((s, p) => s + p.value_lak, 0);
    return { band, lines: mine.length, value_lak: round2(v), pct: lak > 0 ? r1((v / lak) * 100) : 0 };
  });

  // --- Decisions: at / below the minimum; order now, then late, then ordered --
  const bandOrder: Record<string, number> = { order_now: 0, late: 1, ordered: 2 };
  const decisions = positions
    .filter((p) => p.band === "order_now" || p.band === "late" || p.band === "ordered")
    .sort((a, b) => bandOrder[a.band] - bandOrder[b.band] || b.short_by - a.short_by || a.sku_id.localeCompare(b.sku_id));
  const decisionCounts = { order_now: 0, late: 0, ordered: 0 };
  for (const d of decisions) decisionCounts[d.band as keyof typeof decisionCounts]++;

  // --- Held well over the minimum -------------------------------------------
  const slow = positions
    .filter((p) => p.excess_qty > 0)
    .sort((a, b) => b.excess_lak - a.excess_lak || b.value_lak - a.value_lak);
  const slowLak = slow.reduce((s, p) => s + p.value_lak, 0);
  const slowExcessLak = slow.reduce((s, p) => s + p.excess_lak, 0);

  // --- Stock out ranking, company-wide per SKU --------------------------------
  const outBySku = new Map<string, Flow>();
  for (const [key, f] of flowBySku) {
    const skuId = key.split("|")[1];
    const cur = outBySku.get(skuId) ?? emptyFlow();
    for (const k of Object.keys(f) as (keyof Flow)[]) cur[k] += f[k];
    outBySku.set(skuId, cur);
  }
  const holdingBySku = new Map<string, number>();
  for (const p of positions) holdingBySku.set(p.sku_id, (holdingBySku.get(p.sku_id) ?? 0) + p.position);
  const prevRank = new Map(
    [...prevSoldBySku.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id], i) => [id, i + 1])
  );
  const stockOut = [...outBySku.entries()]
    .filter(([, f]) => f.sold > 0 || f.returned > 0)
    .map(([skuId, f]) => {
      const sku = skuById.get(skuId)!;
      return {
        ...skuFields(sku),
        sold: f.sold,
        retail: f.retail,
        wholesale: f.wholesale,
        withdraw: f.withdraw,
        returned: f.returned,
        stock_in: f.stockIn,
        sold_baht: round2(bahtOf(sku, f.sold)),
        sold_lak: round2(value(sku, f.sold)),
        per_day: r1(f.sold / periodDays),
        prev_sold: prevSoldBySku.get(skuId) ?? 0,
        prev_rank: prevRank.get(skuId) ?? null,
        holding: holdingBySku.get(skuId) ?? 0,
      };
    })
    .sort((a, b) => b.sold - a.sold || b.sold_lak - a.sold_lak);

  // --- Cases -------------------------------------------------------------------
  const statusByDesk = new Map(latestDays.map((d) => [d.desk_id, d.status]));
  const heldByDesk = new Map<string, { pcs: number; lak: number }>();
  for (const r of latestRows) {
    if (r.excluded || !inScope.has(r.branch_id)) continue;
    const desk = deskById.get(r.desk_id);
    if (!desk || !desk.active) continue;
    const qty = currentQty(r, statusByDesk.get(r.desk_id));
    const cur = heldByDesk.get(r.desk_id) ?? { pcs: 0, lak: 0 };
    cur.pcs += qty;
    cur.lak += value(skuById.get(r.sku_id), qty);
    heldByDesk.set(r.desk_id, cur);
  }
  const lastDayByDesk = new Map(latestDays.map((d) => [d.desk_id, d]));
  const cases = desks
    .filter((d) => d.active && inScope.has(d.branch_id))
    .map((d) => {
      const f = flowByDesk.get(d.desk_id) ?? { ...emptyFlow(), soldLak: 0 };
      const held = heldByDesk.get(d.desk_id) ?? { pcs: 0, lak: 0 };
      const last = lastDayByDesk.get(d.desk_id);
      return {
        desk_id: d.desk_id,
        branch_id: d.branch_id,
        display_name: d.display_name,
        sold: f.sold,
        retail: f.retail,
        wholesale: f.wholesale,
        withdraw: f.withdraw,
        returned: f.returned,
        stock_in: f.stockIn,
        sold_lak: round2(f.soldLak),
        held_pcs: held.pcs,
        held_lak: round2(held.lak),
        // Share of what the case holds that went out in the period.
        turn_pct: held.lak + f.soldLak > 0 ? r1((f.soldLak / (held.lak + f.soldLak)) * 100) : 0,
        last_date: last?.ledger_date ?? null,
        last_status: last?.status ?? "not_started",
      };
    })
    .sort((a, b) => b.sold_lak - a.sold_lak || b.sold - a.sold);

  // --- By branch and by type ---------------------------------------------------
  const group = <K extends string>(keyOf: (p: (typeof positions)[number]) => K) => {
    const out = new Map<K, { pcs: number; lak: number; baht: number; covered: number; daily: number; critical: number; warning: number; noAction: number; slowLak: number }>();
    for (const p of positions) {
      const k = keyOf(p);
      const g = out.get(k) ?? { pcs: 0, lak: 0, baht: 0, covered: 0, daily: 0, critical: 0, warning: 0, noAction: 0, slowLak: 0 };
      g.pcs += p.position;
      g.lak += p.value_lak;
      g.baht += p.baht;
      if (p.band === "order_now" || p.band === "late") g.critical++;
      if (p.band === "ordered") g.warning++;
      if (p.action === "none") g.noAction++;
      if (p.excess_qty > 0) g.slowLak += p.value_lak;
      out.set(k, g);
    }
    return out;
  };
  const summarise = (g: ReturnType<typeof group> extends Map<string, infer V> ? V : never) => ({
    pcs: g.pcs,
    value_lak: round2(g.lak),
    baht: round2(g.baht),
    share_pct: lak > 0 ? r1((g.lak / lak) * 100) : 0,
    cover_days: g.daily > 0 ? r1(g.covered / g.daily) : null,
    critical: g.critical,
    warning: g.warning,
    no_action: g.noAction,
    slow_lak: round2(g.slowLak),
  });
  const soldLakByBranch = new Map<string, number>();
  const soldLakByType = new Map<string, number>();
  for (const [key, f] of flowBySku) {
    const [b, s] = key.split("|");
    const sku = skuById.get(s)!;
    const v = value(sku, f.sold);
    soldLakByBranch.set(b, (soldLakByBranch.get(b) ?? 0) + v);
    soldLakByType.set(typeKey(sku), (soldLakByType.get(typeKey(sku)) ?? 0) + v);
  }
  const byBranchMap = group((p) => p.branch_id);
  const byBranch = input.branchIds.map((id) => ({
    branch_id: id,
    name_en: branchById.get(id)?.name_en ?? id,
    name_lo: branchById.get(id)?.name_lo ?? null,
    ...summarise(byBranchMap.get(id) ?? { pcs: 0, lak: 0, baht: 0, covered: 0, daily: 0, critical: 0, warning: 0, noAction: 0, slowLak: 0 }),
    sold_lak: round2(soldLakByBranch.get(id) ?? 0),
  }));
  const byTypeMap = group((p) => p.type_key);
  const typeOrder = new Map(types.map((t, i) => [t.type_id, t.sort_order ?? i]));
  const byType = [...byTypeMap.entries()]
    .map(([key, g]) => ({ type_key: key, ...typeName(key), ...summarise(g), sold_lak: round2(soldLakByType.get(key) ?? 0) }))
    .sort((a, b) => b.value_lak - a.value_lak || (typeOrder.get(a.type_key) ?? 999) - (typeOrder.get(b.type_key) ?? 999));

  // --- Freshness: how many cases are settled today ------------------------------
  const activeDesks = desks.filter((d) => d.active && inScope.has(d.branch_id));
  const doneToday = activeDesks.filter((d) => {
    const last = lastDayByDesk.get(d.desk_id);
    return last?.ledger_date === today && last.status === "done";
  }).length;

  return {
    asOf: today,
    period: { days: periodDays, from, to: today, prevFrom, prevTo: addDays(from, -1) },
    price: { lakPerBaht },
    headline: {
      value_lak: round2(lak),
      baht: round2(baht),
      gram: round2(gram),
      pcs,
      on_hand: onHand,
      inbound,
      lines: positions.length,
      skus: new Set(positions.filter((p) => p.position > 0).map((p) => p.sku_id)).size,
      branches: input.branchIds.length,
      cases: activeDesks.length,
      cases_done_today: doneToday,
      cover_days: coverDays,
      // Share of stock value whose SKUs have a selling rate behind cover_days.
      cover_basis_pct: lak > 0 ? r1((coveredLak / lak) * 100) : 0,
      daily_out_lak: round2(dailyLak),
    },
    flow: {
      sold: total.sold,
      sold_lak: round2(total.soldLak),
      sold_baht: round2(total.soldBaht),
      retail: total.retail,
      wholesale: total.wholesale,
      withdraw: total.withdraw,
      returned: total.returned,
      stock_in: total.stockIn,
      stock_in_lak: round2(total.stockInLak),
      prev_sold: total.prevSold,
      prev_sold_lak: round2(total.prevSoldLak),
      change_pct: total.prevSoldLak > 0 ? r1(((total.soldLak - total.prevSoldLak) / total.prevSoldLak) * 100) : null,
    },
    daily: [...daily.entries()].map(([date, d]) => ({ date, sold: d.sold, sold_lak: round2(d.soldLak), stock_in: d.stockIn })),
    ribbon,
    decisions: { counts: decisionCounts, items: decisions },
    slow: { count: slow.length, value_lak: round2(slowLak), excess_lak: round2(slowExcessLak), items: slow },
    stockOut,
    cases,
    byBranch,
    byType,
    positions: positions.sort((a, b) => b.value_lak - a.value_lak),
    slowDays: SLOW_DAYS,
  };
}

export type Executive = ReturnType<typeof buildExecutive>;
