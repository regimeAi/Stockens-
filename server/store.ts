import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { config } from "./config.ts";
import type { AlertRule, Position, Profile, SignalCard, StrategyConfig, Watchlist } from "./types.ts";

// Persistence. Each buyer has an account plus their own data (profile, watchlists, alerts…);
// the agent's signal ledger and reviews are global. Everything lives in a tiny key-value
// table: Postgres when DATABASE_URL is set (needed on hosts without a persistent disk),
// otherwise a JSON file in DATA_DIR. The whole set is held in memory and written through.

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

export interface Account {
  id: string;
  email: string;
  passHash: string; // scrypt
  salt: string;
  createdAt: number;
  paid: boolean;
  paidAt?: number;
  stripeSessionId?: string;
  amountCents?: number;
}

export interface UserData {
  profile: Profile;
  watchlists: Watchlist[];
  alerts: AlertRule[];
  positions: Position[];
  strategies: StrategyConfig[];
  ideas: Idea[];
  playbooks: Playbook[];
  pushSubs: unknown[];
}

export interface GlobalData {
  ledger: LedgerEntry[];
  reviews: Review[];
  vapid?: { publicKey: string; privateKey: string };
  sessionSecret?: string;
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

export const DEFAULT_PLAYBOOKS: Playbook[] = [
  { id: "pb_earn", name: "Earnings window", regime: "earnings-season", steps: ["Cut size 50% into prints", "Only trade post-earnings drift after the gap holds day 1", "Time stop 10 days"], shared: true },
  { id: "pb_riskoff", name: "Risk-off tape", regime: "risk-off", steps: ["No new breakouts", "Mean-reversion only in names above 200-day", "Drawdown brake at 5%"], shared: true },
  { id: "pb_holiday", name: "Holiday liquidity", regime: "holiday-liquidity", steps: ["Regular-session only", "Widen stops 1.5×, halve size", "Skip memecoins"], shared: true },
];

export function defaultUserData(name = "Investor"): UserData {
  return structuredClone({
    profile: { ...DEFAULT_PROFILE, displayName: name, updatedAt: Date.now() },
    watchlists: [
      { id: "wl_ai", name: "AI compute backbone", symbols: ["NVDA", "AMD", "AVGO", "ANET", "EQIX", "SMH"], tags: ["theme:AI"], shared: false },
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
    ideas: [],
    playbooks: DEFAULT_PLAYBOOKS,
    pushSubs: [],
  });
}

// ---------------- key-value backends ----------------
interface KV {
  loadAll(): Promise<[string, unknown][]>;
  put(key: string, value: unknown): Promise<void>;
}

class FileKV implements KV {
  private file = path.join(config.dataDir, "store.json");
  private data: Record<string, unknown> = {};
  private timer?: NodeJS.Timeout;
  async loadAll() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.data = {};
    }
    // Pre-accounts single-user file: keep the global parts, drop the rest.
    if ("profile" in this.data && !("global" in this.data)) {
      const old = this.data as Partial<GlobalData>;
      this.data = { global: { ledger: old.ledger ?? [], reviews: old.reviews ?? [], vapid: old.vapid, sessionSecret: old.sessionSecret } };
    }
    return Object.entries(this.data);
  }
  async put(key: string, value: unknown) {
    this.data[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    }, 250);
  }
}

class PgKV implements KV {
  private pool: pg.Pool;
  private pending = new Map<string, unknown>();
  private timer?: NodeJS.Timeout;
  constructor(url: string) {
    // Hosted Postgres (Neon, Supabase, Render) requires TLS.
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new pg.Pool({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false }, max: 4 });
  }
  async loadAll() {
    await this.pool.query("CREATE TABLE IF NOT EXISTS stockens_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const r = await this.pool.query<{ key: string; value: unknown }>("SELECT key, value FROM stockens_kv");
    return r.rows.map((x) => [x.key, x.value] as [string, unknown]);
  }
  async put(key: string, value: unknown) {
    this.pending.set(key, value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 200);
  }
  private async flush() {
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [k, v] of batch) {
      try {
        await this.pool.query(
          "INSERT INTO stockens_kv (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
          [k, JSON.stringify(v)],
        );
      } catch (e) {
        console.error(`store: failed to save ${k}:`, (e as Error).message);
        if (!this.pending.has(k)) this.pending.set(k, v);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), 5000);
      }
    }
  }
}

// ---------------- store ----------------
type UserKey = keyof UserData;

class Store {
  global: GlobalData = { ledger: [], reviews: [] };
  accounts = new Map<string, Account>();
  users = new Map<string, UserData>();
  private byEmail = new Map<string, string>();
  private kv: KV = config.databaseUrl ? new PgKV(config.databaseUrl) : new FileKV();
  readonly backend = config.databaseUrl ? "postgres" : "file";
  listeners = new Set<(uid: string, key: UserKey) => void>();

  async init() {
    for (const [k, v] of await this.kv.loadAll()) {
      if (k === "global") this.global = Object.assign({ ledger: [], reviews: [] }, v as GlobalData);
      else if (k.startsWith("account:")) {
        const a = v as Account;
        this.accounts.set(a.id, a);
        this.byEmail.set(a.email, a.id);
      } else if (k.startsWith("data:")) {
        const d = { ...defaultUserData(), ...(v as UserData) };
        d.profile = { ...DEFAULT_PROFILE, ...d.profile, risk: { ...DEFAULT_PROFILE.risk, ...d.profile?.risk } };
        this.users.set(k.slice(5), d);
      }
    }
  }

  accountByEmail(email: string) {
    const id = this.byEmail.get(email.trim().toLowerCase());
    return id ? this.accounts.get(id) : undefined;
  }

  saveAccount(a: Account) {
    this.accounts.set(a.id, a);
    this.byEmail.set(a.email, a.id);
    void this.kv.put(`account:${a.id}`, a);
  }

  user(uid: string): UserData {
    let d = this.users.get(uid);
    if (!d) {
      d = defaultUserData(this.accounts.get(uid)?.email.split("@")[0] ?? "Investor");
      this.users.set(uid, d);
      void this.kv.put(`data:${uid}`, d);
    }
    return d;
  }

  updateUser<K extends UserKey>(uid: string, key: K, fn: (v: UserData[K]) => UserData[K]) {
    const d = this.user(uid);
    d[key] = fn(d[key]);
    void this.kv.put(`data:${uid}`, d);
    for (const l of this.listeners) l(uid, key);
  }

  updateGlobal<K extends keyof GlobalData>(key: K, fn: (v: GlobalData[K]) => GlobalData[K]) {
    this.global[key] = fn(this.global[key]);
    void this.kv.put("global", this.global);
  }
}

export const store = new Store();
