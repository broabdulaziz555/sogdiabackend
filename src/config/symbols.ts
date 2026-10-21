/**
 * Tradable universe: top 50 Binance USDT spot pairs by volume.
 * Only these symbols may be opened. Keep the list in sync manually or
 * refresh it from /api/v3/ticker/24hr ranked by quoteVolume.
 */

export const TOP_50_USDT_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'TRXUSDT', 'LINKUSDT',
  'TONUSDT', 'DOTUSDT', 'MATICUSDT', 'SHIBUSDT', 'LTCUSDT',
  'BCHUSDT', 'NEARUSDT', 'UNIUSDT', 'APTUSDT', 'ICPUSDT',
  'ETCUSDT', 'FILUSDT', 'ATOMUSDT', 'XLMUSDT', 'INJUSDT',
  'OPUSDT', 'ARBUSDT', 'SUIUSDT', 'HBARUSDT', 'VETUSDT',
  'IMXUSDT', 'RNDRUSDT', 'TIAUSDT', 'GRTUSDT', 'AAVEUSDT',
  'ALGOUSDT', 'SEIUSDT', 'FTMUSDT', 'SANDUSDT', 'MANAUSDT',
  'AXSUSDT', 'THETAUSDT', 'EOSUSDT', 'FLOWUSDT', 'EGLDUSDT',
  'CHZUSDT', 'GALAUSDT', 'PEPEUSDT', 'WIFUSDT', 'ORDIUSDT',
] as const;

export type TradableSymbol = (typeof TOP_50_USDT_PAIRS)[number];

const SYMBOL_SET = new Set<string>(TOP_50_USDT_PAIRS);

export function isTradableSymbol(symbol: string): symbol is TradableSymbol {
  return SYMBOL_SET.has(symbol.toUpperCase());
}

export function listSymbols() {
  return TOP_50_USDT_PAIRS.map((symbol) => ({
    symbol,
    base: symbol.replace(/USDT$/, ''),
    quote: 'USDT',
  }));
}
