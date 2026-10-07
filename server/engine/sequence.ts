import type { Bar } from "../types.ts";
import { mean, std } from "./indicators.ts";

// Sequence model: single-head scaled dot-product attention over the instrument's own
// history. The query is the latest normalised return window; keys are every past
// window; values are what happened next. Softmax(q·k/√d) weights the past analogs,
// giving a transformer-style pattern matcher with no training step and no GPU.

export interface SequenceForecast {
  expected: number; // weighted mean forward return
  dispersion: number; // weighted stdev of analog outcomes
  effectiveAnalogs: number; // 1/Σw² — how many analogs actually drove the call
  topAnalogs: { t: number; similarity: number; outcome: number }[];
}

function window(bars: Bar[], end: number, len: number): number[] | undefined {
  if (end - len < 0) return undefined;
  const r: number[] = [];
  for (let i = end - len + 1; i <= end; i++) r.push(Math.log(bars[i].c / bars[i - 1].c));
  const s = std(r) || 1e-6;
  const m = mean(r);
  // Add volume shape as extra dims so analogs match price *and* participation.
  const v = bars.slice(end - len + 1, end + 1).map((b) => b.v);
  const vm = mean(v) || 1;
  return [...r.map((x) => (x - m) / s), ...v.map((x) => Math.log(x / vm + 1e-9) * 0.5)];
}

export function attentionForecast(bars: Bar[], end: number, horizon: number, len = 20, temperature = 1): SequenceForecast {
  const q = window(bars, end, len);
  if (!q) return { expected: 0, dispersion: 0.02, effectiveAnalogs: 0, topAnalogs: [] };
  const d = q.length;
  const scores: { i: number; s: number; y: number }[] = [];
  for (let i = len + 1; i + horizon <= end; i += 1) {
    const k = window(bars, i, len);
    if (!k) continue;
    let dot = 0;
    for (let j = 0; j < d; j++) dot += q[j] * k[j];
    scores.push({ i, s: dot / Math.sqrt(d) / temperature, y: bars[i + horizon].c / bars[i].c - 1 });
  }
  if (!scores.length) return { expected: 0, dispersion: 0.02, effectiveAnalogs: 0, topAnalogs: [] };
  const mx = Math.max(...scores.map((x) => x.s));
  const ws = scores.map((x) => Math.exp(x.s - mx));
  const Z = ws.reduce((a, b) => a + b, 0);
  let exp = 0;
  let w2 = 0;
  scores.forEach((x, j) => {
    const w = ws[j] / Z;
    exp += w * x.y;
    w2 += w * w;
  });
  let v = 0;
  scores.forEach((x, j) => (v += (ws[j] / Z) * (x.y - exp) ** 2));
  // Shrink toward zero when only a handful of analogs dominate (overconfidence guard).
  const eff = 1 / w2;
  const shrink = eff / (eff + 10);
  const top = scores
    .map((x, j) => ({ t: bars[x.i].t, similarity: ws[j] / Z, outcome: x.y }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);
  return { expected: exp * shrink, dispersion: Math.sqrt(v), effectiveAnalogs: eff, topAnalogs: top };
}
