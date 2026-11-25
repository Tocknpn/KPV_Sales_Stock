// Dashboard and Report — both computed entirely from the ledger.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, HttpError, scopeBranch } from "../app";
import { assertBranchAccess } from "../auth";
import { businessDate, addDays, isValidMonth, monthRange } from "../time";
import { buildDashboard, buildReport, AGING_LOOKBACK_DAYS } from "../logic";
import { resolveGoldPrice, priceOn } from "../goldPrice";
import { loadBranchStatuses, loadBranchData } from "../replenishment";
import { buildCaseHistory, buildIssueGrid } from "../caseHistory";
import { buildExecutive, PERIODS, type PeriodDays } from "../executive";
import type { CaseDayRow } from "../caseHistory";
import type { Desk, DeskDay, DocumentRecord, SessionUser } from "../types";

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
  return c.json({
    ...buildDashboard({
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
    }),
  });
});

// Executive overview (the CEO dashboard and the report's position / stock-out /
// case tables). period = 7 | 30 | 90 rolling days ending today.
r.get("/executive", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const today = businessDate(c.env);
  const asked = Number(c.req.query("days"));
  const periodDays: PeriodDays = (PERIODS as readonly number[]).includes(asked) ? (asked as PeriodDays) : 30;
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const [skus, types, branches, desks, rules, config, goldRow] = await Promise.all([
    store.skus(),
    store.skuTypes(),
    store.branches(),
    store.desks(),
    store.rules(),
    store.config(),
    store.goldPrice(),
  ]);
  const branchIds = branchId ? [branchId] : branches.map((b) => b.branch_id);
  const from = addDays(today, -(periodDays - 1));
  const [data, latestDays, ledger, proposals] = await Promise.all([
    loadBranchData(store, branchIds, today, { skus, rules, config, desks }),
    store.latestDeskDays({ branchId }),
    store.ledger({ from: addDays(from, -periodDays), to: today, branchId }),
    liveProposals(store, branchId, addDays(today, -PROPOSAL_LOOKBACK_DAYS)),
  ]);
  const gold = resolveGoldPrice(goldRow, config, today);
  return c.json({
    ...buildExecutive({
      today,
      periodDays,
      skus,
      types,
      branches,
      desks,
      statuses: data.statuses,
      latestDays,
      latestRows: data.latestRows,
      ledger,
      proposals,
      config,
      lakPerBaht: gold.lakPerBaht,
      branchIds,
    }),
    priceStale: gold.stale,
  });
});

// Long enough to cover any lead time + warning margin a branch sets.
const PROPOSAL_LOOKBACK_DAYS = 120;

async function liveProposals(store: ReturnType<typeof storeFor>, branchId: string | undefined, dateFrom: string) {
  const out: DocumentRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const { rows, total } = await store.documents({ branchId, kind: "proposal", statusIn: ["pending", "approved"], dateFrom, page, pageSize: 100 });
    out.push(...rows);
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

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
  const statuses = await loadBranchStatuses(store, [...new Set(rows.map((r) => r.branch_id))], today);
  return c.json({ period, ...buildReport(rows, days, skus, { q: c.req.query("q") || undefined }, config, lakPerBaht, statuses) });
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
    const [monthDays, earlierDays, closed, skus, staffAccounts, config, goldRow, snapshots, reopened] = await Promise.all([
      store.deskDays({ branchId, from, to }),
      store.deskDays({ branchId, from: addDays(from, -400), before: from }),
      store.closedDays({ branchId, from, to }),
      store.skus(),
      store.staffAccounts(),
      store.config(),
      store.goldPrice(),
      store.goldPriceHistory(from, to),
      store.reopenedDates(deskIds, from, to),
    ]);
    // Each case's latest earlier day (rows are ascending, so the last one per case wins).
    const latestEarlier = new Map<string, DeskDay>();
    for (const d of earlierDays) if (deskIds.includes(d.desk_id)) latestEarlier.set(d.desk_id, d);
    const anchorDays = [...latestEarlier.values()];
    // The month's rows, plus only the anchor days' rows (one read, however far back they are).
    const [monthLedger, anchorLedger] = await Promise.all([
      store.ledger({ branchId, from, to }),
      anchorDays.length > 0
        ? store.ledger({ pairs: anchorDays.map((d) => ({ deskId: d.desk_id, date: d.ledger_date })) })
        : Promise.resolve([]),
    ]);
    const ledger = [...anchorLedger, ...monthLedger];
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
