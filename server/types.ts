// Shared types between the server engine, background agent and the web app.

export type Horizon = "intraday" | "5d" | "4w" | "2q";
export const HORIZONS: { id: Horizon; label: string; days: number }[] = [
  { id: "intraday", label: "Intraday", days: 1 / 6.5 },
  { id: "5d", label: "1–5 day", days: 5 },
  { id: "4w", label: "1–4 week", days: 20 },
  { id: "2q", label: "Multi-quarter", days: 126 },
];

export type AssetClass = "equity" | "etf" | "crypto";

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  sector: string;
  themes: string[];
  dividendYield?: number;
  beta?: number;
}

export interface Bar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Fundamentals {
  pe?: number;
  forwardPe?: number;
  epsRevision?: number; // % change in next-FY EPS estimate (30d)
  epsSurprise?: number; // last quarter surprise %
  analystDispersion?: number; // stdev of targets / mean
  shortFloat?: number;
  marketCap?: number;
  dividendYield?: number;
  nextEarnings?: number; // epoch ms
}

export interface NewsItem {
  id: string;
  symbol: string;
  t: number;
  headline: string;
  source: string;
  url?: string;
  sentiment: number; // -1..1
}

export type RegimeLabel = "risk-on" | "risk-off" | "neutral";
export interface Regime {
  trend: RegimeLabel;
  vol: "high-vol" | "low-vol" | "normal-vol";
  season: "earnings-season" | "holiday-liquidity" | "normal";
  liquidity: "thin" | "normal";
  label: string;
  // Weights the ensemble uses in this regime.
  weights: { gbt: number; sequence: number; trend: number; reversion: number };
}

export interface Attribution {
  feature: string;
  group: string;
  value: number; // raw feature value
  contribution: number; // signed contribution to the forecast (in % return)
  tip: string; // education tooltip
}

export interface HorizonForecast {
  horizon: Horizon;
  label: string;
  expectedReturn: number; // %
  bandLow: number; // % (≈80% band)
  bandHigh: number; // %
  probUp: number; // 0..1
  confidence: number; // 0..100
  rationale: string;
}

export interface IntegrityCheck {
  name: string;
  ok: boolean;
  note: string;
}

export interface PokerRead {
  handStrength: number; // 0..100 = confidence-weighted edge
  potOdds: number; // breakeven win rate given payoff (0..1)
  equity: number; // model win prob (0..1)
  action: "fold" | "check" | "call" | "raise";
  kellyFraction: number; // fraction of bankroll (already scaled down)
  note: string;
}

export interface Forecast {
  symbol: string;
  name: string;
  sector: string;
  themes: string[];
  price: number;
  changePct: number;
  updatedAt: number;
  regime: Regime;
  horizons: HorizonForecast[];
  attributions: Attribution[];
  integrity: IntegrityCheck[];
  modelVotes: { model: string; expectedReturn: number; weight: number }[];
  sentiment: { score: number; momentum: number; count: number };
  poker: PokerRead;
  catalysts: string[];
  sources: string[];
  path: { t: number; mid: number; low: number; high: number }[]; // 5-day projected cone
}

export interface SignalCard {
  id: string;
  symbol: string;
  side: "buy" | "sell" | "hold";
  createdAt: number;
  entry: number;
  stop: number;
  target: number;
  trailingAtr: number;
  expectedMovePct: number;
  holdingDays: number;
  confidence: number;
  rr: number;
  sizing: { shares: number; notional: number; riskDollars: number; pctOfAccount: number };
  rule: string; // backtested rule that fired
  rationale: string;
  extendedHours: boolean;
  backtest?: { hitRate: number; payoff: number; sharpe: number; trades: number };
}

export interface FeedItem {
  id: string;
  t: number;
  kind: "upgrade" | "downgrade" | "signal" | "regime" | "news" | "alert" | "crypto";
  symbol?: string;
  title: string;
  body: string;
  confidence?: number;
}

export type AlertKind = "price-above" | "price-below" | "pct-move" | "earnings" | "sentiment-flip" | "signal" | "exit";
export interface AlertRule {
  id: string;
  symbol: string;
  kind: AlertKind;
  value?: number;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  note?: string;
}

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
  tags: string[];
  shared: boolean;
}

export interface RiskSettings {
  accountSize: number;
  riskPerTradePct: number; // % of account at risk per trade
  maxPositionPct: number;
  maxSectorPct: number;
  maxDrawdownPct: number; // portfolio drawdown brake
  defaultStop: "atr" | "static" | "trailing" | "time";
  atrMultiple: number;
  timeStopDays: number;
}

export interface Profile {
  id: string;
  displayName: string;
  avatar: string; // emoji
  accent: string;
  theme: "system" | "light" | "dark";
  experience: "novice" | "intermediate" | "advanced";
  showTooltips: boolean;
  defaultHorizon: Horizon;
  favoriteThemes: string[];
  extendedHours: boolean;
  risk: RiskSettings;
  notifications: { push: boolean; inApp: boolean; quietHours?: [number, number] };
  broker?: { name: string; exportFormat: "csv" | "json" };
  updatedAt: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avgPrice: number;
}

export interface StrategyConfig {
  id: string;
  name: string;
  template: "trend" | "breakout" | "mean-reversion" | "post-earnings-drift" | "vol-compression";
  params: Record<string, number>;
  risk: { stopAtr: number; targetAtr: number; timeStopDays: number; trailing: boolean; drawdownBrakePct: number };
  universe: string[];
  createdAt: number;
}

export interface BacktestMetrics {
  trades: number;
  hitRate: number;
  payoff: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpe: number;
  sortino: number;
  mar: number;
  exposure: number;
  exposureAdjReturn: number;
  turnover: number;
}

export interface BacktestResult {
  strategy: StrategyConfig;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  folds: { start: number; end: number; metrics: BacktestMetrics }[];
  byRegime: { regime: string; metrics: BacktestMetrics }[];
  tcSensitivity: { costBps: number; totalReturn: number; sharpe: number }[];
  equity: { t: number; equity: number; benchmark: number; drawdown: number }[];
  warnings: string[];
}

export interface SourceStatus {
  id: string;
  name: string;
  url: string;
  status: "live" | "simulated" | "error" | "disabled";
  lastOk?: number;
  note: string;
}

// ---------------- crypto / latency engine ----------------
export interface CryptoTick {
  symbol: string;
  price: number;
  t: number;
}

export interface GraphNode {
  id: string;
  group: string;
  bias: number; // -1..1
  weight: number;
  cluster: "BULL" | "BEAR" | "NEUTRAL";
}
export interface GraphEdge {
  source: string;
  target: string;
  w: number; // correlation -1..1
}
export interface ConvergenceSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bullMass: number;
  bearMass: number;
  convergence: number; // -1..1 (signed)
  verdict: "BULL" | "BEAR" | "CONFLICT";
}

export interface LatencyTrade {
  id: string;
  t: number;
  side: "UP" | "DOWN";
  entry: number;
  exit?: number;
  stake: number;
  pnl?: number;
  status: "open" | "closed";
  reason: string;
  latencyMs: number;
}

export interface LatencyState {
  mode: "paper" | "live-disabled";
  spot: number;
  windowOpen: number;
  windowEndsAt: number;
  clobMid: number;
  fairProb: number;
  lagPct: number;
  edge: number;
  lastDecision: string;
  skips: Record<string, number>;
  bankroll: number;
  dayPnl: number;
  dayPnlPct: number;
  halted: boolean;
  trades: LatencyTrade[];
  feeds: { binance: string; polymarket: string; tradingview: string; cryptoquant: string };
  evalsPerSec: number;
}
