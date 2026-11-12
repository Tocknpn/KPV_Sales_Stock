import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, LedgerRow, SessionUser } from "./types";
import { getStore, isLive } from "./store";
import { verifyPin, signToken, requireAuth, requireAdmin, assertBranchAccess } from "./auth";
import {
  buildDeskCards,
  buildDeskDetail,
  buildCalendarMonth,
  deskStatusFromRows,
  enrichDocuments,
  buildDashboard,
  buildReport,
  skuSummary,
  staffAccountSummary,
  computeClosing,
  round2,
} from "./logic";

const app = new Hono<{ Bindings: Env; Variables: { user: SessionUser } }>();
app.use("/api/*", cors());

function today(env: Env) {
  return env.DEMO_DATE || new Date().toISOString().slice(0, 10);
}

function daysBefore(dateStr: string, days: number) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function datesInMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

// A brand-new Desk with zero ledger history and no explicit opening SKUs
// (e.g. created outside the normal creation flow) still needs at least one
// row on check-in, since desk status is derived purely from its rows.
const DEFAULT_STARTER_SKUS = ["RG-030", "BR-020", "NK-011", "SP-901"];

// Staff logins only ever see their own branch; admins see whatever branchId
// (or none, for "all branches") they ask for.
function scopeBranch(user: SessionUser, requestedBranchId: string | undefined) {
  return user.role === "staff" ? user.branchId ?? undefined : requestedBranchId;
}

// Public — branch names only, needed to render the login screen's branch
// picker before any session exists. No desks/config/staff data leaks here.
app.get("/api/branches", async (c) => {
  const store = getStore(c.env);
  return c.json({ branches: await store.branches() });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.get("/api/auth/accounts", async (c) => {
  const store = getStore(c.env);
  const branchId = c.req.query("branchId");
  const accounts = await store.staffAccounts();
  const filtered = accounts.filter((a) => a.active && (branchId ? a.branch_id === branchId : a.branch_id === null));
  return c.json({ accounts: filtered.map((a) => ({ id: a.id, branch_id: a.branch_id, display_name: a.display_name, role: a.role })) });
});

app.post("/api/auth/login", async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  const accounts = await store.staffAccounts();
  const account = accounts.find((a) => a.id === body.accountId);
  if (!account || !account.active) return c.json({ error: "Account not found" }, 404);
  if (account.locked_until && account.locked_until > new Date().toISOString()) {
    return c.json({ error: "Too many attempts. Try again later." }, 423);
  }
  const ok = await verifyPin(String(body.pin ?? ""), account.pin_hash);
  if (!ok) {
    return c.json({ error: "Incorrect PIN" }, 401);
  }
  const token = await signToken(account, c.env.AUTH_SECRET || "dev-insecure-secret");
  return c.json({
    token,
    user: { accountId: account.id, displayName: account.display_name, role: account.role, branchId: account.branch_id },
  });
});

app.get("/api/auth/me", requireAuth, async (c) => {
  return c.json({ user: c.get("user") });
});

app.post("/api/auth/logout", requireAuth, async (c) => {
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------
app.get("/api/meta", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const [branches, desks, config] = await Promise.all([store.branches(), store.desks(), store.config()]);
  const scopedBranches = user.role === "staff" ? branches.filter((b) => b.branch_id === user.branchId) : branches;
  const scopedDesks = user.role === "staff" ? desks.filter((d) => d.branch_id === user.branchId) : desks;
  return c.json({ branches: scopedBranches, desks: scopedDesks, config, today: today(c.env), live: isLive(c.env), user });
});

// ---------------------------------------------------------------------------
// Desks
// ---------------------------------------------------------------------------
app.post("/api/desks", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const branchId: string = body.branchId;
  if (!branchId || !assertBranchAccess(user, branchId)) return c.json({ error: "Branch access denied" }, 403);
  const displayName: string = body.displayName || "New Desk";
  const openingSkus: { sku_id: string; opening_qty: number }[] = Array.isArray(body.openingSkus) ? body.openingSkus : [];
  const { desk, rows } = await store.createDesk({ branch_id: branchId, display_name: displayName }, openingSkus, today(c.env), user.accountId);
  return c.json({ desk, rows });
});

// ---------------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------------
app.get("/api/skus", requireAuth, async (c) => {
  const store = getStore(c.env);
  const includeInactive = c.req.query("all") === "1";
  const [skus, types, weights] = await Promise.all([store.skus(), store.skuTypes(), store.skuWeights()]);
  const typeById = new Map(types.map((t) => [t.type_id, t]));
  const weightById = new Map(weights.map((w) => [w.weight_id, w]));
  const filtered = skus.filter((s) => s.is_desk_item && (includeInactive || s.active));
  return c.json({
    skus: filtered.map((s) => ({
      ...s,
      type_name: s.type_id ? typeById.get(s.type_id)?.name_en ?? null : null,
      weight_name: s.weight_id ? weightById.get(s.weight_id)?.name_en ?? null : null,
    })),
  });
});

app.post("/api/skus", requireAuth, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name_en || !body.type_id || !body.weight_id) {
    return c.json({ error: "name_en, type_id and weight_id are required" }, 400);
  }
  const [types, weights] = await Promise.all([store.skuTypes(), store.skuWeights()]);
  const type = types.find((t) => t.type_id === body.type_id);
  const weight = weights.find((w) => w.weight_id === body.weight_id);
  if (!type) return c.json({ error: "Unknown type_id" }, 400);
  if (!weight) return c.json({ error: "Unknown weight_id" }, 400);
  const sku_id = `CUSTOM-${Date.now().toString(36).toUpperCase()}`;
  const sku = await store.createSku({
    sku_id,
    name_en: body.name_en,
    name_lo: body.name_lo ?? null,
    // category/std_gram_weight are derived from Type/Weight so the existing
    // report/dashboard grouping in logic.ts (which still keys off category)
    // keeps working without changes.
    category: type.name_en,
    type_id: type.type_id,
    weight_id: weight.weight_id,
    std_gram_weight: weight.gram_value,
    purity: body.purity ?? null,
    baht_weight: body.baht_weight ?? 0,
    unit_price_lak: body.unit_price_lak ?? 0,
    reorder_level: body.reorder_level ?? 5,
    icon: body.icon ?? type.icon,
    is_desk_item: true,
  });
  return c.json(sku);
});

app.patch("/api/skus/:id", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (body.name_en !== undefined) patch.name_en = body.name_en;
  if (body.active !== undefined) patch.active = body.active;
  if (body.purity !== undefined) patch.purity = body.purity;
  if (body.baht_weight !== undefined) patch.baht_weight = body.baht_weight;
  if (body.unit_price_lak !== undefined) patch.unit_price_lak = body.unit_price_lak;
  if (body.reorder_level !== undefined) patch.reorder_level = body.reorder_level;
  if (body.type_id || body.weight_id) {
    const [types, weights] = await Promise.all([store.skuTypes(), store.skuWeights()]);
    if (body.type_id) {
      const type = types.find((t) => t.type_id === body.type_id);
      if (!type) return c.json({ error: "Unknown type_id" }, 400);
      patch.type_id = type.type_id;
      patch.category = type.name_en;
    }
    if (body.weight_id) {
      const weight = weights.find((w) => w.weight_id === body.weight_id);
      if (!weight) return c.json({ error: "Unknown weight_id" }, 400);
      patch.weight_id = weight.weight_id;
      patch.std_gram_weight = weight.gram_value;
    }
  }
  const sku = await store.updateSku(c.req.param("id") as string, patch);
  return c.json(sku);
});

// ---------------------------------------------------------------------------
// SKU Type / Weight master data (Settings > SKU setting)
// ---------------------------------------------------------------------------
app.get("/api/sku-types", requireAuth, async (c) => {
  const store = getStore(c.env);
  return c.json({ types: await store.skuTypes() });
});

app.post("/api/sku-types", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name_en) return c.json({ error: "name_en is required" }, 400);
  const type_id = body.type_id || body.name_en.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  const type = await store.createSkuType({
    type_id,
    name_en: body.name_en,
    name_lo: body.name_lo ?? null,
    icon: body.icon ?? "ring",
  });
  return c.json(type);
});

app.patch("/api/sku-types/:id", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  const type = await store.updateSkuType(c.req.param("id") as string, body);
  return c.json(type);
});

app.get("/api/sku-weights", requireAuth, async (c) => {
  const store = getStore(c.env);
  return c.json({ weights: await store.skuWeights() });
});

app.post("/api/sku-weights", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  if (!body.name_en || !body.gram_value) return c.json({ error: "name_en and gram_value are required" }, 400);
  const weight_id = body.weight_id || body.name_en.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  const weight = await store.createSkuWeight({
    weight_id,
    name_en: body.name_en,
    gram_value: Number(body.gram_value),
  });
  return c.json(weight);
});

app.patch("/api/sku-weights/:id", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  const weight = await store.updateSkuWeight(c.req.param("id") as string, body);
  return c.json(weight);
});

// ---------------------------------------------------------------------------
// Daily Stock
// ---------------------------------------------------------------------------
app.get("/api/stock/desks", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const date = c.req.query("date") || today(c.env);
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const [desks, branches, skus, ledgerRows, staffAccounts] = await Promise.all([
    store.desks(),
    store.branches(),
    store.skus(),
    store.ledger({ date, branchId }),
    store.staffAccounts(),
  ]);
  const scopedDesks = branchId ? desks.filter((d) => d.branch_id === branchId) : desks;
  const cards = buildDeskCards(scopedDesks, branches, skus, ledgerRows, staffAccounts);
  return c.json({ date, desks: cards });
});

app.get("/api/stock/calendar", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const month = c.req.query("month") || today(c.env).slice(0, 7);
  if (!branchId) return c.json({ error: "branchId is required" }, 400);
  const dates = datesInMonth(month);
  const [desks, ledgerRows] = await Promise.all([
    store.desks(),
    store.ledger({ from: dates[0], to: dates[dates.length - 1], branchId }),
  ]);
  const scopedDesks = desks.filter((d) => d.branch_id === branchId);
  return c.json({ month, days: buildCalendarMonth(dates, scopedDesks, ledgerRows) });
});

app.get("/api/stock/desk/:deskId", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const deskId = c.req.param("deskId");
  const date = c.req.query("date") || today(c.env);
  const [desks, branches, skus, ledgerRows, staffAccounts, weights] = await Promise.all([
    store.desks(),
    store.branches(),
    store.skus(),
    store.ledger({ date, deskId }),
    store.staffAccounts(),
    store.skuWeights(),
  ]);
  const desk = desks.find((d) => d.desk_id === deskId);
  if (!desk) return c.json({ error: "Desk not found" }, 404);
  if (!assertBranchAccess(user, desk.branch_id)) return c.json({ error: "Branch access denied" }, 403);
  const branch = branches.find((b) => b.branch_id === desk.branch_id);
  return c.json(buildDeskDetail(desk, branch, skus, ledgerRows, staffAccounts, await store.config(), weights));
});

app.post("/api/stock/desk/:deskId/checkin", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const deskId = c.req.param("deskId");
  const body = await c.req.json().catch(() => ({}));
  const date: string = body.date || today(c.env);
  const desks = await store.desks();
  const desk = desks.find((d) => d.desk_id === deskId);
  if (!desk) return c.json({ error: "Desk not found" }, 404);
  if (!assertBranchAccess(user, desk.branch_id)) return c.json({ error: "Branch access denied" }, 403);

  const existingToday = (await store.ledger({ date, deskId })).filter((r) => !r.excluded);
  if (existingToday.some((r) => r.desk_status === "done")) {
    return c.json({ error: "This day is already Done for this Desk" }, 409);
  }
  if (existingToday.length > 0) {
    // Already checked in by someone else today — idempotent resume, just
    // stamp who tapped Check In most recently.
    await store.upsertLedgerRows(existingToday.map((r) => ({ ...r, performed_by: user.accountId })));
    return c.json({ ok: true });
  }

  // Carry forward the most recent DONE closing per SKU, searching back
  // across any gap (not just "yesterday"); excluded rows don't count.
  const history = (await store.ledger({ deskId, to: date })).filter((r) => r.desk_status === "done" && !r.excluded);
  const latestBySku = new Map<string, LedgerRow>();
  for (const r of history) {
    const existing = latestBySku.get(r.sku_id);
    if (!existing || r.ledger_date > existing.ledger_date) latestBySku.set(r.sku_id, r);
  }
  const skuIds = latestBySku.size > 0 ? [...latestBySku.keys()] : DEFAULT_STARTER_SKUS;
  const rows = skuIds.map((skuId) => {
    const prev = latestBySku.get(skuId);
    return {
      ledger_date: date,
      desk_id: deskId,
      branch_id: desk.branch_id,
      sku_id: skuId,
      opening_qty: prev?.closing_qty ?? 0,
      stock_in: 0,
      retail_sale: 0,
      wholesale: 0,
      transfer_out: 0,
      destock: 0,
      destock_note: null,
      move: 0,
      closing_qty: prev?.closing_qty ?? 0,
      closing_gram: 0,
      closing_baht: 0,
      counted_qty: null,
      counted_note: null,
      performed_by: user.accountId,
      excluded: false,
      audit_verified: false,
      desk_status: "check_in" as const,
    };
  });
  if (rows.length > 0) await store.upsertLedgerRows(rows);
  return c.json({ ok: true });
});

app.post("/api/stock/desk/:deskId/entry", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const deskId = c.req.param("deskId");
  const body = await c.req.json();
  const date: string = body.date || today(c.env);
  const desks = await store.desks();
  const desk = desks.find((d) => d.desk_id === deskId);
  if (!desk) return c.json({ error: "Desk not found" }, 404);
  if (!assertBranchAccess(user, desk.branch_id)) return c.json({ error: "Branch access denied" }, 403);
  const skus = await store.skus();
  const sku = skus.find((s) => s.sku_id === body.sku_id);

  const existing = (await store.ledger({ date, deskId })).find((r) => r.sku_id === body.sku_id);
  if (existing?.desk_status === "done") {
    return c.json({ error: "This day is Done and locked for this Desk" }, 423);
  }
  const opening_qty = existing?.opening_qty ?? body.opening_qty ?? 0;
  const stock_in = Number(body.stock_in ?? existing?.stock_in ?? 0);
  const retail_sale = Number(body.retail_sale ?? existing?.retail_sale ?? 0);
  const wholesale = Number(body.wholesale ?? existing?.wholesale ?? 0);
  const transfer_out = Number(body.transfer_out ?? existing?.transfer_out ?? 0);
  const destock = Number(body.destock ?? existing?.destock ?? 0);
  const move = Number(body.move ?? existing?.move ?? 0);
  const closing_qty = computeClosing({ opening_qty, stock_in, retail_sale, wholesale, transfer_out, destock, move });

  const [updated] = await store.upsertLedgerRows([
    {
      ledger_date: date,
      desk_id: deskId,
      branch_id: desk.branch_id,
      sku_id: body.sku_id,
      opening_qty,
      stock_in,
      retail_sale,
      wholesale,
      transfer_out,
      destock,
      destock_note: body.destock_note ?? existing?.destock_note ?? null,
      move,
      closing_qty,
      closing_gram: round2(closing_qty * (sku?.std_gram_weight ?? 0)),
      closing_baht: round2(closing_qty * (sku?.baht_weight ?? 0)),
      counted_qty: body.counted_qty !== undefined ? body.counted_qty : existing?.counted_qty ?? null,
      counted_note: body.counted_note ?? existing?.counted_note ?? null,
      performed_by: user.accountId,
      excluded: existing?.excluded ?? false,
      audit_verified: existing?.audit_verified ?? false,
      desk_status: existing?.desk_status ?? "check_in",
      safe_drop_note: body.safe_drop_note ?? existing?.safe_drop_note ?? null,
    },
  ]);
  return c.json(updated);
});

const STATUS_ORDER = ["check_in", "final_stock", "done"] as const;

app.post("/api/stock/desk/:deskId/transition", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const deskId = c.req.param("deskId");
  const body = await c.req.json().catch(() => ({}));
  const date: string = body.date || today(c.env);
  const toStatus: string = body.toStatus;
  if (!STATUS_ORDER.includes(toStatus as (typeof STATUS_ORDER)[number])) return c.json({ error: "Invalid status" }, 400);

  const desks = await store.desks();
  const desk = desks.find((d) => d.desk_id === deskId);
  if (!desk) return c.json({ error: "Desk not found" }, 404);
  if (!assertBranchAccess(user, desk.branch_id)) return c.json({ error: "Branch access denied" }, 403);

  const rows = await store.ledger({ date, deskId });
  const activeRows = rows.filter((r) => !r.excluded);
  if (activeRows.length === 0) return c.json({ error: "No entries to transition" }, 400);
  const current = deskStatusFromRows(rows);
  const currentIdx = STATUS_ORDER.indexOf(current as (typeof STATUS_ORDER)[number]);
  const targetIdx = STATUS_ORDER.indexOf(toStatus as (typeof STATUS_ORDER)[number]);
  if (currentIdx === -1 || targetIdx !== currentIdx + 1) {
    return c.json({ error: `Cannot move from ${current} to ${toStatus}` }, 400);
  }

  await store.upsertLedgerRows(
    activeRows.map((r) => ({
      ...r,
      desk_status: toStatus as (typeof STATUS_ORDER)[number],
      performed_by: user.accountId,
      audit_verified: toStatus === "done" ? true : r.audit_verified,
      safe_drop_note: body.safe_drop_note ?? r.safe_drop_note,
    }))
  );
  return c.json({ ok: true });
});

app.post("/api/stock/desk/:deskId/sku", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const deskId = c.req.param("deskId");
  const body = await c.req.json().catch(() => ({}));
  const date: string = body.date || today(c.env);
  const skuId: string = body.sku_id;
  if (!skuId) return c.json({ error: "sku_id is required" }, 400);

  const desks = await store.desks();
  const desk = desks.find((d) => d.desk_id === deskId);
  if (!desk) return c.json({ error: "Desk not found" }, 404);
  if (!assertBranchAccess(user, desk.branch_id)) return c.json({ error: "Branch access denied" }, 403);

  const todayRows = await store.ledger({ date, deskId });
  const existing = todayRows.find((r) => r.sku_id === skuId);
  if (existing) {
    if (existing.desk_status === "done") return c.json({ error: "This day is Done and locked for this Desk" }, 423);
    const [row] = await store.upsertLedgerRows([{ ...existing, excluded: false, performed_by: user.accountId }]);
    return c.json(row);
  }

  const history = (await store.ledger({ deskId, to: date })).filter((r) => r.sku_id === skuId && r.desk_status === "done" && !r.excluded);
  const prev = history.sort((a, b) => b.ledger_date.localeCompare(a.ledger_date))[0];
  const currentStatus = deskStatusFromRows(todayRows);
  const [row] = await store.upsertLedgerRows([
    {
      ledger_date: date,
      desk_id: deskId,
      branch_id: desk.branch_id,
      sku_id: skuId,
      opening_qty: prev?.closing_qty ?? 0,
      stock_in: 0,
      retail_sale: 0,
      wholesale: 0,
      transfer_out: 0,
      destock: 0,
      destock_note: null,
      move: 0,
      closing_qty: prev?.closing_qty ?? 0,
      closing_gram: 0,
      closing_baht: 0,
      counted_qty: null,
      counted_note: null,
      performed_by: user.accountId,
      excluded: false,
      audit_verified: false,
      desk_status: currentStatus === "not_started" ? "check_in" : currentStatus,
    },
  ]);
  return c.json(row);
});

app.delete("/api/stock/desk/:deskId/sku/:skuId", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const deskId = c.req.param("deskId");
  const skuId = c.req.param("skuId");
  const date = c.req.query("date") || today(c.env);

  const desks = await store.desks();
  const desk = desks.find((d) => d.desk_id === deskId);
  if (!desk) return c.json({ error: "Desk not found" }, 404);
  if (!assertBranchAccess(user, desk.branch_id)) return c.json({ error: "Branch access denied" }, 403);

  const existing = (await store.ledger({ date, deskId })).find((r) => r.sku_id === skuId);
  if (!existing) return c.json({ ok: true });
  if (existing.desk_status === "done") return c.json({ error: "This day is Done and locked for this Desk" }, 423);
  await store.upsertLedgerRows([{ ...existing, excluded: true, performed_by: user.accountId }]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Documents — free-form, timestamped, locked-once-saved records. No approval
// workflow: create, save, print.
// ---------------------------------------------------------------------------
app.get("/api/documents", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const deskId = c.req.query("deskId") || undefined;
  const date = c.req.query("date") || undefined;
  const page = Number(c.req.query("page") || 1);
  const pageSize = Number(c.req.query("pageSize") || 10);
  const [{ rows, total }, branches, desks] = await Promise.all([
    store.documents({ branchId, deskId, date, page, pageSize }),
    store.branches(),
    store.desks(),
  ]);
  return c.json({ documents: enrichDocuments(rows, branches, desks), total, page, pageSize });
});

app.post("/api/documents", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const body = await c.req.json();
  const branchId: string = body.branchId;
  if (!assertBranchAccess(user, branchId)) return c.json({ error: "Branch access denied" }, 403);
  const rows = (body.rows ?? []).map((r: { item: string; qty?: number; weight_g?: number; note?: string }, i: number) => ({
    sort_order: i,
    item: r.item ?? "",
    qty: r.qty ?? null,
    weight_g: r.weight_g ?? null,
    note: r.note ?? null,
  }));
  const doc = await store.createDocument(
    {
      title: body.title,
      branch_id: branchId,
      desk_id: body.deskId ?? null,
      created_by: user.displayName,
      doc_date: body.date || today(c.env),
      notes: body.notes ?? null,
    },
    rows
  );
  const [branches, desks] = await Promise.all([store.branches(), store.desks()]);
  return c.json(enrichDocuments([doc], branches, desks)[0]);
});

app.delete("/api/documents/:id", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "id is required" }, 400);
  const ok = await store.deleteDocument(id);
  if (!ok) return c.json({ error: "Document not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/documents/:id/print", requireAuth, async (c) => {
  const store = getStore(c.env);
  const id = c.req.param("id");
  // Printing a single doc doesn't need the list's pagination — fetch broadly
  // (pageSize well above realistic volume) rather than paging through it.
  const [{ rows: docsList }, branches, desks] = await Promise.all([
    store.documents({ page: 1, pageSize: 10000 }),
    store.branches(),
    store.desks(),
  ]);
  const doc = enrichDocuments(docsList, branches, desks).find((d) => d.id === id);
  if (!doc) return c.text("Document not found", 404);
  const rowsHtml = doc.rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.item)}</td>
        <td style="text-align:right">${r.qty ?? ""}</td>
        <td style="text-align:right">${r.weight_g ?? ""}</td>
        <td>${r.note ? escapeHtml(r.note) : ""}</td>
      </tr>`
    )
    .join("");
  const html = `<!doctype html>
<html lang="lo"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Noto+Sans+Lao:wght@400;500;600;700&display=swap" rel="stylesheet" />
<title>${escapeHtml(doc.doc_no)} — ${escapeHtml(doc.title)}</title>
<style>
  body{font-family:'Plus Jakarta Sans','Noto Sans Lao',Arial,sans-serif;color:#111;padding:32px;max-width:720px;margin:auto}
  h1{color:#990000;font-size:20px;margin-bottom:4px}
  .meta{color:#555;font-size:13px;margin-bottom:24px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border-bottom:1px solid #e5e7eb;padding:8px 6px;text-align:left}
  th{color:#888;text-transform:uppercase;font-size:11px}
  .totals{margin-top:16px;text-align:right;font-weight:700}
  .pill{display:inline-block;padding:4px 10px;border-radius:999px;background:#ffebeb;color:#990000;font-size:12px;font-weight:700}
  @media print{ .no-print{display:none} }
</style></head>
<body>
  <h1>${escapeHtml(doc.title)}</h1>
  <div class="meta">
    <strong>${escapeHtml(doc.doc_no)}</strong> &nbsp;·&nbsp; ${doc.doc_date} &nbsp;·&nbsp; ${escapeHtml(doc.branch_name)}
    ${doc.desk_id ? ` (${doc.desk_id})` : ""} &nbsp;·&nbsp; By ${escapeHtml(doc.created_by)}
    &nbsp;·&nbsp; <span class="pill">${new Date(doc.created_at).toLocaleString("en-GB")}</span>
  </div>
  <table>
    <thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Weight (g)</th><th>Note</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="totals">${doc.rowCount} rows · ${doc.totalWeightG.toFixed(2)} g total</div>
  ${doc.notes ? `<p style="margin-top:20px;color:#555;font-size:13px">Notes: ${escapeHtml(doc.notes)}</p>` : ""}
  <p class="no-print" style="margin-top:32px"><button onclick="window.print()">Print / Save as PDF</button></p>
</body></html>`;
  return c.html(html);
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
app.get("/api/dashboard", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const date = today(c.env);
  const period = c.req.query("period") === "mtd" ? "mtd" : "today";
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const deskId = c.req.query("deskId") || undefined;
  const category = c.req.query("category") || undefined;
  const stockFlag = c.req.query("stockFlag") === "low" || c.req.query("stockFlag") === "over" ? (c.req.query("stockFlag") as "low" | "over") : undefined;
  const movementFrom = period === "mtd" ? `${date.slice(0, 7)}-01` : date;

  const [skus, branches, branchTargets, snapshotRows, movementRows, agingRows, portfolio, config] = await Promise.all([
    store.skus(),
    store.branches(),
    store.branchTargets(),
    store.ledger({ date, branchId, deskId }),
    store.ledger({ from: movementFrom, to: date, branchId, deskId }),
    store.ledger({ from: daysBefore(date, 90), to: date, branchId, deskId }),
    store.portfolioSnapshot(),
    store.config(),
  ]);
  return c.json(
    buildDashboard(skus, branches, branchTargets, snapshotRows, movementRows, agingRows, portfolio, config, {
      branchId,
      deskId,
      category,
      stockFlag,
    })
  );
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
app.get("/api/report", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const period = c.req.query("period") || today(c.env).slice(0, 7);
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const deskId = c.req.query("deskId") || undefined;
  const q = c.req.query("q") || undefined;
  const from = `${period}-01`;
  const to = `${period}-31`;
  const [rows, skus, desks, config] = await Promise.all([
    store.ledger({ from, to, branchId, deskId }),
    store.skus(),
    store.desks(),
    store.config(),
  ]);
  return c.json(buildReport(rows, skus, desks, { period, branchId, deskId, q }, config));
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
app.get("/api/settings/summary", requireAuth, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const [skus, staffAccounts, branches, config] = await Promise.all([
    store.skus(),
    store.staffAccounts(),
    store.branches(),
    store.config(),
  ]);
  const scopedAccounts = user.role === "staff" ? staffAccounts.filter((a) => a.branch_id === user.branchId) : staffAccounts;
  return c.json({
    sku: skuSummary(skus),
    staff: staffAccountSummary(scopedAccounts, branches),
    config,
    sync: { connected: isLive(c.env) },
  });
});

app.post("/api/settings/config", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json();
  const updated = await store.updateConfig({
    safety_buffer_days: body.safetyBufferDays,
    auto_draft_po: body.autoDraftPo,
  });
  return c.json(updated);
});

// ---------------------------------------------------------------------------
// Order lead time and avg. RR setting (per-SKU run rate)
// ---------------------------------------------------------------------------
app.get("/api/settings/run-rate", requireAuth, async (c) => {
  const store = getStore(c.env);
  const [skus, types, weights] = await Promise.all([store.skus(), store.skuTypes(), store.skuWeights()]);
  const typeById = new Map(types.map((t) => [t.type_id, t]));
  const weightById = new Map(weights.map((w) => [w.weight_id, w]));
  const active = skus.filter((s) => s.active && s.is_desk_item);
  const items = active.map((s) => ({
    sku_id: s.sku_id,
    name_en: s.name_en,
    icon: s.icon,
    type_name: s.type_id ? typeById.get(s.type_id)?.name_en ?? null : null,
    weight_name: s.weight_id ? weightById.get(s.weight_id)?.name_en ?? null : null,
    avg_daily_sales: s.avg_daily_sales,
    order_lead_time_days: s.order_lead_time_days,
  }));
  const filledSales = items.filter((i) => i.avg_daily_sales != null).length;
  const filledLeadTime = items.filter((i) => i.order_lead_time_days != null).length;
  return c.json({ items, summary: { total: items.length, filledSales, filledLeadTime } });
});

app.post("/api/settings/run-rate/:skuId", requireAuth, requireAdmin, async (c) => {
  const store = getStore(c.env);
  const body = await c.req.json().catch(() => ({}));
  const sku = await store.updateSkuRunRate(c.req.param("skuId") as string, {
    avg_daily_sales: body.avgDailySales ?? null,
    order_lead_time_days: body.orderLeadTimeDays ?? null,
  });
  return c.json(sku);
});

app.get("/api/settings/about", requireAuth, async (c) => {
  return c.json({ version: c.env.APP_VERSION || "dev", buildDate: c.env.BUILD_DATE || null });
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
