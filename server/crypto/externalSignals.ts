import { config } from "../config.ts";
import { gaussian, mulberry32 } from "../engine/indicators.ts";

// TradingView: no public API, so signals arrive by TradingView alert webhooks
// (POST /api/crypto/tradingview with {"secret","symbol","signal","timeframe"}).
// Each alert decays with a 10-minute half-life.
export interface TvSignal {
  t: number;
  symbol: string;
  timeframe: string;
  bias: number; // -1..1
  raw: string;
}

const TV_MAP: Record<string, number> = { strong_buy: 1, buy: 0.6, neutral: 0, sell: -0.6, strong_sell: -1, long: 0.7, short: -0.7 };

export class TradingViewInbox {
  signals: TvSignal[] = [];
  lastAt = 0;
  accept(body: { secret?: string; symbol?: string; signal?: string; timeframe?: string; bias?: number }): boolean {
    if (body.secret !== config.crypto.tradingViewSecret) return false;
    const raw = String(body.signal ?? "neutral").toLowerCase().replace(/\s+/g, "_");
    const bias = typeof body.bias === "number" ? Math.max(-1, Math.min(1, body.bias)) : TV_MAP[raw] ?? 0;
    this.signals.push({ t: Date.now(), symbol: String(body.symbol ?? "BTCUSDT"), timeframe: String(body.timeframe ?? "5"), bias, raw });
    this.signals = this.signals.slice(-200);
    this.lastAt = Date.now();
    return true;
  }
  // Decayed bias per timeframe bucket.
  bias(timeframe?: string): number {
    const now = Date.now();
    let s = 0;
    let w = 0;
    for (const x of this.signals) {
      if (timeframe && x.timeframe !== timeframe) continue;
      const d = Math.pow(0.5, (now - x.t) / 600_000);
      s += x.bias * d;
      w += d;
    }
    return w > 0.05 ? s / Math.max(1, w) : 0;
  }
  get status() {
    return this.lastAt && Date.now() - this.lastAt < 3600_000 ? "live" : "waiting for webhook";
  }
}

// CryptoQuant exchange flows (API key required). Netflow > 0 = coins moving onto
// exchanges (sell pressure); < 0 = coins leaving (accumulation). Simulated without a key.
export interface FlowReading {
  netflow: number; // BTC per hour
  netflowZ: number; // vs last 24h
  reserveChange: number; // %
  whaleRatio: number; // 0..1
  source: "cryptoquant" | "simulated";
  t: number;
}

export class CryptoQuantFlows {
  reading: FlowReading = { netflow: 0, netflowZ: 0, reserveChange: 0, whaleRatio: 0.45, source: "simulated", t: Date.now() };
  status = "simulated";
  private rand = mulberry32(7);
  private timer?: NodeJS.Timeout;

  start() {
    const tick = () => (config.crypto.cryptoQuantKey && config.liveData ? this.poll().catch((e) => this.sim(String(e))) : this.sim("no CRYPTOQUANT_API_KEY"));
    tick();
    this.timer = setInterval(tick, config.crypto.cryptoQuantKey ? 300_000 : 5_000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll() {
    const h = { authorization: `Bearer ${config.crypto.cryptoQuantKey}` };
    const base = "https://api.cryptoquant.com/v1/btc";
    const [flows, whale] = await Promise.all([
      fetch(`${base}/exchange-flows/netflow?exchange=all_exchange&window=hour&limit=24`, { headers: h, signal: AbortSignal.timeout(6000) }).then((r) => r.json()),
      fetch(`${base}/flow-indicator/exchange-whale-ratio?exchange=all_exchange&window=hour&limit=1`, { headers: h, signal: AbortSignal.timeout(6000) }).then((r) => r.json()),
    ]);
    const rows = (flows?.result?.data ?? []) as { netflow_total?: number }[];
    const xs = rows.map((r) => Number(r.netflow_total ?? 0));
    if (!xs.length) throw new Error("empty flows");
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    this.reading = {
      netflow: xs[0],
      netflowZ: (xs[0] - m) / sd,
      reserveChange: 0,
      whaleRatio: Number(whale?.result?.data?.[0]?.exchange_whale_ratio ?? 0.45),
      source: "cryptoquant",
      t: Date.now(),
    };
    this.status = "live";
  }

  private sim(note: string) {
    const r = this.reading;
    const z = Math.max(-3, Math.min(3, r.netflowZ * 0.95 + gaussian(this.rand) * 0.25));
    this.reading = { netflow: z * 400, netflowZ: z, reserveChange: z * 0.02, whaleRatio: Math.max(0, Math.min(1, r.whaleRatio + gaussian(this.rand) * 0.01)), source: "simulated", t: Date.now() };
    this.status = `simulated (${note})`;
  }

  // Positive = bullish (outflows), negative = bearish (inflows / whales depositing).
  bias(): number {
    const r = this.reading;
    return Math.max(-1, Math.min(1, -r.netflowZ / 2 - (r.whaleRatio - 0.45) * 2));
  }
}
