// Replenishment API: branch position, rules and bulk apply, roles, desk-card critical count.
// Demo data (today 2026-11-12): MM-D01 (checked in today) holds GB-001, GB-002, NK-010, RG-030;
// MM-D02 holds NK-011, BR-020, RG-031; the NECKLACES type (NK-010 + NK-011) has a type rule
// (1.5/day, 7 days) and NK-011 a SKU rule (1.8/day, 4 days), in every branch.
// Rules are per branch; any user sets their own branch's (2026-11-17, migration 15).
import { beforeEach, describe, expect, it } from "vitest";
import { getStore } from "../src/store";
import { freshApp, call, asAdmin, asStaff, asManager, TODAY } from "./helpers";

beforeEach(freshApp);

const rowsOf = async (s: any, branch: string) => (await call(s, "GET", `/replenishment?branchId=${branch}`)).json.rows as any[];
const rowFor = (rows: any[], sku: string) => rows.find((r) => r.sku_id === sku);
const putRule = (s: any, over: Record<string, unknown> = {}) => call(s, "PUT", "/replenishment/rules", { scope: "sku", key: "GB-001", branchId: "B-MM", avgDailySell: 2, ...over });
const cardOf = async (s: any, desk: string) => (await call(s, "GET", "/stock/desks")).json.desks.find((d: any) => d.desk_id === desk);

describe("GET /replenishment", () => {
  it("returns config, today and rows with the spec fields", async () => {
    const admin = await asAdmin();
    const res = await call(admin, "GET", "/replenishment?branchId=B-MM");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ branchId: "B-MM", today: TODAY, config: { defaultLeadTimeDays: 7, warningMarginDays: 3, velocityWindowDays: 28 } });
    const gb = rowFor(res.json.rows, "GB-001");
    expect(gb).toMatchObject({ name: "ທອງຄຳແທ່ງ 1 ບາດ", avg: { value: 2.5, source: "sku" }, lead: { value: 3, source: "sku" }, inbound: 0 });
    expect(gb.position).toBe(gb.onHand);
    expect(Object.keys(gb)).toEqual(expect.arrayContaining(["type", "autoAvg", "runwayDays", "status", "suggestedQty", "review"]));
  });

  it("needs a branch for admin, scopes staff to their own", async () => {
    expect((await call(await asAdmin(), "GET", "/replenishment")).json.code).toBe("BRANCH_REQUIRED");
    expect((await call(await asAdmin(), "GET", "/replenishment?branchId=nope")).status).toBe(404);
    const staff = await asStaff("B-MM");
    expect((await call(staff, "GET", "/replenishment?branchId=B-TS")).json.branchId).toBe("B-MM");
  });

  it("rows are sorted critical, warning, ok, no data", async () => {
    const admin = await asAdmin();
    await putRule(admin, { key: "RG-030", avgDailySell: 1000 });
    const rows = await rowsOf(admin, "B-MM");
    const order = ["critical", "warning", "ok", "no_data"];
    const idx = rows.map((r) => order.indexOf(r.status));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(rows[0]).toMatchObject({ sku_id: "RG-030", status: "critical" });
  });

  it("branch position sums every case of the branch plus inbound in-transit", async () => {
    const admin = await asAdmin();
    const before = rowFor(await rowsOf(admin, "B-MM"), "GB-001");
    // A second case in the same branch holding the same SKU.
    expect((await call(admin, "POST", "/desks", { branchId: "B-MM", displayName: "Case C", openingSkus: [{ sku_id: "GB-001", opening_qty: 5 }] })).status).toBe(200);
    const after = rowFor(await rowsOf(admin, "B-MM"), "GB-001");
    expect(after.onHand).toBe(before.onHand + 5);
    expect(after.position).toBe(before.position + 5);

    // 3 pieces on a truck to Talat Sao: out of Morning Market now, inbound at Talat Sao.
    const ts0 = rowFor(await rowsOf(admin, "B-TS"), "GB-001");
    expect(ts0).toBeUndefined();
    expect((await call(admin, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "TS-D01", skuId: "GB-001", qty: 3 })).status).toBe(200);
    const ts = rowFor(await rowsOf(admin, "B-TS"), "GB-001");
    expect(ts).toMatchObject({ onHand: 0, inbound: 3, position: 3 });
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001").position).toBe(after.position - 3);
  });
});

describe("rules", () => {
  it("lists one branch's rules and the defaults; staff get their own branch", async () => {
    const res = await call(await asStaff("B-MM"), "GET", "/replenishment/rules?branchId=B-TS");
    expect(res.status).toBe(200);
    expect(res.json.branchId).toBe("B-MM");
    expect(res.json.config).toMatchObject({ defaultLeadTimeDays: 7, warningMarginDays: 3 });
    expect(res.json.rules.some((r: any) => r.scope === "type" && r.scope_key === "NECKLACES")).toBe(true);
    expect(res.json.rules.every((r: any) => r.branch_id === "B-MM")).toBe(true);
    expect((await call(await asAdmin(), "GET", "/replenishment/rules")).json.code).toBe("BRANCH_REQUIRED");
  });

  it("a rule is per branch: other branches keep theirs", async () => {
    const admin = await asAdmin();
    expect((await putRule(admin, { avgDailySell: 9, leadTimeDays: 1 })).status).toBe(200);
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001")).toMatchObject({ avg: { value: 9, source: "sku" }, lead: { value: 1, source: "sku" } });
    expect(rowFor(await rowsOf(admin, "B-VT"), "GB-001")).toMatchObject({ avg: { value: 2.5, source: "sku" }, lead: { value: 3, source: "sku" } });
    expect((await getStore({} as any).rules()).some((r) => r.branch_id === null)).toBe(false);
    expect((await putRule(admin, { branchId: undefined })).json.code).toBe("BRANCH_REQUIRED");
  });

  it("null values inherit, and a rule with nothing left is removed", async () => {
    const admin = await asAdmin();
    await putRule(admin, { key: "NK-011", avgDailySell: 9, leadTimeDays: null });
    expect(rowFor(await rowsOf(admin, "B-MM"), "NK-011")).toMatchObject({ avg: { source: "sku" }, lead: { value: 7, source: "type" } });
    const gone = await putRule(admin, { key: "NK-011", avgDailySell: null });
    expect(gone.json.rule).toBeNull();
    expect(rowFor(await rowsOf(admin, "B-MM"), "NK-011").avg).toEqual({ value: 1.5, source: "type" });
  });

  it("rejects an unknown target, a bad scope (group is gone) and bad numbers", async () => {
    const admin = await asAdmin();
    expect((await putRule(admin, { key: "NOPE" })).json.code).toBe("BAD_RULE");
    expect((await putRule(admin, { scope: "weird" })).json.code).toBe("BAD_RULE");
    expect((await putRule(admin, { scope: "group", key: "Snake Necklace" })).json.code).toBe("BAD_RULE");
    expect((await putRule(admin, { avgDailySell: -1 })).json.code).toBe("BAD_RULE");
  });

  it("staff sets own branch rule", async () => {
    for (const s of [await asStaff("B-MM"), await asManager("B-MM")]) {
      expect((await putRule(s, { avgDailySell: 4, branchId: undefined })).status).toBe(200);
      expect(rowFor(await rowsOf(s, "B-MM"), "GB-001").avg).toEqual({ value: 4, source: "sku" });
    }
  });

  it("staff cannot write another branch's rule", async () => {
    const staff = await asStaff("B-MM");
    const res = await putRule(staff, { branchId: "B-VT" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("BRANCH_DENIED");
    expect((await call(staff, "POST", "/replenishment/rules/bulk", { scope: "type", key: "NECKLACES", avgDailySell: 1, branchId: "B-VT" })).json.code).toBe("BRANCH_DENIED");
  });

  it("staff cannot use allBranches", async () => {
    for (const s of [await asStaff("B-MM"), await asManager("B-MM")]) {
      expect((await putRule(s, { allBranches: true })).status).toBe(403);
      expect((await call(s, "POST", "/replenishment/rules/bulk", { scope: "type", key: "NECKLACES", avgDailySell: 1, allBranches: true })).status).toBe(403);
    }
  });

  it("admin allBranches writes every branch", async () => {
    const admin = await asAdmin();
    expect((await putRule(admin, { branchId: undefined, allBranches: true, avgDailySell: 7 })).status).toBe(200);
    const rules = (await getStore({} as any).rules()).filter((r) => r.scope === "sku" && r.scope_key === "GB-001");
    expect(rules.map((r) => r.branch_id).sort()).toEqual(["B-IT", "B-MM", "B-TS", "B-VT"]);
    expect(rules.every((r) => r.avg_daily_sell === 7)).toBe(true);
  });

  it("every change is audited", async () => {
    const admin = await asAdmin();
    await putRule(admin);
    const log = await getStore({} as any).auditLog({ limit: 20 });
    expect(log.some((e) => e.action === "replenishment.rule")).toBe(true);
    expect(log.some((e) => e.table_name === "replenishment_rule" && e.op === "UPDATE")).toBe(true);
  });
});

describe("bulk apply (Type)", () => {
  const bulk = (s: any, over: Record<string, unknown> = {}) =>
    call(s, "POST", "/replenishment/rules/bulk", { scope: "type", key: "NECKLACES", branchId: "B-MM", avgDailySell: 2, leadTimeDays: 5, dryRun: false, ...over });
  const mm = (r: any) => r.branch_id === "B-MM";

  it("sets the Type rule and replaces the SKUs' own values, so it applies to all", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    const res = await bulk(admin);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ affected: 2, overrides: 1, cleared: 1 });
    const rules = (await store.rules()).filter(mm);
    expect(rules.filter((r) => r.scope === "type" && r.scope_key === "NECKLACES")).toMatchObject([{ avg_daily_sell: 2, lead_time_days: 5 }]);
    expect(rules.some((r) => r.scope === "sku" && r.scope_key === "NK-011")).toBe(false);
    const rows = await rowsOf(admin, "B-MM");
    for (const sku of ["NK-010", "NK-011"]) expect(rowFor(rows, sku)).toMatchObject({ avg: { value: 2, source: "type" }, lead: { value: 5, source: "type" } });
  });

  it("a field left blank is not changed, on the Type nor on the SKUs", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    await bulk(admin, { avgDailySell: undefined, leadTimeDays: 9 });
    const rules = (await store.rules()).filter(mm);
    expect(rules.find((r) => r.scope === "type" && r.scope_key === "NECKLACES")).toMatchObject({ avg_daily_sell: 1.5, lead_time_days: 9 });
    // NK-011 keeps its own avg; its own lead time gave way to the Type's.
    expect(rules.find((r) => r.scope === "sku" && r.scope_key === "NK-011")).toMatchObject({ avg_daily_sell: 1.8, lead_time_days: null });
    expect(rowFor(await rowsOf(admin, "B-MM"), "NK-011")).toMatchObject({ avg: { value: 1.8, source: "sku" }, lead: { value: 9, source: "type" } });
    expect((await bulk(admin, { avgDailySell: undefined, leadTimeDays: undefined })).json.code).toBe("BAD_RULE");
    expect((await bulk(admin, { scope: "sku", key: "NK-010" })).json.code).toBe("BAD_RULE");
    expect((await bulk(admin, { key: "NOPE" })).json.code).toBe("BAD_RULE");
  });

  it("dryRun reports affected and override counts and writes nothing", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    const before = JSON.stringify(await store.rules());
    const res = await bulk(admin, { dryRun: true });
    expect(res.json).toEqual({ affected: 2, overrides: 1 });
    expect(JSON.stringify(await store.rules())).toBe(before);
  });

  it("bulk type set-all stays inside one branch", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    const vtBefore = JSON.stringify((await store.rules()).filter((r) => r.branch_id === "B-VT"));
    expect((await bulk(admin)).status).toBe(200);
    expect(JSON.stringify((await store.rules()).filter((r) => r.branch_id === "B-VT"))).toBe(vtBefore);
  });
});

describe("desk cards and dashboard", () => {
  it("desk card criticalCount follows the branch status of its SKUs", async () => {
    const admin = await asAdmin();
    const base = await cardOf(admin, "MM-D01");
    expect(base.lowStockCount).toBeUndefined();
    for (const sku of ["GB-001", "GB-002", "NK-010", "RG-030"]) await putRule(admin, { key: sku, avgDailySell: 5000, leadTimeDays: 7 });
    expect((await cardOf(admin, "MM-D01")).criticalCount).toBe(4);
    for (const sku of ["GB-001", "GB-002", "NK-010", "RG-030"]) await putRule(admin, { key: sku, avgDailySell: 0.001, leadTimeDays: 7 });
    expect((await cardOf(admin, "MM-D01")).criticalCount).toBe(0);
  });

  it("a SKU critical on one case is not critical once the branch holds more elsewhere", async () => {
    const admin = await asAdmin();
    const q = rowFor(await rowsOf(admin, "B-MM"), "GB-001").onHand;
    const others = (await cardOf(admin, "MM-D01")).criticalCount; // the demo's other SKUs, unaffected here
    // runway 6 days on the current stock (lead 7): critical
    await putRule(admin, { avgDailySell: q / 6, leadTimeDays: 7 });
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001").status).toBe("critical");
    expect((await cardOf(admin, "MM-D01")).criticalCount).toBe(others + 1);
    // another case in the branch adds 5 pieces: runway 6 x (q + 5) / q is above lead
    await call(admin, "POST", "/desks", { branchId: "B-MM", displayName: "Case C", openingSkus: [{ sku_id: "GB-001", opening_qty: 5 }] });
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001").status).not.toBe("critical");
    expect((await cardOf(admin, "MM-D01")).criticalCount).toBe(others);
  });

  it("the dashboard low-stock list comes from branch statuses", async () => {
    const admin = await asAdmin();
    await putRule(admin, { key: "GB-001", avgDailySell: 5000, leadTimeDays: 7 });
    const dash = (await call(admin, "GET", "/dashboard?branchId=B-MM")).json;
    const item = dash.watchlist.topLow.find((i: any) => i.sku_id === "GB-001");
    expect(item).toMatchObject({ branch_id: "B-MM", status: "critical" });
    expect(item.closing).toBe(rowFor(await rowsOf(admin, "B-MM"), "GB-001").position);
    expect(dash.watchlist.lowCount).toBeGreaterThan(0);
    expect(dash.branchCards[0].criticalCount).toBeGreaterThan(0);
  });

  it("a rule edit flips the day-detail row status in step with the card's criticalCount", async () => {
    const admin = await asAdmin();
    const detailRow = async () => (await call(admin, "GET", `/stock/desk/MM-D01?date=${TODAY}`)).json.rows.find((r: any) => r.sku_id === "GB-001");
    const before = await detailRow();
    expect(before.branch_status).not.toBe("critical");
    expect(before.threshold).toBeUndefined();
    expect(before.low_stock).toBeUndefined();
    const cards0 = (await cardOf(admin, "MM-D01")).criticalCount;
    await putRule(admin, { avgDailySell: 5000, leadTimeDays: 7 });
    const after = await detailRow();
    expect(after).toMatchObject({ branch_status: "critical", runway_days: 0 });
    expect((await cardOf(admin, "MM-D01")).criticalCount).toBe(cards0 + 1);
    const detail = (await call(admin, "GET", `/stock/desk/MM-D01?date=${TODAY}`)).json;
    expect(detail.criticalItems).toBe(detail.rows.filter((r: any) => r.branch_status === "critical").length);
  });

  it("an inbound-only SKU appears in the dashboard watchlist", async () => {
    const admin = await asAdmin();
    expect((await call(admin, "POST", "/transfers", { date: TODAY, fromDeskId: "MM-D01", toDeskId: "TS-D01", skuId: "GB-001", qty: 3 })).status).toBe(200);
    await putRule(admin, { branchId: "B-TS", avgDailySell: 100, leadTimeDays: 7 });
    const dash = (await call(admin, "GET", "/dashboard?branchId=B-TS")).json;
    const item = dash.watchlist.topLow.find((i: any) => i.sku_id === "GB-001");
    expect(item).toMatchObject({ branch_id: "B-TS", status: "critical", closing: 3, desk_id: "TS-D01" });
  });

  it("no avg/day is no data: the old fixed reorder level no longer warns", async () => {
    const admin = await asAdmin();
    // BR-021 at Talat Sao has no rules and too little history for an automatic avg.
    await call(admin, "PATCH", "/skus/BR-021", { reorder_level: 500 });
    const row = rowFor(await rowsOf(admin, "B-TS"), "BR-021");
    expect(row.status).toBe("no_data");
    const dash = (await call(admin, "GET", "/dashboard?branchId=B-TS")).json;
    expect(dash.watchlist.topLow.find((i: any) => i.sku_id === "BR-021")).toBeUndefined();
  });
});
