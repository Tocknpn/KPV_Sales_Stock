-- ============================================================================
-- KPV Stock v2 -- roles, permission guards and lockdown.
--
-- Purpose: adds the 'manager' (branch manager) role, enforces who may do what
-- INSIDE the database (so a bug or a stolen service key in the Worker cannot
-- widen anyone's permissions), and shuts the public API (anon / authenticated)
-- out of every table and function. The Worker is the only client and uses the
-- service_role key.
--
-- Run order (fresh project):
--   schema.sql -> migrations/* (name order) -> users_roles.sql -> base.sql
--   -> optional seed_mock_data.sql
-- On the live project re-run THIS FILE after every new migration: it is
-- idempotent, and later tasks append their guards to it.
--
-- First admin (nobody can log in until one exists):
--   npm run db:admin -- "Owner" 4821
--   and paste the SQL it prints into the Supabase SQL editor. The SQL editor
--   has no actor header, so the guards below let it through.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Roles: staff | manager | admin. A non-admin always belongs to a branch.
-- ---------------------------------------------------------------------------
alter table staff_accounts drop constraint if exists staff_accounts_role_check;
alter table staff_accounts add constraint staff_accounts_role_check
  check (role in ('staff', 'manager', 'admin'));

alter table staff_accounts drop constraint if exists staff_branch_required;
alter table staff_accounts add constraint staff_branch_required
  check (role = 'admin' or branch_id is not null);

-- ---------------------------------------------------------------------------
-- 2. Actor helpers. kpv_actor_id() / kpv_jwt_role() come from migration 02.
-- ---------------------------------------------------------------------------
create or replace function kpv_actor() returns table (id uuid, role text, branch_id text)
language sql stable as $$
  select s.id, s.role, s.branch_id from staff_accounts s where s.id = kpv_actor_id()
$$;

-- Raises ROLE_DENIED unless the acting user holds one of p_roles and (for a
-- non-admin, when p_branch is given) belongs to p_branch.
--  * No actor and not service_role (SQL editor, scripts): allowed.
--  * service_role with no actor: refused, whatever tags it carries. (The one
--    system exception, login lockouts, lives in guard_staff_accounts only.)
create or replace function kpv_require(p_roles text[], p_branch text default null) returns void
language plpgsql stable as $$
declare
  a record;
begin
  if kpv_actor_id() is null then
    if kpv_jwt_role() = 'service_role' then
      raise exception 'ROLE_DENIED: a write needs an acting user' using errcode = 'P0001';
    end if;
    return;
  end if;
  select * into a from kpv_actor();
  if not found or not (a.role = any (p_roles)) then
    raise exception 'ROLE_DENIED: role % may not do this', coalesce(a.role, 'unknown') using errcode = 'P0001';
  end if;
  if a.role <> 'admin' and p_branch is not null and a.branch_id is distinct from p_branch then
    raise exception 'ROLE_DENIED: another branch' using errcode = 'P0001';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Guard triggers (BEFORE, so a refusal changes nothing).
-- ---------------------------------------------------------------------------

-- Master data and system config: admin only.
create or replace function guard_master_data() returns trigger
language plpgsql as $$
begin
  perform kpv_require('{admin}');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Staff accounts: admin only, except that a manager may unlock (failed_attempts
-- / locked_until, nothing else) a staff account of their own branch.
create or replace function guard_staff_accounts() returns trigger
language plpgsql as $$
declare
  a record;
begin
  -- Login lockouts: a system-tagged, actor-less write may touch only the
  -- lockout counters.
  if tg_op = 'UPDATE' and kpv_actor_id() is null and kpv_header('x-kpv-actor-system') is not null
     and (to_jsonb(new) - 'failed_attempts' - 'locked_until')
         = (to_jsonb(old) - 'failed_attempts' - 'locked_until') then
    return new;
  end if;
  if tg_op = 'UPDATE' and kpv_actor_id() is not null then
    select * into a from kpv_actor();
    if found and a.role = 'manager'
       and old.role = 'staff' and new.role = 'staff'
       and old.branch_id is not distinct from a.branch_id
       and (to_jsonb(new) - 'failed_attempts' - 'locked_until')
           = (to_jsonb(old) - 'failed_attempts' - 'locked_until') then
      return new;
    end if;
  end if;
  perform kpv_require('{admin}');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Reopening a Done day: admin, or the manager of that branch for a day no
-- older than 3 days.
create or replace function guard_desk_day_reopen() returns trigger
language plpgsql as $$
declare
  a record;
begin
  if old.status = 'done' and new.status <> 'done' then
    perform kpv_require('{admin,manager}', old.branch_id);
    if kpv_actor_id() is not null then
      select * into a from kpv_actor();
      if a.role = 'manager' and old.ledger_date < kpv_today() - 3 then
        raise exception 'REOPEN_TOO_OLD: a manager can reopen a day up to 3 days back' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['master_sku', 'sku_type', 'sku_weight', 'system_config'] loop
    execute format('drop trigger if exists trg_guard_master_data on %I', t);
    execute format(
      'create trigger trg_guard_master_data before insert or update or delete on %I
         for each row execute function guard_master_data()', t);
  end loop;
end $$;

drop trigger if exists trg_guard_staff_accounts on staff_accounts;
create trigger trg_guard_staff_accounts before insert or update or delete on staff_accounts
  for each row execute function guard_staff_accounts();

drop trigger if exists trg_guard_desk_day_reopen on desk_days;
create trigger trg_guard_desk_day_reopen before update on desk_days
  for each row when (old.status = 'done' and new.status <> 'done')
  execute function guard_desk_day_reopen();

-- Closed days: a manager of that branch, or an admin.
create or replace function guard_branch_closed_day() returns trigger
language plpgsql as $$
begin
  perform kpv_require('{admin,manager}', coalesce(new.branch_id, old.branch_id));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Case assignment. Staff may take a case for themselves, or hand over / release
-- a case they hold (the RPC ends the holder's row before inserting the
-- successor, so "holds" also means "ended it by me in this transaction").
-- Taking over someone else's case needs a manager of the branch or an admin.
-- Rows are never rewritten: only ended_* and note may change.
create or replace function guard_desk_assignment() returns trigger
language plpgsql as $$
declare
  v_row desk_assignment := case when tg_op = 'DELETE' then old else new end;
  v_branch text;
  a record;
  st record;
  v_held boolean;
begin
  select branch_id into v_branch from desks where desk_id = v_row.desk_id;

  if tg_op = 'DELETE' then
    perform kpv_require('{admin}');
    return old;
  end if;

  -- History is never rewritten: an active row may only be ended (ended_at and
  -- ended_by set); an ended row never changes again.
  if tg_op = 'UPDATE' and (
        new.id <> old.id or new.desk_id <> old.desk_id or new.staff_id <> old.staff_id
     or new.started_at <> old.started_at or new.started_by is distinct from old.started_by
     or new.note is distinct from old.note or new.is_seed <> old.is_seed
     or (old.ended_at is not null and (new.ended_at is distinct from old.ended_at or new.ended_by is distinct from old.ended_by))
     or (new.ended_at is null and new.ended_by is not null)) then
    raise exception 'ASSIGNMENT_IMMUTABLE: an assignment can only be ended, never rewritten' using errcode = 'P0001';
  end if;

  -- Same branch and active, whoever inserts (the RPC checks too; this is the backstop).
  if tg_op = 'INSERT' then
    select * into st from staff_accounts where id = new.staff_id;
    if not found or not st.active then
      raise exception 'ASSIGN_INACTIVE: that staff account is not active' using errcode = 'P0001';
    end if;
    if st.branch_id is distinct from v_branch then
      raise exception 'ASSIGN_OTHER_BRANCH: staff and case belong to different branches' using errcode = 'P0001';
    end if;
  end if;

  if kpv_actor_id() is null then
    perform kpv_require('{admin,manager}', v_branch);
    return new;
  end if;
  select * into a from kpv_actor();
  if not found then
    perform kpv_require('{admin,manager}', v_branch);
    return new;
  end if;
  if a.role in ('admin', 'manager') then
    perform kpv_require('{admin,manager}', v_branch);
    return new;
  end if;

  -- staff
  perform kpv_require('{staff}', v_branch);
  if tg_op = 'UPDATE' then
    if old.staff_id = a.id then return new; end if;
    raise exception 'ROLE_DENIED: only the holder or a manager can end an assignment' using errcode = 'P0001';
  end if;
  if new.staff_id = a.id then return new; end if;
  select exists (
    select 1 from desk_assignment d
     where d.desk_id = new.desk_id and d.staff_id = a.id
       and (d.ended_at is null or (d.ended_by = a.id and d.ended_at = now()))
  ) into v_held;
  if v_held then return new; end if;
  raise exception 'ROLE_DENIED: staff may only take a case for themselves or hand over their own' using errcode = 'P0001';
end $$;

drop trigger if exists trg_guard_branch_closed_day on branch_closed_day;
create trigger trg_guard_branch_closed_day before insert or update or delete on branch_closed_day
  for each row execute function guard_branch_closed_day();

drop trigger if exists trg_guard_desk_assignment on desk_assignment;
create trigger trg_guard_desk_assignment before insert or update or delete on desk_assignment
  for each row execute function guard_desk_assignment();

-- ---------------------------------------------------------------------------
-- 4. Lockdown: RLS on every table (no policies = no access for anon and
--    authenticated; service_role bypasses RLS) and no grants to the public API.
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

revoke all on all tables    in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated, public;
revoke all on all functions in schema public from anon, authenticated, public;

alter default privileges in schema public revoke all on tables    from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated, public;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

-- The Worker (service_role) runs the triggers and RPCs; revoking from PUBLIC
-- above also removed its implicit execute right, so grant it back explicitly.
grant usage on schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant execute on functions to service_role;
