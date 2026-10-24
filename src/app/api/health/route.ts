import { handle, ok } from '@/lib/http';
import { getPrice } from '@/lib/binance';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/health — liveness + upstream check for uptime monitors. */
export const GET = handle(async (req) => {
  const started = Date.now();

  let priceFeed: 'up' | 'down' = 'up';
  try {
    await getPrice('BTCUSDT');
  } catch {
    priceFeed = 'down';
  }

  // Which database is this server really talking to? (host only - it is a public value). With the cron secret the live
  // row counts are included too, so "the dashboard shows rows the table editor does not" can be settled in one request.
  let database: Record<string, unknown> = { host: (() => { try { return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').host; } catch { return null; } })() };
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('x-cron-secret') === secret) {
    const count = async (table: string) => {
      const r = await supabaseAdmin().from(table).select('id', { count: 'exact', head: true });
      return r.error ? `error: ${r.error.message}` : r.count;
    };
    const [accounts, users, orders] = await Promise.all([count('accounts'), count('users'), count('orders')]);
    database = { ...database, accounts, users, orders };
  }

  return ok({
    database,
    status: priceFeed === 'up' ? 'healthy' : 'degraded',
    price_feed: priceFeed,
    latency_ms: Date.now() - started,
    version: '1.1.0',
    time: new Date().toISOString(),
  });
});
