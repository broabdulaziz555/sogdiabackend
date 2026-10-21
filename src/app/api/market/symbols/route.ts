import { handle, ok } from '@/lib/http';
import { listSymbols, TOP_50_USDT_PAIRS } from '@/config/symbols';

export const revalidate = 3600;

/** GET /api/market/symbols */
export const GET = handle(async () =>
  ok({ count: TOP_50_USDT_PAIRS.length, symbols: listSymbols() }),
);
