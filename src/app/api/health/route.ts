import { handle, ok } from '@/lib/http';
import { getPrice } from '@/lib/binance';

export const dynamic = 'force-dynamic';

/** GET /api/health — liveness + upstream check for uptime monitors. */
export const GET = handle(async () => {
  const started = Date.now();

  let priceFeed: 'up' | 'down' = 'up';
  try {
    await getPrice('BTCUSDT');
  } catch {
    priceFeed = 'down';
  }

  return ok({
    status: priceFeed === 'up' ? 'healthy' : 'degraded',
    price_feed: priceFeed,
    latency_ms: Date.now() - started,
    version: '1.1.0',
    time: new Date().toISOString(),
  });
});
