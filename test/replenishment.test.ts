import { describe, expect, it } from "vitest";
import { resolveParams, reorderStatus, orderFor, computeVelocity, buildBranchRows, heldBySku } from "../src/replenishment";
import type { DeskDay, DocumentRecord, LedgerRow, MasterSku, ReplenishmentRule, SystemConfig } from "../src/types";

const config = { default_lead_time_days: 7, warning_margin_days: 3, velocity_window_days: 28 } as SystemConfig;
const sku = { sku_id: "S1", type_id: "NECKLACES", group_name: "Snake" } as MasterSku;

let n = 0;
function rule(scope: ReplenishmentRule["scope"], key: string, branch: string | null, min: number | null, lead: number | null): ReplenishmentRule {
  return { id: `r${++n}`, scope, scope_key: key, branch_id: branch, min_qty: min, lead_time_days: lead, updated_by: null, updated_at: "", is_seed: false };
}

describe("resolveParams", () => {
  it("the branch SKU rule beats the branch Type rule; other branches and company rules are ignored", () => {
    const rules = [rule("type", "NECKLACES", "B1", 1, null), rule("sku", "S1", "B1", 5, null)];
    expect(resolveParams(sku, rules, config, "B1").min).toEqual({ value: 5, source: "sku" });
    expect(resolveParams(sku, rules.slice(0, 1), config, "B1").min).toEqual({ value: 1, source: "type" });
    const ignored = [rule("group", "Snake", "B1", 3, 3), rule("sku", "S1", "B2", 6, 6), rule("type", "NECKLACES", null, 2, 2), rule("sku", "S1", null, 4, 4)];
    const r = resolveParams(sku, ignored, config, "B1");
    expect(r.min).toEqual({ value: null, source: "none" });
    expect(r.lead).toEqual({ value: 7, source: "default" });
  });

  it("min and lead resolve independently", () => {
    const rules = [rule("sku", "S1", "B1", 5, null), rule("type", "NECKLACES", "B1", 99, 10)];
    const r = resolveParams(sku, rules, config, "B1");
    expect(r.min).toEqual({ value: 5, source: "sku" });
    expect(r.lead).toEqual({ value: 10, source: "type" });
  });

  it("a min of 0 is a value, not 'unset'", () => {
    expect(resolveParams(sku, [rule("sku", "S1", "B1", 0, null)], config, "B1").min).toEqual({ value: 0, source: "sku" });
  });
});

const proposal = (p: Partial<DocumentRecord> & { qty?: number; sku?: string }): DocumentRecord =>
  ({
    id: p.doc_no ?? "d",
    doc_no: p.doc_no ?? "DOC-1",
    kind: "proposal",
    branch_id: p.branch_id ?? "B1",
    status: p.status ?? "pending",
    doc_date: p.doc_date ?? "2026-11-25",
    rows: [{ sku_id: p.sku ?? "S1", qty: p.qty ?? 5 }],
  }) as unknown as DocumentRecord;

describe("reorderStatus (min stock, decided 2026-11-27)", () => {
  const today = "2026-11-27";
  it("no min = no alert", () => {
    expect(reorderStatus({ position: 0, min: null, order: null, today })).toEqual({ status: "no_min", shortBy: 0 });
  });
  it("above the min is ok; at or below it is order now, short by min - balance (at least 1)", () => {
    expect(reorderStatus({ position: 6, min: 5, order: null, today })).toEqual({ status: "ok", shortBy: 0 });
    expect(reorderStatus({ position: 5, min: 5, order: null, today })).toEqual({ status: "order_now", shortBy: 1 });
    expect(reorderStatus({ position: 2, min: 5, order: null, today })).toEqual({ status: "order_now", shortBy: 3 });
  });
  it("a live proposal makes it ordered until proposal date + lead, then late", () => {
    const order = orderFor([proposal({ doc_date: "2026-11-25" })], "B1", "S1", today, 7)!;
    expect(order).toMatchObject({ doc_no: "DOC-1", eta: "2026-12-02", state: "pending" });
    expect(reorderStatus({ position: 2, min: 5, order, today }).status).toBe("ordered");
    expect(reorderStatus({ position: 2, min: 5, order, today: "2026-12-03" }).status).toBe("late");
  });
});

describe("orderFor", () => {
  const today = "2026-11-27";
  it("ignores another branch, another SKU, a rejected or old proposal", () => {
    expect(orderFor([proposal({ branch_id: "B2" })], "B1", "S1", today, 7)).toBeNull();
    expect(orderFor([proposal({ sku: "S2" })], "B1", "S1", today, 7)).toBeNull();
    expect(orderFor([proposal({ status: "rejected" as any })], "B1", "S1", today, 7)).toBeNull();
    // older than lead time + 30 days
    expect(orderFor([proposal({ doc_date: "2026-10-01" })], "B1", "S1", today, 7)).toBeNull();
  });
  it("prefers an approved proposal over a pending one, then the newest", () => {
    const ps = [proposal({ doc_no: "P", status: "pending", doc_date: "2026-11-26" }), proposal({ doc_no: "A", status: "approved", doc_date: "2026-11-20" })];
    expect(orderFor(ps, "B1", "S1", today, 7)?.doc_no).toBe("A");
  });
});

describe("buildBranchRows and carried", () => {
  const fullSku = { sku_id: "S1", type_id: "NECKLACES", name_en: "S1", name_lo: "S1", category: "Necklaces", active: true } as MasterSku;
  const desk = { desk_id: "D1", branch_id: "B1", active: true } as any;
  const transfer = { status: "in_transit", to_branch_id: "B1", from_branch_id: "B2", sku_id: "S1", qty: 3 } as any;
  const build = (carried: string[], inTransit: any[], rules: ReplenishmentRule[] = [], proposals: DocumentRecord[] = []) =>
    buildBranchRows({ branchId: "B1", today: "2026-11-27", skus: [fullSku], rules, config, desks: [desk], latestDays: [], latestRows: [], inTransit, proposals, carried: new Set(carried) });

  it("carried off but inbound still shows", () => {
    const rows = build([], [transfer]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku_id: "S1", onHand: 0, inbound: 3, status: "no_min" });
  });

  it("carried off and empty is hidden; carried and empty shows only with a min", () => {
    expect(build([], [])).toHaveLength(0);
    expect(build(["S1"], [])).toHaveLength(0);
    expect(build(["S1"], [], [rule("sku", "S1", "B1", 2, null)])[0]).toMatchObject({ status: "order_now", shortBy: 2, position: 0 });
  });

  it("a proposal naming the SKU turns order now into ordered", () => {
    const [row] = build(["S1"], [], [rule("sku", "S1", "B1", 2, 7)], [proposal({ doc_date: "2026-11-26" })]);
    expect(row).toMatchObject({ status: "ordered", order: { doc_no: "DOC-1", eta: "2026-12-03" } });
  });

  it("heldBySku sums on-hand and inbound for the branch", () => {
    const held = heldBySku([], [], [desk], [transfer], "B1");
    expect(held.get("S1")).toEqual({ onHand: 0, inbound: 3 });
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

  it("velocity counts withdraw as sold but not return", () => {
    const ds = dates(10, 7);
    const days = ds.map((d) => day("D1", d));
    const rows = ds.map((d, i) => row("D1", d, { withdraw: i === 0 ? 2 : 0, destock: i === 1 ? 5 : 0 } as Partial<LedgerRow>));
    const [v] = computeVelocity(rows, days, [], TO, 28);
    expect(v).toMatchObject({ in_stock_days: 7, sold: 2 });
  });
});
