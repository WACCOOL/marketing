import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";

/**
 * Map raw auth errors to actionable copy. The two we actually see:
 * - Supabase's project-wide email cap (until custom SMTP is configured).
 * - A consumed/expired magic link: WAC's inbound mail runs through Cisco
 *   Secure Email (IronPort), whose URL Defense FOLLOWS links in emails — that
 *   prefetch burns the one-time token before the human ever clicks. The
 *   6-digit code path below exists precisely because of this: a code is only
 *   consumed when typed into the app, so scanners can't spend it.
 */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("rate limit")) {
    return (
      "Email sign-in is temporarily rate-limited. Use “Continue with Google”, " +
      "or try the email again in about an hour."
    );
  }
  if (m.includes("expired") || m.includes("invalid")) {
    return (
      "That sign-in link was already used or has expired — company mail " +
      "security often pre-opens links, which uses them up. Request a new " +
      "email and type in the 6-digit code instead of clicking the link."
    );
  }
  return message;
}

/**
 * The magic-link redirect lands back here with the failure in the URL hash
 * (e.g. #error=access_denied&error_code=otp_expired&error_description=…).
 * Surface it instead of silently showing the sign-in form again.
 */
function consumeHashError(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const description = params.get("error_description");
  const code = params.get("error_code");
  if (!description && !code) return null;
  // Clear the hash so a reload/back doesn't resurface a stale error.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return friendlyAuthError(description ?? code ?? "sign-in failed");
}

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"google" | "magic" | "code" | null>(null);

  useEffect(() => {
    const hashErr = consumeHashError();
    if (hashErr) setErr(hashErr);
  }, []);

  async function signInGoogle() {
    setBusy("google");
    setErr(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setErr(friendlyAuthError(error.message));
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
    if (error) setErr(friendlyAuthError(error.message));
    else setSent(true);
    setBusy(null);
  }

  async function signInCode() {
    const token = code.trim();
    if (!email || token.length < 6) return;
    setBusy("code");
    setErr(null);
    const { error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: "email",
    });
    // On success the session lands via onAuthStateChange and the router takes
    // over — nothing to do here.
    if (error) setErr(friendlyAuthError(error.message));
    setBusy(null);
  }

  return (
    <div className="center-screen">
      <div className="card signin col">
        <h2>Sign in to WAC Marketing</h2>
        {err && <div className="alert error">{err}</div>}
        {sent ? (
          <>
            <div className="alert good">
              Check your inbox — a sign-in email has been sent to {email}.
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Enter the 6-digit code from the email (most reliable — company
              mail security can break the link):
            </div>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void signInCode();
              }}
            />
            <button
              onClick={signInCode}
              disabled={code.trim().length < 6 || busy !== null}
            >
              {busy === "code" ? <span className="spinner" /> : null}
              Sign in with code
            </button>
            <button
              className="secondary"
              onClick={() => {
                setSent(false);
                setCode("");
                setErr(null);
              }}
            >
              Use a different email
            </button>
          </>
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
              Email me a sign-in code
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
