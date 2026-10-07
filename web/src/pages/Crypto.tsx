import { useEffect, useState } from "react";
import type { Bar, ConvergenceSnapshot, LatencyState, LatencyTrade } from "../../../server/types";
import { api, ago, cls, fmtPrice, useApp } from "../api";
import { PriceLine } from "../components/charts";
import { Tip } from "../components/ui";
import { ForceGraph } from "../components/viz";

type Cfg = Record<string, number>;
export type CryptoMsg = { state: LatencyState; graph: ConvergenceSnapshot };

export function Crypto({ live }: { live?: CryptoMsg }) {
  const { toast } = useApp();
  const [init, setInit] = useState<CryptoMsg & { config: Cfg; klines: Bar[] }>();
  const [cfg, setCfg] = useState<Cfg>();
  useEffect(() => {
    api<CryptoMsg & { config: Cfg; klines: Bar[] }>("/crypto").then((d) => (setInit(d), setCfg(d.config)));
    const t = setInterval(() => api<CryptoMsg & { config: Cfg; klines: Bar[] }>("/crypto").then((d) => setInit((p) => ({ ...(p ?? d), klines: d.klines }))), 30_000);
    return () => clearInterval(t);
  }, []);
  const s = live?.state ?? init?.state;
  const g = live?.graph ?? init?.graph;
  if (!s || !g || !cfg) return <div className="empty">Connecting to the BTC engine…</div>;
  const left = Math.max(0, Math.round((s.windowEndsAt - Date.now()) / 1000));
  const closed = s.trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const saveCfg = async () => {
    setCfg(await api<Cfg>("/crypto/config", { method: "PUT", body: cfg }));
    toast("Engine limits updated");
  };
  const verdictColor = g.verdict === "BULL" ? "var(--div-pos)" : g.verdict === "BEAR" ? "var(--div-neg)" : "var(--warn)";

  return (
    <div className="grid">
      <div className="card span-12">
        <h2>
          BTC 5-min latency engine <Tip text="The edge isn't predicting BTC. It's the time gap between spot moving on Binance, the signal swarm converging, and the Polymarket CLOB repricing. The engine only acts when all three line up — and skips otherwise." />
          <span className="sub">{s.mode === "paper" ? "PAPER trading" : "live disabled"}</span>
        </h2>
        <div className="kpis">
          <div className="kpi"><div className="v num">{fmtPrice(s.spot)}</div><div className="k">BTC spot · open {fmtPrice(s.windowOpen)}</div></div>
          <div className="kpi"><div className="v num">{left}s</div><div className="k">Left in 5-min window</div></div>
          <div className="kpi"><div className="v num">{(s.fairProb * 100).toFixed(1)}¢</div><div className="k">Fair UP price</div></div>
          <div className="kpi"><div className="v num">{(s.clobMid * 100).toFixed(1)}¢</div><div className="k">CLOB UP mid</div></div>
          <div className="kpi"><div className={`v num ${Math.abs(s.lagPct) >= cfg.lagTriggerPct ? "up" : ""}`}>{s.lagPct.toFixed(3)}%</div><div className="k">CLOB lag vs spot (trigger {cfg.lagTriggerPct}%)</div></div>
          <div className="kpi"><div className={`v num ${cls(s.edge)}`}>{(s.edge * 100).toFixed(2)}pp</div><div className="k">Edge after fees</div></div>
          <div className="kpi"><div className="v" style={{ color: verdictColor }}>{g.verdict} {(g.convergence * 100).toFixed(0)}%</div><div className="k">Swarm convergence</div></div>
          <div className="kpi"><div className="v num">{s.evalsPerSec}/s</div><div className="k">Evaluations</div></div>
        </div>
        <div className="small ink2" style={{ marginTop: 8 }}>
          Last decision: <b>{s.lastDecision}</b>
        </div>
        <div className="tiny muted" style={{ marginTop: 4 }}>
          Feeds — Binance: {s.feeds.binance} · Polymarket: {s.feeds.polymarket} · TradingView: {s.feeds.tradingview} · CryptoQuant: {s.feeds.cryptoquant}
        </div>
      </div>

      <div className="card span-8">
        <h2>
          Signal swarm <Tip text="100 signal nodes (trade flow, momentum, 5m indicators, order book, Polymarket, TradingView, CryptoQuant) and the 180 strongest co-movement edges. Label propagation groups them into BULL and BEAR clusters." />
          <span className="sub">{g.nodes.length} nodes · {g.edges.length} edges</span>
        </h2>
        <ForceGraph snap={g} />
        <div className="row small" style={{ marginTop: 6 }}>
          <span className="ink2">Bull mass {g.bullMass.toFixed(1)}</span>
          <div className="bar-track" style={{ flex: 1, display: "flex" }}>
            <div style={{ width: `${(g.bullMass / (g.bullMass + g.bearMass || 1)) * 100}%`, background: "var(--div-pos)" }} />
            <div style={{ flex: 1, background: "var(--div-neg)" }} />
          </div>
          <span className="ink2">Bear mass {g.bearMass.toFixed(1)}</span>
        </div>
      </div>

      <div className="card span-4">
        <h2>Risk controls</h2>
        <div className="kpis">
          <div className="kpi"><div className="v num">${s.bankroll.toFixed(2)}</div><div className="k">Paper bankroll</div></div>
          <div className="kpi"><div className={`v num ${cls(s.dayPnl)}`}>{s.dayPnlPct.toFixed(2)}%</div><div className="k">Today {s.halted ? "· HALTED" : ""}</div></div>
          <div className="kpi"><div className="v num">{closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—"}</div><div className="k">Win rate ({closed.length})</div></div>
        </div>
        <div className="form-grid" style={{ marginTop: 6 }}>
          {(
            [
              ["perTradeRiskPct", "Per-trade risk %"],
              ["dailyLossCapPct", "Daily loss cap %"],
              ["hardStopPct", "Hard stop %"],
              ["lagTriggerPct", "Lag trigger %"],
              ["takeProfitMinPct", "Take profit min %"],
              ["takeProfitMaxPct", "Take profit max %"],
              ["minEdge", "Min edge (prob)"],
              ["minDepthUsd", "Min depth $"],
              ["maxOrdersPerSec", "Max orders/sec"],
            ] as const
          ).map(([k, l]) => (
            <div key={k}>
              <label className="lbl">{l}</label>
              <input className="field" inputMode="decimal" value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} />
            </div>
          ))}
        </div>
        <button className="btn primary" style={{ marginTop: 10, width: "100%" }} onClick={saveCfg}>Apply limits</button>
        <h2 style={{ marginTop: 14 }}>Skip reasons</h2>
        {Object.entries(s.skips).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
          <div key={k} className="row small"><span>{k}</span><span className="spacer" /><span className="num muted">{v.toLocaleString()}</span></div>
        ))}
      </div>

      <div className="card span-6">
        <h2>BTC 5m klines</h2>
        {init?.klines && <PriceLine data={init.klines.map((k) => ({ t: k.t, c: k.c }))} />}
      </div>
      <div className="card span-6">
        <h2>Trades <span className="sub">{s.trades.length}</span></h2>
        <TradeList trades={s.trades} />
      </div>
      <p className="disclaimer span-12">
        Paper trading only. Live order routing is intentionally not wired up — prediction markets are restricted in some jurisdictions, and latency strategies lose money to fees, spread and slippage more often than screenshots suggest.
      </p>
    </div>
  );
}

function TradeList({ trades }: { trades: LatencyTrade[] }) {
  if (!trades.length) return <div className="empty">No trades yet — the engine is skipping until every condition lines up.</div>;
  return (
    <div style={{ maxHeight: 340, overflowY: "auto" }}>
      {trades.map((t) => (
        <div key={t.id} className="feed-item small">
          <div className="row">
            <span className={`badge ${t.side === "UP" ? "buy" : "sell"}`}>{t.side}</span>
            <span className="num">{(t.entry * 100).toFixed(1)}¢ → {t.exit !== undefined ? `${(t.exit * 100).toFixed(1)}¢` : "open"}</span>
            <span className="spacer" />
            <span className={`num ${cls(t.pnl ?? 0)}`}>{t.pnl !== undefined ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : `$${t.stake.toFixed(2)}`}</span>
          </div>
          <div className="tiny muted">{t.reason} · {t.latencyMs}ms · {ago(t.t)} ago</div>
        </div>
      ))}
    </div>
  );
}
