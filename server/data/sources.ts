import * as cheerio from "cheerio";
import { config } from "../config.ts";
import type { Bar, Fundamentals, NewsItem, SourceStatus } from "../types.ts";
import { uid } from "../engine/indicators.ts";
import { scoreHeadline } from "../engine/sentiment.ts";
import { fetchJson, fetchText, yahooSymbol } from "./http.ts";

// Adapters for the three tracked websites plus a free daily-history provider.
// Every adapter fails soft: it reports status and returns undefined, and the
// DataHub fills the gap from the simulator so the agent never stalls.

export interface SiteSnapshot {
  price?: number;
  changePct?: number;
  fundamentals?: Fundamentals;
  news?: NewsItem[];
  score?: number; // site-specific composite score, normalised to -1..1
}

abstract class Source {
  status: SourceStatus;
  constructor(id: string, name: string, url: string) {
    this.status = { id, name, url, status: "disabled", note: "" };
  }
  protected ok(note = "") {
    this.status = { ...this.status, status: "live", lastOk: Date.now(), note };
  }
  protected fail(err: unknown) {
    this.status = { ...this.status, status: "error", note: String((err as Error)?.message ?? err).slice(0, 160) };
  }
  abstract enabled(): boolean;
  abstract snapshot(symbol: string): Promise<SiteSnapshot | undefined>;
}

// ---------------- Finviz ----------------
const parseNum = (s?: string): number | undefined => {
  if (!s || s === "-") return undefined;
  const m = s.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)([KMBT%]?)/);
  if (!m) return undefined;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, "%": 1, "": 1 }[m[2] as "K"] ?? 1;
  return Number(m[1]) * mult;
};

export class FinvizSource extends Source {
  private cache = new Map<string, { t: number; snap: SiteSnapshot }>();
  private lastReq = 0;
  constructor() {
    super("finviz", "Finviz", "https://finviz.com");
    if (!this.enabled()) this.status.note = "Set FINVIZ_AUTH (Elite) or FINVIZ_SCRAPE=true to enable";
  }
  enabled() {
    return config.liveData && (!!config.finviz.authToken || config.finviz.scrape);
  }
  async snapshot(symbol: string): Promise<SiteSnapshot | undefined> {
    if (!this.enabled()) return undefined;
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.t < 15 * 60_000) return hit.snap;
    if (Date.now() - this.lastReq < config.finviz.minIntervalMs) return hit?.snap;
    this.lastReq = Date.now();
    try {
      const snap = config.finviz.authToken ? await this.elite(symbol) : await this.scrape(symbol);
      this.cache.set(symbol, { t: Date.now(), snap });
      this.ok(config.finviz.authToken ? "Elite export" : "quote page");
      return snap;
    } catch (e) {
      this.fail(e);
      return hit?.snap;
    }
  }
  private async elite(symbol: string): Promise<SiteSnapshot> {
    const csv = await fetchText(`https://elite.finviz.com/export.ashx?v=152&t=${symbol}&c=1,6,7,65,66,68,69,72,81,86&auth=${config.finviz.authToken}`);
    const [head, row] = csv.trim().split(/\r?\n/).map((l) => l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/"/g, "")));
    const get = (name: string) => row?.[head.indexOf(name)];
    return {
      price: parseNum(get("Price")),
      changePct: parseNum(get("Change")),
      fundamentals: { pe: parseNum(get("P/E")), forwardPe: parseNum(get("Forward P/E")), marketCap: parseNum(get("Market Cap")) },
    };
  }
  private async scrape(symbol: string): Promise<SiteSnapshot> {
    const html = await fetchText(`https://finviz.com/quote.ashx?t=${symbol}&p=d`);
    const $ = cheerio.load(html);
    const kv: Record<string, string> = {};
    const cells = $("table.snapshot-table2 td").toArray().map((td) => $(td).text().trim());
    for (let i = 0; i + 1 < cells.length; i += 2) kv[cells[i]] = cells[i + 1];
    const news: NewsItem[] = $("#news-table tr")
      .toArray()
      .slice(0, 8)
      .map((tr) => {
        const a = $(tr).find("a").first();
        const headline = a.text().trim();
        return { id: uid("fv_"), symbol, t: Date.now(), headline, source: "finviz", url: a.attr("href"), sentiment: scoreHeadline(headline) };
      })
      .filter((n) => n.headline);
    const target = parseNum(kv["Target Price"]);
    const price = parseNum(kv["Price"]);
    return {
      price,
      changePct: parseNum(kv["Change"]),
      fundamentals: {
        pe: parseNum(kv["P/E"]),
        forwardPe: parseNum(kv["Forward P/E"]),
        shortFloat: parseNum(kv["Short Float"]),
        epsSurprise: parseNum(kv["EPS Surpr."]),
        dividendYield: parseNum(kv["Dividend %"] ?? kv["Dividend TTM"]),
      },
      news,
      score: target && price ? Math.max(-1, Math.min(1, (target / price - 1) * 3)) : undefined,
    };
  }
}

// ---------------- Generic JSON (Mesarri / InvoApp) ----------------
const getPath = (obj: unknown, p: string): unknown =>
  p.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

export class JsonSiteSource extends Source {
  private cache = new Map<string, { t: number; snap: SiteSnapshot }>();
  constructor(id: string, name: string, site: string, private cfg: { url: string; apiKey: string; map: string }) {
    super(id, name, site);
    if (!this.enabled()) this.status.note = `Set ${id.toUpperCase()}_URL (and _API_KEY) to connect your account feed`;
  }
  enabled() {
    return config.liveData && !!this.cfg.url;
  }
  async snapshot(symbol: string): Promise<SiteSnapshot | undefined> {
    if (!this.enabled()) return undefined;
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.t < 5 * 60_000) return hit.snap;
    try {
      const url = this.cfg.url.replace("{symbol}", encodeURIComponent(symbol));
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
      const json = JSON.parse(await fetchText(url, headers));
      const map = Object.fromEntries(this.cfg.map.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
      const sentiment = Number(getPath(json, map.sentiment ?? "sentiment"));
      const score = Number(getPath(json, map.score ?? "score"));
      const headline = getPath(json, map.headline ?? "headline");
      const snap: SiteSnapshot = {
        score: Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : undefined,
        news:
          typeof headline === "string"
            ? [{ id: uid(this.status.id), symbol, t: Date.now(), headline, source: this.status.name, sentiment: Number.isFinite(sentiment) ? sentiment : scoreHeadline(headline) }]
            : undefined,
      };
      this.cache.set(symbol, { t: Date.now(), snap });
      this.ok();
      return snap;
    } catch (e) {
      this.fail(e);
      return hit?.snap;
    }
  }
}

// ---------------- Prices: Yahoo (free) ----------------
// Daily history plus near-real-time quotes for the whole universe. Yahoo's endpoints are
// unofficial and meant for personal use; for a paid app, set POLYGON_API_KEY instead.
export class HistorySource extends Source {
  private cache = new Map<string, { t: number; bars: Bar[] }>();
  constructor() {
    super("history", "Prices & history (Yahoo)", "https://finance.yahoo.com");
  }
  enabled() {
    return config.liveData && config.yahooHistory;
  }
  async snapshot() {
    return undefined;
  }
  async bars(symbol: string, crypto: boolean): Promise<Bar[] | undefined> {
    if (!this.enabled()) return undefined;
    const hit = this.cache.get(symbol);
    if (hit && Date.now() - hit.t < 6 * 3600_000) return hit.bars;
    try {
      const json = await fetchJson<{ chart: { result: { timestamp: number[]; indicators: { quote: Record<string, (number | null)[]>[] } }[] } }>(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(symbol, crypto)}?range=2y&interval=1d`,
      );
      const r = json.chart.result[0];
      const q = r.indicators.quote[0];
      const bars: Bar[] = r.timestamp
        .map((ts, i) => ({ t: ts * 1000, o: q.open[i]!, h: q.high[i]!, l: q.low[i]!, c: q.close[i]!, v: q.volume[i] ?? 0 }))
        .filter((b) => [b.o, b.h, b.l, b.c].every((x) => typeof x === "number"));
      if (bars.length < 100) throw new Error("short history");
      this.cache.set(symbol, { t: Date.now(), bars });
      this.ok(`${this.cache.size} symbols loaded`);
      return bars;
    } catch (e) {
      this.fail(e);
      return undefined;
    }
  }

  // Latest prices for up to ~20 symbols per call (Yahoo "spark"). Accepts both response
  // shapes Yahoo has used: { spark: { result: [...] } } and { SYMBOL: {...} }.
  async quotes(symbols: { symbol: string; crypto: boolean }[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.enabled() || !symbols.length) return out;
    const byY = new Map(symbols.map((s) => [yahooSymbol(s.symbol, s.crypto), s.symbol]));
    try {
      const json = await fetchJson<Record<string, unknown>>(
        `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent([...byY.keys()].join(","))}&range=1d&interval=5m`,
      );
      type Item = { symbol?: string; close?: (number | null)[]; response?: { meta?: { regularMarketPrice?: number } }[] };
      const items: Item[] =
        (json.spark as { result?: Item[] } | undefined)?.result ?? Object.entries(json).map(([k, v]) => ({ symbol: k, ...(v as object) }));
      for (const it of items) {
        const sym = it.symbol && byY.get(it.symbol);
        if (!sym) continue;
        const price = it.response?.[0]?.meta?.regularMarketPrice ?? it.close?.filter((x): x is number => typeof x === "number").at(-1);
        if (typeof price === "number" && price > 0) out.set(sym, price);
      }
      if (out.size) this.ok(`${this.cache.size} histories · live quotes`);
    } catch (e) {
      this.fail(e);
    }
    return out;
  }
}

// ---------------- Prices + news: Polygon.io (paid, licensed) ----------------
// One key unlocks a full-market snapshot (one call for every US stock), daily history and
// per-ticker news with sentiment. Plans that allow showing data to app users are paid.
export class PolygonSource extends Source {
  constructor() {
    super("polygon", "Polygon.io (licensed market data)", "https://polygon.io");
    if (!this.enabled()) this.status.note = "Set POLYGON_API_KEY for licensed real-time/delayed prices and news";
  }
  enabled() {
    return config.liveData && !!config.polygon.apiKey;
  }
  async snapshot() {
    return undefined;
  }
  private url(path: string, params: Record<string, string> = {}) {
    const q = new URLSearchParams({ ...params, apiKey: config.polygon.apiKey });
    return `${config.polygon.base}${path}?${q}`;
  }
  async allPrices(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.enabled()) return out;
    try {
      type T = { ticker: string; lastTrade?: { p?: number }; min?: { c?: number }; day?: { c?: number }; prevDay?: { c?: number } };
      const json = await fetchJson<{ tickers?: T[] }>(this.url("/v2/snapshot/locale/us/markets/stocks/tickers"), {}, 20_000);
      for (const t of json.tickers ?? []) {
        const p = t.lastTrade?.p || t.min?.c || t.day?.c || t.prevDay?.c;
        if (p) out.set(t.ticker, p);
      }
      this.ok(`${out.size} live prices`);
    } catch (e) {
      this.fail(e);
    }
    return out;
  }
  async bars(symbol: string): Promise<Bar[] | undefined> {
    if (!this.enabled()) return undefined;
    try {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
      const json = await fetchJson<{ results?: { t: number; o: number; h: number; l: number; c: number; v: number }[] }>(
        this.url(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${from}/${to}`, { adjusted: "true", limit: "50000" }),
      );
      const bars = (json.results ?? []).map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
      return bars.length >= 100 ? bars : undefined;
    } catch (e) {
      this.fail(e);
      return undefined;
    }
  }
  async news(symbol: string): Promise<NewsItem[]> {
    if (!this.enabled()) return [];
    try {
      type N = { id: string; title: string; published_utc: string; article_url: string; publisher?: { name?: string }; insights?: { ticker: string; sentiment: string }[] };
      const json = await fetchJson<{ results?: N[] }>(this.url("/v2/reference/news", { ticker: symbol, limit: "20", order: "desc" }));
      return (json.results ?? []).map((n) => {
        const ins = n.insights?.find((i) => i.ticker === symbol)?.sentiment;
        const s = ins === "positive" ? 0.6 : ins === "negative" ? -0.6 : ins === "neutral" ? 0 : scoreHeadline(n.title);
        return { id: `pg_${n.id}`, symbol, t: Date.parse(n.published_utc), headline: n.title, source: n.publisher?.name ?? "Polygon", url: n.article_url, sentiment: s };
      });
    } catch (e) {
      this.fail(e);
      return [];
    }
  }
}
