// ─────────────────────────────────────────────────────────────────────────────
// REAL MARKET DATA PROVIDERS
// Free public APIs, no key required. The reason this module exists: TradingView
// and Binance's bulk ticker only cover exchange-listed coins, so wildcard /
// DEX-only discovery tokens ended up on the random-walk "Live Price Simulator"
// and their price + PnL were not real.
//
// Every provider is tried in order of reliability and the first one that
// answers wins:
//   1. Binance klines / ticker      -> CEX-listed coins (real OHLC + 24h change)
//   2. GeckoTerminal token price    -> ANY token with a contract address (DEX)
//   3. GeckoTerminal pool OHLCV     -> real DEX candles for wildcard tokens
//   4. CoinGecko market_chart       -> real history for coins with a Gecko id
//   5. DexScreener                  -> real DEX spot price + pool address
// ─────────────────────────────────────────────────────────────────────────────

export interface CandlePoint {
  t: number; // epoch ms
  price: number;
  volume: number;
}

export interface RealMarketResult {
  /** Human-readable provider name, shown in the UI price-source badge. */
  source: string;
  /** true = price came from a real market feed, false = nothing answered. */
  isReal: boolean;
  price: number;
  change24h?: number;
  volume24h?: number;
  high24h?: number;
  low24h?: number;
  points: CandlePoint[];
  /** Contract address discovered along the way (used by the DEX providers). */
  contractAddress?: string;
  /** GeckoTerminal `network/pool` when a DEX pool was resolved. */
  pool?: { network: string; address: string; dex?: string };
}

const FETCH_TIMEOUT_MS = 7000;
const HEADERS = { "User-Agent": "Mozilla/5.0 WhalePulseTerminal/3.0", Accept: "application/json" };

// Candle cache: `${SYM}:${RANGE}` -> { at, result }
const CANDLE_CACHE = new Map<string, { at: number; result: RealMarketResult }>();
const CANDLE_CACHE_TTL_MS = 30000;

export type ChartRange = "1h" | "4h" | "24h";

interface RangeSpec {
  binanceInterval: string;
  binanceLimit: number;
  geckoTerminalTimeframe: string;
  geckoTerminalAggregate: number;
  geckoTerminalLimit: number;
  coinGeckoDays: number;
}

const RANGE_SPECS: Record<ChartRange, RangeSpec> = {
  "1h":  { binanceInterval: "1m", binanceLimit: 60,  geckoTerminalTimeframe: "minute", geckoTerminalAggregate: 1,  geckoTerminalLimit: 60, coinGeckoDays: 1 },
  "4h":  { binanceInterval: "5m", binanceLimit: 48,  geckoTerminalTimeframe: "minute", geckoTerminalAggregate: 5,  geckoTerminalLimit: 48, coinGeckoDays: 1 },
  "24h": { binanceInterval: "15m", binanceLimit: 96, geckoTerminalTimeframe: "hour",   geckoTerminalAggregate: 1,  geckoTerminalLimit: 24, coinGeckoDays: 1 },
};

async function getJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && isFinite(n) ? n : 0;
};

/** App chain id -> GeckoTerminal network id. */
export function toGeckoNetwork(chain?: string): string {
  switch ((chain || "").toLowerCase()) {
    case "ethereum": return "eth";
    case "bnb":
    case "bsc":
    case "binance": return "bsc";
    case "base": return "base";
    case "arbitrum": return "arbitrum";
    case "solana": return "solana";
    default: return "eth";
  }
}

// ── 1. Binance ────────────────────────────────────────────────────────────────
export async function fetchBinanceMarket(
  symbol: string,
  range: ChartRange
): Promise<{ points: CandlePoint[]; price: number; change24h?: number; volume24h?: number; high24h?: number; low24h?: number } | null> {
  const spec = RANGE_SPECS[range];
  const pair = `${symbol.toUpperCase()}USDT`;

  const [klines, ticker] = await Promise.all([
    getJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${spec.binanceInterval}&limit=${spec.binanceLimit}`),
    getJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`),
  ]);

  const points: CandlePoint[] = [];
  if (Array.isArray(klines)) {
    for (const k of klines) {
      if (!Array.isArray(k)) continue;
      const t = num(k[0]);
      const close = num(k[4]);
      const volume = num(k[7]) || num(k[5]); // quote volume, else base volume
      if (t > 0 && close > 0) points.push({ t, price: close, volume });
    }
  }

  const price = points.length ? points[points.length - 1].price : num(ticker?.lastPrice);
  if (!(price > 0)) return null;

  const closes = points.map((p) => p.price);
  return {
    points,
    price,
    change24h: ticker ? Number(num(ticker.priceChangePercent).toFixed(2)) : undefined,
    volume24h: ticker ? num(ticker.quoteVolume) : undefined,
    // Prefer the exchange's own 24h extremes; fall back to the candle window.
    high24h: (ticker && num(ticker.highPrice) > 0) ? num(ticker.highPrice) : (closes.length ? Math.max(...closes) : undefined),
    low24h: (ticker && num(ticker.lowPrice) > 0) ? num(ticker.lowPrice) : (closes.length ? Math.min(...closes) : undefined),
  };
}

// ── 2. GeckoTerminal: real USD price for ANY token by contract address ────────
export async function fetchGeckoTerminalTokenPrice(
  network: string,
  tokenAddress: string
): Promise<{ price: number; source: string } | null> {
  if (!tokenAddress) return null;
  const data = await getJson(
    `https://api.geckoterminal.com/api/v2/simple/token_price/${network}?token_addresses=${encodeURIComponent(tokenAddress)}`
  );
  const raw = data?.data?.[tokenAddress] ?? data?.data?.[tokenAddress.toLowerCase()];
  const price = num(raw);
  if (!(price > 0)) return null;
  return { price, source: "GeckoTerminal" };
}

/** Find the deepest pool for a token/symbol on GeckoTerminal. */
export async function resolveGeckoTerminalPool(
  query: string,
  preferredNetwork?: string
): Promise<{ network: string; address: string; dex?: string; priceUsd: number; change24h?: number; volume24h?: number } | null> {
  if (!query) return null;
  const data = await getJson(
    `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&page=1`
  );
  const pools: any[] = Array.isArray(data?.data) ? data.data : [];
  if (!pools.length) return null;

  const scored = pools.map((p) => ({
    network: p?.relationships?.network?.data?.id || preferredNetwork || "eth",
    address: p?.attributes?.address || "",
    dex: p?.relationships?.dex?.data?.id,
    priceUsd: num(p?.attributes?.base_token_price_usd),
    change24h: p?.attributes?.price_change_percentage?.h24 !== undefined
      ? Number(num(p.attributes.price_change_percentage.h24).toFixed(2))
      : undefined,
    volume24h: num(p?.attributes?.volume_usd?.h24),
    liquidity: num(p?.attributes?.reserve_in_usd),
  })).filter((p) => p.address);

  if (!scored.length) return null;

  // Prefer the preferred network, then the deepest pool.
  scored.sort((a, b) => {
    const netA = a.network === preferredNetwork ? 0 : 1;
    const netB = b.network === preferredNetwork ? 0 : 1;
    if (netA !== netB) return netA - netB;
    return b.liquidity - a.liquidity;
  });

  const best = scored[0];
  return {
    network: best.network,
    address: best.address,
    dex: best.dex,
    priceUsd: best.priceUsd,
    change24h: best.change24h,
    volume24h: best.volume24h,
  };
}

// ── 3. GeckoTerminal OHLCV: real DEX candles ──────────────────────────────────
export async function fetchGeckoTerminalCandles(
  network: string,
  poolAddress: string,
  range: ChartRange
): Promise<{ points: CandlePoint[]; price: number; change24h?: number; volume24h?: number } | null> {
  if (!poolAddress) return null;
  const spec = RANGE_SPECS[range];
  const data = await getJson(
    `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}/ohlcv/${spec.geckoTerminalTimeframe}` +
    `?aggregate=${spec.geckoTerminalAggregate}&limit=${spec.geckoTerminalLimit}&currency=usd`
  );

  const rawList: any[] = data?.data?.attributes?.ohlcv_list || [];
  // GeckoTerminal returns newest-first; normalise to oldest-first.
  const points: CandlePoint[] = rawList
    .map((row) => ({
      t: num(row[0]) * 1000,
      price: num(row[4]),
      volume: num(row[5]),
    }))
    .filter((p) => p.t > 0 && p.price > 0)
    .reverse();

  if (!points.length) return null;

  const poolData = await getJson(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${poolAddress}`);
  const attrs = poolData?.data?.attributes;

  return {
    points,
    price: points[points.length - 1].price,
    change24h: attrs?.price_change_percentage?.h24 !== undefined
      ? Number(num(attrs.price_change_percentage.h24).toFixed(2))
      : undefined,
    volume24h: num(attrs?.volume_usd?.h24) || undefined,
  };
}

// ── 4. CoinGecko market_chart ─────────────────────────────────────────────────
export async function fetchCoinGeckoChart(
  coinId: string,
  range: ChartRange
): Promise<{ points: CandlePoint[]; price: number; change24h?: number; volume24h?: number } | null> {
  if (!coinId) return null;
  const spec = RANGE_SPECS[range];

  const [chart, simple] = await Promise.all([
    getJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${spec.coinGeckoDays}`),
    getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`),
  ]);

  const prices: any[] = Array.isArray(chart?.prices) ? chart.prices : [];
  const volumes: any[] = Array.isArray(chart?.total_volumes) ? chart.total_volumes : [];
  const volMap = new Map<number, number>();
  for (const v of volumes) if (Array.isArray(v)) volMap.set(num(v[0]), num(v[1]));

  let points: CandlePoint[] = prices
    .map((row) => ({ t: num(row[0]), price: num(row[1]), volume: volMap.get(num(row[0])) || 0 }))
    .filter((p) => p.t > 0 && p.price > 0);

  const meta = simple?.[coinId];
  if (!points.length && !(num(meta?.usd) > 0)) return null;

  if (!points.length) {
    // No history but we do have a spot price — emit a single point so the chart
    // can still render a live marker instead of an empty frame.
    points = [{ t: Date.now(), price: num(meta.usd), volume: 0 }];
  }

  // Trim to the requested window.
  const windowMs = range === "1h" ? 3600_000 : range === "4h" ? 4 * 3600_000 : 24 * 3600_000;
  const cutoff = Date.now() - windowMs;
  const trimmed = points.filter((p) => p.t >= cutoff);
  if (trimmed.length >= 2) points = trimmed;

  return {
    points,
    price: points[points.length - 1].price,
    change24h: meta?.usd_24h_change !== undefined ? Number(num(meta.usd_24h_change).toFixed(2)) : undefined,
    volume24h: meta?.usd_24h_vol !== undefined ? num(meta.usd_24h_vol) : undefined,
  };
}

// ── Cascade ───────────────────────────────────────────────────────────────────
export interface RealMarketContext {
  symbol: string;
  /** CoinGecko id (top-200 coins carry a real one; wildcard seeds do not). */
  coinId?: string;
  /** Token contract address, when known — unlocks the DEX providers. */
  contractAddress?: string;
  /** App chain id: ethereum | solana | base | arbitrum | bnb */
  chain?: string;
  /** DexScreener-resolved pool, when the gap filler already found one. */
  dexPair?: { chainId?: string; pairAddress?: string; dexName?: string };
}

/**
 * Try every real provider in order. Returns null only when nothing at all
 * answered — the caller then decides whether to fall back to the simulator.
 */
export async function fetchRealMarket(
  ctx: RealMarketContext,
  range: ChartRange = "1h",
  opts: { force?: boolean } = {}
): Promise<RealMarketResult | null> {
  const symbol = (ctx.symbol || "").trim().toUpperCase();
  if (!symbol) return null;

  const cacheKey = `${symbol}:${range}`;
  if (!opts.force) {
    const hit = CANDLE_CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < CANDLE_CACHE_TTL_MS) return hit.result;
  }

  const network = toGeckoNetwork(ctx.chain || ctx.dexPair?.chainId);
  const contract = (ctx.contractAddress || "").trim();

  // 1) Binance — the most complete candles for exchange-listed coins.
  const binance = await fetchBinanceMarket(symbol, range);
  if (binance && binance.points.length > 1) {
    return cache(cacheKey, {
      source: "Binance",
      isReal: true,
      price: binance.price,
      change24h: binance.change24h,
      volume24h: binance.volume24h,
      high24h: binance.high24h,
      low24h: binance.low24h,
      points: binance.points,
      contractAddress: contract || undefined,
    });
  }

  // 2) GeckoTerminal by contract address — real price for ANY DEX token.
  let gtPrice: { price: number; source: string } | null = null;
  if (contract) {
    gtPrice = await fetchGeckoTerminalTokenPrice(network, contract);
  }

  // 3) GeckoTerminal pool OHLCV — real candles for wildcard / DEX-only coins.
  const pool: { network: string; address: string; dex?: string; change24h?: number; volume24h?: number } | null =
    ctx.dexPair?.pairAddress
      ? {
          network: toGeckoNetwork(ctx.dexPair.chainId),
          address: ctx.dexPair.pairAddress,
          dex: ctx.dexPair.dexName,
        }
      : await resolveGeckoTerminalPool(symbol, network);

  if (pool?.address) {
    const gt = await fetchGeckoTerminalCandles(pool.network, pool.address, range);
    if (gt && gt.points.length > 0) {
      return cache(cacheKey, {
        source: `GeckoTerminal${pool.dex ? ` (${pool.dex})` : ""}`,
        isReal: true,
        price: gt.price,
        change24h: gt.change24h ?? pool.change24h,
        volume24h: gt.volume24h ?? pool.volume24h,
        points: gt.points,
        contractAddress: contract || undefined,
        pool,
      });
    }
  }

  // 4) CoinGecko — real history for anything with a Gecko id.
  if (ctx.coinId && !ctx.coinId.startsWith("wildcard-")) {
    const cg = await fetchCoinGeckoChart(ctx.coinId, range);
    if (cg && cg.points.length > 0) {
      return cache(cacheKey, {
        source: "CoinGecko",
        isReal: true,
        price: cg.price,
        change24h: cg.change24h,
        volume24h: cg.volume24h,
        points: cg.points,
        contractAddress: contract || undefined,
        pool,
      });
    }
  }

  // 5) GeckoTerminal spot price only (no candles resolved).
  if (gtPrice) {
    return cache(cacheKey, {
      source: gtPrice.source,
      isReal: true,
      price: gtPrice.price,
      points: [{ t: Date.now(), price: gtPrice.price, volume: 0 }],
      contractAddress: contract || undefined,
      pool,
    });
  }

  // 6) Binance spot price only (candles request failed but ticker answered).
  if (binance?.price) {
    return cache(cacheKey, {
      source: "Binance",
      isReal: true,
      price: binance.price,
      change24h: binance.change24h,
      volume24h: binance.volume24h,
      points: [{ t: Date.now(), price: binance.price, volume: 0 }],
      contractAddress: contract || undefined,
    });
  }

  return null;
}

function cache(key: string, result: RealMarketResult): RealMarketResult {
  CANDLE_CACHE.set(key, { at: Date.now(), result });
  if (CANDLE_CACHE.size > 500) {
    const oldest = CANDLE_CACHE.keys().next().value;
    if (oldest) CANDLE_CACHE.delete(oldest);
  }
  return result;
}
