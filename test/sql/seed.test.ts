import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asActor, expectPgError } from './db';
import { verifyPassword } from '../../src/auth';

const sqlFile = (...p: string[]) => readFileSync(join(process.cwd(), 'supabase', ...p), 'utf8');
const runSeed = (db: PGlite) => db.exec(sqlFile('seed_mock_data.sql'));
const runPurge = (db: PGlite) => db.exec(sqlFile('purge_seed_data.sql'));

type Counts = Record<string, { seed: number; real: number }>;
async function counts(db: PGlite): Promise<Counts> {
  const r = await db.query<{ table_name: string; seed_rows: string; real_rows: string }>(
    `select table_name, seed_rows::text, real_rows::text from kpv_seed_counts() order by 1`);
  const out: Counts = {};
  for (const row of r.rows) out[row.table_name] = { seed: Number(row.seed_rows), real: Number(row.real_rows) };
  return out;
}
const realOnly = (c: Counts) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.real]));
const one = async <T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query<T>(sql, params)).rows[0];

let db: PGlite;

beforeEach(async () => {
  db = await freshDb({ withRoles: true, withBase: true });
});

describe('kpv_seed_counts', () => {
  it('covers every table with is_seed and nothing else', async () => {
    const c = await counts(db);
    expect(Object.keys(c).sort()).toEqual([
      'audit_log', 'branch_closed_day', 'daily_stock_ledger', 'desk_assignment', 'desk_days', 'desks',
      'doc_counters', 'document_rows', 'documents', 'master_sku', 'replenishment_rule', 'sku_type',
      'sku_weight', 'staff_accounts', 'transfers', 'branches',
    ].sort());
    // base.sql rows are real
    expect(c.branches).toEqual({ seed: 0, real: 4 });
    expect(c.sku_type.real).toBe(5);
  });
});

describe('seed_mock_data.sql', () => {
  it('seed loads and produces the scenario', async () => {
    const baseline = realOnly(await counts(db)); // base.sql rows (and their audit entries) are real
    await runSeed(db);

    const br =await db.query<{ branch_id: string; is_seed: boolean }>(
      `select branch_id, is_seed from branches where branch_id like 'B-TST%' order by 1`);
    expect(br.rows).toEqual([{ branch_id: 'B-TST1', is_seed: true }, { branch_id: 'B-TST2', is_seed: true }]);
    const desks = await db.query<{ desk_id: string; branch_id: string }>(
      `select desk_id, branch_id from desks where is_seed order by 1`);
    expect(desks.rows.map((d) => d.desk_id)).toEqual(['T1-1', 'T1-2', 'T1-3', 'T1-4', 'T2-1']);
    expect(desks.rows.filter((d) => d.branch_id === 'B-TST1')).toHaveLength(4);

    // T1-1 is Done today
    expect((await one<{ status: string }>(db,
      `select status from desk_days where desk_id = 'T1-1' and ledger_date = kpv_today()`)).status).toBe('done');
    // T1-2 / T1-3 are checked in today with 21 Done days before
    for (const desk of ['T1-2', 'T1-3']) {
      expect((await one<{ status: string }>(db,
        `select status from desk_days where desk_id = $1 and ledger_date = kpv_today()`, [desk])).status).toBe('check_in');
      expect((await one<{ n: number }>(db,
        `select count(*)::int n from desk_days where desk_id = $1 and status = 'done' and ledger_date < kpv_today()`, [desk])).n).toBe(21);
    }
    // T1-4: last Done = today - 4, nothing after
    const t14 = await one<{ last_done: string; last_any: string }>(db,
      `select max(ledger_date) filter (where status = 'done') ::text last_done, max(ledger_date)::text last_any
         from desk_days where desk_id = 'T1-4'`);
    const target = (await one<{ d: string }>(db, `select (kpv_today() - 4)::text d`)).d;
    expect(t14.last_done).toBe(target);
    expect(t14.last_any).toBe(target);
    // the cases look back far enough for the streak to be required
    expect((await one<{ n: number }>(db,
      `select count(*)::int n from desks where is_seed and (created_at at time zone 'Asia/Vientiane')::date > kpv_today() - 22`)).n).toBe(0);

    // closed day at today - 10, and no desk day of B-TST1 on it
    expect((await one<{ d: string; reason: string }>(db,
      `select closed_date::text d, reason from branch_closed_day where branch_id = 'B-TST1'`))).toEqual({
      d: (await one<{ d: string }>(db, `select (kpv_today() - 10)::text d`)).d, reason: 'Boun That Luang test' });
    expect((await one<{ n: number }>(db,
      `select count(*)::int n from desk_days where branch_id = 'B-TST1' and ledger_date = kpv_today() - 10`)).n).toBe(0);

    // velocity for SEED-SNK-1: two zero-stock days are not in-stock days
    const v = await one<{ velocity: string | null; in_stock_days: number; sold: number }>(db,
      `select velocity::text, in_stock_days, sold from branch_velocity('B-TST1', kpv_today(), 28) where sku_id = 'SEED-SNK-1'`);
    expect(v.velocity).not.toBeNull();
    expect(Number(v.velocity)).toBeGreaterThan(0);
    expect(v.in_stock_days).toBe(19);

    // SKUs, group, rules
    const skus = await db.query<{ sku_id: string }>(`select sku_id from master_sku where is_seed order by 1`);
    expect(skus.rows.map((s) => s.sku_id)).toEqual([
      'SEED-RNG-1', 'SEED-RNG-2', 'SEED-SNK-025', 'SEED-SNK-05', 'SEED-SNK-1', 'SEED-SNK-2']);
    expect((await one<{ n: number }>(db,
      `select count(*)::int n from master_sku where group_name = 'Snake Necklace' and is_seed`)).n).toBe(4);
    const group = await one<{ lead_time_days: string; avg_daily_sell: string; branch_id: string | null; is_seed: boolean }>(db,
      `select lead_time_days::text, avg_daily_sell::text, branch_id, is_seed from replenishment_rule
        where scope = 'group' and scope_key = 'Snake Necklace'`);
    expect(group).toEqual({ lead_time_days: '7.0', avg_daily_sell: '100.000', branch_id: null, is_seed: true });
    const rules = await db.query(`select scope, scope_key, branch_id from replenishment_rule where is_seed order by 1, 2`);
    expect(rules.rows).toHaveLength(2);
    // one SKU+branch override, and ring SKU left on auto (no rule at all)
    expect((await db.query(`select 1 from replenishment_rule where scope = 'sku' and branch_id = 'B-TST1'`)).rows).toHaveLength(1);

    // openings equal the previous recorded day's carried count
    expect((await one<{ n: number }>(db, `
      select count(*)::int n from daily_stock_ledger l
       cross join lateral (
         select coalesce(p.counted_qty, p.closing_qty) q from daily_stock_ledger p
          where p.desk_id = l.desk_id and p.sku_id = l.sku_id and p.ledger_date < l.ledger_date
          order by p.ledger_date desc limit 1) prev
       where l.is_seed and l.opening_qty <> prev.q`)).n).toBe(0);

    // moves T1-1 -> T1-2 today: two moves, one undone by a reverse move
    const moves = await db.query<{ n: number }>(
      `select count(*)::int n from transfers where is_seed and kind = 'move' and from_desk_id in ('T1-1','T1-2') and sent_date = kpv_today()`);
    expect(moves.rows[0].n).toBe(3);
    expect((await one<{ n: number }>(db,
      `select count(*)::int n from transfers where is_seed and reverses_id is not null`)).n).toBe(1);

    // one cross-branch transfer in transit
    const tr = await db.query<{ from_branch_id: string; to_branch_id: string }>(
      `select from_branch_id, to_branch_id from transfers where is_seed and kind = 'transfer' and status = 'in_transit'`);
    expect(tr.rows).toEqual([{ from_branch_id: 'B-TST1', to_branch_id: 'B-TST2' }]);

    // staff
    const staff = await db.query<{ role: string; branch_id: string | null; pin_hash: string }>(
      `select role, branch_id, pin_hash from staff_accounts where is_seed order by role, branch_id, display_name`);
    expect(staff.rows.map((s) => `${s.role}/${s.branch_id}`)).toEqual([
      'admin/null', 'manager/B-TST1', 'staff/B-TST1', 'staff/B-TST1', 'staff/B-TST2']);
    for (const s of staff.rows) expect(await verifyPassword('1234', s.pin_hash)).toBe(true);
    expect((await one<{ display_name: string }>(db,
      `select display_name from staff_accounts where role = 'admin' and is_seed`)).display_name).toBe('Test Admin');

    // assignments incl. a mid-day handover on T1-2
    const t12 = await db.query<{ ended: boolean }>(
      `select (ended_at is not null) ended from desk_assignment where desk_id = 'T1-2' order by started_at, ended_at nulls last`);
    expect(t12.rows).toEqual([{ ended: true }, { ended: false }]);

    // audit entries arise from the triggers, plus the semantic reopen example
    expect((await one<{ n: number }>(db,
      `select count(*)::int n from audit_log where is_seed and action = 'desk_day.reopen'`)).n).toBe(1);
    expect((await one<{ n: number }>(db,
      `select count(*)::int n from audit_log where is_seed and actor_name = 'Test Admin'`)).n).toBeGreaterThan(10);

    // everything the seed wrote is tagged; base data is still all real
    const c = await counts(db);
    expect(c.branches).toEqual({ seed: 2, real: 4 });
    expect(realOnly(c)).toEqual(baseline);
  });

  it('seed refuses to run twice', async () => {
    await runSeed(db);
    await expectPgError(runSeed(db), 'SEED_ALREADY_PRESENT');
    // the failed second run left nothing behind
    expect((await counts(db)).branches.seed).toBe(2);
  });
});

describe('tests/verify_v2.sql', () => {
  it('passes after the seed and prints VERIFY_V2 OK', async () => {
    await runSeed(db);
    const out = await db.exec(sqlFile('tests', 'verify_v2.sql'));
    const last = out[out.length - 1];
    expect(last.rows).toEqual([{ result: 'VERIFY_V2 OK' }]);
  });

  it('fails without the seed', async () => {
    await expectPgError(db.exec(sqlFile('tests', 'verify_v2.sql')), 'VERIFY_V2');
  });
});

describe('purge_seed_data.sql', () => {
  async function realRows(): Promise<void> {
    await db.exec(`
      insert into branches (branch_id, name_en) values ('B-REAL', 'Real');
      insert into desks (desk_id, branch_id, display_name) values ('R-1', 'B-REAL', 'Real case');
      insert into desk_days (desk_id, ledger_date, branch_id, status) values ('R-1', kpv_today() - 1, 'B-REAL', 'check_in');
      insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty, stock_in)
        values (kpv_today() - 1, 'R-1', 'B-REAL', 'RING-1', 0, 5);`);
  }

  beforeEach(async () => {
    // a real SKU for the real ledger row (no actor: SQL editor)
    await db.exec(`insert into master_sku (sku_id, name_en, category) values ('RING-1', 'Real ring', 'Rings & Accessories')`);
  });

  it('purge removes every seed row and no real row', async () => {
    await realRows();
    await db.exec(`insert into audit_log (actor_name, action, target) values ('Owner', 'real.entry', 'x')`);
    const before = await counts(db);
    expect(before.audit_log.real).toBeGreaterThan(0);

    await runSeed(db);
    expect((await counts(db)).branches.seed).toBe(2);

    await runPurge(db);
    const after = await counts(db);
    for (const [t, v] of Object.entries(after)) expect(v.seed, `${t} seed rows`).toBe(0);
    // real rows unchanged, except the single permanent summary entry in the audit log
    const exp = realOnly(before);
    exp.audit_log += 1;
    expect(realOnly(after)).toEqual(exp);

    const entries = await db.query<{ is_seed: boolean; detail: { deleted: Record<string, number> } }>(
      `select is_seed, detail from audit_log where action = 'seed.purge'`);
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0].is_seed).toBe(false);
    expect(entries.rows[0].detail.deleted.branches).toBe(2);
    expect(entries.rows[0].detail.deleted.daily_stock_ledger).toBeGreaterThan(100);
    // the real rows are really still there
    expect((await one<{ n: number }>(db, `select count(*)::int n from daily_stock_ledger where desk_id = 'R-1'`)).n).toBe(1);
    expect((await one<{ n: number }>(db, `select count(*)::int n from audit_log where action = 'real.entry'`)).n).toBe(1);
  });

  it('PURGE_MIXED_TRANSFER: a transfer between a real and a mock case stops the whole purge', async () => {
    await realRows();
    await runSeed(db);
    await db.query(
      `insert into transfers (kind, from_desk_id, from_branch_id, to_desk_id, to_branch_id, sku_id, qty, sent_date, status)
       values ('transfer', 'R-1', 'B-REAL', 'T1-1', 'B-TST1', 'RING-1', 2, kpv_today() - 1, 'in_transit')`);
    const before = await counts(db);
    let message = '';
    try {
      await runPurge(db);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toContain('PURGE_MIXED_TRANSFER');
    expect(message).toContain('R-1');
    expect(message).toContain('T1-1');
    expect(message).toContain('RING-1');
    expect(message).toContain('in_transit');
    // nothing was deleted
    expect(await counts(db)).toEqual(before);
    expect((await one<{ n: number }>(db, `select count(*)::int n from transfers where from_desk_id = 'R-1'`)).n).toBe(1);
  });

  it('purge is safe to run twice, and the seed can load again afterwards', async () => {
    await realRows();
    await runSeed(db);
    await runPurge(db);
    const once = await counts(db);
    await runPurge(db);
    const twice = await counts(db);
    for (const v of Object.values(twice)) expect(v.seed).toBe(0);
    const o = realOnly(once), t = realOnly(twice);
    o.audit_log += 1; // second run writes its own summary entry
    expect(t).toEqual(o);
    await runSeed(db);
    expect((await counts(db)).branches.seed).toBe(2);
    await runPurge(db);
    for (const v of Object.values(await counts(db))) expect(v.seed).toBe(0);
  });

  it("a real admin's action on a seed case is purged too", async () => {
    await runSeed(db);
    const realAdmin = (await one<{ id: string }>(db,
      `insert into staff_accounts (display_name, pin_hash, role) values ('Real Owner', 'h', 'admin') returning id`)).id;
    await asActor(db, realAdmin);
    // T1-4 has no day today: a real admin checks it in
    await db.exec(`insert into desk_days (desk_id, ledger_date, branch_id, status) values ('T1-4', kpv_today(), 'B-TST1', 'check_in')`);
    expect((await one<{ is_seed: boolean }>(db,
      `select is_seed from desk_days where desk_id = 'T1-4' and ledger_date = kpv_today()`)).is_seed).toBe(true);
    await asActor(db, null, { jwtRole: 'postgres' });

    await runPurge(db);
    for (const v of Object.values(await counts(db))) expect(v.seed).toBe(0);
    expect((await one<{ n: number }>(db, `select count(*)::int n from desk_days where desk_id = 'T1-4'`)).n).toBe(0);
    // the real admin survives
    expect((await one<{ n: number }>(db, `select count(*)::int n from staff_accounts where id = $1`, [realAdmin])).n).toBe(1);
  });

  it('purge nulls a real row\'s reference to the seed admin and keeps the real row', async () => {
    await realRows();
    await runSeed(db);
    const seedAdmin = (await one<{ id: string }>(db, `select id from staff_accounts where is_seed and role = 'admin'`)).id;
    // Real, Done day on a real case that the seed admin touched
    await db.query(`update desk_days set checked_in_by = $1 where desk_id = 'R-1'`, [seedAdmin]);
    await db.query(`update daily_stock_ledger set performed_by = $1 where desk_id = 'R-1'`, [seedAdmin]);
    await db.query(`update desk_days set status = 'done', done_by = $1, done_at = now() where desk_id = 'R-1'`, [seedAdmin]);
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('R-2', 'B-REAL', 'Real case 2')`);
    await db.query(
      `insert into transfers (kind, from_desk_id, from_branch_id, to_desk_id, to_branch_id, sku_id, qty, sent_date, sent_by, status, received_by)
       values ('transfer', 'R-1', 'B-REAL', 'R-2', 'B-REAL', 'RING-1', 1, kpv_today() - 1, $1, 'in_transit', $1)`, [seedAdmin]);
    expect((await one<{ is_seed: boolean }>(db, `select is_seed from transfers where to_desk_id = 'R-2'`)).is_seed).toBe(false);

    const before = realOnly(await counts(db));
    await runPurge(db);
    const after = await counts(db);
    for (const v of Object.values(after)) expect(v.seed).toBe(0);
    const exp = { ...before }; exp.audit_log += 1;
    expect(realOnly(after)).toEqual(exp);

    const dd = await one<{ checked_in_by: string | null; done_by: string | null; status: string }>(db,
      `select checked_in_by, done_by, status from desk_days where desk_id = 'R-1'`);
    expect(dd).toEqual({ checked_in_by: null, done_by: null, status: 'done' });
    const lr = await one<{ performed_by: string | null; stock_in: number }>(db,
      `select performed_by, stock_in from daily_stock_ledger where desk_id = 'R-1'`);
    expect(lr).toEqual({ performed_by: null, stock_in: 5 });
    const tf = await one<{ sent_by: string | null; received_by: string | null }>(db,
      `select sent_by, received_by from transfers where from_desk_id = 'R-1'`);
    expect(tf).toEqual({ sent_by: null, received_by: null });

    const entry = await one<{ detail: { nulled: Record<string, number>; nulled_total: number } }>(db,
      `select detail from audit_log where action = 'seed.purge'`);
    expect(entry.detail.nulled_total).toBeGreaterThanOrEqual(5);
    expect(entry.detail.nulled['daily_stock_ledger.performed_by']).toBe(1);
    expect(entry.detail.nulled['desk_days.done_by']).toBe(1);
  });

  it('the purge-time allowance is narrow: nothing else on a Done real day changes', async () => {
    await realRows();
    const real = (await one<{ id: string }>(db,
      `insert into staff_accounts (display_name, pin_hash, role) values ('Real Owner', 'h', 'admin') returning id`)).id;
    await db.query(`update daily_stock_ledger set performed_by = $1 where desk_id = 'R-1'`, [real]);
    await db.exec(`update desk_days set status = 'done' where desk_id = 'R-1'`);
    await db.exec(`select set_config('kpv.purging', 'on', false)`);
    try {
      // another column of the row
      await expectPgError(db.exec(`update daily_stock_ledger set retail_sale = 1 where desk_id = 'R-1'`), 'DAY_LOCKED');
      // nulling a REAL staff reference
      await expectPgError(db.exec(`update daily_stock_ledger set performed_by = null where desk_id = 'R-1'`), 'DAY_LOCKED');
      // deleting a real row
      await expectPgError(db.exec(`delete from daily_stock_ledger where desk_id = 'R-1'`), 'DAY_LOCKED');
    } finally {
      await db.exec(`select set_config('kpv.purging', 'off', false)`);
    }
    expect((await one<{ n: number }>(db, `select count(*)::int n from daily_stock_ledger where desk_id = 'R-1'`)).n).toBe(1);
  });

  it('purge leaves base.sql data intact', async () => {
    const before = await counts(db);
    await runSeed(db);
    await runPurge(db);
    const after = await counts(db);
    expect(after.branches.real).toBe(4);
    expect(after.sku_type.real).toBe(5);
    expect(after.sku_weight.real).toBe(7);
    const br = await db.query<{ branch_id: string }>(`select branch_id from branches order by sort_order`);
    expect(br.rows.map((b) => b.branch_id)).toEqual(['B-MM', 'B-TS', 'B-IT', 'B-VT']);
    expect((await one<{ n: number }>(db, `select count(*)::int n from system_config`)).n).toBe(1);
    expect(after.master_sku.real).toBe(before.master_sku.real);
  });
});
