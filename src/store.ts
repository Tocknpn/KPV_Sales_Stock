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
  Env,
} from "./types";
import { buildDemoData, type DemoData } from "./demoData";
import { businessDate, isLive } from "./time";
import { computeClosing } from "./logic";
import { actorHeaders, type Actor } from "./actor";
import { auditEntry, type AuditOp } from "./audit";

export type StoreErrorCode = "DAY_LOCKED" | "CONFLICT" | "INVALID" | "UNAVAILABLE" | "NEGATIVE" | "AUDIT_ACTOR_MISSING";

// Errors the routes can turn into a meaningful HTTP status.
export class StoreError extends Error {
  constructor(public code: StoreErrorCode, message: string) {
    super(message);
  }
}

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
export type NewTransfer = Omit<Transfer, "id" | "status" | "received_date" | "received_by" | "created_at" | "updated_at">;
export type NewStaffAccount = Pick<StaffAccount, "branch_id" | "display_name" | "pin_hash" | "role">;
export type NewSku = Omit<MasterSku, "active"> & { active?: boolean };

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
  insertLedgerRows(rows: NewLedgerRow[]): Promise<LedgerRow[]>;
  // Changes only the fields present on each patch. Throws DAY_LOCKED when the
  // desk day is Done.
  patchLedgerRows(patches: LedgerRowPatch[]): Promise<LedgerRow[]>;
  // Atomic increment of one movement column. Returns the new value, or null
  // when the row does not exist.
  ledgerAdd(key: LedgerKey, field: "transfer_in" | "transfer_out" | "move", delta: number, actor: string | null): Promise<number | null>;

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
  async insertLedgerRows(rows: NewLedgerRow[]) {
    this.guard();
    const out: LedgerRow[] = [];
    for (const r of rows) {
      this.assertUnlocked(r.desk_id, r.ledger_date);
      if (this.findRow(r)) continue;
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
        throw new StoreError("NEGATIVE", `${row.desk_id} ${row.sku_id}: only ${Math.max(row.closing_qty, 0)} available`);
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
    if (next < 0 && next < row.closing_qty) throw new StoreError("NEGATIVE", `${row.desk_id} ${row.sku_id}: only ${Math.max(row.closing_qty, 0)} available`);
    const before = { ...row };
    row[field] += delta;
    row.excluded = false;
    if (actor) row.performed_by = actor;
    row.closing_qty = computeClosing(row);
    row.updated_at = this.now();
    this.log("daily_stock_ledger", "UPDATE", before, row);
    return row[field];
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
    const row: Transfer = { id: crypto.randomUUID(), status: "in_transit", received_date: null, received_by: null, created_at: now, updated_at: now, ...transfer };
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
      if (body.includes("NEGATIVE_CLOSING")) throw new StoreError("NEGATIVE", "This would make the stock negative");
      if (body.includes("AUDIT_ACTOR_MISSING")) throw new StoreError("AUDIT_ACTOR_MISSING", "A write needs an acting user or system tag");
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
  async insertLedgerRows(rows: NewLedgerRow[]) {
    if (rows.length === 0) return [];
    return this.rest<LedgerRow[]>("daily_stock_ledger?on_conflict=ledger_date,desk_id,sku_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
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
