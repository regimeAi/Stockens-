import { EventEmitter } from "node:events";
import { config } from "../config.ts";
import type { AlertRule, Bar, FeedItem, Forecast, Fundamentals, NewsItem, SignalCard, SourceStatus, StrategyConfig } from "../types.ts";
import { MACRO_PROXIES, UNIVERSE, instrument } from "../data/universe.ts";
import { MarketSimulator } from "../data/simulator.ts";
import { FinvizSource, HistorySource, JsonSiteSource } from "../data/sources.ts";
import { type MarketContext, computeFeatures } from "../engine/features.ts";
import { type SymbolData, type TrainedModel, forecast, trainModels } from "../engine/ensemble.ts";
import { detectRegime } from "../engine/regime.ts";
import { summarize } from "../engine/sentiment.ts";
import { type SignalRuleStats, toSignal } from "../engine/signals.ts";
import { DEFAULT_RISK, TEMPLATES, backtest } from "../engine/backtest.ts";
import { psychologyGauge } from "../engine/psychology.ts";
import { sma, uid } from "../engine/indicators.ts";
import { store, type Review } from "../store.ts";
import type { LatencyEngine } from "../crypto/latencyArb.ts";

// The background agent. It has no UI of its own: it quietly pulls from Finviz,
// Mesarri and InvoApp (plus history and crypto feeds), retrains the ensemble, refreshes
// forecasts, turns them into signals, fires alerts and writes the end-of-day review.
// The web app only ever reads what it publishes.

export class Agent extends EventEmitter {
  sim = new MarketSimulator(UNIVERSE);
  finviz = new FinvizSource();
  mesarri = new JsonSiteSource("mesarri", "Mesarri (Blockworth)", "https://mesarri.io", config.mesarri);
  invo = new JsonSiteSource("invo", "InvoApp", "https://app.invoapp.com", config.invo);
  history = new HistorySource();
  data = new Map<string, SymbolData>();
  news = new Map<string, NewsItem[]>();
  siteScores = new Map<string, { source: string; score: number }[]>();
  forecasts = new Map<string, Forecast>();
  signals = new Map<string, SignalCard>();
  feed: FeedItem[] = [];
  models: TrainedModel[] = [];
  ruleStats: Record<string, SignalRuleStats> = {};
  ctx: MarketContext = { breadth: 0.5, rates: 0, dollar: 0, commodities: 0, medianEarningsYield: 0.04 };
  lastCycle = 0;
  cycleMs = 0;
  status = "starting";
  private timer?: NodeJS.Timeout;
  private lastRegimeLabel = "";
  private scanIndex = 0;

  constructor(private crypto?: LatencyEngine) {
    super();
    for (const inst of UNIVERSE) {
      const s = this.sim.get(inst.symbol)!;
      this.data.set(inst.symbol, { inst, bars: s.bars, fundamentals: s.fundamentals, live: false });
    }
  }

  get sources(): SourceStatus[] {
    const simStatus = (s: SourceStatus): SourceStatus => (s.status === "disabled" || s.status === "error" ? { ...s, status: s.status === "error" ? "error" : "simulated" } : s);
    const crypto = this.crypto?.publicState().feeds;
    return [
      simStatus(this.finviz.status),
      simStatus(this.mesarri.status),
      simStatus(this.invo.status),
      simStatus(this.history.status),
      ...(crypto
        ? [
            { id: "binance", name: "Binance WebSocket", url: "https://binance.com", status: crypto.binance === "live" ? "live" : "simulated", note: crypto.binance } as SourceStatus,
            { id: "polymarket", name: "Polymarket CLOB", url: "https://polymarket.com", status: crypto.polymarket.startsWith("live") ? "live" : "simulated", note: crypto.polymarket } as SourceStatus,
            { id: "tradingview", name: "TradingView webhooks", url: "https://tradingview.com", status: crypto.tradingview === "live" ? "live" : "disabled", note: crypto.tradingview } as SourceStatus,
            { id: "cryptoquant", name: "CryptoQuant flows", url: "https://cryptoquant.com", status: crypto.cryptoquant === "live" ? "live" : "simulated", note: crypto.cryptoquant } as SourceStatus,
          ]
        : []),
    ];
  }

  async start() {
    this.status = "loading history";
    await this.loadHistory();
    this.refreshContext();
    this.status = "training models";
    this.retrain();
    this.status = "running";
    await this.cycle();
    this.timer = setInterval(() => void this.cycle(), config.agentIntervalMs);
    setInterval(() => this.retrain(), 6 * 3600_000);
    setTimeout(() => this.computeRuleStats(), 2000);
    this.scheduleReview();
  }

  stop() {
    clearInterval(this.timer);
  }

  private async loadHistory() {
    if (!this.history.enabled()) return;
    const queue = [...UNIVERSE];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let inst = queue.shift(); inst; inst = queue.shift()) {
          const bars = await this.history.bars(inst.symbol, inst.assetClass === "crypto");
          if (bars) this.data.set(inst.symbol, { ...this.data.get(inst.symbol)!, bars, live: true });
          else if (this.history.status.status === "error" && queue.length > UNIVERSE.length - 6) return; // offline: stop early
        }
      }),
    );
  }

  private refreshContext() {
    const ret20 = (s: string) => {
      const b = this.data.get(s)?.bars ?? [];
      return b.length > 21 ? b.at(-1)!.c / b.at(-21)!.c - 1 : 0;
    };
    const eqs = [...this.data.values()].filter((d) => d.inst.assetClass !== "crypto" && !MACRO_PROXIES.includes(d.inst.symbol));
    const above = eqs.filter((d) => d.bars.at(-1)!.c > sma(d.bars.map((b) => b.c), 50)).length;
    const eys = eqs.map((d) => (d.fundamentals.pe ? 1 / d.fundamentals.pe : 0)).filter(Boolean).sort((a, b) => a - b);
    this.ctx = {
      breadth: eqs.length ? above / eqs.length : 0.5,
      rates: ret20("TLT"),
      dollar: ret20("UUP"),
      commodities: (ret20("USO") + ret20("GLD")) / 2,
      medianEarningsYield: eys[Math.floor(eys.length / 2)] ?? 0.04,
    };
  }

  retrain() {
    const t0 = Date.now();
    this.models = trainModels([...this.data.values()], this.ctx, 80);
    this.push({ kind: "regime", title: "Models retrained", body: this.models.map((m) => `${m.horizon}: OOS hit ${(m.oosHitRate * 100).toFixed(0)}%`).join(" · ") + ` (${((Date.now() - t0) / 1000).toFixed(1)}s)` });
  }

  private computeRuleStats() {
    const bars = new Map([...this.data.entries()].map(([k, v]) => [k, v.bars]));
    const universe = UNIVERSE.filter((i) => i.assetClass !== "crypto").slice(0, 16).map((i) => i.symbol);
    for (const [template, t] of Object.entries(TEMPLATES)) {
      try {
        const s: StrategyConfig = { id: template, name: t.label, template: template as StrategyConfig["template"], params: t.params, risk: DEFAULT_RISK, universe, createdAt: Date.now() };
        const r = backtest(s, bars, this.ctx, this.data.get("SPY")!.bars, 5, 3);
        this.ruleStats[template] = { hitRate: r.outOfSample.hitRate, payoff: r.outOfSample.payoff, sharpe: r.outOfSample.sharpe, trades: r.outOfSample.trades };
      } catch {
        /* skip */
      }
    }
  }

  private async pullSites() {
    // Rotate through the universe so we stay well inside every site's rate limits.
    const batch = UNIVERSE.filter((i) => i.assetClass !== "crypto").slice(this.scanIndex, this.scanIndex + 4);
    this.scanIndex = (this.scanIndex + 4) % UNIVERSE.length;
    await Promise.all(
      batch.map(async (inst) => {
        const scores: { source: string; score: number }[] = [];
        const extraNews: NewsItem[] = [];
        for (const src of [this.finviz, this.mesarri, this.invo]) {
          const snap = await src.snapshot(inst.symbol);
          if (!snap) continue;
          if (snap.score !== undefined) scores.push({ source: src.status.name, score: snap.score });
          if (snap.news) extraNews.push(...snap.news);
          const d = this.data.get(inst.symbol)!;
          if (snap.fundamentals) d.fundamentals = { ...d.fundamentals, ...defined(snap.fundamentals) };
          if (snap.price && src === this.finviz) {
            const b = d.bars.at(-1)!;
            b.c = snap.price;
            b.h = Math.max(b.h, snap.price);
            b.l = Math.min(b.l, snap.price);
            d.live = true;
          }
        }
        if (scores.length) this.siteScores.set(inst.symbol, scores);
        if (extraNews.length) this.news.set(inst.symbol, dedupe([...extraNews, ...(this.news.get(inst.symbol) ?? [])]).slice(0, 30));
      }),
    );
  }

  private applyCryptoPrices() {
    const prices = this.crypto?.feed.prices ?? {};
    for (const [coin, p] of Object.entries(prices)) {
      const d = this.data.get(coin);
      if (!d || !p) continue;
      const b = d.bars.at(-1)!;
      b.c = p;
      b.h = Math.max(b.h, p);
      b.l = Math.min(b.l, p);
      d.live = d.live || this.crypto?.feed.status === "live";
    }
  }

  async cycle() {
    const t0 = Date.now();
    this.sim.tick(this.lastCycle ? t0 - this.lastCycle : config.agentIntervalMs);
    try {
      await this.pullSites();
    } catch {
      /* sources fail soft */
    }
    this.applyCryptoPrices();
    this.refreshContext();
    const spy = this.data.get("SPY")!.bars;
    const btc = this.data.get("BTC")!.bars;
    const eqRegime = detectRegime(spy);
    const cxRegime = detectRegime(btc);
    if (eqRegime.label !== this.lastRegimeLabel) {
      if (this.lastRegimeLabel) this.push({ kind: "regime", title: `Regime shift: ${eqRegime.label}`, body: `Ensemble re-weighted → trees ${eqRegime.weights.gbt}, sequence ${eqRegime.weights.sequence}, trend ${eqRegime.weights.trend}, reversion ${eqRegime.weights.reversion}.` });
      this.lastRegimeLabel = eqRegime.label;
    }
    const profile = store.data.profile;
    for (const d of this.data.values()) {
      const sym = d.inst.symbol;
      if (!this.news.has(sym) || this.news.get(sym)!.every((n) => n.source === "simulated")) this.news.set(sym, this.sim.news(sym));
      const news = this.news.get(sym)!;
      const prev = this.forecasts.get(sym);
      const f = forecast({
        d,
        ctx: this.ctx,
        regime: d.inst.assetClass === "crypto" ? cxRegime : eqRegime,
        models: this.models,
        sentiment: summarize(news),
        siteScores: this.siteScores.get(sym) ?? [],
        catalysts: catalysts(d.fundamentals, news),
        sources: [d.live ? "live prices" : "simulated prices", ...(this.siteScores.get(sym)?.map((s) => s.source) ?? [])],
      });
      this.forecasts.set(sym, f);
      const sig = toSignal(f, d.bars, profile, this.ruleStats);
      const prevSig = this.signals.get(sym);
      this.signals.set(sym, sig);
      this.diff(prev, f, prevSig, sig);
    }
    this.checkAlerts();
    this.updateLedger();
    this.lastCycle = Date.now();
    this.cycleMs = this.lastCycle - t0;
    this.emit("cycle");
  }

  private diff(prev: Forecast | undefined, f: Forecast, prevSig: SignalCard | undefined, sig: SignalCard) {
    if (!prev) return;
    const a = prev.horizons.find((h) => h.horizon === "5d")!;
    const b = f.horizons.find((h) => h.horizon === "5d")!;
    if (b.confidence - a.confidence >= 8 && b.expectedReturn > 0)
      this.push({ kind: "upgrade", symbol: f.symbol, title: `${f.symbol} forecast upgraded`, body: `5-day ${b.expectedReturn.toFixed(2)}% (was ${a.expectedReturn.toFixed(2)}%), confidence ${b.confidence}.`, confidence: b.confidence });
    if (a.confidence - b.confidence >= 8 && a.expectedReturn > 0)
      this.push({ kind: "downgrade", symbol: f.symbol, title: `${f.symbol} forecast downgraded`, body: `Confidence ${a.confidence} → ${b.confidence}.`, confidence: b.confidence });
    const alreadyOpen = store.data.ledger.some((l) => l.outcome === "open" && l.signal.symbol === sig.symbol && l.signal.side === sig.side);
    if (sig.side !== "hold" && prevSig?.side !== sig.side && !alreadyOpen) {
      this.push({ kind: "signal", symbol: f.symbol, title: `${sig.side.toUpperCase()} ${f.symbol}`, body: `Entry ${fmt(sig.entry)} · stop ${fmt(sig.stop)} · target ${fmt(sig.target)} · ${sig.rule}`, confidence: sig.confidence });
      store.update("ledger", (l) => [{ signal: sig, outcome: "open" as const }, ...l].slice(0, 500));
      this.fireSignalAlerts(sig);
    }
    if (Math.sign(prev.sentiment.score) !== Math.sign(f.sentiment.score) && Math.abs(f.sentiment.score) > 0.25) {
      this.push({ kind: "news", symbol: f.symbol, title: `${f.symbol} sentiment flipped ${f.sentiment.score > 0 ? "positive" : "negative"}`, body: `Score ${prev.sentiment.score.toFixed(2)} → ${f.sentiment.score.toFixed(2)}, news momentum ${f.sentiment.momentum.toFixed(2)}.` });
      for (const a of store.data.alerts.filter((x) => x.enabled && x.kind === "sentiment-flip" && x.symbol === f.symbol)) this.fire(a, `${f.symbol} sentiment flipped to ${f.sentiment.score.toFixed(2)}`);
    }
  }

  private fireSignalAlerts(sig: SignalCard) {
    for (const a of store.data.alerts.filter((x) => x.enabled && x.kind === "signal" && x.symbol === sig.symbol)) this.fire(a, `${sig.side.toUpperCase()} ${sig.symbol} @ ${fmt(sig.entry)} (conf ${sig.confidence})`);
  }

  private checkAlerts() {
    for (const a of store.data.alerts) {
      if (!a.enabled) continue;
      const f = this.forecasts.get(a.symbol);
      if (!f) continue;
      const cool = !a.lastFiredAt || Date.now() - a.lastFiredAt > 3600_000;
      if (!cool) continue;
      if (a.kind === "price-above" && a.value !== undefined && f.price >= a.value) this.fire(a, `${a.symbol} crossed above ${fmt(a.value)} (now ${fmt(f.price)})`);
      if (a.kind === "price-below" && a.value !== undefined && f.price <= a.value) this.fire(a, `${a.symbol} fell below ${fmt(a.value)} (now ${fmt(f.price)})`);
      if (a.kind === "pct-move" && a.value !== undefined && Math.abs(f.changePct) >= a.value) this.fire(a, `${a.symbol} moved ${f.changePct.toFixed(2)}% today`);
      if (a.kind === "earnings") {
        const ne = this.data.get(a.symbol)?.fundamentals.nextEarnings;
        if (ne && ne - Date.now() < (a.value ?? 3) * 86_400_000 && ne > Date.now()) this.fire(a, `${a.symbol} reports earnings ${new Date(ne).toDateString()}`);
      }
      if (a.kind === "exit") {
        const led = store.data.ledger.find((l) => l.signal.symbol === a.symbol && l.outcome === "open");
        if (led) {
          const s = led.signal;
          const atrNear = Math.abs(s.entry - s.stop) * 0.25;
          if (s.side === "buy" && f.price - s.stop < atrNear) this.fire(a, `${a.symbol} is near its stop ${fmt(s.stop)} — review exit`);
          if (s.side === "buy" && s.target - f.price < atrNear) this.fire(a, `${a.symbol} is near its target ${fmt(s.target)}`);
        }
      }
    }
  }

  private fire(a: AlertRule, msg: string) {
    store.update("alerts", (xs) => xs.map((x) => (x.id === a.id ? { ...x, lastFiredAt: Date.now() } : x)));
    this.push({ kind: "alert", symbol: a.symbol, title: "Alert", body: msg });
    this.emit("alert", { title: `Stockens · ${a.symbol}`, body: msg });
  }

  private updateLedger() {
    store.update("ledger", (ledger) =>
      ledger.map((l) => {
        if (l.outcome !== "open") return l;
        const f = this.forecasts.get(l.signal.symbol);
        if (!f) return l;
        const s = l.signal;
        const long = s.side === "buy";
        const pnlPct = ((f.price / s.entry - 1) * 100) * (long ? 1 : -1);
        const days = (Date.now() - s.createdAt) / 86_400_000;
        const hitStop = long ? f.price <= s.stop : f.price >= s.stop;
        const hitTarget = long ? f.price >= s.target : f.price <= s.target;
        const outcome = hitTarget ? "target" : hitStop ? "stop" : days > s.holdingDays * 1.4 ? "time" : "open";
        return { ...l, pnlPct, outcome, ...(outcome !== "open" ? { closedAt: Date.now(), exit: f.price } : {}) };
      }),
    );
  }

  private scheduleReview() {
    const check = () => {
      const d = new Date();
      const key = d.toDateString();
      if (d.getHours() >= 16 && d.getMinutes() >= 5 && !store.data.reviews.some((r) => r.date === key)) this.runReview();
    };
    setInterval(check, 60_000);
  }

  runReview(): Review {
    const today = new Date().toDateString();
    const recent = store.data.ledger.filter((l) => Date.now() - l.signal.createdAt < 5 * 86_400_000);
    const closed = recent.filter((l) => l.outcome !== "open");
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const byRuleMap = new Map<string, number[]>();
    for (const l of recent) byRuleMap.set(l.signal.rule, [...(byRuleMap.get(l.signal.rule) ?? []), l.pnlPct ?? 0]);
    const byRule = [...byRuleMap.entries()].map(([rule, xs]) => ({ rule, n: xs.length, avgPnlPct: avg(xs) })).sort((a, b) => b.avgPnlPct - a.avgPnlPct);
    const regime = detectRegime(this.data.get("SPY")!.bars);
    const fcs = [...this.forecasts.values()];
    const best = [...recent].sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0));
    const review: Review = {
      t: Date.now(),
      date: today,
      summary: `${recent.length} signals in the last 5 days, ${closed.length} closed. Regime: ${regime.label}.`,
      worked: [
        ...byRule.filter((r) => r.avgPnlPct > 0).map((r) => `${r.rule}: ${r.n} signals, avg ${r.avgPnlPct.toFixed(2)}%`),
        ...best.slice(0, 3).filter((l) => (l.pnlPct ?? 0) > 0).map((l) => `${l.signal.side.toUpperCase()} ${l.signal.symbol} ${(l.pnlPct ?? 0).toFixed(2)}%`),
      ],
      didnt: [
        ...byRule.filter((r) => r.avgPnlPct <= 0).map((r) => `${r.rule}: ${r.n} signals, avg ${r.avgPnlPct.toFixed(2)}%`),
        ...best.slice(-3).filter((l) => (l.pnlPct ?? 0) < 0).map((l) => `${l.signal.side.toUpperCase()} ${l.signal.symbol} ${(l.pnlPct ?? 0).toFixed(2)}% (${l.outcome})`),
      ],
      regimeNotes: [
        `Ensemble weights now: trees ${regime.weights.gbt}, sequence ${regime.weights.sequence}, trend ${regime.weights.trend}, reversion ${regime.weights.reversion}.`,
        `Breadth ${(this.ctx.breadth * 100).toFixed(0)}%, rates 20d ${(this.ctx.rates * 100).toFixed(1)}%, dollar 20d ${(this.ctx.dollar * 100).toFixed(1)}%.`,
        psychologyGauge(fcs, this.ctx.breadth, avgVolRatio(fcs)).crowd[0],
        ...store.data.playbooks.filter((p) => regime.label.includes(p.regime)).map((p) => `Playbook "${p.name}" applies: ${p.steps[0]}`),
      ],
      stats: { signals: recent.length, closed: closed.length, winRate: closed.length ? closed.filter((l) => (l.pnlPct ?? 0) > 0).length / closed.length : 0, avgPnlPct: avg(closed.map((l) => l.pnlPct ?? 0)) },
      byRule,
    };
    store.update("reviews", (r) => [review, ...r.filter((x) => x.date !== today)].slice(0, 60));
    this.push({ kind: "regime", title: "End-of-day review ready", body: review.summary });
    return review;
  }

  push(item: Omit<FeedItem, "id" | "t">) {
    const full = { ...item, id: uid("f_"), t: Date.now() };
    this.feed = [full, ...this.feed].slice(0, 300);
    this.emit("feed", full);
  }

  // ---------- read models for the API ----------
  barsMap(): Map<string, Bar[]> {
    return new Map([...this.data.entries()].map(([k, v]) => [k, v.bars]));
  }

  dashboard() {
    const fcs = [...this.forecasts.values()];
    const h5 = (f: Forecast) => f.horizons.find((h) => h.horizon === "5d")!;
    const score = (f: Forecast) => h5(f).expectedReturn * (h5(f).confidence / 100);
    // Best buy/sell leans over the 5-day horizon. Actionable signals rank first; names that
    // lean the right way but fail the profile's thresholds are shown as "watch".
    const rank = (side: "buy" | "sell") =>
      fcs
        .filter((f) => (side === "buy" ? h5(f).expectedReturn > 0 : h5(f).expectedReturn < 0))
        .map((f) => ({ signal: this.signals.get(f.symbol)!, forecast: f, actionable: this.signals.get(f.symbol)?.side === side }))
        .sort((a, b) => Number(b.actionable) - Number(a.actionable) || Math.abs(score(b.forecast)) - Math.abs(score(a.forecast)))
        .slice(0, 8);
    const sectors = new Map<string, Forecast[]>();
    for (const f of fcs) sectors.set(f.sector, [...(sectors.get(f.sector) ?? []), f]);
    const regime = detectRegime(this.data.get("SPY")!.bars);
    return {
      updatedAt: this.lastCycle,
      agent: { status: this.status, cycleMs: this.cycleMs, models: this.models.map((m) => ({ horizon: m.horizon, samples: m.samples, oosHitRate: m.oosHitRate, oosIc: m.oosIc, trainedAt: m.trainedAt })) },
      regime,
      psychology: psychologyGauge(fcs, this.ctx.breadth, avgVolRatio(fcs)),
      topBuys: rank("buy"),
      topSells: rank("sell"),
      upgrades: fcs
        .map((f) => ({ symbol: f.symbol, name: f.name, score: score(f), h5: h5(f), price: f.price, changePct: f.changePct }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8),
      heatmap: [...sectors.entries()].map(([sector, list]) => ({
        sector,
        items: list.map((f) => ({ symbol: f.symbol, changePct: f.changePct, sentiment: f.sentiment.score, newsMomentum: f.sentiment.momentum, newsCount: f.sentiment.count })),
      })),
      feed: this.feed.slice(0, 60),
      sources: this.sources,
    };
  }

  detail(symbol: string) {
    const sym = symbol.toUpperCase();
    const f = this.forecasts.get(sym);
    const d = this.data.get(sym);
    if (!f || !d) return undefined;
    const fv = computeFeatures(d.bars, d.bars.length - 1, d.fundamentals, this.ctx);
    return {
      forecast: f,
      signal: this.signals.get(sym),
      bars: d.bars.slice(-180),
      news: this.news.get(sym) ?? [],
      fundamentals: d.fundamentals,
      features: fv,
      instrument: instrument(sym),
    };
  }
}

function avgVolRatio(fcs: Forecast[]) {
  const xs = fcs.map((f) => f.attributions.find((a) => a.feature === "vol_ratio")?.value ?? 0);
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function catalysts(f: Fundamentals, news: NewsItem[]): string[] {
  const out: string[] = [];
  if (f.nextEarnings && f.nextEarnings > Date.now()) out.push(`Earnings ${new Date(f.nextEarnings).toLocaleDateString()}`);
  if (f.epsRevision && Math.abs(f.epsRevision) > 3) out.push(`EPS estimates ${f.epsRevision > 0 ? "up" : "down"} ${Math.abs(f.epsRevision).toFixed(1)}% (30d)`);
  if (f.epsSurprise && Math.abs(f.epsSurprise) > 5) out.push(`Last quarter surprise ${f.epsSurprise.toFixed(1)}%`);
  for (const n of news.filter((x) => Math.abs(x.sentiment) > 0.4).slice(0, 2)) out.push(n.headline);
  return out;
}

const fmt = (x: number) => (x >= 1 ? x.toFixed(2) : x.toPrecision(3));
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !Number.isNaN(v))) as Partial<T>;
const dedupe = (xs: NewsItem[]) => xs.filter((n, i) => xs.findIndex((m) => m.headline === n.headline) === i);
