import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { getAccount } from '@/lib/engine';
import { money } from '@/lib/math';
import { audit } from '@/lib/audit';
import { forcePayoutSchema } from '@/lib/validation';
import type { DbTransaction } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/xdepartment/payouts/{id}/force
 * Set any payout to any state, regardless of the normal workflow —
 * including re-opening a settled payout or paying one that the standard
 * eligibility rules would block. `skip_balance_debit` leaves the trading
 * balance untouched when correcting a mistake.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = forcePayoutSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: tx, error } = await admin
    .from('transactions')
    .select('*')
    .eq('id', ctx.params.id)
    .maybeSingle<DbTransaction>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!tx) throw new ApiError('NOT_FOUND', 'Transaction not found.');

  let debited = false;
  if (body.status === 'paid' && tx.status !== 'paid' && tx.account_id && !body.skip_balance_debit) {
    const account = await getAccount(tx.account_id);
    const gross = Number(tx.amount);
    const now = new Date();

    await admin
      .from('accounts')
      .update({
        balance: money(Number(account.balance) - gross),
        equity: money(Number(account.equity) - gross),
        daily_start_balance: money(Number(account.daily_start_balance) - gross),
        last_payout_at: now.toISOString(),
        next_payout_at: new Date(
          now.getTime() + account.payout_cycle_days * 86_400_000,
        ).toISOString(),
      })
      .eq('id', account.id);

    debited = true;
  }

  const { data: updated, error: updateError } = await admin
    .from('transactions')
    .update({
      status: body.status,
      tx_hash: body.tx_hash ?? tx.tx_hash,
      admin_note: body.note ?? tx.admin_note,
      metadata: { ...(tx.metadata as object), forced_by: staff.id, forced_at: new Date().toISOString() },
    })
    .eq('id', tx.id)
    .select('*')
    .single<DbTransaction>();

  if (updateError) throw new ApiError('INTERNAL_ERROR', updateError.message);

  await audit(
    staff,
    'payout.force',
    { type: 'transaction', id: tx.id },
    { from: tx.status, to: body.status, debited, note: body.note ?? null },
    req,
  );

  return ok({
    transaction: {
      ...updated,
      amount: Number(updated.amount),
      net_amount: updated.net_amount === null ? null : Number(updated.net_amount),
    },
    balance_debited: debited,
  });
});
