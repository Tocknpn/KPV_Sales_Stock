// The opening step: check-in opens a day in `opening` (review yesterday's
// closing, add SKUs with an opening, first stock-in), confirm moves it to
// `check_in` (selling), and close needs no count.
//   MM-D02  done on the three days before today, not started today
//           (NK-011, BR-020, RG-031)
import { beforeEach, describe, expect, it } from "vitest";
import { TODAY, YESTERDAY, freshApp, call, asStaff, asManager } from "./helpers";
import { getStore } from "../src/store";

beforeEach(freshApp);

const DESK = "MM-D02";
const detailOf = async (s: any, date = TODAY) => (await call(s, "GET", `/stock/desk/${DESK}?date=${date}`)).json;
const rowOf = (detail: any, sku: string) => detail.rows.find((r: any) => r.sku_id === sku);
const checkin = (s: any) => call(s, "POST", `/stock/desk/${DESK}/checkin`, { date: TODAY });
const confirm = (s: any) => call(s, "POST", `/stock/desk/${DESK}/transition`, { date: TODAY, toStatus: "check_in" });
const change = (s: any, sku_id: string, field: string, to: unknown) =>
  call(s, "POST", `/stock/desk/${DESK}/entries`, { date: TODAY, changes: [{ sku_id, field, to }] });
const addSku = (s: any, item: Record<string, unknown>) => call(s, "POST", `/stock/desk/${DESK}/sku`, { date: TODAY, items: [item] });

describe("check-in opening step", () => {
  it("check-in opens the day in the opening step with yesterday's closing as opening", async () => {
    const staff = await asStaff("B-MM");
    const yesterday = await detailOf(staff, YESTERDAY);
    expect((await checkin(staff)).status).toBe(200);
    const detail = await detailOf(staff);
    expect(detail.status).toBe("opening");
    for (const y of yesterday.rows) {
      const row = rowOf(detail, y.sku_id);
      expect(row.opening_qty).toBe(y.closing_qty);
      expect(row.opening_editable).toBe(false);
    }
  });

  it("opening step: stock_in saves, retail is refused", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    const ok = await change(staff, "NK-011", "stock_in", 3);
    expect(ok.status).toBe(200);
    expect(ok.json.rows[0].stock_in).toBe(3);
    const refused = await change(staff, "NK-011", "retail_sale", 1);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("FIELD_NOT_IN_STEP");
    expect(refused.json).toMatchObject({ sku_id: "NK-011", field: "retail_sale", status: "opening" });
  });

  it("opening step: a newly added SKU takes an opening and it can be edited", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    expect((await addSku(staff, { sku_id: "SP-904", opening_qty: 4 })).status).toBe(200);
    let row = rowOf(await detailOf(staff), "SP-904");
    expect(row.opening_qty).toBe(4);
    expect(row.opening_editable).toBe(true);
    const res = await change(staff, "SP-904", "opening_qty", 6);
    expect(res.status).toBe(200);
    row = rowOf(await detailOf(staff), "SP-904");
    expect(row.opening_qty).toBe(6);
  });

  it("opening step: a carried row's opening cannot be edited", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    const res = await change(staff, "NK-011", "opening_qty", 99);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("OPENING_LOCKED");
  });

  it("confirm moves opening -> check_in; then retail and withdraw save", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    await change(staff, "NK-011", "stock_in", 2);
    expect((await confirm(staff)).status).toBe(200);
    expect((await detailOf(staff)).status).toBe("check_in");
    expect((await change(staff, "NK-011", "retail_sale", 1)).status).toBe(200);
    expect((await change(staff, "NK-011", "withdraw", 1)).status).toBe(200);
    const row = rowOf(await detailOf(staff), "NK-011");
    expect(row.retail_sale).toBe(1);
    expect(row.withdraw).toBe(1);
    expect(row.opening_editable).toBe(false);
  });

  it("confirm is refused from any status but opening", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    await confirm(staff);
    const again = await confirm(staff);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("BAD_TRANSITION");
  });

  it("opening edit after confirm is refused", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    await addSku(staff, { sku_id: "SP-904", opening_qty: 4 });
    await confirm(staff);
    const res = await change(staff, "SP-904", "opening_qty", 6);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("FIELD_NOT_IN_STEP");
    expect(res.json).toMatchObject({ field: "opening_qty", status: "check_in" });
  });

  it("two devices: adding a SKU with stock_in that the other device already added is refused, nothing written", async () => {
    const a = await asStaff("B-MM");
    const b = await asStaff("B-MM");
    await checkin(a);
    await confirm(a);
    expect((await addSku(a, { sku_id: "SP-904" })).status).toBe(200);
    // B still shows the old screen; its batch also holds a fresh SKU.
    const res = await call(b, "POST", `/stock/desk/${DESK}/sku`, { date: TODAY, items: [{ sku_id: "SP-903", stock_in: 2 }, { sku_id: "SP-904", stock_in: 3 }] });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "SKU_ALREADY_ON_DAY", sku_id: "SP-904" });
    const detail = await detailOf(a);
    expect(rowOf(detail, "SP-904").stock_in).toBe(0);
    expect(rowOf(detail, "SP-903")).toBeUndefined();
    // Without stock_in an existing SKU is still a harmless no-op.
    expect((await addSku(b, { sku_id: "SP-904" })).json).toMatchObject({ ok: true, added: 0, restored: 0 });
  });

  it("a retry after the row was inserted but its stock_in not written is refused, not silently dropped", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    await confirm(staff);
    // First attempt: the insert landed, the stock-in write did not (row has 0).
    expect((await addSku(staff, { sku_id: "SP-904" })).status).toBe(200);
    const retry = await addSku(staff, { sku_id: "SP-904", stock_in: 3 });
    expect(retry.status).toBe(409);
    expect(retry.json).toMatchObject({ code: "SKU_ALREADY_ON_DAY", sku_id: "SP-904" });
    // The client reloads and types it into the row's Stock In cell.
    expect((await change(staff, "SP-904", "stock_in", 3)).status).toBe(200);
    expect(rowOf(await detailOf(staff), "SP-904").stock_in).toBe(3);
  });

  it("adding a SKU after check-in: opening refused, stock_in accepted", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    await confirm(staff);
    const refused = await addSku(staff, { sku_id: "SP-904", opening_qty: 3 });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("OPENING_LOCKED");
    expect(rowOf(await detailOf(staff), "SP-904")).toBeUndefined();
    expect((await addSku(staff, { sku_id: "SP-904", stock_in: 3 })).status).toBe(200);
    const row = rowOf(await detailOf(staff), "SP-904");
    expect(row.stock_in).toBe(3);
    expect(row.opening_qty).toBe(0);
    expect(row.closing_qty).toBe(3);
  });

  it("move_qty, counted_qty, destock_note are refused", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    await confirm(staff);
    for (const [field, to] of [["move_qty", 1], ["counted_qty", 1], ["destock_note", "x"]] as const) {
      const res = await change(staff, "NK-011", field, to);
      expect(res.status, field).toBe(400);
      expect(res.json.code, field).toBe("BAD_FIELD");
    }
  });

  it("cannot close from the opening step", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    const res = await call(staff, "POST", `/stock/desk/${DESK}/close`, { date: TODAY });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("BAD_TRANSITION");
  });

  it("close needs no count", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    await confirm(staff);
    await change(staff, "NK-011", "retail_sale", 1);
    const res = await call(staff, "POST", `/stock/desk/${DESK}/close`, { date: TODAY });
    expect(res.status).toBe(200);
    expect((await detailOf(staff)).status).toBe("done");
  });

  it("a new case starts in the opening step", async () => {
    const staff = await asStaff("B-MM");
    const created = await call(staff, "POST", "/desks", { branchId: "B-MM", displayName: "New case", openingSkus: [{ sku_id: "GB-001", opening_qty: 2 }] });
    expect(created.status).toBe(200);
    const detail = (await call(staff, "GET", `/stock/desk/${created.json.desk.desk_id}?date=${TODAY}`)).json;
    expect(detail.status).toBe("opening");
    // The first day has no previous day: every row's opening is editable.
    expect(rowOf(detail, "GB-001").opening_editable).toBe(true);
  });

  describe("restoring a removed SKU the day carried", () => {
    const ledgerRow = (date: string, sku: string) =>
      (getStore({ DEMO_DATE: TODAY } as any) as any).db.ledger.find((r: any) => r.desk_id === DESK && r.ledger_date === date && r.sku_id === sku);
    const remove = (s: any, sku: string) => call(s, "DELETE", `/stock/desk/${DESK}/sku/${sku}?date=${TODAY}`);

    // RG-031 ended yesterday at 0, so today carries it with opening 0 and it can be removed.
    async function carriedEmpty() {
      const staff = await asStaff("B-MM");
      const y = ledgerRow(YESTERDAY, "RG-031");
      y.retail_sale += y.closing_qty;
      y.closing_qty = 0;
      y.counted_qty = null;
      await checkin(staff);
      expect(rowOf(await detailOf(staff), "RG-031").opening_qty).toBe(0);
      expect((await remove(staff, "RG-031")).status).toBe(200);
      return staff;
    }

    it("the detail lists the carried SKUs in the opening step, removed ones included", async () => {
      const staff = await carriedEmpty();
      const detail = await detailOf(staff);
      expect(rowOf(detail, "RG-031")).toBeUndefined();
      expect(detail.carriedSkus).toEqual(expect.arrayContaining(["NK-011", "BR-020", "RG-031"]));
    });

    it("it is restored with opening 0 (no opening asked); a typed opening is refused", async () => {
      const staff = await carriedEmpty();
      const refused = await addSku(staff, { sku_id: "RG-031", opening_qty: 3 });
      expect(refused.status).toBe(409);
      expect(refused.json.code).toBe("OPENING_LOCKED");
      const ok = await addSku(staff, { sku_id: "RG-031", opening_qty: 0 });
      expect(ok.json).toMatchObject({ ok: true, restored: 1 });
      const row = rowOf(await detailOf(staff), "RG-031");
      expect(row.opening_qty).toBe(0);
      expect(row.opening_editable).toBe(false);
    });

    it("a restored carried row keeps the opening carried onto it", async () => {
      const staff = await carriedEmpty();
      // A later carry (an earlier day reopened and closed again) set its opening while removed.
      ledgerRow(TODAY, "RG-031").opening_qty = 2;
      ledgerRow(TODAY, "RG-031").closing_qty = 2;
      expect((await addSku(staff, { sku_id: "RG-031" })).status).toBe(200);
      expect(rowOf(await detailOf(staff), "RG-031").opening_qty).toBe(2);
    });
  });

  it("a day cannot be written while an earlier day is not Done", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    const manager = await asManager("B-MM");
    const reopened = await call(manager, "POST", `/stock/desk/${DESK}/reopen`, { date: YESTERDAY, reason: "fix a typo" });
    expect(reopened.status).toBe(200);
    const res = await change(staff, "NK-011", "stock_in", 1);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("EARLIER_DAY_OPEN");
    expect(res.json.openDate).toBe(YESTERDAY);
    const conf = await confirm(staff);
    expect(conf.json.code).toBe("EARLIER_DAY_OPEN");
  });
});

describe("check-in returns the day detail", () => {
  it("the response carries the same detail as GET, plus ok", async () => {
    const staff = await asStaff("B-MM");
    const res = await checkin(staff);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.alreadyCheckedIn).toBeUndefined();
    expect(res.json.detail).toEqual(await detailOf(staff));
    expect(res.json.detail.status).toBe("opening");
  });

  it("a second check-in says alreadyCheckedIn and still carries the detail", async () => {
    const staff = await asStaff("B-MM");
    await checkin(staff);
    const res = await checkin(staff);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, alreadyCheckedIn: true });
    expect(res.json.detail).toEqual(await detailOf(staff));
  });
});
