import type { ThomEnv } from "./env.js";

/**
 * Embed a query with Workers AI bge-m3 (1024-dim) via the Worker's `AI`
 * binding — the SAME model the ingest pipeline uses, so query and document
 * vectors share a space. Returns the pgvector text literal (`[...]`) the
 * kb_search / product_semantic_search RPCs expect for their vector arg.
 */
export async function embedQuery(env: ThomEnv, text: string): Promise<string> {
  const [vec] = await embedTexts(env, [text]);
  return vec!;
}

/** Embed many strings with Workers AI bge-m3 (1024-dim), batching to the
 *  model's input cap. Returns one pgvector text literal (`[...]`) per input, in
 *  order — for inserting into kb_chunks.embedding. Used by the on-save marketing
 *  content projection so a document is embedded synchronously in the Worker. */
export async function embedTexts(env: ThomEnv, texts: string[]): Promise<string[]> {
  const MAX_BATCH = 100;
  const runner = env.AI as unknown as {
    run: (m: string, i: { text: string[] }) => Promise<{ data?: number[][] }>;
  };
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await runner.run("@cf/baai/bge-m3", { text: batch });
    const vecs = res.data;
    if (!Array.isArray(vecs) || vecs.length !== batch.length) {
      throw new Error(
        `embedTexts: expected ${batch.length} vectors, got ${vecs?.length ?? "none"}`,
      );
    }
    for (const vec of vecs) {
      if (!vec || vec.length !== 1024) {
        throw new Error(`embedTexts: expected a 1024-d vector, got ${vec?.length ?? "none"}`);
      }
      out.push(`[${vec.join(",")}]`);
    }
  }
  return out;
}
