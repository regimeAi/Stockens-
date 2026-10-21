import { describe, expect, it } from "vitest";
import { consensusScore, fdSymbol, nyTime, parseBars, parseEarningsCalendar, parseEarningsReleases, parseKeyMetrics, parseNews, parseQuotes } from "../server/data/financialdata.ts";

describe("FinancialData.net mapping", () => {
  it("reads New York times in either season", () => {
    expect(new Date(nyTime("2026-06-05 23:59:55")).toISOString()).toBe("2026-06-06T03:59:55.000Z"); // EDT
    expect(new Date(nyTime("2026-01-05 09:30:00")).toISOString()).toBe("2026-01-05T14:30:00.000Z"); // EST
  });

  it("turns newest-first daily rows into ascending bars", () => {
    const bars = parseBars([
      { trading_symbol: "MSFT", date: "2024-12-04", open: 433.03, high: 439.67, low: 432.63, close: 437.42, volume: 26009430 },
      { trading_symbol: "MSFT", date: "2024-12-03", open: 429.84, high: 432.47, low: 427.74, close: 431.2, volume: 18301990 },
      { trading_symbol: "MSFT", date: "bad", open: 1, high: 1, low: 1, close: 1 },
    ]);
    expect(bars.map((b) => b.c)).toEqual([431.2, 437.42]);
    expect(new Date(bars[0].t).toDateString()).toContain("Dec 03 2024");
  });

  it("maps quotes back to our symbols, crypto included", () => {
    expect(fdSymbol("BTC", "crypto")).toBe("BTCUSD");
    const q = parseQuotes(
      [
        { trading_symbol: "AAPL", price: 238.08 },
        { trading_symbol: "BTCUSD", price: 111394.68 },
        { trading_symbol: "ZZZ", price: 5 },
      ],
      new Map([["AAPL", "AAPL"], ["BTCUSD", "BTC"]]),
    );
    expect(Object.fromEntries(q)).toEqual({ AAPL: 238.08, BTC: 111394.68 });
  });

  it("extracts fundamentals, surprise and consensus", () => {
    const f = parseKeyMetrics([
      { fiscal_year: "2023", period_end_date: "2023-06-30", price_to_earnings_ratio: 30 },
      { fiscal_year: "2024", period_end_date: "2024-06-30", price_to_earnings_ratio: 38.5, forward_price_to_earnings_ratio: 34.26, dividend_yield: 0.0066 },
    ]);
    expect(f.pe).toBe(38.5);
    expect(f.forwardPe).toBeCloseTo(34.26);
    expect(f.dividendYield).toBeCloseTo(0.66);
    expect(parseEarningsReleases([{ fiscal_quarter_end_date: "2024-06", percentage_surprise: 1.72 }, { fiscal_quarter_end_date: "2024-09", percentage_surprise: 7.14 }]).epsSurprise).toBe(7.14);
    const c = consensusScore([{ average_price_target: 555.73, highest_price_target: 680, lowest_price_target: 400, buy_recommendations: 36, hold_recommendations: 1, sell_recommendations: 0 }], 500);
    expect(c.score!).toBeGreaterThan(0.3);
    expect(c.dispersion!).toBeGreaterThan(0);
  });

  it("routes news to covered tickers and reads the earnings calendar", () => {
    const news = parseNews(
      [{ trading_symbols: "CRWV,GOOG,NVDA", publication_time: "2026-06-05 23:59:55", article_headline: "Nvidia beats estimates and raises guidance", article_text: "" }],
      new Set(["NVDA", "GOOG"]),
    );
    expect(news.map((n) => n.symbol).sort()).toEqual(["GOOG", "NVDA"]);
    expect(news[0].source).toBe("FinancialData.net");
    const cal = parseEarningsCalendar([{ trading_symbol: "XOM", report_date: "2025-10-31", conference_call_time: "2025-10-31 08:30:00" }]);
    expect(new Date(cal.get("XOM")!).toISOString()).toBe("2025-10-31T12:30:00.000Z");
  });
});
