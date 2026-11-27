// End-to-end rules through the real routes, on the demo dataset:
//   MM-D01  checked in today (GB-001, GB-002, NK-010, RG-030)
//   MM-D02  Done yesterday, not started today
//   VTC-D01  yesterday left at check_in (unfinished)
//   IT-D01  Done today
//   VT-D01  in final count today
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_STAFF } from "../src/demoData";
import { getStore } from "../src/store";
import { TODAY, YESTERDAY, TOMORROW, freshApp, call, login, creds, asAdmin, asStaff, asManager, on, closeDay, checkIn } from "./helpers";

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
    const cards = (await call(staff, "GET", "/stock/desks?branchId=B-VTC")).json.desks;
    expect(new Set(cards.map((d: any) => d.branch_id))).toEqual(new Set(["B-MM"]));
    expect((await call(staff, "GET", `/stock/desk/VTC-D01?date=${TODAY}`)).status).toBe(403);
    expect((await call(staff, "POST", "/stock/desk/VTC-D01/checkin", { date: TODAY })).status).toBe(403);
    expect((await call(staff, "GET", "/dashboard?deskId=VTC-D01")).status).toBe(403);
    expect((await call(staff, "GET", "/report?deskId=VTC-D01")).status).toBe(403);
    // A Vientiane Center document cannot be printed by Morning Market staff.
    expect((await call(staff, "GET", "/documents/a0000000-0000-0000-0000-000000000002/print")).status).toBe(403);
    expect((await call(staff, "GET", "/documents/a0000000-0000-0000-0000-000000000001/print")).status).toBe(200);
  });

  it("only admin changes master data, users, config and locked days", async () => {
    const staff = await asStaff("B-MM");
    const denied = [
      ["PATCH", "/skus/GB-001", { active: false }],
      ["PATCH", "/skus/GB-001", { name: "x" }],
      ["POST", "/skus/import", { branchId: "all", rows: [{}] }],
      ["GET", "/skus/export?branchId=all", undefined],
      ["POST", "/sku-types", { name_en: "X" }],
      ["POST", "/settings/config", { spotLakPerBaht: 1 }],
      ["POST", "/users", { displayName: "X", username: "xxx", branchId: "B-MM", password: "111111" }],
      ["PATCH", `/users/${DEMO_STAFF["B-MM"]}`, { password: "111111" }],
      ["DELETE", "/documents/a0000000-0000-0000-0000-000000000001", undefined],
      ["POST", "/documents/a0000000-0000-0000-0000-000000000003/decision", { decision: "approved" }],
      ["POST", "/stock/desk/IT-D01/reopen", { date: TODAY, reason: "test" }],
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

describe("admin-readable passwords", () => {
  const summaryRow = async (admin: any, id: string) =>
    (await call(admin, "GET", "/settings/summary")).json.staff.accounts.find((a: any) => a.id === id);

  it("admin sees the password set on create and on reset; it is stored as plain text", async () => {
    const admin = await asAdmin();
    const created = await call(admin, "POST", "/users", { displayName: "Pw Test", username: "pwtest", branchId: "B-VT", password: "secret-1" });
    const id = created.json.id;
    expect((await summaryRow(admin, id)).has_password).toBe(true);
    expect((await call(admin, "GET", `/users/${id}/password`)).json.password).toBe("secret-1");
    const row = (getStore({ DEMO_DATE: TODAY } as any) as any).db.staffAccounts.find((a: any) => a.id === id);
    expect(row.password_plain).toBe("secret-1");
    expect((await call(admin, "PATCH", `/users/${id}`, { password: "secret-2" })).status).toBe(200);
    expect((await call(admin, "GET", `/users/${id}/password`)).json.password).toBe("secret-2");
  });

  it("an older account is filled in at its next successful login only", async () => {
    const admin = await asAdmin();
    const id = DEMO_STAFF["B-MM"];
    expect((await summaryRow(admin, id)).has_password).toBe(false);
    expect((await call(admin, "GET", `/users/${id}/password`)).json.password).toBeNull();
    expect((await call(null, "POST", "/auth/login", creds(id, "wrong-pw"))).status).toBe(401);
    expect((await summaryRow(admin, id)).has_password).toBe(false);
    await asStaff("B-MM");
    expect((await call(admin, "GET", `/users/${id}/password`)).json.password).toBe("1234");
  });

  it("only an admin can read a password, and the list never carries one", async () => {
    const admin = await asAdmin();
    const id = DEMO_STAFF["B-MM"];
    await asStaff("B-MM");
    expect((await call(await asManager("B-MM"), "GET", `/users/${id}/password`)).status).toBe(403);
    expect((await call(await asStaff("B-MM"), "GET", `/users/${id}/password`)).status).toBe(403);
    const managerView = (await call(await asManager("B-MM"), "GET", "/settings/summary")).json.staff.accounts;
    expect(managerView.every((a: any) => !("has_password" in a))).toBe(true);
    expect((await call(admin, "GET", "/settings/summary")).text).not.toContain("1234");
  });
});

describe("daily cycle", () => {
  it("check-in is blocked until the unfinished earlier day is Done", async () => {
    const staff = await asStaff("B-VTC");
    const blocked = await call(staff, "POST", "/stock/desk/VTC-D01/checkin", { date: TODAY });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("EARLIER_DAY_OPEN");
    expect(blocked.json.openDate).toBe(YESTERDAY);
    const card = (await call(staff, "GET", "/stock/desks")).json.desks.find((d: any) => d.desk_id === "VTC-D01");
    expect(card.openEarlierDate).toBe(YESTERDAY);

    // Staff may finish the unfinished day themselves, then check in.
    expect((await closeDay(staff, "VTC-D01", YESTERDAY)).status).toBe(200);
    expect((await call(staff, "POST", "/stock/desk/VTC-D01/checkin", { date: TODAY })).status).toBe(200);
    expect((await detailOf(staff, "VTC-D01", TODAY)).status).toBe("opening");
  });

  it("Done needs no count, through final stock too; tomorrow opens with the closing", async () => {
    const staff = await asStaff("B-MM");
    const desk = "MM-D01";
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "GB-001", field: "destock", to: 1 }] });
    // check_in -> done is not a transition step; it goes through final stock (or /close).
    expect((await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "done" })).status).toBe(409);
    expect((await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "final_stock" })).status).toBe(200);
    const gb = rowOf(await detailOf(staff, desk, TODAY), "GB-001");
    expect((await call(staff, "POST", `/stock/desk/${desk}/transition`, { date: TODAY, toStatus: "done" })).status).toBe(200);

    const tomorrow = on(staff, TOMORROW);
    expect((await call(tomorrow, "POST", `/stock/desk/${desk}/checkin`, { date: TOMORROW })).status).toBe(200);
    const next = await detailOf(tomorrow, desk, TOMORROW);
    expect(next.status).toBe("opening");
    expect(rowOf(next, "GB-001").opening_qty).toBe(gb.closing_qty);
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

  it("an opening can only be typed before check-in is confirmed", async () => {
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

  it("a new case freezes who made it and its starting stock", async () => {
    const staff = await asStaff("B-MM");
    const created = await call(staff, "POST", "/desks", {
      branchId: "B-MM",
      displayName: "Origin",
      openingSkus: [{ sku_id: "RG-031", opening_qty: 3 }, { sku_id: "NK-011", opening_qty: 15 }],
    });
    expect(created.status).toBe(200);
    const stored = (await getStore({} as any, { id: DEMO_STAFF["B-MM"] }).desks()).find((d) => d.desk_id === created.json.desk.desk_id)!;
    expect(stored.created_by).toBe(DEMO_STAFF["B-MM"]);
    expect(stored.initial_stock).toEqual({ skus: { "RG-031": 3, "NK-011": 15 }, total_pcs: 18, total_baht: 16.5 });
  });

  it("GET /desks/:id/info returns creator name, original stock and its value", async () => {
    const staff = await asStaff("B-MM");
    const created = await call(staff, "POST", "/desks", { branchId: "B-MM", displayName: "Origin", openingSkus: [{ sku_id: "RG-031", opening_qty: 3 }] });
    const info = await call(staff, "GET", `/desks/${created.json.desk.desk_id}/info`);
    expect(info.status).toBe(200);
    expect(info.json.createdBy.id).toBe(DEMO_STAFF["B-MM"]);
    expect(typeof info.json.createdBy.name).toBe("string");
    expect(info.json.initial.skus).toEqual({ "RG-031": 3 });
    expect(info.json.initial.total_pcs).toBe(3);
    expect(info.json.initial.valueLak).toBeGreaterThan(0);
    // An older case with no recorded origin shows nulls rather than failing.
    const old = await call(staff, "GET", "/desks/MM-D01/info");
    expect(old.status).toBe(200);
    expect(old.json.createdBy).toBeNull();
    expect(old.json.initial).toBeNull();
  });

  it("GET /desks/:id/info refuses staff of another branch", async () => {
    const other = await asStaff("B-VTC");
    expect((await call(other, "GET", "/desks/MM-D01/info")).status).toBe(403);
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
  it("a Done day reopens with a reason and the redone chain carries the fix into today", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const desk = "MM-D02";
    expect((await call(admin, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY })).json.code).toBe("REASON_REQUIRED");

    // Today is already checked in when the mistake in yesterday is found.
    await call(staff, "POST", `/stock/desk/${desk}/checkin`, { date: TODAY });
    const openingBefore = rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty;
    const soldBefore = rowOf(await detailOf(staff, desk, YESTERDAY), "BR-020").retail_sale;

    expect((await call(admin, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY, reason: "wrong count" })).status).toBe(200);
    expect((await detailOf(admin, desk, YESTERDAY)).status).toBe("opening");
    expect((await detailOf(admin, desk, TODAY)).status).toBe("opening");
    // Today's card is in opening and still points at the earlier open day.
    const card = (await call(admin, "GET", "/stock/desks")).json.desks.find((d: any) => d.desk_id === desk);
    expect(card).toMatchObject({ status: "opening", openEarlierDate: YESTERDAY });
    expect((await checkIn(admin, desk, YESTERDAY)).status).toBe(200);
    // Two more sales were missed yesterday.
    await call(admin, "POST", `/stock/desk/${desk}/entries`, {
      date: YESTERDAY,
      changes: [{ sku_id: "BR-020", field: "retail_sale", to: soldBefore + 2 }],
    });
    expect((await closeDay(admin, desk, YESTERDAY)).status).toBe(200);
    expect(rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty).toBe(openingBefore - 2);

    const log = (await call(admin, "GET", "/audit")).json.entries;
    expect(log.find((e: any) => e.action === "desk_day.reopen")).toMatchObject({ target: `${desk}/${YESTERDAY}`, detail: { reason: "wrong count" } });
  });

  // Re-closing yesterday with a lower closing lowers today's opening. If today has
  // already sold that stock, the close must be refused whole, not left half done.
  const reopenAndLower = async (admin: any, desk: string, sku: string, by: number) => {
    expect((await call(admin, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY, reason: "wrong count" })).status).toBe(200);
    expect((await checkIn(admin, desk, YESTERDAY)).status).toBe(200);
    const sold = rowOf(await detailOf(admin, desk, YESTERDAY), sku).retail_sale;
    const res = await call(admin, "POST", `/stock/desk/${desk}/entries`, { date: YESTERDAY, changes: [{ sku_id: sku, field: "retail_sale", to: sold + by }] });
    expect(res.status).toBe(200);
    return closeDay(admin, desk, YESTERDAY);
  };

  it("refuses re-closing a day whose lower closing would push the next day negative, and writes nothing", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const desk = "MM-D02";
    await checkIn(staff, desk, TODAY);
    const open = rowOf(await detailOf(staff, desk, TODAY), "BR-020");
    expect(open.opening_qty).toBeGreaterThanOrEqual(3);
    // Today sells everything it opened with.
    expect((await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "BR-020", field: "retail_sale", to: open.opening_qty }] })).status).toBe(200);

    const res = await reopenAndLower(admin, desk, "BR-020", 2);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("NEXT_DAY_NEGATIVE");
    expect(res.json).toMatchObject({ sku_id: "BR-020", date: TODAY, available: 0 });
    expect((await detailOf(admin, desk, YESTERDAY)).status).not.toBe("done");
    expect(rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty).toBe(open.opening_qty);
  });

  it("closes fine when the lower closing keeps the next day non-negative, and today's opening follows", async () => {
    const admin = await asAdmin();
    const staff = await asStaff("B-MM");
    const desk = "MM-D02";
    await checkIn(staff, desk, TODAY);
    const open = rowOf(await detailOf(staff, desk, TODAY), "BR-020");
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "BR-020", field: "stock_in", to: 5 }] });
    await call(staff, "POST", `/stock/desk/${desk}/entries`, { date: TODAY, changes: [{ sku_id: "BR-020", field: "retail_sale", to: open.opening_qty }] });

    const res = await reopenAndLower(admin, desk, "BR-020", 2);
    expect(res.status).toBe(200);
    expect((await detailOf(admin, desk, YESTERDAY)).status).toBe("done");
    expect(rowOf(await detailOf(staff, desk, TODAY), "BR-020").opening_qty).toBe(open.opening_qty - 2);
  });
});

describe("linked transfers", () => {
  it("gold leaves the sender, stays in the company total while in transit, and lands when confirmed", async () => {
    // Same-branch hand-overs are instant Moves (test/moves.test.ts); this is the cross-branch send / receive flow.
    const staff = await asStaff("B-MM");
    const ts = await asStaff("B-VTC");
    const admin = await asAdmin();
    const total = async () => (await call(admin, "GET", "/dashboard")).json.portfolio.total_pcs;
    const totalBefore = await total();
    const fromBefore = rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001");

    expect((await call(staff, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "VTC-D02", skuId: "GB-001", qty: 999 })).json.code).toBe("NOT_ENOUGH_STOCK");
    const sent = await call(staff, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "VTC-D02", skuId: "GB-001", qty: 3 });
    expect(sent.status).toBe(200);
    expect(sent.json.kind).toBe("transfer"); // another branch

    const fromAfter = rowOf(await detailOf(staff, "MM-D01", TODAY), "GB-001");
    expect(fromAfter.transfer_out).toBe(fromBefore.transfer_out + 3);
    expect(fromAfter.closing_qty).toBe(fromBefore.closing_qty - 3);
    expect(await total()).toBe(totalBefore);
    expect((await call(admin, "GET", "/dashboard")).json.transit).toMatchObject({ count: 1, pcs: 3 });

    // The receiving desk must have an open day to receive into.
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/receive`, { date: TODAY })).json.code).toBe("NOT_CHECKED_IN");
    await call(ts, "POST", "/stock/desk/VTC-D02/checkin", { date: TODAY });
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/receive`, { date: TODAY })).status).toBe(200);
    expect((await call(ts, "POST", `/transfers/${sent.json.id}/receive`, { date: TODAY })).json.code).toBe("NOT_IN_TRANSIT");

    const received = rowOf(await detailOf(ts, "VTC-D02", TODAY), "GB-001");
    expect(received.transfer_in).toBe(3);
    expect(received.closing_qty).toBe(3);
    expect(await total()).toBe(totalBefore);
    expect((await call(admin, "GET", "/dashboard")).json.transit.count).toBe(0);
  });

  it("a transfer to another branch can be cancelled before it is received", async () => {
    const mm = await asStaff("B-MM");
    const ts = await asStaff("B-VTC");
    const before = rowOf(await detailOf(mm, "MM-D01", TODAY), "RG-030");
    const sent = await call(mm, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "VTC-D02", skuId: "RG-030", qty: 2 });
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
    await call(mm, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "VTC-D02", skuId: "RG-030", qty: 2 });
    expect((await closeDay(mm, "MM-D01", TODAY)).status).toBe(200);
  });
});

describe("documents", () => {
  it("numbers never repeat, even after a delete", async () => {
    const admin = await asAdmin();
    const make = async () =>
      (await call(admin, "POST", "/documents", { title: "Order", branchId: "B-MM", deskId: "MM-D01", rows: [{ item: "x", qty: 1 }] })).json;
    const first = await make();
    expect(first.doc_no).toBe("DOC-MM-2026-0003");
    expect((await call(admin, "DELETE", `/documents/${first.id}`)).status).toBe(200);
    expect((await make()).doc_no).toBe("DOC-MM-2026-0004");
  });

  it("a desk from another branch is refused", async () => {
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/documents", { title: "x", branchId: "B-MM", deskId: "VTC-D01", rows: [{ item: "x", qty: 1 }] })).json.code).toBe(
      "DESK_NOT_IN_BRANCH"
    );
  });

  it("proposals are approved once, by an admin", async () => {
    const manager = await asManager("B-MM");
    const admin = await asAdmin();
    const proposal = (await call(manager, "POST", "/documents", { title: "Order", branchId: "B-MM", deskId: "MM-D01", rows: [{ item: "Gold Bar", qty: 5 }] })).json;
    expect(proposal.status).toBe("pending");
    expect(proposal.kind).toBe("proposal");
    expect((await call(admin, "POST", "/documents/a0000000-0000-0000-0000-000000000001/decision", { decision: "approved" })).json.code).toBe("NOT_A_PROPOSAL");
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

  it("value follows the gold_prices sell price", async () => {
    const admin = await asAdmin();
    const dash = (await call(admin, "GET", "/dashboard?deskId=IT-D01")).json.portfolio;
    expect(dash.lak_value).toBe(dash.total_baht_gold * 43230000);
    expect(dash.spotLakPerBaht).toBe(43230000);
    const meta = (await call(admin, "GET", "/app-meta")).json;
    expect(meta.gold).toMatchObject({ lakPerBaht: 43230000, source: "gold_prices" });
  });

  it("the fallback price cannot be changed from the API; spotLakPerBaht is ignored", async () => {
    const admin = await asAdmin();
    const db = (getStore({} as never) as unknown as { db: { goldPrice: unknown } }).db;
    const saved = db.goldPrice;
    try {
      db.goldPrice = null;
      const before = (await call(admin, "GET", "/dashboard?deskId=IT-D01")).json.portfolio;
      expect(before.lak_value).toBe(before.total_baht_gold * 32500000);
      const res = await call(admin, "POST", "/settings/config", { spotLakPerBaht: 40000000 });
      expect(res.status).toBe(200);
      const after = (await call(admin, "GET", "/dashboard?deskId=IT-D01")).json.portfolio;
      expect(after.lak_value).toBe(before.total_baht_gold * 32500000);
    } finally {
      db.goldPrice = saved;
    }
  });

  it("a past day's desk detail is valued at that day's snapshot price", async () => {
    const admin = await asAdmin();
    const db = (getStore({} as never) as unknown as { db: { goldHistory: unknown[] } }).db;
    db.goldHistory = [{ price_date: YESTERDAY, price_baht_sell: 30000000 }];
    const past = await detailOf(admin, "IT-D01", YESTERDAY);
    const now = await detailOf(admin, "IT-D01", TODAY);
    const baht = (d: any) => d.rows.reduce((s: number, r: any) => s + r.closing_baht, 0);
    expect(past.totals.valueLak).toBeGreaterThan(0);
    expect(past.totals.valueLak).toBeCloseTo(baht(past) * 30000000, -3);
    expect(now.totals.valueLak).toBeCloseTo(baht(now) * 43230000, -3);
  });

  it("low stock follows the branch status everywhere", async () => {
    const admin = await asAdmin();
    const row = rowOf(await detailOf(admin, "IT-D01", TODAY), "GB-001");
    expect(row.threshold).toBeUndefined();
    expect(["order_now", "late", "ordered", "ok", "no_min"]).toContain(row.branch_status);
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
  it("a SKU is one Lao name + type + size; editing sets the name and the planning numbers", async () => {
    const admin = await asAdmin();
    // A typed size is dropped: the name is the product only (2026-11-17).
    const made = await call(admin, "POST", "/skus", { sku_id: "LAO-1", name: "ແຫວນ 1 ສະຫຼຶງ", type_id: "RINGS_ACCESSORIES", weight_id: "BAHT_025", purity: "96.5%", unit_price_lak: 5, reorder_level: 9, branchId: "B-MM" });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ name_lo: "ແຫວນ", name_en: "ແຫວນ", baht_weight: 0.25, purity: null, unit_price_lak: 0, group_name: null });
    expect((await call(admin, "POST", "/skus", { name: " ", type_id: "RINGS_ACCESSORIES", weight_id: "BAHT_025", branchId: "B-MM" })).status).toBe(400);

    const rules = async () => (await getStore({} as any).rules()).filter((x) => x.scope === "sku" && x.scope_key === "LAO-1");
    const edited = await call(admin, "PATCH", "/skus/LAO-1", { name: "ແຫວນໃໝ່", detail: "ເບີ8-23", weight_id: "BAHT_1", min_qty: 2, lead_time_days: 5, branchId: "B-MM" });
    expect(edited.json).toMatchObject({ name_lo: "ແຫວນໃໝ່", name_en: "ແຫວນໃໝ່", baht_weight: 1, detail: "ເບີ8-23" });
    expect(await rules()).toMatchObject([{ min_qty: 2, lead_time_days: 5, branch_id: "B-MM" }]);
    expect((await call(admin, "PATCH", "/skus/LAO-1", { min_qty: 2 })).json.code).toBe("BRANCH_REQUIRED");
    // Blank = inherit: both blank removes the SKU rule.
    await call(admin, "PATCH", "/skus/LAO-1", { min_qty: null, lead_time_days: "", branchId: "B-MM" });
    expect(await rules()).toEqual([]);
    expect((await call(admin, "PATCH", "/skus/LAO-1", { min_qty: -1 })).status).toBe(400);
    expect((await call(admin, "PATCH", "/skus/LAO-1", { min_qty: 1.5, branchId: "B-MM" })).status).toBe(400);
  });

  // Import / export: test/skuImport.api.test.ts.
  it("min stock and lead time on create become SKU rules in the branches given", async () => {
    const admin = await asAdmin();
    const row = async (id: string) => {
      const rule = (await getStore({} as any).rules()).find((x) => x.scope === "sku" && x.scope_key === id && x.branch_id === "B-VT");
      return rule ? { min: { value: rule.min_qty, source: "sku" }, lead: { value: rule.lead_time_days, source: "sku" } } : undefined;
    };

    expect((await call(admin, "POST", "/skus", { sku_id: "NEW-0", name: "New 0", type_id: "GOLD_BARS", weight_id: "BAHT_1", min_qty: 4 })).json.code).toBe("BRANCH_REQUIRED");
    const made = await call(admin, "POST", "/skus", { sku_id: "NEW-1", name: "New A", type_id: "GOLD_BARS", weight_id: "BAHT_1", min_qty: 4, lead_time_days: 6, group: "Fresh", allBranches: true });
    expect(made.status).toBe(200);
    expect(made.json.group_name).toBe(null);
    expect(await row("NEW-1")).toMatchObject({ min: { value: 4 }, lead: { value: 6 } });
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

// Staff and managers see only their own branch in every report (2026-11-17).
describe("branch scope", () => {
  const branchesIn = (rows: any[]) => new Set(rows.map((r: any) => r.branch_id));

  it("staff dashboard only has own branch", async () => {
    const staff = await asStaff("B-MM");
    const dash = (await call(staff, "GET", "/dashboard?branchId=B-VTC")).json;
    expect(dash.branchCards.map((b: any) => b.branch_id)).toEqual(["B-MM"]);
    for (const item of dash.watchlist.topLow) expect(item.branch_id).toBe("B-MM");
  });

  it("manager report only has own branch", async () => {
    const manager = await asManager("B-MM");
    const res = await call(manager, "GET", "/report?branchId=B-VTC");
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.json);
    for (const other of ["VTC-D01", "IT-D01", "VT-D01"]) expect(text).not.toContain(other);
    expect(text).toContain("MM-D01");
  });

  it("staff audit only has own branch", async () => {
    const staff = await asStaff("B-MM");
    expect((await call(staff, "GET", "/audit?deskId=VTC-D01")).status).toBe(403);
    expect((await call(staff, "GET", "/audit?branchId=B-VTC")).status).toBe(403);
    const mine = await call(staff, "GET", "/audit?deskId=MM-D01");
    expect(mine.status).toBe(200);
    const branch = await call(staff, "GET", "/audit");
    expect(branch.status).toBe(200);
    for (const e of branch.json.entries) expect([e.branch_id, e.to_branch_id]).toContain("B-MM");
    const manager = await asManager("B-MM");
    expect((await call(manager, "GET", "/audit?branchId=B-VTC")).status).toBe(403);
  });

  it("admin dashboard reorder count = sum of per-branch counts", async () => {
    const admin = await asAdmin();
    // GB-001: order now at Morning Market only (huge min there), calm everywhere else.
    await call(admin, "PUT", "/replenishment/rules", { scope: "sku", key: "GB-001", branchId: "B-MM", minQty: 5000, leadTimeDays: 7 });
    await call(admin, "PUT", "/replenishment/rules", { scope: "sku", key: "GB-001", branchId: "B-VT", minQty: 0, leadTimeDays: 7 });
    const mm = (await call(admin, "GET", "/replenishment?branchId=B-MM")).json.rows.find((r: any) => r.sku_id === "GB-001");
    const vt = (await call(admin, "GET", "/replenishment?branchId=B-VT")).json.rows.find((r: any) => r.sku_id === "GB-001");
    expect(mm.status).toBe("order_now");
    expect(vt.status).toBe("ok");
    const all = (await call(admin, "GET", "/dashboard")).json;
    const perBranch = await Promise.all(["B-MM", "B-VTC", "B-IT", "B-VT"].map(async (b) => (await call(admin, "GET", `/dashboard?branchId=${b}`)).json.watchlist.lowCount));
    expect(all.watchlist.lowCount).toBe(perBranch.reduce((a, n) => a + n, 0));
    const gb = all.watchlist.topLow.filter((i: any) => i.sku_id === "GB-001");
    // Each branch follows its own rule: listed at Morning Market, not at Vangthong.
    expect(branchesIn(gb).has("B-MM")).toBe(true);
    expect(branchesIn(gb).has("B-VT")).toBe(false);
  });
});

describe("SKU per branch", () => {
  const skuOf = async (s: any, id: string, branch?: string) =>
    (await call(s, "GET", `/skus${branch ? `?branchId=${branch}` : ""}`)).json.skus.find((x: any) => x.sku_id === id);
  const carriedIn = async (id: string) =>
    (await getStore({} as any).branchSkus()).filter((b) => b.sku_id === id && b.carried).map((b) => b.branch_id).sort();
  const newSku = { name: "ແຫວນໃໝ່", type_id: "RINGS_ACCESSORIES", weight_id: "BAHT_025" };

  it("staff creates SKU carried only in own branch", async () => {
    const staff = await asStaff("B-MM");
    const made = await call(staff, "POST", "/skus", { ...newSku, sku_id: "ST-1", min_qty: 2, branchId: "B-MM" });
    expect(made.status).toBe(200);
    expect(await carriedIn("ST-1")).toEqual(["B-MM"]);
    expect(await skuOf(staff, "ST-1")).toMatchObject({ carried: true, plan: { min: 2, lead: null } });
    expect((await call(staff, "POST", "/skus", { ...newSku, sku_id: "ST-2", branchId: "B-VT" })).json.code).toBe("BRANCH_DENIED");
  });

  // Decided 2026-11-17: an admin's new SKU follows the "apply to every branch" tick.
  it("admin SKU follows the tick", async () => {
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/skus", { ...newSku, sku_id: "AD-1", branchId: "B-VT" })).status).toBe(200);
    expect(await carriedIn("AD-1")).toEqual(["B-VT"]);
    expect((await call(admin, "POST", "/skus", { ...newSku, sku_id: "AD-2", allBranches: true })).status).toBe(200);
    expect(await carriedIn("AD-2")).toEqual(["B-IT", "B-MM", "B-VT", "B-VTC"]);
    expect((await call(admin, "POST", "/skus", { ...newSku, sku_id: "AD-3" })).json.code).toBe("BRANCH_REQUIRED");
  });

  it("staff rename is refused", async () => {
    for (const s of [await asStaff("B-MM"), await asManager("B-MM")]) {
      for (const body of [{ name: "x" }, { type_id: "GOLD_BARS" }, { weight_id: "BAHT_1" }, { active: false }]) {
        const res = await call(s, "PATCH", "/skus/GB-001", body);
        expect(res.status).toBe(403);
        expect(res.json.code).toBe("ROLE_DENIED");
      }
    }
  });

  it("staff sets own min; other branch unchanged", async () => {
    const staff = await asStaff("B-MM");
    expect((await call(staff, "PATCH", "/skus/GB-001", { min_qty: 9, lead_time_days: 1 })).status).toBe(200);
    expect((await skuOf(staff, "GB-001")).plan).toEqual({ min: 9, lead: 1 });
    expect((await skuOf(await asAdmin(), "GB-001", "B-VT")).plan).toEqual({ min: 13, lead: 3 });
    expect((await call(staff, "PATCH", "/skus/GB-001", { min_qty: 9, branchId: "B-VT" })).json.code).toBe("BRANCH_DENIED");
  });

  it("a SKU edit with nothing to change is refused and not audited", async () => {
    const staff = await asStaff("B-MM");
    const before = (await getStore({} as any).auditLog({ limit: 500 })).length;
    const res = await call(staff, "PATCH", "/skus/GB-001", { branchId: "B-MM" });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("NOTHING_TO_CHANGE");
    expect((await getStore({} as any).auditLog({ limit: 500 })).length).toBe(before);
  });

  it("carried off refused while stock held", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "PUT", "/skus/GB-001/carried", { carried: false });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("STOCK_HELD");
    expect((await skuOf(staff, "GB-001")).carried).toBe(true);
  });

  it("carried off refused while inbound", async () => {
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "VTC-D01", skuId: "GB-001", qty: 3 })).status).toBe(200);
    expect((await call(admin, "PUT", "/skus/GB-001/carried", { branchId: "B-VTC", carried: false })).json.code).toBe("STOCK_HELD");
  });

  it("carried off allowed at zero", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "PUT", "/skus/SP-904/carried", { carried: false });
    expect(res.status).toBe(200);
    expect((await skuOf(staff, "SP-904")).carried).toBe(false);
    expect((await skuOf(await asAdmin(), "SP-904", "B-VT")).carried).toBe(true);
    expect((await call(staff, "PUT", "/skus/SP-904/carried", { branchId: "B-VT", carried: false })).json.code).toBe("BRANCH_DENIED");
    const log = await getStore({} as any).auditLog({ limit: 5 });
    expect(log.some((e) => e.action === "sku.carried")).toBe(true);
    expect((await call(staff, "PUT", "/skus/SP-904/carried", { carried: true })).status).toBe(200);
    expect((await skuOf(staff, "SP-904")).carried).toBe(true);
  });
});

describe("branch manager", () => {
  it("sees only own branch", async () => {
    const manager = await asManager("B-MM");
    const cards = (await call(manager, "GET", "/stock/desks?branchId=B-VTC")).json.desks;
    expect(new Set(cards.map((d: any) => d.branch_id))).toEqual(new Set(["B-MM"]));
    expect((await call(manager, "GET", `/stock/desk/VTC-D01?date=${TODAY}`)).status).toBe(403);
    const meta = (await call(manager, "GET", "/app-meta")).json;
    expect(new Set(meta.desks.map((d: any) => d.branch_id))).toEqual(new Set(["B-MM"]));
    expect(meta.user.role).toBe("manager");
  });

  it("reopens a Done day within 3 days with a reason", async () => {
    const manager = await asManager("B-MM");
    const desk = "MM-D02";
    expect((await call(manager, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY })).json.code).toBe("REASON_REQUIRED");
    expect((await call(manager, "POST", `/stock/desk/${desk}/reopen`, { date: YESTERDAY, reason: "wrong count" })).status).toBe(200);
    expect((await detailOf(manager, desk, YESTERDAY)).status).toBe("opening");
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
    expect((await call(manager, "POST", "/stock/desk/VTC-D01/reopen", { date: YESTERDAY, reason: "other branch" })).status).toBe(403);
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
    expect((await call(manager, "POST", "/sku-types", { name_en: "X" })).status).toBe(403);
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
    expect((await call(manager, "PATCH", `/users/${DEMO_STAFF["B-VTC"]}`, { unlock: true })).status).toBe(403);
  });

  it("admin can create a manager; a manager without a branch is refused", async () => {
    const admin = await asAdmin();
    const bad = await call(admin, "POST", "/users", { displayName: "Boss", username: "boss", role: "manager", password: "222222" });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("BAD_BRANCH");
    const ok = await call(admin, "POST", "/users", { displayName: "Boss", username: "boss", role: "manager", branchId: "B-VTC", password: "222222" });
    expect(ok.status).toBe(200);
    const session = await login(ok.json.id, "222222");
    expect((await call(session, "GET", "/auth/me")).json.user.role).toBe("manager");
    const summary = (await call(admin, "GET", "/settings/summary")).json.staff;
    expect(summary.roleCounts.manager).toBe(2);
  });
});

describe("compare-and-set entries and one-step close", () => {
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
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "counted_qty", to: 5 }] })).json.code).toBe("BAD_FIELD");
    // opening_qty is a real field, but not in the check_in step.
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "opening_qty", to: 5 }] })).json.code).toBe("FIELD_NOT_IN_STEP");
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "retail_sale", to: -1 }] })).json.code).toBe("BAD_QTY");
    expect((await entries(staff, { changes: [{ sku_id: "GB-001", field: "retail_sale", from: "x", to: 1 }] })).json.code).toBe("BAD_QTY");
    expect((await entries(staff, { changes: [{ sku_id: "NOPE", field: "retail_sale", to: 1 }] })).json.code).toBe("ROW_NOT_FOUND");
  });

  it("close goes straight from check_in to done, with no count", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "POST", "/stock/desk/MM-D01/close", { date: TODAY, safe_drop_note: "dropped" });
    expect(res.status).toBe(200);
    expect((await detailOf(staff, "MM-D01", TODAY)).status).toBe("done");
    const tomorrow = on(staff, TOMORROW);
    expect((await call(tomorrow, "POST", "/stock/desk/MM-D01/checkin", { date: TOMORROW })).status).toBe(200);
  });

  it("close also works from final_stock and refuses a Done day", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", "/stock/desk/MM-D01/transition", { date: TODAY, toStatus: "final_stock" });
    expect((await call(staff, "POST", "/stock/desk/MM-D01/close", { date: TODAY })).status).toBe(200);
    expect((await call(staff, "POST", "/stock/desk/MM-D01/close", { date: TODAY })).status).toBe(423);
  });
});

describe("cards: streak, tier, value and branch summary (CR3)", () => {
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
    expect(cards.find((d: any) => d.desk_id === "MM-D03")).toMatchObject({ tier: "on_track", streak: 0, daysBehind: 0 });
    expect(cards.find((d: any) => d.desk_id === "MM-D03")).not.toHaveProperty("assignee");
    expect(res.json.branchSummary).toEqual({ cases: 4, checkedToday: 0, behind1: 0, overdue: 1 });
  });

  it("a closed day keeps the streak and is not behind", async () => {
    await call(await asAdmin(), "POST", "/closed-days", { branchId: "B-IT", date: YESTERDAY, reason: "Holiday" });
    const cards = (await call(await asStaff("B-IT"), "GET", "/stock/desks")).json.desks;
    // IT-D01 was Done the last 4 days including today; yesterday is closed.
    expect(cards.find((d: any) => d.desk_id === "IT-D01")).toMatchObject({ tier: "done_today", streak: 3 });
  });

  it("cards carry valueLak and lastActorAt, and no holder fields", async () => {
    const res = await call(await asStaff("B-MM"), "GET", "/stock/desks");
    const cards = res.json.desks.filter((d: any) => d.branch_id === "B-MM");
    for (const card of cards) {
      expect(typeof card.valueLak).toBe("number");
      expect(card).toHaveProperty("lastActorAt");
      expect(card).not.toHaveProperty("assignee");
      expect(card).not.toHaveProperty("holder");
      expect(card).not.toHaveProperty("canTake");
    }
    const d01 = cards.find((d: any) => d.desk_id === "MM-D01");
    expect(d01.valueLak).toBeGreaterThan(0);
    expect(d01.lastActorName && d01.lastActorAt).toBeTruthy();
  });

  it("the retired /cases and assign routes are gone", async () => {
    const m = await asManager("B-MM");
    expect((await call(m, "POST", "/cases/assign", { deskId: "MM-D01", staffId: DEMO_STAFF["B-MM"] })).status).toBe(404);
    expect((await call(m, "GET", "/my-cases")).status).toBe(404);
    expect((await call(m, "POST", "/desks/MM-D01/assign", { staffId: DEMO_STAFF["B-MM"] })).status).toBe(404);
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
    const staff = await asStaff("B-VTC");
    const env = { KPV_DATA_MODE: "test" };
    const a = await call(admin, "GET", "/meta", undefined, TODAY, env);
    expect(a.json.dataMode).toBe("test");
    expect(a.json.seedRows).toBeGreaterThan(0);
    expect((await call(staff, "GET", "/meta", undefined, TODAY, env)).json.seedRows).toBeNull();
    expect((await call(null, "GET", "/meta", undefined, TODAY, env)).json.seedRows).toBeNull();
  });

  it("refuses a transfer or move between a real case and a mock case (MIXED_TEST_TRANSFER)", async () => {
    const staff = await asStaff("B-MM"); // first request builds the demo store for TODAY
    db().desks.find((d: any) => d.desk_id === "VTC-D02").is_seed = true;
    const sent = await call(staff, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "VTC-D02", skuId: "GB-001", qty: 1 });
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

describe("case history and issue grid", () => {
  it("GET /desks/:id/history returns newest-first rows with nextTo", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "GET", "/desks/MM-D01/history?days=2");
    expect(res.status).toBe(200);
    const dates = res.json.rows.map((r: any) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(res.json.rows.length).toBeGreaterThan(0);
    expect(res.json.rows.length).toBeLessThanOrEqual(2);
    expect(res.json.rows[0].date).toBe(TODAY);
    expect(res.json.nextTo).toBe("2026-11-10");
    // A window reaching the first recorded day has no further page.
    const all = await call(staff, "GET", "/desks/MM-D01/history?days=90");
    expect(all.json.nextTo).toBeNull();
  });

  it("history refuses another branch, bad dates and caps days", async () => {
    expect((await call(await asStaff("B-VTC"), "GET", "/desks/MM-D01/history")).status).toBe(403);
    const staff = await asStaff("B-MM");
    expect((await call(staff, "GET", "/desks/MM-D01/history?to=nope")).status).toBe(400);
    expect((await call(staff, "GET", "/desks/MM-D01/history?days=0")).status).toBe(400);
    expect((await call(staff, "GET", "/desks/NOPE/history")).status).toBe(404);
    const capped = await call(staff, "GET", "/desks/MM-D01/history?days=500");
    expect(capped.status).toBe(200);
    expect(capped.json.rows.length).toBeLessThanOrEqual(90);
  });

  it("history flags a reopened day and a short window matches the full one", async () => {
    const staff = await asStaff("B-MM");
    const full = (await call(staff, "GET", "/desks/MM-D01/history?days=90")).json.rows;
    const lastDone = full.find((r: any) => r.state === "done");
    expect(lastDone).toBeTruthy();
    // Cutting the window to one day must not invent a chain break.
    const one = await call(staff, "GET", `/desks/MM-D01/history?to=${lastDone.date}&days=1`);
    expect(one.json.rows).toEqual([lastDone]);
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/stock/desk/MM-D01/reopen", { date: lastDone.date, reason: "recount" })).status).toBe(200);
    const after = (await call(staff, "GET", "/desks/MM-D01/history?days=90")).json.rows;
    expect(after.find((r: any) => r.date === lastDone.date).flags).toContain("reopened");
  });

  it("GET /report/grid has one row per active desk and one column per day", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "GET", "/report/grid?month=2026-11");
    expect(res.status).toBe(200);
    expect(res.json.dates).toHaveLength(30);
    const desks = (await getStore({} as any).desks()).filter((d) => d.branch_id === "B-MM" && d.active);
    expect(res.json.rows.map((r: any) => r.deskId).sort()).toEqual(desks.map((d) => d.desk_id).sort());
    for (const row of res.json.rows) expect(row.cells).toHaveLength(30);
  });

  it("grid: admin must name a branch, others are scoped, bad month is 400", async () => {
    const admin = await asAdmin();
    expect((await call(admin, "GET", "/report/grid?month=2026-11")).status).toBe(400);
    expect((await call(admin, "GET", "/report/grid?month=2026-11&branch=B-VTC")).status).toBe(200);
    const staff = await asStaff("B-MM");
    expect((await call(staff, "GET", "/report/grid?month=bad")).status).toBe(400);
    const other = await call(staff, "GET", "/report/grid?month=2026-11&branch=B-VTC");
    expect(other.json.rows.every((r: any) => r.deskId.startsWith("MM-"))).toBe(true);
  });

  it("grid: a case last checked long ago does not widen the month read", async () => {
    const store = getStore({} as any) as any;
    const row = store.db.ledger.find((r: any) => r.desk_id === "MM-D02");
    const template = store.db.deskDays.find((d: any) => d.desk_id === "MM-D02");
    const old = "2026-08-03";
    // MM-D02's only earlier day is the August one.
    store.db.deskDays = store.db.deskDays.filter((d: any) => d.desk_id !== "MM-D02" || d.ledger_date >= "2026-11-01");
    store.db.deskDays.push({ ...template, ledger_date: old, status: "done" });
    store.db.ledger.push({ ...row, ledger_date: old });
    const spy = vi.spyOn(Object.getPrototypeOf(store), "ledger");
    const res = await call(await asStaff("B-MM"), "GET", "/report/grid?month=2026-11");
    expect(res.status).toBe(200);
    const calls = spy.mock.calls.map((c: any) => c[0]);
    spy.mockRestore();
    // One month-bounded read and one exact-pairs read; nothing reaches back to August by range.
    expect(calls.filter((f: any) => f.from && f.from < "2026-11-01")).toHaveLength(0);
    expect(calls.some((f: any) => f.pairs?.some((p: any) => p.deskId === "MM-D02" && p.date === old))).toBe(true);
    expect(res.json.rows).toHaveLength(store.db.desks.filter((d: any) => d.branch_id === "B-MM" && d.active).length);
  });
});

// Decided 2026-11-19: main cases, sizes as qty + unit + grams, one type name.
describe("main cases, sizes and type names", () => {
  it("a branch manager sets a person's main cases; they come first for that person only", async () => {
    const manager = await asManager("B-MM");
    const staffId = DEMO_STAFF["B-MM"];
    expect((await call(manager, "PUT", `/users/${staffId}/cases`, { deskIds: ["MM-D02"] })).status).toBe(200);
    expect((await call(manager, "GET", `/users/${staffId}/cases`)).json.deskIds).toEqual(["MM-D02"]);
    // Another branch's case, or another branch's person.
    expect((await call(manager, "PUT", `/users/${staffId}/cases`, { deskIds: ["VTC-D01"] })).json.code).toBe("ASSIGN_OTHER_BRANCH");
    expect((await call(manager, "PUT", `/users/${DEMO_STAFF["B-VTC"]}/cases`, { deskIds: [] })).status).toBe(403);
    // Staff cannot set them.
    const staff = await asStaff("B-MM");
    expect((await call(staff, "PUT", `/users/${staffId}/cases`, { deskIds: [] })).status).toBe(403);

    const mine = (await call(staff, "GET", "/stock/desks?branchId=B-MM")).json.desks;
    expect(mine.filter((d: any) => d.mine).map((d: any) => d.desk_id)).toEqual(["MM-D02"]);
    const others = (await call(manager, "GET", "/stock/desks?branchId=B-MM")).json.desks;
    expect(others.some((d: any) => d.mine)).toBe(false);
  });

  it("each case card carries its weight in grams", async () => {
    const admin = await asAdmin();
    const card = (await call(admin, "GET", "/stock/desks?branchId=B-MM")).json.desks.find((d: any) => d.desk_id === "MM-D01");
    expect(card.totalGram).toBeGreaterThan(0);
    expect(card.totalGram / card.totalBaht).toBeCloseTo(15.244, 0);
  });

  it("a size is qty + any unit + the grams typed; the label is 'qty unit'", async () => {
    const admin = await asAdmin();
    const made = (await call(admin, "POST", "/sku-weights", { qty: 8, unit: "ບາດ", gram_value: 120 })).json;
    expect(made).toMatchObject({ name_en: "8 ບາດ", qty: 8, unit: "ບາດ", gram_value: 120 });
    expect((await call(admin, "POST", "/sku-weights", { qty: 8, unit: "ບາດ", gram_value: 121 })).json.code).toBe("WEIGHT_EXISTS");
    expect((await call(admin, "POST", "/sku-weights", { qty: 1, unit: "ແທ່ງ", gram_value: 0 })).json.code).toBe("BAD_WEIGHT");
    const custom = (await call(admin, "POST", "/sku-weights", { qty: 1, unit: "ແທ່ງ", gram_value: 50 })).json;
    expect(custom.name_en).toBe("1 ແທ່ງ");
    const edited = (await call(admin, "PATCH", `/sku-weights/${made.weight_id}`, { qty: 10, gram_value: 150 })).json;
    expect(edited).toMatchObject({ name_en: "10 ບາດ", unit: "ບາດ", gram_value: 150 });
  });

  it("a type has one name; renaming it renames it everywhere", async () => {
    const admin = await asAdmin();
    const made = (await call(admin, "POST", "/sku-types", { name: "ສາຍແອວ", icon: "ring" })).json;
    expect(made).toMatchObject({ name_en: "ສາຍແອວ", name_lo: "ສາຍແອວ" });
    expect(made.type_id).toBeTruthy();
    expect((await call(admin, "POST", "/sku-types", { name: "ສາຍແອວ" })).json.code).toBe("TYPE_EXISTS");
    await call(admin, "PATCH", "/sku-types/GOLD_BARS", { name: "ຄຳແທ່ງໃໝ່" });
    const type = (await call(admin, "GET", "/sku-types")).json.types.find((t: any) => t.type_id === "GOLD_BARS");
    expect(type).toMatchObject({ name_en: "ຄຳແທ່ງໃໝ່", name_lo: "ຄຳແທ່ງໃໝ່" });
    const bar = (await call(admin, "GET", "/skus")).json.skus.find((s: any) => s.sku_id === "GB-001");
    expect(bar.category).toBe("ຄຳແທ່ງໃໝ່");
  });
});
