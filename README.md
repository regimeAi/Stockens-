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

The **background agent** (`server/agent/agent.ts`) has no UI of its own. It rotates through
the tracked sites within their rate limits, retrains every 6 hours, refreshes forecasts every
`AGENT_INTERVAL_MS`, emits feed events (upgrades, downgrades, signals, regime shifts,
sentiment flips), fires alerts (in-app over WebSocket, plus Web Push), keeps a signal ledger,
and writes the end-of-day review.

**Syncing across devices:** the local server is the single source of truth. When the profile,
watchlists, alerts, positions, strategies, ideas or playbooks change on one device, the change
is broadcast to every other open device.

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
