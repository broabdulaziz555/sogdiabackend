import { ApiError, handle, ok } from '@/lib/http';
import { requireAccount, requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase';
import { money, pct, pnlPct } from '@/lib/math';
import { accountIdSchema, paginationSchema } from '@/lib/validation';
import type { DbOrder, OrderStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

  // "closed" as the clients use it means every finished trade — liquidations included. Matching the literal
  // status hid liquidated positions from History altogether.
  if (status === 'open') query = query.eq('status', 'open');
  else if (status === 'liquidated') query = query.eq('status', 'liquidated');
  else query = query.in('status', ['closed', 'liquidated']);

  const { data, error, count } = await query;
  if (error) throw new ApiError('INTERNAL_ERROR', error.message);

  const orders = (data ?? []) as DbOrder[];

  // Aggregate stats over the whole account, not just this page.
  const { data: allClosed } = await supabaseAdmin()
    .from('orders')
    .select('pnl, side, closed_at')
    .eq('account_id', account_id)
    .in('status', ['closed', 'liquidated'])
    .order('closed_at', { ascending: true });

  const closedRows = (allClosed ?? []) as Array<{ pnl: number | null; side: string; closed_at: string | null }>;
  const pnls: number[] = closedRows.map((r) => Number(r.pnl ?? 0));
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p <= 0).length;

  // Performance statistics (prop-firm dashboard style), over every closed trade of the account.
  const winPnls = pnls.filter((p) => p > 0), lossPnls = pnls.filter((p) => p < 0);
  const grossProfit = winPnls.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));
  let streakW = 0, streakL = 0, maxW = 0, maxL = 0;
  for (const p of pnls) {
    if (p > 0) { streakW += 1; streakL = 0; } else { streakL += 1; streakW = 0; }
    maxW = Math.max(maxW, streakW); maxL = Math.max(maxL, streakL);
  }
  const days = new Set(closedRows.map((r) => (r.closed_at ?? '').slice(0, 10)).filter(Boolean));

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
      gross_profit: money(grossProfit),
      gross_loss: money(grossLoss),
      profit_factor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : null,
      avg_win: winPnls.length ? money(grossProfit / winPnls.length) : 0,
      avg_loss: lossPnls.length ? money(-grossLoss / lossPnls.length) : 0,
      expectancy: pnls.length ? money(pnls.reduce((a, b) => a + b, 0) / pnls.length) : 0,
      best_trade: pnls.length ? money(Math.max(...pnls)) : 0,
      worst_trade: pnls.length ? money(Math.min(...pnls)) : 0,
      max_win_streak: maxW,
      max_loss_streak: maxL,
      longs: closedRows.filter((r) => r.side === 'long').length,
      shorts: closedRows.filter((r) => r.side === 'short').length,
      trading_days: days.size,
    },
  });
});
