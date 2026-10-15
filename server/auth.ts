import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type express from "express";
import { config } from "./config.ts";
import { type Account, store } from "./store.ts";
import { uid as makeId } from "./engine/indicators.ts";
import { createCheckout, retrieveCheckout, verifyWebhook } from "./stripe.ts";

// Accounts, sessions and the paywall.
//
// Modes:
//  - "paid":   STRIPE_SECRET_KEY set. Anyone can sign up; using the app needs a one-time
//              purchase. Emails in ADMIN_EMAILS get access without paying.
//  - "admin":  no Stripe key but ADMIN_EMAILS set. Only admin emails get access.
//  - "open":   neither set (local use). No login; a single built-in local user.

export type AuthMode = "paid" | "admin" | "open";
export const authMode = (): AuthMode => (config.stripe.secretKey ? "paid" : config.auth.adminEmails.length ? "admin" : "open");
export const LOCAL_UID = "local";

const COOKIE = "stk_session";
const MAX_AGE_MS = 30 * 86_400_000;

function secret(): string {
  if (config.auth.sessionSecret) return config.auth.sessionSecret;
  if (!store.global.sessionSecret) store.updateGlobal("sessionSecret", () => crypto.randomBytes(32).toString("hex"));
  return store.global.sessionSecret!;
}

const sign = (payload: string) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

// Token = uid.expiry.passwordFingerprint.mac — changing the password invalidates old sessions.
function makeToken(a: Account): string {
  const payload = `${a.id}.${Date.now() + MAX_AGE_MS}.${a.passHash.slice(0, 10)}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token: string | undefined): Account | undefined {
  if (!token) return undefined;
  const i = token.lastIndexOf(".");
  if (i < 0) return undefined;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(payload));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return undefined;
  const [id, exp, fp] = payload.split(".");
  const a = store.accounts.get(id);
  return a && Number(exp) > Date.now() && a.passHash.slice(0, 10) === fp ? a : undefined;
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, passHash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function passwordMatches(a: Account, password: string) {
  const got = Buffer.from(hashPassword(password, a.salt).passHash, "hex");
  const want = Buffer.from(a.passHash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function readCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const isAdmin = (a?: Account) => authMode() === "open" || (!!a && config.auth.adminEmails.includes(a.email));
export const hasAccess = (a?: Account) => authMode() === "open" || (!!a && (isAdmin(a) || (authMode() === "paid" && a.paid)));

// The signed-in account for a request (the local user in open mode).
export function accountFor(req: IncomingMessage): Account | undefined {
  if (authMode() === "open") {
    let a = store.accounts.get(LOCAL_UID);
    if (!a) {
      a = { id: LOCAL_UID, email: "local", passHash: "", salt: "", createdAt: Date.now(), paid: true };
      store.saveAccount(a);
    }
    return a;
  }
  return readToken(readCookie(req.headers.cookie));
}

// Brute-force guard for login/signup: 10 failures per IP per 15 minutes.
const attempts = new Map<string, { n: number; until: number }>();
const limited = (ip: string) => {
  const a = attempts.get(ip);
  return !!a && a.until > Date.now() && a.n >= 10;
};
const recordFail = (ip: string) => {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setSession(req: express.Request, res: express.Response, a: Account) {
  res.cookie(COOKIE, makeToken(a), { httpOnly: true, secure: req.secure, sameSite: "lax", maxAge: MAX_AGE_MS, path: "/" });
}

function markPaid(a: Account, sessionId: string, amount?: number) {
  if (a.paid) return;
  store.saveAccount({ ...a, paid: true, paidAt: Date.now(), stripeSessionId: sessionId, amountCents: amount });
}

const origin = (req: express.Request) => `${req.protocol}://${req.get("host")}`;

export function authRoutes(api: express.Router) {
  api.get("/session", (req, res) => {
    const a = accountFor(req);
    res.json({
      mode: authMode(),
      authed: !!a,
      email: a?.email,
      access: hasAccess(a),
      admin: isAdmin(a),
      paid: !!a?.paid,
      price: { cents: config.stripe.priceCents, currency: config.stripe.currency },
    });
  });

  api.post("/signup", (req, res) => {
    if (authMode() === "open") return res.json({ ok: true });
    const ip = req.ip ?? "?";
    if (limited(ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!EMAIL.test(email) || email.length > 200) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (store.accountByEmail(email)) {
      recordFail(ip);
      return res.status(409).json({ error: "An account with that email already exists. Log in instead." });
    }
    const a: Account = { id: makeId("u_"), email, ...hashPassword(password), createdAt: Date.now(), paid: false };
    store.saveAccount(a);
    store.user(a.id);
    setSession(req, res, a);
    res.json({ ok: true });
  });

  api.post("/login", (req, res) => {
    if (authMode() === "open") return res.json({ ok: true });
    const ip = req.ip ?? "?";
    if (limited(ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const a = store.accountByEmail(String(req.body?.email ?? ""));
    // Hash even for unknown emails so response time doesn't reveal which emails exist.
    const ok = a ? passwordMatches(a, String(req.body?.password ?? "")) : (hashPassword(String(req.body?.password ?? "")), false);
    if (!a || !ok) {
      recordFail(ip);
      return res.status(401).json({ error: "Wrong email or password." });
    }
    attempts.delete(ip);
    setSession(req, res, a);
    res.json({ ok: true });
  });

  api.post("/logout", (req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, secure: req.secure, sameSite: "lax", path: "/" });
    res.json({ ok: true });
  });

  api.post("/password", (req, res) => {
    const a = accountFor(req);
    if (!a || authMode() === "open") return res.status(401).json({ error: "Login required" });
    if (!passwordMatches(a, String(req.body?.current ?? ""))) return res.status(401).json({ error: "Current password is wrong." });
    const next = String(req.body?.next ?? "");
    if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
    const upd = { ...a, ...hashPassword(next) };
    store.saveAccount(upd);
    setSession(req, res, upd); // keeps this device logged in; others are logged out
    res.json({ ok: true });
  });

  // ---- payment ----
  api.post("/checkout", async (req, res) => {
    const a = accountFor(req);
    if (!a) return res.status(401).json({ error: "Login required" });
    if (hasAccess(a)) return res.json({ already: true });
    if (authMode() !== "paid") return res.status(503).json({ error: "Purchases aren't set up on this server yet." });
    try {
      const s = await createCheckout({
        accountId: a.id,
        email: a.email,
        successUrl: `${origin(req)}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin(req)}/?checkout=cancelled`,
      });
      res.json({ url: s.url });
    } catch (e) {
      console.error("stripe checkout:", (e as Error).message);
      res.status(502).json({ error: "Couldn't start checkout. Please try again." });
    }
  });

  // Called when the buyer returns from Stripe; the webhook below covers a closed tab.
  api.post("/checkout/verify", async (req, res) => {
    const a = accountFor(req);
    if (!a) return res.status(401).json({ error: "Login required" });
    const id = String(req.body?.sessionId ?? "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Bad session id" });
    try {
      const s = await retrieveCheckout(id);
      if (s.client_reference_id === a.id && s.payment_status === "paid") markPaid(a, s.id, s.amount_total);
      res.json({ access: hasAccess(store.accounts.get(a.id)) });
    } catch (e) {
      console.error("stripe verify:", (e as Error).message);
      res.status(502).json({ error: "Couldn't confirm payment yet. Refresh in a moment." });
    }
  });
}

// Stripe webhook needs the raw body for signature checks, so it's mounted before express.json().
export function stripeWebhook(req: express.Request, res: express.Response) {
  const raw = (req.body as Buffer).toString("utf8");
  if (!verifyWebhook(raw, req.get("stripe-signature"))) return res.status(400).send("bad signature");
  const evt = JSON.parse(raw) as { type: string; data: { object: { id: string; client_reference_id?: string; payment_status?: string; amount_total?: number } } };
  if (evt.type === "checkout.session.completed" || evt.type === "checkout.session.async_payment_succeeded") {
    const s = evt.data.object;
    const a = s.client_reference_id ? store.accounts.get(s.client_reference_id) : undefined;
    if (a && s.payment_status === "paid") markPaid(a, s.id, s.amount_total);
  }
  res.json({ received: true });
}

// Everything else under /api needs a signed-in account with access.
const PUBLIC = new Set(["/session", "/signup", "/login", "/logout", "/password", "/checkout", "/checkout/verify", "/health", "/crypto/tradingview"]);
export function requireAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (PUBLIC.has(req.path)) return next();
  const a = accountFor(req);
  if (!a) return res.status(401).json({ error: "Login required" });
  if (!hasAccess(a)) return res.status(402).json({ error: "Purchase required" });
  res.locals.uid = a.id;
  res.locals.admin = isAdmin(a);
  next();
}
