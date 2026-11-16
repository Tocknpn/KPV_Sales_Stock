// Branch closed days, and the database refusals the store maps to clean errors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_STAFF } from "../src/demoData";
import { DemoStore, StoreError, getStore } from "../src/store";
import { freshApp, call, asAdmin, asStaff, asManager, TODAY } from "./helpers";

beforeEach(freshApp);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SOMCHAI = DEMO_STAFF["B-MM"];

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
  });
});
