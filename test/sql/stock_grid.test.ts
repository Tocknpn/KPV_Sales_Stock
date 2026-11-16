// Migration 11: stock-out mode + Move in/out.
import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;
const D = '2026-01-10';
const ACTOR = '11111111-1111-1111-1111-111111111111';

async function apply(changes: unknown[]) {
  const r = await db.query<{ r: any }>(`select ledger_apply($1::date, 'MM-D01', 'S1', $2::jsonb) as r`, [D, JSON.stringify(changes)]);
  return r.rows[0].r;
}
const stored = async () => (await db.query<any>(`select * from daily_stock_ledger where desk_id = 'MM-D01' and sku_id = 'S1'`)).rows[0];

beforeEach(async () => {
  db = await freshDb({ withBase: true });
  await db.exec(`insert into master_sku (sku_id, name_en, category) values ('S1','Test','Rings')`);
  await db.query(`insert into staff_accounts (id, display_name, pin_hash, role) values ($1,'Tester','x','admin')`, [ACTOR]);
  await asActor(db, ACTOR);
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','x'), ('MM-D02','B-MM','y')`);
});

async function openDay(desk = 'MM-D01') {
  await db.query(`insert into desk_days (desk_id, ledger_date, branch_id) values ($1,$2,'B-MM')`, [desk, D]);
  await db.query(
    `insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty, retail_sale) values ($1,$2,'B-MM','S1',10,2)`,
    [D, desk],
  );
}

describe('stock-out mode stamp', () => {
  it('a new day takes the company setting of that moment and keeps it', async () => {
    await openDay('MM-D01');
    await db.exec(`update system_config set stock_out_mode = 'single' where id = 1`);
    await openDay('MM-D02');
    const modes = (await db.query<any>(`select desk_id, stock_out_mode from desk_days order by desk_id`)).rows;
    expect(modes).toEqual([
      { desk_id: 'MM-D01', stock_out_mode: 'dynamic' },
      { desk_id: 'MM-D02', stock_out_mode: 'single' },
    ]);
  });

  it('rejects an unknown mode', async () => {
    await expectPgError(db.exec(`update system_config set stock_out_mode = 'both' where id = 1`), 'stock_out_mode');
  });
});

describe('closing formula and stock_out', () => {
  beforeEach(() => openDay());

  it('stock_out is retail + wholesale + destock + the single total', async () => {
    expect((await apply([{ field: 'wholesale', to: 1 }, { field: 'stock_out_single', to: 3 }])).ok).toBe(true);
    const row = await stored();
    expect(row.stock_out).toBe(6);
    expect(row.closing_qty).toBe(4);
  });

  it('move_qty is signed and changes closing both ways', async () => {
    await apply([{ field: 'move_qty', to: -3 }]);
    expect((await stored()).closing_qty).toBe(5);
    await apply([{ field: 'move_qty', to: 4 }]);
    expect((await stored()).closing_qty).toBe(12);
  });

  it('the negative guard uses the new formula', async () => {
    await expectPgError(apply([{ field: 'move_qty', to: -9 }]), 'NEGATIVE_CLOSING');
    await expectPgError(apply([{ field: 'stock_out_single', to: 9 }]), 'NEGATIVE_CLOSING');
  });

  it('ledger_latest exposes the new columns', async () => {
    await apply([{ field: 'move_qty', to: 2 }]);
    const row = (await db.query<any>(`select move_qty, stock_out, closing_qty from ledger_latest where desk_id = 'MM-D01'`)).rows[0];
    expect(row).toEqual({ move_qty: 2, stock_out: 2, closing_qty: 10 });
  });
});

describe('re-running the migration', () => {
  it('keeps every closing as it was', async () => {
    await openDay();
    await apply([{ field: 'move_qty', to: -1 }]);
    const { readFileSync } = await import('node:fs');
    await db.exec(readFileSync('supabase/migrations/20261116_11_stock_grid_modes.sql', 'utf8'));
    expect((await stored()).closing_qty).toBe(7);
  });
});
