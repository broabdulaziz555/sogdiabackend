import { ApiError } from '@/lib/http';
import { isTradableSymbol, TOP_50_USDT_PAIRS } from '@/config/symbols';

const PRIMARY = (process.env.BINANCE_API_URL ?? 'https://api.binance.com').replace(/\/$/, '');
/**
 * Market-data mirror. api.binance.com is geo-blocked (HTTP 451) from some regions and can hang on others;
 * the mirror serves the same public endpoints. Both hosts are asked at once and the first good answer wins.
 */
const HOSTS = [PRIMARY, 'https://data-api.binance.vision'].filter((v, i, a) => a.indexOf(v) === i);

/** Tiny in-process cache so a burst of polls / orders hits Binance once. */
const TTL_MS = 1_500;
/** If every upstream host fails, a price this young may still be used instead of rejecting the request. */
const STALE_OK_MS = 10_000;
const cache = new Map<string, { price: number; at: number }>();

function readCache(symbol: string, maxAgeMs = TTL_MS): number | null {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.price;
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

/** Identical requests made while one is in flight share the same upstream call. */
const inflight = new Map<string, Promise<unknown>>();

async function fetchHost(host: string, path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`${host}${path}`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Price feed responded ${res.status}.`);
  return res.json();
}

async function binanceFetch(path: string): Promise<unknown> {
  const pending = inflight.get(path);
  if (pending) return pending;

  const run = (async () => {
    const ctrls = HOSTS.map(() => new AbortController());
    const timers = ctrls.map((c) => setTimeout(() => c.abort(), 4_000));
    try {
      return await Promise.any(
        HOSTS.map(async (host, i) => {
          const body = await fetchHost(host, path, ctrls[i].signal);
          ctrls.forEach((c, j) => { if (j !== i) c.abort(); }); // winner found: stop the others
          return body;
        }),
      );
    } catch {
      throw new ApiError('UPSTREAM_ERROR', 'Could not reach the price feed.');
    } finally {
      timers.forEach(clearTimeout);
    }
  })();

  inflight.set(path, run);
  try {
    return await run;
  } finally {
    inflight.delete(path);
  }
}

type TickerRow = { symbol: string; price: string };

function absorb(rows: unknown, wanted: Set<string>, out: Record<string, number>): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows as TickerRow[]) {
    if (!wanted.has(row.symbol)) continue;
    const price = Number(row.price);
    if (Number.isFinite(price) && price > 0) {
      out[row.symbol] = price;
      writeCache(row.symbol, price);
    }
  }
}

/** Live mid price for one whitelisted symbol. */
export async function getPrice(symbol: string): Promise<number> {
  const sym = assertTradable(symbol);
  const prices = await getPrices([sym]);
  return prices[sym];
}

/**
 * Live mid prices for many symbols in a single upstream call.
 *
 * strict (default): every requested symbol must resolve, otherwise UPSTREAM_ERROR.
 * non-strict:       symbols the feed does not list are simply left out — used by the public
 *                   price board so one delisted pair can never blank the whole terminal.
 */
export async function getPrices(
  symbols: string[] = [...TOP_50_USDT_PAIRS],
  strict = true,
): Promise<Record<string, number>> {
  const wanted = Array.from(new Set(symbols.map(assertTradable)));
  const out: Record<string, number> = {};
  let missing: string[] = [];

  for (const sym of wanted) {
    const cached = readCache(sym);
    if (cached !== null) out[sym] = cached;
    else missing.push(sym);
  }
  if (missing.length === 0) return out;

  const want = new Set(missing);
  try {
    try {
      const query = encodeURIComponent(JSON.stringify(missing));
      absorb(await binanceFetch(`/api/v3/ticker/price?symbols=${query}`), want, out);
    } catch {
      // One unknown / delisted symbol makes Binance reject the whole symbols= call; the full listing has no such failure mode.
      absorb(await binanceFetch('/api/v3/ticker/price'), want, out);
    }
  } catch {
    /* every host failed — fall through to the short stale window below */
  }

  missing = missing.filter((s) => out[s] === undefined);
  for (const sym of missing) {
    const stale = readCache(sym, STALE_OK_MS);
    if (stale !== null) out[sym] = stale;
  }

  missing = missing.filter((s) => out[s] === undefined);
  if (strict && missing.length > 0) {
    throw new ApiError('UPSTREAM_ERROR', `No price available for ${missing.join(', ')}.`);
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
