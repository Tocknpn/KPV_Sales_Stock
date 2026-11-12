import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, expectPgError } from './db';

let db: PGlite;
const D = '2026-01-10';

async function desk(id: string, date = D, branch = 'B-MM', seed = false) {
  await db.query(
    `insert into desks (desk_id, branch_id, display_name, is_seed) values ($1,$2,$1,$3) on conflict do nothing`,
    [id, branch, seed],
  );
  await db.query(`insert into desk_days (desk_id, ledger_date, branch_id) values ($1,$2,$3)`, [id, date, branch]);
}
async function ledger(id: string, cols: string, vals: number[], date = D) {
  const ph = vals.map((_, i) => `$${i + 4}`).join(',');
  return db.query(
    `insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, ${cols}) values ($1,$2,'B-MM',$3,${ph})`,
    [date, id, 'S1', ...vals],
  );
}

beforeEach(async () => {
  db = await freshDb({ withBase: true });
  await db.exec(`insert into master_sku (sku_id, name_en, category) values ('S1','Test','Rings')`);
});

describe('foundation migration', () => {
  it('refuses an insert with negative closing', async () => {
    await desk('MM-D01');
    await expectPgError(ledger('MM-D01', 'opening_qty, retail_sale', [1, 2]), 'NEGATIVE_CLOSING');
  });

  it('refuses an update that drops closing below zero', async () => {
    await desk('MM-D01');
    await ledger('MM-D01', 'opening_qty', [3]);
    await expectPgError(
      db.query(`update daily_stock_ledger set retail_sale = 4 where desk_id = 'MM-D01'`),
      'NEGATIVE_CLOSING',
    );
  });

  it('allows updating an already-negative row when closing does not drop', async () => {
    await desk('MM-D01');
    await db.exec(`alter table daily_stock_ledger disable trigger trg_ledger_guard_negative`);
    await ledger('MM-D01', 'opening_qty, retail_sale', [0, 2]);
    await db.exec(`alter table daily_stock_ledger enable trigger trg_ledger_guard_negative`);
    await db.query(`update daily_stock_ledger set counted_qty = 0 where desk_id = 'MM-D01'`);
    await expectPgError(
      db.query(`update daily_stock_ledger set retail_sale = 3 where desk_id = 'MM-D01'`),
      'NEGATIVE_CLOSING',
    );
  });

  it('refuses a desk day after Laos today', async () => {
    await db.query(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','x')`);
    await expectPgError(
      db.query(`insert into desk_days (desk_id, ledger_date, branch_id) values ('MM-D01','2999-01-01','B-MM')`),
      'FUTURE_DATE',
    );
  });

  it('marks a ledger row seed when its desk is seed', async () => {
    await desk('MM-D90', D, 'B-MM', true);
    await ledger('MM-D90', 'opening_qty', [1]);
    const r = await db.query<{ is_seed: boolean }>(`select is_seed from daily_stock_ledger where desk_id='MM-D90'`);
    expect(r.rows[0].is_seed).toBe(true);
  });

  it('marks a staff account seed when its branch is seed', async () => {
    await db.exec(`insert into branches (branch_id, name_en, is_seed) values ('B-SEED','Seed',true)`);
    await db.exec(
      `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ('B-SEED','a','x','staff')`,
    );
    const r = await db.query<{ is_seed: boolean }>(`select is_seed from staff_accounts`);
    expect(r.rows[0].is_seed).toBe(true);
  });

  it('Done lock allows deleting seed rows only while purging', async () => {
    await desk('MM-D90', D, 'B-MM', true);
    await desk('MM-D01');
    await ledger('MM-D90', 'opening_qty', [1]);
    await ledger('MM-D01', 'opening_qty', [1]);
    await db.exec(`update desk_days set status = 'done'`);
    await expectPgError(db.query(`delete from daily_stock_ledger where desk_id='MM-D90'`), 'DAY_LOCKED');
    await db.exec(`set kpv.purging = 'on'`);
    await db.query(`delete from daily_stock_ledger where desk_id='MM-D90'`);
    await expectPgError(db.query(`delete from daily_stock_ledger where desk_id='MM-D01'`), 'DAY_LOCKED');
  });
});
