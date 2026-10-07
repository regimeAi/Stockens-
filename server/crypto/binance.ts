import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.ts";
import type { Bar } from "../types.ts";
import { gaussian, mulberry32 } from "../engine/indicators.ts";

// Binance public market data: trades + 5m klines + top-of-book for BTC, and mini-tickers
// for the other tracked coins. Falls back to a jumpy random walk when offline.

export const COIN_PAIRS: Record<string, string> = { BTC: "btcusdt", ETH: "ethusdt", SOL: "solusdt", DOGE: "dogeusdt", PEPE: "pepeusdt" };

export interface BookTop {
  bidQty: number;
  askQty: number;
  bid: number;
  ask: number;
}

export class BinanceFeed extends EventEmitter {
  price = 0;
  lastTradeT = 0;
  klines5m: Bar[] = [];
  book: BookTop = { bid: 0, ask: 0, bidQty: 0, askQty: 0 };
  prices: Record<string, number> = {};
  trades: { t: number; p: number; q: number; buy: boolean }[] = []; // rolling 10 min
  status: "live" | "simulated" | "connecting" = "connecting";
  private ws?: WebSocket;
  private simTimer?: NodeJS.Timeout;
  private retries = 0;

  async start() {
    if (!config.liveData) return this.simulate("LIVE_DATA=false");
    try {
      const res = await fetch(`${config.crypto.binanceRest}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=500`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`klines ${res.status}`);
      const rows = (await res.json()) as (string | number)[][];
      this.klines5m = rows.map((r) => ({ t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      this.price = this.klines5m.at(-1)?.c ?? 0;
      this.connect();
    } catch (e) {
      this.simulate(String((e as Error).message));
    }
  }

  private connect() {
    const streams = ["btcusdt@trade", "btcusdt@kline_5m", "btcusdt@bookTicker", ...Object.values(COIN_PAIRS).map((p) => `${p}@miniTicker`)];
    this.ws = new WebSocket(`${config.crypto.binanceWs}?streams=${streams.join("/")}`);
    this.ws.on("open", () => {
      this.status = "live";
      this.retries = 0;
      this.emit("status", "live");
    });
    this.ws.on("message", (raw) => {
      const { stream, data } = JSON.parse(raw.toString());
      if (stream.endsWith("@trade")) this.onTrade(data.T, +data.p, +data.q, !data.m);
      else if (stream.endsWith("@kline_5m")) this.onKline({ t: data.k.t, o: +data.k.o, h: +data.k.h, l: +data.k.l, c: +data.k.c, v: +data.k.v });
      else if (stream.endsWith("@bookTicker")) this.book = { bid: +data.b, bidQty: +data.B, ask: +data.a, askQty: +data.A };
      else if (stream.endsWith("@miniTicker")) {
        const coin = Object.entries(COIN_PAIRS).find(([, p]) => p === data.s.toLowerCase())?.[0];
        if (coin) this.prices[coin] = +data.c;
      }
    });
    this.ws.on("close", () => this.reconnect());
    this.ws.on("error", () => this.ws?.close());
  }

  private reconnect() {
    this.status = "connecting";
    if (++this.retries > 5) return this.simulate("websocket unavailable");
    setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** this.retries));
  }

  private onTrade(t: number, p: number, q: number, buy: boolean) {
    this.price = p;
    this.prices.BTC = p;
    this.lastTradeT = t;
    this.trades.push({ t, p, q, buy });
    const cutoff = t - 600_000;
    if (this.trades.length > 50_000 || this.trades[0]?.t < cutoff) this.trades = this.trades.filter((x) => x.t >= cutoff);
    this.emit("tick", p, t);
  }

  private onKline(k: Bar) {
    const last = this.klines5m.at(-1);
    if (last && last.t === k.t) this.klines5m[this.klines5m.length - 1] = k;
    else {
      this.klines5m.push(k);
      if (this.klines5m.length > 600) this.klines5m.shift();
    }
  }

  // Offline mode: 10 Hz random walk with occasional jumps so the latency engine has
  // something to react to. Clearly labelled as simulated everywhere it appears.
  private simulate(reason: string) {
    this.status = "simulated";
    this.emit("status", `simulated (${reason})`);
    const rand = mulberry32(Date.now() & 0xffff);
    let p = this.price || 121_000;
    if (!this.klines5m.length) {
      const now = Math.floor(Date.now() / 300_000) * 300_000;
      let q = p;
      for (let i = 499; i >= 0; i--) {
        const o = q;
        q *= 1 + gaussian(rand) * 0.0018;
        this.klines5m.push({ t: now - i * 300_000, o, h: Math.max(o, q) * 1.0008, l: Math.min(o, q) * 0.9992, c: q, v: 50 + rand() * 100 });
      }
      p = q;
    }
    const alt: Record<string, number> = { ETH: 4500, SOL: 225, DOGE: 0.26, PEPE: 0.0000105 };
    this.simTimer = setInterval(() => {
      const jump = rand() < 0.004 ? gaussian(rand) * 0.004 : 0;
      p *= 1 + gaussian(rand) * 0.00012 + jump;
      const t = Date.now();
      const spread = p * 0.00001;
      this.book = { bid: p - spread, ask: p + spread, bidQty: 1 + rand() * 4, askQty: 1 + rand() * 4 };
      for (const k of Object.keys(alt)) this.prices[k] = alt[k] *= 1 + gaussian(rand) * 0.0003;
      this.onTrade(t, p, rand() * 0.5, rand() > 0.5 - jump * 50);
      const bucket = Math.floor(t / 300_000) * 300_000;
      const last = this.klines5m.at(-1)!;
      this.onKline(last.t === bucket ? { ...last, h: Math.max(last.h, p), l: Math.min(last.l, p), c: p, v: last.v + 0.1 } : { t: bucket, o: p, h: p, l: p, c: p, v: 0.1 });
    }, 100);
  }

  stop() {
    this.ws?.removeAllListeners();
    this.ws?.close();
    if (this.simTimer) clearInterval(this.simTimer);
  }

  // Price at (or just before) time t from the trade buffer.
  priceAt(t: number): number | undefined {
    for (let i = this.trades.length - 1; i >= 0; i--) if (this.trades[i].t <= t) return this.trades[i].p;
    return undefined;
  }
}
