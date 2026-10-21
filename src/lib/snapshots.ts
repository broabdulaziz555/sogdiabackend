import { supabaseAdmin } from '@/lib/supabase';

export type SnapshotSource = 'daily_close' | 'trade_close' | 'manual';

/**
 * Append-only equity curve. Cheap to write, powers the account chart
 * without recomputing historical PnL.
 */
export async function snapshotEquity(
  accountId: string,
  equity: number,
  balance: number,
  source: SnapshotSource = 'trade_close',
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('equity_snapshots')
    .insert({ account_id: accountId, equity, balance, source });

  // Never let telemetry break a trade.
  if (error) console.error('[snapshots] insert failed', error.message);
}

export async function getEquityCurve(accountId: string, limit = 500) {
  const { data } = await supabaseAdmin()
    .from('equity_snapshots')
    .select('equity, balance, source, taken_at')
    .eq('account_id', accountId)
    .order('taken_at', { ascending: true })
    .limit(limit);

  const rows = (data ?? []) as Array<{
    equity: number;
    balance: number;
    source: string;
    taken_at: string;
  }>;

  return rows.map((r) => ({
    equity: Number(r.equity),
    balance: Number(r.balance),
    source: r.source,
    taken_at: r.taken_at,
  }));
}
