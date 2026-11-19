// Replenishment: branch-wide runway per SKU, and the average-daily-sell / lead-time
// rules behind it. Reads: any logged-in user (staff see their own branch).
// Rules: per branch (decided 2026-11-17, migration 15). Any logged-in user sets
// their own branch's values; an admin names a branch or sends allBranches.
// They are set in Settings > SKU, next to each SKU and per Type.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, audit, scopeBranch, targetBranches } from "../app";
import { businessDate } from "../time";
import { listHaving } from "../cachedStore";
import { loadBranchRows } from "../replenishment";
import type { RuleTarget, Store } from "../store";
import type { ReplenishmentRule, RuleScope } from "../types";

const r = newRouter();

const SCOPES: RuleScope[] = ["sku", "type"];
const MAX_AVG = 9_999_999;
const MAX_LEAD = 9999.9;

// undefined / null / "" = inherit (null). Otherwise a number in range, rounded to the column's precision.
function parseValue(value: unknown, field: string, max: number, decimals: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${field} must be a number from 0 to ${max}`, "BAD_RULE");
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// GET /replenishment?branchId=
// ---------------------------------------------------------------------------
r.get("/replenishment", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  if (!branchId) throw new HttpError(400, "branchId is required", "BRANCH_REQUIRED");
  const has = (l: { branch_id: string }[]) => l.some((b) => b.branch_id === branchId);
  if (!has(await listHaving(store, "branches", has))) throw new HttpError(404, "Branch not found", "BRANCH_NOT_FOUND");
  const today = businessDate(c.env);
  const [rows, config] = await Promise.all([loadBranchRows(store, branchId, today), store.config()]);
  return c.json({
    branchId,
    today,
    config: { defaultLeadTimeDays: config.default_lead_time_days, warningMarginDays: config.warning_margin_days, velocityWindowDays: config.velocity_window_days },
    rows,
  });
});

// ---------------------------------------------------------------------------
// PUT /replenishment/rules: one rule; a null / missing value inherits.
// ---------------------------------------------------------------------------
async function validScopeKey(store: Store, scope: RuleScope, key: string) {
  if (scope === "type") {
    const has = (l: { type_id: string }[]) => l.some((t) => t.type_id === key);
    return has(await listHaving(store, "skuTypes", has));
  }
  const has = (l: { sku_id: string }[]) => l.some((s) => s.sku_id === key);
  return has(await listHaving(store, "skus", has));
}

// The audit target's branch part: "*" for every branch.
const whereOf = (allBranches: unknown, branchIds: string[]) => (allBranches === true ? "*" : branchIds[0]);

// GET /replenishment/rules?branchId=: one branch's rules and the defaults (Settings > SKU).
r.get("/replenishment/rules", async (c) => {
  const store = storeFor(c);
  const branchId = scopeBranch(c.get("user"), c.req.query("branchId") || undefined);
  if (!branchId) throw new HttpError(400, "branchId is required", "BRANCH_REQUIRED");
  const [rules, config] = await Promise.all([store.rules(), store.config()]);
  return c.json({
    branchId,
    rules: rules.filter((x) => x.branch_id === branchId && (x.scope === "sku" || x.scope === "type")),
    config: { defaultLeadTimeDays: config.default_lead_time_days, warningMarginDays: config.warning_margin_days, velocityWindowDays: config.velocity_window_days },
  });
});

r.put("/replenishment/rules", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const scope = body.scope as RuleScope;
  if (!SCOPES.includes(scope)) throw new HttpError(400, "scope must be sku or type", "BAD_RULE");
  const key = String(body.key ?? "").trim();
  if (!key || !(await validScopeKey(store, scope, key))) throw new HttpError(400, `Unknown ${scope}`, "BAD_RULE");
  const avg = parseValue(body.avgDailySell, "avgDailySell", MAX_AVG, 3);
  const lead = parseValue(body.leadTimeDays, "leadTimeDays", MAX_LEAD, 1);
  const branchIds = await targetBranches(store, user, body.branchId, body.allBranches);
  let rule: ReplenishmentRule | null = null;
  for (const branch_id of branchIds) rule = await store.upsertRule({ scope, scope_key: key, branch_id, avg_daily_sell: avg, lead_time_days: lead });
  await audit(store, user, rule ? "replenishment.rule" : "replenishment.rule_clear", `${scope}:${key}@${whereOf(body.allBranches, branchIds)}`, {
    avg_daily_sell: avg,
    lead_time_days: lead,
    branch_ids: branchIds,
  });
  return c.json({ rule });
});

// ---------------------------------------------------------------------------
// POST /replenishment/rules/bulk: one Type rule that applies to every SKU in
// the Type. The value given replaces that field on the Type's SKU rules too
// ("apply to all"); a field left blank is not touched. dryRun only counts.
// It works inside one branch, or in every branch for an admin (allBranches).
// ---------------------------------------------------------------------------
r.post("/replenishment/rules/bulk", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  if (body.scope !== "type") throw new HttpError(400, "scope must be type", "BAD_RULE");
  const key = String(body.key ?? "").trim();
  if (!key || !(await validScopeKey(store, "type", key))) throw new HttpError(400, "Unknown type", "BAD_RULE");
  const avg = parseValue(body.avgDailySell, "avgDailySell", MAX_AVG, 3);
  const lead = parseValue(body.leadTimeDays, "leadTimeDays", MAX_LEAD, 1);
  const dryRun = body.dryRun === true;
  if (!dryRun && avg === null && lead === null) throw new HttpError(400, "Give avgDailySell or leadTimeDays", "BAD_RULE");
  const branchIds = await targetBranches(store, user, body.branchId, body.allBranches);
  const inBranches = new Set(branchIds);

  const [skus, rules] = await Promise.all([store.skus(), store.rules()]);
  const skuIds = new Set(skus.filter((s) => s.active && s.type_id === key).map((s) => s.sku_id));
  const skuRules = rules.filter((x) => x.scope === "sku" && x.branch_id !== null && inBranches.has(x.branch_id) && skuIds.has(x.scope_key));
  const preview = { affected: skuIds.size, overrides: skuRules.length };
  if (dryRun) return c.json(preview);

  let rule: ReplenishmentRule | null = null;
  for (const branch_id of branchIds) {
    const existing = rules.find((x) => x.scope === "type" && x.scope_key === key && x.branch_id === branch_id);
    rule = await store.upsertRule({
      scope: "type",
      scope_key: key,
      branch_id,
      avg_daily_sell: avg ?? existing?.avg_daily_sell ?? null,
      lead_time_days: lead ?? existing?.lead_time_days ?? null,
    });
  }
  // The SKU-level value of each field that was given goes, so the Type value applies.
  let cleared = 0;
  const emptied: RuleTarget[] = [];
  for (const x of skuRules) {
    const nextAvg = avg !== null ? null : x.avg_daily_sell;
    const nextLead = lead !== null ? null : x.lead_time_days;
    if (nextAvg === x.avg_daily_sell && nextLead === x.lead_time_days) continue;
    cleared++;
    if (nextAvg === null && nextLead === null) emptied.push({ scope: "sku", scope_key: x.scope_key, branch_id: x.branch_id });
    else await store.upsertRule({ scope: "sku", scope_key: x.scope_key, branch_id: x.branch_id, avg_daily_sell: nextAvg, lead_time_days: nextLead });
  }
  if (emptied.length > 0) await store.deleteRules(emptied);
  await audit(store, user, "replenishment.bulk", `type:${key}@${whereOf(body.allBranches, branchIds)}`, {
    avg_daily_sell: avg,
    lead_time_days: lead,
    cleared,
    affected: preview.affected,
    branch_ids: branchIds,
  });
  return c.json({ ...preview, rule, cleared });
});

export default r;
