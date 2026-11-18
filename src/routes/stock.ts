// Daily Stock: desk cards, the desk day lifecycle
// (not started -> opening -> check_in -> [final_stock] -> done) and row entry.
import { storeFor, newRouter, readBody, HttpError, scopeBranch, requireDesk, requireDate, assertDateWritable, getDay, requireOpenDay, audit } from "../app";
import type { Ctx } from "../app";
import { LEDGER_CHANGE_FIELDS, TEXT_CHANGE_FIELDS } from "../store";
import type { Store, LedgerRowPatch, NewLedgerRow, LedgerChange, LedgerChangeField } from "../store";
import { requireManager, assertBranchAccess, isManagerOf } from "../auth";
import { addDays, businessDate, datesInMonth, isValidMonth, laosDate } from "../time";
import { buildDayStatus } from "../dayStatus";
import { loadBranchStatuses } from "../replenishment";
import { resolveGoldPrice, priceOn } from "../goldPrice";
import { buildCaseHistory } from "../caseHistory";
import { bahtOf, valueLak, buildDeskCards, buildDeskDetail, buildCalendarMonth, carryQty, computeClosing, parseQty, stepFields, validateDeskDay } from "../logic";
import type { Desk, DeskDay, LedgerRow, MasterSku, SessionUser, StaffAccount, Transfer } from "../types";

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
    (row.withdraw ?? 0) !== 0 ||
    row.move !== 0 ||
    (row.stock_out_single ?? 0) !== 0 ||
    (row.move_qty ?? 0) !== 0
  );
}

// Hands a closed day's stock to the following day: each SKU opens with what
// was physically counted (or the calculated closing when there was no count).
async function planCarry(store: Store, from: DeskDay, toDate: string, actor: string) {
  const [fromRows, toRows] = await Promise.all([
    store.ledger({ deskId: from.desk_id, date: from.ledger_date }),
    store.ledger({ deskId: from.desk_id, date: toDate }),
  ]);
  const existing = new Map(toRows.map((row) => [row.sku_id, row]));
  const inserts: NewLedgerRow[] = [];
  const patches: LedgerRowPatch[] = [];
  // The next day's rows whose opening changes, with the closing they would get.
  const reopenings: { row: LedgerRow; closing: number }[] = [];
  for (const row of fromRows) {
    if (row.excluded) continue;
    const opening = Math.max(0, carryQty(row));
    const target = existing.get(row.sku_id);
    const key = { ledger_date: toDate, desk_id: from.desk_id, sku_id: row.sku_id, branch_id: from.branch_id };
    if (!target) inserts.push({ ...key, opening_qty: opening, performed_by: actor });
    else if (target.opening_qty !== opening) {
      patches.push({ ...key, opening_qty: opening });
      reopenings.push({ row: target, closing: computeClosing({ ...target, opening_qty: opening }) });
    }
  }
  return { inserts, patches, reopenings };
}

// The SKUs a case's day carries from its previous day: every non-excluded row
// of the case's latest earlier day. Their opening is yesterday's closing and
// cannot be typed. A case's first day has no previous day, so none are carried.
async function carriedSkus(store: Store, deskId: string, date: string): Promise<Set<string>> {
  const [previous] = await store.deskDays({ deskId, before: date, order: "desc", limit: 1 });
  if (!previous) return new Set();
  const rows = await store.ledger({ deskId, date: previous.ledger_date });
  return new Set(rows.filter((row) => !row.excluded).map((row) => row.sku_id));
}

async function carryForward(store: Store, from: DeskDay, toDate: string, actor: string) {
  const { inserts, patches } = await planCarry(store, from, toDate, actor);
  await store.insertLedgerRows(inserts, { overwriteOpening: true });
  await store.patchLedgerRows(patches);
}

const safeDropNote = (body: Record<string, any>) =>
  body.safe_drop_note !== undefined ? { safe_drop_note: body.safe_drop_note ? String(body.safe_drop_note).slice(0, 500) : null } : {};

// Marks an open day Done (from check-in or final stock; never from the
// opening step) once no row ends below 0 (no physical count is needed), then
// updates the following day's opening balances if that day already exists. Shared by /transition (to done) and /close.
async function closeDeskDay(store: Store, user: SessionUser, desk: Desk, date: string, note: { safe_drop_note?: string | null }) {
  const day = await getDay(store, desk.desk_id, date);
  if (!day || (day.status !== "check_in" && day.status !== "final_stock")) {
    throw new HttpError(409, `Cannot close a day that is ${day?.status ?? "not started"}`, "BAD_TRANSITION");
  }
  const failures = validateDeskDay(await store.ledger({ date, deskId: desk.desk_id }));
  if (failures.length > 0) {
    throw new HttpError(422, "This desk cannot be closed yet", "DAY_INCOMPLETE", { failures });
  }
  // A count typed under the old app on a day still open would otherwise become
  // the next day's opening (carryQty prefers it), though the screen can no
  // longer show or change it. Clear it first, so both the negative pre-check
  // below and the carry use the calculated closing.
  await store.clearLedgerCounts(desk.desk_id, date);
  // If the following day is already open (this day was reopened and closed
  // again), its opening balances follow the corrected count. Check that the new
  // openings keep that day non-negative BEFORE marking this day Done, so a
  // refusal leaves nothing half written. Same rule as the database's negative
  // guard: a row may not end below 0, nor drop further when already below 0.
  const [next] = await store.deskDays({ deskId: desk.desk_id, after: date, order: "asc", limit: 1 });
  const nextOpen = next && next.status !== "done" ? next : undefined;
  if (nextOpen) {
    const plan = await planCarry(store, day, nextOpen.ledger_date, user.accountId);
    for (const { row, closing } of plan.reopenings) {
      if (closing < 0 && closing < row.closing_qty) {
        throw new HttpError(409, `The next day (${nextOpen.ledger_date}) would go negative for ${row.sku_id}`, "NEXT_DAY_NEGATIVE", {
          sku_id: row.sku_id,
          date: nextOpen.ledger_date,
          available: Math.max(row.closing_qty, 0),
        });
      }
    }
  }

  const updated = await store.updateDeskDay(
    desk.desk_id,
    date,
    { status: "done", done_by: user.accountId, done_at: new Date().toISOString(), ...note },
    day.status
  );
  if (!updated) throw new HttpError(409, "This desk was changed on another device — reload", "STALE");
  if (nextOpen) await carryForward(store, updated, nextOpen.ledger_date, user.accountId);
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
  const [desks, branches, skus, days, ledgerRows, staffAccounts, config, openEarlier, history, closed, goldRow] = await Promise.all([
    store.desks(),
    store.branches(),
    store.skus(),
    store.deskDays({ date, branchId }),
    store.ledger({ date, branchId }),
    store.staffAccounts(),
    store.config(),
    store.deskDays({ branchId, before: date, notStatus: "done" }),
    // Check history for streaks: 400 days (a streak shows "365+" beyond that).
    store.deskDays({ branchId, from: addDays(today, -400), to: today }),
    store.closedDays({ branchId, from: addDays(today, -400), to: today }),
    store.goldPrice(),
  ]);
  const scopedDesks = branchId ? desks.filter((d) => d.branch_id === branchId) : desks;
  const statuses = await loadBranchStatuses(store, [...new Set(scopedDesks.map((d) => d.branch_id))], today);
  // Earliest unfinished earlier day per desk — check-in is blocked until it is closed.
  const blockedBy = new Map<string, string>();
  for (const d of openEarlier) if (!blockedBy.has(d.desk_id)) blockedBy.set(d.desk_id, d.ledger_date);
  const staffName = new Map(staffAccounts.map((a) => [a.id, a.display_name]));
  const historyByDesk = new Map<string, typeof history>();
  for (const d of history) historyByDesk.set(d.desk_id, [...(historyByDesk.get(d.desk_id) ?? []), d]);
  const closedByBranch = new Map<string, Set<string>>();
  for (const cd of closed) closedByBranch.set(cd.branch_id, (closedByBranch.get(cd.branch_id) ?? new Set()).add(cd.closed_date));
  const { lakPerBaht } = resolveGoldPrice(goldRow, config, today);
  const deskById = new Map(desks.map((d) => [d.desk_id, d]));
  const none = new Set<string>();

  // Cases with no day on this date show what they last held (their latest earlier day).
  const carried = new Map<string, { rows: LedgerRow[]; status: DeskDay["status"] | undefined }>();
  const withDay = new Set(days.map((d) => d.desk_id));
  if (scopedDesks.some((d) => !withDay.has(d.desk_id))) {
    for (const r of await store.ledgerLatest({ branchId })) {
      if (withDay.has(r.desk_id) || r.ledger_date >= date) continue;
      const entry = carried.get(r.desk_id) ?? {
        rows: [],
        status: (historyByDesk.get(r.desk_id) ?? []).find((d) => d.ledger_date === r.ledger_date)?.status,
      };
      entry.rows.push(r);
      carried.set(r.desk_id, entry);
    }
  }

  const cards = buildDeskCards(scopedDesks, branches, skus, days, ledgerRows, staffAccounts, config, statuses, lakPerBaht, carried).map((card) => {
    const desk = deskById.get(card.desk_id)!;
    const status = buildDayStatus({
      deskCreatedDate: laosDate(new Date(desk.created_at)),
      days: historyByDesk.get(card.desk_id) ?? [],
      closedDates: closedByBranch.get(card.branch_id) ?? none,
      today,
    });
    return {
      ...card,
      openEarlierDate: blockedBy.get(card.desk_id) ?? null,
      openedAt: days.find((x) => x.desk_id === card.desk_id)?.created_at ?? null,
      streak: status.streak,
      lastDoneDate: status.lastDoneDate,
      lastDoneAt: status.lastDoneAt,
      lastDoneByName: status.lastDoneBy ? staffName.get(status.lastDoneBy) ?? null : null,
      daysBehind: status.daysBehind,
      tier: status.tier,
    };
  });
  // Overdue cases first; the rest keep their order (Array.sort is stable).
  cards.sort((a, b) => Number(b.tier === "overdue") - Number(a.tier === "overdue"));
  const branchSummary = {
    cases: cards.length,
    checkedToday: cards.filter((x) => x.tier === "done_today").length,
    behind1: cards.filter((x) => x.tier === "behind_1").length,
    overdue: cards.filter((x) => x.tier === "overdue").length,
  };
  return c.json({ date, today, desks: cards, branchSummary });
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

  const skuList = await store.skus();
  const skuIds = new Set(skuList.filter((s) => s.active).map((s) => s.sku_id));
  const opening = new Map<string, number>();
  for (const item of Array.isArray(body.openingSkus) ? body.openingSkus : []) {
    const qty = parseQty(item?.opening_qty);
    if (!skuIds.has(item?.sku_id) || qty === null) throw new HttpError(400, "Invalid opening stock row", "BAD_OPENING");
    opening.set(item.sku_id, qty);
  }

  const today = businessDate(c.env);
  // The case's origin, frozen for good: who made it and what it started with.
  const initial_stock = {
    skus: Object.fromEntries(opening),
    total_pcs: [...opening.values()].reduce((a, q) => a + q, 0),
    total_baht: Math.round([...opening].reduce((a, [id, q]) => a + bahtOf(skuList.find((s) => s.sku_id === id), q), 0) * 10000) / 10000,
  };
  const desk = await store.createDesk({ branch_id: branchId, display_name: displayName, created_by: user.accountId, initial_stock });
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
  await audit(store, user, "desk.create", desk.desk_id, { display_name: displayName, opening: Object.fromEntries(opening) }, { branchId: desk.branch_id, deskId: desk.desk_id });
  return c.json({ desk, rows });
});

// Case info: who made the case, when, and what it started with (valued today).
r.get("/desks/:deskId/info", async (c) => {
  const store = storeFor(c);
  const desk = await requireDesk(store, c.get("user"), c.req.param("deskId"));
  const [staffAccounts, config, goldRow] = await Promise.all([store.staffAccounts(), store.config(), store.goldPrice()]);
  const creator = desk.created_by ? staffAccounts.find((a) => a.id === desk.created_by) : undefined;
  const { lakPerBaht } = resolveGoldPrice(goldRow, config, businessDate(c.env));
  const skuList = await store.skus();
  const initial = desk.initial_stock
    ? {
        ...desk.initial_stock,
        names: Object.fromEntries(
          Object.keys(desk.initial_stock.skus).map((id) => {
            const sku = skuList.find((s) => s.sku_id === id);
            return [id, { name_en: sku?.name_en ?? id, name_lo: sku?.name_lo ?? null, baht_weight: sku?.baht_weight ?? null, std_gram_weight: sku?.std_gram_weight ?? null }];
          })
        ),
        valueLak: Math.round(Object.entries(desk.initial_stock.skus).reduce((sum, [id, q]) => sum + valueLak(skuList.find((s) => s.sku_id === id), q, lakPerBaht), 0) * 100) / 100,
      }
    : null;
  return c.json({
    deskId: desk.desk_id,
    displayName: desk.display_name,
    branchId: desk.branch_id,
    createdAt: desk.created_at,
    createdBy: desk.created_by ? { id: desk.created_by, name: creator?.display_name ?? null } : null,
    initial,
  });
});

// Case day-by-day history, newest first, one page of `days` (default 30, max 90)
// ending at `to`. nextTo is the last date of the following (older) page, or null
// once the window reaches the case's first recorded day.
const HISTORY_DEFAULT_DAYS = 30;
const HISTORY_MAX_DAYS = 90;

r.get("/desks/:deskId/history", async (c) => {
  const store = storeFor(c);
  const desk = await requireDesk(store, c.get("user"), c.req.param("deskId"));
  const today = businessDate(c.env);
  const requestedTo = requireDate(c.req.query("to"), today);
  const to = requestedTo > today ? today : requestedTo;
  const daysQuery = c.req.query("days");
  let count = HISTORY_DEFAULT_DAYS;
  if (daysQuery !== undefined && daysQuery !== "") {
    count = Number(daysQuery);
    if (!Number.isInteger(count) || count < 1) throw new HttpError(400, "days must be a whole number, 1 or more", "BAD_DAYS");
  }
  count = Math.min(count, HISTORY_MAX_DAYS);
  const from = addDays(to, -(count - 1));

  // One read of the case's days up to `to`; the latest one before `from` anchors
  // the chain check of the first day shown, so the ledger starts there.
  const days = await store.deskDays({ deskId: desk.desk_id, to, order: "asc" });
  const anchor = days.filter((d) => d.ledger_date < from).pop();
  const [ledger, closed, skus, staffAccounts, config, goldRow, snapshots, reopened] = await Promise.all([
    store.ledger({ deskId: desk.desk_id, from: anchor?.ledger_date ?? from, to }),
    store.closedDays({ branchId: desk.branch_id, from, to }),
    store.skus(),
    store.staffAccounts(),
    store.config(),
    store.goldPrice(),
    store.goldPriceHistory(from, to),
    store.reopenedDates([desk.desk_id], from, to),
  ]);
  const rows = buildCaseHistory({
    from,
    to,
    today,
    days,
    ledger,
    closed,
    skus: new Map(skus.map((s) => [s.sku_id, s])),
    staffNames: new Map(staffAccounts.map((a) => [a.id, a.display_name])),
    reopenedDates: reopened.get(desk.desk_id) ?? new Set(),
    snapshots,
    fallbackPrice: resolveGoldPrice(goldRow, config, today).lakPerBaht,
  });
  const first = days[0]?.ledger_date;
  return c.json({ rows, nextTo: first && from > first ? addDays(from, -1) : null });
});

// ---------------------------------------------------------------------------
// Desk detail
// ---------------------------------------------------------------------------
// The same-branch moves touching a case on a date, one item per ticket, for the
// History tab. canUndo mirrors what POST /moves/:ticketId/undo will accept: the
// ticket is not undone, is not itself an undo, and neither day is Done.
async function historyMoves(store: Store, deskId: string, date: string, outgoing: Transfer[], staffAccounts: StaffAccount[], skus: MasterSku[], allDesks: Desk[]) {
  const incomingToday = await store.transfers({ toDeskId: deskId, sentDate: date });
  const rows = [...outgoing, ...incomingToday].filter((t) => t.kind === "move" && t.ticket_id && t.status !== "cancelled");
  const tickets = new Map<string, Transfer[]>();
  for (const t of rows) {
    const list = tickets.get(t.ticket_id!) ?? [];
    if (!list.some((x) => x.id === t.id)) list.push(t);
    tickets.set(t.ticket_id!, list);
  }
  const reversedIds = new Set(rows.map((t) => t.reverses_id).filter(Boolean));
  const statusOf = async (id: string) => (await store.deskDays({ deskId: id, date, limit: 1 }))[0]?.status;
  const deskName = (id: string) => {
    const d = allDesks.find((x) => x.desk_id === id);
    return d ? `${d.desk_id} · ${d.display_name}` : id;
  };
  const out = [];
  for (const [ticketId, lines] of tickets) {
    const first = lines[0];
    const reversal = lines.some((t) => t.reverses_id);
    const reversed = lines.some((t) => reversedIds.has(t.id));
    const open = (await statusOf(first.from_desk_id)) !== "done" && (await statusOf(first.to_desk_id)) !== "done";
    out.push({
      ticketId,
      created_at: lines.reduce((m, t) => (t.created_at < m ? t.created_at : m), first.created_at),
      from_desk_id: first.from_desk_id,
      to_desk_id: first.to_desk_id,
      from: deskName(first.from_desk_id),
      to: deskName(first.to_desk_id),
      by: staffAccounts.find((a) => a.id === first.sent_by)?.display_name ?? null,
      note: first.note,
      reversal,
      reversed,
      canUndo: !reversal && !reversed && open,
      lines: lines.map((t) => { const s = skus.find((x) => x.sku_id === t.sku_id); return { sku_id: t.sku_id, name_en: s?.name_en ?? t.sku_id, name_lo: s?.name_lo ?? null, baht_weight: s?.baht_weight ?? null, std_gram_weight: s?.std_gram_weight ?? null, qty: t.qty }; }),
    });
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function deskDetail(c: Ctx, store: Store, user: SessionUser, deskId: string, date: string) {
  const desk = await requireDesk(store, user, deskId);
  const [branches, skus, days, ledgerRows, staffAccounts, weights, config, earlier, incoming, outgoing, allDesks, goldRow, types] = await Promise.all([
    store.branches(),
    store.skus(),
    store.deskDays({ deskId, date, limit: 1 }),
    store.ledger({ date, deskId }),
    store.staffAccounts(),
    store.skuWeights(),
    store.config(),
    store.deskDays({ deskId, before: date, limit: 1 }),
    store.transfers({ toDeskId: deskId, status: "in_transit" }),
    store.transfers({ fromDeskId: deskId, sentDate: date }),
    store.desks(),
    store.goldPrice(),
    store.skuTypes(),
  ]);
  const moves = await historyMoves(store, deskId, date, outgoing, staffAccounts, skus, allDesks);
  const day = days[0];
  const statuses = await loadBranchStatuses(store, [desk.branch_id], businessDate(c.env));
  const today = businessDate(c.env);
  const gold = resolveGoldPrice(goldRow, config, today);
  // A past day is valued at the price in force that day; today at the live price.
  const lakPerBaht = date < today ? priceOn(date, await store.goldPriceHistory(date, date), gold.lakPerBaht) : gold.lakPerBaht;
  const built = buildDeskDetail(desk, branches.find((b) => b.branch_id === desk.branch_id), day, skus, ledgerRows, staffAccounts, config, weights, statuses, lakPerBaht, types);
  // In the opening step a SKU the day did not carry (added today, or every row
  // on a case's first day) still takes a typed opening.
  const carried = day?.status === "opening" ? await carriedSkus(store, deskId, date) : undefined;
  const detail = { ...built, rows: built.rows.map((row) => ({ ...row, opening_editable: carried !== undefined && !carried.has(row.sku_id) })) };
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
    // In the opening step: the SKUs the day carries from its previous day. Their
    // opening is locked, so the add flow restores a removed one without asking
    // for an opening.
    carriedSkus: carried ? [...carried] : [],
    canReopen: mayReopen(user, desk.branch_id, date, businessDate(c.env)) && day?.status === "done",
    incoming: incoming
      .filter((t) => t.sent_date <= date)
      .map((t) => ({ id: t.id, kind: t.kind, sku_id: t.sku_id, name_en: skuName(t.sku_id), qty: t.qty, from: deskName(t.from_desk_id), sent_date: t.sent_date })),
    moves,
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

// Opens a desk's day in the `opening` step and carries the previous day's stock
// forward. Shared by the check-in route and moves (a destination case is checked in on demand).
export async function checkInDesk(store: Store, user: SessionUser, desk: Desk, date: string, today: string): Promise<"created" | "exists"> {
  if (!desk.active) throw new HttpError(409, "This desk is not active", "DESK_INACTIVE");

  if (await getDay(store, desk.desk_id, date)) return "exists";
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
  if (!created) return "exists";
  if (previous[0]) await carryForward(store, previous[0], date, user.accountId);
  return "created";
}

// ---------------------------------------------------------------------------
// Check-in: opens the day in the opening step (yesterday's closing is reviewed
// as today's opening) and carries the previous day's stock forward. The
// /transition to check_in confirms it.
// ---------------------------------------------------------------------------
r.post("/stock/desk/:deskId/checkin", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  return c.json((await checkInDesk(store, user, desk, date, today)) === "exists" ? { ok: true, alreadyCheckedIn: true } : { ok: true });
});

// ---------------------------------------------------------------------------
// Save entries. Only the fields sent for a row are changed, so two tablets
// editing different things never overwrite each other. Which fields may be
// changed depends on the day's step (stepFields): the opening step takes
// stock-in and the opening of a SKU the day did not carry; check-in takes
// stock-in and the stock-outs (retail / wholesale / return / withdraw on a
// dynamic day, one total stock_out_single on a single-mode day).
// ---------------------------------------------------------------------------
const DYNAMIC_OUT_FIELDS: readonly LedgerChangeField[] = ["retail_sale", "wholesale", "destock", "withdraw"];

// One compare-and-set change: {sku_id, field, from?, to}. `from` omitted means
// "apply whatever is stored".
function parseChange(item: Record<string, any>): { sku_id: string; change: LedgerChange } {
  const sku_id = String(item?.sku_id ?? "");
  const field = item?.field as LedgerChangeField;
  if (!LEDGER_CHANGE_FIELDS.includes(field)) throw new HttpError(400, `Field ${String(item?.field)} cannot be changed here`, "BAD_FIELD", { sku_id, field: item?.field });
  const value = (v: unknown): number | string | null => {
    if (TEXT_CHANGE_FIELDS.includes(field)) return v === null || v === undefined || v === "" ? null : String(v).slice(0, 200);
    const qty = parseQty(v);
    if (qty === null) throw new HttpError(400, `${field} must be a whole number, 0 or more`, "BAD_QTY", { sku_id, field });
    return qty;
  };
  const change: LedgerChange = { field, to: value(item.to) };
  if (item.from !== undefined) change.from = value(item.from);
  return { sku_id, change };
}

r.post("/stock/desk/:deskId/entries", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  const day = await requireOpenDay(store, user, desk.desk_id, date, today);
  const mode = day.stock_out_mode ?? "dynamic";
  const offMode = (field: LedgerChangeField) =>
    mode === "single" ? DYNAMIC_OUT_FIELDS.includes(field) : field === "stock_out_single";
  const allowed = stepFields(day.status, mode);
  let carried: Set<string> | undefined;

  const known = new Set((await store.ledger({ date, deskId: desk.desk_id })).filter((row) => !row.excluded).map((row) => row.sku_id));
  const unknownSku = (skuId: string) => new HttpError(400, `SKU ${skuId} is not on this desk for ${date}`, "ROW_NOT_FOUND", { sku_id: skuId });
  const saveNote = async () => {
    if (body.safe_drop_note !== undefined) await store.updateDeskDay(desk.desk_id, date, safeDropNote(body));
  };

  // Compare-and-set form. Changes already applied stay applied if a later row
  // is refused; resending the whole request is safe (stored == to is success).
  if (Array.isArray(body.changes)) {
    const bySku = new Map<string, LedgerChange[]>();
    for (const item of body.changes) {
      const { sku_id, change } = parseChange(item);
      if (!known.has(sku_id)) throw unknownSku(sku_id);
      // A value typed while the screen still showed the other mode would be
      // invisible after reload; refuse it so the device reloads instead.
      if (offMode(change.field)) {
        throw new HttpError(409, `${change.field} is not used on a ${mode} stock-out day — reload`, "WRONG_STOCK_OUT_MODE", { sku_id, field: change.field, mode });
      }
      if (!allowed.includes(change.field)) {
        throw new HttpError(409, `${change.field} cannot be entered while the day is ${day.status}`, "FIELD_NOT_IN_STEP", { sku_id, field: change.field, status: day.status });
      }
      if (change.field === "opening_qty") {
        carried ??= await carriedSkus(store, desk.desk_id, date);
        if (carried.has(sku_id)) {
          throw new HttpError(409, "This opening is carried from the previous day and cannot be changed", "OPENING_LOCKED", { sku_id });
        }
      }
      const list = bySku.get(sku_id) ?? [];
      // Two assignments to one column would make the generated SQL repeat it (42601).
      if (list.some((x) => x.field === change.field)) {
        throw new HttpError(400, `Field ${change.field} appears twice for ${sku_id}`, "DUPLICATE_FIELD", { sku_id, field: change.field });
      }
      bySku.set(sku_id, [...list, change]);
    }
    const rows: LedgerRow[] = [];
    for (const [sku_id, changes] of bySku) {
      const res = await store.applyLedgerChanges({ ledger_date: date, desk_id: desk.desk_id, sku_id }, changes);
      if (!res.ok) {
        if (res.code === "ROW_NOT_FOUND") throw unknownSku(sku_id);
        throw new HttpError(409, "This row was changed on another device", "ROW_CHANGED", { row: res.row });
      }
      rows.push(res.row);
    }
    await saveNote();
    return c.json({ ok: true, rows });
  }

  // The old last-write-wins `rows` body is gone: its partial upsert fires the
  // database's BEFORE INSERT negative guard on the proposed row. Use `changes`.
  throw new HttpError(400, "Send the entries as changes: [{sku_id, field, from, to}]", "USE_CHANGES");
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
  if (toStatus !== "check_in" && toStatus !== "final_stock" && toStatus !== "done") throw new HttpError(400, "Invalid status", "BAD_STATUS");
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  const day = await requireOpenDay(store, user, desk.desk_id, date, today);

  const expected = toStatus === "check_in" ? "opening" : toStatus === "final_stock" ? "check_in" : "final_stock";
  if (day.status !== expected) throw new HttpError(409, `Cannot move from ${day.status} to ${toStatus}`, "BAD_TRANSITION");

  // Confirm check-in: the opening review is finished and selling may start.
  if (toStatus === "check_in") {
    const updated = await store.updateDeskDay(desk.desk_id, date, { status: "check_in" }, "opening");
    if (!updated) throw new HttpError(409, "This desk was changed on another device — reload", "STALE");
    return c.json({ ok: true });
  }

  if (toStatus === "final_stock") {
    const updated = await store.updateDeskDay(desk.desk_id, date, { status: "final_stock", ...safeDropNote(body) }, "check_in");
    if (!updated) throw new HttpError(409, "This desk was changed on another device — reload", "STALE");
    return c.json({ ok: true });
  }

  await closeDeskDay(store, user, desk, date, safeDropNote(body));
  return c.json({ ok: true });
});

// One step to Done from check-in or final stock (not from the opening step).
r.post("/stock/desk/:deskId/close", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  await requireOpenDay(store, user, desk.desk_id, date, today);
  await closeDeskDay(store, user, desk, date, safeDropNote(body));
  return c.json({ ok: true });
});

// Admin, or a manager of the desk's branch for a recent day: unlock the desk's
// Done day and every later day so they can be redone in date order. They go
// back to the opening step, typed numbers kept.
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
  const dates = await store.reopenFrom(desk.desk_id, date);
  if (dates.length === 0) throw new HttpError(409, "This desk was changed on another device — reload", "STALE");
  await audit(store, user, "desk_day.reopen", `${desk.desk_id}/${date}`, { reason, dates }, { branchId: desk.branch_id, deskId: desk.desk_id });
  return c.json({ ok: true, dates });
});

// ---------------------------------------------------------------------------
// Add / remove a SKU on a desk day
// ---------------------------------------------------------------------------
// Adds one SKU ({ sku_id, opening_qty?, stock_in? }) or several ({ items: [...] })
// to a case's day. Every item is checked before anything is written. An opening
// is typed only in the opening step and only for a SKU the day did not carry;
// a SKU added after check-in arrives through stock_in with opening 0.
const MAX_ADD_ITEMS = 200;
r.post("/stock/desk/:deskId/sku", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const desk = await requireDesk(store, user, c.req.param("deskId"));
  const day = await requireOpenDay(store, user, desk.desk_id, date, today);

  const items: any[] = Array.isArray(body.items) ? body.items : [{ sku_id: body.sku_id, opening_qty: body.opening_qty, stock_in: body.stock_in }];
  if (items.length === 0 || items.length > MAX_ADD_ITEMS) throw new HttpError(400, `Add between 1 and ${MAX_ADD_ITEMS} SKUs`, "BAD_SKU");

  const activeSkus = new Set((await store.skus()).filter((s) => s.active).map((s) => s.sku_id));
  const qtyOf = (v: unknown, label: string) => {
    if (v === undefined || v === null || v === "") return 0;
    const qty = parseQty(v);
    if (qty === null) throw new HttpError(400, `${label} must be a whole number, 0 or more`, "BAD_QTY");
    return qty;
  };
  // sku_id -> {opening, stockIn}; a repeated SKU keeps its last values.
  const wanted = new Map<string, { opening: number; stockIn: number }>();
  for (const item of items) {
    const skuId = String(item?.sku_id ?? "");
    if (!activeSkus.has(skuId)) throw new HttpError(400, "Unknown or inactive SKU", "BAD_SKU");
    wanted.set(skuId, { opening: qtyOf(item.opening_qty, "Opening"), stockIn: qtyOf(item.stock_in, "Stock in") });
  }

  // An opening is typed only while the day is in the opening step, and never
  // for a SKU carried from the previous day; after check-in stock arrives as stock-in.
  const withOpening = [...wanted].filter(([, w]) => w.opening > 0).map(([id]) => id);
  if (withOpening.length) {
    if (day.status !== "opening") throw new HttpError(409, "An opening can only be typed before check-in is confirmed", "OPENING_LOCKED");
    const carried = await carriedSkus(store, desk.desk_id, date);
    const locked = withOpening.find((id) => carried.has(id));
    if (locked) throw new HttpError(409, "This opening is carried from the previous day and cannot be changed", "OPENING_LOCKED", { sku_id: locked });
  }
  const withStockIn = [...wanted].filter(([, w]) => w.stockIn > 0).map(([id]) => id);
  if (withStockIn.length && !stepFields(day.status, day.stock_out_mode ?? "dynamic").includes("stock_in")) {
    throw new HttpError(409, `stock_in cannot be entered while the day is ${day.status}`, "FIELD_NOT_IN_STEP", { sku_id: withStockIn[0], field: "stock_in", status: day.status });
  }

  const key = (sku_id: string) => ({ ledger_date: date, desk_id: desk.desk_id, sku_id, branch_id: desk.branch_id });
  const existing = new Map((await store.ledger({ date, deskId: desk.desk_id })).map((row) => [row.sku_id, row]));
  // A SKU already on the day (another device added it, or a retry after the
  // stock-in write failed) keeps its own Stock In cell: refuse before any write
  // rather than drop or double-count the number. Without stock_in it is a no-op.
  const onDay = withStockIn.find((id) => existing.has(id) && !existing.get(id)!.excluded);
  if (onDay) throw new HttpError(409, "This item is already on the case today — type the stock-in in its row", "SKU_ALREADY_ON_DAY", { sku_id: onDay });
  const restore = [...wanted.keys()].filter((id) => existing.get(id)?.excluded);
  const fresh = [...wanted].filter(([id]) => !existing.has(id));
  // Insert first: it is the write most likely to be refused (another device
  // added the same SKU), and then nothing has been restored yet.
  if (fresh.length) await store.insertLedgerRows(fresh.map(([id, w]) => ({ ...key(id), opening_qty: w.opening, performed_by: user.accountId })));
  // A removed row the day did not carry had no activity, so its opening was 0;
  // it takes the one typed now. A carried row keeps its carried opening (the
  // typed one is 0, or was refused above).
  const carriedRestore = restore.length ? await carriedSkus(store, desk.desk_id, date) : new Set<string>();
  if (restore.length) {
    await store.patchLedgerRows(
      restore.map((id) => ({
        ...key(id),
        excluded: false,
        ...(carriedRestore.has(id) ? {} : { opening_qty: wanted.get(id)!.opening }),
        performed_by: user.accountId,
      }))
    );
  }
  // Stock-in goes through the same compare-and-set path as the grid.
  for (const id of [...fresh.map(([id]) => id), ...restore]) {
    const stockIn = wanted.get(id)!.stockIn;
    if (stockIn === 0) continue;
    const res = await store.applyLedgerChanges({ ledger_date: date, desk_id: desk.desk_id, sku_id: id }, [{ field: "stock_in", to: stockIn }]);
    if (!res.ok) throw new HttpError(409, "This row was changed on another device", "ROW_CHANGED", { sku_id: id });
  }
  return c.json({ ok: true, added: fresh.length, restored: restore.length });
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
