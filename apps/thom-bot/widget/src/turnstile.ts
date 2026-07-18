/**
 * Cloudflare Turnstile integration.
 *
 * On first load the widget renders the Turnstile challenge into a container.
 * When the visitor solves it, we exchange the Turnstile token for a short-lived,
 * IP-bound SESSION token via POST /api/turnstile (same-origin) and hold that
 * session token in memory only. On session expiry (a 401 from /api/chat/stream)
 * the app re-renders a fresh challenge.
 */

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Inject the Turnstile script once and resolve with the global API. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile failed to initialize"));
    };
    s.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Render the challenge into `container` and resolve with the solved Turnstile
 * token. Rejects if the challenge errors or the visitor can't be verified.
 */
export function renderChallenge(container: HTMLElement, siteKey: string): Promise<string> {
  return loadTurnstile().then(
    (api) =>
      new Promise<string>((resolve, reject) => {
        container.replaceChildren();
        api.render(container, {
          sitekey: siteKey,
          callback: (token: string) => resolve(token),
          "error-callback": () => reject(new Error("Turnstile challenge failed")),
          "expired-callback": () => reject(new Error("Turnstile token expired")),
          theme: "auto",
          appearance: "interaction-only",
        });
      }),
  );
}

/** Exchange a solved Turnstile token + site key for a session token. */
export async function mintSession(token: string, siteKey: string): Promise<string> {
  const res = await fetch("/api/turnstile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, siteKey }),
  });
  if (!res.ok) {
    let msg = "verification failed";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body?.error != null) msg = String(body.error);
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  const body = (await res.json()) as { session?: unknown };
  if (typeof body.session !== "string" || !body.session) throw new Error("no session returned");
  return body.session;
}
