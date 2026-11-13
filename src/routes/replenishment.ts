// Replenishment: branch-wide runway per SKU, and the average-daily-sell / lead-time
// rules behind it. Reads: any logged-in user (staff see their own branch).
// Rules: admin any, branch manager their own branch only.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, audit, scopeBranch } from "../app";
import { requireManager, isManagerOf } from "../auth";
import { businessDate } from "../time";
import { loadBranchRows } from "../replenishment";
import type { RuleTarget, Store } from "../store";
import type { MasterSku, RuleScope, SessionUser } from "../types";

const r = newRouter();

const SCOPES: RuleScope[] = ["sku", "group", "type"];
const MAX_AVG = 9_999_999;
const MAX_LEAD = 9999.9;

function denied(): never {
  throw new HttpError(403, "You are not allowed to change these rules", "ROLE_DENIED");
}

// Admin: any rule. Manager: a rule of their own branch. Everyone else: read only.
function assertMayEdit(user: SessionUser, branchId: string | null) {
  if (user.role === "admin") return;
  if (branchId !== null && isManagerOf(user, branchId)) return;
  denied();
}

// undefined / null / "" = inherit (null). Otherwise a number in range, rounded to the column's precision.
function parseValue(value: unknown, field: string, max: number, decimals: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${field} must be a number from 0 to ${max}`, "BAD_RULE");
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

async function parseBranch(store: Store, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === "") return null;
  const id = String(value);
  if (!(await store.branches()).some((b) => b.branch_id === id)) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
  return id;
}

function skusOfScope(skus: MasterSku[], scope: RuleScope, key: string): MasterSku[] {
  return skus.filter((s) => s.active && (scope === "sku" ? s.sku_id === key : scope === "group" ? s.group_name === key : s.type_id === key));
}

// ---------------------------------------------------------------------------
// GET /replenishment?branchId=
// ---------------------------------------------------------------------------
r.get("/replenishment", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  if (!branchId) throw new HttpError(400, "branchId is required", "BRANCH_REQUIRED");
  if (!(await store.branches()).some((b) => b.branch_id === branchId)) throw new HttpError(404, "Branch not found", "BRANCH_NOT_FOUND");
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
  if (scope === "type") return (await store.skuTypes()).some((t) => t.type_id === key);
  const skus = await store.skus();
  return scope === "sku" ? skus.some((s) => s.sku_id === key) : skus.some((s) => s.group_name === key);
}

r.put("/replenishment/rules", requireManager, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const scope = body.scope as RuleScope;
  if (!SCOPES.includes(scope)) throw new HttpError(400, "scope must be sku, group or type", "BAD_RULE");
  const key = String(body.key ?? "").trim();
  if (!key || !(await validScopeKey(store, scope, key))) throw new HttpError(400, `Unknown ${scope}`, "BAD_RULE");
  const branchId = await parseBranch(store, body.branchId);
  assertMayEdit(user, branchId);
  const avg = parseValue(body.avgDailySell, "avgDailySell", MAX_AVG, 3);
  const lead = parseValue(body.leadTimeDays, "leadTimeDays", MAX_LEAD, 1);
  const rule = await store.upsertRule({ scope, scope_key: key, branch_id: branchId, avg_daily_sell: avg, lead_time_days: lead });
  await audit(store, user, rule ? "replenishment.rule" : "replenishment.rule_clear", `${scope}:${key}`, { branchId, avg_daily_sell: avg, lead_time_days: lead }, { branchId });
  return c.json({ rule });
});

// ---------------------------------------------------------------------------
// POST /replenishment/rules/bulk: one group or type rule for every SKU in it.
// SKU-level numbers are kept unless clearOverrides; dryRun only counts.
// ---------------------------------------------------------------------------
r.post("/replenishment/rules/bulk", requireManager, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const scope = body.scope as RuleScope;
  if (scope !== "group" && scope !== "type") throw new HttpError(400, "scope must be group or type", "BAD_RULE");
  const key = String(body.key ?? "").trim();
  if (!key || !(await validScopeKey(store, scope, key))) throw new HttpError(400, `Unknown ${scope}`, "BAD_RULE");
  const branchId = await parseBranch(store, body.branchId);
  assertMayEdit(user, branchId);
  const avg = parseValue(body.avgDailySell, "avgDailySell", MAX_AVG, 3);
  const lead = parseValue(body.leadTimeDays, "leadTimeDays", MAX_LEAD, 1);
  const dryRun = body.dryRun === true;
  if (!dryRun && avg === null && lead === null) throw new HttpError(400, "Give avgDailySell or leadTimeDays", "BAD_RULE");
  const clearOverrides = body.clearOverrides === true;

  const [skus, rules] = await Promise.all([store.skus(), store.rules()]);
  const inScope = skusOfScope(skus, scope, key);
  const skuIds = new Set(inScope.map((s) => s.sku_id));
  const groups = new Set(inScope.map((s) => s.group_name).filter((g): g is string => Boolean(g)));

  // Narrower rules at the same branch level: a group's SKU rules; a type's group and SKU rules.
  const narrower = rules.filter(
    (x) => x.branch_id === branchId && ((x.scope === "sku" && skuIds.has(x.scope_key)) || (scope === "type" && x.scope === "group" && groups.has(x.scope_key)))
  );
  const overriddenSkus = new Set<string>();
  for (const x of narrower) {
    if (x.scope === "sku") overriddenSkus.add(x.scope_key);
    else for (const s of inScope) if (s.group_name === x.scope_key) overriddenSkus.add(s.sku_id);
  }
  const preview = { affected: inScope.length, overrides: overriddenSkus.size };
  if (dryRun) return c.json(preview);

  // A value left out keeps what the rule already has.
  const existing = rules.find((x) => x.scope === scope && x.scope_key === key && x.branch_id === branchId);
  const rule = await store.upsertRule({
    scope,
    scope_key: key,
    branch_id: branchId,
    avg_daily_sell: avg ?? existing?.avg_daily_sell ?? null,
    lead_time_days: lead ?? existing?.lead_time_days ?? null,
  });
  let cleared = 0;
  if (clearOverrides && narrower.length > 0) {
    const targets: RuleTarget[] = narrower.map((x) => ({ scope: x.scope, scope_key: x.scope_key, branch_id: x.branch_id }));
    cleared = await store.deleteRules(targets);
  }
  await audit(store, user, "replenishment.bulk", `${scope}:${key}`, { branchId, avg_daily_sell: avg, lead_time_days: lead, clearOverrides, cleared, affected: preview.affected }, { branchId });
  return c.json({ ...preview, rule, cleared });
});

export default r;
