-- ============================================================================
-- KPV Stock -- username + password login.
--
-- Login changes from "pick branch -> pick name -> 4-digit PIN" to a plain
-- username + password form. Accounts stay in staff_accounts:
--   * username  NEW: the login name, unique ignoring case (stored lower-case).
--   * pin_hash  now holds the PASSWORD hash (same pbkdf2 format), so every
--     existing PIN keeps working as that person's password until it is reset.
-- Existing accounts get a username made from their display name; the select
-- at the bottom lists them so the admin can tell everyone their username.
--
-- Run once in the SQL editor, then re-run users_roles.sql (as after every
-- migration). Safe to run again.
-- ============================================================================

alter table staff_accounts add column if not exists username text;

alter table staff_accounts drop constraint if exists staff_username_format;
alter table staff_accounts add constraint staff_username_format
  check (username is null or username ~ '^[a-z0-9._-]{3,30}$');

create unique index if not exists idx_staff_accounts_username on staff_accounts (username);

-- Backfill: lower-case letters/digits of the display name ("Somchai S." ->
-- "somchais"), "user" when nothing Latin is left (Lao-only names), and a
-- number on repeats ("somchais2"). Only rows without a username are touched.
-- The SQL editor has no actor header, so the staff_accounts guard lets it through.
with base as (
  select id, created_at,
         coalesce(nullif(left(regexp_replace(lower(display_name), '[^a-z0-9]', '', 'g'), 24), ''), 'user') as stem
    from staff_accounts
   where username is null
), numbered as (
  select b.id, b.stem,
         row_number() over (partition by b.stem order by b.created_at, b.id) as n
    from base b
)
update staff_accounts s
   set username = case
         when n.n = 1 and length(n.stem) >= 3
              and not exists (select 1 from staff_accounts o where o.username = n.stem)
           then n.stem
         else n.stem || repeat('0', greatest(0, 3 - length(n.stem))) || (n.n + (select count(*) from staff_accounts o where o.username like n.stem || '%'))
       end
  from numbered n
 where s.id = n.id;

-- Who logs in as what (copy this list for the team).
select username, display_name, role, branch_id, active
  from staff_accounts
 order by role, branch_id nulls first, display_name;
