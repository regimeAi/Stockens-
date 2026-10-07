import type { Bar, ConvergenceSnapshot, GraphEdge, GraphNode } from "../types.ts";
import { correlation, emaSeries, mean, rsi, std } from "../engine/indicators.ts";
import type { BinanceFeed } from "./binance.ts";
import type { ClobBook } from "./polymarket.ts";
import type { CryptoQuantFlows, TradingViewInbox } from "./externalSignals.ts";

// Force-graph signal engine (MiroFish-style swarm view): 100 signal nodes, the 180
// strongest co-movement edges between them, and label propagation to find BULL / BEAR
// clusters. Convergence = how much of the signal mass agrees on one side.

export const NODE_COUNT = 100;
export const EDGE_COUNT = 180;

interface Inputs {
  feed: BinanceFeed;
  book: ClobBook;
  tv: TradingViewInbox;
  flows: CryptoQuantFlows;
  lagDir: number; // +1 spot ran ahead up, -1 down, 0 none
}

type NodeDef = { id: string; group: string; f: (x: Inputs, now: number) => number };

const tanh = Math.tanh;

function windowTrades(feed: BinanceFeed, now: number, sec: number) {
  const from = now - sec * 1000;
  const out = [];
  for (let i = feed.trades.length - 1; i >= 0 && feed.trades[i].t >= from; i--) out.push(feed.trades[i]);
  return out;
}

function kl(feed: BinanceFeed): number[] {
  return feed.klines5m.map((k: Bar) => k.c);
}

function defs(): NodeDef[] {
  const d: NodeDef[] = [];
  for (const s of [2, 5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 300])
    d.push({ id: `flow_${s}s`, group: "Trade flow", f: ({ feed }, now) => {
      const w = windowTrades(feed, now, s);
      const b = w.filter((x) => x.buy).reduce((a, x) => a + x.q, 0);
      const t = w.reduce((a, x) => a + x.q, 0);
      return t ? (2 * b) / t - 1 : 0;
    } });
  for (const s of [5, 15, 30, 60, 120, 300])
    d.push({ id: `whale_flow_${s}s`, group: "Trade flow", f: ({ feed }, now) => {
      const w = windowTrades(feed, now, s);
      const qs = w.map((x) => x.q).sort((a, b) => a - b);
      const cut = qs[Math.floor(qs.length * 0.9)] ?? Infinity;
      const big = w.filter((x) => x.q >= cut);
      const b = big.filter((x) => x.buy).reduce((a, x) => a + x.q, 0);
      const t = big.reduce((a, x) => a + x.q, 0);
      return t ? (2 * b) / t - 1 : 0;
    } });
  for (const s of [1, 3, 5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600])
    d.push({ id: `mom_${s}s`, group: "Spot momentum", f: ({ feed }, now) => {
      const p0 = feed.priceAt(now - s * 1000);
      return p0 ? tanh(((feed.price / p0 - 1) * 1e4) / (4 * Math.sqrt(s))) : 0;
    } });
  for (const s of [5, 10, 30, 60, 120, 300])
    d.push({ id: `accel_${s}s`, group: "Spot momentum", f: ({ feed }, now) => {
      const a = feed.priceAt(now - s * 1000);
      const b = feed.priceAt(now - 2 * s * 1000);
      return a && b ? tanh(((feed.price / a - 1 - (a / b - 1)) * 1e4) / (4 * Math.sqrt(s))) : 0;
    } });
  for (const s of [10, 30, 60, 120, 300, 600])
    d.push({ id: `vwap_dev_${s}s`, group: "Spot momentum", f: ({ feed }, now) => {
      const w = windowTrades(feed, now, s);
      const v = w.reduce((a, x) => a + x.q, 0);
      const vwap = v ? w.reduce((a, x) => a + x.p * x.q, 0) / v : feed.price;
      return tanh(((feed.price / vwap - 1) * 1e4) / 5);
    } });
  for (const [a, b] of [[3, 8], [5, 13], [8, 21], [13, 34], [21, 55], [34, 89]])
    d.push({ id: `ema_${a}_${b}`, group: "5m klines", f: ({ feed }) => {
      const c = kl(feed);
      const ea = emaSeries(c, a).at(-1) ?? 0;
      const eb = emaSeries(c, b).at(-1) ?? 1;
      return tanh(((ea / eb - 1) * 1e4) / 20);
    } });
  for (const n of [6, 9, 14, 21, 28]) d.push({ id: `rsi_${n}`, group: "5m klines", f: ({ feed }) => (rsi(kl(feed), n) - 50) / 50 });
  for (const [f, s, g] of [[12, 26, 9], [5, 35, 5], [8, 17, 9]])
    d.push({ id: `macd_${f}_${s}_${g}`, group: "5m klines", f: ({ feed }) => {
      const c = kl(feed);
      const ef = emaSeries(c, f);
      const es = emaSeries(c, s);
      const m = ef.map((x, i) => x - es[i]);
      const sig = emaSeries(m, g);
      return tanh(((m.at(-1)! - sig.at(-1)!) / (c.at(-1) || 1)) * 1e4 / 5);
    } });
  for (const n of [1, 2, 3, 6, 12, 24, 48, 96])
    d.push({ id: `kmom_${n}`, group: "5m klines", f: ({ feed }) => {
      const c = kl(feed);
      return c.length > n ? tanh(((c.at(-1)! / c.at(-1 - n)! - 1) * 1e4) / (10 * Math.sqrt(n))) : 0;
    } });
  for (const n of [3, 6, 12, 24])
    d.push({ id: `vwmom_${n}`, group: "5m klines", f: ({ feed }) => {
      const k = feed.klines5m.slice(-n);
      const v = k.reduce((a, b) => a + b.v, 0);
      return v ? tanh((k.reduce((a, b) => a + (b.c / b.o - 1) * b.v, 0) / v) * 1e4 / 8) : 0;
    } });
  for (const n of [10, 20, 40])
    d.push({ id: `boll_${n}`, group: "5m klines", f: ({ feed }) => {
      const c = kl(feed).slice(-n);
      const s = std(c);
      return s ? tanh((c.at(-1)! - mean(c)) / s / 2) : 0;
    } });
  for (const n of [12, 24, 48, 96])
    d.push({ id: `donchian_${n}`, group: "5m klines", f: ({ feed }) => {
      const k = feed.klines5m.slice(-n);
      const hi = Math.max(...k.map((x) => x.h));
      const lo = Math.min(...k.map((x) => x.l));
      return hi > lo ? ((feed.price - lo) / (hi - lo)) * 2 - 1 : 0;
    } });
  for (const n of [6, 12, 24, 48])
    d.push({ id: `hhll_${n}`, group: "5m klines", f: ({ feed }) => {
      const k = feed.klines5m.slice(-n);
      let s = 0;
      for (let i = 1; i < k.length; i++) s += (k[i].h > k[i - 1].h ? 1 : 0) - (k[i].l < k[i - 1].l ? 1 : 0);
      return k.length > 1 ? s / (k.length - 1) : 0;
    } });
  for (const n of [1, 3, 6, 12])
    d.push({ id: `body_${n}`, group: "5m klines", f: ({ feed }) => {
      const k = feed.klines5m.slice(-n);
      return mean(k.map((x) => (x.h > x.l ? (x.c - x.o) / (x.h - x.l) : 0)));
    } });
  d.push({ id: "book_imbalance", group: "Order book", f: ({ feed }) => {
    const { bidQty: b, askQty: a } = feed.book;
    return a + b ? (b - a) / (a + b) : 0;
  } });
  d.push({ id: "microprice", group: "Order book", f: ({ feed }) => {
    const { bid, ask, bidQty, askQty } = feed.book;
    if (!bid || !ask) return 0;
    const micro = (bid * askQty + ask * bidQty) / (bidQty + askQty);
    return tanh(((micro / ((bid + ask) / 2) - 1) * 1e5) / 2);
  } });
  d.push({ id: "poly_mid", group: "Polymarket", f: ({ book }) => (book.mid - 0.5) * 2 });
  d.push({ id: "poly_lag", group: "Polymarket", f: ({ lagDir }) => lagDir });
  d.push({ id: "poly_depth", group: "Polymarket", f: ({ book }) => {
    const t = book.upAskDepthUsd + book.downAskDepthUsd;
    return t ? (book.downAskDepthUsd - book.upAskDepthUsd) / t : 0; // thin UP asks = buyers lifted them
  } });
  for (const tf of ["1", "5", "15", "60", "240"]) d.push({ id: `tv_${tf}`, group: "TradingView", f: ({ tv }) => tv.bias(tf) });
  d.push({ id: "tv_all", group: "TradingView", f: ({ tv }) => tv.bias() });
  d.push({ id: "cq_netflow", group: "CryptoQuant", f: ({ flows }) => tanh(-flows.reading.netflowZ / 1.5) });
  d.push({ id: "cq_whales", group: "CryptoQuant", f: ({ flows }) => tanh(-(flows.reading.whaleRatio - 0.45) * 8) });
  d.push({ id: "cq_reserve", group: "CryptoQuant", f: ({ flows }) => tanh(-flows.reading.reserveChange * 20) });
  return d;
}

export class ConvergenceGraph {
  private defs = defs();
  private hist = new Map<string, number[]>();
  private edges: GraphEdge[] = [];
  private lastEdgeAt = 0;
  snapshot: ConvergenceSnapshot = { nodes: [], edges: [], bullMass: 0, bearMass: 0, convergence: 0, verdict: "CONFLICT" };

  constructor() {
    if (this.defs.length !== NODE_COUNT) throw new Error(`graph expects ${NODE_COUNT} nodes, built ${this.defs.length}`);
  }

  update(x: Inputs, now = Date.now()): ConvergenceSnapshot {
    const biases = this.defs.map((d) => {
      let b = 0;
      try {
        b = d.f(x, now);
      } catch {
        b = 0;
      }
      b = Number.isFinite(b) ? Math.max(-1, Math.min(1, b)) : 0;
      const h = this.hist.get(d.id) ?? [];
      h.push(b);
      if (h.length > 90) h.shift();
      this.hist.set(d.id, h);
      return b;
    });
    if (now - this.lastEdgeAt > 5000 || !this.edges.length) {
      this.edges = this.buildEdges();
      this.lastEdgeAt = now;
    }
    // Label propagation: each node blends its own sign with its neighbours' (signed by edge correlation).
    const idx = new Map(this.defs.map((d, i) => [d.id, i]));
    let score = biases.slice();
    for (let iter = 0; iter < 5; iter++) {
      const next = biases.map((b) => b * 0.6);
      const wsum = new Array(NODE_COUNT).fill(0);
      for (const e of this.edges) {
        const a = idx.get(e.source)!;
        const c = idx.get(e.target)!;
        next[a] += 0.4 * e.w * score[c];
        next[c] += 0.4 * e.w * score[a];
        wsum[a] += Math.abs(e.w);
        wsum[c] += Math.abs(e.w);
      }
      score = next.map((v, i) => (wsum[i] ? v / Math.max(1, wsum[i] * 0.4 + 0.6) : v));
    }
    const nodes: GraphNode[] = this.defs.map((d, i) => ({
      id: d.id,
      group: d.group,
      bias: biases[i],
      weight: 1 + this.edges.filter((e) => e.source === d.id || e.target === d.id).length / 4,
      cluster: score[i] > 0.12 ? "BULL" : score[i] < -0.12 ? "BEAR" : "NEUTRAL",
    }));
    const bullMass = nodes.filter((n) => n.cluster === "BULL").reduce((a, n) => a + n.weight * Math.abs(n.bias), 0);
    const bearMass = nodes.filter((n) => n.cluster === "BEAR").reduce((a, n) => a + n.weight * Math.abs(n.bias), 0);
    const total = nodes.reduce((a, n) => a + n.weight * Math.abs(n.bias), 0) || 1;
    const convergence = (bullMass - bearMass) / total;
    this.snapshot = {
      nodes,
      edges: this.edges,
      bullMass,
      bearMass,
      convergence,
      verdict: convergence > 0.35 ? "BULL" : convergence < -0.35 ? "BEAR" : "CONFLICT",
    };
    return this.snapshot;
  }

  private buildEdges(): GraphEdge[] {
    const ids = this.defs.map((d) => d.id);
    const cand: GraphEdge[] = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.hist.get(ids[i]) ?? [];
        const b = this.hist.get(ids[j]) ?? [];
        let w = a.length > 10 ? correlation(a, b) : 0;
        // Before enough history exists, connect nodes from the same family.
        if (!w && this.defs[i].group === this.defs[j].group) w = 0.3 + 0.001 * (j - i);
        if (Number.isFinite(w) && w !== 0) cand.push({ source: ids[i], target: ids[j], w });
      }
    return cand.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, EDGE_COUNT);
  }
}
