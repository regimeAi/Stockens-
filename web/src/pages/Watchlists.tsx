import { useState } from "react";
import type { Horizon, Watchlist } from "../../../server/types";
import { api, cls, fmtPct, fmtPrice, useApp, usePoll, type Idea } from "../api";
import { SideBadge, Tip } from "../components/ui";

interface Row {
  symbol: string; name: string; sector: string; themes: string[]; price: number; changePct: number; expectedReturn: number;
  confidence: number; probUp: number; sentiment: number; signal: "buy" | "sell" | "hold"; pe?: number; dividendYield?: number;
}

export function Watchlists() {
  const { boot, setBoot, openTicker, tick, toast } = useApp();
  const [mode, setMode] = useState<"lists" | "screen" | "ideas">("lists");
  const [active, setActive] = useState<string | undefined>(boot.watchlists[0]?.id);
  const [horizon, setHorizon] = useState<Horizon>(boot.profile.defaultHorizon);
  const [rows] = usePoll<Row[]>(`/screen?horizon=${horizon}`, [tick]);
  const wl = boot.watchlists.find((w) => w.id === active);

  const save = async (id: string, patch: Partial<Watchlist>) => {
    const upd = await api<Watchlist>(`/watchlists/${id}`, { method: "PUT", body: patch });
    setBoot((b) => ({ ...b, watchlists: b.watchlists.map((w) => (w.id === id ? upd : w)) }));
  };
  const create = async () => {
    const name = prompt("Watchlist name", "New list");
    if (!name) return;
    const w = await api<Watchlist>("/watchlists", { method: "POST", body: { name, symbols: [] } });
    setBoot((b) => ({ ...b, watchlists: [...b.watchlists, w] }));
    setActive(w.id);
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this watchlist?")) return;
    await api(`/watchlists/${id}`, { method: "DELETE" });
    setBoot((b) => ({ ...b, watchlists: b.watchlists.filter((w) => w.id !== id) }));
    setActive(boot.watchlists.find((w) => w.id !== id)?.id);
  };

  return (
    <div className="stack">
      <div className="chips">
        {(["lists", "screen", "ideas"] as const).map((m) => (
          <button key={m} className={`chip ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}>
            {m === "lists" ? "Watchlists" : m === "screen" ? "Screener" : "Research ideas"}
          </button>
        ))}
        <span className="spacer" />
        <select className="chip" value={horizon} onChange={(e) => setHorizon(e.target.value as Horizon)} aria-label="Horizon">
          <option value="intraday">Intraday</option>
          <option value="5d">1–5 day</option>
          <option value="4w">1–4 week</option>
          <option value="2q">Multi-quarter</option>
        </select>
      </div>

      {mode === "lists" && (
        <>
          <div className="chips">
            {boot.watchlists.map((w) => (
              <button key={w.id} className={`chip ${w.id === active ? "on" : ""}`} onClick={() => setActive(w.id)}>
                {w.name} {w.shared ? "· shared" : ""}
              </button>
            ))}
            <button className="chip" onClick={create}>＋ New</button>
          </div>
          {wl && (
            <div className="card">
              <h2>
                {wl.name}
                <span className="sub">{wl.tags.join(" ")}</span>
              </h2>
              <AddSymbol onAdd={(s) => save(wl.id, { symbols: Array.from(new Set([...wl.symbols, s])) })} />
              <RowList rows={(rows ?? []).filter((r) => wl.symbols.includes(r.symbol))} onOpen={openTicker} onRemove={(s) => save(wl.id, { symbols: wl.symbols.filter((x) => x !== s) })} />
              <div className="row wrap" style={{ marginTop: 10 }}>
                <label className="switch small" style={{ flex: 1 }}>
                  Share with team
                  <input type="checkbox" checked={wl.shared} onChange={(e) => save(wl.id, { shared: e.target.checked })} />
                </label>
                <button className="btn sm ghost" onClick={() => remove(wl.id)}>Delete list</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "screen" && <Screener rows={rows ?? []} horizon={horizon} />}
      {mode === "ideas" && <Ideas toast={toast} />}
    </div>
  );
}

function AddSymbol({ onAdd }: { onAdd: (s: string) => void }) {
  const { boot } = useApp();
  const [q, setQ] = useState("");
  const matches = q ? boot.universe.filter((i) => i.symbol.startsWith(q.toUpperCase()) || i.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6) : [];
  return (
    <div style={{ marginBottom: 6 }}>
      <input className="field" placeholder="Add ticker (e.g. NVDA, BTC)" value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="characters" />
      {matches.length > 0 && (
        <div className="chips" style={{ marginTop: 6 }}>
          {matches.map((m) => (
            <button key={m.symbol} className="chip" onClick={() => (onAdd(m.symbol), setQ(""))}>
              + {m.symbol} <span className="muted tiny">{m.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RowList({ rows, onOpen, onRemove }: { rows: Row[]; onOpen: (s: string) => void; onRemove?: (s: string) => void }) {
  if (!rows.length) return <div className="empty">Nothing here yet.</div>;
  return (
    <div className="list">
      {rows.map((r) => (
        <div key={r.symbol} className="list-item" onClick={() => onOpen(r.symbol)}>
          <div style={{ minWidth: 0 }}>
            <div className="row">
              <span className="sym">{r.symbol}</span>
              <SideBadge side={r.signal} />
            </div>
            <div className="name">{r.name}</div>
          </div>
          <div className="right">
            <div className="num">{fmtPrice(r.price)} <span className={`small ${cls(r.changePct)}`}>{fmtPct(r.changePct, 1)}</span></div>
            <div className="tiny muted num">
              fcst <span className={cls(r.expectedReturn)}>{fmtPct(r.expectedReturn, 1)}</span> · conf {r.confidence}
            </div>
          </div>
          {onRemove && (
            <button className="btn sm ghost" aria-label={`Remove ${r.symbol}`} onClick={(e) => (e.stopPropagation(), onRemove(r.symbol))}>✕</button>
          )}
        </div>
      ))}
    </div>
  );
}

function Screener({ rows, horizon }: { rows: Row[]; horizon: Horizon }) {
  const { boot, openTicker } = useApp();
  const [theme, setTheme] = useState("");
  const [sector, setSector] = useState("");
  const [asset, setAsset] = useState("");
  const [minDiv, setMinDiv] = useState("");
  const [maxVol, setMaxVol] = useState("");
  const [minConf, setMinConf] = useState("");
  const [maxPe, setMaxPe] = useState("");
  const qs = new URLSearchParams(Object.entries({ horizon, theme, sector, asset, minDiv, maxVol, minConf, maxPe }).filter(([, v]) => v) as [string, string][]).toString();
  const [filtered] = usePoll<Row[]>(`/screen?${qs}`, [rows]);
  const list = filtered ?? rows;
  return (
    <div className="card">
      <h2>
        Screener <Tip text="Filter the whole coverage universe by theme, sector, asset class, dividends, volatility (ATR %), valuation and model confidence." />
        <span className="sub">{list.length} names</span>
      </h2>
      <div className="form-grid">
        <div><label className="lbl">Theme</label><select className="field" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="">Any</option>{boot.themes.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div><label className="lbl">Sector</label><select className="field" value={sector} onChange={(e) => setSector(e.target.value)}><option value="">Any</option>{boot.sectors.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div><label className="lbl">Asset</label><select className="field" value={asset} onChange={(e) => setAsset(e.target.value)}><option value="">Any</option><option value="equity">Stocks</option><option value="etf">ETFs</option><option value="crypto">Crypto</option></select></div>
        <div><label className="lbl">Min dividend %</label><input className="field" inputMode="decimal" value={minDiv} onChange={(e) => setMinDiv(e.target.value)} /></div>
        <div><label className="lbl">Max daily vol (ATR %)</label><input className="field" inputMode="decimal" value={maxVol} onChange={(e) => setMaxVol(e.target.value)} /></div>
        <div><label className="lbl">Max P/E</label><input className="field" inputMode="decimal" value={maxPe} onChange={(e) => setMaxPe(e.target.value)} /></div>
        <div><label className="lbl">Min confidence</label><input className="field" inputMode="numeric" value={minConf} onChange={(e) => setMinConf(e.target.value)} /></div>
      </div>
      <div className="scroll-x" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead>
            <tr><th>Symbol</th><th>Signal</th><th>Price</th><th>Fcst</th><th>Conf</th><th>P(up)</th><th>Sent.</th><th>P/E</th><th>Div %</th><th>Sector</th></tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.symbol} className="click" onClick={() => openTicker(r.symbol)}>
                <td><b>{r.symbol}</b></td>
                <td><SideBadge side={r.signal} /></td>
                <td>{fmtPrice(r.price)}</td>
                <td className={cls(r.expectedReturn)}>{fmtPct(r.expectedReturn, 1)}</td>
                <td>{r.confidence}</td>
                <td>{(r.probUp * 100).toFixed(0)}%</td>
                <td className={cls(r.sentiment)}>{r.sentiment.toFixed(2)}</td>
                <td>{r.pe ?? "—"}</td>
                <td>{r.dividendYield ? r.dividendYield.toFixed(1) : "—"}</td>
                <td className="muted">{r.sector}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Ideas({ toast }: { toast: (m: string) => void }) {
  const { boot, setBoot, openTicker } = useApp();
  const [symbol, setSymbol] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const add = async () => {
    const i = await api<Idea>("/ideas", { method: "POST", body: { symbol, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), note } });
    setBoot((b) => ({ ...b, ideas: [i, ...b.ideas] }));
    setSymbol(""); setTags(""); setNote("");
    toast("Idea tagged");
  };
  return (
    <div className="grid">
      <div className="card span-6">
        <h2>Tag an idea</h2>
        <label className="lbl">Ticker</label>
        <input className="field" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} autoCapitalize="characters" />
        <label className="lbl">Tags (comma separated)</label>
        <input className="field" value={tags} placeholder="AI, earnings, breakout" onChange={(e) => setTags(e.target.value)} />
        <label className="lbl">Thesis / note</label>
        <textarea className="field" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn primary" style={{ marginTop: 10 }} disabled={!symbol} onClick={add}>Save idea</button>
        <div className="row wrap" style={{ marginTop: 14 }}>
          <a className="btn sm" href="/api/export/signals.csv">Export signals CSV</a>
          <a className="btn sm" href="/api/export/signals.json" target="_blank">Signals JSON feed</a>
          <a className="btn sm" href="/api/export/report" target="_blank">Research report</a>
        </div>
      </div>
      <div className="card span-6">
        <h2>Team ideas <span className="sub">{boot.ideas.length}</span></h2>
        {!boot.ideas.length && <div className="empty">No ideas yet.</div>}
        {boot.ideas.map((i) => (
          <div key={i.id} className="feed-item small" onClick={() => openTicker(i.symbol)} style={{ cursor: "pointer" }}>
            <div className="row"><b>{i.symbol}</b>{i.tags.map((t) => <span key={t} className="badge">{t}</span>)}<span className="spacer" /><span className="tiny muted">{i.author}</span></div>
            <div className="ink2">{i.note}</div>
          </div>
        ))}
        <h2 style={{ marginTop: 14 }}>Standardised playbooks</h2>
        {boot.playbooks.map((p) => (
          <div key={p.id} className="feed-item small">
            <div className="row"><b>{p.name}</b><span className="badge">{p.regime}</span></div>
            <ol style={{ margin: "4px 0 0", paddingLeft: 18 }} className="ink2">{p.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
        ))}
      </div>
    </div>
  );
}
