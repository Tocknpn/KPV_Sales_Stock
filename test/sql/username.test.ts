import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, expectPgError } from './db';

const migration = () => readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261113_08_username_login.sql'), 'utf8');

describe('20261113_08_username_login', () => {
  it('gives existing accounts unique usernames from their display names, and is safe to re-run', async () => {
    const db = await freshDb({ upTo: '20261112_07_seed_tools', withBase: true });
    await db.exec(`
      insert into staff_accounts (branch_id, display_name, pin_hash, role, created_at) values
        (null,   'Owner',       'h', 'admin', now() - interval '5 min'),
        ('B-MM', 'Somchai S.',  'h', 'staff', now() - interval '4 min'),
        ('B-TS', 'Somchai S',   'h', 'staff', now() - interval '3 min'),
        ('B-IT', 'ນ້ອຍ',         'h', 'staff', now() - interval '2 min'),
        ('B-VT', 'ແກ້ວ',         'h', 'staff', now() - interval '1 min'),
        ('B-VT', 'Al',          'h', 'staff', now());
    `);
    await db.exec(migration());
    const rows = (await db.query<{ display_name: string; username: string }>(
      `select display_name, username from staff_accounts order by created_at`)).rows;
    expect(rows.map((r) => r.username)).toEqual(['owner', 'somchais', 'somchais2', 'user', 'user2', 'al01']);

    await db.exec(migration());
    const again = (await db.query<{ username: string }>(`select username from staff_accounts order by created_at`)).rows;
    expect(again.map((r) => r.username)).toEqual(rows.map((r) => r.username));
  });

  it('enforces the format and uniqueness', async () => {
    const db = await freshDb({ withBase: true });
    await db.exec(`insert into staff_accounts (display_name, username, pin_hash, role) values ('A', 'boss', 'h', 'admin')`);
    await expectPgError(
      db.exec(`insert into staff_accounts (display_name, username, pin_hash, role) values ('B', 'boss', 'h', 'admin')`),
      'idx_staff_accounts_username');
    await expectPgError(
      db.exec(`insert into staff_accounts (display_name, username, pin_hash, role) values ('C', 'Has Space', 'h', 'admin')`),
      'staff_username_format');
  });
});
