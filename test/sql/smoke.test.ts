import { describe, it, expect } from 'vitest';
import { freshDb } from './db';

describe('PGlite harness', () => {
  it('loads schema.sql and base.sql', async () => {
    const db = await freshDb({ withBase: true });
    const r = await db.query<{ n: number }>('select count(*)::int as n from branches');
    expect(r.rows[0].n).toBe(4);
  });
});
