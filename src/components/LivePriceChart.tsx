import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, BarChart2, LineChart, Radio, ShieldCheck } from "lucide-react";
import { TradingViewChart } from "./TradingViewChart";

interface CandlePoint {
  t: number;
  price: number;
  volume?: number;
  source?: string;
}

interface CandleResponse {
  success: boolean;
  symbol: string;
  name?: string;
  price?: number;
  change24h?: number;
  priceSource?: string;
  isSimulated?: boolean;
  isRealFeed?: boolean;
  hasTradingViewCoverage?: boolean;
  tradingViewSymbol?: string;
  direction?: "PUMP" | "DUMP";
  entryPrice?: number;
  target1?: number;
  target2?: number;
  stopLoss?: number;
  pnlPercent?: number;
  maxPnlPercent?: number;
  high?: number;
  low?: number;
  pointCount?: number;
  points?: CandlePoint[];
}

interface LivePriceChartProps {
  symbol: string;
  entryPrice?: number;
  target1?: number;
  target2?: number;
  stopLoss?: number;
  height?: number;
  isFa?: boolean;
  refreshMs?: number;
  /** Show the TradingView / server-chart switch when the coin is exchange listed. */
  allowTradingView?: boolean;
}

type Range = "1h" | "4h" | "24h";

function fmtPrice(price: number | undefined | null): string {
  if (price === undefined || price === null || isNaN(price) || !(price > 0)) return "0.00";
  if (price < 0.000001) return price.toFixed(8);
  if (price < 0.001) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 10) return price.toFixed(3);
  return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtUsdCompact(v: number | undefined): string {
  if (!v || !isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtTime(t: number, withSeconds = true): string {
  try {
    return new Date(t).toLocaleTimeString("fa-IR", {
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" as const } : {}),
    });
  } catch {
    return new Date(t).toLocaleTimeString();
  }
}

interface Level {
  key: string;
  label: string;
  value: number;
  color: string;
  textColor: string;
}

/**
 * Live chart that shows REAL prices for every coin.
 *
 * Prices come from `/api/chart/candles`, which walks a cascade of free public
 * market providers (Binance klines -> GeckoTerminal token price / DEX OHLCV ->
 * CoinGecko -> DexScreener). Only when none of them can be reached does the
 * server fall back to the random-walk simulator, and that state is flagged
 * explicitly in the UI instead of being presented as market data.
 */
export const LivePriceChart: React.FC<LivePriceChartProps> = ({
  symbol,
  entryPrice,
  target1,
  target2,
  stopLoss,
  height = 260,
  isFa = true,
  refreshMs = 5000,
  allowTradingView = true,
}) => {
  const [data, setData] = useState<CandleResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"live" | "tradingview">("live");
  const [range, setRange] = useState<Range>("1h");

  const load = useCallback(async (r: Range) => {
    try {
      const res = await fetch(
        `/api/chart/candles?symbol=${encodeURIComponent(symbol)}&range=${r}&points=240`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as CandleResponse;
      setData(json);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "خطای دریافت داده");
    } finally {
      setIsLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    setIsLoading(true);
    setData(null);
    load(range);
    const id = setInterval(() => load(range), Math.max(3000, refreshMs));
    return () => clearInterval(id);
  }, [load, range, refreshMs]);

  const points = useMemo(() => data?.points || [], [data]);

  // Props win, server values fill the gaps.
  const entry = entryPrice ?? data?.entryPrice;
  const tp1 = target1 ?? data?.target1;
  const tp2 = target2 ?? data?.target2;
  const sl = stopLoss ?? data?.stopLoss;

  const { min, max, yFor, pricePath, areaPath, levels, volumes, maxVolume } = useMemo(() => {
    const prices = points.map((p) => p.price).filter((p) => p > 0);
    const vols = points.map((p) => p.volume || 0);
    const mv = vols.length ? Math.max(...vols) : 0;

    if (prices.length === 0) {
      return {
        min: 0, max: 0, yFor: () => 50, pricePath: "", areaPath: "",
        levels: [] as Level[], volumes: [] as number[], maxVolume: 0,
      };
    }

    let lo = Math.min(...prices);
    let hi = Math.max(...prices);

    // Always keep entry & stop-loss inside the frame — they define the trade.
    const mustShow = [entry, sl].filter((v): v is number => typeof v === "number" && v > 0);
    if (mustShow.length) {
      lo = Math.min(lo, ...mustShow);
      hi = Math.max(hi, ...mustShow);
    }

    const span = hi - lo || hi * 0.02 || 1;
    lo -= span * 0.08;
    hi += span * 0.08;
    if (lo < 0) lo = 0;
    const rangeSpan = hi - lo || 1;

    const y = (price: number) => ((hi - price) / rangeSpan) * 100;

    const coords = points.map((p, i) => ({
      x: points.length > 1 ? (i / (points.length - 1)) * 100 : 50,
      y: y(p.price),
    }));

    const line = coords
      .map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(3)} ${c.y.toFixed(3)}`)
      .join(" ");
    const area = coords.length > 1 ? `${line} L 100 100 L 0 100 Z` : "";

    const candidates: Level[] = [];
    const push = (key: string, label: string, value: number | undefined, color: string, textColor: string) => {
      if (typeof value !== "number" || !(value > 0)) return;
      if (value < lo || value > hi) return;
      candidates.push({ key, label, value, color, textColor });
    };

    push("entry", isFa ? "ورود" : "Entry", entry, "#22d3ee", "text-cyan-300");
    push("tp1", isFa ? "تارگت ۱" : "TP1", tp1, "#34d399", "text-emerald-300");
    push("tp2", isFa ? "تارگت ۲" : "TP2", tp2, "#10b981", "text-emerald-400");
    push("sl", isFa ? "حد ضرر" : "SL", sl, "#fb7185", "text-rose-300");

    return { min: lo, max: hi, yFor: y, pricePath: line, areaPath: area, levels: candidates, volumes: vols, maxVolume: mv };
  }, [points, entry, tp1, tp2, sl, isFa]);

  const lastPoint = points[points.length - 1];
  const firstPoint = points[0];
  const lastPrice = lastPoint?.price ?? data?.price ?? 0;
  const pnl = data?.pnlPercent;
  const isProfit = typeof pnl === "number" ? pnl >= 0 : lastPrice >= (entry ?? lastPrice);
  const strokeColor = isProfit ? "#34d399" : "#fb7185";
  const gradientId = `lpc-grad-${symbol.replace(/[^a-zA-Z0-9]/g, "")}-${isProfit ? "up" : "down"}`;
  const canUseTradingView = allowTradingView && !!data?.hasTradingViewCoverage;
  const isReal = data ? data.isSimulated === false && (data.points?.length || 0) > 0 : false;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/70 overflow-hidden">
      {/* Header: symbol, live price, 24h change, PnL */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
            <LineChart className="w-4 h-4 text-cyan-400" />
            {isFa ? `چارت زنده ${symbol}` : `Live chart ${symbol}`}
          </span>

          <span className="text-sm font-mono font-bold text-slate-100">${fmtPrice(lastPrice)}</span>

          {typeof data?.change24h === "number" && (
            <span className={`text-xs font-mono font-semibold ${data.change24h >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {data.change24h >= 0 ? "+" : ""}{data.change24h}% {isFa ? "(۲۴ ساعت)" : "(24h)"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Timeframe */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            {(["1h", "4h", "24h"] as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => { setRange(r); setIsLoading(true); }}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold transition ${
                  range === r ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          {canUseTradingView && (
            <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
              <button
                onClick={() => setView("live")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold transition ${
                  view === "live" ? "bg-slate-700 text-cyan-300" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {isFa ? "سرور" : "Server"}
              </button>
              <button
                onClick={() => setView("tradingview")}
                className={`px-2 py-0.5 rounded text-[10px] font-semibold transition ${
                  view === "tradingview" ? "bg-slate-700 text-cyan-300" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                TradingView
              </button>
            </div>
          )}

          <button
            onClick={() => { setIsLoading(true); load(range); }}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            title={isFa ? "بروزرسانی چارت" : "Refresh chart"}
          >
            <Radio className={`w-3.5 h-3.5 text-cyan-400 ${isLoading ? "animate-pulse" : ""}`} />
          </button>
        </div>
      </div>

      {/* PnL strip — Entry / Live / PnL / Max */}
      {(entry || typeof pnl === "number") && view === "live" && (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-slate-800/70 bg-slate-950/60 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">{isFa ? "قیمت ورود" : "Entry"}</span>
            <span className="font-mono font-semibold text-cyan-300">${fmtPrice(entry)}</span>
          </div>
          <div className="h-3 w-px bg-slate-800" />
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">{isFa ? "قیمت فعلی" : "Live"}</span>
            <span className="font-mono font-semibold text-slate-200">${fmtPrice(lastPrice)}</span>
          </div>
          <div className="h-3 w-px bg-slate-800" />
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">{isFa ? "سود/ضرر لحظه‌ای" : "PnL"}</span>
            <span className={`font-mono font-bold ${isProfit ? "text-emerald-400" : "text-rose-400"}`}>
              {typeof pnl === "number" ? `${pnl >= 0 ? "+" : ""}${pnl}%` : "—"}
            </span>
          </div>
          {typeof data?.maxPnlPercent === "number" && (
            <>
              <div className="h-3 w-px bg-slate-800" />
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">{isFa ? "بیشترین سود" : "Max"}</span>
                <span className="font-mono font-semibold text-emerald-300">
                  {data.maxPnlPercent >= 0 ? "+" : ""}{data.maxPnlPercent}%
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Body */}
      {view === "tradingview" && canUseTradingView ? (
        <div className="p-3">
          <TradingViewChart symbol={symbol} isFa={isFa} height={Math.max(240, height)} defaultInterval="15" />
        </div>
      ) : (
        <div className="relative w-full" style={{ height: `${height}px` }}>
          {/* Level labels overlay (HTML so text is never distorted) */}
          {levels.map((lv) => (
            <div
              key={lv.key}
              className={`absolute right-1 -translate-y-1/2 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-slate-950/85 border border-slate-800 ${lv.textColor} pointer-events-none z-10`}
              style={{ top: `${Math.min(96, Math.max(4, yFor(lv.value)))}%` }}
            >
              {lv.label} ${fmtPrice(lv.value)}
            </div>
          ))}

          {/* Price scale labels */}
          {points.length > 0 && (
            <>
              <div className="absolute left-1 top-1 text-[10px] font-mono text-slate-500 pointer-events-none z-10">
                ${fmtPrice(max)}
              </div>
              <div className="absolute left-1 bottom-1 text-[10px] font-mono text-slate-500 pointer-events-none z-10">
                ${fmtPrice(min)}
              </div>
            </>
          )}

          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
                <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Grid */}
            {[25, 50, 75].map((g) => (
              <line
                key={g}
                x1="0" y1={g} x2="100" y2={g}
                stroke="rgba(148, 163, 184, 0.12)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* Volume bars (bottom 22% of the frame) */}
            {maxVolume > 0 && volumes.map((v, i) => {
              const h = (v / maxVolume) * 22;
              const w = 100 / Math.max(1, volumes.length);
              return (
                <rect
                  key={`v${i}`}
                  x={i * w}
                  y={100 - h}
                  width={Math.max(0.15, w * 0.6)}
                  height={h}
                  fill="rgba(56, 189, 248, 0.18)"
                />
              );
            })}

            {/* Trade levels */}
            {levels.map((lv) => (
              <line
                key={lv.key}
                x1="0" y1={yFor(lv.value)} x2="100" y2={yFor(lv.value)}
                stroke={lv.color}
                strokeWidth="1"
                strokeDasharray="4 4"
                strokeOpacity="0.75"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* Price area + line */}
            {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
            {pricePath && (
              <path
                d={pricePath}
                fill="none"
                stroke={strokeColor}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* Last price marker */}
            {lastPoint && (
              <circle
                cx={points.length > 1 ? 100 : 50}
                cy={yFor(lastPoint.price)}
                r="3"
                fill={strokeColor}
                stroke="#020617"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {/* Time axis */}
          {points.length > 1 && (
            <div className="absolute left-2 right-2 bottom-1 flex items-center justify-between text-[10px] font-mono text-slate-600 pointer-events-none z-10">
              <span>{fmtTime(firstPoint.t, false)}</span>
              <span className="flex items-center gap-1 text-cyan-500">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping" />
                {isFa ? "زنده" : "LIVE"}
              </span>
              <span>{fmtTime(lastPoint!.t)}</span>
            </div>
          )}

          {/* Empty / loading state */}
          {points.length < 2 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/60">
              {error ? (
                <>
                  <AlertTriangle className="w-6 h-6 text-amber-400" />
                  <p className="text-xs text-slate-400">
                    {isFa ? "خطا در دریافت داده قیمت:" : "Failed to load price data:"} {error}
                  </p>
                </>
              ) : (
                <>
                  <Activity className="w-6 h-6 text-cyan-400 animate-pulse" />
                  <p className="text-xs text-slate-400">
                    {isFa
                      ? "در حال دریافت قیمت‌های واقعی از Binance / GeckoTerminal / CoinGecko…"
                      : "Fetching real prices from Binance / GeckoTerminal / CoinGecko…"}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer: price source, range high/low, volume */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-t border-slate-800 bg-slate-900/40 text-[10px] text-slate-500">
        <div className="flex items-center gap-2 flex-wrap">
          {data && (
            <span
              className={`flex items-center gap-1 px-2 py-0.5 rounded border font-mono font-semibold ${
                isReal
                  ? "bg-emerald-950/50 border-emerald-800/60 text-emerald-300"
                  : "bg-amber-950/60 border-amber-700/60 text-amber-300"
              }`}
              title={isFa ? "منبع قیمت لحظه‌ای این کوین" : "Source of this coin's live price"}
            >
              {isReal
                ? <ShieldCheck className="w-3 h-3" />
                : <AlertTriangle className="w-3 h-3" />}
              {isReal
                ? `${isFa ? "قیمت واقعی از" : "real feed:"} ${data.priceSource}`
                : (isFa ? "⚠ شبیه‌ساز قیمت (منبع واقعی در دسترس نیست)" : "⚠ Live Price Simulator (no real feed)")}
            </span>
          )}

          {typeof data?.high === "number" && typeof data?.low === "number" && (
            <span className="font-mono">
              {isFa ? "بازه" : "range"}: ${fmtPrice(data.low)} – ${fmtPrice(data.high)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 font-mono">
          <span className="flex items-center gap-1">
            <BarChart2 className="w-3 h-3 text-slate-500" />
            {points.length} {isFa ? "نقطه" : "pts"}
          </span>
          {maxVolume > 0 && <span>{fmtUsdCompact(maxVolume)}</span>}
        </div>
      </div>
    </div>
  );
};
