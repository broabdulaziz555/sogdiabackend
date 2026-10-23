import { handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { assertTradable } from '@/lib/binance';
import { executeOpen } from '@/lib/trading';
import { openTradeSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/open
 * B-book fill: live Binance mid + 0.05% spread against the trader.
 *
 * The whole request is: auth → [account + balance, open orders, Binance price] read in parallel → guards → ONE insert →
 * 200. The risk engine (liquidation sweep, drawdown rules, evaluation target) is never awaited here; it runs behind the
 * reply, on every GET /trade/positions and on /api/cron/tick.
 *
 * Idempotent: the client sends `order_id` (a UUID it generated). That id becomes the order's primary key, so a request
 * repeated after a timeout, a dropped connection or a double tap returns the order already stored instead of opening a
 * second one. The logic lives in lib/trading.ts (shared with server-side limit/stop fills).
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`trade-open:${user.id}`, 240, 60_000);
  const body = openTradeSchema.parse(await readJson(req));

  const r = await executeOpen({
    user,
    accountId: body.account_id,
    orderId: body.order_id,
    symbol: assertTradable(body.symbol),
    side: body.side,
    leverage: body.leverage,
    margin: body.margin,
    takeProfit: body.take_profit,
    stopLoss: body.stop_loss,
  });

  return ok({ order: r.position, replayed: r.replayed, account: r.account, metrics: r.metrics, risk: r.risk });
});
