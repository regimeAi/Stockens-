import { useEffect, useRef, useState } from "react";
import type { ConvergenceSnapshot } from "../../../server/types";
import { fmtPct, useApp } from "../api";

type HeatItem = { symbol: string; changePct: number; sentiment: number; newsMomentum: number; newsCount: number };

// Diverging scale (blue ↔ red with a neutral gray midpoint).
function diverging(v: number) {
  const a = Math.min(1, Math.abs(v));
  const pole = v >= 0 ? "var(--div-pos)" : "var(--div-neg)";
  return `color-mix(in srgb, ${pole} ${Math.round(a * 85)}%, var(--div-mid))`;
}

export function NewsHeatmap({ sectors }: { sectors: { sector: string; items: HeatItem[] }[] }) {
  const { openTicker } = useApp();
  const [metric, setMetric] = useState<"sentiment" | "newsMomentum" | "changePct">("sentiment");
  const val = (i: HeatItem) => (metric === "changePct" ? i.changePct / 4 : i[metric]);
  return (
    <div>
      <div className="chips" style={{ marginBottom: 8 }}>
        {(
          [
            ["sentiment", "News sentiment"],
            ["newsMomentum", "Momentum of news"],
            ["changePct", "Price change"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={`chip ${metric === k ? "on" : ""}`} onClick={() => setMetric(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="stack">
        {sectors
          .sort((a, b) => b.items.length - a.items.length)
          .map((s) => (
            <div key={s.sector}>
              <div className="tiny muted" style={{ marginBottom: 3 }}>{s.sector}</div>
              <div className="heat">
                {s.items.map((i) => {
                  const v = val(i);
                  return (
                    <button
                      key={i.symbol}
                      className="heat-cell"
                      style={{ background: diverging(v), color: Math.abs(v) > 0.55 ? "#fff" : "var(--ink)", border: 0 }}
                      title={`${i.symbol}: sentiment ${i.sentiment.toFixed(2)}, news momentum ${i.newsMomentum.toFixed(2)}, ${fmtPct(i.changePct)}`}
                      onClick={() => openTicker(i.symbol)}
                    >
                      <b>{i.symbol}</b>
                      <span className="num">{metric === "changePct" ? fmtPct(i.changePct, 1) : (metric === "sentiment" ? i.sentiment : i.newsMomentum).toFixed(2)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span><i style={{ background: "var(--div-neg)" }} />Negative</span>
        <span><i style={{ background: "var(--div-mid)" }} />Neutral</span>
        <span><i style={{ background: "var(--div-pos)" }} />Positive</span>
      </div>
    </div>
  );
}

// Force-directed signal graph (100 nodes / 180 edges). Layout runs client-side on canvas.
export function ForceGraph({ snap }: { snap: ConvergenceSnapshot | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pos = useRef(new Map<string, { x: number; y: number; vx: number; vy: number }>());
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const [hover, setHover] = useState<string>();

  useEffect(() => {
    let raf = 0;
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    const css = getComputedStyle(document.documentElement);
    const step = () => {
      const s = snapRef.current;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth;
      const H = c.clientHeight;
      if (c.width !== W * dpr) {
        c.width = W * dpr;
        c.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (s && W > 50 && H > 50) {
        const P = pos.current;
        for (const n of s.nodes) if (!P.has(n.id)) P.set(n.id, { x: W / 2 + (Math.random() - 0.5) * W * 0.6, y: H / 2 + (Math.random() - 0.5) * H * 0.6, vx: 0, vy: 0 });
        // forces: repulsion, edge springs (positive corr pulls, negative pushes), cluster gravity
        const arr = s.nodes.map((n) => [n, P.get(n.id)!] as const);
        for (let i = 0; i < arr.length; i++)
          for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i][1];
            const b = arr[j][1];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const d2 = dx * dx + dy * dy + 0.01;
            if (d2 > 6400) continue; // short-range repulsion only
            const f = Math.min(0.5, 6 / d2);
            a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
          }
        for (const e of s.edges) {
          const a = P.get(e.source);
          const b = P.get(e.target);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const target = e.w > 0 ? 40 : 160;
          const f = ((d - target) / d) * 0.02 * Math.abs(e.w);
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
        for (const [n, p] of arr) {
          const gx = n.cluster === "BULL" ? W * 0.72 : n.cluster === "BEAR" ? W * 0.28 : W / 2;
          p.vx += (gx - p.x) * 0.01;
          p.vy += (H / 2 - p.y) * 0.01;
          p.vx *= 0.82; p.vy *= 0.82;
          const sp = Math.hypot(p.vx, p.vy);
          if (sp > 6) { p.vx *= 6 / sp; p.vy *= 6 / sp; }
          p.x = Math.max(12, Math.min(W - 12, p.x + p.vx));
          p.y = Math.max(28, Math.min(H - 12, p.y + p.vy));
        }
        ctx.lineWidth = 1;
        for (const e of s.edges) {
          const a = P.get(e.source);
          const b = P.get(e.target);
          if (!a || !b) continue;
          ctx.strokeStyle = e.w > 0 ? css.getPropertyValue("--axis") : "rgba(227,73,72,0.35)";
          ctx.globalAlpha = 0.3 + Math.abs(e.w) * 0.5;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const bull = css.getPropertyValue("--div-pos").trim();
        const bear = css.getPropertyValue("--div-neg").trim();
        const neu = css.getPropertyValue("--muted").trim();
        const ring = css.getPropertyValue("--surface").trim();
        for (const [n, p] of arr) {
          const r = 3 + Math.abs(n.bias) * 6 + Math.min(4, n.weight - 1);
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = n.cluster === "BULL" ? bull : n.cluster === "BEAR" ? bear : neu;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = n.id === hover ? css.getPropertyValue("--ink") : ring;
          ctx.stroke();
        }
        ctx.fillStyle = css.getPropertyValue("--ink-2");
        ctx.font = "600 12px system-ui";
        ctx.fillText("BEAR cluster", 10, 18);
        const t = "BULL cluster";
        ctx.fillText(t, W - ctx.measureText(t).width - 10, 18);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hover]);

  const pick = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: string | undefined;
    let bd = 400;
    for (const [id, p] of pos.current) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    setHover(best);
  };
  const hn = snap?.nodes.find((n) => n.id === hover);
  return (
    <div>
      <canvas ref={ref} className="graph" onPointerMove={pick} onPointerDown={pick} aria-label="Signal convergence force graph" />
      <div className="row small wrap" style={{ minHeight: 22 }}>
        <div className="legend">
          <span><i style={{ background: "var(--div-pos)" }} />BULL</span>
          <span><i style={{ background: "var(--div-neg)" }} />BEAR</span>
          <span><i style={{ background: "var(--muted)" }} />Neutral</span>
        </div>
        <span className="spacer" />
        {hn ? (
          <span className="ink2 num">
            {hn.id} · {hn.group} · bias {hn.bias.toFixed(2)} · {hn.cluster}
          </span>
        ) : (
          <span className="muted">Tap a node to inspect</span>
        )}
      </div>
    </div>
  );
}
