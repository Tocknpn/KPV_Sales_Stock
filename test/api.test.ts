// End-to-end rules through the real routes, on the demo dataset:
//   MM-D01  checked in today (GB-001, GB-002, NK-010, RG-030)
//   MM-D02  Done yesterday, not started today
//   TS-D01  yesterday left at check_in (unfinished)
//   IT-D01  Done today
//   VT-D01  in final count today
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_STAFF } from "../src/demoData";
import { getStore } from "../src/store";
import { TODAY, YESTERDAY, TOMORROW, freshApp, call, login, creds, asAdmin, asStaff, asManager, on, closeDay, countEverything } from "./helpers";

beforeEach(freshApp);

const detailOf = async (s: any, desk: string, date: string) => (await call(s, "GET", `/stock/desk/${desk}?date=${date}`)).json;
const rowOf = (detail: any, sku: string) => detail.rows.find((r: any) => r.sku_id === sku);

describe("login", () => {
  it("locks the account after 5 wrong passwords, even for the right one", async () => {
    const id = DEMO_STAFF["B-MM"];
    for (let i = 1; i <= 4; i++) {
      const res = await call(null, "POST", "/auth/login", creds(id, "0000"));
      expect(res.status).toBe(401);
      expect(res.json.attemptsLeft).toBe(5 - i);
    }
    expect((await call(null, "POST", "/auth/login", creds(id, "0000"))).status).toBe(423);
    const locked = await call(null, "POST", "/auth/login", creds(id, "1234"));
    expect(locked.status).toBe(423);
    expect(locked.json.code).toBe("ACCOUNT_LOCKED");
  });

  it("a correct password resets the wrong-password counter", async () => {
    const id = DEMO_STAFF["B-MM"];
    await call(null, "POST", "/auth/login", creds(id, "0000"));
    await login(id, "1234");
    const res = await call(null, "POST", "/auth/login", creds(id, "0000"));
    expect(res.json.attemptsLeft).toBe(4);
  });

  it("an unknown username gets the same answer as a wrong password", async () => {
    const res = await call(null, "POST", "/auth/login", { username: "nobody", password: "whatever" });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("WRONG_LOGIN");
    expect((await call(null, "POST", "/auth/login", {})).json.code).toBe("WRONG_LOGIN");
  });

  it("an admin can change a username; the old one stops working", async () => {
    const admin = await asAdmin();
    const id = DEMO_STAFF["B-MM"];
    expect((await call(admin, "PATCH", `/users/${id}`, { username: "bounmy" })).json.code).toBe("USERNAME_TAKEN");
    expect((await call(admin, "PATCH", `/users/${id}`, { username: "somchai.s" })).status).toBe(200);
    expect((await call(null, "POST", "/auth/login", { username: "somchai", password: "1234" })).status).toBe(401);
    expect((await call(null, "POST", "/auth/login", { username: "somchai.s", password: "1234" })).status).toBe(200);
  });

  it("rejects requests without a session", async () => {
    expect((await call(null, "GET", "/auth/accounts?branchId=B-MM")).status).toBe(401);
    expect((await call(null, "GET", "/stock/desks")).status).toBe(401);
    expect((await call(null, "GET", "/branches")).status).toBe(200);
  });
});

describe("user level", () => {
  it("staff are confined to their own branch", async () => {
    const staff = await asStaff("B-MM");
    const cards = (await call(staff, "GET", "/stock/desks?branchId=B-TS")).json.desks;
    expect(new Set(cards.map((d: any) => d.branch_id))).toEqual(new Set(["B-MM"]));
    expect((await call(staff, "GET", `/stock/desk/TS-D01?date=${TODAY}`)).status).toBe(403);
    expect((await call(staff, "POST", "/stock/desk/TS-D01/checkin", { date: TODAY })).status).toBe(403);
    expect((await call(staff, "GET", "/dashboard?deskId=TS-D01")).status).toBe(403);
    expect((await call(staff, "GET", "/report?deskId=TS-D01")).status).toBe(403);
    // A Talat Sao document cannot be printed by Morning Market staff.
    expect((await call(staff, "GET", "/documents/a0000000-0000-0000-0000-000000000002/print")).status).toBe(403);
    expect((await call(staff, "GET", "/documents/a0000000-0000-0000-0000-000000000001/print")).status).toBe(200);
  });

  it("only admin changes master data, users, config and locked days", async () => {
    const staff = await asStaff("B-MM");
    const denied = [
      ["POST", "/skus", { name_en: "X", type_id: "GOLD_BARS", weight_id: "BAHT_1" }],
      ["PATCH", "/skus/GB-001", { active: false }],
      ["POST", "/skus/import", { rows: [] }],
      ["POST", "/sku-types", { name_en: "X" }],
      ["POST", "/settings/config", { spotLakPerBaht: 1 }],
      ["POST", "/users", { displayName: "X", username: "xxx", branchId: "B-MM", password: "111111" }],
      ["PATCH", `/users/${DEMO_STAFF["B-MM"]}`, { password: "111111" }],
      ["DELETE", "/documents/a0000000-0000-0000-0000-000000000001", undefined],
      ["POST", "/documents/a0000000-0000-0000-0000-000000000003/decision", { decision: "approved" }],
      ["POST", "/stock/desk/IT-D01/reopen", { date: TODAY, reason: "test" }],
      ["GET", "/audit", undefined],
    ] as const;
    for (const [method, path, body] of denied) {
      expect((await call(staff, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
  });

  it("resetting a password ends that user's sessions; deactivating blocks login", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const id = DEMO_STAFF["B-MM"];
    expect((await call(admin, "PATCH", `/users/${id}`, { password: "new-pass" })).status).toBe(200);
    expect((await call(staff, "GET", "/auth/me")).status).toBe(401);
    expect((await call(null, "POST", "/auth/login", creds(id, "1234"))).status).toBe(401);
    const again = await login(id, "new-pass");
    expect((await call(admin, "PATCH", `/users/${id}`, { active: false })).status).toBe(200);
    expect((await call(again, "GET", "/auth/me")).status).toBe(401);
    const closed = await call(null, "POST", "/auth/login", creds(id, "new-pass"));
    expect(closed.status).toBe(401);
    expect(closed.json.code).toBe("WRONG_LOGIN");
  });

  it("admin can add a user who can then log in; the last admin cannot be deactivated", async () => {
    const admin = await asAdmin();
    const user = { displayName: "Noy V.", username: "Noy.V", branchId: "B-VT", password: "secret-1" };
    expect((await call(admin, "POST", "/users", { ...user, password: "12345" })).json.code).toBe("BAD_PASSWORD");
    expect((await call(admin, "POST", "/users", { ...user, username: "no spaces" })).json.code).toBe("BAD_USERNAME");
    expect((await call(admin, "POST", "/users", { ...user, username: "somchai" })).json.code).toBe("USERNAME_TAKEN");
    const created = await call(admin, "POST", "/users", user);
    expect(created.status).toBe(200);
    // stored lower-case; login ignores case and surrounding spaces
    const res = await call(null, "POST", "/auth/login", { username: "  NOY.v ", password: "secret-1" });
    expect(res.status).toBe(200);
    const noy = { token: res.json.token, date: TODAY };
    expect((await call(noy, "GET", "/app-meta")).json.branches.map((b: any) => b.branch_id)).toEqual(["B-VT"]);
    const me = (await call(admin, "GET", "/auth/me")).json.user.accountId;
    expect((await call(admin, "PATCH", `/users/${me}`, { active: false })).status).toBe(409);
  });
});

describe("daily cycle", () => {
  it("check-in is blocked until the unfinished earlier day is Done", async () => {
    const staff = await asStaff("B-TS");
    const blocked = await call(staff, "POST", "/stock/desk/TS-D01/checkin", { date: TODAY });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("EARLIER_DAY_OPEN");
    expect(blocked.json.openDate).toBe(YESTERDAY);
    const card = (await call(staff, "GET", "/stock/desks")).json.desks.find((d: any) => d.desk_id === "TS-D01");
    expect(card.openEarlierDate).toBe(YESTERDAY);

    // Staff may finish the unfinished day themselves, then check in.
    expect((await closeDay(staff, "TS-D01", YESTERDAY)).status).toBe(200);
    expect((await call(staff, "POST", "/stock/desk/TS-D01/checkin", { date: TODAY })).status).toBe(200);
    expect((await detailOf(staff, "TS-D01", TODAY)).status).toBe("check_in");
  });

  it("Done is refused until every row is counted and explained", async () => {
    const staff = await asStaff("B-MM");
    const desk = "MM-D01";
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "GB-001", field: "destock", to: 1 }] });
    // Counts can be entered at any time, including at check-in.
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "GB-001", field: "counted_qty", to: 1 }] });
    expect(rowOf(await detailOf(staff, desk, TODAY), "GB-001").counted_qty).toBe(1);
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "GB-001", field: "counted_qty", to: null }] });
    expect((await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "done" })).status).toBe(409);
    expect((await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "final_stock" })).status).toBe(200);

    let res = await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "done" });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("DAY_INCOMPLETE");
    expect(res.json.failures).toContainEqual({ sku_id: "GB-001", rule: "destock_note_missing" });
    expect(res.json.failures.filter((f: any) => f.rule === "count_missing")).toHaveLength(4);

    await countEverything(staff, desk, TODAY);
    const gb = rowOf(await detailOf(staff, desk, TODAY), "GB-001");
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "GB-001", field: "counted_qty", to: gb.closing_qty - 1 }] });
    res = await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "done" });
    expect(res.json.failures).toEqual([
      { sku_id: "GB-001", rule: "destock_note_missing" },
      { sku_id: "GB-001", rule: "variance_note_missing" },
    ]);

    await call(staff, "POST", `/stock/desk/${desk}/entries`, {
      date: TODAY,
      changes: [
        { sku_id: "GB-001", field: "destock_note", to: "damaged" },
        { sku_id: "GB-001", field: "counted_note", to: "one missing, reported" },
      ],
    });
    expect((await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "done" })).status).toBe(200);

    // Tomorrow opens with the physical count, not the calculated closing.
    const tomorrow = on(staff, TOMORROW);
    expect((await call(tomorrow, "POST", `/stock/desk/${desk}/checkin`, { date: TOMORROW })).status).toBe(200);
    const next = await detailOf(tomorrow, desk, TOMORROW);
    expect(rowOf(next, "GB-001").opening_qty).toBe(gb.closing_qty - 1);
    expect(next.rows).toHaveLength(4);
  });

  it("a Done day is locked for every kind of write", async () => {
    const staff = await asStaff("B-IT");
    const desk = "IT-D01";
    const before = await detailOf(staff, desk, TODAY);
    expect(before.status).toBe("done");
    const writes = [
      ["POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "GB-001", field: "retail_sale", to: 5 }] }],
      ["POST", `/stock/desk/${desk}/sku`, { date: TODAY, sku_id: "NK-010" }],
      ["DELETE", `/stock/desk/${desk}/sku/GB-001?date=${TODAY}`, undefined],
      ["POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "done" }],
      ["POST", "/transfers", { date: TODAY, fromDeskId: desk, toDeskId: "IT-D02", skuId: "GB-001", qty: 1 }],
    ] as const;
    for (const [method, path, body] of writes) {
      const res = await call(staff, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(423);
    }
    expect(await detailOf(staff, desk, TODAY)).toEqual(before);
  });

  it("saving one field does not overwrite the others", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", "/stock/desk/MM-D01/entries", { date: TODAY, changes: [{ sku_id: "NK-010", field: "stock_in", to: 7 }] });
    await call(staff, "POST", "/stock/desk/MM-D01/entries", { date: TODAY, changes: [{ sku_id: "NK-010", field: "wholesale", to: 2 }] });
    const row = rowOf(await detailOf(staff, "MM-D01", TODAY), "NK-010");
    expect([row.stock_in, row.wholesale]).toEqual([7, 2]);
    expect(row.closing_qty).toBe(row.opening_qty + 7 - row.retail_sale - 2);
  });

  it("refuses a sale larger than the stock with NEGATIVE_CLOSING", async () => {
    const staff = await asStaff("B-MM");
    const row = rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001");
    const res = await call(staff, "POST", "/stock/desk/MM-D01/entries", { date: TODAY, changes: [{ sku_id: "GB-001", field: "retail_sale", to: row.closing_qty + row.retail_sale + 1 }] });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NEGATIVE_CLOSING");
  });

  it("rejects bad quantities and unknown rows", async () => {
    const staff = await asStaff("B-MM");
    for (const bad of [-1, 1.5, "x"]) {
      const res = await call(staff, "POST", "/stock/desk/MM-D01/entries", { date: TODAY, changes: [{ sku_id: "GB-001", field: "retail_sale", to: bad }] });
      expect(res.status).toBe(400);
    }
    expect((await call(staff, "POST", "/stock/desk/MM-D01/entries", { date: TODAY, changes: [{ sku_id: "SP-904", field: "stock_in", to: 1 }] })).status).toBe(400);
  });

  it("only an empty row can be removed from the day", async () => {
    const staff = await asStaff("B-MM");
    expect((await call(staff, "DELETE", `/stock/desk/MM-D01/sku/GB-001?date=${TODAY}`)).json.code).toBe("ROW_HAS_ACTIVITY");
    expect((await call(staff, "POST", "/stock/desk/MM-D01/sku", { date: TODAY, sku_id: "SP-904" })).status).toBe(200);
    expect((await call(staff, "DELETE", `/stock/desk/MM-D01/sku/SP-904?date=${TODAY}`)).status).toBe(200);
    expect(rowOf(await detailOf(staff, "MM-D01", TODAY), "SP-904")).toBeUndefined();
  });

  it("opening stock can only be typed on a desk's first day", async () => {
    const staff = await asStaff("B-MM");
    expect((await call(staff, "POST", "/stock/desk/MM-D01/sku", { date: TODAY, sku_id: "SP-904", opening_qty: 9 })).json.code).toBe("OPENING_LOCKED");
    const created = await call(staff, "POST", "/desks", { branchId: "B-MM", displayName: "Desk 05", openingSkus: [{ sku_id: "GB-001", opening_qty: 3 }] });
    expect(created.status).toBe(200);
    const deskId = created.json.desk.desk_id;
    expect(deskId).toBe("MM-D05");
    expect((await call(staff, "POST", `/stock/desk/${deskId}/sku`, { date: TODAY, sku_id: "SP-904", opening_qty: 9 })).status).toBe(200);
    const detail = await detailOf(staff, deskId, TODAY);
    expect(detail.isFirstDay).toBe(true);
    expect(rowOf(detail, "SP-904").opening_qty).toBe(9);
    expect(rowOf(detail, "GB-001").closing_baht).toBe(3);
  });

  it("date rules: no future, staff only today, admin may record the past", async () => {
    const staff = await asStaff("B-MM");
    const admin = await asAdmin();
    expect((await call(staff, "POST", "/stock/desk/MM-D03/checkin", { date: TOMORROW })).json.code).toBe("FUTURE_DATE");
    expect((await call(staff, "POST", "/stock/desk/MM-D03/checkin", { date: YESTERDAY })).json.code).toBe("PAST_DATE");
    expect((await call(admin, "POST", "/stock/desk/MM-D03/checkin", { date: YESTERDAY })).status).toBe(200);
    expect((await call(staff, "POST", "/stock/desk/MM-D03/checkin", { date: "2026-13-40" })).status).toBe(400);
    // MM-D02 already has days after 3 days ago — a gap cannot be back-filled.
    expect((await call(admin, "POST", "/stock/desk/MM-D02/checkin", { date: "2026-11-01" })).json.code).toBe("LATER_DAY_EXISTS");
  });
});

describe("admin reopen", () => {
  it("only the latest Done day reopens, with a reason, and the fix flows into the next day", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const desk = "MM-D02";
    const twoDaysAgo = "2026-11-10";
    expect((await call(admin, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY })).json.code).toBe("REASON_REQUIRED");
    expect((await call(admin, "POST", `/stock/desk/${desk}/reopen`, { date: twoDaysAgo, reason: "wrong count" })).json.code).toBe("NOT_LATEST_DONE");

    // Today is already checked in when the mistake in yesterday is found.
    await call(staff, "POST", `/stock/desk/${desk}/checkin`, { date: TODAY });
    const openingBefore = rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty;

    expect((await call(admin, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY, reason: "wrong count" })).status).toBe(200);
    expect((await detailOf(admin, desk, YESTERDAY)).status).toBe("check_in");
    expect((await call(admin, "POST", `/stock/desk/${desk}/transition`, { date: YESTERDAY, toStatus: "final_stock" })).status).toBe(200);
    await call(admin, "POST", `/stock/desk/${desk}/entries`, {
      date: YESTERDAY,
      changes: [
        { sku_id: "BR-020", field: "counted_qty", to: openingBefore - 2 },
        { sku_id: "BR-020", field: "counted_note", to: "recount" },
      ],
    });
    expect((await call(admin, "POST", `/stock/desk/${desk}/transition`, { date: YESTERDAY, toStatus: "done" })).status).toBe(200);
    expect(rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty).toBe(openingBefore - 2);

    const log = (await call(admin, "GET", "/audit")).json.entries;
    expect(log.find((e: any) => e.action === "desk_day.reopen")).toMatchObject({ target: `${desk}/${YESTERDAY}`, detail: { reason: "wrong count" } });
  });

  // Re-closing yesterday with a lower count lowers today's opening. If today has
  // already sold that stock, the close must be refused whole, not left half done.
  const reopenAndRecount = async (admin: any, desk: string, sku: string, counted: number) => {
    expect((await call(admin, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY, reason: "wrong count" })).status).toBe(200);
    const res = await call(admin, "POST", `/stock/desk/${desk}/entries`, { date: YESTERDAY, changes: [{ sku_id: sku, field: "counted_qty", to: counted }, { sku_id: sku, field: "counted_note", to: "recount" }] });
    expect(res.status).toBe(200);
    return call(admin, "POST", `/stock/desk/${desk}/close`, { date: YESTERDAY });
  };

  it("refuses re-closing a day whose lower count would push the next day negative, and writes nothing", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const desk = "MM-D02";
    await call(staff, "POST", `/stock/desk/${desk}/checkin`, { date: TODAY });
    const open = rowOf(await detailOf(staff, desk, TODAY), "BR-020");
    expect(open.opening_qty).toBeGreaterThanOrEqual(3);
    // Today sells everything it opened with.
    expect((await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "BR-020", field: "retail_sale", to: open.opening_qty }] })).status).toBe(200);

    const res = await reopenAndRecount(admin, desk, "BR-020", open.opening_qty - 2);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NEXT_DAY_NEGATIVE");
    expect(res.json).toMatchObject({ sku_id: "BR-020", date: TODAY, available: 0 });
    expect((await detailOf(admin, desk, YESTERDAY)).status).not.toBe("done");
    expect(rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty).toBe(open.opening_qty);
  });

  it("closes fine when the lower count keeps the next day non-negative, and today's opening follows", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const desk = "MM-D02";
    await call(staff, "POST", `/stock/desk/${desk}/checkin`, { date: TODAY });
    const open = rowOf(await detailOf(staff, desk, TODAY), "BR-020");
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "BR-020", field: "stock_in", to: 5 }] });
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "BR-020", field: "retail_sale", to: open.opening_qty }] });

    const res = await reopenAndRecount(admin, desk, "BR-020", open.opening_qty - 2);
    expect(res.status).toBe(200);
    expect((await detailOf(admin, desk, YESTERDAY)).status).toBe("done");
    expect(rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty).toBe(open.opening_qty - 2);
  });
});

describe("linked transfers", () => {
  it("gold leaves the sender, stays in the company total while in transit, and lands when confirmed", async () => {
    // Same-branch hand-overs are instant Moves (test/moves.test.ts); this is the cross-branch send / receive flow.
    const staff = await asStaff("B-MM");
    const ts = await asStaff("B-TS");
    const admin = await asAdmin();
    const total = async () => (await call(admin, "GET", "/dashboard")).json.portfolio.total_pcs;
    const totalBefore = await total();
    const fromBefore = rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001");

    expect((await call(staff, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "TS-D02", skuId: "GB-001", qty: 999 })).json.code).toBe("NOT_ENOUGH_STOCK");
    const sent = await call(staff, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "TS-D02", skuId: "GB-001", qty: 3 });
    expect(sent.status).toBe(200);
    expect(sent.json.kind).toBe("transfer"); // another branch

    const fromAfter = rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001");
    expect(fromAfter.transfer_out).toBe(fromBefore.transfer_out + 3);
    expect(fromAfter.closing_qty).toBe(fromBefore.closing_qty - 3);
    expect(await total()).toBe(totalBefore);
    expect((await call(admin, "GET", "/dashboard")).json.transit).toMatchObject({ count: 1, pcs: 3 });

    // The receiving desk must have an open day to receive into.
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/receive`, { date: TODAY })).json.code).toBe("NOT_CHECKED_IN");
    await call(ts, "POST", "/stock/desk/TS-D02/checkin", { date: TODAY });
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/receive`, { date: TODAY })).status).toBe(200);
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/receive`, { date: TODAY })).json.code).toBe("NOT_IN_TRANSIT");

    const received = rowOf(await detailOf(ts, "TS-D02", TODAY), "GB-001");
    expect(received.transfer_in).toBe(3);
    expect(received.closing_qty).toBe(3);
    expect(await total()).toBe(totalBefore);
    expect((await call(admin, "GET", "/dashboard")).json.transit.count).toBe(0);
  });

  it("a transfer to another branch can be cancelled before it is received", async () => {
    const mm = await asStaff("B-MM");
    const ts = await asStaff("B-TS");
    const before = rowOf(await detailOf(mm, "MM-D01", TODAY), "RG-030");
    const sent = await call(mm, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "TS-D02", skuId: "RG-030", qty: 2 });
    expect(sent.json.kind).toBe("transfer");
    expect(rowOf(await detailOf(mm, "MM-D01", TODAY), "RG-030").transfer_out).toBe(2);
    // Only the sending branch may cancel.
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/cancel`)).status).toBe(403);
    expect((await call(mm, "POST", `/transfers/${sent.json.id}/cancel`)).status).toBe(200);
    expect(rowOf(await detailOf(mm, "MM-D01", TODAY), "RG-030")).toEqual(before);
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/receive`, { date: TODAY })).json.code).toBe("NOT_IN_TRANSIT");
  });

  it("the sender can close while the transfer is still in transit", async () => {
    const mm = await asStaff("B-MM");
    await call(mm, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "TS-D02", skuId: "RG-030", qty: 2 });
    expect((await closeDay(mm, "MM-D01", TODAY)).status).toBe(200);
  });
});

describe("documents", () => {
  it("numbers never repeat, even after a delete", async () => {
    const admin = await asAdmin();
    const make = async () => (await call(admin, "POST", "/documents", { title: "Receipt", branchId: "B-MM", deskId: "MM-D01", rows: [{ item: "x", qty: 1 }] })).json;
    const first = await make();
    expect(first.doc_no).toBe("DOC-MM-2026-0003");
    expect((await call(admin, "DELETE", `/documents/${first.id}`)).status).toBe(200);
    expect((await make()).doc_no).toBe("DOC-MM-2026-0004");
  });

  it("a desk from another branch is refused", async () => {
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/documents", { title: "x", branchId: "B-MM", deskId: "TS-D01" })).json.code).toBe("DESK_NOT_IN_BRANCH");
  });

  it("proposals are approved once, by an admin; ordinary documents have no status", async () => {
    const staff = await asStaff("B-MM");
    const admin = await asAdmin();
    const proposal = (await call(staff, "POST", "/documents", { title: "Order", branchId: "B-MM", deskId: "MM-D01", kind: "proposal", rows: [{ item: "Gold Bar", qty: 5 }] })).json;
    expect(proposal.status).toBe("pending");
    const plain = (await call(staff, "POST", "/documents", { title: "Receipt", branchId: "B-MM" })).json;
    expect(plain.status).toBeNull();
    expect((await call(admin, "POST", `/documents/${plain.id}/decision`, { decision: "approved" })).json.code).toBe("NOT_A_PROPOSAL");
    expect((await call(admin, "POST", `/documents/${proposal.id}/decision`, { decision: "approved" })).status).toBe(200);
    expect((await call(admin, "POST", `/documents/${proposal.id}/decision`, { decision: "rejected" })).json.code).toBe("ALREADY_DECIDED");
    const pending = (await call(admin, "GET", "/documents?kind=proposal&status=pending")).json.documents;
    expect(pending.map((d: any) => d.id)).not.toContain(proposal.id);
  });
});

describe("numbers agree across screens", () => {
  it("desk cards, dashboard and report give the same stock for a branch", async () => {
    const admin = await asAdmin();
    const cards = (await call(admin, "GET", "/stock/desks?branchId=B-IT")).json.desks;
    const cardPcs = cards.reduce((s: number, d: any) => s + d.totalPcs, 0);
    const cardBaht = cards.reduce((s: number, d: any) => s + d.totalBaht, 0);
    const dash = (await call(admin, "GET", "/dashboard?branchId=B-IT")).json;
    const report = (await call(admin, "GET", "/report?branchId=B-IT&period=2026-11")).json;
    expect(cardPcs).toBeGreaterThan(0);
    expect(dash.portfolio.total_pcs).toBe(cardPcs);
    expect(dash.portfolio.total_baht_gold).toBe(cardBaht);
    expect(report.kpi.closing.pcs).toBe(cardPcs);
    expect(report.kpi.closing.lak).toBe(dash.portfolio.lak_value);
    // opening + in - out + count adjustments = closing
    const k = report.kpi;
    expect(k.opening.pcs + k.in.pcs - k.out.pcs + k.adjust.pcs).toBe(k.closing.pcs);
  });

  it("the dashboard counts desks that have not checked in today", async () => {
    const admin = await asAdmin();
    const dash = (await call(admin, "GET", "/dashboard?deskId=MM-D02")).json;
    expect(dash.portfolio.total_pcs).toBeGreaterThan(0);
    expect(dash.portfolio.desksDoneToday).toBe(0);
  });

  it("value follows the gold price the admin enters", async () => {
    const admin = await asAdmin();
    const before = (await call(admin, "GET", "/dashboard?deskId=IT-D01")).json.portfolio;
    expect(before.lak_value).toBe(before.total_baht_gold * 32500000);
    await call(admin, "POST", "/settings/config", { spotLakPerBaht: 40000000, usdToLakRate: 20000 });
    const after = (await call(admin, "GET", "/dashboard?deskId=IT-D01")).json.portfolio;
    expect(after.lak_value).toBe(before.total_baht_gold * 40000000);
    expect(after.usd_value).toBe(after.lak_value / 20000);
  });

  it("low stock follows the branch status everywhere", async () => {
    const admin = await asAdmin();
    const row = rowOf(await detailOf(admin, "IT-D01", TODAY), "GB-001");
    expect(row.threshold).toBeUndefined();
    expect(["critical", "warning", "ok", "no_data"]).toContain(row.branch_status);
    const low = (await call(admin, "GET", "/dashboard?deskId=IT-D01")).json.watchlist.topLow;
    for (const item of low) expect(item.closing).toBeLessThanOrEqual(item.reorder_level);
  });

  it("the report works for short months", async () => {
    const admin = await asAdmin();
    for (const period of ["2026-11", "2027-02", "2026-09"]) expect((await call(admin, "GET", `/report?period=${period}`)).status).toBe(200);
    expect((await call(admin, "GET", "/report?period=2026-13")).status).toBe(400);
  });
});

describe("SKU master data", () => {
  it("CSV import is all-or-nothing and reports the bad lines", async () => {
    const admin = await asAdmin();
    const count = async () => (await call(admin, "GET", "/skus?all=1")).json.skus.length;
    const before = await count();
    const bad = await call(admin, "POST", "/skus/import", {
      rows: [
        { name_en: "Ring A", type: "Rings & Accessories", weight: "0.5 Baht", purity: "96.5%", baht_weight: "0.5" },
        { name_en: "Ring B", type: "No Such Type" },
        { name_en: "", type: "Gold Bars" },
        { sku_id: "GB-001", name_en: "Dup", type: "Gold Bars" },
      ],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.errors.map((e: any) => e.line)).toEqual([3, 4, 5]);
    expect(await count()).toBe(before);

    const good = await call(admin, "POST", "/skus/import", {
      rows: [
        { sku_id: "RG-100", name_en: "Ring A", type: "rings & accessories", weight: "0.5 Baht", purity: "96.5%", baht_weight: "0.5", avg_daily_sales: "1.5", order_lead_time_days: "2" },
        { name_en: "Bar Z", type: "Gold Bars", weight: "1 Baht", purity: "99.99%", baht_weight: 1 },
      ],
    });
    expect(good.json.imported).toBe(2);
    expect(await count()).toBe(before + 2);
    const ring = (await call(admin, "GET", "/skus")).json.skus.find((s: any) => s.sku_id === "RG-100");
    expect(ring).toMatchObject({ category: "Rings & Accessories", std_gram_weight: 7.622, baht_weight: 0.5, avg_daily_sales: 1.5 });
  });

  it("avg/day and lead time on create and import become company-wide SKU rules", async () => {
    const admin = await asAdmin();
    const row = async (id: string) => {
      const rule = (await getStore({} as any).rules()).find((x) => x.scope === "sku" && x.scope_key === id && x.branch_id === null);
      return rule ? { avg: { value: rule.avg_daily_sell, source: "sku" }, lead: { value: rule.lead_time_days, source: "sku" } } : undefined;
    };

    const made = await call(admin, "POST", "/skus", { sku_id: "NEW-1", name_en: "New A", type_id: "GOLD_BARS", weight_id: "BAHT_1", avg_daily_sales: 4, order_lead_time_days: 6, group: "Fresh" });
    expect(made.status).toBe(200);
    expect(made.json.group_name).toBe("Fresh");
    expect(await row("NEW-1")).toMatchObject({ avg: { value: 4 }, lead: { value: 6 } });

    // A bad row imports nothing, and writes no rule.
    const bad = await call(admin, "POST", "/skus/import", {
      rows: [
        { sku_id: "IMP-1", name_en: "Imp 1", type: "Gold Bars", avg_daily_sales: "2" },
        { sku_id: "IMP-2", name_en: "Imp 2", type: "Gold Bars", order_lead_time_days: "99999" },
      ],
    });
    expect(bad.status).toBe(422);
    expect(await row("IMP-1")).toBeUndefined();

    const good = await call(admin, "POST", "/skus/import", {
      rows: [
        { sku_id: "IMP-1", name_en: "Imp 1", type: "Gold Bars", avg_daily_sales: "2", order_lead_time_days: "3", group: "Imp" },
        { sku_id: "IMP-3", name_en: "Imp 3", type: "Gold Bars", group: "Imp" },
      ],
    });
    expect(good.json.imported).toBe(2);
    expect(await row("IMP-1")).toMatchObject({ avg: { value: 2 }, lead: { value: 3 } });
    expect(await row("IMP-3")).toBeUndefined();
  });

  it("an inactive SKU cannot be added to a desk", async () => {
    const admin = await asAdmin();
    await call(admin, "PATCH", "/skus/SP-904", { active: false });
    expect((await call(admin, "POST", "/stock/desk/MM-D01/sku", { date: TODAY, sku_id: "SP-904" })).json.code).toBe("BAD_SKU");
  });

  it("renaming a type keeps its SKUs grouped under the new name", async () => {
    const admin = await asAdmin();
    await call(admin, "PATCH", "/sku-types/GOLD_BARS", { name_en: "Bars" });
    const bar = (await call(admin, "GET", "/skus")).json.skus.find((s: any) => s.sku_id === "GB-001");
    expect(bar.category).toBe("Bars");
  });
});

describe("branch manager", () => {
  it("sees only own branch", async () => {
    const manager = await asManager("B-MM");
    const cards = (await call(manager, "GET", "/stock/desks?branchId=B-TS")).json.desks;
    expect(new Set(cards.map((d: any) => d.branch_id))).toEqual(new Set(["B-MM"]));
    expect((await call(manager, "GET", `/stock/desk/TS-D01?date=${TODAY}`)).status).toBe(403);
    const meta = (await call(manager, "GET", "/app-meta")).json;
    expect(new Set(meta.desks.map((d: any) => d.branch_id))).toEqual(new Set(["B-MM"]));
    expect(meta.user.role).toBe("manager");
  });

  it("reopens the latest Done day within 3 days with a reason", async () => {
    const manager = await asManager("B-MM");
    const desk = "MM-D02";
    expect((await call(manager, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY })).json.code).toBe("REASON_REQUIRED");
    expect((await call(manager, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY, reason: "wrong count" })).status).toBe(200);
    expect((await detailOf(manager, desk, YESTERDAY)).status).toBe("check_in");
    const log = (await call(await asAdmin(), "GET", "/audit")).json.entries;
    expect(log.find((e: any) => e.action === "desk_day.reopen")).toMatchObject({ actor_name: "Manivone M." });
  });

  it("cannot reopen a day older than 3 days, or another branch", async () => {
    // Ten days later, yesterday's Done day is far too old.
    const late = await asManager("B-MM", "2026-11-22");
    const old = await call(late, "POST", "/stock/desk/MM-D02/reopen", { date: YESTERDAY, reason: "too late" });
    expect(old.status).toBe(403);
    expect(old.json.code).toBe("REOPEN_TOO_OLD");
    const manager = await asManager("B-MM");
    expect((await call(manager, "POST", "/stock/desk/TS-D01/reopen", { date: YESTERDAY, reason: "other branch" })).status).toBe(403);
  });

  it("staff still cannot reopen; admin can reopen any age", async () => {
    const staff = await asStaff("B-MM");
    expect((await call(staff, "POST", "/stock/desk/MM-D02/reopen", { date: YESTERDAY, reason: "nope" })).status).toBe(403);
    const admin = await asAdmin("2026-11-22");
    expect((await call(admin, "POST", "/stock/desk/MM-D02/reopen", { date: YESTERDAY, reason: "old fix" })).status).toBe(200);
  });

  it("cannot create users or change master data", async () => {
    const manager = await asManager("B-MM");
    expect((await call(manager, "POST", "/users", { displayName: "X", username: "xxx", branchId: "B-MM", password: "111111" })).status).toBe(403);
    expect((await call(manager, "PATCH", `/users/${DEMO_STAFF["B-MM"]}`, { password: "111111" })).status).toBe(403);
    expect((await call(manager, "PATCH", `/users/${DEMO_STAFF["B-MM"]}`, { username: "hacked" })).status).toBe(403);
    expect((await call(manager, "PATCH", "/skus/GB-001", { active: false })).status).toBe(403);
    expect((await call(manager, "GET", "/audit?branchId=B-IT")).status).toBe(403);
  });

  it("can unlock own-branch staff but nothing else about them", async () => {
    const manager = await asManager("B-MM");
    const id = DEMO_STAFF["B-MM"];
    for (let i = 0; i < 5; i++) await call(null, "POST", "/auth/login", creds(id, "0000"));
    expect((await call(null, "POST", "/auth/login", creds(id, "1234"))).status).toBe(423);
    expect((await call(manager, "PATCH", `/users/${id}`, { password: "111111" })).status).toBe(403);
    expect((await call(manager, "PATCH", `/users/${id}`, { unlock: true, active: false })).status).toBe(403);
    expect((await call(manager, "PATCH", `/users/${id}`, { unlock: true })).status).toBe(200);
    expect((await call(null, "POST", "/auth/login", creds(id, "1234"))).status).toBe(200);
    // another branch's staff are out of reach
    expect((await call(manager, "PATCH", `/users/${DEMO_STAFF["B-TS"]}`, { unlock: true })).status).toBe(403);
  });

  it("admin can create a manager; a manager without a branch is refused", async () => {
    const admin = await asAdmin();
    const bad = await call(admin, "POST", "/users", { displayName: "Boss", username: "boss", role: "manager", password: "222222" });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("BAD_BRANCH");
    const ok = await call(admin, "POST", "/users", { displayName: "Boss", username: "boss", role: "manager", branchId: "B-TS", password: "222222" });
    expect(ok.status).toBe(200);
    const session = await login(ok.json.id, "222222");
    expect((await call(session, "GET", "/auth/me")).json.user.role).toBe("manager");
    const summary = (await call(admin, "GET", "/settings/summary")).json.staff;
    expect(summary.roleCounts.manager).toBe(2);
  });
});

describe("compare-and-set entries, counts any time, one-step close", () => {
  const entries = (s: any, body: object, desk = "MM-D01") => call(s, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, ...body });

  it("two devices: the second stale change gets 409 ROW_CHANGED with the current row", async () => {
    const a = await asStaff("B-MM");
    const b = await asStaff("B-MM");
    const before = rowOf(await detailOf(a, "MM-D01", TODAY), "NK-010");
    const first = await entries(a, { changes: [{ sku_id: "NK-010", field: "retail_sale", from: before.retail_sale, to: before.retail_sale + 1 }] });
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    expect(first.json.rows[0].retail_sale).toBe(before.retail_sale + 1);
    const second = await entries(b, { changes: [{ sku_id: "NK-010", field: "retail_sale", from: before.retail_sale, to: before.retail_sale + 5 }] });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("ROW_CHANGED");
    expect(second.json.row.retail_sale).toBe(before.retail_sale + 1);
    expect(rowOf(await detailOf(a, "MM-D01", TODAY), "NK-010").retail_sale).toBe(before.retail_sale + 1);
  });

  it("a retried change that already applied returns ok", async () => {
    const staff = await asStaff("B-MM");
    const before = rowOf(await detailOf(staff, "MM-D01", TODAY), "NK-010");
    const change = { sku_id: "NK-010", field: "stock_in", from: before.stock_in, to: before.stock_in + 3 };
    expect((await entries(staff, { changes: [change] })).status).toBe(200);
    const retry = await entries(staff, { changes: [change] });
    expect(retry.status).toBe(200);
    expect(retry.json.ok).toBe(true);
    expect(rowOf(await detailOf(staff, "MM-D01", TODAY), "NK-010").stock_in).toBe(before.stock_in + 3);
  });

  it("a change that would make closing negative gets 409 NEGATIVE_CLOSING with available", async () => {
    const staff = await asStaff("B-MM");
    const row = rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001");
    const res = await entries(staff, { changes: [{ sku_id: "GB-001", field: "retail_sale", from: row.retail_sale, to: row.retail_sale + row.closing_qty + 1 }] });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NEGATIVE_CLOSING");
    expect(res.json.available).toBe(row.closing_qty);
  });

  it("the legacy rows body is gone: USE_CHANGES", async () => {
    const staff = await asStaff("B-MM");
    const res = await entries(staff, { rows: [{ sku_id: "GB-001", retail_sale: 1 }] });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("USE_CHANGES");
    // a body with neither form is refused the same way
    expect((await entries(staff, {})).json.code).toBe("USE_CHANGES");
  });

  it("two changes to the same field of one SKU in one request get DUPLICATE_FIELD", async () => {
    const staff = await asStaff("B-MM");
    const before = rowOf(await detailOf(staff, "MM-D01", TODAY), "NK-010");
    const res = await entries(staff, {
      changes: [
        { sku_id: "NK-010", field: "stock_in", to: 1 },
        { sku_id: "NK-010", field: "stock_in", to: 2 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("DUPLICATE_FIELD");
    expect(res.json).toMatchObject({ sku_id: "NK-010", field: "stock_in" });
    expect(rowOf(await detailOf(staff, "MM-D01", TODAY), "NK-010").stock_in).toBe(before.stock_in);
  });

  it("validates fields, quantities and rows of a change", async () => {
    const staff = await asStaff("B-MM");
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "opening_qty", to: 5 }] })).json.code).toBe("BAD_FIELD");
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "retail_sale", to: -1 }] })).json.code).toBe("BAD_QTY");
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "retail_sale", from: "x", to: 1 }] })).json.code).toBe("BAD_QTY");
    expect((await entries(staff, { changes: [{ sku_id: "NOPE", field: "retail_sale", to: 1 }] })).json.code).toBe("ROW_NOT_FOUND");
  });

  it("counted_qty saves while the day is check_in, and may be cleared with from set", async () => {
    const staff = await asStaff("B-MM");
    expect((await detailOf(staff, "MM-D01", TODAY)).status).toBe("check_in");
    const saved = await entries(staff, { changes: [{ sku_id: "GB-001", field: "counted_qty", from: null, to: 3 }, { sku_id: "GB-001", field: "counted_note", from: null, to: "ok" }] });
    expect(saved.status).toBe(200);
    expect(rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001")).toMatchObject({ counted_qty: 3, counted_note: "ok" });
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "counted_qty", from: 3, to: null }] })).status).toBe(200);
    expect(rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001").counted_qty).toBeNull();
  });

  it("close goes straight from check_in to done when everything is counted", async () => {
    const staff = await asStaff("B-MM");
    await countEverything(staff, "MM-D01", TODAY);
    const res = await call(staff, "POST", "/stock/desk/MM-D01/close", { date: TODAY, safe_drop_note: "dropped" });
    expect(res.status).toBe(200);
    expect((await detailOf(staff, "MM-D01", TODAY)).status).toBe("done");
    const tomorrow = on(staff, TOMORROW);
    expect((await call(tomorrow, "POST", "/stock/desk/MM-D01/checkin", { date: TOMORROW })).status).toBe(200);
  });

  it("close refuses with DAY_INCOMPLETE listing count_missing", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "POST", "/stock/desk/MM-D01/close", { date: TODAY });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("DAY_INCOMPLETE");
    expect(res.json.failures.filter((f: any) => f.rule === "count_missing")).toHaveLength(4);
    expect((await detailOf(staff, "MM-D01", TODAY)).status).toBe("check_in");
  });

  it("close also works from final_stock and refuses a Done day", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", "/stock/desk/MM-D01/transition", { date: TODAY, toStatus: "final_stock" });
    await countEverything(staff, "MM-D01", TODAY);
    expect((await call(staff, "POST", "/stock/desk/MM-D01/close", { date: TODAY })).status).toBe(200);
    expect((await call(staff, "POST", "/stock/desk/MM-D01/close", { date: TODAY })).status).toBe(423);
  });
});

describe("cards: streak, tier, holder and branch summary (CR3)", () => {
  const db = () => (getStore({} as any) as any).db;

  it("overdue case is first; branchSummary counts", async () => {
    const staff = await asStaff("B-MM"); // builds the demo store on the pinned date
    // Morning Market: the two spare cases are brand new, MM-D02 was last done 4 days ago.
    for (const d of db().desks) if (d.desk_id === "MM-D03" || d.desk_id === "MM-D04") d.created_at = `${TODAY}T03:00:00.000Z`;
    db().deskDays = db().deskDays.filter((d: any) => d.desk_id !== "MM-D02");
    db().deskDays.push({ ...db().deskDays.find((d: any) => d.desk_id === "MM-D01"), desk_id: "MM-D02", ledger_date: "2026-11-08", status: "done" });
    const res = await call(staff, "GET", "/stock/desks");
    const cards = res.json.desks.filter((d: any) => d.branch_id === "B-MM");
    expect(cards[0].desk_id).toBe("MM-D02");
    expect(cards[0]).toMatchObject({ tier: "overdue", daysBehind: 3, lastDoneDate: "2026-11-08", streak: 0 });
    const d01 = cards.find((d: any) => d.desk_id === "MM-D01");
    expect(d01).toMatchObject({ tier: "on_track", streak: 3, daysBehind: 0, lastDoneByName: "Somchai S." });
    expect(cards.find((d: any) => d.desk_id === "MM-D03")).toMatchObject({ tier: "on_track", streak: 0, daysBehind: 0, assignee: null });
    expect(res.json.branchSummary).toEqual({ cases: 4, checkedToday: 0, behind1: 0, overdue: 1 });
  });

  it("a closed day keeps the streak and is not behind", async () => {
    await call(await asAdmin(), "POST", "/closed-days", { branchId: "B-IT", date: YESTERDAY, reason: "Holiday" });
    const cards = (await call(await asStaff("B-IT"), "GET", "/stock/desks")).json.desks;
    // IT-D01 was Done the last 4 days including today; yesterday is closed.
    expect(cards.find((d: any) => d.desk_id === "IT-D01")).toMatchObject({ tier: "done_today", streak: 3 });
  });

  it("assignee started yesterday is stale; today is not", async () => {
    const m = await asManager("B-MM");
    await call(m, "POST", "/desks/MM-D01/assign", { staffId: DEMO_STAFF["B-MM"] });
    await call(m, "POST", "/desks/MM-D02/assign", { staffId: DEMO_STAFF["B-MM"] });
    const a = db().assignments.find((x: any) => x.desk_id === "MM-D01");
    a.started_at = `${YESTERDAY}T05:00:00.000Z`;
    const cards = (await call(m, "GET", "/stock/desks?branchId=B-MM")).json.desks;
    expect(cards.find((d: any) => d.desk_id === "MM-D01").assignee).toMatchObject({ staffId: DEMO_STAFF["B-MM"], name: "Somchai S.", stale: true });
    expect(cards.find((d: any) => d.desk_id === "MM-D02").assignee.stale).toBe(false);
  });
});

describe("data mode and /api/meta (Task 18)", () => {
  const db = () => (getStore({} as any) as any).db;
  const seedStaff = () => {
    db().staffAccounts.find((a: any) => a.id === DEMO_STAFF["B-MM"]).is_seed = true;
  };

  it("production mode refuses a seed account login", async () => {
    seedStaff();
    const res = await call(null, "POST", "/auth/login", creds(DEMO_STAFF["B-MM"], "1234"), TODAY, { KPV_DATA_MODE: "production" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("SEED_ACCOUNT_DISABLED");
    const list = await call(await asManager(), "GET", "/auth/accounts?branchId=B-MM", undefined, TODAY, { KPV_DATA_MODE: "production" });
    expect(list.json.accounts.map((a: any) => a.id)).not.toContain(DEMO_STAFF["B-MM"]);
  });

  it("test mode allows it and meta says test", async () => {
    seedStaff();
    const res = await call(null, "POST", "/auth/login", creds(DEMO_STAFF["B-MM"], "1234"), TODAY, { KPV_DATA_MODE: "test" });
    expect(res.status).toBe(200);
    const list = await call(await asManager(), "GET", "/auth/accounts?branchId=B-MM", undefined, TODAY, { KPV_DATA_MODE: "test" });
    expect(list.json.accounts.map((a: any) => a.id)).toContain(DEMO_STAFF["B-MM"]);
    const meta = await call(null, "GET", "/meta", undefined, TODAY, { KPV_DATA_MODE: "test" });
    expect(meta.status).toBe(200);
    expect(meta.json).toEqual({ dataMode: "test", seedRows: null });
  });

  it("defaults to demo without Supabase", async () => {
    expect((await call(null, "GET", "/meta")).json.dataMode).toBe("demo");
  });

  it("admin meta reports seedRows > 0 when seed rows exist; others see null (unknown)", async () => {
    seedStaff();
    const admin = await asAdmin();
    const staff = await asStaff("B-TS");
    const env = { KPV_DATA_MODE: "test" };
    const a = await call(admin, "GET", "/meta", undefined, TODAY, env);
    expect(a.json.dataMode).toBe("test");
    expect(a.json.seedRows).toBeGreaterThan(0);
    expect((await call(staff, "GET", "/meta", undefined, TODAY, env)).json.seedRows).toBeNull();
    expect((await call(null, "GET", "/meta", undefined, TODAY, env)).json.seedRows).toBeNull();
  });

  it("refuses a transfer or move between a real case and a mock case (MIXED_TEST_TRANSFER)", async () => {
    const staff = await asStaff("B-MM"); // first request builds the demo store for TODAY
    db().desks.find((d: any) => d.desk_id === "TS-D02").is_seed = true;
    const sent = await call(staff, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "TS-D02", skuId: "GB-001", qty: 1 });
    expect(sent.status).toBe(400);
    expect(sent.json.code).toBe("MIXED_TEST_TRANSFER");
    // nothing left the sender
    expect(rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001").transfer_out).toBe(0);

    // a real desk of the same branch marked as mock: a move is refused too
    db().desks.find((d: any) => d.desk_id === "MM-D03").is_seed = true;
    const moved = await call(staff, "POST", "/moves", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "MM-D03", lines: [{ skuId: "GB-001", qty: 1 }], clientRef: "00000000-0000-4000-8000-0000000000bb" });
    expect(moved.status).toBe(400);
    expect(moved.json.code).toBe("MIXED_TEST_TRANSFER");
  });

  it("the signed-in screen data moved to /app-meta", async () => {
    const admin = await asAdmin();
    const res = await call(admin, "GET", "/app-meta");
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty("branches");
    expect(res.json).toHaveProperty("today");
  });
});
