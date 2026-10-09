import { useState } from "react";
import type { Bar, Forecast, Fundamentals, Instrument, NewsItem, SignalCard } from "../../../server/types";
import { api, ago, cls, fmtPct, fmtPrice, useApp, usePoll } from "../api";
import { AttributionBars, ForecastChart, HorizonBands } from "../components/charts";
import { ConfidenceMeter, SideBadge, Tip } from "../components/ui";

interface Detail {
  forecast: Forecast;
  signal?: SignalCard;
  bars: Bar[];
  news: NewsItem[];
  fundamentals: Fundamentals;
  instrument?: Instrument;
  stops: { static: number; atr: number; trailing: { distance: number; note: string }; time: { days: number; note: string } };
}

export function Ticker({ symbol }: { symbol: string }) {
  const { tick, boot, setBoot, toast } = useApp();
  const [d] = usePoll<Detail>(`/forecast/${symbol}`, [tick]);
  const [alertLevel, setAlertLevel] = useState("");
  if (!d) return <div className="empty">Loading {symbol}…</div>;
  const f = d.forecast;
  const s = d.signal;
  const h5 = f.horizons.find((h) => h.horizon === "5d")!;

  const addToList = async (id: string) => {
    const wl = boot.watchlists.find((w) => w.id === id)!;
    if (wl.symbols.includes(symbol)) return toast(`${symbol} is already in ${wl.name}`);
    const upd = await api<typeof wl>(`/watchlists/${id}`, { method: "PUT", body: { symbols: [...wl.symbols, symbol] } });
    setBoot((b) => ({ ...b, watchlists: b.watchlists.map((w) => (w.id === id ? upd : w)) }));
    toast(`Added ${symbol} to ${wl.name}`);
  };
  const addAlert = async (kind: string, value?: number) => {
    const a = await api<(typeof boot.alerts)[number]>("/alerts", { method: "POST", body: { symbol, kind, value } });
    setBoot((b) => ({ ...b, alerts: [...b.alerts, a] }));
    toast("Alert saved");
  };

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="row">
            <span className="hero">{f.symbol}</span>
            {s && <SideBadge side={s.side} />}
          </div>
          <div className="ink2 small">{f.name} · {f.sector} · {f.themes.join(", ")}</div>
        </div>
        <span className="spacer" />
        <div style={{ textAlign: "right" }}>
          <div className="hero num" style={{ fontSize: 26 }}>{fmtPrice(f.price)}</div>
          <div className={`num ${cls(f.changePct)}`}>{fmtPct(f.changePct)} today</div>
        </div>
      </div>

      <div className="card">
        <h2>
          5-day forecast <Tip text="The dashed line is the model's expected path; the shaded cone is the 80% confidence band — 8 times out of 10 the price should finish inside it." />
          <span className="sub">{f.regime.label}</span>
        </h2>
        <ForecastChart bars={d.bars} path={f.path} />
      </div>

      {s && <SignalCardView s={s} f={f} d={d} />}

      <div className="grid">
        <div className="card span-6">
          <h2>
            Multi-horizon forecasts <Tip text="Expected return (dot) and 80% band (bar) for each horizon. Longer horizons have wider bands — uncertainty grows with time." />
          </h2>
          <HorizonBands horizons={f.horizons} />
        </div>
        <div className="card span-6">
          <h2>
            What drove this call <Tip text="Feature attributions for the 5-day forecast: how many percentage points each input added or subtracted." />
          </h2>
          <AttributionBars items={f.attributions} />
        </div>

        <div className="card span-6">
          <h2>
            Poker read <Tip text="Treat each trade like a poker hand: only play when your equity (win probability) beats the pot odds (the break-even win rate implied by reward/risk), and bet a fraction of Kelly — never all-in." />
          </h2>
          <div className="kpis">
            <div className="kpi"><div className="v num">{(f.poker.equity * 100).toFixed(0)}%</div><div className="k">Equity (win prob)</div></div>
            <div className="kpi"><div className="v num">{(f.poker.potOdds * 100).toFixed(0)}%</div><div className="k">Pot odds (break-even)</div></div>
            <div className="kpi"><div className="v">{f.poker.action.toUpperCase()}</div><div className="k">Action</div></div>
            <div className="kpi"><div className="v num">{(f.poker.kellyFraction * 100).toFixed(1)}%</div><div className="k">¼-Kelly size</div></div>
          </div>
          <p className="small ink2">{f.poker.note}</p>
          <ConfidenceMeter value={f.poker.handStrength} label="Hand strength" />
        </div>

        <div className="card span-6">
          <h2>
            Integrity checks <Tip text="What might break this forecast. Every failed check lowers trust in the call." />
          </h2>
          {f.integrity.map((c) => (
            <div key={c.name} className="row small" style={{ padding: "5px 0" }}>
              <span className={c.ok ? "status-good" : "status-warn"}>{c.ok ? "Pass" : "Watch"}</span>
              <b>{c.name}</b>
              <span className="spacer" />
              <span className="muted" style={{ textAlign: "right" }}>{c.note}</span>
            </div>
          ))}
          <h2 style={{ marginTop: 12 }}>Model votes (5d)</h2>
          {f.modelVotes.map((v) => (
            <div key={v.model} className="row small" style={{ padding: "3px 0" }}>
              <span>{v.model}</span>
              <span className="muted tiny">weight {v.weight}</span>
              <span className="spacer" />
              <span className={`num ${cls(v.expectedReturn)}`}>{fmtPct(v.expectedReturn)}</span>
            </div>
          ))}
        </div>

        <div className="card span-6">
          <h2>Recent catalysts & news</h2>
          {f.catalysts.map((c) => (
            <div key={c} className="small" style={{ padding: "3px 0" }}>• {c}</div>
          ))}
          <div className="list" style={{ marginTop: 6 }}>
            {d.news.slice(0, 8).map((n) => (
              <div key={n.id} className="feed-item small">
                <div className="row">
                  <span className={`num ${cls(n.sentiment)}`} style={{ minWidth: 40 }}>{n.sentiment.toFixed(2)}</span>
                  {n.url ? <a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a> : <span>{n.headline}</span>}
                </div>
                <div className="tiny muted">{n.source} · {ago(n.t)} ago</div>
              </div>
            ))}
          </div>
          <div className="tiny muted">Sources: {f.sources.join(", ")}</div>
        </div>

        <div className="card span-6">
          <h2>Automate</h2>
          <label className="lbl">Add to watchlist</label>
          <div className="chips">
            {boot.watchlists.map((w) => (
              <button key={w.id} className="chip" onClick={() => addToList(w.id)}>+ {w.name}</button>
            ))}
          </div>
          <label className="lbl">Alert at exact price</label>
          <div className="row">
            <input className="field" inputMode="decimal" placeholder={fmtPrice(f.price)} value={alertLevel} onChange={(e) => setAlertLevel(e.target.value)} />
            <button className="btn" disabled={!alertLevel} onClick={() => addAlert(Number(alertLevel) >= f.price ? "price-above" : "price-below", Number(alertLevel))}>Set</button>
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => addAlert("sentiment-flip")}>Sentiment flip</button>
            <button className="btn sm" onClick={() => addAlert("signal")}>New signal</button>
            <button className="btn sm" onClick={() => addAlert("exit")}>Exit alerts</button>
            <button className="btn sm" onClick={() => addAlert("pct-move", 3)}>±3% move</button>
            <button className="btn sm" onClick={() => addAlert("earnings", 3)}>Earnings</button>
          </div>
        </div>
      </div>
      <p className="disclaimer">Analytics and education only — not financial advice. You approve every trade.</p>
    </div>
  );
}

function SignalCardView({ s, f, d }: { s: SignalCard; f: Forecast; d: Detail }) {
  const { boot } = useApp();
  const [account, setAccount] = useState(boot.profile.risk.accountSize);
  const scale = account / boot.profile.risk.accountSize;
  const shares = s.entry > 1000 ? s.sizing.shares * scale : Math.floor(s.sizing.shares * scale);
  return (
    <div className="card">
      <h2>
        Signal card <Tip text="The forecast translated into a rules-based trade: where to enter, where you're wrong (stop), where to take profit (target), how long to hold and how much to buy so a stop-out only costs your per-trade risk budget." />
        <span className="sub">{s.rule} rule · {s.expectedMovePct >= 0 ? "long" : "short"} setup{s.side === "hold" ? " (not triggered)" : ""}</span>
      </h2>
      <div className="kpis">
        <div className="kpi"><div className="v num">{fmtPrice(s.entry)}</div><div className="k">Entry</div></div>
        <div className="kpi"><div className="v num down">{fmtPrice(s.stop)}</div><div className="k">Stop ({s.trailingAtr}× ATR)</div></div>
        <div className="kpi"><div className="v num up">{fmtPrice(s.target)}</div><div className="k">Target</div></div>
        <div className="kpi"><div className={`v num ${cls(s.expectedMovePct)}`}>{fmtPct(s.expectedMovePct, 1)}</div><div className="k">Expected move</div></div>
        <div className="kpi"><div className="v num">{s.holdingDays}d</div><div className="k">Holding window</div></div>
        <div className="kpi"><div className="v num">{s.rr.toFixed(1)}:1</div><div className="k">Reward : risk</div></div>
      </div>
      <p className="small ink2">{s.rationale}</p>
      <ConfidenceMeter value={s.confidence} />
      {s.side !== "hold" && (
        <div style={{ marginTop: 12 }}>
          <div className="row small">
            <b>Size it</b>
            <Tip text="Shares = (account × risk per trade %) ÷ (entry − stop), scaled by confidence and capped by your max position %. Novice mode halves the risk." />
            <span className="spacer" />
            <span className="muted">Account</span>
            <input className="field" style={{ width: 120, minHeight: 36 }} inputMode="numeric" value={account} onChange={(e) => setAccount(Number(e.target.value) || 0)} />
          </div>
          <div className="kpis" style={{ marginTop: 8 }}>
            <div className="kpi"><div className="v num">{shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div><div className="k">Shares / units</div></div>
            <div className="kpi"><div className="v num">${(shares * s.entry).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div><div className="k">Notional</div></div>
            <div className="kpi"><div className="v num">${(shares * Math.abs(s.entry - s.stop)).toFixed(0)}</div><div className="k">Risk if stopped</div></div>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}>
            Stops: static {fmtPrice(d.stops.static)} · ATR {fmtPrice(d.stops.atr)} · {d.stops.trailing.note} · {d.stops.time.note}.
            {s.extendedHours ? " Extended-hours alerts on." : " Regular session only."}
          </div>
          {s.backtest && (
            <div className="small ink2" style={{ marginTop: 6 }}>
              Backtested {s.rule} rule (out-of-sample): hit rate {(s.backtest.hitRate * 100).toFixed(0)}%, payoff {s.backtest.payoff.toFixed(2)}, Sharpe {s.backtest.sharpe.toFixed(2)}, {s.backtest.trades} trades.
            </div>
          )}
        </div>
      )}
      <div className="tiny muted" style={{ marginTop: 6 }}>Signal for {f.symbol} · {new Date(s.createdAt).toLocaleString()}</div>
    </div>
  );
}
