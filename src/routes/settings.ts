// Settings: SKU master data (incl. CSV import), system config,
// user management. Reads are open to every logged-in user;
// every change is admin only.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, audit } from "../app";
import type { NewSku, Store } from "../store";
import { requireAdmin, requireManager, hashPassword, isValidPassword, normalizeUsername, isValidUsername, isManagerOf, MIN_PASSWORD } from "../auth";
import { isLive } from "../time";
import { skuSummary, staffAccountSummary } from "../logic";
import type { MasterSku, SkuType, SkuWeight } from "../types";

const r = newRouter();

const MAX_IMPORT_ROWS = 500;
// Every SKU is gold (decided 2026-11-17): its Baht weight follows its size.
export const GRAMS_PER_BAHT = 15.244;
const bahtOfGrams = (g: number | null | undefined) => (g && g > 0 ? Math.round((g / GRAMS_PER_BAHT) * 10000) / 10000 : 0);
// Same limits as replenishment rules (the engine reads only rules).
const MAX_RULE_AVG = 9_999_999;
const MAX_RULE_LEAD = 9999.9;

// Avg/day and lead time live only in company-wide SKU rules; a blank value
// inherits (Type rule, then automatic velocity / default lead time).
async function writeSkuRule(store: Store, skuId: string, avg: number | null, lead: number | null) {
  await store.upsertRule({
    scope: "sku",
    scope_key: skuId,
    branch_id: null,
    avg_daily_sell: avg == null ? null : Math.round(avg * 1000) / 1000,
    lead_time_days: lead == null ? null : Math.round(lead * 10) / 10,
  });
}

// The two planning numbers of a form / CSV line: { avg, lead } (null = blank) or an error text.
function planNumbers(input: Record<string, any>): { avg: number | null; lead: number | null } | string {
  const avg = nonNegative(input.avg_daily_sell ?? input.avg_daily_sales);
  const lead = nonNegative(input.lead_time_days ?? input.order_lead_time_days);
  if (Number.isNaN(avg) || (avg !== null && avg > MAX_RULE_AVG)) return `avg_daily_sell must be a number from 0 to ${MAX_RULE_AVG}`;
  if (Number.isNaN(lead) || (lead !== null && lead > MAX_RULE_LEAD)) return `lead_time_days must be a number from 0 to ${MAX_RULE_LEAD}`;
  return { avg, lead };
}

// The SKU name: one Lao name (name, or name_lo; old files may only have name_en).
function skuNameOf(input: Record<string, any>) {
  return String(input.name ?? input.name_lo ?? input.name_en ?? "").trim().slice(0, 120);
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
r.get("/skus", async (c) => {
  const store = storeFor(c);
  const includeInactive = c.req.query("all") === "1";
  const [skus, types, weights] = await Promise.all([store.skus(), store.skuTypes(), store.skuWeights()]);
  const typeById = new Map(types.map((t) => [t.type_id, t]));
  const weightById = new Map(weights.map((w) => [w.weight_id, w]));
  return c.json({
    skus: skus
      .filter((s) => includeInactive || s.active)
      .map((s) => ({
        ...s,
        type_name: s.type_id ? typeById.get(s.type_id)?.name_en ?? null : null,
        weight_name: s.weight_id ? weightById.get(s.weight_id)?.name_en ?? null : null,
      })),
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

r.post("/skus", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const [types, weights] = await Promise.all([store.skuTypes(), store.skuWeights()]);
  if (!body.weight_id) throw new HttpError(400, "name, type_id and weight_id are required", "BAD_SKU");
  const built = buildSku(body, types, weights);
  if (typeof built === "string") throw new HttpError(400, built, "BAD_SKU");
  const [created] = await store.createSkus([built.sku]);
  if (built.avg !== null || built.lead !== null) await writeSkuRule(store, created.sku_id, built.avg, built.lead);
  await audit(store, c.get("user"), "sku.create", created.sku_id, { name_en: created.name_en });
  return c.json(created);
});

// CSV import. Body: { rows: [{ sku_id, name, type, weight, avg_daily_sell, lead_time_days }] }
// (the browser parses the file). Every row is validated first; if any row is
// wrong nothing is imported and the errors are returned per line.
r.post("/skus/import", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const rows: Record<string, any>[] = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) throw new HttpError(400, "The file has no rows", "EMPTY_IMPORT");
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time`, "IMPORT_TOO_LARGE");

  const [types, weights, existing] = await Promise.all([store.skuTypes(), store.skuWeights(), store.skus()]);
  const taken = new Set(existing.map((s) => s.sku_id.toLowerCase()));
  const errors: { line: number; error: string }[] = [];
  const built: BuiltSku[] = [];
  rows.forEach((row, i) => {
    const line = i + 2; // line 1 is the CSV header
    const b = buildSku(row ?? {}, types, weights);
    if (typeof b === "string") return errors.push({ line, error: b });
    if (taken.has(b.sku.sku_id.toLowerCase())) return errors.push({ line, error: `sku_id ${b.sku.sku_id} already exists` });
    taken.add(b.sku.sku_id.toLowerCase());
    built.push(b);
  });
  if (errors.length > 0) throw new HttpError(422, "Nothing was imported — fix these rows and try again", "IMPORT_INVALID", { errors });

  const created = await store.createSkus(built.map((b) => b.sku));
  for (const b of built) if (b.avg !== null || b.lead !== null) await writeSkuRule(store, b.sku.sku_id, b.avg, b.lead);
  await audit(store, c.get("user"), "sku.import", `${created.length} SKUs`, { sku_ids: created.map((s) => s.sku_id).slice(0, 50) });
  return c.json({ imported: created.length });
});

r.patch("/skus/:id", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const patch: Partial<MasterSku> = {};
  const nameInput = body.name ?? body.name_lo ?? body.name_en;
  if (nameInput !== undefined) {
    const name = String(nameInput ?? "").trim().slice(0, 120);
    if (!name) throw new HttpError(400, "name cannot be empty", "BAD_SKU");
    patch.name_en = name;
    patch.name_lo = name;
  }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  // Planning numbers: sent = set (blank = inherit); not sent = unchanged.
  const planSent = body.avg_daily_sell !== undefined || body.lead_time_days !== undefined;
  const plan = planSent ? planNumbers(body) : null;
  if (typeof plan === "string") throw new HttpError(400, plan, "BAD_SKU");
  if (body.type_id || body.weight_id) {
    const [types, weights] = await Promise.all([store.skuTypes(), store.skuWeights()]);
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
  const sku = await store.updateSku((c.req.param("id") ?? ""), patch);
  if (!sku) throw new HttpError(404, "SKU not found", "NOT_FOUND");
  if (plan) await writeSkuRule(store, sku.sku_id, plan.avg, plan.lead);
  const changes = plan ? { ...patch, avg_daily_sell: plan.avg, lead_time_days: plan.lead } : patch;
  await audit(store, c.get("user"), "sku.update", sku.sku_id, changes as Record<string, unknown>);
  return c.json(sku);
});

// ---------------------------------------------------------------------------
// SKU Type / Weight master data
// ---------------------------------------------------------------------------
r.get("/sku-types", async (c) => c.json({ types: await storeFor(c).skuTypes() }));

r.post("/sku-types", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const name_en = String(body.name_en ?? "").trim();
  if (!name_en) throw new HttpError(400, "name_en is required", "BAD_TYPE");
  const type_id = slug(body.type_id || name_en);
  if (!type_id) throw new HttpError(400, "name_en must contain letters or digits", "BAD_TYPE");
  const type = await store.createSkuType({ type_id, name_en, name_lo: body.name_lo ?? null, icon: body.icon ?? "ring" });
  await audit(store, c.get("user"), "sku_type.create", type.type_id, { name_en });
  return c.json(type);
});

// Renaming a type must also rename the mirrored category on its SKUs, or
// grouping would split the type in two.
async function renameCategory(store: Store, typeId: string, name: string) {
  const skus = (await store.skus()).filter((s) => s.type_id === typeId && s.category !== name);
  for (const s of skus) await store.updateSku(s.sku_id, { category: name });
}

r.patch("/sku-types/:id", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const patch: Partial<SkuType> = {};
  if (body.name_en !== undefined) {
    if (!String(body.name_en).trim()) throw new HttpError(400, "name_en cannot be empty", "BAD_TYPE");
    patch.name_en = String(body.name_en).trim();
  }
  if (body.name_lo !== undefined) patch.name_lo = body.name_lo || null;
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

r.post("/sku-weights", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const name_en = String(body.name_en ?? "").trim();
  const gram_value = Number(body.gram_value);
  if (!name_en || !(gram_value > 0)) throw new HttpError(400, "name_en and a gram_value above 0 are required", "BAD_WEIGHT");
  // Names are Lao now, which slug() drops: fall back to the grams.
  const weight_id = slug(body.weight_id || name_en) || `W_${String(gram_value).replace(/[.]/g, "_")}`;
  if ((await store.skuWeights()).some((w) => w.weight_id === weight_id)) throw new HttpError(409, "That size already exists", "WEIGHT_EXISTS");
  const weight = await store.createSkuWeight({ weight_id, name_en, gram_value });
  await audit(store, c.get("user"), "sku_weight.create", weight.weight_id, { name_en, gram_value });
  return c.json(weight);
});

r.patch("/sku-weights/:id", requireAdmin, async (c) => {
  const store = storeFor(c);
  const body = await readBody(c);
  const patch: Partial<SkuWeight> = {};
  if (body.name_en !== undefined) {
    if (!String(body.name_en).trim()) throw new HttpError(400, "name_en cannot be empty", "BAD_WEIGHT");
    patch.name_en = String(body.name_en).trim();
  }
  if (body.gram_value !== undefined) {
    if (!(Number(body.gram_value) > 0)) throw new HttpError(400, "gram_value must be above 0", "BAD_WEIGHT");
    patch.gram_value = Number(body.gram_value);
  }
  if (body.active !== undefined) patch.active = Boolean(body.active);
  if (body.sort_order !== undefined) patch.sort_order = Number(body.sort_order) || 0;
  const weight = await store.updateSkuWeight((c.req.param("id") ?? ""), patch);
  if (!weight) throw new HttpError(404, "Weight not found", "NOT_FOUND");
  // Keep each SKU's gram weight equal to its size definition.
  if (patch.gram_value !== undefined) {
    for (const s of (await store.skus()).filter((x) => x.weight_id === weight.weight_id)) {
      await store.updateSku(s.sku_id, { std_gram_weight: weight.gram_value, baht_weight: bahtOfGrams(weight.gram_value) });
    }
  }
  await audit(store, c.get("user"), "sku_weight.update", weight.weight_id, patch as Record<string, unknown>);
  return c.json(weight);
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
  const fields = { safetyBufferDays: "safety_buffer_days", usdToLakRate: "usd_to_lak_rate" } as const;
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
  if (role !== "admin" && !(await store.branches()).some((b) => b.branch_id === branch_id)) throw new HttpError(400, "Choose a branch", "BAD_BRANCH");
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
    if (!(await store.branches()).some((b) => b.branch_id === body.branchId)) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
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

  await store.updateStaffAccount(account.id, patch);
  await audit(store, me, "user.update", account.display_name, { id: account.id, changes }, { branchId: account.branch_id });
  return c.json({ ok: true });
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
