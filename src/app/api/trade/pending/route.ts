import { ApiError, handle, ok, readJson } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { assertTradable } from '@/lib/binance';
import { createPending } from '@/lib/pending';
import { isTradable } from '@/lib/risk';
import { rateLimit } from '@/lib/ratelimit';
import { pendingSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * POST /api/trade/pending — place a limit or stop order that lives on the server (survives a closed tab).
 * Idempotent on `id` (client-generated UUID, which also becomes the position id when it fills).
 */
export const POST = handle(async (req) => {
  const user = await requireUser(req);
  rateLimit(`trade-pending:${user.id}`, 120, 60_000);
  const body = pendingSchema.parse(await readJson(req));
  const symbol = assertTradable(body.symbol);
  const account = await requireAccount(body.account_id, user);

  if (!isTradable(account)) throw new ApiError('ACCOUNT_NOT_TRADABLE', `Account status is "${account.status}" — trading is disabled.`);
  if (body.leverage > account.max_leverage) throw new ApiError('VALIDATION_ERROR', `Leverage above the account maximum of ${account.max_leverage}x.`);
  if (body.margin > Number(account.balance)) throw new ApiError('INSUFFICIENT_MARGIN', 'Margin is larger than the account balance.');

  const order = await createPending({
    id: body.id,
    accountId: account.id,
    user,
    ownerId: account.user_id,
    symbol,
    side: body.side,
    kind: body.kind,
    trigger: body.trigger_price,
    leverage: body.leverage,
    margin: body.margin,
    takeProfit: body.take_profit,
    stopLoss: body.stop_loss,
  });
  return ok({ order });
});
