-- ============================================================================
-- Migration 02 (v2): actor helpers and an immutable, trigger-written,
-- row-level audit trail. Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Actor helpers. The Worker passes the acting user in request headers that
-- PostgREST exposes as the request.headers setting.
-- ---------------------------------------------------------------------------
create or replace function kpv_header(p_name text) returns text
language sql stable as $$
  select nullif(
    case when coalesce(current_setting('request.headers', true), '') = '' then null
         else (current_setting('request.headers', true)::json) ->> p_name end,
    '')
$$;

create or replace function kpv_actor_id() returns uuid
language plpgsql stable as $$
declare
  v text := coalesce(kpv_header('x-kpv-actor-id'), nullif(current_setting('kpv.actor_id', true), ''));
begin
  if v is null then return null; end if;
  begin
    return v::uuid;
  exception when invalid_text_representation then
    return null;
  end;
end $$;

create or replace function kpv_actor_source() returns text
language sql stable as $$
  select case
    when kpv_header('x-kpv-actor-id') is not null then 'api'
    when kpv_header('x-kpv-actor-system') is not null then 'system:' || kpv_header('x-kpv-actor-system')
    else 'sql:' || current_user
  end
$$;

create or replace function kpv_jwt_role() returns text
language sql stable as $$
  select case when coalesce(current_setting('request.jwt.claims', true), '') = '' then null
              else (current_setting('request.jwt.claims', true)::json) ->> 'role' end
$$;

-- ---------------------------------------------------------------------------
-- audit_log: v1 columns stay; the trigger fills the new ones.
-- ---------------------------------------------------------------------------
alter table audit_log add column if not exists table_name text;
alter table audit_log add column if not exists op         text;
alter table audit_log add column if not exists row_key    jsonb;
alter table audit_log add column if not exists desk_id    text;
alter table audit_log add column if not exists branch_id  text;
alter table audit_log add column if not exists actor_role text;
alter table audit_log add column if not exists source     text;
alter table audit_log add column if not exists old_values jsonb;
alter table audit_log add column if not exists new_values jsonb;

create index if not exists idx_audit_desk   on audit_log (desk_id,   created_at desc);
create index if not exists idx_audit_branch on audit_log (branch_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Generic row trigger.
-- ---------------------------------------------------------------------------
create or replace function audit_row_change() returns trigger
language plpgsql as $$
declare
  o jsonb;
  n jsonb;
  ign text[] := array['updated_at', 'performed_by', 'created_at'];
  k text;
  ov jsonb;
  nv jsonb;
  src jsonb;
  rk jsonb;
  v_actor uuid;
  v_name text;
  v_role text;
begin
  if kpv_is_purging() then return null; end if;

  if kpv_actor_id() is null and kpv_jwt_role() = 'service_role'
     and coalesce(kpv_header('x-kpv-actor-system'), '') = '' then
    raise exception 'AUDIT_ACTOR_MISSING: %', tg_table_name using errcode = 'P0001';
  end if;

  if tg_op <> 'INSERT' then o := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new); end if;
  src := coalesce(n, o);

  if tg_table_name = 'staff_accounts' then
    ign := ign || array['failed_attempts', 'token_version'];
  end if;
  -- generated columns (e.g. closing_qty) follow from the real changes: not logged
  ign := ign || coalesce((
    select array_agg(attname::text) from pg_attribute
    where attrelid = tg_relid and attnum > 0 and not attisdropped and attgenerated <> ''), '{}');

  if tg_op = 'UPDATE' then
    ov := '{}'::jsonb; nv := '{}'::jsonb;
    for k in select jsonb_object_keys(n) loop
      continue when k = any (ign);
      if (o -> k) is distinct from (n -> k) then
        ov := ov || jsonb_build_object(k, o -> k);
        nv := nv || jsonb_build_object(k, n -> k);
      end if;
    end loop;
    if ov = '{}'::jsonb and nv = '{}'::jsonb then return null; end if;
  else
    ov := case when o is null then null else o - ign end;
    nv := case when n is null then null else n - ign end;
  end if;

  if tg_table_name = 'staff_accounts' then
    if ov ? 'pin_hash' then ov := jsonb_set(ov, '{pin_hash}', '"changed"'); end if;
    if nv ? 'pin_hash' then nv := jsonb_set(nv, '{pin_hash}', '"changed"'); end if;
  end if;

  select coalesce(jsonb_object_agg(a.attname, src -> a.attname), '{}'::jsonb) into rk
  from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
  where i.indrelid = tg_relid and i.indisprimary;

  v_actor := kpv_actor_id();
  if v_actor is not null then
    select display_name, role into v_name, v_role from staff_accounts where id = v_actor;
  end if;

  insert into audit_log (
    actor_id, actor_name, action, target, table_name, op, row_key,
    desk_id, branch_id, actor_role, source, old_values, new_values, is_seed
  ) values (
    v_actor,
    coalesce(v_name, kpv_actor_source()),
    lower(tg_op) || ':' || tg_table_name,
    rk::text,
    tg_table_name, tg_op, rk,
    coalesce(src ->> 'desk_id', src ->> 'from_desk_id'),
    coalesce(src ->> 'branch_id', src ->> 'from_branch_id'),
    v_role,
    kpv_actor_source(),
    ov, nv,
    coalesce((src ->> 'is_seed')::boolean, false)
  );
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- audit_log is append-only. Seed rows may be deleted while purging.
-- ---------------------------------------------------------------------------
create or replace function audit_log_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and kpv_is_purging() and old.is_seed then return old; end if;
  raise exception 'AUDIT_IMMUTABLE: audit_log rows cannot be %d', lower(tg_op) using errcode = 'P0001';
end $$;

create or replace function audit_log_no_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_IMMUTABLE: audit_log cannot be truncated' using errcode = 'P0001';
end $$;

drop trigger if exists trg_audit_log_immutable on audit_log;
create trigger trg_audit_log_immutable before update or delete on audit_log
  for each row execute function audit_log_immutable();
drop trigger if exists trg_audit_log_no_truncate on audit_log;
create trigger trg_audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_no_truncate();

-- ---------------------------------------------------------------------------
-- Attach helper (also used by later migrations for new tables).
-- ---------------------------------------------------------------------------
create or replace function kpv_attach_audit(p_table regclass) returns void
language plpgsql as $$
declare
  v_name text := 'trg_' || (select relname from pg_class where oid = p_table) || '_audit';
begin
  execute format('drop trigger if exists %I on %s', v_name, p_table);
  execute format(
    'create trigger %I after insert or update or delete on %s for each row execute function audit_row_change()',
    v_name, p_table);
end $$;
revoke execute on function kpv_attach_audit(regclass) from public, anon, authenticated;

select kpv_attach_audit(t::regclass) from unnest(array[
  'desks', 'staff_accounts', 'master_sku', 'sku_type', 'sku_weight', 'desk_days',
  'daily_stock_ledger', 'transfers', 'documents', 'document_rows', 'system_config'
]) as t;
