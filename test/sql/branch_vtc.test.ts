import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asActor, expectPgError } from './db';

const migration = () => readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261117_16_branch_vtc.sql'), 'utf8');

// A database as it was before migration 16: the old branch list, with Talat
// Sao (B-TS) holding a case, a staff account, a done day, a transfer, a
// document, a rule, a closed day and audit history.
async function oldDb() {
  const db = await freshDb({ upTo: '20261117_15_branch_sku', withRoles: true });
  await asActor(db, null, { jwtRole: 'postgres' });
  await db.exec(`
    insert into branches (branch_id, name_en, name_lo, sort_order) values
      ('B-MM', 'Morning Market', 'ຕະຫຼາດເຊົ້າ', 1), ('B-TS', 'Talat Sao', 'ຕະຫຼາດສາວ', 2),
      ('B-IT', 'ITECC', 'ໄອເທັກ', 3), ('B-VT', 'Vangthong', 'ວັງທອງ', 4);
    insert into sku_type (type_id, name_en, name_lo) values ('GOLD_BARS', 'Gold Bars', 'ທອງຄຳແທ່ງ');
    insert into master_sku (sku_id, name_en, name_lo, category, type_id) values ('BAR-1B', 'Gold Bar', 'ຄຳແທ່ງ', 'Gold Bars', 'GOLD_BARS');
    insert into desks (desk_id, branch_id, display_name) values ('MM-D01', 'B-MM', 'A'), ('TS-D01', 'B-TS', 'A'), ('TS-D02', 'B-TS', 'B');
  `);
  const staff = (await db.query<{ id: string }>(
    `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ('B-TS', 'Tom', 'h', 'staff') returning id`)).rows[0].id;
  await db.query(`select * from assign_desk('TS-D01', $1, null)`, [staff]);
  await db.exec(`
    insert into desk_days (desk_id, ledger_date, branch_id) values ('TS-D01', current_date - 2, 'B-TS');
    insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty) values (current_date - 2, 'TS-D01', 'B-TS', 'BAR-1B', 5);
    update desk_days set status = 'done' where desk_id = 'TS-D01';
    insert into transfers (kind, from_desk_id, from_branch_id, to_desk_id, to_branch_id, sku_id, qty, sent_date)
      values ('transfer', 'TS-D01', 'B-TS', 'MM-D01', 'B-MM', 'BAR-1B', 1, current_date - 2);
    insert into doc_counters (branch_id, year, last_seq) values ('B-TS', 2026, 7);
    insert into documents (doc_no, title, branch_id, desk_id, created_by, doc_date)
      values ('DOC-TS-2026-0007', 'Old', 'B-TS', 'TS-D02', 'Tom', current_date - 2);
    insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell) values ('sku', 'BAR-1B', 'B-TS', 2);
    insert into branch_closed_day (branch_id, closed_date, reason) values ('B-TS', current_date - 30, 'holiday');
  `);
  return { db, staff };
}

const count = async (db: Awaited<ReturnType<typeof freshDb>>, sql: string) =>
  Number((await db.query<{ n: number }>(sql)).rows[0].n);

describe('20261117_16_branch_vtc', () => {
  it('renames the branches and moves B-TS / TS-Dxx to B-VTC / VTC-Dxx everywhere but the audit log', async () => {
    const { db, staff } = await oldDb();
    const auditBefore = await count(db, `select count(*)::int n from audit_log where branch_id = 'B-TS' or desk_id like 'TS-%'`);
    expect(auditBefore).toBeGreaterThan(0);

    await db.exec(migration());

    expect((await db.query(`select branch_id, name_en, name_lo, sort_order from branches order by sort_order`)).rows).toEqual([
      { branch_id: 'B-MM', name_en: 'Morning Market', name_lo: 'ຕະຫລາດເຊົ້າ', sort_order: 1 },
      { branch_id: 'B-VTC', name_en: 'Vientiane Center', name_lo: 'ວຽງຈັນເຊັນເຕີ', sort_order: 2 },
      { branch_id: 'B-IT', name_en: 'ITECC', name_lo: 'ໄອເຕັກ', sort_order: 3 },
      { branch_id: 'B-VT', name_en: 'Vangthong', name_lo: 'ວັງທອງ', sort_order: 4 },
    ]);
    expect((await db.query(`select desk_id, branch_id from desks order by desk_id`)).rows).toEqual([
      { desk_id: 'MM-D01', branch_id: 'B-MM' },
      { desk_id: 'VTC-D01', branch_id: 'B-VTC' },
      { desk_id: 'VTC-D02', branch_id: 'B-VTC' },
    ]);
    expect((await db.query(`select branch_id from staff_accounts where id = $1`, [staff])).rows).toEqual([{ branch_id: 'B-VTC' }]);
    expect((await db.query(`select desk_id, branch_id, status from desk_days`)).rows).toEqual([{ desk_id: 'VTC-D01', branch_id: 'B-VTC', status: 'done' }]);
    expect((await db.query(`select desk_id, branch_id, opening_qty from daily_stock_ledger`)).rows).toEqual([{ desk_id: 'VTC-D01', branch_id: 'B-VTC', opening_qty: 5 }]);
    expect((await db.query(`select desk_id, staff_id from desk_assignment where ended_at is null`)).rows).toEqual([{ desk_id: 'VTC-D01', staff_id: staff }]);
    expect((await db.query(`select from_desk_id, from_branch_id, to_desk_id from transfers`)).rows).toEqual([{ from_desk_id: 'VTC-D01', from_branch_id: 'B-VTC', to_desk_id: 'MM-D01' }]);
    // The issued number stays; the counter carries on under the new code.
    expect((await db.query(`select doc_no, branch_id, desk_id from documents`)).rows).toEqual([{ doc_no: 'DOC-TS-2026-0007', branch_id: 'B-VTC', desk_id: 'VTC-D02' }]);
    expect((await db.query(`select next_doc_seq('B-VTC', 2026) as n`)).rows).toEqual([{ n: 8 }]);
    expect(await count(db, `select count(*)::int n from replenishment_rule where branch_id = 'B-VTC'`)).toBe(1);
    expect(await count(db, `select count(*)::int n from branch_closed_day where branch_id = 'B-VTC'`)).toBe(1);

    // History stays as written, plus one entry for the move; no per-row audit noise.
    expect(await count(db, `select count(*)::int n from audit_log where branch_id = 'B-TS' or desk_id like 'TS-%'`)).toBe(auditBefore);
    expect((await db.query(`select action, target from audit_log where action = 'branch.rename'`)).rows).toEqual([{ action: 'branch.rename', target: 'B-TS -> B-VTC' }]);
    expect(await count(db, `select count(*)::int n from audit_log where branch_id = 'B-VTC' or desk_id like 'VTC-%'`)).toBe(1);

    // The guards are back on: a done day is locked again.
    await expectPgError(db.query(`update daily_stock_ledger set stock_in = 1 where desk_id = 'VTC-D01'`), 'DAY_LOCKED');
    // and every foreign key is back to checked-at-once
    expect(await count(db, `select count(*)::int n from pg_constraint where contype = 'f' and condeferrable`)).toBe(0);
  });

  it('is safe to run again', async () => {
    const { db } = await oldDb();
    await db.exec(migration());
    const snap = async () => ({
      branches: (await db.query(`select * from branches order by branch_id`)).rows,
      desks: (await db.query(`select desk_id, branch_id from desks order by desk_id`)).rows,
      audit: await count(db, `select count(*)::int n from audit_log`),
    });
    const first = await snap();
    await db.exec(migration());
    expect(await snap()).toEqual(first);
  });

  it('does nothing to a fresh database that already has B-VTC', async () => {
    const db = await freshDb({ withRoles: true, withBase: true });
    await db.exec(migration());
    expect((await db.query(`select branch_id from branches order by sort_order`)).rows.map((r: any) => r.branch_id)).toEqual(['B-MM', 'B-VTC', 'B-IT', 'B-VT']);
  });
});
