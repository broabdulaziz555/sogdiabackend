import { money, pct } from '@/lib/math';
import { supabaseAdmin } from '@/lib/supabase';
import type { DbAccount, DbUser } from '@/lib/types';

export type PayoutBlocker =
  | 'KYC_NOT_VERIFIED'
  | 'NO_WALLET'
  | 'ACCOUNT_NOT_ELIGIBLE'
  | 'NO_PROFIT'
  | 'CYCLE_NOT_ELAPSED'
  | 'OPEN_POSITIONS'
  | 'MIN_TRADING_DAYS'
  | 'CONSISTENCY_RULE';

export interface TradingStats {
  /** Distinct UTC days on which a position was closed. */
  trading_days: number;
  /** Largest single-day realised profit. */
  best_day_profit: number;
  total_profit: number;
}

/** Realised-trading stats used by the optional add-on payout rules. */
export async function getTradingStats(accountId: string): Promise<TradingStats> {
  const { data } = await supabaseAdmin()
    .from('orders')
    .select('pnl, closed_at')
    .eq('account_id', accountId)
    .in('status', ['closed', 'liquidated']);

  const byDay = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ pnl: number | null; closed_at: string | null }>) {
    if (!row.closed_at) continue;
    const day = row.closed_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + Number(row.pnl ?? 0));
  }

  const dayProfits = [...byDay.values()];
  return {
    trading_days: byDay.size,
    best_day_profit: dayProfits.length ? money(Math.max(...dayProfits, 0)) : 0,
    total_profit: money(dayProfits.reduce((s, v) => s + v, 0)),
  };
}

export interface PayoutEligibility {
  eligible: boolean;
  reasons: PayoutBlocker[];
  profit: number;
  max_payout: number;
  split_pct: number;
  next_payout_at: string | null;
  days_remaining: number;
  trading_days?: number;
  min_trading_days?: number;
}

/**
 * A payout is available when:
 *   - KYC verified and a payout wallet is on file
 *   - the account is active or passed (not failed/frozen/breached/closed)
 *   - realised balance is above the starting size
 *   - the 14-day cycle has elapsed since creation or the last payout
 *   - no positions are open (profit must be realised)
 *
 * The trader receives `profit * payout_split_pct` (80%).
 */
export function evaluatePayoutEligibility(
  user: DbUser,
  account: DbAccount,
  openPositions: number,
  stats?: TradingStats,
  now: Date = new Date(),
): PayoutEligibility {
  const reasons: PayoutBlocker[] = [];

  // Optional add-on rules — disabled by default (0 / null), so the
  // standard 14-day cycle behaves exactly as before unless a rule-set
  // explicitly turns them on.
  if (stats) {
    if (account.min_trading_days > 0 && stats.trading_days < account.min_trading_days) {
      reasons.push('MIN_TRADING_DAYS');
    }
    if (
      account.consistency_pct !== null &&
      stats.total_profit > 0 &&
      (stats.best_day_profit / stats.total_profit) * 100 > Number(account.consistency_pct)
    ) {
      reasons.push('CONSISTENCY_RULE');
    }
  }

  if (user.kyc_status !== 'verified') reasons.push('KYC_NOT_VERIFIED');
  if (!user.wallet_address) reasons.push('NO_WALLET');
  if (account.status !== 'active' && account.status !== 'passed') {
    reasons.push('ACCOUNT_NOT_ELIGIBLE');
  }
  if (openPositions > 0) reasons.push('OPEN_POSITIONS');

  const profit = money(Number(account.balance) - Number(account.size));
  if (profit <= 0) reasons.push('NO_PROFIT');

  const anchor = account.last_payout_at
    ? new Date(account.last_payout_at)
    : new Date(account.created_at);
  const unlockAt = new Date(anchor.getTime() + account.payout_cycle_days * 86_400_000);
  const msRemaining = unlockAt.getTime() - now.getTime();
  if (msRemaining > 0) reasons.push('CYCLE_NOT_ELAPSED');

  const split = Number(account.payout_split_pct);

  return {
    eligible: reasons.length === 0,
    reasons,
    profit: Math.max(profit, 0),
    max_payout: money(Math.max(profit, 0) * (split / 100)),
    split_pct: split,
    next_payout_at: unlockAt.toISOString(),
    days_remaining: Math.max(Math.ceil(msRemaining / 86_400_000), 0),
    trading_days: stats?.trading_days,
    min_trading_days: account.min_trading_days,
  };
}

/** Trader's share of a gross profit withdrawal. */
export function splitPayout(gross: number, splitPct: number) {
  const net = money(gross * (splitPct / 100));
  return { gross: money(gross), net, firm_fee: money(gross - net), split_pct: pct(splitPct) };
}
