import { describe, it, expect } from 'vitest';
import { freshDb, asActor } from './db';

describe('PGlite harness', () => {
  it('loads schema.sql and base.sql', async () => {
    const db = await freshDb({ withBase: true });
    const r = await db.query<{ n: number }>('select count(*)::int as n from branches');
    expect(r.rows[0].n).toBe(4);
  });

  it('asActor mimics PostgREST headers and claims', async () => {
    const db = await freshDb();
    const id = '11111111-1111-1111-1111-111111111111';
    await asActor(db, id, { system: 'login', jwtRole: 'service_role' });
    const r = await db.query<{ a: string; s: string; role: string }>(
      `select current_setting('request.headers', true)::json->>'x-kpv-actor-id' as a,
              current_setting('request.headers', true)::json->>'x-kpv-actor-system' as s,
              current_setting('request.jwt.claims', true)::json->>'role' as role`,
    );
    expect(r.rows[0]).toEqual({ a: id, s: 'login', role: 'service_role' });

    await asActor(db, null);
    const n = await db.query<{ a: string | null }>(
      `select current_setting('request.headers', true)::json->>'x-kpv-actor-id' as a`,
    );
    expect(n.rows[0].a).toBeNull();
  });
});
