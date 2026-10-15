import { useState } from "react";
import { api } from "../api";

export function Login() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      await api("/login", { method: "POST", body: { password } });
      location.reload();
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={64} height={64} style={{ borderRadius: 16 }} />
        <h1 style={{ margin: "12px 0 4px", fontSize: 26 }}>Stockens</h1>
        <p className="small ink2" style={{ marginTop: 0 }}>Enter your password to continue.</p>
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {err && <div className="small down" style={{ marginTop: 8 }}>{err}</div>}
        <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={!password || busy}>
          {busy ? "Checking…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
