import { ApiError } from '@/lib/http';
import { assertAccountAccess } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrice } from '@/lib/binance';
import { applySpread, liquidationPrice, money, positionSize, price, quantity, toPosition } from '@/lib/math';
import { getAccount, getOpenOrders } from '@/lib/engine';
import { computeMetrics, isTradable } from '@/lib/risk';
import { finishedSince, isAccountBusy, withAccountLock } from '@/lib/accountLock';
import type { DbAccount, DbOrder, DbUser, OrderSide, Position } from '@/lib/types';

/** No database call on the open path may take longer than this. */
export const OPEN_DEADLINE_MS = 5_000;

/** A call that hit its deadline: whether a write landed is unknown, which is not the same as a refusal. */
function timedOut(message: string | undefined): boolean {
  return !!message && /abort|timed? ?out/i.test(message);
}
const UNKNOWN_OUTCOME = 'The database did not answer in time. The order may or may not have been stored; check your positions.';

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
  /** Reads started earlier (see prefetchOpen), so they overlap with resolving the user. */
  prefetched?: OpenReads;
}

export interface OpenResult {
  position: Position;
  /** True when this id had already been stored and nothing new was opened. */
  replayed: boolean;
}

/** Everything an open needs to read, started together. None of it depends on who the caller is. */
export interface OpenReads {
  startedAt: number;
  account: Promise<DbAccount>;
  orders: Promise<DbOrder[]>;
  mid: Promise<number>;
  existing: Promise<DbOrder | null>;
}

/**
 * Start every read an open needs at the same moment: the account row, the account's open orders, the Binance price and
 * the lookup of the order id. The route calls this BEFORE it resolves the user, so authentication, the database reads
 * and the price all travel in parallel. (A failed read stays a rejected promise until executeOpen awaits it.)
 */
export function prefetchOpen(p: { accountId: string; symbol: string; orderId?: string }): OpenReads {
  const signal = AbortSignal.timeout(OPEN_DEADLINE_MS);
  const reads: OpenReads = {
    startedAt: Date.now(),
    account: getAccount(p.accountId, signal),
    orders: getOpenOrders(p.accountId, signal),
    mid: getPrice(p.symbol), // has its own 4 s deadline per host
    existing: p.orderId ? findOrder(p.orderId, signal) : Promise.resolve(null),
  };
  for (const r of Object.values(reads)) if (r instanceof Promise) r.catch(() => undefined); // surfaced when awaited, never "unhandled"
  return reads;
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
 *
 * Critical path: ONE parallel read (account, open orders, price, id lookup — started before the user is even resolved),
 * ONE insert, return. The risk engine is not involved: it runs on the positions poll and on the cron tick.
 *
 * The reads may have been started before this call got the account lock. They are used as they are only when nothing
 * else touched the account in between; otherwise they are read again inside the lock, so two orders fired back to
 * back can never both pass the free-margin check against the same balance.
 */
export async function executeOpen(p: OpenParams): Promise<OpenResult> {
  const { user, accountId, orderId } = p;
  const reads = p.prefetched ?? prefetchOpen({ accountId, symbol: p.symbol, orderId });

  // authorise on the account row that was read in parallel with the user (before taking the lock)
  const first = await reads.account;
  assertAccountAccess(first, user);

  const queued = isAccountBusy(accountId);
  return withAccountLock(accountId, async () => {
    const current = !queued && !finishedSince(accountId, reads.startedAt);
    const [account, openOrders, mid, existing] = await Promise.all(
      current
        ? [reads.account, reads.orders, reads.mid, reads.existing]
        : (() => { const sig = AbortSignal.timeout(OPEN_DEADLINE_MS); return [getAccount(accountId, sig), getOpenOrders(accountId, sig), reads.mid, orderId ? findOrder(orderId, sig) : Promise.resolve(null)]; })(),
    ) as [DbAccount, DbOrder[], number, DbOrder | null];

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

    const ins = await supabaseAdmin()
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
      .abortSignal(AbortSignal.timeout(OPEN_DEADLINE_MS))
      .select('*')
      .single<DbOrder>();

    const order = ins.data;
    if (ins.error || !order) {
      // Lost a race with another instance that stored the same id: that is the same order, not an error.
      if (orderId && (ins.error as { code?: string } | null)?.code === '23505') {
        const again = await findOrder(orderId);
        if (again) return sameOwner(again, user, accountId) ? replay(again) : conflict();
      }
      if (timedOut(ins.error?.message)) throw new ApiError('UPSTREAM_ERROR', UNKNOWN_OUTCOME);
      throw new ApiError('INTERNAL_ERROR', ins.error?.message ?? 'Order was not stored.');
    }

    console.log('[trade/open] stored', { order_id: order.id, account_id: account.id, symbol: p.symbol, side: p.side, leverage: p.leverage, margin: p.margin, mid, entry });
    // Nothing after the insert: the reply goes out now.
    return { position: toPosition(order, mid), replayed: false };
  });
}

async function findOrder(id: string, signal?: AbortSignal): Promise<DbOrder | null> {
  const q = supabaseAdmin().from('orders').select('*').eq('id', id);
  const { data, error } = await (signal ? q.abortSignal(signal) : q).maybeSingle<DbOrder>();
  if (error) throw new ApiError(timedOut(error.message) ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR', timedOut(error.message) ? UNKNOWN_OUTCOME : error.message);
  return data;
}

/** The account was authorised by the caller already, so an id is "ours" exactly when it was stored on that account. */
function sameOwner(o: DbOrder, _user: Pick<DbUser, 'id' | 'role'>, accountId: string): boolean {
  return o.account_id === accountId;
}

function conflict(): never {
  throw new ApiError('DUPLICATE', 'This order id belongs to a different order.');
}
