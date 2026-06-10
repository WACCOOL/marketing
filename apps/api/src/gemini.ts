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

export async function geminiText(
  env: Env,
  opts: { prompt: string; system?: string; json?: boolean; model?: string },
): Promise<string> {
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
        temperature: 0.7,
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini responded ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}
