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

  // Claim the transaction atomically BEFORE creating anything. NOWPayments often sends "confirmed" and
  // "finished" back to back; without the claim both deliveries pass the check above and the buyer gets two accounts.
  const { data: claimed, error: claimErr } = await admin
    .from('transactions')
    .update({ status: 'paid', nowpayments_payment_id: paymentId, metadata })
    .eq('id', tx.id)
    .neq('status', 'paid')
    .select('id')
    .maybeSingle<{ id: string }>();

  if (claimErr) throw new ApiError('INTERNAL_ERROR', claimErr.message);
  if (!claimed) {
    return ok({ received: true, account_created: false, account_id: null, replay: true });
  }

  let account;
  try {
    account = await createAccountFromPlan(tx.user_id, plan);
  } catch (err) {
    // Hand the claim back and answer 5xx so NOWPayments retries the notification.
    await admin.from('transactions').update({ status: tx.status }).eq('id', tx.id);
    throw err;
  }

  const { error: linkErr } = await admin
    .from('transactions')
    .update({ account_id: account.id })
    .eq('id', tx.id);
  if (linkErr) console.error('[ipn] could not link account to transaction', tx.id, linkErr.message);

  // The buyer already has the account; a failed notification or referral credit must not make the webhook retry.
  try {
    await notify(
      tx.user_id,
      'account_created',
      `${plan.label} is live`,
      `Your ${plan.label} account has been funded with $${plan.size.toLocaleString()} of virtual capital. Good luck.`,
      { account_id: account.id, plan_key: plan.key },
    );
    await creditReferral(tx.user_id, tx.id, Number(tx.amount));
  } catch (err) {
    console.error('[ipn] post-purchase step failed', tx.id, err);
  }

  return ok({ received: true, account_created: true, account_id: account.id });
});
