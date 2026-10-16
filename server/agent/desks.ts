import type { Forecast, Instrument, NewsItem } from "../types.ts";
import { CIK } from "../data/universe.ts";
import { cikFor, macroHeadlines, nameMatcher, secFilings, yahooHeadlines } from "../data/news.ts";
import type { PolygonSource } from "../data/sources.ts";
import { scoreHeadline } from "../engine/sentiment.ts";
import { config } from "../config.ts";

// Sector desks: one background agent per slice of the market. Each desk owns its symbols,
// combs them for news and SEC filings at a polite pace, and keeps a running brief of its
// sector (tone, breadth, leaders, laggards, catalysts). A macro desk reads market-wide feeds
// and routes any company it recognises to the right ticker.

export interface DeskHost {
  forecasts: Map<string, Forecast>;
  mergeNews(symbol: string, items: NewsItem[]): void;
  push(item: { kind: "news" | "regime"; symbol?: string; title: string; body: string }): void;
  recentAnomalies(symbols: Set<string>, sinceMs: number): number;
  polygon: PolygonSource;
}

export interface DeskBrief {
  id: string;
  name: string;
  kind: "sector" | "macro";
  symbols: number;
  status: string;
  coverage: number; // share of names with real (non-simulated) news
  lastSweepAt?: number;
  tone: "bullish" | "bearish" | "mixed";
  avgForecast: number; // average 5-day forecast, %
  breadth: number; // share of names forecast to rise
  sentiment: number;
  leaders: { symbol: string; exp: number; conf: number }[];
  laggards: { symbol: string; exp: number; conf: number }[];
  catalysts: { symbol: string; headline: string; source: string; url?: string; t: number }[];
  anomalies24h: number;
}

const toneOf = (avg: number, sent: number): DeskBrief["tone"] => (avg > 0.3 && sent > -0.1 ? "bullish" : avg < -0.3 && sent < 0.1 ? "bearish" : "mixed");

export class SectorDesk {
  private cursor = 0;
  private busy = false;
  private realNews = new Set<string>();
  private filingsAt = new Map<string, number>();
  private errors = 0;
  private lastTone?: DeskBrief["tone"];
  lastSweepAt?: number;
  status = "starting";

  constructor(
    readonly id: string,
    readonly name: string,
    readonly members: Instrument[],
    private host: DeskHost,
  ) {}

  // One small step: the next two names get fresh headlines (and filings every 6 hours).
  async tick() {
    if (this.busy || !config.liveData || !this.members.length) return;
    this.busy = true;
    try {
      for (let k = 0; k < 2; k++) {
        const inst = this.members[this.cursor];
        this.cursor = (this.cursor + 1) % this.members.length;
        if (this.cursor === 0) this.lastSweepAt = Date.now();
        await this.comb(inst);
      }
      this.status = this.errors > 5 ? `errors fetching news (${this.errors})` : "combing";
    } finally {
      this.busy = false;
    }
  }

  private async comb(inst: Instrument) {
    const items: NewsItem[] = [];
    try {
      items.push(...(this.host.polygon.enabled() ? await this.host.polygon.news(inst.symbol) : await yahooHeadlines(inst.symbol, inst.assetClass === "crypto")));
    } catch {
      this.errors++;
    }
    const cik = inst.assetClass === "equity" ? (CIK.get(inst.symbol) ?? (await cikFor(inst.symbol))) : undefined;
    if (cik && Date.now() - (this.filingsAt.get(inst.symbol) ?? 0) > 6 * 3600_000) {
      this.filingsAt.set(inst.symbol, Date.now());
      try {
        items.push(...(await secFilings(inst.symbol, cik)));
      } catch {
        this.errors++;
      }
    }
    if (items.length) {
      this.errors = Math.max(0, this.errors - 1);
      this.realNews.add(inst.symbol);
      this.host.mergeNews(inst.symbol, items);
    }
  }

  brief(): DeskBrief {
    const fs = this.members.map((m) => this.host.forecasts.get(m.symbol)).filter((f): f is Forecast => !!f);
    const h5 = (f: Forecast) => f.horizons.find((h) => h.horizon === "5d")!;
    const avg = fs.length ? fs.reduce((a, f) => a + h5(f).expectedReturn, 0) / fs.length : 0;
    const sent = fs.length ? fs.reduce((a, f) => a + f.sentiment.score, 0) / fs.length : 0;
    const ranked = [...fs].map((f) => ({ symbol: f.symbol, exp: h5(f).expectedReturn, conf: h5(f).confidence })).sort((a, b) => b.exp * b.conf - a.exp * a.conf);
    const tone = toneOf(avg, sent);
    if (this.lastTone && tone !== this.lastTone && tone !== "mixed")
      this.host.push({ kind: "regime", title: `${this.name} desk turned ${tone}`, body: `Average 5-day forecast ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%, ${Math.round((fs.filter((f) => h5(f).expectedReturn > 0).length / Math.max(1, fs.length)) * 100)}% of names forecast to rise.` });
    this.lastTone = tone;
    return {
      id: this.id,
      name: this.name,
      kind: "sector",
      symbols: this.members.length,
      status: config.liveData ? this.status : "simulated (LIVE_DATA=false)",
      coverage: this.members.length ? this.realNews.size / this.members.length : 0,
      lastSweepAt: this.lastSweepAt,
      tone,
      avgForecast: avg,
      breadth: fs.length ? fs.filter((f) => h5(f).expectedReturn > 0).length / fs.length : 0,
      sentiment: sent,
      leaders: ranked.slice(0, 3),
      laggards: ranked.slice(-3).reverse(),
      catalysts: [], // filled by the host from the merged news
      anomalies24h: this.host.recentAnomalies(new Set(this.members.map((m) => m.symbol)), 86_400_000),
    };
  }
}

export class MacroDesk {
  headlines: { title: string; link?: string; t: number; source: string; sentiment: number; symbols: string[] }[] = [];
  status = "starting";
  lastSweepAt?: number;
  private match: (text: string) => string[];

  constructor(universe: Instrument[], private host: DeskHost) {
    this.match = nameMatcher(universe.filter((u) => u.assetClass === "equity"));
  }

  async sweep() {
    if (!config.liveData) {
      this.status = "simulated (LIVE_DATA=false)";
      return;
    }
    const res = await macroHeadlines(config.macroFeeds);
    const fresh: MacroDesk["headlines"] = [];
    for (const r of res) {
      const source = new URL(r.feed).host.replace(/^www\.|^feeds\.|^search\./, "");
      for (const it of r.items) {
        const symbols = this.match(`${it.title} ${it.summary ?? ""}`);
        fresh.push({ title: it.title, link: it.link, t: it.t, source, sentiment: scoreHeadline(`${it.title} ${it.summary ?? ""}`), symbols });
        for (const s of symbols)
          this.host.mergeNews(s, [{ id: `mx_${Buffer.from(it.link ?? it.title).toString("base64url").slice(-24)}`, symbol: s, t: it.t, headline: it.title, source, url: it.link, sentiment: scoreHeadline(it.title) }]);
      }
    }
    const ok = res.filter((r) => !r.error).length;
    this.status = ok ? `${ok}/${res.length} feeds live` : `feeds unreachable (${res[0]?.error ?? "no feeds"})`;
    if (fresh.length) {
      this.headlines = fresh.sort((a, b) => b.t - a.t).slice(0, 60);
      this.lastSweepAt = Date.now();
    }
  }

  tone() {
    const recent = this.headlines.filter((h) => Date.now() - h.t < 2 * 86_400_000);
    return recent.length ? recent.reduce((a, h) => a + h.sentiment, 0) / recent.length : 0;
  }
}
