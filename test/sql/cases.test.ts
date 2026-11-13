import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;
let admin: string;
let mgrMM: string;
let mgrTS: string;
let noy: string; // staff MM
let ann: string; // staff MM
let tom: string; // staff TS

async function account(branch: string | null, name: string, role: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ($1,$2,'h',$3) returning id`,
    [branch, name, role],
  );
  return r.rows[0].id;
}

const assign = (desk: string, staff: string, note: string | null = null) =>
  db.query<{ id: string; staff_id: string; ended_at: string | null }>(`select * from assign_desk($1, $2, $3)`, [desk, staff, note]);
const active = async (desk: string) =>
  (await db.query<{ staff_id: string }>(`select staff_id from desk_assignment where desk_id = $1 and ended_at is null`, [desk])).rows;

beforeEach(async () => {
  db = await freshDb({ withRoles: true, withBase: true });
  await asActor(db, null, { jwtRole: 'postgres' });
  admin = await account(null, 'Owner', 'admin');
  mgrMM = await account('B-MM', 'Mgr MM', 'manager');
  mgrTS = await account('B-TS', 'Mgr TS', 'manager');
  noy = await account('B-MM', 'Noy', 'staff');
  ann = await account('B-MM', 'Ann', 'staff');
  tom = await account('B-TS', 'Tom', 'staff');
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values
    ('MM-D01','B-MM','A'), ('MM-D02','B-MM','B'), ('TS-D01','B-TS','A')`);
});

describe('desk_assignment', () => {
  it('one active holder per case; handover ends the previous row with ended_by', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', noy);
    await assign('MM-D01', ann, 'lunch cover');
    expect(await active('MM-D01')).toEqual([{ staff_id: ann }]);
    const old = await db.query<{ ended_at: string | null; ended_by: string | null }>(
      `select ended_at, ended_by from desk_assignment where desk_id = 'MM-D01' and staff_id = $1`, [noy]);
    expect(old.rows[0].ended_at).not.toBeNull();
    expect(old.rows[0].ended_by).toBe(mgrMM);
    await expectPgError(
      db.query(`insert into desk_assignment (desk_id, staff_id) values ('MM-D01', $1)`, [noy]),
      'uq_desk_assignment_active');
  });

  it('assigning the current holder again is a no-op', async () => {
    await asActor(db, mgrMM);
    const first = await assign('MM-D01', noy);
    const again = await assign('MM-D01', noy);
    expect(again.rows[0].id).toBe(first.rows[0].id);
    const n = await db.query<{ n: number }>(`select count(*)::int n from desk_assignment where desk_id = 'MM-D01'`);
    expect(n.rows[0].n).toBe(1);
  });

  it('one staff can hold several cases', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', noy);
    await assign('MM-D02', noy);
    const r = await db.query(`select 1 from desk_assignment where staff_id = $1 and ended_at is null`, [noy]);
    expect(r.rows).toHaveLength(2);
  });

  it('release ends the row without a successor', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', noy);
    await db.query(`select release_desk('MM-D01')`);
    expect(await active('MM-D01')).toEqual([]);
  });

  it('staff can take a free case and hand their own case to a colleague, but not take over another holder', async () => {
    await asActor(db, noy);
    await assign('MM-D01', noy); // free case
    await assign('MM-D01', ann); // hand over own case
    expect(await active('MM-D01')).toEqual([{ staff_id: ann }]);
    await expectPgError(assign('MM-D01', noy), 'ROLE_DENIED'); // noy no longer holds it
    expect(await active('MM-D01')).toEqual([{ staff_id: ann }]);
  });

  it('staff take over a stale holder (earlier Laos day) but not a same-day holder', async () => {
    await asActor(db, null, { jwtRole: 'postgres' });
    await db.query(`insert into desk_assignment (desk_id, staff_id, started_at) values ('MM-D01', $1, now() - interval '2 days')`, [noy]);
    await asActor(db, ann);
    await assign('MM-D01', ann);
    expect(await active('MM-D01')).toEqual([{ staff_id: ann }]);
    // ann's row is from today: noy cannot take it over
    await asActor(db, noy);
    await expectPgError(assign('MM-D01', noy), 'ROLE_DENIED');
    expect(await active('MM-D01')).toEqual([{ staff_id: ann }]);
  });

  it('staff cannot assign someone else to a free case', async () => {
    await asActor(db, noy);
    await expectPgError(assign('MM-D02', ann), 'ROLE_DENIED');
  });

  it('manager assigns anyone in branch; cross-branch is ASSIGN_OTHER_BRANCH', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', ann);
    await expectPgError(assign('MM-D01', tom), 'ASSIGN_OTHER_BRANCH');
    await expectPgError(assign('TS-D01', tom), 'ROLE_DENIED'); // another branch's manager
    await asActor(db, admin);
    await expectPgError(assign('TS-D01', noy), 'ASSIGN_OTHER_BRANCH');
    await asActor(db, mgrTS);
    await assign('TS-D01', tom);
  });

  it('inactive staff cannot be assigned', async () => {
    await asActor(db, admin);
    await db.query(`update staff_accounts set active = false where id = $1`, [ann]);
    await expectPgError(assign('MM-D01', ann), 'ASSIGN_INACTIVE');
  });

  it('deactivating a staff member ends their assignments', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', noy);
    await assign('MM-D02', noy);
    await asActor(db, admin);
    await db.query(`update staff_accounts set active = false where id = $1`, [noy]);
    const open = await db.query(`select 1 from desk_assignment where staff_id = $1 and ended_at is null`, [noy]);
    expect(open.rows).toHaveLength(0);
    const ended = await db.query<{ ended_by: string }>(`select ended_by from desk_assignment where staff_id = $1`, [noy]);
    expect(ended.rows.map((x) => x.ended_by)).toEqual([admin, admin]);
  });

  it('moving a staff member to another branch ends their assignments', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', noy);
    await asActor(db, admin);
    await db.query(`update staff_accounts set branch_id = 'B-TS' where id = $1`, [noy]);
    expect(await active('MM-D01')).toEqual([]);
  });

  it('assignments are audited and seed-inherited', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', noy);
    const a = await db.query(`select 1 from audit_log where table_name = 'desk_assignment' and op = 'INSERT'`);
    expect(a.rows).toHaveLength(1);
    await asActor(db, null, { jwtRole: 'postgres' });
    const s = await account('B-MM', 'SeedStaff', 'staff');
    await db.query(`update staff_accounts set is_seed = true where id = $1`, [s]);
    await assign('MM-D02', s);
    const r = await db.query<{ is_seed: boolean }>(`select is_seed from desk_assignment where desk_id = 'MM-D02'`);
    expect(r.rows[0].is_seed).toBe(true);
  });
});

describe('branch_closed_day', () => {
  const add = (branch: string, date = '2026-12-25') =>
    db.query(`insert into branch_closed_day (branch_id, closed_date, reason) values ($1, $2, 'Holiday')`, [branch, date]);

  it('staff cannot add a closed day; manager adds for own branch only; admin anywhere', async () => {
    await asActor(db, noy);
    await expectPgError(add('B-MM'), 'ROLE_DENIED');
    await asActor(db, mgrMM);
    await add('B-MM');
    await expectPgError(add('B-TS'), 'ROLE_DENIED');
    await asActor(db, admin);
    await add('B-TS');
  });

  it('is unique per branch and date, audited, and created_by defaults to the actor', async () => {
    await asActor(db, mgrMM);
    await add('B-MM');
    await expectPgError(add('B-MM'), 'branch_closed_day_pkey');
    const r = await db.query<{ created_by: string }>(`select created_by from branch_closed_day`);
    expect(r.rows[0].created_by).toBe(mgrMM);
    const a = await db.query(`select 1 from audit_log where table_name = 'branch_closed_day'`);
    expect(a.rows.length).toBeGreaterThan(0);
  });

  it('staff cannot delete one; manager can', async () => {
    await asActor(db, mgrMM);
    await add('B-MM');
    await asActor(db, noy);
    await expectPgError(db.query(`delete from branch_closed_day`), 'ROLE_DENIED');
    await asActor(db, mgrMM);
    await db.query(`delete from branch_closed_day`);
  });
});

describe('desk_assignment table guards', () => {
  const insertRow = (desk: string, staff: string) =>
    db.query(`insert into desk_assignment (desk_id, staff_id) values ($1, $2)`, [desk, staff]);

  it('a direct insert refuses another branch and an inactive staff member', async () => {
    await asActor(db, admin);
    await expectPgError(insertRow('MM-D01', tom), 'ASSIGN_OTHER_BRANCH');
    await db.query(`update staff_accounts set active = false where id = $1`, [ann]);
    await expectPgError(insertRow('MM-D01', ann), 'ASSIGN_INACTIVE');
  });

  it('history cannot be rewritten', async () => {
    await asActor(db, mgrMM);
    await assign('MM-D01', noy, 'first');
    await assign('MM-D01', ann);
    const upd = (set: string, params: unknown[] = []) =>
      db.query(`update desk_assignment set ${set} where desk_id = 'MM-D01' and staff_id = $1`, [noy, ...params]);
    // ended row: ended_* frozen, no reopening
    await expectPgError(upd(`ended_at = null`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`ended_by = null`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`ended_at = now() + interval '1 hour'`), 'ASSIGNMENT_IMMUTABLE');
    // other columns
    await expectPgError(upd(`note = 'edited'`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`is_seed = true`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`id = gen_random_uuid()`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`desk_id = 'MM-D02'`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`staff_id = '${ann}'`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`started_at = now() - interval '1 day'`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(upd(`started_by = null`), 'ASSIGNMENT_IMMUTABLE');
    // active row: note frozen, ended_by without ended_at refused
    const act = (set: string) => db.query(`update desk_assignment set ${set} where desk_id = 'MM-D01' and ended_at is null`);
    await expectPgError(act(`note = 'edited'`), 'ASSIGNMENT_IMMUTABLE');
    await expectPgError(act(`ended_by = '${admin}'`), 'ASSIGNMENT_IMMUTABLE');
  });
});
