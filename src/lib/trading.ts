import { ApiError } from '@/lib/http';
import { requireAccount } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { applySpread, liquidationPrice, money, positionSize, price, quantity, toPosition } from '@/lib/math';
import { buildPositions, evaluateAccount, getOpenOrders } from '@/lib/engine';
import { computeMetrics, isTradable } from '@/lib/risk';
import { withAccountLock } from '@/lib/accountLock';
import { serializeAccount } from '@/lib/accounts';
import type { AccountMetrics, DbOrder, DbUser, OrderSide, Position } from '@/lib/types';

export interface OpenParams {
  user: Pick<DbUser, 'id' | 'role'>;
  accountId: string;
  /**
   * Client-chosen id of the order (a UUID). It becomes the primary key, which makes the call idempotent: sending the
   * same id again (a retry after a timeout, a double tap, a fill that runs twice) returns the stored order and never
   * opens a second position.
   */
  orderId?: string;
  symbol: string;
  side: OrderSide;
  leverage: number;
  margin: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
  /** A limit order fills at its own price instead of the market. */
  entryPrice?: number;
  /** Skip the background risk sweep (the caller runs its own). */
  skipSweep?: boolean;
}

export interface OpenResult {
  position: Position;
  account?: ReturnType<typeof serializeAccount>;
  metrics?: AccountMetrics;
  risk?: { breached: boolean; reason: string | null; status: string };
  /** True when this id had already been stored and nothing new was opened. */
  replayed: boolean;
}

function replay(order: DbOrder): OpenResult {
  const closed = order.status !== 'open';
  const mark = closed && order.close_price != null ? Number(order.close_price) : Number(order.mark_price_at_open);
  const position = toPosition(order, mark);
  if (closed) {
    position.unrealized_pnl = Number(order.pnl ?? 0);
    position.unrealized_pnl_pct = Number(order.margin) > 0 ? money((position.unrealized_pnl / Number(order.margin)) * 100) : 0;
  }
  return { position, replayed: true };
}

/**
 * Open a B-book position. Pre-trade guards, and only these:
 *   1. account is active  2. symbol is tradable  3. leverage <= account max  4. margin <= free margin
 * (There is deliberately no drawdown gate here; see the note on /api/trade/open.)
 *
 * Round trips: one parallel read (account, open orders, price, id lookup), one insert. Nothing else is awaited: the
 * risk sweep runs after the reply.
 */
export async function executeOpen(p: OpenParams): Promise<OpenResult> {
  const { user, accountId, orderId } = p;

  return withAccountLock(accountId, async () => {
    const [account, openOrders, mid, existing] = await Promise.all([
      requireAccount(accountId, user as DbUser),
      getOpenOrders(accountId),
      getPrice(p.symbol),
      orderId ? findOrder(orderId) : Promise.resolve(null),
    ]);

    if (existing) return sameOwner(existing, user, accountId) ? replay(existing) : conflict();

    if (!isTradable(account)) {
      throw new ApiError('ACCOUNT_NOT_TRADABLE', `Account status is "${account.status}" — trading is disabled.`);
    }
    if (p.leverage > account.max_leverage) {
      throw new ApiError('VALIDATION_ERROR', `Leverage above the account maximum of ${account.max_leverage}x.`);
    }

    const preMetrics = computeMetrics(account, openOrders.map((o) => toPosition(o, Number(o.mark_price_at_open))));
    if (p.margin > preMetrics.free_margin) {
      const snapshot = {
        account_id: account.id, balance: Number(account.balance), used_margin: preMetrics.used_margin,
        free_margin: preMetrics.free_margin, required_margin: p.margin, leverage: p.leverage, symbol: p.symbol,
      };
      console.error('[trade/open] rejected: insufficient margin', snapshot);
      throw new ApiError(
        'INSUFFICIENT_MARGIN',
        `Margin $${p.margin} exceeds free margin $${preMetrics.free_margin} (balance $${snapshot.balance} − $${preMetrics.used_margin} used across ` +
          `${preMetrics.open_positions} open position${preMetrics.open_positions === 1 ? '' : 's'}).`,
        { ...snapshot, shortfall: money(p.margin - preMetrics.free_margin) },
      );
    }

    const entry = p.entryPrice != null ? price(p.entryPrice) : applySpread(mid, p.side, 'open');
    const notional = positionSize(p.margin, p.leverage);
    const qty = quantity(notional, entry);
    const liq = liquidationPrice(entry, p.side, p.leverage);

    const [ins, marks] = await Promise.all([
      supabaseAdmin()
        .from('orders')
        .insert({
          ...(orderId ? { id: orderId } : {}),
          account_id: account.id,
          user_id: account.user_id,
          symbol: p.symbol,
          side: p.side,
          leverage: p.leverage,
          margin: p.margin,
          position_size: notional,
          quantity: qty,
          entry_price: entry,
          mark_price_at_open: mid,
          liquidation_price: liq,
          take_profit: p.takeProfit ?? null,
          stop_loss: p.stopLoss ?? null,
          status: 'open',
        })
        .select('*')
        .single<DbOrder>(),
      buildPositions(openOrders).catch(() => null),
    ]);

    let order = ins.data;
    if (ins.error || !order) {
      // Lost a race with another instance that stored the same id: that is the same order, not an error.
      if (orderId && (ins.error as { code?: string } | null)?.code === '23505') {
        const again = await findOrder(orderId);
        if (again) return sameOwner(again, user, accountId) ? replay(again) : conflict();
      }
      throw new ApiError('INTERNAL_ERROR', ins.error?.message ?? 'Order was not stored.');
    }

    console.log('[trade/open] stored', { order_id: order.id, account_id: account.id, symbol: p.symbol, side: p.side, leverage: p.leverage, margin: p.margin, mid, entry });

    const position = toPosition(order, mid);
    const metrics = marks ? computeMetrics(account, [position, ...marks]) : null;

    // The order is stored, so the trade is real from here on. The risk engine (liquidations, drawdown rules, the
    // evaluation target) is never awaited: it runs behind the reply, on every positions poll and on the cron tick.
    if (!p.skipSweep) {
      void evaluateAccount(account.id).catch((err) =>
        console.error('[trade/open] background evaluation failed', { account_id: account.id, order_id: order!.id, error: err instanceof Error ? err.message : String(err) }),
      );
    }

    return {
      position,
      replayed: false,
      ...(metrics && {
        account: serializeAccount({ ...account, equity: metrics.equity }),
        metrics,
        risk: { breached: false, reason: null, status: account.status },
      }),
    };
  });
}

async function findOrder(id: string): Promise<DbOrder | null> {
  const { data, error } = await supabaseAdmin().from('orders').select('*').eq('id', id).maybeSingle<DbOrder>();
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  return data;
}

/** The account was authorised by the caller already, so an id is "ours" exactly when it was stored on that account. */
function sameOwner(o: DbOrder, _user: Pick<DbUser, 'id' | 'role'>, accountId: string): boolean {
  return o.account_id === accountId;
}

function conflict(): never {
  throw new ApiError('DUPLICATE', 'This order id belongs to a different order.');
}
