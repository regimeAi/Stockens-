import type { Bar, Fundamentals, Instrument, NewsItem } from "../types.ts";
import { gaussian, hashString, mulberry32, uid } from "../engine/indicators.ts";

// Offline market simulator. Used whenever a live source is unreachable so the whole
// app (agent, dashboard, Strategy Lab) keeps working on a laptop with no keys.
// It has regime-switching market volatility, beta exposure, mild momentum persistence
// and mean-reverting idiosyncratic shocks — enough structure for models to find (or not find) edge.

const DAY = 86_400_000;

const BASE_PRICE: Record<string, number> = {
  NVDA: 180, AMD: 160, AVGO: 330, TSM: 290, ANET: 140, COHR: 95, EQIX: 790, DLR: 170, MSFT: 510, AMZN: 225,
  GOOGL: 240, SNOW: 220, ORCL: 290, CRWD: 470, PANW: 200, ZS: 290, ADBE: 350, NOW: 920, META: 760, NFLX: 1200,
  LLY: 820, VRTX: 400, ISRG: 450, MRNA: 26, ROK: 340, ETN: 370, CAT: 470, XOM: 112, FSLR: 210, FLNC: 9,
  VST: 200, JPM: 310, HOOD: 140, SCHW: 95, PYPL: 68, COIN: 380, SHOP: 160, TSLA: 440, COST: 930, AAPL: 255,
  SPY: 670, QQQ: 600, SMH: 320, IGV: 110, CIBR: 75, XBI: 100, TLT: 89, UUP: 27, GLD: 360, USO: 72,
  BTC: 121000, ETH: 4500, SOL: 225, DOGE: 0.26, PEPE: 0.0000105,
};

export interface SimSeries {
  bars: Bar[];
  fundamentals: Fundamentals;
}

export class MarketSimulator {
  private rand = mulberry32(42);
  private series = new Map<string, SimSeries>();
  private marketShocks: number[] = [];
  private volRegime: number[] = [];

  constructor(private universe: Instrument[], private historyDays = 520) {
    this.buildMarket();
    for (const inst of universe) this.series.set(inst.symbol, this.buildSeries(inst));
  }

  private buildMarket() {
    let state = 0; // 0 calm, 1 stressed
    for (let i = 0; i < this.historyDays; i++) {
      if (state === 0 && this.rand() < 0.02) state = 1;
      else if (state === 1 && this.rand() < 0.08) state = 0;
      const vol = state ? 0.022 : 0.009;
      const drift = state ? -0.0012 : 0.0006;
      this.volRegime.push(state);
      this.marketShocks.push(drift + vol * gaussian(this.rand));
    }
  }

  private buildSeries(inst: Instrument): SimSeries {
    const r = mulberry32(hashString(inst.symbol));
    const beta = inst.beta ?? 1;
    const crypto = inst.assetClass === "crypto";
    const idioVol = crypto ? 0.03 : inst.assetClass === "etf" ? 0.004 : 0.014;
    const alpha = (r() - 0.45) * 0.0012;
    const start = BASE_PRICE[inst.symbol] ?? 50;
    // Walk backwards from today's anchor so the latest price ≈ BASE_PRICE.
    const rets: number[] = [];
    let mom = 0;
    for (let i = 0; i < this.historyDays; i++) {
      const shock = gaussian(r) * idioVol;
      mom = 0.92 * mom + 0.08 * shock; // momentum persistence
      const ret = alpha + beta * this.marketShocks[i] + shock + 0.35 * mom;
      rets.push(Math.max(-0.4, Math.min(0.4, ret)));
    }
    const total = rets.reduce((p, x) => p * (1 + x), 1);
    let price = start / total;
    const now = startOfDay(Date.now());
    const bars: Bar[] = [];
    for (let i = 0; i < this.historyDays; i++) {
      const o = price;
      const c = price * (1 + rets[i]);
      const range = Math.abs(rets[i]) + idioVol * (0.4 + r());
      const h = Math.max(o, c) * (1 + range * 0.5 * r());
      const l = Math.min(o, c) * (1 - range * 0.5 * r());
      const v = Math.round((crypto ? 2e4 : 5e6) * (0.6 + r()) * (1 + Math.abs(rets[i]) * 20));
      bars.push({ t: now - (this.historyDays - 1 - i) * DAY, o, h, l, c, v });
      price = c;
    }
    const fundamentals: Fundamentals = crypto
      ? {}
      : {
          pe: Math.round(10 + r() * 60),
          forwardPe: Math.round(8 + r() * 45),
          epsRevision: Math.round((r() - 0.45) * 120) / 10,
          epsSurprise: Math.round((r() - 0.4) * 200) / 10,
          analystDispersion: Math.round((0.05 + r() * 0.4) * 100) / 100,
          shortFloat: Math.round(r() * 120) / 10,
          marketCap: Math.round(start * (1e8 + r() * 5e9)),
          dividendYield: inst.dividendYield,
          nextEarnings: now + Math.round(r() * 60) * DAY,
        };
    return { bars, fundamentals };
  }

  get(symbol: string): SimSeries | undefined {
    return this.series.get(symbol);
  }

  isStressed(): boolean {
    return this.volRegime[this.volRegime.length - 1] === 1;
  }

  // Advance the latest bar with an intraday tick (called by the agent loop).
  tick(dtMs: number) {
    const frac = dtMs / (6.5 * 3600_000);
    const m = gaussian(this.rand) * 0.01 * Math.sqrt(frac);
    for (const inst of this.universe) {
      const s = this.series.get(inst.symbol)!;
      const b = s.bars[s.bars.length - 1];
      const vol = inst.assetClass === "crypto" ? 0.035 : 0.015;
      const ret = (inst.beta ?? 1) * m + gaussian(this.rand) * vol * Math.sqrt(frac);
      b.c = b.c * (1 + ret);
      b.h = Math.max(b.h, b.c);
      b.l = Math.min(b.l, b.c);
      b.v += Math.round(b.v * frac * 0.5);
      // Roll over to a new day when the wall-clock day changes.
      const today = startOfDay(Date.now());
      if (b.t < today) s.bars.push({ t: today, o: b.c, h: b.c, l: b.c, c: b.c, v: 0 });
    }
  }

  news(symbol: string, count = 6): NewsItem[] {
    const r = mulberry32(hashString(symbol + startOfDay(Date.now())) ^ Math.floor(Date.now() / 900_000));
    const s = this.series.get(symbol);
    const bars = s?.bars ?? [];
    const recent = bars.length > 5 ? bars[bars.length - 1].c / bars[bars.length - 6].c - 1 : 0;
    const out: NewsItem[] = [];
    for (let i = 0; i < count; i++) {
      const tone = Math.max(-1, Math.min(1, recent * 8 + (r() - 0.5) * 1.2));
      const pool = tone > 0.2 ? POSITIVE : tone < -0.2 ? NEGATIVE : NEUTRAL;
      out.push({
        id: uid("n_"),
        symbol,
        t: Date.now() - Math.round(r() * 3 * DAY),
        headline: pool[Math.floor(r() * pool.length)].replace("{s}", symbol),
        source: "simulated",
        sentiment: Math.round(tone * 100) / 100,
      });
    }
    return out.sort((a, b) => b.t - a.t);
  }
}

export function startOfDay(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const POSITIVE = [
  "{s} beats estimates, raises full-year guide",
  "Analysts lift {s} price targets after strong demand checks",
  "{s} wins multi-year contract with hyperscaler",
  "Unusual call buying in {s} ahead of product event",
  "{s} added to major index; inflows expected",
];
const NEGATIVE = [
  "{s} cuts outlook citing softer orders",
  "{s} downgraded on valuation, slowing growth",
  "Regulators open probe into {s} practices",
  "{s} insiders file to sell shares",
  "Supply constraints weigh on {s} margins",
];
const NEUTRAL = [
  "{s} to present at industry conference next week",
  "{s} schedules earnings release date",
  "{s} trading range-bound as investors await data",
  "Options market prices modest move for {s}",
];
