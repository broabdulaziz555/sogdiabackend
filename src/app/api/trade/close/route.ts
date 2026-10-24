import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { applySpread, isLiquidated, money, pnlFor, pnlPct, toPosition } from '@/lib/math';
import { buildPositions, evaluateAccount, getAccount, getOpenOrders, settleOrder } from '@/lib/engine';
import { computeMetrics } from '@/lib/risk';
import { snapshotEquity } from '@/lib/snapshots';
import { serializeAccount } from '@/lib/accounts';
import { closeTradeSchema } from '@/lib/validation';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

  // Reply as soon as the position is settled: one parallel read for the fresh account and the remaining book, no sweep.
  // The full risk pass (liquidations, evaluation target, equity snapshot) runs behind the reply and on every poll.
  const [account, rest] = await Promise.all([getAccount(order.account_id), getOpenOrders(order.account_id)]);
  const remaining = await buildPositions(rest).catch(() => rest.map((o) => toPosition(o, Number(o.mark_price_at_open))));
  const metrics = computeMetrics(account, remaining);
  void evaluateAccount(account.id)
    .then((r) => snapshotEquity(r.account.id, Number(r.account.equity), Number(r.account.balance), 'trade_close'))
    .catch((err) => console.error('[trade/close] background evaluation failed', { order_id: order.id, error: err instanceof Error ? err.message : String(err) }));

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
    account: serializeAccount(account),
    metrics,
    risk: { breached: false, reason: null, status: account.status },
  });
});
