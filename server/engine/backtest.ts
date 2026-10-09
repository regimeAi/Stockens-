import type { BacktestMetrics, BacktestResult, Bar, StrategyConfig } from "../types.ts";
import { atr, emaSeries, mean, std } from "./indicators.ts";
import { computeFeatures, type FeatureVector, type MarketContext } from "./features.ts";
import { detectRegime } from "./regime.ts";

// Strategy Lab backtester. Long-only, daily bars, one sleeve per symbol.
// Discipline built in: walk-forward folds with in-fold parameter selection,
// out-of-sample scoring, cost haircuts, a parameter-count cap and regime splits.

export const MAX_PARAMS = 4;

export const TEMPLATES: Record<StrategyConfig["template"], { label: string; params: Record<string, number>; describe: string }> = {
  trend: { label: "Trend following", params: { fast: 20, slow: 50, minMom: 0.02 }, describe: "Buy when the fast EMA is above the slow EMA and 20-day momentum exceeds minMom." },
  breakout: { label: "Breakout", params: { lookback: 20, volZ: 1 }, describe: "Buy a close above the highest high of the lookback window on above-normal volume." },
  "mean-reversion": { label: "Mean reversion", params: { entryZ: 2, exitZ: 0 }, describe: "Buy when price is entryZ standard deviations below its 20-day mean in a long-term uptrend; exit back at exitZ." },
  "post-earnings-drift": { label: "Post-earnings drift", params: { gap: 0.04, volZ: 2, hold: 10 }, describe: "Buy a large up-gap on very heavy volume (earnings-type reaction) and hold for the drift." },
  "vol-compression": { label: "Volatility compression", params: { squeeze: -0.4, lookback: 10 }, describe: "Wait for short-term volatility to compress vs long-term, then buy the break of the recent range." },
};

export const DEFAULT_RISK: StrategyConfig["risk"] = { stopAtr: 2, targetAtr: 4, timeStopDays: 15, trailing: true, drawdownBrakePct: 15 };

interface Pre {
  bars: Bar[];
  fv: FeatureVector[];
  ema: Record<number, number[]>;
  atr: number[];
}

function prepare(bars: Bar[], ctx: MarketContext, emas: number[]): Pre {
  const fv = bars.map((_, i) => (i < 60 ? ({} as FeatureVector) : computeFeatures(bars, i, {}, ctx)));
  const closes = bars.map((b) => b.c);
  const ema: Record<number, number[]> = {};
  for (const n of emas) ema[n] = emaSeries(closes, n);
  return { bars, fv, ema, atr: bars.map((_, i) => atr(bars.slice(Math.max(0, i - 15), i + 1), 14)) };
}

function entrySignal(s: StrategyConfig, p: Pre, i: number, params: Record<string, number>): boolean {
  const f = p.fv[i];
  const b = p.bars;
  if (!f || f.mom_20 === undefined) return false;
  switch (s.template) {
    case "trend": {
      const fast = p.ema[params.fast] ?? p.ema[20];
      const slow = p.ema[params.slow] ?? p.ema[50];
      return fast[i] > slow[i] && f.mom_20 > params.minMom;
    }
    case "breakout": {
      const n = Math.round(params.lookback);
      if (i < n + 1) return false;
      const hi = Math.max(...b.slice(i - n, i).map((x) => x.h));
      return b[i].c > hi && f.volume_z > params.volZ;
    }
    case "mean-reversion":
      return f.z_20 < -params.entryZ && f.mom_120 > 0;
    case "post-earnings-drift":
      return f.gap > params.gap && f.volume_z > params.volZ;
    case "vol-compression": {
      const n = Math.round(params.lookback);
      if (i < n + 1 || p.fv[i - 1]?.vol_ratio === undefined) return false;
      const hi = Math.max(...b.slice(i - n, i).map((x) => x.h));
      return p.fv[i - 1].vol_ratio < params.squeeze && b[i].c > hi;
    }
  }
}

interface Trade {
  symbol: string;
  entryI: number;
  entryT: number; // aligned day index (for regime attribution)
  exitI: number;
  ret: number;
}

function simulate(s: StrategyConfig, pres: Map<string, Pre>, params: Record<string, number>, from: number, to: number, costBps: number) {
  const symbols = [...pres.keys()];
  const n = Math.min(...symbols.map((k) => pres.get(k)!.bars.length));
  const off = (k: string) => pres.get(k)!.bars.length - n; // align on the most recent n bars
  const daily: number[] = [];
  const times: number[] = [];
  const trades: Trade[] = [];
  const exposure: number[] = [];
  const open = new Map<string, { entryI: number; entryT: number; entry: number; stop: number; target: number; peak: number }>();
  let equity = 1;
  let peak = 1;
  let braking = false;
  const cost = costBps / 10_000;
  const start = Math.max(from, 130);
  for (let t = start; t < Math.min(to, n); t++) {
    let r = 0;
    for (const sym of symbols) {
      const p = pres.get(sym)!;
      const i = t + off(sym);
      const bar = p.bars[i];
      const pos = open.get(sym);
      if (pos) {
        r += (bar.c / p.bars[i - 1].c - 1) / symbols.length;
        pos.peak = Math.max(pos.peak, bar.c);
        const trail = s.risk.trailing ? pos.peak - p.atr[i] * s.risk.stopAtr : -Infinity;
        const exitMR = s.template === "mean-reversion" && (p.fv[i]?.z_20 ?? 0) >= (params.exitZ ?? 0);
        const hold = s.template === "post-earnings-drift" ? params.hold ?? s.risk.timeStopDays : s.risk.timeStopDays;
        if (bar.l <= Math.max(pos.stop, trail) || bar.h >= pos.target || i - pos.entryI >= hold || exitMR) {
          r -= cost / symbols.length;
          trades.push({ symbol: sym, entryI: pos.entryI, entryT: pos.entryT, exitI: i, ret: bar.c / pos.entry - 1 - 2 * cost });
          open.delete(sym);
        }
      } else if (!braking && entrySignal(s, p, i, params)) {
        const a = p.atr[i];
        open.set(sym, { entryI: i, entryT: t, entry: bar.c, stop: bar.c - a * s.risk.stopAtr, target: bar.c + a * s.risk.targetAtr, peak: bar.c });
        r -= cost / symbols.length;
      }
    }
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    const dd = equity / peak - 1;
    if (dd < -s.risk.drawdownBrakePct / 100) braking = true;
    else if (braking && dd > -s.risk.drawdownBrakePct / 200) braking = false;
    daily.push(r);
    times.push(pres.get(symbols[0])!.bars[t + off(symbols[0])].t);
    exposure.push(open.size / symbols.length);
  }
  return { daily, times, trades, exposure };
}

export function metrics(daily: number[], trades: { ret: number }[], exposure: number[]): BacktestMetrics {
  const eq: number[] = [];
  let e = 1;
  for (const r of daily) eq.push((e *= 1 + r));
  let peak = 1;
  let mdd = 0;
  for (const x of eq) {
    peak = Math.max(peak, x);
    mdd = Math.min(mdd, x / peak - 1);
  }
  const total = e - 1;
  const years = daily.length / 252 || 1;
  const cagr = Math.pow(Math.max(e, 1e-9), 1 / years) - 1;
  const sd = std(daily);
  const down = std(daily.filter((r) => r < 0).concat([0]));
  const wins = trades.filter((t) => t.ret > 0);
  const losses = trades.filter((t) => t.ret <= 0);
  const avgW = mean(wins.map((t) => t.ret));
  const avgL = Math.abs(mean(losses.map((t) => t.ret)));
  const expo = mean(exposure);
  return {
    trades: trades.length,
    hitRate: trades.length ? wins.length / trades.length : 0,
    payoff: avgL ? avgW / avgL : wins.length ? 99 : 0,
    totalReturn: total,
    cagr,
    maxDrawdown: mdd,
    sharpe: sd ? (mean(daily) / sd) * Math.sqrt(252) : 0,
    sortino: down ? (mean(daily) / down) * Math.sqrt(252) : 0,
    mar: mdd ? cagr / Math.abs(mdd) : 0,
    exposure: expo,
    exposureAdjReturn: expo ? total / expo : 0,
    turnover: years ? trades.length / years : 0,
  };
}

function paramGrid(base: Record<string, number>): Record<string, number>[] {
  const keys = Object.keys(base);
  const k0 = keys[0];
  return [0.75, 1, 1.25].map((m) => ({ ...base, [k0]: Number((base[k0] * m).toFixed(4)) }));
}

export function backtest(s: StrategyConfig, data: Map<string, Bar[]>, ctx: MarketContext, benchmark: Bar[], costBps = 5, folds = 4): BacktestResult {
  const warnings: string[] = [];
  const nParams = Object.keys(s.params).length;
  if (nParams > MAX_PARAMS) warnings.push(`Too many parameters (${nParams} > ${MAX_PARAMS}). Extra parameters were ignored to discourage overfitting.`);
  const params = Object.fromEntries(Object.entries(s.params).slice(0, MAX_PARAMS));
  const grid = paramGrid(params);
  const emaNs = Array.from(new Set([20, 50, ...grid.flatMap((g) => [g.fast, g.slow].filter(Boolean).map(Math.round))]));
  const pres = new Map<string, Pre>();
  for (const sym of s.universe) {
    const b = data.get(sym);
    if (b && b.length > 200) pres.set(sym, prepare(b, ctx, emaNs));
  }
  if (!pres.size) throw new Error("No symbols with enough history in universe");
  const roundGrid = (g: Record<string, number>) => (s.template === "trend" ? { ...g, fast: Math.round(g.fast), slow: Math.round(g.slow) } : g);
  const n = Math.min(...[...pres.values()].map((p) => p.bars.length));

  // In-sample: full period with the user's params.
  const full = simulate(s, pres, roundGrid(params), 0, n, costBps);
  // Walk-forward: pick the best grid point on each training window, score on the next window.
  const foldLen = Math.floor((n - 130) / (folds + 1));
  const oosDaily: number[] = [];
  const oosTrades: Trade[] = [];
  const oosExpo: number[] = [];
  const foldOut: BacktestResult["folds"] = [];
  for (let k = 1; k <= folds; k++) {
    const trainTo = 130 + foldLen * k;
    let best = grid[1];
    let bestSharpe = -Infinity;
    for (const g of grid) {
      const r = simulate(s, pres, roundGrid(g), 0, trainTo, costBps);
      const m = metrics(r.daily, r.trades, r.exposure);
      if (m.sharpe > bestSharpe) {
        bestSharpe = m.sharpe;
        best = g;
      }
    }
    const test = simulate(s, pres, roundGrid(best), trainTo, trainTo + foldLen, costBps);
    oosDaily.push(...test.daily);
    oosTrades.push(...test.trades);
    oosExpo.push(...test.exposure);
    foldOut.push({ start: test.times[0], end: test.times.at(-1)!, metrics: metrics(test.daily, test.trades, test.exposure) });
  }
  const inSample = metrics(full.daily, full.trades, full.exposure);
  const outOfSample = metrics(oosDaily, oosTrades, oosExpo);

  // Regime-specific metrics (by benchmark regime on each day).
  const regimeOf = new Map<number, string>();
  const bOff = benchmark.length - n;
  for (let t = 130; t < n; t++) {
    const bi = t + bOff;
    if (bi > 60 && t % 5 === 0) {
      const rg = detectRegime(benchmark, bi);
      for (let j = 0; j < 5; j++) regimeOf.set(t + j, `${rg.trend} / ${rg.vol}`);
    }
  }
  const groups = new Map<string, { d: number[]; e: number[] }>();
  full.daily.forEach((r, j) => {
    const key = regimeOf.get(j + 130) ?? "unlabelled";
    const g = groups.get(key) ?? { d: [], e: [] };
    g.d.push(r);
    g.e.push(full.exposure[j]);
    groups.set(key, g);
  });
  const byRegime = [...groups.entries()]
    .map(([regime, g]) => ({ regime, metrics: metrics(g.d, full.trades.filter((t) => (regimeOf.get(t.entryT) ?? "unlabelled") === regime), g.e) }))
    .sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);

  const tcSensitivity = [0, 5, 10, 25, 50].map((c) => {
    const r = c === costBps ? full : simulate(s, pres, roundGrid(params), 0, n, c);
    const m = metrics(r.daily, r.trades, r.exposure);
    return { costBps: c, totalReturn: m.totalReturn, sharpe: m.sharpe };
  });

  const bClose = benchmark.slice(-full.daily.length - 1).map((b) => b.c);
  let eq = 1;
  let pk = 1;
  const equity = full.daily.map((r, j) => {
    eq *= 1 + r;
    pk = Math.max(pk, eq);
    return { t: full.times[j], equity: eq, benchmark: bClose[j + 1] / bClose[0], drawdown: (eq / pk - 1) * 100 };
  });

  if (inSample.trades < 30) warnings.push(`Only ${inSample.trades} trades — results are not statistically meaningful.`);
  if (inSample.sharpe > 0.3 && outOfSample.sharpe < inSample.sharpe * 0.5) warnings.push("Out-of-sample Sharpe is less than half of in-sample — likely overfit.");
  if (tcSensitivity.find((x) => x.costBps === 25)!.sharpe < 0 && inSample.sharpe > 0) warnings.push("Edge disappears at 25bps costs — fragile to slippage.");
  const stable = byRegime.filter((r) => r.metrics.sharpe > 0).length;
  if (byRegime.length > 1 && stable / byRegime.length < 0.5) warnings.push("Profitable in fewer than half of regimes — low regime stability.");

  return { strategy: { ...s, params }, inSample, outOfSample, folds: foldOut, byRegime, tcSensitivity, equity, warnings };
}
