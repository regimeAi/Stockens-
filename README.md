# Stockens

Explainable stock and crypto AI that runs on your own machine. A background agent tracks
**Finviz**, **Mesarri (Blockworth)** and **InvoApp**, and builds a live feed of the best
buy/sell leans over a 5-day horizon. The app around it is an iOS-friendly PWA with
interactive dashboards, confidence ratings, a Strategy Lab, risk tools, push alerts and a
customizable profile. It also includes a BTC 5-minute latency engine for the Polymarket
UP/DOWN market, which runs in paper-trading mode.

> Analytics and education only. This is not financial advice. You approve every trade.

## Quick start

```bash
npm install
cp .env.example .env        # optional: add Finviz / Mesarri / InvoApp / CryptoQuant keys
npm start                   # builds the PWA and serves everything on http://localhost:8787
```

- **Development:** `npm run dev` runs the API on :8787 and Vite with hot reload on :5173.
- **iPhone:** open `http://<your-computer's-LAN-IP>:8787` in Safari, then **Share → Add to Home
  Screen**. Push notifications need iOS 16.4+, the app opened from the Home Screen, and HTTPS
  when you're not on localhost (for example via Tailscale or a reverse proxy).
- **Offline demo:** `LIVE_DATA=false npm start` runs entirely on the built-in market simulator.
- **Terminal BTC bot:** `npm run bot` runs locally with no cloud and no GPU.
- **Checks:** `npm test` (engine unit tests) and `npm run typecheck`.

## Selling it for $1.99 (online, with accounts)

When it's hosted, each buyer creates their own account (email + password), pays **$1.99 once**
through **Stripe Checkout** (cards and Apple Pay) and gets lifetime access. Each account has
its own profile, watchlists, alerts, positions and push notifications. Emails listed in
`ADMIN_EMAILS` (you) get full access without paying and are the only accounts that can change
the shared BTC paper bot's limits.

| Mode | When | Behavior |
|---|---|---|
| Paid | `STRIPE_SECRET_KEY` set | Anyone can sign up; the app unlocks after the $1.99 purchase. |
| Owner only | only `ADMIN_EMAILS` set | Only admin emails can use it. |
| Open | neither set | No login, single local user. For your own computer only. |

### Step by step

1. **Database (free, about 3 minutes).** Create a free Postgres database at [neon.tech](https://neon.tech)
   and copy its connection string (`postgresql://…`). Render's free plan has no disk, so without a
   database every account and purchase disappears whenever the app restarts.
2. **Stripe.** Create an account at [stripe.com](https://stripe.com) and finish activating it, so it
   can accept real payments and pay you out. In **Developers → API keys**, copy the **Secret key**
   (`sk_live_…`; use `sk_test_…` first if you want to test with Stripe's test card 4242 4242 4242 4242).
3. **Render.** Go to [render.com](https://render.com), choose **New → Blueprint**, pick this repo, and fill
   in:
   - `DATABASE_URL`: the Neon string from step 1
   - `ADMIN_EMAILS`: your email
   - `STRIPE_SECRET_KEY`: the key from step 2
   - `STRIPE_WEBHOOK_SECRET`: leave it blank for now

   Deploy, and note your app link (`https://stockens-….onrender.com`).
4. **Stripe webhook** (makes sure purchases unlock even if the buyer closes the tab early). In
   Stripe, open **Developers → Webhooks → Add endpoint**:
   - URL: `https://<your-app>.onrender.com/api/stripe/webhook`
   - Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`
   - Copy the **Signing secret** (`whsec_…`) into Render's `STRIPE_WEBHOOK_SECRET`.
5. Open your link in Safari, **create an account with your admin email** (it unlocks without
   paying), then tap **Share → Add to Home Screen**. Share the link with buyers.

### Password-reset emails

With email set up, the login screen shows **Forgot password?** People enter their email, get
a link that works once and expires after 1 hour, and choose a new password. That logs out
their other devices.

1. Sign up at [brevo.com](https://www.brevo.com) (free, 300 emails a day).
2. Go to **Senders, Domains & Dedicated IPs → Senders → Add a sender**, enter the address
   emails should come from (your Gmail is fine), and click the verification link Brevo emails you.
3. Go to **SMTP & API → API keys → Generate a new API key** and copy it.
4. In Render, open **stockens → Environment** and set `BREVO_API_KEY` to the key and
   `EMAIL_FROM` to that sender address, then save.

Without a custom domain, some reset emails may land in spam, so the app tells people to check
there. Resend (`RESEND_API_KEY`) also works if you own a domain. Without either one, the
"Forgot password?" link stays hidden.

### Good to know

- **Stripe fees:** about 2.9% + 30¢ per payment, so a $1.99 sale nets roughly $1.63 (US cards).
- **Free plan sleep:** the app sleeps after about 15 minutes idle (the first visit then takes up to a
  minute), and the background agent only runs while it's awake. A paid Render plan keeps it awake.
- **App Store:** selling through Stripe is fine for a website or Home-Screen web app. If you later
  wrap it as a native App Store app, Apple requires its own in-app purchase system instead.
- **Your obligations:** you're selling a market-analytics product, so publish terms, a refund policy
  and the "not financial advice" disclaimer. Check the rules where you live.

Every data source fails soft. Anything you haven't connected is replaced by the simulator,
and the app labels it **simulated** under **Me → Data & agent** and in each forecast's
integrity checks, so you always know what is real.

## The example workflow

1. **Scan.** **Home** shows the best 5-day buys and sells, top forecast upgrades, a news
   heatmap (sentiment, momentum of news, or price change), the market regime, and a fear/greed
   reading.
2. **Validate.** Tap any ticker to see the 5-day projected path with its 80% confidence band,
   forecasts for every horizon (intraday, 1–5 day, 1–4 week, multi-quarter), feature
   attributions, model votes, integrity checks, catalysts and news.
3. **Decide.** The **Signal Card** gives entry, stop, target, expected move, holding window and
   reward:risk. A sizing calculator lets you enter your account size. A "poker read" compares
   your win probability (equity) with the break-even win rate implied by the payoff (pot
   odds), and suggests a ¼-Kelly size.
4. **Automate.** Add the ticker to a watchlist, set alerts for an exact price level, a % move,
   earnings, a sentiment flip, a new signal, or approaching a stop or target.
5. **Review.** **Me → Daily review** is written by the agent after 4:05pm local time. It covers
   what worked, what didn't (by rule), and regime notes.

## How the engine works (`server/engine`)

| Piece | File | What it does |
|---|---|---|
| Feature engineering | `features.ts` | Covers trend and momentum, breadth, RSI/z-score stretch, ATR, volatility expansion, gaps, volume and close location (a microstructure proxy), EPS revisions and surprise, analyst dispersion, value/size/momentum factors, rates/dollar/commodities proxies, and news sentiment and its momentum. Computed with no look-ahead. |
| Gradient-boosted trees | `gbt.ts` | Written from scratch, CPU only. Trained on volatility-normalized forward returns pooled across the universe. Per-feature attributions use the path method. |
| Sequence model | `sequence.ts` | Single-head scaled dot-product attention over the symbol's own history. Past price/volume windows act as keys and what happened next acts as values. The result is shrunk when only a few analogs dominate. |
| Regime classifier | `regime.ts` | Labels risk-on/off, high/low vol, earnings season, holiday liquidity and thin liquidity, then re-weights the ensemble for each regime. |
| Ensemble | `ensemble.ts` | Blends the trees, the attention model, a trend expert and a mean-reversion expert, then adds news and tracked-site tilts. Produces confidence bands, P(up), a confidence score, a rationale and integrity checks. Models are scored out-of-sample on a purged time split. |
| Signal translation | `signals.ts` | Turns a forecast into an entry, ATR stop, target, time stop and size. Thresholds are stricter in novice mode. |
| Backtester | `backtest.ts` | Trend, breakout, mean-reversion, post-earnings drift and volatility-compression templates, with ATR stops and targets, trailing stops, time exits and a drawdown brake. Uses walk-forward folds with in-fold parameter choice, caps tunable parameters at 4, applies cost haircuts, tests cost sensitivity, and reports per-regime metrics (hit rate, payoff, Sharpe, Sortino, MAR, exposure-adjusted return, turnover). |
| Risk | `risk.ts` | Position sizing, stop variants, portfolio beta, sector limits, correlation creep, drawdown line, and scenario and historical-analog stress tests. |
| Psychology | `psychology.ts` | Fear/greed composite, crowd-behavior notes, and the poker read. |

### Forecast anomalies (`server/engine/anomaly.ts`)

The agent keeps a rolling history of every symbol's forecast and flags anything unusual. It
compares each reading with the symbol's own recent range using robust median/MAD statistics,
with its peers, and, five days later, with what actually happened:

| Anomaly | Fires when |
|---|---|
| Forecast jump | The 5-day forecast is ≥3× outside its normal variation (and moved ≥0.5 points) |
| Confidence shift | Confidence moves ≥20 points within about an hour |
| Direction flip | The call flips up↔down with confidence ≥40 |
| Uncertainty spike | The 80% band is ≥1.5× its usual width |
| Models disagree | The spread between model votes is ≥4× normal |
| Price vs forecast | Price moves ≥1 ATR against the call made about an hour earlier |
| Peer outlier | The forecast is ≥3.5× further from the stocks/ETFs/crypto median than usual |
| Forecast miss | The real 5-day move landed outside the 80% band; this also drives the calibration stat on Home |

Each anomaly gets a severity (Notable / Significant / Extreme), with a 3-hour cooldown per symbol
and type. Anomalies appear on Home and on each ticker. Users choose under **Me → Profile →
Anomaly alerts** whether to be alerted, for which names (their watchlists and positions, or
everything) and at what minimum severity. Alerts arrive in-app and by push, at most 6 per hour.

The **background agent** (`server/agent/agent.ts`) has no UI of its own. It rotates through
the tracked sites within their rate limits, retrains every 6 hours, refreshes forecasts every
`AGENT_INTERVAL_MS`, emits feed events (upgrades, downgrades, signals, regime shifts,
sentiment flips), fires alerts (in-app over WebSocket, plus Web Push), keeps a signal ledger,
and writes the end-of-day review.

**Syncing across devices:** the local server is the single source of truth. When the profile,
watchlists, alerts, positions, strategies, ideas or playbooks change on one device, the change
is broadcast to every other open device.

## Market coverage and real data

**Universe.** By default the app follows about **100 popular, liquid stocks**:
- mega-cap and AI leaders, cloud and cyber names, consumer internet and fintech, and household blue chips;
- **recent tech IPOs** (Reddit, Arm, CoreWeave, Circle, Figma, Astera Labs, Rubrik…), the closest
  public equivalent to buying startups;
- plus the ETFs and macro gauges the models need, and BTC/ETH/SOL/DOGE.

Other settings:
- `UNIVERSE=sp500` covers all 503 S&P 500 companies. Official GICS sectors and SEC CIKs are bundled in
  `server/data/sp500.json`, from
  [datasets/s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies).
- `UNIVERSE=focus` switches to the original curated list.

Companies outside the S&P list get their SEC ID from SEC's official ticker directory.

**Sources, all failing soft to the simulator:**

| What | Free default | Licensed upgrade |
|---|---|---|
| Prices & daily history | Yahoo chart/spark (unofficial; personal use) | `POLYGON_API_KEY`: one full-market snapshot per cycle plus 2 years of history |
| Company news | Yahoo Finance headline RSS per ticker | Polygon news with per-ticker sentiment |
| Filings | **SEC EDGAR** (official, public domain): 8-K items decoded (earnings, executive changes, impairments, bankruptcy…), 10-Q/10-K, Form 4, 13D | same |
| Market-wide news | Federal Reserve, MarketWatch, CNBC and SEC press feeds, with company names routed to tickers | |

**FinancialData.net** (`FINANCIALDATA_API_KEY`, `server/data/financialdata.ts`) is used first
whenever it's set, for whatever your plan includes. The app works out the plan by itself: an
endpoint that answers "not on your plan" is skipped from then on, and the Yahoo/Polygon path covers
that piece. *Me → Data & agent* shows which parts are in use.

| Plan | What Stockens takes from it |
|---|---|
| Free | 2 years of daily stock history |
| Standard | ETF and crypto history, P/E and forward P/E, dividend yield, last earnings surprise |
| Premium | live quotes for every covered name in one call per asset class, analyst targets (a site score), market news routed to tickers every 5 minutes, and a 14-day earnings calendar that feeds the team's earnings rule |

Nobody can legally pull a raw feed straight from the NYSE or Nasdaq without an exchange data
licence. Licensed vendors such as Polygon resell that consolidated feed. **If you sell the app,
use a provider whose plan allows displaying data to your users.**

**Sector desks.** `server/agent/desks.ts` runs one background agent per GICS sector, plus
Funds & macro and Crypto. Each desk combs two of its companies every ~6 seconds (headlines plus
SEC filings every 6 hours), so a full pass over the index takes roughly 15–20 minutes. A shared
per-host rate limiter keeps everything polite, including SEC's 10 requests/second limit. Each desk
publishes a brief: lean, average 5-day forecast, breadth, leaders and laggards, catalysts and
anomaly count. A macro desk reads the market-wide feeds every 10 minutes.

**Performance.** With 523 symbols, a cycle takes about 0.7–2 seconds on a laptop: the pattern
model's windows are cached, cycles never overlap, and the loop yields to keep the API
responsive. Memory stays around 355 MB with `NODE_OPTIONS=--max-old-space-size=256`. On Render's
free 0.1-CPU instance, expect cycles of 10–20 seconds; the $7 Starter plan (0.5 CPU) is
recommended.

## Paper trading team (`server/team/team.ts`)

Four background agents run a **built-in practice account** with pretend money. When live data
is connected, they use real prices. Style: **buy dips in strong stocks and sell quickly** (swing
trades of 1–5 trading days, long only).

| Agent | Job |
|---|---|
| **Scout** | Scans every stock each minute for a dip (or a volume breakout) in a stock that's in an uptrend and whose 5-day forecast is ≥ +0.4% with enough confidence. It proposes the top 3. |
| **Risk Manager** | Rejects ideas that break the rules: team paused, position limit reached, reward:risk below the minimum, **earnings inside the holding window**, a recent serious anomaly, sector over its limit, or no live price. Otherwise it sizes the trade so a stop-out costs `riskPerTradePct` of equity, capped per stock and by cash (fractional shares above $20). |
| **Trader** | Fills at the price plus slippage and fees. On every cycle it moves the stop to breakeven at +1R, trails one ATR below the high from +1.5R, and sells on stop, target, **time exit** (default 5 days) or a forecast that turns negative. |
| **Portfolio Manager** | Marks to market, records the equity curve against SPY, and tracks win rate, average win/loss, profit factor, drawdown and fees. It writes a daily report after the close, **pauses for the day** after a 2% daily loss and **pauses until you resume** after an 8% drawdown. |

Trading happens only during New York market hours (9:30–4:00 ET; exchange holidays aren't
modelled) unless the rule is switched off, which is the default in offline simulation mode. The
**Team** tab shows everything: the scoreboard against SPY, what each agent is doing, open
positions, every proposal with its approve/reject reason, and closed trades. The owner
(`ADMIN_EMAILS`) can pause, resume, edit the rules or start over. **No real money moves**; the
point is to measure whether the strategy is profitable before risking any.

## First-run tutorial

New users get a 16-step walkthrough (`web/src/components/Tour.tsx`). It:
1. confirms the "analytics and education, not financial advice" acknowledgement (stored with a timestamp);
2. personalizes experience level and account size;
3. spotlights each real feature in turn: market mood, best ideas, anomalies, sector desks, the
   news heatmap, a stock's forecast cone, its Signal Card and reasons, then Watchlists, Lab,
   Risk, BTC and Me;
4. finishes with a setup checklist.

Users can skip it after the first step and replay it from **Me**.

## About the three websites

- **Finviz:** set `FINVIZ_AUTH` to use the Elite export, which is recommended. Alternatively,
  set `FINVIZ_SCRAPE=true` to read the public quote page. The scraper is rate-limited and
  caches results, but check Finviz's terms before enabling it.
- **Mesarri (Blockworth)** and **InvoApp:** I couldn't find or verify a public API for either.
  Each has a generic JSON adapter. Point `MESARRI_URL` / `INVO_URL` at whatever endpoint your
  account exposes (`{symbol}` is substituted) and map fields with `*_MAP`. Their scores feed
  the "Tracked sites consensus" attribution.

## BTC 5-minute latency engine (`server/crypto`)

- **Binance:** WebSocket trades, 5m klines and top of book, plus REST kline history.
- **TradingView:** has no public API, so it connects through alert **webhooks**. Point an alert
  at `POST /api/crypto/tradingview` (or `http://127.0.0.1:8788` when using `npm run bot`) with
  `{"secret","symbol","signal":"buy|sell|strong_buy…","timeframe":"5"}`.
- **CryptoQuant:** exchange netflow and whale ratio. Requires `CRYPTOQUANT_API_KEY`.
- **Polymarket:** reads the public CLOB order book for the current "BTC Up or Down – 5 min"
  market, discovered through the Gamma API, or from token IDs you pin.
- **Signal swarm:** a MiroFish-style force graph of exactly **100 signal nodes** and the
  **180** strongest co-movement edges. Label propagation splits them into **BULL / BEAR**
  clusters, and convergence is the share of signal mass that agrees.
- **Fair value:** the UP contract's fair price is `Φ(ln(S/S_open) / (σ√τ))`.
- **Entry conditions:** the engine enters only when **all** of the following hold:
  - spot has moved more than **0.3%** since the CLOB last repriced;
  - fair value beats the ask by at least `BOT_MIN_EDGE` after fees;
  - the swarm agrees on direction;
  - ask depth is at least `BOT_MIN_DEPTH_USD`;
  - the daily cap hasn't been hit;
  - the order-rate limit allows it;
  - more than 15 seconds remain in the window.
- **Skip reporting:** when it skips, it counts the reason (`no-edge`, `thin-liquidity`,
  `signal-conflict`, `daily-cap`, …).
- **Risk controls (in % of bankroll):**
  - 0.5% stake per trade;
  - take profit at 0.3–0.8%, scaled by edge;
  - hard stop at −0.4%;
  - trading halts for the day at −2%;
  - otherwise the position is held to settlement.

**Please read before relying on the bot:**
- **It is paper trading only.** `LiveExecutor` deliberately throws. Connecting real order
  routing means writing that class against Polymarket's official client with your own keys.
  Only do that after confirming prediction-market trading is legal where you live
  (Polymarket restricts some jurisdictions).
- **"1000+ orders per second" isn't realistic** against Polymarket's API rate limits, and it
  isn't needed. The engine evaluates `BOT_EVAL_HZ` times per second (20 by default; adjustable)
  and caps orders with `BOT_MAX_ORDERS_PER_SEC`.
- **The claimed 0.3–0.8% per trade** is a target, not something the code can promise. Spread,
  fees and other bots competing for the same lag usually eat most of it. Run it on paper long
  enough to see real fill and skip statistics first.

## Layout

```
server/            Node + TypeScript API, background agent and engines (run with tsx)
  agent/           the hidden background agent
  engine/          features, GBT, attention model, regimes, ensemble, signals, backtests, risk
  data/            universe, simulator, Finviz / Mesarri / InvoApp / history adapters
  crypto/          Binance, Polymarket, TradingView/CryptoQuant, convergence graph, latency engine, CLI
web/               React PWA (Vite): Home, Watchlists/Screener/Ideas, Lab, Risk, BTC, Me
tests/             vitest engine tests
```
