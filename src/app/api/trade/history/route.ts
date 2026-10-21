import { ApiError, handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { money, pct, pnlPct } from '@/lib/math';
import { accountIdSchema, paginationSchema } from '@/lib/validation';
import type { DbOrder, OrderStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/trade/history?account_id=uuid&limit=50&offset=0&status=closed */
export const GET = handle(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);

  const { account_id } = accountIdSchema.parse({
    account_id: url.searchParams.get('account_id'),
  });
  const { limit, offset } = paginationSchema.parse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  const status = url.searchParams.get('status') as OrderStatus | null;

  await requireAccount(account_id, user);

  let query = supabaseAdmin()
    .from('orders')
    .select('*', { count: 'exact' })
    .eq('account_id', account_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);
  else query = query.in('status', ['closed', 'liquidated']);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const orders = (data ?? []) as DbOrder[];

  // Aggregate stats over the whole account, not just this page.
  const { data: allClosed } = await supabaseAdmin()
    .from('orders')
    .select('pnl')
    .eq('account_id', account_id)
    .in('status', ['closed', 'liquidated']);

  const closedRows = (allClosed ?? []) as Array<{ pnl: number | null }>;
  const pnls: number[] = closedRows.map((r) => Number(r.pnl ?? 0));
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p <= 0).length;

  return ok({
    orders: orders.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      leverage: o.leverage,
      margin: Number(o.margin),
      position_size: Number(o.position_size),
      quantity: Number(o.quantity),
      entry_price: Number(o.entry_price),
      close_price: o.close_price === null ? null : Number(o.close_price),
      pnl: o.pnl === null ? null : Number(o.pnl),
      pnl_pct: o.pnl === null ? null : pnlPct(Number(o.pnl), Number(o.margin)),
      status: o.status,
      close_reason: o.close_reason,
      created_at: o.created_at,
      closed_at: o.closed_at,
    })),
    total: count ?? orders.length,
    limit,
    offset,
    stats: {
      trades: pnls.length,
      wins,
      losses,
      win_rate: pnls.length ? pct((wins / pnls.length) * 100) : 0,
      net_pnl: money(pnls.reduce((s: number, p: number) => s + p, 0)),
    },
  });
});
