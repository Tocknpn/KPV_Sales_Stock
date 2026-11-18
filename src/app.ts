// Shared route plumbing: Hono app type, access scoping, the date rule, and
// small request helpers used by every route module.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Desk, DeskDay, Env, SessionUser } from "./types";
import { getStore, type Store } from "./store";
import { assertBranchAccess } from "./auth";
import { isValidDate } from "./time";

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
export type Ctx = Context<AppEnv>;

// The store for this request: every write is attributed to the logged-in user.
export function storeFor(c: Ctx): Store {
  const user = c.get("user");
  return getStore(c.env, user ? { id: user.accountId } : undefined);
}

export function newRouter() {
  return new Hono<AppEnv>();
}

// An error a route raises on purpose; turned into a JSON response by
// app.onError in src/index.ts. `code` lets the UI react without parsing text.
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export async function readBody(c: Ctx): Promise<Record<string, any>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

// Staff and branch managers only ever see their own branch; admins see whatever branchId
// (or none, for "all branches") they ask for.
export function scopeBranch(user: SessionUser, requestedBranchId: string | undefined) {
  return user.role !== "admin" ? user.branchId ?? undefined : requestedBranchId;
}

// The branches a per-branch write goes to (reorder values, carries switch, import).
// allBranches = every branch, admin only. Otherwise one branch: a staff or
// manager gets their own (another one sent is refused); an admin must name one.
export async function targetBranches(store: Store, user: SessionUser, branchId: unknown, allBranches?: unknown): Promise<string[]> {
  const branches = await store.branches();
  if (allBranches === true) {
    if (user.role !== "admin") throw new HttpError(403, "Only an admin can change every branch", "ROLE_DENIED");
    return branches.map((b) => b.branch_id);
  }
  const asked = branchId === undefined || branchId === null || branchId === "" ? undefined : String(branchId);
  if (user.role !== "admin") {
    if (asked !== undefined && asked !== user.branchId) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
    if (!user.branchId) throw new HttpError(400, "branchId is required", "BRANCH_REQUIRED");
    return [user.branchId];
  }
  if (asked === undefined) throw new HttpError(400, "branchId is required", "BRANCH_REQUIRED");
  if (!branches.some((b) => b.branch_id === asked)) throw new HttpError(404, "Branch not found", "BRANCH_NOT_FOUND");
  return [asked];
}

// Loads a desk and enforces that the user may act on its branch.
export async function requireDesk(store: Store, user: SessionUser, deskId: string | undefined): Promise<Desk> {
  const desk = deskId ? (await store.desks()).find((d) => d.desk_id === deskId) : undefined;
  if (!desk) throw new HttpError(404, "Desk not found", "DESK_NOT_FOUND");
  if (!assertBranchAccess(user, desk.branch_id)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  return desk;
}

export function requireDate(value: unknown, today: string): string {
  const date = value == null || value === "" ? today : value;
  if (!isValidDate(date)) throw new HttpError(400, "Invalid date", "BAD_DATE");
  return date;
}

// Which dates may be WRITTEN:
//   - nobody records a future date;
//   - staff record today, or keep working on an earlier day that is still open
//     (finishing a day that was left unfinished);
//   - admin may record any past date.
export function assertDateWritable(user: SessionUser, date: string, today: string, existingDay: DeskDay | undefined) {
  if (date > today) throw new HttpError(400, "Future dates cannot be recorded", "FUTURE_DATE");
  if (user.role === "admin" || date === today) return;
  if (existingDay && existingDay.status !== "done") return;
  throw new HttpError(403, "Only today can be recorded. Ask an admin to record a past date.", "PAST_DATE");
}

export async function getDay(store: Store, deskId: string, date: string): Promise<DeskDay | undefined> {
  return (await store.deskDays({ deskId, date, limit: 1 }))[0];
}

// For every write to a day's rows: the day must exist, must not be Done, and
// every earlier day of the case must be Done (days are finished in order).
export async function requireOpenDay(store: Store, user: SessionUser, deskId: string, date: string, today: string): Promise<DeskDay> {
  const day = await getDay(store, deskId, date);
  assertDateWritable(user, date, today, day);
  if (!day) throw new HttpError(409, "This desk has not been checked in for that date", "NOT_CHECKED_IN");
  if (day.status === "done") throw new HttpError(423, "This day is Done and locked for this Desk", "DAY_LOCKED");
  const [openEarlier] = await store.deskDays({ deskId, before: date, notStatus: "done", order: "asc", limit: 1 });
  if (openEarlier) {
    throw new HttpError(409, `Finish ${openEarlier.ledger_date} first — that day is not Done yet`, "EARLIER_DAY_OPEN", {
      openDate: openEarlier.ledger_date,
    });
  }
  return day;
}

// `scope` says which branch (and case) the entry is about, so a manager's
// branch view of the audit log includes it. Company-wide entries omit it.
export async function audit(
  store: Store,
  user: SessionUser,
  action: string,
  target: string,
  detail: Record<string, unknown> | null = null,
  scope: { branchId?: string | null; deskId?: string | null } = {}
) {
  await store.audit({
    actor_id: user.accountId,
    actor_name: user.displayName,
    action,
    target,
    detail,
    branch_id: scope.branchId ?? null,
    desk_id: scope.deskId ?? null,
  });
}
