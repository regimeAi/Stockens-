import * as cheerio from "cheerio";
import { config } from "../config.ts";
import type { NewsItem } from "../types.ts";
import { scoreHeadline } from "../engine/sentiment.ts";
import { fetchJson, fetchText, yahooSymbol } from "./http.ts";

// Real news and filings, free sources only:
//  - Yahoo Finance headline RSS per ticker
//  - SEC EDGAR filings per company (official, public domain): 8-K items tell you *what* happened
//  - Market-wide feeds (Fed, MarketWatch, CNBC, SEC press) matched to companies by name

export interface FeedItemRaw {
  title: string;
  link?: string;
  t: number;
  summary?: string;
}

export function parseFeed(xml: string): FeedItemRaw[] {
  const $ = cheerio.load(xml, { xml: true });
  const items = $("item").length ? $("item") : $("entry"); // RSS or Atom
  return items
    .toArray()
    .map((el) => {
      const e = $(el);
      const title = e.find("title").first().text().trim();
      const link = e.find("link").first().attr("href") ?? e.find("link").first().text().trim();
      const date = e.find("pubDate").first().text() || e.find("updated").first().text() || e.find("published").first().text();
      const t = Date.parse(date);
      const summary = cheerio.load(e.find("description").first().text() || e.find("summary").first().text()).text().trim().slice(0, 300);
      return { title, link: link || undefined, t: Number.isFinite(t) ? t : Date.now(), summary: summary || undefined };
    })
    .filter((x) => x.title);
}

const id = (prefix: string, s: string) => prefix + Buffer.from(s).toString("base64url").slice(-24);

export async function yahooHeadlines(symbol: string, crypto = false): Promise<NewsItem[]> {
  const xml = await fetchText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooSymbol(symbol, crypto))}&region=US&lang=en-US`);
  return parseFeed(xml)
    .slice(0, 20)
    .map((x) => ({ id: id("yh_", x.link ?? x.title), symbol, t: x.t, headline: x.title, source: "Yahoo Finance", url: x.link, sentiment: scoreHeadline(`${x.title} ${x.summary ?? ""}`) }));
}

// 8-K item codes → what the filing means, and a sentiment nudge where the item has one.
const ITEMS: Record<string, { what: string; tone: number }> = {
  "1.01": { what: "signed a material agreement", tone: 0.2 },
  "1.02": { what: "terminated a material agreement", tone: -0.3 },
  "1.03": { what: "filed for bankruptcy or receivership", tone: -0.9 },
  "2.01": { what: "completed an acquisition or disposition", tone: 0.1 },
  "2.02": { what: "reported results of operations (earnings)", tone: 0 },
  "2.05": { what: "announced exit or restructuring costs", tone: -0.3 },
  "2.06": { what: "reported a material impairment", tone: -0.5 },
  "3.01": { what: "received a delisting or listing-rule notice", tone: -0.6 },
  "4.02": { what: "said past financial statements can't be relied on", tone: -0.8 },
  "5.02": { what: "announced a director or officer change", tone: -0.1 },
  "5.07": { what: "reported shareholder vote results", tone: 0 },
  "7.01": { what: "released Regulation FD information", tone: 0 },
  "8.01": { what: "reported another material event", tone: 0 },
};

type Submissions = { name?: string; filings?: { recent?: { form: string[]; filingDate: string[]; accessionNumber: string[]; items?: string[]; primaryDocument?: string[] } } };

// Health of the SEC connection, shown on Me → Data & agent.
export const secHealth: { lastOk?: number; error?: string; companies: number } = { companies: 0 };

export async function secFilings(symbol: string, cik: number): Promise<NewsItem[]> {
  const pad = String(cik).padStart(10, "0");
  let j: Submissions;
  try {
    j = await fetchJson<Submissions>(`https://data.sec.gov/submissions/CIK${pad}.json`, { "user-agent": config.secUserAgent });
    secHealth.lastOk = Date.now();
    secHealth.companies++;
    secHealth.error = undefined;
  } catch (e) {
    secHealth.error = (e as Error).message;
    throw e;
  }
  const r = j.filings?.recent;
  if (!r) return [];
  const out: NewsItem[] = [];
  for (let i = 0; i < r.form.length && out.length < 10; i++) {
    const form = r.form[i];
    if (!["8-K", "10-Q", "10-K", "S-1", "SC 13D", "4"].includes(form)) continue;
    if (form === "4" && out.filter((x) => x.headline.includes("insider")).length >= 2) continue;
    const t = Date.parse(r.filingDate[i]);
    if (Date.now() - t > 30 * 86_400_000) break;
    const codes = (r.items?.[i] ?? "").split(",").map((c) => c.trim()).filter((c) => ITEMS[c]);
    const what =
      form === "8-K"
        ? codes.map((c) => ITEMS[c].what).join("; ") || "filed a current report"
        : form === "10-Q"
          ? "filed its quarterly report (10-Q)"
          : form === "10-K"
            ? "filed its annual report (10-K)"
            : form === "4"
              ? "reported an insider transaction (Form 4)"
              : form === "SC 13D"
                ? "has a new 5%+ activist holder (13D)"
                : `filed ${form}`;
    const tone = codes.length ? codes.reduce((a, c) => a + ITEMS[c].tone, 0) / codes.length : 0;
    const acc = r.accessionNumber[i];
    out.push({
      id: `sec_${acc}`,
      symbol,
      t,
      headline: `${symbol} ${what}`,
      source: `SEC ${form}`,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${r.primaryDocument?.[i] ?? ""}`,
      sentiment: tone,
    });
  }
  return out;
}

// Company-name matcher for market-wide headlines ("Nvidia shares jump…" → NVDA).
const SUFFIX = /\b(inc\.?|corp\.?|corporation|company|co\.?|holdings?|group|plc|ltd\.?|incorporated|class [ab]|the|&)\b/gi;
// Names that are ordinary words and would match unrelated headlines.
const AMBIGUOUS = new Set(["target", "ball", "visa", "apple", "best buy", "general", "progressive", "public storage", "southern", "news", "fox", "ford", "match", "gap", "dollar general", "united", "american", "eaton", "best"]);

export function nameMatcher(universe: { symbol: string; name: string }[]) {
  const keys = universe
    .map((u) => ({ symbol: u.symbol, key: u.name.replace(SUFFIX, "").replace(/[.,()]/g, " ").replace(/\s+/g, " ").trim().toLowerCase() }))
    .filter((k) => k.key.length >= 4);
  return (text: string): string[] => {
    const lower = ` ${text.toLowerCase()} `;
    const hits = new Set<string>();
    for (const k of keys) {
      if (AMBIGUOUS.has(k.key)) {
        // Only match ordinary-word names next to a market cue, e.g. "Apple shares", "Target stock".
        if (new RegExp(`\\b${k.key}('s)? (shares|stock|earnings|revenue|ceo|beats|misses|raises|cuts)\\b`).test(lower)) hits.add(k.symbol);
      } else if (new RegExp(`[^a-z]${k.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z]`).test(lower)) hits.add(k.symbol);
    }
    const tick = text.match(/\(([A-Z]{1,5})\)|\$([A-Z]{1,5})\b/g) ?? []; // "(NVDA)" or "$NVDA"
    for (const m of tick) {
      const s = m.replace(/[()$]/g, "");
      if (universe.some((u) => u.symbol === s)) hits.add(s);
    }
    return [...hits];
  };
}

export async function macroHeadlines(feeds: string[]): Promise<{ feed: string; items: FeedItemRaw[]; error?: string }[]> {
  return Promise.all(
    feeds.map(async (feed) => {
      try {
        return { feed, items: parseFeed(await fetchText(feed, feed.includes("sec.gov") ? { "user-agent": config.secUserAgent } : {})).slice(0, 30) };
      } catch (e) {
        return { feed, items: [], error: (e as Error).message };
      }
    }),
  );
}
