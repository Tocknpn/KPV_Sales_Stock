// Branch closed days and case assignment with handover history.
// Demo data: B-MM has cases MM-D01 and MM-D02, staff Somchai (DEMO_STAFF), Noy (DEMO_STAFF_MM2)
// and manager Manivone. No assignments exist at the start.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_STAFF, DEMO_STAFF_MM2, DEMO_MANAGER } from "../src/demoData";
import { DemoStore, StoreError, getStore } from "../src/store";
import { freshApp, call, asAdmin, asStaff, asManager, TODAY } from "./helpers";

beforeEach(freshApp);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOMCHAI = DEMO_STAFF["B-MM"];
const NOY = DEMO_STAFF_MM2;
const assign = (s: any, desk: string, staffId: string, note?: string) => call(s, "POST", `/desks/${desk}/assign`, { staffId, note });

describe("closed days", () => {
  it("staff cannot add a closed day", async () => {
    const res = await call(await asStaff("B-MM"), "POST", "/closed-days", { branchId: "B-MM", date: "2026-12-25", reason: "Holiday" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("ROLE_DENIED");
  });

  it("manager adds for own branch, not another, and not 'all'", async () => {
    const m = await asManager("B-MM");
    const ok = await call(m, "POST", "/closed-days", { branchId: "B-MM", date: "2026-12-25", reason: "Holiday" });
    expect(ok.status).toBe(200);
    expect(ok.json.added).toHaveLength(1);
    expect((await call(m, "POST", "/closed-days", { branchId: "B-TS", date: "2026-12-25", reason: "x" })).status).toBe(403);
    const all = await call(m, "POST", "/closed-days", { branchId: "all", date: "2026-12-26", reason: "x" });
    expect(all.status).toBe(403);
    expect(all.json.code).toBe("ROLE_DENIED");
  });

  it("admin 'all' adds one row per branch and skips dates that already exist", async () => {
    const admin = await asAdmin();
    const branches = (await getStore({} as any).branches()).length;
    await call(admin, "POST", "/closed-days", { branchId: "B-MM", date: "2026-12-25", reason: "Local" });
    const res = await call(admin, "POST", "/closed-days", { branchId: "all", date: "2026-12-25", reason: "National day" });
    expect(res.status).toBe(200);
    expect(res.json.added).toHaveLength(branches - 1);
    expect(res.json.skipped).toBe(1);
    const list = await call(admin, "GET", "/closed-days?from=2026-12-01&to=2026-12-31");
    expect(list.json.closedDays).toHaveLength(branches);
    expect(list.json.closedDays.find((d: any) => d.branch_id === "B-MM").reason).toBe("Local");
  });

  it("rejects a bad date, an empty reason and an unknown branch", async () => {
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/closed-days", { branchId: "B-MM", date: "nope", reason: "x" })).json.code).toBe("BAD_DATE");
    expect((await call(admin, "POST", "/closed-days", { branchId: "B-MM", date: "2026-12-25", reason: "  " })).json.code).toBe("BAD_REASON");
    expect((await call(admin, "POST", "/closed-days", { branchId: "B-XX", date: "2026-12-25", reason: "x" })).json.code).toBe("BAD_BRANCH");
  });

  it("staff and managers only list their own branch; admin filters by branch", async () => {
    const admin = await asAdmin();
    await call(admin, "POST", "/closed-days", { branchId: "all", date: "2026-12-25", reason: "x" });
    const staff = await call(await asStaff("B-MM"), "GET", "/closed-days?branchId=B-TS");
    expect(staff.json.closedDays.map((d: any) => d.branch_id)).toEqual(["B-MM"]);
    const mgr = await call(await asManager("B-MM"), "GET", "/closed-days");
    expect(mgr.json.closedDays.map((d: any) => d.branch_id)).toEqual(["B-MM"]);
    const ts = await call(admin, "GET", "/closed-days?branchId=B-TS");
    expect(ts.json.closedDays.map((d: any) => d.branch_id)).toEqual(["B-TS"]);
    expect((await call(admin, "GET", "/closed-days?from=bad")).status).toBe(400);
  });

  it("manager removes own branch's day; staff cannot; other branch refused", async () => {
    const admin = await asAdmin();
    await call(admin, "POST", "/closed-days", { branchId: "all", date: "2026-12-25", reason: "x" });
    expect((await call(await asStaff("B-MM"), "DELETE", "/closed-days?branchId=B-MM&date=2026-12-25")).status).toBe(403);
    const m = await asManager("B-MM");
    expect((await call(m, "DELETE", "/closed-days?branchId=B-TS&date=2026-12-25")).status).toBe(403);
    expect((await call(m, "DELETE", "/closed-days?branchId=B-MM&date=2026-12-25")).status).toBe(200);
    expect((await call(m, "DELETE", "/closed-days?branchId=B-MM&date=2026-12-25")).status).toBe(404);
    expect((await call(m, "GET", "/closed-days")).json.closedDays).toHaveLength(0);
  });
});

describe("case assignment", () => {
  it("one active holder per case; handover ends the previous row with ended_by", async () => {
    const m = await asManager("B-MM");
    await assign(m, "MM-D01", SOMCHAI);
    const res = await assign(m, "MM-D01", NOY, "lunch cover");
    expect(res.status).toBe(200);
    expect(res.json.assignment.staff_id).toBe(NOY);
    const store = getStore({ DEMO_DATE: "2026-11-12" } as any);
    const active = await store.activeAssignments({ branchId: "B-MM" });
    expect(active.filter((a) => a.desk_id === "MM-D01").map((a) => a.staff_id)).toEqual([NOY]);
    const db = (store as any).db;
    const ended = db.assignments.find((a: any) => a.staff_id === SOMCHAI);
    expect(ended.ended_at).not.toBeNull();
    expect(ended.ended_by).toBe(DEMO_MANAGER["B-MM"]);
  });

  it("assigning the current holder again returns the existing row", async () => {
    const m = await asManager("B-MM");
    const a = await assign(m, "MM-D01", SOMCHAI);
    const b = await assign(m, "MM-D01", SOMCHAI);
    expect(b.json.assignment.id).toBe(a.json.assignment.id);
    expect((getStore({} as any) as any).db.assignments).toHaveLength(1);
  });

  it("one staff member can hold several cases", async () => {
    const m = await asManager("B-MM");
    await assign(m, "MM-D01", SOMCHAI);
    await assign(m, "MM-D02", SOMCHAI);
    const mine = (await call(await asStaff("B-MM"), "GET", "/my-cases")).json.mine;
    expect(mine.map((a: any) => a.desk_id).sort()).toEqual(["MM-D01", "MM-D02"]);
  });

  it("staff can take a free case and hand it to a colleague, but not take over another holder's case", async () => {
    const s = await asStaff("B-MM");
    expect((await assign(s, "MM-D01", SOMCHAI)).status).toBe(200);
    expect((await assign(s, "MM-D01", NOY)).status).toBe(200);
    const back = await assign(s, "MM-D01", SOMCHAI);
    expect(back.status).toBe(403);
    expect(back.json.code).toBe("NOT_HOLDER");
    // a free case cannot be handed to someone else by staff either
    const free = await assign(s, "MM-D02", NOY);
    expect(free.status).toBe(403);
    expect(free.json.code).toBe("NOT_HOLDER");
  });

  it("staff can release their own case but not another's", async () => {
    const s = await asStaff("B-MM");
    await assign(s, "MM-D01", SOMCHAI);
    await assign(await asManager("B-MM"), "MM-D02", NOY);
    expect((await call(s, "POST", "/desks/MM-D02/release")).json.code).toBe("NOT_HOLDER");
    expect((await call(s, "POST", "/desks/MM-D01/release")).status).toBe(200);
    expect((await call(s, "GET", "/my-cases")).json.mine).toHaveLength(0);
  });

  it("manager assigns anyone in the branch; cross-branch staff is ASSIGN_OTHER_BRANCH", async () => {
    const m = await asManager("B-MM");
    expect((await assign(m, "MM-D01", NOY)).status).toBe(200);
    const cross = await assign(m, "MM-D01", DEMO_STAFF["B-TS"]);
    expect(cross.status).toBe(400);
    expect(cross.json.code).toBe("ASSIGN_OTHER_BRANCH");
    expect((await assign(m, "TS-D01", DEMO_STAFF["B-TS"])).status).toBe(403);
    expect((await assign(await asAdmin(), "TS-D01", DEMO_STAFF["B-TS"])).status).toBe(200);
  });

  it("an inactive staff member cannot be assigned", async () => {
    const admin = await asAdmin();
    await call(admin, "PATCH", `/users/${NOY}`, { active: false });
    const res = await assign(admin, "MM-D01", NOY);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("ASSIGN_INACTIVE");
  });

  it("deactivating or moving a staff member to another branch ends their assignments", async () => {
    const admin = await asAdmin();
    await assign(admin, "MM-D01", NOY);
    await assign(admin, "MM-D02", SOMCHAI);
    await call(admin, "PATCH", `/users/${NOY}`, { active: false });
    await call(admin, "PATCH", `/users/${SOMCHAI}`, { branchId: "B-TS" });
    const store = getStore({} as any);
    expect(await store.activeAssignments({})).toHaveLength(0);
    const db = (store as any).db;
    expect(db.assignments.every((a: any) => a.ended_by === db.staffAccounts[0].id)).toBe(true);
    // and the change is audited like the trigger would
    expect(db.audit.some((e: any) => e.table_name === "desk_assignment" && e.op === "UPDATE")).toBe(true);
  });

  it("GET /my-cases returns mine plus every case of the branch with its holder", async () => {
    await assign(await asManager("B-MM"), "MM-D01", NOY);
    const res = await call(await asStaff("B-MM"), "GET", "/my-cases");
    expect(res.status).toBe(200);
    expect(res.json.mine).toEqual([]);
    const d1 = res.json.cases.find((c: any) => c.desk_id === "MM-D01");
    expect(d1.display_name).toBeTruthy();
    expect(d1.holder).toMatchObject({ staffId: NOY, name: "Noy P." });
    expect(d1.holder.since).toBeTruthy();
    expect(res.json.cases.find((c: any) => c.desk_id === "MM-D02").holder).toBeNull();
  });

  it("assignment writes are audited", async () => {
    await assign(await asManager("B-MM"), "MM-D01", NOY);
    const db = (getStore({} as any) as any).db;
    expect(db.audit.some((e: any) => e.action === "insert:desk_assignment")).toBe(true);
  });
});

describe("database refusals", () => {
  const live = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as any;
  const stubFetch = (body: string) =>
    vi.stubGlobal("fetch", async () => new Response(body, { status: 400, headers: { "Content-Type": "application/json" } }));

  it("SupabaseStore turns ROLE_DENIED and ASSIGNMENT_IMMUTABLE into store errors, not a 500", async () => {
    const store = getStore(live, { id: SOMCHAI });
    stubFetch('{"code":"P0001","message":"ROLE_DENIED: only the holder or a manager can end an assignment"}');
    await expect(store.releaseDesk("MM-D01")).rejects.toMatchObject({ code: "DENIED" });
    await expect(store.assignDesk("MM-D01", SOMCHAI)).rejects.toBeInstanceOf(StoreError);
    stubFetch('{"code":"P0001","message":"ASSIGNMENT_IMMUTABLE: an assignment can only be ended, never rewritten"}');
    await expect(store.releaseDesk("MM-D01")).rejects.toMatchObject({ code: "IMMUTABLE" });
  });

  it("a staff race loser (database ROLE_DENIED) gets 403 NOT_HOLDER", async () => {
    vi.spyOn(DemoStore.prototype, "assignDesk").mockRejectedValue(new StoreError("DENIED", "ROLE_DENIED"));
    const res = await assign(await asStaff("B-MM"), "MM-D02", SOMCHAI);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("NOT_HOLDER");
    vi.spyOn(DemoStore.prototype, "releaseDesk").mockRejectedValue(new StoreError("DENIED", "ROLE_DENIED"));
    const rel = await call(await asStaff("B-MM"), "POST", "/desks/MM-D02/release");
    expect(rel.status).toBe(403);
    expect(rel.json.code).toBe("NOT_HOLDER");
  });

  it("DemoStore mirrors the guard: a staff actor cannot take another holder's case", async () => {
    await assign(await asManager("B-MM"), "MM-D01", NOY);
    const store = getStore({} as any, { id: SOMCHAI });
    await expect(store.assignDesk("MM-D01", SOMCHAI)).rejects.toMatchObject({ code: "DENIED" });
    await expect(store.releaseDesk("MM-D01")).rejects.toMatchObject({ code: "DENIED" });
    expect(await store.activeAssignments({ branchId: "B-MM" })).toHaveLength(1);
  });

  it("staff take over a stale assignment through the API and DemoStore; same-day still needs a manager", async () => {
    await assign(await asManager("B-MM"), "MM-D01", NOY);
    const staff = await asStaff("B-MM");
    const same = await assign(staff, "MM-D01", SOMCHAI);
    expect(same.status).toBe(403);
    expect(same.json.code).toBe("NOT_HOLDER");
    const store = getStore({} as any, { id: SOMCHAI });
    (store as any).db.assignments.find((a: any) => a.desk_id === "MM-D01" && a.ended_at === null).started_at = "2020-01-01T00:00:00.000Z";
    await expect(store.assignDesk("MM-D01", SOMCHAI)).resolves.toMatchObject({ staff_id: SOMCHAI });
    expect(await store.activeAssignments({ branchId: "B-MM" })).toHaveLength(1);
    // and through the route, with a fresh stale row held by Noy
    (store as any).db.assignments.find((a: any) => a.desk_id === "MM-D01" && a.ended_at === null).started_at = "2020-01-01T00:00:00.000Z";
    const viaRoute = await assign(await asManager("B-MM"), "MM-D01", NOY);
    expect(viaRoute.status).toBe(200);
    (store as any).db.assignments.find((a: any) => a.desk_id === "MM-D01" && a.ended_at === null).started_at = "2020-01-01T00:00:00.000Z";
    const taken = await assign(staff, "MM-D01", SOMCHAI);
    expect(taken.status).toBe(200);
  });

  it("on a stale case staff may only take it for themselves: no hand-on, no bare release", async () => {
    await assign(await asManager("B-MM"), "MM-D01", NOY);
    const stale = () => ((getStore({} as any) as any).db.assignments.find((a: any) => a.desk_id === "MM-D01" && a.ended_at === null).started_at = "2020-01-01T00:00:00.000Z");
    stale();
    const staff = await asStaff("B-MM");
    const other = await assign(staff, "MM-D01", DEMO_MANAGER["B-MM"]);
    expect(other.status).toBe(403);
    expect(other.json.code).toBe("NOT_HOLDER");
    const rel = await call(staff, "POST", "/desks/MM-D01/release");
    expect(rel.status).toBe(403);
    expect(rel.json.code).toBe("NOT_HOLDER");
    const store = getStore({} as any, { id: SOMCHAI });
    await expect(store.releaseDesk("MM-D01")).rejects.toMatchObject({ code: "DENIED" });
    await expect(store.assignDesk("MM-D01", DEMO_MANAGER["B-MM"])).rejects.toMatchObject({ code: "DENIED" });
    expect((await store.activeAssignments({ branchId: "B-MM" }))[0].staff_id).toBe(NOY);
  });

  it("cards carry openedAt once the day is opened", async () => {
    const staff = await asStaff("B-MM");
    const before = (await call(staff, "GET", "/stock/desks")).json.desks.find((d: any) => d.desk_id === "MM-D02");
    expect(before).toHaveProperty("openedAt");
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: TODAY });
    const after = (await call(staff, "GET", "/stock/desks")).json.desks.find((d: any) => d.desk_id === "MM-D02");
    expect(typeof after.openedAt).toBe("string");
  });

  it("any other route maps DENIED to 403 ROLE_DENIED and IMMUTABLE to 409, with a clean message", async () => {
    vi.spyOn(DemoStore.prototype, "addClosedDays").mockRejectedValue(new StoreError("DENIED", "ROLE_DENIED: raw postgrest body"));
    const denied = await call(await asManager("B-MM"), "POST", "/closed-days", { branchId: "B-MM", date: "2026-12-25", reason: "x" });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: "ROLE_DENIED", error: "You are not allowed to do that" });
    vi.spyOn(DemoStore.prototype, "assignDesk").mockRejectedValue(new StoreError("IMMUTABLE", "raw"));
    const frozen = await assign(await asManager("B-MM"), "MM-D01", NOY);
    expect(frozen.status).toBe(409);
    expect(frozen.json.code).toBe("ASSIGNMENT_IMMUTABLE");
  });
});
