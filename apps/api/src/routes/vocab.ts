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

  // source -> allowed mediums. A source with no rows is unconstrained (the
  // builder then offers the full medium list).
  const { data: mapRows, error: mapErr } = await sb
    .from("utm_source_medium")
    .select("source, medium")
    .order("source");
  if (mapErr) return c.json({ error: mapErr.message }, 500);
  const sourceMediums: Record<string, string[]> = {};
  for (const row of mapRows ?? []) {
    const r = row as { source: string; medium: string };
    (sourceMediums[r.source] ??= []).push(r.medium);
  }

  return c.json({ vocab: grouped, sourceMediums });
});

const VOCAB_TOKEN = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !/\s|[?&=#]/.test(v), "no whitespace or URL control chars")
  // utm values are always lower-cased (see buildTaggedUrl) — store them that way too.
  .transform((v) => v.toLowerCase());

const AddVocabSchema = z.object({
  type: UtmVocabTypeSchema,
  value: VOCAB_TOKEN,
});

vocabRoutes.post("/", requireAuth, async (c) => {
  const parsed = AddVocabSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  // `content` is user-extendable for everyone; `source`/`medium` require the
  // Sources & Mediums (`utm-vocab`) feature (admins always have it). RLS
  // enforces the same; this just returns a clean error first.
  const u = c.get("user");
  const canVocab = u.role === "admin" || u.features.includes("utm-vocab");
  if (parsed.data.type !== "content" && !canVocab) {
    return c.json(
      { error: "Sources & Mediums access is not enabled for your account" },
      403,
    );
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { error } = await sb
    .from("utm_vocab")
    .upsert(
      { type: parsed.data.type, value: parsed.data.value },
      { onConflict: "type,value", ignoreDuplicates: true },
    );
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

const SourceMediumSchema = z.object({
  source: VOCAB_TOKEN,
  medium: VOCAB_TOKEN,
  /** true => allow this medium for this source; false => remove the mapping. */
  enabled: z.boolean(),
});

// Toggle one (source, medium) pair in the mapping. Requires the Sources &
// Mediums (`utm-vocab`) feature; admins always have it.
vocabRoutes.post("/source-medium", requireAuth, async (c) => {
  const u = c.get("user");
  if (!(u.role === "admin" || u.features.includes("utm-vocab"))) {
    return c.json(
      { error: "Sources & Mediums access is not enabled for your account" },
      403,
    );
  }
  const parsed = SourceMediumSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { source, medium, enabled } = parsed.data;
  const { error } = enabled
    ? await sb
        .from("utm_source_medium")
        .upsert({ source, medium }, { onConflict: "source,medium", ignoreDuplicates: true })
    : await sb.from("utm_source_medium").delete().eq("source", source).eq("medium", medium);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
