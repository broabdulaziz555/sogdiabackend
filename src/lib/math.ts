import { SPREAD_BPS } from '@/config/pricing';
import type { DbOrder, OrderSide, Position } from '@/lib/types';

/** Round money to cents. */
export function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round a price to 10 dp (matches numeric(28,10) in Postgres). */
export function price(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e10) / 1e10;
}

export function pct(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Apply the house spread against the trader.
 *   open  long  -> buy at ask  (worse = higher)
 *   open  short -> sell at bid (worse = lower)
 *   close long  -> sell at bid (worse = lower)
 *   close short -> buy at ask  (worse = higher)
 */
export function applySpread(
  mid: number,
  side: OrderSide,
  action: 'open' | 'close',
  bps: number = SPREAD_BPS,
): number {
  const factor = bps / 10_000;
  const payMore = (side === 'long') === (action === 'open');
  return price(payMore ? mid * (1 + factor) : mid * (1 - factor));
}

export function bidAsk(mid: number, bps: number = SPREAD_BPS) {
  const factor = bps / 10_000;
  return { bid: price(mid * (1 - factor)), ask: price(mid * (1 + factor)) };
}

/** Notional exposure in quote currency. */
export function positionSize(margin: number, leverage: number): number {
  return money(margin * leverage);
}

/** Base-currency quantity bought/sold. */
export function quantity(notional: number, entryPrice: number): number {
  return Math.round((notional / entryPrice) * 1e10) / 1e10;
}

/**
 * Liquidation price: the trader is wiped out when the adverse move equals
 * 100 / leverage percent, i.e. when the loss equals the posted margin.
 */
export function liquidationPrice(
  entryPrice: number,
  side: OrderSide,
  leverage: number,
): number {
  const move = 1 / leverage;
  return price(side === 'long' ? entryPrice * (1 - move) : entryPrice * (1 + move));
}

/** Realised or unrealised PnL in quote currency. */
export function pnlFor(
  side: OrderSide,
  entryPrice: number,
  exitPrice: number,
  qty: number,
): number {
  const diff = side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
  return money(diff * qty);
}

/** PnL as a percentage of posted margin (what the trader actually feels). */
export function pnlPct(pnl: number, margin: number): number {
  if (margin <= 0) return 0;
  return pct((pnl / margin) * 100);
}

/** Has the mark crossed the liquidation level? */
export function isLiquidated(
  side: OrderSide,
  markPrice: number,
  liqPrice: number,
): boolean {
  return side === 'long' ? markPrice <= liqPrice : markPrice >= liqPrice;
}

/**
 * Decorate an open order with live marks.
 * The exit spread is applied so unrealised PnL matches what a close
 * would actually realise right now.
 */
export function toPosition(order: DbOrder, midPrice: number): Position {
  const exit = applySpread(midPrice, order.side, 'close');
  const liq = isLiquidated(order.side, midPrice, Number(order.liquidation_price));
  const effectiveExit = liq ? Number(order.liquidation_price) : exit;
  const unrealized = liq
    ? money(-Number(order.margin))
    : pnlFor(order.side, Number(order.entry_price), effectiveExit, Number(order.quantity));

  return {
    ...order,
    margin: Number(order.margin),
    position_size: Number(order.position_size),
    quantity: Number(order.quantity),
    entry_price: Number(order.entry_price),
    liquidation_price: Number(order.liquidation_price),
    mark_price: price(midPrice),
    unrealized_pnl: unrealized,
    unrealized_pnl_pct: pnlPct(unrealized, Number(order.margin)),
  };
}

/**
 * Sum of posted margin across open positions.
 *
 * Throws on a non-numeric margin rather than letting `Number(null) === 0`
 * or a NaN quietly shrink the total — an understated used-margin figure
 * silently lets a trader over-commit, and an overstated one looks
 * identical to a legitimate "no free margin".
 */
export function usedMargin(orders: Array<Pick<DbOrder, 'margin'> & { id?: string }>): number {
  let total = 0;

  for (const order of orders) {
    const value = order.margin as unknown;
    if (value === null || value === undefined || value === '') {
      throw new Error(`Order ${order.id ?? '(unknown)'} has no margin value.`);
    }
    const margin = Number(value);
    if (!Number.isFinite(margin)) {
      throw new Error(
        `Order ${order.id ?? '(unknown)'} has a non-numeric margin: ${JSON.stringify(value)}.`,
      );
    }
    total += margin;
  }

  return money(total);
}
