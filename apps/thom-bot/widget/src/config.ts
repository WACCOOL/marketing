/** Fetch the widget's public runtime config (same-origin) from GET /api/config. */

export interface WidgetConfig {
  turnstileSiteKey: string;
}

export async function fetchConfig(): Promise<WidgetConfig> {
  try {
    const res = await fetch("/api/config", { headers: { accept: "application/json" } });
    if (!res.ok) return { turnstileSiteKey: "" };
    const body = (await res.json()) as { turnstileSiteKey?: unknown };
    return { turnstileSiteKey: typeof body.turnstileSiteKey === "string" ? body.turnstileSiteKey : "" };
  } catch {
    return { turnstileSiteKey: "" };
  }
}
