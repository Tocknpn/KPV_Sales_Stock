import { describe, expect, it } from "vitest";
import { buildExecutive, coverBand } from "../src/executive";
import { computeClosing, stockOutOf } from "../src/logic";
import type { DocumentRecord, LedgerRow, MasterSku } from "../src/types";
import type { ReplenishmentRow } from "../src/replenishment";

const TODAY = "2026-11-25";

function sku(id: string, baht = 1): MasterSku {
  return { sku_id: id, name_en: id, name_lo: null, category: "Rings", type_id: "T1", baht_weight: baht, std_gram_weight: baht * 15.16, active: true, icon: "ring" } as MasterSku;
}
function status(patch: Partial<ReplenishmentRow>): ReplenishmentRow {
  return {
    sku_id: "A", name: "A", name_lo: null, type: "Rings", onHand: 10, inbound: 0, position: 10,
    min: { value: 3, source: "sku" }, lead: { value: 7, source: "default" },
    status: "ok", shortBy: 0, order: null, ...patch,
  };
}
function row(patch: Partial<LedgerRow>): LedgerRow {
  const base = {
    id: "x", ledger_date: TODAY, desk_id: "D1", branch_id: "B1", sku_id: "A", opening_qty: 10, stock_in: 0, transfer_in: 0,
    retail_sale: 0, wholesale: 0, transfer_out: 0, destock: 0, destock_note: null, move: 0, withdraw: 0, stock_out_single: 0,
    stock_out: 0, move_qty: 0, closing_qty: 0, counted_qty: null, counted_note: null, performed_by: null, excluded: false,
    created_at: "", updated_at: "", ...patch,
  } as LedgerRow;
  base.stock_out = stockOutOf(base);
  base.closing_qty = computeClosing(base);
  return base;
}
function proposal(patch: Partial<DocumentRecord>, skuId = "A", qty = 5): DocumentRecord {
  return {
    id: "p", doc_no: "P-1", title: "", branch_id: "B1", desk_id: "D1", created_by: "u", doc_date: TODAY, created_at: "", notes: null,
    kind: "proposal", status: "pending", decided_by: null, decided_at: null,
    rows: [{ id: "r", document_id: "p", sort_order: 0, sku_id: skuId, item: skuId, qty, weight_g: null, note: null }], ...patch,
  };
}

describe("cover band", () => {
  it("is the min-stock status", () => {
    for (const st of ["order_now", "late", "ordered", "ok", "no_min"] as const) expect(coverBand(status({ status: st }))).toBe(st);
  });
});

describe("executive overview", () => {
  const base = {
    today: TODAY,
    periodDays: 7 as const,
    skus: [sku("A", 1), sku("B", 0.5)],
    types: [{ type_id: "T1", name_en: "Rings", name_lo: "ແຫວນ", icon: "ring", active: true, sort_order: 1 }],
    branches: [{ branch_id: "B1", name_en: "One", name_lo: null } as never],
    desks: [{ desk_id: "D1", branch_id: "B1", display_name: "Desk 01", active: true, sort_order: 1, created_at: "" }],
    latestDays: [],
    latestRows: [],
    config: { warning_margin_days: 3, usd_to_lak_rate: 0 },
    lakPerBaht: 1000,
    branchIds: ["B1"],
  };

  it("values stock, counts SKUs to order and lists what is held over 3x its minimum", () => {
    const statuses = new Map([
      ["B1|A", status({ sku_id: "A", position: 2, onHand: 2, status: "order_now", shortBy: 1 })],
      ["B1|B", status({ sku_id: "B", position: 40, onHand: 40, min: { value: 5, source: "sku" } })],
      ["B1|C", status({ sku_id: "C", position: 1, onHand: 1, status: "ordered", shortBy: 2, order: { doc_no: "P-1", doc_date: TODAY, state: "pending", qty: 5, eta: "2026-12-02" } })],
    ]);
    const ex = buildExecutive({ ...base, skus: [...base.skus, sku("C")], statuses, ledger: [], proposals: [proposal({})] });
    // A: 2 x 1 Baht, B: 40 x 0.5 Baht, C: 1 x 1 Baht, at 1000 LAK/Baht.
    expect(ex.headline.value_lak).toBe(23000);
    expect(ex.headline.baht).toBe(23);
    expect(ex.decisions.counts).toEqual({ order_now: 1, late: 0, ordered: 1 });
    expect(ex.decisions.items.map((d) => [d.sku_id, d.action, d.eta])).toEqual([["A", "none", null], ["C", "pending", "2026-12-02"]]);
    // B holds 40, 3 x min = 15: 25 over.
    expect(ex.slow.items.map((s) => [s.sku_id, s.excess_qty])).toEqual([["B", 25]]);
  });

  it("ranks stock out in the period and compares with the period before", () => {
    const ledger = [
      row({ sku_id: "A", retail_sale: 3 }),
      row({ sku_id: "B", retail_sale: 1, withdraw: 4, destock: 2 }),
      row({ sku_id: "A", ledger_date: "2026-11-15", retail_sale: 2 }), // previous 7 days
      row({ sku_id: "A", ledger_date: "2026-11-01", retail_sale: 9 }), // outside both
    ];
    const ex = buildExecutive({ ...base, statuses: new Map(), ledger, proposals: [] });
    expect(ex.stockOut.map((s) => [s.sku_id, s.sold, s.returned])).toEqual([["B", 5, 2], ["A", 3, 0]]);
    expect(ex.flow.sold).toBe(8);
    expect(ex.flow.prev_sold).toBe(2);
    expect(ex.cases[0]).toMatchObject({ desk_id: "D1", sold: 8 });
    expect(ex.daily).toHaveLength(7);
  });
});
