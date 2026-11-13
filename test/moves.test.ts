// Same-branch case-to-case moves: instant, all-or-nothing, idempotent, undoable.
// Demo data: MM-D01 is checked in today (GB-001, GB-002, NK-010, RG-030);
// MM-D02 finished yesterday and has not been checked in today.
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_STAFF } from "../src/demoData";
import { getStore } from "../src/store";
import { TODAY, YESTERDAY, freshApp, call, asAdmin, asStaff, closeDay } from "./helpers";

beforeEach(freshApp);

const detailOf = async (s: any, desk: string, date = TODAY) => (await call(s, "GET", `/stock/desk/${desk}?date=${date}`)).json;
const rowOf = (detail: any, sku: string) => detail.rows.find((r: any) => r.sku_id === sku);
let n = 0;
const ref = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const body = (over: Record<string, unknown> = {}) => ({
  date: TODAY,
  fromDeskId: "MM-D01",
  toDeskId: "MM-D02",
  lines: [{ skuId: "GB-001", qty: 1 }],
  clientRef: ref(),
  ...over,
});

describe("moves", () => {
  it("moving 1 piece updates both cases immediately (A.move, B.transfer_in, both closings)", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: TODAY });
    const a0 = rowOf(await detailOf(staff, "MM-D01"), "GB-001");
    const res = await call(staff, "POST", "/moves", body());
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.ticketId).toBeTruthy();
    expect(res.json.moves).toHaveLength(1);

    const a = rowOf(await detailOf(staff, "MM-D01"), "GB-001");
    const b = rowOf(await detailOf(staff, "MM-D02"), "GB-001");
    expect(a.move).toBe(a0.move + 1);
    expect(a.closing_qty).toBe(a0.closing_qty - 1);
    expect(b.transfer_in).toBe(1);
    expect(b.closing_qty).toBe(1);
    // nothing is in transit
    const admin = await asAdmin();
    expect((await call(admin, "GET", "/dashboard")).json.transit.count).toBe(0);
  });

  it("two simultaneous moves of the last pieces: one succeeds, one NOT_ENOUGH_STOCK", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: TODAY });
    const all = rowOf(await detailOf(staff, "MM-D01"), "GB-001").closing_qty;
    const lines = [{ skuId: "GB-001", qty: all }];
    const [x, y] = await Promise.all([call(staff, "POST", "/moves", body({ lines })), call(staff, "POST", "/moves", body({ lines }))]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.json).toMatchObject({ code: "NOT_ENOUGH_STOCK", available: 0 });
    expect(rowOf(await detailOf(staff, "MM-D01"), "GB-001").closing_qty).toBe(0);
    expect(rowOf(await detailOf(staff, "MM-D02"), "GB-001").transfer_in).toBe(all);
  });

  it("destination not checked in is checked in automatically with carried-forward openings", async () => {
    const staff = await asStaff("B-MM");
    const yesterday = await detailOf(staff, "MM-D02", YESTERDAY);
    expect(yesterday.status).toBe("done");
    expect((await call(staff, "POST", "/moves", body())).status).toBe(200);
    const today = await detailOf(staff, "MM-D02");
    expect(today.status).toBe("check_in");
    for (const r of yesterday.rows) expect(rowOf(today, r.sku_id).opening_qty).toBe(r.counted_qty ?? r.closing_qty);
    expect(rowOf(today, "GB-001")).toMatchObject({ opening_qty: 0, transfer_in: 1 });
  });

  it("destination with an unfinished earlier day → DEST_NOT_OPEN with openDate", async () => {
    // TS-D01 left yesterday unfinished; TS-D02 is a fresh case with some stock.
    const ts = await asStaff("B-TS");
    expect((await call(ts, "POST", "/stock/desk/TS-D02/checkin", { date: TODAY })).status).toBe(200);
    expect((await call(ts, "POST", "/stock/desk/TS-D02/sku", { date: TODAY, sku_id: "GB-001", opening_qty: 5 })).status).toBe(200);
    const res = await call(ts, "POST", "/moves", body({ fromDeskId: "TS-D02", toDeskId: "TS-D01" }));
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "DEST_NOT_OPEN", openDate: YESTERDAY });
    expect(rowOf(await detailOf(ts, "TS-D02"), "GB-001").move).toBe(0);
  });

  it("undo after the destination sold the pieces → NOT_ENOUGH_STOCK, nothing changes", async () => {
    const staff = await asStaff("B-MM");
    const moved = await call(staff, "POST", "/moves", body({ lines: [{ skuId: "GB-001", qty: 2 }] }));
    expect(moved.status).toBe(200);
    expect((await call(staff, "POST", "/stock/desk/MM-D02/entries", { date: TODAY, rows: [{ sku_id: "GB-001", retail_sale: 2 }] })).status).toBe(200);
    const a = await detailOf(staff, "MM-D01");
    const b = await detailOf(staff, "MM-D02");
    const res = await call(staff, "POST", `/moves/${moved.json.ticketId}/undo`, { clientRef: ref() });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "NOT_ENOUGH_STOCK", available: 0 });
    expect(await detailOf(staff, "MM-D01")).toEqual(a);
    expect(await detailOf(staff, "MM-D02")).toEqual(b);
  });

  it("undo puts the pieces back once, as a new ticket that points at the original", async () => {
    const staff = await asStaff("B-MM");
    const before = rowOf(await detailOf(staff, "MM-D01"), "GB-001");
    const moved = (await call(staff, "POST", "/moves", body({ lines: [{ skuId: "GB-001", qty: 2 }] }))).json;
    const undone = await call(staff, "POST", `/moves/${moved.ticketId}/undo`, { clientRef: ref() });
    expect(undone.status).toBe(200);
    expect(undone.json.ticketId).not.toBe(moved.ticketId);
    expect(undone.json.moves[0].reverses_id).toBe(moved.moves[0].id);
    expect(rowOf(await detailOf(staff, "MM-D01"), "GB-001").closing_qty).toBe(before.closing_qty);
    const again = await call(staff, "POST", `/moves/${moved.ticketId}/undo`, { clientRef: ref() });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("ALREADY_UNDONE");
    expect((await call(staff, "POST", `/moves/nope/undo`, { clientRef: ref() })).status).toBe(404);
  });

  it("a repeated clientRef returns the same ticket", async () => {
    const staff = await asStaff("B-MM");
    const b = body({ lines: [{ skuId: "GB-001", qty: 2 }] });
    const first = await call(staff, "POST", "/moves", b);
    const before = rowOf(await detailOf(staff, "MM-D01"), "GB-001");
    const second = await call(staff, "POST", "/moves", b);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ ok: true, ticketId: first.json.ticketId, replayed: true });
    expect(rowOf(await detailOf(staff, "MM-D01"), "GB-001")).toEqual(before);
  });

  it("staff cannot move to another branch's case via /moves (OTHER_BRANCH)", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "POST", "/moves", body({ toDeskId: "TS-D02" }));
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("OTHER_BRANCH");
  });

  it("validates input", async () => {
    const staff = await asStaff("B-MM");
    const code = async (over: Record<string, unknown>) => (await call(staff, "POST", "/moves", body(over))).json.code;
    expect(await code({ toDeskId: "MM-D01" })).toBe("SAME_DESK");
    expect(await code({ lines: [{ skuId: "GB-001", qty: 0 }] })).toBe("BAD_QTY");
    expect(await code({ lines: [{ skuId: "GB-001", qty: 1.5 }] })).toBe("BAD_QTY");
    expect(await code({ lines: [] })).toBe("BAD_QTY");
    expect(await code({ clientRef: "x" })).toBe("BAD_CLIENT_REF");
    expect(await code({ lines: [{ skuId: "GB-001", qty: 999 }] })).toBe("NOT_ENOUGH_STOCK");
    expect((await call(staff, "POST", "/moves", body({ fromDeskId: "TS-D01" }))).status).toBe(403);
  });

  it("a Done destination or source day refuses with 423", async () => {
    const staff = await asStaff("B-IT");
    const res = await call(staff, "POST", "/moves", body({ fromDeskId: "IT-D01", toDeskId: "IT-D02" }));
    expect(res.status).toBe(423);
    expect(res.json.code).toBe("DAY_LOCKED");
  });

  it("POST /transfers to a same-branch case → USE_MOVE", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "MM-D02", skuId: "GB-001", qty: 1 });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("USE_MOVE");
  });

  it("audit has one row per ledger change with the actor", async () => {
    const staff = await asStaff("B-MM");
    const admin = await asAdmin();
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: TODAY });
    const count = async () => (await call(admin, "GET", "/audit?limit=500")).json.entries.filter((e: any) => e.table_name).length;
    const before = await count();
    const moved = await call(staff, "POST", "/moves", body({ lines: [{ skuId: "GB-001", qty: 1 }, { skuId: "RG-030", qty: 2 }] }));
    expect(moved.status).toBe(200);
    const entries = (await call(admin, "GET", "/audit?limit=500")).json.entries.filter((e: any) => e.table_name).slice(0, (await count()) - before);
    const ledger = entries.filter((e: any) => e.table_name === "daily_stock_ledger");
    const transfers = entries.filter((e: any) => e.table_name === "transfers");
    // 2 lines: each has a source UPDATE and a destination INSERT; one transfers row per line
    expect(ledger).toHaveLength(4);
    expect(ledger.filter((e: any) => e.op === "UPDATE" && e.desk_id === "MM-D01")).toHaveLength(2);
    expect(ledger.filter((e: any) => e.op === "INSERT" && e.desk_id === "MM-D02")).toHaveLength(2);
    expect(transfers).toHaveLength(2);
    for (const e of entries) expect(e.actor_id).toBe(DEMO_STAFF["B-MM"]);
  });
});

describe("carry-forward racing a move", () => {
  it("a row created by a move before carry-forward inserts still gets its carried opening", async () => {
    const store = getStore({ DEMO_DATE: TODAY } as any, { system: "test" } as any);
    const yesterday = await store.ledger({ date: YESTERDAY, deskId: "MM-D02" });
    const nk = yesterday.find((r) => r.sku_id === "NK-011")!;
    const carried = nk.counted_qty ?? nk.closing_qty;
    expect(carried).toBeGreaterThan(0);
    const key = { ledger_date: TODAY, desk_id: "MM-D02", sku_id: "NK-011" };
    await store.insertDeskDay({ desk_id: "MM-D02", ledger_date: TODAY, branch_id: "B-MM", checked_in_by: DEMO_STAFF["B-MM"] });
    // the move got there first: opening 0, one piece moved in
    await store.insertLedgerRows([{ ...key, branch_id: "B-MM", opening_qty: 0, performed_by: DEMO_STAFF["B-MM"] }]);
    await store.ledgerAdd(key, "transfer_in", 1, DEMO_STAFF["B-MM"]);
    // plain inserts leave the row alone
    await store.insertLedgerRows([{ ...key, branch_id: "B-MM", opening_qty: carried, performed_by: DEMO_STAFF["B-MM"] }]);
    expect((await store.ledger({ date: TODAY, deskId: "MM-D02" })).find((r) => r.sku_id === "NK-011")!.opening_qty).toBe(0);
    // carry-forward overwrites the opening and keeps transfer_in
    await store.insertLedgerRows([{ ...key, branch_id: "B-MM", opening_qty: carried, performed_by: DEMO_STAFF["B-MM"] }], { overwriteOpening: true });
    const row = (await store.ledger({ date: TODAY, deskId: "MM-D02" })).find((r) => r.sku_id === "NK-011")!;
    expect(row).toMatchObject({ opening_qty: carried, transfer_in: 1, closing_qty: carried + 1 });
  });
});

describe("desk detail moves (History tab)", () => {
  it("lists a case's moves for the date with canUndo until reversed or Done", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: TODAY });
    const moved = await call(staff, "POST", "/moves", body({ lines: [{ skuId: "GB-001", qty: 1 }] }));
    const src = (await detailOf(staff, "MM-D01")).moves;
    const dst = (await detailOf(staff, "MM-D02")).moves;
    expect(src).toHaveLength(1);
    expect(dst).toHaveLength(1);
    expect(src[0]).toMatchObject({ ticketId: moved.json.ticketId, reversal: false, reversed: false, canUndo: true });
    expect(src[0].lines).toEqual([expect.objectContaining({ sku_id: "GB-001", qty: 1 })]);

    const undo = await call(staff, "POST", `/moves/${moved.json.ticketId}/undo`, { clientRef: ref() });
    expect(undo.status).toBe(200);
    const after = (await detailOf(staff, "MM-D01")).moves;
    expect(after).toHaveLength(2);
    expect(after.every((m: any) => m.canUndo === false)).toBe(true);
    expect(after.find((m: any) => m.ticketId === moved.json.ticketId).reversed).toBe(true);
    expect(after.filter((m: any) => m.reversal)).toHaveLength(1);
  });

  it("no Undo once either day is Done", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: TODAY });
    await call(staff, "POST", "/moves", body());
    await closeDay(staff, "MM-D02", TODAY);
    expect((await detailOf(staff, "MM-D01")).moves[0].canUndo).toBe(false);
  });
});
