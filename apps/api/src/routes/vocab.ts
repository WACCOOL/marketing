import { Hono } from "hono";
import { z } from "zod";
import { UtmVocabTypeSchema } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";
import { makeCampaignAdapter } from "../hubspot.js";

export const vocabRoutes = new Hono<AppBindings>();

vocabRoutes.get("/campaigns", requireAuth, async (c) => {
  const adapter = makeCampaignAdapter(c.env);
  const list = await adapter.list();
  return c.json({ campaigns: list });
});

vocabRoutes.get("/", requireAuth, async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("utm_vocab")
    .select("id, type, value")
    .order("value");
  if (error) return c.json({ error: error.message }, 500);
  const grouped: Record<string, string[]> = { source: [], medium: [], content: [] };
  for (const row of data ?? []) {
    const r = row as { type: string; value: string };
    if (r.type in grouped) grouped[r.type]!.push(r.value);
  }
  return c.json({ vocab: grouped });
});

const AddContentSchema = z.object({
  type: UtmVocabTypeSchema,
  value: z
    .string()
    .trim()
    .min(1)
    .refine((v) => !/\s|[?&=#]/.test(v), "no whitespace or URL control chars"),
});

vocabRoutes.post("/", requireAuth, async (c) => {
  const parsed = AddContentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  // Only `content` is user-extendable per the PRD.
  if (parsed.data.type !== "content") {
    return c.json({ error: "only content vocab is user-extendable" }, 403);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { error } = await sb
    .from("utm_vocab")
    .upsert(
      { type: "content", value: parsed.data.value },
      { onConflict: "type,value", ignoreDuplicates: true },
    );
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
