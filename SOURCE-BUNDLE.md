# SOGDIA Backend — Complete Source Bundle
Every file in the project, in reading order. 84 files.
Each file is marked with its path. Copy them into a Next.js project at the paths shown, or just use the zip.

---

# Documentation

## `README.md`

````markdown
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
````

## `api-contract.md`

````markdown
# SOGDIA — Backend API Contract

> Version `1.1.0` · Base URL `https://<your-domain>/api`
> Every route below is implemented under `src/app/api/...` (Next.js App Router, TypeScript).

---

## 1. Conventions

### 1.1 Response envelope

Every JSON endpoint returns one of these two shapes. OG image routes return `image/png` instead.

**Success**
```json
{ "ok": true, "data": { } }
```

**Error**
```json
{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_MARGIN",
    "message": "Margin exceeds free balance.",
    "details": null
  }
}
```

### 1.2 Authentication

Supabase JWT in the header. Obtain it from `POST /api/auth/login` (or the Supabase client SDK on the frontend).

```
Authorization: Bearer <supabase_access_token>
```

| Marker | Meaning |
|---|---|
| 🔓 | public, no auth |
| 🔒 | any authenticated user (trader or admin) |
| 🛡️ | staff — `users.role` is `admin` or `xdepartment` |
| 🛂 | `users.role = 'xdepartment'` only (unrestricted tier, fully audited) |
| ⚙️ | machine-to-machine (`x-cron-secret` header or NOWPayments IPN signature) |

### 1.3 Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query failed schema validation. `details` holds field errors. |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired bearer token. |
| `FORBIDDEN` | 403 | Authenticated but not allowed (not owner / not admin). |
| `NOT_FOUND` | 404 | Resource does not exist or is not visible to the caller. |
| `ACCOUNT_NOT_TRADABLE` | 409 | Account status is not `active`. |
| `ORDER_NOT_OPEN` | 409 | Order already closed or liquidated. |
| `INSUFFICIENT_MARGIN` | 409 | Requested margin exceeds free balance. |
| `SYMBOL_NOT_ALLOWED` | 409 | Symbol outside the top-50 USDT whitelist. |
| `KYC_REQUIRED` | 409 | KYC is not `verified`. |
| `PAYOUT_NOT_ELIGIBLE` | 409 | Cycle not elapsed, no profit, or account not eligible. |
| `DUPLICATE` | 409 | Idempotency conflict (e.g. webhook replay). |
| `RATE_LIMITED` | 429 | Too many requests. |
| `UPSTREAM_ERROR` | 502 | Binance / NOWPayments unreachable. |
| `INTERNAL_ERROR` | 500 | Unhandled. |

### 1.4 Shared object shapes

**User**
```json
{
  "id": "uuid",
  "email": "trader@sogdia.io",
  "role": "trader",
  "kyc_status": "not_submitted",
  "wallet_address": null,
  "full_name": null,
  "country": null,
  "created_at": "2026-10-21T08:00:00.000Z"
}
```

**Account**
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "type": "one_step",
  "plan_key": "one_step_10k",
  "size": 10000,
  "balance": 10420.5,
  "equity": 10388.2,
  "daily_start_balance": 10200,
  "status": "active",
  "max_leverage": 200,
  "profit_target_pct": 10,
  "daily_dd_pct": 4,
  "max_dd_pct": 6,
  "payout_split_pct": 80,
  "payout_cycle_days": 14,
  "next_payout_at": "2026-11-04T08:00:00.000Z",
  "created_at": "2026-10-21T08:00:00.000Z"
}
```

**AccountMetrics** (computed, never stored stale)
```json
{
  "equity": 10388.2,
  "unrealized_pnl": -32.3,
  "used_margin": 500,
  "free_margin": 9920.5,
  "open_positions": 2,
  "daily_dd_limit": 9792,
  "max_dd_limit": 9400,
  "daily_dd_remaining": 596.2,
  "max_dd_remaining": 988.2,
  "daily_dd_used_pct": 1.74,
  "max_dd_used_pct": 1.12,
  "profit_target": 11000,
  "profit_pct": 3.88,
  "target_reached": false
}
```

**Position** (an order with live marks attached)
```json
{
  "id": "uuid",
  "account_id": "uuid",
  "symbol": "BTCUSDT",
  "side": "long",
  "leverage": 20,
  "margin": 250,
  "position_size": 5000,
  "quantity": 0.0721,
  "entry_price": 69350.25,
  "liquidation_price": 65882.74,
  "mark_price": 69510.1,
  "unrealized_pnl": 11.52,
  "unrealized_pnl_pct": 4.61,
  "status": "open",
  "created_at": "2026-10-21T08:00:00.000Z"
}
```

---

## 2. Auth

### `POST /api/auth/register` 🔓
Creates the Supabase auth user; a DB trigger mirrors it into `public.users`.

**Body**
```json
{ "email": "trader@sogdia.io", "password": "Str0ngPass", "full_name": "Ali Karimov", "country": "UZ" }
```
Password: **min 8, max 16 characters**, must contain a letter and a digit. `full_name` and `country` optional.

**200**
```json
{
  "ok": true,
  "data": {
    "user": { "id": "uuid", "email": "trader@sogdia.io", "role": "trader", "kyc_status": "not_submitted" },
    "session": { "access_token": "ey...", "refresh_token": "...", "expires_at": 1792000000 },
    "email_confirmation_required": false
  }
}
```
`session` is `null` when the project has email confirmation enabled.

**Errors** `VALIDATION_ERROR`, `DUPLICATE` (email already registered).

---

### `POST /api/auth/login` 🔓
**Body** `{ "email": "trader@sogdia.io", "password": "Str0ngPass" }`

**200**
```json
{
  "ok": true,
  "data": {
    "user": { "...User" },
    "session": { "access_token": "ey...", "refresh_token": "...", "expires_at": 1792000000 }
  }
}
```
**Errors** `UNAUTHORIZED` (bad credentials).

---

### `POST /api/auth/refresh` 🔓
**Body** `{ "refresh_token": "..." }` → **200** `{ "ok": true, "data": { "session": { ... } } }`

---

### `GET /api/me` 🔒
**200**
```json
{
  "ok": true,
  "data": {
    "user": { "...User" },
    "accounts_count": 3,
    "active_accounts": 2
  }
}
```

### `PATCH /api/me` 🔒
**Body** (all optional) `{ "wallet_address": "TQn9...", "full_name": "Ali Karimov", "country": "UZ" }`
**200** `{ "ok": true, "data": { "user": { "...User" } } }`

---

## 3. Catalog & market data

### `GET /api/pricing` 🔓
List prices are fixed in `src/config/pricing.ts`. `discounts` and `promos` come from the X-Department settings blob (§15), so the pricing page can show both the list price and today's effective price.

**200**
```json
{
  "ok": true,
  "data": {
    "payout_split_pct": 80,
    "payout_cycle_days": 14,
    "discounts": {
      "site_wide_pct": 0,
      "referral_discount_pct": 5,
      "referral_commission_pct": 10,
      "stacking": "best_single_discount"
    },
    "promos": [
      { "code": "WELCOME10", "kind": "percent", "value": 10, "plans": "all",
        "expires_at": null, "note": null }
    ],
    "plans": [
      {
        "key": "one_step_10k",
        "type": "one_step",
        "label": "One-Step $10K",
        "size": 10000,
        "price": 69,
        "effective_price": 69,
        "profit_target_pct": 10,
        "daily_dd_pct": 4,
        "max_dd_pct": 6,
        "max_leverage": 200,
        "payout_split_pct": 80,
        "payout_cycle_days": 14
      }
    ]
  }
}
```
All 10 plans are returned: `one_step_5k|10k|25k|50k|100k` ($39/$69/$149/$249/$399) and `instant_5k|10k|25k|50k|100k` ($63/$91/$183/$275/$459). `promos` lists only active, unexpired codes. `effective_price` reflects the site-wide discount only — per-user and promo pricing comes from `/api/promos/validate`.

### `GET /api/promos/validate` 🔒
Price preview for the checkout screen. Creates nothing.

**Query** `?plan_key=one_step_10k&code=WELCOME10` — omit `code` to see the discount the user already qualifies for (referral or site-wide).

**200 (valid)**
```json
{
  "ok": true,
  "data": {
    "valid": true,
    "promo_code": "WELCOME10",
    "reason": null,
    "quote": {
      "plan_key": "one_step_10k",
      "list_price": 69,
      "discount": 6.9,
      "final_price": 62.1,
      "source": "promo",
      "promo_code": "WELCOME10",
      "label": "WELCOME10"
    }
  }
}
```

**200 (rejected — still 200, so the UI can show the reason inline)**
```json
{
  "ok": true,
  "data": {
    "valid": false,
    "promo_code": "SUMMER25",
    "reason": "EXPIRED",
    "message": "That promo code has expired.",
    "quote": { "...the quote without the code" }
  }
}
```
`reason` ∈ `UNKNOWN_CODE | INACTIVE | EXPIRED | PLAN_NOT_ELIGIBLE | LIMIT_REACHED`.
`source` ∈ `promo | referral | site_wide | none`.

---

### `GET /api/market/symbols` 🔓
**200**
```json
{ "ok": true, "data": { "count": 50, "symbols": [ { "symbol": "BTCUSDT", "base": "BTC", "quote": "USDT" } ] } }
```

### `GET /api/market/prices` 🔓
**Query** `?symbols=BTCUSDT,ETHUSDT` — omit to get all 50.

**200**
```json
{
  "ok": true,
  "data": {
    "spread_bps": 5,
    "prices": [
      { "symbol": "BTCUSDT", "price": 69480.12, "bid": 69445.38, "ask": 69514.86 }
    ],
    "fetched_at": "2026-10-21T08:00:00.000Z"
  }
}
```
**Errors** `SYMBOL_NOT_ALLOWED`, `UPSTREAM_ERROR`.

---

## 4. Accounts

### `GET /api/accounts` 🔒
**Query** `?status=active` (optional)

**200** `{ "ok": true, "data": { "accounts": [ { "...Account" } ] } }`

### `GET /api/accounts/{id}` 🔒
Recomputes equity from live marks, runs the risk engine, and persists any status change before responding.

**200**
```json
{
  "ok": true,
  "data": {
    "account": { "...Account" },
    "metrics": { "...AccountMetrics" },
    "risk": { "breached": false, "reason": null, "status": "active" }
  }
}
```
**Errors** `NOT_FOUND`, `FORBIDDEN`.

---

## 5. Trading engine (B-book)

### `POST /api/trade/open` 🔒
Fetches the live Binance price, applies a **0.05 % spread** against the trader (long fills at ask, short at bid), sizes the position as `margin × leverage`, stores the liquidation price, then re-runs the risk engine.

**Body**
```json
{ "account_id": "uuid", "symbol": "BTCUSDT", "side": "long", "leverage": 20, "margin": 250 }
```
| Field | Rules |
|---|---|
| `symbol` | must be in the top-50 USDT whitelist |
| `side` | `long` \| `short` |
| `leverage` | integer 1–200 |
| `margin` | > 0, ≤ free margin |

**200**
```json
{
  "ok": true,
  "data": {
    "order": { "...Position" },
    "account": { "...Account" },
    "metrics": { "...AccountMetrics" }
  }
}
```
**Errors** `VALIDATION_ERROR`, `ACCOUNT_NOT_TRADABLE`, `INSUFFICIENT_MARGIN`, `SYMBOL_NOT_ALLOWED`, `UPSTREAM_ERROR`.

---

### `POST /api/trade/close` 🔒
**Body** `{ "order_id": "uuid" }`

Fetches the live price, applies the exit spread, realises PnL atomically against the balance (`close_position` SQL function), then re-runs the risk engine.

**200**
```json
{
  "ok": true,
  "data": {
    "order": {
      "id": "uuid", "symbol": "BTCUSDT", "side": "long",
      "entry_price": 69350.25, "close_price": 69510.1,
      "pnl": 11.52, "pnl_pct": 4.61,
      "status": "closed", "close_reason": "manual",
      "closed_at": "2026-10-21T09:12:00.000Z"
    },
    "account": { "...Account" },
    "metrics": { "...AccountMetrics" },
    "risk": { "breached": false, "reason": null, "status": "active" }
  }
}
```
**Errors** `NOT_FOUND`, `ORDER_NOT_OPEN`, `UPSTREAM_ERROR`.

---

### `GET /api/trade/positions` 🔒
Open positions with live PnL. **Side effect:** any position whose mark has crossed its liquidation price is auto-closed at the liquidation price (full margin loss) before the response is built, and the risk engine runs afterwards. Poll this every 2–5 s from the frontend.

**Query** `?account_id=uuid` (required)

**200**
```json
{
  "ok": true,
  "data": {
    "positions": [ { "...Position" } ],
    "liquidated": [ { "id": "uuid", "symbol": "BTCUSDT", "pnl": -250, "close_price": 65882.74 } ],
    "account": { "...Account" },
    "metrics": { "...AccountMetrics" },
    "risk": { "breached": false, "reason": null, "status": "active" }
  }
}
```

---

### `GET /api/trade/history` 🔒
**Query** `?account_id=uuid&limit=50&offset=0&status=closed`

**200**
```json
{
  "ok": true,
  "data": {
    "orders": [ { "id": "uuid", "symbol": "ETHUSDT", "side": "short", "leverage": 10, "margin": 100,
                  "position_size": 1000, "entry_price": 2510.4, "close_price": 2480.1,
                  "pnl": 12.07, "status": "closed", "close_reason": "manual",
                  "created_at": "...", "closed_at": "..." } ],
    "total": 128,
    "limit": 50,
    "offset": 0,
    "stats": { "trades": 128, "wins": 71, "losses": 57, "win_rate": 55.47, "net_pnl": 420.5 }
  }
}
```

---

## 6. Risk engine

Thresholds are snapshotted onto the account at creation:

| Account type | Daily DD | Max DD |
|---|---|---|
| One-Step | 4 % of `daily_start_balance` | 6 % of `size` |
| Instant Funding | 3 % of `daily_start_balance` | 5 % of `size` |

`equity = balance + Σ unrealized_pnl`. On breach: all open positions are force-closed at market, `accounts.status` → `failed`, `breach_reason` recorded. One-Step accounts that reach the profit target flip to `passed` and an `eval_pass` certificate is issued automatically.

### `POST /api/risk/evaluate` 🔒
Manual re-check of one account (the same routine runs after every open/close and on `GET /api/accounts/{id}`).

**Body** `{ "account_id": "uuid" }`

**200**
```json
{
  "ok": true,
  "data": {
    "account": { "...Account" },
    "metrics": { "...AccountMetrics" },
    "risk": { "breached": true, "reason": "DAILY_DRAWDOWN", "status": "failed", "closed_orders": 2 }
  }
}
```
`reason` ∈ `null | "DAILY_DRAWDOWN" | "MAX_DRAWDOWN"`.

### `POST /api/cron/daily-reset` ⚙️
Header `x-cron-secret: <CRON_SECRET>`. Run at **00:00 UTC**. Sets `daily_start_balance = equity` for every `active` account and stamps `daily_reset_at`.

**200** `{ "ok": true, "data": { "accounts_reset": 412, "reset_at": "2026-10-22T00:00:00.000Z" } }`

---

## 7. Payments (NOWPayments)

### `POST /api/checkout` 🔒
Creates a `pending` purchase transaction and a NOWPayments invoice. **No account is created here** — the account appears only when the IPN confirms payment.

**Body**
```json
{ "plan_key": "one_step_10k", "pay_currency": "usdttrc20", "promo_code": "WELCOME10" }
```
`pay_currency` and `promo_code` are optional. Discounts are applied server-side from the settings blob — the client never sends a price. Only the single best discount applies (promo vs referral vs site-wide; they never stack).

**200**
```json
{
  "ok": true,
  "data": {
    "transaction_id": "uuid",
    "order_id": "SOGDIA-9f3a2b1c",
    "invoice_url": "https://nowpayments.io/payment/?iid=123456789",
    "amount": 62.1,
    "pricing": {
      "list_price": 69,
      "discount": 6.9,
      "final_price": 62.1,
      "source": "promo",
      "promo_code": "WELCOME10",
      "label": "WELCOME10"
    },
    "plan": { "key": "one_step_10k", "label": "One-Step $10K", "size": 10000, "price": 69 }
  }
}
```
`amount` equals `pricing.final_price` — that is what the invoice charges. The account granted on confirmation is always the full plan; a discount changes the price, never the account.

**Headers** `Idempotency-Key: <uuid>` (optional) — a repeat of the same key replays the original response instead of creating a second invoice.

**Errors** `VALIDATION_ERROR` (unknown `plan_key`, or an invalid/expired/ineligible `promo_code` — `details` carries `reason`), `UPSTREAM_ERROR`.

---

### `POST /api/webhook/nowpayments` ⚙️
NOWPayments IPN. Verifies the `x-nowpayments-sig` HMAC-SHA512 over the **sorted** JSON body using `NOWPAYMENTS_IPN_SECRET`. Idempotent on `payment_id`.

**Body (sent by NOWPayments)**
```json
{
  "payment_id": "5745459419",
  "payment_status": "finished",
  "order_id": "SOGDIA-9f3a2b1c",
  "price_amount": 69,
  "price_currency": "usd",
  "actually_paid": 69.02,
  "pay_currency": "usdttrc20",
  "outcome_amount": 68.5
}
```

Behaviour by `payment_status`:

| Status | Action |
|---|---|
| `finished`, `confirmed` | transaction → `paid`; **create the account** from the plan snapshot (balance = equity = daily_start_balance = size); link `transactions.account_id` |
| `partially_paid`, `confirming`, `sending`, `waiting` | transaction stays `pending` |
| `failed`, `expired`, `refunded` | transaction → `failed` |

**200** `{ "ok": true, "data": { "received": true, "account_created": true, "account_id": "uuid" } }`
**Errors** `UNAUTHORIZED` (bad signature), `NOT_FOUND` (unknown `order_id`).

---

## 8. KYC

### `GET /api/kyc/status` 🔒
**200** `{ "ok": true, "data": { "kyc_status": "pending", "document_url": "kyc-documents/<uid>/passport.jpg", "note": null } }`

### `POST /api/kyc/upload` 🔒
`multipart/form-data` — field `file` (jpg/png/pdf, ≤ 5 MB), optional field `doc_type` (`passport|id_card|driver_license`).
Uploads to the private `kyc-documents` bucket under `<user_id>/…` and sets `kyc_status = 'pending'`.

**200**
```json
{
  "ok": true,
  "data": {
    "path": "7f0c.../passport-1761033600000.jpg",
    "signed_url": "https://<project>.supabase.co/storage/v1/object/sign/kyc-documents/...",
    "expires_in": 3600,
    "kyc_status": "pending"
  }
}
```
**Errors** `VALIDATION_ERROR` (missing file, bad mime, too large).

### `POST /api/admin/kyc/{userId}` 🛡️
**Body** `{ "action": "approve" }` or `{ "action": "reject", "note": "Document unreadable" }`
**200** `{ "ok": true, "data": { "user": { "...User" } } }`

---

## 9. Payouts

Eligibility: KYC `verified` · `wallet_address` set · account status `active` or `passed` · `balance > size` · `payout_cycle_days` (14) elapsed since `created_at`/`last_payout_at`. Payout = `profit × 80 %`; the 20 % stays with the firm.

### `GET /api/payouts` 🔒
**Query** `?status=pending` (optional)
**200**
```json
{
  "ok": true,
  "data": { "transactions": [
    { "id": "uuid", "account_id": "uuid", "amount": 500, "net_amount": 400, "type": "payout",
      "status": "pending", "wallet_address": "TQn9...", "tx_hash": null, "created_at": "..." }
  ] }
}
```

### `GET /api/payouts/eligibility` 🔒
**Query** `?account_id=uuid`
**200**
```json
{
  "ok": true,
  "data": {
    "eligible": false,
    "reasons": ["CYCLE_NOT_ELAPSED"],
    "profit": 420.5,
    "max_payout": 336.4,
    "split_pct": 80,
    "next_payout_at": "2026-11-04T08:00:00.000Z",
    "days_remaining": 9
  }
}
```

### `POST /api/payouts` 🔒
**Body** `{ "account_id": "uuid", "amount": 300 }` — `amount` is the **gross profit** withdrawn; omit to withdraw all profit. The 80/20 split is applied server-side.

**200**
```json
{
  "ok": true,
  "data": {
    "transaction": { "id": "uuid", "amount": 300, "net_amount": 240, "status": "pending",
                     "wallet_address": "TQn9...", "type": "payout", "created_at": "..." }
  }
}
```
**Errors** `KYC_REQUIRED`, `PAYOUT_NOT_ELIGIBLE`, `ACCOUNT_NOT_TRADABLE`, `VALIDATION_ERROR`.

### `POST /api/admin/payouts/{id}` 🛡️
**Body**
```json
{ "action": "approve" }
{ "action": "mark_paid", "tx_hash": "0xabc...", "note": "TRC20 sent" }
{ "action": "reject", "note": "Suspicious trading pattern" }
```
`mark_paid` debits the gross amount from `accounts.balance`, stamps `last_payout_at` / `next_payout_at` (+14 d), and auto-issues a `payout` certificate.

**200** `{ "ok": true, "data": { "transaction": { ... }, "certificate_id": "uuid" } }`

---

## 10. Certificates & OG images

### `GET /api/certificates` 🔒
**Query** `?account_id=uuid` (optional)
**200**
```json
{ "ok": true, "data": { "certificates": [
  { "id": "uuid", "account_id": "uuid", "type": "payout", "amount": 240, "code": "A1B2C3D4E5",
    "display_name": "Ali Karimov", "is_manual": false, "issued_at": "...",
    "image_url": "/api/og/certificate/uuid" } ] } }
```

### `GET /api/og/trade/{id}` 🔓
Returns **`image/png`** (1200×630) rendered with `@vercel/og`: symbol, side, leverage, entry, exit, PnL %, SOGDIA branding. Shareable — no auth, id is an unguessable uuid. Cached `public, max-age=300` for closed trades, `no-store` while open.
**Errors** 404 PNG fallback if the order does not exist.

### `GET /api/og/certificate/{id}` 🔓
Returns **`image/png`** (1200×850) — certificate type (Evaluation Passed / Payout), trader name, amount, account size, certificate code, issue date.

---

## 11. Admin

### `GET /api/admin/users` 🛡️
**Query** `?query=ali&kyc_status=pending&limit=50&offset=0`
**200** `{ "ok": true, "data": { "users": [ { "...User", "accounts_count": 2 } ], "total": 940 } }`

### `GET /api/admin/accounts` 🛡️
**Query** `?status=active&user_id=uuid&limit=50&offset=0`
**200** `{ "ok": true, "data": { "accounts": [ { "...Account", "user_email": "..." } ], "total": 1820 } }`

### `POST /api/admin/accounts/{id}/status` 🛡️
Freeze, breach (illegal/abusive trading), restore, or close an account.

**Body**
```json
{ "action": "freeze", "reason": "Pending investigation" }
{ "action": "breach", "reason": "Latency arbitrage / tick-scalping detected", "close_positions": true }
{ "action": "unfreeze" }
{ "action": "close", "reason": "Trader request" }
```
`breach` force-closes open positions at market when `close_positions` is `true` (default) and sets status `breached`.

**200** `{ "ok": true, "data": { "account": { "...Account" }, "closed_orders": 3 } }`

### `POST /api/admin/certificates` 🛡️
Manual certificate issuance — inserts with `is_manual = true`.

**Body**
```json
{ "user_id": "uuid", "account_id": "uuid", "type": "payout", "amount": 2500, "display_name": "Ali Karimov" }
```
**200** `{ "ok": true, "data": { "certificate": { ... }, "image_url": "/api/og/certificate/uuid" } }`

### `GET /api/admin/stats` 🛡️
**200**
```json
{
  "ok": true,
  "data": {
    "users": 940,
    "accounts": { "active": 612, "failed": 980, "passed": 71, "frozen": 4, "breached": 9 },
    "revenue_usd": 84210,
    "payouts_paid_usd": 19480,
    "payouts_pending": 12,
    "kyc_pending": 23,
    "open_positions": 318
  }
}
```

---

## 12. Trading extras

### `POST /api/trade/protection` 🔒
Attach or clear a take-profit / stop-loss on an open position. Levels are validated against the side, the live mark, and the liquidation price (a stop beyond liquidation is rejected). Enforced by the same sweep that runs on every `GET /api/trade/positions` call.

**Body** (send either field; `null` clears)
```json
{ "order_id": "uuid", "take_profit": 71500.0, "stop_loss": 68200.0 }
```
**200** `{ "ok": true, "data": { "order": { "...Position" } } }`
**Errors** `ORDER_NOT_OPEN`, `VALIDATION_ERROR`, `NOT_FOUND`.

`POST /api/trade/open` also accepts optional `take_profit` and `stop_loss` in the same body.

When a position auto-closes, `liquidated[]` on the positions response carries `reason`: `liquidation | stop_loss | take_profit`.

### `POST /api/trade/partial-close` 🔒
Closes a slice of a position. The slice is written as its own settled order (linked by `parent_order_id`) so history and win-rate stay accurate; the parent keeps the remainder.

**Body** `{ "order_id": "uuid", "percent": 50 }`

**200**
```json
{
  "ok": true,
  "data": {
    "closed": { "id": "uuid", "percent": 50, "pnl": 24.1, "pnl_pct": 19.3, "close_price": 69510.1 },
    "remaining": { "id": "uuid", "quantity": 0.036, "margin": 125, "position_size": 2500 },
    "account": { "...Account" },
    "metrics": { "...AccountMetrics" }
  }
}
```
`percent: 100` behaves as a normal close and returns `"remaining": null`.

### `GET /api/accounts/{id}/equity-curve` 🔒
**Query** `?limit=500`
**200**
```json
{
  "ok": true,
  "data": {
    "account_id": "uuid",
    "starting_size": 10000,
    "points": [ { "equity": 10120.5, "balance": 10120.5, "source": "trade_close", "taken_at": "..." } ]
  }
}
```
`source` ∈ `daily_close | trade_close | manual`.

---

## 13. Community & account extras

### `GET /api/leaderboard` 🔓
**Query** `?type=one_step&limit=25`
Public ranking by realised return. Names are shortened to `First L.`; no emails or account ids are exposed.
**200**
```json
{
  "ok": true,
  "data": {
    "leaderboard": [
      { "rank": 1, "trader": "Ali K.", "country": "UZ", "account_size": 100000,
        "type": "one_step", "return_pct": 18.4, "status": "passed", "since": "..." }
    ],
    "updated_at": "..."
  }
}
```

### `GET /api/referrals` 🔒
Returns (and lazily mints) the caller's affiliate code. Commission is 10 % of a referred purchase, booked as a `commission` transaction — it never touches a trading account.
**200**
```json
{
  "ok": true,
  "data": {
    "referral_code": "A1B2C3D4",
    "commission_pct": 10,
    "friend_discount_pct": 5,
    "signups": 7,
    "earned_total": 211.3,
    "earned_paid": 138,
    "earned_pending": 73.3,
    "history": [ { "amount": 6.9, "status": "pending", "created_at": "..." } ]
  }
}
```
`POST /api/auth/register` accepts an optional `referral_code` to attribute the signup.

### `GET /api/notifications` 🔒
**Query** `?unread=true&limit=50&offset=0`
**200** `{ "ok": true, "data": { "notifications": [...], "unread": 3, "total": 41, "limit": 50, "offset": 0 } }`

### `POST /api/notifications` 🔒
**Body** `{ "ids": ["uuid"] }` or `{ "all": true }` → **200** `{ "ok": true, "data": { "marked_read": true } }`

### `GET /api/health` 🔓
**200** `{ "ok": true, "data": { "status": "healthy", "price_feed": "up", "latency_ms": 142, "version": "1.1.0", "time": "..." } }`

### Idempotency
`POST /api/checkout` honours an `Idempotency-Key` header: a repeat of the same key replays the original response instead of creating a second invoice.

---

## 14. X-Department 🛂

`role = 'xdepartment'` is the tier above `admin`: everything an admin can do, plus provisioning and overrides. Every endpoint here writes an `audit_logs` row with the actor, target, before/after payload and IP. Endpoints are marked 🛂.

> Pricing is immutable through the API. Nothing in this section can edit the price table — `src/config/pricing.ts` is the only place prices live, and plan prices are snapshotted onto each account at creation.

### `POST /api/xdepartment/accounts/gift` 🛂
Give any user one or more accounts, free of charge — test accounts, comped accounts, competition prizes, goodwill replacements. Either a catalogue plan or a fully custom size and rule-set.

**Body** (plan-based)
```json
{ "email": "trader@sogdia.io", "plan_key": "one_step_100k", "quantity": 1, "reason": "Competition prize" }
```
**Body** (custom size + overridden rules)
```json
{
  "user_id": "uuid",
  "custom": { "type": "instant", "size": 250000 },
  "rules": {
    "profit_target_pct": null,
    "daily_dd_pct": 10,
    "max_dd_pct": 20,
    "max_leverage": 100,
    "payout_split_pct": 90,
    "payout_cycle_days": 7,
    "min_trading_days": 0,
    "consistency_pct": null
  },
  "quantity": 3,
  "reason": "QA load test"
}
```
Identify the recipient by `user_id` **or** `email`. Supply `plan_key` **or** `custom`. `quantity` 1–20. Omitted `rules` fall back to the standard rule-set for that account type, so a gifted account behaves exactly like a purchased one.

**200**
```json
{
  "ok": true,
  "data": {
    "granted": 3,
    "recipient": { "id": "uuid", "email": "trader@sogdia.io" },
    "accounts": [ { "...Account", "is_gifted": true } ]
  }
}
```
Side effects: a zero-amount `adjustment` transaction per account (ledger completeness), an `account.gift` audit row, and an `account_gifted` notification to the recipient.

### `POST /api/xdepartment/accounts/{id}/adjust` 🛂
Account surgery. Every field is optional; combine freely.

**Body**
```json
{
  "set_balance": 12000,
  "balance_delta": -500,
  "set_status": "active",
  "set_size": 50000,
  "reset_daily_start": true,
  "reset_drawdown": true,
  "close_positions": true,
  "clear_breach": true,
  "rules": { "max_leverage": 50, "payout_split_pct": 85 },
  "reason": "Compensating for a feed outage"
}
```
| Field | Effect |
|---|---|
| `set_balance` / `balance_delta` | sets or shifts realised balance (equity follows) |
| `set_status` | force any status, including reviving a `failed` account |
| `set_size` | re-base the account, which re-bases the max-DD floor |
| `reset_daily_start` | move the daily DD floor to the current balance |
| `reset_drawdown` | reset daily floor, clear the breach, set status `active` |
| `close_positions` | flatten open positions at market first |
| `rules` | overwrite any rule column on this account |

**200** `{ "ok": true, "data": { "account": { "...Account" }, "closed_orders": 2 } }`

### `DELETE /api/xdepartment/accounts/{id}` 🛂
Hard delete; cascades to the account's orders. Irreversible — prefer `close` for real traders.
**200** `{ "ok": true, "data": { "deleted": true, "account_id": "uuid" } }`

### `POST /api/xdepartment/users/{id}/role` 🛂
**Body** `{ "role": "admin", "reason": "Ops onboarding" }` — `trader | admin | xdepartment`. Self-demotion is refused.
**200** `{ "ok": true, "data": { "user": { "id": "uuid", "email": "...", "role": "admin" } } }`

### `POST /api/xdepartment/users/{id}/kyc` 🛂
Force any KYC state, bypassing the review flow.
**Body** `{ "kyc_status": "verified", "note": "Verified out of band" }`
**200** `{ "ok": true, "data": { "user": { "id": "uuid", "email": "...", "kyc_status": "verified" } } }`

### `POST /api/xdepartment/payouts/{id}/force` 🛂
Set a payout to any state regardless of workflow, including re-opening a settled one.
**Body** `{ "status": "paid", "tx_hash": "0xabc...", "note": "Manual TRC20 send", "skip_balance_debit": false }`
`skip_balance_debit: true` leaves the trading balance untouched (for correcting a mistaken settlement).
**200** `{ "ok": true, "data": { "transaction": { ... }, "balance_debited": true } }`

### `POST /api/xdepartment/impersonate/{userId}` 🛂
Mints a one-time magic-link token for support. Exchange `token_hash` on the frontend via `supabase.auth.verifyOtp({ type: 'magiclink', token_hash })`.
**200**
```json
{
  "ok": true,
  "data": {
    "user": { "id": "uuid", "email": "...", "role": "trader" },
    "token_hash": "...",
    "action_link": "https://<project>.supabase.co/auth/v1/verify?...",
    "expires_in": 3600
  }
}
```

### `GET /api/xdepartment/audit` 🛂
**Query** `?actor_id=&action=&target_id=&limit=50&offset=0`
**200**
```json
{
  "ok": true,
  "data": {
    "logs": [
      { "id": "uuid", "actor_id": "uuid", "actor_email": "x@sogdia.io", "actor_role": "xdepartment",
        "action": "account.gift", "target_type": "account", "target_id": "uuid",
        "payload": { "size": 250000, "reason": "QA load test" },
        "ip": "203.0.113.4", "created_at": "..." }
    ],
    "total": 1920, "limit": 50, "offset": 0
  }
}
```
Actions: `account.gift|adjust|rules_override|freeze|unfreeze|breach|close|delete`, `kyc.approve|reject|force`, `payout.approve|reject|paid|force`, `certificate.manual`, `user.role_change|impersonate`.

---

## 15. Platform settings — the single editable blob 🛂

Referral commission, discounts and all promo codes live in **one text document** that X-Department edits in a textarea. There is one row (`platform_settings.id = 'global'`), the raw text is stored exactly as typed, and the parsed form is what the backend reads.

**Prices are not in here.** `src/config/pricing.ts` is the only source of plan prices, and each account snapshots its plan at creation. Settings can discount a sale; they cannot change a price or a live account's rules.

### Format

The parser accepts **either** the line format below **or** raw JSON (anything starting with `{`). Lines beginning with `#` or `//` are comments. Everything is optional — omitted keys fall back to the shipped defaults.

```
referral_commission_pct = 10     # % of a referred purchase paid to the referrer
referral_discount_pct   = 5      # % off for a buyer who used a referral code
default_discount_pct    = 0      # site-wide discount on every checkout (0 = off)
min_invoice_usd         = 1      # invoice floor after discounts

promo = WELCOME10 | 10% | plans:all | expires:never | max_uses:0 | active
promo = SUMMER25  | 25% | plans:all | expires:2026-12-31 | max_uses:500 | active
promo = VIP100    | $100 | plans:one_step_100k,instant_100k | expires:never | max_uses:0 | inactive | note:Affiliate VIPs
```

**Promo tokens** (pipe-separated, order-independent after the code):

| Token | Meaning |
|---|---|
| `25%` or `percent:25` | percentage off (max 90) |
| `$50` or `fixed:50` | flat USD off (never below the invoice floor) |
| `plans:all` / `plans:a,b` | eligible plan keys |
| `expires:YYYY-MM-DD` / `expires:never` | end-of-day UTC on that date |
| `max_uses:N` | `0` = unlimited; counted from confirmed purchases |
| `active` / `inactive` | on/off without deleting the line |
| `note:text` | label shown on the pricing page |

**Bounds:** `referral_commission_pct` 0–100; `referral_discount_pct`, `default_discount_pct` and percent promos 0–90; `min_invoice_usd` 0–1000. Codes are 3–24 chars, `A–Z 0–9 _ -`.

### `GET /api/xdepartment/settings` 🛂
**200**
```json
{
  "ok": true,
  "data": {
    "raw": "referral_commission_pct = 10\n...",
    "parsed": {
      "referral_commission_pct": 10,
      "referral_discount_pct": 5,
      "default_discount_pct": 0,
      "min_invoice_usd": 1,
      "promos": [
        { "code": "WELCOME10", "kind": "percent", "value": 10, "plans": "all",
          "expires_at": null, "max_uses": 0, "active": true }
      ]
    },
    "version": 4,
    "updated_at": "2026-10-21T15:40:00.000Z",
    "updated_by": "uuid",
    "default_raw": "# SOGDIA platform settings\n...",
    "default_parsed": { "...the shipped defaults, for a reset button" }
  }
}
```
Put `raw` straight into the textarea; use `default_raw` for "reset to defaults".

### `PUT /api/xdepartment/settings` 🛂
**Body**
```json
{ "raw": "<the entire textarea>", "validate_only": false, "reason": "Black Friday promo" }
```

**200 (saved)**
```json
{
  "ok": true,
  "data": {
    "valid": true,
    "raw": "...",
    "parsed": { "...": "..." },
    "version": 5,
    "updated_at": "...",
    "warnings": [
      { "line": null, "message": "Promo SUMMER25 has already expired." }
    ],
    "normalized_raw": "# SOGDIA platform settings\n..."
  }
}
```

**400 (nothing saved)**
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "3 problems in the settings document.",
    "details": [
      { "line": 4, "message": "referral_commission_pct must be between 0 and 100 (got 150)." },
      { "line": 9, "message": "Promo SUMMER25: expires must be YYYY-MM-DD or \"never\", got \"soon\"." },
      { "line": 11, "message": "Unknown setting \"discount\". Allowed: referral_commission_pct, referral_discount_pct, default_discount_pct, min_invoice_usd, promo." }
    ]
  }
}
```
`details[]` is built for inline editor errors — render each `message` against its `line`. `warnings[]` never blocks a save (expired promos, unknown plan keys). `validate_only: true` runs the same parse and returns `normalized_raw` without writing. Every save writes a `settings.update` audit row with the full before/after.

**Propagation:** settings are cached for 15 s per server instance, so a save takes effect within 15 s across the fleet (immediately on the instance that saved).

### Promo CRUD

Promos can be managed one at a time instead of editing the whole document. These endpoints edit **the same settings document** — one line each — so the textarea stays the single source of truth. Comments, ordering and indentation in the file are preserved; only the affected line changes. (If the document is in JSON form it is normalised to the line format, since JSON carries no comments.)

#### `GET /api/xdepartment/promos` 🛂
**200**
```json
{
  "ok": true,
  "data": {
    "promos": [
      { "code": "WELCOME10", "kind": "percent", "value": 10, "plans": "all",
        "expires_at": null, "max_uses": 0, "active": true, "note": null,
        "uses": 142, "remaining": null, "status": "active" }
    ],
    "count": 1,
    "settings_version": 5
  }
}
```
`status` ∈ `active | inactive | expired | exhausted` — the effective state, not just the `active` flag. `remaining` is `null` when `max_uses` is unlimited. `uses` counts confirmed (`paid`) purchases.

#### `POST /api/xdepartment/promos` 🛂
**Body**
```json
{
  "code": "BLACKFRIDAY",
  "kind": "percent",
  "value": 30,
  "plans": "all",
  "expires_at": "2026-11-30",
  "max_uses": 1000,
  "active": true,
  "note": "BF 2026",
  "reason": "Seasonal campaign"
}
```
Only `code`, `kind` and `value` are required. Defaults: `plans: "all"`, `expires_at: null`, `max_uses: 0`, `active: true`. `kind` is `percent` (max 90) or `fixed` (USD off). `plans` is `"all"` or an array of plan keys — unknown keys are rejected.

**200** `{ "ok": true, "data": { "promo": { ...with uses/remaining/status }, "settings_version": 6, "raw": "<the updated document>" } }`
**Errors** `DUPLICATE` (code exists), `VALIDATION_ERROR`.

#### `GET /api/xdepartment/promos/{code}` 🛂
**200** `{ "ok": true, "data": { "promo": { ...with uses/remaining/status } } }`

#### `PATCH /api/xdepartment/promos/{code}` 🛂
Change any field; send only what changes. The code itself is immutable — redemptions already reference it, so delete and recreate if you need a different code.

**Body** `{ "active": false }` · `{ "value": 20, "expires_at": "2026-12-31" }` · `{ "max_uses": 0, "note": null }`
**200** `{ "ok": true, "data": { "promo": { ... }, "settings_version": 7 } }`
**Errors** `NOT_FOUND`, `VALIDATION_ERROR`.

#### `DELETE /api/xdepartment/promos/{code}` 🛂
Removes the line. The code stops working immediately. Past redemptions keep their recorded `promo_code` on the transaction, so revenue history stays intact — but the promo's terms are gone. To pause instead, `PATCH` with `active: false`.

**200**
```json
{
  "ok": true,
  "data": { "deleted": true, "code": "BLACKFRIDAY", "redemptions": 318,
            "settings_version": 8, "remaining_promos": 2 }
}
```
**Errors** `NOT_FOUND`.

Every one of these writes a `promo.create` / `promo.update` / `promo.delete` audit row with the before/after, and bumps `settings_version`.

---

## 16. Optional add-on rules (off by default)

Two columns exist on `accounts` and are only enforced when set — gifted or overridden accounts can switch them on without affecting anyone else. Standard purchased plans leave them disabled, so the 14-day / 80-20 policy is unchanged.

| Column | Default | Effect when set |
|---|---|---|
| `min_trading_days` | `0` | payout blocked until N distinct trading days (`MIN_TRADING_DAYS`) |
| `consistency_pct` | `null` | payout blocked if one day's profit exceeds N % of total profit (`CONSISTENCY_RULE`) |

Both surface as extra `reasons[]` entries on `GET /api/payouts/eligibility`, which also returns `trading_days` and `min_trading_days`.

---

## 17. Endpoint index

| # | Method | Path | Auth |
|---|---|---|---|
| 1 | POST | `/api/auth/register` | 🔓 |
| 2 | POST | `/api/auth/login` | 🔓 |
| 3 | POST | `/api/auth/refresh` | 🔓 |
| 4 | GET | `/api/me` | 🔒 |
| 5 | PATCH | `/api/me` | 🔒 |
| 6 | GET | `/api/pricing` | 🔓 |
| 7 | GET | `/api/market/symbols` | 🔓 |
| 8 | GET | `/api/market/prices` | 🔓 |
| 9 | GET | `/api/accounts` | 🔒 |
| 10 | GET | `/api/accounts/{id}` | 🔒 |
| 11 | POST | `/api/trade/open` | 🔒 |
| 12 | POST | `/api/trade/close` | 🔒 |
| 13 | GET | `/api/trade/positions` | 🔒 |
| 14 | GET | `/api/trade/history` | 🔒 |
| 15 | POST | `/api/risk/evaluate` | 🔒 |
| 16 | POST | `/api/cron/daily-reset` | ⚙️ |
| 17 | POST | `/api/checkout` | 🔒 |
| 18 | POST | `/api/webhook/nowpayments` | ⚙️ |
| 19 | GET | `/api/kyc/status` | 🔒 |
| 20 | POST | `/api/kyc/upload` | 🔒 |
| 21 | GET | `/api/payouts` | 🔒 |
| 22 | GET | `/api/payouts/eligibility` | 🔒 |
| 23 | POST | `/api/payouts` | 🔒 |
| 24 | GET | `/api/certificates` | 🔒 |
| 25 | GET | `/api/og/trade/{id}` | 🔓 |
| 26 | GET | `/api/og/certificate/{id}` | 🔓 |
| 27 | GET | `/api/admin/users` | 🛡️ |
| 28 | GET | `/api/admin/accounts` | 🛡️ |
| 29 | POST | `/api/admin/accounts/{id}/status` | 🛡️ |
| 30 | POST | `/api/admin/kyc/{userId}` | 🛡️ |
| 31 | POST | `/api/admin/payouts/{id}` | 🛡️ |
| 32 | POST | `/api/admin/certificates` | 🛡️ |
| 33 | GET | `/api/admin/stats` | 🛡️ |
| 34 | GET | `/api/admin/certificates` | 🛡️ |
| 35 | POST | `/api/trade/protection` | 🔒 |
| 36 | POST | `/api/trade/partial-close` | 🔒 |
| 37 | GET | `/api/accounts/{id}/equity-curve` | 🔒 |
| 38 | GET | `/api/leaderboard` | 🔓 |
| 39 | GET | `/api/referrals` | 🔒 |
| 40 | GET | `/api/notifications` | 🔒 |
| 41 | POST | `/api/notifications` | 🔒 |
| 42 | GET | `/api/health` | 🔓 |
| 43 | POST | `/api/xdepartment/accounts/gift` | 🛂 |
| 44 | POST | `/api/xdepartment/accounts/{id}/adjust` | 🛂 |
| 45 | DELETE | `/api/xdepartment/accounts/{id}` | 🛂 |
| 46 | POST | `/api/xdepartment/users/{id}/role` | 🛂 |
| 47 | POST | `/api/xdepartment/users/{id}/kyc` | 🛂 |
| 48 | POST | `/api/xdepartment/payouts/{id}/force` | 🛂 |
| 49 | POST | `/api/xdepartment/impersonate/{userId}` | 🛂 |
| 50 | GET | `/api/xdepartment/audit` | 🛂 |
| 51 | GET | `/api/promos/validate` | 🔒 |
| 52 | GET | `/api/xdepartment/settings` | 🛂 |
| 53 | PUT | `/api/xdepartment/settings` | 🛂 |
| 54 | GET | `/api/xdepartment/promos` | 🛂 |
| 55 | POST | `/api/xdepartment/promos` | 🛂 |
| 56 | GET | `/api/xdepartment/promos/{code}` | 🛂 |
| 57 | PATCH | `/api/xdepartment/promos/{code}` | 🛂 |
| 58 | DELETE | `/api/xdepartment/promos/{code}` | 🛂 |
````

# Database (run in this order)

## `supabase/schema.sql`

```sql
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
```

## `supabase/002_xdepartment_and_upgrades.sql`

```sql
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
```

## `supabase/003_platform_settings.sql`

```sql
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
```

# Project config

## `package.json`

```json
{
  "name": "sogdia-backend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "lint": "next lint"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.4",
    "@vercel/og": "^0.6.3",
    "next": "14.2.15",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.10",
    "@types/react": "^18.3.3",
    "typescript": "^5.5.4"
  }
}
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

## `next.config.js`

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Backend-only project: no frontend pages are shipped.
  experimental: {
    serverComponentsExternalPackages: ['@supabase/supabase-js'],
  },
};

module.exports = nextConfig;
```

## `.env.example`

```
# ---- Supabase ----
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
# Server-only. Bypasses RLS — never expose to the browser.
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# ---- NOWPayments ----
NOWPAYMENTS_API_KEY=XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX
NOWPAYMENTS_IPN_SECRET=your_ipn_secret
NOWPAYMENTS_API_URL=https://api.nowpayments.io/v1
# Sandbox: https://api-sandbox.nowpayments.io/v1

# ---- App ----
NEXT_PUBLIC_APP_URL=https://sogdia.io
# Shared secret for /api/cron/* (sent as x-cron-secret)
CRON_SECRET=generate_a_long_random_string

# ---- Market data ----
BINANCE_API_URL=https://api.binance.com
```

# src/config

## `src/config/pricing.ts`

```typescript
/**
 * SOGDIA pricing & rule-set.
 * Single source of truth — every account snapshots these values at creation,
 * so editing this file never retro-changes live accounts.
 */

export type AccountType = 'one_step' | 'instant';

export interface Plan {
  key: string;
  type: AccountType;
  label: string;
  /** Virtual capital granted to the trader. */
  size: number;
  /** What the trader pays, in USD. */
  price: number;
  /** % profit needed to pass. null = no evaluation (instant funding). */
  profit_target_pct: number | null;
  daily_dd_pct: number;
  max_dd_pct: number;
  max_leverage: number;
  payout_split_pct: number;
  payout_cycle_days: number;
}

/** Global constants. */
export const PAYOUT_SPLIT_PCT = 80;      // trader keeps 80, firm keeps 20
export const PAYOUT_CYCLE_DAYS = 14;
export const MAX_LEVERAGE = 200;
export const MIN_LEVERAGE = 1;
/** 0.05% total spread, applied against the trader on entry and exit. */
export const SPREAD_BPS = 5;

/** Drawdown rule-sets per account type. */
export const RULES: Record<AccountType, {
  profit_target_pct: number | null;
  daily_dd_pct: number;
  max_dd_pct: number;
}> = {
  one_step: { profit_target_pct: 10, daily_dd_pct: 4, max_dd_pct: 6 },
  instant:  { profit_target_pct: null, daily_dd_pct: 3, max_dd_pct: 5 },
};

const ONE_STEP_PRICING: Array<[size: number, price: number]> = [
  [5_000, 39],
  [10_000, 69],
  [25_000, 149],
  [50_000, 249],
  [100_000, 399],
];

const INSTANT_PRICING: Array<[size: number, price: number]> = [
  [5_000, 63],
  [10_000, 91],
  [25_000, 183],
  [50_000, 275],
  [100_000, 459],
];

function sizeLabel(size: number): string {
  return `$${size / 1000}K`;
}

function buildPlans(type: AccountType, rows: Array<[number, number]>): Plan[] {
  const rules = RULES[type];
  const prefix = type === 'one_step' ? 'one_step' : 'instant';
  const name = type === 'one_step' ? 'One-Step' : 'Instant Funding';

  return rows.map(([size, price]) => ({
    key: `${prefix}_${size / 1000}k`,
    type,
    label: `${name} ${sizeLabel(size)}`,
    size,
    price,
    profit_target_pct: rules.profit_target_pct,
    daily_dd_pct: rules.daily_dd_pct,
    max_dd_pct: rules.max_dd_pct,
    max_leverage: MAX_LEVERAGE,
    payout_split_pct: PAYOUT_SPLIT_PCT,
    payout_cycle_days: PAYOUT_CYCLE_DAYS,
  }));
}

export const PLANS: Plan[] = [
  ...buildPlans('one_step', ONE_STEP_PRICING),
  ...buildPlans('instant', INSTANT_PRICING),
];

export const PLANS_BY_KEY: Record<string, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.key, p]),
);

export function getPlan(key: string): Plan | null {
  return PLANS_BY_KEY[key] ?? null;
}

export const PLAN_KEYS = PLANS.map((p) => p.key);
```

## `src/config/settings.ts`

```typescript
/**
 * Platform settings — the one blob X-Department edits.
 *
 * These are the shipped defaults. The live values come from the
 * `platform_settings` row; this file is only the fallback used to seed
 * it and to reset it. Prices themselves are NOT here and are not
 * editable at runtime — see pricing.ts.
 */

export type PromoKind = 'percent' | 'fixed';

export interface Promo {
  code: string;
  kind: PromoKind;
  /** percent: 0–100. fixed: USD off. */
  value: number;
  /** 'all' or a list of plan keys from pricing.ts */
  plans: 'all' | string[];
  /** ISO date (YYYY-MM-DD) or null for no expiry */
  expires_at: string | null;
  /** 0 = unlimited */
  max_uses: number;
  active: boolean;
  note?: string;
}

export interface PlatformSettings {
  /** % of a referred purchase paid to the referrer. */
  referral_commission_pct: number;
  /** % off for a buyer who signed up with a referral code. */
  referral_discount_pct: number;
  /** Site-wide discount applied to every checkout. 0 = off. */
  default_discount_pct: number;
  /** Floor for an invoice after discounts (payment providers reject $0). */
  min_invoice_usd: number;
  promos: Promo[];
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  referral_commission_pct: 10,
  referral_discount_pct: 5,
  default_discount_pct: 0,
  min_invoice_usd: 1,
  promos: [
    {
      code: 'WELCOME10',
      kind: 'percent',
      value: 10,
      plans: 'all',
      expires_at: null,
      max_uses: 0,
      active: true,
    },
  ],
};

/** What the textarea is pre-filled with on a fresh install. */
export const DEFAULT_SETTINGS_RAW = `# SOGDIA platform settings
# Edited by X-Department. Prices live in src/config/pricing.ts and are NOT editable here.
#
# Numbers
#   referral_commission_pct  % of a referred purchase paid to the referrer
#   referral_discount_pct    % off for a buyer who used a referral code
#   default_discount_pct     site-wide discount on every checkout (0 = off)
#   min_invoice_usd          invoice floor after discounts
#
# Promos
#   promo = CODE | 25% | plans:all | expires:2026-12-31 | max_uses:500 | active
#   promo = CODE | $50 | plans:one_step_100k,instant_100k | expires:never | max_uses:0 | inactive
#   value   -> "25%" for percent off, "$50" for a flat USD discount
#   plans   -> "all" or a comma-separated list of plan keys
#   expires -> YYYY-MM-DD or "never"
#   max_uses-> 0 means unlimited
#
# Only the single best discount applies — promo, referral and site-wide never stack.

referral_commission_pct = 10
referral_discount_pct   = 5
default_discount_pct    = 0
min_invoice_usd         = 1

promo = WELCOME10 | 10% | plans:all | expires:never | max_uses:0 | active
`;

export const SETTINGS_NUMERIC_KEYS = [
  'referral_commission_pct',
  'referral_discount_pct',
  'default_discount_pct',
  'min_invoice_usd',
] as const;

export type SettingsNumericKey = (typeof SETTINGS_NUMERIC_KEYS)[number];

/** Hard bounds. A value outside these is rejected with a clear message. */
export const SETTINGS_BOUNDS: Record<SettingsNumericKey, { min: number; max: number }> = {
  referral_commission_pct: { min: 0, max: 100 },
  referral_discount_pct: { min: 0, max: 90 },
  default_discount_pct: { min: 0, max: 90 },
  min_invoice_usd: { min: 0, max: 1000 },
};
```

## `src/config/symbols.ts`

```typescript
/**
 * Tradable universe: top 50 Binance USDT spot pairs by volume.
 * Only these symbols may be opened. Keep the list in sync manually or
 * refresh it from /api/v3/ticker/24hr ranked by quoteVolume.
 */

export const TOP_50_USDT_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'TRXUSDT', 'LINKUSDT',
  'TONUSDT', 'DOTUSDT', 'MATICUSDT', 'SHIBUSDT', 'LTCUSDT',
  'BCHUSDT', 'NEARUSDT', 'UNIUSDT', 'APTUSDT', 'ICPUSDT',
  'ETCUSDT', 'FILUSDT', 'ATOMUSDT', 'XLMUSDT', 'INJUSDT',
  'OPUSDT', 'ARBUSDT', 'SUIUSDT', 'HBARUSDT', 'VETUSDT',
  'IMXUSDT', 'RNDRUSDT', 'TIAUSDT', 'GRTUSDT', 'AAVEUSDT',
  'ALGOUSDT', 'SEIUSDT', 'FTMUSDT', 'SANDUSDT', 'MANAUSDT',
  'AXSUSDT', 'THETAUSDT', 'EOSUSDT', 'FLOWUSDT', 'EGLDUSDT',
  'CHZUSDT', 'GALAUSDT', 'PEPEUSDT', 'WIFUSDT', 'ORDIUSDT',
] as const;

export type TradableSymbol = (typeof TOP_50_USDT_PAIRS)[number];

const SYMBOL_SET = new Set<string>(TOP_50_USDT_PAIRS);

export function isTradableSymbol(symbol: string): symbol is TradableSymbol {
  return SYMBOL_SET.has(symbol.toUpperCase());
}

export function listSymbols() {
  return TOP_50_USDT_PAIRS.map((symbol) => ({
    symbol,
    base: symbol.replace(/USDT$/, ''),
    quote: 'USDT',
  }));
}
```

# src/lib

## `src/lib/accounts.ts`

```typescript
import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import {
  getPlan,
  MAX_LEVERAGE,
  PAYOUT_CYCLE_DAYS,
  PAYOUT_SPLIT_PCT,
  RULES,
  type Plan,
} from '@/config/pricing';
import type { DbAccount } from '@/lib/types';

/**
 * Creates a funded/evaluation account from a plan snapshot.
 * Called only by the NOWPayments webhook once a payment is confirmed
 * (and by admin tooling).
 */
export async function createAccountFromPlan(
  userId: string,
  plan: Plan,
): Promise<DbAccount> {
  const now = new Date();
  const nextPayout = new Date(now.getTime() + plan.payout_cycle_days * 86_400_000);

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .insert({
      user_id: userId,
      type: plan.type,
      size: plan.size,
      balance: plan.size,
      equity: plan.size,
      daily_start_balance: plan.size,
      status: 'active',
      max_leverage: plan.max_leverage,
      profit_target_pct: plan.profit_target_pct,
      daily_dd_pct: plan.daily_dd_pct,
      max_dd_pct: plan.max_dd_pct,
      payout_split_pct: plan.payout_split_pct,
      payout_cycle_days: plan.payout_cycle_days,
      plan_key: plan.key,
      next_payout_at: nextPayout.toISOString(),
    })
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return data;
}

export interface ProvisionOptions {
  type: 'one_step' | 'instant';
  size: number;
  plan_key?: string | null;
  is_gifted?: boolean;
  rules?: Partial<{
    profit_target_pct: number | null;
    daily_dd_pct: number;
    max_dd_pct: number;
    max_leverage: number;
    payout_split_pct: number;
    payout_cycle_days: number;
    min_trading_days: number;
    consistency_pct: number | null;
  }>;
}

/**
 * X-Department provisioning: any type, any size, any rule-set.
 * Falls back to the standard rules for the chosen type when no override
 * is supplied, so a gifted account behaves exactly like a bought one.
 */
export async function provisionAccount(
  userId: string,
  options: ProvisionOptions,
): Promise<DbAccount> {
  const defaults = RULES[options.type];
  const rules = options.rules ?? {};
  const cycleDays = rules.payout_cycle_days ?? PAYOUT_CYCLE_DAYS;
  const nextPayout = new Date(Date.now() + cycleDays * 86_400_000);

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .insert({
      user_id: userId,
      type: options.type,
      size: options.size,
      balance: options.size,
      equity: options.size,
      daily_start_balance: options.size,
      status: 'active',
      max_leverage: rules.max_leverage ?? MAX_LEVERAGE,
      profit_target_pct:
        rules.profit_target_pct !== undefined
          ? rules.profit_target_pct
          : defaults.profit_target_pct,
      daily_dd_pct: rules.daily_dd_pct ?? defaults.daily_dd_pct,
      max_dd_pct: rules.max_dd_pct ?? defaults.max_dd_pct,
      payout_split_pct: rules.payout_split_pct ?? PAYOUT_SPLIT_PCT,
      payout_cycle_days: cycleDays,
      min_trading_days: rules.min_trading_days ?? 0,
      consistency_pct: rules.consistency_pct ?? null,
      plan_key: options.plan_key ?? null,
      is_gifted: options.is_gifted ?? false,
      next_payout_at: nextPayout.toISOString(),
    })
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return data;
}

export function planForAccount(account: DbAccount): Plan | null {
  return account.plan_key ? getPlan(account.plan_key) : null;
}

/** Numeric columns come back as strings from PostgREST on some setups. */
export function serializeAccount(a: DbAccount) {
  return {
    ...a,
    size: Number(a.size),
    balance: Number(a.balance),
    equity: Number(a.equity),
    daily_start_balance: Number(a.daily_start_balance),
    profit_target_pct: a.profit_target_pct === null ? null : Number(a.profit_target_pct),
    daily_dd_pct: Number(a.daily_dd_pct),
    max_dd_pct: Number(a.max_dd_pct),
    payout_split_pct: Number(a.payout_split_pct),
  };
}
```

## `src/lib/audit.ts`

```typescript
import { supabaseAdmin } from '@/lib/supabase';
import { clientIp } from '@/lib/ratelimit';
import type { DbUser } from '@/lib/types';

export type AuditAction =
  | 'account.freeze'
  | 'account.unfreeze'
  | 'account.breach'
  | 'account.close'
  | 'account.gift'
  | 'account.adjust'
  | 'account.delete'
  | 'account.rules_override'
  | 'kyc.approve'
  | 'kyc.reject'
  | 'kyc.force'
  | 'payout.approve'
  | 'payout.reject'
  | 'payout.paid'
  | 'payout.force'
  | 'certificate.manual'
  | 'certificate.delete'
  | 'user.role_change'
  | 'user.impersonate'
  | 'settings.update'
  | 'promo.create'
  | 'promo.update'
  | 'promo.delete';

/**
 * Every privileged mutation is written here. Append-only by policy —
 * nothing in the API ever updates or deletes an audit row.
 */
export async function audit(
  actor: DbUser,
  action: AuditAction,
  target: {
    type: 'user' | 'account' | 'transaction' | 'certificate' | 'order' | 'settings' | 'promo';
    id: string;
  },
  payload: Record<string, unknown> = {},
  req?: Request,
): Promise<void> {
  // target_id is a uuid column; settings and promos are keyed by name,
  // which travels in the payload instead.
  const keyedByName = target.type === 'settings' || target.type === 'promo';
  const targetId = keyedByName ? null : target.id;
  const body = keyedByName ? { ...payload, target_key: target.id } : payload;

  const { error } = await supabaseAdmin().from('audit_logs').insert({
    actor_id: actor.id,
    actor_role: actor.role,
    action,
    target_type: target.type,
    target_id: targetId,
    payload: body,
    ip: req ? clientIp(req) : null,
  });

  if (error) console.error('[audit] insert failed', error.message);
}
```

## `src/lib/auth.ts`

```typescript
import { ApiError, requireEnv } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import type { DbAccount, DbUser } from '@/lib/types';

function bearer(req: Request): string {
  const header = req.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new ApiError('UNAUTHORIZED', 'Missing bearer token.');
  }
  return token;
}

/** Resolve the caller from their Supabase JWT. */
export async function requireUser(req: Request): Promise<DbUser> {
  const token = bearer(req);
  const admin = supabaseAdmin();

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData?.user) {
    throw new ApiError('UNAUTHORIZED', 'Invalid or expired session.');
  }

  const { data: profile, error } = await admin
    .from('users')
    .select('*')
    .eq('id', authData.user.id)
    .single<DbUser>();

  if (error || !profile) {
    throw new ApiError('UNAUTHORIZED', 'User profile not found.');
  }
  return profile;
}

/** admin or xdepartment. See lib/permissions.ts for the full ladder. */
export async function requireAdmin(req: Request): Promise<DbUser> {
  const user = await requireUser(req);
  if (user.role !== 'admin' && user.role !== 'xdepartment') {
    throw new ApiError('FORBIDDEN', 'Admin privileges required.');
  }
  return user;
}

/** Load an account and assert the caller owns it (admins bypass). */
export async function requireAccount(
  accountId: string,
  user: DbUser,
): Promise<DbAccount> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .maybeSingle<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'Account not found.');
  if (data.user_id !== user.id && user.role === 'trader') {
    throw new ApiError('FORBIDDEN', 'This account belongs to another user.');
  }
  return data;
}

/** Guard machine-to-machine cron routes. */
export function requireCronSecret(req: Request): void {
  const provided = req.headers.get('x-cron-secret');
  const expected = requireEnv('CRON_SECRET');
  if (!provided || provided !== expected) {
    throw new ApiError('UNAUTHORIZED', 'Invalid cron secret.');
  }
}
```

## `src/lib/binance.ts`

```typescript
import { ApiError } from '@/lib/http';
import { isTradableSymbol, TOP_50_USDT_PAIRS } from '@/config/symbols';

const BASE_URL = process.env.BINANCE_API_URL ?? 'https://api.binance.com';

/** Tiny in-process cache so a burst of position polls hits Binance once. */
const TTL_MS = 1_500;
const cache = new Map<string, { price: number; at: number }>();

function readCache(symbol: string): number | null {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;
  return null;
}

function writeCache(symbol: string, price: number): void {
  cache.set(symbol, { price, at: Date.now() });
}

export function assertTradable(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (!isTradableSymbol(upper)) {
    throw new ApiError(
      'SYMBOL_NOT_ALLOWED',
      `${upper} is not in the SOGDIA top-50 USDT universe.`,
    );
  }
  return upper;
}

async function binanceFetch(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      // Binance is fast; fail loudly rather than hanging a trade request.
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    throw new ApiError('UPSTREAM_ERROR', 'Could not reach the price feed.');
  }
  if (!res.ok) {
    throw new ApiError('UPSTREAM_ERROR', `Price feed responded ${res.status}.`);
  }
  return res.json();
}

/** Live mid price for one whitelisted symbol. */
export async function getPrice(symbol: string): Promise<number> {
  const sym = assertTradable(symbol);

  const cached = readCache(sym);
  if (cached !== null) return cached;

  const json = (await binanceFetch(`/api/v3/ticker/price?symbol=${sym}`)) as {
    symbol?: string;
    price?: string;
  };

  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ApiError('UPSTREAM_ERROR', `No price available for ${sym}.`);
  }

  writeCache(sym, price);
  return price;
}

/** Live mid prices for many symbols in a single upstream call. */
export async function getPrices(
  symbols: string[] = [...TOP_50_USDT_PAIRS],
): Promise<Record<string, number>> {
  const wanted = Array.from(new Set(symbols.map(assertTradable)));
  const out: Record<string, number> = {};
  const missing: string[] = [];

  for (const sym of wanted) {
    const cached = readCache(sym);
    if (cached !== null) out[sym] = cached;
    else missing.push(sym);
  }
  if (missing.length === 0) return out;

  const query = encodeURIComponent(JSON.stringify(missing));
  const json = (await binanceFetch(`/api/v3/ticker/price?symbols=${query}`)) as Array<{
    symbol: string;
    price: string;
  }>;

  for (const row of json ?? []) {
    const price = Number(row.price);
    if (Number.isFinite(price) && price > 0) {
      out[row.symbol] = price;
      writeCache(row.symbol, price);
    }
  }

  for (const sym of missing) {
    if (out[sym] === undefined) {
      throw new ApiError('UPSTREAM_ERROR', `No price available for ${sym}.`);
    }
  }
  return out;
}

/** 24h stats, handy for a markets table on the frontend. */
export async function get24hStats(symbol: string) {
  const sym = assertTradable(symbol);
  const json = (await binanceFetch(`/api/v3/ticker/24hr?symbol=${sym}`)) as Record<string, string>;
  return {
    symbol: sym,
    price: Number(json.lastPrice),
    change_pct: Number(json.priceChangePercent),
    high: Number(json.highPrice),
    low: Number(json.lowPrice),
    volume: Number(json.quoteVolume),
  };
}
```

## `src/lib/certificates.ts`

```typescript
import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import type { CertificateType, DbCertificate } from '@/lib/types';

export interface IssueCertificateInput {
  user_id: string;
  account_id?: string | null;
  type: CertificateType;
  amount: number;
  display_name?: string | null;
  is_manual?: boolean;
  issued_by?: string | null;
  metadata?: Record<string, unknown>;
}

export async function issueCertificate(input: IssueCertificateInput): Promise<DbCertificate> {
  const admin = supabaseAdmin();

  let displayName = input.display_name ?? null;
  if (!displayName) {
    const { data: user } = await admin
      .from('users')
      .select('full_name, email')
      .eq('id', input.user_id)
      .maybeSingle<{ full_name: string | null; email: string }>();
    displayName = user?.full_name ?? user?.email?.split('@')[0] ?? 'SOGDIA Trader';
  }

  const { data, error } = await admin
    .from('certificates')
    .insert({
      user_id: input.user_id,
      account_id: input.account_id ?? null,
      type: input.type,
      amount: input.amount,
      display_name: displayName,
      is_manual: input.is_manual ?? false,
      issued_by: input.issued_by ?? null,
      metadata: input.metadata ?? {},
    })
    .select('*')
    .single<DbCertificate>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return data;
}

export function certificateImageUrl(id: string): string {
  return `/api/og/certificate/${id}`;
}
```

## `src/lib/engine.ts`

```typescript
import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrices } from '@/lib/binance';
import {
  applySpread,
  isLiquidated,
  money,
  pnlFor,
  toPosition,
} from '@/lib/math';
import { breachMessage, checkBreach, computeMetrics } from '@/lib/risk';
import { issueCertificate } from '@/lib/certificates';
import type {
  AccountMetrics,
  DbAccount,
  DbOrder,
  OrderStatus,
  Position,
  RiskResult,
} from '@/lib/types';

export async function getAccount(accountId: string): Promise<DbAccount> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .maybeSingle<DbAccount>();
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'Account not found.');
  return data;
}

export async function getOpenOrders(accountId: string): Promise<DbOrder[]> {
  const { data, error } = await supabaseAdmin()
    .from('orders')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return (data ?? []) as DbOrder[];
}

/** Attach live Binance marks to a set of open orders. */
export async function buildPositions(orders: DbOrder[]): Promise<Position[]> {
  if (orders.length === 0) return [];
  const symbols = Array.from(new Set(orders.map((o) => o.symbol)));
  const prices = await getPrices(symbols);
  return orders.map((o) => toPosition(o, prices[o.symbol]));
}

/** Atomic settle: writes the order and credits PnL to the account balance. */
export async function settleOrder(
  orderId: string,
  closePrice: number,
  pnl: number,
  status: Exclude<OrderStatus, 'open'>,
  reason: string,
): Promise<DbOrder> {
  const { data, error } = await supabaseAdmin().rpc('close_position', {
    p_order_id: orderId,
    p_close_price: closePrice,
    p_pnl: pnl,
    p_status: status,
    p_reason: reason,
  });

  if (error) {
    if (error.message.includes('ORDER_NOT_OPEN')) {
      throw new ApiError('ORDER_NOT_OPEN', 'This position is already closed.');
    }
    throw new ApiError('INTERNAL_ERROR', error.message);
  }
  return (Array.isArray(data) ? data[0] : data) as DbOrder;
}

export interface AutoClose {
  id: string;
  symbol: string;
  pnl: number;
  close_price: number;
  reason: 'liquidation' | 'stop_loss' | 'take_profit';
}

/**
 * Decide whether an open position must close right now.
 * Liquidation is checked first — a stop-loss sitting beyond the
 * liquidation level can never save the trader.
 */
function resolveAutoClose(
  p: Position,
): { price: number; status: 'closed' | 'liquidated'; reason: AutoClose['reason'] } | null {
  const mark = p.mark_price;
  const long = p.side === 'long';

  if (isLiquidated(p.side, mark, Number(p.liquidation_price))) {
    return { price: Number(p.liquidation_price), status: 'liquidated', reason: 'liquidation' };
  }

  const sl = p.stop_loss === null ? null : Number(p.stop_loss);
  if (sl !== null && (long ? mark <= sl : mark >= sl)) {
    return { price: sl, status: 'closed', reason: 'stop_loss' };
  }

  const tp = p.take_profit === null ? null : Number(p.take_profit);
  if (tp !== null && (long ? mark >= tp : mark <= tp)) {
    return { price: tp, status: 'closed', reason: 'take_profit' };
  }

  return null;
}

/**
 * Auto-close every position that has hit its liquidation price, stop-loss
 * or take-profit. Liquidation settles at the liquidation price, so the
 * trader loses exactly the posted margin.
 */
export async function sweepLiquidations(positions: Position[]): Promise<AutoClose[]> {
  const closed: AutoClose[] = [];

  for (const p of positions) {
    const trigger = resolveAutoClose(p);
    if (!trigger) continue;

    const pnl =
      trigger.reason === 'liquidation'
        ? money(-Number(p.margin))
        : pnlFor(p.side, Number(p.entry_price), trigger.price, Number(p.quantity));

    try {
      await settleOrder(p.id, trigger.price, pnl, trigger.status, trigger.reason);
      closed.push({
        id: p.id,
        symbol: p.symbol,
        pnl,
        close_price: trigger.price,
        reason: trigger.reason,
      });
    } catch (err) {
      // Another concurrent request already settled it — not an error here.
      if (!(err instanceof ApiError && err.code === 'ORDER_NOT_OPEN')) throw err;
    }
  }

  return closed;
}

/** Close every open position at the current market (used on breach / admin kill). */
export async function forceCloseAll(accountId: string, reason: string): Promise<number> {
  const orders = await getOpenOrders(accountId);
  if (orders.length === 0) return 0;

  const symbols = Array.from(new Set(orders.map((o) => o.symbol)));
  const prices = await getPrices(symbols);

  let count = 0;
  for (const order of orders) {
    const exit = applySpread(prices[order.symbol], order.side, 'close');
    const liq = Number(order.liquidation_price);
    const hitLiq = isLiquidated(order.side, prices[order.symbol], liq);
    const closePrice = hitLiq ? liq : exit;
    const pnl = hitLiq
      ? money(-Number(order.margin))
      : pnlFor(order.side, Number(order.entry_price), closePrice, Number(order.quantity));

    try {
      await settleOrder(order.id, closePrice, pnl, hitLiq ? 'liquidated' : 'closed', reason);
      count += 1;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'ORDER_NOT_OPEN')) throw err;
    }
  }
  return count;
}

async function persistEquity(accountId: string, equity: number): Promise<DbAccount> {
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .update({ equity })
    .eq('id', accountId)
    .select('*')
    .single<DbAccount>();
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return data;
}

export interface EvaluationResult {
  account: DbAccount;
  positions: Position[];
  metrics: AccountMetrics;
  risk: RiskResult;
  liquidated: AutoClose[];
}

/**
 * The heart of the risk engine. Runs after every open/close and on demand:
 *   1. liquidate anything past its liquidation price
 *   2. recompute equity from live marks
 *   3. fail the account if a drawdown floor is breached (flattening positions)
 *   4. pass the account if the evaluation target is met
 *   5. persist the equity snapshot
 */
export async function evaluateAccount(input: DbAccount | string): Promise<EvaluationResult> {
  let account = typeof input === 'string' ? await getAccount(input) : input;

  // 1 — liquidation sweep
  let orders = await getOpenOrders(account.id);
  let positions = await buildPositions(orders);
  const liquidated = await sweepLiquidations(positions);

  if (liquidated.length > 0) {
    account = await getAccount(account.id);
    orders = await getOpenOrders(account.id);
    positions = await buildPositions(orders);
  }

  // 2 — equity + rule check
  let metrics = computeMetrics(account, positions);
  const reason = checkBreach(metrics);
  const risk: RiskResult = {
    breached: false,
    reason: null,
    status: account.status,
    closed_orders: liquidated.length,
  };

  const terminal = account.status !== 'active';

  // 3 — drawdown breach
  if (reason && !terminal) {
    const flattened = await forceCloseAll(account.id, 'breach');
    account = await getAccount(account.id);
    positions = [];
    metrics = computeMetrics(account, positions);

    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .update({
        status: 'failed',
        breach_reason: breachMessage(reason, metrics),
        equity: metrics.equity,
      })
      .eq('id', account.id)
      .select('*')
      .single<DbAccount>();
    if (error) throw new ApiError('INTERNAL_ERROR', error.message);

    return {
      account: data,
      positions,
      metrics,
      risk: {
        breached: true,
        reason,
        status: 'failed',
        closed_orders: liquidated.length + flattened,
      },
      liquidated,
    };
  }

  // 4 — evaluation passed (One-Step only; Instant has no target)
  if (!terminal && metrics.target_reached && account.profit_target_pct !== null) {
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .update({ status: 'passed', equity: metrics.equity })
      .eq('id', account.id)
      .select('*')
      .single<DbAccount>();
    if (error) throw new ApiError('INTERNAL_ERROR', error.message);

    await issueCertificate({
      user_id: account.user_id,
      account_id: account.id,
      type: 'eval_pass',
      amount: Number(account.size),
      is_manual: false,
      metadata: { plan_key: account.plan_key, profit_pct: metrics.profit_pct },
    });

    return {
      account: data,
      positions,
      metrics,
      risk: { ...risk, status: 'passed', passed: true },
      liquidated,
    };
  }

  // 5 — persist the equity snapshot
  account = await persistEquity(account.id, metrics.equity);
  return { account, positions, metrics, risk: { ...risk, status: account.status }, liquidated };
}
```

## `src/lib/http.ts`

```typescript
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'ACCOUNT_NOT_TRADABLE'
  | 'ORDER_NOT_OPEN'
  | 'INSUFFICIENT_MARGIN'
  | 'SYMBOL_NOT_ALLOWED'
  | 'KYC_REQUIRED'
  | 'PAYOUT_NOT_ELIGIBLE'
  | 'DUPLICATE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ACCOUNT_NOT_TRADABLE: 409,
  ORDER_NOT_OPEN: 409,
  INSUFFICIENT_MARGIN: 409,
  SYMBOL_NOT_ALLOWED: 409,
  KYC_REQUIRED: 409,
  PAYOUT_NOT_ELIGIBLE: 409,
  DUPLICATE: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
};

/** Throw this anywhere inside a handler wrapped by `handle()`. */
export class ApiError extends Error {
  code: ErrorCode;
  details: unknown;

  constructor(code: ErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, { status: 200, ...init });
}

export function fail(code: ErrorCode, message: string, details: unknown = null) {
  return NextResponse.json(
    { ok: false, error: { code, message, details } },
    { status: STATUS_BY_CODE[code] },
  );
}

/**
 * Wraps a route handler so every throw becomes a well-formed error envelope.
 *
 *   export const POST = handle(async (req) => { ... return ok(data); });
 */
export function handle<Ctx = unknown>(
  fn: (req: Request, ctx: Ctx) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        return fail(err.code, err.message, err.details);
      }
      if (err instanceof ZodError) {
        return fail('VALIDATION_ERROR', 'Request payload is invalid.', err.flatten());
      }
      console.error('[api] unhandled error', err);
      return fail('INTERNAL_ERROR', 'Something went wrong.');
    }
  };
}

/** Parse a JSON body, failing cleanly on malformed input. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Body must be valid JSON.');
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError('INTERNAL_ERROR', `Missing environment variable: ${name}`);
  }
  return value;
}
```

## `src/lib/idempotency.ts`

```typescript
import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * Replays the stored response when the same Idempotency-Key is seen twice.
 * Without the header the handler simply runs normally.
 */
export async function withIdempotency<T>(
  req: Request,
  userId: string,
  route: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = req.headers.get('idempotency-key');
  if (!key) return fn();

  const admin = supabaseAdmin();

  const { data: existing } = await admin
    .from('idempotency_keys')
    .select('response')
    .eq('key', key)
    .eq('user_id', userId)
    .maybeSingle<{ response: T }>();

  if (existing) return existing.response;

  const result = await fn();

  const { error } = await admin
    .from('idempotency_keys')
    .insert({ key, user_id: userId, route, response: result });

  // A concurrent duplicate lost the race — replay the winner's response.
  if (error && error.code === '23505') {
    const { data: winner } = await admin
      .from('idempotency_keys')
      .select('response')
      .eq('key', key)
      .maybeSingle<{ response: T }>();
    if (winner) return winner.response;
    throw new ApiError('DUPLICATE', 'Duplicate request in flight.');
  }

  return result;
}
```

## `src/lib/math.ts`

```typescript
import { SPREAD_BPS } from '@/config/pricing';
import type { DbOrder, OrderSide, Position } from '@/lib/types';

/** Round money to cents. */
export function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round a price to 10 dp (matches numeric(28,10) in Postgres). */
export function price(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e10) / 1e10;
}

export function pct(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Apply the house spread against the trader.
 *   open  long  -> buy at ask  (worse = higher)
 *   open  short -> sell at bid (worse = lower)
 *   close long  -> sell at bid (worse = lower)
 *   close short -> buy at ask  (worse = higher)
 */
export function applySpread(
  mid: number,
  side: OrderSide,
  action: 'open' | 'close',
  bps: number = SPREAD_BPS,
): number {
  const factor = bps / 10_000;
  const payMore = (side === 'long') === (action === 'open');
  return price(payMore ? mid * (1 + factor) : mid * (1 - factor));
}

export function bidAsk(mid: number, bps: number = SPREAD_BPS) {
  const factor = bps / 10_000;
  return { bid: price(mid * (1 - factor)), ask: price(mid * (1 + factor)) };
}

/** Notional exposure in quote currency. */
export function positionSize(margin: number, leverage: number): number {
  return money(margin * leverage);
}

/** Base-currency quantity bought/sold. */
export function quantity(notional: number, entryPrice: number): number {
  return Math.round((notional / entryPrice) * 1e10) / 1e10;
}

/**
 * Liquidation price: the trader is wiped out when the adverse move equals
 * 100 / leverage percent, i.e. when the loss equals the posted margin.
 */
export function liquidationPrice(
  entryPrice: number,
  side: OrderSide,
  leverage: number,
): number {
  const move = 1 / leverage;
  return price(side === 'long' ? entryPrice * (1 - move) : entryPrice * (1 + move));
}

/** Realised or unrealised PnL in quote currency. */
export function pnlFor(
  side: OrderSide,
  entryPrice: number,
  exitPrice: number,
  qty: number,
): number {
  const diff = side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return money(diff * qty);
}

/** PnL as a percentage of posted margin (what the trader actually feels). */
export function pnlPct(pnl: number, margin: number): number {
  if (margin <= 0) return 0;
  return pct((pnl / margin) * 100);
}

/** Has the mark crossed the liquidation level? */
export function isLiquidated(
  side: OrderSide,
  markPrice: number,
  liqPrice: number,
): boolean {
  return side === 'long' ? markPrice <= liqPrice : markPrice >= liqPrice;
}

/**
 * Decorate an open order with live marks.
 * The exit spread is applied so unrealised PnL matches what a close
 * would actually realise right now.
 */
export function toPosition(order: DbOrder, midPrice: number): Position {
  const exit = applySpread(midPrice, order.side, 'close');
  const liq = isLiquidated(order.side, midPrice, Number(order.liquidation_price));
  const effectiveExit = liq ? Number(order.liquidation_price) : exit;
  const unrealized = liq
    ? money(-Number(order.margin))
    : pnlFor(order.side, Number(order.entry_price), effectiveExit, Number(order.quantity));

  return {
    ...order,
    margin: Number(order.margin),
    position_size: Number(order.position_size),
    quantity: Number(order.quantity),
    entry_price: Number(order.entry_price),
    liquidation_price: Number(order.liquidation_price),
    mark_price: price(midPrice),
    unrealized_pnl: unrealized,
    unrealized_pnl_pct: pnlPct(unrealized, Number(order.margin)),
  };
}

/** Sum of posted margin across open positions. */
export function usedMargin(orders: Array<Pick<DbOrder, 'margin'>>): number {
  return money(orders.reduce((sum, o) => sum + Number(o.margin), 0));
}
```

## `src/lib/notifications.ts`

```typescript
import { supabaseAdmin } from '@/lib/supabase';

export type NotificationType =
  | 'account_created'
  | 'account_failed'
  | 'account_passed'
  | 'position_liquidated'
  | 'payout_requested'
  | 'payout_paid'
  | 'payout_rejected'
  | 'kyc_verified'
  | 'kyc_rejected'
  | 'certificate_issued'
  | 'account_gifted'
  | 'admin_action';

export async function notify(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('notifications')
    .insert({ user_id: userId, type, title, body, metadata });

  if (error) console.error('[notifications] insert failed', error.message);
}
```

## `src/lib/nowpayments.ts`

```typescript
import crypto from 'node:crypto';
import { ApiError, requireEnv } from '@/lib/http';

const API_URL = process.env.NOWPAYMENTS_API_URL ?? 'https://api.nowpayments.io/v1';

export interface CreateInvoiceInput {
  amount: number;
  order_id: string;
  order_description: string;
  pay_currency?: string;
  success_url?: string;
  cancel_url?: string;
  ipn_callback_url: string;
}

export interface NowPaymentsInvoice {
  id: string;
  invoice_url: string;
  order_id: string;
  price_amount: string | number;
  price_currency: string;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<NowPaymentsInvoice> {
  const apiKey = requireEnv('NOWPAYMENTS_API_KEY');

  let res: Response;
  try {
    res = await fetch(`${API_URL}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        price_amount: input.amount,
        price_currency: 'usd',
        order_id: input.order_id,
        order_description: input.order_description,
        ipn_callback_url: input.ipn_callback_url,
        success_url: input.success_url,
        cancel_url: input.cancel_url,
        ...(input.pay_currency ? { pay_currency: input.pay_currency } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError('UPSTREAM_ERROR', 'Could not reach the payment provider.');
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json?.invoice_url) {
    throw new ApiError('UPSTREAM_ERROR', 'Payment provider rejected the invoice.', json);
  }
  return json as unknown as NowPaymentsInvoice;
}

/**
 * NOWPayments signs the IPN body with HMAC-SHA512 over the JSON
 * serialisation of the payload with keys sorted alphabetically.
 */
export function verifyIpnSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = requireEnv('NOWPAYMENTS_IPN_SECRET');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const sorted = JSON.stringify(sortKeys(parsed));
  const expected = crypto.createHmac('sha512', secret).update(sorted).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export type NowPaymentsStatus =
  | 'waiting'
  | 'confirming'
  | 'confirmed'
  | 'sending'
  | 'partially_paid'
  | 'finished'
  | 'failed'
  | 'refunded'
  | 'expired';

export function isPaid(status: string): boolean {
  return status === 'finished' || status === 'confirmed';
}

export function isDead(status: string): boolean {
  return status === 'failed' || status === 'refunded' || status === 'expired';
}

export function newOrderId(): string {
  return `SOGDIA-${crypto.randomBytes(4).toString('hex')}`;
}
```

## `src/lib/payouts.ts`

```typescript
import { money, pct } from '@/lib/math';
import { supabaseAdmin } from '@/lib/supabase';
import type { DbAccount, DbUser } from '@/lib/types';

export type PayoutBlocker =
  | 'KYC_NOT_VERIFIED'
  | 'NO_WALLET'
  | 'ACCOUNT_NOT_ELIGIBLE'
  | 'NO_PROFIT'
  | 'CYCLE_NOT_ELAPSED'
  | 'OPEN_POSITIONS'
  | 'MIN_TRADING_DAYS'
  | 'CONSISTENCY_RULE';

export interface TradingStats {
  /** Distinct UTC days on which a position was closed. */
  trading_days: number;
  /** Largest single-day realised profit. */
  best_day_profit: number;
  total_profit: number;
}

/** Realised-trading stats used by the optional add-on payout rules. */
export async function getTradingStats(accountId: string): Promise<TradingStats> {
  const { data } = await supabaseAdmin()
    .from('orders')
    .select('pnl, closed_at')
    .eq('account_id', accountId)
    .in('status', ['closed', 'liquidated']);

  const byDay = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ pnl: number | null; closed_at: string | null }>) {
    if (!row.closed_at) continue;
    const day = row.closed_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + Number(row.pnl ?? 0));
  }

  const dayProfits = [...byDay.values()];
  return {
    trading_days: byDay.size,
    best_day_profit: dayProfits.length ? money(Math.max(...dayProfits, 0)) : 0,
    total_profit: money(dayProfits.reduce((s, v) => s + v, 0)),
  };
}

export interface PayoutEligibility {
  eligible: boolean;
  reasons: PayoutBlocker[];
  profit: number;
  max_payout: number;
  split_pct: number;
  next_payout_at: string | null;
  days_remaining: number;
  trading_days?: number;
  min_trading_days?: number;
}

/**
 * A payout is available when:
 *   - KYC verified and a payout wallet is on file
 *   - the account is active or passed (not failed/frozen/breached/closed)
 *   - realised balance is above the starting size
 *   - the 14-day cycle has elapsed since creation or the last payout
 *   - no positions are open (profit must be realised)
 *
 * The trader receives `profit * payout_split_pct` (80%).
 */
export function evaluatePayoutEligibility(
  user: DbUser,
  account: DbAccount,
  openPositions: number,
  stats?: TradingStats,
  now: Date = new Date(),
): PayoutEligibility {
  const reasons: PayoutBlocker[] = [];

  // Optional add-on rules — disabled by default (0 / null), so the
  // standard 14-day cycle behaves exactly as before unless a rule-set
  // explicitly turns them on.
  if (stats) {
    if (account.min_trading_days > 0 && stats.trading_days < account.min_trading_days) {
      reasons.push('MIN_TRADING_DAYS');
    }
    if (
      account.consistency_pct !== null &&
      stats.total_profit > 0 &&
      (stats.best_day_profit / stats.total_profit) * 100 > Number(account.consistency_pct)
    ) {
      reasons.push('CONSISTENCY_RULE');
    }
  }

  if (user.kyc_status !== 'verified') reasons.push('KYC_NOT_VERIFIED');
  if (!user.wallet_address) reasons.push('NO_WALLET');
  if (account.status !== 'active' && account.status !== 'passed') {
    reasons.push('ACCOUNT_NOT_ELIGIBLE');
  }
  if (openPositions > 0) reasons.push('OPEN_POSITIONS');

  const profit = money(Number(account.balance) - Number(account.size));
  if (profit <= 0) reasons.push('NO_PROFIT');

  const anchor = account.last_payout_at
    ? new Date(account.last_payout_at)
    : new Date(account.created_at);
  const unlockAt = new Date(anchor.getTime() + account.payout_cycle_days * 86_400_000);
  const msRemaining = unlockAt.getTime() - now.getTime();
  if (msRemaining > 0) reasons.push('CYCLE_NOT_ELAPSED');

  const split = Number(account.payout_split_pct);

  return {
    eligible: reasons.length === 0,
    reasons,
    profit: Math.max(profit, 0),
    max_payout: money(Math.max(profit, 0) * (split / 100)),
    split_pct: split,
    next_payout_at: unlockAt.toISOString(),
    days_remaining: Math.max(Math.ceil(msRemaining / 86_400_000), 0),
    trading_days: stats?.trading_days,
    min_trading_days: account.min_trading_days,
  };
}

/** Trader's share of a gross profit withdrawal. */
export function splitPayout(gross: number, splitPct: number) {
  const net = money(gross * (splitPct / 100));
  return { gross: money(gross), net, firm_fee: money(gross - net), split_pct: pct(splitPct) };
}
```

## `src/lib/permissions.ts`

```typescript
import { ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import type { DbUser, UserRole } from '@/lib/types';

/**
 * Role ladder
 * -----------
 * trader       — own accounts only
 * admin        — operations: KYC, payouts, freeze/breach, certificates
 * xdepartment  — everything admin can do, plus provisioning and overrides:
 *                gift accounts of any type/size, adjust balances, override
 *                rules and statuses, change roles, force payouts, delete,
 *                impersonate. Every action is audit-logged.
 */
export const ROLE_RANK: Record<UserRole, number> = {
  trader: 0,
  admin: 1,
  xdepartment: 2,
};

export function isAdmin(user: DbUser): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK.admin;
}

export function isXDepartment(user: DbUser): boolean {
  return user.role === 'xdepartment';
}

export function canSee(user: DbUser, ownerId: string): boolean {
  return user.id === ownerId || isAdmin(user);
}

/** admin or xdepartment */
export async function requireStaff(req: Request): Promise<DbUser> {
  const user = await requireUser(req);
  if (!isAdmin(user)) {
    throw new ApiError('FORBIDDEN', 'Staff privileges required.');
  }
  return user;
}

/** xdepartment only — the unrestricted tier. */
export async function requireXDepartment(req: Request): Promise<DbUser> {
  const user = await requireUser(req);
  if (!isXDepartment(user)) {
    throw new ApiError('FORBIDDEN', 'X-Department clearance required.');
  }
  return user;
}
```

## `src/lib/promos.ts`

```typescript
import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { money } from '@/lib/math';
import { applyPromoEdit, getSettings, saveSettings } from '@/lib/settings';
import type { Plan } from '@/config/pricing';
import type { Promo } from '@/config/settings';
import type { DbUser } from '@/lib/types';

/**
 * Add, replace or remove one promo in the settings document.
 * Pass `null` to delete. The write goes through saveSettings, so the
 * whole document is re-validated before anything is persisted.
 */
export async function writePromo(
  code: string,
  promo: Promo | null,
  actorId: string,
): Promise<{ raw: string; version: number; promos: Promo[] }> {
  const current = await getSettings();
  const nextRaw = applyPromoEdit(current.raw, code, promo);
  const saved = await saveSettings(nextRaw, actorId);

  return { raw: saved.raw, version: saved.version, promos: saved.settings.promos };
}

export async function findPromo(code: string): Promise<Promo | null> {
  const { settings } = await getSettings();
  const wanted = code.trim().toUpperCase();
  return settings.promos.find((p) => p.code === wanted) ?? null;
}

export function promoStatus(promo: Promo, uses: number): 'active' | 'inactive' | 'expired' | 'exhausted' {
  if (!promo.active) return 'inactive';
  if (promo.expires_at && Date.parse(`${promo.expires_at}T23:59:59Z`) < Date.now()) {
    return 'expired';
  }
  if (promo.max_uses > 0 && uses >= promo.max_uses) return 'exhausted';
  return 'active';
}

export type DiscountSource = 'promo' | 'referral' | 'site_wide' | 'none';

export interface DiscountQuote {
  plan_key: string;
  list_price: number;
  discount: number;
  final_price: number;
  source: DiscountSource;
  promo_code: string | null;
  label: string | null;
}

/** How many times a promo has been redeemed on a confirmed purchase. */
export async function promoUses(code: string): Promise<number> {
  const { count } = await supabaseAdmin()
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'purchase')
    .eq('status', 'paid')
    .eq('metadata->>promo_code', code.toUpperCase());

  return count ?? 0;
}

export type PromoRejection =
  | 'UNKNOWN_CODE'
  | 'INACTIVE'
  | 'EXPIRED'
  | 'PLAN_NOT_ELIGIBLE'
  | 'LIMIT_REACHED';

export interface PromoCheck {
  ok: boolean;
  promo: Promo | null;
  reason: PromoRejection | null;
  uses: number;
}

/** Validate a code against a plan without charging anything. */
export async function checkPromo(code: string, planKey: string): Promise<PromoCheck> {
  const { settings } = await getSettings();
  const wanted = code.trim().toUpperCase();
  const promo = settings.promos.find((p) => p.code === wanted) ?? null;

  if (!promo) return { ok: false, promo: null, reason: 'UNKNOWN_CODE', uses: 0 };
  if (!promo.active) return { ok: false, promo, reason: 'INACTIVE', uses: 0 };

  if (promo.expires_at) {
    // Expiry is end-of-day UTC on the stated date.
    const expiresAt = Date.parse(`${promo.expires_at}T23:59:59Z`);
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      return { ok: false, promo, reason: 'EXPIRED', uses: 0 };
    }
  }

  if (promo.plans !== 'all' && !promo.plans.includes(planKey)) {
    return { ok: false, promo, reason: 'PLAN_NOT_ELIGIBLE', uses: 0 };
  }

  const uses = promo.max_uses > 0 ? await promoUses(promo.code) : 0;
  if (promo.max_uses > 0 && uses >= promo.max_uses) {
    return { ok: false, promo, reason: 'LIMIT_REACHED', uses };
  }

  return { ok: true, promo, reason: null, uses };
}

export function promoRejectionMessage(reason: PromoRejection): string {
  switch (reason) {
    case 'UNKNOWN_CODE':
      return 'That promo code does not exist.';
    case 'INACTIVE':
      return 'That promo code is not active.';
    case 'EXPIRED':
      return 'That promo code has expired.';
    case 'PLAN_NOT_ELIGIBLE':
      return 'That promo code does not apply to this plan.';
    case 'LIMIT_REACHED':
      return 'That promo code has reached its usage limit.';
  }
}

function amountOff(promo: Promo, listPrice: number): number {
  return promo.kind === 'percent'
    ? money(listPrice * (promo.value / 100))
    : money(Math.min(promo.value, listPrice));
}

/**
 * Price a checkout. Only the single best discount applies — promo,
 * referral and site-wide never stack. The list price itself is never
 * modified; the discount lives on the invoice and the transaction.
 */
export async function quoteCheckout(
  plan: Plan,
  user: DbUser,
  promoCode?: string | null,
): Promise<DiscountQuote> {
  const { settings } = await getSettings();
  const listPrice = plan.price;

  const candidates: Array<{ discount: number; source: DiscountSource; code: string | null; label: string | null }> = [
    { discount: 0, source: 'none', code: null, label: null },
  ];

  if (promoCode) {
    const check = await checkPromo(promoCode, plan.key);
    if (!check.ok || !check.promo) {
      throw new ApiError(
        'VALIDATION_ERROR',
        promoRejectionMessage(check.reason ?? 'UNKNOWN_CODE'),
        { promo_code: promoCode.toUpperCase(), reason: check.reason },
      );
    }
    candidates.push({
      discount: amountOff(check.promo, listPrice),
      source: 'promo',
      code: check.promo.code,
      label: check.promo.note ?? check.promo.code,
    });
  }

  if (user.referred_by && settings.referral_discount_pct > 0) {
    candidates.push({
      discount: money(listPrice * (settings.referral_discount_pct / 100)),
      source: 'referral',
      code: null,
      label: `Referral discount ${settings.referral_discount_pct}%`,
    });
  }

  if (settings.default_discount_pct > 0) {
    candidates.push({
      discount: money(listPrice * (settings.default_discount_pct / 100)),
      source: 'site_wide',
      code: null,
      label: `${settings.default_discount_pct}% off`,
    });
  }

  const best = candidates.reduce((a, b) => (b.discount > a.discount ? b : a));

  // Payment providers reject zero-value invoices, so a 100% discount is
  // floored rather than silently failing at the provider.
  const floor = settings.min_invoice_usd;
  const finalPrice = money(Math.max(listPrice - best.discount, Math.min(floor, listPrice)));

  return {
    plan_key: plan.key,
    list_price: listPrice,
    discount: money(listPrice - finalPrice),
    final_price: finalPrice,
    source: best.discount > 0 ? best.source : 'none',
    promo_code: best.code,
    label: best.label,
  };
}
```

## `src/lib/ratelimit.ts`

```typescript
import { ApiError } from '@/lib/http';

/**
 * In-process sliding-window limiter. Good enough for a single Node
 * instance; swap the Map for Upstash Redis when you scale horizontally
 * (same signature, make it async).
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (hits.length >= max) {
    throw new ApiError(
      'RATE_LIMITED',
      `Too many requests — try again in ${Math.ceil((windowMs - (now - hits[0])) / 1000)}s.`,
    );
  }

  hits.push(now);
  buckets.set(key, hits);

  // Opportunistic cleanup so the map cannot grow without bound.
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) {
      if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}
```

## `src/lib/referrals.ts`

```typescript
import crypto from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { money } from '@/lib/math';
import { notify } from '@/lib/notifications';
import { getSettings } from '@/lib/settings';
import type { DbUser } from '@/lib/types';

/**
 * Commission paid to the referrer on a confirmed purchase.
 * The live rate is `referral_commission_pct` in the X-Department
 * settings blob; this is only the fallback if settings are unreadable.
 */
export const FALLBACK_REFERRAL_COMMISSION_PCT = 10;

export function generateReferralCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** Lazily mint a referral code for a user who doesn't have one yet. */
export async function ensureReferralCode(user: DbUser): Promise<string> {
  if (user.referral_code) return user.referral_code;

  const code = generateReferralCode();
  const { data } = await supabaseAdmin()
    .from('users')
    .update({ referral_code: code })
    .eq('id', user.id)
    .select('referral_code')
    .maybeSingle<{ referral_code: string }>();

  return data?.referral_code ?? code;
}

export async function resolveReferrer(code: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('users')
    .select('id')
    .eq('referral_code', code.toUpperCase())
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

/**
 * Credits the referrer after a purchase confirms. Commission is recorded
 * as a `commission` transaction — it does not touch any trading account.
 */
export async function creditReferral(
  buyerId: string,
  purchaseTxId: string,
  purchaseAmount: number,
): Promise<void> {
  const admin = supabaseAdmin();

  const { data: buyer } = await admin
    .from('users')
    .select('referred_by')
    .eq('id', buyerId)
    .maybeSingle<{ referred_by: string | null }>();

  const referrerId = buyer?.referred_by;
  if (!referrerId) return;

  const { settings } = await getSettings();
  const pct = settings.referral_commission_pct ?? FALLBACK_REFERRAL_COMMISSION_PCT;

  // Commission is a share of what the buyer actually paid, so a
  // discounted sale pays a proportionally smaller commission.
  const commission = money(purchaseAmount * (pct / 100));
  if (commission <= 0) return;

  const { error } = await admin.from('transactions').insert({
    user_id: referrerId,
    amount: commission,
    net_amount: commission,
    type: 'commission',
    status: 'pending',
    metadata: { source_transaction_id: purchaseTxId, buyer_id: buyerId, pct },
  });

  if (error) {
    console.error('[referrals] commission insert failed', error.message);
    return;
  }

  await notify(
    referrerId,
    'payout_requested',
    'Referral commission earned',
    `You earned $${commission} from a referral purchase.`,
    { amount: commission },
  );
}
```

## `src/lib/risk.ts`

```typescript
import { money, pct, usedMargin } from '@/lib/math';
import type { AccountMetrics, BreachReason, DbAccount, Position } from '@/lib/types';

/**
 * Drawdown model
 * --------------
 * equity        = realised balance + unrealised PnL of open positions
 * daily DD floor = daily_start_balance * (1 - daily_dd_pct/100)   [reset 00:00 UTC]
 * max DD floor   = size                * (1 - max_dd_pct/100)     [static, from day one]
 *
 * One-Step : 4% daily / 6% max      Instant : 3% daily / 5% max
 */
export function computeMetrics(account: DbAccount, positions: Position[]): AccountMetrics {
  const balance = Number(account.balance);
  const size = Number(account.size);
  const dailyStart = Number(account.daily_start_balance);

  const unrealized = money(positions.reduce((s, p) => s + p.unrealized_pnl, 0));
  const equity = money(balance + unrealized);
  const used = usedMargin(positions);

  const dailyLimit = money(dailyStart * (1 - Number(account.daily_dd_pct) / 100));
  const maxLimit = money(size * (1 - Number(account.max_dd_pct) / 100));

  const profitTarget =
    account.profit_target_pct === null
      ? null
      : money(size * (1 + Number(account.profit_target_pct) / 100));

  return {
    equity,
    unrealized_pnl: unrealized,
    used_margin: used,
    free_margin: money(Math.max(balance - used, 0)),
    open_positions: positions.length,
    daily_dd_limit: dailyLimit,
    max_dd_limit: maxLimit,
    daily_dd_remaining: money(equity - dailyLimit),
    max_dd_remaining: money(equity - maxLimit),
    daily_dd_used_pct: dailyStart > 0 ? pct(((dailyStart - equity) / dailyStart) * 100) : 0,
    max_dd_used_pct: size > 0 ? pct(((size - equity) / size) * 100) : 0,
    profit_target: profitTarget,
    profit_pct: size > 0 ? pct(((equity - size) / size) * 100) : 0,
    // Evaluation passes on *realised* balance, so a trader can't pass on an
    // open floating profit and then give it straight back.
    target_reached: profitTarget !== null && balance >= profitTarget,
  };
}

/** Which rule, if any, the account has just violated. Max DD is checked first. */
export function checkBreach(metrics: AccountMetrics): BreachReason {
  if (metrics.equity <= metrics.max_dd_limit) return 'MAX_DRAWDOWN';
  if (metrics.equity <= metrics.daily_dd_limit) return 'DAILY_DRAWDOWN';
  return null;
}

export function breachMessage(reason: Exclude<BreachReason, null>, metrics: AccountMetrics): string {
  return reason === 'MAX_DRAWDOWN'
    ? `Max drawdown breached: equity ${metrics.equity} fell to or below the floor of ${metrics.max_dd_limit}.`
    : `Daily drawdown breached: equity ${metrics.equity} fell to or below today's floor of ${metrics.daily_dd_limit}.`;
}

/** Only `active` accounts may open new positions. */
export function isTradable(account: DbAccount): boolean {
  return account.status === 'active';
}
```

## `src/lib/settings.ts`

```typescript
import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { PLAN_KEYS } from '@/config/pricing';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_RAW,
  SETTINGS_BOUNDS,
  SETTINGS_NUMERIC_KEYS,
  type PlatformSettings,
  type Promo,
  type SettingsNumericKey,
} from '@/config/settings';

export interface ParseIssue {
  line: number | null;
  message: string;
}

export interface ParseResult {
  settings: PlatformSettings;
  warnings: ParseIssue[];
}

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_KEY_SET = new Set<string>(SETTINGS_NUMERIC_KEYS);

function invalid(issues: ParseIssue[]): never {
  throw new ApiError(
    'VALIDATION_ERROR',
    issues.length === 1
      ? issues[0].message
      : `${issues.length} problems in the settings document.`,
    issues,
  );
}

// ---------------------------------------------------------------------
// Promo line: promo = CODE | 25% | plans:all | expires:never | max_uses:0 | active
// ---------------------------------------------------------------------
function parsePromoLine(spec: string, line: number, issues: ParseIssue[]): Promo | null {
  const tokens = spec.split('|').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    issues.push({ line, message: 'Promo line is empty.' });
    return null;
  }

  const code = tokens[0].toUpperCase();
  if (!CODE_RE.test(code)) {
    issues.push({
      line,
      message: `"${tokens[0]}" is not a valid promo code — use 3–24 characters, letters, digits, _ or -.`,
    });
    return null;
  }

  const promo: Promo = {
    code,
    kind: 'percent',
    value: 0,
    plans: 'all',
    expires_at: null,
    max_uses: 0,
    active: true,
  };
  let valueSeen = false;

  for (const token of tokens.slice(1)) {
    const lower = token.toLowerCase();

    if (lower === 'active' || lower === 'enabled') {
      promo.active = true;
      continue;
    }
    if (lower === 'inactive' || lower === 'disabled' || lower === 'off') {
      promo.active = false;
      continue;
    }

    // 25%  |  $50  |  50usd
    const pctMatch = token.match(/^(\d+(?:\.\d+)?)\s*%$/);
    if (pctMatch) {
      promo.kind = 'percent';
      promo.value = Number(pctMatch[1]);
      valueSeen = true;
      continue;
    }
    const fixedMatch = token.match(/^\$\s*(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\s*usd$/i);
    if (fixedMatch) {
      promo.kind = 'fixed';
      promo.value = Number(fixedMatch[1] ?? fixedMatch[2]);
      valueSeen = true;
      continue;
    }

    const sep = token.indexOf(':');
    if (sep === -1) {
      issues.push({ line, message: `Promo ${code}: could not read "${token}".` });
      continue;
    }
    const key = token.slice(0, sep).trim().toLowerCase();
    const value = token.slice(sep + 1).trim();

    switch (key) {
      case 'percent':
        promo.kind = 'percent';
        promo.value = Number(value);
        valueSeen = true;
        break;
      case 'fixed':
      case 'usd':
        promo.kind = 'fixed';
        promo.value = Number(value);
        valueSeen = true;
        break;
      case 'plans':
      case 'plan':
        promo.plans =
          value.toLowerCase() === 'all'
            ? 'all'
            : value.split(',').map((p) => p.trim()).filter(Boolean);
        break;
      case 'expires':
      case 'expires_at':
      case 'until':
        if (value.toLowerCase() === 'never' || value === '-') {
          promo.expires_at = null;
        } else if (DATE_RE.test(value) && !Number.isNaN(Date.parse(value))) {
          promo.expires_at = value;
        } else {
          issues.push({
            line,
            message: `Promo ${code}: expires must be YYYY-MM-DD or "never", got "${value}".`,
          });
        }
        break;
      case 'max_uses':
      case 'uses':
      case 'limit':
        promo.max_uses = Number(value);
        break;
      case 'note':
      case 'label':
        promo.note = value;
        break;
      default:
        issues.push({ line, message: `Promo ${code}: unknown field "${key}".` });
    }
  }

  if (!valueSeen) {
    issues.push({ line, message: `Promo ${code}: no discount given — add "25%" or "$50".` });
    return null;
  }
  if (!Number.isFinite(promo.value) || promo.value <= 0) {
    issues.push({ line, message: `Promo ${code}: discount must be greater than zero.` });
    return null;
  }
  if (promo.kind === 'percent' && promo.value > 90) {
    issues.push({ line, message: `Promo ${code}: percent discount is capped at 90%.` });
    return null;
  }
  if (!Number.isFinite(promo.max_uses) || promo.max_uses < 0) {
    issues.push({ line, message: `Promo ${code}: max_uses must be 0 or more.` });
    return null;
  }

  return promo;
}

// ---------------------------------------------------------------------
// Whole document
// ---------------------------------------------------------------------
function validateShape(input: PlatformSettings, issues: ParseIssue[], warnings: ParseIssue[]) {
  for (const key of SETTINGS_NUMERIC_KEYS) {
    const value = input[key];
    const bounds = SETTINGS_BOUNDS[key];
    if (!Number.isFinite(value)) {
      issues.push({ line: null, message: `${key} must be a number.` });
    } else if (value < bounds.min || value > bounds.max) {
      issues.push({
        line: null,
        message: `${key} must be between ${bounds.min} and ${bounds.max} (got ${value}).`,
      });
    }
  }

  const seen = new Set<string>();
  for (const promo of input.promos) {
    if (seen.has(promo.code)) {
      issues.push({ line: null, message: `Promo code ${promo.code} is listed twice.` });
    }
    seen.add(promo.code);

    if (promo.plans !== 'all') {
      for (const plan of promo.plans) {
        if (!PLAN_KEYS.includes(plan)) {
          warnings.push({
            line: null,
            message: `Promo ${promo.code} references unknown plan "${plan}" — it will never match.`,
          });
        }
      }
    }
    if (promo.expires_at && Date.parse(promo.expires_at) < Date.now()) {
      warnings.push({ line: null, message: `Promo ${promo.code} has already expired.` });
    }
  }
}

/** Accepts the line format or raw JSON. Throws ApiError with per-line details. */
export function parseSettings(raw: string): ParseResult {
  const issues: ParseIssue[] = [];
  const warnings: ParseIssue[] = [];
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    invalid([{ line: null, message: 'Settings document is empty.' }]);
  }

  // --- JSON form ---
  if (trimmed.startsWith('{')) {
    let json: Partial<PlatformSettings>;
    try {
      json = JSON.parse(trimmed) as Partial<PlatformSettings>;
    } catch (err) {
      invalid([{ line: null, message: `Invalid JSON: ${(err as Error).message}` }]);
    }

    const settings: PlatformSettings = {
      ...DEFAULT_SETTINGS,
      ...json,
      promos: Array.isArray(json.promos) ? json.promos.map(normalizePromo) : [],
    };
    validateShape(settings, issues, warnings);
    if (issues.length) invalid(issues);
    return { settings, warnings };
  }

  // --- line format ---
  const settings: PlatformSettings = { ...DEFAULT_SETTINGS, promos: [] };

  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const text = rawLine.trim();
    if (!text || text.startsWith('#') || text.startsWith('//')) return;

    const eq = text.indexOf('=');
    if (eq === -1) {
      issues.push({ line, message: `Expected "key = value", got "${text}".` });
      return;
    }

    const key = text.slice(0, eq).trim().toLowerCase();
    const value = text.slice(eq + 1).trim();

    if (key === 'promo' || key === 'promo_code') {
      const promo = parsePromoLine(value, line, issues);
      if (promo) settings.promos.push(promo);
      return;
    }

    if (!NUMERIC_KEY_SET.has(key)) {
      issues.push({
        line,
        message: `Unknown setting "${key}". Allowed: ${SETTINGS_NUMERIC_KEYS.join(', ')}, promo.`,
      });
      return;
    }

    const num = Number(value.replace(/[%$\s]/g, ''));
    if (!Number.isFinite(num)) {
      issues.push({ line, message: `${key} must be a number, got "${value}".` });
      return;
    }
    settings[key as SettingsNumericKey] = num;
  });

  validateShape(settings, issues, warnings);
  if (issues.length) invalid(issues);

  return { settings, warnings };
}

function normalizePromo(input: Partial<Promo>): Promo {
  return {
    code: String(input.code ?? '').toUpperCase(),
    kind: input.kind === 'fixed' ? 'fixed' : 'percent',
    value: Number(input.value ?? 0),
    plans: input.plans === 'all' || input.plans === undefined ? 'all' : input.plans,
    expires_at: input.expires_at ?? null,
    max_uses: Number(input.max_uses ?? 0),
    active: input.active !== false,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** One canonical `promo = ...` line. */
export function promoLine(promo: Promo): string {
  const value = promo.kind === 'percent' ? `${promo.value}%` : `$${promo.value}`;
  const plans = promo.plans === 'all' ? 'all' : promo.plans.join(',');
  return `promo = ${promo.code} | ${value} | plans:${plans} | expires:${
    promo.expires_at ?? 'never'
  } | max_uses:${promo.max_uses} | ${promo.active ? 'active' : 'inactive'}${
    promo.note ? ` | note:${promo.note}` : ''
  }`;
}

/** Canonical line-format text for a settings object. */
export function serializeSettings(settings: PlatformSettings): string {
  const lines = [
    '# SOGDIA platform settings',
    '# Prices live in src/config/pricing.ts and are NOT editable here.',
    '',
    ...SETTINGS_NUMERIC_KEYS.map((key) => `${key.padEnd(23)} = ${settings[key]}`),
    '',
    ...settings.promos.map(promoLine),
  ];

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------
// Line surgery — add / edit / remove a single promo without rewriting
// the document. Comments, ordering and spacing the operator wrote are
// preserved; only the one line changes.
// ---------------------------------------------------------------------
const PROMO_LINE_RE = /^(\s*)promo(?:_code)?\s*=\s*(.+)$/i;

function isJsonDocument(raw: string): boolean {
  return raw.trim().startsWith('{');
}

function promoLineIndex(lines: string[], code: string): number {
  const wanted = code.trim().toUpperCase();
  return lines.findIndex((line) => {
    const match = line.match(PROMO_LINE_RE);
    if (!match) return false;
    const lineCode = match[2].split('|')[0]?.trim().toUpperCase();
    return lineCode === wanted;
  });
}

export function rawHasPromo(raw: string, code: string): boolean {
  if (isJsonDocument(raw)) {
    return parseSettings(raw).settings.promos.some(
      (p) => p.code === code.trim().toUpperCase(),
    );
  }
  return promoLineIndex(raw.split(/\r?\n/), code) !== -1;
}

/**
 * Rewrite the document with one promo added, replaced or removed.
 * A JSON document is normalised to the line format (JSON carries no
 * comments, so nothing is lost).
 */
export function applyPromoEdit(
  raw: string,
  code: string,
  promo: Promo | null,
): string {
  if (isJsonDocument(raw)) {
    const { settings } = parseSettings(raw);
    const wanted = code.trim().toUpperCase();
    const rest = settings.promos.filter((p) => p.code !== wanted);
    return serializeSettings({
      ...settings,
      promos: promo ? [...rest, promo] : rest,
    });
  }

  const lines = raw.split(/\r?\n/);
  const index = promoLineIndex(lines, code);

  // Remove
  if (!promo) {
    if (index === -1) return raw;
    lines.splice(index, 1);
    return lines.join('\n');
  }

  // Replace in place, keeping the original indentation
  if (index !== -1) {
    const indent = lines[index].match(PROMO_LINE_RE)?.[1] ?? '';
    lines[index] = `${indent}${promoLine(promo)}`;
    return lines.join('\n');
  }

  // Append after the last existing promo line, else at the end
  const lastPromo = lines.reduce(
    (last, line, i) => (PROMO_LINE_RE.test(line) ? i : last),
    -1,
  );

  if (lastPromo !== -1) {
    lines.splice(lastPromo + 1, 0, promoLine(promo));
    return lines.join('\n');
  }

  const trimmedEnd = [...lines];
  while (trimmedEnd.length && trimmedEnd[trimmedEnd.length - 1].trim() === '') {
    trimmedEnd.pop();
  }
  trimmedEnd.push('', promoLine(promo), '');
  return trimmedEnd.join('\n');
}

/** Merge a partial update onto an existing promo. */
export function mergePromo(current: Promo, patch: Partial<Promo>): Promo {
  return {
    ...current,
    ...patch,
    code: current.code,
    plans: patch.plans ?? current.plans,
    expires_at: patch.expires_at === undefined ? current.expires_at : patch.expires_at,
    note: patch.note === undefined ? current.note : patch.note,
  };
}

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------
export interface StoredSettings {
  settings: PlatformSettings;
  raw: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const CACHE_TTL_MS = 15_000;
let cache: { value: StoredSettings; at: number } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Live settings, with the shipped defaults as a fallback. Never throws. */
export async function getSettings(): Promise<StoredSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const fallback: StoredSettings = {
    settings: DEFAULT_SETTINGS,
    raw: DEFAULT_SETTINGS_RAW,
    version: 0,
    updated_at: null,
    updated_by: null,
  };

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .select('raw, parsed, version, updated_at, updated_by')
    .eq('id', 'global')
    .maybeSingle<{
      raw: string;
      parsed: PlatformSettings;
      version: number;
      updated_at: string;
      updated_by: string | null;
    }>();

  if (error || !data) {
    // First boot (or a transient read failure): seed and serve defaults.
    if (!error) {
      await supabaseAdmin()
        .from('platform_settings')
        .upsert({
          id: 'global',
          raw: DEFAULT_SETTINGS_RAW,
          parsed: DEFAULT_SETTINGS,
          version: 1,
        });
    }
    cache = { value: fallback, at: Date.now() };
    return fallback;
  }

  // `parsed` is written on save; re-parse `raw` if it is missing or stale.
  let settings = data.parsed;
  if (!settings || typeof settings !== 'object' || !Array.isArray(settings.promos)) {
    try {
      settings = parseSettings(data.raw).settings;
    } catch {
      settings = DEFAULT_SETTINGS;
    }
  }

  const value: StoredSettings = {
    settings,
    raw: data.raw,
    version: data.version,
    updated_at: data.updated_at,
    updated_by: data.updated_by,
  };
  cache = { value, at: Date.now() };
  return value;
}

export async function saveSettings(
  raw: string,
  actorId: string,
): Promise<StoredSettings & { warnings: ParseIssue[] }> {
  const { settings, warnings } = parseSettings(raw);
  const current = await getSettings();

  const { data, error } = await supabaseAdmin()
    .from('platform_settings')
    .upsert({
      id: 'global',
      raw,
      parsed: settings,
      version: current.version + 1,
      updated_by: actorId,
      updated_at: new Date().toISOString(),
    })
    .select('raw, parsed, version, updated_at, updated_by')
    .single<{
      raw: string;
      parsed: PlatformSettings;
      version: number;
      updated_at: string;
      updated_by: string | null;
    }>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  invalidateSettingsCache();

  return {
    settings: data.parsed,
    raw: data.raw,
    version: data.version,
    updated_at: data.updated_at,
    updated_by: data.updated_by,
    warnings,
  };
}
```

## `src/lib/snapshots.ts`

```typescript
import { supabaseAdmin } from '@/lib/supabase';

export type SnapshotSource = 'daily_close' | 'trade_close' | 'manual';

/**
 * Append-only equity curve. Cheap to write, powers the account chart
 * without recomputing historical PnL.
 */
export async function snapshotEquity(
  accountId: string,
  equity: number,
  balance: number,
  source: SnapshotSource = 'trade_close',
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('equity_snapshots')
    .insert({ account_id: accountId, equity, balance, source });

  // Never let telemetry break a trade.
  if (error) console.error('[snapshots] insert failed', error.message);
}

export async function getEquityCurve(accountId: string, limit = 500) {
  const { data } = await supabaseAdmin()
    .from('equity_snapshots')
    .select('equity, balance, source, taken_at')
    .eq('account_id', accountId)
    .order('taken_at', { ascending: true })
    .limit(limit);

  const rows = (data ?? []) as Array<{
    equity: number;
    balance: number;
    source: string;
    taken_at: string;
  }>;

  return rows.map((r) => ({
    equity: Number(r.equity),
    balance: Number(r.balance),
    source: r.source,
    taken_at: r.taken_at,
  }));
}
```

## `src/lib/supabase.ts`

```typescript
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/http';

/**
 * Service-role client. Bypasses RLS — server-side only, never send this
 * key to a browser. All writes in this backend go through here, with
 * ownership checks enforced in code (see lib/auth.ts).
 */
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return cached;
}

/** Anon client — used only for sign-up / sign-in / token refresh. */
export function supabaseAnon(): SupabaseClient {
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
```

## `src/lib/types.ts`

```typescript
import type { AccountType } from '@/config/pricing';

export type UserRole = 'trader' | 'admin' | 'xdepartment';
export type KycStatus = 'not_submitted' | 'pending' | 'verified' | 'rejected';
export type AccountStatus = 'active' | 'passed' | 'failed' | 'frozen' | 'breached' | 'closed';
export type OrderSide = 'long' | 'short';
export type OrderStatus = 'open' | 'closed' | 'liquidated';
export type TransactionType = 'purchase' | 'payout' | 'refund' | 'adjustment' | 'commission';
export type TransactionStatus = 'pending' | 'approved' | 'paid' | 'rejected' | 'failed';
export type CertificateType = 'eval_pass' | 'payout';

export interface DbUser {
  id: string;
  email: string;
  role: UserRole;
  kyc_status: KycStatus;
  kyc_document_url: string | null;
  kyc_note: string | null;
  wallet_address: string | null;
  full_name: string | null;
  country: string | null;
  referral_code: string | null;
  referred_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbAccount {
  id: string;
  user_id: string;
  type: AccountType;
  size: number;
  balance: number;
  equity: number;
  daily_start_balance: number;
  status: AccountStatus;
  max_leverage: number;
  profit_target_pct: number | null;
  daily_dd_pct: number;
  max_dd_pct: number;
  payout_split_pct: number;
  payout_cycle_days: number;
  plan_key: string | null;
  /** Optional add-on rules. 0 / null = disabled, which is the default. */
  min_trading_days: number;
  consistency_pct: number | null;
  is_gifted: boolean;
  breach_reason: string | null;
  last_payout_at: string | null;
  next_payout_at: string | null;
  daily_reset_at: string;
  created_at: string;
  updated_at: string;
}

export interface DbOrder {
  id: string;
  account_id: string;
  user_id: string;
  symbol: string;
  side: OrderSide;
  leverage: number;
  margin: number;
  position_size: number;
  quantity: number;
  entry_price: number;
  mark_price_at_open: number;
  liquidation_price: number;
  take_profit: number | null;
  stop_loss: number | null;
  parent_order_id: string | null;
  close_price: number | null;
  pnl: number | null;
  status: OrderStatus;
  close_reason: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface DbTransaction {
  id: string;
  user_id: string;
  account_id: string | null;
  amount: number;
  net_amount: number | null;
  currency: string;
  type: TransactionType;
  status: TransactionStatus;
  wallet_address: string | null;
  tx_hash: string | null;
  nowpayments_payment_id: string | null;
  nowpayments_order_id: string | null;
  admin_note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DbCertificate {
  id: string;
  user_id: string;
  account_id: string | null;
  type: CertificateType;
  amount: number;
  code: string;
  display_name: string | null;
  is_manual: boolean;
  issued_by: string | null;
  metadata: Record<string, unknown>;
  issued_at: string;
}

export interface Position extends DbOrder {
  mark_price: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
}

export interface AccountMetrics {
  equity: number;
  unrealized_pnl: number;
  used_margin: number;
  free_margin: number;
  open_positions: number;
  daily_dd_limit: number;
  max_dd_limit: number;
  daily_dd_remaining: number;
  max_dd_remaining: number;
  daily_dd_used_pct: number;
  max_dd_used_pct: number;
  profit_target: number | null;
  profit_pct: number;
  target_reached: boolean;
}

export type BreachReason = 'DAILY_DRAWDOWN' | 'MAX_DRAWDOWN' | null;

export interface RiskResult {
  breached: boolean;
  reason: BreachReason;
  status: AccountStatus;
  closed_orders: number;
  passed?: boolean;
}
```

## `src/lib/validation.ts`

```typescript
import { z } from 'zod';
import { MAX_LEVERAGE, MIN_LEVERAGE, PLAN_KEYS } from '@/config/pricing';

/** Email + password, 8–16 chars, at least one letter and one digit. */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(16, 'Password must be at most 16 characters.')
  .regex(/[A-Za-z]/, 'Password must contain a letter.')
  .regex(/[0-9]/, 'Password must contain a digit.');

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: passwordSchema,
  full_name: z.string().trim().min(2).max(80).optional(),
  country: z.string().trim().length(2).toUpperCase().optional(),
  referral_code: z.string().trim().min(4).max(16).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(64),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(10),
});

export const updateMeSchema = z
  .object({
    wallet_address: z.string().trim().min(16).max(128).nullable().optional(),
    full_name: z.string().trim().min(2).max(80).optional(),
    country: z.string().trim().length(2).toUpperCase().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export const openTradeSchema = z.object({
  account_id: z.string().uuid(),
  symbol: z.string().trim().toUpperCase().min(5).max(20),
  side: z.enum(['long', 'short']),
  leverage: z.number().int().min(MIN_LEVERAGE).max(MAX_LEVERAGE),
  margin: z.number().positive().max(1_000_000),
  take_profit: z.number().positive().nullable().optional(),
  stop_loss: z.number().positive().nullable().optional(),
});

export const closeTradeSchema = z.object({
  order_id: z.string().uuid(),
});

export const accountIdSchema = z.object({
  account_id: z.string().uuid(),
});

export const checkoutSchema = z.object({
  plan_key: z.enum(PLAN_KEYS as [string, ...string[]]),
  pay_currency: z.string().trim().min(2).max(20).optional(),
  promo_code: z.string().trim().min(3).max(24).optional(),
});

// ---------------------------------------------------------------------
// Promo CRUD (X-Department). These edit a single line of the settings
// document; the document itself stays the source of truth.
// ---------------------------------------------------------------------
const promoCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{2,23}$/, 'Use 3–24 characters: letters, digits, _ or -.');

const promoPlans = z.union([
  z.literal('all'),
  z.array(z.enum(PLAN_KEYS as [string, ...string[]])).min(1),
]);

const promoExpiry = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .nullable();

export const promoCreateSchema = z.object({
  code: promoCode,
  kind: z.enum(['percent', 'fixed']),
  value: z.number().positive(),
  plans: promoPlans.optional().default('all'),
  expires_at: promoExpiry.optional().default(null),
  max_uses: z.number().int().min(0).max(1_000_000).optional().default(0),
  active: z.boolean().optional().default(true),
  note: z.string().trim().max(120).optional(),
  reason: z.string().trim().max(500).optional(),
});

export const promoUpdateSchema = z
  .object({
    kind: z.enum(['percent', 'fixed']).optional(),
    value: z.number().positive().optional(),
    plans: promoPlans.optional(),
    expires_at: promoExpiry.optional(),
    max_uses: z.number().int().min(0).max(1_000_000).optional(),
    active: z.boolean().optional(),
    note: z.string().trim().max(120).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'reason'), {
    message: 'Nothing to update.',
  });

/** X-Department settings textarea. One blob, parsed server-side. */
export const settingsSchema = z.object({
  raw: z.string().min(1).max(20_000),
  /** true = parse and report problems without saving. */
  validate_only: z.boolean().optional().default(false),
  reason: z.string().trim().max(500).optional(),
});

export const payoutRequestSchema = z.object({
  account_id: z.string().uuid(),
  amount: z.number().positive().max(1_000_000).optional(),
});

export const adminAccountStatusSchema = z.object({
  action: z.enum(['freeze', 'unfreeze', 'breach', 'close']),
  reason: z.string().trim().max(500).optional(),
  close_positions: z.boolean().optional().default(true),
});

export const adminKycSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional(),
});

export const adminPayoutSchema = z.object({
  action: z.enum(['approve', 'reject', 'mark_paid']),
  tx_hash: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

export const adminCertificateSchema = z.object({
  user_id: z.string().uuid(),
  account_id: z.string().uuid().nullable().optional(),
  type: z.enum(['eval_pass', 'payout']),
  amount: z.number().nonnegative().max(10_000_000),
  display_name: z.string().trim().min(2).max(80).optional(),
});

// ---------------------------------------------------------------------
// X-Department (unrestricted tier)
// ---------------------------------------------------------------------

/** Rule overrides. Pricing itself is never editable through the API. */
export const accountRulesSchema = z.object({
  profit_target_pct: z.number().min(0).max(1000).nullable().optional(),
  daily_dd_pct: z.number().min(0.1).max(100).optional(),
  max_dd_pct: z.number().min(0.1).max(100).optional(),
  max_leverage: z.number().int().min(1).max(200).optional(),
  payout_split_pct: z.number().min(0).max(100).optional(),
  payout_cycle_days: z.number().int().min(0).max(365).optional(),
  min_trading_days: z.number().int().min(0).max(365).optional(),
  consistency_pct: z.number().min(1).max(100).nullable().optional(),
});

export const giftAccountSchema = z
  .object({
    user_id: z.string().uuid().optional(),
    email: z.string().email().optional(),
    plan_key: z.enum(PLAN_KEYS as [string, ...string[]]).optional(),
    custom: z
      .object({
        type: z.enum(['one_step', 'instant']),
        size: z.number().positive().max(10_000_000),
        label: z.string().trim().max(60).optional(),
      })
      .optional(),
    rules: accountRulesSchema.optional(),
    quantity: z.number().int().min(1).max(20).default(1),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.user_id || v.email), {
    message: 'Provide user_id or email.',
  })
  .refine((v) => Boolean(v.plan_key || v.custom), {
    message: 'Provide plan_key or custom.',
  });

export const adjustAccountSchema = z
  .object({
    set_balance: z.number().min(0).max(100_000_000).optional(),
    balance_delta: z.number().min(-100_000_000).max(100_000_000).optional(),
    set_status: z
      .enum(['active', 'passed', 'failed', 'frozen', 'breached', 'closed'])
      .optional(),
    set_size: z.number().positive().max(10_000_000).optional(),
    reset_daily_start: z.boolean().optional(),
    reset_drawdown: z.boolean().optional(),
    close_positions: z.boolean().optional(),
    clear_breach: z.boolean().optional(),
    rules: accountRulesSchema.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'reason'), {
    message: 'Nothing to adjust.',
  });

export const setRoleSchema = z.object({
  role: z.enum(['trader', 'admin', 'xdepartment']),
  reason: z.string().trim().max(500).optional(),
});

export const forceKycSchema = z.object({
  kyc_status: z.enum(['not_submitted', 'pending', 'verified', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

export const forcePayoutSchema = z.object({
  status: z.enum(['pending', 'approved', 'paid', 'rejected', 'failed']),
  tx_hash: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
  /** Skip the balance debit (useful for correcting a mistaken settlement). */
  skip_balance_debit: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------
// Protective orders
// ---------------------------------------------------------------------
export const protectionSchema = z
  .object({
    order_id: z.string().uuid(),
    take_profit: z.number().positive().nullable().optional(),
    stop_loss: z.number().positive().nullable().optional(),
  })
  .refine((v) => v.take_profit !== undefined || v.stop_loss !== undefined, {
    message: 'Provide take_profit and/or stop_loss.',
  });

export const partialCloseSchema = z.object({
  order_id: z.string().uuid(),
  /** Fraction of the position to close, 0 < percent <= 100. */
  percent: z.number().gt(0).max(100),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
```

# API routes — auth & profile

## `src/app/api/auth/register/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { supabaseAdmin, supabaseAnon } from '@/lib/supabase';
import { registerSchema } from '@/lib/validation';
import { generateReferralCode, resolveReferrer } from '@/lib/referrals';
import { clientIp, rateLimit } from '@/lib/ratelimit';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/auth/register */
export const POST = handle(async (req) => {
  rateLimit(`register:${clientIp(req)}`, 5, 60 * 60_000);
  const body = registerSchema.parse(await readJson(req));

  const { data, error } = await supabaseAnon().auth.signUp({
    email: body.email,
    password: body.password,
    options: { data: { full_name: body.full_name ?? null } },
  });

  if (error) {
    const duplicate = /already registered|already exists/i.test(error.message);
    throw new ApiError(
      duplicate ? 'DUPLICATE' : 'VALIDATION_ERROR',
      duplicate ? 'That email is already registered.' : error.message,
    );
  }
  if (!data.user) {
    throw new ApiError('INTERNAL_ERROR', 'Sign-up did not return a user.');
  }

  // The on_auth_user_created trigger inserts the profile row; enrich it here.
  const admin = supabaseAdmin();
  const referredBy = body.referral_code ? await resolveReferrer(body.referral_code) : null;

  await admin
    .from('users')
    .update({
      ...(body.full_name ? { full_name: body.full_name } : {}),
      ...(body.country ? { country: body.country } : {}),
      ...(referredBy && referredBy !== data.user.id ? { referred_by: referredBy } : {}),
      referral_code: generateReferralCode(),
    })
    .eq('id', data.user.id);

  const { data: profile } = await admin
    .from('users')
    .select('id, email, role, kyc_status, wallet_address, full_name, country, referral_code, created_at')
    .eq('id', data.user.id)
    .maybeSingle<DbUser>();

  return ok({
    user: profile ?? { id: data.user.id, email: body.email, role: 'trader', kyc_status: 'not_submitted' },
    session: data.session
      ? {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: data.session.expires_at ?? null,
        }
      : null,
    email_confirmation_required: !data.session,
  });
});
```

## `src/app/api/auth/login/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { supabaseAdmin, supabaseAnon } from '@/lib/supabase';
import { loginSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/auth/login */
export const POST = handle(async (req) => {
  const body = loginSchema.parse(await readJson(req));

  const { data, error } = await supabaseAnon().auth.signInWithPassword({
    email: body.email,
    password: body.password,
  });

  if (error || !data.session || !data.user) {
    throw new ApiError('UNAUTHORIZED', 'Invalid email or password.');
  }

  const { data: profile } = await supabaseAdmin()
    .from('users')
    .select('id, email, role, kyc_status, wallet_address, full_name, country, created_at')
    .eq('id', data.user.id)
    .maybeSingle<DbUser>();

  return ok({
    user: profile,
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at ?? null,
    },
  });
});
```

## `src/app/api/auth/refresh/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { supabaseAnon } from '@/lib/supabase';
import { refreshSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** POST /api/auth/refresh */
export const POST = handle(async (req) => {
  const body = refreshSchema.parse(await readJson(req));

  const { data, error } = await supabaseAnon().auth.refreshSession({
    refresh_token: body.refresh_token,
  });

  if (error || !data.session) {
    throw new ApiError('UNAUTHORIZED', 'Refresh token is invalid or expired.');
  }

  return ok({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at ?? null,
    },
  });
});
```

## `src/app/api/me/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { updateMeSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

function publicUser(u: DbUser) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    kyc_status: u.kyc_status,
    wallet_address: u.wallet_address,
    full_name: u.full_name,
    country: u.country,
    created_at: u.created_at,
  };
}

/** GET /api/me */
export const GET = handle(async (req) => {
  const user = await requireUser(req);

  const admin = supabaseAdmin();
  const [{ count: total }, { count: active }] = await Promise.all([
    admin.from('accounts').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    admin
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('status', 'active'),
  ]);

  return ok({
    user: publicUser(user),
    accounts_count: total ?? 0,
    active_accounts: active ?? 0,
  });
});

/** PATCH /api/me */
export const PATCH = handle(async (req) => {
  const user = await requireUser(req);
  const body = updateMeSchema.parse(await readJson(req));

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update(body)
    .eq('id', user.id)
    .select('*')
    .single<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return ok({ user: publicUser(data) });
});
```

# API routes — catalog & market

## `src/app/api/pricing/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { PAYOUT_CYCLE_DAYS, PAYOUT_SPLIT_PCT, PLANS } from '@/config/pricing';
import { getSettings } from '@/lib/settings';
import { money } from '@/lib/math';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pricing
 * List prices come from src/config/pricing.ts and never change at
 * runtime. The site-wide discount and the public promo list come from
 * the X-Department settings blob, so the pricing page can show both the
 * list price and what a buyer would actually pay today.
 */
export const GET = handle(async () => {
  const { settings } = await getSettings();
  const sitePct = settings.default_discount_pct;

  const publicPromos = settings.promos
    .filter((p) => p.active)
    .filter((p) => !p.expires_at || Date.parse(`${p.expires_at}T23:59:59Z`) >= Date.now())
    .map((p) => ({
      code: p.code,
      kind: p.kind,
      value: p.value,
      plans: p.plans,
      expires_at: p.expires_at,
      note: p.note ?? null,
    }));

  return ok({
    payout_split_pct: PAYOUT_SPLIT_PCT,
    payout_cycle_days: PAYOUT_CYCLE_DAYS,
    discounts: {
      site_wide_pct: sitePct,
      referral_discount_pct: settings.referral_discount_pct,
      referral_commission_pct: settings.referral_commission_pct,
      stacking: 'best_single_discount',
    },
    promos: publicPromos,
    plans: PLANS.map((plan) => ({
      ...plan,
      /** What this plan costs today with the site-wide discount only. */
      effective_price: sitePct > 0 ? money(plan.price * (1 - sitePct / 100)) : plan.price,
    })),
  });
});
```

## `src/app/api/market/symbols/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { listSymbols, TOP_50_USDT_PAIRS } from '@/config/symbols';

export const revalidate = 3600;

/** GET /api/market/symbols */
export const GET = handle(async () =>
  ok({ count: TOP_50_USDT_PAIRS.length, symbols: listSymbols() }),
);
```

## `src/app/api/market/prices/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { getPrices } from '@/lib/binance';
import { bidAsk } from '@/lib/math';
import { SPREAD_BPS } from '@/config/pricing';
import { TOP_50_USDT_PAIRS } from '@/config/symbols';

export const dynamic = 'force-dynamic';

/** GET /api/market/prices?symbols=BTCUSDT,ETHUSDT */
export const GET = handle(async (req) => {
  const url = new URL(req.url);
  const raw = url.searchParams.get('symbols');
  const symbols = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...TOP_50_USDT_PAIRS];

  const prices = await getPrices(symbols);

  return ok({
    spread_bps: SPREAD_BPS,
    prices: Object.entries(prices).map(([symbol, price]) => ({
      symbol,
      price,
      ...bidAsk(price),
    })),
    fetched_at: new Date().toISOString(),
  });
});
```

## `src/app/api/health/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { getPrice } from '@/lib/binance';

export const dynamic = 'force-dynamic';

/** GET /api/health — liveness + upstream check for uptime monitors. */
export const GET = handle(async () => {
  const started = Date.now();

  let priceFeed: 'up' | 'down' = 'up';
  try {
    await getPrice('BTCUSDT');
  } catch {
    priceFeed = 'down';
  }

  return ok({
    status: priceFeed === 'up' ? 'healthy' : 'degraded',
    price_feed: priceFeed,
    latency_ms: Date.now() - started,
    version: '1.1.0',
    time: new Date().toISOString(),
  });
});
```

# API routes — accounts

## `src/app/api/accounts/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { serializeAccount } from '@/lib/accounts';
import type { AccountStatus, DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/accounts?status=active */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const status = new URL(req.url).searchParams.get('status') as AccountStatus | null;

  let query = supabaseAdmin()
    .from('accounts')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  return ok({ accounts: ((data ?? []) as DbAccount[]).map(serializeAccount) });
});
```

## `src/app/api/accounts/[id]/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { evaluateAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';

export const dynamic = 'force-dynamic';

/** GET /api/accounts/{id} — recomputes equity + risk before responding. */
export const GET = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser(req);
  const account = await requireAccount(ctx.params.id, user);
  const result = await evaluateAccount(account);

  return ok({
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: {
      breached: result.risk.breached,
      reason: result.risk.reason,
      status: result.risk.status,
    },
  });
});
```

## `src/app/api/accounts/[id]/equity-curve/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { getEquityCurve } from '@/lib/snapshots';

export const dynamic = 'force-dynamic';

/** GET /api/accounts/{id}/equity-curve?limit=500 */
export const GET = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser(req);
  const account = await requireAccount(ctx.params.id, user);

  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 500) || 500, 2000);
  const points = await getEquityCurve(account.id, limit);

  return ok({
    account_id: account.id,
    starting_size: Number(account.size),
    points,
  });
});
```

# API routes — trading engine

## `src/app/api/trade/open/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { assertTradable, getPrice } from '@/lib/binance';
import {
  applySpread,
  liquidationPrice,
  positionSize,
  quantity,
  toPosition,
} from '@/lib/math';
import { buildPositions, evaluateAccount, getOpenOrders } from '@/lib/engine';
import { computeMetrics, isTradable } from '@/lib/risk';
import { serializeAccount } from '@/lib/accounts';
import { openTradeSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/ratelimit';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/open
 * B-book fill: live Binance mid + 0.05% spread against the trader.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`trade-open:${user.id}`, 60, 60_000);
  const body = openTradeSchema.parse(await readJson(req));

  const account = await requireAccount(body.account_id, user);
  if (!isTradable(account)) {
    throw new ApiError(
      'ACCOUNT_NOT_TRADABLE',
      `Account status is "${account.status}" — trading is disabled.`,
    );
  }

  const symbol = assertTradable(body.symbol);
  if (body.leverage > account.max_leverage) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Leverage above the account maximum of ${account.max_leverage}x.`,
    );
  }

  // Free margin = realised balance minus margin already posted.
  const openOrders = await getOpenOrders(account.id);
  const existing = await buildPositions(openOrders);
  const preMetrics = computeMetrics(account, existing);
  if (body.margin > preMetrics.free_margin) {
    throw new ApiError(
      'INSUFFICIENT_MARGIN',
      `Margin ${body.margin} exceeds free margin ${preMetrics.free_margin}.`,
    );
  }

  const mid = await getPrice(symbol);
  const entry = applySpread(mid, body.side, 'open');
  const notional = positionSize(body.margin, body.leverage);
  const qty = quantity(notional, entry);
  const liq = liquidationPrice(entry, body.side, body.leverage);

  const { data: order, error } = await supabaseAdmin()
    .from('orders')
    .insert({
      account_id: account.id,
      user_id: user.id,
      symbol,
      side: body.side,
      leverage: body.leverage,
      margin: body.margin,
      position_size: notional,
      quantity: qty,
      entry_price: entry,
      mark_price_at_open: mid,
      liquidation_price: liq,
      take_profit: body.take_profit ?? null,
      stop_loss: body.stop_loss ?? null,
      status: 'open',
    })
    .select('*')
    .single<DbOrder>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const result = await evaluateAccount(account.id);

  return ok({
    order: toPosition(order, mid),
    account: serializeAccount(result.account),
    metrics: result.metrics,
  });
});
```

## `src/app/api/trade/close/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { applySpread, isLiquidated, money, pnlFor, pnlPct } from '@/lib/math';
import { evaluateAccount, settleOrder } from '@/lib/engine';
import { snapshotEquity } from '@/lib/snapshots';
import { serializeAccount } from '@/lib/accounts';
import { closeTradeSchema } from '@/lib/validation';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/trade/close */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = closeTradeSchema.parse(await readJson(req));

  const { data: order, error } = await supabaseAdmin()
    .from('orders')
    .select('*')
    .eq('id', body.order_id)
    .maybeSingle<DbOrder>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!order) throw new ApiError('NOT_FOUND', 'Order not found.');
  if (order.user_id !== user.id && user.role === 'trader') {
    throw new ApiError('FORBIDDEN', 'This order belongs to another user.');
  }
  if (order.status !== 'open') {
    throw new ApiError('ORDER_NOT_OPEN', 'This position is already closed.');
  }

  const mid = await getPrice(order.symbol);
  const liq = Number(order.liquidation_price);
  const hitLiq = isLiquidated(order.side, mid, liq);

  // If price already crossed the liquidation level, settle there instead —
  // the trader cannot escape a liquidation by racing the close button.
  const closePrice = hitLiq ? liq : applySpread(mid, order.side, 'close');
  const pnl = hitLiq
    ? money(-Number(order.margin))
    : pnlFor(order.side, Number(order.entry_price), closePrice, Number(order.quantity));

  const settled = await settleOrder(
    order.id,
    closePrice,
    pnl,
    hitLiq ? 'liquidated' : 'closed',
    hitLiq ? 'liquidation' : 'manual',
  );

  const result = await evaluateAccount(order.account_id);
  await snapshotEquity(
    result.account.id,
    Number(result.account.equity),
    Number(result.account.balance),
    'trade_close',
  );

  return ok({
    order: {
      id: settled.id,
      account_id: settled.account_id,
      symbol: settled.symbol,
      side: settled.side,
      leverage: settled.leverage,
      margin: Number(settled.margin),
      position_size: Number(settled.position_size),
      entry_price: Number(settled.entry_price),
      close_price: Number(settled.close_price),
      pnl: Number(settled.pnl),
      pnl_pct: pnlPct(Number(settled.pnl), Number(settled.margin)),
      status: settled.status,
      close_reason: settled.close_reason,
      created_at: settled.created_at,
      closed_at: settled.closed_at,
    },
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: {
      breached: result.risk.breached,
      reason: result.risk.reason,
      status: result.risk.status,
    },
  });
});
```

## `src/app/api/trade/partial-close/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { applySpread, isLiquidated, money, pnlFor, pnlPct } from '@/lib/math';
import { evaluateAccount, settleOrder } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { partialCloseSchema } from '@/lib/validation';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/partial-close
 * Closes a slice of an open position. The closed slice is written as its
 * own settled order row (linked via parent_order_id) so the trade history
 * and win-rate stats stay honest; the parent keeps the remainder.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = partialCloseSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: order, error } = await admin
    .from('orders')
    .select('*')
    .eq('id', body.order_id)
    .maybeSingle<DbOrder>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!order) throw new ApiError('NOT_FOUND', 'Order not found.');
  if (order.user_id !== user.id && user.role === 'trader') {
    throw new ApiError('FORBIDDEN', 'This order belongs to another user.');
  }
  if (order.status !== 'open') {
    throw new ApiError('ORDER_NOT_OPEN', 'This position is already closed.');
  }

  const mid = await getPrice(order.symbol);
  const liq = Number(order.liquidation_price);
  if (isLiquidated(order.side, mid, liq)) {
    throw new ApiError('ORDER_NOT_OPEN', 'Position is at its liquidation price — close it in full.');
  }

  const fraction = body.percent / 100;
  const closePrice = applySpread(mid, order.side, 'close');

  const sliceQty = Number(order.quantity) * fraction;
  const sliceMargin = money(Number(order.margin) * fraction);
  const sliceNotional = money(Number(order.position_size) * fraction);
  const pnl = pnlFor(order.side, Number(order.entry_price), closePrice, sliceQty);

  // 100% is just a normal close.
  if (body.percent === 100) {
    const settled = await settleOrder(order.id, closePrice, pnl, 'closed', 'manual');
    const result = await evaluateAccount(order.account_id);
    return ok({
      closed: { id: settled.id, pnl, pnl_pct: pnlPct(pnl, Number(settled.margin)), close_price: closePrice },
      remaining: null,
      account: serializeAccount(result.account),
      metrics: result.metrics,
    });
  }

  const { data: slice, error: sliceError } = await admin
    .from('orders')
    .insert({
      account_id: order.account_id,
      user_id: order.user_id,
      symbol: order.symbol,
      side: order.side,
      leverage: order.leverage,
      margin: sliceMargin,
      position_size: sliceNotional,
      quantity: sliceQty,
      entry_price: order.entry_price,
      mark_price_at_open: order.mark_price_at_open,
      liquidation_price: order.liquidation_price,
      parent_order_id: order.id,
      status: 'open',
      created_at: order.created_at,
    })
    .select('*')
    .single<DbOrder>();

  if (sliceError) throw new ApiError('INTERNAL_ERROR', sliceError.message);

  const { data: remaining, error: remainingError } = await admin
    .from('orders')
    .update({
      margin: money(Number(order.margin) - sliceMargin),
      position_size: money(Number(order.position_size) - sliceNotional),
      quantity: Number(order.quantity) - sliceQty,
    })
    .eq('id', order.id)
    .eq('status', 'open')
    .select('*')
    .single<DbOrder>();

  if (remainingError) throw new ApiError('INTERNAL_ERROR', remainingError.message);

  await settleOrder(slice.id, closePrice, pnl, 'closed', `partial_${body.percent}`);
  const result = await evaluateAccount(order.account_id);

  return ok({
    closed: {
      id: slice.id,
      percent: body.percent,
      pnl,
      pnl_pct: pnlPct(pnl, sliceMargin),
      close_price: closePrice,
    },
    remaining: {
      id: remaining.id,
      quantity: Number(remaining.quantity),
      margin: Number(remaining.margin),
      position_size: Number(remaining.position_size),
    },
    account: serializeAccount(result.account),
    metrics: result.metrics,
  });
});
```

## `src/app/api/trade/protection/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { toPosition } from '@/lib/math';
import { protectionSchema } from '@/lib/validation';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/protection
 * Attach or clear a take-profit / stop-loss on an open position.
 * Levels are validated against the side and the liquidation price, then
 * enforced by the sweep that runs on every positions poll.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = protectionSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: order, error } = await admin
    .from('orders')
    .select('*')
    .eq('id', body.order_id)
    .maybeSingle<DbOrder>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!order) throw new ApiError('NOT_FOUND', 'Order not found.');
  if (order.user_id !== user.id && user.role === 'trader') {
    throw new ApiError('FORBIDDEN', 'This order belongs to another user.');
  }
  if (order.status !== 'open') {
    throw new ApiError('ORDER_NOT_OPEN', 'This position is already closed.');
  }

  const mark = await getPrice(order.symbol);
  const long = order.side === 'long';
  const liq = Number(order.liquidation_price);

  if (body.take_profit != null) {
    const valid = long ? body.take_profit > mark : body.take_profit < mark;
    if (!valid) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Take-profit must be ${long ? 'above' : 'below'} the current price (${mark}).`,
      );
    }
  }

  if (body.stop_loss != null) {
    const valid = long ? body.stop_loss < mark : body.stop_loss > mark;
    if (!valid) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Stop-loss must be ${long ? 'below' : 'above'} the current price (${mark}).`,
      );
    }
    const beyondLiq = long ? body.stop_loss <= liq : body.stop_loss >= liq;
    if (beyondLiq) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Stop-loss sits beyond the liquidation price (${liq}) — it could never trigger.`,
      );
    }
  }

  const patch: Record<string, number | null> = {};
  if (body.take_profit !== undefined) patch.take_profit = body.take_profit;
  if (body.stop_loss !== undefined) patch.stop_loss = body.stop_loss;

  const { data: updated, error: updateError } = await admin
    .from('orders')
    .update(patch)
    .eq('id', order.id)
    .eq('status', 'open')
    .select('*')
    .single<DbOrder>();

  if (updateError) throw new ApiError('INTERNAL_ERROR', updateError.message);

  return ok({ order: toPosition(updated, mark) });
});
```

## `src/app/api/trade/positions/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { evaluateAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { accountIdSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * GET /api/trade/positions?account_id=uuid
 * Open positions with live PnL. Liquidations are swept on every call,
 * so polling this endpoint (2–5s) drives the liquidation engine.
 */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const { account_id } = accountIdSchema.parse({
    account_id: url.searchParams.get('account_id'),
  });

  const account = await requireAccount(account_id, user);
  const result = await evaluateAccount(account);

  return ok({
    positions: result.positions,
    liquidated: result.liquidated,
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: {
      breached: result.risk.breached,
      reason: result.risk.reason,
      status: result.risk.status,
    },
  });
});
```

## `src/app/api/trade/history/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { money, pct, pnlPct } from '@/lib/math';
import { accountIdSchema, paginationSchema } from '@/lib/validation';
import type { DbOrder, OrderStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/trade/history?account_id=uuid&limit=50&offset=0&status=closed */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);

  const { account_id } = accountIdSchema.parse({
    account_id: url.searchParams.get('account_id'),
  });
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  const status = url.searchParams.get('status') as OrderStatus | null;

  await requireAccount(account_id, user);

  let query = supabaseAdmin()
    .from('orders')
    .select('*', { count: 'exact' })
    .eq('account_id', account_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  else query = query.in('status', ['closed', 'liquidated']);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const orders = (data ?? []) as DbOrder[];

  // Aggregate stats over the whole account, not just this page.
  const { data: allClosed } = await supabaseAdmin()
    .from('orders')
    .select('pnl')
    .eq('account_id', account_id)
    .in('status', ['closed', 'liquidated']);

  const closedRows = (allClosed ?? []) as Array<{ pnl: number | null }>;
  const pnls: number[] = closedRows.map((r) => Number(r.pnl ?? 0));
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p <= 0).length;

  return ok({
    orders: orders.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      leverage: o.leverage,
      margin: Number(o.margin),
      position_size: Number(o.position_size),
      quantity: Number(o.quantity),
      entry_price: Number(o.entry_price),
      close_price: o.close_price === null ? null : Number(o.close_price),
      pnl: o.pnl === null ? null : Number(o.pnl),
      pnl_pct: o.pnl === null ? null : pnlPct(Number(o.pnl), Number(o.margin)),
      status: o.status,
      close_reason: o.close_reason,
      created_at: o.created_at,
      closed_at: o.closed_at,
    })),
    total: count ?? orders.length,
    limit,
    offset,
    stats: {
      trades: pnls.length,
      wins,
      losses,
      win_rate: pnls.length ? pct((wins / pnls.length) * 100) : 0,
      net_pnl: money(pnls.reduce((s: number, p: number) => s + p, 0)),
    },
  });
});
```

# API routes — risk & cron

## `src/app/api/risk/evaluate/route.ts`

```typescript
import { handle, ok, readJson } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { evaluateAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { accountIdSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** POST /api/risk/evaluate */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const { account_id } = accountIdSchema.parse(await readJson(req));

  const account = await requireAccount(account_id, user);
  const result = await evaluateAccount(account);

  return ok({
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: result.risk,
  });
});
```

## `src/app/api/cron/daily-reset/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireCronSecret } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { snapshotEquity } from '@/lib/snapshots';
import type { DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/cron/daily-reset   (header: x-cron-secret)
 * Run at 00:00 UTC. Rolls the daily drawdown floor forward and writes an
 * end-of-day equity snapshot for each active account.
 */
export const POST = handle(async (req) => {
  requireCronSecret(req);
  const admin = supabaseAdmin();
  const resetAt = new Date().toISOString();

  const { data, error } = await admin
    .from('accounts')
    .select('id, equity, balance, status')
    .in('status', ['active', 'passed']);

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  const accounts = (data ?? []) as Pick<DbAccount, 'id' | 'equity' | 'balance' | 'status'>[];

  let reset = 0;
  for (const account of accounts) {
    await snapshotEquity(account.id, Number(account.equity), Number(account.balance), 'daily_close');

    const { error: updateError } = await admin
      .from('accounts')
      .update({ daily_start_balance: Number(account.equity), daily_reset_at: resetAt })
      .eq('id', account.id);

    if (!updateError) reset += 1;
  }

  return ok({ accounts_reset: reset, reset_at: resetAt });
});
```

# API routes — payments

## `src/app/api/checkout/route.ts`

```typescript
import { ApiError, handle, ok, readJson, requireEnv } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { createInvoice, newOrderId } from '@/lib/nowpayments';
import { getPlan } from '@/config/pricing';
import { quoteCheckout } from '@/lib/promos';
import { checkoutSchema } from '@/lib/validation';
import { withIdempotency } from '@/lib/idempotency';
import { rateLimit } from '@/lib/ratelimit';
import type { DbTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/checkout
 * Creates a pending purchase + a NOWPayments invoice.
 * The account itself is only created by the IPN once funds confirm.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`checkout:${user.id}`, 10, 60_000);

  const body = checkoutSchema.parse(await readJson(req));
  const plan = getPlan(body.plan_key);
  if (!plan) throw new ApiError('VALIDATION_ERROR', 'Unknown plan.');

  return withIdempotency(req, user.id, 'checkout', async () => {
    const orderId = newOrderId();
    const appUrl = requireEnv('NEXT_PUBLIC_APP_URL');

    // Discounts come from the X-Department settings blob. The plan's list
    // price is never modified — only what we invoice.
    const quote = await quoteCheckout(plan, user, body.promo_code);

    const { data: tx, error } = await supabaseAdmin()
      .from('transactions')
      .insert({
        user_id: user.id,
        amount: quote.final_price,
        currency: 'USD',
        type: 'purchase',
        status: 'pending',
        nowpayments_order_id: orderId,
        metadata: {
          plan_key: plan.key,
          account_type: plan.type,
          size: plan.size,
          pay_currency: body.pay_currency ?? null,
          list_price: quote.list_price,
          discount: quote.discount,
          discount_source: quote.source,
          promo_code: quote.promo_code,
        },
      })
      .select('*')
      .single<DbTransaction>();

    if (error) throw new ApiError('INTERNAL_ERROR', error.message);

    const invoice = await createInvoice({
      amount: quote.final_price,
      order_id: orderId,
      order_description: `SOGDIA ${plan.label}`,
      pay_currency: body.pay_currency,
      ipn_callback_url: `${appUrl}/api/webhook/nowpayments`,
      success_url: `${appUrl}/checkout/success?order=${orderId}`,
      cancel_url: `${appUrl}/checkout/cancelled?order=${orderId}`,
    });

    await supabaseAdmin()
      .from('transactions')
      .update({
        metadata: { ...(tx.metadata as object), invoice_id: invoice.id, invoice_url: invoice.invoice_url },
      })
      .eq('id', tx.id);

    return {
      transaction_id: tx.id,
      order_id: orderId,
      invoice_url: invoice.invoice_url,
      amount: quote.final_price,
      pricing: {
        list_price: quote.list_price,
        discount: quote.discount,
        final_price: quote.final_price,
        source: quote.source,
        promo_code: quote.promo_code,
        label: quote.label,
      },
      plan: { key: plan.key, label: plan.label, size: plan.size, price: plan.price },
    };
  }).then(ok);
});
```

## `src/app/api/webhook/nowpayments/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { isDead, isPaid, verifyIpnSignature } from '@/lib/nowpayments';
import { createAccountFromPlan } from '@/lib/accounts';
import { getPlan } from '@/config/pricing';
import { notify } from '@/lib/notifications';
import { creditReferral } from '@/lib/referrals';
import type { DbTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface IpnPayload {
  payment_id?: string | number;
  payment_status?: string;
  order_id?: string;
  price_amount?: number;
  actually_paid?: number;
  pay_currency?: string;
  outcome_amount?: number;
}

/**
 * POST /api/webhook/nowpayments
 * Signature-verified, idempotent on payment_id. Creates the trader's
 * account the moment funds confirm.
 */
export const POST = handle(async (req) => {
  const raw = await req.text();
  const signature = req.headers.get('x-nowpayments-sig');

  if (!verifyIpnSignature(raw, signature)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid IPN signature.');
  }

  const payload = JSON.parse(raw) as IpnPayload;
  const orderId = payload.order_id;
  const paymentId = payload.payment_id ? String(payload.payment_id) : null;
  const status = payload.payment_status ?? 'waiting';

  if (!orderId) throw new ApiError('VALIDATION_ERROR', 'Missing order_id.');

  const admin = supabaseAdmin();

  const { data: tx, error } = await admin
    .from('transactions')
    .select('*')
    .eq('nowpayments_order_id', orderId)
    .maybeSingle<DbTransaction>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!tx) throw new ApiError('NOT_FOUND', 'Unknown order_id.');

  // Replay protection: a paid transaction never gets reprocessed.
  if (tx.status === 'paid') {
    return ok({ received: true, account_created: false, account_id: tx.account_id, replay: true });
  }

  const metadata = {
    ...(tx.metadata as Record<string, unknown>),
    last_status: status,
    actually_paid: payload.actually_paid ?? null,
    pay_currency: payload.pay_currency ?? null,
    outcome_amount: payload.outcome_amount ?? null,
  };

  if (isDead(status)) {
    await admin
      .from('transactions')
      .update({ status: 'failed', nowpayments_payment_id: paymentId, metadata })
      .eq('id', tx.id);
    return ok({ received: true, account_created: false, account_id: null });
  }

  if (!isPaid(status)) {
    await admin
      .from('transactions')
      .update({ nowpayments_payment_id: paymentId, metadata })
      .eq('id', tx.id);
    return ok({ received: true, account_created: false, account_id: null });
  }

  // ---- Payment confirmed: provision the account ----
  const planKey = String((tx.metadata as Record<string, unknown>).plan_key ?? '');
  const plan = getPlan(planKey);
  if (!plan) throw new ApiError('INTERNAL_ERROR', `Transaction references unknown plan "${planKey}".`);

  const account = await createAccountFromPlan(tx.user_id, plan);

  await admin
    .from('transactions')
    .update({
      status: 'paid',
      account_id: account.id,
      nowpayments_payment_id: paymentId,
      metadata,
    })
    .eq('id', tx.id);

  await notify(
    tx.user_id,
    'account_created',
    `${plan.label} is live`,
    `Your ${plan.label} account has been funded with $${plan.size.toLocaleString()} of virtual capital. Good luck.`,
    { account_id: account.id, plan_key: plan.key },
  );

  await creditReferral(tx.user_id, tx.id, Number(tx.amount));

  return ok({ received: true, account_created: true, account_id: account.id });
});
```

## `src/app/api/promos/validate/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getPlan } from '@/config/pricing';
import { checkPromo, promoRejectionMessage, quoteCheckout } from '@/lib/promos';

export const dynamic = 'force-dynamic';

/**
 * GET /api/promos/validate?code=WELCOME10&plan_key=one_step_10k
 * Price preview for the checkout screen. Never creates anything.
 */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);

  const planKey = url.searchParams.get('plan_key');
  const code = url.searchParams.get('code');

  if (!planKey) throw new ApiError('VALIDATION_ERROR', 'plan_key is required.');
  const plan = getPlan(planKey);
  if (!plan) throw new ApiError('VALIDATION_ERROR', 'Unknown plan_key.');

  // No code: just show whatever discount the user already qualifies for.
  if (!code) {
    const quote = await quoteCheckout(plan, user, null);
    return ok({ valid: true, promo_code: null, reason: null, quote });
  }

  const check = await checkPromo(code, plan.key);
  if (!check.ok) {
    return ok({
      valid: false,
      promo_code: code.trim().toUpperCase(),
      reason: check.reason,
      message: promoRejectionMessage(check.reason ?? 'UNKNOWN_CODE'),
      quote: await quoteCheckout(plan, user, null),
    });
  }

  const quote = await quoteCheckout(plan, user, code);
  return ok({ valid: true, promo_code: check.promo?.code ?? null, reason: null, quote });
});
```

# API routes — KYC & payouts

## `src/app/api/kyc/upload/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

const BUCKET = 'kyc-documents';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const SIGNED_URL_TTL = 3600;

/**
 * POST /api/kyc/upload   (multipart/form-data: file, doc_type?)
 * Stores the document in a private bucket under <user_id>/ and flips
 * the user's KYC status to `pending` for admin review.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`kyc:${user.id}`, 5, 60 * 60_000);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Expected multipart/form-data.');
  }

  const file = form.get('file');
  const docType = String(form.get('doc_type') ?? 'id_document');

  if (!(file instanceof File)) {
    throw new ApiError('VALIDATION_ERROR', 'Field "file" is required.');
  }
  if (!ALLOWED.includes(file.type)) {
    throw new ApiError('VALIDATION_ERROR', 'File must be JPG, PNG, WEBP or PDF.');
  }
  if (file.size > MAX_BYTES) {
    throw new ApiError('VALIDATION_ERROR', 'File must be 5 MB or smaller.');
  }

  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
  const path = `${user.id}/${docType}-${Date.now()}.${ext}`;
  const admin = supabaseAdmin();

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });

  if (uploadError) throw new ApiError('INTERNAL_ERROR', uploadError.message);

  const { data: signed } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);

  await admin
    .from('users')
    .update({ kyc_status: 'pending', kyc_document_url: path, kyc_note: null })
    .eq('id', user.id);

  return ok({
    path,
    signed_url: signed?.signedUrl ?? null,
    expires_in: SIGNED_URL_TTL,
    kyc_status: 'pending',
  });
});
```

## `src/app/api/kyc/status/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** GET /api/kyc/status */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  return ok({
    kyc_status: user.kyc_status,
    document_url: user.kyc_document_url,
    note: user.kyc_note,
  });
});
```

## `src/app/api/payouts/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getOpenOrders } from '@/lib/engine';
import { evaluatePayoutEligibility, getTradingStats, splitPayout } from '@/lib/payouts';
import { notify } from '@/lib/notifications';
import { payoutRequestSchema } from '@/lib/validation';
import type { DbTransaction, TransactionStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/payouts?status=pending */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const status = new URL(req.url).searchParams.get('status') as TransactionStatus | null;

  let query = supabaseAdmin()
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .in('type', ['payout', 'commission'])
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  return ok({
    transactions: ((data ?? []) as DbTransaction[]).map((t) => ({
      ...t,
      amount: Number(t.amount),
      net_amount: t.net_amount === null ? null : Number(t.net_amount),
    })),
  });
});

/** POST /api/payouts — request a withdrawal of realised profit. */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = payoutRequestSchema.parse(await readJson(req));
  const account = await requireAccount(body.account_id, user);

  const [openOrders, stats] = await Promise.all([
    getOpenOrders(account.id),
    getTradingStats(account.id),
  ]);
  const eligibility = evaluatePayoutEligibility(user, account, openOrders.length, stats);

  if (!eligibility.eligible) {
    if (eligibility.reasons.includes('KYC_NOT_VERIFIED')) {
      throw new ApiError('KYC_REQUIRED', 'Complete KYC verification before requesting a payout.');
    }
    throw new ApiError(
      'PAYOUT_NOT_ELIGIBLE',
      'This account is not eligible for a payout yet.',
      eligibility.reasons,
    );
  }

  const gross = body.amount ?? eligibility.profit;
  if (gross > eligibility.profit) {
    throw new ApiError(
      'PAYOUT_NOT_ELIGIBLE',
      `Requested ${gross} exceeds withdrawable profit ${eligibility.profit}.`,
    );
  }

  const split = splitPayout(gross, Number(account.payout_split_pct));

  const { data, error } = await supabaseAdmin()
    .from('transactions')
    .insert({
      user_id: user.id,
      account_id: account.id,
      amount: split.gross,
      net_amount: split.net,
      type: 'payout',
      status: 'pending',
      wallet_address: user.wallet_address,
      metadata: { split_pct: split.split_pct, firm_fee: split.firm_fee },
    })
    .select('*')
    .single<DbTransaction>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  await notify(
    user.id,
    'payout_requested',
    'Payout requested',
    `Your payout request of $${split.net} (80% of $${split.gross}) is under review.`,
    { transaction_id: data.id, account_id: account.id },
  );

  return ok({
    transaction: {
      ...data,
      amount: Number(data.amount),
      net_amount: Number(data.net_amount),
    },
  });
});
```

## `src/app/api/payouts/eligibility/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { getOpenOrders } from '@/lib/engine';
import { evaluatePayoutEligibility, getTradingStats } from '@/lib/payouts';
import { accountIdSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** GET /api/payouts/eligibility?account_id=uuid */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const { account_id } = accountIdSchema.parse({
    account_id: url.searchParams.get('account_id'),
  });

  const account = await requireAccount(account_id, user);
  const [openOrders, stats] = await Promise.all([
    getOpenOrders(account.id),
    getTradingStats(account.id),
  ]);

  return ok(evaluatePayoutEligibility(user, account, openOrders.length, stats));
});
```

# API routes — certificates & OG images

## `src/app/api/certificates/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { certificateImageUrl } from '@/lib/certificates';
import type { DbCertificate } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/certificates?account_id=uuid */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const accountId = new URL(req.url).searchParams.get('account_id');

  let query = supabaseAdmin()
    .from('certificates')
    .select('*')
    .eq('user_id', user.id)
    .order('issued_at', { ascending: false });

  if (accountId) query = query.eq('account_id', accountId);

  const { data, error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  return ok({
    certificates: ((data ?? []) as DbCertificate[]).map((c) => ({
      ...c,
      amount: Number(c.amount),
      image_url: certificateImageUrl(c.id),
    })),
  });
});
```

## `src/app/api/og/trade/[id]/route.tsx`

```tsx
import { ImageResponse } from 'next/og';
import { supabaseAdmin } from '@/lib/supabase';
import { pnlPct } from '@/lib/math';
import type { DbOrder } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BRAND = '#00E08F';
const LOSS = '#FF4D6D';
const BG = '#070B10';

function fmt(n: number, dp = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** GET /api/og/trade/{id} -> image/png (1200x630) */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const { data } = await supabaseAdmin()
    .from('orders')
    .select('*')
    .eq('id', ctx.params.id)
    .maybeSingle<DbOrder>();

  if (!data) {
    return new ImageResponse(
      (
        <div
          style={{
            width: '100%', height: '100%', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: BG, color: '#9AA7B4', fontSize: 44,
          }}
        >
          Trade not found
        </div>
      ),
      { width: 1200, height: 630 },
    );
  }

  const isLong = data.side === 'long';
  const entry = Number(data.entry_price);
  const close = data.close_price === null ? null : Number(data.close_price);
  const pnl = data.pnl === null ? null : Number(data.pnl);
  const roi = pnl === null ? null : pnlPct(pnl, Number(data.margin));
  const positive = (roi ?? 0) >= 0;
  const accent = positive ? BRAND : LOSS;

  const rows: Array<[string, string]> = [
    ['Entry', `$${fmt(entry, entry < 10 ? 6 : 2)}`],
    [close === null ? 'Mark' : 'Exit', close === null ? '—' : `$${fmt(close, close < 10 ? 6 : 2)}`],
    ['Margin', `$${fmt(Number(data.margin))}`],
    ['Size', `$${fmt(Number(data.position_size))}`],
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
          background: BG, padding: 64, color: '#FFFFFF',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          backgroundImage: `radial-gradient(900px 420px at 85% -10%, ${accent}22, transparent)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, background: BRAND,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: BG, fontSize: 26, fontWeight: 800,
            }}>S</div>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 6 }}>SOGDIA</div>
          </div>
          <div style={{
            display: 'flex', fontSize: 22, color: '#8A99A8',
            border: '1px solid #1C2733', borderRadius: 999, padding: '10px 22px',
          }}>
            {data.status === 'liquidated' ? 'LIQUIDATED' : data.status === 'open' ? 'OPEN' : 'CLOSED'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 56 }}>
          <div style={{ fontSize: 76, fontWeight: 800 }}>{data.symbol}</div>
          <div style={{
            display: 'flex', background: isLong ? `${BRAND}1F` : `${LOSS}1F`,
            color: isLong ? BRAND : LOSS, borderRadius: 10,
            padding: '10px 20px', fontSize: 28, fontWeight: 700,
          }}>
            {isLong ? 'LONG' : 'SHORT'} {data.leverage}x
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, marginTop: 24 }}>
          <div style={{ fontSize: 132, fontWeight: 800, color: accent, lineHeight: 1 }}>
            {roi === null ? '—' : `${positive ? '+' : ''}${fmt(roi)}%`}
          </div>
          {pnl !== null && (
            <div style={{ fontSize: 40, color: accent, paddingBottom: 18 }}>
              {positive ? '+' : '−'}${fmt(Math.abs(pnl))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 56, marginTop: 'auto' }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 22, color: '#6E7D8C', letterSpacing: 1 }}>{label.toUpperCase()}</div>
              <div style={{ fontSize: 34, fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        'cache-control':
          data.status === 'open' ? 'no-store' : 'public, max-age=300, s-maxage=3600',
      },
    },
  );
}
```

## `src/app/api/og/certificate/[id]/route.tsx`

```tsx
import { ImageResponse } from 'next/og';
import { supabaseAdmin } from '@/lib/supabase';
import type { DbCertificate } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BRAND = '#00E08F';
const BG = '#070B10';

function fmtUsd(n: number) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** GET /api/og/certificate/{id} -> image/png (1200x850) */
export async function GET(_req: Request, ctx: { params: { id: string } }) {
  const { data } = await supabaseAdmin()
    .from('certificates')
    .select('*, accounts(size, type, plan_key)')
    .eq('id', ctx.params.id)
    .maybeSingle<DbCertificate & { accounts: { size: number; type: string; plan_key: string | null } | null }>();

  if (!data) {
    return new ImageResponse(
      (
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: BG, color: '#9AA7B4', fontSize: 44,
        }}>
          Certificate not found
        </div>
      ),
      { width: 1200, height: 850 },
    );
  }

  const isPayout = data.type === 'payout';
  const title = isPayout ? 'CERTIFICATE OF PAYOUT' : 'CERTIFICATE OF ACHIEVEMENT';
  const caption = isPayout
    ? 'has successfully withdrawn profits from a SOGDIA funded account'
    : 'has successfully passed the SOGDIA evaluation and earned a funded account';

  const issued = new Date(data.issued_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const accountSize = data.accounts?.size ? Number(data.accounts.size) : null;

  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', background: BG, color: '#FFFFFF', padding: 56,
        fontFamily: 'ui-serif, Georgia, serif',
        backgroundImage: `radial-gradient(800px 500px at 50% -15%, ${BRAND}1A, transparent)`,
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          width: '100%', height: '100%', border: `2px solid ${BRAND}55`,
          borderRadius: 24, padding: 56,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10, background: BRAND,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: BG, fontSize: 24, fontWeight: 800,
            }}>S</div>
            <div style={{ fontSize: 28, letterSpacing: 8, fontWeight: 700 }}>SOGDIA</div>
          </div>

          <div style={{ fontSize: 26, letterSpacing: 6, color: BRAND, marginTop: 34 }}>{title}</div>
          <div style={{ fontSize: 20, color: '#7D8B99', marginTop: 10 }}>This certifies that</div>

          <div style={{
            fontSize: 72, fontWeight: 700, marginTop: 18,
            borderBottom: `1px solid ${BRAND}44`, paddingBottom: 18,
          }}>
            {data.display_name ?? 'SOGDIA Trader'}
          </div>

          <div style={{ fontSize: 24, color: '#9AA7B4', marginTop: 26, textAlign: 'center', maxWidth: 820 }}>
            {caption}
          </div>

          <div style={{ display: 'flex', gap: 80, marginTop: 44 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: 18, color: '#6E7D8C', letterSpacing: 2 }}>
                {isPayout ? 'AMOUNT PAID' : 'ACCOUNT SIZE'}
              </div>
              <div style={{ fontSize: 56, fontWeight: 700, color: BRAND, marginTop: 8 }}>
                {fmtUsd(Number(data.amount))}
              </div>
            </div>
            {accountSize !== null && isPayout && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: 18, color: '#6E7D8C', letterSpacing: 2 }}>ACCOUNT</div>
                <div style={{ fontSize: 56, fontWeight: 700, marginTop: 8 }}>
                  ${(accountSize / 1000).toFixed(0)}K
                </div>
              </div>
            )}
          </div>

          <div style={{
            display: 'flex', justifyContent: 'space-between', width: '100%',
            marginTop: 'auto', fontSize: 20, color: '#6E7D8C',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          }}>
            <div style={{ display: 'flex' }}>Issued {issued}</div>
            <div style={{ display: 'flex' }}>Verification code · {data.code}</div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 850,
      headers: { 'cache-control': 'public, max-age=600, s-maxage=86400' },
    },
  );
}
```

# API routes — community

## `src/app/api/leaderboard/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { pct } from '@/lib/math';
import type { AccountType } from '@/config/pricing';

export const revalidate = 60;

interface Row {
  id: string;
  size: number;
  balance: number;
  type: AccountType;
  status: string;
  created_at: string;
  users: { full_name: string | null; country: string | null } | null;
}

function anonymize(name: string | null, index: number): string {
  if (!name) return `Trader #${index + 1}`;
  const [first, ...rest] = name.trim().split(/\s+/);
  const initial = rest.length ? `${rest[rest.length - 1][0]}.` : '';
  return `${first} ${initial}`.trim();
}

/**
 * GET /api/leaderboard?type=one_step&limit=25
 * Public ranking by realised return on the account. Names are shortened
 * to "First L." — no emails, no account ids.
 */
export const GET = handle(async (req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type') as AccountType | null;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);

  let query = supabaseAdmin()
    .from('accounts')
    .select('id, size, balance, type, status, created_at, users(full_name, country)')
    .in('status', ['active', 'passed'])
    .limit(500);

  if (type) query = query.eq('type', type);

  const { data, error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const ranked = ((data ?? []) as unknown as Row[])
    .map((row) => ({
      size: Number(row.size),
      return_pct: pct(((Number(row.balance) - Number(row.size)) / Number(row.size)) * 100),
      type: row.type,
      status: row.status,
      country: row.users?.country ?? null,
      name: row.users?.full_name ?? null,
      since: row.created_at,
    }))
    .filter((r) => r.return_pct > 0)
    .sort((a, b) => b.return_pct - a.return_pct)
    .slice(0, limit)
    .map((r, i) => ({
      rank: i + 1,
      trader: anonymize(r.name, i),
      country: r.country,
      account_size: r.size,
      type: r.type,
      return_pct: r.return_pct,
      status: r.status,
      since: r.since,
    }));

  return ok({ leaderboard: ranked, updated_at: new Date().toISOString() });
});
```

## `src/app/api/referrals/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { ensureReferralCode } from '@/lib/referrals';
import { getSettings } from '@/lib/settings';
import { money } from '@/lib/math';

export const dynamic = 'force-dynamic';

/** GET /api/referrals — the caller's affiliate code, signups and commissions. */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const code = await ensureReferralCode(user);
  const { settings } = await getSettings();
  const admin = supabaseAdmin();

  const [{ count: signups }, { data: commissions, error }] = await Promise.all([
    admin.from('users').select('id', { count: 'exact', head: true }).eq('referred_by', user.id),
    admin
      .from('transactions')
      .select('amount, status, created_at')
      .eq('user_id', user.id)
      .eq('type', 'commission')
      .order('created_at', { ascending: false }),
  ]);

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (commissions ?? []) as Array<{ amount: number; status: string; created_at: string }>;
  const total = money(rows.reduce((s, r) => s + Number(r.amount), 0));
  const paid = money(
    rows.filter((r) => r.status === 'paid').reduce((s, r) => s + Number(r.amount), 0),
  );

  return ok({
    referral_code: code,
    commission_pct: settings.referral_commission_pct,
    friend_discount_pct: settings.referral_discount_pct,
    signups: signups ?? 0,
    earned_total: total,
    earned_paid: paid,
    earned_pending: money(total - paid),
    history: rows,
  });
});
```

## `src/app/api/notifications/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { paginationSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** GET /api/notifications?unread=true&limit=&offset= */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  let query = supabaseAdmin()
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (url.searchParams.get('unread') === 'true') query = query.is('read_at', null);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const { count: unread } = await supabaseAdmin()
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .is('read_at', null);

  return ok({ notifications: data ?? [], unread: unread ?? 0, total: count ?? 0, limit, offset });
});

/** POST /api/notifications — mark read. Body: { ids?: uuid[], all?: boolean } */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = (await readJson(req)) as { ids?: string[]; all?: boolean };

  let query = supabaseAdmin()
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('read_at', null);

  if (!body.all) {
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'Provide ids[] or all:true.');
    }
    query = query.in('id', body.ids);
  }

  const { error } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  return ok({ marked_read: true });
});
```

# API routes — admin

## `src/app/api/admin/users/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { paginationSchema } from '@/lib/validation';
import type { DbUser, KycStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/admin/users?query=&kyc_status=&role=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  const search = url.searchParams.get('query');
  const kycStatus = url.searchParams.get('kyc_status') as KycStatus | null;
  const role = url.searchParams.get('role');

  let query = supabaseAdmin()
    .from('users')
    .select('*, accounts(count)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
  if (kycStatus) query = query.eq('kyc_status', kycStatus);
  if (role) query = query.eq('role', role);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<DbUser & { accounts: Array<{ count: number }> }>;

  return ok({
    users: rows.map(({ accounts, ...u }) => ({
      ...u,
      accounts_count: accounts?.[0]?.count ?? 0,
    })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});
```

## `src/app/api/admin/accounts/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { serializeAccount } from '@/lib/accounts';
import { paginationSchema } from '@/lib/validation';
import type { AccountStatus, DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/admin/accounts?status=&user_id=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  const status = url.searchParams.get('status') as AccountStatus | null;
  const userId = url.searchParams.get('user_id');

  let query = supabaseAdmin()
    .from('accounts')
    .select('*, users(email, full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  if (userId) query = query.eq('user_id', userId);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<DbAccount & { users: { email: string; full_name: string | null } | null }>;

  return ok({
    accounts: rows.map(({ users, ...a }) => ({
      ...serializeAccount(a),
      user_email: users?.email ?? null,
      user_name: users?.full_name ?? null,
    })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});
```

## `src/app/api/admin/accounts/[id]/status/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { forceCloseAll, getAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { adminAccountStatusSchema } from '@/lib/validation';
import type { AccountStatus, DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';

const NEXT_STATUS: Record<string, AccountStatus> = {
  freeze: 'frozen',
  unfreeze: 'active',
  breach: 'breached',
  close: 'closed',
};

/**
 * POST /api/admin/accounts/{id}/status
 * Freeze, restore, breach (illegal/abusive trading) or close an account.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireStaff(req);
  const body = adminAccountStatusSchema.parse(await readJson(req));

  const account = await getAccount(ctx.params.id);
  const nextStatus = NEXT_STATUS[body.action];

  if (body.action === 'unfreeze' && account.status !== 'frozen') {
    throw new ApiError('VALIDATION_ERROR', 'Only a frozen account can be unfrozen.');
  }

  let closedOrders = 0;
  if ((body.action === 'breach' || body.action === 'close') && body.close_positions) {
    closedOrders = await forceCloseAll(account.id, body.action);
  }

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .update({
      status: nextStatus,
      breach_reason: body.action === 'unfreeze' ? null : body.reason ?? account.breach_reason,
    })
    .eq('id', account.id)
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  await audit(
    staff,
    `account.${body.action}` as 'account.freeze',
    { type: 'account', id: account.id },
    { reason: body.reason ?? null, closed_orders: closedOrders, from: account.status, to: nextStatus },
    req,
  );

  await notify(
    account.user_id,
    body.action === 'unfreeze' ? 'admin_action' : 'account_failed',
    `Account ${nextStatus}`,
    body.reason ?? `Your account status changed to ${nextStatus}.`,
    { account_id: account.id },
  );

  return ok({ account: serializeAccount(data), closed_orders: closedOrders });
});
```

## `src/app/api/admin/kyc/[userId]/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { adminKycSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/admin/kyc/{userId} — approve or reject a KYC submission. */
export const POST = handle(async (req: Request, ctx: { params: { userId: string } }) => {
  const staff = await requireStaff(req);
  const body = adminKycSchema.parse(await readJson(req));
  const approved = body.action === 'approve';

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update({
      kyc_status: approved ? 'verified' : 'rejected',
      kyc_note: body.note ?? null,
    })
    .eq('id', ctx.params.userId)
    .select('*')
    .maybeSingle<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'User not found.');

  await audit(
    staff,
    approved ? 'kyc.approve' : 'kyc.reject',
    { type: 'user', id: data.id },
    { note: body.note ?? null },
    req,
  );

  await notify(
    data.id,
    approved ? 'kyc_verified' : 'kyc_rejected',
    approved ? 'KYC verified' : 'KYC rejected',
    approved
      ? 'Your identity is verified. Payouts are now available.'
      : body.note ?? 'Your KYC submission was rejected. Please re-upload a clear document.',
  );

  return ok({
    user: {
      id: data.id,
      email: data.email,
      role: data.role,
      kyc_status: data.kyc_status,
      kyc_note: data.kyc_note,
      wallet_address: data.wallet_address,
      full_name: data.full_name,
      country: data.country,
      created_at: data.created_at,
    },
  });
});
```

## `src/app/api/admin/payouts/[id]/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { getAccount } from '@/lib/engine';
import { issueCertificate } from '@/lib/certificates';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { money } from '@/lib/math';
import { adminPayoutSchema } from '@/lib/validation';
import type { DbTransaction, TransactionStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/payouts/{id}
 * approve | reject | mark_paid. `mark_paid` debits the gross profit from
 * the account, rolls the payout cycle and issues a payout certificate.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireStaff(req);
  const body = adminPayoutSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: tx, error } = await admin
    .from('transactions')
    .select('*')
    .eq('id', ctx.params.id)
    .maybeSingle<DbTransaction>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!tx) throw new ApiError('NOT_FOUND', 'Transaction not found.');
  if (tx.type !== 'payout' && tx.type !== 'commission') {
    throw new ApiError('VALIDATION_ERROR', 'This transaction is not a payout.');
  }
  if (tx.status === 'paid') {
    throw new ApiError('DUPLICATE', 'This payout is already settled.');
  }

  const nextStatus: TransactionStatus =
    body.action === 'approve' ? 'approved' : body.action === 'reject' ? 'rejected' : 'paid';

  let certificateId: string | null = null;

  if (body.action === 'mark_paid' && tx.account_id) {
    const account = await getAccount(tx.account_id);
    const gross = Number(tx.amount);
    const now = new Date();
    const nextPayout = new Date(now.getTime() + account.payout_cycle_days * 86_400_000);

    const { error: accError } = await admin
      .from('accounts')
      .update({
        balance: money(Number(account.balance) - gross),
        equity: money(Number(account.equity) - gross),
        daily_start_balance: money(Number(account.daily_start_balance) - gross),
        last_payout_at: now.toISOString(),
        next_payout_at: nextPayout.toISOString(),
      })
      .eq('id', account.id);

    if (accError) throw new ApiError('INTERNAL_ERROR', accError.message);

    const certificate = await issueCertificate({
      user_id: tx.user_id,
      account_id: account.id,
      type: 'payout',
      amount: Number(tx.net_amount ?? tx.amount),
      is_manual: false,
      issued_by: staff.id,
      metadata: { transaction_id: tx.id, gross, split_pct: Number(account.payout_split_pct) },
    });
    certificateId = certificate.id;
  }

  const { data: updated, error: updateError } = await admin
    .from('transactions')
    .update({
      status: nextStatus,
      tx_hash: body.tx_hash ?? tx.tx_hash,
      admin_note: body.note ?? tx.admin_note,
    })
    .eq('id', tx.id)
    .select('*')
    .single<DbTransaction>();

  if (updateError) throw new ApiError('INTERNAL_ERROR', updateError.message);

  await audit(
    staff,
    body.action === 'mark_paid' ? 'payout.paid' : `payout.${body.action}` as 'payout.approve',
    { type: 'transaction', id: tx.id },
    { note: body.note ?? null, tx_hash: body.tx_hash ?? null, amount: Number(tx.amount) },
    req,
  );

  await notify(
    tx.user_id,
    body.action === 'reject' ? 'payout_rejected' : 'payout_paid',
    body.action === 'reject' ? 'Payout rejected' : `Payout ${nextStatus}`,
    body.action === 'reject'
      ? body.note ?? 'Your payout request was rejected.'
      : `Your payout of $${Number(tx.net_amount ?? tx.amount)} is ${nextStatus}.`,
    { transaction_id: tx.id, tx_hash: body.tx_hash ?? null },
  );

  return ok({
    transaction: {
      ...updated,
      amount: Number(updated.amount),
      net_amount: updated.net_amount === null ? null : Number(updated.net_amount),
    },
    certificate_id: certificateId,
  });
});
```

## `src/app/api/admin/certificates/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { certificateImageUrl, issueCertificate } from '@/lib/certificates';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { adminCertificateSchema, paginationSchema } from '@/lib/validation';
import type { DbCertificate } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/admin/certificates?user_id=&type=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  let query = supabaseAdmin()
    .from('certificates')
    .select('*, users(email, full_name)', { count: 'exact' })
    .order('issued_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const userId = url.searchParams.get('user_id');
  const type = url.searchParams.get('type');
  if (userId) query = query.eq('user_id', userId);
  if (type) query = query.eq('type', type);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<DbCertificate & { users: { email: string } | null }>;

  return ok({
    certificates: rows.map(({ users, ...c }) => ({
      ...c,
      amount: Number(c.amount),
      user_email: users?.email ?? null,
      image_url: certificateImageUrl(c.id),
    })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});

/** POST /api/admin/certificates — manual issuance. */
export const POST = handle(async (req) => {
  const staff = await requireStaff(req);
  const body = adminCertificateSchema.parse(await readJson(req));

  const certificate = await issueCertificate({
    user_id: body.user_id,
    account_id: body.account_id ?? null,
    type: body.type,
    amount: body.amount,
    display_name: body.display_name,
    is_manual: true,
    issued_by: staff.id,
    metadata: { issued_via: 'admin_panel' },
  });

  await audit(
    staff,
    'certificate.manual',
    { type: 'certificate', id: certificate.id },
    { user_id: body.user_id, type: body.type, amount: body.amount },
    req,
  );

  await notify(
    body.user_id,
    'certificate_issued',
    'New certificate issued',
    `A ${body.type === 'payout' ? 'payout' : 'evaluation'} certificate has been added to your profile.`,
    { certificate_id: certificate.id },
  );

  return ok({
    certificate: { ...certificate, amount: Number(certificate.amount) },
    image_url: certificateImageUrl(certificate.id),
  });
});
```

## `src/app/api/admin/stats/route.ts`

```typescript
import { handle, ok } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { money } from '@/lib/math';
import type { AccountStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/admin/stats — operations dashboard. */
export const GET = handle(async (req) => {
  await requireStaff(req);
  const admin = supabaseAdmin();

  const statuses: AccountStatus[] = ['active', 'passed', 'failed', 'frozen', 'breached', 'closed'];

  const [
    usersRes,
    accountRes,
    revenueRes,
    paidRes,
    pendingPayoutRes,
    kycRes,
    openRes,
  ] = await Promise.all([
    admin.from('users').select('id', { count: 'exact', head: true }),
    admin.from('accounts').select('status'),
    admin.from('transactions').select('amount').eq('type', 'purchase').eq('status', 'paid'),
    admin.from('transactions').select('net_amount').eq('type', 'payout').eq('status', 'paid'),
    admin
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'payout')
      .eq('status', 'pending'),
    admin.from('users').select('id', { count: 'exact', head: true }).eq('kyc_status', 'pending'),
    admin.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);

  const accounts = Object.fromEntries(statuses.map((s) => [s, 0])) as Record<AccountStatus, number>;
  for (const row of (accountRes.data ?? []) as Array<{ status: AccountStatus }>) {
    accounts[row.status] = (accounts[row.status] ?? 0) + 1;
  }

  const revenue = money(
    ((revenueRes.data ?? []) as Array<{ amount: number }>).reduce((s, r) => s + Number(r.amount), 0),
  );
  const payoutsPaid = money(
    ((paidRes.data ?? []) as Array<{ net_amount: number | null }>).reduce(
      (s, r) => s + Number(r.net_amount ?? 0),
      0,
    ),
  );

  return ok({
    users: usersRes.count ?? 0,
    accounts,
    revenue_usd: revenue,
    payouts_paid_usd: payoutsPaid,
    payouts_pending: pendingPayoutRes.count ?? 0,
    kyc_pending: kycRes.count ?? 0,
    open_positions: openRes.count ?? 0,
  });
});
```

# API routes — X-Department

## `src/app/api/xdepartment/accounts/gift/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { provisionAccount, serializeAccount } from '@/lib/accounts';
import { getPlan } from '@/config/pricing';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { giftAccountSchema } from '@/lib/validation';
import type { DbAccount, DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/accounts/gift
 *
 * Provision one or more accounts to any user, free of charge — test
 * accounts, comped accounts, influencer accounts, competition prizes,
 * goodwill replacements. Any plan, or a fully custom size and rule-set.
 * Pricing is never touched: nothing here writes to the price table.
 */
export const POST = handle(async (req) => {
  const staff = await requireXDepartment(req);
  const body = giftAccountSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  // Resolve the recipient by id or email.
  let recipient: DbUser | null = null;
  if (body.user_id) {
    const { data } = await admin.from('users').select('*').eq('id', body.user_id).maybeSingle<DbUser>();
    recipient = data;
  } else if (body.email) {
    const { data } = await admin
      .from('users')
      .select('*')
      .ilike('email', body.email)
      .maybeSingle<DbUser>();
    recipient = data;
  }
  if (!recipient) throw new ApiError('NOT_FOUND', 'Recipient not found.');

  // Plan-based or fully custom.
  const plan = body.plan_key ? getPlan(body.plan_key) : null;
  if (body.plan_key && !plan) throw new ApiError('VALIDATION_ERROR', 'Unknown plan_key.');

  const spec = plan
    ? { type: plan.type, size: plan.size, plan_key: plan.key }
    : { type: body.custom!.type, size: body.custom!.size, plan_key: null };

  const created: DbAccount[] = [];
  for (let i = 0; i < body.quantity; i += 1) {
    const account = await provisionAccount(recipient.id, {
      ...spec,
      is_gifted: true,
      rules: body.rules,
    });
    created.push(account);

    // A zero-cost transaction keeps the ledger complete and auditable.
    await admin.from('transactions').insert({
      user_id: recipient.id,
      account_id: account.id,
      amount: 0,
      type: 'adjustment',
      status: 'paid',
      admin_note: body.reason ?? 'X-Department gifted account',
      metadata: {
        gifted: true,
        granted_by: staff.id,
        plan_key: spec.plan_key,
        size: spec.size,
        rules: body.rules ?? null,
      },
    });

    await audit(
      staff,
      'account.gift',
      { type: 'account', id: account.id },
      {
        recipient: recipient.id,
        recipient_email: recipient.email,
        plan_key: spec.plan_key,
        size: spec.size,
        rules: body.rules ?? null,
        reason: body.reason ?? null,
      },
      req,
    );
  }

  const label = plan?.label ?? `${spec.type === 'one_step' ? 'One-Step' : 'Instant'} $${spec.size.toLocaleString()}`;
  await notify(
    recipient.id,
    'account_gifted',
    body.quantity > 1 ? `${body.quantity} accounts added` : `${label} account added`,
    body.reason ?? `SOGDIA has credited you with a ${label} account. It is live and ready to trade.`,
    { account_ids: created.map((a) => a.id) },
  );

  return ok({
    granted: created.length,
    recipient: { id: recipient.id, email: recipient.email },
    accounts: created.map(serializeAccount),
  });
});
```

## `src/app/api/xdepartment/accounts/[id]/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { getAccount } from '@/lib/engine';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/xdepartment/accounts/{id}
 * Hard delete. Cascades to the account's orders and detaches its
 * transactions and certificates. Irreversible — prefer `close` unless
 * you are cleaning up test data.
 */
export const DELETE = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const account = await getAccount(ctx.params.id);

  const { error } = await supabaseAdmin().from('accounts').delete().eq('id', account.id);
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  await audit(
    staff,
    'account.delete',
    { type: 'account', id: account.id },
    {
      user_id: account.user_id,
      size: Number(account.size),
      balance: Number(account.balance),
      plan_key: account.plan_key,
      was_gifted: account.is_gifted,
    },
    req,
  );

  return ok({ deleted: true, account_id: account.id });
});
```

## `src/app/api/xdepartment/accounts/[id]/adjust/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { forceCloseAll, getAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { snapshotEquity } from '@/lib/snapshots';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { money } from '@/lib/math';
import { adjustAccountSchema } from '@/lib/validation';
import type { DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/accounts/{id}/adjust
 *
 * Unrestricted account surgery: set or shift the balance, change size,
 * force any status, reset the drawdown floors, clear a breach, rewrite
 * the rule-set. Every field is optional; everything is audit-logged.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = adjustAccountSchema.parse(await readJson(req));

  const account = await getAccount(ctx.params.id);
  const patch: Record<string, unknown> = {};

  let closedOrders = 0;
  if (body.close_positions) {
    closedOrders = await forceCloseAll(account.id, 'admin');
  }

  const current = closedOrders > 0 ? await getAccount(account.id) : account;
  let balance = Number(current.balance);

  if (body.set_balance !== undefined) balance = money(body.set_balance);
  if (body.balance_delta !== undefined) balance = money(balance + body.balance_delta);
  if (balance < 0) throw new ApiError('VALIDATION_ERROR', 'Resulting balance would be negative.');

  if (body.set_balance !== undefined || body.balance_delta !== undefined) {
    patch.balance = balance;
    patch.equity = balance; // positions were either flat or re-marked on next evaluate
  }

  if (body.set_size !== undefined) patch.size = body.set_size;
  if (body.set_status) patch.status = body.set_status;
  if (body.clear_breach) patch.breach_reason = null;

  // Reset the daily floor (and the max-DD anchor when asked) to the new balance.
  if (body.reset_daily_start || body.reset_drawdown) patch.daily_start_balance = balance;
  if (body.reset_drawdown) {
    patch.daily_reset_at = new Date().toISOString();
    patch.breach_reason = null;
    if (!body.set_status) patch.status = 'active';
  }

  if (body.rules) Object.assign(patch, body.rules);

  if (Object.keys(patch).length === 0 && closedOrders === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Nothing to adjust.');
  }

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .update(patch)
    .eq('id', account.id)
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  await snapshotEquity(data.id, Number(data.equity), Number(data.balance), 'manual');

  await audit(
    staff,
    body.rules ? 'account.rules_override' : 'account.adjust',
    { type: 'account', id: account.id },
    {
      before: {
        balance: Number(account.balance),
        size: Number(account.size),
        status: account.status,
      },
      patch,
      closed_orders: closedOrders,
      reason: body.reason ?? null,
    },
    req,
  );

  if (body.reason) {
    await notify(account.user_id, 'admin_action', 'Account updated', body.reason, {
      account_id: account.id,
    });
  }

  return ok({ account: serializeAccount(data), closed_orders: closedOrders });
});
```

## `src/app/api/xdepartment/users/[id]/role/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { setRoleSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/users/{id}/role
 * Promote or demote any user, including granting X-Department clearance.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = setRoleSchema.parse(await readJson(req));

  if (ctx.params.id === staff.id && body.role !== 'xdepartment') {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Refusing to demote yourself — have another X-Department member do it.',
    );
  }

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update({ role: body.role })
    .eq('id', ctx.params.id)
    .select('*')
    .maybeSingle<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'User not found.');

  await audit(
    staff,
    'user.role_change',
    { type: 'user', id: data.id },
    { to: body.role, email: data.email, reason: body.reason ?? null },
    req,
  );

  await notify(data.id, 'admin_action', 'Account role updated', `Your role is now "${body.role}".`);

  return ok({ user: { id: data.id, email: data.email, role: data.role } });
});
```

## `src/app/api/xdepartment/users/[id]/kyc/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import { forceKycSchema } from '@/lib/validation';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/users/{id}/kyc
 * Force any KYC state, including resetting a verified user back to
 * not_submitted. Bypasses the normal approve/reject flow.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = forceKycSchema.parse(await readJson(req));

  const { data, error } = await supabaseAdmin()
    .from('users')
    .update({ kyc_status: body.kyc_status, kyc_note: body.note ?? null })
    .eq('id', ctx.params.id)
    .select('*')
    .maybeSingle<DbUser>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'User not found.');

  await audit(
    staff,
    'kyc.force',
    { type: 'user', id: data.id },
    { kyc_status: body.kyc_status, note: body.note ?? null },
    req,
  );

  return ok({ user: { id: data.id, email: data.email, kyc_status: data.kyc_status } });
});
```

## `src/app/api/xdepartment/payouts/[id]/force/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { getAccount } from '@/lib/engine';
import { money } from '@/lib/math';
import { audit } from '@/lib/audit';
import { forcePayoutSchema } from '@/lib/validation';
import type { DbTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/payouts/{id}/force
 * Set any payout to any state, regardless of the normal workflow —
 * including re-opening a settled payout or paying one that the standard
 * eligibility rules would block. `skip_balance_debit` leaves the trading
 * balance untouched when correcting a mistake.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = forcePayoutSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: tx, error } = await admin
    .from('transactions')
    .select('*')
    .eq('id', ctx.params.id)
    .maybeSingle<DbTransaction>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!tx) throw new ApiError('NOT_FOUND', 'Transaction not found.');

  let debited = false;
  if (body.status === 'paid' && tx.status !== 'paid' && tx.account_id && !body.skip_balance_debit) {
    const account = await getAccount(tx.account_id);
    const gross = Number(tx.amount);
    const now = new Date();

    await admin
      .from('accounts')
      .update({
        balance: money(Number(account.balance) - gross),
        equity: money(Number(account.equity) - gross),
        daily_start_balance: money(Number(account.daily_start_balance) - gross),
        last_payout_at: now.toISOString(),
        next_payout_at: new Date(
          now.getTime() + account.payout_cycle_days * 86_400_000,
        ).toISOString(),
      })
      .eq('id', account.id);

    debited = true;
  }

  const { data: updated, error: updateError } = await admin
    .from('transactions')
    .update({
      status: body.status,
      tx_hash: body.tx_hash ?? tx.tx_hash,
      admin_note: body.note ?? tx.admin_note,
      metadata: { ...(tx.metadata as object), forced_by: staff.id, forced_at: new Date().toISOString() },
    })
    .eq('id', tx.id)
    .select('*')
    .single<DbTransaction>();

  if (updateError) throw new ApiError('INTERNAL_ERROR', updateError.message);

  await audit(
    staff,
    'payout.force',
    { type: 'transaction', id: tx.id },
    { from: tx.status, to: body.status, debited, note: body.note ?? null },
    req,
  );

  return ok({
    transaction: {
      ...updated,
      amount: Number(updated.amount),
      net_amount: updated.net_amount === null ? null : Number(updated.net_amount),
    },
    balance_debited: debited,
  });
});
```

## `src/app/api/xdepartment/impersonate/[userId]/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { audit } from '@/lib/audit';
import type { DbUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/impersonate/{userId}
 *
 * Mints a one-time sign-in token for support/debugging. The frontend
 * exchanges `token_hash` via supabase.auth.verifyOtp({ type: 'magiclink' })
 * to obtain that user's session. Always audit-logged, and the target is
 * notified — impersonation is powerful, not secret.
 */
export const POST = handle(async (req: Request, ctx: { params: { userId: string } }) => {
  const staff = await requireXDepartment(req);
  const admin = supabaseAdmin();

  const { data: target } = await admin
    .from('users')
    .select('*')
    .eq('id', ctx.params.userId)
    .maybeSingle<DbUser>();

  if (!target) throw new ApiError('NOT_FOUND', 'User not found.');

  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: target.email,
  });

  if (error || !data?.properties) {
    throw new ApiError('INTERNAL_ERROR', error?.message ?? 'Could not mint an impersonation token.');
  }

  await audit(
    staff,
    'user.impersonate',
    { type: 'user', id: target.id },
    { email: target.email },
    req,
  );

  return ok({
    user: { id: target.id, email: target.email, role: target.role },
    token_hash: data.properties.hashed_token,
    action_link: data.properties.action_link,
    expires_in: 3600,
  });
});
```

## `src/app/api/xdepartment/settings/route.ts`

```typescript
import { handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { getSettings, parseSettings, saveSettings, serializeSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_RAW } from '@/config/settings';
import { audit } from '@/lib/audit';
import { settingsSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * GET /api/xdepartment/settings
 * Returns the raw blob for the textarea, plus the parsed form and the
 * shipped defaults so the UI can offer a "reset" button.
 */
export const GET = handle(async (req) => {
  await requireXDepartment(req);
  const current = await getSettings();

  return ok({
    raw: current.raw,
    parsed: current.settings,
    version: current.version,
    updated_at: current.updated_at,
    updated_by: current.updated_by,
    default_raw: DEFAULT_SETTINGS_RAW,
    default_parsed: DEFAULT_SETTINGS,
  });
});

/**
 * PUT /api/xdepartment/settings
 * Saves the whole document. Parse failures return every problem with a
 * line number, and nothing is written. `validate_only: true` is a dry run.
 */
export const PUT = handle(async (req) => {
  const staff = await requireXDepartment(req);
  const body = settingsSchema.parse(await readJson(req));

  if (body.validate_only) {
    const { settings, warnings } = parseSettings(body.raw);
    return ok({
      valid: true,
      validate_only: true,
      parsed: settings,
      warnings,
      normalized_raw: serializeSettings(settings),
    });
  }

  const before = await getSettings();
  const saved = await saveSettings(body.raw, staff.id);

  await audit(
    staff,
    'settings.update',
    { type: 'settings', id: 'global' },
    {
      version: saved.version,
      reason: body.reason ?? null,
      before: before.settings,
      after: saved.settings,
    },
    req,
  );

  return ok({
    valid: true,
    raw: saved.raw,
    parsed: saved.settings,
    version: saved.version,
    updated_at: saved.updated_at,
    warnings: saved.warnings,
    normalized_raw: serializeSettings(saved.settings),
  });
});
```

## `src/app/api/xdepartment/promos/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { getSettings } from '@/lib/settings';
import { findPromo, promoStatus, promoUses, writePromo } from '@/lib/promos';
import { audit } from '@/lib/audit';
import { promoCreateSchema } from '@/lib/validation';
import type { Promo } from '@/config/settings';

export const dynamic = 'force-dynamic';

/**
 * GET /api/xdepartment/promos
 * Every promo in the settings document, with redemption counts.
 */
export const GET = handle(async (req) => {
  await requireXDepartment(req);
  const { settings, version } = await getSettings();

  const promos = await Promise.all(
    settings.promos.map(async (promo) => {
      const uses = await promoUses(promo.code);
      return {
        ...promo,
        note: promo.note ?? null,
        uses,
        remaining: promo.max_uses > 0 ? Math.max(promo.max_uses - uses, 0) : null,
        status: promoStatus(promo, uses),
      };
    }),
  );

  return ok({ promos, count: promos.length, settings_version: version });
});

/**
 * POST /api/xdepartment/promos
 * Create a promo. Adds one line to the settings document — comments and
 * the rest of the file are left exactly as they were.
 */
export const POST = handle(async (req) => {
  const staff = await requireXDepartment(req);
  const body = promoCreateSchema.parse(await readJson(req));

  if (await findPromo(body.code)) {
    throw new ApiError('DUPLICATE', `Promo ${body.code} already exists.`);
  }
  if (body.kind === 'percent' && body.value > 90) {
    throw new ApiError('VALIDATION_ERROR', 'Percent discounts are capped at 90%.');
  }

  const promo: Promo = {
    code: body.code,
    kind: body.kind,
    value: body.value,
    plans: body.plans,
    expires_at: body.expires_at,
    max_uses: body.max_uses,
    active: body.active,
    ...(body.note ? { note: body.note } : {}),
  };

  const result = await writePromo(promo.code, promo, staff.id);

  await audit(
    staff,
    'promo.create',
    { type: 'promo', id: promo.code },
    { promo, reason: body.reason ?? null, settings_version: result.version },
    req,
  );

  return ok({
    promo: { ...promo, note: promo.note ?? null, uses: 0, remaining: promo.max_uses || null, status: promoStatus(promo, 0) },
    settings_version: result.version,
    raw: result.raw,
  });
});
```

## `src/app/api/xdepartment/promos/[code]/route.ts`

```typescript
import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { mergePromo } from '@/lib/settings';
import { findPromo, promoStatus, promoUses, writePromo } from '@/lib/promos';
import { audit } from '@/lib/audit';
import { promoUpdateSchema } from '@/lib/validation';
import type { Promo } from '@/config/settings';

export const dynamic = 'force-dynamic';

async function load(code: string): Promise<Promo> {
  const promo = await findPromo(code);
  if (!promo) throw new ApiError('NOT_FOUND', `Promo ${code.toUpperCase()} does not exist.`);
  return promo;
}

/** GET /api/xdepartment/promos/{code} */
export const GET = handle(async (req: Request, ctx: { params: { code: string } }) => {
  await requireXDepartment(req);
  const promo = await load(ctx.params.code);
  const uses = await promoUses(promo.code);

  return ok({
    promo: {
      ...promo,
      note: promo.note ?? null,
      uses,
      remaining: promo.max_uses > 0 ? Math.max(promo.max_uses - uses, 0) : null,
      status: promoStatus(promo, uses),
    },
  });
});

/**
 * PATCH /api/xdepartment/promos/{code}
 * Change any field. The code itself is immutable — redemptions already
 * reference it; delete and recreate if you need a different code.
 */
export const PATCH = handle(async (req: Request, ctx: { params: { code: string } }) => {
  const staff = await requireXDepartment(req);
  const body = promoUpdateSchema.parse(await readJson(req));
  const current = await load(ctx.params.code);

  const next = mergePromo(current, {
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
    ...(body.value !== undefined ? { value: body.value } : {}),
    ...(body.plans !== undefined ? { plans: body.plans } : {}),
    ...(body.expires_at !== undefined ? { expires_at: body.expires_at } : {}),
    ...(body.max_uses !== undefined ? { max_uses: body.max_uses } : {}),
    ...(body.active !== undefined ? { active: body.active } : {}),
    ...(body.note !== undefined ? { note: body.note ?? undefined } : {}),
  });

  if (next.kind === 'percent' && next.value > 90) {
    throw new ApiError('VALIDATION_ERROR', 'Percent discounts are capped at 90%.');
  }

  const result = await writePromo(current.code, next, staff.id);
  const uses = await promoUses(next.code);

  await audit(
    staff,
    'promo.update',
    { type: 'promo', id: current.code },
    { before: current, after: next, reason: body.reason ?? null, settings_version: result.version },
    req,
  );

  return ok({
    promo: {
      ...next,
      note: next.note ?? null,
      uses,
      remaining: next.max_uses > 0 ? Math.max(next.max_uses - uses, 0) : null,
      status: promoStatus(next, uses),
    },
    settings_version: result.version,
  });
});

/**
 * DELETE /api/xdepartment/promos/{code}
 * Removes the line from the settings document. Past redemptions keep
 * their recorded code on the transaction, so revenue history is intact —
 * but the code stops working immediately and nothing remembers its terms.
 * To pause a promo instead, PATCH it with `active: false`.
 */
export const DELETE = handle(async (req: Request, ctx: { params: { code: string } }) => {
  const staff = await requireXDepartment(req);
  const promo = await load(ctx.params.code);
  const uses = await promoUses(promo.code);

  const result = await writePromo(promo.code, null, staff.id);

  await audit(
    staff,
    'promo.delete',
    { type: 'promo', id: promo.code },
    { promo, redemptions: uses, settings_version: result.version },
    req,
  );

  return ok({
    deleted: true,
    code: promo.code,
    redemptions: uses,
    settings_version: result.version,
    remaining_promos: result.promos.length,
  });
});
```

## `src/app/api/xdepartment/audit/route.ts`

```typescript
import { ApiError, handle, ok } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { paginationSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** GET /api/xdepartment/audit?actor_id=&action=&target_id=&limit=&offset= */
export const GET = handle(async (req) => {
  await requireXDepartment(req);
  const url = new URL(req.url);
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });

  let query = supabaseAdmin()
    .from('audit_logs')
    .select('*, users!audit_logs_actor_id_fkey(email)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const actorId = url.searchParams.get('actor_id');
  const action = url.searchParams.get('action');
  const targetId = url.searchParams.get('target_id');
  if (actorId) query = query.eq('actor_id', actorId);
  if (action) query = query.eq('action', action);
  if (targetId) query = query.eq('target_id', targetId);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const rows = (data ?? []) as Array<Record<string, unknown> & { users: { email: string } | null }>;

  return ok({
    logs: rows.map(({ users, ...row }) => ({ ...row, actor_email: users?.email ?? null })),
    total: count ?? rows.length,
    limit,
    offset,
  });
});
```
