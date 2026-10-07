import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import type { AlertRule, Position, Profile, SignalCard, StrategyConfig, Watchlist } from "./types.ts";

// Local JSON store. The server is the single source of truth, so every device that
// opens the app (phone, tablet, laptop) sees the same profile, watchlists and alerts.

export interface LedgerEntry {
  signal: SignalCard;
  closedAt?: number;
  exit?: number;
  pnlPct?: number;
  outcome?: "target" | "stop" | "time" | "open";
}

export interface Review {
  t: number;
  date: string;
  summary: string;
  worked: string[];
  didnt: string[];
  regimeNotes: string[];
  stats: { signals: number; closed: number; winRate: number; avgPnlPct: number };
  byRule: { rule: string; n: number; avgPnlPct: number }[];
}

export interface Idea {
  id: string;
  symbol: string;
  tags: string[];
  note: string;
  author: string;
  createdAt: number;
}

export interface Playbook {
  id: string;
  name: string;
  regime: string;
  steps: string[];
  strategyId?: string;
  shared: boolean;
}

export interface StoreShape {
  profile: Profile;
  watchlists: Watchlist[];
  alerts: AlertRule[];
  positions: Position[];
  strategies: StrategyConfig[];
  ledger: LedgerEntry[];
  reviews: Review[];
  ideas: Idea[];
  playbooks: Playbook[];
  pushSubs: unknown[];
  vapid?: { publicKey: string; privateKey: string };
}

export const DEFAULT_PROFILE: Profile = {
  id: "me",
  displayName: "Investor",
  avatar: "🦊",
  accent: "#2a78d6",
  theme: "system",
  experience: "novice",
  showTooltips: true,
  defaultHorizon: "5d",
  favoriteThemes: ["AI", "cloud", "semis"],
  extendedHours: false,
  risk: {
    accountSize: 10_000,
    riskPerTradePct: 0.5,
    maxPositionPct: 10,
    maxSectorPct: 35,
    maxDrawdownPct: 10,
    defaultStop: "atr",
    atrMultiple: 2,
    timeStopDays: 10,
  },
  notifications: { push: false, inApp: true },
  broker: { name: "Export only", exportFormat: "csv" },
  updatedAt: Date.now(),
};

const DEFAULTS: StoreShape = {
  profile: DEFAULT_PROFILE,
  watchlists: [
    { id: "wl_ai", name: "AI compute backbone", symbols: ["NVDA", "AMD", "AVGO", "ANET", "EQIX", "SMH"], tags: ["theme:AI"], shared: true },
    { id: "wl_cyber", name: "Cyber & cloud", symbols: ["CRWD", "PANW", "ZS", "SNOW", "MSFT"], tags: ["theme:cyber"], shared: false },
    { id: "wl_div", name: "Dividends", symbols: ["XOM", "JPM", "COST", "DLR", "TLT"], tags: ["factor:dividend"], shared: false },
    { id: "wl_crypto", name: "BTC & memecoins", symbols: ["BTC", "ETH", "SOL", "DOGE", "PEPE"], tags: ["crypto"], shared: false },
  ],
  alerts: [],
  positions: [
    { symbol: "NVDA", qty: 10, avgPrice: 160 },
    { symbol: "MSFT", qty: 4, avgPrice: 470 },
    { symbol: "SPY", qty: 5, avgPrice: 600 },
  ],
  strategies: [],
  ledger: [],
  reviews: [],
  ideas: [],
  playbooks: [
    { id: "pb_earn", name: "Earnings window", regime: "earnings-season", steps: ["Cut size 50% into prints", "Only trade post-earnings drift after the gap holds day 1", "Time stop 10 days"], shared: true },
    { id: "pb_riskoff", name: "Risk-off tape", regime: "risk-off", steps: ["No new breakouts", "Mean-reversion only in names above 200-day", "Drawdown brake at 5%"], shared: true },
    { id: "pb_holiday", name: "Holiday liquidity", regime: "holiday-liquidity", steps: ["Regular-session only", "Widen stops 1.5×, halve size", "Skip memecoins"], shared: true },
  ],
  pushSubs: [],
};

class Store {
  data: StoreShape;
  private file = path.join(config.dataDir, "store.json");
  private timer?: NodeJS.Timeout;
  listeners = new Set<(key: keyof StoreShape) => void>();

  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    let loaded: Partial<StoreShape> = {};
    try {
      loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      /* first run */
    }
    this.data = { ...structuredClone(DEFAULTS), ...loaded };
    this.data.profile = { ...DEFAULT_PROFILE, ...this.data.profile, risk: { ...DEFAULT_PROFILE.risk, ...this.data.profile?.risk } };
  }

  update<K extends keyof StoreShape>(key: K, fn: (v: StoreShape[K]) => StoreShape[K]) {
    this.data[key] = fn(this.data[key]);
    this.save();
    for (const l of this.listeners) l(key);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    }, 250);
  }
}

export const store = new Store();
