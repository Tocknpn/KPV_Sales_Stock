import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './db';

const migration = () => readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261117_14_sku_simplify.sql'), 'utf8');

describe('20261117_14_sku_simplify', () => {
  it('folds group and branch rules into company SKU / Type rules, fixes Baht weights and names; safe to re-run', async () => {
    const db = await freshDb({ upTo: '20261116_13_plain_passwords', withBase: true });
    await db.exec(`
      insert into master_sku (sku_id, name_en, name_lo, category, type_id, weight_id, std_gram_weight, baht_weight, group_name) values
        ('NK-1', 'Snake 1', 'ງູ 1',  'Gold Bars', 'GOLD_BARS', 'BAHT_1', 15.244, 0,   'Snake'),
        ('NK-2', 'Snake 2', null,    'Gold Bars', 'GOLD_BARS', 'BAHT_1', 15.244, 0.9, 'Snake'),
        ('NK-3', 'Snake 3', '',      'Gold Bars', 'GOLD_BARS', null,     null,   2,   null);
      insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days) values
        ('group', 'Snake',     null,   1.5,  7),     -- -> NK-1 (new rule), NK-2 (fills its lead)
        ('sku',   'NK-2',      null,   3,    null),
        ('sku',   'NK-3',      'B-MM', 4,    2),     -- branch rule, no company rule -> becomes company
        ('type',  'GOLD_BARS', 'B-MM', 9,    9),     -- branch rule, company exists -> dropped
        ('type',  'GOLD_BARS', null,   1,    null);
      update system_config set stock_out_mode = 'single';
    `);

    const snapshot = async () => ({
      rules: (await db.query(`select scope, scope_key, branch_id, avg_daily_sell::float as avg, lead_time_days::float as lead
                                from replenishment_rule order by scope, scope_key`)).rows,
      skus: (await db.query(`select sku_id, name_lo, baht_weight::float as baht from master_sku where sku_id like 'NK-%' order by sku_id`)).rows,
      mode: (await db.query<{ stock_out_mode: string }>(`select stock_out_mode from system_config`)).rows[0].stock_out_mode,
    });

    await db.exec(migration());
    const first = await snapshot();
    expect(first.rules).toEqual([
      { scope: 'sku', scope_key: 'NK-1', branch_id: null, avg: 1.5, lead: 7 },
      { scope: 'sku', scope_key: 'NK-2', branch_id: null, avg: 3, lead: 7 },
      { scope: 'sku', scope_key: 'NK-3', branch_id: null, avg: 4, lead: 2 },
      { scope: 'type', scope_key: 'GOLD_BARS', branch_id: null, avg: 1, lead: null },
    ]);
    expect(first.skus).toEqual([
      { sku_id: 'NK-1', name_lo: 'ງູ 1', baht: 1 },
      { sku_id: 'NK-2', name_lo: 'Snake 2', baht: 1 },
      { sku_id: 'NK-3', name_lo: 'Snake 3', baht: 2 }, // no size: Baht weight left as it was
    ]);
    expect(first.mode).toBe('dynamic');

    await db.exec(migration());
    expect(await snapshot()).toEqual(first);
  });
});
