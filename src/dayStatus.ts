// CR3: a case's check streak, days behind and tier (spec section 4, Definitions).
// Pure: the caller supplies the case's history, its branch's closed dates and "today".
import { addDays } from "./time";
import type { DeskDay } from "./types";

export type Tier = "done_today" | "on_track" | "behind_1" | "overdue";

// The UI prints this as "365+".
export const STREAK_CAP = 366;

export interface DayStatusInput {
  deskCreatedDate: string;
  days: Pick<DeskDay, "ledger_date" | "status" | "done_at" | "done_by">[];
  closedDates: Set<string>;
  today: string;
}

export interface DayStatus {
  streak: number;
  lastDoneDate: string | null;
  lastDoneAt: string | null;
  lastDoneBy: string | null;
  daysBehind: number;
  tier: Tier;
}

export function buildDayStatus({ deskCreatedDate, days, closedDates, today }: DayStatusInput): DayStatus {
  // Only a Done day is checked; check_in and final_stock are not.
  const doneByDate = new Map<string, (typeof days)[number]>();
  for (const d of days) if (d.status === "done" && d.ledger_date <= today) doneByDate.set(d.ledger_date, d);

  let lastDoneDate: string | null = null;
  for (const date of doneByDate.keys()) if (!lastDoneDate || date > lastDoneDate) lastDoneDate = date;
  const last = lastDoneDate ? doneByDate.get(lastDoneDate)! : null;

  const required = (date: string) => date >= deskCreatedDate && date <= today && !closedDates.has(date);

  // Streak: walk back from the anchor over required dates; closed days are skipped.
  const checkedToday = doneByDate.has(today);
  let streak = 0;
  for (let d = checkedToday ? today : addDays(today, -1); d >= deskCreatedDate && streak < STREAK_CAP; d = addDays(d, -1)) {
    if (closedDates.has(d)) continue;
    if (!doneByDate.has(d)) break;
    streak++;
  }

  // Days behind: required dates strictly between the last Done day and today.
  let daysBehind = 0;
  const start = lastDoneDate && lastDoneDate >= deskCreatedDate ? addDays(lastDoneDate, 1) : deskCreatedDate;
  for (let d = start; d < today; d = addDays(d, 1)) if (required(d)) daysBehind++;

  const tier: Tier = checkedToday ? "done_today" : daysBehind === 0 ? "on_track" : daysBehind === 1 ? "behind_1" : "overdue";
  return { streak, lastDoneDate, lastDoneAt: last?.done_at ?? null, lastDoneBy: last?.done_by ?? null, daysBehind, tier };
}
