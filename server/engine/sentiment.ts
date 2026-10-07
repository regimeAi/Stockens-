import type { NewsItem } from "../types.ts";

// Lightweight finance lexicon scorer. It's deliberately simple and transparent:
// every headline score can be traced to the words that moved it.
const POS: Record<string, number> = {
  beat: 0.6, beats: 0.6, raise: 0.4, raises: 0.5, raised: 0.4, upgrade: 0.6, upgraded: 0.6, lift: 0.3, lifts: 0.3,
  record: 0.4, strong: 0.4, surge: 0.5, surges: 0.5, wins: 0.4, win: 0.3, contract: 0.2, growth: 0.3, inflows: 0.3,
  outperform: 0.5, buy: 0.3, bullish: 0.5, rally: 0.4, approval: 0.5, approved: 0.5, partnership: 0.3, expands: 0.3,
  accelerat: 0.4, demand: 0.2, added: 0.2, tops: 0.4, guide: 0.1,
};
const NEG: Record<string, number> = {
  miss: -0.6, misses: -0.6, cut: -0.5, cuts: -0.5, downgrade: -0.6, downgraded: -0.6, probe: -0.5, lawsuit: -0.5,
  weak: -0.4, softer: -0.4, slowing: -0.4, plunge: -0.6, plunges: -0.6, falls: -0.3, sell: -0.2, bearish: -0.5,
  recall: -0.5, delay: -0.4, delays: -0.4, investigation: -0.5, layoffs: -0.3, warns: -0.5, constraints: -0.3,
  weigh: -0.3, halt: -0.5, fraud: -0.8, default: -0.6, bankruptcy: -0.9, dilution: -0.4,
};

export function scoreHeadline(h: string): number {
  const words = h.toLowerCase().split(/[^a-z]+/);
  let s = 0;
  for (const w of words) {
    for (const [k, v] of Object.entries(POS)) if (w.startsWith(k)) s += v;
    for (const [k, v] of Object.entries(NEG)) if (w.startsWith(k)) s += v;
  }
  return Math.max(-1, Math.min(1, s));
}

export interface SentimentSummary {
  score: number; // recency-weighted mean, -1..1
  momentum: number; // change of sentiment & volume of news: recent half vs older half
  count: number;
}

// "Momentum of news": recency-weighted tone, and how fast tone *and* volume are changing.
export function summarize(news: NewsItem[], now = Date.now()): SentimentSummary {
  if (!news.length) return { score: 0, momentum: 0, count: 0 };
  const halfLife = 24 * 3600_000;
  let wsum = 0;
  let s = 0;
  for (const n of news) {
    const w = Math.pow(0.5, (now - n.t) / halfLife);
    wsum += w;
    s += w * n.sentiment;
  }
  const cutoff = now - 24 * 3600_000;
  const recent = news.filter((n) => n.t >= cutoff);
  const older = news.filter((n) => n.t < cutoff);
  const avg = (xs: NewsItem[]) => (xs.length ? xs.reduce((a, b) => a + b.sentiment, 0) / xs.length : 0);
  const toneShift = avg(recent) - avg(older);
  const volumeShift = (recent.length - older.length / 2) / Math.max(1, news.length);
  const momentum = Math.max(-1, Math.min(1, toneShift * 0.8 + Math.sign(avg(recent)) * volumeShift * 0.4));
  return { score: wsum ? s / wsum : 0, momentum, count: news.length };
}
