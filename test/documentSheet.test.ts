import { describe, expect, it } from "vitest";
import { groupSheetRows, renderDocumentSheet, productBase } from "../src/print/documentSheet";
import type { MasterSku, SkuType } from "../src/types";

const types: SkuType[] = [
  { type_id: "NECKLACES", name_en: "Necklaces", name_lo: "ສາຍຄໍ", icon: "necklace", active: true, sort_order: 2 },
  { type_id: "BRACELETS", name_en: "Bracelets", name_lo: "ສາຍແຂນ", icon: "bracelet", active: true, sort_order: 3 },
  { type_id: "RINGS_ACCESSORIES", name_en: "Rings & Accessories", name_lo: "ແຫວນ", icon: "ring", active: true, sort_order: 4 },
];
const sku = (sku_id: string, name_lo: string, type_id: string, gram: number): MasterSku =>
  ({ sku_id, name_en: sku_id, name_lo, type_id, std_gram_weight: gram, baht_weight: gram / 15 }) as MasterSku;
const skus = [
  sku("NECK-1B", "ສາຍຄໍ 1 ບາດ", "NECKLACES", 15),
  sku("NECK-3S", "ສາຍຄໍ 3 ສະຫຼຶງ", "NECKLACES", 11.25),
  sku("BRAC-1B", "ສາຍແຂນ 1 ບາດ", "BRACELETS", 15),
  sku("AMUL-1S", "ກີ້ພະ 1 ສະຫຼຶງ", "RINGS_ACCESSORIES", 3.75),
];
const row = (sku_id: string | null, item: string, qty: number | null, weight_g: number | null = null, note: string | null = null) =>
  ({ id: item, document_id: "d", sort_order: 0, sku_id, item, qty, weight_g, note });

describe("productBase", () => {
  it("drops the size from a Lao product name", () => {
    expect(productBase("ສາຍຄໍ 1 ບາດ")).toBe("ສາຍຄໍ");
    expect(productBase("ກີ້ພະ 1 ສະຫຼຶງ")).toBe("ກີ້ພະ");
    expect(productBase("ປີເຊຍ 0.18 g")).toBe("ປີເຊຍ");
    expect(productBase("ຄຳແທ່ງ")).toBe("ຄຳແທ່ງ");
  });
});

describe("groupSheetRows", () => {
  it("groups by product and weight per piece like the case sheet, with subtotals and a grand total", () => {
    const sheet = groupSheetRows(
      [
        row("BRAC-1B", "ຕະໃບກົມ", 25, null, "ຍາວ12-18"),
        row("NECK-1B", "ໂສ້", 50),
        row("AMUL-1S", "ພະປະຈຳວັນເກີດ", 105),
        row("NECK-3S", "ໂສ້", 20, 225),
        row("NECK-1B", "ປ້ອງອ້ອຍ", 50, 751),
        row(null, "Free text item", 2, 9.5),
      ],
      skus,
      types
    );
    expect(sheet.groups.map((g) => `${g.label}/${g.gramEach}`)).toEqual(["ສາຍຄໍ/15", "ສາຍຄໍ/11.25", "ສາຍແຂນ/15", "ກີ້ພະ/3.75", "ອື່ນໆ/null"]);
    const neck = sheet.groups[0];
    // weight falls back to qty x grams per piece; a typed weight wins
    expect(neck.rows.map((r) => [r.pattern, r.qty, r.grams])).toEqual([["ໂສ້", 50, 750], ["ປ້ອງອ້ອຍ", 50, 751]]);
    expect(neck.totalQty).toBe(100);
    expect(neck.totalGrams).toBe(1501);
    expect(sheet.groups[2].rows[0].size).toBe("ຍາວ12-18");
    expect(sheet.groups[3].totalGrams).toBe(393.75);
    expect(sheet.totalQty).toBe(252);
    expect(sheet.totalGrams).toBeCloseTo(750 + 751 + 225 + 375 + 393.75 + 9.5);
  });
});

describe("renderDocumentSheet", () => {
  it("prints the case-sheet columns, merged type cells and totals, and escapes text", () => {
    const html = renderDocumentSheet({
      doc: {
        doc_no: "MM-2026-0001", title: "ລາຍລະອຽດເຄື່ອງຕູ້ 2 <b>", doc_date: "2026-11-15", branch_name: "Morning Market",
        desk_id: "MM-D02", desk_name: "ຕູ້ 2", created_by: "Owner", created_at: "2026-11-15T03:00:00Z",
        notes: "check", status: null, decided_by: null, decided_at: null,
        rows: [row("NECK-1B", "ໂສ້", 50), row("NECK-1B", "ປ້ອງອ້ອຍ", 50)],
      } as any,
      skus,
      types,
    });
    for (const header of ["ປະເພດ", "ນ້ຳໜັກ", "ລາຍ", "ຂະໜາດ", "ຈຳນວນຢ່າງ", "ນັບໄດ້", "ອໍເດີ", "ຜູ້ສົ່ງ", "ຊ່າງ", "ຜູ້ອານຸມັດ", "ລວມນ້ຳໜັກ+ຈຳນວນ"]) {
      expect(html).toContain(header);
    }
    expect(html).toContain('rowspan="2"');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("1,500");
    expect(html).toContain("@page");
  });
});
