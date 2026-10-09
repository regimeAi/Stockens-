import type { Bar, Forecast, Instrument, Position, RiskSettings } from "../types.ts";
import { clamp, correlation, maxDrawdown, returns } from "./indicators.ts";

export interface SizeInput {
  entry: number;
  stop: number;
  confidence: number; // 0..100
  edge: number; // expected return as fraction
  atrPct: number;
  risk: RiskSettings;
  novice?: boolean;
}

// Position sizing assistant: start from the account risk budget, divide by stop distance,
// then scale by forecast edge/confidence and cap by max-position %. Novice mode halves risk.
export function sizePosition(s: SizeInput) {
  const perShareRisk = Math.abs(s.entry - s.stop);
  if (!perShareRisk || !s.entry) return { shares: 0, notional: 0, riskDollars: 0, pctOfAccount: 0, explain: "No valid stop distance." };
  const base = s.risk.accountSize * (s.risk.riskPerTradePct / 100) * (s.novice ? 0.5 : 1);
  const conviction = clamp(0.4 + (s.confidence / 100) * 0.8, 0.4, 1.2);
  const volAdj = clamp(0.02 / Math.max(s.atrPct, 0.005), 0.5, 1.5);
  const riskDollars = base * conviction;
  let shares = riskDollars / perShareRisk;
  const maxNotional = s.risk.accountSize * (s.risk.maxPositionPct / 100);
  shares = Math.min(shares, maxNotional / s.entry) * (volAdj < 1 ? volAdj : 1);
  shares = s.entry > 1000 ? Math.floor(shares * 10000) / 10000 : Math.floor(shares);
  const notional = shares * s.entry;
  return {
    shares,
    notional,
    riskDollars: shares * perShareRisk,
    pctOfAccount: (notional / s.risk.accountSize) * 100,
    explain: `Risk budget $${base.toFixed(0)} × conviction ${conviction.toFixed(2)} ÷ stop distance $${perShareRisk.toFixed(2)}, capped at ${s.risk.maxPositionPct}% of account${volAdj < 1 ? ", trimmed for high volatility" : ""}.`,
  };
}

export function stops(entry: number, atrAbs: number, side: "buy" | "sell", r: RiskSettings) {
  const dir = side === "buy" ? -1 : 1;
  return {
    static: entry * (1 + dir * 0.05),
    atr: entry + dir * atrAbs * r.atrMultiple,
    trailing: { distance: atrAbs * r.atrMultiple, note: `Trail ${r.atrMultiple}× ATR below the highest close since entry` },
    time: { days: r.timeStopDays, note: `Exit after ${r.timeStopDays} trading days if the target hasn't hit` },
  };
}

export interface PortfolioView {
  value: number;
  beta: number;
  sectors: { sector: string; pct: number; overLimit: boolean }[];
  correlationCreep: number; // avg pairwise correlation of holdings (60d)
  drawdown: number;
  drawdownSeries: { t: number; value: number; dd: number }[];
  nudges: string[];
}

export function portfolioView(positions: Position[], bars: Map<string, Bar[]>, insts: Map<string, Instrument>, r: RiskSettings): PortfolioView {
  const live = positions.filter((p) => bars.get(p.symbol)?.length);
  const px = (s: string) => bars.get(s)!.at(-1)!.c;
  const value = live.reduce((a, p) => a + p.qty * px(p.symbol), 0) || 0;
  const beta = value ? live.reduce((a, p) => a + ((p.qty * px(p.symbol)) / value) * (insts.get(p.symbol)?.beta ?? 1), 0) : 0;
  const bySector = new Map<string, number>();
  for (const p of live) {
    const s = insts.get(p.symbol)?.sector ?? "Other";
    bySector.set(s, (bySector.get(s) ?? 0) + p.qty * px(p.symbol));
  }
  const sectors = [...bySector.entries()]
    .map(([sector, v]) => ({ sector, pct: value ? (v / value) * 100 : 0, overLimit: value ? (v / value) * 100 > r.maxSectorPct : false }))
    .sort((a, b) => b.pct - a.pct);
  const rets = live.map((p) => returns(bars.get(p.symbol)!.slice(-61).map((b) => b.c)));
  let cs = 0;
  let cn = 0;
  for (let i = 0; i < rets.length; i++) for (let j = i + 1; j < rets.length; j++) {
    cs += correlation(rets[i], rets[j]);
    cn++;
  }
  // Historical portfolio value at current weights (last 120 days).
  const len = Math.min(120, ...live.map((p) => bars.get(p.symbol)!.length));
  const series: { t: number; value: number; dd: number }[] = [];
  if (live.length && Number.isFinite(len)) {
    const ref = bars.get(live[0].symbol)!;
    let peak = 0;
    for (let k = len; k >= 1; k--) {
      const v = live.reduce((a, p) => a + p.qty * bars.get(p.symbol)!.at(-k)!.c, 0);
      peak = Math.max(peak, v);
      series.push({ t: ref.at(-k)!.t, value: v, dd: peak ? (v / peak - 1) * 100 : 0 });
    }
  }
  const dd = maxDrawdown(series.map((s) => s.value)) * 100;
  const nudges: string[] = [];
  for (const s of sectors) if (s.overLimit) nudges.push(`${s.sector} is ${s.pct.toFixed(0)}% of the portfolio (limit ${r.maxSectorPct}%). Consider trimming.`);
  if (cn && cs / cn > 0.6) nudges.push(`Correlation creep: holdings move together (avg ρ ${(cs / cn).toFixed(2)}). You have less diversification than it looks.`);
  if (beta > 1.4) nudges.push(`Portfolio beta ${beta.toFixed(2)} — a 5% market drop would cost ≈${(beta * 5).toFixed(1)}%.`);
  const curDd = series.at(-1)?.dd ?? 0;
  if (curDd < -r.maxDrawdownPct) nudges.push(`Drawdown brake: ${curDd.toFixed(1)}% is past your ${r.maxDrawdownPct}% limit. New entries are paused until you recover or reset.`);
  return { value, beta, sectors, correlationCreep: cn ? cs / cn : 0, drawdown: dd, drawdownSeries: series, nudges };
}

export interface Scenario {
  id: string;
  name: string;
  market: number; // % shock to the market factor
  rates: number; // % move in long bonds
  vol: number; // vol multiplier
  sectorShocks?: Record<string, number>;
}

export const SCENARIOS: Scenario[] = [
  { id: "gap-down", name: "Market gaps down 5%", market: -5, rates: 1, vol: 1.8 },
  { id: "rates-up", name: "Rates spike (+50bp)", market: -2, rates: -6, vol: 1.3, sectorShocks: { Technology: -2, "Real Estate": -3, Utilities: -2, Financials: 1 } },
  { id: "rates-down", name: "Rates fall (−50bp)", market: 1.5, rates: 6, vol: 0.9, sectorShocks: { Technology: 1.5, "Real Estate": 3, Financials: -1 } },
  { id: "vol-spike", name: "Volatility spike (VIX 35)", market: -7, rates: 2, vol: 2.5, sectorShocks: { Crypto: -12 } },
  { id: "2020-03", name: "Historical analog: Mar 2020", market: -12, rates: 4, vol: 4 },
  { id: "2022-rates", name: "Historical analog: 2022 rate shock", market: -8, rates: -10, vol: 1.6, sectorShocks: { Technology: -6, Communication: -6, Energy: 8 } },
  { id: "ai-unwind", name: "AI trade unwinds", market: -3, rates: 0, vol: 1.5, sectorShocks: { Technology: -9, Utilities: -6, "Real Estate": -4 } },
];

export function runScenario(positions: Position[], bars: Map<string, Bar[]>, insts: Map<string, Instrument>, sc: Scenario) {
  const rows = positions
    .filter((p) => bars.get(p.symbol)?.length)
    .map((p) => {
      const inst = insts.get(p.symbol);
      const price = bars.get(p.symbol)!.at(-1)!.c;
      const isBond = inst?.themes.includes("rates");
      const shock = isBond ? sc.rates : (inst?.beta ?? 1) * sc.market + (sc.sectorShocks?.[inst?.sector ?? ""] ?? 0);
      const pnl = p.qty * price * (shock / 100);
      return { symbol: p.symbol, shockPct: shock, pnl };
    });
  const total = rows.reduce((a, r) => a + r.pnl, 0);
  return { scenario: sc, rows, total };
}

// Stops/targets "pre-wired to alert before violations": distance to stop in ATRs.
export function proximity(f: Forecast, stop: number, atrAbs: number) {
  return atrAbs ? (f.price - stop) / atrAbs : Infinity;
}
