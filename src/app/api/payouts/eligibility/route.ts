import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { getOpenOrders } from '@/lib/engine';
import { evaluatePayoutEligibility, getTradingStats } from '@/lib/payouts';
import { accountIdSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** GET /api/payouts/eligibility?account_id=uuid */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const { account_id } = accountIdSchema.parse({
    account_id: url.searchParams.get('account_id'),
  });

  const account = await requireAccount(account_id, user);
  const [openOrders, stats] = await Promise.all([
    getOpenOrders(account.id),
    getTradingStats(account.id),
  ]);

  return ok(evaluatePayoutEligibility(user, account, openOrders.length, stats));
});
