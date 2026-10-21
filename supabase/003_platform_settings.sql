-- =====================================================================
-- SOGDIA — migration 003
-- Single editable settings document (referral commission, discounts,
-- promo codes), owned by X-Department.
-- Run AFTER 002_xdepartment_and_upgrades.sql.
-- =====================================================================

create table if not exists public.platform_settings (
  id         text primary key default 'global',
  raw        text        not null,                        -- exactly what X-Department typed
  parsed     jsonb       not null default '{}'::jsonb,     -- normalised, what the API reads
  version    int         not null default 1,
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint platform_settings_single_row check (id = 'global')
);

comment on table public.platform_settings is
  'One row. `raw` is the free-text blob edited in the admin textarea; `parsed` is the validated form the backend reads.';

alter table public.platform_settings enable row level security;

-- Readable by staff only; the public-facing values are exposed through
-- the API (GET /api/pricing, /api/promos/validate), never by direct select.
drop policy if exists platform_settings_select_staff on public.platform_settings;
create policy platform_settings_select_staff on public.platform_settings
  for select using (public.is_admin());

-- Seed the defaults. The API backfills this row on first read if missing,
-- so this insert is belt-and-braces.
insert into public.platform_settings (id, raw, parsed)
values (
  'global',
  E'# SOGDIA platform settings\n'
  E'# Edited by X-Department. Prices live in src/config/pricing.ts and are NOT editable here.\n'
  E'\n'
  E'referral_commission_pct = 10\n'
  E'referral_discount_pct   = 5\n'
  E'default_discount_pct    = 0\n'
  E'min_invoice_usd         = 1\n'
  E'\n'
  E'# promo = CODE | 25% | plans:all | expires:2026-12-31 | max_uses:500 | active\n'
  E'promo = WELCOME10 | 10% | plans:all | expires:never | max_uses:0 | active\n',
  '{}'::jsonb
)
on conflict (id) do nothing;

-- Promo redemptions are counted from transactions.metadata->>'promo_code',
-- so this index keeps that count cheap.
create index if not exists transactions_promo_idx
  on public.transactions ((metadata ->> 'promo_code'))
  where type = 'purchase';
