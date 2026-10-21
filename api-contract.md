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
