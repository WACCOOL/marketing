import { useState } from "react";
import { supabase } from "../lib/supabase.js";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"google" | "magic" | null>(null);

  async function signInGoogle() {
    setBusy("google");
    setErr(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setErr(error.message);
    setBusy(null);
  }

  async function signInMagic() {
    if (!email) return;
    setBusy("magic");
    setErr(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setErr(error.message);
    else setSent(true);
    setBusy(null);
  }

  return (
    <div className="center-screen">
      <div className="card signin col">
        <h2>Sign in to WAC Marketing</h2>
        {err && <div className="alert error">{err}</div>}
        {sent ? (
          <div className="alert good">
            Check your inbox — a sign-in link has been sent to {email}.
          </div>
        ) : (
          <>
            <button onClick={signInGoogle} disabled={busy !== null}>
              {busy === "google" ? <span className="spinner" /> : null}
              Continue with Google
            </button>
            <div className="muted" style={{ textAlign: "center", margin: "8px 0" }}>
              or
            </div>
            <input
              type="email"
              placeholder="you@waclighting.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button
              className="secondary"
              onClick={signInMagic}
              disabled={!email || busy !== null}
            >
              {busy === "magic" ? <span className="spinner" /> : null}
              Email me a magic link
            </button>
            <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              Internal WAC Group emails are auto-approved. Other addresses
              create a pending account for an admin to approve.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
