import { supabase } from "./supabase.js";

const BASE = import.meta.env.VITE_API_BASE_URL ?? ""; // empty -> same origin via Vite proxy

export interface ApiError {
  status: number;
  error: string;
  issues?: unknown;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let body: unknown = await res.text();
    if (ct.includes("application/json")) {
      try {
        body = JSON.parse(body as string);
      } catch {
        // keep text
      }
    }
    const err: ApiError = {
      status: res.status,
      error: typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : String(body),
      issues:
        typeof body === "object" && body && "issues" in body
          ? (body as { issues: unknown }).issues
          : undefined,
    };
    throw err;
  }
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.blob()) as unknown as T;
}

export async function apiBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    throw {
      status: res.status,
      error: await res.text(),
    } satisfies ApiError;
  }
  return await res.blob();
}
