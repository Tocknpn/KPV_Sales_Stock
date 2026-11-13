import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;
let staffId: string;
const D = '2026-01-10';

let baseline: string[] = [];
// audit_log is immutable, so setup rows are excluded by id rather than deleted.
async function audit(where = '1=1') {
  const r = await db.query<Record<string, any>>(
    `select * from audit_log where table_name is not null and id <> all($1::uuid[]) and ${where} order by created_at, id`,
    [baseline],
  );
  return r.rows;
}
async function markBaseline() {
  const r = await db.query<{ id: string }>(`select id from audit_log`);
  baseline = r.rows.map((x) => x.id);
}

beforeEach(async () => {
  db = await freshDb({ withBase: true });
  await db.exec(`insert into master_sku (sku_id, name_en, category) values ('S1','Test','Rings')`);
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','x')`);
  await db.exec(`insert into desk_days (desk_id, ledger_date, branch_id) values ('MM-D01','${D}','B-MM')`);
  await db.exec(
    `insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id) values ('${D}','MM-D01','B-MM','S1')`,
  );
  const r = await db.query<{ id: string }>(
    `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ('B-MM','Somchai','h','staff') returning id`,
  );
  staffId = r.rows[0].id;
  await markBaseline();
});

describe('audit trigger', () => {
  it('logs a ledger update as old -> new with the header actor', async () => {
    await asActor(db, staffId);
    await db.exec(`update daily_stock_ledger set stock_in = 3 where desk_id = 'MM-D01'`);
    const rows = await audit();
    expect(rows).toHaveLength(1);
    const a = rows[0];
    expect(a.old_values).toEqual({ stock_in: 0 });
    expect(a.new_values).toEqual({ stock_in: 3 });
    expect(a.desk_id).toBe('MM-D01');
    expect(a.branch_id).toBe('B-MM');
    expect(a.actor_id).toBe(staffId);
    expect(a.actor_name).toBe('Somchai');
    expect(a.actor_role).toBe('staff');
    expect(a.source).toBe('api');
    expect(a.table_name).toBe('daily_stock_ledger');
    expect(a.op).toBe('UPDATE');
    expect(a.action).toBe('update:daily_stock_ledger');
    expect(Object.keys(a.row_key)).toEqual(['id']);
    expect(a.target).toBe(JSON.stringify(a.row_key).replace(/:/g, ': '));
  });

  it('skips no-op updates and ignores updated_at / performed_by', async () => {
    await asActor(db, staffId);
    await db.exec(`update daily_stock_ledger set stock_in = 0 where desk_id = 'MM-D01'`);
    await db.exec(
      `update daily_stock_ledger set performed_by = '${staffId}', updated_at = now() where desk_id = 'MM-D01'`,
    );
    expect(await audit()).toHaveLength(0);
  });

  it('records inserts and deletes with full row minus ignored keys', async () => {
    await asActor(db, staffId);
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D02','B-MM','y')`);
    await db.exec(`delete from desks where desk_id = 'MM-D02'`);
    const rows = await audit(`table_name = 'desks'`);
    expect(rows.map((r) => r.op)).toEqual(['INSERT', 'DELETE']);
    expect(rows[0].old_values).toBeNull();
    expect(rows[0].new_values.display_name).toBe('y');
    expect(rows[0].new_values).not.toHaveProperty('created_at');
    expect(rows[1].new_values).toBeNull();
    expect(rows[1].old_values.display_name).toBe('y');
  });

  it('redacts pin_hash', async () => {
    await asActor(db, staffId);
    await db.query(`update staff_accounts set pin_hash = 'secret' where id = $1`, [staffId]);
    const rows = await audit(`table_name = 'staff_accounts'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].new_values.pin_hash).toBe('changed');
    expect(JSON.stringify(rows[0])).not.toContain('secret');
  });

  it('redacts pin_hash on insert', async () => {
    await db.exec(
      `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ('B-MM','N','topsecret','staff')`,
    );
    const rows = await audit(`table_name = 'staff_accounts'`);
    expect(rows[0].new_values.pin_hash).toBe('changed');
  });

  it('does not log failed_attempts alone', async () => {
    await db.query(`update staff_accounts set failed_attempts = 2, token_version = 5 where id = $1`, [staffId]);
    expect(await audit(`table_name = 'staff_accounts'`)).toHaveLength(0);
  });

  it('refuses a service_role write without an actor', async () => {
    await asActor(db, null, { jwtRole: 'service_role' });
    await expectPgError(
      db.exec(`update daily_stock_ledger set stock_in = 1 where desk_id = 'MM-D01'`),
      'AUDIT_ACTOR_MISSING',
    );
  });

  it('accepts a system-tagged write', async () => {
    await asActor(db, null, { system: 'login', jwtRole: 'service_role' });
    await db.exec(`update daily_stock_ledger set stock_in = 1 where desk_id = 'MM-D01'`);
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('system:login');
    expect(rows[0].actor_name).toBe('system:login');
    expect(rows[0].actor_id).toBeNull();
  });

  it('accepts SQL-editor writes with no actor and no role', async () => {
    await db.exec(`update daily_stock_ledger set stock_in = 1 where desk_id = 'MM-D01'`);
    const rows = await audit();
    expect(rows[0].actor_name).toBe('sql:postgres');
  });

  it('treats an invalid actor uuid as no actor', async () => {
    await db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-kpv-actor-id': 'nope' })]);
    const r = await db.query<{ a: string | null }>(`select kpv_actor_id() as a`);
    expect(r.rows[0].a).toBeNull();
  });

  it('keeps the v1 semantic inserts working', async () => {
    await db.exec(`insert into audit_log (actor_name, action, target) values ('a','desk_day.reopen','x')`);
    const r = await db.query(`select 1 from audit_log where action = 'desk_day.reopen'`);
    expect(r.rows).toHaveLength(1);
  });
});

describe('audit context and transfer ends', () => {
  it('carries natural-key context on a ledger update', async () => {
    await db.exec(`update daily_stock_ledger set stock_in = 2 where desk_id = 'MM-D01'`);
    const [a] = await audit();
    expect(a.context.sku_id).toBe('S1');
    expect(a.context.ledger_date).toBe(D);
    expect(a.context.desk_id).toBe('MM-D01');
    expect(a.context.branch_id).toBe('B-MM');
    expect(a.context).not.toHaveProperty('to_desk_id');
  });

  it('records both ends of a transfer', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('TS-D01','B-TS','t')`);
    await db.exec(
      `insert into transfers (kind, from_desk_id, from_branch_id, to_desk_id, to_branch_id, sku_id, qty, sent_date)
       values ('transfer','MM-D01','B-MM','TS-D01','B-TS','S1',1,'${D}')`,
    );
    await db.exec(`update transfers set status = 'received', received_date = '${D}'`);
    const rows = await audit(`table_name = 'transfers'`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.desk_id).toBe('MM-D01');
      expect(r.branch_id).toBe('B-MM');
      expect(r.to_desk_id).toBe('TS-D01');
      expect(r.to_branch_id).toBe('B-TS');
      expect(r.context.to_desk_id).toBe('TS-D01');
    }
  });
});

describe('audit immutability', () => {
  beforeEach(async () => {
    await db.exec(`insert into audit_log (actor_name, action, target) values ('a','x','y')`);
  });

  it('cannot be updated, deleted or truncated', async () => {
    await expectPgError(db.exec(`update audit_log set target = 'z'`), 'AUDIT_IMMUTABLE');
    await expectPgError(db.exec(`delete from audit_log`), 'AUDIT_IMMUTABLE');
    await expectPgError(db.exec(`truncate audit_log`), 'AUDIT_IMMUTABLE');
  });

  it('allows deleting seed rows while purging only', async () => {
    await db.exec(`insert into audit_log (actor_name, action, target, is_seed) values ('s','x','seed',true)`);
    await expectPgError(db.exec(`delete from audit_log where is_seed`), 'AUDIT_IMMUTABLE');
    await db.exec(`set kpv.purging = 'on'; delete from audit_log where is_seed; reset kpv.purging;`);
    const r = await db.query(`select 1 from audit_log where is_seed`);
    expect(r.rows).toHaveLength(0);
    await db.exec(`set kpv.purging = 'on'`);
    await expectPgError(db.exec(`delete from audit_log where target = 'y'`), 'AUDIT_IMMUTABLE');
    await db.exec(`reset kpv.purging`);
  });
});

describe('audit and seed', () => {
  it('audit row of a seed row is seed', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name, is_seed) values ('MM-S01','B-MM','s',true)`);
    await db.exec(`update desks set display_name = 'z' where desk_id = 'MM-S01'`);
    await db.exec(`delete from desks where desk_id = 'MM-S01'`);
    const seeded = await audit(`table_name = 'desks' and row_key->>'desk_id' = 'MM-S01'`);
    expect(seeded).toHaveLength(3);
    expect(seeded.every((r) => r.is_seed === true)).toBe(true);
    const real = await audit(`table_name = 'desks' and row_key->>'desk_id' = 'MM-D01'`);
    expect(real.every((r) => r.is_seed === false)).toBe(true);
  });

  it('writes nothing while purging', async () => {
    await db.exec(`insert into desks (desk_id, branch_id, display_name, is_seed) values ('MM-S01','B-MM','s',true)`);
    await markBaseline();
    await db.exec(`set kpv.purging = 'on'; delete from desks where desk_id = 'MM-S01'; reset kpv.purging;`);
    expect(await audit()).toHaveLength(0);
  });

  it('kpv_attach_audit is idempotent', async () => {
    await db.exec(`select kpv_attach_audit('desks'); select kpv_attach_audit('desks');`);
    const r = await db.query<{ n: number }>(
      `select count(*)::int n from pg_trigger where tgrelid = 'desks'::regclass and tgname = 'trg_desks_audit'`,
    );
    expect(r.rows[0].n).toBe(1);
  });
});
