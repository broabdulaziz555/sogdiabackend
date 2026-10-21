import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { toPosition } from '@/lib/math';
import { protectionSchema } from '@/lib/validation';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/protection
 * Attach or clear a take-profit / stop-loss on an open position.
 * Levels are validated against the side and the liquidation price, then
 * enforced by the sweep that runs on every positions poll.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = protectionSchema.parse(await readJson(req));
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

  const mark = await getPrice(order.symbol);
  const long = order.side === 'long';
  const liq = Number(order.liquidation_price);

  if (body.take_profit != null) {
    const valid = long ? body.take_profit > mark : body.take_profit < mark;
    if (!valid) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Take-profit must be ${long ? 'above' : 'below'} the current price (${mark}).`,
      );
    }
  }

  if (body.stop_loss != null) {
    const valid = long ? body.stop_loss < mark : body.stop_loss > mark;
    if (!valid) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Stop-loss must be ${long ? 'below' : 'above'} the current price (${mark}).`,
      );
    }
    const beyondLiq = long ? body.stop_loss <= liq : body.stop_loss >= liq;
    if (beyondLiq) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Stop-loss sits beyond the liquidation price (${liq}) — it could never trigger.`,
      );
    }
  }

  const patch: Record<string, number | null> = {};
  if (body.take_profit !== undefined) patch.take_profit = body.take_profit;
  if (body.stop_loss !== undefined) patch.stop_loss = body.stop_loss;

  const { data: updated, error: updateError } = await admin
    .from('orders')
    .update(patch)
    .eq('id', order.id)
    .eq('status', 'open')
    .select('*')
    .single<DbOrder>();

  if (updateError) throw new ApiError('INTERNAL_ERROR', updateError.message);

  return ok({ order: toPosition(updated, mark) });
});
