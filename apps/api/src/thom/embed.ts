import type { Env } from "../env.js";

/**
 * Embed a query with Workers AI bge-m3 (1024-dim) via the Worker's `AI`
 * binding — the SAME model the ingest pipeline uses, so query and document
 * vectors share a space. Returns the pgvector text literal (`[...]`) the
 * kb_search / product_semantic_search RPCs expect for their vector arg.
 */
export async function embedQuery(env: Env, text: string): Promise<string> {
  const out = (await (env.AI as unknown as {
    run: (m: string, i: { text: string[] }) => Promise<{ data?: number[][] }>;
  }).run("@cf/baai/bge-m3", { text: [text] }));
  const vec = out.data?.[0];
  if (!vec || vec.length !== 1024) {
    throw new Error(`embedQuery: expected a 1024-d vector, got ${vec?.length ?? "none"}`);
  }
  return `[${vec.join(",")}]`;
}
