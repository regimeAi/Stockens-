import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type express from "express";
import { config } from "./config.ts";
import { store } from "./store.ts";

// Password login for hosting the app online. A single shared password (APP_PASSWORD)
// unlocks the app; a signed, HttpOnly session cookie keeps the device logged in.
// With no APP_PASSWORD set the app stays open, which is fine for localhost only.

const COOKIE = "stk_session";
const MAX_AGE_MS = 30 * 86_400_000;

export const authEnabled = () => !!config.auth.password;

function secret(): string {
  if (config.auth.sessionSecret) return config.auth.sessionSecret;
  if (!store.data.sessionSecret) store.update("sessionSecret", () => crypto.randomBytes(32).toString("hex"));
  return store.data.sessionSecret!;
}

const sign = (payload: string) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

function makeToken(): string {
  // The password fingerprint is part of the token, so changing APP_PASSWORD logs every device out.
  const payload = `${Date.now() + MAX_AGE_MS}.${sign(config.auth.password).slice(0, 12)}`;
  return `${payload}.${sign(payload)}`;
}

function validToken(token: string | undefined): boolean {
  if (!token) return false;
  const i = token.lastIndexOf(".");
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(payload));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return false;
  const [exp, pw] = payload.split(".");
  return Number(exp) > Date.now() && pw === sign(config.auth.password).slice(0, 12);
}

function passwordMatches(input: string): boolean {
  // Compare fixed-length digests so the check takes the same time for any input.
  const a = crypto.createHash("sha256").update(input).digest();
  const b = crypto.createHash("sha256").update(config.auth.password).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isAuthed(req: IncomingMessage): boolean {
  return !authEnabled() || validToken(readCookie(req.headers.cookie));
}

// Simple in-memory brute-force guard: 10 failed attempts per IP per 15 minutes.
const attempts = new Map<string, { n: number; until: number }>();
function limited(ip: string): boolean {
  const a = attempts.get(ip);
  return !!a && a.until > Date.now() && a.n >= 10;
}
function recordFail(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}

export function authRoutes(api: express.Router) {
  api.get("/session", (req, res) => res.json({ authRequired: authEnabled(), authed: isAuthed(req) }));

  api.post("/login", (req, res) => {
    if (!authEnabled()) return res.json({ ok: true });
    const ip = req.ip ?? "unknown";
    if (limited(ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    if (typeof req.body?.password !== "string" || !passwordMatches(req.body.password)) {
      recordFail(ip);
      return res.status(401).json({ error: "Wrong password" });
    }
    attempts.delete(ip);
    res.cookie(COOKIE, makeToken(), { httpOnly: true, secure: req.secure, sameSite: "lax", maxAge: MAX_AGE_MS, path: "/" });
    res.json({ ok: true });
  });

  api.post("/logout", (req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, secure: req.secure, sameSite: "lax", path: "/" });
    res.json({ ok: true });
  });
}

// Everything under /api needs a session, except the login endpoints, the health check
// used by the host, and the TradingView webhook (which carries its own secret).
const PUBLIC = new Set(["/session", "/login", "/logout", "/health", "/crypto/tradingview"]);
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (PUBLIC.has(req.path) || isAuthed(req)) return next();
  res.status(401).json({ error: "Login required" });
}
