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

  const check = await checkPromo(code, plan.key, user.id);
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
