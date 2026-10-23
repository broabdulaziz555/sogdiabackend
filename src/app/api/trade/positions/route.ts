import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { getOpenOrders } from '@/lib/engine';
import { listPending } from '@/lib/pending';
import { runCycle } from '@/lib/cycle';
import { serializeAccount } from '@/lib/accounts';
import { accountIdSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * GET /api/trade/positions?account_id=uuid
 * The terminal snapshot: open positions with live PnL, working limit/stop orders, account figures.
 * Each call also runs one engine cycle (limit/stop fills, liquidations, SL/TP), so polling drives the engine
 * for the person watching; /api/cron/tick covers everyone else.
 */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const { account_id } = accountIdSchema.parse({ account_id: url.searchParams.get('account_id') });

  // Account (with its ownership check), open orders and working orders are read side by side: one round trip.
  const [account, orders, pending] = await Promise.all([
    requireAccount(account_id, user),
    getOpenOrders(account_id),
    listPending(account_id),
  ]);
  const { result, pending: pendingAfter } = await runCycle(user, account, { orders, pending });

  return ok({
    positions: result.positions,
    pending: pendingAfter,
    liquidated: result.liquidated,
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: {
      breached: result.risk.breached,
      reason: result.risk.reason,
      status: result.risk.status,
    },
    server_time: Date.now(),
  });
});
