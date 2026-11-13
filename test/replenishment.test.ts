import { describe, expect, it } from "vitest";
import { resolveParams, runwayStatus, needsReview, computeVelocity } from "../src/replenishment";
import type { DeskDay, LedgerRow, MasterSku, ReplenishmentRule, SystemConfig } from "../src/types";

const config = { default_lead_time_days: 7, warning_margin_days: 3, velocity_window_days: 28 } as SystemConfig;
const sku = { sku_id: "S1", type_id: "NECKLACES", group_name: "Snake" } as MasterSku;

let n = 0;
function rule(scope: ReplenishmentRule["scope"], key: string, branch: string | null, avg: number | null, lead: number | null): ReplenishmentRule {
  return { id: `r${++n}`, scope, scope_key: key, branch_id: branch, avg_daily_sell: avg, lead_time_days: lead, updated_by: null, updated_at: "", is_seed: false };
}

describe("resolveParams", () => {
  it("sku-branch beats sku beats group-branch beats group beats type-branch beats type", () => {
    const rules = [
      rule("type", "NECKLACES", null, 1, null),
      rule("type", "NECKLACES", "B1", 2, null),
      rule("group", "Snake", null, 3, null),
      rule("group", "Snake", "B1", 4, null),
      rule("sku", "S1", null, 5, null),
      rule("sku", "S1", "B1", 6, null),
    ];
    const order: [number, string][] = [];
    for (let i = rules.length; i > 0; i--) {
      const r = resolveParams(sku, "B1", rules.slice(0, i), config, 9);
      order.push([r.avg.value!, r.avg.source]);
    }
    expect(order.map((o) => o[1])).toEqual(["sku-branch", "sku", "group-branch", "group", "type-branch", "type"]);
    expect(order.map((o) => o[0])).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("a rule for another branch does not apply", () => {
    const r = resolveParams(sku, "B1", [rule("sku", "S1", "B2", 6, 1)], config, null);
    expect(r.avg).toEqual({ value: null, source: "none" });
    expect(r.lead).toEqual({ value: 7, source: "default" });
  });

  it("avg and lead resolve independently", () => {
    const rules = [rule("sku", "S1", null, 5, null), rule("group", "Snake", null, 99, 10), rule("type", "NECKLACES", "B1", null, 2)];
    const r = resolveParams(sku, "B1", rules, config, null);
    expect(r.avg).toEqual({ value: 5, source: "sku" });
    expect(r.lead).toEqual({ value: 10, source: "group" });
  });

  it("no avg rule falls back to auto, no lead rule to the default", () => {
    const r = resolveParams(sku, "B1", [], config, 4.5);
    expect(r.avg).toEqual({ value: 4.5, source: "auto" });
    expect(r.lead).toEqual({ value: 7, source: "default" });
  });

  it("no avg rule and no auto velocity is none", () => {
    expect(resolveParams(sku, "B1", [], config, null).avg).toEqual({ value: null, source: "none" });
  });

  it("a SKU without a group skips the group level", () => {
    const r = resolveParams({ ...sku, group_name: null }, "B1", [rule("group", "Snake", null, 3, 3)], config, null);
    expect(r.avg.source).toBe("none");
  });

  it("a manual 0 is a value, not 'unset'", () => {
    expect(resolveParams(sku, "B1", [rule("sku", "S1", null, 0, null)], config, 5).avg).toEqual({ value: 0, source: "sku" });
  });
});

const base = { margin: 3, reorderLevel: 0 };

describe("runwayStatus", () => {
  it("runway at or below lead is critical", () => {
    const r = runwayStatus({ ...base, position: 14, avg: 2, lead: 7, onHand: 14 });
    expect(r).toMatchObject({ runwayDays: 7, status: "critical", fixedLevel: false });
  });

  it("lead < runway <= lead + margin is warning", () => {
    expect(runwayStatus({ ...base, position: 15, avg: 2, lead: 7, onHand: 15 }).status).toBe("warning");
    expect(runwayStatus({ ...base, position: 20, avg: 2, lead: 7, onHand: 20 }).status).toBe("warning");
    expect(runwayStatus({ ...base, position: 21, avg: 2, lead: 7, onHand: 21 }).status).toBe("ok");
  });

  it("position 0 with an avg is critical", () => {
    expect(runwayStatus({ ...base, position: 0, avg: 2, lead: 7, onHand: 0 })).toMatchObject({ status: "critical", runwayDays: 0 });
  });

  it("no avg: no data, or warning (fixed level) when on-hand is below reorder_level", () => {
    expect(runwayStatus({ ...base, position: 3, avg: null, lead: 7, onHand: 3 })).toMatchObject({ status: "no_data", runwayDays: null, fixedLevel: false });
    expect(runwayStatus({ ...base, reorderLevel: 5, position: 3, avg: null, lead: 7, onHand: 3 })).toMatchObject({ status: "warning", fixedLevel: true });
    expect(runwayStatus({ ...base, reorderLevel: 5, position: 3, avg: null, lead: 7, onHand: 5 }).status).toBe("no_data");
  });

  it("the fixed level looks at on-hand, not position", () => {
    expect(runwayStatus({ ...base, reorderLevel: 5, position: 9, avg: null, lead: 7, onHand: 3 }).status).toBe("warning");
  });

  it("an avg of 0 never alerts", () => {
    expect(runwayStatus({ ...base, position: 0, avg: 0, lead: 7, onHand: 0 })).toMatchObject({ status: "ok", runwayDays: null, suggestedQty: 0 });
  });

  it("suggested qty = ceil(avg x (lead + margin)) - position, never below 0", () => {
    expect(runwayStatus({ ...base, position: 4, avg: 1.5, lead: 7, onHand: 4 }).suggestedQty).toBe(11); // ceil(1.5 x 10) - 4
  });
  it("suggested qty rounds up and floors at 0", () => {
    expect(runwayStatus({ ...base, position: 4, avg: 1.55, lead: 7, onHand: 4 }).suggestedQty).toBe(12); // ceil(15.5)=16 - 4
    expect(runwayStatus({ ...base, position: 100, avg: 1, lead: 7, onHand: 100 }).suggestedQty).toBe(0);
  });
});

describe("needsReview", () => {
  it("flags a manual avg when auto differs by more than 50% with >= 14 in-stock days", () => {
    expect(needsReview({ source: "sku", manual: 2, autoAvg: 3.1, inStockDays: 14 })).toBe(true);
    expect(needsReview({ source: "group-branch", manual: 2, autoAvg: 0.9, inStockDays: 20 })).toBe(true);
  });
  it("does not flag within 50%, with too few days, or without a manual rule", () => {
    expect(needsReview({ source: "sku", manual: 2, autoAvg: 3, inStockDays: 14 })).toBe(false);
    expect(needsReview({ source: "sku", manual: 2, autoAvg: 5, inStockDays: 13 })).toBe(false);
    expect(needsReview({ source: "auto", manual: null, autoAvg: 5, inStockDays: 20 })).toBe(false);
    expect(needsReview({ source: "sku", manual: 2, autoAvg: null, inStockDays: 20 })).toBe(false);
    expect(needsReview({ source: "sku", manual: 0, autoAvg: 5, inStockDays: 20 })).toBe(false);
  });
});

describe("computeVelocity (twin of branch_velocity)", () => {
  const TO = "2026-03-31"; // window 28 days: 2026-03-03 .. 2026-03-30
  function day(desk: string, date: string, status: DeskDay["status"] = "done"): DeskDay {
    return { desk_id: desk, ledger_date: date, branch_id: "B1", status } as DeskDay;
  }
  function row(desk: string, date: string, p: Partial<LedgerRow> = {}): LedgerRow {
    return { desk_id: desk, branch_id: "B1", ledger_date: date, sku_id: "S1", opening_qty: 10, stock_in: 0, transfer_in: 0, retail_sale: 0, wholesale: 0, excluded: false, ...p } as LedgerRow;
  }
  function dates(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => `2026-03-${String(from + i).padStart(2, "0")}`);
  }

  it("sold / in-stock days, 3 decimals, null under 7 days", () => {
    const ds = dates(10, 7);
    const days = ds.map((d) => day("D1", d));
    const rows = ds.map((d, i) => row("D1", d, { retail_sale: i === 0 ? 3 : 0, wholesale: i === 1 ? 1 : 0 }));
    const [v] = computeVelocity(rows, days, [], TO, 28);
    expect(v).toEqual({ sku_id: "S1", sold: 4, in_stock_days: 7, velocity: 0.571 });
    const [short] = computeVelocity(rows.slice(0, 6), days.slice(0, 6), [], TO, 28);
    expect(short).toMatchObject({ in_stock_days: 6, velocity: null });
  });

  it("window is to-days .. to-1; only Done days; closed days and excluded rows ignored", () => {
    const ds = dates(3, 28); // 03..30
    const inWindow = ds.map((d) => day("D1", d));
    const rows = ds.map((d) => row("D1", d, { retail_sale: 1 }));
    // outside the window: before and the 'to' day itself
    rows.push(row("D1", "2026-03-02", { retail_sale: 50 }), row("D1", "2026-03-31", { retail_sale: 50 }));
    inWindow.push(day("D1", "2026-03-02"), day("D1", "2026-03-31"));
    // an open day, a closed day, an excluded row
    inWindow[0] = day("D1", ds[0], "check_in");
    rows[1] = { ...rows[1], retail_sale: 7 };
    rows[2] = { ...rows[2], excluded: true };
    const [v] = computeVelocity(rows, inWindow, [ds[1]], TO, 28);
    // 28 days minus open (1), closed (1), excluded (1) = 25
    expect(v.in_stock_days).toBe(25);
    expect(v.sold).toBe(25);
  });

  it("sums the branch's desks per date and counts a date in stock once", () => {
    const ds = dates(10, 7);
    const days = [...ds.map((d) => day("D1", d)), ...ds.map((d) => day("D2", d))];
    const rows = [...ds.map((d) => row("D1", d, { retail_sale: 1 })), ...ds.map((d) => row("D2", d, { retail_sale: 2, opening_qty: 0, stock_in: 5 }))];
    const [v] = computeVelocity(rows, days, [], TO, 28);
    expect(v).toMatchObject({ in_stock_days: 7, sold: 21, velocity: 3 });
  });

  it("a date with nothing stocked is not an in-stock day, moves do not count as sales", () => {
    const ds = dates(10, 8);
    const days = ds.map((d) => day("D1", d));
    const rows = ds.map((d, i) => row("D1", d, i === 7 ? { opening_qty: 0 } : { move: 2 } as Partial<LedgerRow>));
    const [v] = computeVelocity(rows, days, [], TO, 28);
    expect(v).toMatchObject({ in_stock_days: 7, sold: 0, velocity: 0 });
  });
});
