import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { applySpread, isLiquidated, money, pnlFor, pnlPct } from '@/lib/math';
import { evaluateAccount, settleOrder } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { partialCloseSchema } from '@/lib/validation';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/partial-close
 * Closes a slice of an open position. The closed slice is written as its
 * own settled order row (linked via parent_order_id) so the trade history
 * and win-rate stats stay honest; the parent keeps the remainder.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = partialCloseSchema.parse(await readJson(req));
  const admin = supabaseAdmin();

  const { data: order, error } = await admin
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
  if (isLiquidated(order.side, mid, liq)) {
    throw new ApiError('ORDER_NOT_OPEN', 'Position is at its liquidation price — close it in full.');
  }

  const fraction = body.percent / 100;
  const closePrice = applySpread(mid, order.side, 'close');

  const sliceQty = Number(order.quantity) * fraction;
  const sliceMargin = money(Number(order.margin) * fraction);
  const sliceNotional = money(Number(order.position_size) * fraction);
  const pnl = pnlFor(order.side, Number(order.entry_price), closePrice, sliceQty);

  // 100% is just a normal close.
  if (body.percent === 100) {
    const settled = await settleOrder(order.id, closePrice, pnl, 'closed', 'manual');
    const result = await evaluateAccount(order.account_id);
    return ok({
      closed: { id: settled.id, pnl, pnl_pct: pnlPct(pnl, Number(settled.margin)), close_price: closePrice },
      remaining: null,
      account: serializeAccount(result.account),
      metrics: result.metrics,
    });
  }

  const { data: slice, error: sliceError } = await admin
    .from('orders')
    .insert({
      account_id: order.account_id,
      user_id: order.user_id,
      symbol: order.symbol,
      side: order.side,
      leverage: order.leverage,
      margin: sliceMargin,
      position_size: sliceNotional,
      quantity: sliceQty,
      entry_price: order.entry_price,
      mark_price_at_open: order.mark_price_at_open,
      liquidation_price: order.liquidation_price,
      parent_order_id: order.id,
      status: 'open',
      created_at: order.created_at,
    })
    .select('*')
    .single<DbOrder>();

  if (sliceError) throw new ApiError('INTERNAL_ERROR', sliceError.message);

  const { data: remaining, error: remainingError } = await admin
    .from('orders')
    .update({
      margin: money(Number(order.margin) - sliceMargin),
      position_size: money(Number(order.position_size) - sliceNotional),
      quantity: Number(order.quantity) - sliceQty,
    })
    .eq('id', order.id)
    .eq('status', 'open')
    .select('*')
    .single<DbOrder>();

  if (remainingError) throw new ApiError('INTERNAL_ERROR', remainingError.message);

  await settleOrder(slice.id, closePrice, pnl, 'closed', `partial_${body.percent}`);
  const result = await evaluateAccount(order.account_id);

  return ok({
    closed: {
      id: slice.id,
      percent: body.percent,
      pnl,
      pnl_pct: pnlPct(pnl, sliceMargin),
      close_price: closePrice,
    },
    remaining: {
      id: remaining.id,
      quantity: Number(remaining.quantity),
      margin: Number(remaining.margin),
      position_size: Number(remaining.position_size),
    },
    account: serializeAccount(result.account),
    metrics: result.metrics,
  });
});
