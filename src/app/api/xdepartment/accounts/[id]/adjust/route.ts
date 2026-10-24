import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireXDepartment } from '@/lib/permissions';
import { supabaseAdmin } from '@/lib/supabase';
import { forceCloseAll, getAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { snapshotEquity } from '@/lib/snapshots';
import { audit } from '@/lib/audit';
import { notify } from '@/lib/notifications';
import { money } from '@/lib/math';
import { adjustAccountSchema } from '@/lib/validation';
import type { DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/xdepartment/accounts/{id}/adjust
 *
 * Unrestricted account surgery: set or shift the balance, change size,
 * force any status, reset the drawdown floors, clear a breach, rewrite
 * the rule-set. Every field is optional; everything is audit-logged.
 */
export const POST = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const staff = await requireXDepartment(req);
  const body = adjustAccountSchema.parse(await readJson(req));

  const account = await getAccount(ctx.params.id);
  const patch: Record<string, unknown> = {};

  let closedOrders = 0;
  if (body.close_positions) {
    closedOrders = await forceCloseAll(account.id, 'admin');
  }

  const current = closedOrders > 0 ? await getAccount(account.id) : account;
  let balance = Number(current.balance);

  if (body.set_balance !== undefined) balance = money(body.set_balance);
  if (body.balance_delta !== undefined) balance = money(balance + body.balance_delta);
  if (balance < 0) throw new ApiError('VALIDATION_ERROR', 'Resulting balance would be negative.');

  if (body.set_balance !== undefined || body.balance_delta !== undefined) {
    patch.balance = balance;
    patch.equity = balance; // positions were either flat or re-marked on next evaluate
  }

  if (body.set_size !== undefined) patch.size = body.set_size;
  if (body.set_status) patch.status = body.set_status;
  if (body.clear_breach) patch.breach_reason = null;

  // Reset the daily floor (and the max-DD anchor when asked) to the new balance.
  if (body.reset_daily_start || body.reset_drawdown) patch.daily_start_balance = balance;
  if (body.reset_drawdown) {
    patch.daily_reset_at = new Date().toISOString();
    patch.breach_reason = null;
    if (!body.set_status) patch.status = 'active';
  }

  if (body.rules) Object.assign(patch, body.rules);

  if (Object.keys(patch).length === 0 && closedOrders === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Nothing to adjust.');
  }

  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .update(patch)
    .eq('id', account.id)
    .select('*')
    .single<DbAccount>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  await snapshotEquity(data.id, Number(data.equity), Number(data.balance), 'manual');

  await audit(
    staff,
    body.rules ? 'account.rules_override' : 'account.adjust',
    { type: 'account', id: account.id },
    {
      before: {
        balance: Number(account.balance),
        size: Number(account.size),
        status: account.status,
      },
      patch,
      closed_orders: closedOrders,
      reason: body.reason ?? null,
    },
    req,
  );

  if (body.reason) {
    await notify(account.user_id, 'admin_action', 'Account updated', body.reason, {
      account_id: account.id,
    });
  }

  return ok({ account: serializeAccount(data), closed_orders: closedOrders });
});
