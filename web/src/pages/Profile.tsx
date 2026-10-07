import { useState } from "react";
import type { AlertRule, Profile as P, SourceStatus } from "../../../server/types";
import { api, ago, fmtPct, useApp, usePoll } from "../api";
import { Tip } from "../components/ui";

interface Review {
  t: number; date: string; summary: string; worked: string[]; didnt: string[]; regimeNotes: string[];
  stats: { signals: number; closed: number; winRate: number; avgPnlPct: number };
  byRule: { rule: string; n: number; avgPnlPct: number }[];
}

const AVATARS = ["🦊", "🐂", "🐻", "🦉", "🚀", "💎", "🧠", "🐳", "🦅", "🌱"];
const ACCENTS = ["#2a78d6", "#1baf7a", "#eb6834", "#4a3aa7", "#e87ba4", "#0b0b0b"];

export function Profile() {
  const { boot, setBoot, toast } = useApp();
  const [section, setSection] = useState<"profile" | "alerts" | "review" | "sources">("profile");
  const p = boot.profile;
  const save = async (patch: Omit<Partial<P>, "risk" | "notifications"> & { risk?: Partial<P["risk"]>; notifications?: Partial<P["notifications"]> }) => {
    const upd = await api<P>("/profile", { method: "PUT", body: patch });
    setBoot((b) => ({ ...b, profile: upd }));
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="row">
          <div style={{ fontSize: 44, width: 64, height: 64, borderRadius: 20, background: "var(--surface-2)", display: "grid", placeItems: "center" }}>{p.avatar}</div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{p.displayName}</div>
            <div className="small ink2">{p.experience} · {p.favoriteThemes.join(", ")}</div>
          </div>
        </div>
      </div>
      <div className="chips">
        {(["profile", "alerts", "review", "sources"] as const).map((s) => (
          <button key={s} className={`chip ${section === s ? "on" : ""}`} onClick={() => setSection(s)}>
            {s === "profile" ? "Profile & risk" : s === "alerts" ? `Alerts (${boot.alerts.length})` : s === "review" ? "Daily review" : "Data & agent"}
          </button>
        ))}
      </div>

      {section === "profile" && (
        <div className="grid">
          <div className="card span-6">
            <h2>Customize</h2>
            <label className="lbl">Display name</label>
            <input className="field" defaultValue={p.displayName} onBlur={(e) => save({ displayName: e.target.value })} />
            <label className="lbl">Avatar</label>
            <div className="chips">{AVATARS.map((a) => <button key={a} className={`chip ${p.avatar === a ? "on" : ""}`} onClick={() => save({ avatar: a })}>{a}</button>)}</div>
            <label className="lbl">Accent colour</label>
            <div className="row">{ACCENTS.map((c) => <button key={c} aria-label={c} onClick={() => save({ accent: c })} style={{ width: 36, height: 36, borderRadius: "50%", background: c, border: p.accent === c ? "3px solid var(--ink)" : "2px solid var(--border)", cursor: "pointer" }} />)}</div>
            <label className="lbl">Appearance</label>
            <div className="chips">{(["system", "light", "dark"] as const).map((t) => <button key={t} className={`chip ${p.theme === t ? "on" : ""}`} onClick={() => save({ theme: t })}>{t}</button>)}</div>
            <label className="lbl">Experience level <Tip text="Novice mode uses stricter signal thresholds, halves position risk and shows the workflow guide. You can change it anytime." /></label>
            <div className="chips">{(["novice", "intermediate", "advanced"] as const).map((t) => <button key={t} className={`chip ${p.experience === t ? "on" : ""}`} onClick={() => save({ experience: t })}>{t}</button>)}</div>
            <label className="lbl">Favourite themes</label>
            <div className="chips" style={{ flexWrap: "wrap" }}>
              {boot.themes.map((t) => (
                <button key={t} className={`chip ${p.favoriteThemes.includes(t) ? "on" : ""}`} onClick={() => save({ favoriteThemes: p.favoriteThemes.includes(t) ? p.favoriteThemes.filter((x) => x !== t) : [...p.favoriteThemes, t] })}>{t}</button>
              ))}
            </div>
            <label className="switch">Education tooltips<input type="checkbox" checked={p.showTooltips} onChange={(e) => save({ showTooltips: e.target.checked })} /></label>
            <label className="switch">Pre/post-market alerts<input type="checkbox" checked={p.extendedHours} onChange={(e) => save({ extendedHours: e.target.checked })} /></label>
            <label className="lbl">Default forecast horizon</label>
            <select className="field" value={p.defaultHorizon} onChange={(e) => save({ defaultHorizon: e.target.value as P["defaultHorizon"] })}>
              <option value="intraday">Intraday</option><option value="5d">1–5 day</option><option value="4w">1–4 week</option><option value="2q">Multi-quarter</option>
            </select>
          </div>
          <div className="card span-6">
            <h2>Risk settings <Tip text="These travel with you to every device and drive the signal cards, sizing assistant and portfolio nudges." /></h2>
            <div className="form-grid">
              {(
                [
                  ["accountSize", "Account size $"],
                  ["riskPerTradePct", "Risk per trade %"],
                  ["maxPositionPct", "Max position %"],
                  ["maxSectorPct", "Max sector %"],
                  ["maxDrawdownPct", "Drawdown brake %"],
                  ["atrMultiple", "Stop (× ATR)"],
                  ["timeStopDays", "Time stop (days)"],
                ] as const
              ).map(([k, l]) => (
                <div key={k}>
                  <label className="lbl">{l}</label>
                  <input className="field" inputMode="decimal" defaultValue={p.risk[k]} onBlur={(e) => save({ risk: { [k]: Number(e.target.value) } })} />
                </div>
              ))}
            </div>
            <label className="lbl">Default stop type</label>
            <div className="chips">{(["atr", "static", "trailing", "time"] as const).map((t) => <button key={t} className={`chip ${p.risk.defaultStop === t ? "on" : ""}`} onClick={() => save({ risk: { defaultStop: t } })}>{t}</button>)}</div>
            <h2 style={{ marginTop: 16 }}>Notifications</h2>
            <label className="switch">In-app alerts<input type="checkbox" checked={p.notifications.inApp} onChange={(e) => save({ notifications: { inApp: e.target.checked } })} /></label>
            <PushToggle />
            <h2 style={{ marginTop: 16 }}>Broker</h2>
            <div className="small ink2">Signals export as CSV/JSON for your broker. Direct order routing is not enabled — you approve and place every trade.</div>
            <div className="row" style={{ marginTop: 8 }}>
              <a className="btn sm" href="/api/export/signals.csv">Download signals CSV</a>
            </div>
            <div className="tiny muted" style={{ marginTop: 10 }}>Synced {ago(p.updatedAt)} ago across your devices.</div>
          </div>
        </div>
      )}

      {section === "alerts" && <Alerts toast={toast} />}
      {section === "review" && <ReviewView />}
      {section === "sources" && <Sources />}
      <p className="disclaimer">Stockens provides analytics and education. It is not financial advice; you make the final decisions.</p>
    </div>
  );
}

function PushToggle() {
  const { boot, setBoot, toast } = useApp();
  const on = boot.profile.notifications.push;
  const enable = async (v: boolean) => {
    if (v) {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("On iPhone: Share → Add to Home Screen, open Stockens from there, then enable push.");
        const perm = await Notification.requestPermission();
        if (perm !== "granted") throw new Error("Notifications permission was denied.");
        const reg = await navigator.serviceWorker.ready;
        const key = Uint8Array.from(atob(boot.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(boot.vapidPublicKey.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
      } catch (e) {
        return toast((e as Error).message);
      }
    }
    const upd = await api<typeof boot.profile>("/profile", { method: "PUT", body: { notifications: { push: v } } });
    setBoot((b) => ({ ...b, profile: upd }));
    if (v) api("/push/test", { method: "POST" });
  };
  return (
    <label className="switch">
      <span>Push notifications <Tip text="Price levels, % moves, earnings, sentiment flips and exit alerts — even when the app is closed. On iPhone, add Stockens to your Home Screen first (iOS 16.4+)." /></span>
      <input type="checkbox" checked={on} onChange={(e) => enable(e.target.checked)} />
    </label>
  );
}

const KIND_LABEL: Record<AlertRule["kind"], string> = {
  "price-above": "Price above", "price-below": "Price below", "pct-move": "% move ≥", earnings: "Earnings within (days)", "sentiment-flip": "Sentiment flip", signal: "New signal", exit: "Exit (near stop/target)",
};

function Alerts({ toast }: { toast: (m: string) => void }) {
  const { boot, setBoot } = useApp();
  const [symbol, setSymbol] = useState("NVDA");
  const [kind, setKind] = useState<AlertRule["kind"]>("price-above");
  const [value, setValue] = useState("");
  const add = async () => {
    const a = await api<AlertRule>("/alerts", { method: "POST", body: { symbol, kind, value: value ? Number(value) : undefined } });
    setBoot((b) => ({ ...b, alerts: [...b.alerts, a] }));
    toast("Alert saved");
  };
  const toggle = async (a: AlertRule) => {
    const u = await api<AlertRule>(`/alerts/${a.id}`, { method: "PUT", body: { enabled: !a.enabled } });
    setBoot((b) => ({ ...b, alerts: b.alerts.map((x) => (x.id === a.id ? u : x)) }));
  };
  const del = async (a: AlertRule) => {
    await api(`/alerts/${a.id}`, { method: "DELETE" });
    setBoot((b) => ({ ...b, alerts: b.alerts.filter((x) => x.id !== a.id) }));
  };
  const needsValue = ["price-above", "price-below", "pct-move", "earnings"].includes(kind);
  return (
    <div className="grid">
      <div className="card span-6">
        <h2>New alert</h2>
        <div className="form-grid">
          <div><label className="lbl">Ticker</label><input className="field" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></div>
          <div><label className="lbl">Type</label><select className="field" value={kind} onChange={(e) => setKind(e.target.value as AlertRule["kind"])}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          {needsValue && <div><label className="lbl">Value</label><input className="field" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></div>}
        </div>
        <button className="btn primary" style={{ marginTop: 10 }} onClick={add} disabled={needsValue && !value}>Add alert</button>
      </div>
      <div className="card span-6">
        <h2>Your alerts</h2>
        {!boot.alerts.length && <div className="empty">No alerts yet. Add one here or from any ticker.</div>}
        {boot.alerts.map((a) => (
          <div key={a.id} className="list-item" style={{ cursor: "default" }}>
            <div>
              <div className="sym">{a.symbol}</div>
              <div className="name">{KIND_LABEL[a.kind]} {a.value ?? ""}{a.lastFiredAt ? ` · fired ${ago(a.lastFiredAt)} ago` : ""}</div>
            </div>
            <span className="spacer" />
            <label className="switch"><input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} aria-label="Enabled" /></label>
            <button className="btn sm ghost" onClick={() => del(a)} aria-label="Delete">✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewView() {
  const [reviews, reload] = usePoll<Review[]>("/review");
  const run = async () => {
    await api("/review/run", { method: "POST" });
    reload();
  };
  const r = reviews?.[0];
  return (
    <div className="card">
      <h2>
        End-of-day review <Tip text="Written automatically by the agent after the close: what worked, what didn't, and regime notes to refine tomorrow's plan." />
        <span className="sub"><button className="btn sm" onClick={run}>Run now</button></span>
      </h2>
      {!r ? (
        <div className="empty">No review yet — it's generated after 4:05pm, or tap Run now.</div>
      ) : (
        <div className="stack">
          <div className="small muted">{r.date}</div>
          <div>{r.summary}</div>
          <div className="kpis">
            <div className="kpi"><div className="v num">{r.stats.signals}</div><div className="k">Signals (5d)</div></div>
            <div className="kpi"><div className="v num">{r.stats.closed}</div><div className="k">Closed</div></div>
            <div className="kpi"><div className="v num">{(r.stats.winRate * 100).toFixed(0)}%</div><div className="k">Win rate</div></div>
            <div className="kpi"><div className="v num">{fmtPct(r.stats.avgPnlPct)}</div><div className="k">Avg P&L</div></div>
          </div>
          <div><b className="up">What worked</b>{r.worked.length ? r.worked.map((w) => <div key={w} className="small">• {w}</div>) : <div className="small muted">Nothing closed green yet.</div>}</div>
          <div><b className="down">What didn't</b>{r.didnt.length ? r.didnt.map((w) => <div key={w} className="small">• {w}</div>) : <div className="small muted">No losers to report.</div>}</div>
          <div><b>Regime notes</b>{r.regimeNotes.map((w) => <div key={w} className="small ink2">• {w}</div>)}</div>
        </div>
      )}
    </div>
  );
}

function Sources() {
  const { tick } = useApp();
  const [st] = usePoll<{ agent: string; lastCycle: number; cycleMs: number; sources: SourceStatus[] }>("/status", [tick]);
  const [dash] = usePoll<{ agent: { models: { horizon: string; samples: number; oosHitRate: number; oosIc: number }[] } }>("/dashboard", []);
  if (!st) return null;
  return (
    <div className="grid">
      <div className="card span-6">
        <h2>Background agent <Tip text="The agent works unseen: it pulls the tracked sites, retrains models, refreshes forecasts and fires alerts. This is the only place it shows itself." /></h2>
        <div className="small">Status: <b>{st.agent}</b> · last cycle {ago(st.lastCycle)} ago ({st.cycleMs} ms)</div>
        <table className="tbl" style={{ marginTop: 8 }}>
          <thead><tr><th>Model</th><th>Samples</th><th>OOS hit</th><th>OOS IC</th></tr></thead>
          <tbody>{dash?.agent.models.map((m) => <tr key={m.horizon}><td>{m.horizon}</td><td>{m.samples}</td><td>{(m.oosHitRate * 100).toFixed(1)}%</td><td>{m.oosIc.toFixed(3)}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="card span-6">
        <h2>Data sources</h2>
        {st.sources.map((s) => (
          <div key={s.id} className="feed-item small">
            <div className="row">
              <span className={s.status === "live" ? "status-good" : s.status === "error" ? "status-crit" : "status-warn"}>{s.status}</span>
              <b>{s.name}</b>
              <span className="spacer" />
              {s.lastOk && <span className="tiny muted">ok {ago(s.lastOk)} ago</span>}
            </div>
            <div className="tiny muted">{s.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
