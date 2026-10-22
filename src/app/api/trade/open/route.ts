import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { assertTradable, getPrice } from '@/lib/binance';
import {
  applySpread,
  liquidationPrice,
  money,
  positionSize,
  quantity,
  toPosition,
} from '@/lib/math';
import { buildPositions, evaluateAccount, getOpenOrders } from '@/lib/engine';
import { computeMetrics, isTradable } from '@/lib/risk';
import { serializeAccount } from '@/lib/accounts';
import { openTradeSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/ratelimit';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/open
 * B-book fill: live Binance mid + 0.05% spread against the trader.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`trade-open:${user.id}`, 60, 60_000);
  const body = openTradeSchema.parse(await readJson(req));

  const account = await requireAccount(body.account_id, user);
  if (!isTradable(account)) {
    throw new ApiError(
      'ACCOUNT_NOT_TRADABLE',
      `Account status is "${account.status}" — trading is disabled.`,
    );
  }

  const symbol = assertTradable(body.symbol);
  if (body.leverage > account.max_leverage) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Leverage above the account maximum of ${account.max_leverage}x.`,
    );
  }

  // Free margin = realised balance minus margin already posted.
  // Computed by the same computeMetrics() the account and positions
  // endpoints use, against the account row this request names — so the
  // figure shown in the UI and the figure validated here are one value.
  const openOrders = await getOpenOrders(account.id);
  const existing = await buildPositions(openOrders);
  const preMetrics = computeMetrics(account, existing);

  // Full breakdown, attached to both the log and the error, so a
  // rejection can always be traced to the account row it came from.
  const snapshot = {
    account_id: account.id,
    account_status: account.status,
    balance: Number(account.balance),
    equity: preMetrics.equity,
    unrealized_pnl: preMetrics.unrealized_pnl,
    used_margin: preMetrics.used_margin,
    free_margin: preMetrics.free_margin,
    open_positions: preMetrics.open_positions,
    required_margin: body.margin,
    leverage: body.leverage,
    notional: positionSize(body.margin, body.leverage),
    symbol,
  };

  if (process.env.TRADE_DEBUG === '1') {
    console.log('[trade/open] margin check', snapshot);
  }

  if (body.margin > preMetrics.free_margin) {
    console.error('[trade/open] rejected: insufficient margin', snapshot);

    throw new ApiError(
      'INSUFFICIENT_MARGIN',
      `Margin $${body.margin} exceeds free margin $${preMetrics.free_margin} on account ${account.id} ` +
        `(balance $${snapshot.balance} − $${preMetrics.used_margin} used across ` +
        `${preMetrics.open_positions} open position${preMetrics.open_positions === 1 ? '' : 's'}).`,
      { ...snapshot, shortfall: money(body.margin - preMetrics.free_margin) },
    );
  }

  const mid = await getPrice(symbol);
  const entry = applySpread(mid, body.side, 'open');
  const notional = positionSize(body.margin, body.leverage);
  const qty = quantity(notional, entry);
  const liq = liquidationPrice(entry, body.side, body.leverage);

  const { data: order, error } = await supabaseAdmin()
    .from('orders')
    .insert({
      account_id: account.id,
      user_id: user.id,
      symbol,
      side: body.side,
      leverage: body.leverage,
      margin: body.margin,
      position_size: notional,
      quantity: qty,
      entry_price: entry,
      mark_price_at_open: mid,
      liquidation_price: liq,
      take_profit: body.take_profit ?? null,
      stop_loss: body.stop_loss ?? null,
      status: 'open',
    })
    .select('*')
    .single<DbOrder>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const result = await evaluateAccount(account.id);

  return ok({
    order: toPosition(order, mid),
    account: serializeAccount(result.account),
    metrics: result.metrics,
  });
});
