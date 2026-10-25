// Test fixture generated from the read-only live schema capture. Stdout only.
import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync(new URL('../baseline/schema.json', import.meta.url)));
console.log(`
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE TABLE public.purchase_sessions(id uuid PRIMARY KEY, status text, checkout_provider text, stripe_checkout_session_id text);
CREATE TABLE public.payments(id uuid PRIMARY KEY, purchase_session_id uuid, status text, telegram_user_id bigint, plan_id text,
  amount_cents integer, currency text, provider text, manually_confirmed_by uuid, manually_confirmed_at timestamptz,
  stripe_checkout_session_id text);
CREATE TABLE public.entitlements(telegram_user_id bigint, source_payment_id uuid, plan_id text, status text, expires_at timestamptz);
`);
for (const table of ['avatar_addon_balances', 'avatar_addon_purchases', 'payment_notification_outbox']) {
  const columns = rows.filter(r => r.kind === 'column' && r.object === table).map(r => {
    const d = JSON.parse(r.definition);
    return `"${r.name}" ${d.type === 'character' ? 'character(3)' : d.type}`
      + (d.nullable === 'NO' ? ' NOT NULL' : '') + (d.default === null ? '' : ` DEFAULT ${d.default}`);
  });
  console.log(`CREATE TABLE public.${table} (${columns.join(',\n')});`);
  for (const r of rows.filter(r => r.kind === 'constraint' && r.object === table)) {
    console.log(`ALTER TABLE public.${table} ADD CONSTRAINT "${r.name}" ${r.definition};`);
  }
}
console.log(`
ALTER TABLE public.avatar_addon_balances ADD PRIMARY KEY (telegram_user_id);
ALTER TABLE public.payment_notification_outbox ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;
INSERT INTO auth.users VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
-- Pre-existing paid purchase must never acquire a retrospective receipt.
INSERT INTO avatar_addon_purchases(id,user_id,telegram_user_id,package_id,minutes,seconds,status,stripe_checkout_session_id,paid_at)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',990000001,'addon_20',20,1200,'paid','cs_historical',now());
INSERT INTO avatar_addon_balances(telegram_user_id,purchased_seconds) VALUES (990000001,1200);
`);