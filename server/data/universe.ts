import type { Instrument } from "../types.ts";
import sp500 from "./sp500.json" with { type: "json" };

// Coverage universe: every S&P 500 constituent (official GICS sector + sub-industry, from
// sp500.json, refreshed from https://github.com/datasets/s-and-p-500-companies), plus
// ETFs/macro gauges and BTC + large memecoins. Hand-curated entries below add AI-economy
// themes and betas on top; every other name gets themes from its sub-industry.
//
// Default (UNIVERSE=popular): ~100 popular names + recent tech IPOs. UNIVERSE=sp500 covers
// the whole index; UNIVERSE=focus the original curated list.

const eq = (symbol: string, name: string, sector: string, themes: string[], beta = 1, dividendYield = 0): Instrument => ({
  symbol, name, assetClass: "equity", sector, themes, beta, dividendYield,
});
const etf = (symbol: string, name: string, sector: string, themes: string[], beta = 1, dividendYield = 0): Instrument => ({
  symbol, name, assetClass: "etf", sector, themes, beta, dividendYield,
});
const cx = (symbol: string, name: string, themes: string[], beta = 2): Instrument => ({
  symbol, name, assetClass: "crypto", sector: "Crypto", themes, beta,
});
const CURATED: Instrument[] = [
  // Compute backbone
  eq("NVDA", "NVIDIA", "Information Technology", ["AI", "semis", "compute"], 1.8),
  eq("AMD", "Advanced Micro Devices", "Information Technology", ["AI", "semis", "compute"], 1.7),
  eq("AVGO", "Broadcom", "Information Technology", ["AI", "semis", "networking"], 1.3, 1.3),
  eq("TSM", "Taiwan Semiconductor", "Information Technology", ["semis", "compute"], 1.2, 1.4),
  eq("ANET", "Arista Networks", "Information Technology", ["AI", "networking"], 1.4),
  eq("COHR", "Coherent", "Information Technology", ["AI", "optical"], 1.6),
  eq("EQIX", "Equinix", "Real Estate", ["AI", "data-center-reit"], 0.8, 2.1),
  eq("DLR", "Digital Realty", "Real Estate", ["AI", "data-center-reit"], 0.9, 3.0),
  // Cloud & platforms
  eq("MSFT", "Microsoft", "Information Technology", ["AI", "cloud"], 1.0, 0.7),
  eq("AMZN", "Amazon", "Consumer Discretionary", ["cloud", "e-com"], 1.2),
  eq("GOOGL", "Alphabet", "Communication Services", ["AI", "cloud"], 1.1, 0.5),
  eq("SNOW", "Snowflake", "Information Technology", ["cloud", "data"], 1.6),
  eq("ORCL", "Oracle", "Information Technology", ["cloud", "AI"], 1.0, 1.2),
  // Applications
  eq("CRWD", "CrowdStrike", "Information Technology", ["cyber", "SaaS"], 1.4),
  eq("PANW", "Palo Alto Networks", "Information Technology", ["cyber"], 1.2),
  eq("ZS", "Zscaler", "Information Technology", ["cyber", "cloud"], 1.4),
  eq("ADBE", "Adobe", "Information Technology", ["design", "AI"], 1.1),
  eq("NOW", "ServiceNow", "Information Technology", ["SaaS", "AI"], 1.1),
  // Communication / media
  eq("META", "Meta Platforms", "Communication Services", ["AI", "media"], 1.3, 0.4),
  eq("NFLX", "Netflix", "Communication Services", ["media"], 1.2),
  // Healthcare & bio
  eq("LLY", "Eli Lilly", "Health Care", ["bio", "pharma"], 0.5, 0.7),
  eq("VRTX", "Vertex Pharmaceuticals", "Health Care", ["bio"], 0.6),
  eq("ISRG", "Intuitive Surgical", "Health Care", ["robotics", "medtech"], 1.0),
  eq("MRNA", "Moderna", "Health Care", ["bio"], 1.5),
  // Industrials / automation
  eq("ROK", "Rockwell Automation", "Industrials", ["automation", "robotics"], 1.2, 1.9),
  eq("ETN", "Eaton", "Industrials", ["grid", "electrification"], 1.1, 1.2),
  eq("CAT", "Caterpillar", "Industrials", ["cyclical"], 1.0, 1.6),
  // Energy incl. grid storage
  eq("XOM", "Exxon Mobil", "Energy", ["oil", "dividends"], 0.8, 3.4),
  eq("FSLR", "First Solar", "Energy", ["solar", "grid"], 1.5),
  eq("FLNC", "Fluence Energy", "Energy", ["grid-storage"], 2.0),
  eq("VST", "Vistra", "Utilities", ["power", "AI"], 1.3, 0.7),
  // Financials / fintech & brokers
  eq("JPM", "JPMorgan Chase", "Financials", ["banks", "dividends"], 1.1, 2.2),
  eq("HOOD", "Robinhood", "Financials", ["fintech", "brokers"], 2.0),
  eq("SCHW", "Charles Schwab", "Financials", ["brokers"], 1.0, 1.4),
  eq("PYPL", "PayPal", "Financials", ["fintech"], 1.3),
  eq("COIN", "Coinbase", "Financials", ["fintech", "crypto"], 2.5),
  // Consumer
  eq("SHOP", "Shopify", "Consumer Discretionary", ["e-com", "SaaS"], 1.9),
  eq("TSLA", "Tesla", "Consumer Discretionary", ["EV", "robotics", "AI"], 2.0),
  eq("COST", "Costco", "Consumer Staples", ["staples", "dividends"], 0.8, 0.6),
  eq("AAPL", "Apple", "Information Technology", ["hardware", "AI"], 1.1, 0.5),
  // ETFs
  etf("SPY", "SPDR S&P 500", "Index", ["broad"], 1.0, 1.3),
  etf("QQQ", "Invesco QQQ", "Index", ["broad", "tech"], 1.15, 0.6),
  etf("SMH", "VanEck Semiconductor", "Information Technology", ["semis", "AI"], 1.5, 0.4),
  etf("IGV", "iShares Software", "Information Technology", ["SaaS", "cloud"], 1.2),
  etf("CIBR", "First Trust Cybersecurity", "Information Technology", ["cyber"], 1.1),
  etf("XBI", "SPDR Biotech", "Health Care", ["bio"], 1.3),
  etf("TLT", "iShares 20+ Year Treasury", "Rates", ["macro", "rates"], -0.2, 4.0),
  etf("UUP", "Invesco US Dollar", "FX", ["macro", "dollar"], -0.1),
  etf("GLD", "SPDR Gold", "Commodities", ["macro", "commodities"], 0.1),
  etf("USO", "US Oil Fund", "Commodities", ["macro", "commodities"], 0.9),
  // Crypto
  cx("BTC", "Bitcoin", ["crypto", "btc"], 1.8),
  cx("ETH", "Ethereum", ["crypto"], 2.0),
  cx("SOL", "Solana", ["crypto"], 2.5),
  cx("DOGE", "Dogecoin", ["crypto", "memecoin"], 3.0),
  cx("PEPE", "Pepe", ["crypto", "memecoin"], 3.5),
];


// Sub-industry → theme tags, so screeners and alerts work across the whole index.
const THEME_RULES: [RegExp, string[]][] = [
  [/Semiconductor/i, ["semis", "AI"]],
  [/Application Software|Systems Software/i, ["SaaS", "cloud"]],
  [/Internet Services|Interactive Media/i, ["cloud", "media"]],
  [/Data Center|Specialized REITs/i, ["data-center-reit"]],
  [/Communications Equipment|Electronic Components|Technology Hardware/i, ["hardware", "networking"]],
  [/Biotechnology|Life Sciences/i, ["bio"]],
  [/Pharmaceuticals/i, ["pharma"]],
  [/Health Care Equipment|Health Care Supplies/i, ["medtech"]],
  [/Electric Utilities|Multi-Utilities|Independent Power|Renewable/i, ["power"]],
  [/Electrical Components|Heavy Electrical/i, ["electrification", "grid"]],
  [/Oil|Gas|Coal/i, ["oil"]],
  [/Banks/i, ["banks"]],
  [/Capital Markets|Investment Banking|Asset Management|Exchanges/i, ["brokers"]],
  [/Transaction|Payment|Consumer Finance/i, ["fintech"]],
  [/Insurance/i, ["insurance"]],
  [/Aerospace|Defense/i, ["defense"]],
  [/Industrial Machinery|Construction Machinery/i, ["automation"]],
  [/Automobile|Auto Parts/i, ["EV"]],
  [/Broadline Retail|Internet & Direct Marketing/i, ["e-com"]],
  [/Restaurants|Hotels|Casinos|Leisure/i, ["consumer"]],
  [/Food|Beverage|Household Products|Personal Care|Tobacco|Staples/i, ["staples"]],
  [/REIT/i, ["reit"]],
];

interface Sp500Row {
  s: string;
  n: string;
  sec: string;
  ind: string;
  cik: number | null;
}

const curatedBySymbol = new Map(CURATED.map((i) => [i.symbol, i]));
const SP500: (Instrument & { subIndustry: string; cik?: number })[] = (sp500.constituents as Sp500Row[]).map((r) => {
  const c = curatedBySymbol.get(r.s);
  const themes = Array.from(new Set([...(c?.themes ?? []), ...THEME_RULES.filter(([re]) => re.test(r.ind)).flatMap(([, t]) => t), "sp500"]));
  return {
    symbol: r.s,
    name: r.n,
    assetClass: "equity",
    sector: r.sec,
    themes,
    beta: c?.beta ?? 1,
    dividendYield: c?.dividendYield ?? 0,
    subIndustry: r.ind,
    cik: r.cik ?? undefined,
  };
});
const inSp = new Set(SP500.map((i) => i.symbol));

export const SP500_META = { source: sp500.source, fetched: sp500.fetched, count: SP500.length };
export const SP500_LIST: Instrument[] = SP500;

// The default coverage: popular, liquid names people actually trade, recent tech IPOs (the
// closest thing to buying startups), plus a few ETFs/macro gauges the models need and crypto.
// Ordered roughly by theme. Names outside the S&P 500 carry their own sector/themes here.
const POPULAR: (string | [symbol: string, name: string, sector: string, themes: string[], beta?: number])[] = [
  // Mega-cap & AI leaders
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "ORCL", "AMD", "NFLX", "ADBE", "CRM",
  "INTC", "QCOM", "MU", "DELL", "SMCI", "ANET", "VRT", "CEG", "VST",
  ["TSM", "Taiwan Semiconductor", "Information Technology", ["semis", "AI", "compute"], 1.2],
  ["ASML", "ASML Holding", "Information Technology", ["semis", "AI"], 1.2],
  ["ARM", "Arm Holdings", "Information Technology", ["semis", "AI", "ipo"], 1.8],
  // Cloud, data & cyber
  "PANW", "CRWD", "DDOG", "PLTR", "APP",
  ["ZS", "Zscaler", "Information Technology", ["cyber", "cloud"], 1.4],
  ["NET", "Cloudflare", "Information Technology", ["cloud", "cyber"], 1.6],
  ["SNOW", "Snowflake", "Information Technology", ["cloud", "data", "AI"], 1.6],
  ["MDB", "MongoDB", "Information Technology", ["cloud", "data"], 1.6],
  ["TTD", "The Trade Desk", "Communication Services", ["adtech"], 1.6],
  // Recent IPOs / startup-stage public companies
  ["RDDT", "Reddit", "Communication Services", ["ipo", "media", "AI"], 2.0],
  ["CRWV", "CoreWeave", "Information Technology", ["ipo", "AI", "compute"], 2.5],
  ["CRCL", "Circle Internet", "Financials", ["ipo", "fintech", "crypto"], 2.5],
  ["FIG", "Figma", "Information Technology", ["ipo", "SaaS", "design"], 2.0],
  ["ALAB", "Astera Labs", "Information Technology", ["ipo", "semis", "AI"], 2.2],
  ["RBRK", "Rubrik", "Information Technology", ["ipo", "cyber", "cloud"], 1.8],
  ["KVYO", "Klaviyo", "Information Technology", ["ipo", "SaaS"], 1.7],
  ["CART", "Instacart (Maplebear)", "Consumer Staples", ["ipo", "e-com"], 1.3],
  ["CAVA", "Cava Group", "Consumer Discretionary", ["ipo", "consumer"], 1.6],
  ["DUOL", "Duolingo", "Consumer Discretionary", ["AI", "edtech"], 1.5],
  ["TOST", "Toast", "Financials", ["fintech", "SaaS"], 1.6],
  ["RKLB", "Rocket Lab", "Industrials", ["space"], 2.2],
  ["IONQ", "IonQ", "Information Technology", ["quantum"], 2.6],
  ["OKLO", "Oklo", "Utilities", ["nuclear", "AI", "power"], 2.6],
  ["SOUN", "SoundHound AI", "Information Technology", ["AI"], 2.6],
  // Consumer internet & fintech
  "UBER", "ABNB", "DASH", "COIN", "HOOD", "PYPL", "XYZ",
  ["SHOP", "Shopify", "Information Technology", ["e-com", "SaaS"], 1.8],
  ["SPOT", "Spotify", "Communication Services", ["media"], 1.4],
  ["RBLX", "Roblox", "Communication Services", ["gaming", "media"], 1.7],
  ["PINS", "Pinterest", "Communication Services", ["media", "adtech"], 1.3],
  ["SNAP", "Snap", "Communication Services", ["media"], 1.8],
  ["SOFI", "SoFi Technologies", "Financials", ["fintech"], 1.9],
  ["AFRM", "Affirm", "Financials", ["fintech"], 2.4],
  ["NU", "Nu Holdings", "Financials", ["fintech"], 1.5],
  ["MSTR", "Strategy (MicroStrategy)", "Information Technology", ["crypto", "btc"], 3.0],
  // EV & autos
  "F", "GM", ["RIVN", "Rivian", "Consumer Discretionary", ["EV"], 2.2],
  // Blue chips people know
  "JPM", "BAC", "GS", "V", "MA", "BRK.B", "WMT", "COST", "HD", "MCD", "SBUX", "NKE", "KO", "PEP", "DIS",
  "LLY", "UNH", "JNJ", "PFE", "MRNA", "XOM", "CVX", "BA", "CAT", "GE", "T", "VZ",
  ["NVO", "Novo Nordisk", "Health Care", ["pharma", "GLP-1"], 0.7],
];
// ETFs and macro gauges the models use for context, plus crypto.
const SUPPORT = ["SPY", "QQQ", "SMH", "IGV", "XBI", "TLT", "UUP", "GLD", "USO", "BTC", "ETH", "SOL", "DOGE"];

const spBySymbol = new Map(SP500.map((i) => [i.symbol, i]));
const popular: Instrument[] = POPULAR.map((p) => {
  if (typeof p === "string") {
    const sp = spBySymbol.get(p);
    if (!sp) throw new Error(`POPULAR: ${p} isn't in the S&P list; give it a name/sector`);
    const { subIndustry: _s, cik: _c, ...inst } = sp;
    return { ...inst, themes: inst.themes.filter((t) => t !== "sp500").concat("popular") };
  }
  const [symbol, name, sector, themes, beta = 1.5] = p;
  return { symbol, name, assetClass: "equity", sector, themes: [...themes, "popular"], beta, dividendYield: 0 };
});

const mode = (process.env.UNIVERSE ?? "popular").toLowerCase();
export const UNIVERSE: Instrument[] =
  mode === "sp500"
    ? [...SP500, ...CURATED.filter((i) => !inSp.has(i.symbol))]
    : mode === "focus"
      ? CURATED
      : [...popular, ...CURATED.filter((i) => SUPPORT.includes(i.symbol))];

export const CIK = new Map<string, number>(SP500.filter((i) => i.cik).map((i) => [i.symbol, i.cik!]));
export const SUB_INDUSTRY = new Map<string, string>(SP500.map((i) => [i.symbol, i.subIndustry]));

export const MACRO_PROXIES = ["TLT", "UUP", "GLD", "USO", "SPY"];

export const THEMES = Array.from(new Set(UNIVERSE.flatMap((i) => i.themes))).sort();
export const SECTORS = Array.from(new Set(UNIVERSE.map((i) => i.sector))).sort();

export function instrument(symbol: string): Instrument | undefined {
  return UNIVERSE.find((i) => i.symbol === symbol.toUpperCase());
}
