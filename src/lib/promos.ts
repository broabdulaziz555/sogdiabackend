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
