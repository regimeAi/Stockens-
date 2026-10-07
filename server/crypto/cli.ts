import http from "node:http";
import { LatencyEngine } from "./latencyArb.ts";

// Terminal runner for the BTC latency engine. Local only, no cloud, no GPU.
//   npm run bot
// Optional TradingView webhook listener on BOT_WEBHOOK_PORT (default 8788).

const engine = new LatencyEngine();
const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m", b: "\x1b[1m" };

engine.on("trade", (t) => {
  const col = t.status === "open" ? C.y : (t.pnl ?? 0) >= 0 ? C.g : C.r;
  console.log(`\n${col}${t.status === "open" ? "▶ ENTER" : "■ EXIT "} ${t.side} entry ${(t.entry * 100).toFixed(1)}¢ ${t.pnl !== undefined ? `pnl ${t.pnl.toFixed(2)}` : `stake $${t.stake.toFixed(2)}`} ${C.d}${t.reason} (${t.latencyMs}ms)${C.x}`);
});

engine.on("state", () => {
  const s = engine.publicState();
  const g = engine.graph.snapshot;
  const left = Math.max(0, Math.round((s.windowEndsAt - Date.now()) / 1000));
  const vcol = g.verdict === "BULL" ? C.g : g.verdict === "BEAR" ? C.r : C.y;
  process.stdout.write(
    `\r${C.b}BTC${C.x} ${s.spot.toFixed(2)}  open ${s.windowOpen.toFixed(2)}  ${left}s  ` +
      `fair ${(s.fairProb * 100).toFixed(1)}¢ clob ${(s.clobMid * 100).toFixed(1)}¢  lag ${s.lagPct.toFixed(3)}%  edge ${(s.edge * 100).toFixed(2)}pp  ` +
      `swarm ${vcol}${g.verdict} ${(g.convergence * 100).toFixed(0)}%${C.x}  bank $${s.bankroll.toFixed(2)} day ${s.dayPnlPct.toFixed(2)}%  ` +
      `${s.evalsPerSec}/s ${s.halted ? C.r + "HALTED" + C.x : ""} ${C.d}${s.lastDecision.slice(0, 40)}${C.x}   `,
  );
});

const port = Number(process.env.BOT_WEBHOOK_PORT ?? 8788);
http
  .createServer((req, res) => {
    if (req.method !== "POST") return res.writeHead(404).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        res.writeHead(engine.tv.accept(JSON.parse(body)) ? 200 : 401).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  })
  .listen(port, "127.0.0.1");

console.log(`${C.b}Stockens BTC latency engine${C.x} — PAPER mode. TradingView webhook: http://127.0.0.1:${port}/`);
console.log(`${C.d}Risk: ${engine.cfg.perTradeRiskPct}%/trade, daily cap ${engine.cfg.dailyLossCapPct}%, hard stop ${engine.cfg.hardStopPct}%, lag trigger ${engine.cfg.lagTriggerPct}%${C.x}`);
await engine.start();
process.on("SIGINT", () => {
  engine.stop();
  const s = engine.publicState();
  const closed = s.trades.filter((t) => t.status === "closed");
  console.log(`\n\nSession: ${closed.length} trades, P&L $${s.dayPnl.toFixed(2)}, skips ${JSON.stringify(s.skips)}`);
  process.exit(0);
});
