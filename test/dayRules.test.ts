// Pure helpers of the day screen (public/js/views/day/day-rules.js) and the
// min-stock chip (public/js/util.js).
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { addPlan, addItems, nextDayNegativeText, reopenRange, STEP_CHANGED_CODES } from "../public/js/views/day/day-rules.js";
// @ts-expect-error plain browser ES module without types
import { reorderChip, fmtPlanLine } from "../public/js/util.js";

const sku = (sku_id: string) => ({ sku_id });

describe("add SKU plan", () => {
  it("opening step: asks an opening only for SKUs the day did not carry; carried ones go with 0", () => {
    const skus = [sku("A"), sku("B"), sku("C")];
    const plan = addPlan(skus, true, ["B", "X"]);
    expect(plan.field).toBe("opening_qty");
    expect(plan.ask.map((s: any) => s.sku_id)).toEqual(["A", "C"]);
    const items = addItems(skus, plan.field, new Map([["A", 4], ["C", 1]]));
    expect(items).toEqual([
      { sku_id: "A", opening_qty: 4 },
      { sku_id: "B", opening_qty: 0 },
      { sku_id: "C", opening_qty: 1 },
    ]);
  });

  it("opening step with only carried SKUs asks nothing", () => {
    expect(addPlan([sku("B")], true, ["B"]).ask).toEqual([]);
  });

  it("after check-in every SKU takes a stock-in quantity", () => {
    const skus = [sku("A"), sku("B")];
    const plan = addPlan(skus, false, ["B"]);
    expect(plan).toEqual({ ask: skus, field: "stock_in" });
    expect(addItems(skus, plan.field, new Map([["B", 2]]))).toEqual([
      { sku_id: "A", stock_in: 0 },
      { sku_id: "B", stock_in: 2 },
    ]);
  });
});

describe("NEXT_DAY_NEGATIVE text", () => {
  const rows = [{ sku_id: "GB-001", name_en: "Gold bar", name_lo: "ທອງແທ່ງ", baht_weight: 1 }];

  it("names the item (Lao name) and the date", () => {
    const text = nextDayNegativeText({ sku_id: "GB-001", date: "2026-11-10", available: 2 }, rows, (d: string) => `D:${d}`);
    expect(text).toContain("ທອງແທ່ງ");
    expect(text).toContain("D:2026-11-10");
    expect(text).toContain("2");
    expect(text).not.toMatch(/\{(name|date|n)\}/);
  });

  it("falls back to the SKU id when the row is not on screen", () => {
    expect(nextDayNegativeText({ sku_id: "ZZ-9", date: "2026-11-10", available: 0 }, rows)).toContain("ZZ-9");
  });
});

describe("reopen range", () => {
  it("runs from the reopened date up to today", () => {
    expect(reopenRange("2026-11-09", "2026-11-12")).toEqual({ from: "2026-11-09", to: "2026-11-12" });
    expect(reopenRange("2026-11-12", "2026-11-12")).toEqual({ from: "2026-11-12", to: "2026-11-12" });
  });
});

describe("stale step codes", () => {
  it("reload the day on EARLIER_DAY_OPEN, FIELD_NOT_IN_STEP and BAD_TRANSITION", () => {
    expect([...STEP_CHANGED_CODES].sort()).toEqual(["BAD_TRANSITION", "EARLIER_DAY_OPEN", "FIELD_NOT_IN_STEP"]);
  });
});

describe("min-stock chip and plan line", () => {
  it("order now names the shortfall; ok and no min show nothing", () => {
    expect(reorderChip({ branch_status: "order_now", short_by: 2 })).toMatchObject({ status: "order_now", cls: expect.stringContaining("danger") });
    expect(reorderChip({ branch_status: "ok" })).toBeNull();
    expect(reorderChip({ status: "no_min" })).toBeNull();
  });

  it("ordered is amber, late is red", () => {
    expect(reorderChip({ status: "ordered", eta: "2026-12-02" })?.cls).toContain("warning");
    expect(reorderChip({ status: "late", eta: "2026-12-02" })?.cls).toContain("danger");
  });

  it("plan line shows min and lead, or no min", () => {
    expect(fmtPlanLine(5, 7)).toBe("ຂັ້ນຕ່ຳ 5 · ໄລຍະສັ່ງ 7 ມື້");
    expect(fmtPlanLine(null, 7)).toBe("ບໍ່ມີຂັ້ນຕ່ຳ · ໄລຍະສັ່ງ 7 ມື້");
  });
});
