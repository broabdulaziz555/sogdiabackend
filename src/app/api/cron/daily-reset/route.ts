import { ApiError, handle, ok } from '@/lib/http';
import { requireCronSecret } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { snapshotEquity } from '@/lib/snapshots';
import type { DbAccount } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * POST /api/cron/daily-reset   (header: x-cron-secret)
 * Run at 00:00 UTC. Rolls the daily drawdown floor forward and writes an
 * end-of-day equity snapshot for each active account.
 */
export const POST = handle(async (req) => {
  requireCronSecret(req);
  const admin = supabaseAdmin();
  const resetAt = new Date().toISOString();

  const { data, error } = await admin
    .from('accounts')
    .select('id, equity, balance, status')
    .in('status', ['active', 'passed']);

  if (error) throw new ApiError('INTERNAL_ERROR', error.message);
  const accounts = (data ?? []) as Pick<DbAccount, 'id' | 'equity' | 'balance' | 'status'>[];

  let reset = 0;
  for (const account of accounts) {
    await snapshotEquity(account.id, Number(account.equity), Number(account.balance), 'daily_close');

    const { error: updateError } = await admin
      .from('accounts')
      .update({ daily_start_balance: Number(account.equity), daily_reset_at: resetAt })
      .eq('id', account.id);

    if (!updateError) reset += 1;
  }

  return ok({ accounts_reset: reset, reset_at: resetAt });
});
