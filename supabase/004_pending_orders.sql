-- =====================================================================
-- 004 — Server-side limit / stop orders (terminal v2)
-- Safe to run more than once. Paste into Supabase → SQL Editor → Run.
-- Until this is run the terminal keeps working: limit/stop orders then
-- stay in the browser, exactly as before.
-- =====================================================================
create table if not exists public.pending_orders (
  id              uuid primary key default gen_random_uuid(),   -- chosen by the browser; becomes the position id when filled
  account_id      uuid not null references public.accounts (id) on delete cascade,
  user_id         uuid not null references public.users (id) on delete cascade,
  symbol          text not null,
  side            order_side not null,
  kind            text not null check (kind in ('limit', 'stop')),
  trigger_price   numeric(28,10) not null check (trigger_price > 0),
  leverage        int not null check (leverage between 1 and 200),
  margin          numeric(18,2) not null check (margin > 0),
  take_profit     numeric(28,10),
  stop_loss       numeric(28,10),
  status          text not null default 'working' check (status in ('working', 'filled', 'cancelled', 'failed')),
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists pending_orders_working_idx on public.pending_orders (account_id) where status = 'working';
create index if not exists pending_orders_account_idx on public.pending_orders (account_id, status);

alter table public.pending_orders enable row level security;
drop policy if exists pending_orders_select_own on public.pending_orders;
create policy pending_orders_select_own on public.pending_orders
  for select using (user_id = auth.uid() or public.is_admin());
