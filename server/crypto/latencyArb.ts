import { EventEmitter } from "node:events";
import { config } from "../config.ts";
import type { LatencyState, LatencyTrade } from "../types.ts";
import { normCdf, uid } from "../engine/indicators.ts";
import { BinanceFeed } from "./binance.ts";
import { ConvergenceGraph } from "./convergenceGraph.ts";
import { CryptoQuantFlows, TradingViewInbox } from "./externalSignals.ts";
import { PolymarketClob } from "./polymarket.ts";

// BTC 5-minute UP/DOWN latency engine.
//
// The edge isn't predicting BTC. It's the time gap between (1) spot moving on Binance,
// (2) the signal swarm converging, and (3) the Polymarket CLOB repricing. When spot has
// moved > lagTrigger% since the CLOB last repriced, the fair probability (from spot vs
// the window's open, time left and realised vol) beats the stale ask by more than fees,
// and the swarm agrees, the engine takes the trade. Otherwise it skips and says why.
//
// Execution is PAPER by default. Live order routing is deliberately not implemented
// here: wire your own Polymarket client in LiveExecutor only after checking that
// prediction-market trading is legal for you and accepting the risk.

export interface Executor {
  buy(side: "UP" | "DOWN", price: number, stakeUsd: number): Promise<{ filled: number; price: number }>;
  sell(side: "UP" | "DOWN", price: number, shares: number): Promise<{ price: number }>;
}

export class PaperExecutor implements Executor {
  async buy(_side: "UP" | "DOWN", price: number, stakeUsd: number) {
    const fill = Math.min(0.99, price + 0.002); // assume a tick of slippage
    return { filled: stakeUsd / fill, price: fill };
  }
  async sell(_side: "UP" | "DOWN", price: number) {
    return { price: Math.max(0.01, price - 0.002) };
  }
}

export class LiveExecutor implements Executor {
  async buy(): Promise<never> {
    throw new Error("Live execution is disabled. Implement LiveExecutor with your own Polymarket CLOB client and keys.");
  }
  async sell(): Promise<never> {
    throw new Error("Live execution is disabled.");
  }
}

interface OpenPos {
  trade: LatencyTrade;
  shares: number;
}

export class LatencyEngine extends EventEmitter {
  feed = new BinanceFeed();
  tv = new TradingViewInbox();
  flows = new CryptoQuantFlows();
  graph = new ConvergenceGraph();
  clob: PolymarketClob;
  cfg = { ...config.bot };
  private exec: Executor = new PaperExecutor();
  private open?: OpenPos;
  private timers: NodeJS.Timeout[] = [];
  private evals = 0;
  private evalWindowStart = Date.now();
  private orderTimes: number[] = [];
  private windowStart = 0;
  private windowOpenPrice = 0;
  private volPerSec = 0.00005;
  private lastVolSample = { t: 0, p: 0 };
  private day = new Date().toDateString();
  state: LatencyState;

  constructor() {
    super();
    this.clob = new PolymarketClob(() => this.fairProb());
    this.state = {
      mode: "paper",
      spot: 0,
      windowOpen: 0,
      windowEndsAt: 0,
      clobMid: 0.5,
      fairProb: 0.5,
      lagPct: 0,
      edge: 0,
      lastDecision: "starting",
      skips: {},
      bankroll: this.cfg.bankroll,
      dayPnl: 0,
      dayPnlPct: 0,
      halted: false,
      trades: [],
      feeds: { binance: "connecting", polymarket: "connecting", tradingview: "waiting", cryptoquant: "simulated" },
      evalsPerSec: 0,
    };
  }

  async start() {
    await this.feed.start();
    this.clob.start();
    this.flows.start();
    this.timers.push(setInterval(() => this.graph.update(this.inputs()), 500));
    this.timers.push(setInterval(() => void this.evaluate(), Math.max(5, 1000 / this.cfg.evalHz)));
    this.timers.push(setInterval(() => this.emit("state", this.publicState()), 1000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.feed.stop();
    this.clob.stop();
    this.flows.stop();
  }

  private inputs() {
    return { feed: this.feed, book: this.clob.book, tv: this.tv, flows: this.flows, lagDir: Math.sign(this.lagSigned()) };
  }

  // Fair probability that BTC closes the window above its open.
  fairProb(): number {
    const tau = Math.max(1, (this.windowStart + 300_000 - Date.now()) / 1000);
    if (!this.windowOpenPrice || !this.feed.price) return 0.5;
    const z = Math.log(this.feed.price / this.windowOpenPrice) / (this.volPerSec * Math.sqrt(tau));
    return Math.min(0.995, Math.max(0.005, normCdf(z)));
  }

  private lagSigned(): number {
    const ref = this.feed.priceAt(this.clob.book.updatedAt);
    return ref ? (this.feed.price / ref - 1) * 100 : 0;
  }

  private skip(reason: string, detail: string) {
    this.state.skips[reason] = (this.state.skips[reason] ?? 0) + 1;
    this.state.lastDecision = `skip: ${detail}`;
  }

  private async evaluate() {
    const now = Date.now();
    this.evals++;
    if (now - this.evalWindowStart >= 1000) {
      this.state.evalsPerSec = Math.round((this.evals * 1000) / (now - this.evalWindowStart));
      this.evals = 0;
      this.evalWindowStart = now;
    }
    if (!this.feed.price) return;
    if (new Date().toDateString() !== this.day) {
      this.day = new Date().toDateString();
      this.state.dayPnl = 0;
      this.state.halted = false;
    }
    // EWMA of per-second volatility.
    if (now - this.lastVolSample.t >= 1000) {
      if (this.lastVolSample.p) {
        const r = Math.log(this.feed.price / this.lastVolSample.p) / Math.sqrt((now - this.lastVolSample.t) / 1000);
        this.volPerSec = Math.max(0.00001, Math.sqrt(0.97 * this.volPerSec ** 2 + 0.03 * r * r));
      }
      this.lastVolSample = { t: now, p: this.feed.price };
    }
    const ws = Math.floor(now / 300_000) * 300_000;
    if (ws !== this.windowStart) {
      if (this.open) await this.settle(this.windowOpenPrice);
      this.windowStart = ws;
      this.windowOpenPrice = this.feed.priceAt(ws) ?? this.feed.price;
    }
    const book = this.clob.book;
    const fair = this.fairProb();
    const lag = this.lagSigned();
    const conv = this.graph.snapshot;
    const side: "UP" | "DOWN" = fair >= book.mid ? "UP" : "DOWN";
    const ask = side === "UP" ? book.upAsk : book.downAsk;
    const p = side === "UP" ? fair : 1 - fair;
    const edge = p - ask - this.cfg.feeRate * ask * (1 - ask) * 2;
    Object.assign(this.state, {
      spot: this.feed.price,
      windowOpen: this.windowOpenPrice,
      windowEndsAt: ws + 300_000,
      clobMid: book.mid,
      fairProb: fair,
      lagPct: lag,
      edge,
    });

    if (this.open) return this.manage(now);
    const bankroll = this.state.bankroll;
    if (this.state.halted || this.state.dayPnl <= -bankroll * (this.cfg.dailyLossCapPct / 100)) {
      this.state.halted = true;
      return this.skip("daily-cap", `daily loss cap ${this.cfg.dailyLossCapPct}% hit — halted until tomorrow`);
    }
    if (ws + 300_000 - now < 15_000) return this.skip("window-closing", "<15s left in window");
    if (Math.abs(lag) < this.cfg.lagTriggerPct) return this.skip("no-lag", `CLOB lag ${lag.toFixed(3)}% < ${this.cfg.lagTriggerPct}%`);
    if ((lag > 0 ? "UP" : "DOWN") !== side) return this.skip("signal-conflict", "lag direction disagrees with fair value");
    if (edge < this.cfg.minEdge) return this.skip("no-edge", `edge ${(edge * 100).toFixed(2)}pp < ${(this.cfg.minEdge * 100).toFixed(1)}pp after fees`);
    if ((side === "UP" ? book.upAskDepthUsd : book.downAskDepthUsd) < this.cfg.minDepthUsd) return this.skip("thin-liquidity", "ask depth below minimum");
    if (conv.verdict === "CONFLICT" || (conv.verdict === "BULL") !== (side === "UP")) return this.skip("signal-conflict", `swarm says ${conv.verdict}`);
    this.orderTimes = this.orderTimes.filter((t) => now - t < 1000);
    if (this.orderTimes.length >= this.cfg.maxOrdersPerSec) return this.skip("rate-limit", "order rate cap");

    const t0 = performance.now();
    const stake = bankroll * (this.cfg.perTradeRiskPct / 100);
    try {
      const fill = await this.exec.buy(side, ask, stake);
      this.orderTimes.push(now);
      const trade: LatencyTrade = {
        id: uid("lt_"),
        t: now,
        side,
        entry: fill.price,
        stake,
        status: "open",
        reason: `lag ${lag.toFixed(2)}%, fair ${(p * 100).toFixed(1)}¢ vs ask ${(ask * 100).toFixed(1)}¢, swarm ${conv.verdict} ${(conv.convergence * 100).toFixed(0)}%`,
        latencyMs: Math.round((performance.now() - t0) * 10) / 10,
      };
      this.open = { trade, shares: fill.filled };
      this.state.trades = [trade, ...this.state.trades].slice(0, 200);
      this.state.lastDecision = `ENTER ${side} @ ${(fill.price * 100).toFixed(1)}¢`;
      this.emit("trade", trade);
    } catch (e) {
      this.skip("exec-error", String((e as Error).message));
    }
  }

  // Exit rules (in % of bankroll): take profit between tpMin..tpMax scaled by entry edge,
  // hard stop at -hardStop%, otherwise hold to settlement.
  private async manage(now: number) {
    const o = this.open!;
    const book = this.clob.book;
    const bid = o.trade.side === "UP" ? book.upBid : book.downBid;
    const mtm = o.shares * bid - o.trade.stake;
    const bank = this.state.bankroll;
    const tp = bank * (Math.min(this.cfg.takeProfitMaxPct, Math.max(this.cfg.takeProfitMinPct, this.state.edge * 10)) / 100);
    if (mtm >= tp || mtm <= -bank * (this.cfg.hardStopPct / 100)) {
      const r = await this.exec.sell(o.trade.side, bid, o.shares);
      this.close(o.shares * r.price - o.trade.stake, r.price, mtm >= tp ? "take-profit" : "hard-stop");
    } else if (now >= this.windowStart + 300_000) {
      await this.settle(this.windowOpenPrice);
    }
  }

  private async settle(open: number) {
    const o = this.open;
    if (!o) return;
    const up = this.feed.price >= open;
    const won = (o.trade.side === "UP") === up;
    this.close(won ? o.shares - o.trade.stake : -o.trade.stake, won ? 1 : 0, "settled");
  }

  private close(pnl: number, exit: number, why: string) {
    const o = this.open!;
    Object.assign(o.trade, { exit, pnl, status: "closed", reason: `${o.trade.reason} → ${why}` });
    this.state.bankroll += pnl;
    this.state.dayPnl += pnl;
    this.state.dayPnlPct = (this.state.dayPnl / this.cfg.bankroll) * 100;
    this.state.lastDecision = `EXIT ${o.trade.side} ${why} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
    this.open = undefined;
    this.emit("trade", o.trade);
  }

  publicState(): LatencyState {
    this.state.feeds = { binance: this.feed.status, polymarket: `${this.clob.status}${this.clob.note ? ` (${this.clob.note})` : ""}`, tradingview: this.tv.status, cryptoquant: this.flows.status };
    return { ...this.state };
  }
}
