// CachedStore: the rarely-changing lists are read once per request, and (on
// the Supabase store only) shared across requests for 30 s. Writes to those
// tables clear both layers.
import { beforeEach, describe, expect, it } from "vitest";
import { cachedStore, clearSharedCache, fresh, listHaving, SHARED_TTL_MS } from "../src/cachedStore";
import type { Store } from "../src/store";
import { getStore, resetDemoStore } from "../src/store";
import { DEMO_ADMIN_ID } from "../src/demoData";
import { TODAY } from "./helpers";
import { spyStore } from "./storeSpy";

const env = { DEMO_DATE: TODAY } as any;
const raw = () => getStore(env, { id: DEMO_ADMIN_ID });

beforeEach(() => {
  resetDemoStore();
  clearSharedCache();
});

describe("per-request memo", () => {
  it("reads each memoised list once, even when asked concurrently", async () => {
    const spy = spyStore(raw());
    const store = cachedStore(spy.store);
    const [a, b] = await Promise.all([store.skus(), store.skus()]);
    await store.skus();
    expect(a).toBe(b);
    for (const m of ["desks", "skuTypes", "skuWeights", "branches", "config", "staffAccounts", "goldPrice", "rules"] as const) {
      await (store as any)[m]();
      await (store as any)[m]();
      expect(spy.count(m), m).toBe(1);
    }
    expect(spy.count("skus")).toBe(1);
  });

  it("memoises branchSkus per filter", async () => {
    const spy = spyStore(raw());
    const store = cachedStore(spy.store);
    await store.branchSkus({ branchId: "B-MM" });
    await store.branchSkus({ branchId: "B-MM" });
    await store.branchSkus({ branchId: "B-VTC" });
    await store.branchSkus();
    expect(spy.count("branchSkus")).toBe(3);
  });

  it("never memoises days, ledger or transfers", async () => {
    const spy = spyStore(raw());
    const store = cachedStore(spy.store);
    await store.deskDays({ date: TODAY });
    await store.deskDays({ date: TODAY });
    await store.ledger({ date: TODAY });
    await store.ledger({ date: TODAY });
    await store.transfers({});
    await store.transfers({});
    expect(spy.count()).toBe(6);
  });

  it("a write to a memoised table makes the next read fresh", async () => {
    const spy = spyStore(raw());
    const store = cachedStore(spy.store);
    const before = await store.skus();
    const sku = before[0];
    await store.updateSku(sku.sku_id, { name_en: "Renamed" });
    const after = await store.skus();
    expect(spy.count("skus")).toBe(2);
    expect(after.find((s) => s.sku_id === sku.sku_id)!.name_en).toBe("Renamed");

    await store.config();
    await store.updateConfig({ velocity_window_days: 21 });
    expect((await store.config()).velocity_window_days).toBe(21);
    expect(spy.count("config")).toBe(2);

    await store.staffAccounts();
    await store.updateStaffAccount(DEMO_ADMIN_ID, { display_name: "Boss" });
    await store.staffAccounts();
    expect(spy.count("staffAccounts")).toBe(2);

    await store.rules();
    await store.deleteRules([]);
    await store.rules();
    expect(spy.count("rules")).toBe(2);
  });

  it("other writes leave the memo alone", async () => {
    const spy = spyStore(raw());
    const store = cachedStore(spy.store);
    await store.skus();
    await store.audit({ actor_id: DEMO_ADMIN_ID, actor_name: "x", action: "test", target: "t", detail: null, branch_id: null, desk_id: null });
    await store.skus();
    expect(spy.count("skus")).toBe(1);
  });

  it("a failed read is not remembered", async () => {
    let fail = true;
    const inner = raw();
    const flaky = new Proxy(inner, {
      get(t, p, r) {
        if (p === "skus") return async () => { if (fail) throw new Error("down"); return inner.skus(); };
        return Reflect.get(t, p, r);
      },
    });
    const store = cachedStore(flaky);
    await expect(store.skus()).rejects.toThrow("down");
    fail = false;
    expect((await store.skus()).length).toBeGreaterThan(0);
  });

  it("staffAccount(id) reads one account, always fresh", async () => {
    const spy = spyStore(raw());
    const store = cachedStore(spy.store);
    expect((await store.staffAccount(DEMO_ADMIN_ID))?.id).toBe(DEMO_ADMIN_ID);
    await store.staffAccount(DEMO_ADMIN_ID);
    expect(spy.count("staffAccount")).toBe(2);
    expect(await store.staffAccount("no-such-id")).toBeNull();
  });
});

describe("30 s shared cache (Supabase only)", () => {
  it("without a shared key, every request reads again", async () => {
    const spy = spyStore(raw());
    await cachedStore(spy.store).skus();
    await cachedStore(spy.store).skus();
    expect(spy.count("skus")).toBe(2);
  });

  it("with a shared key, the lists are shared across requests for 30 s", async () => {
    let now = 1_000_000;
    const spy = spyStore(raw());
    const req = () => cachedStore(spy.store, { sharedKey: "test|db", now: () => now });
    for (const m of ["skus", "skuTypes", "skuWeights", "branches", "config"] as const) {
      await (req() as any)[m]();
      await (req() as any)[m]();
      expect(spy.count(m), m).toBe(1);
    }
    // Staff, desks, gold price and rules stay per request.
    for (const m of ["staffAccounts", "desks", "goldPrice", "rules"] as const) {
      await (req() as any)[m]();
      await (req() as any)[m]();
      expect(spy.count(m), m).toBe(2);
    }
    now += SHARED_TTL_MS - 1;
    await req().skus();
    expect(spy.count("skus")).toBe(1);
    now += 2;
    await req().skus();
    expect(spy.count("skus")).toBe(2);
  });

  it("each request gets its own copy (a caller's change does not leak)", async () => {
    const spy = spyStore(raw());
    const a = await cachedStore(spy.store, { sharedKey: "k" }).skus();
    a[0].name_en = "Mutated";
    const b = await cachedStore(spy.store, { sharedKey: "k" }).skus();
    expect(b[0].name_en).not.toBe("Mutated");
  });

  it("a write on any request clears the shared cache for that table", async () => {
    const spy = spyStore(raw());
    const req = () => cachedStore(spy.store, { sharedKey: "k" });
    await req().skus();
    await req().skuTypes();
    await req().config();
    const sku = (await req().skus())[0];
    await req().updateSku(sku.sku_id, { name_en: "Edited" });
    expect((await req().skus()).find((s) => s.sku_id === sku.sku_id)!.name_en).toBe("Edited");
    expect(spy.count("skus")).toBe(2);
    // Other tables are kept.
    await req().skuTypes();
    expect(spy.count("skuTypes")).toBe(1);
    await req().updateConfig({ velocity_window_days: 14 });
    expect((await req().config()).velocity_window_days).toBe(14);
    expect(spy.count("config")).toBe(2);
  });

  it("keys do not share (test and production data never mix)", async () => {
    const spy = spyStore(raw());
    await cachedStore(spy.store, { sharedKey: "test|a" }).skus();
    await cachedStore(spy.store, { sharedKey: "production|b" }).skus();
    expect(spy.count("skus")).toBe(2);
  });
});

// A store whose skus() waits until the test lets it go.
function gated(inner: Store) {
  const waiting: (() => void)[] = [];
  let calls = 0;
  const store = new Proxy(inner, {
    get(t, p, r) {
      if (p === "skus") {
        return async () => {
          calls++;
          const list = await inner.skus();
          const copy = structuredClone(list);
          await new Promise<void>((go) => waiting.push(go));
          return copy;
        };
      }
      return Reflect.get(t, p, r);
    },
  });
  return { store, calls: () => calls, release: () => waiting.splice(0).forEach((go) => go()) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("shared cache holds only settled values", () => {
  it("a request never awaits another request's pending read", async () => {
    const g = gated(raw());
    const req = () => cachedStore(g.store, { sharedKey: "k" });
    const a = req().skus();
    const b = req().skus();
    await tick();
    // Each request made its own read.
    expect(g.calls()).toBe(2);
    g.release();
    await Promise.all([a, b]);
    // Settled: the next request is served from memory.
    await req().skus();
    expect(g.calls()).toBe(2);
  });

  it("a read that started before a write does not store its result after it", async () => {
    const g = gated(raw());
    const req = () => cachedStore(g.store, { sharedKey: "k" });
    const slow = req().skus();
    await tick();
    const sku = (await raw().skus())[0];
    await req().updateSku(sku.sku_id, { name_en: "After" });
    g.release();
    expect((await slow).find((s) => s.sku_id === sku.sku_id)!.name_en).not.toBe("After");
    const next = req().skus();
    await tick();
    expect(g.calls()).toBe(2);
    g.release();
    expect((await next).find((s) => s.sku_id === sku.sku_id)!.name_en).toBe("After");
  });

  it("the within-request memo still shares its own pending read", async () => {
    const g = gated(raw());
    const store = cachedStore(g.store, { sharedKey: "k" });
    const a = store.skus();
    const b = store.skus();
    await tick();
    expect(g.calls()).toBe(1);
    g.release();
    expect(await a).toBe(await b);
  });
});

describe("fresh reads for id checks", () => {
  it("an id missing from the cached list but in the database is found", async () => {
    const spy = spyStore(raw());
    const req = () => cachedStore(spy.store, { sharedKey: "k" });
    await req().skus();
    // Made on another isolate: this one's 30 s cache does not know it.
    const [base] = await raw().skus();
    await raw().createSkus([{ ...base, sku_id: "SKU-NEW-ELSEWHERE" }]);
    const r = req();
    expect((await r.skus()).some((s) => s.sku_id === "SKU-NEW-ELSEWHERE")).toBe(false);
    const list = await listHaving(r, "skus", (l) => l.some((s) => s.sku_id === "SKU-NEW-ELSEWHERE"));
    expect(list.some((s) => s.sku_id === "SKU-NEW-ELSEWHERE")).toBe(true);
    // The fresh read refreshed both layers.
    expect((await r.skus()).some((s) => s.sku_id === "SKU-NEW-ELSEWHERE")).toBe(true);
    expect((await req().skus()).some((s) => s.sku_id === "SKU-NEW-ELSEWHERE")).toBe(true);
    expect(spy.count("skus")).toBe(2);
  });

  it("a hit on the cached list reads nothing more; a real miss reads once", async () => {
    const spy = spyStore(raw());
    const r = cachedStore(spy.store, { sharedKey: "k" });
    const [first] = await r.skus();
    await listHaving(r, "skus", (l) => l.some((s) => s.sku_id === first.sku_id));
    expect(spy.count("skus")).toBe(1);
    const list = await listHaving(r, "skus", (l) => l.some((s) => s.sku_id === "NO-SUCH"));
    expect(list.some((s) => s.sku_id === "NO-SUCH")).toBe(false);
    expect(spy.count("skus")).toBe(2);
  });

  it("fresh() of a store without a cache is the store itself", () => {
    const s = raw();
    expect(fresh(s)).toBe(s);
  });
});
