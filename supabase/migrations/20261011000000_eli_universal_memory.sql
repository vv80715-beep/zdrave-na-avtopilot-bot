-- Prepared migration only. Do not apply to production without explicit approval.
-- Fact values are AES-GCM ciphertext produced by the eli-memory Edge Function.
create table if not exists public.eli_universal_memory_facts (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null
    check (contract_version = 'eli-v2.2/durable-memory/1'),
  telegram_user_id text not null
    check (telegram_user_id ~ '^[0-9]{1,20}$'),
  category text not null,
  fact_key text,
  value_ciphertext text not null,
  value_iv text not null,
  status text not null default 'active'
    check (status in ('active', 'deleted')),
  source text not null default 'telegram',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists eli_universal_memory_facts_owner_status_idx
  on public.eli_universal_memory_facts (telegram_user_id, status, updated_at desc);

alter table public.eli_universal_memory_facts enable row level security;
revoke all on public.eli_universal_memory_facts from anon, authenticated;
grant select, insert, update, delete on public.eli_universal_memory_facts to service_role;
