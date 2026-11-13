// Branch closed days (holidays) and case assignment with handover history.
// A case is held by at most one staff member at a time; a handover ends the
// previous row and starts a new one, so the full history stays. The receiver
// does not have to accept (spec 4.13); every change is audited.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, scopeBranch, requireDesk } from "../app";
import { requireManager, isManagerOf } from "../auth";
import { isValidDate, laosDate, businessDate } from "../time";
import { StoreError } from "../store";
import type { ClosedDay } from "../types";

const r = newRouter();

function optionalDate(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isValidDate(value)) throw new HttpError(400, "Invalid date", "BAD_DATE");
  return value;
}

r.get("/closed-days", async (c) => {
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const closedDays = await storeFor(c).closedDays({ branchId, from: optionalDate(c.req.query("from")), to: optionalDate(c.req.query("to")) });
  return c.json({ closedDays });
});

r.post("/closed-days", requireManager, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const date = body.date;
  if (!isValidDate(date)) throw new HttpError(400, "Invalid date", "BAD_DATE");
  const reason = String(body.reason ?? "").trim().slice(0, 200);
  if (!reason) throw new HttpError(400, "A reason is required", "BAD_REASON");

  const branchId = String(body.branchId ?? "");
  const branches = (await store.branches()).map((b) => b.branch_id);
  let targets: string[];
  if (branchId === "all") {
    if (user.role !== "admin") throw new HttpError(403, "Only an admin can close all branches", "ROLE_DENIED");
    targets = branches;
  } else {
    if (!branches.includes(branchId)) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
    if (user.role !== "admin" && !isManagerOf(user, branchId)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
    targets = [branchId];
  }

  const now = new Date().toISOString();
  const rows: ClosedDay[] = targets.map((b) => ({ branch_id: b, closed_date: date, reason, created_by: user.accountId, created_at: now, is_seed: false }));
  const added = await store.addClosedDays(rows);
  return c.json({ added, skipped: rows.length - added.length });
});

r.delete("/closed-days", requireManager, async (c) => {
  const user = c.get("user");
  const body = await readBody(c);
  const branchId = String(c.req.query("branchId") ?? body.branchId ?? "");
  const date = c.req.query("date") ?? body.date;
  if (!isValidDate(date)) throw new HttpError(400, "Invalid date", "BAD_DATE");
  if (user.role !== "admin" && !isManagerOf(user, branchId)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  if (!(await storeFor(c).removeClosedDay(branchId, date))) throw new HttpError(404, "That closed day does not exist", "NOT_FOUND");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------
function notHolder(err: unknown): never {
  if (err instanceof StoreError && err.code === "DENIED") throw new HttpError(403, "Only the person holding this case can do that", "NOT_HOLDER");
  throw err;
}

const holderOf = async (store: ReturnType<typeof storeFor>, deskId: string, branchId: string) =>
  (await store.activeAssignments({ branchId })).find((a) => a.desk_id === deskId);

// A holder who took the case on an earlier Laos day is stale (spec 4.14): staff may take it over.
const isStale = (a: { started_at: string }, today: string) => laosDate(new Date(a.started_at)) < today;

r.post("/desks/:id/assign", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const desk = await requireDesk(store, user, c.req.param("id"));
  const body = await readBody(c);
  const staffId = String(body.staffId ?? "");
  const target = (await store.staffAccounts()).find((a) => a.id === staffId);
  if (!target) throw new HttpError(404, "Staff member not found", "STAFF_NOT_FOUND");
  if (target.branch_id !== desk.branch_id) throw new HttpError(400, "That staff member belongs to another branch", "ASSIGN_OTHER_BRANCH");
  if (!target.active) throw new HttpError(409, "That staff account is not active", "ASSIGN_INACTIVE");

  // Staff may take a free case for themselves, or hand over a case they hold.
  if (user.role === "staff") {
    const current = await holderOf(store, desk.desk_id, desk.branch_id);
    const mayAct = current ? current.staff_id === user.accountId || (staffId === user.accountId && isStale(current, businessDate(c.env))) : staffId === user.accountId;
    if (!mayAct) throw new HttpError(403, "Only the person holding this case can hand it over", "NOT_HOLDER");
  }
  const note = body.note ? String(body.note).trim().slice(0, 200) || undefined : undefined;
  // A race with another tablet (the holder changed since the check above) is refused by the database guard.
  const assignment = await store.assignDesk(desk.desk_id, staffId, note).catch(notHolder);
  return c.json({ assignment });
});

r.post("/desks/:id/release", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const desk = await requireDesk(store, user, c.req.param("id"));
  if (user.role === "staff") {
    const current = await holderOf(store, desk.desk_id, desk.branch_id);
    if (current && current.staff_id !== user.accountId) throw new HttpError(403, "Only the person holding this case can release it", "NOT_HOLDER");
  }
  await store.releaseDesk(desk.desk_id).catch(notHolder);
  return c.json({ ok: true });
});

// The caller's cases, plus every case of their branch with its current holder
// (for the case switcher). An admin may pass ?branchId, or sees all branches.
r.get("/my-cases", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const [desks, active, accounts] = await Promise.all([store.desks(), store.activeAssignments({ branchId }), store.staffAccounts()]);
  const names = new Map(accounts.map((a) => [a.id, a.display_name]));
  const byDesk = new Map(active.map((a) => [a.desk_id, a]));
  const cases = desks
    .filter((d) => d.active && (!branchId || d.branch_id === branchId))
    .map((d) => {
      const a = byDesk.get(d.desk_id);
      return {
        desk_id: d.desk_id,
        display_name: d.display_name,
        holder: a ? { staffId: a.staff_id, name: names.get(a.staff_id) ?? "", since: a.started_at } : null,
      };
    });
  return c.json({ mine: active.filter((a) => a.staff_id === user.accountId), cases });
});

export default r;
