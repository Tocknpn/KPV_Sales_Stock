import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;
const D = '2026-01-10';
const ACTOR = '11111111-1111-1111-1111-111111111111';

async function apply(changes: unknown[], sku = 'S1') {
  const r = await db.query<{ r: any }>(`select ledger_apply($1::date, 'MM-D01', $2, $3::jsonb) as r`, [D, sku, JSON.stringify(changes)]);
  return r.rows[0].r;
}
const stored = async () =>
  (await db.query<any>(`select * from daily_stock_ledger where desk_id = 'MM-D01' and sku_id = 'S1'`)).rows[0];

beforeEach(async () => {
  db = await freshDb({ withBase: true });
  await db.exec(`insert into master_sku (sku_id, name_en, category) values ('S1','Test','Rings')`);
  await db.query(`insert into staff_accounts (id, display_name, pin_hash, role) values ($1,'Tester','x','admin')`, [ACTOR]);
  await asActor(db, ACTOR);
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','x')`);
  await db.query(`insert into desk_days (desk_id, ledger_date, branch_id) values ('MM-D01',$1,'B-MM')`, [D]);
  await db.query(
    `insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty, retail_sale) values ($1,'MM-D01','B-MM','S1',10,2)`,
    [D],
  );
});

describe('ledger_apply', () => {
  it('applies a change when from matches', async () => {
    const res = await apply([{ field: 'retail_sale', from: 2, to: 4 }, { field: 'counted_note', from: null, to: 'hi' }]);
    expect(res.ok).toBe(true);
    expect(res.row.retail_sale).toBe(4);
    expect(res.row.closing_qty).toBe(6);
    expect((await stored()).counted_note).toBe('hi');
    expect((await stored()).performed_by).toBe(ACTOR);
  });

  it('returns ROW_CHANGED with the row when from is stale', async () => {
    const res = await apply([{ field: 'stock_in', from: 0, to: 1 }, { field: 'retail_sale', from: 1, to: 5 }]);
    expect(res).toMatchObject({ ok: false, code: 'ROW_CHANGED' });
    expect(res.row.retail_sale).toBe(2);
    // nothing was written, not even the change that matched
    expect((await stored()).stock_in).toBe(0);
  });

  it('treats stored == to as success (retry)', async () => {
    const res = await apply([{ field: 'retail_sale', from: 1, to: 2 }]);
    expect(res.ok).toBe(true);
    expect((await stored()).retail_sale).toBe(2);
  });

  it('applies a change with no from unconditionally', async () => {
    expect((await apply([{ field: 'wholesale', to: 3 }])).ok).toBe(true);
    expect((await stored()).wholesale).toBe(3);
  });

  it('refuses a field outside the list', async () => {
    await expectPgError(apply([{ field: 'opening_qty', from: 10, to: 99 }]), 'not allowed');
    await expectPgError(apply([{ field: 'transfer_out', to: 1 }]), 'not allowed');
  });

  it('negative result raises NEGATIVE_CLOSING', async () => {
    await expectPgError(apply([{ field: 'retail_sale', from: 2, to: 11 }]), 'NEGATIVE_CLOSING: available 8');
  });

  it('returns ROW_NOT_FOUND for a missing row', async () => {
    expect(await apply([{ field: 'wholesale', to: 1 }], 'NOPE')).toEqual({ ok: false, code: 'ROW_NOT_FOUND' });
  });

  it('is callable by service_role only', async () => {
    const r = await db.query<{ p: string; a: boolean; s: boolean }>(
      `select has_function_privilege('anon','ledger_apply(date,text,text,jsonb)','execute') as a,
              has_function_privilege('authenticated','ledger_apply(date,text,text,jsonb)','execute') as p,
              has_function_privilege('service_role','ledger_apply(date,text,text,jsonb)','execute') as s`,
    );
    expect(r.rows[0]).toMatchObject({ a: false, p: false, s: true });
  });
});
