import crypto from "node:crypto";
import { config } from "./config.ts";

// Minimal Stripe client (Checkout Sessions + webhook signatures) over fetch, so there's
// no SDK to keep in sync. Docs: https://docs.stripe.com/api/checkout/sessions

const API = `${config.stripe.apiBase}/v1`;

interface CheckoutSession {
  id: string;
  url: string;
  client_reference_id?: string;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total?: number;
}

async function stripe<T>(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.stripe.secretKey}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `stripe ${res.status}`);
  return json;
}

export function createCheckout(o: { accountId: string; email: string; successUrl: string; cancelUrl: string }) {
  return stripe<CheckoutSession>("POST", "/checkout/sessions", {
    mode: "payment",
    client_reference_id: o.accountId,
    customer_email: o.email,
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": config.stripe.currency,
    "line_items[0][price_data][unit_amount]": String(config.stripe.priceCents),
    "line_items[0][price_data][product_data][name]": config.stripe.productName,
    "metadata[account_id]": o.accountId,
  });
}

export function retrieveCheckout(id: string) {
  return stripe<CheckoutSession>("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
}

// Stripe-Signature: t=timestamp,v1=hex(hmac_sha256(secret, `${t}.${payload}`)); 5-minute tolerance.
export function verifyWebhook(payload: string, header: string | undefined): boolean {
  if (!config.stripe.webhookSecret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = crypto.createHmac("sha256", config.stripe.webhookSecret).update(`${t}.${payload}`).digest("hex");
  const sigs = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}
