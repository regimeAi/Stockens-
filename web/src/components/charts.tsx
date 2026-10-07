import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { Attribution, Bar, HorizonForecast } from "../../../server/types";
import { fmtPct, fmtPrice } from "../api";
import { Tip } from "./ui";

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function TT({ active, payload, label, fmt }: { active?: boolean; payload?: { name: string; value: number | number[]; color: string }[]; label?: number; fmt?: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const f = fmt ?? fmtPrice;
  return (
    <div className="chart-tt">
      <div className="muted">{label ? day(label) : ""}</div>
      {payload
        .filter((p) => p.value !== undefined && p.value !== null)
        .map((p) => (
          <div key={p.name} className="row num">
            <i style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: "inline-block" }} />
            <span className="ink2">{p.name}</span>
            <span className="spacer" />
            <b>{Array.isArray(p.value) ? `${f(p.value[0])} – ${f(p.value[1])}` : f(p.value)}</b>
          </div>
        ))}
    </div>
  );
}

// Price history + the 5-day projected cone (80% confidence band around the mid path).
export function ForecastChart({ bars, path }: { bars: Bar[]; path: { t: number; mid: number; low: number; high: number }[] }) {
  const hist = bars.slice(-60).map((b) => ({ t: b.t, price: b.c }));
  const last = hist.at(-1)!;
  const proj = path.map((p, i) => ({ t: p.t, mid: p.mid, band: [p.low, p.high] as [number, number], price: i === 0 ? last.price : undefined }));
  const data = [...hist.slice(0, -1), ...proj];
  return (
    <div>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span><i style={{ background: "var(--s1)" }} />Price</span>
        <span><i style={{ background: "var(--s2)" }} />5-day forecast</span>
        <span><i style={{ background: "color-mix(in srgb, var(--s2) 22%, transparent)" }} />80% confidence band</span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeWidth={1} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} scale="time" tickFormatter={day} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={40} />
          <YAxis domain={["auto", "auto"]} tickFormatter={fmtPrice} tickLine={false} axisLine={false} width={56} />
          <Tooltip content={<TT />} />
          <Area dataKey="band" name="80% band" stroke="none" fill="var(--s2)" fillOpacity={0.18} isAnimationActive={false} />
          <Line dataKey="price" name="Price" stroke="var(--s1)" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          <Line dataKey="mid" name="Forecast" stroke="var(--s2)" strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Multi-horizon forecasts: expected return with its 80% band, plus confidence.
export function HorizonBands({ horizons }: { horizons: HorizonForecast[] }) {
  const lo = Math.min(...horizons.map((h) => h.bandLow), 0);
  const hi = Math.max(...horizons.map((h) => h.bandHigh), 0);
  const x = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  return (
    <div className="stack">
      {horizons.map((h) => (
        <div key={h.horizon}>
          <div className="row small">
            <b>{h.label}</b>
            <span className={`num ${h.expectedReturn >= 0 ? "up" : "down"}`}>{fmtPct(h.expectedReturn)}</span>
            <span className="muted num">P(up) {(h.probUp * 100).toFixed(0)}%</span>
            <span className="spacer" />
            <span className="ink2 num">conf {h.confidence}</span>
          </div>
          <div style={{ position: "relative", height: 22, margin: "4px 0" }} title={`80% band ${fmtPct(h.bandLow)} to ${fmtPct(h.bandHigh)}`}>
            <div style={{ position: "absolute", left: `${x(0)}%`, top: 0, bottom: 0, width: 1, background: "var(--axis)" }} />
            <div style={{ position: "absolute", left: `${x(h.bandLow)}%`, width: `${x(h.bandHigh) - x(h.bandLow)}%`, top: 7, height: 8, borderRadius: 4, background: "color-mix(in srgb, var(--s1) 25%, transparent)" }} />
            <div style={{ position: "absolute", left: `calc(${x(h.expectedReturn)}% - 6px)`, top: 5, width: 12, height: 12, borderRadius: "50%", background: "var(--s1)", border: "2px solid var(--surface)" }} />
          </div>
          <div className="tiny muted num row">
            <span>{fmtPct(h.bandLow, 1)}</span>
            <span className="spacer" />
            <span>{fmtPct(h.bandHigh, 1)}</span>
          </div>
          <div className="small ink2" style={{ marginTop: 2 }}>{h.rationale}</div>
        </div>
      ))}
    </div>
  );
}

// Feature attributions as a diverging bar list (blue pushes up, red pushes down).
export function AttributionBars({ items }: { items: Attribution[] }) {
  const max = Math.max(...items.map((a) => Math.abs(a.contribution)), 1e-6);
  return (
    <div className="stack">
      <div className="legend">
        <span><i style={{ background: "var(--div-pos)" }} />Pushes forecast up</span>
        <span><i style={{ background: "var(--div-neg)" }} />Pushes forecast down</span>
      </div>
      {items.map((a) => (
        <div key={a.feature} className="small">
          <div className="row">
            <span style={{ fontWeight: 500 }}>{pretty(a.feature)}</span>
            <Tip text={`${a.tip} (current value ${a.value.toFixed(3)})`} />
            <span className="muted tiny">{a.group}</span>
            <span className="spacer" />
            <span className="num ink2">{a.contribution > 0 ? "+" : ""}{a.contribution.toFixed(2)} pp</span>
          </div>
          <div style={{ display: "flex", height: 8, marginTop: 3 }}>
            <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
              {a.contribution < 0 && <div style={{ width: `${(Math.abs(a.contribution) / max) * 100}%`, background: "var(--div-neg)", borderRadius: "4px 0 0 4px" }} />}
            </div>
            <div style={{ width: 1, background: "var(--axis)" }} />
            <div style={{ flex: 1 }}>{a.contribution > 0 && <div style={{ width: `${(a.contribution / max) * 100}%`, height: "100%", background: "var(--div-pos)", borderRadius: "0 4px 4px 0" }} />}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const NAMES: Record<string, string> = {
  mom_5: "5-day momentum", mom_20: "20-day momentum", mom_120: "6-month momentum", trend_slope: "Trend slope", rsi_14: "RSI (14)", z_20: "Stretch vs 20-day mean",
  atr_pct: "ATR % (volatility)", vol_ratio: "Vol expansion", gap: "Opening gap", volume_z: "Volume surge", close_loc: "Close location", breadth: "Market breadth",
  eps_rev: "EPS revisions", eps_surprise: "Earnings surprise", dispersion: "Analyst dispersion", value: "Value (earnings yield)", size: "Size", rates: "Rates (TLT)",
  dollar: "Dollar (UUP)", commodities: "Commodities", sentiment: "News sentiment", news_mom: "News momentum",
};
export const pretty = (k: string) => NAMES[k] ?? k;

export function EquityChart({ data }: { data: { t: number; equity: number; benchmark: number }[] }) {
  return (
    <div>
      <div className="legend" style={{ marginBottom: 6 }}>
        <span><i style={{ background: "var(--s1)" }} />Strategy</span>
        <span><i style={{ background: "var(--s2)" }} />Benchmark (SPY)</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={day} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={50} />
          <YAxis tickFormatter={(v) => `${((v - 1) * 100).toFixed(0)}%`} tickLine={false} axisLine={false} width={44} domain={["auto", "auto"]} />
          <ReferenceLine y={1} stroke="var(--axis)" />
          <Tooltip content={<TT fmt={(v) => fmtPct((v - 1) * 100, 1)} />} />
          <Line dataKey="equity" name="Strategy" stroke="var(--s1)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="benchmark" name="SPY" stroke="var(--s2)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DrawdownChart({ data, dataKey = "drawdown" }: { data: { t: number; [k: string]: number }[]; dataKey?: string }) {
  return (
    <ResponsiveContainer width="100%" height={120}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={day} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={50} />
        <YAxis tickFormatter={(v) => `${v.toFixed(0)}%`} tickLine={false} axisLine={false} width={44} />
        <Tooltip content={<TT fmt={(v) => fmtPct(v, 1)} />} />
        <Area dataKey={dataKey} name="Drawdown" stroke="var(--div-neg)" strokeWidth={2} fill="var(--div-neg)" fillOpacity={0.15} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function PriceLine({ data, color = "var(--s1)", height = 200 }: { data: { t: number; c: number }[]; color?: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} tickLine={false} axisLine={{ stroke: "var(--axis)" }} minTickGap={50} />
        <YAxis domain={["auto", "auto"]} tickFormatter={fmtPrice} tickLine={false} axisLine={false} width={60} />
        <Tooltip content={<TT />} />
        <Line dataKey="c" name="BTC" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
