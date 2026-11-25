// Settings: SKU master data (incl. import), system config, user management.
// Reads are open to every logged-in user. Since 2026-11-17 any logged-in user
// may add a SKU, set their own branch's avg/day and lead time, and switch
// whether their branch carries a SKU; renaming, type, size, deactivating,
// Types, Sizes, config and users stay admin only.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, audit, scopeBranch, targetBranches } from "../app";
import { loadHeld } from "../replenishment";
import { MAX_IMPORT_ROWS, exportRows, planImport } from "../skuImport";
import { stripWeight } from "../skuName";
import { fresh, listHaving } from "../cachedStore";
import type { NewSku, Store } from "../store";
import { requireAdmin, requireManager, hashPassword, isValidPassword, normalizeUsername, isValidUsername, isManagerOf, MIN_PASSWORD } from "../auth";
import { isLive } from "../time";
import { skuSummary, staffAccountSummary } from "../logic";
import type { MasterSku, SizePart, SkuType, SkuUnit, SkuWeight } from "../types";
import { partsGrams, partsLabel, partsOf, readParts } from "../sizes";

const r = newRouter();

// Every SKU is gold (decided 2026-11-17): its Baht weight follows its size.
export const GRAMS_PER_BAHT = 15.244;
const bahtOfGrams = (g: number | null | undefined) => (g && g > 0 ? Math.round((g / GRAMS_PER_BAHT) * 10000) / 10000 : 0);
// Same limits as replenishment rules (the engine reads only rules).
const MAX_RULE_AVG = 9_999_999;
const MAX_RULE_LEAD = 9999.9;

// Avg/day and lead time live only in per-branch SKU rules; a blank value
// inherits (the branch's Type rule, then automatic velocity / default lead time).
async function writeSkuRule(store: Store, skuId: string, branchIds: string[], avg: number | null, lead: number | null) {
  for (const branch_id of branchIds) {
    await store.upsertRule({
      scope: "sku",
      scope_key: skuId,
      branch_id,
      avg_daily_sell: avg == null ? null : Math.round(avg * 1000) / 1000,
      lead_time_days: lead == null ? null : Math.round(lead * 10) / 10,
    });
  }
}

// The two planning numbers of a form / CSV line: { avg, lead } (null = blank) or an error text.
function planNumbers(input: Record<string, any>): { avg: number | null; lead: number | null } | string {
  const avg = nonNegative(input.avg_daily_sell ?? input.avg_daily_sales);
  const lead = nonNegative(input.lead_time_days ?? input.order_lead_time_days);
  if (Number.isNaN(avg) || (avg !== null && avg > MAX_RULE_AVG)) return `avg_daily_sell must be a number from 0 to ${MAX_RULE_AVG}`;
  if (Number.isNaN(lead) || (lead !== null && lead > MAX_RULE_LEAD)) return `lead_time_days must be a number from 0 to ${MAX_RULE_LEAD}`;
  return { avg, lead };
}

// The SKU name: one Lao name (name, or name_lo; old files may only have name_en),
// the product only: a trailing size is dropped (the size is the SKU's weight).
function skuNameOf(input: Record<string, any>) {
  return stripWeight(String(input.name ?? input.name_lo ?? input.name_en ?? "")).slice(0, 120);
}

function slug(name: string) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function newSkuId() {
  const rand = crypto.getRandomValues(new Uint8Array(3));
  return `SKU-${Date.now().toString(36).toUpperCase()}${[...rand].map((b) => (b % 36).toString(36)).join("").toUpperCase()}`;
}

function nonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

// ---------------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------------
// GET /skus?branchId=&all=1: every SKU; with a branch (a staff / manager always
// gets their own) each one also has carried and that branch's own plan numbers.
r.get("/skus", async (c) => {
  const store = storeFor(c);
  const includeInactive = c.req.query("all") === "1";
  const branchId = scopeBranch(c.get("user"), c.req.query("branchId") || undefined);
  const [skus, types, weights, rules, branchSkus] = await Promise.all([
    store.skus(),
    store.skuTypes(),
    store.skuWeights(),
    branchId ? store.rules() : Promise.resolve([]),
    branchId ? store.branchSkus({ branchId }) : Promise.resolve([]),
  ]);
  const typeById = new Map(types.map((t) => [t.type_id, t]));
  const weightById = new Map(weights.map((w) => [w.weight_id, w]));
  const carried = new Set(branchSkus.filter((b) => b.carried).map((b) => b.sku_id));
  const ruleBySku = new Map(rules.filter((x) => x.scope === "sku" && x.branch_id === branchId).map((x) => [x.scope_key, x]));
  return c.json({
    branchId: branchId ?? null,
    skus: skus
      .filter((s) => includeInactive || s.active)
      .map((s) => {
        const rule = ruleBySku.get(s.sku_id);
        return {
          ...s,
          type_name: s.type_id ? typeById.get(s.type_id)?.name_en ?? null : null,
          weight_name: s.weight_id ? weightById.get(s.weight_id)?.name_en ?? null : null,
          carried: branchId ? carried.has(s.sku_id) : null,
          plan: branchId ? { avg: rule?.avg_daily_sell ?? null, lead: rule?.lead_time_days ?? null } : null,
        };
      }),
  });
});

type BuiltSku = { sku: NewSku; avg: number | null; lead: number | null };

// Validates one SKU input (form or CSV line). Returns the SKU or an error text.
// Purity, price, group and fixed reorder level are no longer asked for and are
// ignored if sent (decided 2026-11-17).
function buildSku(input: Record<string, any>, types: SkuType[], weights: SkuWeight[]): BuiltSku | string {
  const name = skuNameOf(input);
  if (!name) return "name is required";
  const typeKey = String(input.type ?? "").trim().toLowerCase();
  const type = types.find(
    (t) => t.type_id === input.type_id || (typeKey !== "" && (t.name_en.toLowerCase() === typeKey || (t.name_lo ?? "").toLowerCase() === typeKey))
  );
  if (!type) return "unknown type";
  const weightKey = String(input.weight ?? "").trim().toLowerCase();
  const weight = weights.find(
    (w) => w.weight_id === input.weight_id || (weightKey !== "" && (w.name_en.toLowerCase() === weightKey || w.weight_id.toLowerCase() === weightKey))
  );
  if ((input.weight_id || weightKey) && !weight) return "unknown weight";
  const plan = planNumbers(input);
  if (typeof plan === "string") return plan;
  const sku_id = String(input.sku_id ?? "").trim();
  if (sku_id && !/^[A-Za-z0-9_-]{1,40}$/.test(sku_id)) return "sku_id may only contain letters, digits, - and _";
  return {
    sku: {
      sku_id: sku_id || newSkuId(),
      // name_en is NOT NULL and the fallback everywhere: it mirrors the Lao name.
      name_en: name,
      name_lo: name,
      category: type.name_en,
      type_id: type.type_id,
      weight_id: weight?.weight_id ?? null,
      std_gram_weight: weight?.gram_value ?? null,
      purity: null,
      baht_weight: bahtOfGrams(weight?.gram_value),
      unit_cost_lak: 0,
      unit_price_lak: 0,
      reorder_level: 0,
      avg_daily_sales: null,
      order_lead_time_days: null,
      group_name: null,
      icon: input.icon ? String(input.icon) : type.icon,
    },
    avg: plan.avg,
    lead: plan.lead,
  };
}

// The size of a SKU form's parts: the size with the same label, else a new one
// (any role may add it, like the SKU). Its grams follow the units' grams.
async function sizeFromBody(store: Store, input: unknown): Promise<SkuWeight> {
  const units = await listHaving(store, "skuUnits", (l) =>
    !Array.isArray(input) || input.every((p: SizePart) => l.some((u) => u.unit === String(p?.unit ?? "").trim()))
  );
  const parts = readParts(input, units);
  if (typeof parts === "string") throw new HttpError(400, parts, "BAD_SIZE");
  const name_en = partsLabel(parts);
  const weights = await fresh(store).skuWeights();
  const found = weights.find((w) => w.name_en.trim() === name_en);
  if (found) return found;
  const gram_value = partsGrams(parts, units)!;
  const one = parts.length === 1 ? parts[0] : null;
  const weight_id = `W_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  return store.createSkuWeight({ weight_id, name_en, qty: one?.qty ?? null, unit: one?.unit ?? null, parts, gram_value, sort_order: weights.length + 1 });
}

// POST /skus: any role. The new SKU is carried, with its avg/day and lead
// time, in the branch given: a staff / manager's own; an admin names one or
// sends allBranches (decided 2026-11-17: the admin's tick decides).
r.post("/skus", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  if (body.size !== undefined) body.weight_id = (await sizeFromBody(store, body.size)).weight_id;
  const [types, weights] = await Promise.all([
    listHaving(store, "skuTypes", (l) => l.some((t) => t.type_id === body.type_id)),
    listHaving(store, "skuWeights", (l) => l.some((w) => w.weight_id === body.weight_id)),
  ]);
  if (!body.weight_id) throw new HttpError(400, "name, type_id and weight_id are required", "BAD_SKU");
  const built = buildSku(body, types, weights);
  if (typeof built === "string") throw new HttpError(400, built, "BAD_SKU");
  const hasPlan = built.avg !== null || built.lead !== null;
  const carriedIn = await targetBranches(store, user, body.branchId, body.allBranches);
  const ruleBranches = carriedIn;
  const [created] = await store.createSkus([built.sku]);
  await store.setCarried(carriedIn.map((branch_id) => ({ branch_id, sku_id: created.sku_id, carried: true })));
  if (hasPlan) await writeSkuRule(store, created.sku_id, ruleBranches, built.avg, built.lead);
  await audit(store, user, "sku.create", created.sku_id, { name_en: created.name_en, carried_in: carriedIn });
  return c.json(created);
});

// GET /skus/export?branchId=<id>|all: the rows of the SKU file (the browser
// writes the .xlsx). One branch = the SKUs it carries with its own values; a
// staff / manager always gets their own branch. "all" (admin only) = one row
// per branch and SKU, with branch_id filled.
r.get("/skus/export", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const asked = c.req.query("branchId") || undefined;
  if (asked === "all" && user.role !== "admin") throw new HttpError(403, "Only an admin can export every branch", "ROLE_DENIED");
  const all = asked === "all";
  const branchIds = all ? (await store.branches()).map((b) => b.branch_id) : [scopeBranch(user, asked)].filter((b): b is string => !!b);
  if (branchIds.length === 0) throw new HttpError(400, "branchId is required", "BRANCH_REQUIRED");
  const hasBranch = (l: { branch_id: string }[]) => l.some((b) => b.branch_id === branchIds[0]);
  if (!all && !hasBranch(await listHaving(store, "branches", hasBranch))) throw new HttpError(404, "Branch not found", "BRANCH_NOT_FOUND");
  const [skus, types, rules, branchSkus] = await Promise.all([store.skus(), store.skuTypes(), store.rules(), store.branchSkus(all ? {} : { branchId: branchIds[0] })]);
  return c.json({ branchId: all ? "all" : branchIds[0], rows: exportRows({ branchIds, withBranch: all, skus, types, rules, branchSkus }) });
});

// POST /skus/import { branchId: <id>|"all", fileName, rows, dryRun }. Every
// row is checked first; if any is wrong nothing is written and the errors are
// returned per sheet line (422). dryRun returns the same counts and writes
// nothing. Nothing is ever deleted.
r.post("/skus/import", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const all = body.branchId === "all";
  if (all && user.role !== "admin") throw new HttpError(403, "Only an admin can import every branch", "ROLE_DENIED");
  const branchId = all ? null : (await targetBranches(store, user, body.branchId))[0];
  const rows: Record<string, unknown>[] = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) throw new HttpError(400, "The file has no rows", "EMPTY_IMPORT");
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time`, "IMPORT_TOO_LARGE");

  // The lists may be up to 30 s old on this isolate: a refused file is
  // checked once more against fresh ones before the errors are returned.
  const planFrom = async (s: Store) => {
    const [skus, types, weights, rules, branchSkus, branches] = await Promise.all([s.skus(), s.skuTypes(), s.skuWeights(), s.rules(), s.branchSkus(), s.branches()]);
    const plan = planImport({ rows, branchId, isAdmin: user.role === "admin", branchIds: branches.map((b) => b.branch_id), skus, types, weights, rules, branchSkus });
    return { skus, types, weights, plan };
  };
  let planned = await planFrom(store);
  if (planned.plan.errors.length > 0 && fresh(store) !== store) planned = await planFrom(fresh(store));
  const { skus, types, weights, plan } = planned;
  const summary = { created: plan.created, updated: plan.updated, unchanged: plan.unchanged, ignored: plan.ignored, cleared: plan.cleared, errors: plan.errors };
  if (plan.errors.length > 0) throw new HttpError(422, "Nothing was imported — fix these rows and try again", "IMPORT_INVALID", summary);
  if (body.dryRun === true) return c.json(summary);

  // New SKUs: one all-or-nothing create, then carried + values in their row's branch.
  const built = plan.newSkus.map((n) => {
    const b = buildSku({ name: n.name, type_id: n.type.type_id, weight_id: n.weight.weight_id }, types, weights);
    if (typeof b === "string") throw new HttpError(500, b, "IMPORT_INVALID");
    return { n, sku: b.sku };
  });
  const created = await store.createSkus(built.map((b) => b.sku));
  await store.setCarried(built.flatMap((b) => b.n.branches.map((x) => ({ branch_id: x.branch_id, sku_id: b.sku.sku_id, carried: true }))));
  for (const b of built) {
    for (const x of b.n.branches) if (x.avg !== null || x.lead !== null) await writeSkuRule(store, b.sku.sku_id, [x.branch_id], x.avg, x.lead);
  }

  // Catalogue changes (admin only; planImport ignores them for others).
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  for (const [skuId, ch] of plan.skuPatches) {
    const p: Partial<MasterSku> = {};
    if (ch.name) Object.assign(p, { name_en: ch.name, name_lo: ch.name });
    if (ch.type) Object.assign(p, { type_id: ch.type.type_id, category: ch.type.name_en });
    if (ch.weight) Object.assign(p, { weight_id: ch.weight.weight_id, std_gram_weight: ch.weight.gram_value, baht_weight: bahtOfGrams(ch.weight.gram_value) });
    await store.updateSku(skuId, p);
  }
  for (const x of plan.rules) await writeSkuRule(store, x.sku_id, [x.branch_id], x.avg, x.lead);
  await store.setCarried(plan.carried);

  // Audit: one row per SKU and branch written, then the summary.
  for (const b of built) {
    for (const x of b.n.branches) {
      await audit(store, user, "sku.import_row", b.sku.sku_id, {
        branch_id: x.branch_id,
        before: null,
        after: { name: b.n.name, type_id: b.n.type.type_id, weight_id: b.n.weight.weight_id, avg_daily_sell: x.avg, lead_time_days: x.lead },
      });
    }
  }
  for (const u of plan.updatedRows) {
    const sku = skuById.get(u.sku_id)!;
    const ch = plan.skuPatches.get(u.sku_id);
    const rule = plan.rules.find((x) => x.sku_id === u.sku_id && x.branch_id === u.branch_id);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (ch?.name) Object.assign(before, { name: sku.name_lo || sku.name_en }), Object.assign(after, { name: ch.name });
    if (ch?.type) Object.assign(before, { type_id: sku.type_id }), Object.assign(after, { type_id: ch.type.type_id });
    if (ch?.weight) Object.assign(before, { weight_id: sku.weight_id }), Object.assign(after, { weight_id: ch.weight.weight_id });
    if (rule) {
      Object.assign(before, { avg_daily_sell: rule.before.avg, lead_time_days: rule.before.lead });
      Object.assign(after, { avg_daily_sell: rule.avg, lead_time_days: rule.lead });
    }
    if (plan.carried.some((x) => x.sku_id === u.sku_id && x.branch_id === u.branch_id)) Object.assign(before, { carried: false }), Object.assign(after, { carried: true });
    await audit(store, user, "sku.import_row", u.sku_id, { branch_id: u.branch_id, before, after });
  }
  const fileName = String(body.fileName ?? "").slice(0, 200);
  await audit(store, user, "sku.import", fileName || "import", {
    fileName,
    branchId: all ? "all" : branchId,
    created: plan.created,
    updated: plan.updated,
    unchanged: plan.unchanged,
    sku_ids: created.map((s) => s.sku_id).slice(0, 50),
  });
  return c.json(summary);
});

// PATCH /skus/:id: name, type, size and active are admin only; avg/day and
// lead time are any role's, for their own branch (an admin names one or sends
// allBranches).
r.patch("/skus/:id", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const catalogue = ["name", "name_lo", "name_en", "type_id", "weight_id", "size", "active"].some((k) => body[k] !== undefined);
  if (catalogue && user.role !== "admin") throw new HttpError(403, "Only an admin can rename an SKU or change its type, size or status", "ROLE_DENIED");
  if (body.size !== undefined) body.weight_id = (await sizeFromBody(store, body.size)).weight_id;
  const patch: Partial<MasterSku> = {};
  const nameInput = body.name ?? body.name_lo ?? body.name_en;
  if (nameInput !== undefined) {
    const name = stripWeight(String(nameInput ?? "")).slice(0, 120);
    if (!name) throw new HttpError(400, "name cannot be empty", "BAD_SKU");
    patch.name_en = name;
    patch.name_lo = name;
  }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  // Planning numbers: sent = set (blank = inherit); not sent = unchanged.
  const planSent = body.avg_daily_sell !== undefined || body.lead_time_days !== undefined;
  const plan = planSent ? planNumbers(body) : null;
  if (typeof plan === "string") throw new HttpError(400, plan, "BAD_SKU");
  const planBranches = plan ? await targetBranches(store, user, body.branchId, body.allBranches) : [];
  if (body.type_id || body.weight_id) {
    const [types, weights] = await Promise.all([
      listHaving(store, "skuTypes", (l) => !body.type_id || l.some((t) => t.type_id === body.type_id)),
      listHaving(store, "skuWeights", (l) => !body.weight_id || l.some((w) => w.weight_id === body.weight_id)),
    ]);
    if (body.type_id) {
      const type = types.find((t) => t.type_id === body.type_id);
      if (!type) throw new HttpError(400, "Unknown type_id", "BAD_SKU");
      patch.type_id = type.type_id;
      patch.category = type.name_en;
    }
    if (body.weight_id) {
      const weight = weights.find((w) => w.weight_id === body.weight_id);
      if (!weight) throw new HttpError(400, "Unknown weight_id", "BAD_SKU");
      patch.weight_id = weight.weight_id;
      patch.std_gram_weight = weight.gram_value;
      patch.baht_weight = bahtOfGrams(weight.gram_value);
    }
  }
  if (Object.keys(patch).length === 0 && !plan) throw new HttpError(400, "Nothing to change", "NOTHING_TO_CHANGE");
  const id = c.req.param("id") ?? "";
  const sku = Object.keys(patch).length > 0 ? await store.updateSku(id, patch) : (await listHaving(store, "skus", (l) => l.some((s) => s.sku_id === id))).find((s) => s.sku_id === id) ?? null;
  if (!sku) throw new HttpError(404, "SKU not found", "NOT_FOUND");
  if (plan) await writeSkuRule(store, sku.sku_id, planBranches, plan.avg, plan.lead);
  const changes = plan ? { ...patch, avg_daily_sell: plan.avg, lead_time_days: plan.lead, branch_ids: planBranches } : patch;
  await audit(store, user, "sku.update", sku.sku_id, changes as Record<string, unknown>);
  return c.json(sku);
});

// PUT /skus/:id/carried { branchId, carried }: whether a branch carries a SKU.
// Off is refused while the branch still holds it or has it on the way.
r.put("/skus/:id/carried", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const [branchId] = await targetBranches(store, user, body.branchId);
  if (typeof body.carried !== "boolean") throw new HttpError(400, "carried must be true or false", "BAD_SKU");
  const id = c.req.param("id") ?? "";
  const hasSku = (l: MasterSku[]) => l.some((s) => s.sku_id === id);
  if (!hasSku(await listHaving(store, "skus", hasSku))) throw new HttpError(404, "SKU not found", "NOT_FOUND");
  if (!body.carried) {
    const held = (await loadHeld(store, branchId)).get(id);
    if (held && held.onHand + held.inbound > 0) {
      throw new HttpError(409, "The branch still holds this SKU or has it on the way", "STOCK_HELD", { onHand: held.onHand, inbound: held.inbound });
    }
  }
  await store.setCarried([{ branch_id: branchId, sku_id: id, carried: body.carried }]);
  await audit(store, user, "sku.carried", id + "@" + branchId, { branch_id: branchId, carried: body.carried });
  return c.json({ sku_id: id, branchId, carried: body.carried });
});

// ---------------------------------------------------------------------------
// SKU Type / Weight master data
// ---------------------------------------------------------------------------
r.get("/sku-types", async (c) => c.json({ types: await storeFor(c).skuTypes() }));

// A type has one name (decided 2026-11-19): name_lo and name_en hold the same
// text. The id is made once from the name (or a fallback for a Lao-only name)
// and never changes, so a rename reaches every SKU, report and old record.
const typeName = (body: Record<string, any>) => String(body.name ?? body.name_lo ?? body.name_en ?? "").trim().slice(0, 60);

r.post("/sku-types", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const name = typeName(body);
  if (!name) throw new HttpError(400, "A type name is required", "BAD_TYPE");
  const types = await store.skuTypes();
  if (types.some((t) => (t.name_lo ?? t.name_en).trim() === name || t.name_en.trim() === name)) throw new HttpError(409, "That type already exists", "TYPE_EXISTS");
  let type_id = slug(body.type_id || name) || `T_${Date.now().toString(36).toUpperCase()}`;
  if (types.some((t) => t.type_id === type_id)) type_id = `${type_id}_${Date.now().toString(36).toUpperCase()}`;
  const type = await store.createSkuType({ type_id, name_en: name, name_lo: name, icon: body.icon ?? "ring" });
  await audit(store, c.get("user"), "sku_type.create", type.type_id, { name });
  return c.json(type);
});

// Renaming a type must also rename the mirrored category on its SKUs, or
// grouping would split the type in two.
async function renameCategory(store: Store, typeId: string, name: string) {
  // Fresh: a SKU made on another isolate within 30 s must be renamed too.
  const skus = (await fresh(store).skus()).filter((s) => s.type_id === typeId && s.category !== name);
  for (const s of skus) await store.updateSku(s.sku_id, { category: name });
}

r.patch("/sku-types/:id", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const patch: Partial<SkuType> = {};
  if (body.name !== undefined || body.name_en !== undefined || body.name_lo !== undefined) {
    const name = typeName(body);
    if (!name) throw new HttpError(400, "The type name cannot be empty", "BAD_TYPE");
    patch.name_en = name;
    patch.name_lo = name;
  }
  if (body.icon !== undefined) patch.icon = String(body.icon);
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0;
  const type = await store.updateSkuType((c.req.param("id") ?? ""), patch);
  if (!type) throw new HttpError(404, "Type not found", "NOT_FOUND");
  if (patch.name_en) await renameCategory(store, type.type_id, type.name_en);
  await audit(store, c.get("user"), "sku_type.update", type.type_id, patch as Record<string, unknown>);
  return c.json(type);
});

r.get("/sku-weights", async (c) => c.json({ weights: await storeFor(c).skuWeights() }));

// A size is "qty unit" with its grams typed by the user (decided 2026-11-19):
// 8 ບາດ = 120 g. The unit is a free name (the list is every unit already in use
// plus a new one typed in); only the grams are used in calculations.
function readSize(body: Record<string, any>, partial: boolean) {
  const out: { qty?: number; unit?: string; gram_value?: number } = {};
  if (!partial || body.qty !== undefined) {
    const qty = Number(body.qty);
    if (!(qty > 0) || qty > 1_000_000) throw new HttpError(400, "Enter an amount above 0", "BAD_WEIGHT");
    out.qty = Math.round(qty * 10000) / 10000;
  }
  if (!partial || body.unit !== undefined) {
    const unit = String(body.unit ?? "").trim().slice(0, 30);
    if (!unit) throw new HttpError(400, "Choose or type a unit", "BAD_WEIGHT");
    out.unit = unit;
  }
  if (!partial || body.gram_value !== undefined) {
    const g = Number(body.gram_value);
    if (!(g > 0) || g > 100_000_000) throw new HttpError(400, "Enter the weight in grams, above 0", "BAD_WEIGHT");
    out.gram_value = Math.round(g * 10000) / 10000;
  }
  return out;
}
const sizeLabel = (qty: number, unit: string) => `${Number(qty)} ${unit}`;

r.post("/sku-weights", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const { qty, unit, gram_value } = readSize(body, false) as { qty: number; unit: string; gram_value: number };
  const name_en = sizeLabel(qty, unit);
  const weights = await store.skuWeights();
  if (weights.some((w) => w.name_en.trim() === name_en)) throw new HttpError(409, "That size already exists", "WEIGHT_EXISTS");
  let weight_id = `W_${String(qty).replace(/[.]/g, "_")}_${Date.now().toString(36).toUpperCase()}`;
  if (weights.some((w) => w.weight_id === weight_id)) weight_id += "X";
  const weight = await store.createSkuWeight({ weight_id, name_en, qty, unit, gram_value, sort_order: weights.length + 1 });
  await audit(store, c.get("user"), "sku_weight.create", weight.weight_id, { name_en, gram_value });
  return c.json(weight);
});

r.patch("/sku-weights/:id", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const id = c.req.param("id") ?? "";
  const weights = await store.skuWeights();
  const current = weights.find((w) => w.weight_id === id);
  if (!current) throw new HttpError(404, "Weight not found", "NOT_FOUND");
  const patch: Partial<SkuWeight> = { ...readSize(body, true) };
  if (patch.qty !== undefined || patch.unit !== undefined) {
    const qty = patch.qty ?? current.qty;
    const unit = patch.unit ?? current.unit;
    if (!(Number(qty) > 0) || !unit) throw new HttpError(400, "Enter both the amount and the unit", "BAD_WEIGHT");
    patch.qty = Number(qty);
    patch.unit = unit;
    patch.name_en = sizeLabel(Number(qty), unit);
    if (weights.some((w) => w.weight_id !== id && w.name_en.trim() === patch.name_en)) throw new HttpError(409, "That size already exists", "WEIGHT_EXISTS");
  }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0;
  const weight = await store.updateSkuWeight(id, patch);
  if (!weight) throw new HttpError(404, "Weight not found", "NOT_FOUND");
  // Keep each SKU's gram weight equal to its size definition.
  if (patch.gram_value !== undefined) {
    for (const s of (await fresh(store).skus()).filter((x) => x.weight_id === weight.weight_id)) {
      await store.updateSku(s.sku_id, { std_gram_weight: weight.gram_value, baht_weight: bahtOfGrams(weight.gram_value) });
    }
  }
  await audit(store, c.get("user"), "sku_weight.update", weight.weight_id, patch as Record<string, unknown>);
  return c.json(weight);
});

// Units (migration 20): a name and the grams in 1 of it. Admin only. The name
// never changes (a size's label is made of it); a wrong one is turned off and
// a new one added. Changing the grams recalculates every size made with the
// unit and each SKU of those sizes.
r.get("/sku-units", async (c) => c.json({ units: await storeFor(c).skuUnits() }));

function readUnitGrams(body: Record<string, any>) {
  const g = Number(body.gram_value);
  if (!(g > 0) || g > 100_000_000) throw new HttpError(400, "Enter the grams in 1 unit, above 0", "BAD_UNIT");
  return Math.round(g * 10000) / 10000;
}

r.post("/sku-units", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const unit = String(body.unit ?? "").trim().replace(/\s+/g, " ");
  if (!unit || unit.length > 30 || /\d/.test(unit)) throw new HttpError(400, "Type a unit name (no digits, up to 30 letters)", "BAD_UNIT");
  const gram_value = readUnitGrams(body);
  const units = await fresh(store).skuUnits();
  if (units.some((u) => u.unit === unit)) throw new HttpError(409, "That unit already exists", "UNIT_EXISTS");
  const row = await store.createSkuUnit({ unit, gram_value, sort_order: units.length + 1 });
  await audit(store, c.get("user"), "sku_unit.create", unit, { gram_value });
  return c.json(row);
});

r.patch("/sku-units/:unit", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const name = c.req.param("unit") ?? "";
  const units = await fresh(store).skuUnits();
  if (!units.some((u) => u.unit === name)) throw new HttpError(404, "Unit not found", "NOT_FOUND");
  const patch: Partial<SkuUnit> = {};
  if (body.gram_value !== undefined) patch.gram_value = readUnitGrams(body);
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to change", "NOTHING_TO_CHANGE");
  const row = await store.updateSkuUnit(name, patch);
  if (!row) throw new HttpError(404, "Unit not found", "NOT_FOUND");
  let resized = 0;
  if (patch.gram_value !== undefined) {
    const after = units.map((u) => (u.unit === name ? row : u));
    const skus = await fresh(store).skus();
    for (const w of await fresh(store).skuWeights()) {
      const parts = partsOf(w);
      if (!parts.some((p) => p.unit === name)) continue;
      const gram_value = partsGrams(parts, after);
      if (gram_value === null || gram_value === Number(w.gram_value)) continue;
      await store.updateSkuWeight(w.weight_id, { gram_value, ...(w.parts ? {} : { parts }) });
      for (const s of skus.filter((x) => x.weight_id === w.weight_id)) {
        await store.updateSku(s.sku_id, { std_gram_weight: gram_value, baht_weight: bahtOfGrams(gram_value) });
      }
      resized++;
    }
  }
  await audit(store, c.get("user"), "sku_unit.update", name, { ...patch, sizes_recalculated: resized });
  return c.json({ ...row, resized });
});

// ---------------------------------------------------------------------------
// Summary + system config
// ---------------------------------------------------------------------------
r.get("/settings/summary", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const [skus, staffAccounts, branches, config] = await Promise.all([store.skus(), store.staffAccounts(), store.branches(), store.config()]);
  const scoped = user.role !== "admin" ? staffAccounts.filter((a) => a.branch_id === user.branchId) : staffAccounts;
  return c.json({
    sku: skuSummary(skus),
    staff: staffAccountSummary(scoped, branches, new Date().toISOString(), user.role === "admin"),
    config,
    sync: { connected: isLive(c.env) },
  });
});

r.post("/settings/config", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  // spotLakPerBaht is intentionally not accepted: the gold price now comes from the gold_prices feed;
  // the spot_lak_per_baht column stays only as the silent fallback.
  const patch: Record<string, number | string> = {};
  const fields = { safetyBufferDays: "safety_buffer_days" } as const;
  for (const [key, column] of Object.entries(fields)) {
    if (body[key] === undefined) continue;
    const n = nonNegative(body[key]);
    if (n === null || Number.isNaN(n)) throw new HttpError(400, `${key} must be a number, 0 or more`, "BAD_CONFIG");
    patch[column] = n;
  }
  // Company-wide; each case-day keeps the mode it was opened in. The menu for it
  // is hidden since 2026-11-17 (every day uses "dynamic"); the API stays so the
  // setting can come back.
  if (body.stockOutMode !== undefined) {
    if (body.stockOutMode !== "dynamic" && body.stockOutMode !== "single") {
      throw new HttpError(400, "stockOutMode must be dynamic or single", "BAD_CONFIG");
    }
    patch.stock_out_mode = body.stockOutMode;
  }
  const updated = await store.updateConfig(patch);
  await audit(store, c.get("user"), "config.update", "system_config", patch);
  return c.json(updated);
});

r.get("/settings/about", async (c) => c.json({ version: c.env.APP_VERSION || "dev", buildDate: c.env.BUILD_DATE || null }));

// ---------------------------------------------------------------------------
// User management (admin)
// ---------------------------------------------------------------------------

// A valid username nobody else (other than `selfId`) already uses.
async function checkUsername(store: Store, raw: unknown, selfId: string | null) {
  const username = normalizeUsername(raw);
  if (!isValidUsername(username)) throw new HttpError(400, "Username: 3-30 letters a-z, digits, . _ -", "BAD_USERNAME");
  if ((await store.staffAccounts()).some((a) => a.username === username && a.id !== selfId)) {
    throw new HttpError(409, "That username is already taken", "USERNAME_TAKEN");
  }
  return username;
}
r.post("/users", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const display_name = String(body.displayName ?? "").trim();
  const role = body.role === "admin" ? "admin" : body.role === "manager" ? "manager" : "staff";
  const branch_id = role === "admin" ? null : String(body.branchId ?? "");
  if (!display_name) throw new HttpError(400, "Name is required", "BAD_USER");
  const username = await checkUsername(store, body.username, null);
  if (!isValidPassword(body.password)) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`, "BAD_PASSWORD");
  if (role !== "admin" && !(await listHaving(store, "branches", (l) => l.some((b) => b.branch_id === branch_id))).some((b) => b.branch_id === branch_id)) throw new HttpError(400, "Choose a branch", "BAD_BRANCH");
  const account = await store.createStaffAccount({ display_name: display_name.slice(0, 60), username, role, branch_id, pin_hash: await hashPassword(body.password), password_plain: body.password });
  await audit(store, c.get("user"), "user.create", account.display_name, { id: account.id, role, branch_id }, { branchId: account.branch_id });
  return c.json({ id: account.id });
});

r.patch("/users/:id", requireManager, async (c) => {
  const store = storeFor(c);
  const me = c.get("user");
  const body = await readBody(c);
  const accounts = await store.staffAccounts();
  const account = accounts.find((a) => a.id === (c.req.param("id") ?? ""));
  if (!account) throw new HttpError(404, "User not found", "NOT_FOUND");
  // A manager may only unlock staff of their own branch; nothing else.
  if (me.role === "manager") {
    const onlyUnlock = Object.keys(body).every((k) => k === "unlock") && body.unlock === true;
    if (account.role !== "staff" || !isManagerOf(me, account.branch_id ?? "") || !onlyUnlock) {
      throw new HttpError(403, "A manager can only unlock staff of their own branch", "ROLE_DENIED");
    }
  }

  const patch: Record<string, unknown> = {};
  const changes: string[] = [];
  if (body.displayName !== undefined) {
    const name = String(body.displayName).trim();
    if (!name) throw new HttpError(400, "Name cannot be empty", "BAD_USER");
    patch.display_name = name.slice(0, 60);
    changes.push("name");
  }
  if (body.username !== undefined) {
    const username = await checkUsername(store, body.username, account.id);
    if (username !== account.username) {
      patch.username = username;
      changes.push("username");
    }
  }
  if (body.branchId !== undefined && account.role !== "admin") {
    const hasBranch = (l: { branch_id: string }[]) => l.some((b) => b.branch_id === body.branchId);
    if (!hasBranch(await listHaving(store, "branches", hasBranch))) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
    patch.branch_id = body.branchId;
    changes.push("branch");
  }
  if (body.active !== undefined) {
    const active = Boolean(body.active);
    if (!active && account.id === me.accountId) throw new HttpError(409, "You cannot deactivate your own account", "SELF_DEACTIVATE");
    if (!active && account.role === "admin" && accounts.filter((a) => a.role === "admin" && a.active).length <= 1) {
      throw new HttpError(409, "At least one admin must stay active", "LAST_ADMIN");
    }
    patch.active = active;
    changes.push(active ? "activated" : "deactivated");
  }
  if (body.password !== undefined) {
    if (!isValidPassword(body.password)) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`, "BAD_PASSWORD");
    patch.pin_hash = await hashPassword(body.password);
    patch.password_plain = body.password;
    patch.failed_attempts = 0;
    patch.locked_until = null;
    changes.push("password");
  }
  if (body.unlock) {
    patch.failed_attempts = 0;
    patch.locked_until = null;
    changes.push("unlocked");
  }
  // Anything that changes who the person is or what they may see ends every
  // session they have open (name and branch are baked into the token).
  if (changes.some((ch) => ch !== "unlocked" && ch !== "activated" && ch !== "username")) patch.token_version = account.token_version + 1;
  if (changes.length === 0) return c.json({ ok: true });

  // A person moved to another branch keeps no main cases of the old one.
  if (patch.branch_id !== undefined && patch.branch_id !== account.branch_id) await store.setMainCases(account.id, []);
  await store.updateStaffAccount(account.id, patch);
  await audit(store, me, "user.update", account.display_name, { id: account.id, changes }, { branchId: account.branch_id });
  return c.json({ ok: true });
});

// Main cases (decided 2026-11-19): the cases a person mainly looks after come
// first on their Daily stock list. Ordering only: everyone in the branch still
// sees and works every case. Set by an admin or the manager of that branch.
async function mainCaseTarget(c: any) {
  const store = storeFor(c);
  const me = c.get("user");
  const account = (await store.staffAccounts()).find((a) => a.id === (c.req.param("id") ?? ""));
  if (!account) throw new HttpError(404, "User not found", "NOT_FOUND");
  if (account.role === "admin" || !account.branch_id) throw new HttpError(400, "An admin has no branch cases", "BAD_USER");
  if (me.role === "manager" && !isManagerOf(me, account.branch_id)) throw new HttpError(403, "Another branch", "ROLE_DENIED");
  return { store, me, account };
}

r.get("/users/:id/cases", requireManager, async (c) => {
  const { store, account } = await mainCaseTarget(c);
  return c.json({ deskIds: (await store.mainCases({ staffId: account.id })).map((m) => m.desk_id) });
});

r.put("/users/:id/cases", requireManager, async (c) => {
  const { store, me, account } = await mainCaseTarget(c);
  const body = await readBody(c);
  if (!Array.isArray(body.deskIds) || body.deskIds.some((d: unknown) => typeof d !== "string")) throw new HttpError(400, "deskIds must be a list", "BAD_CASES");
  const deskIds = [...new Set(body.deskIds as string[])];
  const desks = await store.desks();
  for (const id of deskIds) {
    const desk = desks.find((d) => d.desk_id === id);
    if (!desk || desk.branch_id !== account.branch_id) throw new HttpError(400, "A case of another branch", "ASSIGN_OTHER_BRANCH");
  }
  await store.setMainCases(account.id, deskIds);
  await audit(store, me, "user.cases", account.display_name, { id: account.id, desk_ids: deskIds }, { branchId: account.branch_id });
  return c.json({ deskIds });
});

// The current password of one account, for the admin (in-house decision,
// 2026-11-16). Not audited: reveals are routine. password null = not known
// yet (set before this feature and not logged in since).
r.get("/users/:id/password", requireAdmin, async (c) => {
  const account = (await storeFor(c).staffAccounts()).find((a) => a.id === (c.req.param("id") ?? ""));
  if (!account) throw new HttpError(404, "User not found", "NOT_FOUND");
  return c.json({ password: account.password_plain ?? null });
});

export default r;
