import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extract text from a PDF. Two-tier for cost:
 *  1. Born-digital text layer via unpdf (pdf.js) — near-free, covers most WAC
 *     spec sheets / manuals.
 *  2. Fallback: a Claude PDF-vision pass, ONLY when the text layer is empty or
 *     sparse (scanned pages, or a spec table that's actually a rasterized
 *     image). Done once at ingest and cached by the row flipping to 'active',
 *     so the expensive path never re-runs for an unchanged doc.
 */

const SPARSE_THRESHOLD = 200; // chars of real text below which we escalate

export interface ExtractResult {
  text: string;
  pages: number;
  method: "text-layer" | "claude-vision";
}

export interface ClaudeCfg {
  apiKey: string;
  model: string; // e.g. claude-haiku-4-5
}

async function textLayer(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n\n") : text;
  return { text: (merged ?? "").trim(), pages: totalPages ?? 0 };
}

function density(text: string): number {
  return text.replace(/\s+/g, "").length;
}

async function claudeVision(bytes: Uint8Array, cfg: ClaudeCfg): Promise<string> {
  const b64 = Buffer.from(bytes).toString("base64");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: b64 },
            },
            {
              type: "text",
              text:
                "Extract ALL text from this lighting product spec sheet / installation manual as clean plain text. " +
                "Render tables as readable `label: value` lines. Include every specification, dimension, electrical " +
                "value, finish, and installation step. Output only the extracted text — no preamble or commentary.",
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

export async function extractPdf(
  bytes: Uint8Array,
  claude: ClaudeCfg | null,
): Promise<ExtractResult> {
  let pages = 0;
  try {
    const t = await textLayer(bytes);
    pages = t.pages;
    if (density(t.text) >= SPARSE_THRESHOLD) {
      return { text: t.text, pages, method: "text-layer" };
    }
  } catch {
    // Corrupt/encrypted text layer — fall through to the vision pass.
  }
  if (claude) {
    const text = await claudeVision(bytes, claude);
    if (density(text) > 0) return { text, pages, method: "claude-vision" };
  }
  // Nothing usable — return empty so the caller marks the doc failed.
  return { text: "", pages, method: "text-layer" };
}
