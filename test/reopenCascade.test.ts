// Reopening a Done day reopens every later day of the case (to `opening`),
// keeps typed numbers, clears done stamps and counts; staff redo the days in
// date order and each close carries into the next day's opening.
//   MM-D02  done on 11-09, 11-10, 11-11; today (11-12) not started
import { beforeEach, describe, expect, it } from "vitest";
import { TODAY, YESTERDAY, freshApp, call, asStaff, asManager, asAdmin, on, checkIn, closeDay } from "./helpers";
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

  it("reopen is audited once with every reopened date", async () => {
    await reopen(await asManager("B-MM"), D3, "audit me");
    const log = (await call(await asAdmin(), "GET", "/audit")).json.entries.filter((e: any) => e.action === "desk_day.reopen");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ target: `${DESK}/${D3}`, detail: { reason: "audit me", dates: [D3, D2, D1] } });
  });
});
