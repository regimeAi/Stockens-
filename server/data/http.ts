// Shared HTTP helpers with per-host pacing, so a dozen agents combing the market never
// hammer one site (and stay inside SEC's 10 requests/second fair-access rule).

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const MIN_GAP_MS: Record<string, number> = {
  "www.sec.gov": 250,
  "data.sec.gov": 250,
  "query1.finance.yahoo.com": 400,
  "query2.finance.yahoo.com": 400,
  "feeds.finance.yahoo.com": 1200,
  "finviz.com": 4000,
  "financialdata.net": 250,
};

const nextSlot = new Map<string, number>();
const backoffUntil = new Map<string, number>();

async function slot(host: string) {
  const gap = MIN_GAP_MS[host] ?? 500;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0, backoffUntil.get(host) ?? 0);
  nextSlot.set(host, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<string> {
  const host = new URL(url).host;
  await slot(host);
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 429 || res.status === 503) backoffUntil.set(host, Date.now() + 60_000); // cool off a minute
  if (!res.ok) throw new HttpError(res.status, `${host} ${res.status} ${res.statusText}`);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<T> {
  return JSON.parse(await fetchText(url, { accept: "application/json", ...headers }, timeoutMs)) as T;
}

// Yahoo uses "-" where the S&P list uses "." (BRK.B → BRK-B); crypto is quoted vs USD.
export const yahooSymbol = (symbol: string, crypto = false) => (crypto ? `${symbol}-USD` : symbol.replace(/\./g, "-"));
