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
