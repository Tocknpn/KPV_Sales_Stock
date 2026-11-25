import { describe, expect, it } from "vitest";
import { buildExecutive, coverBand, actionFor } from "../src/executive";
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
    avg: { value: 1, source: "auto" }, autoAvg: { value: 1, inStockDays: 30 }, lead: { value: 7, source: "default" },
    runwayDays: 10, status: "ok", suggestedQty: 0, review: false, ...patch,
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
  it("follows the runway status, then splits ok stock by how long it lasts", () => {
    expect(coverBand(status({ status: "critical" }))).toBe("critical");
    expect(coverBand(status({ status: "warning" }))).toBe("warning");
    expect(coverBand(status({ status: "no_data", avg: { value: null, source: "none" } }))).toBe("unknown");
    expect(coverBand(status({ runwayDays: 30 }))).toBe("ok");
    expect(coverBand(status({ runwayDays: 120 }))).toBe("long");
    expect(coverBand(status({ avg: { value: 0, source: "sku" }, runwayDays: null }))).toBe("no_sales");
  });
});

describe("action on a low SKU", () => {
  it("is none without a live proposal for that SKU", () => {
    expect(actionFor([], "B1", "A", TODAY, 10).state).toBe("none");
    expect(actionFor([proposal({}, "B")], "B1", "A", TODAY, 10).state).toBe("none");
    expect(actionFor([proposal({}, "A", 0)], "B1", "A", TODAY, 10).state).toBe("none");
    expect(actionFor([proposal({ branch_id: "B2" })], "B1", "A", TODAY, 10).state).toBe("none");
  });
  it("ignores a proposal older than lead time + margin", () => {
    expect(actionFor([proposal({ doc_date: "2026-11-01" })], "B1", "A", TODAY, 10).state).toBe("none");
    expect(actionFor([proposal({ doc_date: "2026-11-20" })], "B1", "A", TODAY, 10).state).toBe("pending");
  });
  it("prefers an approved proposal over a pending one", () => {
    const a = actionFor([proposal({ doc_no: "P-1" }), proposal({ doc_no: "P-2", status: "approved", doc_date: "2026-11-22" })], "B1", "A", TODAY, 10);
    expect(a).toMatchObject({ state: "approved", doc_no: "P-2", qty: 5 });
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

  it("values stock, works out value-weighted days of cover and flags unanswered low SKUs", () => {
    const statuses = new Map([
      ["B1|A", status({ sku_id: "A", position: 2, onHand: 2, runwayDays: 1, status: "critical", avg: { value: 2, source: "auto" } })],
      ["B1|B", status({ sku_id: "B", position: 40, onHand: 40, runwayDays: 200, avg: { value: 0.2, source: "auto" } })],
    ]);
    const ex = buildExecutive({ ...base, statuses, ledger: [], proposals: [] });
    // A: 2 x 1 Baht, B: 40 x 0.5 Baht, at 1000 LAK/Baht.
    expect(ex.headline.value_lak).toBe(22000);
    // (2000 + 20000) / (2*1000 + 0.2*500) = 22000 / 2100
    expect(ex.headline.cover_days).toBe(10.5);
    expect(ex.decisions.counts.critical.none).toBe(1);
    expect(ex.slow.items.map((s) => s.sku_id)).toEqual(["B"]);
    // B holds 40, 90 days needs 18: 22 pieces x 0.5 Baht x 1000 over.
    expect(ex.slow.excess_lak).toBe(11000);
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
