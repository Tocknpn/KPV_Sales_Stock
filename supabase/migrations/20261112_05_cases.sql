-- Branch closed days and case ("desk") assignment with handover history.
-- Idempotent. The role guards for both tables live in users_roles.sql.

-- ---------------------------------------------------------------------------
-- Closed days: a date on which a branch is shut (holiday). Skipped by streaks
-- and "required date" rules.
-- ---------------------------------------------------------------------------
create table if not exists branch_closed_day (
  branch_id   text not null references branches(branch_id),
  closed_date date not null,
  reason      text not null,
  created_by  uuid default kpv_actor_id(),
  created_at  timestamptz not null default now(),
  is_seed     boolean not null default false,
  primary key (branch_id, closed_date)
);

-- ---------------------------------------------------------------------------
-- Assignment: who is responsible for a case. History is kept; only ended_*
-- (and note) ever change. At most one active row per case.
-- ---------------------------------------------------------------------------
create table if not exists desk_assignment (
  id         uuid primary key default gen_random_uuid(),
  desk_id    text not null references desks(desk_id),
  staff_id   uuid not null references staff_accounts(id),
  started_at timestamptz not null default now(),
  started_by uuid,
  ended_at   timestamptz,
  ended_by   uuid,
  note       text,
  is_seed    boolean not null default false
);

create unique index if not exists uq_desk_assignment_active on desk_assignment(desk_id) where ended_at is null;
create index if not exists idx_desk_assignment_staff_active on desk_assignment(staff_id) where ended_at is null;
create index if not exists idx_desk_assignment_desk on desk_assignment(desk_id, started_at desc);

drop trigger if exists trg_branch_closed_day_seed on branch_closed_day;
create trigger trg_branch_closed_day_seed before insert on branch_closed_day
  for each row execute function kpv_inherit_seed();
drop trigger if exists trg_desk_assignment_seed on desk_assignment;
create trigger trg_desk_assignment_seed before insert on desk_assignment
  for each row execute function kpv_inherit_seed();

select kpv_attach_audit('branch_closed_day'::regclass);
select kpv_attach_audit('desk_assignment'::regclass);

-- ---------------------------------------------------------------------------
-- assign_desk: lock the case, end the current holder, start the new one.
-- Assigning the current holder again returns the existing row.
-- ---------------------------------------------------------------------------
create or replace function assign_desk(p_desk text, p_staff uuid, p_note text default null)
returns desk_assignment
language plpgsql as $$
declare
  v_desk desks%rowtype;
  v_staff staff_accounts%rowtype;
  v_cur desk_assignment%rowtype;
  v_new desk_assignment%rowtype;
  v_actor uuid := kpv_actor_id();
begin
  select * into v_desk from desks where desk_id = p_desk for update;
  if not found then
    raise exception 'DESK_NOT_FOUND: %', p_desk using errcode = 'P0001';
  end if;
  select * into v_staff from staff_accounts where id = p_staff;
  if not found or not v_staff.active then
    raise exception 'ASSIGN_INACTIVE: that staff account is not active' using errcode = 'P0001';
  end if;
  if v_staff.branch_id is distinct from v_desk.branch_id then
    raise exception 'ASSIGN_OTHER_BRANCH: staff and case belong to different branches' using errcode = 'P0001';
  end if;

  select * into v_cur from desk_assignment where desk_id = p_desk and ended_at is null;
  if found then
    if v_cur.staff_id = p_staff then
      return v_cur;
    end if;
    update desk_assignment set ended_at = now(), ended_by = v_actor where id = v_cur.id;
  end if;

  insert into desk_assignment (desk_id, staff_id, started_by, note)
  values (p_desk, p_staff, v_actor, p_note)
  returning * into v_new;
  return v_new;
end $$;

create or replace function release_desk(p_desk text) returns void
language plpgsql as $$
begin
  perform 1 from desks where desk_id = p_desk for update;
  update desk_assignment set ended_at = now(), ended_by = kpv_actor_id()
   where desk_id = p_desk and ended_at is null;
end $$;

-- ---------------------------------------------------------------------------
-- A deactivated staff member, or one moved to another branch, no longer holds
-- any case.
-- ---------------------------------------------------------------------------
create or replace function staff_end_assignments() returns trigger
language plpgsql as $$
begin
  update desk_assignment set ended_at = now(), ended_by = kpv_actor_id()
   where staff_id = new.id and ended_at is null;
  return new;
end $$;

drop trigger if exists trg_staff_end_assignments on staff_accounts;
create trigger trg_staff_end_assignments after update on staff_accounts
  for each row
  when ((old.active and not new.active) or old.branch_id is distinct from new.branch_id)
  execute function staff_end_assignments();

revoke all on branch_closed_day, desk_assignment from anon, authenticated;
alter table branch_closed_day enable row level security;
alter table desk_assignment enable row level security;

revoke execute on function assign_desk(text, uuid, text) from public, anon, authenticated;
revoke execute on function release_desk(text) from public, anon, authenticated;
revoke execute on function staff_end_assignments() from public, anon, authenticated;
grant execute on function assign_desk(text, uuid, text) to service_role;
grant execute on function release_desk(text) to service_role;
