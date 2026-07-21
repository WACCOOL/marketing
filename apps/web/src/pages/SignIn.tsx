import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";

/**
 * Map raw auth errors to actionable copy. The two we actually see:
 * - Supabase's project-wide email cap (until custom SMTP is configured).
 * - A consumed/expired magic link: WAC's inbound mail runs through Cisco
 *   Secure Email (IronPort), whose URL Defense FOLLOWS links in emails — that
 *   prefetch burns the one-time token before the human ever clicks. The
 *   6-digit code paths below (sign-in AND password recovery) exist precisely
 *   because of this: a code is only consumed when typed into the app, so
 *   scanners can't spend it.
 */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("rate limit")) {
    return (
      "Email sign-in is temporarily rate-limited. Use “Continue with Google”, " +
      "or try the email again in about an hour."
    );
  }
  if (m.includes("invalid login credentials")) {
    return (
      "Wrong email or password. If you've never set a password, use " +
      "“Set or reset password” below to create one."
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

type Mode = "signin" | "otp-sent" | "reset-sent";

export function SignIn() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "google" | "magic" | "code" | "password" | "reset" | "setpw" | null
  >(null);

  useEffect(() => {
    const hashErr = consumeHashError();
    if (hashErr) setErr(hashErr);
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setCode("");
    setErr(null);
  }

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

  async function signInPassword() {
    if (!email || !password) return;
    setBusy("password");
    setErr(null);
    // On success the session lands via onAuthStateChange — router takes over.
    const { error } = await supabase.auth.signInWithPassword({ email, password });
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
    else switchMode("otp-sent");
    setBusy(null);
  }

  async function signInCode() {
    const token = code.trim();
    if (!email || token.length < 6) return;
    setBusy("code");
    setErr(null);
    const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
    if (error) setErr(friendlyAuthError(error.message));
    setBusy(null);
  }

  /** Password recovery, CODE-based (link-free, so IronPort can't burn it):
   *  request a recovery email, then verify its 6-digit code and set the new
   *  password in one step. Serves both "forgot" and FIRST-TIME password setup
   *  on accounts that have only ever used Google / sign-in codes. */
  async function requestReset() {
    if (!email) return;
    setBusy("reset");
    setErr(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) setErr(friendlyAuthError(error.message));
    else switchMode("reset-sent");
    setBusy(null);
  }

  async function confirmReset() {
    const token = code.trim();
    if (!email || token.length < 6 || newPassword.length < 8) return;
    setBusy("setpw");
    setErr(null);
    const { error: otpErr } = await supabase.auth.verifyOtp({ email, token, type: "recovery" });
    if (otpErr) {
      setErr(friendlyAuthError(otpErr.message));
      setBusy(null);
      return;
    }
    const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword });
    if (pwErr) {
      // The recovery code signed them in; only the password save failed. The
      // router is about to take over — surface what happened.
      setErr(`Signed in, but saving the password failed: ${pwErr.message}`);
    }
    setBusy(null);
  }

  return (
    <div className="center-screen">
      <div className="card signin col">
        <h2>Sign in to WAC Marketing</h2>
        {err && <div className="alert error">{err}</div>}

        {mode === "otp-sent" && (
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
            <button onClick={signInCode} disabled={code.trim().length < 6 || busy !== null}>
              {busy === "code" ? <span className="spinner" /> : null}
              Sign in with code
            </button>
            <button className="secondary" onClick={() => switchMode("signin")}>
              Back
            </button>
          </>
        )}

        {mode === "reset-sent" && (
          <>
            <div className="alert good">
              Check your inbox — a password email has been sent to {email}.
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Enter the 6-digit code from that email and choose your password
              (type the code — don't click the link):
            </div>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="New password (min 8 characters)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirmReset();
              }}
            />
            <button
              onClick={confirmReset}
              disabled={code.trim().length < 6 || newPassword.length < 8 || busy !== null}
            >
              {busy === "setpw" ? <span className="spinner" /> : null}
              Set password & sign in
            </button>
            <button className="secondary" onClick={() => switchMode("signin")}>
              Back
            </button>
          </>
        )}

        {mode === "signin" && (
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
              autoComplete="email"
              placeholder="you@waclighting.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void signInPassword();
              }}
            />
            <button onClick={signInPassword} disabled={!email || !password || busy !== null}>
              {busy === "password" ? <span className="spinner" /> : null}
              Sign in
            </button>
            <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
              <button className="secondary" onClick={signInMagic} disabled={!email || busy !== null}>
                {busy === "magic" ? <span className="spinner" /> : null}
                Email me a sign-in code
              </button>
              <button className="secondary" onClick={requestReset} disabled={!email || busy !== null}>
                {busy === "reset" ? <span className="spinner" /> : null}
                Set or reset password
              </button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              Have an account but no password? Enter your email and hit “Set
              or reset password”. First time here? Sign in with Google or a
              sign-in code once — that creates your account — then set a
              password. Internal WAC Group emails are auto-approved; other
              addresses create a pending account for an admin to approve.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
