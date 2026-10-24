import { handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { assertTradable } from '@/lib/binance';
import { executeOpen, prefetchOpen } from '@/lib/trading';
import { openTradeSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/trade/open
 * B-book fill: live Binance mid + 0.05% spread against the trader.
 *
 * The request is: [user, account, open orders, Binance price, order-id lookup] all in flight at once → guards →
 * ONE insert → 200. No risk engine here: liquidations, drawdown rules and the evaluation target are checked on every
 * GET /trade/positions and by /api/cron/tick.
 *
 * Idempotent: the client sends `order_id` (a UUID it generated). That id becomes the order's primary key, so a request
 * repeated after a timeout, a dropped connection or a double tap returns the order already stored instead of opening a
 * second one. The logic lives in lib/trading.ts (shared with server-side limit/stop fills).
 */
export const POST = handle(async (req) => {
  const t0 = Date.now();
  const body = openTradeSchema.parse(await readJson(req));
  const symbol = assertTradable(body.symbol);

  // everything that does not depend on who is asking starts now, alongside authentication
  const prefetched = prefetchOpen({ accountId: body.account_id, symbol, orderId: body.order_id });
  const user = await requireUser(req);
  rateLimit(`trade-open:${user.id}`, 240, 60_000);

  const r = await executeOpen({
    user,
    accountId: body.account_id,
    orderId: body.order_id,
    symbol,
    side: body.side,
    leverage: body.leverage,
    margin: body.margin,
    takeProfit: body.take_profit,
    stopLoss: body.stop_loss,
    prefetched,
  });

  // server_ms: time spent inside this handler, so a slow open can be told apart from a slow network (shown in the terminal's Diagnostics)
  return ok({ order: r.position, replayed: r.replayed, server_ms: Date.now() - t0 });
});
