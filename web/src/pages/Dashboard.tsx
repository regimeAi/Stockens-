import type { FeedItem, Forecast, HorizonForecast, Regime, SignalCard, SourceStatus } from "../../../server/types";
import { ago, cls, fmtPct, fmtPrice, useApp, usePoll } from "../api";
import { ConfidenceMeter, SideBadge, Tip } from "../components/ui";
import { NewsHeatmap } from "../components/viz";

export interface DashboardData {
  updatedAt: number;
  agent: { status: string; cycleMs: number; models: { horizon: string; samples: number; oosHitRate: number; oosIc: number }[] };
  regime: Regime;
  psychology: { fearGreed: number; label: string; components: { name: string; value: number; note: string }[]; crowd: string[] };
  topBuys: { signal: SignalCard; forecast: Forecast; actionable: boolean }[];
  topSells: { signal: SignalCard; forecast: Forecast; actionable: boolean }[];
  upgrades: { symbol: string; name: string; score: number; h5: HorizonForecast; price: number; changePct: number }[];
  heatmap: { sector: string; items: { symbol: string; changePct: number; sentiment: number; newsMomentum: number; newsCount: number }[] }[];
  feed: FeedItem[];
  sources: SourceStatus[];
}

export function Dashboard() {
  const { tick, feed, openTicker, boot } = useApp();
  const [d, , err] = usePoll<DashboardData>("/dashboard", [tick]);
  if (!d) return <div className="empty">{err ? `Agent warming up… (${err})` : "Loading…"}</div>;
  const liveFeed = [...feed, ...d.feed.filter((x) => !feed.some((y) => y.id === x.id))].slice(0, 30);
  const novice = boot.profile.experience === "novice";
  return (
    <div className="grid">
      <div className="card span-12">
        <div className="row wrap" style={{ gap: 16 }}>
          <div>
            <div className="small ink2 row">Market regime <Tip text="The agent labels the market state (trend, volatility, season, liquidity) and re-weights its models so one playbook doesn't get over-used." /></div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>{d.regime.label}</div>
          </div>
          <div>
            <div className="small ink2 row">Fear & greed <Tip text="Market psychology composite: breadth, momentum, volatility, news tone and how stretched prices are. Extremes often precede reversals." /></div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>
              {d.psychology.fearGreed} · {d.psychology.label}
            </div>
          </div>
          <span className="spacer" />
          <div className="small muted">Updated {ago(d.updatedAt)} ago</div>
        </div>
        {novice && (
          <div className="small ink2" style={{ marginTop: 10, lineHeight: 1.5 }}>
            <b>How to use this:</b> 1) <b>Scan</b> the best 5-day ideas below → 2) tap one to <b>validate</b> the forecast and what drives it → 3) <b>decide</b> with the Signal Card's entry, stop and size → 4) <b>automate</b> with a watchlist + alerts → 5) <b>review</b> the end-of-day summary in Me.
          </div>
        )}
      </div>

      <div className="card span-6">
        <h2>
          Best 5-day buys <Tip text="Ranked by expected 5-day return × confidence. BUY means it passed your profile's signal thresholds; WATCH means it leans up but isn't strong enough yet." />
          <span className="sub">live</span>
        </h2>
        <Leans rows={d.topBuys} onOpen={openTicker} />
      </div>
      <div className="card span-6">
        <h2>
          Best 5-day sells <Tip text="Names the models expect to fall over 5 days. SELL = exit or avoid (or short if you're experienced). WATCH = leaning down, not actionable." />
          <span className="sub">live</span>
        </h2>
        <Leans rows={d.topSells} onOpen={openTicker} />
      </div>

      <div className="card span-8">
        <h2>
          News heatmap <Tip text="Each tile is a ticker, grouped by sector. Momentum of news shows where tone and coverage are changing fastest — often an early sign of an inflection." />
        </h2>
        <NewsHeatmap sectors={d.heatmap} />
      </div>
      <div className="card span-4">
        <h2>Agent feed <span className="sub">{liveFeed.length}</span></h2>
        <div style={{ maxHeight: 520, overflowY: "auto" }}>
          {liveFeed.map((f) => (
            <div key={f.id} className="feed-item" onClick={() => f.symbol && openTicker(f.symbol)} style={{ cursor: f.symbol ? "pointer" : "default" }}>
              <div className="row small">
                <b>{f.title}</b>
                <span className="spacer" />
                <span className="muted tiny">{ago(f.t)}</span>
              </div>
              <div className="small ink2">{f.body}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-6">
        <h2>Top forecast upgrades</h2>
        <div className="list">
          {d.upgrades.map((u) => (
            <div key={u.symbol} className="list-item" onClick={() => openTicker(u.symbol)}>
              <div>
                <div className="sym">{u.symbol}</div>
                <div className="name">{u.name}</div>
              </div>
              <div className="right">
                <div className={`num ${cls(u.h5.expectedReturn)}`}>{fmtPct(u.h5.expectedReturn)} <span className="muted tiny">5d</span></div>
                <div className="tiny muted num">conf {u.h5.confidence} · P(up) {(u.h5.probUp * 100).toFixed(0)}%</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-6">
        <h2>
          Market psychology <Tip text="How the crowd is likely behaving right now and what that means for entries, stops and size." />
        </h2>
        <div className="stack">
          {d.psychology.components.map((c) => (
            <div key={c.name} className="small">
              <div className="row">
                <span>{c.name}</span>
                <span className="spacer" />
                <span className="muted">{c.note}</span>
              </div>
              <div className="bar-track" style={{ marginTop: 3 }}>
                <div className="bar-fill" style={{ width: `${c.value}%`, background: "var(--s1)" }} />
              </div>
            </div>
          ))}
          {d.psychology.crowd.map((c) => (
            <div key={c} className="small ink2">• {c}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Leans({ rows, onOpen }: { rows: DashboardData["topBuys"]; onOpen: (s: string) => void }) {
  if (!rows.length) return <div className="empty">No names leaning this way right now.</div>;
  return (
    <div className="list">
      {rows.map(({ signal: s, forecast: f, actionable }) => {
        const h5 = f.horizons.find((h) => h.horizon === "5d")!;
        return (
          <div key={f.symbol} className="list-item" onClick={() => onOpen(f.symbol)}>
            <div style={{ minWidth: 0 }}>
              <div className="row">
                <span className="sym">{f.symbol}</span>
                <SideBadge side={s.side === "hold" ? (h5.expectedReturn > 0 ? "buy" : "sell") : s.side} actionable={actionable} />
              </div>
              <div className="name">{f.name}</div>
            </div>
            <div className="right" style={{ width: 130 }}>
              <div className="num">
                {fmtPrice(f.price)} <span className={`small ${cls(h5.expectedReturn)}`}>{fmtPct(h5.expectedReturn, 1)}</span> <span className="tiny muted">5d</span>
              </div>
              <ConfidenceMeter value={h5.confidence} label="" />
            </div>
          </div>
        );
      })}
    </div>
  );
}
