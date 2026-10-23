import { ApiError } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase';
import { getPrices } from '@/lib/binance';
import { bidAsk } from '@/lib/math';
import { executeOpen } from '@/lib/trading';
import type { DbUser, OrderSide } from '@/lib/types';

export type PendingKind = 'limit' | 'stop';

export interface PendingRow {
  id: string;
  account_id: string;
  user_id: string;
  symbol: string;
  side: OrderSide;
  kind: PendingKind;
  trigger_price: number;
  leverage: number;
  margin: number;
  take_profit: number | null;
  stop_loss: number | null;
  status: 'working' | 'filled' | 'cancelled' | 'failed';
  error: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_WORKING_PENDING = 50;

/** PostgREST / Postgres say this when migration 004 has not been run yet. */
function missingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === '42P01' || err.code === 'PGRST205' || /pending_orders/.test(err.message ?? '') && /does not exist|schema cache/.test(err.message ?? '');
}

let warned = false;
function unavailable(): ApiError {
  if (!warned) {
    warned = true;
    console.warn('[pending] table public.pending_orders is missing — run supabase/004_pending_orders.sql. Limit/stop orders stay in the browser until then.');
  }
  return new ApiError('FEATURE_UNAVAILABLE', 'Server-side limit/stop orders are not enabled yet.');
}

const norm = (r: Record<string, unknown>): PendingRow => ({
  ...(r as unknown as PendingRow),
  trigger_price: Number(r.trigger_price),
  margin: Number(r.margin),
  take_profit: r.take_profit == null ? null : Number(r.take_profit),
  stop_loss: r.stop_loss == null ? null : Number(r.stop_loss),
});

/** Working orders plus the ones that failed in the last day (so the trader sees why). Never throws on a missing table. */
export async function listPending(accountId: string): Promise<PendingRow[]> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data, error } = await supabaseAdmin()
    .from('pending_orders')
    .select('*')
    .eq('account_id', accountId)
    .or(`status.eq.working,and(status.eq.failed,updated_at.gte.${since})`)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    if (missingTable(error)) { void unavailable(); return []; }
    throw new ApiError('INTERNAL_ERROR', error.message);
  }
  return (data ?? []).map(norm);
}

export interface CreatePendingInput {
  id?: string;
  accountId: string;
  user: Pick<DbUser, 'id'>;
  ownerId: string;
  symbol: string;
  side: OrderSide;
  kind: PendingKind;
  trigger: number;
  leverage: number;
  margin: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}

/** Idempotent on `id`: repeating the call returns the stored order. */
export async function createPending(i: CreatePendingInput): Promise<PendingRow> {
  const admin = supabaseAdmin();
  const { count, error: cErr } = await admin
    .from('pending_orders')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', i.accountId)
    .eq('status', 'working');
  if (cErr) { if (missingTable(cErr)) throw unavailable(); throw new ApiError('INTERNAL_ERROR', cErr.message); }
  if ((count ?? 0) >= MAX_WORKING_PENDING) throw new ApiError('VALIDATION_ERROR', `At most ${MAX_WORKING_PENDING} working orders per account.`);

  const { data, error } = await admin
    .from('pending_orders')
    .insert({
      ...(i.id ? { id: i.id } : {}),
      account_id: i.accountId,
      user_id: i.ownerId,
      symbol: i.symbol,
      side: i.side,
      kind: i.kind,
      trigger_price: i.trigger,
      leverage: i.leverage,
      margin: i.margin,
      take_profit: i.takeProfit ?? null,
      stop_loss: i.stopLoss ?? null,
    })
    .select('*')
    .single();
  if (error || !data) {
    if (missingTable(error)) throw unavailable();
    if (i.id && (error as { code?: string } | null)?.code === '23505') {
      const { data: again } = await admin.from('pending_orders').select('*').eq('id', i.id).eq('account_id', i.accountId).maybeSingle();
      if (again) return norm(again);
    }
    throw new ApiError('INTERNAL_ERROR', error?.message ?? 'Order was not stored.');
  }
  return norm(data);
}

/** Cancel a working order, or dismiss a failed one. Idempotent. */
export async function cancelPending(id: string, accountId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('pending_orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .in('status', ['working', 'failed']);
  if (error) { if (missingTable(error)) throw unavailable(); throw new ApiError('INTERNAL_ERROR', error.message); }
}

const crossed = (o: PendingRow, bid: number, ask: number) => {
  if (o.kind === 'limit') return o.side === 'long' ? ask <= o.trigger_price : bid >= o.trigger_price;
  return o.side === 'long' ? ask >= o.trigger_price : bid <= o.trigger_price;
};

async function settle(id: string, status: 'filled' | 'failed', error?: string) {
  await supabaseAdmin()
    .from('pending_orders')
    .update({ status, error: error ?? null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'working');
}

/** Errors that mean "this order can never fill" (as opposed to a passing upstream problem, which is retried next cycle). */
const FINAL = new Set(['INSUFFICIENT_MARGIN', 'VALIDATION_ERROR', 'ACCOUNT_NOT_TRADABLE', 'SYMBOL_NOT_ALLOWED', 'FORBIDDEN', 'NOT_FOUND']);

/**
 * Fill every working order whose trigger the market has crossed. A limit fills at its own price or better, a stop at
 * the market. The pending order's id is used as the position id, so filling twice (two polls at once, a retry after a
 * crash) can never open two positions. Returns the orders after the pass and how many were filled (a fill another request already made counts: the book changed either way).
 */
export async function fillDue(
  user: Pick<DbUser, 'id' | 'role'>,
  pending: PendingRow[],
): Promise<{ pending: PendingRow[]; opened: number; filled: number }> {
  const working = pending.filter((o) => o.status === 'working');
  if (working.length === 0) return { pending, opened: 0, filled: 0 };

  let prices: Record<string, number>;
  try {
    prices = await getPrices(Array.from(new Set(working.map((o) => o.symbol))), false);
  } catch {
    return { pending, opened: 0, filled: 0 };
  }

  let opened = 0;
  let filled = 0;
  const done = new Map<string, PendingRow>();
  for (const o of working) {
    const mid = prices[o.symbol];
    if (!mid) continue;
    const { bid, ask } = bidAsk(mid);
    if (!crossed(o, bid, ask)) continue;
    try {
      const market = o.side === 'long' ? ask : bid;
      const entry = o.kind === 'limit' ? (o.side === 'long' ? Math.min(o.trigger_price, market) : Math.max(o.trigger_price, market)) : undefined;
      const r = await executeOpen({
        user,
        accountId: o.account_id,
        orderId: o.id,
        symbol: o.symbol,
        side: o.side,
        leverage: o.leverage,
        margin: o.margin,
        takeProfit: o.take_profit,
        stopLoss: o.stop_loss,
        entryPrice: entry,
        skipSweep: true,
      });
      if (!r.replayed) opened += 1;
      await settle(o.id, 'filled');
      filled += 1;
      done.set(o.id, { ...o, status: 'filled' });
      console.log('[pending] filled', { id: o.id, kind: o.kind, symbol: o.symbol, side: o.side, replayed: r.replayed });
    } catch (err) {
      if (err instanceof ApiError && FINAL.has(err.code)) {
        await settle(o.id, 'failed', err.message).catch(() => undefined);
        done.set(o.id, { ...o, status: 'failed', error: err.message });
        console.warn('[pending] failed', { id: o.id, code: err.code });
      } else {
        console.warn('[pending] fill postponed', { id: o.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return { pending: pending.map((o) => done.get(o.id) ?? o).filter((o) => o.status === 'working' || o.status === 'failed'), opened, filled };
}
