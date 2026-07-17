/**
 * Embeddings via Cloudflare Workers AI (@cf/baai/bge-m3, 1024-dim) over the
 * REST API — the same model the Worker binds as `AI`, reached from Node here so
 * the heavy ingest runs out-of-band with real RAM. Near-free; no per-token
 * vendor. Returns one 1024-float vector per input string, in order.
 */

const MODEL = "@cf/baai/bge-m3";
const MAX_BATCH = 100;

export interface CfCreds {
  accountId: string;
  token: string;
}

async function runOnce(creds: CfCreds, texts: string[]): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${MODEL}`;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: texts }),
    });
    if (res.ok) break;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      continue;
    }
    throw new Error(`Workers AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    result?: { data?: number[][] };
    success?: boolean;
    errors?: unknown[];
  };
  const vecs = data.result?.data;
  if (!Array.isArray(vecs) || vecs.length !== texts.length) {
    throw new Error(
      `Workers AI: expected ${texts.length} embeddings, got ${vecs?.length ?? "none"}`,
    );
  }
  return vecs;
}

/** Embed any number of strings, batching to the model's input cap. */
export async function embed(creds: CfCreds, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    out.push(...(await runOnce(creds, texts.slice(i, i + MAX_BATCH))));
  }
  return out;
}

/** pgvector text literal for a Supabase insert (`[1,2,3]`). */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
