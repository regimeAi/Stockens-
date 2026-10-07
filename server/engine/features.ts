import type { Bar, Fundamentals } from "../types.ts";
import { atr, clamp, emaSeries, mean, returns, rsi, sma, std, zscore } from "./indicators.ts";

// Feature engineering. Each feature is computed at a bar index (no look-ahead),
// so the same code powers live forecasts, model training and walk-forward backtests.

export interface FeatureDef {
  key: string;
  group: string;
  tip: string;
}

export const FEATURES: FeatureDef[] = [
  { key: "mom_5", group: "Price/volume structure", tip: "5-day return. Short-term momentum: recent winners often keep drifting for a few days." },
  { key: "mom_20", group: "Price/volume structure", tip: "20-day return. Medium-term trend strength." },
  { key: "mom_120", group: "Factor tilts", tip: "6-month momentum factor (skips the last week to avoid short-term reversal)." },
  { key: "trend_slope", group: "Price/volume structure", tip: "Distance of the 20-day average above the 50-day average. Positive = uptrend." },
  { key: "rsi_14", group: "Mean-reversion stress", tip: "Relative Strength Index, centred at 0. Large positive = overbought, large negative = oversold." },
  { key: "z_20", group: "Mean-reversion stress", tip: "How many standard deviations price sits from its 20-day mean. Extremes tend to snap back." },
  { key: "atr_pct", group: "Volatility", tip: "Average True Range as % of price: the typical daily move. Drives stop distance and position size." },
  { key: "vol_ratio", group: "Volatility", tip: "Short-term vs long-term volatility. >0 means volatility is expanding (breakouts); <0 compressing (coiling)." },
  { key: "gap", group: "Volatility", tip: "Today's opening gap vs prior close. Large discrete gaps often partially fill." },
  { key: "volume_z", group: "Microstructure", tip: "Volume vs its 20-day norm. Price moves on heavy volume are more trustworthy." },
  { key: "close_loc", group: "Microstructure", tip: "Where the bar closed in its high–low range. Closing near highs = buyers in control into the bell." },
  { key: "breadth", group: "Price/volume structure", tip: "Share of the universe above its 50-day average. Healthy rallies have broad participation." },
  { key: "eps_rev", group: "Earnings", tip: "Recent change in analysts' EPS estimates. Upward revisions tend to lead price." },
  { key: "eps_surprise", group: "Earnings", tip: "Last earnings surprise. Big beats often drift higher for weeks (post-earnings drift)." },
  { key: "dispersion", group: "Earnings", tip: "Disagreement between analysts. High dispersion = more uncertainty, wider bands." },
  { key: "value", group: "Factor tilts", tip: "Earnings yield (1/PE) vs the universe. Cheap stocks have a long-run tailwind." },
  { key: "size", group: "Factor tilts", tip: "Log market cap. Small caps are more volatile and react more to liquidity." },
  { key: "rates", group: "Macro proxies", tip: "20-day move in long bonds (TLT). Falling yields usually help growth stocks." },
  { key: "dollar", group: "Macro proxies", tip: "20-day move in the dollar (UUP). A strong dollar is a headwind for multinationals and commodities." },
  { key: "commodities", group: "Macro proxies", tip: "20-day move in oil & gold. Inflation pulse." },
  { key: "sentiment", group: "News & sentiment", tip: "Recency-weighted headline sentiment from tracked sources." },
  { key: "news_mom", group: "News & sentiment", tip: "Momentum of news: is tone/volume of coverage improving or deteriorating?" },
];

export type FeatureVector = Record<string, number>;

export interface MarketContext {
  breadth: number; // 0..1
  rates: number;
  dollar: number;
  commodities: number;
  medianEarningsYield: number;
}

export function computeFeatures(
  bars: Bar[],
  i: number,
  f: Fundamentals,
  ctx: MarketContext,
  sentiment = { score: 0, momentum: 0 },
): FeatureVector {
  const w = bars.slice(Math.max(0, i - 160), i + 1);
  const c = w.map((b) => b.c);
  const n = c.length;
  const ret = (k: number) => (n > k ? c[n - 1] / c[n - 1 - k] - 1 : 0);
  const r = returns(c);
  const a = atr(w, 14);
  const price = c[n - 1];
  const vols = w.map((b) => b.v);
  const b = w[n - 1];
  const prev = w[n - 2] ?? b;
  const ema20 = emaSeries(c.slice(-60), 20);
  return {
    mom_5: ret(5),
    mom_20: ret(20),
    mom_120: n > 126 ? c[n - 6] / c[n - 126] - 1 : ret(Math.max(1, n - 1)),
    trend_slope: n > 50 ? sma(c, 20) / sma(c, 50) - 1 : 0,
    rsi_14: (rsi(c, 14) - 50) / 50,
    z_20: clamp(zscore(c, 20), -4, 4),
    atr_pct: price ? a / price : 0,
    vol_ratio: (() => {
      const s = std(r.slice(-10));
      const l = std(r.slice(-60));
      return l ? clamp(Math.log(s / l || 1), -2, 2) : 0;
    })(),
    gap: prev.c ? b.o / prev.c - 1 : 0,
    volume_z: clamp(zscore(vols, 20), -4, 4),
    close_loc: b.h > b.l ? (b.c - b.l) / (b.h - b.l) - 0.5 : 0,
    breadth: ctx.breadth - 0.5,
    eps_rev: (f.epsRevision ?? 0) / 100,
    eps_surprise: (f.epsSurprise ?? 0) / 100,
    dispersion: f.analystDispersion ?? 0.2,
    value: f.pe ? 1 / f.pe - ctx.medianEarningsYield : 0,
    size: f.marketCap ? Math.log10(f.marketCap) - 10 : 0,
    rates: ctx.rates,
    dollar: ctx.dollar,
    commodities: ctx.commodities,
    sentiment: sentiment.score,
    news_mom: sentiment.momentum,
    // keep ema20 distance as an internal helper for strategies (not a model feature)
    _ema20_dist: ema20.length ? price / ema20[ema20.length - 1] - 1 : 0,
  };
}

export function toArray(fv: FeatureVector): number[] {
  return FEATURES.map((d) => fv[d.key] ?? 0);
}

export function forwardReturn(bars: Bar[], i: number, h: number): number | undefined {
  if (i + h >= bars.length) return undefined;
  return bars[i + h].c / bars[i].c - 1;
}

export function realizedVol(bars: Bar[], i: number, n = 20): number {
  const c = bars.slice(Math.max(0, i - n), i + 1).map((b) => b.c);
  return std(returns(c)) || 0.01;
}

export function avgAbs(xs: number[]) {
  return mean(xs.map(Math.abs));
}
