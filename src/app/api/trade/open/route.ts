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
import { checkBreach, computeMetrics, isTradable } from '@/lib/risk';
import { withAccountLock } from '@/lib/accountLock';
import { serializeAccount } from '@/lib/accounts';
import { openTradeSchema } from '@/lib/validation';
import { rateLimit } from '@/lib/ratelimit';
import type { DbOrder } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/open
 * B-book fill: live Binance mid + 0.05% spread against the trader.
 *
 * Pre-trade guards — these four, and ONLY these four:
 *   1. account status is 'active'
 *   2. symbol is in the allowed universe
 *   3. leverage <= the account's max leverage
 *   4. margin <= free margin (balance − margin already posted)
 *
 * There is deliberately NO drawdown / equity gate here. A trader may open
 * positions right up to the moment their equity breaches a drawdown floor.
 * computeMetrics() below is used to obtain free margin; nothing it computes
 * about equity or drawdown (beyond the diagnostic log) is allowed to gate
 * the order.
 *
 * Speed: the account row, open orders and live price are fetched together, the insert runs beside the
 * metrics build, and the reply goes out as soon as the order is stored. The full risk sweep
 * (evaluateAccount) then runs in the background — /trade/positions re-runs it on every poll anyway.
 * Only when the new position itself trips a drawdown rule (enforcement is opt-in) is it awaited.
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`trade-open:${user.id}`, 120, 60_000);
  const body = openTradeSchema.parse(await readJson(req));
  const symbol = assertTradable(body.symbol);

  // One order at a time per account, so rapid clicks cannot all pass the margin check against the same balance.
  return withAccountLock(body.account_id, async () => {
    const [account, openOrders, mid] = await Promise.all([
      requireAccount(body.account_id, user),
      getOpenOrders(body.account_id),
      getPrice(symbol),
    ]);

    if (!isTradable(account)) {
      throw new ApiError(
        'ACCOUNT_NOT_TRADABLE',
        `Account status is "${account.status}" — trading is disabled.`,
      );
    }
    if (body.leverage > account.max_leverage) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Leverage above the account maximum of ${account.max_leverage}x.`,
      );
    }

    // Free margin = realised balance minus margin already posted, from the same computeMetrics() the account
    // and positions endpoints use. It only depends on margins, so the stub marks below need no price lookups.
    const preMetrics = computeMetrics(
      account,
      openOrders.map((o) => toPosition(o, Number(o.mark_price_at_open))),
    );

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

    const entry = applySpread(mid, body.side, 'open');
    const notional = positionSize(body.margin, body.leverage);
    const qty = quantity(notional, entry);
    const liq = liquidationPrice(entry, body.side, body.leverage);

    // Store the order while the live marks for the rest of the book are being attached.
    const [{ data: order, error }, existing] = await Promise.all([
      supabaseAdmin()
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
        .single<DbOrder>(),
      buildPositions(openOrders).catch(() => null),
    ]);

    if (error || !order) throw new ApiError('INTERNAL_ERROR', error?.message ?? 'Order was not stored.');

    // The order is stored, so the trade is real from here on: nothing below may turn into a rejected order
    // (the UI would drop the position and the trader would re-send it, doubling up).
    const position = toPosition(order, mid);
    const metrics = existing ? computeMetrics(account, [position, ...existing]) : null;

    let result: Awaited<ReturnType<typeof evaluateAccount>> | null = null;
    if (metrics && checkBreach(metrics) === null) {
      // Normal path: answer now, run the full risk sweep (liquidations, equity snapshot) behind the reply.
      void evaluateAccount(account.id).catch((err) => {
        console.error('[trade/open] background evaluation failed', {
          account_id: account.id,
          order_id: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      try {
        result = await evaluateAccount(account.id);
      } catch (err) {
        console.error('[trade/open] order opened but post-trade evaluation failed', {
          account_id: account.id,
          order_id: order.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result) {
      return ok({
        order: position,
        account: serializeAccount(result.account),
        metrics: result.metrics,
        // Same shape /trade/close returns, so a client can see an instant breach.
        risk: {
          breached: result.risk.breached,
          reason: result.risk.reason,
          status: result.risk.status,
        },
      });
    }

    return ok({
      order: position,
      ...(metrics && {
        account: serializeAccount({ ...account, equity: metrics.equity }),
        metrics,
        risk: { breached: false, reason: null, status: account.status },
      }),
    });
  });
});
