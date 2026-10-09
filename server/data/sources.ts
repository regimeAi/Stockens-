import * as cheerio from "cheerio";
import { config } from "../config.ts";
import type { Bar, Fundamentals, NewsItem, SourceStatus } from "../types.ts";
import { uid } from "../engine/indicators.ts";
import { scoreHeadline } from "../engine/sentiment.ts";

// Adapters for the three tracked websites plus a free daily-history provider.
// Every adapter fails soft: it reports status and returns undefined, and the
// DataHub fills the gap from the simulator so the agent never stalls.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

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

// ---------------- Daily history (Yahoo chart API, unofficial) ----------------
export class HistorySource extends Source {
  private cache = new Map<string, { t: number; bars: Bar[] }>();
  constructor() {
    super("history", "Daily history (Yahoo chart)", "https://finance.yahoo.com");
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
      const ysym = crypto ? `${symbol}-USD` : symbol;
      const json = JSON.parse(await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${ysym}?range=2y&interval=1d`));
      const r = json.chart.result[0];
      const q = r.indicators.quote[0];
      const bars: Bar[] = r.timestamp
        .map((ts: number, i: number) => ({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 }))
        .filter((b: Bar) => [b.o, b.h, b.l, b.c].every((x) => typeof x === "number"));
      if (bars.length < 100) throw new Error("short history");
      this.cache.set(symbol, { t: Date.now(), bars });
      this.ok(`${this.cache.size} symbols cached`);
      return bars;
    } catch (e) {
      this.fail(e);
      return undefined;
    }
  }
}
