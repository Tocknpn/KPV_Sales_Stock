-- Sales Sup user rights (decided 2026-11-27). Idempotent; safe to re-run.
--
-- The "Branch manager" role is shown as "Sales Sup" in the app (the database
-- keeps role = 'manager'). A Sales Sup may now ADD a staff account to their
-- own branch. Changing a user's role or branch stays admin only.
-- Same function as supabase/users_roles.sql (kept in step there).

-- Staff accounts: admin only, except that a Sales Sup (manager) may unlock
-- (failed_attempts / locked_until, nothing else) a staff account of their own
-- branch, and add a staff account to their own branch.
create or replace function guard_staff_accounts() returns trigger
language plpgsql as $$
declare
  a record;
begin
  -- Login: a system-tagged, actor-less write may touch only the lockout
  -- counters, and fill password_plain while it is still empty (the backfill
  -- of the admin-readable password, migration 13). It can never replace one.
  if tg_op = 'UPDATE' and kpv_actor_id() is null and kpv_header('x-kpv-actor-system') is not null
     and (to_jsonb(new) - 'failed_attempts' - 'locked_until' - 'password_plain')
         = (to_jsonb(old) - 'failed_attempts' - 'locked_until' - 'password_plain')
     and (to_jsonb(new) -> 'password_plain' is not distinct from to_jsonb(old) -> 'password_plain'
          or to_jsonb(old) ->> 'password_plain' is null) then
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
  -- A Sales Sup (role 'manager') may add a staff account to their own branch
  -- (decided 2026-11-27). Nothing else: no other role, no other branch.
  if tg_op = 'INSERT' and kpv_actor_id() is not null then
    select * into a from kpv_actor();
    if found and a.role = 'manager' and new.role = 'staff' and new.branch_id is not distinct from a.branch_id then
      return new;
    end if;
  end if;
  perform kpv_require('{admin}');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
