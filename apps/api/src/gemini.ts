import type { Env } from "./env.js";

/**
 * Minimal Gemini text-generation client for the API Worker (Phase 2 — Product
 * Information). Text/data work needs no container (PRD §4), so the Worker
 * calls the Generative Language REST API directly. Distinct from the image
 * pipeline in apps/generator, which has its own Gemini adapter.
 */

const GEMINI_TEXT_MODEL_DEFAULT = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 30_000;

export function geminiConfigured(env: Env): boolean {
  return !!env.GEMINI_API_KEY;
}

export interface GeminiUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GeminiTextOpts {
  prompt: string;
  system?: string;
  json?: boolean;
  model?: string;
  /** Override generation temperature (default 0.7). Classification wants ~0. */
  temperature?: number;
  /** Override for long generations (e.g. doc-to-deck drafting); default 30s. */
  timeoutMs?: number;
}

export async function geminiText(env: Env, opts: GeminiTextOpts): Promise<string> {
  return (await geminiTextWithUsage(env, opts)).text;
}

/**
 * Same as geminiText but also returns the response's token usage (so callers can
 * measure ACTUAL spend — used by the company sub-type classifier to price a
 * sample before any large run).
 */
export async function geminiTextWithUsage(
  env: Env,
  opts: GeminiTextOpts,
): Promise<{ text: string; usage: GeminiUsage | null }> {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "AI text generation is not configured (GEMINI_API_KEY is unset)",
    );
  }
  const model = opts.model || env.GEMINI_TEXT_MODEL || GEMINI_TEXT_MODEL_DEFAULT;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      ...(opts.system
        ? { systemInstruction: { parts: [{ text: opts.system }] } }
        : {}),
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini responded ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty response");
  const um = data.usageMetadata;
  const usage: GeminiUsage | null = um
    ? {
        promptTokens: um.promptTokenCount ?? 0,
        outputTokens: um.candidatesTokenCount ?? 0,
        totalTokens: um.totalTokenCount ?? 0,
      }
    : null;
  return { text, usage };
}
