import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.ts";
import { store, type UserData } from "./store.ts";
import { Agent } from "./agent/agent.ts";
import { LatencyEngine } from "./crypto/latencyArb.ts";
import { SECTORS, THEMES, UNIVERSE } from "./data/universe.ts";
import { DEFAULT_RISK, MAX_PARAMS, TEMPLATES, backtest } from "./engine/backtest.ts";
import { SCENARIOS, portfolioView, runScenario, sizePosition, stops } from "./engine/risk.ts";
import { atr, uid } from "./engine/indicators.ts";
import { initPush, sendPush, vapidPublicKey } from "./push.ts";
import type { AlertRule, Anomaly, SignalCard, StrategyConfig, Watchlist } from "./types.ts";
import { accountFor, authMode, authRoutes, hasAccess, requireAccess, stripeWebhook } from "./auth.ts";
import { toSignal } from "./engine/signals.ts";

const app = express();
// Behind a hosting proxy (Render, Fly, etc.) so req.secure / req.ip reflect the real client.
app.set("trust proxy", 1);
app.disable("x-powered-by");
// Stripe needs the exact raw body to check the webhook signature.
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), stripeWebhook);
app.use(express.json({ limit: "1mb" }));

const crypto = new LatencyEngine();
const agent = new Agent(crypto);
const insts = new Map(UNIVERSE.map((i) => [i.symbol, i]));

// ---------------- realtime ----------------
const server = http.createServer(app);
// The live socket carries the same data as the API, so it needs a valid session too.
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }: { req: http.IncomingMessage }) => hasAccess(accountFor(req)) });
const clients = new Map<WebSocket, string>(); // socket → account id
wss.on("connection", (ws, req) => {
  clients.set(ws, accountFor(req)!.id);
  ws.on("close", () => clients.delete(ws));
});
const broadcast = (type: string, data: unknown) => {
  const msg = JSON.stringify({ type, data });
  for (const c of clients.keys()) if (c.readyState === 1) c.send(msg);
};
const sendTo = (uid: string, type: string, data: unknown) => {
  const msg = JSON.stringify({ type, data });
  for (const [c, id] of clients) if (id === uid && c.readyState === 1) c.send(msg);
};
agent.on("feed", (item) => broadcast("feed", item));
agent.on("cycle", () => broadcast("cycle", { t: agent.lastCycle }));
agent.on("alert", ({ uid, title, body }: { uid: string; title: string; body: string }) => {
  sendTo(uid, "alert", { title, body });
  void sendPush(uid, { title, body });
});
// Forecast anomalies → each user who opted in, filtered by their scope and minimum severity,
// capped at 6 per hour per user so a volatile day can't flood their phone.
const anomalyQuota = new Map<string, number[]>();
const SEVERITY = ["", "Notable", "Significant", "Extreme"];
agent.on("anomaly", (a: Anomaly) => {
  for (const [uid, u] of store.users) {
    if (!hasAccess(store.accounts.get(uid))) continue;
    const pref = u.profile.anomalyAlerts ?? { enabled: true, scope: "watchlists", minSeverity: 2 };
    if (!pref.enabled || a.severity < pref.minSeverity) continue;
    const watched = u.watchlists.some((w) => w.symbols.includes(a.symbol)) || u.positions.some((p) => p.symbol === a.symbol);
    if (pref.scope === "watchlists" && !watched) continue;
    const recent = (anomalyQuota.get(uid) ?? []).filter((t) => Date.now() - t < 3600_000);
    if (recent.length >= 6) continue;
    anomalyQuota.set(uid, [...recent, Date.now()]);
    const title = `⚠️ ${SEVERITY[a.severity]} anomaly · ${a.symbol}`;
    sendTo(uid, "alert", { title, body: a.title });
    void sendPush(uid, { title, body: `${a.title}. ${a.detail}`, url: `/#/home/${a.symbol}` });
  }
});
crypto.on("state", () => broadcast("crypto", { state: crypto.publicState(), graph: crypto.graph.snapshot }));
crypto.on("trade", (t) => broadcast("crypto-trade", t));
// Preferences sync: a change on one device is pushed to that user's other open devices.
store.listeners.add((uid, key) => {
  if (key !== "pushSubs") sendTo(uid, "sync", { key, value: store.user(uid)[key] });
});

// ---------------- API ----------------
const api = express.Router();
api.get("/health", (_req, res) => res.json({ ok: true }));
authRoutes(api);
api.use(requireAccess);
const ready = (_req: express.Request, res: express.Response, next: express.NextFunction) => (agent.forecasts.size ? next() : res.status(503).json({ error: "Agent is warming up", status: agent.status }));
// The signed-in user's own data (set by requireAccess).
const me = (res: express.Response): UserData => store.user(res.locals.uid as string);
const update = <K extends keyof UserData>(res: express.Response, key: K, fn: (v: UserData[K]) => UserData[K]) => store.updateUser(res.locals.uid as string, key, fn);
// Signals re-cut with the user's own experience level and risk settings.
function personalSignal(res: express.Response, symbol: string): SignalCard | undefined {
  const f = agent.forecasts.get(symbol);
  const d = agent.data.get(symbol);
  return f && d ? toSignal(f, d.bars, me(res).profile, agent.ruleStats) : undefined;
}

api.get("/bootstrap", (_req, res) => {
  const u = me(res);
  res.json({
    profile: u.profile,
    watchlists: u.watchlists,
    alerts: u.alerts,
    positions: u.positions,
    strategies: u.strategies,
    ideas: u.ideas,
    playbooks: u.playbooks,
    account: { email: store.accounts.get(res.locals.uid)?.email, admin: res.locals.admin, mode: authMode() },
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

api.get("/dashboard", ready, (_req, res) => {
  const d = agent.dashboard();
  const personal = (rows: typeof d.topBuys, side: "buy" | "sell") =>
    rows
      .map((r) => {
        const signal = personalSignal(res, r.forecast.symbol) ?? r.signal;
        return { ...r, signal, actionable: signal.side === side };
      })
      .sort((a, b) => Number(b.actionable) - Number(a.actionable));
  res.json({ ...d, topBuys: personal(d.topBuys, "buy"), topSells: personal(d.topSells, "sell") });
});

api.get("/forecast/:symbol", ready, (req, res) => {
  const d = agent.detail(String(req.params.symbol));
  if (!d) return res.status(404).json({ error: "Unknown symbol" });
  const a = atr(d.bars, 14);
  const signal = personalSignal(res, d.forecast.symbol);
  res.json({ ...d, signal, stops: stops(d.forecast.price, a, signal?.side === "sell" ? "sell" : "buy", me(res).profile.risk) });
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
        signal: personalSignal(res, f.symbol)?.side ?? "hold", pe: fund?.pe, dividendYield: fund?.dividendYield ?? insts.get(f.symbol)?.dividendYield,
      };
    })
    .sort((a, b) => b.expectedReturn * b.confidence - a.expectedReturn * a.confidence);
  res.json(rows);
});

api.put("/profile", (req, res) => {
  const body = req.body ?? {};
  update(res, "profile", (p) => ({ ...p, ...body, id: p.id, risk: { ...p.risk, ...(body.risk ?? {}) }, notifications: { ...p.notifications, ...(body.notifications ?? {}) }, updatedAt: Date.now() }));
  res.json(me(res).profile);
});

// Generic CRUD for list collections synced across devices.
function crud<T extends { id: string }>(key: "watchlists" | "alerts" | "strategies" | "ideas" | "playbooks", prefix: string, defaults: (b: Partial<T>) => T) {
  type L = UserData[typeof key];
  api.get(`/${key}`, (_req, res) => res.json(me(res)[key]));
  api.post(`/${key}`, (req, res) => {
    if ((me(res)[key] as unknown[]).length >= 200) return res.status(400).json({ error: "Limit reached" });
    const item = defaults({ ...req.body, id: uid(prefix) });
    update(res, key, (xs) => [...(xs as unknown as T[]), item] as unknown as L);
    res.json(item);
  });
  api.put(`/${key}/:id`, (req, res) => {
    update(res, key, (xs) => (xs as unknown as T[]).map((x) => (x.id === req.params.id ? { ...x, ...req.body, id: x.id } : x)) as unknown as L);
    res.json((me(res)[key] as unknown as T[]).find((x) => x.id === req.params.id));
  });
  api.delete(`/${key}/:id`, (req, res) => {
    update(res, key, (xs) => (xs as unknown as T[]).filter((x) => x.id !== req.params.id) as unknown as L);
    res.json({ ok: true });
  });
}
crud<Watchlist>("watchlists", "wl_", (b) => ({ id: b.id!, name: b.name ?? "New list", symbols: (b.symbols ?? []).map((s) => s.toUpperCase()), tags: b.tags ?? [], shared: !!b.shared }));
crud<AlertRule>("alerts", "al_", (b) => ({ id: b.id!, symbol: (b.symbol ?? "SPY").toUpperCase(), kind: b.kind ?? "price-above", value: b.value === undefined ? undefined : Number(b.value), enabled: b.enabled ?? true, createdAt: Date.now(), note: b.note }));
crud<StrategyConfig>("strategies", "st_", (b) => ({ id: b.id!, name: b.name ?? "My strategy", template: b.template ?? "trend", params: b.params ?? TEMPLATES[b.template ?? "trend"].params, risk: { ...DEFAULT_RISK, ...(b.risk ?? {}) }, universe: b.universe ?? ["SPY"], createdAt: Date.now() }));
crud<{ id: string; symbol: string; tags: string[]; note: string; author: string; createdAt: number }>("ideas", "id_", (b) => ({ id: b.id!, symbol: (b.symbol ?? "").toUpperCase(), tags: b.tags ?? [], note: b.note ?? "", author: "", createdAt: Date.now() }));
crud<{ id: string; name: string; regime: string; steps: string[]; shared: boolean }>("playbooks", "pb_", (b) => ({ id: b.id!, name: b.name ?? "Playbook", regime: b.regime ?? "normal", steps: b.steps ?? [], shared: b.shared ?? true }));

api.put("/positions", (req, res) => {
  const rows = Array.isArray(req.body) ? (req.body as { symbol: string; qty: number; avgPrice: number }[]).slice(0, 200) : [];
  update(res, "positions", () => rows.map((p) => ({ symbol: String(p.symbol).toUpperCase(), qty: Number(p.qty), avgPrice: Number(p.avgPrice) })));
  res.json(me(res).positions);
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
  res.json(sizePosition({ entry: Number(entry), stop: Number(stop), confidence: Number(confidence), edge: 0, atrPct: a / Number(entry), risk: me(res).profile.risk, novice: me(res).profile.experience === "novice" }));
});

api.get("/risk/portfolio", ready, (_req, res) => {
  const u = me(res);
  const pv = portfolioView(u.positions, agent.barsMap(), insts, u.profile.risk);
  const rows = u.positions.map((p) => {
    const f = agent.forecasts.get(p.symbol);
    return { ...p, price: f?.price ?? 0, pnlPct: f ? (f.price / p.avgPrice - 1) * 100 : 0, value: (f?.price ?? 0) * p.qty, signal: personalSignal(res, p.symbol)?.side ?? "hold" };
  });
  res.json({ ...pv, rows, scenarios: SCENARIOS.map((s) => runScenario(u.positions, agent.barsMap(), insts, s)) });
});

api.get("/anomalies", (req, res) => res.json(agent.anomalyReport(typeof req.query.symbol === "string" ? req.query.symbol : undefined)));
api.get("/review", (_req, res) => res.json(store.global.reviews));
api.post("/review/run", ready, (_req, res) => res.json(agent.runReview()));
api.get("/ledger", (_req, res) => res.json(store.global.ledger.slice(0, 200)));

// Exports for brokers / research teams.
api.get("/export/signals.:fmt", ready, (req, res) => {
  const sigs = [...agent.forecasts.keys()].map((s) => personalSignal(res, s)!).filter((s) => s && s.side !== "hold");
  if (req.params.fmt === "json") return res.json(sigs);
  const head = "symbol,side,entry,stop,target,shares,confidence,holding_days,rule,created_at";
  const lines = sigs.map((s) => [s.symbol, s.side, s.entry.toFixed(4), s.stop.toFixed(4), s.target.toFixed(4), s.sizing.shares, s.confidence, s.holdingDays, s.rule, new Date(s.createdAt).toISOString()].join(","));
  res.type("text/csv").attachment("stockens-signals.csv").send([head, ...lines].join("\n"));
});
api.get("/export/report", ready, (_req, res) => {
  const d = agent.dashboard();
  res.json({ generatedAt: new Date().toISOString(), regime: d.regime, psychology: d.psychology, topBuys: d.topBuys.map((x) => x.signal), topSells: d.topSells.map((x) => x.signal), watchlists: me(res).watchlists, ideas: me(res).ideas, playbooks: me(res).playbooks });
});

api.post("/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: "bad subscription" });
  update(res, "pushSubs", (s) => [...s.filter((x) => (x as { endpoint: string }).endpoint !== sub.endpoint), sub].slice(-10));
  res.json({ ok: true });
});
api.post("/push/test", async (_req, res) => {
  await sendPush(res.locals.uid, { title: "Stockens", body: "Push alerts are working ✅" });
  res.json({ ok: true, subscribers: me(res).pushSubs.length });
});

// Crypto latency engine
api.get("/crypto", (_req, res) => res.json({ state: crypto.publicState(), graph: crypto.graph.snapshot, config: crypto.cfg, klines: crypto.feed.klines5m.slice(-120) }));
// The paper bot is shared by everyone, so only the owner (admin) can change its limits.
api.put("/crypto/config", (req, res) => {
  if (!res.locals.admin) return res.status(403).json({ error: "Only the owner can change engine limits." });
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

try {
  await store.init();
} catch (e) {
  console.error(`\nStockens can't start: ${(e as Error).message}\n`);
  process.exit(1);
}
initPush();
const mode = authMode();
if (mode === "open") console.warn("No STRIPE_SECRET_KEY or ADMIN_EMAILS: running in open single-user mode with no login. Don't host it online like this.");
if (mode !== "open" && store.backend === "file") console.warn(`Accounts are stored in ${config.dataDir}. On hosts without a persistent disk set DATABASE_URL, or accounts and purchases are lost on restart.`);
server.listen(config.port, "0.0.0.0", () => {
  console.log(`Stockens server on http://localhost:${config.port}  (mode=${mode}, storage=${store.backend}, LIVE_DATA=${config.liveData})`);
});

void crypto.start();
agent.start().catch((e) => {
  agent.status = `error: ${(e as Error).message}`;
  console.error(e);
});
