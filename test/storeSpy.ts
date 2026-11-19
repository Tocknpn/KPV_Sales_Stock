// Counts the calls made on a Store (one call = one PostgREST round trip on the
// real database) and the serial stage each call started in. With `batched`,
// calls are held back and released together, one batch per macrotask, like a
// network trip: calls started together (one Promise.all, or parallel chains at
// the same depth) share a stage; a call that waited on an earlier result lands
// in a later one. Deterministic, whatever the machine load.
import type { Store } from "../src/store";

export interface StoreSpy {
  store: Store;
  calls: { method: string; stage: number }[];
  stages(): number;
  count(method?: string): number;
}

export function spyStore(inner: Store, batched = false): StoreSpy {
  let stage = 0;
  let pending: (() => void)[] = [];
  const release = () =>
    new Promise<void>((resolve) => {
      pending.push(resolve);
      if (pending.length > 1) return;
      setTimeout(() => {
        const batch = pending;
        pending = [];
        stage++;
        for (const r of batch) r();
      }, 0);
    });
  const spy: StoreSpy = {
    calls: [],
    store: new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          spy.calls.push({ method: String(prop), stage });
          const result = await value.apply(target, args);
          if (batched) await release();
          return result;
        };
      },
    }),
    stages() {
      return new Set(spy.calls.map((c) => c.stage)).size;
    },
    count(method?: string) {
      return method ? spy.calls.filter((c) => c.method === method).length : spy.calls.length;
    },
  };
  return spy;
}
