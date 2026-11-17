import { describe, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './db';

const sqlFile = (...p: string[]) => readFileSync(join(process.cwd(), 'supabase', ...p), 'utf8');
const realSkus = async (db: PGlite) =>
  Number((await db.query<{ n: string }>(`select count(*)::text as n from master_sku where not is_seed`)).rows[0].n);
const expected = (sqlFile('real_skus.sql').match(/^\s+\('/gm) ?? []).length;

describe('real_skus.sql', () => {
  it('loads every SKU as real, and running it twice changes nothing', async () => {
    const db = await freshDb({ withRoles: true, withBase: true });
    await db.exec(sqlFile('real_skus.sql'));
    expect(expected).toBeGreaterThan(100);
    expect(await realSkus(db)).toBe(expected);
    await db.exec(sqlFile('real_skus.sql'));
    expect(await realSkus(db)).toBe(expected);
    const bad = await db.query(`select sku_id from master_sku m left join sku_type t using (type_id)
                                 where not m.is_seed and (t.type_id is null or m.category <> t.name_en)`);
    expect(bad.rows).toEqual([]);
  });

  it('a re-run leaves each branch\'s carries choices alone', async () => {
    const db = await freshDb({ withRoles: true, withBase: true });
    await db.exec(sqlFile('real_skus.sql'));
    const first = await db.query<{ n: number }>(`select count(*)::int n from branch_sku where carried`);
    expect(first.rows[0].n).toBe(expected * 4);
    // A branch-only SKU (added by staff) and a SKU one branch stopped selling.
    await db.exec(`
      insert into master_sku (sku_id, name_en, category, type_id) values ('ST-1', 'Staff ring', 'Rings & Accessories', 'RINGS_ACCESSORIES');
      insert into branch_sku (branch_id, sku_id, carried) values ('B-MM', 'ST-1', true);
      update branch_sku set carried = false where branch_id = 'B-VT' and sku_id = 'BAR-1G';
    `);
    await db.exec(sqlFile('real_skus.sql'));
    const st = await db.query(`select branch_id from branch_sku where sku_id = 'ST-1' order by 1`);
    expect(st.rows).toEqual([{ branch_id: 'B-MM' }]);
    const off = await db.query(`select carried from branch_sku where branch_id = 'B-VT' and sku_id = 'BAR-1G'`);
    expect(off.rows).toEqual([{ carried: false }]);
  });

  it('works after the mock data, passes verify_v2, and survives the purge', async () => {
    const db = await freshDb({ withRoles: true, withBase: true });
    await db.exec(sqlFile('seed_mock_data.sql'));
    await db.exec(sqlFile('real_skus.sql'));
    await db.exec(sqlFile('tests', 'verify_v2.sql'));
    await db.exec(sqlFile('purge_seed_data.sql'));
    expect(await realSkus(db)).toBe(expected);
    const left = await db.query(`select count(*)::int as n from master_sku where is_seed`);
    expect(left.rows[0]).toEqual({ n: 0 });
  });
});
