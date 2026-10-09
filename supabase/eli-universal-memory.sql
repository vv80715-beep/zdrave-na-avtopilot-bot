-- Staged schema, not an applied production migration. Generate the migration
-- with `supabase migration new eli_universal_memory` after a verified backup.
-- The bot calls PostgREST server-side; it does not share service credentials
-- with Telegram users or require a memory Edge Function.
begin;

create table public.eli_memory_state (
  telegram_user_id text primary key check (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
  revision integer not null check (revision > 0),
  payload jsonb not null check ((
    jsonb_typeof(payload) = 'object'
    and payload->>'version' = '1'
    and jsonb_typeof(payload->'iv') = 'string'
    and jsonb_typeof(payload->'tag') = 'string'
    and jsonb_typeof(payload->'ciphertext') = 'string'
    and payload - array['version','iv','tag','ciphertext'] = '{}'::jsonb
    and octet_length(payload::text) < 500000
  ) is true),
  updated_at timestamptz not null default now()
);
alter table public.eli_memory_state enable row level security;
revoke all on public.eli_memory_state from public, anon, authenticated;
revoke all on public.eli_memory_state from service_role;
grant select, insert, update on public.eli_memory_state to service_role;

create function public.eli_memory_compare_and_swap(
  p_user_id text, p_expected_revision integer, p_payload jsonb
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare new_revision integer;
begin
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid_revision' using errcode = '22023';
  end if;
  if p_expected_revision = 0 then
    insert into public.eli_memory_state(telegram_user_id, revision, payload)
    values(p_user_id, 1, p_payload)
    on conflict (telegram_user_id) do nothing
    returning revision into new_revision;
  else
    update public.eli_memory_state
    set revision = revision + 1, payload = p_payload, updated_at = now()
    where telegram_user_id = p_user_id and revision = p_expected_revision
    returning revision into new_revision;
  end if;
  -- NULL means a conflict. Never overwrite an unexpected version.
  return new_revision;
end;
$$;
revoke all on function public.eli_memory_compare_and_swap(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.eli_memory_compare_and_swap(text, integer, jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
