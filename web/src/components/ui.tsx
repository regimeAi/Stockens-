import { type ReactNode, useEffect, useRef, useState } from "react";
import { useApp } from "../api";

// Education tooltip: tap on iOS, hover on desktop. Hidden when the profile turns tips off.
export function Tip({ text }: { text: string }) {
  const { boot } = useApp();
  const [pos, setPos] = useState<{ x: number; y: number }>();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(undefined);
    window.addEventListener("scroll", close, true);
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("pointerdown", close);
    };
  }, [pos]);
  if (!boot.profile.showTooltips || !text) return null;
  const show = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.min(Math.max(16, r.left - 140), window.innerWidth - 336), y: r.bottom + 8 > window.innerHeight - 140 ? r.top - 8 : r.bottom + 8 });
  };
  return (
    <>
      <span ref={ref} className="tip" role="button" aria-label="Explain" tabIndex={0} onPointerDown={(e) => (e.stopPropagation(), pos ? setPos(undefined) : show(e))} onMouseEnter={show} onMouseLeave={() => setPos(undefined)}>
        ?
      </span>
      {pos && (
        <span className="tip-pop" style={{ left: Math.max(16, pos.x), top: pos.y, transform: pos.y < (ref.current?.getBoundingClientRect().top ?? 0) ? "translateY(-100%)" : undefined }}>
          {text}
        </span>
      )}
    </>
  );
}

export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="grabber" onClick={onClose} />
        {children}
      </div>
    </>
  );
}

export function SideBadge({ side, actionable = true }: { side: "buy" | "sell" | "hold"; actionable?: boolean }) {
  if (side === "hold" || !actionable) return <span className="badge">{side === "hold" ? "HOLD" : "WATCH"}</span>;
  return <span className={`badge ${side}`}>{side === "buy" ? "▲ BUY" : "▼ SELL"}</span>;
}

// Confidence as a meter: single value → bar, not a chart. Colour = status, with text label.
export function ConfidenceMeter({ value, label = "Confidence" }: { value: number; label?: string }) {
  const status = value >= 65 ? "good" : value >= 45 ? "warn" : "crit";
  const word = value >= 65 ? "High" : value >= 45 ? "Medium" : "Low";
  return (
    <div>
      <div className="row small">
        <span className="ink2">{label}</span>
        <span className="spacer" />
        <span className={`status-${status} num`}>
          {word} · {value}
        </span>
      </div>
      <div className="bar-track" style={{ marginTop: 4 }}>
        <div className="bar-fill" style={{ width: `${value}%`, background: `var(--${status})` }} />
      </div>
    </div>
  );
}

export const Icon = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" /></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  lab: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3" /><path d="M7 15h10" /></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>,
  btc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M9.5 7.5v9M9.5 8h4a2 2 0 0 1 0 4h-4m0 0h4.5a2 2 0 0 1 0 4H9.5M11 6v2m0 8v2" /></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>,
};
