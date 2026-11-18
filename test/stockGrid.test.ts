// Stock grid: stock-out mode (single / dynamic, stamped per case-day).
// Move in/out was dropped by the owner (the server refuses move_qty). Demo data: MM-D01 is checked in today (dynamic, GB-001
// among its SKUs); MM-D02 finished yesterday and is not checked in today.
import { beforeEach, describe, expect, it } from "vitest";
import { TODAY, freshApp, call, asAdmin, asStaff, asManager, checkIn } from "./helpers";

beforeEach(freshApp);

const detailOf = async (s: any, desk: string) => (await call(s, "GET", `/stock/desk/${desk}?date=${TODAY}`)).json;
const rowOf = (detail: any, sku: string) => detail.rows.find((r: any) => r.sku_id === sku);
const save = (s: any, desk: string, field: string, to: unknown, sku = "GB-001") =>
  call(s, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: sku, field, to }] });

describe("stock-out mode setting", () => {
  it("only an admin may change it, and only to dynamic or single", async () => {
    expect((await call(await asManager(), "POST", "/settings/config", { stockOutMode: "single" })).status).toBe(403);
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/settings/config", { stockOutMode: "both" })).json.code).toBe("BAD_CONFIG");
    const res = await call(admin, "POST", "/settings/config", { stockOutMode: "single" });
    expect(res.status).toBe(200);
    expect(res.json.stock_out_mode).toBe("single");
  });

  it("a day keeps the mode it was opened in; days opened later take the new one", async () => {
    const staff = await asStaff("B-MM");
    await call(await asAdmin(), "POST", "/settings/config", { stockOutMode: "single" });
    expect((await detailOf(staff, "MM-D01")).stock_out_mode).toBe("dynamic");
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: TODAY });
    expect((await detailOf(staff, "MM-D02")).stock_out_mode).toBe("single");
  });
});

describe("single stock-out day", () => {
  async function singleDay() {
    const staff = await asStaff("B-MM");
    await call(await asAdmin(), "POST", "/settings/config", { stockOutMode: "single" });
    await checkIn(staff, "MM-D02", TODAY);
    const row = rowOf(await detailOf(staff, "MM-D02"), "NK-011");
    return { staff, row };
  }

  it("takes one total that lowers closing and shows as stock_out", async () => {
    const { staff, row } = await singleDay();
    const res = await save(staff, "MM-D02", "stock_out_single", 2, "NK-011");
    expect(res.status).toBe(200);
    const after = rowOf(await detailOf(staff, "MM-D02"), "NK-011");
    expect(after.stock_out).toBe(2);
    expect(after.closing_qty).toBe(row.closing_qty - 2);
  });

  it("refuses retail / wholesale / destock", async () => {
    const { staff } = await singleDay();
    const res = await save(staff, "MM-D02", "retail_sale", 1, "NK-011");
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("WRONG_STOCK_OUT_MODE");
  });
});

describe("dynamic stock-out day", () => {
  it("refuses the single total; stock_out is the sum of the three parts", async () => {
    const staff = await asStaff("B-MM");
    expect((await save(staff, "MM-D01", "stock_out_single", 1)).json.code).toBe("WRONG_STOCK_OUT_MODE");
    await call(staff, "POST", "/stock/desk/MM-D01/entries", {
      date: TODAY,
      changes: [
        { sku_id: "GB-001", field: "retail_sale", to: 1 },
        { sku_id: "GB-001", field: "wholesale", to: 1 },
      ],
    });
    expect(rowOf(await detailOf(staff, "MM-D01"), "GB-001").stock_out).toBe(2);
  });
});
