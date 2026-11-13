// The audit trail, read-only. There is deliberately no route that changes or
// deletes an entry. Scope follows spec 4.8:
//   staff    only one case (deskId) of their own branch, and only today (Laos)
//   manager  their own branch
//   admin    everything
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, HttpError, requireDesk } from "../app";
import { businessDate, addDays, isValidDate } from "../time";

const r = newRouter();

const PAGE = 50;
const MAX_PAGE = 500;
const LAOS_OFFSET = "+07:00";

// Start of a Laos calendar day as a UTC instant.
const laosStart = (date: string) => new Date(`${date}T00:00:00${LAOS_OFFSET}`).toISOString();

r.get("/audit", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const today = businessDate(c.env);
  const q = (k: string) => c.req.query(k) || undefined;

  let deskId = q("deskId");
  let branchId = q("branchId");
  const actorId = q("actorId");
  let from = q("from");
  let to = q("to");
  const before = q("before");

  for (const d of [from, to]) {
    if (d !== undefined && !isValidDate(d)) throw new HttpError(400, "Invalid date", "BAD_DATE");
  }
  if (before !== undefined && Number.isNaN(Date.parse(before))) throw new HttpError(400, "Invalid cursor", "BAD_CURSOR");

  if (user.role === "staff") {
    if (!deskId) throw new HttpError(403, "Choose a case to see its history", "AUDIT_DENIED");
    if (branchId || actorId) throw new HttpError(403, "History is limited to one case", "AUDIT_DENIED");
    await requireDesk(store, user, deskId);
    from = to = today;
  } else if (user.role === "manager") {
    if (!user.branchId) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
    if (branchId && branchId !== user.branchId) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
    if (deskId) await requireDesk(store, user, deskId);
    branchId = user.branchId;
  }

  const requested = Math.floor(Number(q("limit")));
  const limit = Math.min(MAX_PAGE, Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : PAGE));
  const rows = await store.auditLog({
    deskId,
    branchId,
    actorId,
    from: from ? laosStart(from) : undefined,
    to: to ? laosStart(addDays(to, 1)) : undefined,
    before,
    limit: limit + 1,
  });
  const more = rows.length > limit;
  const entries = more ? rows.slice(0, limit) : rows;
  return c.json({ entries, next: more ? entries[entries.length - 1].created_at : null });
});

export default r;
