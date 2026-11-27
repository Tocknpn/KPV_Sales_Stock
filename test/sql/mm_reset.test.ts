// Migration 21 (min stock) and the Morning Market reset script (2026-11-27).
import { describe, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, expectPgError } from './db';

const sqlFile = (...p: string[]) => readFileSync(join(process.cwd(), 'supabase', ...p), 'utf8');
const one = async <T = Record<string, unknown>>(db: PGlite, sql: string): Promise<T> => (await db.query<T>(sql)).rows[0];
const num = async (db: PGlite, sql: string) => Number(Object.values(await one<Record<string, unknown>>(db, sql))[0]);

describe('20261127_21_min_stock', () => {
  it('adds min_qty and detail, keeps old avg rows valid, and is safe to re-run', async () => {
    const db = await freshDb({ upTo: '20261125_20_size_units' });
    await db.exec(`insert into branches (branch_id, name_en) values ('B1', 'One');
      insert into sku_type (type_id, name_en) values ('T', 'T');
      insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days) values
        ('type', 'T', 'B1', 2, null), ('type', 'T2', 'B1', 1, 5);`);
    const migration = sqlFile('migrations', '20261127_21_min_stock.sql');
    await db.exec(migration);
    await db.exec(migration);
    // The avg-only rule says nothing any more and is gone; the one with a lead time stays.
    expect(await num(db, `select count(*) from replenishment_rule`)).toBe(1);
    await db.exec(`insert into replenishment_rule (scope, scope_key, branch_id, min_qty) values ('type', 'T', 'B1', 4)`);
    await expectPgError(db.exec(`insert into replenishment_rule (scope, scope_key, branch_id, min_qty) values ('sku', 'X', 'B1', -1)`), 'replenishment_rule_min_check');
    await expectPgError(db.exec(`insert into replenishment_rule (scope, scope_key, branch_id) values ('sku', 'Y', 'B1')`), 'replenishment_rule_value_check');
    await db.exec(`update master_sku set detail = 'ຍາວ15-17' where false`);
  });
});

describe('Morning Market reset', () => {
  it('backs up, empties every branch and loads the 7 cases from the workbook', async () => {
    const db = await freshDb({ withRoles: true, withBase: true });
    // Old data in another branch, with a Done day (normally locked).
    await db.exec(sqlFile('seed_mock_data.sql'));
    const before = await num(db, `select count(*) from daily_stock_ledger`);
    expect(before).toBeGreaterThan(0);
    const doneBefore = await num(db, `select count(*) from desk_days where status = 'done'`);
    expect(doneBefore).toBeGreaterThan(0);

    await db.exec(sqlFile('reset', '20261127_morning_market_reset.sql'));

    expect(await num(db, `select count(*) from kpv_backup_20261127.daily_stock_ledger`)).toBe(before);
    expect(await num(db, `select count(*) from desks`)).toBe(7);
    expect(await num(db, `select count(*) from master_sku`)).toBe(235);
    expect(await num(db, `select count(*) from sku_type`)).toBe(11);
    // Column E is the minimum, not the stock: every opening is 0.
    expect(await num(db, `select sum(opening_qty) from daily_stock_ledger`)).toBe(0);
    expect(await num(db, `select count(*) from daily_stock_ledger`)).toBe(235);
    expect(await num(db, `select count(*) from documents`)).toBe(0);
    expect(await num(db, `select count(*) from replenishment_rule where scope = 'sku' and branch_id = 'B-MM'`)).toBe(235);
    // ໂລ້ມີໂອ 5 ບາດ is listed twice in ຕູ້6 (3 and 3): the larger, not the sum.
    expect(await num(db, `select min_qty from replenishment_rule where scope_key = 'MM0219'`)).toBe(3);
    expect(await num(db, `select count(distinct branch_id) from daily_stock_ledger`)).toBe(1);
    // Minimums per case, as in the sheet.
    const perCase = (await db.query<{ display_name: string; pcs: string }>(
      `select d.display_name, sum(r.min_qty)::text as pcs from daily_stock_ledger l join desks d using (desk_id)
         join replenishment_rule r on r.scope = 'sku' and r.scope_key = l.sku_id and r.branch_id = l.branch_id
        group by d.display_name, d.sort_order order by d.sort_order`)).rows;
    expect(perCase.map((r) => [r.display_name, Number(r.pcs)])).toEqual([
      ['ຕູ້1', 2035], ['ຕູ້2', 885], ['ຕູ້3', 790], ['ຕູ້4', 552], ['ຕູ້5', 1370], ['ຕູ້6', 516], ['ຕູ້7', 230],
    ]);
    // Weights in Baht: ສາຍຄໍ 3.75 g = 0.25 ບາດ; ຄຳແທ່ງ 1 g = 1 ກລາມ.
    expect(await one(db, `select w.name_en, m.detail from master_sku m join sku_weight w using (weight_id) where m.name_lo = 'ເອັດຕັນ' and m.type_id = (select type_id from sku_type where name_lo = 'ສາຍຄໍ') order by w.gram_value limit 1`))
      .toEqual({ name_en: '0.25 ບາດ', detail: null });
    expect(await one(db, `select w.name_en from master_sku m join sku_weight w using (weight_id) where m.name_lo = 'ຄຳແທ່ງ' order by w.gram_value limit 1`))
      .toEqual({ name_en: '1 ກລາມ' });
    // Every case opened and checked in on 2026-11-27, with its frozen starting stock.
    expect((await db.query(`select distinct ledger_date::text as d, status from desk_days`)).rows).toEqual([{ d: '2026-11-27', status: 'check_in' }]);
    expect(await num(db, `select (initial_stock->>'total_pcs')::int from desks where desk_id = 'MM-D01'`)).toBe(0);
    expect(await num(db, `select count(*) from desks d, jsonb_object_keys(d.initial_stock->'skus')`)).toBe(235);
    // Guards are back on: a Done day is locked again.
    await db.exec(`update desk_days set status = 'done' where desk_id = 'MM-D07'`);
    await expectPgError(db.exec(`update daily_stock_ledger set stock_in = 1 where desk_id = 'MM-D07'`), 'DAY_LOCKED');
    expect(await one(db, `select action from audit_log where action = 'data.reset'`)).toEqual({ action: 'data.reset' });
  });
});

describe('Morning Market fix (openings to 0, minimums from column E)', () => {
  // The live database as the first reset left it: column E loaded as opening, no minimums.
  const oldLoad = async () => {
    const db = await freshDb({ withRoles: true, withBase: true });
    await db.exec(sqlFile('reset', '20261127_morning_market_reset.sql'));
    await db.exec(`delete from replenishment_rule;
      update daily_stock_ledger set opening_qty = 5;
      alter table desks disable trigger trg_desk_origin_immutable;
      update desks set initial_stock = jsonb_build_object('skus', (select jsonb_object_agg(k, 5) from jsonb_object_keys(initial_stock->'skus') k), 'total_pcs', 99, 'total_baht', 9);
      alter table desks enable trigger trg_desk_origin_immutable;
      insert into replenishment_rule (scope, scope_key, branch_id, lead_time_days) values ('sku', 'MM0001', 'B-MM', 3);`);
    return db;
  };
  const fix = sqlFile('reset', '20261127_mm_min_and_zero_opening.sql');

  it('zeroes openings and original stock, keeps today\'s entries, saves the minimums', async () => {
    const db = await oldLoad();
    await db.exec(`update daily_stock_ledger set stock_in = 7, retail_sale = 2 where sku_id = 'MM0002'`);
    await db.exec(fix);
    expect(await num(db, `select sum(opening_qty) from daily_stock_ledger`)).toBe(0);
    expect(await one(db, `select stock_in, retail_sale, closing_qty from daily_stock_ledger where sku_id = 'MM0002'`))
      .toEqual({ stock_in: 7, retail_sale: 2, closing_qty: 5 });
    expect(await num(db, `select sum((initial_stock->>'total_pcs')::int) from desks`)).toBe(0);
    expect(await num(db, `select count(*) from replenishment_rule where min_qty is not null`)).toBe(235);
    expect(await num(db, `select min_qty from replenishment_rule where scope_key = 'MM0219'`)).toBe(3);
    // A lead time set before is kept.
    expect(await one(db, `select min_qty, lead_time_days::int as lead from replenishment_rule where scope_key = 'MM0001'`)).toEqual({ min_qty: 30, lead: 3 });
    // The origin lock is back on.
    await expectPgError(db.exec(`update desks set initial_stock = '{"skus":{},"total_pcs":1,"total_baht":0}' where desk_id = 'MM-D01'`), 'INITIAL_IMMUTABLE');
    expect(await one(db, `select action from audit_log where action = 'data.min_reset'`)).toEqual({ action: 'data.min_reset' });
  });

  it('refuses, changing nothing, when sales are not covered by Stock-in', async () => {
    const db = await oldLoad();
    await db.exec(`update daily_stock_ledger set retail_sale = 3 where sku_id = 'MM0003'`);
    await expectPgError(db.exec(fix), 'MM_FIX_NEGATIVE');
    await db.exec('rollback');
    expect(await num(db, `select sum(opening_qty) from daily_stock_ledger`)).toBe(5 * 235);
  });

  it('refuses when a case day is already closed', async () => {
    const db = await oldLoad();
    await db.exec(`update desk_days set status = 'done' where desk_id = 'MM-D07'`);
    await expectPgError(db.exec(fix), 'MM_FIX_BLOCKED');
  });
});
