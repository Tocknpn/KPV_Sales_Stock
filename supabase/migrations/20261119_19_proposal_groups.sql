-- Reorder proposals: several cases saved together, balance kept per row, one
-- proposal per case per day (decided 2026-11-19). Idempotent; safe to re-run.
--
--   * documents.group_id: the cases one manager saved together share it, so the
--     list can offer "Print all" and the PDF prints them one after another.
--   * document_rows.balance: the stock the manager saw when ordering (opening
--     before the day's final count, closing after it).
--   * One live proposal per case per day: a pending or approved proposal blocks
--     a second one for the same case and date. Rejected or deleted ones do not.

alter table documents add column if not exists group_id uuid;
create index if not exists idx_documents_group on documents(group_id) where group_id is not null;
create index if not exists idx_documents_created_by on documents(created_by);

alter table document_rows add column if not exists balance numeric(12,3);

-- The index is only built when the existing data already obeys the rule; the
-- app checks the rule either way. Clean up the duplicates the notice lists and
-- re-run this file to add the index.
do $$
declare dup record;
begin
  if exists (select 1 from pg_indexes where indexname = 'uq_documents_proposal_case_day') then
    return;
  end if;
  for dup in
    select desk_id, doc_date, count(*) as n from documents
     where kind = 'proposal' and status in ('pending','approved') and desk_id is not null
     group by desk_id, doc_date having count(*) > 1
  loop
    raise notice 'Duplicate live proposals: case % on % (% proposals)', dup.desk_id, dup.doc_date, dup.n;
  end loop;
  if found then
    raise notice 'uq_documents_proposal_case_day not created: reject or delete the duplicates above, then re-run.';
    return;
  end if;
  create unique index uq_documents_proposal_case_day on documents(desk_id, doc_date)
    where kind = 'proposal' and status in ('pending','approved') and desk_id is not null;
end $$;
