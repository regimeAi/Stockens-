import type { Instrument } from "../types.ts";

// Default coverage universe: major U.S. equities + ETFs grouped by sector/theme,
// plus BTC and a few large memecoins. Extend freely; the agent scans everything here.
const eq = (symbol: string, name: string, sector: string, themes: string[], beta = 1, dividendYield = 0): Instrument => ({
  symbol, name, assetClass: "equity", sector, themes, beta, dividendYield,
});
const etf = (symbol: string, name: string, sector: string, themes: string[], beta = 1, dividendYield = 0): Instrument => ({
  symbol, name, assetClass: "etf", sector, themes, beta, dividendYield,
});
const cx = (symbol: string, name: string, themes: string[], beta = 2): Instrument => ({
  symbol, name, assetClass: "crypto", sector: "Crypto", themes, beta,
});

export const UNIVERSE: Instrument[] = [
  // Compute backbone
  eq("NVDA", "NVIDIA", "Technology", ["AI", "semis", "compute"], 1.8),
  eq("AMD", "Advanced Micro Devices", "Technology", ["AI", "semis", "compute"], 1.7),
  eq("AVGO", "Broadcom", "Technology", ["AI", "semis", "networking"], 1.3, 1.3),
  eq("TSM", "Taiwan Semiconductor", "Technology", ["semis", "compute"], 1.2, 1.4),
  eq("ANET", "Arista Networks", "Technology", ["AI", "networking"], 1.4),
  eq("COHR", "Coherent", "Technology", ["AI", "optical"], 1.6),
  eq("EQIX", "Equinix", "Real Estate", ["AI", "data-center-reit"], 0.8, 2.1),
  eq("DLR", "Digital Realty", "Real Estate", ["AI", "data-center-reit"], 0.9, 3.0),
  // Cloud & platforms
  eq("MSFT", "Microsoft", "Technology", ["AI", "cloud"], 1.0, 0.7),
  eq("AMZN", "Amazon", "Consumer", ["cloud", "e-com"], 1.2),
  eq("GOOGL", "Alphabet", "Communication", ["AI", "cloud"], 1.1, 0.5),
  eq("SNOW", "Snowflake", "Technology", ["cloud", "data"], 1.6),
  eq("ORCL", "Oracle", "Technology", ["cloud", "AI"], 1.0, 1.2),
  // Applications
  eq("CRWD", "CrowdStrike", "Technology", ["cyber", "SaaS"], 1.4),
  eq("PANW", "Palo Alto Networks", "Technology", ["cyber"], 1.2),
  eq("ZS", "Zscaler", "Technology", ["cyber", "cloud"], 1.4),
  eq("ADBE", "Adobe", "Technology", ["design", "AI"], 1.1),
  eq("NOW", "ServiceNow", "Technology", ["SaaS", "AI"], 1.1),
  // Communication / media
  eq("META", "Meta Platforms", "Communication", ["AI", "media"], 1.3, 0.4),
  eq("NFLX", "Netflix", "Communication", ["media"], 1.2),
  // Healthcare & bio
  eq("LLY", "Eli Lilly", "Healthcare", ["bio", "pharma"], 0.5, 0.7),
  eq("VRTX", "Vertex Pharmaceuticals", "Healthcare", ["bio"], 0.6),
  eq("ISRG", "Intuitive Surgical", "Healthcare", ["robotics", "medtech"], 1.0),
  eq("MRNA", "Moderna", "Healthcare", ["bio"], 1.5),
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
  eq("SHOP", "Shopify", "Consumer", ["e-com", "SaaS"], 1.9),
  eq("TSLA", "Tesla", "Consumer", ["EV", "robotics", "AI"], 2.0),
  eq("COST", "Costco", "Consumer", ["staples", "dividends"], 0.8, 0.6),
  eq("AAPL", "Apple", "Technology", ["hardware", "AI"], 1.1, 0.5),
  // ETFs
  etf("SPY", "SPDR S&P 500", "Index", ["broad"], 1.0, 1.3),
  etf("QQQ", "Invesco QQQ", "Index", ["broad", "tech"], 1.15, 0.6),
  etf("SMH", "VanEck Semiconductor", "Technology", ["semis", "AI"], 1.5, 0.4),
  etf("IGV", "iShares Software", "Technology", ["SaaS", "cloud"], 1.2),
  etf("CIBR", "First Trust Cybersecurity", "Technology", ["cyber"], 1.1),
  etf("XBI", "SPDR Biotech", "Healthcare", ["bio"], 1.3),
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

export const MACRO_PROXIES = ["TLT", "UUP", "GLD", "USO", "SPY"];

export const THEMES = Array.from(new Set(UNIVERSE.flatMap((i) => i.themes))).sort();
export const SECTORS = Array.from(new Set(UNIVERSE.map((i) => i.sector))).sort();

export function instrument(symbol: string): Instrument | undefined {
  return UNIVERSE.find((i) => i.symbol === symbol.toUpperCase());
}
