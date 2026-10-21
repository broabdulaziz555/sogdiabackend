import { handle, ok } from '@/lib/http';
import { getPrices } from '@/lib/binance';
import { bidAsk } from '@/lib/math';
import { SPREAD_BPS } from '@/config/pricing';
import { TOP_50_USDT_PAIRS } from '@/config/symbols';

export const dynamic = 'force-dynamic';

/** GET /api/market/prices?symbols=BTCUSDT,ETHUSDT */
export const GET = handle(async (req) => {
  const url = new URL(req.url);
  const raw = url.searchParams.get('symbols');
  const symbols = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...TOP_50_USDT_PAIRS];

  const prices = await getPrices(symbols);

  return ok({
    spread_bps: SPREAD_BPS,
    prices: Object.entries(prices).map(([symbol, price]) => ({
      symbol,
      price,
      ...bidAsk(price),
    })),
    fetched_at: new Date().toISOString(),
  });
});
