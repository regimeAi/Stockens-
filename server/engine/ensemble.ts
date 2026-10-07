import type { Attribution, Bar, Forecast, Fundamentals, HorizonForecast, Instrument, IntegrityCheck, Regime } from "../types.ts";
import { HORIZONS } from "../types.ts";
import { FEATURES, type MarketContext, computeFeatures, forwardReturn, realizedVol, toArray } from "./features.ts";
import { GradientBoostedTrees } from "./gbt.ts";
import { attentionForecast } from "./sequence.ts";
import { atr, clamp, normCdf } from "./indicators.ts";
import { pokerRead } from "./psychology.ts";
import type { SentimentSummary } from "./sentiment.ts";

// The ensemble: GBT on tabular features + attention sequence model + trend and
// mean-reversion experts, blended with regime-dependent weights. Targets are
// volatility-normalised forward returns so one model can be pooled across assets.

const H_DAYS: Record<string, number> = { intraday: 1, "5d": 5, "4w": 20, "2q": 126 };

export interface TrainedModel {
  horizon: string;
  gbt: GradientBoostedTrees;
  trainedAt: number;
  samples: number;
  oosHitRate: number; // out-of-sample directional accuracy on the most recent 20% of time
  oosIc: number; // rank-ish correlation between prediction and outcome on OOS
}

export interface SymbolData {
  inst: Instrument;
  bars: Bar[];
  fundamentals: Fundamentals;
  live: boolean; // true if prices came from a live source
}

export function trainModels(data: SymbolData[], ctx: MarketContext, maxSamplesPerSymbol = 120): TrainedModel[] {
  const out: TrainedModel[] = [];
  for (const { id } of HORIZONS) {
    const h = H_DAYS[id];
    const rows: { x: number[]; y: number; t: number }[] = [];
    for (const d of data) {
      const n = d.bars.length;
      const start = 130;
      const stride = Math.max(1, Math.floor((n - start - h) / maxSamplesPerSymbol));
      for (let i = start; i + h < n; i += stride) {
        const fr = forwardReturn(d.bars, i, h)!;
        const vol = realizedVol(d.bars, i) * Math.sqrt(h);
        const fv = computeFeatures(d.bars, i, d.fundamentals, ctx);
        rows.push({ x: toArray(fv), y: clamp(fr / vol, -4, 4), t: d.bars[i].t });
      }
    }
    if (rows.length < 200) continue;
    // Time-ordered split: train on the past, score on the most recent 20% (walk-forward style).
    rows.sort((a, b) => a.t - b.t);
    const cut = Math.floor(rows.length * 0.8);
    // Purge an h-day gap so training labels never overlap the test window.
    const purgeT = rows[cut].t - h * 86_400_000;
    const train = rows.slice(0, cut).filter((r) => r.t < purgeT);
    const test = rows.slice(cut);
    const gbt = new GradientBoostedTrees({ trees: 50, depth: 3, minLeaf: 25, maxFeatures: 12 }).fit(
      train.map((r) => r.x),
      train.map((r) => r.y),
    );
    let hits = 0;
    const preds = test.map((r) => gbt.predict(r.x));
    test.forEach((r, k) => (hits += Math.sign(preds[k]) === Math.sign(r.y) ? 1 : 0));
    const pm = preds.reduce((a, b) => a + b, 0) / preds.length;
    const ym = test.reduce((a, b) => a + b.y, 0) / test.length;
    let num = 0, dp = 0, dy = 0;
    test.forEach((r, k) => {
      num += (preds[k] - pm) * (r.y - ym);
      dp += (preds[k] - pm) ** 2;
      dy += (r.y - ym) ** 2;
    });
    out.push({
      horizon: id,
      gbt,
      trainedAt: Date.now(),
      samples: train.length,
      oosHitRate: hits / Math.max(1, test.length),
      oosIc: dp && dy ? num / Math.sqrt(dp * dy) : 0,
    });
  }
  return out;
}

export interface ForecastInput {
  d: SymbolData;
  ctx: MarketContext;
  regime: Regime;
  models: TrainedModel[];
  sentiment: SentimentSummary;
  siteScores: { source: string; score: number }[];
  catalysts: string[];
  sources: string[];
}

export function forecast(inp: ForecastInput): Forecast {
  const { d, ctx, regime, models, sentiment } = inp;
  const bars = d.bars;
  const i = bars.length - 1;
  const price = bars[i].c;
  const fv = computeFeatures(bars, i, d.fundamentals, ctx, sentiment);
  const x = toArray(fv);
  const dvol = realizedVol(bars, i);
  const W = regime.weights;
  const site = inp.siteScores.length ? inp.siteScores.reduce((a, b) => a + b.score, 0) / inp.siteScores.length : 0;

  const horizons: HorizonForecast[] = [];
  const contribByFeature = new Map<string, number>();
  let votes5d: Forecast["modelVotes"] = [];
  let analogs = 0;

  for (const hz of HORIZONS) {
    const h = H_DAYS[hz.id];
    const scale = hz.id === "intraday" ? Math.sqrt(1 / 6.5) : 1; // rest-of-session ≈ fraction of a day
    const sig = dvol * Math.sqrt(h) * scale;
    const m = models.find((mm) => mm.horizon === hz.id);
    const gbtZ = m ? m.gbt.predict(x) : 0;
    const gbtRet = gbtZ * sig * 0.5; // shrink: models are noisy, half-strength by default
    const seq = attentionForecast(bars, i, Math.max(1, Math.round(h * scale)), hz.id === "2q" ? 40 : 20);
    if (hz.id === "5d") analogs = seq.effectiveAnalogs;
    const trendRet = clamp(fv.mom_20 * 0.15 + fv.trend_slope * 0.4, -0.5, 0.5) * Math.sqrt(h / 20) * scale;
    const revRet = -clamp(fv.z_20, -3, 3) * 0.25 * sig;
    const newsRet = (sentiment.score * 0.6 + sentiment.momentum * 0.4) * 0.15 * sig * (h <= 5 ? 1 : 0.3);
    const siteRet = site * 0.2 * sig;
    const comps = [
      { model: "Gradient-boosted trees", r: gbtRet, w: W.gbt },
      { model: "Attention sequence", r: seq.expected * scale, w: W.sequence },
      { model: "Trend expert", r: trendRet, w: W.trend },
      { model: "Mean-reversion expert", r: revRet, w: W.reversion },
    ];
    const blended = comps.reduce((a, c) => a + c.r * c.w, 0) + newsRet + siteRet;
    const disagreement = Math.sqrt(comps.reduce((a, c) => a + c.w * (c.r - blended) ** 2, 0)) / (sig || 1);
    const bandSig = sig * (1 + clamp(fv.dispersion, 0, 1) * 0.3 + clamp(disagreement, 0, 1) * 0.5) * (regime.vol === "high-vol" ? 1.2 : 1);
    const probUp = normCdf(blended / (bandSig || 1e-9));
    const agree = comps.filter((c) => Math.sign(c.r) === Math.sign(blended)).reduce((a, c) => a + c.w, 0);
    // Confidence = signal strength (z-score of the expected move inside its band) blended with
    // model agreement, discounted by data quality and the model's out-of-sample skill.
    const quality = (d.live ? 1 : 0.9) * (m ? clamp(0.8 + (m.oosHitRate - 0.5) * 2, 0.6, 1) : 0.6) * (regime.liquidity === "thin" ? 0.85 : 1);
    const strength = clamp(Math.abs(blended / (bandSig || 1e-9)) / 0.35, 0, 1);
    const confidence = Math.round(clamp((strength * 0.55 + agree * 0.45) * quality * 100, 1, 99));
    horizons.push({
      horizon: hz.id,
      label: hz.label,
      expectedReturn: blended * 100,
      bandLow: (blended - 1.2816 * bandSig) * 100,
      bandHigh: (blended + 1.2816 * bandSig) * 100,
      probUp,
      confidence,
      rationale: rationale(hz.label, comps, blended, regime, sentiment),
    });

    if (hz.id === "5d") {
      votes5d = comps.map((c) => ({ model: c.model, expectedReturn: c.r * 100, weight: c.w }));
      // Feature attributions for the headline 5-day call.
      if (m) {
        const { contribs } = m.gbt.explain(x);
        contribs.forEach((cz, k) => add(contribByFeature, FEATURES[k].key, cz * sig * 0.5 * W.gbt * 100));
      }
      add(contribByFeature, "mom_20", fv.mom_20 * 0.15 * Math.sqrt(h / 20) * W.trend * 100);
      add(contribByFeature, "trend_slope", fv.trend_slope * 0.4 * Math.sqrt(h / 20) * W.trend * 100);
      add(contribByFeature, "z_20", revRet * W.reversion * 100);
      add(contribByFeature, "sentiment", sentiment.score * 0.6 * 0.15 * sig * 100);
      add(contribByFeature, "news_mom", sentiment.momentum * 0.4 * 0.15 * sig * 100);
      add(contribByFeature, "_pattern", seq.expected * W.sequence * 100);
      if (inp.siteScores.length) add(contribByFeature, "_sites", siteRet * 100);
    }
  }

  const attributions: Attribution[] = [...contribByFeature.entries()]
    .map(([key, c]) => {
      const def = FEATURES.find((f) => f.key === key);
      if (key === "_pattern")
        return { feature: "Pattern analogs", group: "Sequence model", value: analogs, contribution: c, tip: "Similar past price/volume windows (attention-weighted) and what followed them." };
      if (key === "_sites")
        return { feature: "Tracked sites consensus", group: "External", value: site, contribution: c, tip: "Blend of Finviz target-price gap and your Mesarri / InvoApp scores." };
      return { feature: key, group: def?.group ?? "", value: fv[key] ?? 0, contribution: c, tip: def?.tip ?? "" };
    })
    .filter((a) => Math.abs(a.contribution) > 1e-4)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 10);

  const h5 = horizons.find((h) => h.horizon === "5d")!;
  const a = atr(bars, 14);
  const integrity = integrityChecks(d, h5, models, regime, analogs);
  const path = cone(bars[i].t, price, h5.expectedReturn / 100, (h5.bandHigh - h5.bandLow) / 100 / 2.563);
  const changePct = i > 0 ? (price / bars[i - 1].c - 1) * 100 : 0;
  return {
    symbol: d.inst.symbol,
    name: d.inst.name,
    sector: d.inst.sector,
    themes: d.inst.themes,
    price,
    changePct,
    updatedAt: Date.now(),
    regime,
    horizons,
    attributions,
    integrity,
    modelVotes: votes5d,
    sentiment,
    poker: pokerRead(h5.probUp, h5.expectedReturn / 100, a / price, h5.confidence),
    catalysts: inp.catalysts,
    sources: inp.sources,
    path,
  };
}

function add(m: Map<string, number>, k: string, v: number) {
  m.set(k, (m.get(k) ?? 0) + v);
}

function rationale(label: string, comps: { model: string; r: number; w: number }[], blended: number, regime: Regime, s: SentimentSummary) {
  const lead = [...comps].sort((a, b) => Math.abs(b.r * b.w) - Math.abs(a.r * a.w))[0];
  const dir = blended > 0 ? "upside" : "downside";
  const conflict = comps.some((c) => Math.sign(c.r) !== Math.sign(blended) && Math.abs(c.r * c.w) > Math.abs(blended) * 0.5);
  const news = Math.abs(s.score) > 0.2 ? ` News tone is ${s.score > 0 ? "supportive" : "negative"}${Math.abs(s.momentum) > 0.2 ? " and shifting fast" : ""}.` : "";
  return `${label}: ${lead.model.toLowerCase()} leads toward ${dir} in a ${regime.label} regime.${news}${conflict ? " Models disagree — treat as lower conviction." : ""}`;
}

function integrityChecks(d: SymbolData, h5: HorizonForecast, models: TrainedModel[], regime: Regime, analogs: number): IntegrityCheck[] {
  const m5 = models.find((m) => m.horizon === "5d");
  const earningsSoon = d.fundamentals.nextEarnings && d.fundamentals.nextEarnings - Date.now() < 7 * 86_400_000 && d.fundamentals.nextEarnings > Date.now();
  return [
    { name: "History depth", ok: d.bars.length >= 250, note: `${d.bars.length} daily bars` },
    { name: "Live data", ok: d.live, note: d.live ? "Prices from a live source" : "Simulated prices — connect sources for live data" },
    { name: "Out-of-sample skill", ok: (m5?.oosHitRate ?? 0) > 0.51, note: m5 ? `5d OOS hit rate ${(m5.oosHitRate * 100).toFixed(1)}%, IC ${m5.oosIc.toFixed(3)}` : "Model not trained yet" },
    { name: "Analog coverage", ok: analogs >= 8, note: `${analogs.toFixed(1)} effective analogs` },
    { name: "Band sanity", ok: h5.bandHigh - h5.bandLow < 40, note: `80% band width ${(h5.bandHigh - h5.bandLow).toFixed(1)}%` },
    { name: "Event risk", ok: !earningsSoon, note: earningsSoon ? "Earnings inside the 5-day window — gap risk" : "No scheduled earnings in window" },
    { name: "Liquidity", ok: regime.liquidity !== "thin", note: regime.liquidity === "thin" ? "Thin liquidity — wider slippage" : "Normal" },
  ];
}

function cone(t0: number, p: number, mu5: number, sig5: number) {
  const out = [];
  for (let k = 0; k <= 5; k++) {
    const f = k / 5;
    const mid = p * (1 + mu5 * f);
    const s = sig5 * Math.sqrt(f);
    out.push({ t: t0 + k * 86_400_000, mid, low: p * (1 + mu5 * f - 1.2816 * s), high: p * (1 + mu5 * f + 1.2816 * s) });
  }
  return out;
}
