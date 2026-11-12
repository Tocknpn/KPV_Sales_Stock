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
}

// Legacy fixed set, still seeded as the starting Types — kept only as a
// reference; master_sku.category is now a free-text mirror of sku_type.name_en
// (see SkuType below) since admins can add Types beyond this original list.
export type SkuCategory = string;
export type SkuStatus = "in_stock" | "low_stock" | "depleted";

// Editable product grouping ("Gold Bar", "Jewelry", ...) — reporting/dashboard
// grouping + icon. Seeded from the old fixed SkuCategory list; admins can add,
// rename, or deactivate from here on.
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
  reorder_level: number;
  // Per-SKU run-rate inputs driving "Order lead time and avg. RR setting".
  // null = not yet filled in by the user.
  avg_daily_sales: number | null;
  order_lead_time_days: number | null;
  active: boolean;
  status: SkuStatus;
  is_desk_item: boolean;
  icon: string;
}

export type DeskStatus = "check_in" | "final_stock" | "done";
// Derived-only value for a desk/date with no ledger rows yet. Never stored.
export type CardStatus = DeskStatus | "not_started";

export interface LedgerRow {
  id: string;
  ledger_date: string;
  desk_id: string;
  branch_id: string;
  sku_id: string;
  opening_qty: number;
  stock_in: number;
  retail_sale: number;
  wholesale: number;
  transfer_out: number;
  destock: number;
  destock_note: string | null;
  move: number;
  closing_qty: number;
  closing_gram: number;
  closing_baht: number;
  counted_qty: number | null;
  counted_note: string | null;
  performed_by: string | null;
  excluded: boolean;
  audit_verified: boolean;
  desk_status: DeskStatus;
  safe_drop_note: string | null;
  created_at: string;
  updated_at: string;
}

export type StaffRole = "staff" | "admin";

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
}

// The only staff-account shape ever sent to the client (login picker etc).
export interface PublicStaffAccount {
  id: string;
  branch_id: string | null;
  display_name: string;
  role: StaffRole;
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
  rows?: DocumentRow[];
}

export interface SystemConfig {
  id: 1;
  safety_buffer_days: number;
  auto_draft_po: boolean;
  sync_interval_min: number;
  spot_lak_per_baht: number;
  usd_to_lak_rate: number;
  last_synced_at: string;
}

export interface PortfolioSnapshot {
  snapshot_date: string;
  total_baht_gold: number;
  total_pcs: number;
  usd_value: number;
  lak_value: number;
  audit_balanced_pct: number;
}

export interface BranchTarget {
  branch_id: string;
  current_baht: number;
  target_baht: number;
  health_state: "Optimal" | "Restock Needed" | "Alert";
}

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AUTH_SECRET?: string;
  DEMO_DATE?: string;
  APP_VERSION?: string;
  BUILD_DATE?: string;
}
