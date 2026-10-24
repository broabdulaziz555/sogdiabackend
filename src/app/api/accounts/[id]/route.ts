import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { evaluateAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/accounts/{id} — recomputes equity + risk before responding. */
export const GET = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser(req);
  const account = await requireAccount(ctx.params.id, user);
  const result = await evaluateAccount(account);

  return ok({
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: {
      breached: result.risk.breached,
      reason: result.risk.reason,
      status: result.risk.status,
    },
  });
});
