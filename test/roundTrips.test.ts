// Round trips per request: every Store call is one PostgREST request on the
// real database. Counts the calls (and serial stages) of the screens a case
// open goes through, on the demo store.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TODAY, freshApp, call, asStaff } from "./helpers";
import { storeTestHooks } from "../src/app";
import { spyStore, type StoreSpy } from "./storeSpy";

let spy: StoreSpy | undefined;
let all: { method: string; stage: number }[] = [];

beforeEach(() => {
  freshApp();
  all = [];
  // One spy per request; `all` collects what the measured request did.
  storeTestHooks.wrap = (store) => {
    spy = spyStore(store, true);
    all = spy.calls;
    return spy.store;
  };
});
afterEach(() => {
  storeTestHooks.wrap = undefined;
});

const stagesOf = (calls: { stage: number }[]) => new Set(calls.map((c) => c.stage)).size;
const report = (label: string) => console.log(`[round trips] ${label}: ${all.length} calls in ${stagesOf(all)} stages: ${all.map((c) => `${c.stage}:${c.method}`).join(" ")}`);

describe("round trips", () => {
  // Before: 24 calls in 5 stages. The 30 s shared cache (Supabase only) also
  // skips skus, skuTypes, skuWeights, branches and config when warm.
  it("GET desk detail: at most 20 calls (15 with a warm shared cache) in at most 3 serial stages", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "GET", `/stock/desk/MM-D01?date=${TODAY}`);
    expect(res.status).toBe(200);
    report("desk detail (today)");
    expect(all.length).toBeLessThanOrEqual(20);
    const shared = new Set(["skus", "skuTypes", "skuWeights", "branches", "config"]);
    expect(all.filter((c) => !shared.has(c.method)).length).toBeLessThanOrEqual(15);
    expect(stagesOf(all)).toBeLessThanOrEqual(3);
  });

  it("GET desk detail of an opening day: still at most 3 stages", async () => {
    const staff = await asStaff("B-MM");
    await call(staff, "POST", `/stock/desk/MM-D02/checkin`, { date: TODAY });
    const res = await call(staff, "GET", `/stock/desk/MM-D02?date=${TODAY}`);
    expect(res.status).toBe(200);
    report("desk detail (opening day)");
    expect(stagesOf(all)).toBeLessThanOrEqual(3);
  });

  // Before: 21 calls in 4 stages.
  it("GET /stock/desks: at most 2 stages, one memoised read per list, no second ledgerLatest", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "GET", `/stock/desks?date=${TODAY}`);
    expect(res.status).toBe(200);
    report("home list");
    expect(stagesOf(all)).toBeLessThanOrEqual(2);
    for (const m of ["skus", "config", "desks", "rules"]) expect(all.filter((c) => c.method === m).length, m).toBeLessThanOrEqual(1);
    expect(all.filter((c) => c.method === "ledgerLatest").length).toBe(1);
  });

  it("POST check-in (with its detail)", async () => {
    const staff = await asStaff("B-MM");
    const res = await call(staff, "POST", `/stock/desk/MM-D02/checkin`, { date: TODAY });
    expect(res.status).toBe(200);
    report("check-in");
    // The day detail rides along: the client needs no second or third request.
    expect(res.json.detail.status).toBe("opening");
    expect(all.filter((c) => c.method === "desks").length).toBe(1);
  });
});
