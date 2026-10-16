import type { Anomaly } from "../../../server/types";
import { ago, useApp, usePoll } from "../api";
import { Tip } from "./ui";

export interface AnomalyReport {
  anomalies: Anomaly[];
  calibration: { checked: number; insideRate?: number };
}

const SEV = {
  1: { label: "Notable", cls: "status-info" },
  2: { label: "Significant", cls: "status-warn" },
  3: { label: "Extreme", cls: "status-crit" },
} as const;

const KIND: Record<Anomaly["kind"], string> = {
  "forecast-jump": "Forecast jump",
  "confidence-shift": "Confidence shift",
  "direction-flip": "Direction flip",
  "uncertainty-shock": "Uncertainty spike",
  "model-split": "Models disagree",
  "price-vs-forecast": "Price vs forecast",
  "peer-outlier": "Peer outlier",
  "forecast-miss": "Forecast miss",
};

export function AnomalyList({ items, onOpen, limit = 12 }: { items: Anomaly[]; onOpen?: (s: string) => void; limit?: number }) {
  if (!items.length) return <div className="empty">No anomalies right now. The agent needs about 20 minutes of history before most checks start.</div>;
  return (
    <div className="list">
      {items.slice(0, limit).map((a) => (
        <div key={a.id} className="feed-item" onClick={() => onOpen?.(a.symbol)} style={{ cursor: onOpen ? "pointer" : "default" }}>
          <div className="row small wrap">
            <span className={`${SEV[a.severity].cls} tiny`}>{SEV[a.severity].label}</span>
            <span className="badge">{KIND[a.kind]}</span>
            <span className="spacer" />
            <span className="tiny muted">{ago(a.t)} ago</span>
          </div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>{a.title}</div>
          <div className="small ink2">{a.detail}</div>
        </div>
      ))}
    </div>
  );
}

export function AnomaliesCard() {
  const { tick, openTicker } = useApp();
  const [r] = usePoll<AnomalyReport>("/anomalies", [tick]);
  const cal = r?.calibration;
  return (
    <>
      <h2>
        Forecast anomalies{" "}
        <Tip text="The agent watches every forecast for unusual behaviour: sudden jumps, confidence swings, direction flips, uncertainty spikes, models disagreeing, price moving against the call, names far from their peers, and real moves landing outside the 80% band. Set which ones ping you in Me → Profile." />
        <span className="sub">{r?.anomalies.length ?? 0}</span>
      </h2>
      {cal && cal.checked > 0 && cal.insideRate !== undefined && (
        <div className="small ink2" style={{ marginBottom: 6 }}>
          Calibration: real 5-day moves landed inside the 80% band <b>{Math.round(cal.insideRate * 100)}%</b> of the time ({cal.checked} checked). Close to 80% means the bands are honest.
        </div>
      )}
      <div style={{ maxHeight: 420, overflowY: "auto" }}>
        <AnomalyList items={r?.anomalies ?? []} onOpen={openTicker} />
      </div>
    </>
  );
}
