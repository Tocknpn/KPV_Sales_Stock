// POST /stock/desk/:deskId/sku with `items`: several SKUs added to a case in
// one request, all-or-nothing on validation.
//   MM-D01  checked in today, has earlier days (GB-001, GB-002, NK-010, RG-030)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStore } from "../src/store";
import { TODAY, freshApp, call, asStaff } from "./helpers";

beforeEach(freshApp);

const detailOf = async (s: any, desk: string) => (await call(s, "GET", `/stock/desk/${desk}?date=${TODAY}`)).json;
const rowOf = (detail: any, sku: string) => detail.rows.find((r: any) => r.sku_id === sku);
const add = (s: any, desk: string, items: unknown) => call(s, "POST", `/stock/desk/${desk}/sku`, { date: TODAY, items });

async function newCase(staff: any) {
  const created = await call(staff, "POST", "/desks", { branchId: "B-MM", displayName: "Batch case", openingSkus: [{ sku_id: "GB-001", opening_qty: 1 }] });
  return created.json.desk.desk_id as string;
}

describe("add SKUs in a batch", () => {
  it("adds every item in one request", async () => {
    const staff = await asStaff("B-MM");
    const res = await add(staff, "MM-D01", [{ sku_id: "SP-904" }, { sku_id: "SP-903" }]);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, added: 2, restored: 0 });
    const detail = await detailOf(staff, "MM-D01");
    expect(rowOf(detail, "SP-904")).toBeDefined();
    expect(rowOf(detail, "SP-903")).toBeDefined();
  });

  it("refuses an opening above 0 after the first day, adding nothing", async () => {
    const staff = await asStaff("B-MM");
    const res = await add(staff, "MM-D01", [{ sku_id: "SP-904" }, { sku_id: "SP-903", opening_qty: 9 }]);
    expect(res.json.code).toBe("OPENING_LOCKED");
    const detail = await detailOf(staff, "MM-D01");
    expect(rowOf(detail, "SP-904")).toBeUndefined();
    expect(rowOf(detail, "SP-903")).toBeUndefined();
  });

  it("sets openings on the case's first day", async () => {
    const staff = await asStaff("B-MM");
    const deskId = await newCase(staff);
    const res = await add(staff, deskId, [{ sku_id: "SP-904", opening_qty: 4 }, { sku_id: "SP-903", opening_qty: 0 }]);
    expect(res.json).toMatchObject({ ok: true, added: 2 });
    const detail = await detailOf(staff, deskId);
    expect(rowOf(detail, "SP-904").opening_qty).toBe(4);
    expect(rowOf(detail, "SP-903").opening_qty).toBe(0);
  });

  it("an unknown SKU refuses the whole batch", async () => {
    const staff = await asStaff("B-MM");
    const res = await add(staff, "MM-D01", [{ sku_id: "SP-904" }, { sku_id: "NOPE" }]);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("BAD_SKU");
    expect(rowOf(await detailOf(staff, "MM-D01"), "SP-904")).toBeUndefined();
  });

  it("a duplicate SKU is added once, the last opening wins", async () => {
    const staff = await asStaff("B-MM");
    const deskId = await newCase(staff);
    const res = await add(staff, deskId, [{ sku_id: "SP-904", opening_qty: 2 }, { sku_id: "SP-904", opening_qty: 5 }]);
    expect(res.json).toMatchObject({ added: 1 });
    expect(rowOf(await detailOf(staff, deskId), "SP-904").opening_qty).toBe(5);
  });

  it("re-includes a SKU removed today and adds the new ones", async () => {
    const staff = await asStaff("B-MM");
    expect((await add(staff, "MM-D01", [{ sku_id: "SP-904" }])).status).toBe(200);
    expect((await call(staff, "DELETE", `/stock/desk/MM-D01/sku/SP-904?date=${TODAY}`)).status).toBe(200);
    const res = await add(staff, "MM-D01", [{ sku_id: "SP-904" }, { sku_id: "SP-903" }]);
    expect(res.json).toMatchObject({ ok: true, added: 1, restored: 1 });
    const detail = await detailOf(staff, "MM-D01");
    expect(rowOf(detail, "SP-904")).toBeDefined();
    expect(rowOf(detail, "SP-903")).toBeDefined();
  });

  it("a SKU re-added on the case's first day keeps the opening typed for it", async () => {
    const staff = await asStaff("B-MM");
    const deskId = await newCase(staff);
    expect((await add(staff, deskId, [{ sku_id: "SP-904" }])).status).toBe(200);
    expect((await call(staff, "DELETE", `/stock/desk/${deskId}/sku/SP-904?date=${TODAY}`)).status).toBe(200);
    const res = await add(staff, deskId, [{ sku_id: "SP-904", opening_qty: 3 }]);
    expect(res.json).toMatchObject({ restored: 1 });
    expect(rowOf(await detailOf(staff, deskId), "SP-904").opening_qty).toBe(3);
  });

  it("when inserting the new rows fails, no removed SKU is restored", async () => {
    const staff = await asStaff("B-MM");
    expect((await add(staff, "MM-D01", [{ sku_id: "SP-904" }])).status).toBe(200);
    expect((await call(staff, "DELETE", `/stock/desk/MM-D01/sku/SP-904?date=${TODAY}`)).status).toBe(200);
    const proto = Object.getPrototypeOf(getStore({} as any));
    const spy = vi.spyOn(proto, "insertLedgerRows").mockRejectedValueOnce(new Error("boom"));
    try {
      expect((await add(staff, "MM-D01", [{ sku_id: "SP-904" }, { sku_id: "SP-903" }])).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(rowOf(await detailOf(staff, "MM-D01"), "SP-904")).toBeUndefined();
  });

  it("refuses an empty batch and one over 200 items", async () => {
    const staff = await asStaff("B-MM");
    expect((await add(staff, "MM-D01", [])).json.code).toBe("BAD_SKU");
    const many = Array.from({ length: 201 }, () => ({ sku_id: "SP-904" }));
    expect((await add(staff, "MM-D01", many)).json.code).toBe("BAD_SKU");
  });

  it("flags rows added today (not carried) as added_today", async () => {
    const staff = await asStaff("B-MM");
    expect((await add(staff, "MM-D01", [{ sku_id: "SP-904" }])).status).toBe(200);
    const detail = await detailOf(staff, "MM-D01");
    expect(rowOf(detail, "SP-904").added_today).toBe(true);
    expect(rowOf(detail, "GB-001").added_today).toBe(false);
  });

  it("flags nothing on a case's first day", async () => {
    const staff = await asStaff("B-MM");
    const deskId = await newCase(staff);
    expect((await add(staff, deskId, [{ sku_id: "SP-904", opening_qty: 1 }])).status).toBe(200);
    expect((await detailOf(staff, deskId)).rows.every((r: any) => r.added_today === false)).toBe(true);
  });

  it("a SKU already on the case is neither added nor restored", async () => {
    const staff = await asStaff("B-MM");
    const res = await add(staff, "MM-D01", [{ sku_id: "GB-001" }]);
    expect(res.json).toMatchObject({ ok: true, added: 0, restored: 0 });
  });
});
