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

export function promoStatus(
  promo: Promo,
  uses: number,
): 'active' | 'inactive' | 'expired' | 'exhausted' {
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

/**
 * An open invoice counts against a limit for this long. NOWPayments
 * invoices resolve or expire well inside this window, and the webhook
 * marks dead ones `failed`, so a stale pending cannot block a code
 * forever.
 */
const PENDING_HOLD_MS = 2 * 60 * 60 * 1000;

/** Redemptions that count: paid, plus invoices still open. */
function countsAsRedemption(query: ReturnType<ReturnType<typeof supabaseAdmin>['from']>) {
  const since = new Date(Date.now() - PENDING_HOLD_MS).toISOString();
  return (query as any).or(`status.eq.paid,and(status.eq.pending,created_at.gte.${since})`);
}

/** How many times a promo has been redeemed, across all customers. */
export async function promoUses(code: string): Promise<number> {
  const base = supabaseAdmin()
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'purchase')
    .eq('metadata->>promo_code', code.toUpperCase());

  const { count } = await countsAsRedemption(base);
  return count ?? 0;
}

/** How many times ONE customer has redeemed a promo. */
export async function promoUsesByUser(code: string, userId: string): Promise<number> {
  const base = supabaseAdmin()
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'purchase')
    .eq('user_id', userId)
    .eq('metadata->>promo_code', code.toUpperCase());

  const { count } = await countsAsRedemption(base);
  return count ?? 0;
}

export type PromoRejection =
  | 'UNKNOWN_CODE'
  | 'INACTIVE'
  | 'EXPIRED'
  | 'PLAN_NOT_ELIGIBLE'
  | 'LIMIT_REACHED'
  | 'USER_LIMIT_REACHED';

export interface PromoCheck {
  ok: boolean;
  promo: Promo | null;
  reason: PromoRejection | null;
  uses: number;
  user_uses: number;
}

/**
 * Validate a code against a plan without charging anything.
 *
 * `userId` is needed to enforce `max_per_user`. Omit it only where no
 * customer is in scope (an admin listing, say) — the per-user cap is
 * then not evaluated.
 */
export async function checkPromo(
  code: string,
  planKey: string,
  userId?: string,
): Promise<PromoCheck> {
  const { settings } = await getSettings();
  const wanted = code.trim().toUpperCase();
  const promo = settings.promos.find((p) => p.code === wanted) ?? null;

  const miss = (reason: PromoRejection): PromoCheck => ({
    ok: false,
    promo,
    reason,
    uses: 0,
    user_uses: 0,
  });

  if (!promo) return { ...miss('UNKNOWN_CODE'), promo: null };
  if (!promo.active) return miss('INACTIVE');

  if (promo.expires_at) {
    // Expiry is end-of-day UTC on the stated date.
    const expiresAt = Date.parse(`${promo.expires_at}T23:59:59Z`);
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      return miss('EXPIRED');
    }
  }

  if (promo.plans !== 'all' && !promo.plans.includes(planKey)) {
    return miss('PLAN_NOT_ELIGIBLE');
  }

  // Per-customer cap first: "you have already used this" is a more
  // useful message than "this code is exhausted".
  let userUses = 0;
  if (promo.max_per_user > 0 && userId) {
    userUses = await promoUsesByUser(promo.code, userId);
    if (userUses >= promo.max_per_user) {
      return { ok: false, promo, reason: 'USER_LIMIT_REACHED', uses: 0, user_uses: userUses };
    }
  }

  const uses = promo.max_uses > 0 ? await promoUses(promo.code) : 0;
  if (promo.max_uses > 0 && uses >= promo.max_uses) {
    return { ok: false, promo, reason: 'LIMIT_REACHED', uses, user_uses: userUses };
  }

  return { ok: true, promo, reason: null, uses, user_uses: userUses };
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
    case 'USER_LIMIT_REACHED':
      return 'You have already used that promo code.';
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
    const check = await checkPromo(promoCode, plan.key, user.id);
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
