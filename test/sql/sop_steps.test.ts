// Migration 17: withdraw column, opening status, reopen-from function.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;
const D1 = '2026-01-10';
const D2 = '2026-01-11';
const D3 = '2026-01-12';
const ACTOR = '11111111-1111-1111-1111-111111111111';

async function apply(date: string, changes: unknown[]) {
  const r = await db.query<{ r: any }>(`select ledger_apply($1::date, 'MM-D01', 'S1', $2::jsonb) as r`, [date, JSON.stringify(changes)]);
  return r.rows[0].r;
}
const stored = async (date = D1) =>
  (await db.query<any>(`select * from daily_stock_ledger where desk_id = 'MM-D01' and sku_id = 'S1' and ledger_date = $1`, [date])).rows[0];

async function openDay(date: string, status = 'opening', opening = 10) {
  await db.query(`insert into desk_days (desk_id, ledger_date, branch_id, status) values ('MM-D01',$1,'B-MM',$2)`, [date, status]);
  await db.query(
    `insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty) values ($1,'MM-D01','B-MM','S1',$2)`,
    [date, opening],
  );
}

beforeEach(async () => {
  db = await freshDb({ withBase: true });
  await db.exec(`insert into master_sku (sku_id, name_en, category) values ('S1','Test','Rings')`);
  await db.query(`insert into staff_accounts (id, display_name, pin_hash, role) values ($1,'Tester','x','admin')`, [ACTOR]);
  await asActor(db, ACTOR);
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','x')`);
});

describe('withdraw', () => {
  it('lowers closing and counts in stock_out', async () => {
    await openDay(D1);
    expect((await apply(D1, [
      { field: 'stock_in', to: 2 }, { field: 'retail_sale', to: 1 }, { field: 'wholesale', to: 1 },
      { field: 'destock', to: 1 }, { field: 'withdraw', to: 3 },
    ])).ok).toBe(true);
    const row = await stored();
    expect(row.closing_qty).toBe(6);
    expect(row.stock_out).toBe(6);
  });

  it('cannot be negative', async () => {
    await openDay(D1);
    await expectPgError(db.exec(`update daily_stock_ledger set withdraw = -1 where desk_id = 'MM-D01'`), 'withdraw');
  });

  it('negative guard includes withdraw', async () => {
    await openDay(D1, 'opening', 2);
    await expectPgError(apply(D1, [{ field: 'withdraw', to: 3 }]), 'NEGATIVE_CLOSING');
  });

  it('ledger_apply sets withdraw and opening_qty', async () => {
    await openDay(D1);
    const r = await apply(D1, [{ field: 'opening_qty', to: 12 }, { field: 'withdraw', to: 4 }]);
    expect(r.ok).toBe(true);
    expect(r.row.withdraw).toBe(4);
    expect(r.row.opening_qty).toBe(12);
    expect(r.row.closing_qty).toBe(8);
  });
});

describe('opening status', () => {
  it('a new desk_day defaults to opening; opening is allowed; junk is not', async () => {
    await db.query(`insert into desk_days (desk_id, ledger_date, branch_id) values ('MM-D01',$1,'B-MM')`, [D1]);
    expect((await db.query<any>(`select status from desk_days`)).rows[0].status).toBe('opening');
    await expectPgError(db.exec(`update desk_days set status = 'bogus'`), 'status');
  });
});

describe('desk_reopen_from', () => {
  it('reopens the day and every later day, clears done stamps and counts', async () => {
    const D0 = '2026-01-09';
    for (const d of [D0, D1, D2]) await openDay(d, 'check_in');
    await openDay(D3, 'check_in');
    await db.exec(`update daily_stock_ledger set counted_qty = 5, counted_note = 'n'`);
    await db.exec(`update desk_days set status = 'done', done_by = '${ACTOR}', done_at = now() where ledger_date in ('${D0}','${D1}','${D2}')`);

    const r = await db.query<any>(`select * from desk_reopen_from('MM-D01', $1::date)`, [D1]);
    expect(r.rows.map((x: any) => String(x.desk_reopen_from instanceof Date ? x.desk_reopen_from.toISOString().slice(0, 10) : x.desk_reopen_from)).sort())
      .toEqual([D1, D2, D3]);

    const days = (await db.query<any>(`select ledger_date::text d, status, done_by, done_at from desk_days order by ledger_date`)).rows;
    expect(days.map((x: any) => x.status)).toEqual(['done', 'opening', 'opening', 'opening']);
    for (const x of days.slice(1)) { expect(x.done_by).toBeNull(); expect(x.done_at).toBeNull(); }
    expect(days[0].done_by).toBe(ACTOR);

    const rows = (await db.query<any>(`select ledger_date::text d, counted_qty, counted_note from daily_stock_ledger order by ledger_date`)).rows;
    expect(rows[0].counted_qty).toBe(5);
    for (const x of rows.slice(1)) { expect(x.counted_qty).toBeNull(); expect(x.counted_note).toBeNull(); }
  });
});

describe('desk_reopen_from compare-and-set', () => {
  it('a day that is not Done returns no rows and changes nothing', async () => {
    await openDay(D1, 'check_in');
    await openDay(D2, 'check_in');
    await db.exec(`update daily_stock_ledger set counted_qty = 5, counted_note = 'n'`);
    const r = await db.query<any>(`select * from desk_reopen_from('MM-D01', $1::date)`, [D1]);
    expect(r.rows).toHaveLength(0);
    const rows = (await db.query<any>(`select counted_qty, counted_note from daily_stock_ledger`)).rows;
    for (const x of rows) { expect(x.counted_qty).toBe(5); expect(x.counted_note).toBe('n'); }
    expect((await db.query<any>(`select status from desk_days order by ledger_date`)).rows.map((x: any) => x.status)).toEqual(['check_in', 'check_in']);
    expect((await db.query<any>(`select * from desk_reopen_from('MM-D01', '2000-01-01'::date)`)).rows).toHaveLength(0);
  });
});

describe('branch_velocity', () => {
  it('counts withdraw as sold, not destock', async () => {
    for (let i = 1; i <= 8; i++) {
      const d = `2026-02-${String(i).padStart(2, '0')}`;
      await openDay(d, 'check_in', 20);
      await apply(d, [{ field: 'withdraw', to: 2 }, { field: 'destock', to: 5 }, { field: 'retail_sale', to: 1 }]);
      await db.query(`update desk_days set status = 'done' where ledger_date = $1`, [d]);
    }
    const r = await db.query<any>(`select * from branch_velocity('B-MM', '2026-02-09'::date, 8)`);
    expect(r.rows[0].sold).toBe(24);
    expect(r.rows[0].in_stock_days).toBe(8);
  });
});

describe('migration re-run', () => {
  it('is a no-op the second time', async () => {
    const sql = readFileSync('supabase/migrations/20261118_17_sop_steps.sql', 'utf8');
    await db.exec(sql);
    await openDay(D1);
    await apply(D1, [{ field: 'withdraw', to: 1 }]);
    expect((await stored()).closing_qty).toBe(9);
  });
});
