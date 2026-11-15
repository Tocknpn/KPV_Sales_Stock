-- ============================================================================
-- KPV Stock -- document rows remember their product.
--
-- document_rows.sku_id links a row to the SKU it was picked from, so the
-- printed sheet can group rows by product and weight (the case-sheet layout).
-- Free-text rows and every older row keep sku_id null and print under "ອື່ນໆ".
-- Deleting a SKU (e.g. the mock-data purge) only clears the link.
--
-- Run once in the SQL editor, then re-run users_roles.sql. Safe to run again.
-- ============================================================================

alter table document_rows add column if not exists sku_id text;

alter table document_rows drop constraint if exists document_rows_sku_id_fkey;
alter table document_rows add constraint document_rows_sku_id_fkey
  foreign key (sku_id) references master_sku(sku_id) on delete set null;
