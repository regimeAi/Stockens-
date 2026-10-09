import type { Bar, Forecast, Profile, SignalCard } from "../types.ts";
import { atr, clamp } from "./indicators.ts";
import { computeFeatures } from "./features.ts";
import { sizePosition } from "./risk.ts";

// Signal translation: the 5-day forecast becomes a rules-based trade with entry, stop,
// target, holding window and size. Thresholds are stricter for novices (safer defaults).

export interface SignalRuleStats {
  hitRate: number;
  payoff: number;
  sharpe: number;
  trades: number;
}

export function thresholds(p: Profile) {
  return p.experience === "novice"
    ? { minConf: 62, minProb: 0.56, minRR: 1.8 }
    : p.experience === "intermediate"
      ? { minConf: 55, minProb: 0.54, minRR: 1.5 }
      : { minConf: 48, minProb: 0.52, minRR: 1.3 };
}

// Which backtested rule family this setup belongs to (uses the full feature vector,
// not just the top attributions).
export function classifyRule(f: Forecast, bars: Bar[]): string {
  const fv = computeFeatures(bars, bars.length - 1, {}, { breadth: 0.5, rates: 0, dollar: 0, commodities: 0, medianEarningsYield: 0.04 });
  const surprise = f.attributions.find((a) => a.feature === "eps_surprise")?.value ?? 0;
  const v = (k: string) => (k === "eps_surprise" ? surprise : fv[k] ?? 0);
  if (Math.abs(v("eps_surprise")) > 0.05) return "post-earnings-drift";
  if (v("vol_ratio") < -0.3) return "vol-compression";
  if (Math.abs(v("z_20")) > 1.8) return "mean-reversion";
  if (v("volume_z") > 1.5) return "breakout";
  return "trend";
}

export function toSignal(f: Forecast, bars: Bar[], profile: Profile, stats?: Record<string, SignalRuleStats>): SignalCard {
  const h5 = f.horizons.find((h) => h.horizon === "5d")!;
  const t = thresholds(profile);
  const a = atr(bars, 14);
  const entry = f.price;
  const exp = h5.expectedReturn / 100;
  const long = exp > 0;
  const riskDist = a * profile.risk.atrMultiple;
  const stop = long ? entry - riskDist : entry + riskDist;
  const targetDist = Math.max(Math.abs(exp) * entry * 1.25, riskDist * t.minRR);
  const target = long ? entry + targetDist : entry - targetDist;
  const rr = targetDist / riskDist;
  const prob = long ? h5.probUp : 1 - h5.probUp;
  const rule = classifyRule(f, bars);
  const ok = h5.confidence >= t.minConf && prob >= t.minProb && f.poker.action !== "fold";
  const side: SignalCard["side"] = !ok ? "hold" : long ? "buy" : "sell";
  const size = sizePosition({
    entry,
    stop,
    confidence: h5.confidence,
    edge: Math.abs(exp),
    atrPct: a / entry,
    risk: profile.risk,
    novice: profile.experience === "novice",
  });
  const st = stats?.[rule];
  const failing = f.integrity.filter((c) => !c.ok).map((c) => c.name.toLowerCase());
  return {
    id: `${f.symbol}-${side}-${new Date().toISOString().slice(0, 13)}`,
    symbol: f.symbol,
    side,
    createdAt: Date.now(),
    entry,
    stop,
    target,
    trailingAtr: profile.risk.atrMultiple,
    expectedMovePct: h5.expectedReturn,
    holdingDays: clamp(Math.round(5 * (rule === "mean-reversion" ? 0.6 : 1)), 1, profile.risk.timeStopDays),
    confidence: h5.confidence,
    rr,
    sizing: side === "hold" ? { shares: 0, notional: 0, riskDollars: 0, pctOfAccount: 0 } : size,
    rule,
    rationale:
      side === "hold"
        ? `No trade: ${h5.confidence < t.minConf ? `confidence ${h5.confidence} < ${t.minConf}` : prob < t.minProb ? `win probability ${(prob * 100).toFixed(0)}% < ${(t.minProb * 100).toFixed(0)}%` : "equity below pot odds"}.`
        : `${rule} setup, ${(prob * 100).toFixed(0)}% win probability, ${rr.toFixed(1)}:1 reward/risk. ${h5.rationale}${failing.length ? ` Watch: ${failing.join(", ")}.` : ""}`,
    extendedHours: profile.extendedHours && rule !== "mean-reversion",
    backtest: st,
  };
}
