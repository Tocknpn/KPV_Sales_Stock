// Reopening a Done day reopens every later day of the case (to `opening`),
// keeps typed numbers, clears done stamps and counts; staff redo the days in
// date order and each close carries into the next day's opening.
//   MM-D02  done on 11-09, 11-10, 11-11; today (11-12) not started
import { beforeEach, describe, expect, it } from "vitest";
import { TODAY, YESTERDAY, TOMORROW, freshApp, call, asStaff, asManager, asAdmin, on, checkIn, closeDay } from "./helpers";
import { getStore } from "../src/store";

beforeEach(freshApp);

const DESK = "MM-D02";
const D3 = "2026-11-09";
const D2 = "2026-11-10";
const D1 = YESTERDAY;
const SKU = "BR-020";
const detailOf = async (s: any, date: string) => (await call(s, "GET", `/stock/desk/${DESK}?date=${date}`)).json;
const rowOf = (detail: any, sku: string) => detail.rows.find((r: any) => r.sku_id === sku);
const ledgerRow = (date: string, sku = SKU) =>
  (getStore({ DEMO_DATE: TODAY } as any) as any).db.ledger.find((r: any) => r.desk_id === DESK && r.ledger_date === date && r.sku_id === sku);
const retail = (s: any, date: string, to: number) =>
  call(s, "POST", `/stock/desk/${DESK}/entries`, { date, changes: [{ sku_id: SKU, field: "retail_sale", to }] });
const reopen = (s: any, date: string, reason = "wrong count") => call(s, "POST", `/stock/desk/${DESK}/reopen`, { date, reason });

// Today is checked in with a sale typed, as when a mistake in D-3 is found.
async function startToday() {
  const staff = await asStaff("B-MM");
  expect((await checkIn(staff, DESK, TODAY)).status).toBe(200);
  expect((await retail(staff, TODAY, 1)).status).toBe(200);
  return staff;
}

describe("reopen cascade", () => {
  it("manager reopen of D-3 puts D-3..today back to opening and keeps typed numbers", async () => {
    const staff = await startToday();
    const manager = await asManager("B-MM");
    const soldD2 = rowOf(await detailOf(staff, D2), SKU).retail_sale;
    const res = await reopen(manager, D3);
    expect(res.status).toBe(200);
    for (const date of [D3, D2, D1, TODAY]) {
      const d = await detailOf(staff, date);
      expect(d.status).toBe("opening");
    }
    expect(rowOf(await detailOf(staff, D2), SKU).retail_sale).toBe(soldD2);
    expect(rowOf(await detailOf(staff, TODAY), SKU).retail_sale).toBe(1);
    const days = (getStore({ DEMO_DATE: TODAY } as any) as any).db.deskDays.filter((d: any) => d.desk_id === DESK);
    expect(days.every((d: any) => d.done_by === null && d.done_at === null)).toBe(true);
  });

  it("manager cannot reopen D-4; admin can", async () => {
    // Log in on TODAY first so the demo data is seeded for TODAY, then act a day later.
    const manager = on(await asManager("B-MM"), "2026-11-13");
    const old = await reopen(manager, D3);
    expect(old.status).toBe(403);
    expect(old.json.code).toBe("REOPEN_TOO_OLD");
    const admin = on(await asAdmin(), "2026-11-13");
    expect((await reopen(admin, D3)).status).toBe(200);
  });

  it("staff redo reopened days in date order", async () => {
    const staff = await startToday();
    await reopen(await asManager("B-MM"), D3);
    const blocked = await retail(staff, D2, 1);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("EARLIER_DAY_OPEN");
    expect(blocked.json.openDate).toBe(D3);
    for (const date of [D3, D2, D1]) {
      expect((await checkIn(staff, DESK, date)).status).toBe(200);
      expect((await closeDay(staff, DESK, date)).status).toBe(200);
      expect((await detailOf(staff, date)).status).toBe("done");
    }
    expect((await checkIn(staff, DESK, TODAY)).status).toBe(200);
    expect((await retail(staff, TODAY, 2)).status).toBe(200);
  });

  it("closing a corrected day carries the new closing into the next day's opening", async () => {
    const staff = await asStaff("B-MM");
    const before = rowOf(await detailOf(staff, D3), SKU);
    await reopen(await asManager("B-MM"), D3);
    await checkIn(staff, DESK, D3);
    expect((await retail(staff, D3, before.retail_sale + 1)).status).toBe(200);
    expect((await closeDay(staff, DESK, D3)).status).toBe(200);
    const after = rowOf(await detailOf(staff, D3), SKU);
    expect(after.closing_qty).toBe(before.closing_qty - 1);
    expect(rowOf(await detailOf(staff, D2), SKU).opening_qty).toBe(after.closing_qty);
  });

  it("reopen clears old counts so the corrected closing carries", async () => {
    const staff = await asStaff("B-MM");
    ledgerRow(D3).counted_qty = ledgerRow(D3).closing_qty + 5;
    ledgerRow(D3).counted_note = "found extra";
    await reopen(await asManager("B-MM"), D3);
    expect(ledgerRow(D3).counted_qty).toBeNull();
    expect(ledgerRow(D3).counted_note).toBeNull();
    await checkIn(staff, DESK, D3);
    const sold = rowOf(await detailOf(staff, D3), SKU).retail_sale;
    await retail(staff, D3, sold + 1);
    expect((await closeDay(staff, DESK, D3)).status).toBe(200);
    expect(rowOf(await detailOf(staff, D2), SKU).opening_qty).toBe(ledgerRow(D3).closing_qty);
  });

  it("closing a corrected day refuses when the next day would go negative", async () => {
    const staff = await asStaff("B-MM");
    // D-2 sold everything it had.
    const row = ledgerRow(D2);
    row.retail_sale += row.closing_qty;
    row.closing_qty = 0;
    row.counted_qty = null;
    await reopen(await asManager("B-MM"), D3);
    await checkIn(staff, DESK, D3);
    const sold = rowOf(await detailOf(staff, D3), SKU).retail_sale;
    await retail(staff, D3, sold + 1);
    const res = await closeDay(staff, DESK, D3);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NEXT_DAY_NEGATIVE");
    expect(res.json).toMatchObject({ sku_id: SKU, date: D2 });
    expect((await detailOf(staff, D3)).status).toBe("check_in");
  });

  it("reopen answers with the reopened dates", async () => {
    await startToday();
    const res = await reopen(await asManager("B-MM"), D3);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, dates: [D3, D2, D1, TODAY] });
  });

  // A count typed under the old app on a day still open at deploy time: the new
  // screen cannot show or clear it, so closing clears it and carries the
  // calculated closing.
  it("closing a day that holds an old count carries the calculated closing, not the count", async () => {
    const staff = await startToday();
    const row = ledgerRow(TODAY);
    row.counted_qty = row.closing_qty + 5;
    row.counted_note = "old app count";
    expect((await closeDay(staff, DESK, TODAY)).status).toBe(200);
    expect(ledgerRow(TODAY).counted_qty).toBeNull();
    expect(ledgerRow(TODAY).counted_note).toBeNull();
    const tomorrow = on(staff, TOMORROW);
    expect((await call(tomorrow, "POST", `/stock/desk/${DESK}/checkin`, { date: TOMORROW })).status).toBe(200);
    expect(rowOf(await detailOf(tomorrow, TOMORROW), SKU).opening_qty).toBe(ledgerRow(TODAY).closing_qty);
  });

  it("closing a reopened day that holds an old count updates the next day's opening with the calculated closing", async () => {
    const staff = await asStaff("B-MM");
    await reopen(await asManager("B-MM"), D3);
    await checkIn(staff, DESK, D3);
    // A stale count left on the open day (as from the old app).
    ledgerRow(D3).counted_qty = ledgerRow(D3).closing_qty + 4;
    const sold = rowOf(await detailOf(staff, D3), SKU).retail_sale;
    await retail(staff, D3, sold + 1);
    expect((await closeDay(staff, DESK, D3)).status).toBe(200);
    expect(ledgerRow(D3).counted_qty).toBeNull();
    expect(rowOf(await detailOf(staff, D2), SKU).opening_qty).toBe(ledgerRow(D3).closing_qty);
  });

  it("reopen is audited once with every reopened date", async () => {
    await reopen(await asManager("B-MM"), D3, "audit me");
    const log = (await call(await asAdmin(), "GET", "/audit")).json.entries.filter((e: any) => e.action === "desk_day.reopen");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ target: `${DESK}/${D3}`, detail: { reason: "audit me", dates: [D3, D2, D1] } });
  });

  it("a second reopen is refused and does not clear a count typed since (sequential: NOT_DONE; racing: STALE)", async () => {
    const manager = await asManager("B-MM");
    expect((await reopen(manager, D3)).status).toBe(200);
    ledgerRow(D2).counted_qty = 7;
    const again = await reopen(manager, D3);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("NOT_DONE");
    expect(ledgerRow(D2).counted_qty).toBe(7);
  });

  it("a reopen that loses the race after its check is STALE and clears nothing", async () => {
    const manager = await asManager("B-MM");
    const proto = Object.getPrototypeOf(getStore({ DEMO_DATE: TODAY } as any));
    const original = proto.reopenFrom;
    // Another request reopens between this one's NOT_DONE check and its write,
    // then someone types a count.
    proto.reopenFrom = async function (this: any, desk: string, date: string) {
      proto.reopenFrom = original;
      await original.call(this, desk, date);
      ledgerRow(D2).counted_qty = 7;
      return original.call(this, desk, date);
    };
    try {
      const res = await reopen(manager, D3);
      expect(res.status).toBe(409);
      expect(res.json.code).toBe("STALE");
      expect(ledgerRow(D2).counted_qty).toBe(7);
    } finally {
      proto.reopenFrom = original;
    }
  });
});
