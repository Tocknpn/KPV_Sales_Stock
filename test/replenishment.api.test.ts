// Replenishment API: branch position, rules and bulk apply, roles, desk-card critical count.
// Demo data (today 2026-11-12): MM-D01 (checked in today) holds GB-001, GB-002, NK-010, RG-030;
// MM-D02 holds NK-011, BR-020, RG-031; Snake Necklace = NK-010 + NK-011 with a company-wide group
// rule (1.5/day, 7 days) and a company-wide SKU rule on NK-011 (1.8/day, 4 days).
import { beforeEach, describe, expect, it } from "vitest";
import { getStore } from "../src/store";
import { freshApp, call, asAdmin, asStaff, asManager, TODAY } from "./helpers";

beforeEach(freshApp);

const rowsOf = async (s: any, branch: string) => (await call(s, "GET", `/replenishment?branchId=${branch}`)).json.rows as any[];
const rowFor = (rows: any[], sku: string) => rows.find((r) => r.sku_id === sku);
const putRule = (s: any, over: Record<string, unknown> = {}) => call(s, "PUT", "/replenishment/rules", { scope: "sku", key: "GB-001", branchId: null, avgDailySell: 2, ...over });
const cardOf = async (s: any, desk: string) => (await call(s, "GET", "/stock/desks")).json.desks.find((d: any) => d.desk_id === desk);

describe("GET /replenishment", () => {
  it("returns config, today and rows with the spec fields", async () => {
    const admin = await asAdmin();
    const res = await call(admin, "GET", "/replenishment?branchId=B-MM");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ branchId: "B-MM", today: TODAY, config: { defaultLeadTimeDays: 7, warningMarginDays: 3, velocityWindowDays: 28 } });
    const gb = rowFor(res.json.rows, "GB-001");
    expect(gb).toMatchObject({ name: "Gold Bar 1 Baht", avg: { value: 2.5, source: "sku" }, lead: { value: 3, source: "sku" }, inbound: 0 });
    expect(gb.position).toBe(gb.onHand);
    expect(Object.keys(gb)).toEqual(expect.arrayContaining(["group", "autoAvg", "runwayDays", "status", "suggestedQty", "review"]));
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
  it("a branch rule beats the company rule for that branch only", async () => {
    const admin = await asAdmin();
    expect((await putRule(admin, { branchId: "B-MM", avgDailySell: 9, leadTimeDays: 1 })).status).toBe(200);
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001")).toMatchObject({ avg: { value: 9, source: "sku-branch" }, lead: { value: 1, source: "sku-branch" } });
    expect(rowFor(await rowsOf(admin, "B-VT"), "GB-001")).toMatchObject({ avg: { value: 2.5, source: "sku" } });
  });

  it("null values inherit, and a rule with nothing left is removed", async () => {
    const admin = await asAdmin();
    await putRule(admin, { branchId: "B-MM", avgDailySell: 9, leadTimeDays: null });
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001")).toMatchObject({ avg: { source: "sku-branch" }, lead: { value: 3, source: "sku" } });
    const gone = await putRule(admin, { branchId: "B-MM", avgDailySell: null });
    expect(gone.json.rule).toBeNull();
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001").avg.source).toBe("sku");
  });

  it("rejects an unknown target, a bad scope and bad numbers", async () => {
    const admin = await asAdmin();
    expect((await putRule(admin, { key: "NOPE" })).json.code).toBe("BAD_RULE");
    expect((await putRule(admin, { scope: "weird" })).json.code).toBe("BAD_RULE");
    expect((await putRule(admin, { avgDailySell: -1 })).json.code).toBe("BAD_RULE");
    expect((await putRule(admin, { branchId: "B-XX" })).json.code).toBe("BAD_BRANCH");
  });

  it("manager edits own-branch rules only; staff read-only", async () => {
    const mgr = await asManager("B-MM");
    expect((await putRule(mgr, { branchId: "B-MM" })).status).toBe(200);
    const other = await putRule(mgr, { branchId: "B-TS" });
    expect(other.status).toBe(403);
    expect(other.json.code).toBe("ROLE_DENIED");
    expect((await putRule(mgr, { branchId: null })).status).toBe(403);
    expect((await call(mgr, "POST", "/replenishment/rules/bulk", { scope: "group", key: "Snake Necklace", branchId: null, avgDailySell: 1 })).status).toBe(403);
    expect((await call(mgr, "POST", "/replenishment/rules/bulk", { scope: "group", key: "Snake Necklace", branchId: "B-MM", avgDailySell: 1 })).status).toBe(200);

    const staff = await asStaff("B-MM");
    const res = await putRule(staff, { branchId: "B-MM" });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("ROLE_DENIED");
    expect((await call(staff, "GET", "/replenishment")).status).toBe(200);
  });

  it("every change is audited", async () => {
    const admin = await asAdmin();
    await putRule(admin);
    const log = await getStore({} as any).auditLog(20);
    expect(log.some((e) => e.action === "replenishment.rule")).toBe(true);
    expect(log.some((e) => e.table_name === "replenishment_rule" && e.op === "UPDATE")).toBe(true);
  });
});

describe("bulk apply", () => {
  const bulk = (s: any, over: Record<string, unknown> = {}) =>
    call(s, "POST", "/replenishment/rules/bulk", { scope: "group", key: "Snake Necklace", branchId: null, avgDailySell: 2, leadTimeDays: 5, clearOverrides: false, dryRun: false, ...over });

  it("by group writes one rule and keeps SKU overrides unless clearOverrides", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    const res = await bulk(admin);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ affected: 2, overrides: 1, cleared: 0 });
    const groupRules = (await store.rules()).filter((r) => r.scope === "group");
    expect(groupRules).toHaveLength(1);
    expect(groupRules[0]).toMatchObject({ scope_key: "Snake Necklace", avg_daily_sell: 2, lead_time_days: 5 });
    let rows = await rowsOf(admin, "B-MM");
    expect(rowFor(rows, "NK-010")).toMatchObject({ avg: { value: 2, source: "group" }, lead: { value: 5, source: "group" } });
    expect(rowFor(rows, "NK-011")).toMatchObject({ avg: { value: 1.8, source: "sku" } });

    const cleared = await bulk(admin, { clearOverrides: true });
    expect(cleared.json.cleared).toBe(1);
    rows = await rowsOf(admin, "B-MM");
    expect(rowFor(rows, "NK-011")).toMatchObject({ avg: { value: 2, source: "group" }, lead: { value: 5, source: "group" } });
    expect((await store.rules()).some((r) => r.scope === "sku" && r.scope_key === "NK-011")).toBe(false);
  });

  it("by type covers the type's SKUs and clears group and SKU rules under it", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    const dry = await bulk(admin, { scope: "type", key: "NECKLACES", dryRun: true });
    expect(dry.json).toEqual({ affected: 2, overrides: 2 });
    const res = await bulk(admin, { scope: "type", key: "NECKLACES", clearOverrides: true });
    expect(res.json.cleared).toBe(2);
    const rules = await store.rules();
    expect(rules.filter((r) => r.scope === "type")).toHaveLength(1);
    expect(rules.some((r) => r.scope === "group" || r.scope_key === "NK-011")).toBe(false);
    expect(rowFor(await rowsOf(admin, "B-MM"), "NK-011").avg.source).toBe("type");
  });

  it("clearOverrides only touches rules of the same branch level", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    await putRule(admin, { key: "NK-011", branchId: "B-MM", avgDailySell: 4 });
    const res = await bulk(admin, { clearOverrides: true });
    expect(res.json.cleared).toBe(1); // the company-wide NK-011 rule, not the B-MM one
    expect((await store.rules()).some((r) => r.scope_key === "NK-011" && r.branch_id === "B-MM")).toBe(true);
  });

  it("dryRun reports affected and override counts and writes nothing", async () => {
    const admin = await asAdmin();
    const store = getStore({} as any);
    const before = JSON.stringify(await store.rules());
    const res = await bulk(admin, { dryRun: true, clearOverrides: true });
    expect(res.json).toEqual({ affected: 2, overrides: 1 });
    expect(JSON.stringify(await store.rules())).toBe(before);
  });

  it("a value left out keeps what the group rule already has; nothing at all is refused", async () => {
    const admin = await asAdmin();
    await bulk(admin, { avgDailySell: undefined, leadTimeDays: 9 });
    const rule = (await getStore({} as any).rules()).find((r) => r.scope === "group")!;
    expect(rule).toMatchObject({ avg_daily_sell: 1.5, lead_time_days: 9 });
    expect((await bulk(admin, { avgDailySell: undefined, leadTimeDays: undefined })).json.code).toBe("BAD_RULE");
    expect((await bulk(admin, { scope: "sku", key: "NK-010" })).json.code).toBe("BAD_RULE");
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
    await putRule(admin, { branchId: "B-MM", avgDailySell: q / 6, leadTimeDays: 7 });
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001").status).toBe("critical");
    expect((await cardOf(admin, "MM-D01")).criticalCount).toBe(others + 1);
    // another case in the branch adds 5 pieces: runway 6 x (q + 5) / q is above lead
    await call(admin, "POST", "/desks", { branchId: "B-MM", displayName: "Case C", openingSkus: [{ sku_id: "GB-001", opening_qty: 5 }] });
    expect(rowFor(await rowsOf(admin, "B-MM"), "GB-001").status).not.toBe("critical");
    expect((await cardOf(admin, "MM-D01")).criticalCount).toBe(others);
  });

  it("the dashboard low-stock list comes from branch statuses", async () => {
    const admin = await asAdmin();
    await putRule(admin, { key: "GB-001", branchId: "B-MM", avgDailySell: 5000, leadTimeDays: 7 });
    const dash = (await call(admin, "GET", "/dashboard?branchId=B-MM")).json;
    const item = dash.watchlist.topLow.find((i: any) => i.sku_id === "GB-001");
    expect(item).toMatchObject({ branch_id: "B-MM", status: "critical" });
    expect(item.closing).toBe(rowFor(await rowsOf(admin, "B-MM"), "GB-001").position);
    expect(dash.watchlist.lowCount).toBeGreaterThan(0);
    expect(dash.branchCards[0].criticalCount).toBeGreaterThan(0);
  });
});
