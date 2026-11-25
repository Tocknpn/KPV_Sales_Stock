import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asActor, expectPgError } from './db';

const migration = () => readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261125_20_size_units.sql'), 'utf8');

async function account(db: Awaited<ReturnType<typeof freshDb>>, branch: string | null, name: string, role: string) {
  const r = await db.query<{ id: string }>(
    `insert into staff_accounts (branch_id, display_name, pin_hash, role) values ($1,$2,'h',$3) returning id`,
    [branch, name, role],
  );
  return r.rows[0].id;
}

describe('20261125_20_size_units', () => {
  it('makes units from the sizes in use, fills each size\'s parts, and is safe to re-run', async () => {
    const db = await freshDb({ upTo: '20261119_19_proposal_groups' });
    await db.exec(`
      insert into sku_weight (weight_id, name_en, qty, unit, gram_value) values
        ('B8', '8 ບາດ', 8, 'ບາດ', 120), ('B1', '1 ບາດ', 1, 'ບາດ', 15), ('S2', '2 ສະຫຼຶງ', 2, 'ສະຫຼຶງ', 7.5),
        ('T1', '1 ຕຳລຶງ', 1, 'ຕຳລຶງ', 60), ('OLD', 'old', null, null, 3);
    `);
    await db.exec(migration());
    const snapshot = async () => ({
      units: (await db.query(`select unit, gram_value::float as g, sort_order from sku_unit order by sort_order`)).rows,
      parts: (await db.query(`select weight_id, parts from sku_weight order by weight_id`)).rows,
    });
    const first = await snapshot();
    // Grams from the size closest to 1 of the unit; the usual units added.
    expect(first.units).toEqual([
      { unit: 'ກິໂລ', g: 1000, sort_order: 1 },
      { unit: 'ຕຳລຶງ', g: 60, sort_order: 2 },
      { unit: 'ບາດ', g: 15, sort_order: 3 },
      { unit: 'ສະຫຼຶງ', g: 3.75, sort_order: 4 },
      { unit: 'ກລາມ', g: 1, sort_order: 5 },
      { unit: 'ຫຸນ', g: 0.3811, sort_order: 6 },
    ]);
    expect(first.parts).toEqual([
      { weight_id: 'B1', parts: [{ unit: 'ບາດ', qty: 1 }] },
      { weight_id: 'B8', parts: [{ unit: 'ບາດ', qty: 8 }] },
      { weight_id: 'OLD', parts: null },
      { weight_id: 'S2', parts: [{ unit: 'ສະຫຼຶງ', qty: 2 }] },
      { weight_id: 'T1', parts: [{ unit: 'ຕຳລຶງ', qty: 1 }] },
    ]);
    await db.exec(migration());
    expect(await snapshot()).toEqual(first);
  });

  it('any role may add a size; only an admin may add or change a unit', async () => {
    const db = await freshDb({ withBase: true, withRoles: true });
    const admin = await account(db, null, 'Owner', 'admin');
    const staff = await account(db, 'B-MM', 'Staff MM', 'staff');

    await asActor(db, staff);
    await db.exec(`insert into sku_weight (weight_id, name_en, gram_value, parts) values ('W_X', '4 ບາດ 2 ສະຫຼຶງ', 68.598, '[{"unit":"ບາດ","qty":4},{"unit":"ສະຫຼຶງ","qty":2}]')`);
    await expectPgError(db.query(`update sku_weight set gram_value = 1 where weight_id = 'W_X'`), 'ROLE_DENIED');
    await expectPgError(db.query(`insert into sku_unit (unit, gram_value) values ('ຕຳລຶງ', 60)`), 'ROLE_DENIED');
    await expectPgError(db.query(`update sku_unit set gram_value = 15 where unit = 'ບາດ'`), 'ROLE_DENIED');

    await asActor(db, admin);
    await db.exec(`insert into sku_unit (unit, gram_value) values ('ຕຳລຶງ', 60)`);
    await db.exec(`update sku_unit set gram_value = 15 where unit = 'ບາດ'`);
    const r = await db.query<{ g: number }>(`select gram_value::float as g from sku_unit where unit = 'ບາດ'`);
    expect(r.rows[0].g).toBe(15);
  });
});
