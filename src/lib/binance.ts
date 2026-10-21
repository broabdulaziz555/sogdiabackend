import { ApiError } from '@/lib/http';
import { isTradableSymbol, TOP_50_USDT_PAIRS } from '@/config/symbols';

const BASE_URL = process.env.BINANCE_API_URL ?? 'https://api.binance.com';

/** Tiny in-process cache so a burst of position polls hits Binance once. */
const TTL_MS = 1_500;
const cache = new Map<string, { price: number; at: number }>();

function readCache(symbol: string): number | null {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;
  return null;
}

function writeCache(symbol: string, price: number): void {
  cache.set(symbol, { price, at: Date.now() });
}

export function assertTradable(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (!isTradableSymbol(upper)) {
    throw new ApiError(
      'SYMBOL_NOT_ALLOWED',
      `${upper} is not in the SOGDIA top-50 USDT universe.`,
    );
  }
  return upper;
}

async function binanceFetch(path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      // Binance is fast; fail loudly rather than hanging a trade request.
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    throw new ApiError('UPSTREAM_ERROR', 'Could not reach the price feed.');
  }
  if (!res.ok) {
    throw new ApiError('UPSTREAM_ERROR', `Price feed responded ${res.status}.`);
  }
  return res.json();
}

/** Live mid price for one whitelisted symbol. */
export async function getPrice(symbol: string): Promise<number> {
  const sym = assertTradable(symbol);

  const cached = readCache(sym);
  if (cached !== null) return cached;

  const json = (await binanceFetch(`/api/v3/ticker/price?symbol=${sym}`)) as {
    symbol?: string;
    price?: string;
  };

  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ApiError('UPSTREAM_ERROR', `No price available for ${sym}.`);
  }

  writeCache(sym, price);
  return price;
}

/** Live mid prices for many symbols in a single upstream call. */
export async function getPrices(
  symbols: string[] = [...TOP_50_USDT_PAIRS],
): Promise<Record<string, number>> {
  const wanted = Array.from(new Set(symbols.map(assertTradable)));
  const out: Record<string, number> = {};
  const missing: string[] = [];

  for (const sym of wanted) {
    const cached = readCache(sym);
    if (cached !== null) out[sym] = cached;
    else missing.push(sym);
  }
  if (missing.length === 0) return out;

  const query = encodeURIComponent(JSON.stringify(missing));
  const json = (await binanceFetch(`/api/v3/ticker/price?symbols=${query}`)) as Array<{
    symbol: string;
    price: string;
  }>;

  for (const row of json ?? []) {
    const price = Number(row.price);
    if (Number.isFinite(price) && price > 0) {
      out[row.symbol] = price;
      writeCache(row.symbol, price);
    }
  }

  for (const sym of missing) {
    if (out[sym] === undefined) {
      throw new ApiError('UPSTREAM_ERROR', `No price available for ${sym}.`);
    }
  }
  return out;
}

/** 24h stats, handy for a markets table on the frontend. */
export async function get24hStats(symbol: string) {
  const sym = assertTradable(symbol);
  const json = (await binanceFetch(`/api/v3/ticker/24hr?symbol=${sym}`)) as Record<string, string>;
  return {
    symbol: sym,
    price: Number(json.lastPrice),
    change_pct: Number(json.priceChangePercent),
    high: Number(json.highPrice),
    low: Number(json.lowPrice),
    volume: Number(json.quoteVolume),
  };
}
