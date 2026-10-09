-- Execute ONLY in a fresh disposable test database, never the linked project.
\set ON_ERROR_STOP on
create role anon;
create role authenticated;
create role service_role bypassrls;
grant usage on schema public to anon, authenticated, service_role;
\ir ../../supabase/eli-universal-memory.sql

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.eli_memory_state'::regclass) then raise exception 'RLS missing'; end if;
  if has_table_privilege('anon', 'public.eli_memory_state', 'SELECT') or has_table_privilege('authenticated', 'public.eli_memory_state', 'SELECT') then raise exception 'public memory exposure'; end if;
  if has_function_privilege('anon', 'public.eli_memory_compare_and_swap(text,integer,jsonb)', 'EXECUTE') or has_function_privilege('authenticated', 'public.eli_memory_compare_and_swap(text,integer,jsonb)', 'EXECUTE') then raise exception 'public write exposure'; end if;
  if has_table_privilege('service_role', 'public.eli_memory_state', 'DELETE') then raise exception 'physical delete permitted'; end if;
end;
$$;

set role service_role;
do $$
declare p jsonb := '{"version":1,"iv":"synthetic","tag":"synthetic","ciphertext":"synthetic"}'; r integer;
begin
  r := public.eli_memory_compare_and_swap('99000000000000000001', 0, p);
  if r is distinct from 1 then raise exception 'insert failed'; end if;
  r := public.eli_memory_compare_and_swap('99000000000000000001', 0, p);
  if r is not null then raise exception 'duplicate insert overwrote data'; end if;
  r := public.eli_memory_compare_and_swap('99000000000000000001', 1, p);
  if r is distinct from 2 then raise exception 'update failed'; end if;
  r := public.eli_memory_compare_and_swap('99000000000000000001', 1, p);
  if r is not null then raise exception 'stale revision overwrote data'; end if;
  r := public.eli_memory_compare_and_swap('99000000000000000002', 1, p);
  if r is not null then raise exception 'cross-user update found another user'; end if;
  begin
    perform public.eli_memory_compare_and_swap('99000000000000000003', 0, '{}'::jsonb);
    raise exception 'missing encryption fields accepted';
  exception when check_violation then null;
  end;
end;
$$;
reset role;

-- Two independent sessions compete for the same revision. Exactly one wins.
-- The shell runner performs that race after the checks above.
select 'schema-and-cas-ok' as result;
