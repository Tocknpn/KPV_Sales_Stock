import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor } from './db';

let db: PGlite;
const D = '2026-01-10';
const ACTOR = '11111111-1111-1111-1111-111111111111';
const REF1 = '00000000-0000-0000-0000-0000000000a1';
const REF2 = '00000000-0000-0000-0000-0000000000a2';
const REF3 = '00000000-0000-0000-0000-0000000000a3';

async function move(lines: unknown[], ref = REF1, from = 'MM-D01', to = 'MM-D02', date = D) {
  const r = await db.query<{ r: any }>(`select move_stock($1::date, $2, $3, $4::jsonb, $5::uuid, null) as r`, [date, from, to, JSON.stringify(lines), ref]);
  return r.rows[0].r;
}
const undo = async (ticket: string, ref: string) =>
  (await db.query<{ r: any }>(`select undo_move($1::uuid, $2::uuid) as r`, [ticket, ref])).rows[0].r;
const ledger = async (desk: string, sku: string) =>
  (await db.query<any>(`select * from daily_stock_ledger where desk_id = $1 and sku_id = $2 and ledger_date = $3`, [desk, sku, D])).rows[0];
const transferCount = async () => Number((await db.query<any>(`select count(*)::int as n from transfers`)).rows[0].n);

beforeEach(async () => {
  db = await freshDb({ withBase: true });
  await db.exec(`insert into master_sku (sku_id, name_en, category) values ('S1','One','Rings'), ('S2','Two','Rings')`);
  await db.query(`insert into staff_accounts (id, display_name, pin_hash, role) values ($1,'Tester','x','admin')`, [ACTOR]);
  await asActor(db, ACTOR);
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','a'),('MM-D02','B-MM','b'),('TS-D01','B-TS','c')`);
  await db.query(`insert into desk_days (desk_id, ledger_date, branch_id) values ('MM-D01',$1,'B-MM'),('MM-D02',$1,'B-MM'),('TS-D01',$1,'B-TS')`, [D]);
  await db.query(
    `insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty) values
       ($1,'MM-D01','B-MM','S1',10), ($1,'MM-D01','B-MM','S2',3), ($1,'MM-D02','B-MM','S1',1)`,
    [D],
  );
});

describe('move_stock', () => {
  it('moves stock between two open cases in one transaction', async () => {
    const res = await move([{ sku_id: 'S1', qty: 4 }]);
    expect(res.ok).toBe(true);
    expect(res.ticket_id).toBeTruthy();
    expect(res.moves).toHaveLength(1);
    const a = await ledger('MM-D01', 'S1');
    const b = await ledger('MM-D02', 'S1');
    expect(a.move).toBe(4);
    expect(a.closing_qty).toBe(6);
    expect(b.transfer_in).toBe(4);
    expect(b.closing_qty).toBe(5);
    const t = (await db.query<any>(`select * from transfers`)).rows[0];
    expect(t).toMatchObject({ kind: 'move', status: 'received', qty: 4, sent_by: ACTOR, received_by: ACTOR, client_ref: REF1 });
    expect(String(t.received_date.toISOString?.() ?? t.received_date)).toContain('2026-01-10');
  });

  it('creates the destination row when the case never held the item', async () => {
    expect((await move([{ sku_id: 'S2', qty: 3 }])).ok).toBe(true);
    const b = await ledger('MM-D02', 'S2');
    expect(b).toMatchObject({ opening_qty: 0, transfer_in: 3, closing_qty: 3 });
    expect((await ledger('MM-D01', 'S2')).closing_qty).toBe(0);
  });

  it('refuses more than available and writes nothing', async () => {
    const res = await move([{ sku_id: 'S1', qty: 11 }]);
    expect(res).toEqual({ ok: false, code: 'NOT_ENOUGH_STOCK', sku_id: 'S1', available: 10 });
    expect((await ledger('MM-D01', 'S1')).move).toBe(0);
    expect(await transferCount()).toBe(0);
  });

  it('multi-line ticket is all-or-nothing', async () => {
    const res = await move([{ sku_id: 'S1', qty: 2 }, { sku_id: 'S2', qty: 4 }]);
    expect(res).toMatchObject({ ok: false, code: 'NOT_ENOUGH_STOCK', sku_id: 'S2', available: 3 });
    expect((await ledger('MM-D01', 'S1')).move).toBe(0);
    expect((await ledger('MM-D02', 'S1')).transfer_in).toBe(0);
    expect(await transferCount()).toBe(0);

    const ok = await move([{ sku_id: 'S1', qty: 2 }, { sku_id: 'S2', qty: 3 }], REF2);
    expect(ok.ok).toBe(true);
    const rows = (await db.query<any>(`select ticket_id, client_ref from transfers`)).rows;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: any) => r.ticket_id)).size).toBe(1);
    expect(rows.filter((r: any) => r.client_ref === REF2)).toHaveLength(1);
  });

  it('same client_ref replays without a second effect', async () => {
    const first = await move([{ sku_id: 'S1', qty: 2 }]);
    const again = await move([{ sku_id: 'S1', qty: 2 }]);
    expect(again).toMatchObject({ ok: true, replayed: true, ticket_id: first.ticket_id });
    expect((await ledger('MM-D01', 'S1')).move).toBe(2);
    expect(await transferCount()).toBe(1);
  });

  it('refuses when the destination day is Done', async () => {
    await db.query(`update desk_days set status = 'done' where desk_id = 'MM-D02'`);
    expect(await move([{ sku_id: 'S1', qty: 1 }])).toMatchObject({ ok: false, code: 'DEST_DAY_LOCKED' });
    expect(await transferCount()).toBe(0);
  });

  it('refuses a Done source, a missing day, other branches and the same desk', async () => {
    await db.query(`update desk_days set status = 'done' where desk_id = 'MM-D01'`);
    expect(await move([{ sku_id: 'S1', qty: 1 }])).toMatchObject({ ok: false, code: 'DAY_LOCKED' });
    await db.query(`update desk_days set status = 'check_in' where desk_id = 'MM-D01'`);
    expect(await move([{ sku_id: 'S1', qty: 1 }], REF1, 'MM-D01', 'TS-D01')).toMatchObject({ ok: false, code: 'OTHER_BRANCH' });
    expect(await move([{ sku_id: 'S1', qty: 1 }], REF1, 'MM-D01', 'MM-D01')).toMatchObject({ ok: false, code: 'SAME_DESK' });
    expect(await move([{ sku_id: 'S1', qty: 1 }], REF1, 'MM-D01', 'MM-D02', '2026-01-09')).toMatchObject({ ok: false, code: 'NOT_CHECKED_IN' });
    expect(await transferCount()).toBe(0);
  });

  it('refuses bad quantities', async () => {
    expect(await move([{ sku_id: 'S1', qty: 0 }])).toMatchObject({ ok: false, code: 'BAD_QTY' });
    expect(await move([])).toMatchObject({ ok: false, code: 'BAD_QTY' });
  });

  it('is callable by service_role only', async () => {
    const r = await db.query<any>(
      `select has_function_privilege('anon','move_stock(date,text,text,jsonb,uuid,text)','execute') as a,
              has_function_privilege('authenticated','undo_move(uuid,uuid)','execute') as p,
              has_function_privilege('service_role','move_stock(date,text,text,jsonb,uuid,text)','execute') as s,
              has_function_privilege('service_role','undo_move(uuid,uuid)','execute') as u`,
    );
    expect(r.rows[0]).toMatchObject({ a: false, p: false, s: true, u: true });
  });
});

describe('undo_move', () => {
  it('undo reverses and cannot be undone twice', async () => {
    const first = await move([{ sku_id: 'S1', qty: 4 }]);
    const res = await undo(first.ticket_id, REF2);
    expect(res.ok).toBe(true);
    expect(res.ticket_id).not.toBe(first.ticket_id);
    expect((await ledger('MM-D01', 'S1')).closing_qty).toBe(10);
    expect((await ledger('MM-D02', 'S1')).closing_qty).toBe(1);
    const originals = (await db.query<any>(`select id from transfers where ticket_id = $1`, [first.ticket_id])).rows;
    const reversed = (await db.query<any>(`select reverses_id from transfers where ticket_id = $1`, [res.ticket_id])).rows;
    expect(reversed.map((r: any) => r.reverses_id)).toEqual(originals.map((r: any) => r.id));

    expect(await undo(first.ticket_id, REF3)).toMatchObject({ ok: false, code: 'ALREADY_UNDONE' });
    // the same client_ref replays the first undo
    expect(await undo(first.ticket_id, REF2)).toMatchObject({ ok: true, replayed: true, ticket_id: res.ticket_id });
    expect(await transferCount()).toBe(2);
  });

  it('undo after the destination used the pieces is refused and changes nothing', async () => {
    const first = await move([{ sku_id: 'S2', qty: 3 }]);
    await db.query(`update daily_stock_ledger set retail_sale = 2 where desk_id = 'MM-D02' and sku_id = 'S2'`);
    expect(await undo(first.ticket_id, REF2)).toMatchObject({ ok: false, code: 'NOT_ENOUGH_STOCK', sku_id: 'S2', available: 1 });
    expect(await transferCount()).toBe(1);
    expect((await ledger('MM-D01', 'S2')).move).toBe(3);
  });

  it('undo is refused when a day is Done, and for unknown tickets', async () => {
    const first = await move([{ sku_id: 'S1', qty: 1 }]);
    await db.query(`update desk_days set status = 'done' where desk_id = 'MM-D01'`);
    expect(await undo(first.ticket_id, REF2)).toMatchObject({ ok: false, code: 'DEST_DAY_LOCKED' });
    expect(await undo('00000000-0000-0000-0000-0000000000ff', REF3)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a second undo of the same ticket is refused, and a unique index backs it', async () => {
    const first = await move([{ sku_id: 'S1', qty: 2 }]);
    expect((await undo(first.ticket_id, REF2)).ok).toBe(true);
    expect(await undo(first.ticket_id, REF3)).toMatchObject({ ok: false, code: 'ALREADY_UNDONE' });
    // bypass undo_move's own pre-check: the check under the lock still refuses
    const direct = await db.query<{ r: any }>(
      `select kpv_move_stock($1::date, 'MM-D02', 'MM-D01', '[{"sku_id":"S1","qty":2}]'::jsonb, $2::uuid, null, $3::uuid) as r`,
      [D, REF3, first.ticket_id],
    );
    expect(direct.rows[0].r).toMatchObject({ ok: false, code: 'ALREADY_UNDONE' });
    const idx = await db.query<any>(`select indexdef from pg_indexes where indexname = 'uq_transfers_reverses'`);
    expect(idx.rows[0].indexdef).toContain('UNIQUE');
    expect(await transferCount()).toBe(2);
  });
});
