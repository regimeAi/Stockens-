import { config } from "../config.ts";
import type { Bar, Fundamentals, NewsItem, SourceStatus } from "../types.ts";
import { scoreHeadline } from "../engine/sentiment.ts";
import { HttpError, fetchJson } from "./http.ts";
import type { SiteSnapshot } from "./sources.ts";

// FinancialData.net (https://financialdata.net/documentation): one key, query param `key`.
// Plans unlock different endpoints (Free: daily stock prices; Standard: fundamentals,
// earnings, crypto; Premium: live quotes, news, earnings calendar, analyst consensus).
// An endpoint the plan doesn't include answers 401/403; we remember that and stop asking,
// and the agent falls back to its other sources for that piece.

type Row = Record<string, unknown>;
type Kind = "equity" | "etf" | "crypto";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(+v) ? +v : undefined);

// FinancialData.net reports times in New York time ("2026-06-05 23:59:55").
export function nyTime(s: string): number {
  const guess = Date.parse(s.trim().replace(" ", "T") + (s.includes(" ") ? "Z" : "T16:00:00Z"));
  if (!Number.isFinite(guess)) return NaN;
  const d = new Date(guess);
  const asNy = Date.parse(d.toLocaleString("en-US", { timeZone: "America/New_York" }) + " UTC");
  return guess + (guess - asNy);
}

// Crypto is quoted against USD (BTC → BTCUSD); S&P dots stay dots (BRK.B).
export const fdSymbol = (symbol: string, kind: Kind) => (kind === "crypto" ? `${symbol}USD` : symbol);

export function parseBars(rows: Row[]): Bar[] {
  return rows
    .map((r) => ({ t: nyTime(String(r.date ?? "")), o: num(r.open)!, h: num(r.high)!, l: num(r.low)!, c: num(r.close)!, v: num(r.volume) ?? 0 }))
    .filter((b) => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every((x) => typeof x === "number" && x > 0))
    .sort((a, b) => a.t - b.t);
}

export function parseQuotes(rows: Row[], back: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const sym = back.get(String(r.trading_symbol ?? r.identifier ?? ""));
    const p = num(r.price);
    if (sym && p && p > 0) out.set(sym, p);
  }
  return out;
}

// Most recent fiscal year first in the API; take the newest row that has numbers.
export function parseKeyMetrics(rows: Row[]): Fundamentals {
  const r = [...rows].sort((a, b) => String(b.period_end_date ?? b.fiscal_year ?? "").localeCompare(String(a.period_end_date ?? a.fiscal_year ?? "")))[0];
  if (!r) return {};
  const pe = num(r.price_to_earnings_ratio);
  const fpe = num(r.forward_price_to_earnings_ratio);
  const dy = num(r.dividend_yield);
  return {
    pe: pe && pe > 0 && pe < 1000 ? pe : undefined,
    forwardPe: fpe && fpe > 0 && fpe < 1000 ? fpe : undefined,
    dividendYield: dy !== undefined && dy >= 0 ? dy * 100 : undefined,
    marketCap: num(r.market_cap),
  };
}

export function parseEarningsReleases(rows: Row[]): Fundamentals {
  const r = [...rows].sort((a, b) => String(b.fiscal_quarter_end_date ?? "").localeCompare(String(a.fiscal_quarter_end_date ?? "")))[0];
  if (!r) return {};
  const eps = num(r.earnings_per_share);
  const est = num(r.earnings_per_share_forecast);
  const surprise = num(r.percentage_surprise) ?? (eps !== undefined && est ? ((eps - est) / Math.abs(est)) * 100 : undefined);
  return { epsSurprise: surprise, marketCap: num(r.market_cap) };
}

// Analyst consensus → a -1..1 score: upside to the average target, tilted by the buy/sell mix.
export function consensusScore(rows: Row[], price?: number): { score?: number; dispersion?: number } {
  const r = rows[0];
  if (!r) return {};
  const target = num(r.average_price_target);
  const hi = num(r.highest_price_target);
  const lo = num(r.lowest_price_target);
  const buy = num(r.buy_recommendations) ?? 0;
  const hold = num(r.hold_recommendations) ?? 0;
  const sell = num(r.sell_recommendations) ?? 0;
  const n = buy + hold + sell;
  const mix = n ? (buy - sell) / n : 0;
  const upside = target && price ? target / price - 1 : 0;
  const score = n || (target && price) ? Math.max(-1, Math.min(1, upside * 2 + mix * 0.4)) : undefined;
  return { score, dispersion: target && hi && lo ? (hi - lo) / 4 / target : undefined };
}

export function parseNews(rows: Row[], known: Set<string>): NewsItem[] {
  const out: NewsItem[] = [];
  for (const r of rows) {
    const headline = String(r.article_headline ?? "").trim();
    if (!headline) continue;
    const t = nyTime(String(r.publication_time ?? ""));
    const text = String(r.article_text ?? "");
    const sentiment = scoreHeadline(`${headline}. ${text.slice(0, 400)}`);
    const syms = String(r.trading_symbols ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => known.has(s));
    for (const symbol of new Set(syms))
      out.push({ id: `fdn_${symbol}_${t}_${headline.slice(0, 24)}`, symbol, t: Number.isFinite(t) ? t : Date.now(), headline, source: "FinancialData.net", sentiment });
  }
  return out;
}

export function parseEarningsCalendar(rows: Row[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const sym = String(r.trading_symbol ?? "");
    const t = nyTime(String(r.conference_call_time ?? r.report_date ?? ""));
    if (sym && Number.isFinite(t)) out.set(sym, t);
  }
  return out;
}

const PLAN: Record<string, string> = {
  "stock-prices": "daily history",
  "etf-prices": "ETF history",
  "crypto-prices": "crypto history",
  "stock-quotes": "live quotes",
  "etf-quotes": "ETF quotes",
  "crypto-quotes": "crypto quotes",
  "key-metrics": "fundamentals",
  "earnings-releases": "earnings surprises",
  "analyst-consensus": "analyst targets",
  "earnings-calendar": "earnings calendar",
  "latest-news": "news",
};

export class FinancialDataSource {
  status: SourceStatus = { id: "financialdata", name: "FinancialData.net", url: "https://financialdata.net", status: "disabled", note: "" };
  private locked = new Set<string>(); // endpoints the plan doesn't include
  private working = new Set<string>();
  private fundCache = new Map<string, { t: number; snap: SiteSnapshot }>();
  private seenNews = new Set<string>();
  private lastError = "";

  constructor() {
    if (!this.enabled()) this.status.note = "Set FINANCIALDATA_API_KEY for prices, fundamentals, earnings and news";
  }
  enabled() {
    return config.liveData && !!config.financialData.apiKey;
  }
  has(endpoint: string) {
    return this.enabled() && !this.locked.has(endpoint);
  }

  private refreshStatus() {
    const on = [...this.working].map((e) => PLAN[e] ?? e);
    const off = [...this.locked].map((e) => PLAN[e] ?? e);
    const note = [on.length ? `using ${on.join(", ")}` : "", off.length ? `not on your plan: ${off.join(", ")}` : "", this.lastError].filter(Boolean).join(" · ");
    const live = this.working.size > 0;
    this.status = { ...this.status, status: live ? "live" : this.lastError || off.length ? "error" : "disabled", lastOk: live ? Date.now() : this.status.lastOk, note: note || "connecting" };
  }

  // One page of an endpoint. Undefined when the plan lacks it or the call failed.
  private async get(endpoint: string, params: Record<string, string>): Promise<Row[] | undefined> {
    if (!this.has(endpoint)) return undefined;
    const q = new URLSearchParams({ ...params, key: config.financialData.apiKey });
    try {
      const json = await fetchJson<unknown>(`${config.financialData.base}/${endpoint}?${q}`, {}, 15_000);
      if (!Array.isArray(json)) throw new Error(`${endpoint}: unexpected response`);
      this.working.add(endpoint);
      this.lastError = "";
      return json as Row[];
    } catch (e) {
      if (e instanceof HttpError && [401, 402, 403].includes(e.status)) this.locked.add(endpoint);
      else this.lastError = String((e as Error)?.message ?? e).replace(config.financialData.apiKey, "***").slice(0, 120);
      return undefined;
    } finally {
      this.refreshStatus();
    }
  }

  // ~2 years of daily bars (300 per page, newest first).
  async bars(symbol: string, kind: Kind): Promise<Bar[] | undefined> {
    const endpoint = kind === "crypto" ? "crypto-prices" : kind === "etf" ? "etf-prices" : "stock-prices";
    const rows: Row[] = [];
    for (let offset = 0; offset < 600; offset += 300) {
      const page = await this.get(endpoint, { identifier: fdSymbol(symbol, kind), offset: String(offset) });
      if (!page) break;
      rows.push(...page);
      if (page.length < 300) break;
    }
    const bars = parseBars(rows);
    return bars.length >= 100 ? bars : undefined;
  }

  // Latest prices for the whole universe: one call per asset class (up to 300 names each).
  async quotes(items: { symbol: string; kind: Kind }[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const groups: [string, Kind][] = [["stock-quotes", "equity"], ["etf-quotes", "etf"], ["crypto-quotes", "crypto"]];
    for (const [endpoint, kind] of groups) {
      const list = items.filter((i) => i.kind === kind);
      for (let i = 0; i < list.length; i += 300) {
        const chunk = list.slice(i, i + 300);
        const back = new Map(chunk.map((c) => [fdSymbol(c.symbol, kind), c.symbol]));
        const rows = await this.get(endpoint, { identifiers: [...back.keys()].join(",") });
        if (!rows) break;
        for (const [s, p] of parseQuotes(rows, back)) out.set(s, p);
      }
    }
    return out;
  }

  // Fundamentals + earnings surprise + analyst consensus for one stock (cached 12h). Returns the
  // cached copy at once and refreshes in the background, so the agent's cycle never waits on it.
  private inFlight = new Set<string>();
  async snapshot(symbol: string, price?: number): Promise<SiteSnapshot | undefined> {
    if (!this.enabled()) return undefined;
    const hit = this.fundCache.get(symbol);
    if ((!hit || Date.now() - hit.t > 12 * 3600_000) && !this.inFlight.has(symbol)) {
      this.inFlight.add(symbol);
      void this.fetchFundamentals(symbol, price).finally(() => this.inFlight.delete(symbol));
    }
    return hit?.snap;
  }
  private async fetchFundamentals(symbol: string, price?: number) {
    const [km, er, ac] = [
      await this.get("key-metrics", { identifier: symbol }),
      await this.get("earnings-releases", { identifier: symbol }),
      await this.get("analyst-consensus", { identifier: symbol }),
    ];
    if (!km && !er && !ac) return;
    const cons = consensusScore(ac ?? [], price);
    const f: Fundamentals = { ...parseKeyMetrics(km ?? []), ...parseEarningsReleases(er ?? []), analystDispersion: cons.dispersion };
    this.fundCache.set(symbol, { t: Date.now(), snap: { fundamentals: f, score: cons.score } });
  }

  // Newest market news (10 per page), routed to the symbols we cover. Only returns unseen items.
  async latestNews(known: Set<string>, pages = 2): Promise<NewsItem[]> {
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const fresh: NewsItem[] = [];
    for (let p = 0; p < pages; p++) {
      const rows = await this.get("latest-news", { date: day, offset: String(p * 10) });
      if (!rows?.length) break;
      for (const n of parseNews(rows, known)) if (!this.seenNews.has(n.id)) (this.seenNews.add(n.id), fresh.push(n));
      if (rows.length < 10) break;
    }
    if (this.seenNews.size > 5000) this.seenNews = new Set([...this.seenNews].slice(-2000));
    return fresh;
  }

  // Upcoming earnings dates for the next `days` calendar days.
  async earningsCalendar(days = 14): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let d = 0; d < days && this.has("earnings-calendar"); d++) {
      const date = new Date(Date.now() + d * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      for (let offset = 0; offset < 1500; offset += 300) {
        const rows = await this.get("earnings-calendar", { date, offset: String(offset) });
        if (!rows) break;
        for (const [s, t] of parseEarningsCalendar(rows)) out.set(s, t);
        if (rows.length < 300) break;
      }
    }
    return out;
  }
}
