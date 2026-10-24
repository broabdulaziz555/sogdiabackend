import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { getOpenOrders } from '@/lib/engine';
import { listPending } from '@/lib/pending';
import { runCycle } from '@/lib/cycle';
import { serializeAccount } from '@/lib/accounts';
import { accountIdSchema } from '@/lib/validation';
import { RISK_ENGINE_ON } from '@/lib/risk';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/trade/positions?account_id=uuid
 * The terminal snapshot: open positions with live PnL, working limit/stop orders, account figures.
 *
 * Each call also runs the risk engine (liquidation / SL / TP / drawdown checks, see lib/risk.ts). With RISK_ENGINE=off
 * the route is read-only: no order status is written. The writes left then are the opening of limit/stop orders the
 * market has reached, and the account's equity figure.
 */
export const GET = handle(async (req) => {
  const t0 = Date.now();
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
  const positions = result.positions;

  // Orders come from supabaseAdmin() (service role, RLS does not apply). `db_open_orders` is what the database listed for
  // this account before the cycle ran; `returned` is what is sent back. If they differ, the cycle closed something.
  console.log('FETCHED POSITIONS:', positions);
  if (orders.length !== positions.length) {
    console.warn('[positions] database listed', orders.length, 'open order(s) but the response carries', positions.length, { account_id, liquidated: result.liquidated.length, status: result.risk.status });
  }

  return ok({
    positions,
    debug: { account_id, db_open_orders: orders.length, returned: positions.length, closed_by_cycle: result.liquidated.length, account_status: result.risk.status, risk_engine: RISK_ENGINE_ON ? 'on' : 'off', server_ms: Date.now() - t0 },
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
