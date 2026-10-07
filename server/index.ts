import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.ts";
import { store, type StoreShape } from "./store.ts";
import { Agent } from "./agent/agent.ts";
import { LatencyEngine } from "./crypto/latencyArb.ts";
import { SECTORS, THEMES, UNIVERSE } from "./data/universe.ts";
import { DEFAULT_RISK, MAX_PARAMS, TEMPLATES, backtest } from "./engine/backtest.ts";
import { SCENARIOS, portfolioView, runScenario, sizePosition, stops } from "./engine/risk.ts";
import { atr, uid } from "./engine/indicators.ts";
import { initPush, sendPush, vapidPublicKey } from "./push.ts";
import type { AlertRule, StrategyConfig, Watchlist } from "./types.ts";

const app = express();
app.use(express.json({ limit: "1mb" }));

const crypto = new LatencyEngine();
const agent = new Agent(crypto);
const insts = new Map(UNIVERSE.map((i) => [i.symbol, i]));
initPush();

// ---------------- realtime ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});
const broadcast = (type: string, data: unknown) => {
  const msg = JSON.stringify({ type, data });
  for (const c of clients) if (c.readyState === 1) c.send(msg);
};
agent.on("feed", (item) => broadcast("feed", item));
agent.on("cycle", () => broadcast("cycle", { t: agent.lastCycle }));
agent.on("alert", (a) => {
  broadcast("alert", a);
  void sendPush(a);
});
crypto.on("state", () => broadcast("crypto", { state: crypto.publicState(), graph: crypto.graph.snapshot }));
crypto.on("trade", (t) => broadcast("crypto-trade", t));
// Preferences sync: any device's change is pushed to every other open device.
store.listeners.add((key) => {
  if (["profile", "watchlists", "alerts", "positions", "strategies", "ideas", "playbooks"].includes(key)) broadcast("sync", { key, value: store.data[key] });
});

// ---------------- API ----------------
const api = express.Router();
const ready = (_req: express.Request, res: express.Response, next: express.NextFunction) => (agent.forecasts.size ? next() : res.status(503).json({ error: "Agent is warming up", status: agent.status }));

api.get("/bootstrap", (_req, res) => {
  res.json({
    profile: store.data.profile,
    watchlists: store.data.watchlists,
    alerts: store.data.alerts,
    positions: store.data.positions,
    strategies: store.data.strategies,
    ideas: store.data.ideas,
    playbooks: store.data.playbooks,
    universe: UNIVERSE,
    themes: THEMES,
    sectors: SECTORS,
    templates: TEMPLATES,
    maxParams: MAX_PARAMS,
    scenarios: SCENARIOS,
    vapidPublicKey: vapidPublicKey(),
    agentStatus: agent.status,
  });
});

api.get("/dashboard", ready, (_req, res) => res.json(agent.dashboard()));

api.get("/forecast/:symbol", ready, (req, res) => {
  const d = agent.detail(String(req.params.symbol));
  if (!d) return res.status(404).json({ error: "Unknown symbol" });
  const a = atr(d.bars, 14);
  res.json({ ...d, stops: stops(d.forecast.price, a, d.signal?.side === "sell" ? "sell" : "buy", store.data.profile.risk) });
});

api.get("/screen", ready, (req, res) => {
  const q = req.query as Record<string, string>;
  const rows = [...agent.forecasts.values()]
    .filter((f) => !q.theme || f.themes.includes(q.theme))
    .filter((f) => !q.sector || f.sector === q.sector)
    .filter((f) => !q.asset || insts.get(f.symbol)?.assetClass === q.asset)
    .filter((f) => !q.minDiv || (agent.data.get(f.symbol)?.fundamentals.dividendYield ?? insts.get(f.symbol)?.dividendYield ?? 0) >= Number(q.minDiv))
    .filter((f) => !q.maxVol || (f.attributions.find((x) => x.feature === "atr_pct")?.value ?? 0) * 100 <= Number(q.maxVol))
    .filter((f) => !q.minConf || f.horizons.find((h) => h.horizon === (q.horizon || "5d"))!.confidence >= Number(q.minConf))
    .filter((f) => !q.maxPe || (agent.data.get(f.symbol)?.fundamentals.pe ?? 0) <= Number(q.maxPe))
    .map((f) => {
      const h = f.horizons.find((x) => x.horizon === (q.horizon || "5d"))!;
      const fund = agent.data.get(f.symbol)?.fundamentals;
      return {
        symbol: f.symbol, name: f.name, sector: f.sector, themes: f.themes, price: f.price, changePct: f.changePct,
        expectedReturn: h.expectedReturn, confidence: h.confidence, probUp: h.probUp, sentiment: f.sentiment.score,
        signal: agent.signals.get(f.symbol)?.side ?? "hold", pe: fund?.pe, dividendYield: fund?.dividendYield ?? insts.get(f.symbol)?.dividendYield,
      };
    })
    .sort((a, b) => b.expectedReturn * b.confidence - a.expectedReturn * a.confidence);
  res.json(rows);
});

api.put("/profile", (req, res) => {
  const body = req.body ?? {};
  store.update("profile", (p) => ({ ...p, ...body, id: p.id, risk: { ...p.risk, ...(body.risk ?? {}) }, notifications: { ...p.notifications, ...(body.notifications ?? {}) }, updatedAt: Date.now() }));
  res.json(store.data.profile);
});

// Generic CRUD for list collections synced across devices.
function crud<T extends { id: string }>(key: "watchlists" | "alerts" | "strategies" | "ideas" | "playbooks", prefix: string, defaults: (b: Partial<T>) => T) {
  api.get(`/${key}`, (_req, res) => res.json(store.data[key]));
  api.post(`/${key}`, (req, res) => {
    const item = defaults({ ...req.body, id: uid(prefix) });
    store.update(key, (xs) => [...(xs as unknown as T[]), item] as unknown as StoreShape[typeof key]);
    res.json(item);
  });
  api.put(`/${key}/:id`, (req, res) => {
    store.update(key, (xs) => (xs as unknown as T[]).map((x) => (x.id === req.params.id ? { ...x, ...req.body, id: x.id } : x)) as unknown as StoreShape[typeof key]);
    res.json((store.data[key] as unknown as T[]).find((x) => x.id === req.params.id));
  });
  api.delete(`/${key}/:id`, (req, res) => {
    store.update(key, (xs) => (xs as unknown as T[]).filter((x) => x.id !== req.params.id) as unknown as StoreShape[typeof key]);
    res.json({ ok: true });
  });
}
crud<Watchlist>("watchlists", "wl_", (b) => ({ id: b.id!, name: b.name ?? "New list", symbols: (b.symbols ?? []).map((s) => s.toUpperCase()), tags: b.tags ?? [], shared: !!b.shared }));
crud<AlertRule>("alerts", "al_", (b) => ({ id: b.id!, symbol: (b.symbol ?? "SPY").toUpperCase(), kind: b.kind ?? "price-above", value: b.value === undefined ? undefined : Number(b.value), enabled: b.enabled ?? true, createdAt: Date.now(), note: b.note }));
crud<StrategyConfig>("strategies", "st_", (b) => ({ id: b.id!, name: b.name ?? "My strategy", template: b.template ?? "trend", params: b.params ?? TEMPLATES[b.template ?? "trend"].params, risk: { ...DEFAULT_RISK, ...(b.risk ?? {}) }, universe: b.universe ?? ["SPY"], createdAt: Date.now() }));
crud<{ id: string; symbol: string; tags: string[]; note: string; author: string; createdAt: number }>("ideas", "id_", (b) => ({ id: b.id!, symbol: (b.symbol ?? "").toUpperCase(), tags: b.tags ?? [], note: b.note ?? "", author: store.data.profile.displayName, createdAt: Date.now() }));
crud<{ id: string; name: string; regime: string; steps: string[]; shared: boolean }>("playbooks", "pb_", (b) => ({ id: b.id!, name: b.name ?? "Playbook", regime: b.regime ?? "normal", steps: b.steps ?? [], shared: b.shared ?? true }));

api.put("/positions", (req, res) => {
  store.update("positions", () => (req.body as { symbol: string; qty: number; avgPrice: number }[]).map((p) => ({ symbol: p.symbol.toUpperCase(), qty: Number(p.qty), avgPrice: Number(p.avgPrice) })));
  res.json(store.data.positions);
});

api.post("/backtest", ready, (req, res) => {
  try {
    const b = req.body as Partial<StrategyConfig> & { costBps?: number };
    const s: StrategyConfig = {
      id: b.id ?? "adhoc",
      name: b.name ?? "Ad-hoc",
      template: b.template ?? "trend",
      params: b.params ?? TEMPLATES[b.template ?? "trend"].params,
      risk: { ...DEFAULT_RISK, ...(b.risk ?? {}) },
      universe: (b.universe?.length ? b.universe : ["SPY", "QQQ", "NVDA", "MSFT", "AAPL", "AMZN"]).map((x) => x.toUpperCase()),
      createdAt: Date.now(),
    };
    res.json(backtest(s, agent.barsMap(), agent.ctx, agent.data.get("SPY")!.bars, b.costBps ?? 5));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

api.post("/risk/size", (req, res) => {
  const { entry, stop, confidence = 60, symbol } = req.body ?? {};
  const bars = symbol ? agent.data.get(String(symbol).toUpperCase())?.bars : undefined;
  const a = bars ? atr(bars, 14) : Math.abs(entry - stop) / 2;
  res.json(sizePosition({ entry: Number(entry), stop: Number(stop), confidence: Number(confidence), edge: 0, atrPct: a / Number(entry), risk: store.data.profile.risk, novice: store.data.profile.experience === "novice" }));
});

api.get("/risk/portfolio", ready, (_req, res) => {
  const pv = portfolioView(store.data.positions, agent.barsMap(), insts, store.data.profile.risk);
  const rows = store.data.positions.map((p) => {
    const f = agent.forecasts.get(p.symbol);
    return { ...p, price: f?.price ?? 0, pnlPct: f ? (f.price / p.avgPrice - 1) * 100 : 0, value: (f?.price ?? 0) * p.qty, signal: agent.signals.get(p.symbol)?.side ?? "hold" };
  });
  res.json({ ...pv, rows, scenarios: SCENARIOS.map((s) => runScenario(store.data.positions, agent.barsMap(), insts, s)) });
});

api.get("/review", (_req, res) => res.json(store.data.reviews));
api.post("/review/run", ready, (_req, res) => res.json(agent.runReview()));
api.get("/ledger", (_req, res) => res.json(store.data.ledger.slice(0, 200)));

// Exports for brokers / research teams.
api.get("/export/signals.:fmt", ready, (req, res) => {
  const sigs = [...agent.signals.values()].filter((s) => s.side !== "hold");
  if (req.params.fmt === "json") return res.json(sigs);
  const head = "symbol,side,entry,stop,target,shares,confidence,holding_days,rule,created_at";
  const lines = sigs.map((s) => [s.symbol, s.side, s.entry.toFixed(4), s.stop.toFixed(4), s.target.toFixed(4), s.sizing.shares, s.confidence, s.holdingDays, s.rule, new Date(s.createdAt).toISOString()].join(","));
  res.type("text/csv").attachment("stockens-signals.csv").send([head, ...lines].join("\n"));
});
api.get("/export/report", ready, (_req, res) => {
  const d = agent.dashboard();
  res.json({ generatedAt: new Date().toISOString(), regime: d.regime, psychology: d.psychology, topBuys: d.topBuys.map((x) => x.signal), topSells: d.topSells.map((x) => x.signal), watchlists: store.data.watchlists, ideas: store.data.ideas, playbooks: store.data.playbooks });
});

api.post("/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: "bad subscription" });
  store.update("pushSubs", (s) => [...s.filter((x) => (x as { endpoint: string }).endpoint !== sub.endpoint), sub]);
  res.json({ ok: true });
});
api.post("/push/test", async (_req, res) => {
  await sendPush({ title: "Stockens", body: "Push alerts are working ✅" });
  res.json({ ok: true, subscribers: store.data.pushSubs.length });
});

// Crypto latency engine
api.get("/crypto", (_req, res) => res.json({ state: crypto.publicState(), graph: crypto.graph.snapshot, config: crypto.cfg, klines: crypto.feed.klines5m.slice(-120) }));
api.put("/crypto/config", (req, res) => {
  const allowed = ["perTradeRiskPct", "dailyLossCapPct", "hardStopPct", "lagTriggerPct", "takeProfitMinPct", "takeProfitMaxPct", "minEdge", "minDepthUsd", "maxOrdersPerSec"] as const;
  for (const k of allowed) if (typeof req.body?.[k] === "number") crypto.cfg[k] = req.body[k];
  res.json(crypto.cfg);
});
api.post("/crypto/tradingview", (req, res) => res.status(crypto.tv.accept(req.body) ? 200 : 401).json({ ok: true }));

api.get("/status", (_req, res) => res.json({ agent: agent.status, lastCycle: agent.lastCycle, cycleMs: agent.cycleMs, sources: agent.sources }));

app.use("/api", api);

// Serve the built PWA in production.
const dist = path.resolve(process.cwd(), "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Stockens server on http://localhost:${config.port}  (LIVE_DATA=${config.liveData})`);
});

void crypto.start();
agent.start().catch((e) => {
  agent.status = `error: ${(e as Error).message}`;
  console.error(e);
});
