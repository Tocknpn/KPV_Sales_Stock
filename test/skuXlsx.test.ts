// The SKU .xlsx layout (decided 2026-11-17): Lao + English header row, rows
// mapped by header text, Lao text kept as typed.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { SKU_HEADERS, exportRowsToSheet, sheetRowsToImport } from "../public/js/sku-xlsx.js";

const label = (g: number | null) => (g === 15.244 ? "1 ບາດ" : g == null ? "" : `${g} ກລາມ`);

describe("sku xlsx", () => {
  it("headers are exact", () => {
    expect(SKU_HEADERS).toEqual([
      "ລະຫັດ SKU / sku_id",
      "ຊື່ສິນຄ້າ* / name",
      "ປະເພດ* / type",
      "ນ້ຳໜັກ (ກຣາມ)* / grams",
      "ສະຕັອກຂັ້ນຕ່ຳ (ຊິ້ນ) / min_qty",
      "ໄລຍະສັ່ງ (ມື້) / lead_time_days",
      "ສາຂາ / branch_id",
      "ນ້ຳໜັກ (ລາວ) / size_lo",
    ]);
  });

  it("export puts Lao size label", () => {
    const aoa = exportRowsToSheet(
      [{ sku_id: "GB-001", name: "ທອງຄຳແທ່ງ 1 ບາດ", type: "ທອງຄຳແທ່ງ", grams: 15.244, min_qty: 13, lead_time_days: null, branch_id: null }],
      label
    );
    expect(aoa).toEqual([SKU_HEADERS, ["GB-001", "ທອງຄຳແທ່ງ 1 ບາດ", "ທອງຄຳແທ່ງ", 15.244, 13, null, null, "1 ບາດ"]]);
    expect(exportRowsToSheet([], label)).toEqual([SKU_HEADERS]);
  });

  it("sheetRowsToImport maps by header text", () => {
    const aoa = [
      ["ປະເພດ* / type", "Name", "grams", "ລະຫັດ SKU / sku_id", "ນ້ຳໜັກ (ລາວ) / size_lo"],
      ["ແຫວນ", "ແຫວນໃໝ່", 3.811, "", "1 ສະຫຼຶງ"],
    ];
    expect(sheetRowsToImport(aoa)).toEqual({
      error: null,
      rows: [{ line: 2, sku_id: "", name: "ແຫວນໃໝ່", type: "ແຫວນ", grams: 3.811, min_qty: null, lead_time_days: null, branch_id: null }],
    });
  });

  it("sheetRowsToImport trims and reads rich text", () => {
    const aoa = [SKU_HEADERS, ["", "ຄຳແທ່ງ  ", { v: "ສາຍຄໍ", r: "<r><t>ສາຍຄໍ</t></r>" }, " 15.244 ", "", "", "", ""]];
    const { rows } = sheetRowsToImport(aoa);
    expect(rows[0]).toMatchObject({ name: "ຄຳແທ່ງ", type: "ສາຍຄໍ", grams: "15.244" });
  });

  it("blank rows skipped, line numbers kept", () => {
    const aoa = [SKU_HEADERS, ["", "A", "ແຫວນ", 1], [null, "", "  ", null], [], ["", "B", "ແຫວນ", 1]];
    expect(sheetRowsToImport(aoa).rows.map((r: any) => [r.line, r.name])).toEqual([
      [2, "A"],
      [5, "B"],
    ]);
  });

  it("line numbers start from the sheet's first used row", () => {
    // The used range starts on row 3: header on row 3, first data row is line 4.
    const aoa = [SKU_HEADERS, ["", "A", "ແຫວນ", 1], [], ["", "B", "ແຫວນ", 1]];
    expect(sheetRowsToImport(aoa, 3).rows.map((r: any) => [r.line, r.name])).toEqual([
      [4, "A"],
      [6, "B"],
    ]);
    // Blank rows above the header (as SheetJS returns them with blankrows: true).
    const padded = [[], [null, null], SKU_HEADERS, ["", "A", "ແຫວນ", 1], [], ["", "B", "ແຫວນ", 1]];
    expect(sheetRowsToImport(padded).rows.map((r: any) => r.line)).toEqual([4, 6]);
  });

  it("missing grams column is an error", () => {
    expect(sheetRowsToImport([["ຊື່ສິນຄ້າ* / name", "ປະເພດ* / type"], ["A", "ແຫວນ"]]).error).toBe("missing column grams");
    expect(sheetRowsToImport([]).error).toBe("missing column name");
  });
});
