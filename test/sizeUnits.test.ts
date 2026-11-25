// Sizes built from units (decided 2026-11-25): Settings > SKU > Units holds
// each unit's grams; a SKU's size is up to 4 "qty unit" parts.
import { beforeEach, describe, expect, it } from "vitest";
import { freshApp, call, asAdmin, asStaff } from "./helpers";
import { partsGrams, partsLabel, readParts } from "../src/sizes";
import type { SkuUnit } from "../src/types";

beforeEach(freshApp);

const UNITS: SkuUnit[] = [
  { unit: "ບາດ", gram_value: 15, active: true, sort_order: 1 },
  { unit: "ສະຫຼຶງ", gram_value: 3.75, active: true, sort_order: 2 },
  { unit: "ຫຸນ", gram_value: 0.375, active: true, sort_order: 3 },
];

describe("size parts", () => {
  it("puts the biggest unit first and sums the grams", () => {
    const parts = readParts([{ unit: "ສະຫຼຶງ", qty: 2 }, { unit: "ບາດ", qty: "4" }], UNITS);
    expect(parts).toEqual([{ unit: "ບາດ", qty: 4 }, { unit: "ສະຫຼຶງ", qty: 2 }]);
    expect(partsLabel(parts as any)).toBe("4 ບາດ 2 ສະຫຼຶງ");
    expect(partsGrams(parts as any, UNITS)).toBe(67.5);
  });

  it("refuses no parts, more than 4, an unknown unit, a zero amount and a repeated unit", () => {
    expect(typeof readParts([], UNITS)).toBe("string");
    expect(typeof readParts(Array.from({ length: 5 }, () => ({ unit: "ບາດ", qty: 1 })), UNITS)).toBe("string");
    expect(typeof readParts([{ unit: "ກິໂລ", qty: 1 }], UNITS)).toBe("string");
    expect(typeof readParts([{ unit: "ບາດ", qty: 0 }], UNITS)).toBe("string");
    expect(typeof readParts([{ unit: "ບາດ", qty: 1 }, { unit: "ບາດ", qty: 2 }], UNITS)).toBe("string");
  });
});

describe("SKU size from units", () => {
  it("a staff member's new SKU makes the size it needs, and the next one reuses it", async () => {
    const staff = await asStaff("B-MM");
    const size = [{ unit: "ສະຫຼຶງ", qty: 2 }, { unit: "ບາດ", qty: 4 }];
    const a = await call(staff, "POST", "/skus", { name: "ສາຍຄໍ", type_id: "NECKLACES", size });
    expect(a.status).toBe(200);
    const weights = (await call(staff, "GET", "/sku-weights")).json.weights;
    const made = weights.find((w: any) => w.weight_id === a.json.weight_id);
    expect(made).toMatchObject({ name_en: "4 ບາດ 2 ສະຫຼຶງ", gram_value: 68.598, parts: [{ unit: "ບາດ", qty: 4 }, { unit: "ສະຫຼຶງ", qty: 2 }] });
    expect(a.json.std_gram_weight).toBe(68.598);

    const b = await call(staff, "POST", "/skus", { name: "ສາຍແຂນ", type_id: "NECKLACES", size: [{ unit: "ບາດ", qty: 4 }, { unit: "ສະຫຼຶງ", qty: 2 }] });
    expect(b.json.weight_id).toBe(a.json.weight_id);
    expect((await call(staff, "GET", "/sku-weights")).json.weights.length).toBe(weights.length);
  });

  it("a one-unit size reuses the existing size of that label", async () => {
    const admin = await asAdmin();
    const res = await call(admin, "POST", "/skus", { name: "ຄຳແທ່ງ", type_id: "NECKLACES", size: [{ unit: "ບາດ", qty: 1 }], branchId: "B-MM" });
    expect(res.json.weight_id).toBe("BAHT_1");
  });

  it("refuses a bad size and an unknown unit", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "POST", "/skus", { name: "x", type_id: "NECKLACES", size: [{ unit: "ໂຕນ", qty: 1 }] });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("BAD_SIZE");
  });

  it("only an admin changes an existing SKU's size", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const created = (await call(admin, "POST", "/skus", { name: "ແຫວນ", type_id: "NECKLACES", size: [{ unit: "ບາດ", qty: 1 }], branchId: "B-MM" })).json;
    expect((await call(staff, "PATCH", `/skus/${created.sku_id}`, { size: [{ unit: "ບາດ", qty: 2 }] })).json.code).toBe("ROLE_DENIED");
    const res = await call(admin, "PATCH", `/skus/${created.sku_id}`, { size: [{ unit: "ບາດ", qty: 2 }, { unit: "ກລາມ", qty: 1 }] });
    expect(res.status).toBe(200);
    expect(res.json.std_gram_weight).toBe(31.488);
  });
});

describe("units", () => {
  it("only an admin adds or changes a unit; a name is unique and has no digits", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    expect((await call(staff, "POST", "/sku-units", { unit: "ຕຳລຶງ", gram_value: 37.5 })).status).toBe(403);
    expect((await call(admin, "POST", "/sku-units", { unit: "ຕຳລຶງ", gram_value: 37.5 })).status).toBe(200);
    expect((await call(admin, "POST", "/sku-units", { unit: "ຕຳລຶງ", gram_value: 1 })).json.code).toBe("UNIT_EXISTS");
    expect((await call(admin, "POST", "/sku-units", { unit: "2ບາດ", gram_value: 1 })).json.code).toBe("BAD_UNIT");
    expect((await call(admin, "POST", "/sku-units", { unit: "ກ້ອນ", gram_value: 0 })).json.code).toBe("BAD_UNIT");
    const units = (await call(staff, "GET", "/sku-units")).json.units;
    expect(units.some((u: any) => u.unit === "ຕຳລຶງ" && u.gram_value === 37.5)).toBe(true);
  });

  it("new grams recalculate every size made with the unit and its SKUs", async () => {
    const admin = await asAdmin();
    const sku = (await call(admin, "POST", "/skus", { name: "ສາຍຄໍ", type_id: "NECKLACES", size: [{ unit: "ບາດ", qty: 4 }, { unit: "ສະຫຼຶງ", qty: 2 }], branchId: "B-MM" })).json;
    const res = await call(admin, "PATCH", `/sku-units/${encodeURIComponent("ບາດ")}`, { gram_value: 15 });
    expect(res.status).toBe(200);
    // 1 ບາດ, 2 ບາດ and 4 ບາດ 2 ສະຫຼຶງ.
    expect(res.json.resized).toBe(3);
    const weights = (await call(admin, "GET", "/sku-weights")).json.weights;
    expect(weights.find((w: any) => w.weight_id === sku.weight_id).gram_value).toBe(67.622);
    expect(weights.find((w: any) => w.weight_id === "BAHT_2").gram_value).toBe(30);
    const after = (await call(admin, "GET", "/skus?all=1")).json.skus.find((s: any) => s.sku_id === sku.sku_id);
    expect(after.std_gram_weight).toBe(67.622);
  });
});
