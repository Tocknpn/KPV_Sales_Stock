// Data-access layer. Two interchangeable implementations behind one Store
// interface: SupabaseStore (real Postgres via PostgREST) and DemoStore
// (in-memory). Business rules live in the routes and src/logic.ts; a Store
// only offers small, atomic primitives so both implementations stay equal.
import type {
  Branch,
  Desk,
  MasterSku,
  SkuType,
  SkuWeight,
  DeskDay,
  DeskStatus,
  LedgerRow,
  LedgerEntryPatch,
  DocumentRecord,
  DocumentRow,
  DocumentKind,
  ProposalStatus,
  SystemConfig,
  StaffAccount,
  Transfer,
  TransferStatus,
  AuditEntry,
  ClosedDay,
  DeskAssignment,
  ReplenishmentRule,
  RuleScope,
  Env,
} from "./types";
import { computeVelocity, type VelocityRow } from "./replenishment";
import { buildDemoData, type DemoData } from "./demoData";
import { businessDate, isLive, laosDate } from "./time";
import { computeClosing } from "./logic";
import { actorHeaders, type Actor } from "./actor";
import { auditEntry, type AuditOp } from "./audit";

export type StoreErrorCode = "DAY_LOCKED" | "CONFLICT" | "INVALID" | "UNAVAILABLE" | "NEGATIVE" | "AUDIT_ACTOR_MISSING" | "DENIED" | "IMMUTABLE";

// Errors the routes can turn into a meaningful HTTP status.
export class StoreError extends Error {
  // `available` accompanies NEGATIVE: the row's closing before the refused change.
  constructor(public code: StoreErrorCode, message: string, public available?: number) {
    super(message);
  }
}

export type LedgerChangeField = "stock_in" | "retail_sale" | "wholesale" | "destock" | "destock_note" | "counted_qty" | "counted_note";
export const LEDGER_CHANGE_FIELDS: readonly LedgerChangeField[] = ["stock_in", "retail_sale", "wholesale", "destock", "destock_note", "counted_qty", "counted_note"];
export const TEXT_CHANGE_FIELDS: readonly LedgerChangeField[] = ["destock_note", "counted_note"];
// Compare-and-set: when `from` is present the change applies only if the stored
// value is still `from` (or already `to`, which makes a retry harmless).
export type LedgerChange = { field: LedgerChangeField; from?: number | string | null; to: number | string | null };
export type ApplyResult =
  | { ok: true; row: LedgerRow }
  | { ok: false; code: "ROW_CHANGED" | "ROW_NOT_FOUND"; row?: LedgerRow };

export interface LedgerFilter {
  date?: string;
  from?: string;
  to?: string;
  branchId?: string;
  deskId?: string;
}

export interface DeskDayFilter extends LedgerFilter {
  before?: string; // strictly earlier than
  after?: string; // strictly later than
  status?: DeskStatus;
  notStatus?: DeskStatus;
  order?: "asc" | "desc";
  limit?: number;
}

export interface DocumentFilter {
  branchId?: string;
  deskId?: string;
  date?: string;
  kind?: DocumentKind;
  status?: ProposalStatus;
  page?: number;
  pageSize?: number;
}

export interface TransferFilter {
  branchId?: string; // either side
  fromDeskId?: string;
  toDeskId?: string;
  status?: TransferStatus;
  sentDate?: string;
  ticketId?: string;
}

export interface LedgerKey {
  ledger_date: string;
  desk_id: string;
  sku_id: string;
}

export type NewLedgerRow = LedgerKey & { branch_id: string; opening_qty: number; performed_by: string | null };
export type LedgerRowPatch = LedgerKey & { branch_id: string } & LedgerEntryPatch;
export type NewDocument = Omit<DocumentRecord, "id" | "doc_no" | "created_at" | "rows">;
export type NewDocumentRow = Omit<DocumentRow, "id" | "document_id">;
export type NewTransfer = Omit<Transfer, "id" | "status" | "received_date" | "received_by" | "created_at" | "updated_at" | "client_ref" | "reverses_id" | "ticket_id" | "note" | "is_seed"> &
  Partial<Pick<Transfer, "client_ref" | "reverses_id" | "ticket_id" | "note">>;

export interface MoveInput {
  date: string;
  fromDeskId: string;
  toDeskId: string;
  lines: { skuId: string; qty: number }[];
  clientRef: string;
  note?: string;
}
// A refusal writes nothing. Trigger errors (DAY_LOCKED, NEGATIVE) are thrown as StoreError instead.
export type MoveResult =
  | { ok: true; ticketId: string; moves: Transfer[]; replayed?: boolean }
  | { ok: false; code: string; skuId?: string; available?: number };
export type NewStaffAccount = Pick<StaffAccount, "branch_id" | "display_name" | "pin_hash" | "role">;
export type NewSku = Omit<MasterSku, "active"> & { active?: boolean };

export interface ClosedDayFilter {
  branchId?: string;
  from?: string;
  to?: string;
}

export interface RuleTarget {
  scope: RuleScope;
  scope_key: string;
  branch_id: string | null;
}
export interface RuleInput extends RuleTarget {
  avg_daily_sell: number | null;
  lead_time_days: number | null;
}

export interface Store {
  branches(): Promise<Branch[]>;
  desks(): Promise<Desk[]>;
  createDesk(input: { branch_id: string; display_name: string }): Promise<Desk>;

  staffAccounts(): Promise<StaffAccount[]>;
  createStaffAccount(account: NewStaffAccount): Promise<StaffAccount>;
  updateStaffAccount(id: string, patch: Partial<Omit<StaffAccount, "id" | "created_at">>): Promise<StaffAccount | null>;

  skus(): Promise<MasterSku[]>;
  // All-or-nothing: either every SKU is created or none is.
  createSkus(skus: NewSku[]): Promise<MasterSku[]>;
  updateSku(skuId: string, patch: Partial<MasterSku>): Promise<MasterSku | null>;
  skuTypes(): Promise<SkuType[]>;
  createSkuType(type: Partial<SkuType> & Pick<SkuType, "type_id" | "name_en">): Promise<SkuType>;
  updateSkuType(typeId: string, patch: Partial<SkuType>): Promise<SkuType | null>;
  skuWeights(): Promise<SkuWeight[]>;
  createSkuWeight(weight: Partial<SkuWeight> & Pick<SkuWeight, "weight_id" | "name_en" | "gram_value">): Promise<SkuWeight>;
  updateSkuWeight(weightId: string, patch: Partial<SkuWeight>): Promise<SkuWeight | null>;

  deskDays(filter: DeskDayFilter): Promise<DeskDay[]>;
  // Each desk's most recent day (any status).
  latestDeskDays(filter: { branchId?: string; deskId?: string }): Promise<DeskDay[]>;
  // Returns null when that desk/date already exists (someone else checked in).
  insertDeskDay(day: Pick<DeskDay, "desk_id" | "ledger_date" | "branch_id" | "checked_in_by">): Promise<DeskDay | null>;
  // Conditional update: applies only while the day is still `expectedStatus`.
  // Returns null when it is not (another tablet got there first).
  updateDeskDay(deskId: string, date: string, patch: Partial<DeskDay>, expectedStatus?: DeskStatus): Promise<DeskDay | null>;

  ledger(filter: LedgerFilter): Promise<LedgerRow[]>;
  // Ledger rows of each desk's most recent day.
  ledgerLatest(filter: { branchId?: string; deskId?: string }): Promise<LedgerRow[]>;
  // Existing rows are left untouched.
  // `overwriteOpening` (carry-forward only) sets opening_qty on rows that already exist, so a
  // row created meanwhile (e.g. by a move) still gets its carried opening.
  insertLedgerRows(rows: NewLedgerRow[], opts?: { overwriteOpening?: boolean }): Promise<LedgerRow[]>;
  // Changes only the fields present on each patch. Throws DAY_LOCKED when the
  // desk day is Done.
  patchLedgerRows(patches: LedgerRowPatch[]): Promise<LedgerRow[]>;
  // Atomic increment of one movement column. Returns the new value, or null
  // when the row does not exist.
  ledgerAdd(key: LedgerKey, field: "transfer_in" | "transfer_out" | "move", delta: number, actor: string | null): Promise<number | null>;
  // Atomic compare-and-set of several fields of one row (the ledger_apply RPC).
  applyLedgerChanges(key: LedgerKey, changes: LedgerChange[]): Promise<ApplyResult>;

  documents(filter: DocumentFilter): Promise<{ rows: DocumentRecord[]; total: number }>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  createDocument(doc: NewDocument, rows: NewDocumentRow[]): Promise<DocumentRecord>;
  updateDocument(id: string, patch: Partial<DocumentRecord>, expectedStatus?: ProposalStatus): Promise<DocumentRecord | null>;
  deleteDocument(id: string): Promise<boolean>;

  config(): Promise<SystemConfig>;
  updateConfig(patch: Partial<SystemConfig>): Promise<SystemConfig>;

  transfers(filter: TransferFilter): Promise<Transfer[]>;
  getTransfer(id: string): Promise<Transfer | null>;
  createTransfer(transfer: NewTransfer): Promise<Transfer>;
  updateTransfer(id: string, patch: Partial<Transfer>, expectedStatus: TransferStatus): Promise<Transfer | null>;
  // Same-branch move: both cases change in one atomic step (the move_stock RPC).
  moveStock(input: MoveInput): Promise<MoveResult>;
  // Reverses a whole ticket on its original date (the undo_move RPC).
  undoMove(ticketId: string, clientRef: string): Promise<MoveResult>;

  // Branch closed days (holidays). addClosedDays skips dates that already exist
  // and returns only the rows it added.
  closedDays(filter: ClosedDayFilter): Promise<ClosedDay[]>;
  addClosedDays(rows: ClosedDay[]): Promise<ClosedDay[]>;
  removeClosedDay(branchId: string, date: string): Promise<boolean>;

  // Replenishment rules. upsertRule writes one (scope, key, branch) rule; a null value
  // inherits, and a rule left with both values null is deleted. deleteRules returns how
  // many rows it removed. Company-wide rules need an admin, branch rules an admin or that
  // branch's manager (DENIED otherwise).
  rules(): Promise<ReplenishmentRule[]>;
  upsertRule(input: RuleInput): Promise<ReplenishmentRule | null>;
  deleteRules(targets: RuleTarget[]): Promise<number>;
  // Automatic sales velocity per SKU for one branch (the branch_velocity RPC).
  branchVelocity(branchId: string, to: string, days: number): Promise<VelocityRow[]>;

  // Case assignment. activeAssignments = the current holder of each case.
  // assignDesk ends the current holder and starts the new one atomically (no-op
  // when already the holder); releaseDesk ends without a successor.
  activeAssignments(filter: { branchId?: string }): Promise<DeskAssignment[]>;
  assignDesk(deskId: string, staffId: string, note?: string): Promise<DeskAssignment>;
  releaseDesk(deskId: string): Promise<void>;

  audit(entry: Omit<AuditEntry, "id" | "created_at">): Promise<void>;
  auditLog(limit: number): Promise<AuditEntry[]>;
}

function nextDeskId(branchId: string, existingIds: string[]) {
  const branchCode = branchId.replace(/^B-/, "");
  let n = existingIds.length + 1;
  let id = `${branchCode}-D${String(n).padStart(2, "0")}`;
  while (existingIds.includes(id)) id = `${branchCode}-D${String(++n).padStart(2, "0")}`;
  return id;
}

function docNo(branchId: string, year: string, seq: number) {
  return `DOC-${branchId.replace(/^B-/, "")}-${year}-${String(seq).padStart(4, "0")}`;
}

const SKU_DEFAULTS = {
  name_lo: null,
  type_id: null,
  weight_id: null,
  purity: null,
  std_gram_weight: null,
  baht_weight: 0,
  unit_cost_lak: 0,
  unit_price_lak: 0,
  reorder_level: 5,
  avg_daily_sales: null,
  order_lead_time_days: null,
  active: true,
  icon: "ring",
  group_name: null,
};

// ============================================================================
// Demo (in-memory) store
// ============================================================================
export class DemoStore implements Store {
  private idSeq = 0;
  constructor(public db: DemoData, private actor?: Actor) {}

  // A thin view over the same data that attributes its writes to `actor`.
  withActor(actor: Actor | undefined): DemoStore {
    const view = new DemoStore(this.db, actor);
    view.idSeq = this.idSeq;
    return view;
  }

  // Every mutator calls this first (like the trigger refusing an anonymous
  // service-role write) so nothing changes when the actor is missing.
  private guard() {
    if (!this.actor) throw new StoreError("AUDIT_ACTOR_MISSING", "A write needs an acting user or system tag");
  }

  // The DemoStore equivalent of the audit_row_change() trigger.
  private log(table: string, op: AuditOp, oldRow: object | null, newRow: object | null) {
    const strip = (r: object | null) => {
      if (!r || table !== "documents") return r;
      const { rows: _rows, ...rest } = r as Record<string, unknown>;
      return rest;
    };
    const actorId = this.actor && "id" in this.actor ? this.actor.id : null;
    const account = actorId ? this.db.staffAccounts.find((a) => a.id === actorId) : undefined;
    const entry = auditEntry(table, op, strip(oldRow), strip(newRow), { actor: this.actor, name: account?.display_name, role: account?.role });
    if (entry) this.db.audit.unshift({ id: crypto.randomUUID(), created_at: this.now(), ...entry });
  }

  private newId(prefix: string) {
    return `${prefix}-${++this.idSeq}-${Math.random().toString(36).slice(2, 8)}`;
  }
  private now() {
    return new Date().toISOString();
  }
  private dayStatus(deskId: string, date: string) {
    return this.db.deskDays.find((d) => d.desk_id === deskId && d.ledger_date === date)?.status ?? null;
  }
  private assertUnlocked(deskId: string, date: string) {
    const status = this.dayStatus(deskId, date);
    if (status === null) throw new StoreError("INVALID", `No desk day for ${deskId} ${date}`);
    if (status === "done") throw new StoreError("DAY_LOCKED", `${deskId} ${date} is Done`);
  }

  async branches() {
    return this.db.branches;
  }
  async desks() {
    return this.db.desks;
  }
  async createDesk(input: { branch_id: string; display_name: string }) {
    this.guard();
    const sameBranch = this.db.desks.filter((d) => d.branch_id === input.branch_id);
    const desk: Desk = {
      desk_id: nextDeskId(input.branch_id, sameBranch.map((d) => d.desk_id)),
      branch_id: input.branch_id,
      display_name: input.display_name,
      active: true,
      sort_order: sameBranch.length + 1,
      created_at: this.now(),
    };
    this.db.desks.push(desk);
    this.log("desks", "INSERT", null, desk);
    return desk;
  }

  async staffAccounts() {
    return this.db.staffAccounts;
  }
  async createStaffAccount(account: NewStaffAccount) {
    this.guard();
    const row: StaffAccount = {
      id: crypto.randomUUID(),
      active: true,
      token_version: 0,
      failed_attempts: 0,
      locked_until: null,
      created_at: this.now(),
      ...account,
    };
    this.db.staffAccounts.push(row);
    this.log("staff_accounts", "INSERT", null, row);
    return row;
  }
  async updateStaffAccount(id: string, patch: Partial<StaffAccount>) {
    this.guard();
    const row = this.db.staffAccounts.find((a) => a.id === id);
    if (!row) return null;
    const before = { ...row };
    Object.assign(row, patch);
    this.log("staff_accounts", "UPDATE", before, row);
    // Mirrors trg_staff_end_assignments: deactivated or moved staff hold no case.
    if ((before.active && !row.active) || before.branch_id !== row.branch_id) {
      for (const a of this.db.assignments.filter((x) => x.staff_id === id && x.ended_at === null)) this.endAssignment(a);
    }
    return row;
  }

  async skus() {
    return this.db.skus;
  }
  async createSkus(skus: NewSku[]) {
    this.guard();
    const ids = new Set(this.db.skus.map((s) => s.sku_id));
    for (const s of skus) {
      if (ids.has(s.sku_id)) throw new StoreError("CONFLICT", `SKU ${s.sku_id} already exists`);
      ids.add(s.sku_id);
    }
    const rows = skus.map((s) => ({ ...SKU_DEFAULTS, ...s } as MasterSku));
    this.db.skus.push(...rows);
    for (const r of rows) this.log("master_sku", "INSERT", null, r);
    return rows;
  }
  async updateSku(skuId: string, patch: Partial<MasterSku>) {
    this.guard();
    const row = this.db.skus.find((s) => s.sku_id === skuId);
    if (!row) return null;
    const before = { ...row };
    Object.assign(row, patch);
    this.log("master_sku", "UPDATE", before, row);
    return row;
  }
  async skuTypes() {
    return this.db.skuTypes;
  }
  async createSkuType(type: Partial<SkuType> & Pick<SkuType, "type_id" | "name_en">) {
    this.guard();
    if (this.db.skuTypes.some((t) => t.type_id === type.type_id)) throw new StoreError("CONFLICT", "Type already exists");
    const row: SkuType = { name_lo: null, icon: "ring", active: true, sort_order: this.db.skuTypes.length + 1, ...type };
    this.db.skuTypes.push(row);
    this.log("sku_type", "INSERT", null, row);
    return row;
  }
  async updateSkuType(typeId: string, patch: Partial<SkuType>) {
    this.guard();
    const row = this.db.skuTypes.find((t) => t.type_id === typeId);
    if (!row) return null;
    const before = { ...row };
    Object.assign(row, patch);
    this.log("sku_type", "UPDATE", before, row);
    return row;
  }
  async skuWeights() {
    return this.db.skuWeights;
  }
  async createSkuWeight(weight: Partial<SkuWeight> & Pick<SkuWeight, "weight_id" | "name_en" | "gram_value">) {
    this.guard();
    if (this.db.skuWeights.some((w) => w.weight_id === weight.weight_id)) throw new StoreError("CONFLICT", "Weight already exists");
    const row: SkuWeight = { active: true, sort_order: this.db.skuWeights.length + 1, ...weight };
    this.db.skuWeights.push(row);
    this.log("sku_weight", "INSERT", null, row);
    return row;
  }
  async updateSkuWeight(weightId: string, patch: Partial<SkuWeight>) {
    this.guard();
    const row = this.db.skuWeights.find((w) => w.weight_id === weightId);
    if (!row) return null;
    const before = { ...row };
    Object.assign(row, patch);
    this.log("sku_weight", "UPDATE", before, row);
    return row;
  }

  async deskDays(filter: DeskDayFilter) {
    const rows = this.db.deskDays.filter((d) => {
      if (filter.date && d.ledger_date !== filter.date) return false;
      if (filter.from && d.ledger_date < filter.from) return false;
      if (filter.to && d.ledger_date > filter.to) return false;
      if (filter.before && d.ledger_date >= filter.before) return false;
      if (filter.after && d.ledger_date <= filter.after) return false;
      if (filter.branchId && d.branch_id !== filter.branchId) return false;
      if (filter.deskId && d.desk_id !== filter.deskId) return false;
      if (filter.status && d.status !== filter.status) return false;
      if (filter.notStatus && d.status === filter.notStatus) return false;
      return true;
    });
    const dir = filter.order === "desc" ? -1 : 1;
    rows.sort((a, b) => dir * a.ledger_date.localeCompare(b.ledger_date) || a.desk_id.localeCompare(b.desk_id));
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }
  async latestDeskDays(filter: { branchId?: string; deskId?: string }) {
    const latest = new Map<string, DeskDay>();
    for (const d of this.db.deskDays) {
      if (filter.branchId && d.branch_id !== filter.branchId) continue;
      if (filter.deskId && d.desk_id !== filter.deskId) continue;
      const cur = latest.get(d.desk_id);
      if (!cur || d.ledger_date > cur.ledger_date) latest.set(d.desk_id, d);
    }
    return [...latest.values()];
  }
  async insertDeskDay(day: Pick<DeskDay, "desk_id" | "ledger_date" | "branch_id" | "checked_in_by">) {
    this.guard();
    if (this.dayStatus(day.desk_id, day.ledger_date) !== null) return null;
    const now = this.now();
    const row: DeskDay = { ...day, status: "check_in", safe_drop_note: null, done_by: null, done_at: null, created_at: now, updated_at: now };
    this.db.deskDays.push(row);
    this.log("desk_days", "INSERT", null, row);
    return row;
  }
  async updateDeskDay(deskId: string, date: string, patch: Partial<DeskDay>, expectedStatus?: DeskStatus) {
    this.guard();
    const row = this.db.deskDays.find((d) => d.desk_id === deskId && d.ledger_date === date);
    if (!row) return null;
    if (expectedStatus && row.status !== expectedStatus) return null;
    const before = { ...row };
    Object.assign(row, patch, { updated_at: this.now() });
    this.log("desk_days", "UPDATE", before, row);
    return row;
  }

  async ledger(filter: LedgerFilter) {
    return this.db.ledger.filter((row) => {
      if (filter.date && row.ledger_date !== filter.date) return false;
      if (filter.from && row.ledger_date < filter.from) return false;
      if (filter.to && row.ledger_date > filter.to) return false;
      if (filter.branchId && row.branch_id !== filter.branchId) return false;
      if (filter.deskId && row.desk_id !== filter.deskId) return false;
      return true;
    });
  }
  async ledgerLatest(filter: { branchId?: string; deskId?: string }) {
    const days = await this.latestDeskDays(filter);
    const latestByDesk = new Map(days.map((d) => [d.desk_id, d.ledger_date]));
    return this.db.ledger.filter((r) => latestByDesk.get(r.desk_id) === r.ledger_date);
  }
  private findRow(key: LedgerKey) {
    return this.db.ledger.find((r) => r.ledger_date === key.ledger_date && r.desk_id === key.desk_id && r.sku_id === key.sku_id);
  }
  async insertLedgerRows(rows: NewLedgerRow[], opts?: { overwriteOpening?: boolean }) {
    this.guard();
    const out: LedgerRow[] = [];
    for (const r of rows) {
      this.assertUnlocked(r.desk_id, r.ledger_date);
      const existing = this.findRow(r);
      if (existing) {
        if (opts?.overwriteOpening && existing.opening_qty !== r.opening_qty) {
          const before = { ...existing };
          existing.opening_qty = r.opening_qty;
          existing.closing_qty = computeClosing(existing);
          existing.updated_at = this.now();
          this.log("daily_stock_ledger", "UPDATE", before, existing);
        }
        continue;
      }
      if (r.opening_qty < 0) throw new StoreError("NEGATIVE", `${r.desk_id} ${r.sku_id}: opening cannot be negative`);
      const now = this.now();
      const row: LedgerRow = {
        id: this.newId("ledger"),
        ...r,
        stock_in: 0,
        transfer_in: 0,
        retail_sale: 0,
        wholesale: 0,
        transfer_out: 0,
        destock: 0,
        destock_note: null,
        move: 0,
        closing_qty: r.opening_qty,
        counted_qty: null,
        counted_note: null,
        excluded: false,
        created_at: now,
        updated_at: now,
      };
      this.db.ledger.push(row);
      this.log("daily_stock_ledger", "INSERT", null, row);
      out.push(row);
    }
    return out;
  }
  async patchLedgerRows(patches: LedgerRowPatch[]) {
    this.guard();
    for (const p of patches) this.assertUnlocked(p.desk_id, p.ledger_date);
    // Same rule as the database trigger: refuse a write that leaves closing
    // below zero unless the row was already that low (closing does not drop).
    for (const p of patches) {
      const row = this.findRow(p);
      if (!row) continue;
      const next = computeClosing({ ...row, ...p });
      if (next < 0 && next < row.closing_qty) {
        throw new StoreError("NEGATIVE", `${row.desk_id} ${row.sku_id}: only ${Math.max(row.closing_qty, 0)} available`, Math.max(row.closing_qty, 0));
      }
    }
    const out: LedgerRow[] = [];
    for (const p of patches) {
      const row = this.findRow(p);
      if (!row) continue;
      const before = { ...row };
      Object.assign(row, p, { updated_at: this.now() });
      row.closing_qty = computeClosing(row);
      this.log("daily_stock_ledger", "UPDATE", before, row);
      out.push(row);
    }
    return out;
  }
  async ledgerAdd(key: LedgerKey, field: "transfer_in" | "transfer_out" | "move", delta: number, actor: string | null) {
    this.guard();
    const row = this.findRow(key);
    if (!row) return null;
    this.assertUnlocked(key.desk_id, key.ledger_date);
    if (row[field] + delta < 0) throw new StoreError("INVALID", `${field} cannot go below zero`);
    const next = computeClosing({ ...row, [field]: row[field] + delta });
    if (next < 0 && next < row.closing_qty) throw new StoreError("NEGATIVE", `${row.desk_id} ${row.sku_id}: only ${Math.max(row.closing_qty, 0)} available`, Math.max(row.closing_qty, 0));
    const before = { ...row };
    row[field] += delta;
    row.excluded = false;
    if (actor) row.performed_by = actor;
    row.closing_qty = computeClosing(row);
    row.updated_at = this.now();
    this.log("daily_stock_ledger", "UPDATE", before, row);
    return row[field];
  }
  // Synchronous body between the read and the write, so it is atomic.
  async applyLedgerChanges(key: LedgerKey, changes: LedgerChange[]): Promise<ApplyResult> {
    this.guard();
    for (const c of changes) {
      if (!LEDGER_CHANGE_FIELDS.includes(c.field)) throw new StoreError("INVALID", `ledger_apply: field ${c.field} not allowed`);
    }
    const row = this.findRow(key);
    if (!row) return { ok: false, code: "ROW_NOT_FOUND" };
    this.assertUnlocked(key.desk_id, key.ledger_date);
    for (const c of changes) {
      if (c.from === undefined) continue;
      const stored = row[c.field] ?? null;
      if (stored !== c.from && stored !== c.to) return { ok: false, code: "ROW_CHANGED", row: { ...row } };
    }
    const patch = Object.fromEntries(changes.map((c) => [c.field, c.to])) as Partial<LedgerRow>;
    const next = computeClosing({ ...row, ...patch });
    if (next < 0 && next < row.closing_qty) {
      throw new StoreError("NEGATIVE", `${row.desk_id} ${row.sku_id}: only ${Math.max(row.closing_qty, 0)} available`, Math.max(row.closing_qty, 0));
    }
    const before = { ...row };
    Object.assign(row, patch, { updated_at: this.now() });
    if (this.actor && "id" in this.actor) row.performed_by = this.actor.id;
    row.closing_qty = computeClosing(row);
    this.log("daily_stock_ledger", "UPDATE", before, row);
    return { ok: true, row: { ...row } };
  }

  async documents(filter: DocumentFilter) {
    const matched = this.db.documents.filter((d) => {
      if (filter.branchId && d.branch_id !== filter.branchId) return false;
      if (filter.deskId && d.desk_id !== filter.deskId) return false;
      if (filter.date && d.doc_date !== filter.date) return false;
      if (filter.kind && d.kind !== filter.kind) return false;
      if (filter.status && d.status !== filter.status) return false;
      return true;
    });
    const sorted = [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const pageSize = filter.pageSize ?? 10;
    const start = ((filter.page ?? 1) - 1) * pageSize;
    return { rows: sorted.slice(start, start + pageSize), total: sorted.length };
  }
  async getDocument(id: string) {
    return this.db.documents.find((d) => d.id === id) ?? null;
  }
  async createDocument(doc: NewDocument, rows: NewDocumentRow[]) {
    this.guard();
    const year = doc.doc_date.slice(0, 4);
    const counterKey = `${doc.branch_id}/${year}`;
    const seq = (this.db.docCounters[counterKey] ?? 0) + 1;
    this.db.docCounters[counterKey] = seq;
    const id = crypto.randomUUID();
    const created: DocumentRecord = {
      id,
      doc_no: docNo(doc.branch_id, year, seq),
      created_at: this.now(),
      ...doc,
      rows: rows.map((r, i) => ({ ...r, id: `${id}-${i}`, document_id: id })),
    };
    this.db.documents.unshift(created);
    this.log("documents", "INSERT", null, created);
    for (const r of created.rows ?? []) this.log("document_rows", "INSERT", null, r);
    return created;
  }
  async updateDocument(id: string, patch: Partial<DocumentRecord>, expectedStatus?: ProposalStatus) {
    this.guard();
    const row = this.db.documents.find((d) => d.id === id);
    if (!row) return null;
    if (expectedStatus && row.status !== expectedStatus) return null;
    const before = { ...row };
    Object.assign(row, patch);
    this.log("documents", "UPDATE", before, row);
    return row;
  }
  async deleteDocument(id: string) {
    this.guard();
    const idx = this.db.documents.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    const [removed] = this.db.documents.splice(idx, 1);
    this.log("documents", "DELETE", removed, null);
    // document_rows cascade with their document, and the trigger sees each row.
    for (const r of removed.rows ?? []) this.log("document_rows", "DELETE", r, null);
    return true;
  }

  async config() {
    return this.db.config;
  }
  async updateConfig(patch: Partial<SystemConfig>) {
    this.guard();
    const before = { ...this.db.config };
    Object.assign(this.db.config, patch, { updated_at: this.now() });
    this.log("system_config", "UPDATE", before, this.db.config);
    return this.db.config;
  }

  async transfers(filter: TransferFilter) {
    return this.db.transfers
      .filter((t) => {
        if (filter.branchId && t.from_branch_id !== filter.branchId && t.to_branch_id !== filter.branchId) return false;
        if (filter.fromDeskId && t.from_desk_id !== filter.fromDeskId) return false;
        if (filter.toDeskId && t.to_desk_id !== filter.toDeskId) return false;
        if (filter.status && t.status !== filter.status) return false;
        if (filter.sentDate && t.sent_date !== filter.sentDate) return false;
        if (filter.ticketId && t.ticket_id !== filter.ticketId) return false;
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async getTransfer(id: string) {
    return this.db.transfers.find((t) => t.id === id) ?? null;
  }
  async createTransfer(transfer: NewTransfer) {
    this.guard();
    const now = this.now();
    const row: Transfer = { id: crypto.randomUUID(), status: "in_transit", received_date: null, received_by: null, client_ref: null, reverses_id: null, ticket_id: null, note: null, is_seed: false, created_at: now, updated_at: now, ...transfer };
    this.db.transfers.push(row);
    this.log("transfers", "INSERT", null, row);
    return row;
  }
  async updateTransfer(id: string, patch: Partial<Transfer>, expectedStatus: TransferStatus) {
    this.guard();
    const row = this.db.transfers.find((t) => t.id === id);
    if (!row || row.status !== expectedStatus) return null;
    const before = { ...row };
    Object.assign(row, patch, { updated_at: this.now() });
    this.log("transfers", "UPDATE", before, row);
    return row;
  }

  // The whole move runs without an await, so two simultaneous requests cannot
  // interleave between the stock check and the writes (the SQL RPC gets the same
  // guarantee from row locks).
  private moveCore(input: MoveInput, reversesTicket: string | null): MoveResult {
    this.guard();
    const ticketRows = (ticket: string) => this.db.transfers.filter((t) => t.ticket_id === ticket);
    const prior = this.db.transfers.find((t) => t.client_ref === input.clientRef);
    if (prior?.ticket_id) return { ok: true, ticketId: prior.ticket_id, moves: ticketRows(prior.ticket_id), replayed: true };

    const { date, fromDeskId, toDeskId } = input;
    if (fromDeskId === toDeskId) return { ok: false, code: "SAME_DESK" };
    const from = this.db.desks.find((d) => d.desk_id === fromDeskId);
    const to = this.db.desks.find((d) => d.desk_id === toDeskId);
    if (!from || !to) return { ok: false, code: "DESK_NOT_FOUND" };
    if (from.branch_id !== to.branch_id) return { ok: false, code: "OTHER_BRANCH" };

    if (input.lines.length === 0 || input.lines.some((l) => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 99999)) {
      return { ok: false, code: "BAD_QTY" };
    }
    const fromStatus = this.dayStatus(fromDeskId, date);
    const toStatus = this.dayStatus(toDeskId, date);
    if (fromStatus === null) return { ok: false, code: "NOT_CHECKED_IN" };
    if (toStatus === null) return { ok: false, code: "DEST_NOT_OPEN" };
    if (fromStatus === "done") return { ok: false, code: "DAY_LOCKED" };
    if (toStatus === "done") return { ok: false, code: "DEST_DAY_LOCKED" };

    const totals = new Map<string, number>();
    for (const l of input.lines) totals.set(l.skuId, (totals.get(l.skuId) ?? 0) + l.qty);
    const lines = [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [skuId, qty] of lines) {
      const row = this.findRow({ ledger_date: date, desk_id: fromDeskId, sku_id: skuId });
      if (!row || row.excluded || qty > row.closing_qty) {
        return { ok: false, code: "NOT_ENOUGH_STOCK", skuId, available: row && !row.excluded ? Math.max(row.closing_qty, 0) : 0 };
      }
    }

    const actorId = this.actor && "id" in this.actor ? this.actor.id : null;
    const ticketId = crypto.randomUUID();
    const original = reversesTicket ? ticketRows(reversesTicket) : [];
    const moves: Transfer[] = [];
    lines.forEach(([skuId, qty], i) => {
      const src = this.findRow({ ledger_date: date, desk_id: fromDeskId, sku_id: skuId })!;
      const srcBefore = { ...src };
      src.move += qty;
      src.excluded = false;
      if (actorId) src.performed_by = actorId;
      src.closing_qty = computeClosing(src);
      src.updated_at = this.now();
      this.log("daily_stock_ledger", "UPDATE", srcBefore, src);

      const dst = this.findRow({ ledger_date: date, desk_id: toDeskId, sku_id: skuId });
      if (dst) {
        const before = { ...dst };
        dst.transfer_in += qty;
        dst.excluded = false;
        if (actorId) dst.performed_by = actorId;
        dst.closing_qty = computeClosing(dst);
        dst.updated_at = this.now();
        this.log("daily_stock_ledger", "UPDATE", before, dst);
      } else {
        const stamp = this.now();
        const row: LedgerRow = {
          id: this.newId("ledger"),
          ledger_date: date,
          desk_id: toDeskId,
          branch_id: to.branch_id,
          sku_id: skuId,
          opening_qty: 0,
          stock_in: 0,
          transfer_in: qty,
          retail_sale: 0,
          wholesale: 0,
          transfer_out: 0,
          destock: 0,
          destock_note: null,
          move: 0,
          closing_qty: qty,
          counted_qty: null,
          counted_note: null,
          performed_by: actorId,
          excluded: false,
          created_at: stamp,
          updated_at: stamp,
        };
        this.db.ledger.push(row);
        this.log("daily_stock_ledger", "INSERT", null, row);
      }

      const now = this.now();
      const transfer: Transfer = {
        id: crypto.randomUUID(),
        kind: "move",
        from_desk_id: fromDeskId,
        from_branch_id: from.branch_id,
        to_desk_id: toDeskId,
        to_branch_id: to.branch_id,
        sku_id: skuId,
        qty,
        sent_date: date,
        sent_by: actorId,
        status: "received",
        received_date: date,
        received_by: actorId,
        client_ref: i === 0 ? input.clientRef : null,
        reverses_id: original.find((t) => t.sku_id === skuId)?.id ?? null,
        ticket_id: ticketId,
        note: input.note ?? null,
        is_seed: false,
        created_at: now,
        updated_at: now,
      };
      this.db.transfers.push(transfer);
      this.log("transfers", "INSERT", null, transfer);
      moves.push(transfer);
    });
    return { ok: true, ticketId, moves };
  }
  async moveStock(input: MoveInput): Promise<MoveResult> {
    return this.moveCore(input, null);
  }
  async undoMove(ticketId: string, clientRef: string): Promise<MoveResult> {
    this.guard();
    const prior = this.db.transfers.find((t) => t.client_ref === clientRef);
    if (prior?.ticket_id) {
      return { ok: true, ticketId: prior.ticket_id, moves: this.db.transfers.filter((t) => t.ticket_id === prior.ticket_id), replayed: true };
    }
    const original = this.db.transfers.filter((t) => t.ticket_id === ticketId);
    if (original.length === 0) return { ok: false, code: "NOT_FOUND" };
    if (original[0].kind !== "move" || original[0].status !== "received") return { ok: false, code: "NOT_A_MOVE" };
    const ids = new Set(original.map((t) => t.id));
    if (this.db.transfers.some((t) => t.reverses_id && ids.has(t.reverses_id))) return { ok: false, code: "ALREADY_UNDONE" };
    return this.moveCore(
      {
        date: original[0].sent_date,
        fromDeskId: original[0].to_desk_id,
        toDeskId: original[0].from_desk_id,
        lines: original.map((t) => ({ skuId: t.sku_id, qty: t.qty })),
        clientRef,
      },
      ticketId
    );
  }

  async closedDays(filter: ClosedDayFilter) {
    return this.db.closedDays
      .filter((d) => (!filter.branchId || d.branch_id === filter.branchId) && (!filter.from || d.closed_date >= filter.from) && (!filter.to || d.closed_date <= filter.to))
      .sort((a, b) => a.closed_date.localeCompare(b.closed_date) || a.branch_id.localeCompare(b.branch_id));
  }
  async addClosedDays(rows: ClosedDay[]) {
    this.guard();
    const added: ClosedDay[] = [];
    for (const r of rows) {
      if (this.db.closedDays.some((d) => d.branch_id === r.branch_id && d.closed_date === r.closed_date)) continue;
      const row = { ...r };
      this.db.closedDays.push(row);
      this.log("branch_closed_day", "INSERT", null, row);
      added.push(row);
    }
    return added;
  }
  async removeClosedDay(branchId: string, date: string) {
    this.guard();
    const i = this.db.closedDays.findIndex((d) => d.branch_id === branchId && d.closed_date === date);
    if (i < 0) return false;
    const [row] = this.db.closedDays.splice(i, 1);
    this.log("branch_closed_day", "DELETE", row, null);
    return true;
  }

  // Mirrors guard_replenishment_rule: a company-wide rule needs an admin, a branch
  // rule an admin or that branch's manager. System writes are not restricted.
  private assertMayEditRule(branchId: string | null) {
    const id = this.actorId();
    if (!id) return;
    const me = this.db.staffAccounts.find((a) => a.id === id);
    if (me?.role === "admin") return;
    if (branchId !== null && me?.role === "manager" && me.branch_id === branchId) return;
    throw new StoreError("DENIED", "ROLE_DENIED");
  }
  private sameRule(r: ReplenishmentRule, t: RuleTarget) {
    return r.scope === t.scope && r.scope_key === t.scope_key && r.branch_id === t.branch_id;
  }
  async rules() {
    return this.db.rules;
  }
  async upsertRule(input: RuleInput) {
    this.guard();
    this.assertMayEditRule(input.branch_id);
    const i = this.db.rules.findIndex((r) => this.sameRule(r, input));
    if (input.avg_daily_sell === null && input.lead_time_days === null) {
      if (i >= 0) {
        const [gone] = this.db.rules.splice(i, 1);
        this.log("replenishment_rule", "DELETE", gone, null);
      }
      return null;
    }
    if (i >= 0) {
      const row = this.db.rules[i];
      const before = { ...row };
      Object.assign(row, { avg_daily_sell: input.avg_daily_sell, lead_time_days: input.lead_time_days, updated_by: this.actorId(), updated_at: this.now() });
      this.log("replenishment_rule", "UPDATE", before, row);
      return row;
    }
    const row: ReplenishmentRule = {
      id: crypto.randomUUID(),
      scope: input.scope,
      scope_key: input.scope_key,
      branch_id: input.branch_id,
      avg_daily_sell: input.avg_daily_sell,
      lead_time_days: input.lead_time_days,
      updated_by: this.actorId(),
      updated_at: this.now(),
      is_seed: false,
    };
    this.db.rules.push(row);
    this.log("replenishment_rule", "INSERT", null, row);
    return row;
  }
  async deleteRules(targets: RuleTarget[]) {
    this.guard();
    let removed = 0;
    for (const t of targets) {
      const i = this.db.rules.findIndex((r) => this.sameRule(r, t));
      if (i < 0) continue;
      this.assertMayEditRule(t.branch_id);
      const [gone] = this.db.rules.splice(i, 1);
      this.log("replenishment_rule", "DELETE", gone, null);
      removed++;
    }
    return removed;
  }
  async branchVelocity(branchId: string, to: string, days: number) {
    const closed = this.db.closedDays.filter((d) => d.branch_id === branchId).map((d) => d.closed_date);
    return computeVelocity(
      this.db.ledger.filter((r) => r.branch_id === branchId),
      this.db.deskDays.filter((d) => d.branch_id === branchId),
      closed,
      to,
      days
    );
  }

  private actorId() {
    return this.actor && "id" in this.actor ? this.actor.id : null;
  }
  // Mirrors guard_desk_assignment for staff: a case may be taken for oneself when
  // free, and handed over or released only by its holder (or taken over for oneself once stale).
  private assertMayChangeAssignment(current: DeskAssignment | undefined, newStaffId: string | null) {
    const id = this.actorId();
    const me = id ? this.db.staffAccounts.find((a) => a.id === id) : undefined;
    if (me?.role !== "staff") return;
    // A holder from an earlier Laos day is stale: staff may take it over for themselves.
    const stale = current ? laosDate(new Date(current.started_at)) < laosDate() : false;
    // Stale: only a self-take (newStaffId is me), never a plain release or a hand-on.
    const ok = current ? current.staff_id === me.id || (stale && newStaffId === me.id) : newStaffId === me.id;
    if (!ok) throw new StoreError("DENIED", "ROLE_DENIED");
  }
  private endAssignment(a: DeskAssignment) {
    const before = { ...a };
    a.ended_at = this.now();
    a.ended_by = this.actorId();
    this.log("desk_assignment", "UPDATE", before, a);
  }
  async activeAssignments(filter: { branchId?: string }) {
    const deskIds = new Set(this.db.desks.filter((d) => !filter.branchId || d.branch_id === filter.branchId).map((d) => d.desk_id));
    return this.db.assignments.filter((a) => a.ended_at === null && deskIds.has(a.desk_id));
  }
  async assignDesk(deskId: string, staffId: string, note?: string) {
    this.guard();
    const desk = this.db.desks.find((d) => d.desk_id === deskId);
    if (!desk) throw new StoreError("INVALID", "DESK_NOT_FOUND");
    const staff = this.db.staffAccounts.find((a) => a.id === staffId);
    if (!staff || !staff.active) throw new StoreError("INVALID", "ASSIGN_INACTIVE");
    if (staff.branch_id !== desk.branch_id) throw new StoreError("INVALID", "ASSIGN_OTHER_BRANCH");
    const current = this.db.assignments.find((a) => a.desk_id === deskId && a.ended_at === null);
    if (current) {
      if (current.staff_id === staffId) return current;
    }
    this.assertMayChangeAssignment(current, staffId);
    if (current) this.endAssignment(current);
    const row: DeskAssignment = {
      id: crypto.randomUUID(),
      desk_id: deskId,
      staff_id: staffId,
      started_at: this.now(),
      started_by: this.actorId(),
      ended_at: null,
      ended_by: null,
      note: note ?? null,
      is_seed: false,
    };
    this.db.assignments.push(row);
    this.log("desk_assignment", "INSERT", null, row);
    return row;
  }
  async releaseDesk(deskId: string) {
    this.guard();
    const current = this.db.assignments.find((a) => a.desk_id === deskId && a.ended_at === null);
    if (!current) return;
    this.assertMayChangeAssignment(current, null);
    this.endAssignment(current);
  }

  async audit(entry: Omit<AuditEntry, "id" | "created_at">) {
    this.db.audit.unshift({ id: crypto.randomUUID(), created_at: this.now(), ...entry });
  }
  async auditLog(limit: number) {
    return this.db.audit.slice(0, limit);
  }
}

// ============================================================================
// Supabase (PostgREST) store
// ============================================================================
const PAGE = 1000; // PostgREST's default max rows per response on Supabase
const enc = encodeURIComponent;

class SupabaseStore implements Store {
  private url: string;
  private key: string;
  constructor(url: string, key: string, private actor?: Actor) {
    this.url = url.replace(/\/+$/, "");
    this.key = key;
  }

  private async send(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...actorHeaders(this.actor),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      throw new StoreError("UNAVAILABLE", `Database unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text();
      if (body.includes("DAY_LOCKED")) throw new StoreError("DAY_LOCKED", "This day is Done and locked");
      if (body.includes("NEGATIVE_CLOSING")) {
        const available = Number(/NEGATIVE_CLOSING: available (-?\d+)/.exec(body)?.[1]);
        throw new StoreError("NEGATIVE", "This would make the stock negative", Number.isFinite(available) ? Math.max(available, 0) : undefined);
      }
      if (body.includes("AUDIT_ACTOR_MISSING")) throw new StoreError("AUDIT_ACTOR_MISSING", "A write needs an acting user or system tag");
      // Database role guards (every guard raises ROLE_DENIED) and the assignment history rule.
      if (body.includes("ROLE_DENIED")) throw new StoreError("DENIED", "That action is not allowed for this user");
      if (body.includes("ASSIGNMENT_IMMUTABLE")) throw new StoreError("IMMUTABLE", "An assignment can only be ended, never rewritten");
      if (/ASSIGN_(INACTIVE|OTHER_BRANCH)|DESK_NOT_FOUND/.test(body)) throw new StoreError("INVALID", body);
      if (body.includes("FUTURE_DATE")) throw new StoreError("INVALID", "That date is after today");
      const pgCode = /"code"\s*:\s*"([A-Za-z0-9]+)"/.exec(body)?.[1] ?? "";
      if (res.status === 409 || pgCode === "23505") throw new StoreError("CONFLICT", body);
      if (pgCode === "23514" || pgCode === "23503" || pgCode.startsWith("22")) throw new StoreError("INVALID", body);
      throw new Error(`Supabase ${path.split("?")[0]} failed (${res.status}): ${body}`);
    }
    return res;
  }

  private async rest<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.send(path, init);
    if (res.status === 204) return [] as unknown as T;
    return (await res.json()) as T;
  }

  // Reads every row, paging past PostgREST's 1000-row cap. `path` must carry
  // a stable `order=` so pages do not overlap.
  private async restAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let start = 0; ; start += PAGE) {
      const page = await this.rest<T[]>(path, { headers: { Range: `${start}-${start + PAGE - 1}`, "Range-Unit": "items" } });
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    return this.rest<T>(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  }

  private async patchOne<T>(path: string, patch: unknown): Promise<T | null> {
    const rows = await this.rest<T[]>(path, { method: "PATCH", body: JSON.stringify(patch) });
    return rows[0] ?? null;
  }

  async branches() {
    return this.rest<Branch[]>("branches?select=*&order=sort_order");
  }
  async desks() {
    return this.rest<Desk[]>("desks?select=*&order=branch_id,sort_order");
  }
  async createDesk(input: { branch_id: string; display_name: string }) {
    const existing = await this.rest<{ desk_id: string }[]>(`desks?branch_id=eq.${enc(input.branch_id)}&select=desk_id`);
    const [desk] = await this.rest<Desk[]>("desks", {
      method: "POST",
      body: JSON.stringify({
        desk_id: nextDeskId(input.branch_id, existing.map((d) => d.desk_id)),
        branch_id: input.branch_id,
        display_name: input.display_name,
        active: true,
        sort_order: existing.length + 1,
      }),
    });
    return desk;
  }

  async staffAccounts() {
    return this.rest<StaffAccount[]>("staff_accounts?select=*&order=created_at");
  }
  async createStaffAccount(account: NewStaffAccount) {
    const [row] = await this.rest<StaffAccount[]>("staff_accounts", { method: "POST", body: JSON.stringify(account) });
    return row;
  }
  async updateStaffAccount(id: string, patch: Partial<StaffAccount>) {
    return this.patchOne<StaffAccount>(`staff_accounts?id=eq.${enc(id)}`, patch);
  }

  async skus() {
    return this.restAll<MasterSku>("master_sku?select=*&order=sku_id");
  }
  async createSkus(skus: NewSku[]) {
    if (skus.length === 0) return [];
    // One request = one transaction in PostgREST, so this is all-or-nothing.
    return this.rest<MasterSku[]>("master_sku", { method: "POST", body: JSON.stringify(skus.map((s) => ({ ...SKU_DEFAULTS, ...s }))) });
  }
  async updateSku(skuId: string, patch: Partial<MasterSku>) {
    return this.patchOne<MasterSku>(`master_sku?sku_id=eq.${enc(skuId)}`, patch);
  }
  async skuTypes() {
    return this.rest<SkuType[]>("sku_type?select=*&order=sort_order");
  }
  async createSkuType(type: Partial<SkuType> & Pick<SkuType, "type_id" | "name_en">) {
    const [row] = await this.rest<SkuType[]>("sku_type", { method: "POST", body: JSON.stringify({ name_lo: null, icon: "ring", active: true, sort_order: 0, ...type }) });
    return row;
  }
  async updateSkuType(typeId: string, patch: Partial<SkuType>) {
    return this.patchOne<SkuType>(`sku_type?type_id=eq.${enc(typeId)}`, patch);
  }
  async skuWeights() {
    return this.rest<SkuWeight[]>("sku_weight?select=*&order=sort_order");
  }
  async createSkuWeight(weight: Partial<SkuWeight> & Pick<SkuWeight, "weight_id" | "name_en" | "gram_value">) {
    const [row] = await this.rest<SkuWeight[]>("sku_weight", { method: "POST", body: JSON.stringify({ active: true, sort_order: 0, ...weight }) });
    return row;
  }
  async updateSkuWeight(weightId: string, patch: Partial<SkuWeight>) {
    return this.patchOne<SkuWeight>(`sku_weight?weight_id=eq.${enc(weightId)}`, patch);
  }

  private dateFilters(f: LedgerFilter & { before?: string; after?: string }) {
    const q: string[] = [];
    if (f.date) q.push(`ledger_date=eq.${f.date}`);
    if (f.from) q.push(`ledger_date=gte.${f.from}`);
    if (f.to) q.push(`ledger_date=lte.${f.to}`);
    if (f.before) q.push(`ledger_date=lt.${f.before}`);
    if (f.after) q.push(`ledger_date=gt.${f.after}`);
    if (f.branchId) q.push(`branch_id=eq.${enc(f.branchId)}`);
    if (f.deskId) q.push(`desk_id=eq.${enc(f.deskId)}`);
    return q;
  }

  async deskDays(filter: DeskDayFilter) {
    const q = ["select=*", ...this.dateFilters(filter)];
    if (filter.status) q.push(`status=eq.${filter.status}`);
    if (filter.notStatus) q.push(`status=neq.${filter.notStatus}`);
    q.push(`order=ledger_date.${filter.order === "desc" ? "desc" : "asc"},desk_id`);
    if (filter.limit) {
      q.push(`limit=${filter.limit}`);
      return this.rest<DeskDay[]>(`desk_days?${q.join("&")}`);
    }
    return this.restAll<DeskDay>(`desk_days?${q.join("&")}`);
  }
  async latestDeskDays(filter: { branchId?: string; deskId?: string }) {
    const q = ["select=*", ...this.dateFilters(filter), "order=desk_id"];
    return this.restAll<DeskDay>(`desk_latest_day?${q.join("&")}`);
  }
  async insertDeskDay(day: Pick<DeskDay, "desk_id" | "ledger_date" | "branch_id" | "checked_in_by">) {
    const rows = await this.rest<DeskDay[]>("desk_days?on_conflict=desk_id,ledger_date", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ ...day, status: "check_in" }),
    });
    return rows[0] ?? null;
  }
  async updateDeskDay(deskId: string, date: string, patch: Partial<DeskDay>, expectedStatus?: DeskStatus) {
    const q = [`desk_id=eq.${enc(deskId)}`, `ledger_date=eq.${date}`];
    if (expectedStatus) q.push(`status=eq.${expectedStatus}`);
    return this.patchOne<DeskDay>(`desk_days?${q.join("&")}`, patch);
  }

  async ledger(filter: LedgerFilter) {
    const q = ["select=*", ...this.dateFilters(filter), "order=ledger_date,desk_id,sku_id"];
    return this.restAll<LedgerRow>(`daily_stock_ledger?${q.join("&")}`);
  }
  async ledgerLatest(filter: { branchId?: string; deskId?: string }) {
    const q = ["select=*", ...this.dateFilters(filter), "order=desk_id,sku_id"];
    return this.restAll<LedgerRow>(`ledger_latest?${q.join("&")}`);
  }
  async insertLedgerRows(rows: NewLedgerRow[], opts?: { overwriteOpening?: boolean }) {
    if (rows.length === 0) return [];
    // merge-duplicates writes only the payload columns: opening_qty (and the key / branch / actor).
    const merge = opts?.overwriteOpening === true;
    return this.rest<LedgerRow[]>("daily_stock_ledger?on_conflict=ledger_date,desk_id,sku_id", {
      method: "POST",
      headers: { Prefer: `resolution=${merge ? "merge-duplicates" : "ignore-duplicates"},return=representation` },
      body: JSON.stringify(rows),
    });
  }
  async patchLedgerRows(patches: LedgerRowPatch[]) {
    if (patches.length === 0) return [];
    // A bulk upsert writes exactly the columns in the payload, so rows are
    // grouped by which fields they change: each group is one request and no
    // row has a field overwritten that its own patch did not carry.
    const groups = new Map<string, LedgerRowPatch[]>();
    for (const p of patches) {
      const shape = Object.keys(p).sort().join(",");
      if (!groups.has(shape)) groups.set(shape, []);
      groups.get(shape)!.push(p);
    }
    const results = await Promise.all(
      [...groups.entries()].map(([shape, rows]) =>
        this.rest<LedgerRow[]>(`daily_stock_ledger?on_conflict=ledger_date,desk_id,sku_id&columns=${shape}`, {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(rows),
        })
      )
    );
    return results.flat();
  }
  async ledgerAdd(key: LedgerKey, field: "transfer_in" | "transfer_out" | "move", delta: number, actor: string | null) {
    return this.rpc<number | null>("ledger_add", {
      p_date: key.ledger_date,
      p_desk: key.desk_id,
      p_sku: key.sku_id,
      p_field: field,
      p_delta: delta,
      p_actor: actor,
    });
  }

  async applyLedgerChanges(key: LedgerKey, changes: LedgerChange[]) {
    return this.rpc<ApplyResult>("ledger_apply", { p_date: key.ledger_date, p_desk: key.desk_id, p_sku: key.sku_id, p_changes: changes });
  }

  async documents(filter: DocumentFilter) {
    const q: string[] = ["select=*,rows:document_rows(*)", "order=created_at.desc"];
    if (filter.branchId) q.push(`branch_id=eq.${enc(filter.branchId)}`);
    if (filter.deskId) q.push(`desk_id=eq.${enc(filter.deskId)}`);
    if (filter.date) q.push(`doc_date=eq.${filter.date}`);
    if (filter.kind) q.push(`kind=eq.${filter.kind}`);
    if (filter.status) q.push(`status=eq.${filter.status}`);
    const pageSize = filter.pageSize ?? 10;
    const start = ((filter.page ?? 1) - 1) * pageSize;
    const res = await this.send(`documents?${q.join("&")}`, {
      headers: { Range: `${start}-${start + pageSize - 1}`, "Range-Unit": "items", Prefer: "count=exact" },
    });
    const total = Number(res.headers.get("content-range")?.split("/")[1]) || 0;
    const rows = res.status === 204 ? [] : ((await res.json()) as DocumentRecord[]);
    for (const d of rows) d.rows?.sort((a, b) => a.sort_order - b.sort_order);
    return { rows, total };
  }
  async getDocument(id: string) {
    const rows = await this.rest<DocumentRecord[]>(`documents?id=eq.${enc(id)}&select=*,rows:document_rows(*)`);
    const doc = rows[0] ?? null;
    doc?.rows?.sort((a, b) => a.sort_order - b.sort_order);
    return doc;
  }
  async createDocument(doc: NewDocument, rows: NewDocumentRow[]) {
    const year = doc.doc_date.slice(0, 4);
    const seq = await this.rpc<number>("next_doc_seq", { p_branch: doc.branch_id, p_year: Number(year) });
    const [created] = await this.rest<DocumentRecord[]>("documents", {
      method: "POST",
      body: JSON.stringify({ ...doc, doc_no: docNo(doc.branch_id, year, seq) }),
    });
    const rowPayload = rows.map((r, i) => ({ ...r, document_id: created.id, sort_order: r.sort_order ?? i }));
    const createdRows = rowPayload.length
      ? await this.rest<DocumentRow[]>("document_rows", { method: "POST", body: JSON.stringify(rowPayload) })
      : [];
    return { ...created, rows: createdRows };
  }
  async updateDocument(id: string, patch: Partial<DocumentRecord>, expectedStatus?: ProposalStatus) {
    const q = [`id=eq.${enc(id)}`];
    if (expectedStatus) q.push(`status=eq.${expectedStatus}`);
    return this.patchOne<DocumentRecord>(`documents?${q.join("&")}`, patch);
  }
  async deleteDocument(id: string) {
    const rows = await this.rest<DocumentRecord[]>(`documents?id=eq.${enc(id)}`, { method: "DELETE" });
    return rows.length > 0;
  }

  async config() {
    const [row] = await this.rest<SystemConfig[]>("system_config?id=eq.1&select=*");
    if (!row) throw new Error("system_config row is missing — run supabase/base.sql");
    return row;
  }
  async updateConfig(patch: Partial<SystemConfig>) {
    const row = await this.patchOne<SystemConfig>("system_config?id=eq.1", patch);
    if (!row) throw new Error("system_config row is missing — run supabase/base.sql");
    return row;
  }

  async transfers(filter: TransferFilter) {
    const q = ["select=*", "order=created_at.desc"];
    if (filter.branchId) q.push(`or=(from_branch_id.eq.${enc(filter.branchId)},to_branch_id.eq.${enc(filter.branchId)})`);
    if (filter.fromDeskId) q.push(`from_desk_id=eq.${enc(filter.fromDeskId)}`);
    if (filter.toDeskId) q.push(`to_desk_id=eq.${enc(filter.toDeskId)}`);
    if (filter.status) q.push(`status=eq.${filter.status}`);
    if (filter.sentDate) q.push(`sent_date=eq.${filter.sentDate}`);
    if (filter.ticketId) q.push(`ticket_id=eq.${enc(filter.ticketId)}`);
    return this.restAll<Transfer>(`transfers?${q.join("&")}`);
  }
  async getTransfer(id: string) {
    const rows = await this.rest<Transfer[]>(`transfers?id=eq.${enc(id)}&select=*`);
    return rows[0] ?? null;
  }
  async createTransfer(transfer: NewTransfer) {
    const [row] = await this.rest<Transfer[]>("transfers", { method: "POST", body: JSON.stringify(transfer) });
    return row;
  }
  async updateTransfer(id: string, patch: Partial<Transfer>, expectedStatus: TransferStatus) {
    return this.patchOne<Transfer>(`transfers?id=eq.${enc(id)}&status=eq.${expectedStatus}`, patch);
  }

  // The RPC speaks snake_case; the Store speaks camelCase.
  private moveResult(r: { ok: boolean; code?: string; sku_id?: string; available?: number; ticket_id?: string; moves?: Transfer[]; replayed?: boolean }): MoveResult {
    if (!r.ok) {
      return { ok: false, code: r.code ?? "UNKNOWN", ...(r.sku_id !== undefined ? { skuId: r.sku_id } : {}), ...(r.available !== undefined ? { available: r.available } : {}) };
    }
    return { ok: true, ticketId: r.ticket_id!, moves: r.moves ?? [], ...(r.replayed ? { replayed: true } : {}) };
  }
  async moveStock(input: MoveInput) {
    return this.moveResult(
      await this.rpc("move_stock", {
        p_date: input.date,
        p_from: input.fromDeskId,
        p_to: input.toDeskId,
        p_lines: input.lines.map((l) => ({ sku_id: l.skuId, qty: l.qty })),
        p_client_ref: input.clientRef,
        p_note: input.note ?? null,
      })
    );
  }
  async undoMove(ticketId: string, clientRef: string) {
    return this.moveResult(await this.rpc("undo_move", { p_ticket: ticketId, p_client_ref: clientRef }));
  }

  async closedDays(filter: ClosedDayFilter) {
    const q = [
      filter.branchId ? `branch_id=eq.${enc(filter.branchId)}` : "",
      filter.from ? `closed_date=gte.${enc(filter.from)}` : "",
      filter.to ? `closed_date=lte.${enc(filter.to)}` : "",
    ].filter(Boolean);
    return this.restAll<ClosedDay>(`branch_closed_day?select=*${q.length ? "&" + q.join("&") : ""}&order=closed_date,branch_id`);
  }
  async addClosedDays(rows: ClosedDay[]) {
    if (rows.length === 0) return [];
    // Existing dates are skipped; created_at / is_seed / created_by default in the database.
    const body = rows.map((r) => ({ branch_id: r.branch_id, closed_date: r.closed_date, reason: r.reason }));
    return this.rest<ClosedDay[]>("branch_closed_day?on_conflict=branch_id,closed_date", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
      body: JSON.stringify(body),
    });
  }
  async removeClosedDay(branchId: string, date: string) {
    const rows = await this.rest<ClosedDay[]>(`branch_closed_day?branch_id=eq.${enc(branchId)}&closed_date=eq.${enc(date)}`, { method: "DELETE" });
    return rows.length > 0;
  }

  async rules() {
    return this.restAll<ReplenishmentRule>("replenishment_rule?select=*&order=scope,scope_key,branch_id");
  }
  private ruleFilter(t: RuleTarget) {
    return `scope=eq.${enc(t.scope)}&scope_key=eq.${enc(t.scope_key)}&branch_id=${t.branch_id === null ? "is.null" : `eq.${enc(t.branch_id)}`}`;
  }
  async upsertRule(input: RuleInput) {
    // The unique index is on an expression, so on_conflict cannot name it: look first.
    if (input.avg_daily_sell === null && input.lead_time_days === null) {
      await this.deleteRules([input]);
      return null;
    }
    const values = { avg_daily_sell: input.avg_daily_sell, lead_time_days: input.lead_time_days };
    const [existing] = await this.rest<ReplenishmentRule[]>(`replenishment_rule?select=*&${this.ruleFilter(input)}`);
    if (existing) return this.patchOne<ReplenishmentRule>(`replenishment_rule?id=eq.${enc(existing.id)}`, values);
    const [row] = await this.rest<ReplenishmentRule[]>("replenishment_rule", {
      method: "POST",
      body: JSON.stringify({ scope: input.scope, scope_key: input.scope_key, branch_id: input.branch_id, ...values }),
    });
    return row ?? null;
  }
  async deleteRules(targets: RuleTarget[]) {
    let removed = 0;
    for (const t of targets) {
      const rows = await this.rest<ReplenishmentRule[]>(`replenishment_rule?${this.ruleFilter(t)}`, { method: "DELETE" });
      removed += rows.length;
    }
    return removed;
  }
  async branchVelocity(branchId: string, to: string, days: number) {
    return this.rpc<VelocityRow[]>("branch_velocity", { p_branch: branchId, p_to: to, p_days: days });
  }

  async activeAssignments(filter: { branchId?: string }) {
    if (!filter.branchId) return this.restAll<DeskAssignment>("desk_assignment?select=*&ended_at=is.null&order=started_at");
    const desks = await this.rest<{ desk_id: string }[]>(`desks?branch_id=eq.${enc(filter.branchId)}&select=desk_id`);
    if (desks.length === 0) return [];
    return this.restAll<DeskAssignment>(`desk_assignment?select=*&ended_at=is.null&desk_id=in.(${desks.map((d) => enc(d.desk_id)).join(",")})&order=started_at`);
  }
  async assignDesk(deskId: string, staffId: string, note?: string) {
    return this.rpc<DeskAssignment>("assign_desk", { p_desk: deskId, p_staff: staffId, p_note: note ?? null });
  }
  async releaseDesk(deskId: string) {
    await this.rpc("release_desk", { p_desk: deskId });
  }

  async audit(entry: Omit<AuditEntry, "id" | "created_at">) {
    await this.rest("audit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(entry) });
  }
  async auditLog(limit: number) {
    return this.rest<AuditEntry[]>(`audit_log?select=*&order=created_at.desc&limit=${limit}`);
  }
}

let cachedDemoStore: DemoStore | null = null;

// `actor` attributes every write. Reads need none.
export function getStore(env: Env, actor?: Actor): Store {
  if (isLive(env)) return new SupabaseStore(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, actor);
  if (!cachedDemoStore) cachedDemoStore = new DemoStore(buildDemoData(businessDate(env)));
  return cachedDemoStore.withActor(actor);
}

// Tests only: start the next request from a fresh demo dataset.
export function resetDemoStore() {
  cachedDemoStore = null;
}
