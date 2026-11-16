// Dashboard and Report — both computed entirely from the ledger.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, HttpError, scopeBranch } from "../app";
import { assertBranchAccess } from "../auth";
import { businessDate, addDays, isValidMonth, monthRange } from "../time";
import { buildDashboard, buildReport, AGING_LOOKBACK_DAYS } from "../logic";
import { resolveGoldPrice, priceOn } from "../goldPrice";
import { loadBranchStatuses } from "../replenishment";
import { buildCaseHistory, buildIssueGrid } from "../caseHistory";
import type { CaseDayRow } from "../caseHistory";
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
  const store = storeFor(c);
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
  const [skus, branches, latestDays, latestRows, windowRows, inTransit, config, goldRow] = await Promise.all([
    store.skus(),
    store.branches(),
    store.latestDeskDays({ branchId, deskId }),
    store.ledgerLatest({ branchId, deskId }),
    store.ledger({ from: agingFrom, to: today, branchId, deskId }),
    store.transfers({ branchId, status: "in_transit" }),
    store.config(),
    store.goldPrice(),
  ]);
  const gold = resolveGoldPrice(goldRow, config, today);
  const statuses = await loadBranchStatuses(store, branchId ? [branchId] : branches.map((b) => b.branch_id), today);
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
      lakPerBaht: gold.lakPerBaht,
      statuses,
      filter: { branchId, deskId, category: c.req.query("category") || undefined, stockFlag },
    })
  );
});

r.get("/report", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const today = businessDate(c.env);
  const period = c.req.query("period") || today.slice(0, 7);
  if (!isValidMonth(period)) throw new HttpError(400, "Invalid period", "BAD_MONTH");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const deskId = scopeDesk(user, await store.desks(), c.req.query("deskId") || undefined);
  const { from, to } = monthRange(period);
  const [rows, days, skus, config, goldRow, goldHistory] = await Promise.all([
    store.ledger({ from, to, branchId, deskId }),
    store.deskDays({ from, to, branchId, deskId }),
    store.skus(),
    store.config(),
    store.goldPrice(),
    store.goldPriceHistory(from, to),
  ]);
  // A month is valued at the price in force on its last day (or today, if the month is still running).
  const gold = resolveGoldPrice(goldRow, config, today);
  const lakPerBaht = priceOn(to < today ? to : today, goldHistory, gold.lakPerBaht);
  return c.json({ period, ...buildReport(rows, days, skus, { q: c.req.query("q") || undefined }, config, lakPerBaht) });
});

// Month grid of issues: one row per active case of a branch, one cell per day.
r.get("/report/grid", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const today = businessDate(c.env);
  const month = c.req.query("month") || today.slice(0, 7);
  if (!isValidMonth(month)) throw new HttpError(400, "Invalid month", "BAD_MONTH");
  const branchId = scopeBranch(user, c.req.query("branch") || undefined);
  if (!branchId) throw new HttpError(400, "branch is required", "BRANCH_REQUIRED");
  const [branches, allDesks] = await Promise.all([store.branches(), store.desks()]);
  if (!branches.some((b) => b.branch_id === branchId)) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
  const desks = allDesks.filter((d) => d.branch_id === branchId && d.active);

  const { from, to: monthEnd } = monthRange(month);
  // Days that have not happened yet stay blank.
  const to = monthEnd > today ? today : monthEnd;
  const perDesk = new Map<string, CaseDayRow[]>();
  if (to >= from && desks.length > 0) {
    const deskIds = desks.map((d) => d.desk_id);
    // One range read for the month, plus each case's latest earlier day so the
    // first day of the month is chain-checked against it.
    const [monthDays, anchors, closed, skus, staffAccounts, config, goldRow, snapshots, reopened] = await Promise.all([
      store.deskDays({ branchId, from, to }),
      Promise.all(deskIds.map((deskId) => store.deskDays({ deskId, before: from, order: "desc", limit: 1 }))),
      store.closedDays({ branchId, from, to }),
      store.skus(),
      store.staffAccounts(),
      store.config(),
      store.goldPrice(),
      store.goldPriceHistory(from, to),
      store.reopenedDates(deskIds, from, to),
    ]);
    const anchorDays = anchors.flat();
    const ledgerFrom = anchorDays.reduce((min, d) => (d.ledger_date < min ? d.ledger_date : min), from);
    const ledger = await store.ledger({ branchId, from: ledgerFrom, to });
    const skuMap = new Map(skus.map((s) => [s.sku_id, s]));
    const staffNames = new Map(staffAccounts.map((a) => [a.id, a.display_name]));
    const fallbackPrice = resolveGoldPrice(goldRow, config, today).lakPerBaht;
    for (const desk of desks) {
      const id = desk.desk_id;
      perDesk.set(
        id,
        buildCaseHistory({
          from,
          to,
          today,
          days: [...anchorDays, ...monthDays].filter((d) => d.desk_id === id),
          ledger: ledger.filter((l) => l.desk_id === id),
          closed,
          skus: skuMap,
          staffNames,
          reopenedDates: reopened.get(id) ?? new Set(),
          snapshots,
          fallbackPrice,
        })
      );
    }
  }
  return c.json(buildIssueGrid({ month, desks, perDesk }));
});

export default r;
