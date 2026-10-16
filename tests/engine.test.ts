import { describe, expect, it } from "vitest";
import { GradientBoostedTrees } from "../server/engine/gbt.ts";
import { attentionForecast } from "../server/engine/sequence.ts";
import { metrics, backtest, DEFAULT_RISK, TEMPLATES } from "../server/engine/backtest.ts";
import { sizePosition } from "../server/engine/risk.ts";
import { pokerRead } from "../server/engine/psychology.ts";
import { scoreHeadline, summarize } from "../server/engine/sentiment.ts";
import { detectRegime } from "../server/engine/regime.ts";
import { normCdf, mulberry32 } from "../server/engine/indicators.ts";
import { MarketSimulator } from "../server/data/simulator.ts";
import { UNIVERSE } from "../server/data/universe.ts";
import { trainModels, forecast } from "../server/engine/ensemble.ts";
import { ConvergenceGraph, EDGE_COUNT, NODE_COUNT } from "../server/crypto/convergenceGraph.ts";
import { DEFAULT_PROFILE } from "../server/store.ts";
import { toSignal } from "../server/engine/signals.ts";
import type { Bar, StrategyConfig } from "../server/types.ts";

const ctx = { breadth: 0.55, rates: 0, dollar: 0, commodities: 0, medianEarningsYield: 0.04 };

describe("gradient boosted trees", () => {
  it("learns a non-linear function and attributions sum to the prediction", () => {
    const r = mulberry32(1);
    const X = Array.from({ length: 600 }, () => [r() * 2 - 1, r() * 2 - 1, r()]);
    const y = X.map(([a, b]) => (a > 0 ? 1 : -1) + 0.5 * b);
    const m = new GradientBoostedTrees({ trees: 80, depth: 3, minLeaf: 10 }).fit(X, y);
    expect(m.predict([0.8, 0, 0.5])).toBeGreaterThan(0.5);
    expect(m.predict([-0.8, 0, 0.5])).toBeLessThan(-0.5);
    const x = [0.3, -0.4, 0.2];
    const { base, contribs } = m.explain(x);
    expect(base + contribs.reduce((a, b) => a + b, 0)).toBeCloseTo(m.predict(x), 8);
    expect(Math.abs(contribs[0])).toBeGreaterThan(Math.abs(contribs[2]));
  });
});

describe("attention sequence model", () => {
  it("finds analogs and returns a bounded forecast", () => {
    const sim = new MarketSimulator(UNIVERSE.slice(0, 3));
    const bars = sim.get(UNIVERSE[0].symbol)!.bars;
    const f = attentionForecast(bars, bars.length - 1, 5);
    expect(f.effectiveAnalogs).toBeGreaterThan(1);
    expect(Math.abs(f.expected)).toBeLessThan(0.2);
    expect(f.topAnalogs.length).toBe(5);
  });
});

describe("ensemble + signals", () => {
  const sim = new MarketSimulator(UNIVERSE);
  const data = UNIVERSE.map((inst) => ({ inst, bars: sim.get(inst.symbol)!.bars, fundamentals: sim.get(inst.symbol)!.fundamentals, live: false }));
  const models = trainModels(data.slice(0, 20), ctx, 40);
  it("trains one model per horizon with purged out-of-sample scoring", () => {
    expect(models.map((m) => m.horizon).sort()).toEqual(["2q", "4w", "5d", "intraday"]);
    for (const m of models) expect(m.oosHitRate).toBeGreaterThanOrEqual(0);
  });
  it("produces multi-horizon forecasts with ordered bands, attributions and checks", () => {
    const d = data.find((x) => x.inst.symbol === "NVDA")!;
    const f = forecast({ d, ctx, regime: detectRegime(data.find((x) => x.inst.symbol === "SPY")!.bars), models, sentiment: summarize(sim.news("NVDA")), siteScores: [], catalysts: [], sources: [] });
    expect(f.horizons).toHaveLength(4);
    for (const h of f.horizons) {
      expect(h.bandLow).toBeLessThan(h.expectedReturn);
      expect(h.bandHigh).toBeGreaterThan(h.expectedReturn);
      expect(h.confidence).toBeGreaterThanOrEqual(1);
      expect(h.confidence).toBeLessThanOrEqual(99);
    }
    const w = (id: string) => { const h = f.horizons.find((x) => x.horizon === id)!; return h.bandHigh - h.bandLow; };
    expect(w("2q")).toBeGreaterThan(w("5d"));
    expect(f.attributions.length).toBeGreaterThan(3);
    expect(f.integrity.find((c) => c.name === "Live data")!.ok).toBe(false);
    expect(f.path).toHaveLength(6);

    const s = toSignal(f, d.bars, DEFAULT_PROFILE);
    if (s.expectedMovePct > 0) expect(s.stop).toBeLessThan(s.entry);
    else expect(s.stop).toBeGreaterThan(s.entry);
    if (s.side !== "hold") expect(s.sizing.riskDollars).toBeLessThanOrEqual(DEFAULT_PROFILE.risk.accountSize * 0.01);
  });
});

describe("backtester", () => {
  it("computes metrics correctly on a known series", () => {
    const m = metrics([0.01, -0.02, 0.03, 0], [{ ret: 0.05 }, { ret: -0.02 }], [1, 1, 0, 0]);
    expect(m.totalReturn).toBeCloseTo(1.01 * 0.98 * 1.03 - 1, 10);
    expect(m.maxDrawdown).toBeCloseTo(-0.02, 10);
    expect(m.hitRate).toBe(0.5);
    expect(m.payoff).toBeCloseTo(2.5, 10);
    expect(m.exposure).toBe(0.5);
  });
  it("runs walk-forward folds, regime splits and cost sensitivity", () => {
    const sim = new MarketSimulator(UNIVERSE);
    const bars = new Map(UNIVERSE.map((i) => [i.symbol, sim.get(i.symbol)!.bars] as [string, Bar[]]));
    const s: StrategyConfig = { id: "t", name: "t", template: "trend", params: TEMPLATES.trend.params, risk: DEFAULT_RISK, universe: ["SPY", "QQQ", "NVDA", "MSFT"], createdAt: 0 };
    const r = backtest(s, bars, ctx, bars.get("SPY")!, 5, 3);
    expect(r.folds).toHaveLength(3);
    expect(r.tcSensitivity.map((x) => x.costBps)).toEqual([0, 5, 10, 25, 50]);
    // Higher costs never help.
    expect(r.tcSensitivity[0].totalReturn).toBeGreaterThanOrEqual(r.tcSensitivity[4].totalReturn);
    expect(r.equity.length).toBeGreaterThan(100);
  });
  it("caps parameter count", () => {
    const sim = new MarketSimulator(UNIVERSE.slice(0, 45));
    const bars = new Map(UNIVERSE.slice(0, 45).map((i) => [i.symbol, sim.get(i.symbol)!.bars] as [string, Bar[]]));
    const s: StrategyConfig = { id: "t", name: "t", template: "trend", params: { fast: 20, slow: 50, minMom: 0.02, a: 1, b: 2 }, risk: DEFAULT_RISK, universe: ["SPY"], createdAt: 0 };
    const r = backtest(s, bars, ctx, bars.get("SPY")!, 5, 2);
    expect(Object.keys(r.strategy.params)).toHaveLength(4);
    expect(r.warnings.some((w) => w.includes("Too many parameters"))).toBe(true);
  });
});

describe("risk + psychology", () => {
  it("sizes so a stop-out costs about the risk budget and respects max position", () => {
    const risk = { ...DEFAULT_PROFILE.risk, accountSize: 100_000, riskPerTradePct: 1, maxPositionPct: 100 };
    const s = sizePosition({ entry: 100, stop: 95, confidence: 50, edge: 0.02, atrPct: 0.02, risk });
    expect(s.riskDollars).toBeLessThanOrEqual(1000 * 1.2 + 5);
    const capped = sizePosition({ entry: 100, stop: 99.9, confidence: 90, edge: 0.02, atrPct: 0.02, risk: { ...risk, maxPositionPct: 10 } });
    expect(capped.notional).toBeLessThanOrEqual(10_000);
    const novice = sizePosition({ entry: 100, stop: 95, confidence: 50, edge: 0.02, atrPct: 0.02, risk, novice: true });
    expect(novice.shares).toBeLessThan(s.shares);
  });
  it("folds when equity is below pot odds", () => {
    expect(pokerRead(0.3, 0.01, 0.02, 40).action).toBe("fold");
    expect(pokerRead(0.75, 0.05, 0.01, 80).action).toBe("raise");
  });
  it("scores headlines", () => {
    expect(scoreHeadline("Company beats estimates and raises guidance")).toBeGreaterThan(0.5);
    expect(scoreHeadline("Regulators open probe; company cuts outlook")).toBeLessThan(-0.5);
  });
});

describe("crypto convergence graph", () => {
  it("builds exactly 100 nodes and 180 edges", () => {
    const g = new ConvergenceGraph();
    const trades = Array.from({ length: 400 }, (_, i) => ({ t: Date.now() - (400 - i) * 250, p: 100000 + i * 5, q: 0.1 + (i % 7) / 10, buy: i % 3 !== 0 }));
    const klines = Array.from({ length: 200 }, (_, i) => ({ t: i * 300000, o: 99000 + i * 5, h: 99010 + i * 5, l: 98990 + i * 5, c: 99005 + i * 5, v: 10 }));
    const feed = { price: 102000, trades, klines5m: klines, book: { bid: 101999, ask: 102001, bidQty: 3, askQty: 1 }, priceAt: (t: number) => trades.filter((x) => x.t <= t).at(-1)?.p } as never;
    const book = { upBid: 0.6, upAsk: 0.62, downBid: 0.38, downAsk: 0.4, upAskDepthUsd: 300, downAskDepthUsd: 500, mid: 0.61, updatedAt: Date.now() };
    const tv = { bias: () => 0.5 } as never;
    const flows = { reading: { netflowZ: -1, whaleRatio: 0.4, reserveChange: -0.01 } } as never;
    let snap = g.update({ feed, book, tv, flows, lagDir: 1 });
    for (let i = 0; i < 15; i++) snap = g.update({ feed, book, tv, flows, lagDir: 1 });
    expect(snap.nodes).toHaveLength(NODE_COUNT);
    expect(snap.edges.length).toBeLessThanOrEqual(EDGE_COUNT);
    expect(snap.edges.length).toBeGreaterThan(100);
    // A steadily rising tape with net buying should converge bullish.
    expect(snap.verdict).toBe("BULL");
  });
  it("normal CDF is sane", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.2816)).toBeCloseTo(0.9, 3);
  });
});

describe("stripe webhook signatures", async () => {
  const crypto = await import("node:crypto");
  const { config } = await import("../server/config.ts");
  const { verifyWebhook } = await import("../server/stripe.ts");
  it("accepts a valid signature and rejects tampering or stale timestamps", () => {
    config.stripe.webhookSecret = "whsec_test";
    const body = JSON.stringify({ type: "checkout.session.completed" });
    const t = Math.floor(Date.now() / 1000);
    const sig = (ts: number, b: string) => crypto.createHmac("sha256", "whsec_test").update(`${ts}.${b}`).digest("hex");
    expect(verifyWebhook(body, `t=${t},v1=${sig(t, body)}`)).toBe(true);
    expect(verifyWebhook(body + " ", `t=${t},v1=${sig(t, body)}`)).toBe(false);
    expect(verifyWebhook(body, `t=${t - 600},v1=${sig(t - 600, body)}`)).toBe(false);
    expect(verifyWebhook(body, undefined)).toBe(false);
  });
});

describe("DATABASE_URL validation", async () => {
  const { databaseUrlProblem } = await import("../server/store.ts");
  it("explains common copy-paste mistakes and accepts a full Neon string", () => {
    expect(databaseUrlProblem("postgresql://…channel_binding=require")).toMatch(/cut short/);
    expect(databaseUrlProblem("neondb_owner:pw@host/db")).toBeTruthy();
    expect(databaseUrlProblem("postgresql://neondb_owner@ep-x.us-west-2.aws.neon.tech/neondb")).toMatch(/no password/);
    expect(databaseUrlProblem("postgresql://neondb_owner:secret@ep-x-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require")).toBeUndefined();
  });
});

describe("forecast anomaly detection", async () => {
  const { AnomalyDetector, checkMisses, robustZ, calibration } = await import("../server/engine/anomaly.ts");
  const fc = (symbol: string, exp: number, conf: number, band: number, price: number, votes = [exp, exp, exp, exp]) =>
    ({
      symbol, price,
      horizons: [{ horizon: "5d", expectedReturn: exp, confidence: conf, bandLow: exp - band / 2, bandHigh: exp + band / 2, probUp: 0.5, label: "", rationale: "" }],
      modelVotes: votes.map((v) => ({ model: "m", expectedReturn: v, weight: 0.25 })),
    }) as never;

  it("stays quiet on normal noise", () => {
    const d = new AnomalyDetector({ sampleMs: 1000, minHistory: 20 });
    const t0 = 1_000_000_000;
    let n = 0;
    for (let i = 0; i < 120; i++) n += d.observe(fc("AAA", 1 + Math.sin(i) * 0.1, 50 + (i % 3), 6, 100 + Math.sin(i) * 0.2), 2, t0 + i * 60_000).length;
    expect(n).toBe(0);
  });

  it("flags a forecast jump, a direction flip, an uncertainty spike and models splitting", () => {
    const d = new AnomalyDetector({ sampleMs: 1000, minHistory: 20 });
    const t0 = 1_000_000_000;
    for (let i = 0; i < 60; i++) d.observe(fc("BBB", 1 + (i % 5) * 0.05, 50, 6, 100), 2, t0 + i * 60_000);
    const found = d.observe(fc("BBB", -3, 62, 14, 100, [-6, -3, 2, 1]), 2, t0 + 61 * 60_000);
    const kinds = found.map((a) => a.kind).sort();
    expect(kinds).toEqual(["direction-flip", "forecast-jump", "model-split", "uncertainty-shock"]);
    expect(found.find((a) => a.kind === "forecast-jump")!.severity).toBe(3);
    // Cooldown: the same reading a minute later doesn't re-alert.
    expect(d.observe(fc("BBB", -3, 62, 14, 100, [-6, -3, 2, 1]), 2, t0 + 62 * 60_000)).toHaveLength(0);
  });

  it("flags price running against the forecast and confidence collapsing", () => {
    const d = new AnomalyDetector({ sampleMs: 1000, minHistory: 20 });
    const t0 = 1_000_000_000;
    for (let i = 0; i < 70; i++) d.observe(fc("CCC", 1.2, 70, 6, 100), 2, t0 + i * 60_000);
    const found = d.observe(fc("CCC", 1.2, 45, 6, 96.5), 2, t0 + 71 * 60_000); // -3.5% vs a 2% ATR, bullish call
    expect(found.map((a) => a.kind).sort()).toEqual(["confidence-shift", "price-vs-forecast"]);
  });

  it("finds peer outliers and forecast misses", () => {
    const d = new AnomalyDetector();
    const peers = Array.from({ length: 12 }, (_, i) => fc(`P${i}`, 0.5 + (i % 4) * 0.1, 50, 6, 100));
    const out = d.peers(new Map([["stocks", [...peers, fc("ODD", 6, 50, 6, 100)]]]));
    expect(out.map((a) => a.symbol)).toEqual(["ODD"]);

    const bars = Array.from({ length: 10 }, (_, i) => ({ t: i, c: i < 3 ? 100 : 112 }));
    const { log, misses } = checkMisses(
      [{ symbol: "M", barT: 2, price: 100, exp: 1, low: -4, high: 6 }, { symbol: "N", barT: 2, price: 100, exp: 1, low: -4, high: 20 }],
      () => bars,
    );
    expect(misses.map((m) => m.symbol)).toEqual(["M"]); // +12% landed above M's band, inside N's
    expect(calibration(log, Infinity, 0).insideRate).toBe(0.5);
    expect(robustZ(10, [1, 1, 1, 1], 0.5)).toBe(18);
  });
});
