import { handle, ok, readJson } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { evaluateAccount } from '@/lib/engine';
import { serializeAccount } from '@/lib/accounts';
import { accountIdSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** POST /api/risk/evaluate */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const { account_id } = accountIdSchema.parse(await readJson(req));

  const account = await requireAccount(account_id, user);
  const result = await evaluateAccount(account);

  return ok({
    account: serializeAccount(result.account),
    metrics: result.metrics,
    risk: result.risk,
  });
});
