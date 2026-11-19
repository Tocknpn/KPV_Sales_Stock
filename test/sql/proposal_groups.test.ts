import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, expectPgError } from './db';

const migration = () => readFileSync(join(process.cwd(), 'supabase', 'migrations', '20261119_19_proposal_groups.sql'), 'utf8');

async function proposal(db: Awaited<ReturnType<typeof freshDb>>, no: string, desk: string, date: string, status: string) {
  await db.query(
    `insert into documents (doc_no, title, branch_id, desk_id, created_by, doc_date, kind, status) values ($1,'t','B-MM',$2,'x',$3,'proposal',$4)`,
    [no, desk, date, status],
  );
}

describe('20261119_19_proposal_groups', () => {
  it('one live proposal per case per day; rejected ones and other days do not count', async () => {
    const db = await freshDb({ withBase: true });
    await db.exec(`insert into desks (desk_id, branch_id, display_name) values ('MM-D01','B-MM','a')`);
    await proposal(db, 'P1', 'MM-D01', '2026-11-19', 'rejected');
    await proposal(db, 'P2', 'MM-D01', '2026-11-19', 'pending');
    await expectPgError(proposal(db, 'P3', 'MM-D01', '2026-11-19', 'pending'), 'uq_documents_proposal_case_day');
    await proposal(db, 'P4', 'MM-D01', '2026-11-18', 'pending');
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where (table_name = 'documents' and column_name = 'group_id') or (table_name = 'document_rows' and column_name = 'balance')`,
    );
    expect(cols.rows).toHaveLength(2);
  });

  it('re-runs cleanly', async () => {
    const db = await freshDb({ withBase: true });
    await db.exec(migration());
    await db.exec(migration());
  });
});
