// In-memory demo dataset, built relative to a given business date so the demo
// always has a few finished days behind "today". Used whenever Supabase is not
// configured (local development and tests). scripts/gen-seed.ts turns the same
// dataset into supabase/seed.sql.
import type {
  Branch,
  Desk,
  MasterSku,
  SkuType,
  SkuWeight,
  DeskDay,
  LedgerRow,
  DocumentRecord,
  SystemConfig,
  StaffAccount,
  Transfer,
  AuditEntry,
} from "./types";

export interface DemoData {
  branches: Branch[];
  desks: Desk[];
  staffAccounts: StaffAccount[];
  skuTypes: SkuType[];
  skuWeights: SkuWeight[];
  skus: MasterSku[];
  deskDays: DeskDay[];
  ledger: LedgerRow[];
  documents: DocumentRecord[];
  docCounters: Record<string, number>;
  config: SystemConfig;
  transfers: Transfer[];
  audit: AuditEntry[];
}

export const DEMO_ADMIN_ID = "11111111-0000-0000-0000-000000000001";
export const DEMO_STAFF = {
  "B-MM": "11111111-0000-0000-0000-000000000002",
  "B-TS": "11111111-0000-0000-0000-000000000003",
  "B-IT": "11111111-0000-0000-0000-000000000004",
  "B-VT": "11111111-0000-0000-0000-000000000005",
} as const;

function shiftDate(dateStr: string, days: number) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function sku(
  sku_id: string,
  name_en: string,
  name_lo: string,
  type: SkuType,
  weight_id: string | null,
  purity: MasterSku["purity"],
  gram: number | null,
  baht: number,
  cost: number,
  price: number,
  reorder_level: number,
  avg_daily_sales: number | null,
  order_lead_time_days: number | null,
  icon?: string
): MasterSku {
  return {
    sku_id,
    name_en,
    name_lo,
    category: type.name_en,
    type_id: type.type_id,
    weight_id,
    purity,
    std_gram_weight: gram,
    baht_weight: baht,
    unit_cost_lak: cost,
    unit_price_lak: price,
    reorder_level,
    avg_daily_sales,
    order_lead_time_days,
    active: true,
    icon: icon ?? type.icon,
  };
}

// Demo PINs: Admin "9999" (all branches), each branch staff account "1234".
// Hashes precomputed with the pbkdf2 routine in src/auth.ts.
function account(id: string, branch_id: string | null, display_name: string, pin_hash: string, created_at: string): StaffAccount {
  return {
    id,
    branch_id,
    display_name,
    pin_hash,
    role: branch_id ? "staff" : "admin",
    active: true,
    token_version: 0,
    failed_attempts: 0,
    locked_until: null,
    created_at,
  };
}

interface DeskPlan {
  desk_id: string;
  branch_id: keyof typeof DEMO_STAFF;
  // [sku_id, opening on the first demo day]
  stock: [string, number][];
  // Status of each of the last days, oldest first; the final entry is "today".
  // null = that day was never checked in.
  days: (DeskDay["status"] | null)[];
}

export function buildDemoData(today: string): DemoData {
  const startedAt = `${shiftDate(today, -30)}T01:00:00.000Z`;

  const branches: Branch[] = [
    { branch_id: "B-MM", name_en: "Morning Market", name_lo: "ຕະຫຼາດເຊົ້າ", sort_order: 1 },
    { branch_id: "B-TS", name_en: "Talat Sao", name_lo: "ຕະຫຼາດສາວ", sort_order: 2 },
    { branch_id: "B-IT", name_en: "ITECC", name_lo: "ໄອເທັກ", sort_order: 3 },
    { branch_id: "B-VT", name_en: "Vangthong", name_lo: "ວັງທອງ", sort_order: 4 },
  ];

  const desks: Desk[] = branches.flatMap((b) =>
    [1, 2, 3, 4].map((n) => ({
      desk_id: `${b.branch_id.replace(/^B-/, "")}-D0${n}`,
      branch_id: b.branch_id,
      display_name: `Desk 0${n}`,
      active: true,
      sort_order: n,
      created_at: startedAt,
    }))
  );

  const staffAccounts: StaffAccount[] = [
    account(DEMO_ADMIN_ID, null, "Owner", "pbkdf2$100000$5a567e950cc5658058c5526ca2b2c529$fac4cf2f3f6f3b526ee8768176df34c642cd6994746bf8f8d8a9620126781dfe", startedAt),
    account(DEMO_STAFF["B-MM"], "B-MM", "Somchai S.", "pbkdf2$100000$f9a0b9935d5ed4f141b351308c396b6f$322d97255131fbbb277ca489bfbf0e7fcc8e6c1ac24e632256dc0ae5a8706edd", startedAt),
    account(DEMO_STAFF["B-TS"], "B-TS", "Bounmy K.", "pbkdf2$100000$c7dbf04fcf343d0e37d4ed5eae7686a5$32d08f9b51e411c2888ca090837a53774162389bf23143e3d4e964d14d21ace5", startedAt),
    account(DEMO_STAFF["B-IT"], "B-IT", "Vilayphone N.", "pbkdf2$100000$25cc26e71c8f12edb467d813fabcb081$91c5af05b41c76bcd563d587af00a4ce04b4fdf87c468333b1f812c7a391984a", startedAt),
    account(DEMO_STAFF["B-VT"], "B-VT", "Khamla P.", "pbkdf2$100000$fc5f0bc2c09393ef3814d8fbff21b477$7246099325f4a7e9d7003bbb43f2a351b4d6908e9f04fef2ced496dc309aee88", startedAt),
  ];

  const T = {
    bars: { type_id: "GOLD_BARS", name_en: "Gold Bars", name_lo: "ທອງຄຳແທ່ງ", icon: "bar", active: true, sort_order: 1 },
    necklaces: { type_id: "NECKLACES", name_en: "Necklaces", name_lo: "ສາຍຄໍ", icon: "necklace", active: true, sort_order: 2 },
    bracelets: { type_id: "BRACELETS", name_en: "Bracelets", name_lo: "ສາຍແຂນ", icon: "bracelet", active: true, sort_order: 3 },
    rings: { type_id: "RINGS_ACCESSORIES", name_en: "Rings & Accessories", name_lo: "ແຫວນ", icon: "ring", active: true, sort_order: 4 },
    supplies: { type_id: "SUPPLIES", name_en: "Supplies", name_lo: "ອຸປະກອນ", icon: "box", active: true, sort_order: 5 },
  } satisfies Record<string, SkuType>;
  const skuTypes: SkuType[] = Object.values(T);

  const skuWeights: SkuWeight[] = [
    { weight_id: "BAHT_025", name_en: "0.25 Baht", gram_value: 3.811, active: true, sort_order: 1 },
    { weight_id: "BAHT_05", name_en: "0.5 Baht", gram_value: 7.622, active: true, sort_order: 2 },
    { weight_id: "BAHT_1", name_en: "1 Baht", gram_value: 15.244, active: true, sort_order: 3 },
    { weight_id: "BAHT_2", name_en: "2 Baht", gram_value: 30.488, active: true, sort_order: 4 },
    { weight_id: "G_1", name_en: "1g", gram_value: 1, active: true, sort_order: 5 },
    { weight_id: "G_3_75", name_en: "3.75g", gram_value: 3.75, active: true, sort_order: 6 },
    { weight_id: "KG_1", name_en: "1kg", gram_value: 1000, active: true, sort_order: 7 },
  ];

  const skus: MasterSku[] = [
    sku("GB-001", "Gold Bar 1 Baht", "ທອງຄຳແທ່ງ 1 ບາດ", T.bars, "BAHT_1", "99.99%", 15.244, 1, 32000000, 33000000, 5, 2.5, 3),
    sku("GB-002", "Gold Bar 2 Baht", "ທອງຄຳແທ່ງ 2 ບາດ", T.bars, "BAHT_2", "99.99%", 30.488, 2, 64000000, 65500000, 5, null, null),
    sku("NK-010", "Necklace Dragon 2 Baht", "ສາຍຄໍມັງກອນ 2 ບາດ", T.necklaces, "BAHT_2", "96.5%", 30.488, 2, 57000000, 60000000, 5, null, null),
    sku("NK-011", "Necklace Chain 1 Baht", "ສາຍຄໍ 1 ບາດ", T.necklaces, "BAHT_1", "96.5%", 15.244, 1, 28500000, 30200000, 5, 1.8, 4),
    sku("BR-020", "Bracelet Classic 1 Baht", "ສາຍແຂນ 1 ບາດ", T.bracelets, "BAHT_1", "96.5%", 15.244, 1, 28800000, 30500000, 5, 1.2, 3.5),
    sku("BR-021", "Bracelet Beaded 0.5 Baht", "ສາຍແຂນແກ້ວ 0.5 ບາດ", T.bracelets, "BAHT_05", "96.5%", 7.622, 0.5, 14500000, 15400000, 5, null, null),
    sku("RG-030", "Ring Solitaire 0.25 Baht", "ແຫວນເພັດ 0.25 ບາດ", T.rings, "BAHT_025", "96.5%", 3.811, 0.25, 7700000, 8200000, 5, 0.9, 2),
    sku("RG-031", "Ring Wedding Band 0.5 Baht", "ແຫວນແຕ່ງງານ 0.5 ບາດ", T.rings, "BAHT_05", "96.5%", 7.622, 0.5, 14700000, 15600000, 5, null, null),
    sku("SP-901", "Premium Gift Box", "ກ່ອງຂອງຂວັນ", T.supplies, null, null, null, 0, 25000, 45000, 20, null, null),
    sku("SP-902", "Logo Paper Bag", "ຖົງເຈ້ຍໂລໂກ້", T.supplies, null, null, null, 0, 3500, 8000, 30, null, null, "bag"),
    sku("SP-903", "Branded Pen", "ປາກກາ", T.supplies, null, null, null, 0, 5000, 12000, 30, null, null, "pen"),
    sku("SP-904", "Ceramic Mug", "ຈອກເຊລາມິກ", T.supplies, null, null, null, 0, 32000, 65000, 15, null, null, "mug"),
  ];

  // Four demo days per desk, oldest first; the last one is today.
  const plans: DeskPlan[] = [
    // Checked in today and being worked on.
    { desk_id: "MM-D01", branch_id: "B-MM", stock: [["GB-001", 14], ["GB-002", 7], ["NK-010", 9], ["RG-030", 22]], days: ["done", "done", "done", "check_in"] },
    // Finished yesterday, not started today.
    { desk_id: "MM-D02", branch_id: "B-MM", stock: [["NK-011", 16], ["BR-020", 11], ["RG-031", 6]], days: ["done", "done", "done", null] },
    // Yesterday was left unfinished — today's check-in is blocked until it is closed.
    { desk_id: "TS-D01", branch_id: "B-TS", stock: [["BR-021", 10], ["RG-030", 8], ["SP-903", 60]], days: ["done", "done", "check_in", null] },
    // Already counted and closed today.
    { desk_id: "IT-D01", branch_id: "B-IT", stock: [["GB-001", 9], ["RG-031", 7]], days: ["done", "done", "done", "done"] },
    // In final count today.
    { desk_id: "VT-D01", branch_id: "B-VT", stock: [["GB-001", 6], ["NK-011", 8], ["SP-901", 40]], days: [null, "done", "done", "final_stock"] },
  ];

  const deskDays: DeskDay[] = [];
  const ledger: LedgerRow[] = [];
  let seq = 0;

  for (const plan of plans) {
    const actor = DEMO_STAFF[plan.branch_id];
    let carry = new Map(plan.stock);
    plan.days.forEach((status, i) => {
      if (!status) return;
      const date = shiftDate(today, i - (plan.days.length - 1));
      const stamp = `${date}T09:00:00.000Z`;
      deskDays.push({
        desk_id: plan.desk_id,
        ledger_date: date,
        branch_id: plan.branch_id,
        status,
        safe_drop_note: null,
        checked_in_by: actor,
        done_by: status === "done" ? actor : null,
        done_at: status === "done" ? stamp : null,
        created_at: stamp,
        updated_at: stamp,
      });
      const next = new Map<string, number>();
      [...carry.entries()].forEach(([sku_id, opening], k) => {
        // Small deterministic movements so reports have something to show.
        const active = status !== "check_in" || i < plan.days.length - 1 || k % 2 === 0;
        const stock_in = active && (i + k) % 4 === 1 ? 2 : 0;
        const retail_sale = active ? Math.min(opening + stock_in, (i + k) % 3) : 0;
        const closing = opening + stock_in - retail_sale;
        const counted = status === "check_in" ? null : closing;
        seq++;
        ledger.push({
          id: `demo-ledger-${seq}`,
          ledger_date: date,
          desk_id: plan.desk_id,
          branch_id: plan.branch_id,
          sku_id,
          opening_qty: opening,
          stock_in,
          transfer_in: 0,
          retail_sale,
          wholesale: 0,
          transfer_out: 0,
          destock: 0,
          destock_note: null,
          move: 0,
          closing_qty: closing,
          counted_qty: counted,
          counted_note: null,
          performed_by: actor,
          excluded: false,
          created_at: stamp,
          updated_at: stamp,
        });
        next.set(sku_id, counted ?? closing);
      });
      carry = next;
    });
  }

  const docBase = { kind: "document" as const, status: null, decided_by: null, decided_at: null };
  const d3 = shiftDate(today, -3);
  const d2 = shiftDate(today, -2);
  const d1 = shiftDate(today, -1);
  const year = today.slice(0, 4);
  const documents: DocumentRecord[] = [
    {
      id: "a0000000-0000-0000-0000-000000000001",
      doc_no: `DOC-MM-${year}-0001`,
      title: "ໃບຮັບທອງ — ຮອບເຊົ້າ",
      branch_id: "B-MM",
      desk_id: "MM-D01",
      created_by: "Somchai S.",
      doc_date: d3,
      created_at: `${d3}T03:45:00.000Z`,
      notes: "Morning delivery",
      ...docBase,
      rows: [
        { id: "dr-1", document_id: "a0000000-0000-0000-0000-000000000001", sort_order: 0, item: "Gold Bar 1 Baht", qty: 4, weight_g: 60.98, note: null },
        { id: "dr-2", document_id: "a0000000-0000-0000-0000-000000000001", sort_order: 1, item: "Necklace Dragon 2 Baht", qty: 2, weight_g: 60.98, note: null },
      ],
    },
    {
      id: "a0000000-0000-0000-0000-000000000002",
      doc_no: `DOC-TS-${year}-0001`,
      title: "Wedding band batch weigh-in",
      branch_id: "B-TS",
      desk_id: "TS-D01",
      created_by: "Bounmy K.",
      doc_date: d2,
      created_at: `${d2}T02:15:00.000Z`,
      notes: null,
      ...docBase,
      rows: [{ id: "dr-3", document_id: "a0000000-0000-0000-0000-000000000002", sort_order: 0, item: "Ring Wedding Band 0.5 Baht", qty: 10, weight_g: 76.22, note: null }],
    },
    {
      id: "a0000000-0000-0000-0000-000000000003",
      doc_no: `DOC-MM-${year}-0002`,
      title: "ຂໍ້ສະເໜີສັ່ງຊື້ — MM-D02 · Desk 02",
      branch_id: "B-MM",
      desk_id: "MM-D02",
      created_by: "Somchai S.",
      doc_date: d1,
      created_at: `${d1}T09:30:00.000Z`,
      notes: null,
      kind: "proposal",
      status: "pending",
      decided_by: null,
      decided_at: null,
      rows: [{ id: "dr-4", document_id: "a0000000-0000-0000-0000-000000000003", sort_order: 0, item: "Ring Wedding Band 0.5 Baht", qty: 10, weight_g: 76.22, note: "low stock" }],
    },
  ];

  return {
    branches,
    desks,
    staffAccounts,
    skuTypes,
    skuWeights,
    skus,
    deskDays,
    ledger,
    documents,
    docCounters: { [`B-MM/${year}`]: 2, [`B-TS/${year}`]: 1 },
    config: { id: 1, safety_buffer_days: 2, spot_lak_per_baht: 32500000, usd_to_lak_rate: 20800, updated_at: startedAt },
    transfers: [],
    audit: [],
  };
}
