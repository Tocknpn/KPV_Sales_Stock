import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;
let admin: string;
let mgrMM: string;
let mgrTS: string;
let staffMM: string;
let staffTS: string;

async function account(branch: string | null, name: string, role: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ($1,$2,'h',$3) returning id`,
    [branch, name, role],
  );
  return r.rows[0].id;
}

async function doneDay(deskId: string, branch: string, daysAgo: number) {
  await db.query(
    `insert into desk_days (desk_id, ledger_date, branch_id, status) values ($1, kpv_today() - $2::int, $3, 'done')`,
    [deskId, daysAgo, branch],
  );
}

const reopen = (deskId: string, daysAgo: number) =>
  db.query(
    `update desk_days set status = 'check_in' where desk_id = $1 and ledger_date = kpv_today() - $2::int`,
    [deskId, daysAgo],
  );

beforeEach(async () => {
  db = await freshDb({ withBase: true, withRoles: true });
  admin = await account(null, 'Owner', 'admin');
  mgrMM = await account('B-MM', 'Mgr MM', 'manager');
  mgrTS = await account('B-TS', 'Mgr TS', 'manager');
  staffMM = await account('B-MM', 'Staff MM', 'staff');
  staffTS = await account('B-TS', 'Staff TS', 'staff');
  await db.exec(`insert into master_sku (sku_id, name_en, category) values ('S1','Test','Rings')`);
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','x'), ('TS-D01','B-TS','x')`);
});

describe('role constraint', () => {
  it('accepts a branch manager but requires a branch', async () => {
    await expectPgError(account(null, 'No branch', 'manager'), 'staff_branch_required');
    await expectPgError(account('B-MM', 'Bad', 'owner'), 'staff_accounts_role_check');
  });

  it('is idempotent', async () => {
    await db.exec(readFileSync(join(process.cwd(), 'supabase', 'users_roles.sql'), 'utf8'));
    expect(await account('B-MM', 'Another', 'manager')).toBeTruthy();
  });
});

describe('master data guard', () => {
  it('staff cannot change a SKU', async () => {
    await asActor(db, staffMM);
    await expectPgError(db.query(`update master_sku set name_en = 'Hacked' where sku_id = 'S1'`), 'ROLE_DENIED');
    await expectPgError(db.query(`insert into sku_type (type_id, name_en) values ('X','X')`), 'ROLE_DENIED');
  });

  it('a manager cannot change master data or config either', async () => {
    await asActor(db, mgrMM);
    await expectPgError(db.query(`update master_sku set name_en = 'Hacked' where sku_id = 'S1'`), 'ROLE_DENIED');
    await expectPgError(db.query(`update system_config set spot_lak_per_baht = 1`), 'ROLE_DENIED');
  });

  it('an admin can', async () => {
    await asActor(db, admin);
    await db.query(`update master_sku set name_en = 'Renamed' where sku_id = 'S1'`);
    const r = await db.query<{ name_en: string }>(`select name_en from master_sku where sku_id = 'S1'`);
    expect(r.rows[0].name_en).toBe('Renamed');
  });

  it('SQL editor (no actor, not service_role) passes guards', async () => {
    await asActor(db, null, { jwtRole: 'postgres' });
    await db.query(`update master_sku set name_en = 'Editor' where sku_id = 'S1'`);
    await db.query(`update staff_accounts set role = 'admin', branch_id = null where id = $1`, [staffMM]);
  });

  it('a service_role call with no actor and no system tag is refused', async () => {
    await asActor(db, null, { jwtRole: 'service_role' });
    await expectPgError(db.query(`update master_sku set name_en = 'x' where sku_id = 'S1'`), 'ROLE_DENIED');
  });

  it('a system-tagged call (login lockout) may touch staff accounts', async () => {
    await asActor(db, null, { system: 'login', jwtRole: 'service_role' });
    await db.query(`update staff_accounts set failed_attempts = 1 where id = $1`, [staffMM]);
  });
});

describe('staff account guard', () => {
  it('manager can unlock own-branch staff but not change their role', async () => {
    await db.query(`update staff_accounts set failed_attempts = 5, locked_until = now() + interval '15 minutes' where id = $1`, [staffMM]);
    await asActor(db, mgrMM);
    await db.query(`update staff_accounts set failed_attempts = 0, locked_until = null where id = $1`, [staffMM]);
    const r = await db.query<{ failed_attempts: number; locked_until: string | null }>(
      `select failed_attempts, locked_until from staff_accounts where id = $1`,
      [staffMM],
    );
    expect(r.rows[0]).toEqual({ failed_attempts: 0, locked_until: null });
    await expectPgError(db.query(`update staff_accounts set role = 'admin', branch_id = null where id = $1`, [staffMM]), 'ROLE_DENIED');
    await expectPgError(db.query(`update staff_accounts set pin_hash = 'x' where id = $1`, [staffMM]), 'ROLE_DENIED');
    await expectPgError(db.query(`update staff_accounts set active = false where id = $1`, [staffMM]), 'ROLE_DENIED');
  });

  it('manager cannot unlock another branch, a manager or an admin', async () => {
    await asActor(db, mgrMM);
    await expectPgError(db.query(`update staff_accounts set failed_attempts = 0 where id = $1`, [staffTS]), 'ROLE_DENIED');
    await expectPgError(db.query(`update staff_accounts set failed_attempts = 0 where id = $1`, [mgrTS]), 'ROLE_DENIED');
    await expectPgError(db.query(`update staff_accounts set failed_attempts = 0 where id = $1`, [admin]), 'ROLE_DENIED');
    await expectPgError(
      db.query(`insert into staff_accounts (branch_id, display_name, pin_hash, role) values ('B-MM','n','h','staff')`),
      'ROLE_DENIED',
    );
  });

  it('staff cannot change accounts at all', async () => {
    await asActor(db, staffMM);
    await expectPgError(db.query(`update staff_accounts set failed_attempts = 0 where id = $1`, [staffMM]), 'ROLE_DENIED');
  });

  it('admin can', async () => {
    await asActor(db, admin);
    await db.query(`update staff_accounts set display_name = 'Renamed' where id = $1`, [staffMM]);
  });
});

describe('desk day reopen guard', () => {
  beforeEach(async () => {
    await doneDay('MM-D01', 'B-MM', 2);
    await doneDay('MM-D01', 'B-MM', 3);
    await doneDay('MM-D01', 'B-MM', 4);
    await doneDay('TS-D01', 'B-TS', 2);
  });

  it('manager reopens own-branch Done day of 2 days ago', async () => {
    await asActor(db, mgrMM);
    await reopen('MM-D01', 2);
    const r = await db.query<{ status: string }>(`select status from desk_days where desk_id = 'MM-D01' and ledger_date = kpv_today() - 2`);
    expect(r.rows[0].status).toBe('check_in');
  });

  it('manager may reopen exactly 3 days ago', async () => {
    await asActor(db, mgrMM);
    await reopen('MM-D01', 3);
  });

  it('manager cannot reopen 4 days ago or another branch', async () => {
    await asActor(db, mgrMM);
    await expectPgError(reopen('MM-D01', 4), 'REOPEN_TOO_OLD');
    await expectPgError(reopen('TS-D01', 2), 'ROLE_DENIED');
  });

  it('staff cannot reopen', async () => {
    await asActor(db, staffMM);
    await expectPgError(reopen('MM-D01', 2), 'ROLE_DENIED');
  });

  it('admin can reopen any age', async () => {
    await asActor(db, admin);
    await reopen('MM-D01', 4);
    await reopen('TS-D01', 2);
  });

  it('other updates of a Done day are not treated as a reopen', async () => {
    await asActor(db, staffMM);
    await db.query(`update desk_days set safe_drop_note = 'n' where desk_id = 'MM-D01' and ledger_date = kpv_today() - 2`);
  });
});

describe('lockdown', () => {
  it('anon has no table privileges, even if something granted them', async () => {
    const raw = await freshDb({ withBase: true });
    await raw.exec(`grant all on all tables in schema public to anon, authenticated`);
    await raw.exec(`grant execute on all functions in schema public to anon, authenticated`);
    await raw.exec(readFileSync(join(process.cwd(), 'supabase', 'users_roles.sql'), 'utf8'));
    const r = await raw.query<{ t: string; s: boolean; w: boolean; a: boolean }>(
      `select tablename as t,
              has_table_privilege('anon', format('public.%I', tablename), 'select') as s,
              has_table_privilege('authenticated', format('public.%I', tablename), 'insert') as w,
              has_table_privilege('anon', format('public.%I', tablename), 'update') as a
       from pg_tables where schemaname = 'public'`,
    );
    expect(r.rows.length).toBeGreaterThan(5);
    for (const row of r.rows) expect([row.t, row.s, row.w, row.a]).toEqual([row.t, false, false, false]);
    const fn = await raw.query<{ ok: boolean }>(
      `select has_function_privilege('anon', 'public.kpv_today()', 'execute') as ok`,
    );
    expect(fn.rows[0].ok).toBe(false);
  });

  it('row level security is enabled on every public table', async () => {
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(r.rows).toEqual([]);
  });

  it('service_role can still run the functions the triggers use', async () => {
    const r = await db.query<{ ok: boolean }>(
      `select has_function_privilege('service_role', 'public.kpv_today()', 'execute') as ok`,
    );
    expect(r.rows[0].ok).toBe(true);
  });
});
