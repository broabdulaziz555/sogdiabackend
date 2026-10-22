import { ApiError } from '@/lib/http';
import { money, pct, usedMargin } from '@/lib/math';
import type { AccountMetrics, BreachReason, DbAccount, Position } from '@/lib/types';

/**
 * Coerce a numeric account column, refusing the values that silently
 * become 0.
 *
 * `Number(null)` and `Number('')` are both 0 and both finite, so a
 * missing column used to sail through as a legitimate zero balance —
 * and a zero balance looks exactly like "no free margin". Missing data
 * must fail loudly, never arrive as a plausible number.
 */
function accountNumber(account: DbAccount, field: keyof DbAccount): number {
  const value = account[field] as unknown;

  if (value === null || value === undefined || value === '') {
    throw new ApiError(
      'INTERNAL_ERROR',
      `Account data is incomplete: "${String(field)}" is missing. This is a data fault, not a margin shortfall.`,
      { account_id: account.id, field: String(field), value: value === undefined ? 'undefined' : value },
    );
  }

  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new ApiError(
      'INTERNAL_ERROR',
      `Account data is invalid: "${String(field)}" is not a number.`,
      { account_id: account.id, field: String(field), value: JSON.stringify(value) },
    );
  }
  return num;
}

/**
 * Drawdown model
 * --------------
 * equity        = realised balance + unrealised PnL of open positions
 * daily DD floor = daily_start_balance * (1 - daily_dd_pct/100)   [reset 00:00 UTC]
 * max DD floor   = size                * (1 - max_dd_pct/100)     [static, from day one]
 *
 * One-Step : 4% daily / 6% max      Instant : 3% daily / 5% max
 *
 * This is the ONE place free margin is computed. Every reader — the
 * account endpoints, the positions poll and the order validator — goes
 * through here, so the figure a trader sees and the figure an order is
 * checked against cannot diverge.
 */
export function computeMetrics(account: DbAccount, positions: Position[]): AccountMetrics {
  const balance = accountNumber(account, 'balance');
  const size = accountNumber(account, 'size');
  const dailyStart = accountNumber(account, 'daily_start_balance');

  const unrealized = money(positions.reduce((s, p) => s + p.unrealized_pnl, 0));
  const equity = money(balance + unrealized);
  const used = usedMargin(positions);

  const dailyLimit = money(dailyStart * (1 - Number(account.daily_dd_pct) / 100));
  const maxLimit = money(size * (1 - Number(account.max_dd_pct) / 100));

  const profitTarget =
    account.profit_target_pct === null
      ? null
      : money(size * (1 + Number(account.profit_target_pct) / 100));

  return {
    equity,
    unrealized_pnl: unrealized,
    used_margin: used,
    // NOT clamped at zero. An over-committed account reports a negative
    // figure, which is the truth and is visibly wrong; clamping made a
    // corrupt account indistinguishable from an exhausted one.
    free_margin: money(balance - used),
    open_positions: positions.length,
    daily_dd_limit: dailyLimit,
    max_dd_limit: maxLimit,
    daily_dd_remaining: money(equity - dailyLimit),
    max_dd_remaining: money(equity - maxLimit),
    daily_dd_used_pct: dailyStart > 0 ? pct(((dailyStart - equity) / dailyStart) * 100) : 0,
    max_dd_used_pct: size > 0 ? pct(((size - equity) / size) * 100) : 0,
    profit_target: profitTarget,
    profit_pct: size > 0 ? pct(((equity - size) / size) * 100) : 0,
    // Evaluation passes on *realised* balance, so a trader can't pass on an
    // open floating profit and then give it straight back.
    target_reached: profitTarget !== null && balance >= profitTarget,
  };
}

/** Which rule, if any, the account has just violated. Max DD is checked first. */
export function checkBreach(metrics: AccountMetrics): BreachReason {
  if (metrics.equity <= metrics.max_dd_limit) return 'MAX_DRAWDOWN';
  if (metrics.equity <= metrics.daily_dd_limit) return 'DAILY_DRAWDOWN';
  return null;
}

export function breachMessage(reason: Exclude<BreachReason, null>, metrics: AccountMetrics): string {
  return reason === 'MAX_DRAWDOWN'
    ? `Max drawdown breached: equity ${metrics.equity} fell to or below the floor of ${metrics.max_dd_limit}.`
    : `Daily drawdown breached: equity ${metrics.equity} fell to or below today's floor of ${metrics.daily_dd_limit}.`;
}

/** Only `active` accounts may open new positions. */
export function isTradable(account: DbAccount): boolean {
  return account.status === 'active';
}
