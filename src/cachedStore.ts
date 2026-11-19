// Fewer database round trips per request. A route asks for the same small
// lists many times (requireDesk, the branch statuses, the detail itself); the
// CachedStore reads each one once per request.
//
// On the Supabase store the lists that almost never change (SKUs, SKU types,
// SKU weights, branches, system config) are also kept in Worker memory for
// 30 s, shared by every request on the isolate. A write to one of those tables
// through any CachedStore clears it at once; another isolate can lag up to
// 30 s (accepted by the owner). Staff accounts, days, ledger and transfers are
// always read fresh by each request.
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

interface SharedEntry {
  at: number;
  value: Promise<unknown>;
}
// sharedKey -> "method" -> entry. The key names the database (data mode +
// URL), so test and production data never share an entry.
const sharedCache = new Map<string, Map<string, SharedEntry>>();

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

export function cachedStore(inner: Store, opts: CacheOptions = {}): Store {
  const now = opts.now ?? Date.now;
  // "method|args" -> the pending or settled read, so concurrent callers share it.
  const memo = new Map<string, Promise<unknown>>();
  const shared = opts.sharedKey === undefined ? undefined : sharedCache.get(opts.sharedKey) ?? sharedCache.set(opts.sharedKey, new Map()).get(opts.sharedKey)!;

  const forget = (tables: readonly MemoMethod[]) => {
    for (const key of [...memo.keys()]) if (tables.includes(key.split("|")[0] as MemoMethod)) memo.delete(key);
    if (shared) for (const t of tables) shared.delete(t);
  };

  // A rejected read is dropped from both layers, so the next call tries again.
  const readShared = (method: MemoMethod, read: () => Promise<unknown>): Promise<unknown> => {
    let entry = shared!.get(method);
    if (!entry || now() - entry.at >= SHARED_TTL_MS) {
      const fresh: SharedEntry = { at: now(), value: read() };
      fresh.value.catch(() => {
        if (shared!.get(method) === fresh) shared!.delete(method);
      });
      shared!.set(method, fresh);
      entry = fresh;
    }
    // Each request gets its own copy: a caller that changes what it got must
    // not change what the next request reads.
    return entry.value.then((v) => structuredClone(v));
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (isMemo(prop)) {
        return (...args: unknown[]) => {
          const key = `${prop}|${JSON.stringify(args)}`;
          const hit = memo.get(key);
          if (hit) return hit;
          const read = () => value.apply(target, args) as Promise<unknown>;
          const p = shared && SHARED.includes(prop) ? readShared(prop, read) : read();
          memo.set(key, p);
          p.catch(() => {
            if (memo.get(key) === p) memo.delete(key);
          });
          return p;
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
}
