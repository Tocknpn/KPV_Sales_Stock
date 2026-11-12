-- ============================================================================
-- Demo seed data for KPV Goldsmith & Retail Inventory
-- Safe to re-run: truncates app tables first (keeps schema intact).
-- ============================================================================

truncate table document_rows, documents, daily_stock_ledger,
  branch_targets, portfolio_snapshot, master_sku, sku_type, sku_weight,
  staff_accounts, desks, branches, system_config restart identity cascade;

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------
insert into branches (branch_id, name_en, name_lo, sort_order) values
  ('B-MM', 'Morning Market', 'ຕະຫຼາດເຊົ້າ', 1),
  ('B-TS', 'Talat Sao',      'ຕະຫຼາດສາວ',   2),
  ('B-IT', 'ITECC',          'ໄອເທັກ',      3),
  ('B-VT', 'Vangthong',      'ວັງທອງ',      4);

-- ---------------------------------------------------------------------------
-- Desks ("Cases") — Branch-owned, not staff-owned. Any logged-in staff of the
-- branch can work any Desk in it (see staff_accounts below for logins).
-- ---------------------------------------------------------------------------
insert into desks (desk_id, branch_id, display_name, active, sort_order) values
  ('MM-D01', 'B-MM', 'Desk 01', true, 1),
  ('MM-D02', 'B-MM', 'Desk 02', true, 2),
  ('MM-D03', 'B-MM', 'Desk 03', true, 3),
  ('MM-D04', 'B-MM', 'Desk 04', true, 4),

  ('TS-D01', 'B-TS', 'Desk 01', true, 1),
  ('TS-D02', 'B-TS', 'Desk 02', true, 2),
  ('TS-D03', 'B-TS', 'Desk 03', true, 3),
  ('TS-D04', 'B-TS', 'Desk 04', true, 4),

  ('IT-D01', 'B-IT', 'Desk 01', true, 1),
  ('IT-D02', 'B-IT', 'Desk 02', true, 2),
  ('IT-D03', 'B-IT', 'Desk 03', true, 3),
  ('IT-D04', 'B-IT', 'Desk 04', true, 4),

  ('VT-D01', 'B-VT', 'Desk 01', true, 1),
  ('VT-D02', 'B-VT', 'Desk 02', true, 2),
  ('VT-D03', 'B-VT', 'Desk 03', true, 3),
  ('VT-D04', 'B-VT', 'Desk 04', true, 4);

-- ---------------------------------------------------------------------------
-- Staff accounts — demo logins. PIN hashes precomputed with the same pbkdf2
-- routine as src/auth.ts, so demo and live share one verification path.
-- Demo PINs: Owner (admin, all branches) "9999"; each branch staff "1234".
-- ---------------------------------------------------------------------------
insert into staff_accounts (id, branch_id, display_name, pin_hash, role, active, token_version) values
  ('11111111-0000-0000-0000-000000000001', null,   'Owner',          'pbkdf2$100000$5a567e950cc5658058c5526ca2b2c529$fac4cf2f3f6f3b526ee8768176df34c642cd6994746bf8f8d8a9620126781dfe', 'admin', true, 0),
  ('11111111-0000-0000-0000-000000000002', 'B-MM', 'Somchai S.',     'pbkdf2$100000$f9a0b9935d5ed4f141b351308c396b6f$322d97255131fbbb277ca489bfbf0e7fcc8e6c1ac24e632256dc0ae5a8706edd', 'staff', true, 0),
  ('11111111-0000-0000-0000-000000000003', 'B-TS', 'Bounmy K.',      'pbkdf2$100000$c7dbf04fcf343d0e37d4ed5eae7686a5$32d08f9b51e411c2888ca090837a53774162389bf23143e3d4e964d14d21ace5', 'staff', true, 0),
  ('11111111-0000-0000-0000-000000000004', 'B-IT', 'Vilayphone N.',  'pbkdf2$100000$25cc26e71c8f12edb467d813fabcb081$91c5af05b41c76bcd563d587af00a4ce04b4fdf87c468333b1f812c7a391984a', 'staff', true, 0),
  ('11111111-0000-0000-0000-000000000005', 'B-VT', 'Khamla P.',      'pbkdf2$100000$fc5f0bc2c09393ef3814d8fbff21b477$7246099325f4a7e9d7003bbb43f2a351b4d6908e9f04fef2ced496dc309aee88', 'staff', true, 0);

-- ---------------------------------------------------------------------------
-- SKU Type / Weight master data (Settings > SKU setting). Types seeded 1:1
-- from the old fixed master_sku.category list; weights cover every size the
-- named SKUs below actually use, plus the plain gram sizes from app.md.
-- ---------------------------------------------------------------------------
insert into sku_type (type_id, name_en, name_lo, icon, active, sort_order) values
  ('GOLD_BARS',           'Gold Bars',           'ທອງຄຳແທ່ງ',  'bar',      true, 1),
  ('NECKLACES',           'Necklaces',           'ສร้อยคอ',    'necklace', true, 2),
  ('BRACELETS',           'Bracelets',           'ສາຍແຂນ',     'bracelet', true, 3),
  ('RINGS_ACCESSORIES',   'Rings & Accessories', 'ແຫວນ',       'ring',     true, 4),
  ('SUPPLIES',            'Supplies',            'ອຸປະກອນ',    'box',      true, 5);

insert into sku_weight (weight_id, name_en, gram_value, active, sort_order) values
  ('BAHT_025', '0.25 Baht', 3.811,  true, 1),
  ('BAHT_05',  '0.5 Baht',  7.622,  true, 2),
  ('BAHT_1',   '1 Baht',    15.244, true, 3),
  ('BAHT_2',   '2 Baht',    30.488, true, 4),
  ('G_1',      '1g',        1,      true, 5),
  ('G_3_75',   '3.75g',     3.75,   true, 6),
  ('KG_1',     '1kg',       1000,   true, 7);

-- ---------------------------------------------------------------------------
-- Master_SKU — named desk/report items (gold jewelry + retail supplies)
-- ---------------------------------------------------------------------------
insert into master_sku (sku_id, name_en, name_lo, category, type_id, weight_id, purity, std_gram_weight, baht_weight, unit_cost_lak, unit_price_lak, reorder_level, avg_daily_sales, order_lead_time_days, active, status, is_desk_item, icon) values
  ('GB-001', 'Gold Bar 1 Baht',        'ທອງຄຳແທ່ງ 1 ບາດ',   'Gold Bars',           'GOLD_BARS',         'BAHT_1',   '99.99%', 15.244, 1.00, 32000000, 33000000, 5, 2.5,  3.0, true, 'in_stock', true, 'bar'),
  ('GB-002', 'Gold Bar 2 Baht',        'ທອງຄຳແທ່ງ 2 ບາດ',   'Gold Bars',           'GOLD_BARS',         'BAHT_2',   '99.99%', 30.488, 2.00, 64000000, 65500000, 5, null, null, true, 'in_stock', true, 'bar'),
  ('NK-010', 'Necklace Dragon 2 Baht', 'ສร้อยคอมังกร 2 ບາດ', 'Necklaces',           'NECKLACES',         'BAHT_2',   '96.5%',  30.488, 2.00, 57000000, 60000000, 5, null, null, true, 'in_stock', true, 'necklace'),
  ('NK-011', 'Necklace Chain 1 Baht',  'ສร้อยคอเส้น 1 ບາດ',  'Necklaces',           'NECKLACES',         'BAHT_1',   '96.5%',  15.244, 1.00, 28500000, 30200000, 5, 1.8,  4.0, true, 'in_stock', true, 'necklace'),
  ('BR-020', 'Bracelet Classic 1 Baht','ສาຍແຂນ 1 ບາດ',      'Bracelets',           'BRACELETS',         'BAHT_1',   '96.5%',  15.244, 1.00, 28800000, 30500000, 5, 1.2,  3.5, true, 'in_stock', true, 'bracelet'),
  ('BR-021', 'Bracelet Beaded 0.5 Baht','ສາຍແຂນແກ້ວ 0.5 ບາດ','Bracelets',           'BRACELETS',         'BAHT_05',  '96.5%',  7.622,  0.50, 14500000, 15400000, 5, null, null, true, 'in_stock', true, 'bracelet'),
  ('RG-030', 'Ring Solitaire 0.25 Baht','ແຫວນເພັດ 0.25 ບາດ', 'Rings & Accessories', 'RINGS_ACCESSORIES', 'BAHT_025', '96.5%',  3.811,  0.25, 7700000,  8200000,  5, 0.9,  2.0, true, 'in_stock', true, 'ring'),
  ('RG-031', 'Ring Wedding Band 0.5 Baht','ແຫວນແຕ່ງງານ 0.5 ບາດ','Rings & Accessories','RINGS_ACCESSORIES', 'BAHT_05',  '96.5%', 7.622,  0.50, 14700000, 15600000, 5, null, null, true, 'in_stock', true, 'ring'),
  ('SP-901', 'Premium Gift Box',       'ກ່ອງຂອງຂວັນ',        'Supplies', 'SUPPLIES', null, null, null, 0, 25000, 45000, 20, null, null, true, 'in_stock', true, 'box'),
  ('SP-902', 'Logo Paper Bag',         'ຖົງເຈ້ຍໂລໂກ້',        'Supplies', 'SUPPLIES', null, null, null, 0, 3500,  8000,  30, null, null, true, 'in_stock', true, 'bag'),
  ('SP-903', 'Branded Pen',            'ປາກກາຕາແບຣນ',        'Supplies', 'SUPPLIES', null, null, null, 0, 5000,  12000, 30, null, null, true, 'in_stock', true, 'pen'),
  ('SP-904', 'Ceramic Mug',            'ຈອກເຊລາມິກ',          'Supplies', 'SUPPLIES', null, null, null, 0, 32000, 65000, 15, null, null, true, 'in_stock', true, 'mug');

-- ---------------------------------------------------------------------------
-- Master_SKU — bulk generated catalog (fills out the 1,240-SKU portfolio used
-- by the Dashboard capacity bar / category donut). Deterministic ranges give
-- exact totals: Gold Bars 558, Necklaces 347, Bracelets 186, Rings 149 (=1240);
-- status In Stock 1,091 / Low Stock 112 / Depleted 37 (=1240).
-- ---------------------------------------------------------------------------
insert into master_sku (sku_id, name_en, category, purity, std_gram_weight, baht_weight, unit_cost_lak, unit_price_lak, reorder_level, active, status, is_desk_item, icon)
select
  'SKU-' || lpad(n::text, 5, '0'),
  'Catalog Item ' || n,
  case
    when n <= 556 then 'Gold Bars'
    when n <= 556 + 345 then 'Necklaces'
    when n <= 556 + 345 + 184 then 'Bracelets'
    else 'Rings & Accessories'
  end,
  case when n % 2 = 0 then '99.99%' else '96.5%' end,
  round((2 + (n % 30))::numeric, 3),
  round((0.1 + (n % 20) * 0.1)::numeric, 4),
  round((2000000 + (n % 40) * 500000)::numeric, 2),
  round((2200000 + (n % 40) * 550000)::numeric, 2),
  5,
  true,
  case
    when n <= 1083 then 'in_stock'
    when n <= 1083 + 112 then 'low_stock'
    else 'depleted'
  end,
  false,
  case
    when n <= 556 then 'bar'
    when n <= 556 + 345 then 'necklace'
    when n <= 556 + 345 + 184 then 'bracelet'
    else 'ring'
  end
from generate_series(1, 1232) as n;

-- ---------------------------------------------------------------------------
-- Daily_Stock_Ledger — demo date 2026-10-24
-- MM-D01: checked in & settled -> "Done"   MM-D02 / TS-D01 / IT-D01: mid-day -> "Check In"
-- Every other desk has no row yet -> "Not Started" (no row = not started)
-- ---------------------------------------------------------------------------
insert into daily_stock_ledger
  (ledger_date, desk_id, branch_id, sku_id, opening_qty, stock_in, retail_sale, wholesale, transfer_out, destock, move, closing_qty, closing_gram, closing_baht, audit_verified, desk_status, performed_by) values
  ('2026-10-24','MM-D01','B-MM','GB-001', 12, 2, 1, 0, 0, 0, 0, 13, 198.172, 13.00, true, 'done', '11111111-0000-0000-0000-000000000002'),
  ('2026-10-24','MM-D01','B-MM','GB-002',  6, 1, 0, 3, 0, 0, 0,  4,  60.976,  8.00, true, 'done', '11111111-0000-0000-0000-000000000002'),
  ('2026-10-24','MM-D01','B-MM','NK-010',  9, 0, 2, 0, 0, 0, 0,  7, 213.416, 14.00, true, 'done', '11111111-0000-0000-0000-000000000002'),
  ('2026-10-24','MM-D01','B-MM','RG-030', 20, 5, 3, 0, 2, 0, 0, 20,  76.220,  5.00, true, 'done', '11111111-0000-0000-0000-000000000002'),

  ('2026-10-24','MM-D02','B-MM','NK-011', 15, 0, 1, 0, 0, 0, 0, 14, 213.416, 14.00, false, 'check_in', '11111111-0000-0000-0000-000000000002'),
  ('2026-10-24','MM-D02','B-MM','BR-020', 10, 2, 0, 0, 1, 0, 0, 11, 167.684, 11.00, false, 'check_in', '11111111-0000-0000-0000-000000000002'),
  ('2026-10-24','MM-D02','B-MM','RG-031',  4, 0, 0, 0, 0, 0, 0,  4,  30.488,  2.00, false, 'check_in', '11111111-0000-0000-0000-000000000002'),

  ('2026-10-24','TS-D01','B-TS','BR-021',  8, 0, 1, 0, 0, 0, 0,  7,  53.354,  3.50, false, 'check_in', '11111111-0000-0000-0000-000000000003'),
  ('2026-10-24','TS-D01','B-TS','RG-030',  3, 0, 0, 0, 0, 0, 0,  3,  11.433,  0.75, false, 'check_in', '11111111-0000-0000-0000-000000000003'),
  ('2026-10-24','TS-D01','B-TS','SP-903', 50, 20, 12, 0, 0, 0, 0, 58,   0.000,  0.00, false, 'check_in', '11111111-0000-0000-0000-000000000003'),

  ('2026-10-24','IT-D01','B-IT','GB-001',  8, 0, 1, 0, 0, 0, 0,  7, 106.708,  7.00, false, 'check_in', '11111111-0000-0000-0000-000000000004'),
  ('2026-10-24','IT-D01','B-IT','RG-031',  4, 0, 1, 0, 0, 0, 0,  3,  22.866,  1.50, false, 'check_in', '11111111-0000-0000-0000-000000000004');

-- ---------------------------------------------------------------------------
-- Documents + rows
-- ---------------------------------------------------------------------------
insert into documents (id, doc_no, title, branch_id, desk_id, created_by, doc_date, created_at, notes) values
  ('a0000000-0000-0000-0000-000000000001', 'DOC-MM-2026-0001', 'ลายทองเกี่ยวทั่วไป 2',   'B-MM', 'MM-D01', 'Somchai S.',    '2026-10-20', '2026-10-20T10:45:00Z', 'Weekend production tally'),
  ('a0000000-0000-0000-0000-000000000002', 'DOC-TS-2026-0001', 'Wedding band batch weigh-in', 'B-TS', 'TS-D01', 'Bounmy K.',     '2026-10-22', '2026-10-22T09:15:00Z', null),
  ('a0000000-0000-0000-0000-000000000003', 'DOC-IT-2026-0001', 'Daily melt loss record',      'B-IT', 'IT-D01', 'Vilayphone N.', '2026-10-23', '2026-10-23T14:05:00Z', null),
  ('a0000000-0000-0000-0000-000000000004', 'DOC-VT-2026-0001', 'ลายทองเกี่ยวทั่วไป',        'B-VT', 'VT-D01', 'Khamla P.',     '2026-10-18', '2026-10-18T08:30:00Z', 'Monthly foundry pickup record');

insert into document_rows (document_id, sort_order, item, qty, weight_g, note) values
  ('a0000000-0000-0000-0000-000000000001', 1, 'ໄສ້', 50, 750, null),
  ('a0000000-0000-0000-0000-000000000001', 2, 'ປ່ອຍດອຍ', 50, 750, null),
  ('a0000000-0000-0000-0000-000000000001', 3, 'ເສດເງິນ', 15, 225, null),

  ('a0000000-0000-0000-0000-000000000002', 1, 'Ring Wedding Band 0.5 Baht', 10, 76.22, null),
  ('a0000000-0000-0000-0000-000000000002', 2, 'Bracelet Classic 1 Baht', 5, 76.22, null),

  ('a0000000-0000-0000-0000-000000000003', 1, 'Bracelet Beaded 0.5 Baht', 8, 60.98, 'melt loss ~0.3g'),

  ('a0000000-0000-0000-0000-000000000004', 1, 'Gold Bar 1 Baht', 4, 60.98, null),
  ('a0000000-0000-0000-0000-000000000004', 2, 'Necklace Dragon 2 Baht', 2, 60.98, null);

-- ---------------------------------------------------------------------------
-- System_Config
-- ---------------------------------------------------------------------------
insert into system_config (id, safety_buffer_days, auto_draft_po, sync_interval_min, spot_lak_per_baht, usd_to_lak_rate) values
  (1, 2.0, false, 15, 32500000, 20800);

-- ---------------------------------------------------------------------------
-- Portfolio snapshot (Dashboard hero card)
-- ---------------------------------------------------------------------------
insert into portfolio_snapshot (snapshot_date, total_baht_gold, total_pcs, usd_value, lak_value, audit_balanced_pct) values
  ('2026-10-24', 1480.5, 1240, 3850000, 125200000000, 100);

-- ---------------------------------------------------------------------------
-- Branch safety-stock targets (Dashboard cluster chart + branch cards)
-- ---------------------------------------------------------------------------
insert into branch_targets (branch_id, current_baht, target_baht, health_state) values
  ('B-MM', 940, 1000, 'Optimal'),
  ('B-TS', 820, 1000, 'Restock Needed'),
  ('B-IT', 680, 1000, 'Restock Needed'),
  ('B-VT', 420, 1000, 'Alert');
