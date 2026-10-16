import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no dependency). Values already in process.env win.
const envPath = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const env = (k: string, d = "") => process.env[k] ?? d;
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const bool = (k: string, d: boolean) => (process.env[k] ? process.env[k] === "true" || process.env[k] === "1" : d);

export const config = {
  port: num("PORT", 8787),
  dataDir: env("DATA_DIR", path.resolve(process.cwd(), ".data")),
  // When false the agent never touches the network and runs fully on the simulator.
  liveData: bool("LIVE_DATA", true),
  agentIntervalMs: num("AGENT_INTERVAL_MS", 15_000),
  anomaly: {
    sampleMs: num("ANOMALY_SAMPLE_MS", 60_000), // one baseline point per symbol per minute
    minHistory: num("ANOMALY_MIN_HISTORY", 20), // ~20 minutes of history before most checks fire
  },

  finviz: {
    // Finviz Elite export token. Without it the adapter reads the public quote page,
    // politely rate-limited and cached. Check Finviz's terms before enabling scraping.
    authToken: env("FINVIZ_AUTH"),
    scrape: bool("FINVIZ_SCRAPE", false),
    minIntervalMs: num("FINVIZ_MIN_INTERVAL_MS", 4000),
  },
  // Mesarri (Blockworth) and InvoApp do not publish an API we could verify, so these
  // are generic JSON adapters: point the URL template at whatever endpoint your account
  // exposes ({symbol} is substituted) and map fields with KEY=json.path pairs.
  mesarri: {
    url: env("MESARRI_URL"),
    apiKey: env("MESARRI_API_KEY"),
    map: env("MESARRI_MAP", "sentiment=sentiment,score=score,headline=headline"),
  },
  invo: {
    url: env("INVO_URL"),
    apiKey: env("INVO_API_KEY"),
    map: env("INVO_MAP", "sentiment=sentiment,score=score,headline=headline"),
  },
  // Free daily history for backtests (unofficial endpoint; falls back to the simulator).
  yahooHistory: bool("YAHOO_HISTORY", true),
  // Licensed market data (recommended for a paid app): one key for prices, history and news.
  polygon: { apiKey: env("POLYGON_API_KEY"), base: env("POLYGON_BASE", "https://api.polygon.io") },
  // SEC EDGAR asks every client to identify itself with a contact email.
  secUserAgent: env("SEC_USER_AGENT", `Stockens research ${env("ADMIN_EMAILS").split(",")[0] || "contact@example.com"}`),
  // Market-wide news feeds (RSS/Atom) read by the macro desk. Comma-separated.
  macroFeeds: env(
    "MACRO_FEEDS",
    "https://www.federalreserve.gov/feeds/press_all.xml,https://feeds.content.dowjones.io/public/rss/mw_topstories,https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114,https://www.sec.gov/news/pressreleases.rss",
  ).split(",").map((s) => s.trim()).filter(Boolean),

  crypto: {
    binanceWs: env("BINANCE_WS", "wss://stream.binance.com:9443/stream"),
    binanceRest: env("BINANCE_REST", "https://api.binance.com"),
    polymarketClob: env("POLYMARKET_CLOB", "https://clob.polymarket.com"),
    polymarketGamma: env("POLYMARKET_GAMMA", "https://gamma-api.polymarket.com"),
    // Token ids for the current "BTC Up or Down – 5 min" market. If empty the engine
    // tries to discover them via the Gamma API, else it simulates the order book.
    upTokenId: env("POLY_UP_TOKEN"),
    downTokenId: env("POLY_DOWN_TOKEN"),
    marketSlugPrefix: env("POLY_SLUG_PREFIX", "btc-updown-5m"),
    cryptoQuantKey: env("CRYPTOQUANT_API_KEY"),
    tradingViewSecret: env("TRADINGVIEW_WEBHOOK_SECRET", "change-me"),
  },
  bot: {
    bankroll: num("BOT_BANKROLL", 1000),
    perTradeRiskPct: num("BOT_PER_TRADE_RISK_PCT", 0.5),
    dailyLossCapPct: num("BOT_DAILY_CAP_PCT", 2),
    hardStopPct: num("BOT_HARD_STOP_PCT", 0.4),
    lagTriggerPct: num("BOT_LAG_TRIGGER_PCT", 0.3),
    takeProfitMinPct: num("BOT_TP_MIN_PCT", 0.3),
    takeProfitMaxPct: num("BOT_TP_MAX_PCT", 0.8),
    minEdge: num("BOT_MIN_EDGE", 0.02), // probability points after fees
    feeRate: num("BOT_FEE_RATE", 0.01),
    minDepthUsd: num("BOT_MIN_DEPTH_USD", 200),
    maxOrdersPerSec: num("BOT_MAX_ORDERS_PER_SEC", 5),
    evalHz: num("BOT_EVAL_HZ", 20),
  },
  // Postgres connection string. Required on hosts without a persistent disk (e.g. Render's
  // free plan), otherwise accounts and purchases are lost when the server restarts.
  databaseUrl: env("DATABASE_URL").trim().replace(/^["']|["']$/g, ""),
  auth: {
    sessionSecret: env("SESSION_SECRET"),
    // Comma-separated emails that get full access without paying (you, the owner).
    adminEmails: env("ADMIN_EMAILS").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  },
  // Public address of the app, used in emailed links. Render sets RENDER_EXTERNAL_URL itself.
  publicUrl: env("PUBLIC_URL", env("RENDER_EXTERNAL_URL")).replace(/\/$/, ""),
  // Password-reset emails (see server/mailer.ts).
  mail: {
    brevoKey: env("BREVO_API_KEY"),
    resendKey: env("RESEND_API_KEY"),
    from: env("EMAIL_FROM"),
    fromName: env("EMAIL_FROM_NAME", "Stockens"),
    brevoBase: env("BREVO_API_BASE", "https://api.brevo.com"), // override only for tests
  },
  // One-time purchase through Stripe Checkout. Without STRIPE_SECRET_KEY nobody can buy,
  // and (unless ADMIN_EMAILS is set) the app runs in open single-user mode for local use.
  stripe: {
    secretKey: env("STRIPE_SECRET_KEY"),
    webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
    priceCents: num("PRICE_CENTS", 199),
    currency: env("PRICE_CURRENCY", "usd"),
    productName: env("PRODUCT_NAME", "Stockens lifetime access"),
    apiBase: env("STRIPE_API_BASE", "https://api.stripe.com"), // override only for tests
  },
  push: {
    subject: env("VAPID_SUBJECT", "mailto:you@example.com"),
    publicKey: env("VAPID_PUBLIC_KEY"),
    privateKey: env("VAPID_PRIVATE_KEY"),
  },
};
