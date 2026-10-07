import { useState } from "react";
import type { BacktestMetrics, BacktestResult, StrategyConfig } from "../../../server/types";
import { api, fmtPct, useApp } from "../api";
import { DrawdownChart, EquityChart } from "../components/charts";
import { Tip } from "../components/ui";

type Template = StrategyConfig["template"];

export function StrategyLab() {
  const { boot, setBoot, toast } = useApp();
  const [template, setTemplate] = useState<Template>("trend");
  const [params, setParams] = useState<Record<string, number>>(boot.templates.trend.params);
  const [risk, setRisk] = useState({ stopAtr: 2, targetAtr: 4, timeStopDays: 15, trailing: true, drawdownBrakePct: 15 });
  const [universe, setUniverse] = useState("SPY, QQQ, NVDA, MSFT, AAPL, AMZN, META, AVGO");
  const [costBps, setCostBps] = useState(5);
  const [name, setName] = useState("My trend strategy");
  const [res, setRes] = useState<BacktestResult>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const pick = (t: Template) => {
    setTemplate(t);
    setParams(boot.templates[t].params);
    setName(`My ${boot.templates[t].label.toLowerCase()} strategy`);
    setRes(undefined);
  };
  const body = () => ({ name, template, params, risk, universe: universe.split(/[\s,]+/).filter(Boolean), costBps });
  const run = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      setRes(await api<BacktestResult>("/backtest", { method: "POST", body: body() }));
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  const save = async () => {
    const s = await api<StrategyConfig>("/strategies", { method: "POST", body: body() });
    setBoot((b) => ({ ...b, strategies: [...b.strategies, s] }));
    toast("Strategy saved");
  };
  const load = (s: StrategyConfig) => {
    setTemplate(s.template); setParams(s.params); setRisk(s.risk); setUniverse(s.universe.join(", ")); setName(s.name); setRes(undefined);
  };

  return (
    <div className="grid">
      <div className="card span-12">
        <h2>
          Strategy Lab <Tip text="Design a rule, add risk overlays, then backtest with walk-forward validation. Only save strategies that hold up out-of-sample." />
        </h2>
        <div className="chips">
          {(Object.keys(boot.templates) as Template[]).map((t) => (
            <button key={t} className={`chip ${template === t ? "on" : ""}`} onClick={() => pick(t)}>{boot.templates[t].label}</button>
          ))}
        </div>
        <p className="small ink2">{boot.templates[template].describe}</p>
        <div className="form-grid">
          <div><label className="lbl">Name</label><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></div>
          {Object.entries(params).map(([k, v]) => (
            <div key={k}>
              <label className="lbl">{k}</label>
              <input className="field" inputMode="decimal" value={v} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} />
            </div>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>Guardrail: max {boot.maxParams} tunable parameters. Walk-forward tests ±25% around the first parameter.</div>

        <h2 style={{ marginTop: 14 }}>Risk overlays <Tip text="Multi-stop logic: ATR stop, ATR target, trailing stop, time-based exit and a portfolio drawdown brake that pauses new entries." /></h2>
        <div className="form-grid">
          <div><label className="lbl">Stop (× ATR)</label><input className="field" inputMode="decimal" value={risk.stopAtr} onChange={(e) => setRisk({ ...risk, stopAtr: Number(e.target.value) })} /></div>
          <div><label className="lbl">Target (× ATR)</label><input className="field" inputMode="decimal" value={risk.targetAtr} onChange={(e) => setRisk({ ...risk, targetAtr: Number(e.target.value) })} /></div>
          <div><label className="lbl">Time stop (days)</label><input className="field" inputMode="numeric" value={risk.timeStopDays} onChange={(e) => setRisk({ ...risk, timeStopDays: Number(e.target.value) })} /></div>
          <div><label className="lbl">Drawdown brake %</label><input className="field" inputMode="decimal" value={risk.drawdownBrakePct} onChange={(e) => setRisk({ ...risk, drawdownBrakePct: Number(e.target.value) })} /></div>
          <div><label className="lbl">Costs (bps / side)</label><input className="field" inputMode="decimal" value={costBps} onChange={(e) => setCostBps(Number(e.target.value))} /></div>
          <label className="switch" style={{ alignSelf: "end" }}>Trailing stop<input type="checkbox" checked={risk.trailing} onChange={(e) => setRisk({ ...risk, trailing: e.target.checked })} /></label>
        </div>
        <label className="lbl">Universe</label>
        <input className="field" value={universe} onChange={(e) => setUniverse(e.target.value.toUpperCase())} autoCapitalize="characters" />
        <div className="row wrap" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={run} disabled={busy}>{busy ? "Backtesting…" : "Run backtest"}</button>
          <button className="btn" onClick={save} disabled={!res}>Save strategy</button>
          {boot.strategies.map((s) => (
            <button key={s.id} className="chip" onClick={() => load(s)}>{s.name}</button>
          ))}
        </div>
        {err && <div className="small down" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      {res && (
        <>
          {res.warnings.length > 0 && (
            <div className="card span-12">
              {res.warnings.map((w) => <div key={w} className="small status-warn" style={{ padding: "3px 0" }}>{w}</div>)}
            </div>
          )}
          <div className="card span-6">
            <h2>Equity curve <span className="sub">in-sample, after costs</span></h2>
            <EquityChart data={res.equity} />
            <h2 style={{ marginTop: 10 }}>Drawdown</h2>
            <DrawdownChart data={res.equity} />
          </div>
          <div className="card span-6">
            <h2>
              Metrics <Tip text="Out-of-sample is what matters: each fold picks parameters on past data only, then trades the next unseen window. Hit rate × payoff = edge; MAR = CAGR ÷ max drawdown." />
            </h2>
            <MetricsTable a={res.inSample} b={res.outOfSample} />
          </div>
          <div className="card span-6">
            <h2>Walk-forward folds</h2>
            <table className="tbl">
              <thead><tr><th>Window</th><th>Return</th><th>Sharpe</th><th>Trades</th></tr></thead>
              <tbody>
                {res.folds.map((f) => (
                  <tr key={f.start}>
                    <td>{new Date(f.start).toLocaleDateString()} – {new Date(f.end).toLocaleDateString()}</td>
                    <td>{fmtPct(f.metrics.totalReturn * 100, 1)}</td>
                    <td>{f.metrics.sharpe.toFixed(2)}</td>
                    <td>{f.metrics.trades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card span-6">
            <h2>By regime <Tip text="Regime stability: a robust strategy shouldn't depend on a single market state." /></h2>
            <table className="tbl">
              <thead><tr><th>Regime</th><th>Return</th><th>Sharpe</th><th>Hit</th></tr></thead>
              <tbody>
                {res.byRegime.map((r) => (
                  <tr key={r.regime}><td>{r.regime}</td><td>{fmtPct(r.metrics.totalReturn * 100, 1)}</td><td>{r.metrics.sharpe.toFixed(2)}</td><td>{(r.metrics.hitRate * 100).toFixed(0)}%</td></tr>
                ))}
              </tbody>
            </table>
            <h2 style={{ marginTop: 12 }}>Transaction-cost sensitivity</h2>
            <table className="tbl">
              <thead><tr><th>Cost (bps)</th><th>Return</th><th>Sharpe</th></tr></thead>
              <tbody>
                {res.tcSensitivity.map((t) => (
                  <tr key={t.costBps}><td>{t.costBps}</td><td>{fmtPct(t.totalReturn * 100, 1)}</td><td>{t.sharpe.toFixed(2)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function MetricsTable({ a, b }: { a: BacktestMetrics; b: BacktestMetrics }) {
  const rows: [string, (m: BacktestMetrics) => string][] = [
    ["Total return", (m) => fmtPct(m.totalReturn * 100, 1)],
    ["CAGR", (m) => fmtPct(m.cagr * 100, 1)],
    ["Max drawdown", (m) => fmtPct(m.maxDrawdown * 100, 1)],
    ["Sharpe", (m) => m.sharpe.toFixed(2)],
    ["Sortino", (m) => m.sortino.toFixed(2)],
    ["MAR", (m) => m.mar.toFixed(2)],
    ["Hit rate", (m) => `${(m.hitRate * 100).toFixed(0)}%`],
    ["Payoff ratio", (m) => m.payoff.toFixed(2)],
    ["Trades", (m) => String(m.trades)],
    ["Exposure", (m) => `${(m.exposure * 100).toFixed(0)}%`],
    ["Exposure-adj. return", (m) => fmtPct(m.exposureAdjReturn * 100, 1)],
    ["Turnover (trades/yr)", (m) => m.turnover.toFixed(0)],
  ];
  return (
    <table className="tbl">
      <thead><tr><th>Metric</th><th>In-sample</th><th>Out-of-sample</th></tr></thead>
      <tbody>{rows.map(([k, f]) => <tr key={k}><td>{k}</td><td>{f(a)}</td><td><b>{f(b)}</b></td></tr>)}</tbody>
    </table>
  );
}
