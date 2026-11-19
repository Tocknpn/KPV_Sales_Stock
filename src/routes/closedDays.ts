// Branch closed days (holidays). Case assignment was retired: any staff of the
// branch works any case and their name is stamped on what they change.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, scopeBranch } from "../app";
import { requireManager, isManagerOf } from "../auth";
import { isValidDate } from "../time";
import { listHaving } from "../cachedStore";
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
  const branches = (await listHaving(store, "branches", (l) => branchId === "all" || l.some((b) => b.branch_id === branchId))).map((b) => b.branch_id);
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

export default r;
