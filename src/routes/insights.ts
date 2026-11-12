// Dashboard and Report — both computed entirely from the ledger.
// Mounted behind requireAuth in src/index.ts.
import { newRouter, HttpError, scopeBranch } from "../app";
import { getStore } from "../store";
import { assertBranchAccess } from "../auth";
import { businessDate, addDays, isValidMonth, monthRange } from "../time";
import { buildDashboard, buildReport, AGING_LOOKBACK_DAYS } from "../logic";
import type { Desk, SessionUser } from "../types";

const r = newRouter();

// A deskId filter is only honoured for a desk the user may see.
function scopeDesk(user: SessionUser, desks: Desk[], deskId: string | undefined) {
  if (!deskId) return undefined;
  const desk = desks.find((d) => d.desk_id === deskId);
  if (!desk) throw new HttpError(404, "Desk not found", "DESK_NOT_FOUND");
  if (!assertBranchAccess(user, desk.branch_id)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  return desk.desk_id;
}

r.get("/dashboard", async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const today = businessDate(c.env);
  const period = c.req.query("period") === "mtd" ? "mtd" : "today";
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const desks = await store.desks();
  const deskId = scopeDesk(user, desks, c.req.query("deskId") || undefined);
  const stockFlagQuery = c.req.query("stockFlag");
  const stockFlag = stockFlagQuery === "low" || stockFlagQuery === "over" ? stockFlagQuery : undefined;
  const movementFrom = period === "mtd" ? `${today.slice(0, 7)}-01` : today;
  const agingFrom = addDays(today, -AGING_LOOKBACK_DAYS);

  // One read covers both the aging window and the (shorter) movement period.
  const [skus, branches, latestDays, latestRows, windowRows, inTransit, config] = await Promise.all([
    store.skus(),
    store.branches(),
    store.latestDeskDays({ branchId, deskId }),
    store.ledgerLatest({ branchId, deskId }),
    store.ledger({ from: agingFrom, to: today, branchId, deskId }),
    store.transfers({ branchId, status: "in_transit" }),
    store.config(),
  ]);
  return c.json(
    buildDashboard({
      today,
      skus,
      branches,
      desks,
      latestDays,
      latestRows,
      movementRows: windowRows.filter((row) => row.ledger_date >= movementFrom),
      agingRows: windowRows,
      inTransit,
      config,
      filter: { branchId, deskId, category: c.req.query("category") || undefined, stockFlag },
    })
  );
});

r.get("/report", async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const period = c.req.query("period") || businessDate(c.env).slice(0, 7);
  if (!isValidMonth(period)) throw new HttpError(400, "Invalid period", "BAD_MONTH");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const deskId = scopeDesk(user, await store.desks(), c.req.query("deskId") || undefined);
  const { from, to } = monthRange(period);
  const [rows, days, skus, config] = await Promise.all([
    store.ledger({ from, to, branchId, deskId }),
    store.deskDays({ from, to, branchId, deskId }),
    store.skus(),
    store.config(),
  ]);
  return c.json({ period, ...buildReport(rows, days, skus, { q: c.req.query("q") || undefined }, config) });
});

export default r;
