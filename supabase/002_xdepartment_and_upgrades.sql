-- =====================================================================
-- SOGDIA — migration 002
-- X-Department tier + platform upgrades.
-- Run AFTER schema.sql. Pricing and the drawdown rule-sets are unchanged;
-- everything here is additive.
--
-- NOTE: `alter type ... add value` cannot run inside a transaction block.
-- Run section 1 on its own first if your client wraps statements.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENUM EXTENSIONS
-- ---------------------------------------------------------------------
alter type user_role        add value if not exists 'xdepartment';
alter type transaction_type add value if not exists 'commission';

-- ---------------------------------------------------------------------
-- 2. COLUMN ADDITIONS
-- ---------------------------------------------------------------------

-- users: affiliate programme
alter table public.users
  add column if not exists referral_code text unique,
  add column if not exists referred_by   uuid references public.users (id) on delete set null;

create index if not exists users_referred_by_idx on public.users (referred_by);

-- accounts: optional add-on rules (0 / null = disabled, the default)
alter table public.accounts
  add column if not exists min_trading_days int           not null default 0,
  add column if not exists consistency_pct  numeric(6,3),
  add column if not exists is_gifted        boolean       not null default false;

comment on column public.accounts.min_trading_days is
  'Minimum distinct trading days before a payout. 0 = disabled.';
comment on column public.accounts.consistency_pct is
  'Max share of total profit allowed from a single day. null = disabled.';
comment on column public.accounts.is_gifted is
  'True when provisioned by X-Department rather than purchased.';

-- orders: protective orders + partial closes
alter table public.orders
  add column if not exists take_profit     numeric(28,10),
  add column if not exists stop_loss       numeric(28,10),
  add column if not exists parent_order_id uuid references public.orders (id) on delete set null;

create index if not exists orders_parent_idx on public.orders (parent_order_id);

-- ---------------------------------------------------------------------
-- 3. NEW TABLES
-- ---------------------------------------------------------------------

-- Append-only privileged-action log.
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.users (id) on delete set null,
  actor_role  user_role not null,
  action      text      not null,
  target_type text      not null,
  target_id   uuid,
  payload     jsonb     not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_actor_idx   on public.audit_logs (actor_id, created_at desc);
create index if not exists audit_logs_target_idx  on public.audit_logs (target_id);
create index if not exists audit_logs_action_idx  on public.audit_logs (action);

-- Equity curve points.
create table if not exists public.equity_snapshots (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  equity     numeric(18,2) not null,
  balance    numeric(18,2) not null,
  source     text not null default 'trade_close',
  taken_at   timestamptz not null default now()
);

create index if not exists equity_snapshots_account_idx
  on public.equity_snapshots (account_id, taken_at desc);

-- In-app notifications.
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text not null,
  metadata   jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;

-- Idempotency replay store (checkout, trade open).
create table if not exists public.idempotency_keys (
  key        text primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  route      text not null,
  response   jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idempotency_created_idx on public.idempotency_keys (created_at);

-- ---------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------
alter table public.audit_logs       enable row level security;
alter table public.equity_snapshots enable row level security;
alter table public.notifications    enable row level security;
alter table public.idempotency_keys enable row level security;

-- is_admin() now covers both staff tiers.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role in ('admin', 'xdepartment')
  );
$$;

create or replace function public.is_xdepartment()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'xdepartment'
  );
$$;

drop policy if exists audit_logs_select_x on public.audit_logs;
create policy audit_logs_select_x on public.audit_logs
  for select using (public.is_xdepartment());

drop policy if exists equity_select_own on public.equity_snapshots;
create policy equity_select_own on public.equity_snapshots
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.accounts a
      where a.id = equity_snapshots.account_id and a.user_id = auth.uid()
    )
  );

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- idempotency_keys: service role only, no client policy.

-- ---------------------------------------------------------------------
-- 5. BACKFILL
-- ---------------------------------------------------------------------
update public.users
   set referral_code = upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 8))
 where referral_code is null;

-- ---------------------------------------------------------------------
-- 6. HOUSEKEEPING
-- ---------------------------------------------------------------------
-- Drop replayed idempotency keys older than 7 days (schedule with pg_cron):
--   select cron.schedule('idem-gc', '0 3 * * *',
--     $$delete from public.idempotency_keys where created_at < now() - interval '7 days'$$);

-- Grant the first X-Department account:
--   update public.users set role = 'xdepartment' where email = 'you@sogdia.io';
