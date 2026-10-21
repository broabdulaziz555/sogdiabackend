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
