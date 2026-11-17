import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './db';

const migration = () => readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261117_15_branch_sku.sql'), 'utf8');

describe('20261117_15_branch_sku', () => {
  it('copies company rules into every branch, drops them, seeds branch_sku; safe to re-run', async () => {
    const db = await freshDb({ upTo: '20261117_14_sku_simplify', withBase: true });
    await db.exec(`
      insert into master_sku (sku_id, name_en, name_lo, category, type_id) values
        ('NK-1', 'Snake 1', 'ງູ 1', 'Gold Bars', 'GOLD_BARS'),
        ('NK-2', 'Snake 2', 'ງູ 2', 'Gold Bars', 'GOLD_BARS');
      insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days) values
        ('sku',  'NK-1',      null,   1.5, 7),
        ('type', 'GOLD_BARS', null,   1,   null),
        ('sku',  'NK-1',      'B-MM', 9,   null);   -- branch value wins; only its blank lead is filled
    `);
    const branches = (await db.query<{ branch_id: string }>(`select branch_id from branches order by branch_id`)).rows.map((r) => r.branch_id);
    const skuCount = Number((await db.query<{ n: number }>(`select count(*)::int as n from master_sku`)).rows[0].n);

    const snapshot = async () => ({
      rules: (await db.query(`select scope, scope_key, branch_id, avg_daily_sell::float as avg, lead_time_days::float as lead
                                from replenishment_rule order by scope, scope_key, branch_id`)).rows,
      carried: (await db.query<{ n: number; on: number }>(`select count(*)::int as n, count(*) filter (where carried)::int as on from branch_sku`)).rows[0],
    });

    await db.exec(migration());
    const first = await snapshot();
    const expected = [
      ...branches.map((b) => ({ scope: 'sku', scope_key: 'NK-1', branch_id: b, avg: b === 'B-MM' ? 9 : 1.5, lead: 7 })),
      ...branches.map((b) => ({ scope: 'type', scope_key: 'GOLD_BARS', branch_id: b, avg: 1, lead: null })),
    ];
    expect(first.rules).toEqual(expected);
    expect(first.rules.some((r: any) => r.branch_id === null)).toBe(false);
    expect(first.carried).toEqual({ n: branches.length * skuCount, on: branches.length * skuCount });

    await db.exec(migration());
    expect(await snapshot()).toEqual(first);
  });
});
