export interface Branch {
  branch_id: string;
  name_en: string;
  name_lo: string | null;
  sort_order: number;
}

export interface Desk {
  desk_id: string;
  branch_id: string;
  display_name: string;
  active: boolean;
  sort_order: number;
  created_at: string;
  is_seed?: boolean;
}

// master_sku.category is a free-text mirror of sku_type.name_en, kept so
// grouping code can read one column without joining.
export type SkuCategory = string;

// Editable product grouping ("Gold Bar", "Jewelry", ...).
export interface SkuType {
  type_id: string;
  name_en: string;
  name_lo: string | null;
  icon: string;
  active: boolean;
  sort_order: number;
}

// Editable size/weight definition ("Baht", "1g", "3.75g", "1kg", ...). Every
// size must declare its gram_value so stock-weight totals can be computed.
export interface SkuWeight {
  weight_id: string;
  name_en: string;
  gram_value: number;
  active: boolean;
  sort_order: number;
}

export interface MasterSku {
  sku_id: string;
  name_en: string;
  name_lo: string | null;
  category: SkuCategory;
  type_id: string | null;
  weight_id: string | null;
  purity: "96.5%" | "99.99%" | null;
  std_gram_weight: number | null;
  baht_weight: number | null;
  unit_cost_lak: number;
  unit_price_lak: number;
  // Fallback low-stock level, used only while avg_daily_sales is not filled in.
  reorder_level: number;
  // Per-SKU run-rate inputs. null = not yet filled in by the admin.
  avg_daily_sales: number | null;
  order_lead_time_days: number | null;
  // Product family ("Snake Necklace"); lets one replenishment rule cover all sizes.
  group_name: string | null;
  active: boolean;
  icon: string;
}

export type RuleScope = "sku" | "group" | "type";

// Average daily sell and/or lead time for a SKU, group or type; company-wide
// (branch_id null) or for one branch. A null value inherits.
export interface ReplenishmentRule {
  id: string;
  scope: RuleScope;
  scope_key: string;
  branch_id: string | null;
  avg_daily_sell: number | null;
  lead_time_days: number | null;
  updated_by: string | null;
  updated_at: string;
  is_seed: boolean;
}

export type DeskStatus = "check_in" | "final_stock" | "done";
// "not_started" = no desk_days row for that desk/date. Never stored.
export type CardStatus = DeskStatus | "not_started";

// One row per desk per business date: the single place a day's status lives.
export interface DeskDay {
  desk_id: string;
  ledger_date: string;
  branch_id: string;
  status: DeskStatus;
  safe_drop_note: string | null;
  checked_in_by: string | null;
  done_by: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id: string;
  ledger_date: string;
  desk_id: string;
  branch_id: string;
  sku_id: string;
  opening_qty: number;
  stock_in: number;
  // Credited only by a confirmed incoming transfer/move — never typed by staff.
  transfer_in: number;
  retail_sale: number;
  wholesale: number;
  transfer_out: number;
  destock: number;
  destock_note: string | null;
  move: number;
  // Computed by the database (generated column) / DemoStore — never written.
  closing_qty: number;
  counted_qty: number | null;
  counted_note: string | null;
  performed_by: string | null;
  excluded: boolean;
  created_at: string;
  updated_at: string;
}

// Fields a route may change on a ledger row. transfer_in / transfer_out / move
// are absent on purpose: they only change through Store.ledgerAdd.
export type LedgerEntryPatch = Partial<
  Pick<LedgerRow, "stock_in" | "retail_sale" | "wholesale" | "destock" | "destock_note" | "counted_qty" | "counted_note" | "performed_by" | "excluded" | "opening_qty">
>;

export type StaffRole = "staff" | "manager" | "admin";

// Server/store-side shape — includes pin_hash. Never sent to the client.
export interface StaffAccount {
  id: string;
  branch_id: string | null;
  display_name: string;
  pin_hash: string;
  role: StaffRole;
  active: boolean;
  token_version: number;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  // Mock-data account (removed by the purge). Production mode refuses it.
  is_seed?: boolean;
}

// Verified-session identity, set on the Hono context by the auth middleware.
export interface SessionUser {
  accountId: string;
  displayName: string;
  role: StaffRole;
  branchId: string | null;
}

export interface DocumentRow {
  id: string;
  document_id: string;
  sort_order: number;
  item: string;
  qty: number | null;
  weight_g: number | null;
  note: string | null;
}

export type DocumentKind = "document" | "proposal";
export type ProposalStatus = "pending" | "approved" | "rejected";

export interface DocumentRecord {
  id: string;
  doc_no: string;
  title: string;
  branch_id: string;
  desk_id: string | null;
  created_by: string;
  doc_date: string;
  created_at: string;
  notes: string | null;
  kind: DocumentKind;
  // Only proposals carry a status; ordinary documents stay null.
  status: ProposalStatus | null;
  decided_by: string | null;
  decided_at: string | null;
  rows?: DocumentRow[];
}

export interface SystemConfig {
  id: 1;
  safety_buffer_days: number;
  spot_lak_per_baht: number;
  usd_to_lak_rate: number;
  default_lead_time_days: number;
  warning_margin_days: number;
  velocity_window_days: number;
  updated_at: string;
}

export type TransferKind = "transfer" | "move";
export type TransferStatus = "in_transit" | "received" | "cancelled";

// A linked Transfer-out (any branch) or Move (same branch) between two desks.
export interface Transfer {
  id: string;
  kind: TransferKind;
  from_desk_id: string;
  from_branch_id: string;
  to_desk_id: string;
  to_branch_id: string;
  sku_id: string;
  qty: number;
  sent_date: string;
  sent_by: string | null;
  status: TransferStatus;
  received_date: string | null;
  received_by: string | null;
  // Same-branch moves: one ticket groups the lines of a single move; a retried
  // request carries the same client_ref; an undo points at the rows it reverses.
  client_ref: string | null;
  reverses_id: string | null;
  ticket_id: string | null;
  note: string | null;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  // Row-level fields written by the database audit trigger (and mirrored by DemoStore).
  table_name?: string | null;
  op?: "INSERT" | "UPDATE" | "DELETE" | null;
  row_key?: Record<string, unknown> | null;
  desk_id?: string | null;
  branch_id?: string | null;
  to_desk_id?: string | null;
  to_branch_id?: string | null;
  context?: Record<string, unknown> | null;
  actor_role?: string | null;
  source?: string | null;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  is_seed?: boolean;
}

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AUTH_SECRET?: string;
  // Demo/test only: pins "today" so the demo dataset and tests are stable.
  // Ignored when Supabase is configured.
  DEMO_DATE?: string;
  // "test": Supabase holds mock data (banner shown). "production": real data; seed accounts refused.
  // Default: production when Supabase is set, demo otherwise.
  KPV_DATA_MODE?: "test" | "production";
  APP_VERSION?: string;
  BUILD_DATE?: string;
}

// A date a branch is shut (holiday). Mirrors branch_closed_day.
export interface ClosedDay {
  branch_id: string;
  closed_date: string;
  reason: string;
  created_by: string | null;
  created_at: string;
  is_seed: boolean;
}

// Who is responsible for a case, with handover history. The active row has
// ended_at = null. Mirrors desk_assignment.
export interface DeskAssignment {
  id: string;
  desk_id: string;
  staff_id: string;
  started_at: string;
  started_by: string | null;
  ended_at: string | null;
  ended_by: string | null;
  note: string | null;
  is_seed: boolean;
}
