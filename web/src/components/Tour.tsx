import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Profile } from "../../../server/types";
import { api, useApp } from "../api";

// First-run walkthrough. Steps either show a centred card or spotlight a real element
// (found by its data-tour attribute) on the page the step navigates to.

interface Step {
  route?: string; // hash route to open first, e.g. "/home" or "/home/NVDA"
  target?: string; // data-tour attribute to spotlight
  title: string;
  body: string;
  kind?: "welcome" | "personalize" | "finish";
}

const DEMO = "NVDA";

const STEPS: Step[] = [
  { kind: "welcome", title: "Welcome to Stockens", body: "" },
  { kind: "personalize", title: "Make it yours", body: "" },
  {
    route: "/home",
    target: "regime",
    title: "1 · Read the market mood",
    body: "Start here every day. The market regime says whether the market is calm or stormy, trending or choppy. Fear & greed shows whether the crowd is scared or euphoric. Extremes in either direction call for extra caution.",
  },
  {
    route: "/home",
    target: "buys",
    title: "2 · Best 5-day ideas",
    body: "The names the models expect to rise (or fall) most over the next 5 days. BUY / SELL means the idea passed your safety thresholds; WATCH means it's leaning that way but isn't strong enough yet. The bar is confidence: low, medium or high.",
  },
  {
    route: "/home",
    target: "anomalies",
    title: "3 · Anomalies",
    body: "The agent watches every forecast for anything unusual: sudden jumps, confidence collapsing, a call flipping direction, or price moving against the forecast. These are often worth a closer look before you act.",
  },
  {
    route: "/home",
    target: "desks",
    title: "4 · Sector desks",
    body: "Separate background agents each cover one sector of the S&P 500, reading headlines and official SEC filings. Each card shows whether the sector leans bullish or bearish, its strongest and weakest names, and the latest catalyst. Tap any ticker to dig in.",
  },
  {
    route: "/home",
    target: "heatmap",
    title: "5 · News heatmap",
    body: "Each tile is a stock, colored blue for positive news and red for negative. Switch to 'Momentum of news' to see where the story is changing fastest, which can be an early sign of a turn.",
  },
  {
    route: `/home/${DEMO}`,
    target: "forecast",
    title: "6 · Tap a stock: the forecast cone",
    body: "Blue is the real price. The dashed orange line is the expected path for the next 5 days, and the shaded cone is the range where the price should land about 8 times out of 10. A narrow cone means more certainty.",
  },
  {
    route: `/home/${DEMO}`,
    target: "signal",
    title: "7 · The Signal Card",
    body: "This turns the forecast into a plan: where to enter, where you're proven wrong (the stop), where to take profit (the target) and how long to hold. 'Size it' tells you how many shares keep a stop-out within your risk budget.",
  },
  {
    route: `/home/${DEMO}`,
    target: "why",
    title: "8 · Why the model thinks this",
    body: "Every forecast shows its reasons. Blue bars push the forecast up, red bars push it down. Tap any ? icon for a plain-English explanation. If the reasons don't make sense to you, don't take the trade.",
  },
  {
    route: "/team",
    target: "tab-team",
    title: "9 · Your trading team",
    body: "Four agents run a practice account with pretend money: the Scout finds dips in strong stocks, the Risk Manager approves or rejects each one and sizes it, the Trader buys and manages stops and exits, and the Portfolio Manager tracks profit against SPY and pauses everything after a bad day. Watch it here before you ever use real money.",
  },
  {
    route: "/watch",
    target: "tab-watch",
    title: "10 · Watchlists & screener",
    body: "Keep lists of stocks you care about, search all 500+ names by sector, theme, dividends or volatility, and save research ideas. Anomaly alerts follow your watchlists by default.",
  },
  {
    route: "/lab",
    target: "tab-lab",
    title: "11 · Strategy Lab",
    body: "Test a trading rule on past data before risking money. Trust the 'Out-of-sample' column, which is how the rule did on data it never saw. A warning like 'likely overfit' means don't rely on it.",
  },
  {
    route: "/risk",
    target: "tab-risk",
    title: "12 · Risk",
    body: "Enter your holdings to see how concentrated you are, how they'd fare in a crash or rate spike, and how much to buy for any trade. Stockens nudges you when one sector gets too big.",
  },
  {
    route: "/btc",
    target: "tab-btc",
    title: "13 · BTC engine (experiment)",
    body: "A paper-trading experiment that watches Bitcoin and 5-minute prediction markets. No real money moves. Treat it as something to observe, not a money-maker.",
  },
  {
    route: "/me",
    target: "tab-me",
    title: "14 · Me",
    body: "Your profile, risk settings, alerts, push notifications and the end-of-day review live here. You can replay this tutorial from here any time.",
  },
  { kind: "finish", route: "/home", title: "You're all set", body: "" },
];

export function Tour({ onClose }: { onClose: () => void }) {
  const { boot, setBoot } = useApp();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [agreed, setAgreed] = useState(!!boot.profile.disclaimerAcceptedAt);
  const [exp, setExp] = useState<Profile["experience"]>(boot.profile.experience);
  const [account, setAccount] = useState(String(boot.profile.risk.accountSize));
  const step = STEPS[i];
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardTop, setCardTop] = useState(window.innerHeight);
  const isTab = !!step.target?.startsWith("tab-");

  const save = async (patch: Record<string, unknown>) => {
    const p = await api<Profile>("/profile", { method: "PUT", body: patch });
    setBoot((b) => ({ ...b, profile: p }));
  };

  // Navigate, then find and spotlight the target (it may render a moment later).
  useEffect(() => {
    if (step.route && location.hash !== `#${step.route}`) location.hash = step.route;
    setRect(null);
    if (!step.target) return;
    let el: Element | null = null;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const measure = () => el && setRect(el.getBoundingClientRect());
    const find = () => {
      el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        // Content goes to the top of the screen (scroll-margin clears the header); the card sits below it.
        el.scrollIntoView({ block: step.target!.startsWith("tab-") ? "nearest" : "start", behavior: "smooth" });
        timer = setTimeout(measure, 450);
      } else if (tries++ < 60) timer = setTimeout(find, 100);
    };
    find();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [i]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardTop(cardRef.current.getBoundingClientRect().top);
  });

  useLayoutEffect(() => {
    document.body.classList.add("touring");
    return () => document.body.classList.remove("touring");
  }, []);

  const finish = async () => {
    await save({ onboardedAt: Date.now() });
    location.hash = "/home";
    onClose();
  };
  const next = async () => {
    if (step.kind === "welcome") await save({ disclaimerAcceptedAt: Date.now() });
    if (step.kind === "personalize") await save({ experience: exp, risk: { accountSize: Math.max(100, Number(account) || 10_000) } });
    if (i === STEPS.length - 1) return finish();
    setI(i + 1);
  };

  const pad = 6;
  // Spotlight only the visible part of the target that the card doesn't cover.
  const holeTop = rect ? Math.max(rect.top - pad, 4) : 0;
  const holeBottom = rect ? (isTab ? rect.bottom + pad : Math.min(rect.bottom + pad, cardTop - 10)) : 0;
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Stockens tutorial">
      {rect ? (
        <div
          className="tour-hole"
          style={{ left: rect.left - pad, top: holeTop, width: rect.width + pad * 2, height: Math.max(40, holeBottom - holeTop) }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div ref={cardRef} className={`tour-card ${step.target ? (isTab ? "at-top" : "at-bottom") : "centered"}`}>
        <div className="row tiny muted">
          <span>
            Step {i + 1} of {STEPS.length}
          </span>
          <span className="spacer" />
          {i > 0 && step.kind !== "finish" && (
            <button className="btn ghost sm" onClick={finish}>
              Skip tour
            </button>
          )}
        </div>
        <h2 style={{ margin: "6px 0 6px", fontSize: 19 }}>{step.title}</h2>

        {step.kind === "welcome" && (
          <>
            <p className="small ink2">
              Stockens runs AI agents in the background that read the whole S&P 500, its news and official filings. They turn all that into
              forecasts, signals and alerts. This 2-minute tour shows you where everything is.
            </p>
            <label className="row small" style={{ alignItems: "flex-start", gap: 10, background: "var(--surface-2)", padding: 10, borderRadius: 12 }}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ width: 22, height: 22, flexShrink: 0, marginTop: 2 }} />
              <span>
                I understand Stockens provides <b>analytics and education, not financial advice</b>. Forecasts can be wrong, and I can lose money. I make my own decisions.
              </span>
            </label>
          </>
        )}

        {step.kind === "personalize" && (
          <>
            <p className="small ink2">This sets how cautious the signals are and how big the suggested positions are. You can change it later in Me.</p>
            <label className="lbl">Your experience</label>
            <div className="chips">
              {(
                [
                  ["novice", "New to investing"],
                  ["intermediate", "Some experience"],
                  ["advanced", "Experienced"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`chip ${exp === k ? "on" : ""}`} onClick={() => setExp(k)}>
                  {l}
                </button>
              ))}
            </div>
            <label className="lbl">Money you'd actually trade with ($)</label>
            <input className="field" inputMode="numeric" value={account} onChange={(e) => setAccount(e.target.value.replace(/[^0-9]/g, ""))} />
            <div className="tiny muted" style={{ marginTop: 4 }}>
              Each suggested trade risks about {boot.profile.risk.riskPerTradePct}% of this{exp === "novice" ? ", halved while you're new" : ""}.
            </div>
          </>
        )}

        {step.kind === "finish" && (
          <>
            <p className="small ink2">A few things worth doing now:</p>
            <ul className="small ink2" style={{ paddingLeft: 18, lineHeight: 1.7, margin: "4px 0" }}>
              <li>
                Add Stockens to your Home Screen: Safari → <b>Share</b> → <b>Add to Home Screen</b>
              </li>
              <li>
                Turn on <b>Push notifications</b> in Me so alerts reach you when the app is closed
              </li>
              <li>Add the stocks you care about to a watchlist</li>
              <li>
                <b>Paper trade first:</b> track what you would have done for a few weeks before using real money
              </li>
            </ul>
          </>
        )}

        {!step.kind && <p className="small ink2" style={{ margin: 0 }}>{step.body}</p>}

        <div className="row" style={{ marginTop: 12 }}>
          {i > 0 && (
            <button className="btn ghost sm" onClick={() => setI(i - 1)}>
              Back
            </button>
          )}
          <span className="spacer" />
          <button className="btn primary" onClick={next} disabled={step.kind === "welcome" && !agreed}>
            {step.kind === "welcome" ? "Start the tour" : i === STEPS.length - 1 ? "Start using Stockens" : "Next"}
          </button>
        </div>
        <div className="tour-dots">
          {STEPS.map((_, k) => (
            <span key={k} className={k === i ? "on" : ""} />
          ))}
        </div>
      </div>
    </div>
  );
}
