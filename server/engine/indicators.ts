import type { Bar } from "../types.ts";

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const last = <T>(xs: T[]) => xs[xs.length - 1];

export function returns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

export function sma(xs: number[], n: number): number {
  return mean(xs.slice(-n));
}

export function emaSeries(xs: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = xs[0] ?? 0;
  for (const x of xs) {
    e = x * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function rsi(closes: number[], n = 14): number {
  if (closes.length <= n) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function atr(bars: Bar[], n = 14): number {
  if (bars.length < 2) return bars[0] ? bars[0].h - bars[0].l : 0;
  const trs: number[] = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  return mean(trs);
}

export function zscore(xs: number[], n: number): number {
  const w = xs.slice(-n);
  const s = std(w);
  return s === 0 ? 0 : (last(w) - mean(w)) / s;
}

export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    mdd = Math.min(mdd, e / peak - 1);
  }
  return mdd;
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26).
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Deterministic PRNG so simulations and tests are reproducible.
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const uid = (prefix = "") => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
