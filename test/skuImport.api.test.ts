// SKU import/export per branch (decided 2026-11-17). The browser reads and
// writes the .xlsx; the Worker gets and returns plain rows.
// Demo: GB-001 = ທອງຄຳແທ່ງ 1 ບາດ (Gold Bars, 15.244 g), rule 2.5/day, 3 days in every branch.
import { beforeEach, describe, expect, it } from "vitest";
import { getStore } from "../src/store";
import { freshApp, call, asAdmin, asStaff, asManager } from "./helpers";

beforeEach(freshApp);

const imp = (s: any, rows: unknown[], over: Record<string, unknown> = {}) =>
  call(s, "POST", "/skus/import", { branchId: "B-MM", fileName: "skus.xlsx", rows, dryRun: false, ...over });
const store = () => getStore({} as any);
const ruleOf = async (sku: string, branch: string) =>
  (await store().rules()).find((r) => r.scope === "sku" && r.scope_key === sku && r.branch_id === branch);
const skuOf = async (id: string) => (await store().skus()).find((s) => s.sku_id === id);

const NEW_ROW = { sku_id: "", name: "ແຫວນໃໝ່", type: "ແຫວນ", grams: 3.811, avg_daily_sell: 1, lead_time_days: 4 };

describe("SKU import", () => {
  it("dry run previews and writes nothing", async () => {
    const admin = await asAdmin();
    const before = (await store().skus()).length;
    const res = await imp(admin, [NEW_ROW, { sku_id: "GB-001", name: "ທອງຄຳແທ່ງ 1 ບາດ", type: "ທອງຄຳແທ່ງ", grams: 15.244, avg_daily_sell: 2.5, lead_time_days: 3 }], { dryRun: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ created: 1, updated: 0, unchanged: 1, ignored: [], cleared: [], errors: [] });
    expect((await store().skus()).length).toBe(before);
  });

  it("commit creates and updates", async () => {
    const admin = await asAdmin();
    const res = await imp(admin, [NEW_ROW, { sku_id: "GB-001", name: "ຄຳແທ່ງ 1 ບາດ", type: "Gold Bars", grams: 15.244, avg_daily_sell: 6, lead_time_days: "" }]);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: 1, updated: 1, unchanged: 0 });
    const made = (await store().skus()).find((s) => s.name_lo === "ແຫວນໃໝ່")!;
    expect(made).toMatchObject({ type_id: "RINGS_ACCESSORIES", weight_id: "BAHT_025", baht_weight: 0.25 });
    expect(await ruleOf(made.sku_id, "B-MM")).toMatchObject({ avg_daily_sell: 1, lead_time_days: 4 });
    expect((await store().branchSkus()).filter((b) => b.sku_id === made.sku_id && b.carried).map((b) => b.branch_id)).toEqual(["B-MM"]);
    expect(await skuOf("GB-001")).toMatchObject({ name_lo: "ຄຳແທ່ງ 1 ບາດ" });
    // An empty cell leaves the value as it is (decided 2026-11-17).
    expect(await ruleOf("GB-001", "B-MM")).toMatchObject({ avg_daily_sell: 6, lead_time_days: 3 });
    expect(await ruleOf("GB-001", "B-VT")).toMatchObject({ avg_daily_sell: 2.5, lead_time_days: 3 });
  });

  it("an empty cell keeps the value", async () => {
    const res = await imp(await asAdmin(), [{ sku_id: "GB-001", avg_daily_sell: "", lead_time_days: null }]);
    expect(res.json).toMatchObject({ updated: 0, unchanged: 1, cleared: [] });
    expect(await ruleOf("GB-001", "B-MM")).toMatchObject({ avg_daily_sell: 2.5, lead_time_days: 3 });
  });

  it("a dash clears the value and is listed in cleared", async () => {
    const admin = await asAdmin();
    const dry = await imp(admin, [{ sku_id: "GB-001", avg_daily_sell: "-", lead_time_days: " – " }], { dryRun: true });
    expect(dry.json).toMatchObject({ updated: 1, cleared: [{ line: 2, field: "avg_daily_sell" }, { line: 2, field: "lead_time_days" }] });
    await imp(admin, [{ sku_id: "GB-001", avg_daily_sell: "-", lead_time_days: 5 }]);
    expect(await ruleOf("GB-001", "B-MM")).toMatchObject({ avg_daily_sell: null, lead_time_days: 5 });
    // clearing what is already empty is no change
    const again = await imp(admin, [{ sku_id: "GB-002", avg_daily_sell: "-" }], { dryRun: true });
    expect(again.json).toMatchObject({ unchanged: 1, cleared: [] });
  });

  it("a dash on a new row means no value", async () => {
    const res = await imp(await asAdmin(), [{ ...NEW_ROW, avg_daily_sell: "-", lead_time_days: "" }]);
    expect(res.json).toMatchObject({ created: 1, cleared: [] });
    const made = (await store().skus()).find((s) => s.name_lo === "ແຫວນໃໝ່")!;
    expect(await ruleOf(made.sku_id, "B-MM")).toBeUndefined();
  });

  it("one bad row imports nothing", async () => {
    const admin = await asAdmin();
    const before = (await store().skus()).length;
    const res = await imp(admin, [NEW_ROW, { ...NEW_ROW, name: "" }, { ...NEW_ROW, avg_daily_sell: -1 }]);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("IMPORT_INVALID");
    expect(res.json.errors.map((e: any) => e.line)).toEqual([3, 4]);
    expect((await store().skus()).length).toBe(before);
  });

  it("errors use the sheet line the browser sends", async () => {
    const res = await imp(await asAdmin(), [{ ...NEW_ROW, line: 2 }, { ...NEW_ROW, name: "", line: 7 }]);
    expect(res.json.errors).toEqual([{ line: 7, error: "name is required" }]);
  });

  it("unknown type is an error", async () => {
    const res = await imp(await asAdmin(), [{ ...NEW_ROW, type: "ບໍ່ມີ" }]);
    expect(res.status).toBe(422);
    expect(res.json.errors).toEqual([{ line: 2, error: "unknown type ບໍ່ມີ" }]);
  });

  it("unknown size and unknown code are errors", async () => {
    const res = await imp(await asAdmin(), [{ ...NEW_ROW, grams: 2 }, { ...NEW_ROW, sku_id: "NOPE-1" }]);
    expect(res.json.errors).toEqual([
      { line: 2, error: "no size of 2 g" },
      { line: 3, error: "unknown sku_id NOPE-1" },
    ]);
  });

  it("grams from float and text match the size", async () => {
    const res = await imp(await asAdmin(), [{ ...NEW_ROW, grams: 3.8109999 }, { ...NEW_ROW, name: "ແຫວນ 2", grams: " 15.244 " }], { dryRun: true });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(2);
  });

  it("Lao text with a non-breaking space and spaces still matches", async () => {
    const res = await imp(await asAdmin(), [{ ...NEW_ROW, type: " ແຫວນ  " }], { dryRun: true });
    expect(res.json.created).toBe(1);
  });

  it("duplicate code is an error", async () => {
    const row = { sku_id: "GB-001", name: "ທອງຄຳແທ່ງ 1 ບາດ", type: "ທອງຄຳແທ່ງ", grams: 15.244 };
    const res = await imp(await asAdmin(), [row, NEW_ROW, row]);
    expect(res.json.errors).toEqual([{ line: 4, error: "sku_id GB-001 is also on line 2" }]);
  });

  it("branch_id mismatch is an error", async () => {
    const res = await imp(await asAdmin(), [{ ...NEW_ROW, branch_id: "B-VT" }]);
    expect(res.json.errors).toEqual([{ line: 2, error: "branch_id B-VT is not B-MM" }]);
  });

  it("all branches: admin only, each row names its branch", async () => {
    const admin = await asAdmin();
    const res = await imp(admin, [
      { ...NEW_ROW, branch_id: "B-VT" },
      { sku_id: "GB-001", name: "", type: "", grams: "", avg_daily_sell: 8, branch_id: "B-TS" },
      { ...NEW_ROW, name: "x" },
    ], { branchId: "all" });
    expect(res.json.errors).toEqual([{ line: 4, error: "branch_id is required" }]);
    const ok = await imp(admin, [{ sku_id: "GB-001", name: "", type: "", grams: "", avg_daily_sell: 8, branch_id: "B-TS" }], { branchId: "all" });
    expect(ok.json).toMatchObject({ updated: 1 });
    expect(await ruleOf("GB-001", "B-TS")).toMatchObject({ avg_daily_sell: 8 });
    expect(await skuOf("GB-001")).toMatchObject({ name_lo: "ທອງຄຳແທ່ງ 1 ບາດ" });
  });

  it("all branches: one new SKU on several branch rows is created once", async () => {
    const admin = await asAdmin();
    const before = (await store().skus()).length;
    const res = await imp(admin, [
      { ...NEW_ROW, branch_id: "B-MM", avg_daily_sell: 1 },
      { ...NEW_ROW, name: " ແຫວນໃໝ່ ", branch_id: "B-VT", avg_daily_sell: 4 },
    ], { branchId: "all" });
    expect(res.status).toBe(200);
    expect(res.json.created).toBe(1);
    expect((await store().skus()).length).toBe(before + 1);
    const made = (await store().skus()).find((s) => s.name_lo === "ແຫວນໃໝ່")!;
    expect((await store().branchSkus()).filter((b) => b.sku_id === made.sku_id && b.carried).map((b) => b.branch_id).sort()).toEqual(["B-MM", "B-VT"]);
    expect(await ruleOf(made.sku_id, "B-MM")).toMatchObject({ avg_daily_sell: 1 });
    expect(await ruleOf(made.sku_id, "B-VT")).toMatchObject({ avg_daily_sell: 4 });
  });

  it("the same new SKU twice in one branch is an error", async () => {
    const res = await imp(await asAdmin(), [NEW_ROW, { ...NEW_ROW, avg_daily_sell: 9 }]);
    expect(res.json.errors).toEqual([{ line: 3, error: "the same new SKU is also on line 2" }]);
  });

  it("a new row that matches an existing SKU is an error", async () => {
    const res = await imp(await asAdmin(), [{ sku_id: "", name: "ທອງຄຳແທ່ງ 1 ບາດ", type: "ທອງຄຳແທ່ງ", grams: 15.244 }]);
    expect(res.json.errors).toEqual([{ line: 2, error: "this SKU already exists as GB-001 — put GB-001 in sku_id" }]);
  });

  it("staff import is forced to own branch", async () => {
    const staff = await asStaff("B-MM");
    const res = await imp(staff, [NEW_ROW], { branchId: "B-VT" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("BRANCH_DENIED");
    expect((await imp(staff, [NEW_ROW], { branchId: undefined })).json).toMatchObject({ created: 1 });
  });

  it("staff name change is ignored and listed", async () => {
    const staff = await asManager("B-MM");
    const res = await imp(staff, [{ sku_id: "GB-001", name: "ຊື່ໃໝ່", type: "ສາຍຄໍ", grams: 7.622, avg_daily_sell: 3, lead_time_days: 3 }]);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ updated: 1, ignored: [{ line: 2, field: "name" }, { line: 2, field: "type" }, { line: 2, field: "grams" }] });
    expect(await skuOf("GB-001")).toMatchObject({ name_lo: "ທອງຄຳແທ່ງ 1 ບາດ", type_id: "GOLD_BARS", weight_id: "BAHT_1" });
    expect(await ruleOf("GB-001", "B-MM")).toMatchObject({ avg_daily_sell: 3 });
  });

  it("staff cannot import all", async () => {
    expect((await imp(await asStaff("B-MM"), [NEW_ROW], { branchId: "all" })).status).toBe(403);
  });

  it("an empty or too large file is refused", async () => {
    const admin = await asAdmin();
    expect((await imp(admin, [])).json.code).toBe("EMPTY_IMPORT");
    expect((await imp(admin, Array.from({ length: 501 }, () => NEW_ROW))).json.code).toBe("IMPORT_TOO_LARGE");
  });

  it("audit has one row per SKU plus a summary", async () => {
    const admin = await asAdmin();
    await imp(admin, [NEW_ROW, { sku_id: "GB-001", name: "ທອງຄຳແທ່ງ 1 ບາດ", type: "ທອງຄຳແທ່ງ", grams: 15.244, avg_daily_sell: 7, lead_time_days: 3 }, { sku_id: "GB-002" }]);
    const log = await store().auditLog({ limit: 50 });
    const rows = log.filter((e) => e.action === "sku.import_row");
    expect(rows).toHaveLength(2);
    const gb = rows.find((e) => e.target === "GB-001")!;
    expect(gb.detail).toMatchObject({ branch_id: "B-MM", before: { avg_daily_sell: 2.5 }, after: { avg_daily_sell: 7 } });
    const summary = log.find((e) => e.action === "sku.import")!;
    expect(summary.detail).toMatchObject({ fileName: "skus.xlsx", branchId: "B-MM", created: 1, updated: 1, unchanged: 1 });
  });
});

describe("SKU export", () => {
  it("export only carried SKUs", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "PUT", "/skus/SP-904/carried", { carried: false });
    const res = await call(staff, "GET", "/skus/export?branchId=B-VT");
    expect(res.status).toBe(200);
    const ids = res.json.rows.map((r: any) => r.sku_id);
    expect(ids).not.toContain("SP-904");
    expect(res.json.rows.find((r: any) => r.sku_id === "GB-001")).toEqual({
      sku_id: "GB-001", name: "ທອງຄຳແທ່ງ 1 ບາດ", type: "ທອງຄຳແທ່ງ", grams: 15.244, avg_daily_sell: 2.5, lead_time_days: 3, branch_id: null,
    });
  });

  it("all branches is admin only, one row per carried branch and SKU", async () => {
    expect((await call(await asStaff("B-MM"), "GET", "/skus/export?branchId=all")).status).toBe(403);
    const admin = await asAdmin();
    expect((await call(admin, "GET", "/skus/export")).json.code).toBe("BRANCH_REQUIRED");
    const all = (await call(admin, "GET", "/skus/export?branchId=all")).json.rows;
    const one = (await call(admin, "GET", "/skus/export?branchId=B-MM")).json.rows;
    expect(all.length).toBe(one.length * 4);
    expect(new Set(all.map((r: any) => r.branch_id))).toEqual(new Set(["B-MM", "B-TS", "B-IT", "B-VT"]));
  });

  it("an export imports back unchanged", async () => {
    const staff = await asStaff("B-MM");
    const rows = (await call(staff, "GET", "/skus/export")).json.rows;
    const res = await imp(staff, rows, { branchId: undefined, dryRun: true });
    expect(res.json).toMatchObject({ created: 0, updated: 0, unchanged: rows.length, ignored: [], cleared: [], errors: [] });
  });
});
