import { EventEmitter } from "node:events";
import { config } from "../config.ts";
import type { AlertRule, Anomaly, Bar, FeedItem, Forecast, Fundamentals, Instrument, NewsItem, SignalCard, SourceStatus, StrategyConfig } from "../types.ts";
import { MACRO_PROXIES, UNIVERSE, instrument } from "../data/universe.ts";
import { MarketSimulator } from "../data/simulator.ts";
import { FinvizSource, HistorySource, JsonSiteSource, PolygonSource } from "../data/sources.ts";
import { type DeskBrief, MacroDesk, SectorDesk } from "./desks.ts";
import { secHealth } from "../data/news.ts";
import { DEFAULT_TEAM_SETTINGS, TradingTeam, newTeamState } from "../team/team.ts";
import { type MarketContext, computeFeatures } from "../engine/features.ts";
import { type SymbolData, type TrainedModel, forecast, trainModels } from "../engine/ensemble.ts";
import { detectRegime } from "../engine/regime.ts";
import { summarize } from "../engine/sentiment.ts";
import { type SignalRuleStats, toSignal } from "../engine/signals.ts";
import { DEFAULT_RISK, TEMPLATES, backtest } from "../engine/backtest.ts";
import { psychologyGauge } from "../engine/psychology.ts";
import { atr, sma, uid } from "../engine/indicators.ts";
import { AnomalyDetector, calibration, checkMisses } from "../engine/anomaly.ts";
import { DEFAULT_PLAYBOOKS, DEFAULT_PROFILE, store, type Review } from "../store.ts";
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
  polygon = new PolygonSource();
  desks: SectorDesk[] = [];
  macro: MacroDesk;
  historyLoaded = 0;
  team?: TradingTeam;
  private quoteCursor = 0;
  data = new Map<string, SymbolData>();
  news = new Map<string, NewsItem[]>();
  siteScores = new Map<string, { source: string; score: number }[]>();
  forecasts = new Map<string, Forecast>();
  signals = new Map<string, SignalCard>();
  feed: FeedItem[] = [];
  models: TrainedModel[] = [];
  ruleStats: Record<string, SignalRuleStats> = {};
  detector = new AnomalyDetector({ sampleMs: config.anomaly.sampleMs, minHistory: config.anomaly.minHistory });
  anomalies: Anomaly[] = [];
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
    // One desk per GICS sector, plus funds/macro gauges and crypto.
    const groups = new Map<string, Instrument[]>();
    for (const inst of UNIVERSE) {
      const g = inst.assetClass === "crypto" ? "Crypto" : inst.assetClass === "etf" ? "Funds & macro" : inst.sector;
      groups.set(g, [...(groups.get(g) ?? []), inst]);
    }
    this.desks = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([name, members]) => new SectorDesk(name.toLowerCase().replace(/[^a-z]+/g, "-"), name, members, this));
    this.macro = new MacroDesk(UNIVERSE, this);
  }

  get sources(): SourceStatus[] {
    const simStatus = (s: SourceStatus): SourceStatus => (s.status === "disabled" || s.status === "error" ? { ...s, status: s.status === "error" ? "error" : "simulated" } : s);
    const crypto = this.crypto?.publicState().feeds;
    return [
      simStatus(this.finviz.status),
      simStatus(this.mesarri.status),
      simStatus(this.invo.status),
      simStatus(this.history.status),
      this.polygon.enabled() ? this.polygon.status : { ...this.polygon.status, status: "disabled" as const },
      {
        id: "sec",
        name: "SEC EDGAR filings",
        url: "https://www.sec.gov/edgar",
        status: !config.liveData ? ("simulated" as const) : secHealth.lastOk && !secHealth.error ? ("live" as const) : secHealth.error ? ("error" as const) : ("disabled" as const),
        lastOk: secHealth.lastOk,
        note: secHealth.error ?? (secHealth.lastOk ? `filings read for ${secHealth.companies} company checks` : "8-K, 10-Q/10-K, Form 4 and 13D filings for every S&P 500 company — starting up"),
      },
      { id: "macro", name: "Market-wide news feeds", url: "https://www.federalreserve.gov", status: this.macro.status.includes("live") ? ("live" as const) : config.liveData ? ("error" as const) : ("simulated" as const), note: this.macro.status, lastOk: this.macro.lastSweepAt },
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

  // The four-agent paper-trading team. Its books live in the database.
  private startTeam() {
    const saved = store.global.team;
    const state = saved ? { ...saved, settings: { ...DEFAULT_TEAM_SETTINGS, ...saved.settings } } : newTeamState({ marketHoursOnly: config.liveData });
    const agent = this;
    const host = {
      get data() { return agent.data; },
      get forecasts() { return agent.forecasts; },
      get anomalies() { return agent.anomalies; },
      get ctx() { return agent.ctx; },
      liveData: config.liveData,
      push: (item: Omit<FeedItem, "id" | "t">) => agent.push(item),
    };
    this.team = new TradingTeam(state, host, (s) => store.updateGlobal("team", () => s));
  }

  async start() {
    this.startTeam();
    // Start on whatever we have (simulated until real history arrives), so the app is usable
    // immediately; real history streams in behind it and the models retrain once it lands.
    this.refreshContext();
    this.status = "training models";
    this.retrain();
    this.status = "running";
    await this.cycle();
    this.timer = setInterval(() => void this.cycle(), config.agentIntervalMs);
    void this.loadHistory().then((n) => {
      if (n > 0) {
        this.refreshContext();
        this.retrain();
      }
    });
    // Desks tick on staggered timers; the shared per-host limiter keeps the total polite.
    this.desks.forEach((d, i) => setTimeout(() => setInterval(() => void d.tick(), 6000), i * 450));
    const sweepMacro = () => void this.macro.sweep().catch(() => (this.macro.status = "error"));
    setTimeout(sweepMacro, 3000);
    setInterval(sweepMacro, 10 * 60_000);
    setInterval(() => this.retrain(), 6 * 3600_000);
    setTimeout(() => this.computeRuleStats(), 2000);
    this.scheduleReview();
  }

  stop() {
    clearInterval(this.timer);
  }

  // Real daily history for every symbol: Polygon if configured, else Yahoo. Returns how many loaded.
  private async loadHistory(): Promise<number> {
    if (!this.history.enabled() && !this.polygon.enabled()) return 0;
    const queue = [...UNIVERSE];
    let failsInARow = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let inst = queue.shift(); inst; inst = queue.shift()) {
          const crypto = inst.assetClass === "crypto";
          const bars = (!crypto && (await this.polygon.bars(inst.symbol))) || (await this.history.bars(inst.symbol, crypto));
          if (bars) {
            this.data.set(inst.symbol, { ...this.data.get(inst.symbol)!, bars, live: true });
            this.historyLoaded++;
            failsInARow = 0;
          } else if (++failsInARow >= 12 && this.historyLoaded === 0) return; // sources unreachable: stay on the simulator
          this.status = `running · real history ${this.historyLoaded}/${UNIVERSE.length}`;
        }
      }),
    );
    this.status = this.historyLoaded ? `running · real history for ${this.historyLoaded}/${UNIVERSE.length}` : "running (simulated prices)";
    return this.historyLoaded;
  }

  // Live prices: one full-market snapshot with Polygon, otherwise rotating Yahoo batches.
  private async refreshPrices() {
    let prices = new Map<string, number>();
    if (this.polygon.enabled()) prices = await this.polygon.allPrices();
    else if (this.history.enabled()) {
      for (let k = 0; k < 2; k++) {
        const batch = UNIVERSE.slice(this.quoteCursor, this.quoteCursor + 20);
        this.quoteCursor = this.quoteCursor + 20 >= UNIVERSE.length ? 0 : this.quoteCursor + 20;
        for (const [s, p] of await this.history.quotes(batch.map((i) => ({ symbol: i.symbol, crypto: i.assetClass === "crypto" })))) prices.set(s, p);
      }
    }
    const today = new Date().toDateString();
    const weekday = ![0, 6].includes(new Date().getDay());
    for (const [sym, p] of prices) {
      const d = this.data.get(sym);
      if (!d?.live) continue; // only update series that are real history
      const b = d.bars.at(-1)!;
      if (new Date(b.t).toDateString() !== today && weekday && Math.abs(p / b.c - 1) > 1e-6) {
        d.bars.push({ t: Date.now(), o: p, h: p, l: p, c: p, v: 0 }); // first trade of a new session
      } else {
        b.c = p;
        b.h = Math.max(b.h, p);
        b.l = Math.min(b.l, p);
      }
    }
  }

  // DeskHost: desks hand real headlines and filings to the agent.
  mergeNews(symbol: string, items: NewsItem[]) {
    const prev = (this.news.get(symbol) ?? []).filter((n) => n.source !== "simulated");
    const seen = new Set<string>();
    const merged = [...items, ...prev].filter((n) => {
      const h = n.headline.toLowerCase();
      if (seen.has(n.id) || seen.has(h)) return false;
      seen.add(n.id);
      seen.add(h);
      return true;
    });
    this.news.set(symbol, merged.sort((a, b) => b.t - a.t).slice(0, 40));
  }

  recentAnomalies(symbols: Set<string>, sinceMs: number) {
    return this.anomalies.filter((a) => symbols.has(a.symbol) && Date.now() - a.t < sinceMs).length;
  }

  deskBriefs(): (DeskBrief & { macro?: never })[] {
    return this.desks.map((d) => {
      const b = d.brief();
      b.catalysts = d.members
        .flatMap((m) => (this.news.get(m.symbol) ?? []).filter((n) => n.source !== "simulated" && (n.source.startsWith("SEC") || Math.abs(n.sentiment) >= 0.3)))
        .sort((x, y) => y.t - x.t)
        .slice(0, 3)
        .map((n) => ({ symbol: n.symbol, headline: n.headline, source: n.source, url: n.url, t: n.t }));
      return b;
    });
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
    // Keep training affordable as the universe grows (~8k rows per horizon in total).
    this.models = trainModels([...this.data.values()], this.ctx, Math.max(10, Math.min(80, Math.floor(8000 / this.data.size))));
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

  private cycling = false;
  async cycle() {
    // Never overlap: on a slow server a cycle can outlast the interval.
    if (this.cycling) return;
    this.cycling = true;
    try {
      await this.runCycle();
    } finally {
      this.cycling = false;
    }
  }

  private async runCycle() {
    const t0 = Date.now();
    this.sim.tick(this.lastCycle ? t0 - this.lastCycle : config.agentIntervalMs);
    try {
      await this.pullSites();
    } catch {
      /* sources fail soft */
    }
    try {
      await this.refreshPrices();
    } catch {
      /* fail soft */
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
    // Feed signals use a fixed "house" profile; each user's own thresholds and sizing are
    // applied when they view a signal (see personalSignal in server/index.ts).
    const profile = HOUSE_PROFILE;
    let k = 0;
    for (const d of this.data.values()) {
      if (++k % 25 === 0) await new Promise((r) => setImmediate(r)); // keep the server responsive
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
      for (const a of this.detector.observe(f, (atr(d.bars, 14) / f.price) * 100)) this.recordAnomaly(a);
    }
    this.scanAnomalies();
    this.checkAlerts();
    this.updateLedger();
    try {
      this.team?.step();
    } catch (e) {
      console.error("team step failed:", (e as Error).message);
    }
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
    const alreadyOpen = store.global.ledger.some((l) => l.outcome === "open" && l.signal.symbol === sig.symbol && l.signal.side === sig.side);
    if (sig.side !== "hold" && prevSig?.side !== sig.side && !alreadyOpen) {
      this.push({ kind: "signal", symbol: f.symbol, title: `${sig.side.toUpperCase()} ${f.symbol}`, body: `Entry ${fmt(sig.entry)} · stop ${fmt(sig.stop)} · target ${fmt(sig.target)} · ${sig.rule}`, confidence: sig.confidence });
      store.updateGlobal("ledger", (l) => [{ signal: sig, outcome: "open" as const }, ...l].slice(0, 500));
      this.fireSignalAlerts(sig);
    }
    if (Math.sign(prev.sentiment.score) !== Math.sign(f.sentiment.score) && Math.abs(f.sentiment.score) > 0.25) {
      this.push({ kind: "news", symbol: f.symbol, title: `${f.symbol} sentiment flipped ${f.sentiment.score > 0 ? "positive" : "negative"}`, body: `Score ${prev.sentiment.score.toFixed(2)} → ${f.sentiment.score.toFixed(2)}, news momentum ${f.sentiment.momentum.toFixed(2)}.` });
      for (const [uid, u] of store.users)
        for (const a of u.alerts.filter((x) => x.enabled && x.kind === "sentiment-flip" && x.symbol === f.symbol)) this.fire(uid, a, `${f.symbol} sentiment flipped to ${f.sentiment.score.toFixed(2)}`);
    }
  }

  // Cross-symbol anomaly checks: peer outliers, plus the daily forecast log and its misses.
  private scanAnomalies() {
    const groups = new Map<string, Forecast[]>();
    for (const f of this.forecasts.values()) {
      const cls = this.data.get(f.symbol)!.inst.assetClass;
      const name = cls === "crypto" ? "crypto" : cls === "etf" ? "ETFs" : "stocks";
      groups.set(name, [...(groups.get(name) ?? []), f]);
    }
    for (const a of this.detector.peers(groups)) this.recordAnomaly(a);

    let log = store.global.forecastLog ?? [];
    let changed = false;
    for (const f of this.forecasts.values()) {
      const barT = this.data.get(f.symbol)!.bars.at(-1)!.t;
      if (log.some((e) => e.symbol === f.symbol && e.barT === barT)) continue;
      const h = f.horizons.find((x) => x.horizon === "5d")!;
      log.push({ symbol: f.symbol, barT, price: f.price, exp: h.expectedReturn, low: h.bandLow, high: h.bandHigh });
      changed = true;
    }
    const res = checkMisses(log, (s) => this.data.get(s)?.bars);
    if (res.misses.length || changed || res.log.some((e, i) => e !== log[i])) {
      log = res.log.slice(-3000);
      store.updateGlobal("forecastLog", () => log);
    }
    for (const m of res.misses) this.recordAnomaly({ ...m, id: uid("an_") });
  }

  private recordAnomaly(a: Anomaly) {
    this.anomalies = [a, ...this.anomalies].slice(0, 300);
    this.push({ kind: "anomaly", symbol: a.symbol, title: a.title, body: a.detail });
    this.emit("anomaly", a);
  }

  anomalyReport(symbol?: string) {
    const list = symbol ? this.anomalies.filter((a) => a.symbol === symbol.toUpperCase()) : this.anomalies;
    return { anomalies: list.slice(0, 100), calibration: calibration(store.global.forecastLog ?? []) };
  }

  private fireSignalAlerts(sig: SignalCard) {
    for (const [uid, u] of store.users)
      for (const a of u.alerts.filter((x) => x.enabled && x.kind === "signal" && x.symbol === sig.symbol)) this.fire(uid, a, `${sig.side.toUpperCase()} ${sig.symbol} @ ${fmt(sig.entry)} (conf ${sig.confidence})`);
  }

  private checkAlerts() {
    for (const [uid, u] of store.users) this.checkUserAlerts(uid, u.alerts);
  }

  private checkUserAlerts(uid: string, alerts: AlertRule[]) {
    for (const a of alerts) {
      if (!a.enabled) continue;
      const f = this.forecasts.get(a.symbol);
      if (!f) continue;
      const cool = !a.lastFiredAt || Date.now() - a.lastFiredAt > 3600_000;
      if (!cool) continue;
      if (a.kind === "price-above" && a.value !== undefined && f.price >= a.value) this.fire(uid, a, `${a.symbol} crossed above ${fmt(a.value)} (now ${fmt(f.price)})`);
      if (a.kind === "price-below" && a.value !== undefined && f.price <= a.value) this.fire(uid, a, `${a.symbol} fell below ${fmt(a.value)} (now ${fmt(f.price)})`);
      if (a.kind === "pct-move" && a.value !== undefined && Math.abs(f.changePct) >= a.value) this.fire(uid, a, `${a.symbol} moved ${f.changePct.toFixed(2)}% today`);
      if (a.kind === "earnings") {
        const ne = this.data.get(a.symbol)?.fundamentals.nextEarnings;
        if (ne && ne - Date.now() < (a.value ?? 3) * 86_400_000 && ne > Date.now()) this.fire(uid, a, `${a.symbol} reports earnings ${new Date(ne).toDateString()}`);
      }
      if (a.kind === "exit") {
        const led = store.global.ledger.find((l) => l.signal.symbol === a.symbol && l.outcome === "open");
        if (led) {
          const s = led.signal;
          const atrNear = Math.abs(s.entry - s.stop) * 0.25;
          if (s.side === "buy" && f.price - s.stop < atrNear) this.fire(uid, a, `${a.symbol} is near its stop ${fmt(s.stop)} — review exit`);
          if (s.side === "buy" && s.target - f.price < atrNear) this.fire(uid, a, `${a.symbol} is near its target ${fmt(s.target)}`);
        }
      }
    }
  }

  // Alerts are personal: they go only to the user who set them, never into the shared feed.
  private fire(uid: string, a: AlertRule, msg: string) {
    store.updateUser(uid, "alerts", (xs) => xs.map((x) => (x.id === a.id ? { ...x, lastFiredAt: Date.now() } : x)));
    this.emit("alert", { uid, title: `Stockens · ${a.symbol}`, body: msg });
  }

  private updateLedger() {
    store.updateGlobal("ledger", (ledger) =>
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
      if (d.getHours() >= 16 && d.getMinutes() >= 5 && !store.global.reviews.some((r) => r.date === key)) this.runReview();
    };
    setInterval(check, 60_000);
  }

  runReview(): Review {
    const today = new Date().toDateString();
    const recent = store.global.ledger.filter((l) => Date.now() - l.signal.createdAt < 5 * 86_400_000);
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
        ...DEFAULT_PLAYBOOKS.filter((p) => regime.label.includes(p.regime)).map((p) => `Playbook "${p.name}" applies: ${p.steps[0]}`),
      ],
      stats: { signals: recent.length, closed: closed.length, winRate: closed.length ? closed.filter((l) => (l.pnlPct ?? 0) > 0).length / closed.length : 0, avgPnlPct: avg(closed.map((l) => l.pnlPct ?? 0)) },
      byRule,
    };
    store.updateGlobal("reviews", (r) => [review, ...r.filter((x) => x.date !== today)].slice(0, 60));
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
      // Heatmap: the most active 16 names per sector (by news tone + move) keep it phone-friendly.
      heatmap: [...sectors.entries()].map(([sector, list]) => ({
        sector,
        total: list.length,
        items: list
          .map((f) => ({ symbol: f.symbol, changePct: f.changePct, sentiment: f.sentiment.score, newsMomentum: f.sentiment.momentum, newsCount: f.sentiment.count }))
          .sort((a, b) => Math.abs(b.sentiment) + Math.abs(b.changePct) / 3 - (Math.abs(a.sentiment) + Math.abs(a.changePct) / 3))
          .slice(0, 16),
      })),
      desks: this.deskBriefs(),
      macro: { status: this.macro.status, tone: this.macro.tone(), headlines: this.macro.headlines.slice(0, 12) },
      coverage: { symbols: this.data.size, realHistory: this.historyLoaded },
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

const HOUSE_PROFILE = { ...DEFAULT_PROFILE, experience: "intermediate" as const };

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
