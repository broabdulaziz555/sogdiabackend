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
