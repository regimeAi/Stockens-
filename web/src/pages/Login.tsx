import { useState } from "react";
import { api } from "../api";

export interface SessionInfo {
  mode: "paid" | "admin" | "open";
  authed: boolean;
  email?: string;
  access: boolean;
  admin: boolean;
  paid: boolean;
  price: { cents: number; currency: string };
  resetAvailable: boolean;
}

export const formatPrice = (p: SessionInfo["price"]) => new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency.toUpperCase() }).format(p.cents / 100);

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login">
      <div className="card">
        <img src="/icon.svg" alt="" width={64} height={64} style={{ borderRadius: 16 }} />
        <h1 style={{ margin: "12px 0 4px", fontSize: 26 }}>Stockens</h1>
        {children}
      </div>
    </div>
  );
}

export function Login({ session }: { session: SessionInfo }) {
  const [mode, setMode] = useState<"signup" | "login" | "forgot">("signup");
  const [sent, setSent] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      if (mode === "forgot") {
        const r = await api<{ message: string }>("/password/forgot", { method: "POST", body: { email } });
        setSent(r.message);
        setBusy(false);
        return;
      }
      await api(`/${mode}`, { method: "POST", body: { email, password } });
      location.reload();
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  return (
    <Shell>
      <p className="small ink2" style={{ marginTop: 0 }}>
        {mode === "forgot"
          ? "Enter your account email and we'll send you a link to set a new password."
          : mode === "signup"
          ? session.mode === "paid"
            ? `Explainable stock & crypto forecasts. ${formatPrice(session.price)} one-time — no subscription.`
            : "Create your account."
          : "Welcome back."}
      </p>
      <div className="chips" style={{ justifyContent: "center", marginBottom: 12 }}>
        <button type="button" className={`chip ${mode === "signup" ? "on" : ""}`} onClick={() => setMode("signup")}>Create account</button>
        <button type="button" className={`chip ${mode === "login" ? "on" : ""}`} onClick={() => setMode("login")}>Log in</button>
      </div>
      <form onSubmit={submit} style={{ textAlign: "left" }}>
        <input className="field" type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
        {mode !== "forgot" && <input
          className="field"
          style={{ marginTop: 8 }}
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder={mode === "signup" ? "Password (8+ characters)" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />}
        {err && <div className="small down" style={{ marginTop: 8 }}>{err}</div>}
        {sent && <div className="small status-good" style={{ marginTop: 8 }}>{sent}</div>}
        <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={!email || (mode !== "forgot" && !password) || busy}>
          {busy ? "One moment…" : mode === "signup" ? "Create account" : mode === "login" ? "Log in" : "Email me a reset link"}
        </button>
      </form>
      {mode === "login" && session.resetAvailable && (
        <button type="button" className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => (setMode("forgot"), setErr(undefined), setSent(undefined))}>
          Forgot password?
        </button>
      )}
      {mode === "forgot" && (
        <button type="button" className="btn ghost sm" style={{ marginTop: 10 }} onClick={() => (setMode("login"), setErr(undefined), setSent(undefined))}>
          Back to log in
        </button>
      )}
      <p className="tiny muted" style={{ marginTop: 14 }}>Analytics and education only — not financial advice.</p>
    </Shell>
  );
}

export function Paywall({ session }: { session: SessionInfo }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const cancelled = new URLSearchParams(location.search).get("checkout") === "cancelled";
  const buy = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api<{ url?: string; already?: boolean }>("/checkout", { method: "POST" });
      if (r.already) return location.reload();
      if (r.url) location.href = r.url;
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  const logout = () => api("/logout", { method: "POST" }).then(() => location.replace("/"));
  if (session.mode !== "paid")
    return (
      <Shell>
        <p className="small ink2">Access to this Stockens server is limited to its owner.</p>
        <button className="btn ghost sm" onClick={logout}>Log out</button>
      </Shell>
    );
  return (
    <Shell>
      <p className="small ink2" style={{ marginTop: 0 }}>Signed in as {session.email}</p>
      <div style={{ fontSize: 40, fontWeight: 700, margin: "8px 0 0" }}>{formatPrice(session.price)}</div>
      <div className="small muted">one-time · lifetime access</div>
      <ul className="small ink2" style={{ textAlign: "left", lineHeight: 1.7, paddingLeft: 20 }}>
        <li>Live best 5-day buys & sells from the background agent</li>
        <li>Forecasts with confidence bands and what drove them</li>
        <li>Signal cards with entry, stop, target and position size</li>
        <li>Strategy Lab, risk tools, alerts and the BTC engine</li>
      </ul>
      {cancelled && <div className="small muted">Checkout cancelled — you weren't charged.</div>}
      {err && <div className="small down" style={{ marginTop: 8 }}>{err}</div>}
      <button className="btn primary" style={{ width: "100%", marginTop: 8 }} onClick={buy} disabled={busy}>
        {busy ? "Opening checkout…" : `Unlock for ${formatPrice(session.price)}`}
      </button>
      <div className="tiny muted" style={{ marginTop: 8 }}>Secure payment by Stripe. Apple Pay and cards accepted.</div>
      <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={logout}>Log out</button>
    </Shell>
  );
}

// Landing page for the emailed link: /?reset=<token>
export function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setErr("Passwords don't match.");
    setBusy(true);
    setErr(undefined);
    try {
      await api("/password/reset", { method: "POST", body: { token, password } });
      location.replace("/");
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  return (
    <Shell>
      <p className="small ink2" style={{ marginTop: 0 }}>Choose a new password. You'll be logged in, and other devices will be logged out.</p>
      <form onSubmit={submit} style={{ textAlign: "left" }}>
        <input className="field" type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input className="field" style={{ marginTop: 8 }} type="password" autoComplete="new-password" placeholder="Repeat new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {err && <div className="small down" style={{ marginTop: 8 }}>{err}</div>}
        <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={password.length < 8 || !confirm || busy}>
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
      <a className="btn ghost sm" style={{ marginTop: 10 }} href="/">Back to log in</a>
    </Shell>
  );
}
