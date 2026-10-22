import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { applySpread, isLiquidated, money, pnlFor, pnlPct } from '@/lib/math';
import { evaluateAccount, settleOrder } from '@/lib/engine';
import { snapshotEquity } from '@/lib/snapshots';
import { serializeAccount } from '@/lib/accounts';
import { closeTradeSchema } from '@/lib/validation';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** POST /api/trade/close */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = closeTradeSchema.parse(await readJson(req));

  const { data: order, error } = await supabaseAdmin()
    .from('orders')
    .select('*')
    .eq('id', body.order_id)
    .maybeSingle<DbOrder>();

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  if (!order) throw new ApiError('NOT_FOUND', 'Order not found.');
  if (order.user_id !== user.id && user.role === 'trader') {
    throw new ApiError('FORBIDDEN', 'This order belongs to another user.');
  }
  if (order.status !== 'open') {
    throw new ApiError('ORDER_NOT_OPEN', 'This position is already closed.');
  }

  const mid = await getPrice(order.symbol);
  const liq = Number(order.liquidation_price);
  const hitLiq = isLiquidated(order.side, mid, liq);

  // If price already crossed the liquidation level, settle there instead —
  // the trader cannot escape a liquidation by racing the close button.
  const closePrice = hitLiq ? liq : applySpread(mid, order.side, 'close');
  const pnl = hitLiq
    ? money(-Number(order.margin))
    : pnlFor(order.side, Number(order.entry_price), closePrice, Number(order.quantity));

  const settled = await settleOrder(
    order.id,
    closePrice,
    pnl,
    hitLiq ? 'liquidated' : 'closed',
    hitLiq ? 'liquidation' : 'manual',
  );

  const result = await evaluateAccount(order.account_id);
  // Telemetry only: don't make the trader wait for the equity-curve insert.
  void snapshotEquity(
    result.account.id,
    Number(result.account.equity),
    Number(result.account.balance),
    'trade_close',
  ).catch(() => undefined);

  return ok({
    order: {
      id: settled.id,
      account_id: settled.account_id,
      symbol: settled.symbol,
      side: settled.side,
      leverage: settled.leverage,
      margin: Number(settled.margin),
      position_size: Number(settled.position_size),
      entry_price: Number(settled.entry_price),
      close_price: Number(settled.close_price),
      pnl: Number(settled.pnl),
      pnl_pct: pnlPct(Number(settled.pnl), Number(settled.margin)),
      status: settled.status,
      close_reason: settled.close_reason,
      created_at: settled.created_at,
      closed_at: settled.closed_at,
    },
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: {
      breached: result.risk.breached,
      reason: result.risk.reason,
      status: result.risk.status,
    },
  });
});
