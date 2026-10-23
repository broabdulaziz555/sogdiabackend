import { handle, ok } from '@/lib/http';
import { requireCronSecret } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { getAccount } from '@/lib/engine';
import { runCycle } from '@/lib/cycle';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/cron/tick   (header: x-cron-secret)
 * Optional but recommended: call it every minute from any scheduler (Render Cron Job, cron-job.org, ...).
 * Runs one engine cycle for every account that has an open position or a working limit/stop order, so liquidations,
 * stop-loss / take-profit and conditional fills happen even when nobody has the terminal open.
 */
export const POST = handle(async (req) => {
  requireCronSecret(req);
  const admin = supabaseAdmin();

  const [open, working] = await Promise.all([
    admin.from('orders').select('account_id').eq('status', 'open').limit(5000),
    admin.from('pending_orders').select('account_id').eq('status', 'working').limit(5000),
  ]);
  const ids = Array.from(new Set([...(open.data ?? []), ...(working.error ? [] : working.data ?? [])].map((r) => String((r as { account_id: string }).account_id))));

  let done = 0;
  let failed = 0;
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const account = await getAccount(id);
        await runCycle({ id: account.user_id, role: 'trader' }, account);
        done += 1;
      } catch (err) {
        failed += 1;
        console.warn('[cron/tick] account failed', { id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return ok({ accounts: ids.length, done, failed });
});
