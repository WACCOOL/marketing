/** Fetch the widget's public runtime config (same-origin) from GET /api/config. */

export interface WidgetConfig {
  turnstileSiteKey: string;
  /** Dark-launch flag for the feedback thumbs (UX only — the Worker's
   *  /api/feedback route also gates server-side). */
  feedbackEnabled: boolean;
}

export async function fetchConfig(): Promise<WidgetConfig> {
  try {
    const res = await fetch("/api/config", { headers: { accept: "application/json" } });
    if (!res.ok) return { turnstileSiteKey: "", feedbackEnabled: false };
    const body = (await res.json()) as { turnstileSiteKey?: unknown; feedbackEnabled?: unknown };
    return {
      turnstileSiteKey: typeof body.turnstileSiteKey === "string" ? body.turnstileSiteKey : "",
      feedbackEnabled: body.feedbackEnabled === true,
    };
  } catch {
    return { turnstileSiteKey: "", feedbackEnabled: false };
  }
}
