-- ============================================================================
-- KPV Stock v2 -- tagged MOCK DATA for testing a Supabase project.
--
-- Run order (fresh project):
--   schema.sql -> migrations/* -> users_roles.sql -> base.sql -> this file
--
-- Every row this file writes has is_seed = true. It touches no real row and
-- changes no schema. To remove it all again, run supabase/purge_seed_data.sql.
-- It refuses to run when seed rows already exist (purge first), and it is a
-- single DO block, which Postgres runs atomically: any failure leaves nothing
-- behind. (No BEGIN/COMMIT here, so a failed run cannot leave an aborted
-- transaction open in your SQL session.)
--
-- Dates are relative to kpv_today() (Laos), so this file never needs
-- regenerating. Login for every seed account: PIN 1234.
--
-- What you get:
--   B-TST1 "Test Branch" with cases T1-1 .. T1-4, B-TST2 with case T2-1
--   T1-1  Done today (tier done_today)
--   T1-2, T1-3  checked in today, Done on each of the 21 required days before
--         (streak 21, on_track)
--   T1-4  last Done = today - 4 (3 days behind, overdue)
--   B-TST1 closed on today - 10 ("Boun That Luang test")
--   SKUs SEED-SNK-025/-05/-1/-2 (group "Snake Necklace"), SEED-RNG-1/-2
--   two zero-stock days for SEED-SNK-1 (today - 15 and today - 14)
--   rules, same-branch moves (one undone), one cross-branch transfer in transit
--   staff: Test Admin, a manager and two staff (B-TST1), one staff (B-TST2)
-- ============================================================================

do $$
declare
  v_today date := kpv_today();
  v_pin   constant text := 'pbkdf2$100000$779f103340e75f15d22d0121cc45f4e1$632159949dbe5db4d24ea545930ac416b818c0d136a53413491cee8e0e6a5de6';  -- PIN 1234 (npm run db:pin -- 1234)
  v_admin uuid;
  v_mgr   uuid;
  v_s1    uuid;
  v_s2    uuid;
  v_s3    uuid;
  v_o     int;
  v_d     date;
  v_desk  record;
  v_res   jsonb;
  v_tmp   int;
begin
  -- -------------------------------------------------------------------------
  -- 0. Refuse to run on top of earlier seed data.
  -- -------------------------------------------------------------------------
  if exists (select 1 from kpv_seed_counts() where seed_rows > 0) then
    raise exception 'SEED_ALREADY_PRESENT: seed rows exist; run supabase/purge_seed_data.sql first'
      using errcode = 'P0001';
  end if;

  -- -------------------------------------------------------------------------
  -- 1. The seed admin comes first (SQL editor: no actor, so the guards let
  --    this one insert through). Everything after runs as that admin, because
  --    only an admin may create SKUs, rules and closed days.
  -- -------------------------------------------------------------------------
  insert into staff_accounts (branch_id, display_name, pin_hash, role, is_seed)
  values (null, 'Test Admin', v_pin, 'admin', true)
  returning id into v_admin;
  perform set_config('kpv.actor_id', v_admin::text, true);

  -- -------------------------------------------------------------------------
  -- 2. Branches, cases, staff
  -- -------------------------------------------------------------------------
  insert into branches (branch_id, name_en, name_lo, sort_order, is_seed) values
    ('B-TST1', 'Test Branch',   'ສາຂາທົດສອບ',   91, true),
    ('B-TST2', 'Test Branch 2', 'ສາຂາທົດສອບ 2', 92, true);

  -- created_at is back-dated so the cases are "old enough" for their streaks
  insert into desks (desk_id, branch_id, display_name, sort_order, created_at, is_seed)
  select x.desk_id, x.branch_id, x.display_name, x.sort_order,
         (v_today - 40)::timestamp at time zone 'Asia/Vientiane', true
    from (values
      ('T1-1', 'B-TST1', 'Test case 1', 1),
      ('T1-2', 'B-TST1', 'Test case 2', 2),
      ('T1-3', 'B-TST1', 'Test case 3', 3),
      ('T1-4', 'B-TST1', 'Test case 4', 4),
      ('T2-1', 'B-TST2', 'Test case 1', 1)
    ) as x(desk_id, branch_id, display_name, sort_order);

  insert into staff_accounts (branch_id, display_name, pin_hash, role, is_seed)
  values ('B-TST1', 'Test Manager', v_pin, 'manager', true) returning id into v_mgr;
  insert into staff_accounts (branch_id, display_name, pin_hash, role, is_seed)
  values ('B-TST1', 'Test Staff 1', v_pin, 'staff', true) returning id into v_s1;
  insert into staff_accounts (branch_id, display_name, pin_hash, role, is_seed)
  values ('B-TST1', 'Test Staff 2', v_pin, 'staff', true) returning id into v_s2;
  insert into staff_accounts (branch_id, display_name, pin_hash, role, is_seed)
  values ('B-TST2', 'Test Staff 3', v_pin, 'staff', true) returning id into v_s3;

  -- -------------------------------------------------------------------------
  -- 3. SKUs on the base types and weights (which stay real). Group "Snake
  --    Necklace" on 0.25 / 0.5 / 1 / 2 Baht, plus two rings.
  -- -------------------------------------------------------------------------
  insert into master_sku (sku_id, name_en, category, type_id, weight_id, purity, std_gram_weight, baht_weight,
                          unit_cost_lak, unit_price_lak, group_name, is_seed)
  values
    ('SEED-SNK-025', 'Snake Necklace 0.25 Baht', 'Necklaces', 'NECKLACES', 'BAHT_025', '96.5%', 3.811, 0.25,  9500000,  9900000, 'Snake Necklace', true),
    ('SEED-SNK-05',  'Snake Necklace 0.5 Baht',  'Necklaces', 'NECKLACES', 'BAHT_05',  '96.5%', 7.622, 0.5,  19000000, 19800000, 'Snake Necklace', true),
    ('SEED-SNK-1',   'Snake Necklace 1 Baht',    'Necklaces', 'NECKLACES', 'BAHT_1',   '96.5%', 15.244, 1,   38000000, 39600000, 'Snake Necklace', true),
    ('SEED-SNK-2',   'Snake Necklace 2 Baht',    'Necklaces', 'NECKLACES', 'BAHT_2',   '96.5%', 30.488, 2,   76000000, 79200000, 'Snake Necklace', true),
    ('SEED-RNG-1',   'Seed Ring 1 g',            'Rings & Accessories', 'RINGS_ACCESSORIES', 'G_1',    '96.5%', 1,    null, 2500000, 2700000, 'Seed Ring', true),
    ('SEED-RNG-2',   'Seed Ring 3.75 g',         'Rings & Accessories', 'RINGS_ACCESSORIES', 'G_3_75', '96.5%', 3.75, null, 9400000, 9900000, 'Seed Ring', true);

  -- -------------------------------------------------------------------------
  -- 4. Replenishment rules: the group rule is company-wide (lead 7, avg 100),
  --    one SKU+branch override, and the rings are left on auto (no rule).
  -- -------------------------------------------------------------------------
  insert into replenishment_rule (scope, scope_key, branch_id, avg_daily_sell, lead_time_days, is_seed) values
    ('group', 'Snake Necklace', null,      100, 7, true),
    ('sku',   'SEED-SNK-1',     'B-TST1',    8, 5, true);

  -- -------------------------------------------------------------------------
  -- 5. One closed day, so streaks visibly skip it.
  -- -------------------------------------------------------------------------
  insert into branch_closed_day (branch_id, closed_date, reason, is_seed)
  values ('B-TST1', v_today - 10, 'Boun That Luang test', true);

  -- -------------------------------------------------------------------------
  -- 6. History, oldest day first, so every opening is the previous count.
  --    22 calendar days back, minus the closed day = 21 required days. Each
  --    desk-day gets its ledger rows BEFORE it is set to done (a Done day's
  --    ledger is frozen). T1-4 stops at today - 4.
  --    SEED-SNK-1 sells out on today - 16 and is not restocked until
  --    today - 13: two zero-stock days (today - 15, today - 14) that must not
  --    count as in-stock days in the velocity.
  -- -------------------------------------------------------------------------
  for v_o in reverse 22 .. 1 loop
    v_d := v_today - v_o;
    for v_desk in
      select * from (values
        ('T1-1', 'B-TST1', v_s1),
        ('T1-2', 'B-TST1', v_s2),
        ('T1-3', 'B-TST1', v_s2),
        ('T1-4', 'B-TST1', v_s1),
        ('T2-1', 'B-TST2', v_s3)
      ) as t(desk_id, branch_id, staff_id)
    loop
      continue when v_desk.branch_id = 'B-TST1' and v_o = 10;      -- closed day
      continue when v_desk.desk_id = 'T1-4' and v_o < 4;           -- last Done = today - 4

      insert into desk_days (desk_id, ledger_date, branch_id, status, checked_in_by, is_seed)
      values (v_desk.desk_id, v_d, v_desk.branch_id, 'check_in', v_desk.staff_id, true);

      insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty, stock_in,
                                      retail_sale, counted_qty, performed_by, is_seed)
      select v_d, v_desk.desk_id, v_desk.branch_id, x.sku_id, x.op, x.si, x.sale,
             x.op + x.si - x.sale, v_desk.staff_id, true
        from (
          select b.sku_id, b.op, b.si,
                 case when b.sku_id = 'SEED-SNK-1' and v_o = 16 then b.op + b.si     -- sells out
                      else least(b.op + b.si, b.h) end as sale
            from (
              select s.sku_id,
                     coalesce(p.q, 0) as op,
                     case when p.q is null then 30                                    -- first day: stocked
                          when s.sku_id = 'SEED-SNK-1' and v_o in (16, 15, 14) then 0 -- no restock
                          when p.q < 6 then 25                                        -- restock
                          else 0 end as si,
                     case when s.sku_id = 'SEED-SNK-1' and v_o in (15, 14) then 0
                          else abs(hashtext(s.sku_id || v_desk.desk_id || v_d::text)) % 4 end as h
                from (values ('SEED-SNK-025'), ('SEED-SNK-05'), ('SEED-SNK-1'), ('SEED-SNK-2'),
                             ('SEED-RNG-1'), ('SEED-RNG-2')) as s(sku_id)
                left join lateral (
                  select coalesce(l.counted_qty, l.closing_qty) as q
                    from daily_stock_ledger l
                   where l.desk_id = v_desk.desk_id and l.sku_id = s.sku_id and l.ledger_date < v_d
                   order by l.ledger_date desc limit 1
                ) p on true
            ) b
        ) x;

      update desk_days
         set status = 'done',
             done_by = v_desk.staff_id,
             done_at = (v_d + time '18:30') at time zone 'Asia/Vientiane'
       where desk_id = v_desk.desk_id and ledger_date = v_d;
    end loop;
  end loop;

  -- -------------------------------------------------------------------------
  -- 7. Today: T1-1, T1-2, T1-3 and T2-1 are checked in. T1-4 is not (it is
  --    behind). T1-1 and T1-3 receive a delivery of 10 of everything.
  -- -------------------------------------------------------------------------
  for v_desk in
    select * from (values
      ('T1-1', 'B-TST1', v_s1, 10),
      ('T1-2', 'B-TST1', v_s2, 0),
      ('T1-3', 'B-TST1', v_s2, 10),
      ('T2-1', 'B-TST2', v_s3, 0)
    ) as t(desk_id, branch_id, staff_id, delivery)
  loop
    insert into desk_days (desk_id, ledger_date, branch_id, status, checked_in_by, is_seed)
    values (v_desk.desk_id, v_today, v_desk.branch_id, 'check_in', v_desk.staff_id, true);

    insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty, stock_in, performed_by, is_seed)
    select v_today, v_desk.desk_id, v_desk.branch_id, s.sku_id, coalesce(p.q, 0), v_desk.delivery, v_desk.staff_id, true
      from (values ('SEED-SNK-025'), ('SEED-SNK-05'), ('SEED-SNK-1'), ('SEED-SNK-2'),
                   ('SEED-RNG-1'), ('SEED-RNG-2')) as s(sku_id)
      left join lateral (
        select coalesce(l.counted_qty, l.closing_qty) as q
          from daily_stock_ledger l
         where l.desk_id = v_desk.desk_id and l.sku_id = s.sku_id and l.ledger_date < v_today
         order by l.ledger_date desc limit 1
      ) p on true;
  end loop;

  -- -------------------------------------------------------------------------
  -- 8. Assignments (through the real RPC). T1-2 starts with Test Staff 2 and
  --    is handed to the manager mid-day: an ended row and an active row.
  -- -------------------------------------------------------------------------
  insert into desk_assignment (desk_id, staff_id, started_at, started_by, note, is_seed)
  values ('T1-2', v_s2, now() - interval '4 hours', v_admin, 'opening shift', true);
  perform assign_desk('T1-2', v_mgr, 'lunch handover');
  perform assign_desk('T1-1', v_s1);
  perform assign_desk('T1-3', v_s2);
  perform assign_desk('T2-1', v_s3);

  -- -------------------------------------------------------------------------
  -- 9. Moves T1-1 -> T1-2 today (through the real RPCs). The second move is
  --    undone, which is itself a reverse move.
  -- -------------------------------------------------------------------------
  v_res := move_stock(v_today, 'T1-1', 'T1-2', '[{"sku_id":"SEED-SNK-1","qty":3}]'::jsonb,
                      gen_random_uuid(), 'Seed: top up T1-2');
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception 'SEED_FAILED: move 1: %', v_res;
  end if;
  v_res := move_stock(v_today, 'T1-1', 'T1-2', '[{"sku_id":"SEED-SNK-2","qty":2}]'::jsonb,
                      gen_random_uuid(), 'Seed: moved by mistake');
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception 'SEED_FAILED: move 2: %', v_res;
  end if;
  v_res := undo_move((v_res ->> 'ticket_id')::uuid, gen_random_uuid());
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception 'SEED_FAILED: undo: %', v_res;
  end if;

  -- One transfer between branches, sent from T1-3 and still in transit to T2-1.
  v_tmp := ledger_add(v_today, 'T1-3', 'SEED-SNK-2', 'transfer_out', 2, v_s2);
  if v_tmp is null then raise exception 'SEED_FAILED: transfer_out row missing'; end if;
  insert into transfers (kind, from_desk_id, from_branch_id, to_desk_id, to_branch_id, sku_id, qty,
                         sent_date, sent_by, status, is_seed)
  values ('transfer', 'T1-3', 'B-TST1', 'T2-1', 'B-TST2', 'SEED-SNK-2', 2, v_today, v_s2, 'in_transit', true);

  -- -------------------------------------------------------------------------
  -- 10. T1-1 finishes today: some sales, a count, then Done.
  -- -------------------------------------------------------------------------
  update daily_stock_ledger set retail_sale = 1, performed_by = v_s1
   where desk_id = 'T1-1' and ledger_date = v_today and sku_id in ('SEED-SNK-1', 'SEED-RNG-1');
  update daily_stock_ledger set counted_qty = closing_qty, performed_by = v_s1
   where desk_id = 'T1-1' and ledger_date = v_today;
  update desk_days set status = 'done', done_by = v_s1, done_at = now()
   where desk_id = 'T1-1' and ledger_date = v_today;

  -- -------------------------------------------------------------------------
  -- 11. A semantic audit entry (the Worker writes these for reopen), as an
  --     example for the history screen.
  -- -------------------------------------------------------------------------
  insert into audit_log (actor_id, actor_name, action, target, detail, branch_id, desk_id, is_seed)
  values (v_admin, 'Test Admin', 'desk_day.reopen', 'T1-2/' || (v_today - 3)::text,
          '{"reason":"Seed example: recount"}'::jsonb, 'B-TST1', 'T1-2', true);

  raise notice 'Seed loaded for % (see kpv_seed_counts()). Login PIN for all seed accounts: 1234', v_today;
end $$;

select * from kpv_seed_counts() order by table_name;
