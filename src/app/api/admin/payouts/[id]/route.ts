import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { getAccount } from '@/lib/engine';
import { issueCertificate } from '@/lib/certificates';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { money } from '@/lib/math';
import { adminPayoutSchema } from '@/lib/validation';
import type { DbTransaction, TransactionStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/payouts/{id}
 * approve | reject | mark_paid. `mark_paid` debits the gross profit from
 * the account, rolls the payout cycle and issues a payout certificate.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireStaff(req);
  const body = adminPayoutSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: tx, error } = await admin
    .from('transactions')
    .select('*')
    .eq('id', ctx.params.id)
    .maybeSingle<DbTransaction>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!tx) throw new ApiError('NOT_FOUND', 'Transaction not found.');
  if (tx.type !== 'payout' && tx.type !== 'commission') {
    throw new ApiError('VALIDATION_ERROR', 'This transaction is not a payout.');
  }
  if (tx.status === 'paid') {
    throw new ApiError('DUPLICATE', 'This payout is already settled.');
  }

  const nextStatus: TransactionStatus =
    body.action === 'approve' ? 'approved' : body.action === 'reject' ? 'rejected' : 'paid';

  let certificateId: string | null = null;

  if (body.action === 'mark_paid' && tx.account_id) {
    const account = await getAccount(tx.account_id);
    const gross = Number(tx.amount);
    const now = new Date();
    const nextPayout = new Date(now.getTime() + account.payout_cycle_days * 86_400_000);

    const { error: accError } = await admin
      .from('accounts')
      .update({
        balance: money(Number(account.balance) - gross),
        equity: money(Number(account.equity) - gross),
        daily_start_balance: money(Number(account.daily_start_balance) - gross),
        last_payout_at: now.toISOString(),
        next_payout_at: nextPayout.toISOString(),
      })
      .eq('id', account.id);

    if (accError) throw new ApiError('INTERNAL_ERROR', accError.message);

    const certificate = await issueCertificate({
      user_id: tx.user_id,
      account_id: account.id,
      type: 'payout',
      amount: Number(tx.net_amount ?? tx.amount),
      is_manual: false,
      issued_by: staff.id,
      metadata: { transaction_id: tx.id, gross, split_pct: Number(account.payout_split_pct) },
    });
    certificateId = certificate.id;
  }

  const { data: updated, error: updateError } = await admin
    .from('transactions')
    .update({
      status: nextStatus,
      tx_hash: body.tx_hash ?? tx.tx_hash,
      admin_note: body.note ?? tx.admin_note,
    })
    .eq('id', tx.id)
    .select('*')
    .single<DbTransaction>();

  if (updateError) throw new ApiError('INTERNAL_ERROR', updateError.message);

  await audit(
    staff,
    body.action === 'mark_paid' ? 'payout.paid' : `payout.${body.action}` as 'payout.approve',
    { type: 'transaction', id: tx.id },
    { note: body.note ?? null, tx_hash: body.tx_hash ?? null, amount: Number(tx.amount) },
    req,
  );

  await notify(
    tx.user_id,
    body.action === 'reject' ? 'payout_rejected' : 'payout_paid',
    body.action === 'reject' ? 'Payout rejected' : `Payout ${nextStatus}`,
    body.action === 'reject'
      ? body.note ?? 'Your payout request was rejected.'
      : `Your payout of $${Number(tx.net_amount ?? tx.amount)} is ${nextStatus}.`,
    { transaction_id: tx.id, tx_hash: body.tx_hash ?? null },
  );

  return ok({
    transaction: {
      ...updated,
      amount: Number(updated.amount),
      net_amount: updated.net_amount === null ? null : Number(updated.net_amount),
    },
    certificate_id: certificateId,
  });
});
