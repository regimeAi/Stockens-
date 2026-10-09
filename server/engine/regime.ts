import type { Bar, Regime } from "../types.ts";
import { returns, sma, std } from "./indicators.ts";

// Regime classifier. Labels the market state from the benchmark (SPY or BTC for crypto)
// and re-weights the ensemble: trend-following leads in calm risk-on tapes, mean-reversion
// and the analog model get more say in choppy / high-vol tapes, and everything is
// de-risked when liquidity is thin.

export function detectRegime(benchmark: Bar[], i = benchmark.length - 1, now = benchmark[i]?.t ?? Date.now()): Regime {
  const c = benchmark.slice(Math.max(0, i - 260), i + 1).map((b) => b.c);
  const r = returns(c);
  const vol20 = std(r.slice(-20)) * Math.sqrt(252);
  const vol250 = std(r) * Math.sqrt(252) || vol20;
  const above200 = c.length > 200 ? c[c.length - 1] > sma(c, 200) : c[c.length - 1] > sma(c, c.length);
  const slope50 = c.length > 60 ? sma(c, 50) / sma(c.slice(0, -10), 50) - 1 : 0;
  const trend = above200 && slope50 > 0 ? "risk-on" : !above200 && slope50 < 0 ? "risk-off" : "neutral";
  const volState = vol20 > vol250 * 1.3 ? "high-vol" : vol20 < vol250 * 0.75 ? "low-vol" : "normal-vol";

  const d = new Date(now);
  const m = d.getMonth();
  const day = d.getDate();
  // Earnings season ≈ weeks 2–6 after quarter end.
  const earnings = [0, 3, 6, 9].includes(m) ? day >= 10 : [1, 4, 7, 10].includes(m) ? day <= 15 : false;
  const holiday = (m === 11 && day >= 20) || (m === 0 && day <= 2) || (m === 6 && day <= 5) || (m === 10 && day >= 24 && day <= 28);
  const recentVol = benchmark.slice(-5).reduce((a, b) => a + b.v, 0) / 5;
  const avgVol = benchmark.slice(-60).reduce((a, b) => a + b.v, 0) / Math.min(60, benchmark.length);
  const thin = holiday || recentVol < avgVol * 0.6;

  let weights = { gbt: 0.4, sequence: 0.25, trend: 0.2, reversion: 0.15 };
  if (trend === "risk-on" && volState !== "high-vol") weights = { gbt: 0.35, sequence: 0.2, trend: 0.35, reversion: 0.1 };
  if (volState === "high-vol") weights = { gbt: 0.35, sequence: 0.3, trend: 0.1, reversion: 0.25 };
  if (trend === "risk-off" && volState === "high-vol") weights = { gbt: 0.3, sequence: 0.3, trend: 0.15, reversion: 0.25 };

  const season = earnings ? "earnings-season" : holiday ? "holiday-liquidity" : "normal";
  const label = [trend, volState, season !== "normal" ? season : null, thin ? "thin liquidity" : null].filter(Boolean).join(" · ");
  return { trend, vol: volState, season, liquidity: thin ? "thin" : "normal", label, weights };
}
