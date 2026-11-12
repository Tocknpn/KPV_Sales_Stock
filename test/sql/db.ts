import { PGlite } from '@electric-sql/pglite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SUPABASE_DIR = join(process.cwd(), 'supabase');

function readSql(...parts: string[]): string {
  return readFileSync(join(SUPABASE_DIR, ...parts), 'utf8');
}

export interface FreshDbOptions {
  /** Last migration (file name, with or without .sql) to apply; default all. */
  upTo?: string;
  withRoles?: boolean;
  withBase?: boolean;
}

/** In-memory Postgres loaded with the real Supabase SQL, in fresh-project order. */
export async function freshDb(opts: FreshDbOptions = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    do $$
    declare r text;
    begin
      foreach r in array array['anon', 'authenticated', 'service_role'] loop
        if not exists (select from pg_roles where rolname = r) then
          execute format('create role %I', r);
        end if;
      end loop;
    end $$;
  `);
  await db.exec(readSql('schema.sql'));

  const migDir = join(SUPABASE_DIR, 'migrations');
  if (existsSync(migDir)) {
    const stop = opts.upTo?.replace(/\.sql$/, '');
    const files = readdirSync(migDir).filter((f: string) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (stop && f.replace(/\.sql$/, '') > stop) break;
      await db.exec(readSql('migrations', f));
    }
  }

  if (opts.withRoles) {
    if (!existsSync(join(SUPABASE_DIR, 'users_roles.sql'))) {
      throw new Error('withRoles: supabase/users_roles.sql is missing');
    }
    await db.exec(readSql('users_roles.sql'));
  }
  if (opts.withBase) await db.exec(readSql('base.sql'));
  return db;
}

/** Mimic PostgREST request context for a given actor (null = no actor header). */
export async function asActor(
  db: PGlite,
  actorId: string | null,
  opts: { system?: string; jwtRole?: string } = {},
): Promise<void> {
  const headers: Record<string, string> = {};
  if (actorId) headers['x-kpv-actor-id'] = actorId;
  if (opts.system) headers['x-kpv-actor-system'] = opts.system;
  await db.query(`select set_config('request.headers', $1, false)`, [JSON.stringify(headers)]);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ role: opts.jwtRole ?? 'service_role' }),
  ]);
}

/** Assert the promise rejects with a Postgres error whose message contains `code`. */
export async function expectPgError(p: Promise<unknown>, code: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`expected Postgres error containing "${code}", but the query succeeded`);
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes(code)) throw new Error(`expected error containing "${code}", got: ${msg}`);
}
