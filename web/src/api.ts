import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { AlertRule, FeedItem, Instrument, Position, Profile, StrategyConfig, Watchlist } from "../../server/types";

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export interface Idea { id: string; symbol: string; tags: string[]; note: string; author: string; createdAt: number }
export interface Playbook { id: string; name: string; regime: string; steps: string[]; shared: boolean }

export interface Boot {
  profile: Profile;
  watchlists: Watchlist[];
  alerts: AlertRule[];
  positions: Position[];
  strategies: StrategyConfig[];
  ideas: Idea[];
  playbooks: Playbook[];
  universe: Instrument[];
  themes: string[];
  sectors: string[];
  templates: Record<string, { label: string; params: Record<string, number>; describe: string }>;
  maxParams: number;
  scenarios: { id: string; name: string }[];
  vapidPublicKey: string;
  agentStatus: string;
}

export interface AppCtx {
  boot: Boot;
  setBoot: (fn: (b: Boot) => Boot) => void;
  openTicker: (s: string) => void;
  toast: (msg: string) => void;
  tick: number; // increments on each agent cycle
  feed: FeedItem[];
  connected: boolean;
}

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

// Single websocket for live feed, agent cycles, crypto state and cross-device sync.
export function useSocket(handlers: Record<string, (data: any) => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | undefined;
    let stop = false;
    let retry = 0;
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
      };
      ws.onmessage = (e) => {
        const { type, data } = JSON.parse(e.data);
        ref.current[type]?.(data);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stop) setTimeout(open, Math.min(15000, 500 * 2 ** retry++));
      };
    };
    open();
    // iOS suspends sockets in the background; reconnect when the app comes back.
    const vis = () => document.visibilityState === "visible" && ws?.readyState !== 1 && open();
    document.addEventListener("visibilitychange", vis);
    return () => {
      stop = true;
      ws?.close();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  return connected;
}

export function usePoll<T>(path: string | null, deps: unknown[] = []): [T | undefined, () => void, string | undefined] {
  const [data, setData] = useState<T>();
  const [err, setErr] = useState<string>();
  const load = () => {
    if (!path) return;
    api<T>(path)
      .then((d) => {
        setData(d);
        setErr(undefined);
      })
      .catch((e) => setErr(String(e.message)));
  };
  useEffect(load, [path, ...deps]);
  return [data, load, err];
}

export const fmtPrice = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "—" : x >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 0 }) : x >= 1 ? x.toFixed(2) : x.toPrecision(3));
export const fmtPct = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}%`);
export const cls = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "");
export const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
