// Row-level audit rules, shared by the DemoStore so its audit rows match what
// the Postgres trigger audit_row_change() writes (supabase/migrations/
// 20261112_02_audit.sql). Keep the two in step.
import type { AuditEntry } from "./types";
import type { Actor } from "./actor";

type Row = Record<string, unknown>;
export type AuditOp = "INSERT" | "UPDATE" | "DELETE";

// Never logged: bookkeeping and generated columns.
const IGNORED = ["updated_at", "performed_by", "created_at", "closing_qty"];
const IGNORED_BY_TABLE: Record<string, string[]> = { staff_accounts: ["failed_attempts", "token_version"] };

const PRIMARY_KEYS: Record<string, string[]> = {
  desks: ["desk_id"],
  staff_accounts: ["id"],
  master_sku: ["sku_id"],
  sku_type: ["type_id"],
  sku_weight: ["weight_id"],
  desk_days: ["desk_id", "ledger_date"],
  daily_stock_ledger: ["id"],
  transfers: ["id"],
  documents: ["id"],
  document_rows: ["id"],
  system_config: ["id"],
};

const CONTEXT_KEYS = [
  "ledger_date", "desk_id", "sku_id", "branch_id", "from_desk_id", "to_desk_id",
  "from_branch_id", "to_branch_id", "staff_id", "document_id", "kind", "qty", "status",
];

const ignoredFor = (table: string) => new Set([...IGNORED, ...(IGNORED_BY_TABLE[table] ?? [])]);

function redact(table: string, values: Row): Row {
  return table === "staff_accounts" && "pin_hash" in values ? { ...values, pin_hash: "changed" } : values;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The changed columns of one write. null means there is nothing to log (an
// UPDATE that changed only ignored columns).
export function auditDiff(
  table: string,
  op: AuditOp,
  oldRow: object | null,
  newRow: object | null
): { old_values: Row | null; new_values: Row | null } | null {
  const ign = ignoredFor(table);
  const o = oldRow as Row | null;
  const n = newRow as Row | null;
  if (op === "UPDATE") {
    const ov: Row = {};
    const nv: Row = {};
    for (const k of Object.keys(n ?? {})) {
      if (ign.has(k) || same(o?.[k], n![k])) continue;
      ov[k] = o?.[k] ?? null;
      nv[k] = n![k];
    }
    if (Object.keys(nv).length === 0) return null;
    return { old_values: redact(table, ov), new_values: redact(table, nv) };
  }
  const strip = (r: Row | null) => (r ? redact(table, Object.fromEntries(Object.entries(r).filter(([k]) => !ign.has(k)))) : null);
  return { old_values: op === "INSERT" ? null : strip(o), new_values: op === "DELETE" ? null : strip(n) };
}

export interface AuditActor {
  actor?: Actor;
  // Display name and role of the staff member, when the actor is one.
  name?: string | null;
  role?: string | null;
}

// The complete audit_log row for one write, or null when nothing changed.
export function auditEntry(
  table: string,
  op: AuditOp,
  oldRow: object | null,
  newRow: object | null,
  who: AuditActor
): Omit<AuditEntry, "id" | "created_at"> | null {
  const diff = auditDiff(table, op, oldRow, newRow);
  if (!diff) return null;
  const src = (newRow ?? oldRow) as Row;
  const rowKey = Object.fromEntries((PRIMARY_KEYS[table] ?? []).map((k) => [k, src[k] ?? null]));
  const context = Object.fromEntries(CONTEXT_KEYS.filter((k) => src[k] !== undefined && src[k] !== null).map((k) => [k, src[k]]));
  const source = !who.actor ? "sql:service_role" : "id" in who.actor ? "api" : `system:${who.actor.system}`;
  const str = (k: string) => (src[k] == null ? null : String(src[k]));
  return {
    actor_id: who.actor && "id" in who.actor ? who.actor.id : null,
    actor_name: who.name ?? source,
    action: `${op.toLowerCase()}:${table}`,
    target: JSON.stringify(rowKey),
    detail: null,
    table_name: table,
    op,
    row_key: rowKey,
    desk_id: str("desk_id") ?? str("from_desk_id"),
    branch_id: str("branch_id") ?? str("from_branch_id"),
    to_desk_id: str("to_desk_id"),
    to_branch_id: str("to_branch_id"),
    context,
    actor_role: who.role ?? null,
    source,
    old_values: diff.old_values,
    new_values: diff.new_values,
    is_seed: src.is_seed === true,
  };
}
