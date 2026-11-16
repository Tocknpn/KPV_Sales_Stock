import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;

const history = async () =>
  (await db.query<{ d: string; sell: string }>(
    `select price_date::text d, price_baht_sell::text sell from gold_price_history order by price_date`)).rows;

beforeEach(async () => {
  db = await freshDb({ withRoles: true, withBase: true });
  await asActor(db, null, { jwtRole: 'postgres' });
});

describe('gold price history', () => {
  it('snapshot_on_update: same-day updates keep one row with the latest price', async () => {
    await db.exec(`insert into gold_prices (id, price_baht_sell, updated_at) values (1, 43230000, '2026-11-16 02:00+00')`);
    await db.exec(`update gold_prices set price_baht_sell = 43300000, updated_at = '2026-11-16 03:00+00' where id = 1`);
    expect(await history()).toEqual([{ d: '2026-11-16', sell: '43300000' }]);
  });

  it('snapshot_new_day: a new Laos day adds a row', async () => {
    await db.exec(`insert into gold_prices (id, price_baht_sell, updated_at) values (1, 43230000, '2026-11-16 02:00+00')`);
    await db.exec(`update gold_prices set price_baht_sell = 43400000, updated_at = '2026-11-17 02:00+00' where id = 1`);
    expect((await history()).map((r) => r.d)).toEqual(['2026-11-16', '2026-11-17']);
  });
});

describe('frozen case origin', () => {
  it('origin_immutable: set once, never changed', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','A')`);
    await db.exec(`update desks set initial_stock = '{"skus":{"RG-031":3},"total_pcs":3,"total_baht":0}' where desk_id = 'MM-D01'`);
    // identical re-write is allowed
    await db.exec(`update desks set initial_stock = '{"skus":{"RG-031":3},"total_pcs":3,"total_baht":0}' where desk_id = 'MM-D01'`);
    await expectPgError(
      db.query(`update desks set initial_stock = '{"skus":{"RG-031":4},"total_pcs":4,"total_baht":0}' where desk_id = 'MM-D01'`),
      'INITIAL_IMMUTABLE');
    const u = await db.query<{ id: string }>(
      `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ('B-MM','U','h','staff') returning id`);
    await db.query(`update desks set created_by = $1 where desk_id = 'MM-D01'`, [u.rows[0].id]);
    await expectPgError(db.query(`update desks set created_by = null where desk_id = 'MM-D01'`), 'INITIAL_IMMUTABLE');
  });

  it('backfill_from_audit: desk.create audit row supplies creator and opening', async () => {
    const u = await db.query<{ id: string }>(
      `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ('B-MM','U','h','staff') returning id`);
    const U = u.rows[0].id;
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','A')`);
    await db.query(
      `insert into audit_log (actor_id, actor_name, action, target, detail)
       values ($1, 'U', 'desk.create', 'MM-D01', '{"display_name":"A","opening":{"RG-031":3}}'::jsonb)`, [U]);
    await db.exec(`select kpv_backfill_desk_origin()`);
    const r = await db.query<{ created_by: string; initial_stock: any }>(
      `select created_by, initial_stock from desks where desk_id = 'MM-D01'`);
    expect(r.rows[0].created_by).toBe(U);
    expect(r.rows[0].initial_stock.skus).toEqual({ 'RG-031': 3 });
    expect(r.rows[0].initial_stock.total_pcs).toBe(3);
  });

  it('backfill_from_first_day: no audit row -> earliest day opening_qty, created_by null', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D02','B-MM','B')`);
    await db.exec(`insert into master_sku (sku_id, name_en, category, baht_weight) values ('S1','s1','x',1.5), ('S2','s2','x',0.5)`);
    await db.exec(`insert into desk_days (desk_id, ledger_date, branch_id) values ('MM-D02','2026-11-10','B-MM'), ('MM-D02','2026-11-11','B-MM')`);
    await db.exec(`insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty) values
      ('2026-11-10','MM-D02','B-MM','S1',2), ('2026-11-10','MM-D02','B-MM','S2',4), ('2026-11-11','MM-D02','B-MM','S1',9)`);
    await db.exec(`select kpv_backfill_desk_origin()`);
    const r = await db.query<{ created_by: string | null; initial_stock: any }>(
      `select created_by, initial_stock from desks where desk_id = 'MM-D02'`);
    expect(r.rows[0].created_by).toBeNull();
    expect(r.rows[0].initial_stock.skus).toEqual({ S1: 2, S2: 4 });
    expect(r.rows[0].initial_stock.total_pcs).toBe(6);
    expect(Number(r.rows[0].initial_stock.total_baht)).toBe(5);
  });
});

describe('case origin edge cases', () => {
  it('no audit row and no first-day ledger rows keeps origin null', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D03','B-MM','C')`);
    await db.exec(`select kpv_backfill_desk_origin()`);
    const r = await db.query<{ created_by: string | null; initial_stock: unknown }>(
      `select created_by, initial_stock from desks where desk_id = 'MM-D03'`);
    expect(r.rows[0].created_by).toBeNull();
    expect(r.rows[0].initial_stock).toBeNull();
  });

  it('audit opening skips non-numeric and non-positive entries without aborting', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D04','B-MM','D')`);
    await db.exec(`insert into audit_log (actor_name, action, target, detail) values
      ('x','desk.create','MM-D04','{"opening":{"A":2,"B":"x","C":0,"D":1.5,"E":-1}}'::jsonb)`);
    await db.exec(`select kpv_backfill_desk_origin()`);
    const r = await db.query<{ initial_stock: any }>(`select initial_stock from desks where desk_id = 'MM-D04'`);
    expect(r.rows[0].initial_stock.skus).toEqual({ A: 2 });
    expect(r.rows[0].initial_stock.total_pcs).toBe(2);
  });

  it('re-running the backfill leaves a set initial_stock unchanged', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name, initial_stock)
      values ('MM-D05','B-MM','E','{"skus":{"Z":1},"total_pcs":1,"total_baht":0}')`);
    await db.exec(`insert into audit_log (actor_name, action, target, detail) values
      ('x','desk.create','MM-D05','{"opening":{"Y":9}}'::jsonb)`);
    await db.exec(`select kpv_backfill_desk_origin()`);
    const r = await db.query<{ initial_stock: any }>(`select initial_stock from desks where desk_id = 'MM-D05'`);
    expect(r.rows[0].initial_stock.skus).toEqual({ Z: 1 });
  });

  it('null updated_at snapshots under kpv_today()', async () => {
    await db.exec(`insert into gold_prices (id, price_baht_sell, updated_at) values (1, 43000000, null)`);
    const r = await db.query<{ ok: boolean }>(`select bool_and(price_date = kpv_today()) ok from gold_price_history`);
    expect(r.rows[0].ok).toBe(true);
  });

  it('audit opening all invalid falls back to the first-day ledger', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D06','B-MM','F')`);
    await db.exec(`insert into master_sku (sku_id, name_en, category, baht_weight) values ('S1','s1','x',1)`);
    await db.exec(`insert into desk_days (desk_id, ledger_date, branch_id) values ('MM-D06','2026-11-10','B-MM')`);
    await db.exec(`insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty) values ('2026-11-10','MM-D06','B-MM','S1',3)`);
    await db.exec(`insert into audit_log (actor_name, action, target, detail) values
      ('x','desk.create','MM-D06','{"opening":{"A":0}}'::jsonb)`);
    await db.exec(`select kpv_backfill_desk_origin()`);
    const r = await db.query<{ initial_stock: any }>(`select initial_stock from desks where desk_id = 'MM-D06'`);
    expect(r.rows[0].initial_stock.skus).toEqual({ S1: 3 });
  });
});
