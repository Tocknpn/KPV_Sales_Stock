import { describe, expect, it } from "vitest";
import { computeClosing, stockOutOf, soldOf, netMoveOf, parseSignedQty, carryQty, currentQty, reorderPoint, valueLak, parseQty, validateDeskDay, buildCalendarMonth } from "../src/logic";
import { laosDate, monthRange, isValidDate, addDays } from "../src/time";
import type { LedgerRow } from "../src/types";

function row(patch: Partial<LedgerRow> = {}): LedgerRow {
  const base: LedgerRow = {
    id: "x",
    ledger_date: "2026-11-12",
    desk_id: "MM-D01",
    branch_id: "B-MM",
    sku_id: "GB-001",
    opening_qty: 10,
    stock_in: 0,
    transfer_in: 0,
    retail_sale: 0,
    wholesale: 0,
    transfer_out: 0,
    destock: 0,
    destock_note: null,
    move: 0,
    stock_out_single: 0,
    stock_out: 0,
    move_qty: 0,
    closing_qty: 0,
    counted_qty: null,
    counted_note: null,
    performed_by: null,
    excluded: false,
    created_at: "",
    updated_at: "",
    ...patch,
  };
  base.stock_out = stockOutOf(base);
  base.closing_qty = computeClosing(base);
  return base;
}

describe("closing formula", () => {
  it("is opening + in + transfer in - sale - wholesale - out - destock - move", () => {
    expect(computeClosing(row({ opening_qty: 20, stock_in: 5, transfer_in: 2, retail_sale: 3, wholesale: 4, transfer_out: 1, destock: 2, move: 1 }))).toBe(16);
  });
  it("subtracts a single-mode stock-out total and adds a signed Move in/out", () => {
    expect(computeClosing(row({ opening_qty: 20, stock_in: 5, stock_out_single: 8, move_qty: -3 }))).toBe(14);
    expect(computeClosing(row({ opening_qty: 20, move_qty: 8 }))).toBe(28);
  });
  it("stock_out combines the three parts and the single total", () => {
    expect(stockOutOf(row({ retail_sale: 3, wholesale: 4, destock: 2 }))).toBe(9);
    expect(stockOutOf(row({ stock_out_single: 7 }))).toBe(7);
  });
  it("sold is retail + wholesale, or the single total (destock never counts)", () => {
    expect(soldOf(row({ retail_sale: 3, wholesale: 4, destock: 2 }))).toBe(7);
    expect(soldOf(row({ stock_out_single: 5 }))).toBe(5);
  });
  it("net move adds Move in/out to the old linked columns", () => {
    expect(netMoveOf(row({ transfer_in: 2, transfer_out: 1, move: 1, move_qty: -8 }))).toBe(-8);
  });
  it("parseSignedQty accepts negatives within the limit", () => {
    expect(parseSignedQty("-8")).toBe(-8);
    expect(parseSignedQty(8)).toBe(8);
    expect(parseSignedQty(1.5)).toBeNull();
    expect(parseSignedQty(-100000)).toBeNull();
  });
});

describe("carry forward", () => {
  it("uses the physical count when there is one", () => {
    expect(carryQty(row({ counted_qty: 8 }))).toBe(8);
    expect(carryQty(row())).toBe(10);
  });
  it("an open day is still at its running closing, a Done day at its count", () => {
    const r = row({ counted_qty: 8 });
    expect(currentQty(r, "final_stock")).toBe(10);
    expect(currentQty(r, "done")).toBe(8);
  });
});

describe("reorder point", () => {
  const config = { warning_margin_days: 3 };
  const st = (avg: number | null, lead: number) => ({ avg: { value: avg }, lead: { value: lead } });
  it("is avg/day x (lead time + warning margin), rounded up", () => {
    expect(reorderPoint(st(2.5, 3), config)).toBe(15);
    expect(reorderPoint(st(1.1, 7), config)).toBe(11);
  });
  it("is 0 (not known) without an avg/day; no fixed level any more", () => {
    expect(reorderPoint(st(null, 7), config)).toBe(0);
    expect(reorderPoint(st(0, 7), config)).toBe(0);
    expect(reorderPoint(undefined, config)).toBe(0);
  });
});

describe("valuation", () => {
  const config = { spot_lak_per_baht: 30000000 };
  it("values gold at Baht weight x gold price", () => {
    expect(valueLak({ baht_weight: 0.5 }, 4, config.spot_lak_per_baht)).toBe(60000000);
  });
  it("every SKU is gold: no Baht weight is worth 0", () => {
    expect(valueLak({ baht_weight: 0 }, 3, config.spot_lak_per_baht)).toBe(0);
  });
});

describe("quantity input", () => {
  it("accepts whole numbers from 0", () => {
    expect(parseQty(0)).toBe(0);
    expect(parseQty("12")).toBe(12);
  });
  it("rejects negatives, fractions and junk", () => {
    for (const bad of [-1, 1.5, "abc", null, undefined, "", 1e9]) expect(parseQty(bad)).toBeNull();
  });
});

describe("rules before a day can be Done", () => {
  it("passes a fully counted, explained day", () => {
    expect(validateDeskDay([row({ retail_sale: 2, counted_qty: 8 })])).toEqual([]);
  });
  it("requires a count on every row", () => {
    expect(validateDeskDay([row()])).toEqual([{ sku_id: "GB-001", rule: "count_missing" }]);
  });
  it("requires a note when the count differs from the closing", () => {
    expect(validateDeskDay([row({ counted_qty: 9 })])).toEqual([{ sku_id: "GB-001", rule: "variance_note_missing" }]);
    expect(validateDeskDay([row({ counted_qty: 9, counted_note: "one found damaged" })])).toEqual([]);
  });
  it("requires a reason for destock", () => {
    expect(validateDeskDay([row({ destock: 1, counted_qty: 9 })])).toEqual([{ sku_id: "GB-001", rule: "destock_note_missing" }]);
    expect(validateDeskDay([row({ destock: 1, destock_note: "  ", counted_qty: 9 })])).toHaveLength(1);
  });
  it("rejects a negative closing", () => {
    const failures = validateDeskDay([row({ retail_sale: 11, counted_qty: 0, counted_note: "x" })]);
    expect(failures.map((f) => f.rule)).toContain("negative_closing");
  });
  it("ignores rows removed from the day", () => {
    expect(validateDeskDay([row({ excluded: true })])).toEqual([]);
  });
});

describe("dates", () => {
  it("uses the Laos calendar date (UTC+7)", () => {
    expect(laosDate(new Date("2026-11-11T16:59:00Z"))).toBe("2026-11-11");
    expect(laosDate(new Date("2026-11-11T17:00:00Z"))).toBe("2026-11-12");
  });
  it("month ranges end on the real last day", () => {
    expect(monthRange("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthRange("2027-02")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(monthRange("2028-02").to).toBe("2028-02-29");
  });
  it("validates dates", () => {
    expect(isValidDate("2026-11-31")).toBe(false);
    expect(isValidDate("2026-11-30")).toBe(true);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("calendar", () => {
  const desks = [1, 2].map((n) => ({ desk_id: `D${n}`, branch_id: "B", display_name: `D${n}`, active: true, sort_order: n, created_at: "2026-11-01T00:00:00Z" }));
  const day = (desk_id: string, status: "check_in" | "final_stock" | "done") => ({
    desk_id,
    ledger_date: "2026-11-12",
    branch_id: "B",
    status,
    safe_drop_note: null,
    checked_in_by: null,
    done_by: null,
    done_at: null,
    stock_out_mode: "dynamic" as const,
    created_at: "",
    updated_at: "",
  });
  it("is only complete when every desk is Done", () => {
    expect(buildCalendarMonth(["2026-11-12"], desks, [])[0].pct).toBe(0);
    expect(buildCalendarMonth(["2026-11-12"], desks, [day("D1", "done"), day("D2", "check_in")])[0].pct).toBe(75);
    expect(buildCalendarMonth(["2026-11-12"], desks, [day("D1", "done"), day("D2", "done")])[0].pct).toBe(100);
  });
});
