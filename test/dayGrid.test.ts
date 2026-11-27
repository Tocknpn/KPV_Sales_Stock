// The day screen's grid (public/js/views/day/row.js): SOP columns, which cells
// take input in each step, and how old days' moves and counts are shown.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { columnsFor, closingOf, editableFor, renderRow, headerHtml } from "../public/js/views/day/row.js";

const row = (extra: Record<string, unknown> = {}) => ({
  sku_id: "GB-001",
  name_en: "Gold bar",
  name_lo: "ທອງແທ່ງ",
  opening_qty: 10,
  stock_in: 0,
  transfer_in: 0,
  transfer_out: 0,
  move: 0,
  retail_sale: 0,
  wholesale: 0,
  destock: 0,
  withdraw: 0,
  stock_out_single: 0,
  move_qty: 0,
  legacy_move: 0,
  counted_qty: null,
  opening_editable: false,
  ...extra,
});

const sorted = (s: Set<string>) => [...s].sort();

describe("day grid", () => {
  it("dynamic columns are In, Retail, Wholesale, Return, Withdraw", () => {
    expect(columnsFor("dynamic")).toEqual(["stock_in", "retail_sale", "wholesale", "destock", "withdraw"]);
    expect(columnsFor("single")).toEqual(["stock_in", "stock_out_single"]);
    const head = headerHtml("dynamic");
    expect(head).not.toContain("grid.");
    expect(head).toContain("ສົ່ງຄືນ"); // Return
    expect(head).toContain("ຖອນ"); // Withdraw
    expect(head.match(/<div/g)).toHaveLength(8); // name + opening + 5 + closing
  });

  it("closingOf subtracts withdraw", () => {
    expect(closingOf(row({ stock_in: 5, retail_sale: 2, wholesale: 1, destock: 1, withdraw: 3 }))).toBe(8);
    // Old days' linked transfers and moves still count.
    expect(closingOf(row({ transfer_in: 2, transfer_out: 1, move: 1, move_qty: -3 }))).toBe(7);
    // Optional fields may be missing.
    const { withdraw, stock_out_single, move_qty, ...bare } = row();
    expect(closingOf(bare)).toBe(10);
  });

  it("opening step: only stock_in, plus opening on a new row", () => {
    expect(sorted(editableFor("opening", "dynamic", row({ opening_editable: false })))).toEqual(["stock_in"]);
    expect(sorted(editableFor("opening", "dynamic", row({ opening_editable: true })))).toEqual(["opening_qty", "stock_in"]);
    const html = renderRow(row({ opening_editable: true }), { status: "opening", mode: "dynamic" });
    expect(html).toContain('data-field="opening_qty"');
    expect(html).toContain('data-field="stock_in"');
    expect(html).not.toContain('data-field="retail_sale"');
  });

  it("check_in step: stock_in and the four outs; opening never", () => {
    const fields = ["destock", "retail_sale", "stock_in", "wholesale", "withdraw"];
    expect(sorted(editableFor("check_in", "dynamic", row()))).toEqual(fields);
    expect(sorted(editableFor("check_in", "dynamic", row({ opening_editable: true })))).toEqual(fields);
    expect(sorted(editableFor("final_stock", "dynamic", row()))).toEqual(fields);
    expect(sorted(editableFor("check_in", "single", row()))).toEqual(["stock_in", "stock_out_single"]);
    expect(editableFor("done", "dynamic", row()).size).toBe(0);
    const html = renderRow(row(), { status: "check_in", mode: "dynamic" });
    expect(html).not.toContain('data-field="opening_qty"');
    expect(html).toContain('data-field="withdraw"');
    expect(html).not.toContain('data-field="move_qty"');
    expect(renderRow(row(), { status: "done", mode: "dynamic" })).not.toContain("data-field=");
  });

  it("legacy move shows on the closing cell", () => {
    const html = renderRow(row({ legacy_move: -3, move_qty: -3 }), { status: "done", mode: "dynamic" });
    expect(html).toContain("⇄ −3");
    expect(renderRow(row(), { status: "done", mode: "dynamic" })).not.toContain("⇄");
  });

  it("a past counted value shows as a note, never as an input", () => {
    for (const status of ["check_in", "done"]) {
      const html = renderRow(row({ counted_qty: 8 }), { status, mode: "dynamic" });
      expect(html).not.toContain("data-count");
      expect(html).toContain("8");
      expect(html).not.toMatch(/<input[^>]*value="8"/);
    }
  });

  it("a row at or below its minimum shows the order-now chip and the shortfall", () => {
    const html = renderRow(row({ branch_status: "order_now", short_by: 3 }), { status: "check_in", mode: "dynamic" });
    expect(html).toContain("data-order-chip");
    expect(html).toContain("ສັ່ງ! ຂາດ 3");
    expect(html).toContain("ສັ່ງດຽວນີ້! · ຂາດ 3");
  });

  it("an ordered row shows its expected arrival; an ok row shows no chip", () => {
    expect(renderRow(row({ branch_status: "ordered", short_by: 1, order_eta: "2026-12-02" }), { status: "check_in", mode: "dynamic" })).toContain("~2/12");
    expect(renderRow(row({ branch_status: "ok" }), { status: "check_in", mode: "dynamic" })).not.toContain("data-order-chip");
  });

  it("shows the SKU's detail line", () => {
    expect(renderRow(row({ detail: "ຍາວ15-17" }), { status: "check_in", mode: "dynamic" })).toContain("ຍາວ15-17");
  });
});
