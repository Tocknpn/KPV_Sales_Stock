// Case (desk) day-by-day history and the monthly issue grid. Pure: no I/O.
import { priceOn } from "./goldPrice";
import { carryQty, movementIn, movementOut, valueLak } from "./logic";
import { addDays, datesInMonth } from "./time";
import type { ClosedDay, Desk, DeskDay, GoldPriceSnapshot, LedgerRow, MasterSku } from "./types";

export type DayFlag = "count_diff" | "chain_break" | "missed" | "reopened";

export interface CaseDayRow {
  date: string;
  state: "done" | "open" | "missed" | "closed";
  openBaht: number;
  inBaht: number;
  outBaht: number;
  closeBaht: number;
  countBaht: number | null;
  diffBaht: number | null;
  pcsClose: number;
  valueLak: number | null;
  by: string | null;
  flags: DayFlag[];
}

export type GridCell = { kind: "ok" | "diff" | "warn" | "unchecked"; diffBaht?: number };

export interface CaseHistoryInput {
  from: string;
  to: string;
  today: string;
  days: DeskDay[];
  ledger: LedgerRow[];
  closed: ClosedDay[];
  skus: Map<string, MasterSku>;
  staffNames: Map<string, string>;
  reopenedDates: Set<string>;
  snapshots: GoldPriceSnapshot[];
  fallbackPrice: number;
}

const DIFF_EPSILON = 0.005;
// Strips float noise from sums of qty x baht weight.
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function emptyRow(date: string, state: CaseDayRow["state"], flags: DayFlag[]): CaseDayRow {
  return { date, state, openBaht: 0, inBaht: 0, outBaht: 0, closeBaht: 0, countBaht: null, diffBaht: null, pcsClose: 0, valueLak: null, by: null, flags };
}

export function buildCaseHistory(input: CaseHistoryInput): CaseDayRow[] {
  const { from, to, today, days, ledger, closed, skus, staffNames, reopenedDates, snapshots, fallbackPrice } = input;
  if (days.length === 0) return [];

  const dayByDate = new Map(days.map((d) => [d.ledger_date, d]));
  const recorded = [...dayByDate.keys()].sort();
  const firstDay = recorded[0];
  const closedDates = new Set(closed.map((c) => c.closed_date));

  const rowsByDate = new Map<string, LedgerRow[]>();
  for (const r of ledger) {
    if (r.excluded) continue;
    const list = rowsByDate.get(r.ledger_date);
    if (list) list.push(r);
    else rowsByDate.set(r.ledger_date, [r]);
  }

  // Previous recorded day = latest earlier date that has a desk_days row.
  const prevRecorded = (date: string): string | null => {
    let prev: string | null = null;
    for (const d of recorded) {
      if (d < date) prev = d;
      else break;
    }
    return prev;
  };

  const start = from > firstDay ? from : firstDay;
  const out: CaseDayRow[] = [];

  for (let date = start; date <= to; date = addDays(date, 1)) {
    const day = dayByDate.get(date);
    if (!day) {
      if (closedDates.has(date)) out.push(emptyRow(date, "closed", []));
      else if (date >= today) out.push(emptyRow(date, "open", []));
      else out.push(emptyRow(date, "missed", ["missed"]));
      continue;
    }

    const rows = rowsByDate.get(date) ?? [];
    const price = priceOn(date, snapshots, fallbackPrice);
    let openBaht = 0, inBaht = 0, outBaht = 0, closeBaht = 0, pcs = 0, lak = 0;
    let countBaht = 0, diff = 0, anyCount = false;
    for (const r of rows) {
      const sku = skus.get(r.sku_id);
      const w = sku?.baht_weight ?? 0;
      openBaht += r.opening_qty * w;
      inBaht += movementIn(r) * w;
      outBaht += movementOut(r) * w;
      closeBaht += r.closing_qty * w;
      pcs += r.closing_qty;
      lak += valueLak(sku, r.closing_qty, price);
      if (r.counted_qty != null) {
        anyCount = true;
        countBaht += r.counted_qty * w;
        diff += (r.counted_qty - r.closing_qty) * w;
      }
    }

    const flags: DayFlag[] = [];
    const diffBaht = anyCount ? r4(diff) : null;
    if (diffBaht != null && Math.abs(diffBaht) >= DIFF_EPSILON) flags.push("count_diff");

    const prev = prevRecorded(date);
    if (prev) {
      const prevCarry = new Map<string, number>();
      for (const r of rowsByDate.get(prev) ?? []) prevCarry.set(r.sku_id, Math.max(0, carryQty(r)));
      const here = new Set(rows.map((r) => r.sku_id));
      const dropped = [...prevCarry].some(([id, q]) => q > 0 && !here.has(id));
      if (dropped || rows.some((r) => r.opening_qty !== (prevCarry.get(r.sku_id) ?? 0))) flags.push("chain_break");
    }
    if (reopenedDates.has(date)) flags.push("reopened");

    const byId = day.done_by ?? day.checked_in_by;
    out.push({
      date,
      state: day.status === "done" ? "done" : "open",
      openBaht: r4(openBaht),
      inBaht: r4(inBaht),
      outBaht: r4(outBaht),
      closeBaht: r4(closeBaht),
      countBaht: anyCount ? r4(countBaht) : null,
      diffBaht,
      pcsClose: pcs,
      valueLak: lak,
      by: byId ? (staffNames.get(byId) ?? null) : null,
      flags,
    });
  }

  return out.reverse();
}

function cellFor(row: CaseDayRow): GridCell | null {
  if (row.state === "closed") return null;
  if (row.flags.includes("count_diff")) return { kind: "diff", diffBaht: row.diffBaht ?? 0 };
  if (row.flags.includes("chain_break") || row.flags.includes("reopened")) return { kind: "warn" };
  if (row.state === "done") return { kind: "ok" };
  return { kind: "unchecked" };
}

// Month grid: one row per case, one cell per date. null = closed day, or a
// date outside the case's history (before its first day / after the range).
export function buildIssueGrid(input: { month: string; desks: Desk[]; perDesk: Map<string, CaseDayRow[]> }) {
  const dates = datesInMonth(input.month);
  const rows = input.desks.map((d) => {
    const byDate = new Map((input.perDesk.get(d.desk_id) ?? []).map((r) => [r.date, r]));
    return {
      deskId: d.desk_id,
      name: d.display_name,
      cells: dates.map((date) => {
        const r = byDate.get(date);
        return r ? cellFor(r) : null;
      }),
    };
  });
  return { dates, rows };
}
