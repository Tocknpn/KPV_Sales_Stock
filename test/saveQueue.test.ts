// Simulates the day screen's save queue (public/js/views/day/save-queue.js)
// against a fake API: "Saved" must only be reported when every request of the
// burst succeeded, and unsent edits must be countable so leaving the screen can
// warn about them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ saveChanges: vi.fn(), deskDetail: vi.fn() }));
vi.mock("../public/js/api.js", () => ({ api }));
// @ts-expect-error plain browser ES module without types
import { createSaveQueue } from "../public/js/views/day/save-queue.js";

const last = <T,>(a: T[]) => a[a.length - 1];

class HttpFail extends Error {
  constructor(public status: number | undefined, public code?: string, public data?: any) {
    super(code ?? "network");
  }
}

function setup() {
  const stored = new Map<string, any>([["GB-001", { sku_id: "GB-001", retail_sale: 0, stock_in: 0, counted_qty: null }]]);
  const states: string[] = [];
  const results: any[] = [];
  const queue = createSaveQueue({
    deskId: "MM-D01",
    date: "2026-11-12",
    getStored: (sku: string) => stored.get(sku),
    onStored: (sku: string, row: any) => Object.assign(stored.get(sku), row),
    onResult: (res: any) => results.push(res),
    onStatus: (s: string) => states.push(s),
  });
  return { queue, states, results, stored };
}

beforeEach(() => {
  vi.useFakeTimers();
  api.saveChanges.mockReset();
  api.deskDetail.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("save queue status", () => {
  it("reports saved when every request succeeded", async () => {
    api.saveChanges.mockResolvedValue({ ok: true, rows: [{ sku_id: "GB-001", retail_sale: 2 }] });
    const { queue, states } = setup();
    queue.set("GB-001", "retail_sale", 2, { kind: "typed" });
    await queue.flushAll();
    expect(last(states)).toBe("saved");
    expect(queue.hasUnsaved()).toBe(false);
  });

  it("reports error, not saved, when the server refuses (NEGATIVE_CLOSING)", async () => {
    api.saveChanges.mockRejectedValue(new HttpFail(409, "NEGATIVE_CLOSING", { available: 1 }));
    const { queue, states, results } = setup();
    queue.set("GB-001", "retail_sale", 9, { kind: "typed" });
    await queue.flushAll();
    expect(states).not.toContain("saved");
    expect(last(states)).toBe("error");
    expect(results[0]).toMatchObject({ ok: false, code: "NEGATIVE_CLOSING", available: 1 });
  });

  it("reports error on a server failure and starts a fresh burst clean", async () => {
    api.saveChanges.mockRejectedValueOnce(new HttpFail(500, "SERVER_ERROR"));
    const { queue, states } = setup();
    queue.set("GB-001", "retail_sale", 1, { kind: "typed" });
    await queue.flushAll();
    expect(last(states)).toBe("error");

    api.saveChanges.mockResolvedValue({ ok: true, rows: [{ sku_id: "GB-001", stock_in: 3 }] });
    queue.set("GB-001", "stock_in", 3, { kind: "typed" });
    await queue.flushAll();
    expect(last(states)).toBe("saved");
  });

  it("offline: status is offline (never saved), the edits stay countable", async () => {
    api.saveChanges.mockRejectedValue(new HttpFail(undefined));
    const { queue, states } = setup();
    queue.set("GB-001", "retail_sale", 4, { kind: "typed" });
    queue.set("GB-001", "stock_in", 2, { kind: "typed" });
    await queue.flushAll();
    expect(states).not.toContain("saved");
    expect(last(states)).toBe("offline");
    expect(queue.hasUnsaved()).toBe(true);
    expect(queue.unsavedCount()).toBe(2);
    queue.dispose();
  });

  it("a mixed burst (one ok, one refused) ends as error", async () => {
    api.saveChanges
      .mockResolvedValueOnce({ ok: true, rows: [{ sku_id: "GB-001", stock_in: 1 }] })
      .mockRejectedValueOnce(new HttpFail(409, "NEGATIVE_CLOSING", { available: 0 }));
    const { queue, states } = setup();
    queue.set("GB-001", "stock_in", 1, { kind: "typed" });
    queue.set("GB-001", "retail_sale", 50, { kind: "typed" });
    await queue.flushAll();
    expect(states).not.toContain("saved");
    expect(last(states)).toBe("error");
  });
});
