import type { Forecast, PokerRead } from "../types.ts";
import { clamp } from "./indicators.ts";

// Poker strategy applied to trades: a signal is only worth playing when your equity
// (model win probability) beats the pot odds implied by the payoff, and you size by a
// fraction of Kelly — like betting a strong hand without going all-in.
export function pokerRead(probUp: number, expected: number, atrPct: number, confidence: number): PokerRead {
  const long = expected >= 0;
  const equity = long ? probUp : 1 - probUp;
  const stop = Math.max(atrPct * 2, 0.005);
  const target = Math.max(Math.abs(expected) * 1.5, stop * 1.5);
  const b = target / stop; // payoff ratio
  const potOdds = 1 / (1 + b);
  const edge = equity - potOdds;
  const kelly = clamp(((b * equity - (1 - equity)) / b) * 0.25, 0, 0.05);
  const handStrength = Math.round(clamp(edge * 200 + confidence * 0.5, 0, 100));
  const action: PokerRead["action"] = edge <= 0 ? "fold" : edge < 0.03 ? "check" : edge < 0.08 || confidence < 60 ? "call" : "raise";
  const note =
    action === "fold"
      ? "Equity is below pot odds — the payoff doesn't pay for the risk. Fold and wait for a better hand."
      : action === "check"
        ? "Marginal edge. Watch, don't commit — let the next card (data) come."
        : action === "call"
          ? "Positive expectancy but modest. Play a small, standard size."
          : "Strong hand: equity comfortably beats pot odds. Size up within your risk limits — never all-in.";
  return { handStrength, potOdds, equity, action, kellyFraction: kelly, note };
}

export interface PsychologyGauge {
  fearGreed: number; // 0 (extreme fear) .. 100 (extreme greed)
  label: string;
  components: { name: string; value: number; note: string }[];
  crowd: string[];
}

// Market psychology: a fear/greed composite from breadth, momentum, volatility,
// news tone and how stretched prices are, with plain-English crowd-behaviour notes.
export function psychologyGauge(forecasts: Forecast[], breadth: number, volRatio: number): PsychologyGauge {
  const eq = forecasts.filter((f) => !f.themes.includes("crypto"));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const mom = avg(eq.map((f) => f.changePct));
  const news = avg(forecasts.map((f) => f.sentiment.score));
  const stretch = avg(eq.map((f) => f.attributions.find((a) => a.feature === "z_20")?.value ?? 0));
  const comps = [
    { name: "Breadth", value: clamp(breadth * 100, 0, 100), note: `${Math.round(breadth * 100)}% of names above 50-day average` },
    { name: "Momentum", value: clamp(50 + mom * 15, 0, 100), note: `Average move today ${mom.toFixed(2)}%` },
    { name: "Volatility", value: clamp(50 - volRatio * 40, 0, 100), note: volRatio > 0 ? "Volatility expanding (fear)" : "Volatility compressing (complacency)" },
    { name: "News tone", value: clamp(50 + news * 100, 0, 100), note: `Headline sentiment ${news.toFixed(2)}` },
    { name: "Stretch", value: clamp(50 + stretch * 20, 0, 100), note: "How far prices sit from their 20-day mean" },
  ];
  const fg = Math.round(avg(comps.map((c) => c.value)));
  const label = fg < 20 ? "Extreme fear" : fg < 40 ? "Fear" : fg < 60 ? "Neutral" : fg < 80 ? "Greed" : "Extreme greed";
  const crowd: string[] = [];
  if (fg > 75) crowd.push("FOMO risk: late buyers chase extended names — favour pullback entries and tighter stops.");
  if (fg < 25) crowd.push("Capitulation conditions: forced selling creates mispricings; scale in slowly, don't catch the whole knife.");
  if (Math.abs(news) > 0.3 && Math.sign(news) !== Math.sign(mom)) crowd.push("Narrative and tape disagree — one of them is about to be wrong. Wait for confirmation.");
  if (volRatio > 0.5) crowd.push("Volatility shock: correlations rise, diversification weakens. Cut size, widen stops or stand aside.");
  if (!crowd.length) crowd.push("No extreme crowd behaviour. Let the signals and your rules do the work.");
  return { fearGreed: fg, label, components: comps, crowd };
}
