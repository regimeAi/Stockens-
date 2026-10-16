import type { Anomaly, AnomalyKind, Forecast } from "../types.ts";
import { uid } from "./indicators.ts";

// Forecast anomaly detection. Each symbol's forecasts are tracked over time and compared
// with that symbol's own recent behaviour (robust median/MAD statistics, so one odd reading
// doesn't distort the baseline), with its peers, and — after five days — with what really
// happened. Anything unusual becomes an Anomaly with a severity and a plain-English reason.

export interface Snapshot {
  t: number;
  exp: number; // 5-day expected return, %
  conf: number;
  band: number; // 80% band width, %
  price: number;
  split: number; // spread between model votes, %
}

export interface DetectorOptions {
  sampleMs: number; // keep at most one snapshot per symbol per sampleMs
  historyMs: number; // how far back the baseline looks
  minHistory: number; // snapshots needed before history-based checks fire
  cooldownMs: number; // quiet period per symbol+kind after an anomaly
}

const DEFAULTS: DetectorOptions = { sampleMs: 60_000, historyMs: 12 * 3600_000, minHistory: 20, cooldownMs: 3 * 3600_000 };

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Robust z-score: distance from the median in units of (scaled) median absolute deviation.
// `floor` stops a near-constant history from turning tiny wiggles into huge z-scores.
export function robustZ(x: number, xs: number[], floor: number): number {
  const m = median(xs);
  const mad = median(xs.map((v) => Math.abs(v - m))) * 1.4826;
  return (x - m) / Math.max(mad, floor);
}

const sev = (v: number, s2: number, s3: number): 1 | 2 | 3 => (v >= s3 ? 3 : v >= s2 ? 2 : 1);
const mins = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? "about a minute" : `about ${m} minutes`;
};
const pct = (x: number, d = 2) => `${x > 0 ? "+" : ""}${x.toFixed(d)}%`;

export function snapshotOf(f: Forecast, t = Date.now()): Snapshot {
  const h = f.horizons.find((x) => x.horizon === "5d")!;
  const votes = f.modelVotes.map((v) => v.expectedReturn);
  return {
    t,
    exp: h.expectedReturn,
    conf: h.confidence,
    band: h.bandHigh - h.bandLow,
    price: f.price,
    split: votes.length ? Math.max(...votes) - Math.min(...votes) : 0,
  };
}

export class AnomalyDetector {
  opts: DetectorOptions;
  private hist = new Map<string, Snapshot[]>();
  private lastFired = new Map<string, number>();

  constructor(opts: Partial<DetectorOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  history(symbol: string) {
    return this.hist.get(symbol) ?? [];
  }

  private fire(out: Anomaly[], symbol: string, kind: AnomalyKind, severity: 1 | 2 | 3, title: string, detail: string, metric: number, now: number) {
    const key = `${symbol}|${kind}`;
    const last = this.lastFired.get(key) ?? 0;
    if (now - last < this.opts.cooldownMs) return;
    this.lastFired.set(key, now);
    out.push({ id: uid("an_"), t: now, symbol, kind, severity, title, detail, metric: Math.round(metric * 100) / 100 });
  }

  // Compare the newest forecast with the symbol's own history. atrPct = typical daily move (%).
  observe(f: Forecast, atrPct: number, now = Date.now()): Anomaly[] {
    const out: Anomaly[] = [];
    const s = snapshotOf(f, now);
    const all = this.hist.get(f.symbol) ?? [];
    const base = all.filter((x) => now - x.t <= this.opts.historyMs);
    const sym = f.symbol;

    if (base.length >= this.opts.minHistory) {
      // 1. Forecast jump — the 5-day call is far outside its usual range.
      const zExp = robustZ(s.exp, base.map((x) => x.exp), 0.15);
      const moved = s.exp - median(base.map((x) => x.exp));
      if (Math.abs(zExp) >= 3 && Math.abs(moved) >= 0.5)
        this.fire(out, sym, "forecast-jump", sev(Math.abs(zExp), 4, 6), `${sym} forecast jumped ${moved > 0 ? "up" : "down"}`,
          `5-day forecast is now ${pct(s.exp)} vs a typical ${pct(s.exp - moved)} — ${Math.abs(zExp).toFixed(1)}× its normal variation.`, zExp, now);

      // 2. Confidence shift over roughly the last hour.
      const hourAgo = base.filter((x) => now - x.t >= 50 * 60_000).at(-1) ?? base[0];
      const dConf = s.conf - hourAgo.conf;
      if (Math.abs(dConf) >= 20)
        this.fire(out, sym, "confidence-shift", sev(Math.abs(dConf), 25, 35), `${sym} confidence ${dConf > 0 ? "surged" : "collapsed"}`,
          `Confidence went from ${hourAgo.conf} to ${s.conf} (${dConf > 0 ? "+" : ""}${dConf} points) in ${mins(now - hourAgo.t)}.`, dConf, now);

      // 3. Direction flip with conviction.
      const recentSign = Math.sign(median(base.slice(-Math.min(base.length, 30)).map((x) => x.exp)));
      if (recentSign !== 0 && Math.sign(s.exp) === -recentSign && Math.abs(s.exp) >= 0.5 && s.conf >= 40)
        this.fire(out, sym, "direction-flip", s.conf >= 60 ? 3 : 2, `${sym} forecast flipped ${s.exp > 0 ? "bullish" : "bearish"}`,
          `The 5-day call turned ${s.exp > 0 ? "positive" : "negative"} (${pct(s.exp)}) with confidence ${s.conf}, after leaning the other way.`, s.exp, now);

      // 4. Uncertainty shock — the confidence band blew out.
      const bandRatio = s.band / Math.max(median(base.map((x) => x.band)), 1e-6);
      if (bandRatio >= 1.5)
        this.fire(out, sym, "uncertainty-shock", sev(bandRatio, 2, 3), `${sym} uncertainty spiked`,
          `The 80% forecast band is ${bandRatio.toFixed(1)}× its usual width (${s.band.toFixed(1)}% wide). Expect bigger, less predictable moves.`, bandRatio, now);

      // 5. Models splitting far more than usual.
      const zSplit = robustZ(s.split, base.map((x) => x.split), 0.1);
      if (zSplit >= 4 && s.split >= 1)
        this.fire(out, sym, "model-split", sev(zSplit, 6, 9), `${sym} models disagree`,
          `The ensemble's models are ${s.split.toFixed(1)} points apart (${zSplit.toFixed(1)}× normal). Treat the forecast as low-conviction until they converge.`, zSplit, now);

      // 6. Price running hard against the forecast made ~an hour ago.
      if (atrPct > 0 && Math.abs(hourAgo.exp) >= 0.3) {
        const move = (s.price / hourAgo.price - 1) * 100;
        const against = -Math.sign(hourAgo.exp) * move; // positive = against the call
        const inAtr = against / atrPct;
        if (inAtr >= 1)
          this.fire(out, sym, "price-vs-forecast", sev(inAtr, 1.5, 2.5), `${sym} moving against its forecast`,
            `Price is ${pct(move)} since the ${hourAgo.exp > 0 ? "bullish" : "bearish"} call — ${inAtr.toFixed(1)}× a normal day's range the wrong way. Check stops.`, inAtr, now);
      }
    }

    if (!all.length || now - all[all.length - 1].t >= this.opts.sampleMs) {
      all.push(s);
      while (all.length && now - all[0].t > this.opts.historyMs) all.shift();
      this.hist.set(sym, all);
    }
    return out;
  }

  // 7. Peer outliers — a forecast far from comparable assets (same asset class).
  peers(groups: Map<string, Forecast[]>, now = Date.now()): Anomaly[] {
    const out: Anomaly[] = [];
    for (const [group, fs] of groups) {
      if (fs.length < 8) continue;
      const exps = fs.map((f) => snapshotOf(f).exp);
      for (const f of fs) {
        const e = snapshotOf(f).exp;
        const z = robustZ(e, exps, 0.2);
        if (Math.abs(z) >= 3.5 && Math.abs(e) >= 1)
          this.fire(out, f.symbol, "peer-outlier", Math.abs(z) >= 6 ? 2 : 1, `${f.symbol} stands out from other ${group}`,
            `Its 5-day forecast (${pct(e)}) is ${Math.abs(z).toFixed(1)}× further from the ${group} median (${pct(median(exps))}) than usual.`, z, now);
      }
    }
    return out;
  }
}

// 8. Forecast misses: keep one 5-day forecast per symbol per day and, five bars later,
// check whether the real move landed inside the 80% band. Also yields calibration stats.
export interface ForecastLogEntry {
  symbol: string;
  barT: number; // timestamp of the daily bar the forecast was made on
  price: number;
  exp: number;
  low: number;
  high: number;
  realized?: number;
  inside?: boolean;
}

export function checkMisses(
  log: ForecastLogEntry[],
  barsFor: (s: string) => { t: number; c: number }[] | undefined,
  now = Date.now(),
): { log: ForecastLogEntry[]; misses: Omit<Anomaly, "id">[] } {
  const misses: Omit<Anomaly, "id">[] = [];
  const next = log.map((e) => {
    if (e.realized !== undefined) return e;
    const bars = barsFor(e.symbol);
    if (!bars) return e;
    const i = bars.findIndex((b) => b.t === e.barT);
    if (i < 0 || i + 5 >= bars.length) return e;
    const realized = (bars[i + 5].c / e.price - 1) * 100;
    const inside = realized >= e.low && realized <= e.high;
    if (!inside) {
      const width = Math.max(e.high - e.low, 0.1);
      const outBy = realized > e.high ? realized - e.high : e.low - realized;
      misses.push({
        t: now,
        symbol: e.symbol,
        kind: "forecast-miss",
        severity: sev(outBy / width, 0.5, 1),
        title: `${e.symbol} broke out of its forecast range`,
        detail: `Five days ago the 80% range was ${pct(e.low, 1)} to ${pct(e.high, 1)}; the actual move was ${pct(realized, 1)}. Something the models didn't see is driving it.`,
        metric: Math.round((outBy / width) * 100) / 100,
      });
    }
    return { ...e, realized, inside };
  });
  return { log: next, misses };
}

export function calibration(log: ForecastLogEntry[], sinceMs = 30 * 86_400_000, now = Date.now()) {
  const done = log.filter((e) => e.inside !== undefined && now - e.barT <= sinceMs + 7 * 86_400_000);
  return { checked: done.length, insideRate: done.length ? done.filter((e) => e.inside).length / done.length : undefined };
}
