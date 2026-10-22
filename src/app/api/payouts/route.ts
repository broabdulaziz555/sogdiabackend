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

  // One open request per account: a double click or a second request must not pay the same profit twice.
  const { count: pendingCount } = await supabaseAdmin()
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', account.id)
    .eq('type', 'payout')
    .eq('status', 'pending');
  if ((pendingCount ?? 0) > 0) {
    throw new ApiError('PAYOUT_NOT_ELIGIBLE', 'A payout request for this account is already under review.');
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
