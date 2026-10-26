-- =====================================================================
-- SOGDIA — Crypto Prop Firm
-- Supabase / PostgreSQL schema
-- Run in the Supabase SQL editor (or `supabase db push`).
-- Idempotent-ish: safe to run on a fresh project.
-- =====================================================================

create extension if not exists "pgcrypto";

-- =====================================================================
-- 1. ENUMS
-- =====================================================================
do $$ begin
  create type user_role        as enum ('trader', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type kyc_status       as enum ('not_submitted', 'pending', 'verified', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type account_type     as enum ('one_step', 'instant');
exception when duplicate_object then null; end $$;

do $$ begin
  -- active   : tradable
  -- passed   : evaluation target hit (one_step) -> eligible for funded/payout
  -- failed   : drawdown breach (automatic, by risk engine)
  -- frozen   : admin hold, read-only, can be un-frozen
  -- breached : admin hard-kill for illegal / abusive trading activity
  -- closed   : archived
  create type account_status   as enum ('active', 'passed', 'failed', 'frozen', 'breached', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_side       as enum ('long', 'short');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status     as enum ('open', 'closed', 'liquidated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type transaction_type as enum ('purchase', 'payout', 'refund', 'adjustment');
exception when duplicate_object then null; end $$;

do $$ begin
  create type transaction_status as enum ('pending', 'approved', 'paid', 'rejected', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type certificate_type as enum ('eval_pass', 'payout');
exception when duplicate_object then null; end $$;

-- =====================================================================
-- 2. TABLES
-- =====================================================================

-- ---------------------------------------------------------------------
-- users  (mirror of auth.users + app profile)
-- ---------------------------------------------------------------------
create table if not exists public.users (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null unique,
  role            user_role   not null default 'trader',
  kyc_status      kyc_status  not null default 'not_submitted',
  kyc_document_url text,
  kyc_note        text,
  wallet_address  text,
  full_name       text,
  country         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- accounts  (a user may own many)
-- ---------------------------------------------------------------------
create table if not exists public.accounts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users (id) on delete cascade,
  type                 account_type   not null,
  size                 numeric(18,2)  not null,                  -- initial virtual capital, e.g. 10000.00
  balance              numeric(18,2)  not null,                  -- realised balance
  equity               numeric(18,2)  not null,                  -- balance + unrealised PnL (snapshot)
  daily_start_balance  numeric(18,2)  not null,                  -- reset 00:00 UTC by cron
  status               account_status not null default 'active',

  -- rule-set snapshot (copied from src/config/pricing.ts at creation time,
  -- so changing prices/rules later never retro-breaks live accounts)
  max_leverage         int            not null default 200,
  profit_target_pct    numeric(6,3),                             -- null for instant funding
  daily_dd_pct         numeric(6,3)   not null,
  max_dd_pct           numeric(6,3)   not null,
  payout_split_pct     numeric(6,3)   not null default 80,
  payout_cycle_days    int            not null default 14,

  plan_key             text,                                     -- e.g. 'one_step_10k'
  breach_reason        text,
  last_payout_at       timestamptz,
  next_payout_at       timestamptz,
  daily_reset_at       timestamptz    not null default date_trunc('day', now() at time zone 'utc'),
  created_at           timestamptz    not null default now(),
  updated_at           timestamptz    not null default now(),

  constraint accounts_size_positive    check (size > 0),
  constraint accounts_balance_sane     check (balance >= 0)
);

create index if not exists accounts_user_id_idx on public.accounts (user_id);
create index if not exists accounts_status_idx  on public.accounts (status);

-- ---------------------------------------------------------------------
-- orders  (positions — B-book, no external execution)
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.accounts (id) on delete cascade,
  user_id           uuid not null references public.users (id) on delete cascade,
  symbol            text         not null,                       -- 'BTCUSDT'
  side              order_side   not null,
  leverage          int          not null,
  margin            numeric(18,2) not null,                      -- collateral locked
  position_size     numeric(18,2) not null,                      -- margin * leverage (notional, quote ccy)
  quantity          numeric(28,10) not null,                     -- position_size / entry_price (base ccy)
  entry_price       numeric(28,10) not null,                     -- spread-adjusted fill
  mark_price_at_open numeric(28,10) not null,                    -- raw Binance mid at open
  liquidation_price numeric(28,10) not null,
  close_price       numeric(28,10),
  pnl               numeric(18,2),                               -- realised, quote ccy
  status            order_status not null default 'open',
  close_reason      text,                                        -- 'manual' | 'liquidation' | 'admin' | 'breach'
  created_at        timestamptz  not null default now(),
  closed_at         timestamptz,

  constraint orders_leverage_range check (leverage between 1 and 200),
  constraint orders_margin_positive check (margin > 0)
);

create index if not exists orders_account_id_idx on public.orders (account_id);
create index if not exists orders_user_id_idx    on public.orders (user_id);
create index if not exists orders_open_idx       on public.orders (account_id) where status = 'open';
create index if not exists orders_created_at_idx on public.orders (created_at desc);

-- ---------------------------------------------------------------------
-- transactions  (challenge purchases + payouts)
-- ---------------------------------------------------------------------
create table if not exists public.transactions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.users (id) on delete cascade,
  account_id             uuid references public.accounts (id) on delete set null,
  amount                 numeric(18,2) not null,                 -- gross amount in USD
  net_amount             numeric(18,2),                          -- payout after 80/20 split
  currency               text not null default 'USD',
  type                   transaction_type   not null,
  status                 transaction_status not null default 'pending',
  wallet_address         text,
  tx_hash                text,
  nowpayments_payment_id text unique,                            -- idempotency key for the IPN
  nowpayments_order_id   text unique,                            -- our own id sent to NOWPayments
  admin_note             text,
  metadata               jsonb not null default '{}'::jsonb,     -- { plan_key, account_type, size, pay_currency, ... }
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists transactions_user_id_idx on public.transactions (user_id);
create index if not exists transactions_status_idx  on public.transactions (type, status);

-- ---------------------------------------------------------------------
-- certificates  (eval pass + payout certificates, OG-rendered)
-- ---------------------------------------------------------------------
create table if not exists public.certificates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  account_id  uuid references public.accounts (id) on delete set null,
  type        certificate_type not null,
  amount      numeric(18,2) not null,
  code        text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10)),
  display_name text,
  is_manual   boolean not null default false,
  issued_by   uuid references public.users (id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  issued_at   timestamptz not null default now()
);

create index if not exists certificates_user_id_idx on public.certificates (user_id);

-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

-- updated_at maintenance
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists accounts_set_updated_at on public.accounts;
create trigger accounts_set_updated_at before update on public.accounts
  for each row execute function public.set_updated_at();

drop trigger if exists transactions_set_updated_at on public.transactions;
create trigger transactions_set_updated_at before update on public.transactions
  for each row execute function public.set_updated_at();

-- auth.users -> public.users mirror
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- =====================================================================
-- 4. HELPERS
-- =====================================================================
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'
  );
$$;

-- Atomic position close: credits PnL to balance and settles the order in one tx.
create or replace function public.close_position(
  p_order_id uuid,
  p_close_price numeric,
  p_pnl numeric,
  p_status order_status,
  p_reason text
) returns public.orders language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
begin
  update public.orders
     set close_price = p_close_price,
         pnl         = p_pnl,
         status      = p_status,
         close_reason = p_reason,
         closed_at   = now()
   where id = p_order_id and status = 'open'
  returning * into v_order;

  if v_order.id is null then
    raise exception 'ORDER_NOT_OPEN';
  end if;

  update public.accounts
     set balance = balance + p_pnl,
         equity  = equity  + p_pnl
   where id = v_order.account_id;

  return v_order;
end $$;

-- =====================================================================
-- 5. ROW LEVEL SECURITY
--    All writes go through API routes using the service-role key
--    (which bypasses RLS). These policies protect direct client reads.
-- =====================================================================
alter table public.users        enable row level security;
alter table public.accounts     enable row level security;
alter table public.orders       enable row level security;
alter table public.transactions enable row level security;
alter table public.certificates enable row level security;

drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists accounts_select_own on public.accounts;
create policy accounts_select_own on public.accounts
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists orders_select_own on public.orders;
create policy orders_select_own on public.orders
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists transactions_select_own on public.transactions;
create policy transactions_select_own on public.transactions
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists certificates_select_own on public.certificates;
create policy certificates_select_own on public.certificates
  for select using (user_id = auth.uid() or public.is_admin());

-- =====================================================================
-- 6. STORAGE (KYC documents — private bucket)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('kyc-documents', 'kyc-documents', false)
on conflict (id) do nothing;

drop policy if exists kyc_read_own on storage.objects;
create policy kyc_read_own on storage.objects
  for select using (
    bucket_id = 'kyc-documents'
    and (public.is_admin() or (storage.foldername(name))[1] = auth.uid()::text)
  );

-- =====================================================================
-- 7. SEED AN ADMIN (run manually after creating the auth user)
-- =====================================================================
-- update public.users set role = 'admin' where email = 'admin@sogdia.io';
