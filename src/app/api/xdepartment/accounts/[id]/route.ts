import { ApiError, handle, ok } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { getAccount } from '@/lib/engine';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * DELETE /api/xdepartment/accounts/{id}
 * Hard delete. Cascades to the account's orders and detaches its
 * transactions and certificates. Irreversible — prefer `close` unless
 * you are cleaning up test data.
 */
export const DELETE = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const account = await getAccount(ctx.params.id);

  const { error } = await supabaseAdmin().from('accounts').delete().eq('id', account.id);
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  await audit(
    staff,
    'account.delete',
    { type: 'account', id: account.id },
    {
      user_id: account.user_id,
      size: Number(account.size),
      balance: Number(account.balance),
      plan_key: account.plan_key,
      was_gifted: account.is_gifted,
    },
    req,
  );

  return ok({ deleted: true, account_id: account.id });
});
