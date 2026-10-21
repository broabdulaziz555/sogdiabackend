# SOGDIA — Backend

Crypto prop-firm backend. Next.js 14 App Router (API routes only, no UI), Supabase (Postgres + Auth + Storage), NOWPayments for crypto checkout, Binance public REST for pricing, `@vercel/og` for shareable trade cards and certificates.

**Read [`api-contract.md`](./api-contract.md) first** — it is the full frontend contract: every route, body and response.

## Folder structure

```
sogdia-backend/
├── api-contract.md                    ← the frontend contract (50 endpoints)
├── supabase/
│   ├── schema.sql                     ← base schema: tables, enums, RLS, triggers, RPC
│   ├── 002_xdepartment_and_upgrades.sql  ← X-Department tier + platform upgrades
│   └── 003_platform_settings.sql      ← the editable settings blob (commission, discounts, promos)
├── .env.example
└── src/
    ├── config/
    │   ├── pricing.ts                 ← plans, prices, 80/20 split, 14-day cycle, DD rules
    │   ├── settings.ts                ← default commission/discount/promo blob
    │   └── symbols.ts                 ← top-50 Binance USDT whitelist
    ├── lib/
    │   ├── accounts.ts                ← account provisioning (purchase + gift)
    │   ├── audit.ts                   ← privileged-action log
    │   ├── auth.ts                    ← bearer → user, ownership guards, cron secret
    │   ├── binance.ts                 ← live prices, 1.5s cache, symbol whitelist
    │   ├── certificates.ts            ← certificate issuance
    │   ├── engine.ts                  ← B-book orchestration: sweep, settle, evaluate
    │   ├── http.ts                    ← response envelope, ApiError, handle()
    │   ├── idempotency.ts             ← Idempotency-Key replay
    │   ├── math.ts                    ← spread, sizing, PnL, liquidation price
    │   ├── nowpayments.ts             ← invoice creation + IPN HMAC verification
    │   ├── notifications.ts
    │   ├── payouts.ts                 ← eligibility + 80/20 split
    │   ├── permissions.ts             ← trader / admin / xdepartment ladder
    │   ├── promos.ts                  ← promo validation + checkout pricing
    │   ├── settings.ts                ← settings blob parser, validator, cache
    │   ├── ratelimit.ts
    │   ├── referrals.ts
    │   ├── risk.ts                    ← equity, drawdown floors, breach detection
    │   ├── snapshots.ts               ← equity curve
    │   ├── supabase.ts                ← service-role + anon clients
    │   ├── types.ts
    │   └── validation.ts              ← zod schemas for every body
    └── app/api/
        ├── auth/{register,login,refresh}/
        ├── me/
        ├── pricing/            market/{symbols,prices}/     health/
        ├── accounts/           accounts/[id]/{route,equity-curve}/
        ├── trade/{open,close,partial-close,protection,positions,history}/
        ├── risk/evaluate/      cron/daily-reset/
        ├── checkout/           webhook/nowpayments/
        ├── kyc/{upload,status}/
        ├── payouts/            payouts/eligibility/
        ├── certificates/       og/{trade,certificate}/[id]/
        ├── leaderboard/        referrals/      notifications/   promos/validate/
        ├── admin/{users,accounts,accounts/[id]/status,kyc/[userId],payouts/[id],certificates,stats}/
        └── xdepartment/{accounts/gift,accounts/[id],accounts/[id]/adjust,
                         users/[id]/role,users/[id]/kyc,payouts/[id]/force,
                         impersonate/[userId],audit,settings,
                         promos,promos/[code]}/
```

## Setup

```bash
npm install
cp .env.example .env.local     # fill in Supabase, NOWPayments, CRON_SECRET
npm run dev
```

1. Run `supabase/schema.sql` in the Supabase SQL editor.
2. Run `supabase/002_xdepartment_and_upgrades.sql`. If your client wraps statements in a transaction, run section 1 (the `alter type` lines) on its own first. Then run `supabase/003_platform_settings.sql`.
3. Register your own user, then grant yourself clearance:
   ```sql
   update public.users set role = 'xdepartment' where email = 'you@sogdia.io';
   ```
4. Point the NOWPayments IPN at `https://<domain>/api/webhook/nowpayments`.
5. Schedule `POST /api/cron/daily-reset` at 00:00 UTC with the `x-cron-secret` header (Vercel Cron, GitHub Actions, or pg_cron + `net.http_post`).

## How the engine works

**Fill.** `trade/open` pulls the live Binance mid, applies a 0.05 % spread against the trader (long fills at ask, short at bid), sizes the notional as `margin × leverage`, and stores the liquidation price up front: `entry × (1 ∓ 1/leverage)`. Margin is not debited — free margin is `balance − Σ open margin`, and PnL hits the balance only on settlement.

**Settlement** goes through the `close_position` SQL function, so the order row and the balance credit move together.

**Auto-close sweep.** Every `GET /api/trade/positions` call re-marks open positions and closes anything that crossed its liquidation price (settles at the liquidation price, trader loses exactly the margin), its stop-loss, or its take-profit. Liquidation is checked first, so a stop placed beyond liquidation can never rescue a position. Poll it every 2–5 s.

**Risk.** `equity = balance + unrealised PnL`. The daily floor is `daily_start_balance × (1 − daily_dd_pct)`, reset at 00:00 UTC; the max floor is `size × (1 − max_dd_pct)`, static from day one. One-Step runs 4 % / 6 %, Instant 3 % / 5 %. On breach the engine flattens every position, sets `status = 'failed'` and records the reason. One-Step accounts pass on **realised** balance, so floating profit can't buy a pass.

**Money in.** `checkout` creates a pending transaction plus a NOWPayments invoice. The account is created only by the IPN, which verifies the HMAC-SHA512 signature over the sorted JSON body and is idempotent on `payment_id`.

**Money out.** A payout needs verified KYC, a wallet, a positive realised balance, no open positions, and an elapsed 14-day cycle. The trader receives 80 %. `mark_paid` debits the gross from the account, rolls the cycle and auto-issues a payout certificate.

## Role ladder

| Role | Can do |
|---|---|
| `trader` | own accounts only |
| `admin` | KYC review, payout approval, freeze/breach, manual certificates, stats |
| `xdepartment` | all of the above, plus gifting accounts of any type/size, balance and rule overrides, status forcing, hard deletes, role changes, forced payouts, impersonation |

## Runtime settings

Referral commission, referral discount, the site-wide discount and every promo code live in **one editable document** (`platform_settings`, one row) that X-Department reads and writes through `GET`/`PUT /api/xdepartment/settings`. The raw text is stored exactly as typed; the parser accepts a forgiving line format or raw JSON and returns per-line errors so the editor can show them inline. Defaults ship in `src/config/settings.ts` and are returned as `default_raw` for a reset button. See §15 of the API contract for the full format.

Promos can be managed either by editing the document or one at a time through `/api/xdepartment/promos` (list, create, update, delete). Both paths write the same document — the per-promo endpoints do line-level edits, so comments and formatting in the file survive.

Only the single best discount applies to a checkout — promo, referral and site-wide never stack — and the invoice is floored at `min_invoice_usd` so a 100 % code can't produce a $0 invoice the payment provider rejects. A discount changes the price, never the account: a discounted sale still grants the full plan.

Every privileged action writes an `audit_logs` row (actor, role, target, before/after payload, IP). Nothing in the API can edit prices — `src/config/pricing.ts` is the only source, and each account snapshots its plan at creation so later edits never retro-change live accounts.

## Before you go live

- **Keys.** `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. Server-only, never in a client bundle.
- **Rate limiting** is in-process (`lib/ratelimit.ts`). Swap the `Map` for Upstash Redis once you run more than one instance.
- **Price feed.** Binance public REST is unauthenticated and rate-limited by IP. For real volume, move to a websocket ticker stream with a shared in-memory book and keep REST as the fallback.
- **Liquidations** currently fire on poll. A background worker looping over open positions every second closes the gap where nobody is watching the screen.
- **Idempotency GC.** Schedule the `delete from idempotency_keys` statement at the bottom of migration 002.
- **Regulatory.** A simulated-capital prop model is treated very differently across jurisdictions; the payout, marketing and T&C side wants a lawyer before launch, not after.
