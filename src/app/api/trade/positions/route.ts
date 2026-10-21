import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { evaluateAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { accountIdSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * GET /api/trade/positions?account_id=uuid
 * Open positions with live PnL. Liquidations are swept on every call,
 * so polling this endpoint (2–5s) drives the liquidation engine.
 */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const { account_id } = accountIdSchema.parse({
    account_id: url.searchParams.get('account_id'),
  });

  const account = await requireAccount(account_id, user);
  const result = await evaluateAccount(account);

  return ok({
    positions: result.positions,
    liquidated: result.liquidated,
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: {
      breached: result.risk.breached,
      reason: result.risk.reason,
      status: result.risk.status,
    },
  });
});
