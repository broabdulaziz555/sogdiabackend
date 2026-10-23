import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrices } from '@/lib/binance';
import {
  applySpread,
  isLiquidated,
  money,
  pnlFor,
  toPosition,
} from '@/lib/math';
import { RISK_ENGINE_ON, breachMessage, checkBreach, computeMetrics } from '@/lib/risk';
import { issueCertificate } from '@/lib/certificates';
import type {
  AccountMetrics,
  DbAccount,
  DbOrder,
  OrderStatus,
  Position,
  RiskResult,
} from '@/lib/types';

/** A database call that hit its deadline (not a refusal by the database). */
const deadlineHit = (message: string | undefined) => !!message && /abort|timed? ?out/i.test(message);

export async function getAccount(accountId: string, signal?: AbortSignal): Promise<DbAccount> {
  const q = supabaseAdmin()
    .from('accounts')
    .select('*')
    .eq('id', accountId);
  const { data, error } = await (signal ? q.abortSignal(signal) : q).maybeSingle<DbAccount>();
  if (error) throw new ApiError(deadlineHit(error.message) ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR', error.message);
  if (!data) throw new ApiError('NOT_FOUND', 'Account not found.');
  return data;
}

export async function getOpenOrders(accountId: string, signal?: AbortSignal): Promise<DbOrder[]> {
  const q = supabaseAdmin()
    .from('orders')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'open')
    .order('created_at', { ascending: false });
  const { data, error } = await (signal ? q.abortSignal(signal) : q);
  if (error) throw new ApiError(deadlineHit(error.message) ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR', error.message);
  return (data ?? []) as DbOrder[];
}

/**
 * Attach live Binance marks to a set of open orders.
 *
 * A price that cannot be had never hides a position and never fails the request: that position is listed at its
 * open price (price_source 'fallback') and the problem is logged. The risk sweep skips fallback positions, so a stand-in
 * price can never liquidate or stop anyone out.
 */
export async function buildPositions(orders: DbOrder[]): Promise<Position[]> {
  if (orders.length === 0) return [];
  const symbols = Array.from(new Set(orders.map((o) => o.symbol)));
  let prices: Record<string, number> = {};
  try {
    prices = await getPrices(symbols, false); // lenient: symbols the feed cannot give are left out instead of failing the call
  } catch (err) {
    console.error('[engine] live prices unavailable, listing positions at their open price', { symbols, error: err instanceof Error ? err.message : String(err) });
  }
  return orders.map((o) => {
    const live = prices[o.symbol];
    if (Number.isFinite(live) && live > 0) return { ...toPosition(o, live), price_source: 'live' as const };
    const standIn = Number(o.mark_price_at_open) > 0 ? Number(o.mark_price_at_open) : Number(o.entry_price);
    console.warn('[engine] no live price, using the open price', { order_id: o.id, symbol: o.symbol, stand_in: standIn });
    return { ...toPosition(o, standIn), price_source: 'fallback' as const };
  });
}

/** Atomic settle: writes the order and credits PnL to the account balance. */
export async function settleOrder(
  orderId: string,
  closePrice: number,
  pnl: number,
  status: Exclude<OrderStatus, 'open'>,
  reason: string,
): Promise<DbOrder> {
  const { data, error } = await supabaseAdmin().rpc('close_position', {
    p_order_id: orderId,
    p_close_price: closePrice,
    p_pnl: pnl,
    p_status: status,
    p_reason: reason,
  });

  if (error) {
    if (error.message.includes('ORDER_NOT_OPEN')) {
      throw new ApiError('ORDER_NOT_OPEN', 'This position is already closed.');
    }
    throw new ApiError('INTERNAL_ERROR', error.message);
  }
  return (Array.isArray(data) ? data[0] : data) as DbOrder;
}

export interface AutoClose {
  id: string;
  symbol: string;
  pnl: number;
  close_price: number;
  reason: 'liquidation' | 'stop_loss' | 'take_profit';
}

/**
 * Decide whether an open position must close right now.
 * Liquidation is checked first — a stop-loss sitting beyond the
 * liquidation level can never save the trader.
 */
function resolveAutoClose(
  p: Position,
): { price: number; status: 'closed' | 'liquidated'; reason: AutoClose['reason'] } | null {
  const mark = p.mark_price;
  const long = p.side === 'long';

  if (isLiquidated(p.side, mark, Number(p.liquidation_price))) {
    return { price: Number(p.liquidation_price), status: 'liquidated', reason: 'liquidation' };
  }

  const sl = p.stop_loss === null ? null : Number(p.stop_loss);
  if (sl !== null && (long ? mark <= sl : mark >= sl)) {
    return { price: sl, status: 'closed', reason: 'stop_loss' };
  }

  const tp = p.take_profit === null ? null : Number(p.take_profit);
  if (tp !== null && (long ? mark >= tp : mark <= tp)) {
    return { price: tp, status: 'closed', reason: 'take_profit' };
  }

  return null;
}

/**
 * Auto-close every position that has hit its liquidation price, stop-loss
 * or take-profit. Liquidation settles at the liquidation price, so the
 * trader loses exactly the posted margin.
 */
export async function sweepLiquidations(positions: Position[]): Promise<AutoClose[]> {
  const closed: AutoClose[] = [];
  if (!RISK_ENGINE_ON) return closed; // engine off: nothing is ever closed automatically

  for (const p of positions) {
    if (p.price_source === 'fallback') continue; // never settle a trade on a stand-in price
    const trigger = resolveAutoClose(p);
    if (!trigger) continue;

    const pnl =
      trigger.reason === 'liquidation'
        ? money(-Number(p.margin))
        : pnlFor(p.side, Number(p.entry_price), trigger.price, Number(p.quantity));

    try {
      console.log('[engine] auto-close', {
        order_id: p.id, symbol: p.symbol, side: p.side, reason: trigger.reason,
        mark: p.mark_price, entry: p.entry_price, liq: p.liquidation_price, sl: p.stop_loss, tp: p.take_profit, leverage: p.leverage,
      });
      await settleOrder(p.id, trigger.price, pnl, trigger.status, trigger.reason);
      closed.push({
        id: p.id,
        symbol: p.symbol,
        pnl,
        close_price: trigger.price,
        reason: trigger.reason,
      });
    } catch (err) {
      // Another concurrent request already settled it — not an error here.
      if (!(err instanceof ApiError && err.code === 'ORDER_NOT_OPEN')) throw err;
    }
  }

  return closed;
}

/** Close every open position at the current market (used on breach / admin kill). */
export async function forceCloseAll(accountId: string, reason: string): Promise<number> {
  const orders = await getOpenOrders(accountId);
  if (orders.length === 0) return 0;

  const symbols = Array.from(new Set(orders.map((o) => o.symbol)));
  const prices = await getPrices(symbols);

  let count = 0;
  for (const order of orders) {
    const exit = applySpread(prices[order.symbol], order.side, 'close');
    const liq = Number(order.liquidation_price);
    const hitLiq = isLiquidated(order.side, prices[order.symbol], liq);
    const closePrice = hitLiq ? liq : exit;
    const pnl = hitLiq
      ? money(-Number(order.margin))
      : pnlFor(order.side, Number(order.entry_price), closePrice, Number(order.quantity));

    try {
      await settleOrder(order.id, closePrice, pnl, hitLiq ? 'liquidated' : 'closed', reason);
      count += 1;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'ORDER_NOT_OPEN')) throw err;
    }
  }
  return count;
}

/**
 * Stores the latest equity figure. The write is not awaited: every caller already holds the freshly computed
 * number (and returns it to the client), so the poll no longer waits on a database round trip.
 */
function persistEquity(account: DbAccount, equity: number): DbAccount {
  void supabaseAdmin()
    .from('accounts')
    .update({ equity })
    .eq('id', account.id)
    .then(
      ({ error }) => { if (error) console.error('[engine] equity persist failed', error.message); },
      (err: unknown) => console.error('[engine] equity persist failed', err),
    );
  return { ...account, equity };
}

export interface EvaluationResult {
  account: DbAccount;
  positions: Position[];
  metrics: AccountMetrics;
  risk: RiskResult;
  liquidated: AutoClose[];
}

/**
 * The heart of the risk engine. Runs on every positions poll, after a close, and on demand. Steps 1, 3 and 4 act only
 * when RISK_ENGINE=on (see risk.ts); with the engine off this function just reads and computes.
 *   1. liquidate anything past its liquidation price
 *   2. recompute equity from live marks
 *   3. fail the account if a drawdown floor is breached (flattening positions)
 *   4. pass the account if the evaluation target is met
 *   5. persist the equity snapshot
 */
export async function evaluateAccount(input: DbAccount | string, preloadedOrders?: DbOrder[]): Promise<EvaluationResult> {
  let account = typeof input === 'string' ? await getAccount(input) : input;

  // 1 — liquidation sweep (callers that already read the open orders pass them in, saving a database round trip)
  let orders = preloadedOrders ?? (await getOpenOrders(account.id));
  let positions = await buildPositions(orders);
  const liquidated = await sweepLiquidations(positions);

  if (liquidated.length > 0) {
    account = await getAccount(account.id);
    orders = await getOpenOrders(account.id);
    positions = await buildPositions(orders);
  }

  // 2 — equity + rule check
  let metrics = computeMetrics(account, positions);
  const reason = checkBreach(metrics);
  const risk: RiskResult = {
    breached: false,
    reason: null,
    status: account.status,
    closed_orders: liquidated.length,
  };

  const terminal = account.status !== 'active';

  // 3 — drawdown breach
  if (reason && !terminal) {
    const flattened = await forceCloseAll(account.id, 'breach');
    account = await getAccount(account.id);
    positions = [];
    metrics = computeMetrics(account, positions);

    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .update({
        status: 'failed',
        breach_reason: breachMessage(reason, metrics),
        equity: metrics.equity,
      })
      .eq('id', account.id)
      .select('*')
      .single<DbAccount>();
    if (error) throw new ApiError('INTERNAL_ERROR', error.message);

    return {
      account: data,
      positions,
      metrics,
      risk: {
        breached: true,
        reason,
        status: 'failed',
        closed_orders: liquidated.length + flattened,
      },
      liquidated,
    };
  }

  // 4 — evaluation passed (One-Step only; Instant has no target)
  if (RISK_ENGINE_ON && !terminal && metrics.target_reached && account.profit_target_pct !== null) {
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .update({ status: 'passed', equity: metrics.equity })
      .eq('id', account.id)
      .select('*')
      .single<DbAccount>();
    if (error) throw new ApiError('INTERNAL_ERROR', error.message);

    await issueCertificate({
      user_id: account.user_id,
      account_id: account.id,
      type: 'eval_pass',
      amount: Number(account.size),
      is_manual: false,
      metadata: { plan_key: account.plan_key, profit_pct: metrics.profit_pct },
    });

    return {
      account: data,
      positions,
      metrics,
      risk: { ...risk, status: 'passed', passed: true },
      liquidated,
    };
  }

  // 5 — persist the equity snapshot
  account = persistEquity(account, metrics.equity);
  return { account, positions, metrics, risk: { ...risk, status: account.status }, liquidated };
}
