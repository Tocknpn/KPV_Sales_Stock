import { describe, expect, it } from "vitest";
import { stripWeight, skuLabel as serverLabel } from "../src/skuName";
// @ts-expect-error plain browser ES module without types
import { skuLabel, filterSkus } from "../public/js/sku-groups.js";

describe("SKU names are the product only (2026-11-17)", () => {
  it("drops a trailing size in Lao or English", () => {
    expect(stripWeight("ຄຳແທ່ງ 1 ສະຫຼຶງ")).toBe("ຄຳແທ່ງ");
    expect(stripWeight(" ສາຍຄໍ 53.96 g ")).toBe("ສາຍຄໍ");
    expect(stripWeight("ຄຳແທ່ງ 1000g")).toBe("ຄຳແທ່ງ");
    expect(stripWeight("Gold Bar 2 Salueng")).toBe("Gold Bar");
    expect(stripWeight("ແຫວນ 5 ຫຸນ")).toBe("ແຫວນ");
  });

  it("keeps a name without a unit, and never empties a name", () => {
    expect(stripWeight("ແຫວນ ລາຍ 9")).toBe("ແຫວນ ລາຍ 9");
    expect(stripWeight("ປາກກາ")).toBe("ປາກກາ");
    expect(stripWeight("1 ບາດ")).toBe("1 ບາດ");
  });

  it("labels a SKU with its size, Baht first when it is whole hun", () => {
    const bar = { name_en: "Gold Bar", name_lo: "ຄຳແທ່ງ", std_gram_weight: 75, baht_weight: 5 };
    const gram = { name_en: "Necklace", name_lo: "ສາຍຄໍ", std_gram_weight: 53.96, baht_weight: 3.5973 };
    const kilo = { name_en: "Gold Bar", name_lo: "ຄຳແທ່ງ", std_gram_weight: 1000, baht_weight: 66.6667 };
    const box = { name_en: "Gift box", name_lo: "ກ່ອງ", std_gram_weight: null, baht_weight: 0 };
    for (const label of [skuLabel, serverLabel]) {
      expect(label(bar)).toBe("ຄຳແທ່ງ 5 ບາດ");
      expect(label(gram)).toBe("ສາຍຄໍ 53.96 ກລາມ");
      expect(label(kilo)).toBe("ຄຳແທ່ງ 1 ກິໂລ");
      expect(label(box)).toBe("ກ່ອງ");
      // an old name that still ends in its size is not given it twice
      expect(label({ ...bar, name_lo: "ຄຳແທ່ງ 5 ບາດ" })).toBe("ຄຳແທ່ງ 5 ບາດ");
    }
  });

  it("search finds a SKU by its size", () => {
    const skus = [
      { sku_id: "A", name_en: "Gold Bar", name_lo: "ຄຳແທ່ງ", std_gram_weight: 3.811, baht_weight: 0.25 },
      { sku_id: "B", name_en: "Gold Bar", name_lo: "ຄຳແທ່ງ", std_gram_weight: 15.244, baht_weight: 1 },
    ];
    expect(filterSkus(skus, "1 ສະຫຼຶງ").map((s: { sku_id: string }) => s.sku_id)).toEqual(["A"]);
  });
});
