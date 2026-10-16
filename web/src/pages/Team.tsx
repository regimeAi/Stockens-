import { useEffect, useState } from "react";
import { api, ago, cls, fmtPct, fmtPrice, useApp, usePoll } from "../api";
import { EquityChart } from "../components/charts";
import { Tip } from "../components/ui";

interface Pos {
  id: string; symbol: string; qty: number; entry: number; stop: number; target: number; openedAt: number; setup: string; live: boolean;
  price: number; value: number; pnl: number; pnlPct: number;
}
interface Closed { id: string; symbol: string; qty: number; entry: number; exit: number; exitAt: number; pnl: number; pnlPct: number; reason: string; daysHeld: number; setup: string }
interface Proposal { id: string; t: number; symbol: string; price: number; exp: number; conf: number; rr: number; setup: string; status: "approved" | "rejected"; note: string }
type Settings = Record<string, number | boolean>;
interface TeamResp {
  settings: Settings;
  startedAt: number;
  cash: number;
  paused: string | null;
  marketOpen: boolean;
  agents: Record<"scout" | "risk" | "trader" | "pm", { at: number; msg: string }>;
  stats: {
    equity: number; totalPnl: number; totalReturnPct: number; spyReturnPct?: number; realized: number; unrealized: number; trades: number;
    winRate: number; avgWin: number; avgLoss: number; profitFactor: number; expectancy: number; fees: number; maxDrawdownPct: number; avgHoldDays: number;
  };
  positions: Pos[];
  closed: Closed[];
  proposals: Proposal[];
  equity: { t: number; equity: number; spy: number }[];
  canManage: boolean;
}

const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(3));

const AGENTS = [
  { key: "scout", icon: "🔭", name: "Scout", role: "Finds dips in strong stocks the forecasts like" },
  { key: "risk", icon: "🛡️", name: "Risk Manager", role: "Approves or rejects every idea and sizes it" },
  { key: "trader", icon: "⚡", name: "Trader", role: "Buys, then manages every stop, target and time exit" },
  { key: "pm", icon: "📒", name: "Portfolio Manager", role: "Keeps the books, compares with SPY, pauses on losses" },
] as const;

const RULES: [string, string, string][] = [
  ["riskPerTradePct", "Risk per trade (% of equity)", "How much the account loses if a trade hits its stop."],
  ["maxPositions", "Max open positions", ""],
  ["maxPositionPct", "Max per stock (% of equity)", ""],
  ["maxSectorPct", "Max per sector (%)", ""],
  ["stopAtr", "Stop distance (× ATR)", "ATR = a stock's typical daily move. 1.5× gives normal wiggle room."],
  ["minRewardRisk", "Min reward : risk", "Target must be at least this many times the distance to the stop."],
  ["maxHoldDays", "Max hold (trading days)", "Sell after this many days no matter what — keeps it quick."],
  ["minConfidence", "Min forecast confidence", ""],
  ["dailyLossLimitPct", "Daily loss limit (%)", "Pause new trades for the rest of the day past this loss."],
  ["drawdownPausePct", "Drawdown pause (%)", "Pause until you resume if equity falls this far below its peak."],
  ["slippageBps", "Slippage per side (bps)", "Realistic cost of getting filled. 5 bps = 0.05%."],
  ["feePerTrade", "Fee per trade ($)", ""],
];

export function Team() {
  const { tick, toast, openTicker } = useApp();
  const [d, reload] = usePoll<TeamResp>("/team", [tick]);
  const [edit, setEdit] = useState<Settings>();
  useEffect(() => {
    if (d && !edit) setEdit(d.settings);
  }, [d]);
  if (!d) return <div className="empty">Assembling the team…</div>;
  const s = d.stats;
  const start = d.equity[0];
  const curve = d.equity.map((e) => ({ t: e.t, equity: e.equity / (start?.equity || 1), benchmark: start?.spy ? e.spy / start.spy : 1 }));
  const act = async (path: string, body?: unknown, msg?: string) => {
    try {
      await api(`/team/${path}`, { method: path === "settings" ? "PUT" : "POST", body });
      if (msg) toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="grid">
      <div className="card span-12">
        <h2>
          Paper trading team{" "}
          <Tip text="Four background agents run a practice account with pretend money and real prices (when live data is connected). Nothing here touches a real brokerage. The goal is to prove — or disprove — that the strategy makes money before you risk any." />
          <span className="sub">
            {d.paused ? <span className="status-warn">Paused</span> : <span className="status-good">Running</span>}
            {" · "}
            {!d.settings.marketHoursOnly ? "trades any time (market-hours rule off)" : d.marketOpen ? "market open" : "market closed — waits for 9:30 ET"}
          </span>
        </h2>
        <div className="kpis">
          <div className="kpi"><div className="v num">{money(s.equity)}</div><div className="k">Paper equity</div></div>
          <div className="kpi"><div className={`v num ${cls(s.totalPnl)}`}>{money(s.totalPnl)}</div><div className="k">Total profit/loss ({fmtPct(s.totalReturnPct)})</div></div>
          <div className="kpi">
            <div className={`v num ${cls(s.totalReturnPct - (s.spyReturnPct ?? 0))}`}>{s.spyReturnPct === undefined ? "—" : fmtPct(s.totalReturnPct - s.spyReturnPct)}</div>
            <div className="k">vs just holding SPY ({s.spyReturnPct === undefined ? "—" : fmtPct(s.spyReturnPct)})</div>
          </div>
          <div className="kpi"><div className="v num">{s.trades ? `${Math.round(s.winRate * 100)}%` : "—"}</div><div className="k">Win rate ({s.trades} trades)</div></div>
          <div className="kpi"><div className="v num">{s.trades ? `${money(s.avgWin)} / ${money(s.avgLoss)}` : "—"}</div><div className="k">Avg win / avg loss</div></div>
          <div className="kpi"><div className="v num">{s.trades ? (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞") : "—"}</div><div className="k">Profit factor <Tip text="Total won ÷ total lost. Above 1.0 means the strategy makes money overall; 1.5+ is solid." /></div></div>
          <div className="kpi"><div className="v num">{fmtPct(-s.maxDrawdownPct, 1)}</div><div className="k">Worst drawdown</div></div>
          <div className="kpi"><div className="v num">{money(d.cash)}</div><div className="k">Cash</div></div>
        </div>
        {d.paused && <div className="small status-warn" style={{ marginTop: 8 }}>Paused: {d.paused}</div>}
        {d.canManage && (
          <div className="row wrap" style={{ marginTop: 10 }}>
            {d.paused ? (
              <button className="btn primary sm" onClick={() => act("resume", undefined, "Team resumed")}>Resume trading</button>
            ) : (
              <button className="btn sm" onClick={() => act("pause", undefined, "Team paused")}>Pause new trades</button>
            )}
          </div>
        )}
      </div>

      <div className="card span-12">
        <h2>Profit over time <span className="sub">since {new Date(d.startedAt).toLocaleDateString()}</span></h2>
        {curve.length > 1 ? <EquityChart data={curve} /> : <div className="empty">The chart fills in as the team trades (one point every 5 minutes).</div>}
      </div>

      <div className="card span-12">
        <h2>The team</h2>
        <div className="desk-grid">
          {AGENTS.map((a) => (
            <div key={a.key} className="desk">
              <div className="row">
                <span style={{ fontSize: 22 }}>{a.icon}</span>
                <div>
                  <b>{a.name}</b>
                  <div className="tiny muted">{a.role}</div>
                </div>
              </div>
              <div className="small ink2" style={{ marginTop: 6 }}>{d.agents[a.key].msg}</div>
              <div className="tiny muted" style={{ marginTop: 2 }}>{ago(d.agents[a.key].at)} ago</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-6">
        <h2>Open positions <span className="sub">{d.positions.length}</span></h2>
        {!d.positions.length && <div className="empty">No open trades. The Scout only buys when a setup passes every rule.</div>}
        {d.positions.map((p) => (
          <div key={p.id} className="list-item" onClick={() => openTicker(p.symbol)}>
            <div>
              <div className="sym">{p.symbol}</div>
              <div className="name">{qty(p.qty)} @ {fmtPrice(p.entry)} · {ago(p.openedAt)} ago{p.live ? "" : " · simulated price"}</div>
              <div className="tiny muted">stop {fmtPrice(p.stop)} · target {fmtPrice(p.target)}</div>
            </div>
            <div className="right">
              <div className="num">{fmtPrice(p.price)}</div>
              <div className={`small num ${cls(p.pnl)}`}>{money(p.pnl)} ({fmtPct(p.pnlPct, 1)})</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card span-6">
        <h2>
          Decisions <Tip text="Every idea the Scout raised and what the Risk Manager decided, with the reason. Rejections are the rules doing their job." />
        </h2>
        {!d.proposals.length && <div className="empty">No proposals yet.</div>}
        <div style={{ maxHeight: 380, overflowY: "auto" }}>
          {d.proposals.map((p) => (
            <div key={p.id} className="feed-item small">
              <div className="row">
                <span className={`badge ${p.status === "approved" ? "buy" : ""}`}>{p.status === "approved" ? "✓ Approved" : "✕ Rejected"}</span>
                <b>{p.symbol}</b>
                <span className="muted">{p.setup}</span>
                <span className="spacer" />
                <span className="tiny muted">{ago(p.t)} ago</span>
              </div>
              <div className="ink2">{p.note}</div>
              <div className="tiny muted num">fcst {fmtPct(p.exp, 1)} · conf {p.conf} · {p.rr.toFixed(1)}:1</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card span-12">
        <h2>Closed trades <span className="sub">avg hold {s.avgHoldDays.toFixed(1)} days · fees {money(s.fees)}</span></h2>
        {!d.closed.length ? (
          <div className="empty">No closed trades yet.</div>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Stock</th><th>Qty</th><th>Bought</th><th>Sold</th><th>P&L</th><th>Days</th><th>Why it closed</th></tr></thead>
              <tbody>
                {d.closed.map((c) => (
                  <tr key={c.id} className="click" onClick={() => openTicker(c.symbol)}>
                    <td><b>{c.symbol}</b></td><td>{qty(c.qty)}</td><td>{fmtPrice(c.entry)}</td><td>{fmtPrice(c.exit)}</td>
                    <td className={cls(c.pnl)}>{money(c.pnl)} ({fmtPct(c.pnlPct, 1)})</td><td>{c.daysHeld}</td><td className="muted">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d.canManage && edit && (
        <div className="card span-12">
          <h2>Team rules <span className="sub">owner only</span></h2>
          <div className="form-grid">
            {RULES.map(([k, l, tip]) => (
              <div key={k}>
                <label className="lbl">{l} {tip && <Tip text={tip} />}</label>
                <input className="field" inputMode="decimal" value={String(edit[k] ?? "")} onChange={(e) => setEdit({ ...edit, [k]: e.target.value as unknown as number })} />
              </div>
            ))}
          </div>
          <label className="switch">Only trade during market hours (9:30–4:00 ET)<input type="checkbox" checked={!!edit.marketHoursOnly} onChange={(e) => setEdit({ ...edit, marketHoursOnly: e.target.checked })} /></label>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => act("settings", Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, typeof v === "boolean" ? v : Number(v)])), "Rules saved")}>Save rules</button>
            <button
              className="btn ghost"
              onClick={() => {
                const cash = prompt("Start over with how much paper money? This clears all trades and history.", String(d.settings.startingCash));
                if (cash) act("reset", { startingCash: Number(cash) }, "Paper account reset");
              }}
            >
              Start over…
            </button>
          </div>
        </div>
      )}
      <p className="disclaimer span-12">Practice account with pretend money. Past paper results don't guarantee real results: real fills, gaps and emotions are harder.</p>
    </div>
  );
}
