// Daily Stock: desk cards, the desk day lifecycle
// (not started -> check_in -> final_stock -> done) and row entry.
import { storeFor, newRouter, readBody, HttpError, scopeBranch, requireDesk, requireDate, assertDateWritable, getDay, requireOpenDay, audit } from "../app";
import type { Ctx } from "../app";
import type { Store, LedgerRowPatch, NewLedgerRow } from "../store";
import { requireManager, assertBranchAccess, isManagerOf } from "../auth";
import { addDays, businessDate, datesInMonth, isValidMonth } from "../time";
import { buildDeskCards, buildDeskDetail, buildCalendarMonth, carryQty, parseQty, validateDeskDay } from "../logic";
import type { DeskDay, LedgerRow, SessionUser } from "../types";

// Mounted behind requireAuth in src/index.ts.
const r = newRouter();

// A branch manager may reopen a Done day of their own branch up to this many
// days back; an admin has no limit.
export const MANAGER_REOPEN_DAYS = 3;
const withinManagerWindow = (date: string, today: string) => date >= addDays(today, -MANAGER_REOPEN_DAYS);

function mayReopen(user: SessionUser, branchId: string, date: string, today: string) {
  return user.role === "admin" || (isManagerOf(user, branchId) && withinManagerWindow(date, today));
}

function hasActivity(row: LedgerRow) {
  return (
    row.opening_qty !== 0 ||
    row.stock_in !== 0 ||
    row.transfer_in !== 0 ||
    row.retail_sale !== 0 ||
    row.wholesale !== 0 ||
    row.transfer_out !== 0 ||
    row.destock !== 0 ||
    row.move !== 0
  );
}

// Hands a closed day's stock to the following day: each SKU opens with what
// was physically counted (or the calculated closing when there was no count).
async function carryForward(store: Store, from: DeskDay, toDate: string, actor: string) {
  const [fromRows, toRows] = await Promise.all([
    store.ledger({ deskId: from.desk_id, date: from.ledger_date }),
    store.ledger({ deskId: from.desk_id, date: toDate }),
  ]);
  const existing = new Map(toRows.map((row) => [row.sku_id, row]));
  const inserts: NewLedgerRow[] = [];
  const patches: LedgerRowPatch[] = [];
  for (const row of fromRows) {
    if (row.excluded) continue;
    const opening = Math.max(0, carryQty(row));
    const target = existing.get(row.sku_id);
    const key = { ledger_date: toDate, desk_id: from.desk_id, sku_id: row.sku_id, branch_id: from.branch_id };
    if (!target) inserts.push({ ...key, opening_qty: opening, performed_by: actor });
    else if (target.opening_qty !== opening) patches.push({ ...key, opening_qty: opening });
  }
  await store.insertLedgerRows(inserts);
  await store.patchLedgerRows(patches);
}

// ---------------------------------------------------------------------------
// Desk cards + calendar
// ---------------------------------------------------------------------------
r.get("/stock/desks", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const today = businessDate(c.env);
  const date = requireDate(c.req.query("date"), today);
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const [desks, branches, skus, days, ledgerRows, staffAccounts, config, openEarlier] = await Promise.all([
    store.desks(),
    store.branches(),
    store.skus(),
    store.deskDays({ date, branchId }),
    store.ledger({ date, branchId }),
    store.staffAccounts(),
    store.config(),
    store.deskDays({ branchId, before: date, notStatus: "done" }),
  ]);
  const scopedDesks = branchId ? desks.filter((d) => d.branch_id === branchId) : desks;
  // Earliest unfinished earlier day per desk — check-in is blocked until it is closed.
  const blockedBy = new Map<string, string>();
  for (const d of openEarlier) if (!blockedBy.has(d.desk_id)) blockedBy.set(d.desk_id, d.ledger_date);
  const cards = buildDeskCards(scopedDesks, branches, skus, days, ledgerRows, staffAccounts, config).map((card) => ({
    ...card,
    openEarlierDate: blockedBy.get(card.desk_id) ?? null,
  }));
  return c.json({ date, today, desks: cards });
});

r.get("/stock/calendar", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  if (!branchId) throw new HttpError(400, "branchId is required", "BRANCH_REQUIRED");
  const month = c.req.query("month") || businessDate(c.env).slice(0, 7);
  if (!isValidMonth(month)) throw new HttpError(400, "Invalid month", "BAD_MONTH");
  const dates = datesInMonth(month);
  const [desks, days] = await Promise.all([store.desks(), store.deskDays({ from: dates[0], to: dates[dates.length - 1], branchId })]);
  return c.json({ month, days: buildCalendarMonth(dates, desks.filter((d) => d.branch_id === branchId), days) });
});

// ---------------------------------------------------------------------------
// New desk ("case") with its starting stock
// ---------------------------------------------------------------------------
r.post("/desks", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const branchId = String(body.branchId ?? "");
  if (!(await store.branches()).some((b) => b.branch_id === branchId)) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
  if (!assertBranchAccess(user, branchId)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  const displayName = String(body.displayName ?? "").trim();
  if (!displayName) throw new HttpError(400, "Case name is required", "NAME_REQUIRED");

  const skuIds = new Set((await store.skus()).filter((s) => s.active).map((s) => s.sku_id));
  const opening = new Map<string, number>();
  for (const item of Array.isArray(body.openingSkus) ? body.openingSkus : []) {
    const qty = parseQty(item?.opening_qty);
    if (!skuIds.has(item?.sku_id) || qty === null) throw new HttpError(400, "Invalid opening stock row", "BAD_OPENING");
    opening.set(item.sku_id, qty);
  }

  const today = businessDate(c.env);
  const desk = await store.createDesk({ branch_id: branchId, display_name: displayName });
  await store.insertDeskDay({ desk_id: desk.desk_id, ledger_date: today, branch_id: branchId, checked_in_by: user.accountId });
  const rows = await store.insertLedgerRows(
    [...opening.entries()].map(([sku_id, opening_qty]) => ({
      ledger_date: today,
      desk_id: desk.desk_id,
      branch_id: branchId,
      sku_id,
      opening_qty,
      performed_by: user.accountId,
    }))
  );
  await audit(store, user, "desk.create", desk.desk_id, { display_name: displayName, opening: Object.fromEntries(opening) });
  return c.json({ desk, rows });
});

// ---------------------------------------------------------------------------
// Desk detail
// ---------------------------------------------------------------------------
async function deskDetail(c: Ctx, store: Store, user: SessionUser, deskId: string, date: string) {
  const desk = await requireDesk(store, user, deskId);
  const [branches, skus, days, ledgerRows, staffAccounts, weights, config, earlier, laterDone, incoming, outgoing, allDesks] = await Promise.all([
    store.branches(),
    store.skus(),
    store.deskDays({ deskId, date, limit: 1 }),
    store.ledger({ date, deskId }),
    store.staffAccounts(),
    store.skuWeights(),
    store.config(),
    store.deskDays({ deskId, before: date, limit: 1 }),
    store.deskDays({ deskId, after: date, status: "done", limit: 1 }),
    store.transfers({ toDeskId: deskId, status: "in_transit" }),
    store.transfers({ fromDeskId: deskId, sentDate: date }),
    store.desks(),
  ]);
  const day = days[0];
  const detail = buildDeskDetail(desk, branches.find((b) => b.branch_id === desk.branch_id), day, skus, ledgerRows, staffAccounts, config, weights);
  const skuName = (id: string) => skus.find((s) => s.sku_id === id)?.name_en ?? id;
  const deskName = (id: string) => {
    const d = allDesks.find((x) => x.desk_id === id);
    return d ? `${d.desk_id} · ${d.display_name}` : id;
  };
  return {
    ...detail,
    date,
    today: businessDate(c.env),
    // The very first day of a desk: starting stock may still be typed in.
    isFirstDay: Boolean(day) && earlier.length === 0,
    canReopen: mayReopen(user, desk.branch_id, date, businessDate(c.env)) && day?.status === "done" && laterDone.length === 0,
    incoming: incoming
      .filter((t) => t.sent_date <= date)
      .map((t) => ({ id: t.id, kind: t.kind, sku_id: t.sku_id, name_en: skuName(t.sku_id), qty: t.qty, from: deskName(t.from_desk_id), sent_date: t.sent_date })),
    outgoing: outgoing
      .filter((t) => t.status !== "cancelled")
      .map((t) => ({ id: t.id, kind: t.kind, sku_id: t.sku_id, name_en: skuName(t.sku_id), qty: t.qty, to: deskName(t.to_desk_id), status: t.status })),
  };
}

// ?date=latest resolves to the desk's most recent recorded day — "what is on
// this desk right now" for screens that are not tied to one date.
r.get("/stock/desk/:deskId", async (c) => {
  const store = storeFor(c);
  const today = businessDate(c.env);
  const deskId = c.req.param("deskId");
  let date: string;
  if (c.req.query("date") === "latest") {
    await requireDesk(store, c.get("user"), deskId);
    date = (await store.latestDeskDays({ deskId }))[0]?.ledger_date ?? today;
  } else {
    date = requireDate(c.req.query("date"), today);
  }
  return c.json(await deskDetail(c, store, c.get("user"), deskId, date));
});

// ---------------------------------------------------------------------------
// Check-in: opens the day and carries the previous day's stock forward.
// ---------------------------------------------------------------------------
r.post("/stock/desk/:deskId/checkin", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  if (!desk.active) throw new HttpError(409, "This desk is not active", "DESK_INACTIVE");

  if (await getDay(store, desk.desk_id, date)) return c.json({ ok: true, alreadyCheckedIn: true });
  assertDateWritable(user, date, today, undefined);

  const [openEarlier, later, previous] = await Promise.all([
    store.deskDays({ deskId: desk.desk_id, before: date, notStatus: "done", order: "asc", limit: 1 }),
    store.deskDays({ deskId: desk.desk_id, after: date, order: "asc", limit: 1 }),
    store.deskDays({ deskId: desk.desk_id, before: date, order: "desc", limit: 1 }),
  ]);
  if (openEarlier[0]) {
    throw new HttpError(409, `Finish ${openEarlier[0].ledger_date} first — that day is not Done yet`, "EARLIER_DAY_OPEN", {
      openDate: openEarlier[0].ledger_date,
    });
  }
  if (later[0]) {
    throw new HttpError(409, `A later day (${later[0].ledger_date}) is already recorded for this desk`, "LATER_DAY_EXISTS", {
      laterDate: later[0].ledger_date,
    });
  }

  const created = await store.insertDeskDay({ desk_id: desk.desk_id, ledger_date: date, branch_id: desk.branch_id, checked_in_by: user.accountId });
  if (!created) return c.json({ ok: true, alreadyCheckedIn: true });
  if (previous[0]) await carryForward(store, previous[0], date, user.accountId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Save entries. Only the fields sent for a row are changed, so two tablets
// editing different things never overwrite each other. Transfer-out, Move and
// incoming transfers are not typed here — see routes/transfers.ts.
// ---------------------------------------------------------------------------
const QTY_FIELDS = ["stock_in", "retail_sale", "wholesale", "destock"] as const;

r.post("/stock/desk/:deskId/entries", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  const day = await requireOpenDay(store, user, desk.desk_id, date, today);

  const items: Record<string, any>[] = Array.isArray(body.rows) ? body.rows : [];
  const known = new Set((await store.ledger({ date, deskId: desk.desk_id })).filter((row) => !row.excluded).map((row) => row.sku_id));
  const patches: LedgerRowPatch[] = [];
  for (const item of items) {
    const skuId = String(item?.sku_id ?? "");
    if (!known.has(skuId)) throw new HttpError(400, `SKU ${skuId} is not on this desk for ${date}`, "ROW_NOT_FOUND", { sku_id: skuId });
    const patch: LedgerRowPatch = { ledger_date: date, desk_id: desk.desk_id, sku_id: skuId, branch_id: desk.branch_id };
    let changed = false;
    for (const field of QTY_FIELDS) {
      if (item[field] === undefined) continue;
      const qty = parseQty(item[field]);
      if (qty === null) throw new HttpError(400, `${field} must be a whole number, 0 or more`, "BAD_QTY", { sku_id: skuId, field });
      patch[field] = qty;
      changed = true;
    }
    if (item.destock_note !== undefined) {
      patch.destock_note = item.destock_note ? String(item.destock_note).slice(0, 200) : null;
      changed = true;
    }
    // The physical count belongs to the Final Stock step only.
    if (day.status === "final_stock") {
      if (item.counted_qty !== undefined) {
        const counted = item.counted_qty === null || item.counted_qty === "" ? null : parseQty(item.counted_qty);
        if (counted === null && item.counted_qty !== null && item.counted_qty !== "") {
          throw new HttpError(400, "Count must be a whole number, 0 or more", "BAD_QTY", { sku_id: skuId, field: "counted_qty" });
        }
        patch.counted_qty = counted;
        changed = true;
      }
      if (item.counted_note !== undefined) {
        patch.counted_note = item.counted_note ? String(item.counted_note).slice(0, 200) : null;
        changed = true;
      }
    }
    if (changed) patches.push({ ...patch, performed_by: user.accountId });
  }

  await store.patchLedgerRows(patches);
  if (body.safe_drop_note !== undefined) {
    await store.updateDeskDay(desk.desk_id, date, { safe_drop_note: body.safe_drop_note ? String(body.safe_drop_note).slice(0, 500) : null });
  }
  return c.json({ ok: true, saved: patches.length });
});

// ---------------------------------------------------------------------------
// Status transitions — forward only, one step at a time.
// ---------------------------------------------------------------------------
r.post("/stock/desk/:deskId/transition", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const toStatus = body.toStatus;
  if (toStatus !== "final_stock" && toStatus !== "done") throw new HttpError(400, "Invalid status", "BAD_STATUS");
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  const day = await requireOpenDay(store, user, desk.desk_id, date, today);

  const expected = toStatus === "final_stock" ? "check_in" : "final_stock";
  if (day.status !== expected) throw new HttpError(409, `Cannot move from ${day.status} to ${toStatus}`, "BAD_TRANSITION");

  const note = body.safe_drop_note !== undefined ? { safe_drop_note: body.safe_drop_note ? String(body.safe_drop_note).slice(0, 500) : null } : {};

  if (toStatus === "final_stock") {
    const updated = await store.updateDeskDay(desk.desk_id, date, { status: "final_stock", ...note }, "check_in");
    if (!updated) throw new HttpError(409, "This desk was changed on another device — reload", "STALE");
    return c.json({ ok: true });
  }

  const failures = validateDeskDay(await store.ledger({ date, deskId: desk.desk_id }));
  if (failures.length > 0) {
    throw new HttpError(422, "This desk cannot be closed yet", "DAY_INCOMPLETE", { failures });
  }
  const updated = await store.updateDeskDay(
    desk.desk_id,
    date,
    { status: "done", done_by: user.accountId, done_at: new Date().toISOString(), ...note },
    "final_stock"
  );
  if (!updated) throw new HttpError(409, "This desk was changed on another device — reload", "STALE");

  // If the following day is already open (this day was reopened and closed
  // again), its opening balances follow the corrected count.
  const [next] = await store.deskDays({ deskId: desk.desk_id, after: date, order: "asc", limit: 1 });
  if (next && next.status !== "done") await carryForward(store, updated, next.ledger_date, user.accountId);
  return c.json({ ok: true });
});

// Admin, or a manager of the desk's branch for a recent day: unlock the desk's
// most recent Done day so it can be corrected. It goes back to check-in.
r.post("/stock/desk/:deskId/reopen", requireManager, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) throw new HttpError(400, "A reason is required to reopen a day", "REASON_REQUIRED");
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  if (!mayReopen(user, desk.branch_id, date, today)) {
    throw new HttpError(403, `A manager can reopen a day up to ${MANAGER_REOPEN_DAYS} days back. Ask an admin.`, "REOPEN_TOO_OLD");
  }
  const day = await getDay(store, desk.desk_id, date);
  if (!day || day.status !== "done") throw new HttpError(409, "Only a Done day can be reopened", "NOT_DONE");
  const [laterDone] = await store.deskDays({ deskId: desk.desk_id, after: date, status: "done", limit: 1 });
  if (laterDone) {
    throw new HttpError(409, `Reopen ${laterDone.ledger_date} first — only the latest Done day can be reopened`, "NOT_LATEST_DONE", {
      laterDate: laterDone.ledger_date,
    });
  }
  const updated = await store.updateDeskDay(desk.desk_id, date, { status: "check_in", done_by: null, done_at: null }, "done");
  if (!updated) throw new HttpError(409, "This desk was changed on another device — reload", "STALE");
  await audit(store, user, "desk_day.reopen", `${desk.desk_id}/${date}`, { reason });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Add / remove a SKU on a desk day
// ---------------------------------------------------------------------------
r.post("/stock/desk/:deskId/sku", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const skuId = String(body.sku_id ?? "");
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  await requireOpenDay(store, user, desk.desk_id, date, today);

  const sku = (await store.skus()).find((s) => s.sku_id === skuId);
  if (!sku || !sku.active) throw new HttpError(400, "Unknown or inactive SKU", "BAD_SKU");

  const key = { ledger_date: date, desk_id: desk.desk_id, sku_id: skuId, branch_id: desk.branch_id };
  const existing = (await store.ledger({ date, deskId: desk.desk_id })).find((row) => row.sku_id === skuId);
  if (existing) {
    if (existing.excluded) await store.patchLedgerRows([{ ...key, excluded: false, performed_by: user.accountId }]);
    return c.json({ ok: true });
  }

  // Starting stock can only be typed on a desk's very first day; afterwards
  // stock arrives through "In" or an incoming transfer.
  let opening = 0;
  if (body.opening_qty !== undefined && body.opening_qty !== null && body.opening_qty !== "") {
    const qty = parseQty(body.opening_qty);
    if (qty === null) throw new HttpError(400, "Opening must be a whole number, 0 or more", "BAD_QTY");
    if (qty > 0) {
      const [earlier] = await store.deskDays({ deskId: desk.desk_id, before: date, limit: 1 });
      if (earlier) throw new HttpError(409, "Opening stock can only be set on a desk's first day", "OPENING_LOCKED");
      opening = qty;
    }
  }
  await store.insertLedgerRows([{ ...key, opening_qty: opening, performed_by: user.accountId }]);
  return c.json({ ok: true });
});

r.delete("/stock/desk/:deskId/sku/:skuId", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const today = businessDate(c.env);
  const date = requireDate(c.req.query("date"), today);
  const skuId = (c.req.param("skuId") ?? "");
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  await requireOpenDay(store, user, desk.desk_id, date, today);

  const existing = (await store.ledger({ date, deskId: desk.desk_id })).find((row) => row.sku_id === skuId);
  if (!existing || existing.excluded) return c.json({ ok: true });
  // Hiding a row that holds stock or movements would make gold disappear
  // from every total, so only an empty row can be removed.
  if (hasActivity(existing)) {
    throw new HttpError(409, "This item has stock or movements today, so it cannot be removed", "ROW_HAS_ACTIVITY");
  }
  await store.patchLedgerRows([
    { ledger_date: date, desk_id: desk.desk_id, sku_id: skuId, branch_id: desk.branch_id, excluded: true, performed_by: user.accountId },
  ]);
  return c.json({ ok: true });
});

export default r;
