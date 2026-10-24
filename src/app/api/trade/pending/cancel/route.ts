import { handle, ok, readJson } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { cancelPending } from '@/lib/pending';
import { cancelPendingSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** POST /api/trade/pending/cancel — cancel a working order (or dismiss a failed one). Idempotent. */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  const body = cancelPendingSchema.parse(await readJson(req));
  const account = await requireAccount(body.account_id, user);
  await cancelPending(body.id, account.id);
  return ok({ id: body.id });
});
