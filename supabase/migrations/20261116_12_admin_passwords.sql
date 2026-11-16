-- ============================================================================
-- 20261116_12 — admin-readable passwords. Additive, idempotent.
--
-- In-house decision (2026-11-16): an admin can see each person's password in
-- Settings > Users. Login still checks the pbkdf2 hash in pin_hash. This adds
-- a second copy:
--   * staff_accounts.password_enc: the password encrypted with AES-GCM by the
--     Worker under its PASSWORD_KEY secret ('v1$<iv>$<ciphertext>'). The
--     database never holds the key, so this column alone reveals nothing.
--     null = not known yet: set on create / reset, or captured the next time
--     that person logs in successfully.
--   * audit_row_change: password_enc is never written to the audit log (the
--     pin_hash "changed" entry already records a reset).
--
-- Run once in the SQL editor, then re-run users_roles.sql (its login rule now
-- lets a login fill an empty password_enc). Safe to run again.
-- ============================================================================

alter table staff_accounts add column if not exists password_enc text;

-- Body from migration 02; staff_accounts also ignores password_enc.
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
  ctx jsonb;
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
    ign := ign || array['failed_attempts', 'token_version', 'password_enc'];
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

  -- identifying columns of the row, whatever changed (NEW, or OLD on DELETE)
  select jsonb_object_agg(e.key, e.value) into ctx
  from jsonb_each(src) e
  where e.key = any (array['ledger_date', 'desk_id', 'sku_id', 'branch_id', 'from_desk_id',
                           'to_desk_id', 'from_branch_id', 'to_branch_id', 'staff_id',
                           'document_id', 'kind', 'qty', 'status'])
    and e.value <> 'null'::jsonb;

  v_actor := kpv_actor_id();
  if v_actor is not null then
    select display_name, role into v_name, v_role from staff_accounts where id = v_actor;
  end if;

  insert into audit_log (
    actor_id, actor_name, action, target, table_name, op, row_key,
    desk_id, branch_id, actor_role, source, old_values, new_values, is_seed,
    context, to_desk_id, to_branch_id
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
    coalesce((src ->> 'is_seed')::boolean, false),
    ctx, src ->> 'to_desk_id', src ->> 'to_branch_id'
  );
  return null;
end $$;
