// historyMoves (the move tickets on a case's History tab) reads nothing when
// there are no move tickets, and one deskDays read for all tickets otherwise.
import { beforeEach, describe, expect, it } from "vitest";
import { historyMoves } from "../src/routes/stock";
import { getStore, resetDemoStore } from "../src/store";
import { TODAY } from "./helpers";
import { spyStore } from "./storeSpy";
import type { Transfer } from "../src/types";

beforeEach(resetDemoStore);
const store = () => getStore({ DEMO_DATE: TODAY } as any);

const move = (over: Partial<Transfer>): Transfer =>
  ({
    id: "t1",
    kind: "move",
    ticket_id: "T-1",
    status: "received",
    from_desk_id: "MM-D01",
    to_desk_id: "MM-D02",
    from_branch_id: "B-MM",
    to_branch_id: "B-MM",
    sku_id: "NK-011",
    qty: 1,
    sent_date: TODAY,
    sent_by: null,
    created_at: `${TODAY}T03:00:00Z`,
    reverses_id: null,
    note: null,
    ...over,
  }) as Transfer;

describe("historyMoves", () => {
  it("no move tickets: no store reads at all", async () => {
    const spy = spyStore(store());
    const out = await historyMoves(spy.store, "MM-D01", TODAY, [], [], [], [], []);
    expect(out).toEqual([]);
    expect(spy.count()).toBe(0);
  });

  it("transfers that are not moves: no store reads", async () => {
    const spy = spyStore(store());
    const out = await historyMoves(spy.store, "MM-D01", TODAY, [move({ kind: "transfer" as any, ticket_id: null })], [], [], [], []);
    expect(out).toEqual([]);
    expect(spy.count()).toBe(0);
  });

  it("several tickets: one deskDays read for every desk involved", async () => {
    const spy = spyStore(store());
    const out = await historyMoves(
      spy.store,
      "MM-D01",
      TODAY,
      [move({ id: "a", ticket_id: "T-1" }), move({ id: "b", ticket_id: "T-2", to_desk_id: "MM-D03" })],
      [move({ id: "c", ticket_id: "T-3", from_desk_id: "MM-D02", to_desk_id: "MM-D01" })],
      [],
      [],
      []
    );
    expect(out.map((m) => m.ticketId).sort()).toEqual(["T-1", "T-2", "T-3"]);
    expect(spy.count()).toBe(1);
    expect(spy.count("deskDays")).toBe(1);
  });
});
