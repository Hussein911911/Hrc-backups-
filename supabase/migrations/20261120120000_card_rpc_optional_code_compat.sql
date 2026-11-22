-- Preserve barcode-only calls from older cached clients while keeping one
-- function signature per RPC. An omitted p_code is equivalent to an empty code.
-- The guard fails closed if an unexpected overload exists; it never drops or
-- silently rewrites a different function.
do $guard$
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'brc' and p.proname = 'lookup_card') <> 1 then
    raise exception 'Expected exactly one brc.lookup_card function before compatibility update';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'brc' and p.proname = 'self_service_card') <> 1 then
    raise exception 'Expected exactly one brc.self_service_card function before compatibility update';
  end if;
end
$guard$;

create or replace function brc.lookup_card(p_serial text, p_code text default '')
returns jsonb language plpgsql security definer
set search_path = brc, public, pg_temp
as $function$
declare
  v_guard jsonb; v_body jsonb; v_name text; v_phone text;
begin
  v_guard := brc.card_lookup_guard(p_serial, null);
  if coalesce((v_guard->>'ok')::boolean, false) is not true then return v_guard; end if;

  v_body := brc.lookup_card_unguarded(p_serial, p_code);
  if v_body is null or coalesce((v_body->>'ok')::boolean, false) is not true then
    return v_body;
  end if;
  if (v_body->>'status') = 'blank' then return v_body; end if;

  select full_name, phone into v_name, v_phone
    from brc.applicants where serial = upper(btrim(coalesce(p_serial, '')));

  v_body := jsonb_set(v_body, '{fullName}', to_jsonb(coalesce(v_name, '')),   true);
  v_body := jsonb_set(v_body, '{phone}',    to_jsonb(coalesce(v_phone, '')),  true);
  v_body := jsonb_set(v_body, '{masked}',   'false'::jsonb, true);
  v_body := jsonb_set(v_body, '{verified}', 'true'::jsonb,  true);
  return v_body;
end
$function$;

create or replace function brc.self_service_card(p_serial text, p_code text default '')
returns jsonb language plpgsql security definer
set search_path = brc, public, pg_temp
as $function$
declare
  v_guard jsonb; v_body jsonb;
begin
  v_guard := brc.card_lookup_guard(p_serial, null);
  if coalesce((v_guard->>'ok')::boolean, false) is not true then return v_guard; end if;

  v_body := brc.self_service_card_unguarded(p_serial, p_code);
  if v_body is null or coalesce((v_body->>'ok')::boolean, false) is not true then
    return v_body;
  end if;

  v_body := jsonb_set(v_body, '{card,masked}',        'false'::jsonb, true);
  v_body := jsonb_set(v_body, '{card,verified}',      'true'::jsonb,  true);
  v_body := jsonb_set(v_body, '{card,profileLocked}', 'false'::jsonb, true);
  return v_body;
end
$function$;

revoke all on function brc.lookup_card(text, text) from public;
revoke all on function brc.self_service_card(text, text) from public;
grant execute on function brc.lookup_card(text, text) to anon, authenticated;
grant execute on function brc.self_service_card(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
