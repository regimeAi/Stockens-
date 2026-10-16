import type { Anomaly, FeedItem, Forecast } from "../types.ts";
import type { SymbolData } from "../engine/ensemble.ts";
import { type MarketContext, computeFeatures } from "../engine/features.ts";
import { atr, uid } from "../engine/indicators.ts";

// The trading team: four background agents running a built-in paper (practice) account.
//
//   Scout            finds "buy the dip in a strong stock" setups the forecasts like
//   Risk Manager     approves or rejects each idea against the rules and sizes it
//   Trader           fills approved trades (with slippage/fees) and manages every exit
//   Portfolio Mgr    keeps the books, compares with SPY, writes reports, pauses on losses
//
// Style: short swing trades (1–5 trading days). Long only. No real money ever moves here.

export interface TeamSettings {
  startingCash: number;
  riskPerTradePct: number; // % of equity lost if a stop is hit
  maxPositions: number;
  maxPositionPct: number; // % of equity in any one stock
  maxSectorPct: number;
  stopAtr: number; // stop distance in ATRs
  minRewardRisk: number;
  maxHoldDays: number; // trading days before a time exit
  dailyLossLimitPct: number; // pause for the rest of the day
  drawdownPausePct: number; // pause until resumed by the owner
  slippageBps: number; // per side
  feePerTrade: number; // $ per fill
  minConfidence: number;
  marketHoursOnly: boolean;
}

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  startingCash: 10_000,
  riskPerTradePct: 0.75,
  maxPositions: 5,
  maxPositionPct: 20,
  maxSectorPct: 45,
  stopAtr: 1.5,
  minRewardRisk: 1.5,
  maxHoldDays: 5,
  dailyLossLimitPct: 2,
  drawdownPausePct: 8,
  slippageBps: 5,
  feePerTrade: 0,
  minConfidence: 40,
  marketHoursOnly: true,
};

export interface PaperPosition {
  id: string;
  symbol: string;
  sector: string;
  qty: number;
  entry: number;
  stop: number;
  initialStop: number;
  target: number;
  openedAt: number;
  openedBarT: number;
  high: number;
  setup: string;
  live: boolean; // filled at a live (not simulated) price
  fees: number;
}

export interface ClosedTrade extends PaperPosition {
  exit: number;
  exitAt: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  daysHeld: number;
}

export interface Proposal {
  id: string;
  t: number;
  symbol: string;
  price: number;
  exp: number;
  conf: number;
  stop: number;
  target: number;
  rr: number;
  setup: string;
  status: "approved" | "rejected";
  note: string; // why approved / rejected
  qty?: number;
}

type AgentKey = "scout" | "risk" | "trader" | "pm";

export interface TeamState {
  settings: TeamSettings;
  startedAt: number;
  startSpy?: number;
  cash: number;
  positions: PaperPosition[];
  closed: ClosedTrade[];
  proposals: Proposal[];
  equity: { t: number; equity: number; spy: number }[];
  peak: number;
  dayKey: string;
  dayStartEquity: number;
  paused: string | null;
  pauseUntilNextDay: boolean;
  lastReportDay?: string;
  agents: Record<AgentKey, { at: number; msg: string }>;
}

export interface TeamHost {
  data: Map<string, SymbolData>;
  forecasts: Map<string, Forecast>;
  anomalies: Anomaly[];
  ctx: MarketContext;
  liveData: boolean;
  push(item: Omit<FeedItem, "id" | "t">): void;
}

export function newTeamState(settings: Partial<TeamSettings> = {}, now = Date.now()): TeamState {
  const s = { ...DEFAULT_TEAM_SETTINGS, ...settings };
  const idle = { at: now, msg: "Starting up" };
  return {
    settings: s,
    startedAt: now,
    cash: s.startingCash,
    positions: [],
    closed: [],
    proposals: [],
    equity: [],
    peak: s.startingCash,
    dayKey: "",
    dayStartEquity: s.startingCash,
    paused: null,
    pauseUntilNextDay: false,
    agents: { scout: idle, risk: idle, trader: idle, pm: idle },
  };
}

// New York trading clock (weekday 9:30–16:00 ET; exchange holidays aren't modelled).
export function nyClock(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = !["Sat", "Sun"].includes(parts.weekday);
  return { dayKey: `${parts.year}-${parts.month}-${parts.day}`, mins, open: weekday && mins >= 570 && mins < 960, weekday };
}

const money = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyStr = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(3));

export class TradingTeam {
  private lastScan = 0;
  private lastSample = 0;

  constructor(
    public state: TeamState,
    private host: TeamHost,
    private save: (s: TeamState) => void,
  ) {}

  private price(symbol: string) {
    return this.host.data.get(symbol)?.bars.at(-1)?.c;
  }

  private say(agent: AgentKey, msg: string, now: number) {
    this.state.agents[agent] = { at: now, msg };
  }

  equityNow(): number {
    return this.state.cash + this.state.positions.reduce((a, p) => a + p.qty * (this.price(p.symbol) ?? p.entry), 0);
  }

  // One heartbeat for the whole team; called after every agent cycle.
  step(now = Date.now()) {
    const st = this.state;
    const s = st.settings;
    const clock = nyClock(now);
    const spy = this.price("SPY");
    st.startSpy ??= spy;

    // New trading day: reset the daily loss baseline and lift a daily-loss pause.
    if (clock.dayKey !== st.dayKey) {
      st.dayKey = clock.dayKey;
      st.dayStartEquity = this.equityNow();
      if (st.paused && st.pauseUntilNextDay) {
        st.paused = null;
        st.pauseUntilNextDay = false;
        this.say("pm", "New day — daily loss limit reset, trading resumed.", now);
      }
    }

    const marketOpen = !s.marketHoursOnly || clock.open;
    if (marketOpen) {
      this.manageExits(now);
      if (now - this.lastScan >= 60_000) {
        this.lastScan = now;
        for (const p of this.scout(now)) this.review(p, now);
      }
    } else {
      const msg = "Market closed — waiting for the 9:30am ET open.";
      this.say("scout", msg, now);
      this.say("trader", `${st.positions.length} open position${st.positions.length === 1 ? "" : "s"}; ${msg.toLowerCase()}`, now);
    }
    this.bookkeeping(now, clock, spy);
    this.save(st);
  }

  // ---------------- Scout ----------------
  private scout(now: number): Omit<Proposal, "status" | "note">[] {
    const s = this.state.settings;
    const ideas: (Omit<Proposal, "status" | "note"> & { score: number })[] = [];
    let scanned = 0;
    for (const d of this.host.data.values()) {
      if (d.inst.assetClass !== "equity") continue;
      const f = this.host.forecasts.get(d.inst.symbol);
      if (!f) continue;
      scanned++;
      const h5 = f.horizons.find((h) => h.horizon === "5d")!;
      if (h5.expectedReturn < 0.4 || h5.probUp < 0.53 || h5.confidence < s.minConfidence) continue;
      const bars = d.bars;
      const fv = computeFeatures(bars, bars.length - 1, d.fundamentals, this.host.ctx);
      const strong = fv.mom_120 > 0 && fv.trend_slope > -0.005;
      const dip = fv.mom_5 < 0 || fv.z_20 < -0.5 || fv.rsi_14 < -0.1;
      const breakout = fv.volume_z > 1.5 && fv.close_loc > 0.2 && fv.mom_5 > 0;
      if (!strong || !(dip || breakout)) continue;
      const price = f.price;
      const a = atr(bars, 14);
      if (!a) continue;
      const stop = price - s.stopAtr * a;
      const risk = price - stop;
      const target = price + Math.max((h5.expectedReturn / 100) * price * 1.3, s.minRewardRisk * risk);
      ideas.push({
        id: uid("pr_"),
        t: now,
        symbol: d.inst.symbol,
        price,
        exp: h5.expectedReturn,
        conf: h5.confidence,
        stop,
        target,
        rr: (target - price) / risk,
        setup: dip ? "dip in an uptrend" : "breakout on volume",
        score: (h5.expectedReturn * h5.confidence) / 100 / Math.max((a / price) * 100, 0.5),
      });
    }
    const recent = new Set(this.state.proposals.filter((p) => now - p.t < 4 * 3600_000).map((p) => p.symbol));
    const held = new Set(this.state.positions.map((p) => p.symbol));
    const picks = ideas
      .filter((i) => !recent.has(i.symbol) && !held.has(i.symbol))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    this.say(
      "scout",
      picks.length
        ? `Scanned ${scanned} stocks; proposing ${picks.map((p) => p.symbol).join(", ")}.`
        : `Scanned ${scanned} stocks; no fresh setups pass the bar (dip or breakout in an uptrend, forecast ≥ +0.4%, confidence ≥ ${s.minConfidence}).`,
      now,
    );
    return picks.map(({ score: _score, ...p }) => p);
  }

  // ---------------- Risk Manager ----------------
  private review(p: Omit<Proposal, "status" | "note">, now: number) {
    const st = this.state;
    const s = st.settings;
    const d = this.host.data.get(p.symbol)!;
    const equity = this.equityNow();
    const slip = s.slippageBps / 10_000;
    const reject = (note: string) => {
      st.proposals = [{ ...p, status: "rejected" as const, note }, ...st.proposals].slice(0, 200);
      this.say("risk", `Rejected ${p.symbol}: ${note}`, now);
    };
    if (st.paused) return reject(`team is paused (${st.paused})`);
    if (this.host.liveData && !d.live) return reject("no live price for this stock yet");
    if (st.positions.length >= s.maxPositions) return reject(`already at the ${s.maxPositions}-position limit`);
    if (p.rr + 1e-6 < s.minRewardRisk) return reject(`reward:risk ${p.rr.toFixed(1)} is below ${s.minRewardRisk}`);
    const ne = d.fundamentals.nextEarnings;
    if (ne && ne > now && ne - now < (s.maxHoldDays + 2) * 1.4 * 86_400_000) return reject(`earnings on ${new Date(ne).toLocaleDateString()} fall inside the holding window`);
    const warn = this.host.anomalies.find(
      (a) => a.symbol === p.symbol && now - a.t < 2 * 3600_000 && a.severity >= 2 && ["price-vs-forecast", "uncertainty-shock", "direction-flip", "model-split"].includes(a.kind),
    );
    if (warn) return reject(`recent anomaly: ${warn.title.toLowerCase()}`);

    const perShare = p.price - p.stop;
    let qty = (equity * (s.riskPerTradePct / 100)) / perShare;
    qty = Math.min(qty, (equity * (s.maxPositionPct / 100)) / p.price, (st.cash - s.feePerTrade) / (p.price * (1 + slip)));
    qty = p.price >= 20 ? Math.floor(qty * 1000) / 1000 : Math.floor(qty); // fractional shares above $20
    const notional = qty * p.price;
    if (notional < 50) return reject(st.cash < 100 ? "not enough cash left" : "position would be too small to matter");
    const sectorNow = st.positions.filter((x) => x.sector === d.inst.sector).reduce((a, x) => a + x.qty * (this.price(x.symbol) ?? x.entry), 0);
    if (((sectorNow + notional) / equity) * 100 > s.maxSectorPct) return reject(`${d.inst.sector} would exceed ${s.maxSectorPct}% of the portfolio`);

    const note = `risks ${money(qty * perShare)} (${((qty * perShare * 100) / equity).toFixed(2)}% of equity) for ${p.rr.toFixed(1)}:1 reward`;
    st.proposals = [{ ...p, status: "approved" as const, note, qty }, ...st.proposals].slice(0, 200);
    this.say("risk", `Approved ${p.symbol}: ${note}.`, now);
    this.buy(p, qty, d, now);
  }

  // ---------------- Trader ----------------
  private buy(p: Omit<Proposal, "status" | "note">, qty: number, d: SymbolData, now: number) {
    const st = this.state;
    const s = st.settings;
    const fill = p.price * (1 + s.slippageBps / 10_000);
    st.cash -= qty * fill + s.feePerTrade;
    st.positions.push({
      id: uid("pos_"),
      symbol: p.symbol,
      sector: d.inst.sector,
      qty,
      entry: fill,
      stop: p.stop,
      initialStop: p.stop,
      target: p.target,
      openedAt: now,
      openedBarT: d.bars.at(-1)!.t,
      high: fill,
      setup: p.setup,
      live: d.live,
      fees: s.feePerTrade,
    });
    this.say("trader", `Bought ${qtyStr(qty)} ${p.symbol} at ${money(fill)} (stop ${money(p.stop)}, target ${money(p.target)}).`, now);
    this.host.push({ kind: "signal", symbol: p.symbol, title: `Team bought ${p.symbol} (paper)`, body: `${qtyStr(qty)} shares at ${money(fill)} · ${p.setup} · stop ${money(p.stop)} · target ${money(p.target)}` });
  }

  private manageExits(now: number) {
    const st = this.state;
    const s = st.settings;
    const actions: string[] = [];
    for (const pos of [...st.positions]) {
      const d = this.host.data.get(pos.symbol);
      const price = this.price(pos.symbol);
      if (!d || !price) continue;
      pos.high = Math.max(pos.high, price);
      const r = pos.entry - pos.initialStop;
      // Lock in: breakeven after +1R, then trail one ATR below the high after +1.5R.
      if (pos.high >= pos.entry + r && pos.stop < pos.entry) {
        pos.stop = pos.entry;
        actions.push(`moved ${pos.symbol} stop to breakeven`);
      }
      if (pos.high >= pos.entry + 1.5 * r) pos.stop = Math.max(pos.stop, pos.high - atr(d.bars, 14));
      const days = d.bars.filter((b) => b.t > pos.openedBarT).length;
      const f = this.host.forecasts.get(pos.symbol)?.horizons.find((h) => h.horizon === "5d");
      const reason =
        price <= pos.stop
          ? pos.stop >= pos.entry
            ? "trailing stop"
            : "stop loss"
          : price >= pos.target
            ? "hit target"
            : days >= s.maxHoldDays
              ? `time exit (${days} days)`
              : f && f.expectedReturn < -0.3 && f.confidence >= 50
                ? "forecast turned negative"
                : null;
      if (reason) actions.push(this.sell(pos, price, reason, days, now));
    }
    this.say("trader", actions.length ? actions.join("; ") + "." : `Watching ${st.positions.length} open position${st.positions.length === 1 ? "" : "s"}.`, now);
  }

  private sell(pos: PaperPosition, price: number, reason: string, daysHeld: number, now: number): string {
    const st = this.state;
    const s = st.settings;
    const fill = price * (1 - s.slippageBps / 10_000);
    st.cash += pos.qty * fill - s.feePerTrade;
    const fees = pos.fees + s.feePerTrade;
    const pnl = pos.qty * (fill - pos.entry) - fees;
    st.positions = st.positions.filter((x) => x.id !== pos.id);
    st.closed = [{ ...pos, fees, exit: fill, exitAt: now, pnl, pnlPct: (fill / pos.entry - 1) * 100, reason, daysHeld }, ...st.closed].slice(0, 500);
    this.host.push({ kind: "signal", symbol: pos.symbol, title: `Team sold ${pos.symbol} (paper) ${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}`, body: `${reason} · ${qtyStr(pos.qty)} at ${money(fill)} after ${daysHeld} day${daysHeld === 1 ? "" : "s"}` });
    return `sold ${pos.symbol} (${reason}, ${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))})`;
  }

  // ---------------- Portfolio Manager ----------------
  private bookkeeping(now: number, clock: ReturnType<typeof nyClock>, spy?: number) {
    const st = this.state;
    const s = st.settings;
    const eq = this.equityNow();
    st.peak = Math.max(st.peak, eq);
    if (now - this.lastSample >= 5 * 60_000 || !st.equity.length) {
      this.lastSample = now;
      st.equity = [...st.equity, { t: now, equity: eq, spy: spy ?? 0 }].slice(-4000);
    }
    const dayPct = ((eq - st.dayStartEquity) / st.dayStartEquity) * 100;
    const ddPct = ((st.peak - eq) / st.peak) * 100;
    if (!st.paused && dayPct <= -s.dailyLossLimitPct) {
      st.paused = `down ${dayPct.toFixed(2)}% today (limit ${s.dailyLossLimitPct}%)`;
      st.pauseUntilNextDay = true;
      this.host.push({ kind: "alert", title: "Team paused for the day", body: `Paper account is ${st.paused}. No new trades until tomorrow; open positions keep their stops.` });
    }
    if (!st.paused && ddPct >= s.drawdownPausePct) {
      st.paused = `${ddPct.toFixed(1)}% below its peak (limit ${s.drawdownPausePct}%)`;
      st.pauseUntilNextDay = false;
      this.host.push({ kind: "alert", title: "Team paused — drawdown limit", body: `Paper account is ${st.paused}. Review the trades, then resume from the Team tab.` });
    }
    const t = teamStats(st, eq, spy);
    this.say(
      "pm",
      `Equity ${money(eq)} (${t.totalReturnPct >= 0 ? "+" : ""}${t.totalReturnPct.toFixed(2)}%${t.spyReturnPct !== undefined ? ` vs SPY ${t.spyReturnPct >= 0 ? "+" : ""}${t.spyReturnPct.toFixed(2)}%` : ""}); today ${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(2)}%${st.paused ? ` — PAUSED: ${st.paused}` : ""}.`,
      now,
    );
    // End-of-day report once per trading day, after the close.
    if (clock.weekday && clock.mins >= 965 && st.lastReportDay !== clock.dayKey) {
      st.lastReportDay = clock.dayKey;
      const today = st.closed.filter((c) => nyClock(c.exitAt).dayKey === clock.dayKey);
      const pnl = today.reduce((a, c) => a + c.pnl, 0);
      this.host.push({
        kind: "regime",
        title: "Team daily report (paper)",
        body: `${today.length} trade${today.length === 1 ? "" : "s"} closed today (${pnl >= 0 ? "+" : "−"}${money(Math.abs(pnl))}); equity ${money(eq)}, ${t.totalReturnPct >= 0 ? "+" : ""}${t.totalReturnPct.toFixed(2)}% since start${t.spyReturnPct !== undefined ? ` vs SPY ${t.spyReturnPct.toFixed(2)}%` : ""}; win rate ${t.trades ? Math.round(t.winRate * 100) + "%" : "—"}; ${st.positions.length} open.`,
      });
    }
  }
}

export function teamStats(st: TeamState, equity: number, spy?: number) {
  const c = st.closed;
  const wins = c.filter((x) => x.pnl > 0);
  const losses = c.filter((x) => x.pnl <= 0);
  const sum = (xs: ClosedTrade[]) => xs.reduce((a, x) => a + x.pnl, 0);
  let peak = -Infinity;
  let mdd = 0;
  for (const e of st.equity) {
    peak = Math.max(peak, e.equity);
    mdd = Math.max(mdd, ((peak - e.equity) / peak) * 100);
  }
  const unrealized = equity - st.cash - st.positions.reduce((a, p) => a + p.qty * p.entry, 0);
  return {
    equity,
    totalPnl: equity - st.settings.startingCash,
    totalReturnPct: ((equity - st.settings.startingCash) / st.settings.startingCash) * 100,
    spyReturnPct: st.startSpy && spy ? (spy / st.startSpy - 1) * 100 : undefined,
    realized: sum(c),
    unrealized,
    trades: c.length,
    winRate: c.length ? wins.length / c.length : 0,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : wins.length ? Infinity : 0,
    expectancy: c.length ? sum(c) / c.length : 0,
    fees: c.reduce((a, x) => a + x.fees, 0) + st.positions.reduce((a, p) => a + p.fees, 0),
    maxDrawdownPct: mdd,
    avgHoldDays: c.length ? c.reduce((a, x) => a + x.daysHeld, 0) / c.length : 0,
  };
}

