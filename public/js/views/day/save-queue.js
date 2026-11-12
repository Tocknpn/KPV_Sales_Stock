// Saves day-screen edits as compare-and-set changes, one SKU per request.
//
//  - Stepper taps are buffered for STEPPER_BUFFER_MS and sent as one change.
//  - Typed values (and notes) are sent straight away.
//  - Every change carries `from` (the last value the server confirmed), so a
//    second tablet's edit is never silently overwritten:
//      ROW_CHANGED + stepper  -> re-based once: to = current + (to - from)
//      ROW_CHANGED + typed    -> the caller is asked "keep yours?"
//      NEGATIVE_CLOSING       -> the caller is told how many are available
import { api } from "../../api.js";

export const MAX_QTY = 99999;
export const STEPPER_BUFFER_MS = 600;
const TEXT_FIELDS = new Set(["destock_note", "counted_note"]);

export function clampQty(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_QTY, Math.max(0, v)) : 0;
}

/**
 * @param {object} opts
 * @param {string} opts.deskId
 * @param {string} opts.date
 * @param {(skuId: string) => object} opts.getStored  last server-confirmed row for a SKU
 * @param {(skuId: string, row: object) => void} opts.onStored  a server row arrived; show it
 * @param {(res: object) => void} opts.onResult  fallback handler for failures nobody else handled
 * @param {(state: "saving" | "saved") => void} [opts.onStatus]
 */
export function createSaveQueue({ deskId, date, getStored, onStored, onResult, onStatus }) {
  /** skuId -> { timer, fields: Map<field, {from, to, kind, cb}> } */
  const pending = new Map();
  /** skuId -> promise of the request in flight (requests per SKU stay in order) */
  const inflight = new Map();
  /** "skuId|field" -> number of requests carrying that field that have not finished */
  const flying = new Map();
  /** SKUs whose last request died without an answer: the server may or may not have applied it */
  const unsynced = new Set();
  let busy = 0;
  let offline = false;
  let disposed = false;
  const RETRY_MS = 5000;

  const begin = () => {
    busy++;
    onStatus?.("saving");
  };
  const end = () => {
    busy--;
    if (busy === 0 && pending.size === 0 && !offline) onStatus?.("saved");
  };
  const fly = (skuId, fields, d) =>
    fields.forEach((f) => {
      const k = `${skuId}|${f}`;
      const n = (flying.get(k) ?? 0) + d;
      if (n > 0) flying.set(k, n);
      else flying.delete(k);
    });

  // No HTTP status = the request never got an answer (offline, dropped).
  const isNetworkError = (err) => err.status === undefined || err.status === null;

  // Put unsent changes back in the queue (keeping anything newer) and retry later.
  function requeue(skuId, entries) {
    if (disposed) return;
    unsynced.add(skuId);
    offline = true;
    onStatus?.("offline");
    let entry = pending.get(skuId);
    if (!entry) {
      entry = { timer: null, fields: new Map() };
      pending.set(skuId, entry);
    }
    for (const [field, e] of entries) if (!entry.fields.has(field)) entry.fields.set(field, e);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => send(skuId), RETRY_MS);
  }

  // Reads the row from the server so the next change compares against the truth.
  async function resync(skuId) {
    const detail = await api.deskDetail(deskId, date);
    const row = detail.rows.find((r) => r.sku_id === skuId);
    if (row) onStored(skuId, row);
  }

  // `cb` is the caller's own handler for this field; returning true means it
  // showed the result itself, otherwise the shared fallback handles it.
  const report = (cb, res) => {
    if (cb?.(res) === true) return;
    if (!res.ok) onResult(res);
  };

  async function request(skuId, entries) {
    const changes = entries.map(([field, e]) => ({ sku_id: skuId, field, from: e.from, to: e.to }));
    return api.saveChanges(deskId, { date, changes });
  }

  async function attempt(skuId, entries, rebased) {
    try {
      const res = await request(skuId, entries);
      const row = res.rows?.find((r) => r.sku_id === skuId) ?? res.rows?.[0];
      if (row) onStored(skuId, row);
      entries.forEach(([, e]) => report(e.cb, { ok: true }));
    } catch (err) {
      if (isNetworkError(err)) {
        // Do not revert and do not guess: the server may have applied it.
        requeue(skuId, entries);
        return;
      }
      if (err.code === "ROW_CHANGED" && err.data?.row) {
        const cur = err.data.row;
        onStored(skuId, cur);
        const steppers = entries.filter(([field, e]) => e.kind === "step" && !TEXT_FIELDS.has(field));
        const typed = entries.filter(([field, e]) => e.kind !== "step" || TEXT_FIELDS.has(field));
        if (steppers.length && !rebased) {
          const rebasedEntries = steppers.map(([field, e]) => [
            field,
            { ...e, from: cur[field], to: clampQty(cur[field] + (e.to - e.from)) },
          ]);
          await attempt(skuId, rebasedEntries, true);
        } else {
          typed.push(...steppers);
        }
        for (const [field, e] of typed) {
          report(e.cb, {
            ok: false,
            code: "ROW_CHANGED",
            skuId,
            field,
            mine: e.to,
            theirs: cur[field],
            byId: cur.performed_by ?? null,
            // "Keep mine": send again against what the server holds now.
            keepMine: () =>
              attempt(skuId, [[field, { ...e, from: cur[field], kind: "typed" }]], true),
          });
        }
      } else if (err.code === "NEGATIVE_CLOSING") {
        onStored(skuId, getStored(skuId));
        entries.forEach(([field, e]) =>
          report(e.cb, { ok: false, code: "NEGATIVE_CLOSING", skuId, field, available: Number(err.data?.available ?? 0) })
        );
      } else {
        onStored(skuId, getStored(skuId));
        entries.forEach(([field, e]) => report(e.cb, { ok: false, code: err.code ?? "ERROR", skuId, field, message: err.message }));
      }
    }
  }

  function send(skuId) {
    const entry = pending.get(skuId);
    if (!entry) return inflight.get(skuId) ?? Promise.resolve();
    clearTimeout(entry.timer);
    pending.delete(skuId);
    const queued = [...entry.fields.entries()];
    begin();
    // `from` is read when the request actually goes out, so taps made while an
    // earlier request was in flight compare against what that request saved.
    fly(skuId, queued.map(([f]) => f), 1);
    const run = (inflight.get(skuId) ?? Promise.resolve()).then(async () => {
      if (unsynced.has(skuId)) {
        try {
          await resync(skuId);
          unsynced.delete(skuId);
          offline = unsynced.size > 0;
        } catch (e) {
          if (isNetworkError(e)) {
            requeue(skuId, queued);
            return;
          }
          // A real HTTP error (403, 5xx; a 401 already sent the app to login) will
          // not fix itself by retrying: give up on this SKU's unsent changes,
          // show what the server holds, and tell the user why.
          unsynced.delete(skuId);
          offline = unsynced.size > 0;
          onStored(skuId, getStored(skuId));
          queued.forEach(([field, q]) => report(q.cb, { ok: false, code: e.code ?? "ERROR", skuId, field, message: e.message }));
          return;
        }
      }
      const stored = getStored(skuId);
      const entries = queued
        .map(([field, e]) => [field, { ...e, from: stored[field] }])
        .filter(([field, e]) => e.to !== e.from);
      return entries.length ? attempt(skuId, entries, false) : undefined;
    });
    const tracked = run.finally(() => {
      fly(skuId, queued.map(([f]) => f), -1);
      if (inflight.get(skuId) === tracked) inflight.delete(skuId);
      end();
    });
    inflight.set(skuId, tracked);
    return tracked;
  }

  return {
    /**
     * Record a new value for one field. kind "step" = buffered, "typed" = sent now.
     * `from` is the last server-confirmed value, even across several taps.
     */
    set(skuId, field, to, { kind = "step", cb } = {}) {
      const stored = getStored(skuId);
      let entry = pending.get(skuId);
      if (!entry) {
        entry = { timer: null, fields: new Map() };
        pending.set(skuId, entry);
      }
      const existing = entry.fields.get(field);
      const from = existing ? existing.from : stored[field];
      const effectiveKind = TEXT_FIELDS.has(field) ? "typed" : existing?.kind === "typed" ? "typed" : kind;
      if (to === from) {
        // Tapped back to where the server already is: nothing to send.
        entry.fields.delete(field);
        if (entry.fields.size === 0) {
          clearTimeout(entry.timer);
          pending.delete(skuId);
          return;
        }
      } else {
        entry.fields.set(field, { from, to, kind: effectiveKind, cb: cb ?? existing?.cb });
      }
      clearTimeout(entry.timer);
      if (effectiveKind === "typed") {
        send(skuId);
      } else {
        entry.timer = setTimeout(() => send(skuId), STEPPER_BUFFER_MS);
      }
    },

    // True while a newer value for this field is queued, or a later request
    // carrying it is still on its way: a server answer must not overwrite it.
    isPending(skuId, field) {
      return (pending.get(skuId)?.fields.has(field) ?? false) || (flying.get(`${skuId}|${field}`) ?? 0) > 1;
    },

    /** True while anything is unsent, in flight, or waiting for the network. */
    hasUnsaved() {
      return pending.size > 0 || inflight.size > 0 || unsynced.size > 0;
    },

    /** Stops all timers; call when the screen goes away. Unsent changes are dropped. */
    dispose() {
      disposed = true;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      unsynced.clear();
      offline = false;
    },

    /** Sends everything buffered and waits for all requests to finish. */
    async flushAll() {
      for (const skuId of [...pending.keys()]) send(skuId);
      await Promise.all([...inflight.values()]);
    },
  };
}
