// Data-access layer. Two interchangeable implementations behind one Store
// interface: SupabaseStore (real Postgres via PostgREST) and DemoStore
// (in-memory, seeded to match supabase/seed.sql). getStore() picks whichever
// is configured so every route in src/index.ts is written once against the
// Store interface regardless of backend.
import type {
  Branch,
  Desk,
  MasterSku,
  SkuType,
  SkuWeight,
  LedgerRow,
  DocumentRecord,
  DocumentRow,
  SystemConfig,
  PortfolioSnapshot,
  BranchTarget,
  StaffAccount,
  Env,
} from "./types";
import * as demo from "./demoData";

export interface LedgerFilter {
  date?: string;
  from?: string;
  to?: string;
  branchId?: string;
  deskId?: string;
}

export interface DocumentFilter {
  branchId?: string;
  deskId?: string;
  date?: string;
  page?: number;
  pageSize?: number;
}

export interface Store {
  branches(): Promise<Branch[]>;
  desks(): Promise<Desk[]>;
  createDesk(
    input: { branch_id: string; display_name: string },
    openingRows: { sku_id: string; opening_qty: number }[],
    date: string,
    performedBy: string | null
  ): Promise<{ desk: Desk; rows: LedgerRow[] }>;
  staffAccounts(): Promise<StaffAccount[]>;
  bumpStaffAccountTokenVersion(id: string): Promise<void>;
  skus(): Promise<MasterSku[]>;
  createSku(sku: Partial<MasterSku> & Pick<MasterSku, "sku_id" | "name_en" | "category">): Promise<MasterSku>;
  updateSku(skuId: string, patch: Partial<MasterSku>): Promise<MasterSku>;
  updateSkuRunRate(skuId: string, patch: { avg_daily_sales?: number | null; order_lead_time_days?: number | null }): Promise<MasterSku>;
  skuTypes(): Promise<SkuType[]>;
  createSkuType(type: Partial<SkuType> & Pick<SkuType, "type_id" | "name_en">): Promise<SkuType>;
  updateSkuType(typeId: string, patch: Partial<SkuType>): Promise<SkuType>;
  skuWeights(): Promise<SkuWeight[]>;
  createSkuWeight(weight: Partial<SkuWeight> & Pick<SkuWeight, "weight_id" | "name_en" | "gram_value">): Promise<SkuWeight>;
  updateSkuWeight(weightId: string, patch: Partial<SkuWeight>): Promise<SkuWeight>;
  ledger(filter: LedgerFilter): Promise<LedgerRow[]>;
  upsertLedgerRows(rows: Partial<LedgerRow>[]): Promise<LedgerRow[]>;
  documents(filter: DocumentFilter): Promise<{ rows: DocumentRecord[]; total: number }>;
  createDocument(
    doc: Omit<DocumentRecord, "id" | "doc_no" | "created_at" | "rows">,
    rows: Omit<DocumentRow, "id" | "document_id">[]
  ): Promise<DocumentRecord>;
  deleteDocument(id: string): Promise<boolean>;
  config(): Promise<SystemConfig>;
  updateConfig(patch: Partial<SystemConfig>): Promise<SystemConfig>;
  portfolioSnapshot(): Promise<PortfolioSnapshot>;
  branchTargets(): Promise<BranchTarget[]>;
}

function nextDeskId(branchId: string, existing: Desk[]) {
  const branchCode = branchId.replace(/^B-/, "");
  const countForBranch = existing.filter((d) => d.branch_id === branchId).length;
  return `${branchCode}-D${String(countForBranch + 1).padStart(2, "0")}`;
}

function newLedgerRowDefaults(deskId: string, branchId: string, skuId: string, openingQty: number, date: string, performedBy: string | null = null): LedgerRow {
  return {
    id: "",
    ledger_date: date,
    desk_id: deskId,
    branch_id: branchId,
    sku_id: skuId,
    opening_qty: openingQty,
    stock_in: 0,
    retail_sale: 0,
    wholesale: 0,
    transfer_out: 0,
    destock: 0,
    destock_note: null,
    move: 0,
    closing_qty: openingQty,
    closing_gram: 0,
    closing_baht: 0,
    counted_qty: null,
    counted_note: null,
    performed_by: performedBy,
    excluded: false,
    audit_verified: false,
    desk_status: "check_in",
    safe_drop_note: null,
    created_at: "",
    updated_at: "",
  };
}

// ============================================================================
// Demo (in-memory) store
// ============================================================================
class DemoStore implements Store {
  async branches() {
    return demo.branches;
  }
  async desks() {
    return demo.desks;
  }
  async createDesk(input: { branch_id: string; display_name: string }, openingRows: { sku_id: string; opening_qty: number }[], date: string, performedBy: string | null) {
    const desk_id = nextDeskId(input.branch_id, demo.desks);
    const desk: Desk = {
      desk_id,
      branch_id: input.branch_id,
      display_name: input.display_name,
      active: true,
      sort_order: demo.desks.filter((d) => d.branch_id === input.branch_id).length + 1,
      created_at: new Date().toISOString(),
    };
    demo.desks.push(desk);
    const rows = await this.upsertLedgerRows(
      openingRows.map((r) => newLedgerRowDefaults(desk_id, input.branch_id, r.sku_id, r.opening_qty, date, performedBy))
    );
    return { desk, rows };
  }
  async staffAccounts() {
    return demo.staffAccounts;
  }
  async bumpStaffAccountTokenVersion(id: string) {
    const acct = demo.staffAccounts.find((a) => a.id === id);
    if (acct) acct.token_version++;
  }
  async skus() {
    return demo.skus;
  }
  async createSku(sku: Partial<MasterSku> & Pick<MasterSku, "sku_id" | "name_en" | "category">) {
    const row: MasterSku = {
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
      status: "in_stock",
      is_desk_item: true,
      icon: "ring",
      ...sku,
    };
    demo.skus.push(row);
    return row;
  }
  async updateSku(skuId: string, patch: Partial<MasterSku>) {
    const sku = demo.skus.find((s) => s.sku_id === skuId);
    if (!sku) throw new Error("SKU not found");
    Object.assign(sku, patch);
    return sku;
  }
  async updateSkuRunRate(skuId: string, patch: { avg_daily_sales?: number | null; order_lead_time_days?: number | null }) {
    const sku = demo.skus.find((s) => s.sku_id === skuId);
    if (!sku) throw new Error("SKU not found");
    Object.assign(sku, patch);
    return sku;
  }
  async skuTypes() {
    return demo.skuTypes;
  }
  async createSkuType(type: Partial<SkuType> & Pick<SkuType, "type_id" | "name_en">) {
    const row: SkuType = { name_lo: null, icon: "ring", active: true, sort_order: demo.skuTypes.length + 1, ...type };
    demo.skuTypes.push(row);
    return row;
  }
  async updateSkuType(typeId: string, patch: Partial<SkuType>) {
    const row = demo.skuTypes.find((t) => t.type_id === typeId);
    if (!row) throw new Error("SKU type not found");
    Object.assign(row, patch);
    return row;
  }
  async skuWeights() {
    return demo.skuWeights;
  }
  async createSkuWeight(weight: Partial<SkuWeight> & Pick<SkuWeight, "weight_id" | "name_en" | "gram_value">) {
    const row: SkuWeight = { active: true, sort_order: demo.skuWeights.length + 1, ...weight };
    demo.skuWeights.push(row);
    return row;
  }
  async updateSkuWeight(weightId: string, patch: Partial<SkuWeight>) {
    const row = demo.skuWeights.find((w) => w.weight_id === weightId);
    if (!row) throw new Error("SKU weight not found");
    Object.assign(row, patch);
    return row;
  }
  async ledger(filter: LedgerFilter) {
    return demo.ledger.filter((row) => {
      if (filter.date && row.ledger_date !== filter.date) return false;
      if (filter.from && row.ledger_date < filter.from) return false;
      if (filter.to && row.ledger_date > filter.to) return false;
      if (filter.branchId && row.branch_id !== filter.branchId) return false;
      if (filter.deskId && row.desk_id !== filter.deskId) return false;
      return true;
    });
  }
  async upsertLedgerRows(rows: Partial<LedgerRow>[]) {
    const out: LedgerRow[] = [];
    for (const patch of rows) {
      const idx = demo.ledger.findIndex(
        (r) => r.ledger_date === patch.ledger_date && r.desk_id === patch.desk_id && r.sku_id === patch.sku_id
      );
      const now = new Date().toISOString();
      if (idx >= 0) {
        demo.ledger[idx] = { ...demo.ledger[idx], ...patch, updated_at: now };
        out.push(demo.ledger[idx]);
      } else {
        const row: LedgerRow = {
          id: `ledger-${demo.ledger.length + 1}`,
          ledger_date: patch.ledger_date ?? demo.DEMO_DATE,
          desk_id: patch.desk_id ?? "",
          branch_id: patch.branch_id ?? "",
          sku_id: patch.sku_id ?? "",
          opening_qty: patch.opening_qty ?? 0,
          stock_in: patch.stock_in ?? 0,
          retail_sale: patch.retail_sale ?? 0,
          wholesale: patch.wholesale ?? 0,
          transfer_out: patch.transfer_out ?? 0,
          destock: patch.destock ?? 0,
          destock_note: patch.destock_note ?? null,
          move: patch.move ?? 0,
          closing_qty: patch.closing_qty ?? 0,
          closing_gram: patch.closing_gram ?? 0,
          closing_baht: patch.closing_baht ?? 0,
          counted_qty: patch.counted_qty ?? null,
          counted_note: patch.counted_note ?? null,
          performed_by: patch.performed_by ?? null,
          excluded: patch.excluded ?? false,
          audit_verified: patch.audit_verified ?? false,
          desk_status: patch.desk_status ?? "check_in",
          safe_drop_note: patch.safe_drop_note ?? null,
          created_at: now,
          updated_at: now,
        };
        demo.ledger.push(row);
        out.push(row);
      }
    }
    return out;
  }
  async documents(filter: DocumentFilter) {
    const matched = demo.documents.filter((d) => {
      if (filter.branchId && d.branch_id !== filter.branchId) return false;
      if (filter.deskId && d.desk_id !== filter.deskId) return false;
      if (filter.date && d.doc_date !== filter.date) return false;
      return true;
    });
    const sorted = [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const pageSize = filter.pageSize ?? 10;
    const page = filter.page ?? 1;
    const start = (page - 1) * pageSize;
    return { rows: sorted.slice(start, start + pageSize), total: sorted.length };
  }
  async createDocument(
    doc: Omit<DocumentRecord, "id" | "doc_no" | "created_at" | "rows">,
    rows: Omit<DocumentRow, "id" | "document_id">[]
  ) {
    const branchCode = doc.branch_id.replace(/^B-/, "");
    const year = doc.doc_date.slice(0, 4);
    const countForBranchYear = demo.documents.filter((d) => d.branch_id === doc.branch_id && d.doc_date.startsWith(year)).length;
    const seq = countForBranchYear + 1;
    const docNo = `DOC-${branchCode}-${year}-${String(seq).padStart(4, "0")}`;
    const id = `demo-doc-${demo.documents.length + 1}`;
    const newDoc: DocumentRecord = {
      id,
      doc_no: docNo,
      created_at: new Date().toISOString(),
      rows: rows.map((r, i) => ({ ...r, id: `demo-doc-row-${id}-${i}`, document_id: id })),
      ...doc,
    };
    demo.documents.unshift(newDoc);
    return newDoc;
  }
  async deleteDocument(id: string) {
    const idx = demo.documents.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    demo.documents.splice(idx, 1);
    return true;
  }
  async config() {
    return demo.config;
  }
  async updateConfig(patch: Partial<SystemConfig>) {
    Object.assign(demo.config, patch, { last_synced_at: new Date().toISOString() });
    return demo.config;
  }
  async portfolioSnapshot() {
    return demo.portfolioSnapshot;
  }
  async branchTargets() {
    return demo.branchTargets;
  }
}

// ============================================================================
// Supabase (PostgREST) store
// ============================================================================
class SupabaseStore implements Store {
  constructor(private url: string, private key: string) {}

  private async rest<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase ${path} failed (${res.status}): ${body}`);
    }
    if (res.status === 204) return [] as unknown as T;
    return (await res.json()) as T;
  }

  private async restWithCount<T>(path: string, init?: RequestInit): Promise<{ rows: T; total: number }> {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        Prefer: "count=exact",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase ${path} failed (${res.status}): ${body}`);
    }
    const contentRange = res.headers.get("content-range"); // "0-9/42"
    const total = contentRange ? Number(contentRange.split("/")[1]) || 0 : 0;
    const rows = res.status === 204 ? ([] as unknown as T) : ((await res.json()) as T);
    return { rows, total };
  }

  async branches() {
    return this.rest<Branch[]>("branches?select=*&order=sort_order");
  }
  async desks() {
    return this.rest<Desk[]>("desks?select=*&order=sort_order");
  }
  async createDesk(input: { branch_id: string; display_name: string }, openingRows: { sku_id: string; opening_qty: number }[], date: string, performedBy: string | null) {
    const existing = await this.rest<Desk[]>(`desks?branch_id=eq.${input.branch_id}&select=desk_id`);
    const desk_id = nextDeskId(input.branch_id, existing.map((d) => ({ ...d, branch_id: input.branch_id })) as Desk[]);
    const [desk] = await this.rest<Desk[]>("desks", {
      method: "POST",
      body: JSON.stringify({ desk_id, branch_id: input.branch_id, display_name: input.display_name, active: true, sort_order: existing.length + 1 }),
    });
    const rows = await this.upsertLedgerRows(
      openingRows.map((r) => newLedgerRowDefaults(desk_id, input.branch_id, r.sku_id, r.opening_qty, date, performedBy))
    );
    return { desk, rows };
  }
  async staffAccounts() {
    return this.rest<StaffAccount[]>("staff_accounts?select=*");
  }
  async bumpStaffAccountTokenVersion(id: string) {
    const [current] = await this.rest<StaffAccount[]>(`staff_accounts?id=eq.${id}&select=token_version`);
    if (!current) return;
    await this.rest(`staff_accounts?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ token_version: current.token_version + 1 }),
    });
  }
  async skus() {
    return this.rest<MasterSku[]>("master_sku?select=*");
  }
  async createSku(sku: Partial<MasterSku> & Pick<MasterSku, "sku_id" | "name_en" | "category">) {
    const payload = {
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
      status: "in_stock",
      is_desk_item: true,
      icon: "ring",
      ...sku,
    };
    const [row] = await this.rest<MasterSku[]>("master_sku", { method: "POST", body: JSON.stringify(payload) });
    return row;
  }
  async updateSku(skuId: string, patch: Partial<MasterSku>) {
    const [row] = await this.rest<MasterSku[]>(`master_sku?sku_id=eq.${skuId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return row;
  }
  async updateSkuRunRate(skuId: string, patch: { avg_daily_sales?: number | null; order_lead_time_days?: number | null }) {
    const [row] = await this.rest<MasterSku[]>(`master_sku?sku_id=eq.${skuId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return row;
  }
  async skuTypes() {
    return this.rest<SkuType[]>("sku_type?select=*&order=sort_order");
  }
  async createSkuType(type: Partial<SkuType> & Pick<SkuType, "type_id" | "name_en">) {
    const payload = { name_lo: null, icon: "ring", active: true, sort_order: 0, ...type };
    const [row] = await this.rest<SkuType[]>("sku_type", { method: "POST", body: JSON.stringify(payload) });
    return row;
  }
  async updateSkuType(typeId: string, patch: Partial<SkuType>) {
    const [row] = await this.rest<SkuType[]>(`sku_type?type_id=eq.${typeId}`, { method: "PATCH", body: JSON.stringify(patch) });
    return row;
  }
  async skuWeights() {
    return this.rest<SkuWeight[]>("sku_weight?select=*&order=sort_order");
  }
  async createSkuWeight(weight: Partial<SkuWeight> & Pick<SkuWeight, "weight_id" | "name_en" | "gram_value">) {
    const payload = { active: true, sort_order: 0, ...weight };
    const [row] = await this.rest<SkuWeight[]>("sku_weight", { method: "POST", body: JSON.stringify(payload) });
    return row;
  }
  async updateSkuWeight(weightId: string, patch: Partial<SkuWeight>) {
    const [row] = await this.rest<SkuWeight[]>(`sku_weight?weight_id=eq.${weightId}`, { method: "PATCH", body: JSON.stringify(patch) });
    return row;
  }
  async ledger(filter: LedgerFilter) {
    const q: string[] = ["select=*"];
    if (filter.date) q.push(`ledger_date=eq.${filter.date}`);
    if (filter.from) q.push(`ledger_date=gte.${filter.from}`);
    if (filter.to) q.push(`ledger_date=lte.${filter.to}`);
    if (filter.branchId) q.push(`branch_id=eq.${filter.branchId}`);
    if (filter.deskId) q.push(`desk_id=eq.${filter.deskId}`);
    return this.rest<LedgerRow[]>(`daily_stock_ledger?${q.join("&")}`);
  }
  async upsertLedgerRows(rows: Partial<LedgerRow>[]) {
    return this.rest<LedgerRow[]>("daily_stock_ledger?on_conflict=ledger_date,desk_id,sku_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(rows),
    });
  }
  async documents(filter: DocumentFilter) {
    const q: string[] = ["select=*,rows:document_rows(*)", "order=created_at.desc"];
    if (filter.branchId) q.push(`branch_id=eq.${filter.branchId}`);
    if (filter.deskId) q.push(`desk_id=eq.${filter.deskId}`);
    if (filter.date) q.push(`doc_date=eq.${filter.date}`);
    const pageSize = filter.pageSize ?? 10;
    const page = filter.page ?? 1;
    const start = (page - 1) * pageSize;
    const { rows, total } = await this.restWithCount<DocumentRecord[]>(`documents?${q.join("&")}`, {
      method: "GET",
      headers: { Range: `${start}-${start + pageSize - 1}` },
    });
    return { rows, total };
  }
  async createDocument(
    doc: Omit<DocumentRecord, "id" | "doc_no" | "created_at" | "rows">,
    rows: Omit<DocumentRow, "id" | "document_id">[]
  ) {
    const branchCode = doc.branch_id.replace(/^B-/, "");
    const year = doc.doc_date.slice(0, 4);
    const { total: countForBranchYear } = await this.restWithCount<DocumentRecord[]>(
      `documents?select=id&branch_id=eq.${doc.branch_id}&doc_date=gte.${year}-01-01&doc_date=lte.${year}-12-31`
    );
    const docNo = `DOC-${branchCode}-${year}-${String(countForBranchYear + 1).padStart(4, "0")}`;
    const [created] = await this.rest<DocumentRecord[]>("documents", {
      method: "POST",
      body: JSON.stringify({ ...doc, doc_no: docNo }),
    });
    const rowPayload = rows.map((r, i) => ({ ...r, document_id: created.id, sort_order: r.sort_order ?? i }));
    const createdRows = rowPayload.length
      ? await this.rest<DocumentRow[]>("document_rows", { method: "POST", body: JSON.stringify(rowPayload) })
      : [];
    return { ...created, rows: createdRows };
  }
  async deleteDocument(id: string) {
    await this.rest<DocumentRecord[]>(`documents?id=eq.${id}`, { method: "DELETE" });
    return true;
  }
  async config() {
    const [row] = await this.rest<SystemConfig[]>("system_config?id=eq.1&select=*");
    return row;
  }
  async updateConfig(patch: Partial<SystemConfig>) {
    const [row] = await this.rest<SystemConfig[]>("system_config?id=eq.1", {
      method: "PATCH",
      body: JSON.stringify({ ...patch, last_synced_at: new Date().toISOString() }),
    });
    return row;
  }
  async portfolioSnapshot() {
    const [row] = await this.rest<PortfolioSnapshot[]>("portfolio_snapshot?select=*&order=snapshot_date.desc&limit=1");
    return row;
  }
  async branchTargets() {
    return this.rest<BranchTarget[]>("branch_targets?select=*");
  }
}

let cachedDemoStore: DemoStore | null = null;

export function getStore(env: Env): Store {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }
  if (!cachedDemoStore) cachedDemoStore = new DemoStore();
  return cachedDemoStore;
}

export function isLive(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}
