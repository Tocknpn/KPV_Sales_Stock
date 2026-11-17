import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { groupSkusByType, filterSkus, toggleSelection, skuSizeLabel } from "../public/js/sku-groups.js";

const types = [
  { type_id: "T-RING", name_en: "Rings", name_lo: "ແຫວນ", sort_order: 2, active: true },
  { type_id: "T-NECK", name_en: "Necklaces", name_lo: "ສາຍຄໍ", sort_order: 1, active: true },
  { type_id: "T-OLD", name_en: "Old", name_lo: null, sort_order: 3, active: false },
];
const weights = [
  { weight_id: "W-1B", name_en: "1 Baht", sort_order: 2 },
  { weight_id: "W-HB", name_en: "0.5 Baht", sort_order: 1 },
];
const sku = (sku_id: string, type_id: string | null, weight_id: string | null, extra: Record<string, unknown> = {}) => ({
  sku_id,
  type_id,
  weight_id,
  name_en: sku_id,
  name_lo: null,
  baht_weight: 0,
  weight_name: null,
  ...extra,
});

describe("groupSkusByType", () => {
  it("orders groups by type sort_order and items by weight sort_order", () => {
    const groups = groupSkusByType(
      [sku("R1", "T-RING", "W-1B"), sku("N1", "T-NECK", "W-1B"), sku("N2", "T-NECK", "W-HB")],
      types,
      weights
    );
    expect(groups.map((g: any) => g.typeId)).toEqual(["T-NECK", "T-RING"]);
    expect(groups[0].items.map((s: any) => s.sku_id)).toEqual(["N2", "N1"]);
    expect(groups[0].type.name_lo).toBe("ສາຍຄໍ");
  });

  it("puts SKUs with no or unknown type in a last group with typeId null", () => {
    const groups = groupSkusByType([sku("X", null, null), sku("Y", "T-GONE", null), sku("R1", "T-RING", null)], types, weights);
    expect(groups.map((g: any) => g.typeId)).toEqual(["T-RING", null]);
    expect(groups[1].type).toBeNull();
    expect(groups[1].items.map((s: any) => s.sku_id)).toEqual(["X", "Y"]);
  });

  it("keeps SKUs of an inactive type under that type", () => {
    const groups = groupSkusByType([sku("O1", "T-OLD", null)], types, weights);
    expect(groups).toHaveLength(1);
    expect(groups[0].typeId).toBe("T-OLD");
  });

  it("breaks weight ties by baht weight, then name", () => {
    const groups = groupSkusByType(
      [sku("B", "T-RING", null, { baht_weight: 2, name_lo: "ຂ" }), sku("A", "T-RING", null, { baht_weight: 1, name_lo: "ກ" }), sku("C", "T-RING", null, { baht_weight: 1, name_lo: "ຄ" })],
      types,
      weights
    );
    expect(groups[0].items.map((s: any) => s.sku_id)).toEqual(["A", "C", "B"]);
  });
});

describe("filterSkus", () => {
  const list = [sku("NK-010", "T-NECK", null, { name_en: "Snake Chain", name_lo: "ສາຍຄໍ 14 ບາດ" }), sku("RG-030", "T-RING", null, { name_en: "Plain Ring" })];
  it("returns all for a blank query", () => {
    expect(filterSkus(list, "  ")).toHaveLength(2);
  });
  it("matches Lao name, English name and SKU id, ignoring case", () => {
    expect(filterSkus(list, "ສາຍຄໍ").map((s: any) => s.sku_id)).toEqual(["NK-010"]);
    expect(filterSkus(list, "plain").map((s: any) => s.sku_id)).toEqual(["RG-030"]);
    expect(filterSkus(list, "nk-0").map((s: any) => s.sku_id)).toEqual(["NK-010"]);
  });
});

describe("toggleSelection", () => {
  it("adds and removes without changing the input", () => {
    const a = new Set(["X"]);
    const b = toggleSelection(a, "Y");
    expect([...a]).toEqual(["X"]);
    expect([...b].sort()).toEqual(["X", "Y"]);
    expect([...toggleSelection(b, "X")]).toEqual(["Y"]);
  });
});

describe("skuSizeLabel", () => {
  it("prefers the weight name, then baht weight, else empty", () => {
    expect(skuSizeLabel(sku("A", null, null, { weight_name: "1 Baht", baht_weight: 1 }))).toBe("1 Baht");
    expect(skuSizeLabel(sku("A", null, null, { baht_weight: 0.25 }))).toBe("0.25 Baht");
    expect(skuSizeLabel(sku("A", null, null))).toBe("");
  });
});
