import { evaluateAccount, getOpenOrders } from '@/lib/engine';
import { fillDue, listPending, type PendingRow } from '@/lib/pending';
import type { DbAccount, DbOrder, DbUser } from '@/lib/types';

/**
 * One pass of the account engine: fill the limit/stop orders the market has reached, then run the risk sweep
 * (liquidations, SL/TP, drawdown, evaluation target). The positions poll runs it for the person looking at the
 * terminal; /api/cron/tick runs it for everyone, so nothing depends on a browser being open.
 */
export async function runCycle(
  user: Pick<DbUser, 'id' | 'role'>,
  account: DbAccount,
  preloaded?: { orders: DbOrder[]; pending: PendingRow[] },
) {
  let orders = preloaded?.orders ?? (await getOpenOrders(account.id));
  let pending = preloaded?.pending ?? (await listPending(account.id));

  if (pending.some((o) => o.status === 'working') && account.status === 'active') {
    const filled = await fillDue(user, pending);
    pending = filled.pending;
    if (filled.filled > 0) orders = await getOpenOrders(account.id);
  }

  const result = await evaluateAccount(account, orders);
  return { result, pending };
}
