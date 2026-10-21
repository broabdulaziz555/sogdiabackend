import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireStaff } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { forceCloseAll, getAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { adminAccountStatusSchema } from '@/lib/validation';
import type { AccountStatus, DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';

const NEXT_STATUS: Record<string, AccountStatus> = {
  freeze: 'frozen',
  unfreeze: 'active',
  breach: 'breached',
  close: 'closed',
};

/**
 * POST /api/admin/accounts/{id}/status
 * Freeze, restore, breach (illegal/abusive trading) or close an account.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireStaff(req);
  const body = adminAccountStatusSchema.parse(await readJson(req));

  const account = await getAccount(ctx.params.id);
  const nextStatus = NEXT_STATUS[body.action];

  if (body.action === 'unfreeze' && account.status !== 'frozen') {
    throw new ApiError('VALIDATION_ERROR', 'Only a frozen account can be unfrozen.');
  }

  let closedOrders = 0;
  if ((body.action === 'breach' || body.action === 'close') && body.close_positions) {
    closedOrders = await forceCloseAll(account.id, body.action);
  }

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .update({
      status: nextStatus,
      breach_reason: body.action === 'unfreeze' ? null : body.reason ?? account.breach_reason,
    })
    .eq('id', account.id)
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  await audit(
    staff,
    `account.${body.action}` as 'account.freeze',
    { type: 'account', id: account.id },
    { reason: body.reason ?? null, closed_orders: closedOrders, from: account.status, to: nextStatus },
    req,
  );

  await notify(
    account.user_id,
    body.action === 'unfreeze' ? 'admin_action' : 'account_failed',
    `Account ${nextStatus}`,
    body.reason ?? `Your account status changed to ${nextStatus}.`,
    { account_id: account.id },
  );

  return ok({ account: serializeAccount(data), closed_orders: closedOrders });
});
