import { handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { getEquityCurve } from '@/lib/snapshots';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/accounts/{id}/equity-curve?limit=500 */
export const GET = handle(async (req: Request, ctx: { params: { id: string } }) => {
  const user = await requireUser(req);
  const account = await requireAccount(ctx.params.id, user);

  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? 500) || 500, 2000);
  const points = await getEquityCurve(account.id, limit);

  // Anchor the curve at the starting size when the whole history fits in the window, so the first trade already
  // draws a line from the initial balance instead of a single dot / flat stub.
  const size = Number(account.size);
  if (points.length < limit) {
    points.unshift({ equity: size, balance: size, source: 'start', taken_at: account.created_at });
  }

  return ok({
    account_id: account.id,
    starting_size: Number(account.size),
    points,
  });
});
