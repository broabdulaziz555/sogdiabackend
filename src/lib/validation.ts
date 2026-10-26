import { z } from 'zod';
import { CERTIFICATE_TYPES } from '@/lib/certificateCopy';
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
  /** Client-generated order id: makes the request safe to repeat (see lib/trading.ts). */
  order_id: z.string().uuid().optional(),
  symbol: z.string().trim().toUpperCase().min(5).max(20),
  side: z.enum(['long', 'short']),
  leverage: z.number().int().min(MIN_LEVERAGE).max(MAX_LEVERAGE),
  margin: z.number().positive().max(1_000_000),
  take_profit: z.number().positive().nullable().optional(),
  stop_loss: z.number().positive().nullable().optional(),
});

export const pendingSchema = z.object({
  id: z.string().uuid().optional(),
  account_id: z.string().uuid(),
  symbol: z.string().trim().toUpperCase().min(5).max(20),
  side: z.enum(['long', 'short']),
  kind: z.enum(['limit', 'stop']),
  trigger_price: z.number().positive(),
  leverage: z.number().int().min(MIN_LEVERAGE).max(MAX_LEVERAGE),
  margin: z.number().positive().max(1_000_000),
  take_profit: z.number().positive().nullable().optional(),
  stop_loss: z.number().positive().nullable().optional(),
});

export const cancelPendingSchema = z.object({
  id: z.string().uuid(),
  account_id: z.string().uuid(),
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
  max_per_user: z.number().int().min(0).max(1000).optional().default(0),
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
    max_per_user: z.number().int().min(0).max(1000).optional(),
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
  type: z.enum(CERTIFICATE_TYPES),
  amount: z.number().nonnegative().max(10_000_000),
  display_name: z.string().trim().min(2).max(80).optional(),
  // certificate builder overrides (all optional; the type's default wording is used otherwise)
  title: z.string().trim().max(60).optional(),
  caption: z.string().trim().max(200).optional(),
  amount_label: z.string().trim().max(30).optional(),
  hide_amount: z.boolean().optional(),
  issued_at: z.string().datetime({ offset: true }).optional(),
  notify: z.boolean().optional(),
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
