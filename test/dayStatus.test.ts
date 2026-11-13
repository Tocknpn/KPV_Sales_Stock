// CR3: check streak, days behind and tier (spec section 4, Definitions).
import { describe, expect, it } from "vitest";
import { buildDayStatus } from "../src/dayStatus";
import { addDays } from "../src/time";

const TODAY = "2026-11-12";
const CREATED = "2026-01-01";
const done = (date: string) => ({ ledger_date: date, status: "done" as const, done_at: `${date}T10:00:00.000Z`, done_by: "u1" });
const open = (date: string, status: "check_in" | "final_stock") => ({ ledger_date: date, status, done_at: null, done_by: null });
const run = (days: any[], closed: string[] = [], created = CREATED) =>
  buildDayStatus({ deskCreatedDate: created, days, closedDates: new Set(closed), today: TODAY });
const back = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => addDays(TODAY, -(from - i)));

describe("buildDayStatus", () => {
  it("21 consecutive Done days, today open -> on_track, streak 21", () => {
    const s = run(back(21, 1).map(done));
    expect(s.tier).toBe("on_track");
    expect(s.streak).toBe(21);
    expect(s.daysBehind).toBe(0);
    expect(s.lastDoneDate).toBe(addDays(TODAY, -1));
  });

  it("today Done -> done_today, streak includes today", () => {
    const s = run(back(3, 0).map(done));
    expect(s.tier).toBe("done_today");
    expect(s.streak).toBe(4);
    expect(s.lastDoneDate).toBe(TODAY);
    expect(s.lastDoneBy).toBe("u1");
    expect(s.lastDoneAt).toBe(`${TODAY}T10:00:00.000Z`);
  });

  it("last Done today-2 -> behind_1", () => {
    const s = run([done(addDays(TODAY, -2))]);
    expect(s.tier).toBe("behind_1");
    expect(s.daysBehind).toBe(1);
    expect(s.streak).toBe(0);
  });

  it("last Done today-4 -> overdue, daysBehind 3", () => {
    const s = run([done(addDays(TODAY, -4))]);
    expect(s.tier).toBe("overdue");
    expect(s.daysBehind).toBe(3);
  });

  it("a closed day with Done records is skipped: streak neither breaks nor counts it", () => {
    const days = [...back(5, 1)].map(done);
    const closed = addDays(TODAY, -3);
    expect(run(days, [closed]).streak).toBe(4);
    // A gap on the closed day does not break the streak either.
    expect(run(days.filter((d) => d.ledger_date !== closed), [closed]).streak).toBe(4);
  });

  it("a closed day in a gap is not counted as behind", () => {
    const s = run([done(addDays(TODAY, -3))], [addDays(TODAY, -2)]);
    expect(s.daysBehind).toBe(1);
    expect(s.tier).toBe("behind_1");
  });

  it("new case created today -> on_track, streak 0, behind 0", () => {
    const s = run([], [], TODAY);
    expect(s).toMatchObject({ tier: "on_track", streak: 0, daysBehind: 0, lastDoneDate: null });
  });

  it("an unfinished (check_in) earlier day counts as behind", () => {
    const s = run([done(addDays(TODAY, -3)), open(addDays(TODAY, -2), "check_in"), open(addDays(TODAY, -1), "final_stock")]);
    expect(s.daysBehind).toBe(2);
    expect(s.tier).toBe("overdue");
    expect(s.streak).toBe(0);
  });

  it("caps the streak at 366", () => {
    const days = back(399, 0).map(done);
    expect(run(days, [], "2025-01-01").streak).toBe(366);
  });
});
