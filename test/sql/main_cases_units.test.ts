import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asActor, expectPgError } from './db';

const migration = () => readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261119_18_main_cases_units.sql'), 'utf8');

async function account(db: Awaited<ReturnType<typeof freshDb>>, branch: string | null, name: string, role: string) {
  const r = await db.query<{ id: string }>(
    `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ($1,$2,'h',$3) returning id`,
    [branch, name, role],
  );
  return r.rows[0].id;
}

describe('20261119_18_main_cases_units', () => {
  it('main cases: admin or the branch manager may set them; staff and other branches may not', async () => {
    const db = await freshDb({ withBase: true, withRoles: true });
    const admin = await account(db, null, 'Owner', 'admin');
    const mgrMM = await account(db, 'B-MM', 'Mgr MM', 'manager');
    const mgrVTC = await account(db, 'B-VTC', 'Mgr VTC', 'manager');
    const staffMM = await account(db, 'B-MM', 'Staff MM', 'staff');
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','a'), ('MM-D02','B-MM','b'), ('VTC-D01','B-VTC','c')`);
    const mine = async () =>
      (await db.query<{ desk_id: string }>(`select desk_id from staff_main_case where staff_id = $1 order by desk_id`, [staffMM])).rows.map((r) => r.desk_id);

    await asActor(db, mgrMM);
    await db.query(`select set_main_cases($1, $2)`, [staffMM, ['MM-D01', 'MM-D02']]);
    expect(await mine()).toEqual(['MM-D01', 'MM-D02']);
    await db.query(`select set_main_cases($1, $2)`, [staffMM, ['MM-D02']]);
    expect(await mine()).toEqual(['MM-D02']);

    // A case of another branch.
    await expectPgError(db.query(`select set_main_cases($1, $2)`, [staffMM, ['VTC-D01']]), 'ASSIGN_OTHER_BRANCH');
    // The manager of another branch.
    await asActor(db, mgrVTC);
    await expectPgError(db.query(`select set_main_cases($1, $2)`, [staffMM, ['MM-D01']]), 'ROLE_DENIED');
    // Staff, even for themselves.
    await asActor(db, staffMM);
    await expectPgError(db.query(`select set_main_cases($1, $2)`, [staffMM, ['MM-D01']]), 'ROLE_DENIED');
    // Admin, and an empty list clears.
    await asActor(db, admin);
    await db.query(`select set_main_cases($1, $2)`, [staffMM, []]);
    expect(await mine()).toEqual([]);
  });

  it('fills qty + unit on existing sizes, keeps one type name, and is safe to re-run', async () => {
    const db = await freshDb({ upTo: '20261118_17_sop_steps' });
    await db.exec(`
      insert into sku_type (type_id, name_en, name_lo) values ('BARS', 'Gold Bars', 'ທອງຄຳແທ່ງ'), ('X', 'Only English', null);
      insert into sku_weight (weight_id, name_en, gram_value) values
        ('B1', '1 Baht', 15.244), ('S1', '1 ສະຫຼຶງ', 3.811), ('H1', 'hun', 0.3811),
        ('S6', '1.5 Baht', 22.866), ('G375', '3.75g', 3.75), ('K1', '1kg', 1000);
      insert into master_sku (sku_id, name_en, category, type_id) values ('A', 'a', 'Gold Bars', 'BARS'), ('B', 'b', 'Only English', 'X');
    `);
    const snapshot = async () => ({
      weights: (await db.query(`select weight_id, name_en, qty::float as qty, unit from sku_weight order by weight_id`)).rows,
      types: (await db.query(`select type_id, name_en, name_lo from sku_type order by type_id`)).rows,
      cats: (await db.query(`select sku_id, category from master_sku order by sku_id`)).rows,
    });
    await db.exec(migration());
    const first = await snapshot();
    expect(first.weights).toEqual([
      { weight_id: 'B1', name_en: '1 ບາດ', qty: 1, unit: 'ບາດ' },
      { weight_id: 'G375', name_en: '3.75 ກລາມ', qty: 3.75, unit: 'ກລາມ' },
      { weight_id: 'H1', name_en: '1 ຫຸນ', qty: 1, unit: 'ຫຸນ' },
      { weight_id: 'K1', name_en: '1 ກິໂລ', qty: 1, unit: 'ກິໂລ' },
      { weight_id: 'S1', name_en: '1 ສະຫຼຶງ', qty: 1, unit: 'ສະຫຼຶງ' },
      { weight_id: 'S6', name_en: '6 ສະຫຼຶງ', qty: 6, unit: 'ສະຫຼຶງ' },
    ]);
    expect(first.types).toEqual([
      { type_id: 'BARS', name_en: 'ທອງຄຳແທ່ງ', name_lo: 'ທອງຄຳແທ່ງ' },
      { type_id: 'X', name_en: 'Only English', name_lo: 'Only English' },
    ]);
    expect(first.cats).toEqual([
      { sku_id: 'A', category: 'ທອງຄຳແທ່ງ' },
      { sku_id: 'B', category: 'Only English' },
    ]);
    await db.exec(migration());
    expect(await snapshot()).toEqual(first);
  });
});
