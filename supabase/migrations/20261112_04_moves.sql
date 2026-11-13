-- Instant, all-or-nothing case-to-case moves inside one branch, with
-- idempotency (client_ref) and undo. A move is a "received" transfer row per
-- line: the source's `move` column and the destination's `transfer_in` change in
-- the same transaction, so gold is never in transit between two cases.

alter table transfers add column if not exists client_ref  uuid;
alter table transfers add column if not exists reverses_id uuid references transfers(id);
alter table transfers add column if not exists ticket_id   uuid;
alter table transfers add column if not exists note        text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transfers_client_ref_key') then
    alter table transfers add constraint transfers_client_ref_key unique (client_ref);
  end if;
end $$;

create index if not exists idx_transfers_ticket on transfers(ticket_id);
-- One reversal per original row, even when two undos race.
create unique index if not exists uq_transfers_reverses on transfers(reverses_id) where reverses_id is not null;

-- ---------------------------------------------------------------------------
-- Shared body. p_reverses is the ticket being undone (null for a normal move).
-- Business refusals come back as {"ok":false,"code":...} with nothing written;
-- trigger errors (DAY_LOCKED, NEGATIVE_CLOSING) are allowed to raise.
-- ---------------------------------------------------------------------------
create or replace function kpv_move_stock(
  p_date date, p_from text, p_to text, p_lines jsonb, p_client_ref uuid, p_note text, p_reverses uuid
) returns jsonb
language plpgsql as $$
declare
  v_ticket uuid;
  v_from desks%rowtype;
  v_to desks%rowtype;
  v_day record;
  v_from_status text;
  v_to_status text;
  v_line record;
  v_elem jsonb;
  v_row record;
  v_first boolean := true;
  v_actor uuid := kpv_actor_id();
  v_moves jsonb;
begin
  -- (1) replay
  if p_client_ref is not null then
    select ticket_id into v_ticket from transfers where client_ref = p_client_ref;
    if found then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.sku_id), '[]'::jsonb) into v_moves
        from transfers t where t.ticket_id = v_ticket;
      return jsonb_build_object('ok', true, 'ticket_id', v_ticket, 'replayed', true, 'moves', v_moves);
    end if;
  end if;

  -- (2) shape and branch rules
  if p_from = p_to then
    return jsonb_build_object('ok', false, 'code', 'SAME_DESK');
  end if;
  select * into v_from from desks where desk_id = p_from;
  select * into v_to from desks where desk_id = p_to;
  if v_from.desk_id is null or v_to.desk_id is null then
    return jsonb_build_object('ok', false, 'code', 'DESK_NOT_FOUND');
  end if;
  if v_from.branch_id <> v_to.branch_id then
    return jsonb_build_object('ok', false, 'code', 'OTHER_BRANCH');
  end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'code', 'BAD_QTY');
  end if;
  for v_elem in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_elem) <> 'object'
       or jsonb_typeof(v_elem -> 'sku_id') is distinct from 'string'
       or jsonb_typeof(v_elem -> 'qty') is distinct from 'number'
       or (v_elem ->> 'qty') !~ '^[0-9]{1,5}$'
       or (v_elem ->> 'qty')::int < 1 then
      return jsonb_build_object('ok', false, 'code', 'BAD_QTY');
    end if;
  end loop;

  -- (3) lock both desk days, ordered by desk_id so two moves cannot deadlock
  for v_day in
    select desk_id, status from desk_days
     where ledger_date = p_date and desk_id in (p_from, p_to)
     order by desk_id
     for no key update
  loop
    if v_day.desk_id = p_from then v_from_status := v_day.status; else v_to_status := v_day.status; end if;
  end loop;
  -- Re-check under the lock: a request that lost a race replays or is refused
  -- cleanly instead of failing on the unique indexes.
  if p_client_ref is not null then
    select ticket_id into v_ticket from transfers where client_ref = p_client_ref;
    if found then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.sku_id), '[]'::jsonb) into v_moves
        from transfers t where t.ticket_id = v_ticket;
      return jsonb_build_object('ok', true, 'ticket_id', v_ticket, 'replayed', true, 'moves', v_moves);
    end if;
  end if;
  if p_reverses is not null
     and exists (select 1 from transfers where reverses_id in (select id from transfers where ticket_id = p_reverses)) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_UNDONE');
  end if;
  if v_from_status is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_CHECKED_IN');
  end if;
  if v_to_status is null then
    return jsonb_build_object('ok', false, 'code', 'DEST_NOT_OPEN');
  end if;
  if v_from_status = 'done' then
    return jsonb_build_object('ok', false, 'code', 'DAY_LOCKED');
  end if;
  if v_to_status = 'done' then
    return jsonb_build_object('ok', false, 'code', 'DEST_DAY_LOCKED');
  end if;

  -- (4) lock the source rows (ordered by sku) and check every line first
  for v_line in
    select x.sku_id, sum(x.qty)::int as qty
      from jsonb_to_recordset(p_lines) as x(sku_id text, qty int)
     group by x.sku_id order by x.sku_id
  loop
    select closing_qty, excluded into v_row from daily_stock_ledger
     where ledger_date = p_date and desk_id = p_from and sku_id = v_line.sku_id
     for update;
    if not found or v_row.excluded or v_line.qty > v_row.closing_qty then
      return jsonb_build_object('ok', false, 'code', 'NOT_ENOUGH_STOCK', 'sku_id', v_line.sku_id,
        'available', case when found and not v_row.excluded then greatest(v_row.closing_qty, 0) else 0 end);
    end if;
  end loop;

  -- (5) write everything
  v_ticket := gen_random_uuid();
  for v_line in
    select x.sku_id, sum(x.qty)::int as qty
      from jsonb_to_recordset(p_lines) as x(sku_id text, qty int)
     group by x.sku_id order by x.sku_id
  loop
    update daily_stock_ledger
       set move = move + v_line.qty, excluded = false, performed_by = coalesce(v_actor, performed_by)
     where ledger_date = p_date and desk_id = p_from and sku_id = v_line.sku_id;

    insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty, transfer_in, performed_by)
    values (p_date, p_to, v_to.branch_id, v_line.sku_id, 0, v_line.qty, v_actor)
    on conflict (ledger_date, desk_id, sku_id) do update
      set transfer_in = daily_stock_ledger.transfer_in + excluded.transfer_in,
          excluded = false,
          performed_by = coalesce(v_actor, daily_stock_ledger.performed_by);

    insert into transfers (kind, from_desk_id, from_branch_id, to_desk_id, to_branch_id, sku_id, qty,
                           sent_date, sent_by, status, received_date, received_by,
                           ticket_id, client_ref, note, reverses_id)
    values ('move', p_from, v_from.branch_id, p_to, v_to.branch_id, v_line.sku_id, v_line.qty,
            p_date, v_actor, 'received', p_date, v_actor,
            v_ticket, case when v_first then p_client_ref end, p_note,
            case when p_reverses is null then null
                 else (select id from transfers where ticket_id = p_reverses and sku_id = v_line.sku_id limit 1) end);
    v_first := false;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.sku_id), '[]'::jsonb) into v_moves
    from transfers t where t.ticket_id = v_ticket;
  return jsonb_build_object('ok', true, 'ticket_id', v_ticket, 'moves', v_moves);
end $$;

create or replace function move_stock(
  p_date date, p_from text, p_to text, p_lines jsonb, p_client_ref uuid, p_note text
) returns jsonb
language sql as $$
  select kpv_move_stock(p_date, p_from, p_to, p_lines, p_client_ref, p_note, null)
$$;

create or replace function undo_move(p_ticket uuid, p_client_ref uuid) returns jsonb
language plpgsql as $$
declare
  v_orig transfers%rowtype;
  v_lines jsonb;
begin
  -- a retried undo replays instead of tripping ALREADY_UNDONE
  if p_client_ref is not null and exists (select 1 from transfers where client_ref = p_client_ref) then
    return kpv_move_stock(null, null, null, null, p_client_ref, null, p_ticket);
  end if;

  select * into v_orig from transfers where ticket_id = p_ticket order by created_at, sku_id limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_orig.kind <> 'move' or v_orig.status <> 'received' then
    return jsonb_build_object('ok', false, 'code', 'NOT_A_MOVE');
  end if;
  if exists (select 1 from transfers where reverses_id in (select id from transfers where ticket_id = p_ticket)) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_UNDONE');
  end if;

  select jsonb_agg(jsonb_build_object('sku_id', sku_id, 'qty', qty) order by sku_id) into v_lines
    from transfers where ticket_id = p_ticket;
  return kpv_move_stock(v_orig.sent_date, v_orig.to_desk_id, v_orig.from_desk_id, v_lines, p_client_ref, null, p_ticket);
end $$;

revoke execute on function kpv_move_stock(date, text, text, jsonb, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function move_stock(date, text, text, jsonb, uuid, text) from public, anon, authenticated;
revoke execute on function undo_move(uuid, uuid) from public, anon, authenticated;
grant execute on function kpv_move_stock(date, text, text, jsonb, uuid, text, uuid) to service_role;
grant execute on function move_stock(date, text, text, jsonb, uuid, text) to service_role;
grant execute on function undo_move(uuid, uuid) to service_role;
