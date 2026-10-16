import { ago, cls, fmtPct, useApp } from "../api";
import { Tip } from "./ui";

export interface DeskBrief {
  id: string;
  name: string;
  symbols: number;
  status: string;
  coverage: number;
  lastSweepAt?: number;
  tone: "bullish" | "bearish" | "mixed";
  avgForecast: number;
  breadth: number;
  sentiment: number;
  leaders: { symbol: string; exp: number; conf: number }[];
  laggards: { symbol: string; exp: number; conf: number }[];
  catalysts: { symbol: string; headline: string; source: string; url?: string; t: number }[];
  anomalies24h: number;
}

export interface MacroBrief {
  status: string;
  tone: number;
  headlines: { title: string; link?: string; t: number; source: string; sentiment: number; symbols: string[] }[];
}

const TONE = {
  bullish: { label: "Bullish", color: "var(--div-pos)" },
  bearish: { label: "Bearish", color: "var(--div-neg)" },
  mixed: { label: "Mixed", color: "var(--muted)" },
} as const;

export function DesksCard({ desks }: { desks: DeskBrief[] }) {
  const { openTicker } = useApp();
  return (
    <>
      <h2>
        Sector desks{" "}
        <Tip text="One background agent per slice of the market. Each desk combs its companies' headlines and official SEC filings, then summarises the sector: overall lean, how many names are forecast to rise, the strongest and weakest calls, and fresh catalysts." />
        <span className="sub">{desks.length} desks</span>
      </h2>
      <div className="desk-grid">
        {desks.map((d) => (
          <div key={d.id} className="desk">
            <div className="row">
              <b style={{ fontSize: 14 }}>{d.name}</b>
              <span className="spacer" />
              <span className="small" style={{ color: TONE[d.tone].color, fontWeight: 600 }}>
                ● {TONE[d.tone].label}
              </span>
            </div>
            <div className="row small ink2 num" style={{ marginTop: 2 }}>
              <span>
                avg 5d <span className={cls(d.avgForecast)}>{fmtPct(d.avgForecast, 2)}</span>
              </span>
              <span>· {Math.round(d.breadth * 100)}% up</span>
              {d.anomalies24h > 0 && <span>· {d.anomalies24h} anomal{d.anomalies24h === 1 ? "y" : "ies"}</span>}
            </div>
            <div className="chips" style={{ marginTop: 6 }}>
              {d.leaders.map((l) => (
                <button key={l.symbol} className="chip" onClick={() => openTicker(l.symbol)}>
                  ▲ {l.symbol} <span className="up tiny">{fmtPct(l.exp, 1)}</span>
                </button>
              ))}
              {d.laggards.map((l) => (
                <button key={l.symbol} className="chip" onClick={() => openTicker(l.symbol)}>
                  ▼ {l.symbol} <span className="down tiny">{fmtPct(l.exp, 1)}</span>
                </button>
              ))}
            </div>
            {d.catalysts[0] && (
              <div className="tiny ink2" style={{ marginTop: 4 }} onClick={() => openTicker(d.catalysts[0].symbol)}>
                <b>{d.catalysts[0].symbol}</b> {d.catalysts[0].headline} <span className="muted">· {d.catalysts[0].source} · {ago(d.catalysts[0].t)}</span>
              </div>
            )}
            <div className="tiny muted" style={{ marginTop: 4 }}>
              {d.symbols} names · real news for {Math.round(d.coverage * 100)}% · {d.status}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function MacroCard({ macro }: { macro: MacroBrief }) {
  const { openTicker } = useApp();
  const tone = macro.tone > 0.1 ? "positive" : macro.tone < -0.1 ? "negative" : "neutral";
  return (
    <>
      <h2>
        Market news{" "}
        <Tip text="The macro desk reads market-wide feeds (Federal Reserve, MarketWatch, CNBC, SEC press releases), scores their tone and routes any company it recognises to that stock's news." />
        <span className="sub">tone {tone}</span>
      </h2>
      {!macro.headlines.length ? (
        <div className="empty">{macro.status.startsWith("simulated") ? "Market-wide news is off while the app runs on simulated data." : `Waiting for feeds — ${macro.status}`}</div>
      ) : (
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {macro.headlines.map((h) => (
            <div key={h.title + h.t} className="feed-item small">
              <div className="row">
                <span className={`num ${cls(h.sentiment)}`} style={{ minWidth: 36 }}>{h.sentiment.toFixed(2)}</span>
                {h.link ? <a href={h.link} target="_blank" rel="noreferrer">{h.title}</a> : <span>{h.title}</span>}
              </div>
              <div className="row tiny muted wrap">
                {h.source} · {ago(h.t)} ago
                {h.symbols.slice(0, 4).map((s) => (
                  <button key={s} className="badge" onClick={() => openTicker(s)} style={{ cursor: "pointer" }}>{s}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
