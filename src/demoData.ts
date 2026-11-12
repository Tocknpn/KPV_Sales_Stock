// In-memory demo dataset — mirrors supabase/seed.sql exactly.
// Used automatically whenever SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not
// configured as Worker secrets, so the app is fully explorable without a live
// Supabase project. Swap in real credentials to switch to live Postgres data
// (see src/store.ts).
import type {
  Branch,
  Desk,
  MasterSku,
  SkuType,
  SkuWeight,
  LedgerRow,
  DocumentRecord,
  SystemConfig,
  PortfolioSnapshot,
  BranchTarget,
  StaffAccount,
} from "./types";

export const DEMO_DATE = "2026-10-24";

export const branches: Branch[] = [
  { branch_id: "B-MM", name_en: "Morning Market", name_lo: "ຕະຫຼາດເຊົ້າ", sort_order: 1 },
  { branch_id: "B-TS", name_en: "Talat Sao", name_lo: "ຕະຫຼາດສາວ", sort_order: 2 },
  { branch_id: "B-IT", name_en: "ITECC", name_lo: "ໄອເທັກ", sort_order: 3 },
  { branch_id: "B-VT", name_en: "Vangthong", name_lo: "ວັງທອງ", sort_order: 4 },
];

// Each branch runs its own set of Desks ("Cases"). Desks are Branch-owned,
// not staff-owned — any logged-in staff of the branch can work any Desk in
// it (see staffAccounts below for login identities).
const DESK_CREATED_AT = `${DEMO_DATE}T00:00:00.000Z`;
export const desks: Desk[] = [
  { desk_id: "MM-D01", branch_id: "B-MM", display_name: "Desk 01", active: true, sort_order: 1, created_at: DESK_CREATED_AT },
  { desk_id: "MM-D02", branch_id: "B-MM", display_name: "Desk 02", active: true, sort_order: 2, created_at: DESK_CREATED_AT },
  { desk_id: "MM-D03", branch_id: "B-MM", display_name: "Desk 03", active: true, sort_order: 3, created_at: DESK_CREATED_AT },
  { desk_id: "MM-D04", branch_id: "B-MM", display_name: "Desk 04", active: true, sort_order: 4, created_at: DESK_CREATED_AT },

  { desk_id: "TS-D01", branch_id: "B-TS", display_name: "Desk 01", active: true, sort_order: 1, created_at: DESK_CREATED_AT },
  { desk_id: "TS-D02", branch_id: "B-TS", display_name: "Desk 02", active: true, sort_order: 2, created_at: DESK_CREATED_AT },
  { desk_id: "TS-D03", branch_id: "B-TS", display_name: "Desk 03", active: true, sort_order: 3, created_at: DESK_CREATED_AT },
  { desk_id: "TS-D04", branch_id: "B-TS", display_name: "Desk 04", active: true, sort_order: 4, created_at: DESK_CREATED_AT },

  { desk_id: "IT-D01", branch_id: "B-IT", display_name: "Desk 01", active: true, sort_order: 1, created_at: DESK_CREATED_AT },
  { desk_id: "IT-D02", branch_id: "B-IT", display_name: "Desk 02", active: true, sort_order: 2, created_at: DESK_CREATED_AT },
  { desk_id: "IT-D03", branch_id: "B-IT", display_name: "Desk 03", active: true, sort_order: 3, created_at: DESK_CREATED_AT },
  { desk_id: "IT-D04", branch_id: "B-IT", display_name: "Desk 04", active: true, sort_order: 4, created_at: DESK_CREATED_AT },

  { desk_id: "VT-D01", branch_id: "B-VT", display_name: "Desk 01", active: true, sort_order: 1, created_at: DESK_CREATED_AT },
  { desk_id: "VT-D02", branch_id: "B-VT", display_name: "Desk 02", active: true, sort_order: 2, created_at: DESK_CREATED_AT },
  { desk_id: "VT-D03", branch_id: "B-VT", display_name: "Desk 03", active: true, sort_order: 3, created_at: DESK_CREATED_AT },
  { desk_id: "VT-D04", branch_id: "B-VT", display_name: "Desk 04", active: true, sort_order: 4, created_at: DESK_CREATED_AT },
];

// Demo login accounts. PIN hashes precomputed with the same pbkdf2 routine as
// src/auth.ts (see scratchpad gen-pins script) so demo and live auth share
// one verification code path instead of a plaintext-PIN special case.
// Demo PINs: Admin "9999" (all branches), each branch staff account "1234".
export const staffAccounts: StaffAccount[] = [
  {
    id: "11111111-0000-0000-0000-000000000001",
    branch_id: null,
    display_name: "Owner",
    pin_hash: "pbkdf2$100000$5a567e950cc5658058c5526ca2b2c529$fac4cf2f3f6f3b526ee8768176df34c642cd6994746bf8f8d8a9620126781dfe",
    role: "admin",
    active: true,
    token_version: 0,
    failed_attempts: 0,
    locked_until: null,
    created_at: DESK_CREATED_AT,
  },
  {
    id: "11111111-0000-0000-0000-000000000002",
    branch_id: "B-MM",
    display_name: "Somchai S.",
    pin_hash: "pbkdf2$100000$f9a0b9935d5ed4f141b351308c396b6f$322d97255131fbbb277ca489bfbf0e7fcc8e6c1ac24e632256dc0ae5a8706edd",
    role: "staff",
    active: true,
    token_version: 0,
    failed_attempts: 0,
    locked_until: null,
    created_at: DESK_CREATED_AT,
  },
  {
    id: "11111111-0000-0000-0000-000000000003",
    branch_id: "B-TS",
    display_name: "Bounmy K.",
    pin_hash: "pbkdf2$100000$c7dbf04fcf343d0e37d4ed5eae7686a5$32d08f9b51e411c2888ca090837a53774162389bf23143e3d4e964d14d21ace5",
    role: "staff",
    active: true,
    token_version: 0,
    failed_attempts: 0,
    locked_until: null,
    created_at: DESK_CREATED_AT,
  },
  {
    id: "11111111-0000-0000-0000-000000000004",
    branch_id: "B-IT",
    display_name: "Vilayphone N.",
    pin_hash: "pbkdf2$100000$25cc26e71c8f12edb467d813fabcb081$91c5af05b41c76bcd563d587af00a4ce04b4fdf87c468333b1f812c7a391984a",
    role: "staff",
    active: true,
    token_version: 0,
    failed_attempts: 0,
    locked_until: null,
    created_at: DESK_CREATED_AT,
  },
  {
    id: "11111111-0000-0000-0000-000000000005",
    branch_id: "B-VT",
    display_name: "Khamla P.",
    pin_hash: "pbkdf2$100000$fc5f0bc2c09393ef3814d8fbff21b477$7246099325f4a7e9d7003bbb43f2a351b4d6908e9f04fef2ced496dc309aee88",
    role: "staff",
    active: true,
    token_version: 0,
    failed_attempts: 0,
    locked_until: null,
    created_at: DESK_CREATED_AT,
  },
];

// Editable product grouping (Settings > SKU setting > Type), seeded 1:1 from
// the old fixed master_sku.category list.
export const skuTypes: SkuType[] = [
  { type_id: "GOLD_BARS", name_en: "Gold Bars", name_lo: "ທອງຄຳແທ່ງ", icon: "bar", active: true, sort_order: 1 },
  { type_id: "NECKLACES", name_en: "Necklaces", name_lo: "ສร้อยคอ", icon: "necklace", active: true, sort_order: 2 },
  { type_id: "BRACELETS", name_en: "Bracelets", name_lo: "ສາຍແຂນ", icon: "bracelet", active: true, sort_order: 3 },
  { type_id: "RINGS_ACCESSORIES", name_en: "Rings & Accessories", name_lo: "ແຫວນ", icon: "ring", active: true, sort_order: 4 },
  { type_id: "SUPPLIES", name_en: "Supplies", name_lo: "ອຸປະກອນ", icon: "box", active: true, sort_order: 5 },
];

// Editable size/weight definition (Settings > SKU setting > Weight). Covers
// every size the named SKUs below use, plus the plain gram sizes from app.md.
export const skuWeights: SkuWeight[] = [
  { weight_id: "BAHT_025", name_en: "0.25 Baht", gram_value: 3.811, active: true, sort_order: 1 },
  { weight_id: "BAHT_05", name_en: "0.5 Baht", gram_value: 7.622, active: true, sort_order: 2 },
  { weight_id: "BAHT_1", name_en: "1 Baht", gram_value: 15.244, active: true, sort_order: 3 },
  { weight_id: "BAHT_2", name_en: "2 Baht", gram_value: 30.488, active: true, sort_order: 4 },
  { weight_id: "G_1", name_en: "1g", gram_value: 1, active: true, sort_order: 5 },
  { weight_id: "G_3_75", name_en: "3.75g", gram_value: 3.75, active: true, sort_order: 6 },
  { weight_id: "KG_1", name_en: "1kg", gram_value: 1000, active: true, sort_order: 7 },
];

const namedSkus: MasterSku[] = [
  { sku_id: "GB-001", name_en: "Gold Bar 1 Baht", name_lo: "ທອງຄຳແທ່ງ 1 ບາດ", category: "Gold Bars", type_id: "GOLD_BARS", weight_id: "BAHT_1", purity: "99.99%", std_gram_weight: 15.244, baht_weight: 1.0, unit_cost_lak: 32000000, unit_price_lak: 33000000, reorder_level: 5, avg_daily_sales: 2.5, order_lead_time_days: 3.0, active: true, status: "in_stock", is_desk_item: true, icon: "bar" },
  { sku_id: "GB-002", name_en: "Gold Bar 2 Baht", name_lo: "ທອງຄຳແທ່ງ 2 ບາດ", category: "Gold Bars", type_id: "GOLD_BARS", weight_id: "BAHT_2", purity: "99.99%", std_gram_weight: 30.488, baht_weight: 2.0, unit_cost_lak: 64000000, unit_price_lak: 65500000, reorder_level: 5, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "bar" },
  { sku_id: "NK-010", name_en: "Necklace Dragon 2 Baht", name_lo: "ສร้อยคอมังกร 2 ບາດ", category: "Necklaces", type_id: "NECKLACES", weight_id: "BAHT_2", purity: "96.5%", std_gram_weight: 30.488, baht_weight: 2.0, unit_cost_lak: 57000000, unit_price_lak: 60000000, reorder_level: 5, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "necklace" },
  { sku_id: "NK-011", name_en: "Necklace Chain 1 Baht", name_lo: "ສร้อยคอเส้น 1 ບາດ", category: "Necklaces", type_id: "NECKLACES", weight_id: "BAHT_1", purity: "96.5%", std_gram_weight: 15.244, baht_weight: 1.0, unit_cost_lak: 28500000, unit_price_lak: 30200000, reorder_level: 5, avg_daily_sales: 1.8, order_lead_time_days: 4.0, active: true, status: "in_stock", is_desk_item: true, icon: "necklace" },
  { sku_id: "BR-020", name_en: "Bracelet Classic 1 Baht", name_lo: "ສາຍແຂນ 1 ບາດ", category: "Bracelets", type_id: "BRACELETS", weight_id: "BAHT_1", purity: "96.5%", std_gram_weight: 15.244, baht_weight: 1.0, unit_cost_lak: 28800000, unit_price_lak: 30500000, reorder_level: 5, avg_daily_sales: 1.2, order_lead_time_days: 3.5, active: true, status: "in_stock", is_desk_item: true, icon: "bracelet" },
  { sku_id: "BR-021", name_en: "Bracelet Beaded 0.5 Baht", name_lo: "ສາຍແຂນແກ້ວ 0.5 ບາດ", category: "Bracelets", type_id: "BRACELETS", weight_id: "BAHT_05", purity: "96.5%", std_gram_weight: 7.622, baht_weight: 0.5, unit_cost_lak: 14500000, unit_price_lak: 15400000, reorder_level: 5, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "bracelet" },
  { sku_id: "RG-030", name_en: "Ring Solitaire 0.25 Baht", name_lo: "ແຫວນເພັດ 0.25 ບາດ", category: "Rings & Accessories", type_id: "RINGS_ACCESSORIES", weight_id: "BAHT_025", purity: "96.5%", std_gram_weight: 3.811, baht_weight: 0.25, unit_cost_lak: 7700000, unit_price_lak: 8200000, reorder_level: 5, avg_daily_sales: 0.9, order_lead_time_days: 2.0, active: true, status: "in_stock", is_desk_item: true, icon: "ring" },
  { sku_id: "RG-031", name_en: "Ring Wedding Band 0.5 Baht", name_lo: "ແຫວນແຕ່ງງານ 0.5 ບາດ", category: "Rings & Accessories", type_id: "RINGS_ACCESSORIES", weight_id: "BAHT_05", purity: "96.5%", std_gram_weight: 7.622, baht_weight: 0.5, unit_cost_lak: 14700000, unit_price_lak: 15600000, reorder_level: 5, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "ring" },
  { sku_id: "SP-901", name_en: "Premium Gift Box", name_lo: "ກ່ອງຂອງຂວັນ", category: "Supplies", type_id: "SUPPLIES", weight_id: null, purity: null, std_gram_weight: null, baht_weight: 0, unit_cost_lak: 25000, unit_price_lak: 45000, reorder_level: 20, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "box" },
  { sku_id: "SP-902", name_en: "Logo Paper Bag", name_lo: "ຖົງເຈ້ຍໂລໂກ້", category: "Supplies", type_id: "SUPPLIES", weight_id: null, purity: null, std_gram_weight: null, baht_weight: 0, unit_cost_lak: 3500, unit_price_lak: 8000, reorder_level: 30, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "bag" },
  { sku_id: "SP-903", name_en: "Branded Pen", name_lo: "ປາກກາຕາແບຣນ", category: "Supplies", type_id: "SUPPLIES", weight_id: null, purity: null, std_gram_weight: null, baht_weight: 0, unit_cost_lak: 5000, unit_price_lak: 12000, reorder_level: 30, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "pen" },
  { sku_id: "SP-904", name_en: "Ceramic Mug", name_lo: "ຈອກເຊລາມິກ", category: "Supplies", type_id: "SUPPLIES", weight_id: null, purity: null, std_gram_weight: null, baht_weight: 0, unit_cost_lak: 32000, unit_price_lak: 65000, reorder_level: 15, avg_daily_sales: null, order_lead_time_days: null, active: true, status: "in_stock", is_desk_item: true, icon: "mug" },
];

// Deterministic bulk catalog — exact totals: Gold Bars 556, Necklaces 345,
// Bracelets 184, Rings & Accessories 147 (+8 named = 1,240); status In Stock
// 1,083, Low Stock 112, Depleted 37 (+8 named in_stock = 1,091/112/37/1,240).
function buildBulkCatalog(): MasterSku[] {
  const rows: MasterSku[] = [];
  for (let n = 1; n <= 1232; n++) {
    const category =
      n <= 556 ? "Gold Bars" : n <= 556 + 345 ? "Necklaces" : n <= 556 + 345 + 184 ? "Bracelets" : "Rings & Accessories";
    const icon = n <= 556 ? "bar" : n <= 556 + 345 ? "necklace" : n <= 556 + 345 + 184 ? "bracelet" : "ring";
    const status = n <= 1083 ? "in_stock" : n <= 1083 + 112 ? "low_stock" : "depleted";
    rows.push({
      sku_id: `SKU-${String(n).padStart(5, "0")}`,
      name_en: `Catalog Item ${n}`,
      name_lo: null,
      category,
      type_id: null,
      weight_id: null,
      purity: n % 2 === 0 ? "99.99%" : "96.5%",
      std_gram_weight: Math.round((2 + (n % 30)) * 1000) / 1000,
      baht_weight: Math.round((0.1 + (n % 20) * 0.1) * 10000) / 10000,
      unit_cost_lak: 2000000 + (n % 40) * 500000,
      unit_price_lak: 2200000 + (n % 40) * 550000,
      reorder_level: 5,
      avg_daily_sales: null,
      order_lead_time_days: null,
      active: true,
      status,
      is_desk_item: false,
      icon,
    });
  }
  return rows;
}

export const skus: MasterSku[] = [...namedSkus, ...buildBulkCatalog()];

export const ledger: LedgerRow[] = [
  mkLedger("MM-D01", "B-MM", "GB-001", 12, 2, 1, 0, 0, 0, 0, 13, 198.172, 13.0, true, "done", "11111111-0000-0000-0000-000000000002"),
  // Deliberately below GB-002's reorder_level (5) — gives the Documents >
  // Reorder Proposal screen a ready-made low-stock SKU on the very first
  // desk a new staff member sees (Morning Market Desk 01).
  mkLedger("MM-D01", "B-MM", "GB-002", 6, 1, 0, 3, 0, 0, 0, 4, 60.976, 8.0, true, "done", "11111111-0000-0000-0000-000000000002"),
  mkLedger("MM-D01", "B-MM", "NK-010", 9, 0, 2, 0, 0, 0, 0, 7, 213.416, 14.0, true, "done", "11111111-0000-0000-0000-000000000002"),
  mkLedger("MM-D01", "B-MM", "RG-030", 20, 5, 3, 0, 2, 0, 0, 20, 76.22, 5.0, true, "done", "11111111-0000-0000-0000-000000000002"),

  mkLedger("MM-D02", "B-MM", "NK-011", 15, 0, 1, 0, 0, 0, 0, 14, 213.416, 14.0, false, "check_in", "11111111-0000-0000-0000-000000000002"),
  mkLedger("MM-D02", "B-MM", "BR-020", 10, 2, 0, 0, 1, 0, 0, 11, 167.684, 11.0, false, "check_in", "11111111-0000-0000-0000-000000000002"),
  mkLedger("MM-D02", "B-MM", "RG-031", 4, 0, 0, 0, 0, 0, 0, 4, 30.488, 2.0, false, "check_in", "11111111-0000-0000-0000-000000000002"),

  mkLedger("TS-D01", "B-TS", "BR-021", 8, 0, 1, 0, 0, 0, 0, 7, 53.354, 3.5, false, "check_in", "11111111-0000-0000-0000-000000000003"),
  mkLedger("TS-D01", "B-TS", "RG-030", 3, 0, 0, 0, 0, 0, 0, 3, 11.433, 0.75, false, "check_in", "11111111-0000-0000-0000-000000000003"),
  mkLedger("TS-D01", "B-TS", "SP-903", 50, 20, 12, 0, 0, 0, 0, 58, 0, 0, false, "check_in", "11111111-0000-0000-0000-000000000003"),

  mkLedger("IT-D01", "B-IT", "GB-001", 8, 0, 1, 0, 0, 0, 0, 7, 106.708, 7.0, false, "check_in", "11111111-0000-0000-0000-000000000004"),
  mkLedger("IT-D01", "B-IT", "RG-031", 4, 0, 1, 0, 0, 0, 0, 3, 22.866, 1.5, false, "check_in", "11111111-0000-0000-0000-000000000004"),
];

let ledgerSeq = ledger.length;
function mkLedger(
  deskId: string,
  branchId: string,
  skuId: string,
  opening: number,
  stockIn: number,
  retail: number,
  wholesale: number,
  transfer: number,
  destock: number,
  move: number,
  closing: number,
  gram: number,
  baht: number,
  verified: boolean,
  status: LedgerRow["desk_status"],
  performedBy: string
): LedgerRow {
  ledgerSeq++;
  return {
    id: `ledger-${ledgerSeq}`,
    ledger_date: DEMO_DATE,
    desk_id: deskId,
    branch_id: branchId,
    sku_id: skuId,
    opening_qty: opening,
    stock_in: stockIn,
    retail_sale: retail,
    wholesale: wholesale,
    transfer_out: transfer,
    destock,
    destock_note: null,
    move,
    closing_qty: closing,
    closing_gram: gram,
    closing_baht: baht,
    counted_qty: null,
    counted_note: null,
    performed_by: performedBy,
    excluded: false,
    audit_verified: verified,
    desk_status: status,
    safe_drop_note: null,
    // Workers lock Date() to the epoch outside of a request context, so seed
    // timestamps use a fixed literal rather than `new Date()` at module scope.
    created_at: `${DEMO_DATE}T18:00:00.000Z`,
    updated_at: `${DEMO_DATE}T18:00:00.000Z`,
  };
}

export const documents: DocumentRecord[] = [
  {
    id: "a0000000-0000-0000-0000-000000000001",
    doc_no: "DOC-MM-2026-0001",
    title: "ลายทองเกี่ยวทั่วไป 2",
    branch_id: "B-MM",
    desk_id: "MM-D01",
    created_by: "Somchai S.",
    doc_date: "2026-10-20",
    created_at: "2026-10-20T10:45:00Z",
    notes: "Weekend production tally",
    rows: [
      { id: "dr-1", document_id: "a0000000-0000-0000-0000-000000000001", sort_order: 1, item: "ໄສ້", qty: 50, weight_g: 750, note: null },
      { id: "dr-2", document_id: "a0000000-0000-0000-0000-000000000001", sort_order: 2, item: "ປ່ອຍດອຍ", qty: 50, weight_g: 750, note: null },
      { id: "dr-3", document_id: "a0000000-0000-0000-0000-000000000001", sort_order: 3, item: "ເສດເງິນ", qty: 15, weight_g: 225, note: null },
    ],
  },
  {
    id: "a0000000-0000-0000-0000-000000000002",
    doc_no: "DOC-TS-2026-0001",
    title: "Wedding band batch weigh-in",
    branch_id: "B-TS",
    desk_id: "TS-D01",
    created_by: "Bounmy K.",
    doc_date: "2026-10-22",
    created_at: "2026-10-22T09:15:00Z",
    notes: null,
    rows: [
      { id: "dr-4", document_id: "a0000000-0000-0000-0000-000000000002", sort_order: 1, item: "Ring Wedding Band 0.5 Baht", qty: 10, weight_g: 76.22, note: null },
      { id: "dr-5", document_id: "a0000000-0000-0000-0000-000000000002", sort_order: 2, item: "Bracelet Classic 1 Baht", qty: 5, weight_g: 76.22, note: null },
    ],
  },
  {
    id: "a0000000-0000-0000-0000-000000000003",
    doc_no: "DOC-IT-2026-0001",
    title: "Daily melt loss record",
    branch_id: "B-IT",
    desk_id: "IT-D01",
    created_by: "Vilayphone N.",
    doc_date: "2026-10-23",
    created_at: "2026-10-23T14:05:00Z",
    notes: null,
    rows: [{ id: "dr-6", document_id: "a0000000-0000-0000-0000-000000000003", sort_order: 1, item: "Bracelet Beaded 0.5 Baht", qty: 8, weight_g: 60.98, note: "melt loss ~0.3g" }],
  },
  {
    id: "a0000000-0000-0000-0000-000000000004",
    doc_no: "DOC-VT-2026-0001",
    title: "ลายทองเกี่ยวทั่วไป",
    branch_id: "B-VT",
    desk_id: "VT-D01",
    created_by: "Khamla P.",
    doc_date: "2026-10-18",
    created_at: "2026-10-18T08:30:00Z",
    notes: "Monthly foundry pickup record",
    rows: [
      { id: "dr-7", document_id: "a0000000-0000-0000-0000-000000000004", sort_order: 1, item: "Gold Bar 1 Baht", qty: 4, weight_g: 60.98, note: null },
      { id: "dr-8", document_id: "a0000000-0000-0000-0000-000000000004", sort_order: 2, item: "Necklace Dragon 2 Baht", qty: 2, weight_g: 60.98, note: null },
    ],
  },
];

export const config: SystemConfig = {
  id: 1,
  safety_buffer_days: 2.0,
  auto_draft_po: false,
  sync_interval_min: 15,
  spot_lak_per_baht: 32500000,
  usd_to_lak_rate: 20800,
  last_synced_at: `${DEMO_DATE}T07:00:00.000Z`,
};

export const portfolioSnapshot: PortfolioSnapshot = {
  snapshot_date: DEMO_DATE,
  total_baht_gold: 1480.5,
  total_pcs: 1240,
  usd_value: 3850000,
  lak_value: 125200000000,
  audit_balanced_pct: 100,
};

export const branchTargets: BranchTarget[] = [
  { branch_id: "B-MM", current_baht: 940, target_baht: 1000, health_state: "Optimal" },
  { branch_id: "B-TS", current_baht: 820, target_baht: 1000, health_state: "Restock Needed" },
  { branch_id: "B-IT", current_baht: 680, target_baht: 1000, health_state: "Restock Needed" },
  { branch_id: "B-VT", current_baht: 420, target_baht: 1000, health_state: "Alert" },
];
