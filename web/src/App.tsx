import { useCallback, useEffect, useState } from "react";
import type { FeedItem } from "../../server/types";
import { Ctx, api, useSocket, type Boot } from "./api";
import { Icon, Sheet } from "./components/ui";
import { Dashboard } from "./pages/Dashboard";
import { Ticker } from "./pages/Ticker";
import { Watchlists } from "./pages/Watchlists";
import { StrategyLab } from "./pages/StrategyLab";
import { Risk } from "./pages/Risk";
import { Crypto, type CryptoMsg } from "./pages/Crypto";
import { Profile } from "./pages/Profile";

const TABS = [
  { id: "home", label: "Home", icon: Icon.home, title: "Today" },
  { id: "watch", label: "Watchlists", icon: Icon.list, title: "Watchlists" },
  { id: "lab", label: "Lab", icon: Icon.lab, title: "Strategy Lab" },
  { id: "risk", label: "Risk", icon: Icon.shield, title: "Risk" },
  { id: "btc", label: "BTC", icon: Icon.btc, title: "BTC Engine" },
  { id: "me", label: "Me", icon: Icon.user, title: "Profile" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const readHash = () => {
  const [tab, sym] = location.hash.replace(/^#\/?/, "").split("/");
  return { tab: (TABS.some((t) => t.id === tab) ? tab : "home") as Tab, sym: sym?.toUpperCase() };
};

export function App() {
  const [boot, setBootState] = useState<Boot>();
  const [route, setRoute] = useState(readHash);
  const [tick, setTick] = useState(0);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [toastMsg, setToast] = useState<string>();
  const [crypto, setCrypto] = useState<CryptoMsg>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    const load = () => api<Boot>("/bootstrap").then(setBootState).catch((e) => (setErr(e.message), setTimeout(load, 3000)));
    load();
    const h = () => setRoute(readHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  const toast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(undefined), 2600);
  }, []);

  const connected = useSocket({
    cycle: () => setTick((t) => t + 1),
    feed: (f: FeedItem) => setFeed((xs) => [f, ...xs].slice(0, 50)),
    alert: (a: { title: string; body: string }) => {
      if (boot?.profile.notifications.inApp !== false) toast(`🔔 ${a.body}`);
    },
    crypto: (c: CryptoMsg) => setCrypto(c),
    // Cross-device sync: another device changed preferences.
    sync: ({ key, value }: { key: keyof Boot; value: never }) => setBootState((b) => (b ? { ...b, [key]: value } : b)),
  });

  // Theme + accent from the profile.
  useEffect(() => {
    if (!boot) return;
    const root = document.documentElement;
    if (boot.profile.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", boot.profile.theme);
    root.style.setProperty("--accent", boot.profile.accent);
  }, [boot?.profile.theme, boot?.profile.accent]);

  if (!boot)
    return (
      <div className="empty" style={{ paddingTop: 120 }}>
        {err ? `Waiting for the Stockens server… (${err})` : "Loading Stockens…"}
      </div>
    );

  const go = (tab: Tab, sym?: string) => {
    location.hash = sym ? `/${tab}/${sym}` : `/${tab}`;
  };
  const openTicker = (s: string) => go(route.tab, s);
  const setBoot = (fn: (b: Boot) => Boot) => setBootState((b) => (b ? fn(b) : b));
  const title = TABS.find((t) => t.id === route.tab)!.title;

  return (
    <Ctx.Provider value={{ boot, setBoot, openTicker, toast, tick, feed, connected }}>
      <div className="app">
        <header className="topbar">
          <h1>{title}</h1>
          <span className="live">
            <span className={`dot ${connected ? "" : "off"}`} />
            {connected ? "Live" : "Reconnecting"}
          </span>
          <button className="btn sm ghost" aria-label="Profile" onClick={() => go("me")} style={{ fontSize: 20 }}>
            {boot.profile.avatar}
          </button>
        </header>
        <main>
          {route.tab === "home" && <Dashboard />}
          {route.tab === "watch" && <Watchlists />}
          {route.tab === "lab" && <StrategyLab />}
          {route.tab === "risk" && <Risk />}
          {route.tab === "btc" && <Crypto live={crypto} />}
          {route.tab === "me" && <Profile />}
        </main>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={route.tab === t.id ? "on" : ""} onClick={() => go(t.id)} aria-label={t.label}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        {route.sym && (
          <Sheet onClose={() => go(route.tab)}>
            <Ticker symbol={route.sym} />
          </Sheet>
        )}
        {toastMsg && <div className="toast">{toastMsg}</div>}
      </div>
    </Ctx.Provider>
  );
}
