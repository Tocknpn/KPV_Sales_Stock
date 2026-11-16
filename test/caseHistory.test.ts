import { describe, it, expect } from "vitest";
import { buildCaseHistory, buildIssueGrid, type CaseDayRow } from "../src/caseHistory";
import { computeClosing, movementIn, movementOut } from "../src/logic";
import type { DeskDay, LedgerRow, MasterSku, ClosedDay, Desk } from "../src/types";

const sku = (id: string, baht: number | null, price = 0): MasterSku =>
  ({ sku_id: id, baht_weight: baht, unit_price_lak: price, name_en: id, category: "x" }) as unknown as MasterSku;
const skus = new Map([
  ["A", sku("A", 0.5)],
  ["B", sku("B", 1)],
]);
const staff = new Map([
  ["u1", "Noy"],
  ["u2", "Kham"],
]);

const day = (date: string, status: DeskDay["status"] = "done"): DeskDay => ({
  desk_id: "D1",
  ledger_date: date,
  branch_id: "b",
  status,
  safe_drop_note: null,
  checked_in_by: "u1",
  done_by: status === "done" ? "u2" : null,
  done_at: null,
  stock_out_mode: "dynamic",
  created_at: "",
  updated_at: "",
});

function row(date: string, sku_id: string, o: Partial<LedgerRow> = {}): LedgerRow {
  const r = {
    id: date + sku_id, ledger_date: date, desk_id: "D1", branch_id: "b", sku_id,
    opening_qty: 0, stock_in: 0, transfer_in: 0, retail_sale: 0, wholesale: 0, transfer_out: 0,
    destock: 0, destock_note: null, move: 0, stock_out_single: 0, move_qty: 0, counted_qty: null, counted_note: null,
    performed_by: null, excluded: false, created_at: "", updated_at: "", ...o,
  } as LedgerRow;
  r.closing_qty = computeClosing(r);
  return r;
}
const closedDay = (d: string): ClosedDay => ({ branch_id: "b", closed_date: d, reason: "", created_by: null, created_at: "", is_seed: false });

function build(p: Partial<Parameters<typeof buildCaseHistory>[0]>) {
  return buildCaseHistory({
    from: "2026-11-01", to: "2026-11-10", today: "2026-11-10",
    days: [], ledger: [], closed: [], skus, staffNames: staff,
    reopenedDates: new Set(), snapshots: [], fallbackPrice: 100, ...p,
  });
}

describe("move sign convention", () => {
  it("open + in - out = close for every row", () => {
    const r = row("2026-11-01", "A", { opening_qty: 5, stock_in: 2, transfer_in: 1, retail_sale: 1, wholesale: 1, transfer_out: 1, destock: 1, move: 2 });
    expect(r.opening_qty + movementIn(r) - movementOut(r)).toBe(r.closing_qty);
    const h = build({ days: [day("2026-11-01")], ledger: [r], to: "2026-11-01", today: "2026-11-02" });
    const x = h[0];
    expect(x.openBaht + x.inBaht - x.outBaht).toBeCloseTo(x.closeBaht, 6);
    expect(x.outBaht).toBeCloseTo(6 * 0.5, 6);
  });
});

describe("buildCaseHistory", () => {
  it("clean_day: done, counted = closing, no flags", () => {
    const h = build({ days: [day("2026-11-01")], ledger: [row("2026-11-01", "A", { opening_qty: 3, counted_qty: 3 })], to: "2026-11-01", today: "2026-11-02" });
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ state: "done", flags: [], diffBaht: 0, countBaht: 1.5, closeBaht: 1.5, pcsClose: 3, by: "Kham" });
  });
  it("count_diff: counted 2 vs closing 3 on a 0.5 baht SKU", () => {
    const h = build({ days: [day("2026-11-01")], ledger: [row("2026-11-01", "A", { opening_qty: 3, counted_qty: 2 })], to: "2026-11-01", today: "2026-11-02" });
    expect(h[0].diffBaht).toBeCloseTo(-0.5, 6);
    expect(h[0].flags).toContain("count_diff");
  });
  it("ignores excluded rows", () => {
    const h = build({
      days: [day("2026-11-01")],
      ledger: [row("2026-11-01", "A", { opening_qty: 3 }), row("2026-11-01", "B", { opening_qty: 9, excluded: true })],
      to: "2026-11-01", today: "2026-11-02",
    });
    expect(h[0].closeBaht).toBeCloseTo(1.5, 6);
    expect(h[0].pcsClose).toBe(3);
  });
  it("chain_break: day 2 opening 4 vs day 1 closing 3", () => {
    const h = build({
      days: [day("2026-11-01"), day("2026-11-02")], to: "2026-11-02", today: "2026-11-03",
      ledger: [row("2026-11-01", "A", { opening_qty: 3 }), row("2026-11-02", "A", { opening_qty: 4 })],
    });
    expect(h[0].date).toBe("2026-11-02");
    expect(h[0].flags).toContain("chain_break");
    expect(h[1].flags).toEqual([]);
  });
  it("chain_break: a SKU carried yesterday has no row today", () => {
    const h = build({
      days: [day("2026-11-01"), day("2026-11-02")], to: "2026-11-02", today: "2026-11-03",
      ledger: [row("2026-11-01", "A", { opening_qty: 3 }), row("2026-11-01", "B", { opening_qty: 2 }), row("2026-11-02", "A", { opening_qty: 3 })],
    });
    expect(h[0].flags).toContain("chain_break");
  });
  it("new_sku_not_break (RF5): SKU absent yesterday with opening 0", () => {
    const h = build({
      days: [day("2026-11-01"), day("2026-11-02")], to: "2026-11-02", today: "2026-11-03",
      ledger: [row("2026-11-01", "A", { opening_qty: 3 }), row("2026-11-02", "A", { opening_qty: 3 }), row("2026-11-02", "B", { opening_qty: 0, stock_in: 2 })],
    });
    expect(h[0].flags).toEqual([]);
  });
  it("closed_gap_not_missed (RF3): carries across a closed day with no break", () => {
    const h = build({
      days: [day("2026-11-01"), day("2026-11-03")], to: "2026-11-03", today: "2026-11-04",
      closed: [closedDay("2026-11-02")],
      ledger: [row("2026-11-01", "A", { opening_qty: 3 }), row("2026-11-03", "A", { opening_qty: 3 })],
    });
    expect(h.map((r) => r.state)).toEqual(["done", "closed", "done"]);
    expect(h[0].flags).toEqual([]);
    expect(h[1]).toMatchObject({ flags: [], closeBaht: 0, valueLak: null });
  });
  it("missed_day is flagged", () => {
    const h = build({
      days: [day("2026-11-01"), day("2026-11-03")], to: "2026-11-03", today: "2026-11-04",
      ledger: [row("2026-11-01", "A", { opening_qty: 3 }), row("2026-11-03", "A", { opening_qty: 3 })],
    });
    expect(h[1]).toMatchObject({ state: "missed", flags: ["missed"], diffBaht: null, countBaht: null, by: null });
  });
  it("today_open_not_missed (RF2): today without a row is open, not missed", () => {
    const h = build({
      days: [day("2026-11-01")], to: "2026-11-02", today: "2026-11-02",
      ledger: [row("2026-11-01", "A", { opening_qty: 3 })],
    });
    expect(h[0].date).toBe("2026-11-02");
    expect(h[0].state).toBe("open");
    expect(h[0].flags).not.toContain("missed");
  });
  it("today with a desk_days row not done is open", () => {
    const h = build({ days: [day("2026-11-01", "check_in")], ledger: [row("2026-11-01", "A", { opening_qty: 3 })], to: "2026-11-01", today: "2026-11-01" });
    expect(h[0].state).toBe("open");
    expect(h[0].by).toBe("Noy");
  });
  it("no days returns []", () => {
    expect(build({})).toEqual([]);
  });
  it("starts at max(from, first day)", () => {
    const h = build({ days: [day("2026-11-05")], ledger: [row("2026-11-05", "A")], from: "2026-11-01", to: "2026-11-06", today: "2026-11-07" });
    expect(h.map((r) => r.date)).toEqual(["2026-11-06", "2026-11-05"]);
    const h2 = build({
      days: [day("2026-11-01"), day("2026-11-05")],
      ledger: [row("2026-11-01", "A"), row("2026-11-05", "A")],
      from: "2026-11-05", to: "2026-11-05", today: "2026-11-07",
    });
    expect(h2.map((r) => r.date)).toEqual(["2026-11-05"]);
  });
  it("reopened comes from reopenedDates", () => {
    const h = build({ days: [day("2026-11-01")], ledger: [row("2026-11-01", "A")], to: "2026-11-01", today: "2026-11-02", reopenedDates: new Set(["2026-11-01"]) });
    expect(h[0].flags).toContain("reopened");
  });
  it("value_uses_day_price", () => {
    const h = build({
      days: [day("2026-11-01"), day("2026-11-02")], to: "2026-11-02", today: "2026-11-03",
      ledger: [row("2026-11-01", "A", { opening_qty: 2 }), row("2026-11-02", "A", { opening_qty: 2 })],
      snapshots: [
        { price_date: "2026-11-01", price_baht_sell: 1000 },
        { price_date: "2026-11-02", price_baht_sell: 2000 },
      ],
    });
    expect(h[0].valueLak).toBe(2 * 0.5 * 2000);
    expect(h[1].valueLak).toBe(2 * 0.5 * 1000);
  });
});

describe("buildIssueGrid", () => {
  it("grid_cells maps each kind", () => {
    const mk = (date: string, state: CaseDayRow["state"], flags: CaseDayRow["flags"], diffBaht: number | null = 0): CaseDayRow => ({
      date, state, openBaht: 0, inBaht: 0, outBaht: 0, closeBaht: 0, countBaht: null, diffBaht, pcsClose: 0, valueLak: null, by: null, flags,
    });
    const desks = [{ desk_id: "D1", display_name: "Case 1" }] as unknown as Desk[];
    const perDesk = new Map([
      [
        "D1",
        [
          mk("2026-11-01", "done", []),
          mk("2026-11-02", "done", ["count_diff"], -0.5),
          mk("2026-11-03", "done", ["chain_break"]),
          mk("2026-11-04", "done", ["reopened"]),
          mk("2026-11-05", "missed", ["missed"], null),
          mk("2026-11-06", "open", []),
          mk("2026-11-07", "closed", []),
        ],
      ],
    ]);
    const g = buildIssueGrid({ month: "2026-11", desks, perDesk });
    expect(g.dates).toHaveLength(30);
    expect(g.rows[0]).toMatchObject({ deskId: "D1", name: "Case 1" });
    expect(g.rows[0].cells.slice(0, 7)).toEqual([
      { kind: "ok" },
      { kind: "diff", diffBaht: -0.5 },
      { kind: "warn" },
      { kind: "warn" },
      { kind: "unchecked" },
      { kind: "unchecked" },
      null,
    ]);
  });
});
