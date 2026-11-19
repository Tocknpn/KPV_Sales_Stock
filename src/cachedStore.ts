// Fewer database round trips per request. A route asks for the same small
// lists many times (requireDesk, the branch statuses, the detail itself); the
// CachedStore reads each one once per request.
//
// On the Supabase store the lists that almost never change (SKUs, SKU types,
// SKU weights, branches, system config) are also kept in Worker memory for
// 30 s, shared by every request on the isolate. A write to one of those tables
// through any CachedStore clears it at once; another isolate can lag up to
// 30 s (accepted by the owner). A route that checks an id against one of those
// lists uses listHaving(), which reads fresh once before refusing, so a SKU
// just made on another isolate is never refused. Staff accounts, days, ledger
// and transfers are always read fresh by each request.
import type { Store } from "./store";

export const SHARED_TTL_MS = 30_000;

// Read once per request. Values are the memo key's table.
const MEMO = ["desks", "skus", "skuTypes", "skuWeights", "branches", "config", "staffAccounts", "goldPrice", "rules", "branchSkus"] as const;
type MemoMethod = (typeof MEMO)[number];
// Also shared across requests for 30 s (Supabase only).
const SHARED: readonly MemoMethod[] = ["skus", "skuTypes", "skuWeights", "branches", "config"];

// The writes that change a memoised list, and which lists they change.
const INVALIDATES: Partial<Record<keyof Store, readonly MemoMethod[]>> = {
  createDesk: ["desks"],
  createStaffAccount: ["staffAccounts"],
  updateStaffAccount: ["staffAccounts"],
  createSkus: ["skus", "branchSkus"],
  updateSku: ["skus", "branchSkus"],
  createSkuType: ["skuTypes"],
  updateSkuType: ["skuTypes"],
  createSkuWeight: ["skuWeights"],
  updateSkuWeight: ["skuWeights"],
  updateConfig: ["config", "goldPrice"],
  upsertRule: ["rules"],
  deleteRules: ["rules"],
  setCarried: ["branchSkus"],
};

// Only settled values are shared: a request never awaits another request's
// pending read (Workers may cancel or hang a subrequest across requests).
interface SharedEntry {
  at: number;
  value: unknown;
}
interface SharedSlot {
  entries: Map<string, SharedEntry>;
  // Bumped by every write to the table: a read that started before the write
  // must not store what it got afterwards.
  gen: Map<string, number>;
}
// sharedKey -> slot. The key names the database (data mode + URL), so test
// and production data never share an entry.
const sharedCache = new Map<string, SharedSlot>();

// Tests only.
export function clearSharedCache() {
  sharedCache.clear();
}

export interface CacheOptions {
  // Enables the 30 s cross-request layer (the Supabase store only).
  sharedKey?: string;
  now?: () => number;
}

const isMemo = (prop: string): prop is MemoMethod => (MEMO as readonly string[]).includes(prop);

// CachedStore -> the same store with its memoised lists read fresh.
const freshViews = new WeakMap<Store, Store>();

// The store with every memoised list read from the database now (the result
// refreshes both cache layers). Writes behave as on the store itself. A store
// without a cache is returned as is.
export function fresh(store: Store): Store {
  return freshViews.get(store) ?? store;
}

type Lookup = "skus" | "skuTypes" | "skuWeights" | "branches";
type ListOf<M extends Lookup> = Awaited<ReturnType<Store[M]>>;

// A cached list that passes `ok`, re-read fresh once when the cached copy
// fails it: an id made on another isolate within the last 30 s is found.
export async function listHaving<M extends Lookup>(store: Store, method: M, ok: (list: ListOf<M>) => boolean): Promise<ListOf<M>> {
  const read = (s: Store) => (s as unknown as Record<M, () => Promise<ListOf<M>>>)[method]();
  const list = await read(store);
  const view = freshViews.get(store);
  if (ok(list) || !view) return list;
  return read(view);
}

export function cachedStore(inner: Store, opts: CacheOptions = {}): Store {
  const now = opts.now ?? Date.now;
  // "method|args" -> this request's pending or settled read, so its own
  // concurrent callers share it.
  const memo = new Map<string, Promise<unknown>>();
  let shared: SharedSlot | undefined;
  if (opts.sharedKey !== undefined) {
    shared = sharedCache.get(opts.sharedKey);
    if (!shared) sharedCache.set(opts.sharedKey, (shared = { entries: new Map(), gen: new Map() }));
  }
  const isShared = (m: MemoMethod) => !!shared && SHARED.includes(m);

  const forget = (tables: readonly MemoMethod[]) => {
    for (const key of [...memo.keys()]) if (tables.includes(key.split("|")[0] as MemoMethod)) memo.delete(key);
    if (shared) {
      for (const t of tables) {
        shared.entries.delete(t);
        shared.gen.set(t, (shared.gen.get(t) ?? 0) + 1);
      }
    }
  };

  // This request's own read; its settled value is shared unless a write to
  // the table happened meanwhile. Each request gets its own copy: a caller
  // that changes what it got must not change what the next request reads.
  const readAndShare = async (method: MemoMethod, read: () => Promise<unknown>): Promise<unknown> => {
    const slot = shared!;
    const gen = slot.gen.get(method) ?? 0;
    const at = now();
    const value = await read();
    if ((slot.gen.get(method) ?? 0) === gen) slot.entries.set(method, { at, value: structuredClone(value) });
    return value;
  };

  const readShared = (method: MemoMethod, read: () => Promise<unknown>): Promise<unknown> => {
    const entry = shared!.entries.get(method);
    if (entry && now() - entry.at < SHARED_TTL_MS) return Promise.resolve(structuredClone(entry.value));
    return readAndShare(method, read);
  };

  const remember = (key: string, p: Promise<unknown>) => {
    memo.set(key, p);
    // A rejected read is dropped, so the next call tries again.
    p.catch(() => {
      if (memo.get(key) === p) memo.delete(key);
    });
    return p;
  };

  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (isMemo(prop)) {
        return (...args: unknown[]) => {
          const key = `${prop}|${JSON.stringify(args)}`;
          const hit = memo.get(key);
          if (hit) return hit;
          const read = () => value.apply(target, args) as Promise<unknown>;
          return remember(key, isShared(prop) ? readShared(prop, read) : read());
        };
      }
      const tables = INVALIDATES[prop as keyof Store];
      if (!tables) return value.bind(target);
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } finally {
          // Cleared even when the write failed: it may have landed anyway.
          forget(tables);
        }
      };
    },
  });

  const freshView = new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && isMemo(prop)) {
        const value = Reflect.get(target, prop, receiver) as (...a: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) => {
          const read = () => value.apply(target, args);
          return remember(`${prop}|${JSON.stringify(args)}`, isShared(prop) ? readAndShare(prop, read) : read());
        };
      }
      return Reflect.get(proxy, prop);
    },
  });
  freshViews.set(proxy, freshView);
  return proxy;
}
