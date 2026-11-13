-- Compare-and-set ledger edits. A device sends {field, from, to} per change;
-- if someone else already changed the value (stored <> from and stored <> to)
-- nothing is written and the current row comes back. stored == to counts as
-- applied, so a retried request is harmless.

create or replace function ledger_apply(p_date date, p_desk text, p_sku text, p_changes jsonb)
returns jsonb
language plpgsql as $$
declare
  c jsonb;
  v_row daily_stock_ledger%rowtype;
  v_field text;
  v_stored text;
  v_sets text[] := '{}';
  v_int text[] := array['stock_in','retail_sale','wholesale','destock','counted_qty'];
  v_txt text[] := array['destock_note','counted_note'];
begin
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'ledger_apply: changes must be an array';
  end if;
  for c in select * from jsonb_array_elements(p_changes) loop
    v_field := c->>'field';
    if v_field is null or not (v_field = any (v_int) or v_field = any (v_txt)) then
      raise exception 'ledger_apply: field % not allowed', coalesce(v_field, '(none)');
    end if;
  end loop;

  select * into v_row from daily_stock_ledger
   where ledger_date = p_date and desk_id = p_desk and sku_id = p_sku
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ROW_NOT_FOUND');
  end if;

  for c in select * from jsonb_array_elements(p_changes) loop
    v_field := c->>'field';
    v_stored := to_jsonb(v_row) ->> v_field;
    if c ? 'from'
       and v_stored is distinct from (c->>'from')
       and v_stored is distinct from (c->>'to') then
      return jsonb_build_object('ok', false, 'code', 'ROW_CHANGED', 'row', to_jsonb(v_row));
    end if;
  end loop;

  for c in select * from jsonb_array_elements(p_changes) loop
    v_field := c->>'field';
    v_sets := v_sets || format('%I = %L::%s', v_field, c->>'to', case when v_field = any (v_int) then 'int' else 'text' end);
  end loop;

  if cardinality(v_sets) > 0 then
    execute format(
      'update daily_stock_ledger set %s, performed_by = coalesce(kpv_actor_id(), performed_by)
        where ledger_date = $1 and desk_id = $2 and sku_id = $3', array_to_string(v_sets, ', '))
      using p_date, p_desk, p_sku;
  end if;

  select * into v_row from daily_stock_ledger where ledger_date = p_date and desk_id = p_desk and sku_id = p_sku;
  return jsonb_build_object('ok', true, 'row', to_jsonb(v_row));
end $$;

revoke execute on function ledger_apply(date, text, text, jsonb) from public, anon, authenticated;
grant execute on function ledger_apply(date, text, text, jsonb) to service_role;
