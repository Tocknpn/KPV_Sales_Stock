import { describe, it, expect, beforeEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { freshDb, asActor, expectPgError } from './db';

let db: PGlite;
let admin: string;
let mgrMM: string;
let mgrTS: string;

const migration = () => readFileSync('supabase/migrations/20261112_06_replenishment.sql', 'utf8');
const TO = '2026-03-31'; // window with p_days = 28 is 2026-03-03 .. 2026-03-30

async function account(branch: string | null, name: string, role: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ($1,$2,'h',$3) returning id`,
    [branch, name, role],
  );
  return r.rows[0].id;
}

interface Day {
  date: string;
  sku?: string;
  opening?: number;
  stockIn?: number;
  transferIn?: number;
  retail?: number;
  wholesale?: number;
  move?: number;
  destock?: number;
  status?: string;
  desk?: string;
  excluded?: boolean;
}

/** One ledger row (and its desk day, created on first use). */
async function day(d: Day): Promise<void> {
  const desk = d.desk ?? 'MM-D01';
  const branch = desk.startsWith('TS') ? 'B-TS' : 'B-MM';
  await db.query(
    `insert into desk_days (desk_id, ledger_date, branch_id, status) values ($1,$2,$3,$4)
     on conflict (desk_id, ledger_date) do nothing`,
    [desk, d.date, branch, 'check_in'],
  );
  await db.query(`update desk_days set status = 'check_in' where desk_id = $1 and ledger_date = $2`, [desk, d.date]);
  await db.query(
    `insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty, stock_in, transfer_in,
        retail_sale, wholesale, move, destock, excluded)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [d.date, desk, branch, d.sku ?? 'S1', d.opening ?? 0, d.stockIn ?? 0, d.transferIn ?? 0,
      d.retail ?? 0, d.wholesale ?? 0, d.move ?? 0, d.destock ?? 0, d.excluded ?? false],
  );
  await db.query(`update desk_days set status = $3 where desk_id = $1 and ledger_date = $2`, [desk, d.date, d.status ?? 'done']);
}

const dateOf = (offset: number): string => {
  const t = new Date(`${TO}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - offset);
  return t.toISOString().slice(0, 10);
};

async function velocity(branch = 'B-MM', days = 28) {
  const r = await db.query<{ sku_id: string; sold: number; in_stock_days: number; velocity: string | null }>(
    `select sku_id, sold, in_stock_days, velocity::text velocity from branch_velocity($1, $2::date, $3) order by sku_id`,
    [branch, TO, days],
  );
  return r.rows;
}

beforeEach(async () => {
  db = await freshDb({ withRoles: true, withBase: true });
  await asActor(db, null, { jwtRole: 'postgres' });
  admin = await account(null, 'Owner', 'admin');
  mgrMM = await account('B-MM', 'Mgr MM', 'manager');
  mgrTS = await account('B-TS', 'Mgr TS', 'manager');
  await db.exec(`insert into desks (desk_id, branch_id, display_name) values
    ('MM-D01','B-MM','A'), ('MM-D02','B-MM','B'), ('TS-D01','B-TS','A')`);
  await db.exec(`insert into master_sku (sku_id, name_en, category) values
    ('S1','One','Ring'), ('S2','Two','Ring'), ('S3','Three','Ring')`);
});

describe('branch_velocity', () => {
  it('velocity ignores zero-stock days', async () => {
    // 10 days in stock selling 2/day (opening 20, closing 18 ...), 5 days out of stock.
    for (let i = 1; i <= 10; i++) await day({ date: dateOf(i), opening: 20, retail: 2 });
    for (let i = 11; i <= 15; i++) await day({ date: dateOf(i), opening: 0 });
    const rows = await velocity();
    expect(rows).toEqual([{ sku_id: 'S1', sold: 20, in_stock_days: 10, velocity: '2.000' }]);
  });

  it('velocity counts retail plus wholesale', async () => {
    for (let i = 1; i <= 7; i++) await day({ date: dateOf(i), opening: 50, retail: 1, wholesale: 2 });
    expect((await velocity())[0]).toMatchObject({ sold: 21, in_stock_days: 7, velocity: '3.000' });
  });

  it('velocity ignores moves and destock', async () => {
    for (let i = 1; i <= 8; i++) await day({ date: dateOf(i), opening: 30, retail: 1, move: 5, destock: 3 });
    expect((await velocity())[0]).toMatchObject({ sold: 8, in_stock_days: 8, velocity: '1.000' });
  });

  it('a day stocked only by stock-in or transfer-in is in stock', async () => {
    for (let i = 1; i <= 4; i++) await day({ date: dateOf(i), opening: 0, stockIn: 5 });
    for (let i = 5; i <= 8; i++) await day({ date: dateOf(i), opening: 0, transferIn: 5 });
    expect((await velocity())[0].in_stock_days).toBe(8);
  });

  it('velocity is null below 7 in-stock days', async () => {
    for (let i = 1; i <= 6; i++) await day({ date: dateOf(i), opening: 10, retail: 1 });
    expect(await velocity()).toEqual([{ sku_id: 'S1', sold: 6, in_stock_days: 6, velocity: null }]);
  });

  it('closed days and non-Done days are excluded', async () => {
    for (let i = 1; i <= 7; i++) await day({ date: dateOf(i), opening: 10, retail: 1 });
    // closed day: a Done row exists but the branch was shut
    await day({ date: dateOf(8), opening: 10, retail: 9 });
    await db.query(`insert into branch_closed_day (branch_id, closed_date, reason) values ('B-MM',$1,'holiday')`, [dateOf(8)]);
    // open days
    await day({ date: dateOf(9), opening: 10, retail: 9, status: 'check_in' });
    await day({ date: dateOf(10), opening: 10, retail: 9, status: 'final_stock' });
    expect((await velocity())[0]).toMatchObject({ sold: 7, in_stock_days: 7, velocity: '1.000' });
  });

  it('only the window p_to - p_days .. p_to - 1 counts', async () => {
    await day({ date: TO, opening: 10, retail: 9 }); // p_to itself
    await day({ date: dateOf(28), opening: 10, retail: 1 }); // first day of window
    await day({ date: dateOf(29), opening: 10, retail: 9 }); // before the window
    expect((await velocity())[0]).toMatchObject({ sold: 1, in_stock_days: 1 });
  });

  it('other branches, excluded rows and open desks do not leak in', async () => {
    for (let i = 1; i <= 7; i++) await day({ date: dateOf(i), opening: 10, retail: 1 });
    for (let i = 1; i <= 7; i++) await day({ date: dateOf(i), desk: 'TS-D01', opening: 10, retail: 5 });
    await day({ date: dateOf(1), sku: 'S2', opening: 10, retail: 5, excluded: true });
    // a second desk of the branch with an open day on an included date
    await day({ date: dateOf(2), desk: 'MM-D02', opening: 10, retail: 7, status: 'check_in' });
    const rows = await velocity();
    expect(rows).toEqual([{ sku_id: 'S1', sold: 7, in_stock_days: 7, velocity: '1.000' }]);
  });

  it('sums the branch desks per date before testing stock', async () => {
    for (let i = 1; i <= 7; i++) {
      await day({ date: dateOf(i), desk: 'MM-D01', opening: 0, retail: 0 });
      await day({ date: dateOf(i), desk: 'MM-D02', opening: 4, retail: 2 });
    }
    expect((await velocity())[0]).toMatchObject({ sold: 14, in_stock_days: 7, velocity: '2.000' });
  });

  it('is not callable by anon or authenticated', async () => {
    const r = await db.query<{ a: boolean; s: boolean }>(
      `select has_function_privilege('anon', 'branch_velocity(text,date,int)', 'execute') a,
              has_function_privilege('service_role', 'branch_velocity(text,date,int)', 'execute') s`);
    expect(r.rows[0]).toEqual({ a: false, s: true });
  });
});

describe('replenishment_rule and config', () => {
  it('data copy creates sku rules once', async () => {
    await db.exec(`update master_sku set avg_daily_sales = 1.5 where sku_id = 'S1';
                   update master_sku set order_lead_time_days = 10 where sku_id = 'S2'`);
    const mig = migration();
    await db.exec(mig); // second run of the whole migration
    await db.exec(mig); // third: still no duplicates
    const r = await db.query<{ scope_key: string; avg: string | null; lead: string | null; branch_id: string | null }>(
      `select scope_key, avg_daily_sell::text avg, lead_time_days::text lead, branch_id
         from replenishment_rule where scope = 'sku' order by scope_key`);
    expect(r.rows).toEqual([
      { scope_key: 'S1', avg: '1.500', lead: null, branch_id: null },
      { scope_key: 'S2', avg: null, lead: '10.0', branch_id: null },
    ]);
  });

  it('a manually changed rule survives a re-run of the migration', async () => {
    await db.exec(`update master_sku set avg_daily_sales = 1.5 where sku_id = 'S1'`);
    await db.exec(migration());
    await db.exec(`update replenishment_rule set avg_daily_sell = 4 where scope_key = 'S1'`);
    await db.exec(migration());
    const r = await db.query<{ v: string }>(`select avg_daily_sell::text v from replenishment_rule where scope_key = 'S1'`);
    expect(r.rows[0].v).toBe('4.000');
  });

  it('config defaults and window check', async () => {
    const r = await db.query<{ l: string; w: string; v: number }>(
      `select default_lead_time_days::text l, warning_margin_days::text w, velocity_window_days v from system_config`);
    expect(r.rows[0]).toEqual({ l: '7.0', w: '3.0', v: 28 });
    await expectPgError(db.query(`update system_config set velocity_window_days = 6`), 'velocity_window_days');
    await expectPgError(db.query(`update system_config set velocity_window_days = 121`), 'velocity_window_days');
  });

  it('rule shape: scope check, non-negative values, at least one value, unique per scope and branch', async () => {
    await expectPgError(
      db.query(`insert into replenishment_rule (scope, scope_key, avg_daily_sell) values ('bogus','X',1)`), 'scope');
    await expectPgError(
      db.query(`insert into replenishment_rule (scope, scope_key, avg_daily_sell) values ('sku','S1',-1)`), 'avg_daily_sell');
    await expectPgError(
      db.query(`insert into replenishment_rule (scope, scope_key) values ('sku','S1')`), 'replenishment_rule');
    await db.query(`insert into replenishment_rule (scope, scope_key, avg_daily_sell) values ('sku','S1',1)`);
    await expectPgError(
      db.query(`insert into replenishment_rule (scope, scope_key, lead_time_days) values ('sku','S1',2)`), 'uq_rule_scope');
    // a branch-specific rule for the same key is a different row
    await db.query(`insert into replenishment_rule (scope, scope_key, branch_id, lead_time_days) values ('sku','S1','B-MM',2)`);
  });

  it('product group is stored and indexed', async () => {
    await db.exec(`update master_sku set group_name = 'Plain ring' where sku_id = 'S1'`);
    const r = await db.query(`select 1 from pg_indexes where tablename = 'master_sku' and indexdef like '%group_name%'`);
    expect(r.rows).toHaveLength(1);
  });

  it('rule writes are audited', async () => {
    await asActor(db, admin);
    await db.query(`insert into replenishment_rule (scope, scope_key, avg_daily_sell) values ('sku','S1',1)`);
    const r = await db.query(`select 1 from audit_log where table_name = 'replenishment_rule'`);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe('replenishment_rule guard', () => {
  const rule = (branch: string | null, key = 'S1') =>
    db.query(`insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell) values ('sku',$1,$2,1)`, [key, branch]);

  it('manager cannot write a company-wide rule', async () => {
    await asActor(db, mgrMM);
    await expectPgError(rule(null), 'ROLE_DENIED');
  });

  it('manager writes rules for their own branch only', async () => {
    await asActor(db, mgrMM);
    await rule('B-MM');
    await expectPgError(rule('B-TS', 'S2'), 'ROLE_DENIED');
    await db.query(`update replenishment_rule set avg_daily_sell = 5 where branch_id = 'B-MM'`);
    const v = await db.query<{ v: string }>(`select avg_daily_sell::text v from replenishment_rule where branch_id = 'B-MM'`);
    expect(v.rows[0].v).toBe('5.000');
    await asActor(db, mgrTS);
    await expectPgError(db.query(`update replenishment_rule set avg_daily_sell = 9 where branch_id = 'B-MM'`), 'ROLE_DENIED');
    await expectPgError(db.query(`delete from replenishment_rule where branch_id = 'B-MM'`), 'ROLE_DENIED');
  });

  it('admin writes company-wide and branch rules', async () => {
    await asActor(db, admin);
    await rule(null);
    await rule('B-TS', 'S2');
    await db.query(`delete from replenishment_rule where branch_id is null`);
  });

  it('staff cannot write rules', async () => {
    const staff = await account('B-MM', 'Noy', 'staff');
    await asActor(db, staff);
    await expectPgError(rule('B-MM'), 'ROLE_DENIED');
  });
});
