import type { Instrument } from "../types.ts";
import sp500 from "./sp500.json" with { type: "json" };

// Coverage universe: every S&P 500 constituent (official GICS sector + sub-industry, from
// sp500.json, refreshed from https://github.com/datasets/s-and-p-500-companies), plus
// ETFs/macro gauges and BTC + large memecoins. Hand-curated entries below add AI-economy
// themes and betas on top; every other name gets themes from its sub-industry.
//
// UNIVERSE=focus limits coverage to the curated list (lighter on small servers).

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

export const UNIVERSE: Instrument[] =
  process.env.UNIVERSE === "focus"
    ? CURATED
    : [...SP500, ...CURATED.filter((i) => !inSp.has(i.symbol))]; // non-S&P curated names (TSM, ETFs, crypto) stay

export const CIK = new Map<string, number>(SP500.filter((i) => i.cik).map((i) => [i.symbol, i.cik!]));
export const SUB_INDUSTRY = new Map<string, string>(SP500.map((i) => [i.symbol, i.subIndustry]));

export const MACRO_PROXIES = ["TLT", "UUP", "GLD", "USO", "SPY"];

export const THEMES = Array.from(new Set(UNIVERSE.flatMap((i) => i.themes))).sort();
export const SECTORS = Array.from(new Set(UNIVERSE.map((i) => i.sector))).sort();

export function instrument(symbol: string): Instrument | undefined {
  return UNIVERSE.find((i) => i.symbol === symbol.toUpperCase());
}
