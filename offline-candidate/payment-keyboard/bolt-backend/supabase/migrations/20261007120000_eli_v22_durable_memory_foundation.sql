-- Eli V2.2 durable memory foundation.
-- PREPARED ONLY: do not apply without separate production approval.

create table if not exists public.eli_user_health_profiles (
  telegram_user_id bigint primary key,
  profile jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.eli_memory_facts (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  category text not null,
  fact_key text,
  value text not null,
  status text not null default 'active' check (status in ('active','superseded','deleted')),
  source text,
  supersedes_id uuid references public.eli_memory_facts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists eli_memory_facts_user_idx on public.eli_memory_facts(telegram_user_id, status);

create table if not exists public.eli_health_events (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  event_type text not null,
  value jsonb,
  unit text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists eli_health_events_user_time_idx on public.eli_health_events(telegram_user_id, occurred_at desc);

create table if not exists public.eli_checkins (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists eli_checkins_user_time_idx on public.eli_checkins(telegram_user_id, occurred_at desc);

create table if not exists public.eli_short_context (
  telegram_user_id bigint primary key,
  messages jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint eli_short_context_max_10 check (jsonb_typeof(messages) = 'array' and jsonb_array_length(messages) <= 10)
);

create table if not exists public.eli_reminders (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  payload jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists eli_reminders_user_idx on public.eli_reminders(telegram_user_id, enabled);

create table if not exists public.eli_scheduled_deliveries (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','claimed','sent','failed')),
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists eli_scheduled_deliveries_claim_idx on public.eli_scheduled_deliveries(status, lease_until);

alter table public.eli_user_health_profiles enable row level security;
alter table public.eli_memory_facts enable row level security;
alter table public.eli_health_events enable row level security;
alter table public.eli_checkins enable row level security;
alter table public.eli_short_context enable row level security;
alter table public.eli_reminders enable row level security;
alter table public.eli_scheduled_deliveries enable row level security;

revoke all on public.eli_user_health_profiles from anon, authenticated;
revoke all on public.eli_memory_facts from anon, authenticated;
revoke all on public.eli_health_events from anon, authenticated;
revoke all on public.eli_checkins from anon, authenticated;
revoke all on public.eli_short_context from anon, authenticated;
revoke all on public.eli_reminders from anon, authenticated;
revoke all on public.eli_scheduled_deliveries from anon, authenticated;
