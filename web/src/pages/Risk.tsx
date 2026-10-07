import { useState } from "react";
import type { Position } from "../../../server/types";
import { api, cls, fmtPct, fmtPrice, useApp, usePoll } from "../api";
import { DrawdownChart } from "../components/charts";
import { SideBadge, Tip } from "../components/ui";

interface PortfolioResp {
  value: number;
  beta: number;
  sectors: { sector: string; pct: number; overLimit: boolean }[];
  correlationCreep: number;
  drawdown: number;
  drawdownSeries: { t: number; value: number; dd: number }[];
  nudges: string[];
  rows: (Position & { price: number; pnlPct: number; value: number; signal: "buy" | "sell" | "hold" })[];
  scenarios: { scenario: { id: string; name: string }; total: number; rows: { symbol: string; shockPct: number; pnl: number }[] }[];
}

export function Risk() {
  const { tick, boot, setBoot, toast, openTicker } = useApp();
  const [p, reload] = usePoll<PortfolioResp>("/risk/portfolio", [tick, boot.positions]);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Position[]>(boot.positions);
  const savePositions = async () => {
    const pos = await api<Position[]>("/positions", { method: "PUT", body: draft.filter((d) => d.symbol && d.qty) });
    setBoot((b) => ({ ...b, positions: pos }));
    setEdit(false);
    reload();
    toast("Positions saved");
  };

  return (
    <div className="grid">
      <div className="card span-12">
        <h2>
          Portfolio <Tip text="Live beta, sector concentration, correlation creep and drawdown, with nudges when you drift past your limits (set in Me → Risk)." />
          <span className="sub"><button className="btn sm" onClick={() => (setDraft(boot.positions), setEdit(!edit))}>{edit ? "Cancel" : "Edit positions"}</button></span>
        </h2>
        {p && (
          <div className="kpis">
            <div className="kpi"><div className="v num">${p.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div><div className="k">Value</div></div>
            <div className="kpi"><div className="v num">{p.beta.toFixed(2)}</div><div className="k">Beta</div></div>
            <div className="kpi"><div className="v num">{p.correlationCreep.toFixed(2)}</div><div className="k">Avg correlation</div></div>
            <div className="kpi"><div className="v num">{fmtPct(p.drawdown, 1)}</div><div className="k">Max drawdown (120d)</div></div>
          </div>
        )}
        {p?.nudges.map((n) => <div key={n} className="small status-warn" style={{ marginTop: 8 }}>{n}</div>)}
        {edit ? (
          <div style={{ marginTop: 10 }}>
            {draft.map((d, i) => (
              <div key={i} className="row" style={{ marginBottom: 6 }}>
                <input className="field" value={d.symbol} placeholder="Ticker" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, symbol: e.target.value.toUpperCase() } : x)))} />
                <input className="field" inputMode="decimal" value={d.qty} placeholder="Qty" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
                <input className="field" inputMode="decimal" value={d.avgPrice} placeholder="Avg price" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, avgPrice: Number(e.target.value) } : x)))} />
                <button className="btn sm ghost" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div className="row">
              <button className="btn" onClick={() => setDraft([...draft, { symbol: "", qty: 0, avgPrice: 0 }])}>＋ Add</button>
              <button className="btn primary" onClick={savePositions}>Save</button>
            </div>
          </div>
        ) : (
          <div className="list" style={{ marginTop: 8 }}>
            {p?.rows.map((r) => (
              <div key={r.symbol} className="list-item" onClick={() => openTicker(r.symbol)}>
                <div><div className="row"><span className="sym">{r.symbol}</span><SideBadge side={r.signal} /></div><div className="name">{r.qty} @ {fmtPrice(r.avgPrice)}</div></div>
                <div className="right"><div className="num">${r.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div><div className={`small num ${cls(r.pnlPct)}`}>{fmtPct(r.pnlPct, 1)}</div></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {p && (
        <>
          <div className="card span-6">
            <h2>Sector exposure <span className="sub">limit {boot.profile.risk.maxSectorPct}%</span></h2>
            {p.sectors.map((s) => (
              <div key={s.sector} className="small" style={{ marginBottom: 8 }}>
                <div className="row"><span>{s.sector}</span>{s.overLimit && <span className="status-crit tiny">Over limit</span>}<span className="spacer" /><span className="num">{s.pct.toFixed(0)}%</span></div>
                <div className="bar-track" style={{ marginTop: 3, position: "relative" }}>
                  <div className="bar-fill" style={{ width: `${s.pct}%`, background: "var(--s1)" }} />
                  <div style={{ position: "absolute", left: `${boot.profile.risk.maxSectorPct}%`, top: -2, bottom: -2, width: 2, background: "var(--ink-2)" }} />
                </div>
              </div>
            ))}
            <h2 style={{ marginTop: 12 }}>Drawdown line</h2>
            <DrawdownChart data={p.drawdownSeries} dataKey="dd" />
          </div>
          <div className="card span-6">
            <h2>
              Scenario tests <Tip text="What-if shocks applied to today's positions using each holding's beta and sector. Historical analogs replay the shape of past stress events." />
            </h2>
            <table className="tbl">
              <thead><tr><th>Scenario</th><th style={{ textAlign: "right" }}>P&L</th><th style={{ textAlign: "right" }}>% of value</th></tr></thead>
              <tbody>
                {p.scenarios.map((s) => (
                  <tr key={s.scenario.id} title={s.rows.map((r) => `${r.symbol} ${r.shockPct.toFixed(1)}%`).join(", ")}>
                    <td>{s.scenario.name}</td>
                    <td style={{ textAlign: "right" }} className={cls(s.total)}>{s.total >= 0 ? "+" : "−"}${Math.abs(s.total).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: "right" }} className={cls(s.total)}>{fmtPct((s.total / (p.value || 1)) * 100, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <SizingAssistant />
    </div>
  );
}

function SizingAssistant() {
  const { boot } = useApp();
  const [symbol, setSymbol] = useState("NVDA");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [confidence, setConfidence] = useState("60");
  const [out, setOut] = useState<{ shares: number; notional: number; riskDollars: number; pctOfAccount: number; explain: string }>();
  const calc = async () => setOut(await api("/risk/size", { method: "POST", body: { symbol, entry: Number(entry), stop: Number(stop), confidence: Number(confidence) } }));
  return (
    <div className="card span-12">
      <h2>
        Position sizing assistant <Tip text="Uses your account risk budget, the stop distance, volatility and forecast confidence to suggest a quantity. Change the budget in Me → Risk." />
        <span className="sub">${boot.profile.risk.accountSize.toLocaleString()} · {boot.profile.risk.riskPerTradePct}% risk/trade</span>
      </h2>
      <div className="form-grid">
        <div><label className="lbl">Ticker</label><input className="field" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></div>
        <div><label className="lbl">Entry</label><input className="field" inputMode="decimal" value={entry} onChange={(e) => setEntry(e.target.value)} /></div>
        <div><label className="lbl">Stop</label><input className="field" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} /></div>
        <div><label className="lbl">Confidence</label><input className="field" inputMode="numeric" value={confidence} onChange={(e) => setConfidence(e.target.value)} /></div>
      </div>
      <button className="btn primary" style={{ marginTop: 10 }} disabled={!entry || !stop} onClick={calc}>Calculate</button>
      {out && (
        <>
          <div className="kpis" style={{ marginTop: 10 }}>
            <div className="kpi"><div className="v num">{out.shares}</div><div className="k">Quantity</div></div>
            <div className="kpi"><div className="v num">${out.notional.toFixed(0)}</div><div className="k">Notional</div></div>
            <div className="kpi"><div className="v num">${out.riskDollars.toFixed(0)}</div><div className="k">Max loss at stop</div></div>
            <div className="kpi"><div className="v num">{out.pctOfAccount.toFixed(1)}%</div><div className="k">Of account</div></div>
          </div>
          <p className="small ink2">{out.explain}</p>
        </>
      )}
    </div>
  );
}
