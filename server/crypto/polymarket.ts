import { config } from "../config.ts";
import { gaussian, mulberry32 } from "../engine/indicators.ts";

// Polymarket CLOB reader for the BTC "Up or Down – 5 minute" markets. Read-only:
// public order books via the CLOB REST API, market discovery via the Gamma API.
// When unreachable it simulates a book whose mid reprices to fair value with a lag.

export interface ClobBook {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  upAskDepthUsd: number;
  downAskDepthUsd: number;
  mid: number; // UP mid probability
  updatedAt: number; // when the mid last changed
}

export class PolymarketClob {
  book: ClobBook = { upBid: 0.49, upAsk: 0.51, downBid: 0.49, downAsk: 0.51, upAskDepthUsd: 500, downAskDepthUsd: 500, mid: 0.5, updatedAt: Date.now() };
  status: "live" | "simulated" | "connecting" = "connecting";
  note = "";
  private tokens = { up: config.crypto.upTokenId, down: config.crypto.downTokenId, window: 0 };
  private timer?: NodeJS.Timeout;
  private rand = mulberry32(99);
  private simFair = 0.5;

  constructor(private fairProb: () => number) {}

  start() {
    if (!config.liveData) return this.simulate("LIVE_DATA=false");
    this.timer = setInterval(() => this.poll().catch((e) => this.fallback(e)), 300);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private fallback(e: unknown) {
    if (this.status !== "simulated") this.simulate(String((e as Error).message ?? e).slice(0, 80));
  }

  private async discover(windowStart: number) {
    if (config.crypto.upTokenId && config.crypto.downTokenId) return;
    if (this.tokens.window === windowStart) return;
    const slug = `${config.crypto.marketSlugPrefix}-${Math.floor(windowStart / 1000)}`;
    const res = await fetch(`${config.crypto.polymarketGamma}/events?slug=${slug}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`gamma ${res.status}`);
    const events = (await res.json()) as { markets?: { clobTokenIds?: string }[] }[];
    const ids = JSON.parse(events[0]?.markets?.[0]?.clobTokenIds ?? "[]") as string[];
    if (ids.length < 2) throw new Error(`no market for ${slug}`);
    this.tokens = { up: ids[0], down: ids[1], window: windowStart };
    this.note = slug;
  }

  private async poll() {
    if (this.status === "simulated") return;
    const windowStart = Math.floor(Date.now() / 300_000) * 300_000;
    await this.discover(windowStart);
    const [up, down] = await Promise.all([this.fetchBook(this.tokens.up), this.fetchBook(this.tokens.down)]);
    const mid = (up.bid + up.ask) / 2;
    this.book = {
      upBid: up.bid,
      upAsk: up.ask,
      downBid: down.bid,
      downAsk: down.ask,
      upAskDepthUsd: up.askDepthUsd,
      downAskDepthUsd: down.askDepthUsd,
      mid,
      updatedAt: Math.abs(mid - this.book.mid) > 1e-6 ? Date.now() : this.book.updatedAt,
    };
    this.status = "live";
  }

  private async fetchBook(token: string) {
    const res = await fetch(`${config.crypto.polymarketClob}/book?token_id=${token}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`clob ${res.status}`);
    const b = (await res.json()) as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };
    const bids = b.bids.map((x) => ({ p: +x.price, s: +x.size })).sort((x, y) => y.p - x.p);
    const asks = b.asks.map((x) => ({ p: +x.price, s: +x.size })).sort((x, y) => x.p - y.p);
    return { bid: bids[0]?.p ?? 0, ask: asks[0]?.p ?? 1, askDepthUsd: asks.slice(0, 3).reduce((a, x) => a + x.p * x.s, 0) };
  }

  // Simulated book: the market maker reprices toward fair value only every ~0.5–2.5 s,
  // which is exactly the lag the engine looks for.
  private simulate(reason: string) {
    this.status = "simulated";
    this.note = reason;
    if (this.timer) clearInterval(this.timer);
    let nextReprice = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now >= nextReprice) {
        this.simFair = Math.min(0.98, Math.max(0.02, this.fairProb() + gaussian(this.rand) * 0.01));
        nextReprice = now + 500 + this.rand() * 2000;
      }
      const half = 0.005 + this.rand() * 0.005;
      const mid = Math.round(this.simFair * 100) / 100;
      this.book = {
        upBid: Math.max(0.01, mid - half),
        upAsk: Math.min(0.99, mid + half),
        downBid: Math.max(0.01, 1 - mid - half),
        downAsk: Math.min(0.99, 1 - mid + half),
        upAskDepthUsd: 100 + this.rand() * 900,
        downAskDepthUsd: 100 + this.rand() * 900,
        mid,
        updatedAt: Math.abs(mid - this.book.mid) > 1e-6 ? now : this.book.updatedAt,
      };
    }, 100);
  }
}
