import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import { PPT_LAYOUTS, PptDeckSchema, type PptDeck } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import type { Env } from "../env.js";
import { requireAuth } from "../auth.js";
import { generatorFetch } from "../generatorClient.js";
import { geminiText } from "../gemini.js";
import { userSupabase } from "../supabase.js";

/**
 * PRD §8 — PPT Generator. Admin-uploaded .pptx templates live in R2
 * (templates/{id}.pptx) with one ppt_templates row each; the generation
 * Container introspects an upload's slide layouts (python-pptx) to seed
 * `layout_map`, which maps the canonical deck layout names (see
 * packages/shared/src/ppt.ts) onto the template's own layouts. Deck export
 * itself runs through the normal /api/jobs pipeline (tool="ppt"); this file
 * covers template management plus the doc-driven AI drafting flow.
 *
 * RLS is the enforcement layer (active users read templates, admins manage
 * them) — the role checks here just give non-admins a clean 403.
 */
export const pptRoutes = new Hono<AppBindings>();

pptRoutes.use("*", requireAuth, async (c, next) => {
  if (c.get("user").role === "rep") {
    return c.json({ error: "the PPT generator is internal-only" }, 403);
  }
  await next();
});

interface TemplateRow {
  id: string;
  name: string;
  brand: string | null;
  r2_key: string;
  version: number;
  layout_map: Record<string, string>;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_COLS =
  "id, name, brand, r2_key, version, layout_map, uploaded_by, created_at, updated_at";

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_PPTX_BYTES = 30 * 1024 * 1024; // 30 MB
// Introspection unzips the deck and walks every layout's placeholders — quick,
// but allow for a container cold start.
const INTROSPECT_TIMEOUT_MS = 60_000;

/** Partial record canonical-layout -> template layout name; unknown keys 400. */
const LayoutMapSchema = z.record(z.enum(PPT_LAYOUTS), z.string().max(200));

function isAdmin(c: Context<AppBindings>): boolean {
  return c.get("user").role === "admin";
}

// ---------------------------------------------------------------------------
// Multipart .pptx intake (shared by upload + re-upload)
// ---------------------------------------------------------------------------

type PptxUpload =
  | { ok: true; bytes: ArrayBuffer; name: string; brand: string | null }
  | { ok: false; error: string };

/** Parse + sanity-check a multipart .pptx upload (size cap, zip magic bytes). */
async function readPptxUpload(c: Context<AppBindings>): Promise<PptxUpload> {
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch {
    return { ok: false, error: "expected multipart/form-data with a file part" };
  }
  const file = body.file;
  if (!(file instanceof File)) {
    return { ok: false, error: 'missing "file" part' };
  }
  if (!/\.pptx$/i.test(file.name)) {
    return { ok: false, error: "file must be a .pptx" };
  }
  if (file.size > MAX_PPTX_BYTES) {
    return { ok: false, error: `file exceeds max size (${MAX_PPTX_BYTES} bytes)` };
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) {
    return { ok: false, error: "empty file" };
  }
  if (bytes.byteLength > MAX_PPTX_BYTES) {
    return { ok: false, error: `file exceeds max size (${MAX_PPTX_BYTES} bytes)` };
  }
  // .pptx is a zip — check the local-file-header magic so an arbitrary blob
  // can't be stored as a template.
  const magic = new Uint8Array(bytes, 0, 4);
  if (
    magic[0] !== 0x50 ||
    magic[1] !== 0x4b ||
    magic[2] !== 0x03 ||
    magic[3] !== 0x04
  ) {
    return { ok: false, error: "file is not a valid .pptx (bad zip header)" };
  }
  const nameField = typeof body.name === "string" ? body.name.trim() : "";
  const brandField = typeof body.brand === "string" ? body.brand.trim() : "";
  return {
    ok: true,
    bytes,
    name: nameField || file.name.replace(/\.pptx$/i, ""),
    brand: brandField || null,
  };
}

// ---------------------------------------------------------------------------
// Container introspection proxy
// ---------------------------------------------------------------------------

/**
 * Ask the generation Container to introspect a stored template's slide
 * layouts. Contract: { ok, slideWidthEmu, slideHeightEmu, layouts: [{ index,
 * name, placeholders: [{ idx, type, name, xEmu, yEmu, wEmu, hEmu }] }],
 * suggestedMap }. Failures come back as { ok: false, error } rather than
 * throwing — a template with no introspection is still mappable by hand.
 */
async function introspectTemplate(
  env: Env,
  routingKey: string,
  r2Key: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await generatorFetch(env, routingKey, "/ppt-introspect", {
      method: "POST",
      body: JSON.stringify({ r2Key }),
      signal: AbortSignal.timeout(INTROSPECT_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `introspection failed: ${msg}` };
  }
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (json && typeof json === "object") {
      return "ok" in json ? json : { ok: res.ok, ...json };
    }
  } catch {
    // non-JSON body (e.g. a stale container's catch-all) — fall through
  }
  return { ok: false, error: text || `introspection failed (${res.status})` };
}

async function loadTemplate(
  c: Context<AppBindings>,
  id: string,
): Promise<TemplateRow | null> {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("ppt_templates")
    .select(TEMPLATE_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TemplateRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** List templates for the picker (active users, RLS-scoped). */
pptRoutes.get("/templates", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("ppt_templates")
    .select(TEMPLATE_COLS)
    .order("name", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ templates: (data ?? []) as TemplateRow[] });
});

/** Upload a new .pptx template (admin), then introspect it to seed layout_map. */
pptRoutes.post("/templates", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "admin only" }, 403);
  const user = c.get("user");

  const upload = await readPptxUpload(c);
  if (!upload.ok) return c.json({ error: upload.error }, 400);

  const id = crypto.randomUUID();
  const r2Key = `templates/${id}.pptx`;
  await c.env.ASSETS_BUCKET.put(r2Key, upload.bytes, {
    httpMetadata: { contentType: PPTX_CONTENT_TYPE },
  });

  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: inserted, error } = await sb
    .from("ppt_templates")
    .insert({
      id,
      name: upload.name,
      brand: upload.brand,
      r2_key: r2Key,
      version: 1,
      layout_map: {},
      uploaded_by: user.id,
    })
    .select(TEMPLATE_COLS)
    .single();
  if (error) return c.json({ error: error.message }, 500);
  let template = inserted as TemplateRow;

  // Seed layout_map from the introspection heuristic when it succeeds; a
  // failed introspection still returns 200 so the admin can map manually.
  const introspection = await introspectTemplate(c.env, `ppt:${user.id}`, r2Key);
  const suggested = LayoutMapSchema.safeParse(introspection.suggestedMap);
  if (introspection.ok === true && suggested.success) {
    const { data: updated, error: uerr } = await sb
      .from("ppt_templates")
      .update({ layout_map: suggested.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(TEMPLATE_COLS)
      .single();
    if (!uerr && updated) template = updated as TemplateRow;
  }

  return c.json({ template, introspection }, 201);
});

const TemplatePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    brand: z.string().trim().max(200).nullable().optional(),
    layout_map: LayoutMapSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

/** Edit a template's name/brand/layout mapping (admin). */
pptRoutes.patch("/templates/:id", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "admin only" }, 403);
  const parsed = TemplatePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("ppt_templates")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", c.req.param("id"))
    .select(TEMPLATE_COLS)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ template: data as TemplateRow });
});

/**
 * Re-upload a template's .pptx (admin): overwrite the same R2 key and bump
 * `version`. The admin's layout_map survives — the fresh introspection is
 * returned for the mapping UI but never auto-applied here.
 */
pptRoutes.post("/templates/:id/file", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "admin only" }, 403);
  const existing = await loadTemplate(c, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);

  const upload = await readPptxUpload(c);
  if (!upload.ok) return c.json({ error: upload.error }, 400);

  await c.env.ASSETS_BUCKET.put(existing.r2_key, upload.bytes, {
    httpMetadata: { contentType: PPTX_CONTENT_TYPE },
  });

  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("ppt_templates")
    .update({
      version: existing.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", existing.id)
    .select(TEMPLATE_COLS)
    .single();
  if (error) return c.json({ error: error.message }, 500);

  const introspection = await introspectTemplate(
    c.env,
    `ppt:${c.get("user").id}`,
    existing.r2_key,
  );
  return c.json({ template: data as TemplateRow, introspection });
});

/** Re-run introspection on the stored file (admin, reopens the mapping UI). */
pptRoutes.post("/templates/:id/introspect", async (c) => {
  if (!isAdmin(c)) return c.json({ error: "admin only" }, 403);
  const existing = await loadTemplate(c, c.req.param("id"));
  if (!existing) return c.json({ error: "not found" }, 404);
  const introspection = await introspectTemplate(
    c.env,
    `ppt:${c.get("user").id}`,
    existing.r2_key,
  );
  return c.json({ introspection });
});

// ---------------------------------------------------------------------------
// AI drafting — document text -> deck JSON (Gemini, directly from the Worker)
// ---------------------------------------------------------------------------

const DraftSchema = z.object({
  text: z.string().min(1).max(100_000),
  templateId: z.string().uuid(),
  /**
   * Document images: the client extracts them from the .docx, uploads each via
   * /api/uploads, and replaces it in `text` with an [IMAGE:n] marker. The
   * model references them back as fields.imageRef, which we resolve to URLs.
   */
  images: z
    .array(
      z.object({
        ref: z.number().int().min(1).max(99),
        url: z.string().url(),
      }),
    )
    .max(30)
    .optional(),
});

const DRAFT_SYSTEM = [
  "You convert documents into presentation outlines for a premium architectural lighting company (WAC Group).",
  "Respond with JSON only, exactly this shape:",
  '{"slides":[{"layout":"<layout name>","fields":{...}}]}',
  "Layouts (the only valid names) and the fields each one uses:",
  '- "title": {"title": string, "subtitle"?: string} — the opening slide.',
  '- "title_content": {"title": string, "bullets"?: [string], "body"?: string}.',
  '- "title_content_image": {"title": string, "bullets"?: [string], "body"?: string} plus an image (see the image rules).',
  '- "two_column": {"title": string, "body": string, "body2": string} — left and right columns.',
  '- "image_full": {"title"?: string} — a full-bleed image slide (see the image rules).',
  '- "image_caption": {"title"?: string, "body"?: string} — an image with a caption (see the image rules).',
  '- "agenda": {"title": string, "bullets": [string]} — the agenda items, 8 or fewer.',
  '- "quote": {"quote": {"text": string, "attribution"?: string}} — a standout pull quote.',
  '- "chart": {"title": string, "chart": {"chartType": "column"|"bar"|"line"|"pie", "categories": [string], "series": [{"name": string, "values": [number]}]}} — every series\'s "values" array must contain exactly as many numbers as there are categories.',
  '- "diagram": {"title": string, "items": [string]} — grouped/related concepts as short labels.',
  '- "process": {"title": string, "items": [string]} — sequential steps as short labels.',
  '- "video": {"title"?: string, "video": {"url": string, "caption"?: string}} — an embedded movie.',
  '- "table": {"title": string, "table": {"headers": [string], "rows": [[string]]}} — every row must have exactly as many cells as there are headers.',
  '- "section": {"title": string, "subtitle"?: string} — a chapter/major-topic divider.',
  "Rules:",
  "- 5-20 slides is typical; never pad with filler slides.",
  '- Start with a "title" slide (title + subtitle).',
  '- When the document has section structure worth an agenda, prefer an "agenda" slide right after the title slide; keep it to 8 items or fewer.',
  '- Use "section" slides to break chapters/major topics.',
  "- At most 8 bullets per slide; split dense content across slides.",
  '- Use "quote" for standout pull quotes with attribution when the document contains them.',
  '- Use "chart" ONLY when the document contains numeric data suited to one: "column" for comparisons, "line" for trends over time, "pie" for shares of a whole. Never invent numbers.',
  '- Use "process" for step sequences and workflows, "diagram" for grouped concepts; both take "items" (8 or fewer short labels).',
  '- Use "video" only when the document references a direct video file URL (.mp4/.webm); put that URL in fields.video.url.',
  '- Use "table" only for genuinely tabular data.',
  '- The document may contain [IMAGE:n] markers standing in for its images. Where a slide\'s content covers a marker, add "imageRef": n inside that slide\'s "fields" and choose an image-bearing layout (image_full, image_caption, or title_content_image) for it when appropriate.',
  '- Where the document DESCRIBES a desired image (a figure caption, an "Image: ..." description) without an [IMAGE:n] marker, set fields.imagePrompt to a detailed photographic text-to-image prompt — mention the setting, mood, and lighting; this is an architectural-lighting brand.',
  '- Never output an "images" field — the system attaches the actual images from your "imageRef" values.',
  "- Plain text only in every field: no markdown, no bullet glyphs, no HTML.",
].join("\n");

/** Strip a ```json fence if the model wrapped its output in one. */
function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** One model pass: generate, parse, resolve imageRefs, inject ids + templateId, validate. */
async function draftDeckOnce(
  env: Env,
  basePrompt: string,
  templateId: string,
  imageByRef: ReadonlyMap<number, string>,
  feedback: string | null,
): Promise<{ ok: true; deck: PptDeck } | { ok: false; error: string }> {
  const raw = await geminiText(env, {
    model: "gemini-3.1-pro-preview",
    json: true,
    system: DRAFT_SYSTEM,
    prompt: feedback
      ? `${basePrompt}\n\nYour previous attempt was invalid — fix these problems and return the corrected JSON:\n${feedback}`
      : basePrompt,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return { ok: false, error: "model returned malformed JSON" };
  }
  const slides = (parsed as { slides?: unknown })?.slides;
  if (!Array.isArray(slides) || slides.length === 0) {
    return { ok: false, error: 'model output is missing a non-empty "slides" array' };
  }
  // Stable ids (s1..sN) + the template are ours to inject, never the model's.
  // The model marks document images with fields.imageRef (the request's
  // [IMAGE:n] uploads); resolve each valid first-use ref to its real URL and
  // pop the marker either way. Refs that are malformed, unknown, or already
  // used are dropped silently, and any model-emitted "images" (hallucinated
  // URLs — the prompt forbids it) is discarded. fields.imagePrompt is
  // schema-legal and passes through untouched for the builder.
  const usedRefs = new Set<number>();
  const candidate = {
    templateId,
    slides: slides.map((s, i) => {
      const slide: Record<string, unknown> = {
        ...(typeof s === "object" && s !== null ? s : {}),
        id: `s${i + 1}`,
      };
      if (typeof slide.fields === "object" && slide.fields !== null) {
        const { imageRef, images: _modelImages, ...fields } = slide.fields as Record<
          string,
          unknown
        >;
        const ref = typeof imageRef === "number" ? imageRef : NaN;
        const url = imageByRef.get(ref);
        if (url !== undefined && !usedRefs.has(ref)) {
          usedRefs.add(ref);
          fields.images = [{ url }];
        }
        slide.fields = fields;
      }
      return slide;
    }),
  };
  const result = PptDeckSchema.safeParse(candidate);
  if (!result.success) {
    return { ok: false, error: JSON.stringify(result.error.issues).slice(0, 2000) };
  }
  return { ok: true, deck: result.data };
}

/**
 * Flow 2 (doc-driven drafting): paste a document (with optional [IMAGE:n]
 * markers + uploaded image URLs), get a draft deck back for the builder.
 * Validation failures get one retry with the errors fed back to the model; a
 * second failure is the model's problem, so it surfaces as 502.
 */
pptRoutes.post("/draft", async (c) => {
  const parsed = DraftSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { text, templateId, images } = parsed.data;

  const template = await loadTemplate(c, templateId);
  if (!template) return c.json({ error: "template not found" }, 404);

  const imageByRef = new Map<number, string>();
  for (const img of images ?? []) imageByRef.set(img.ref, img.url);

  const basePrompt = `Convert this document into a slide deck:\n\n${text}`;
  try {
    let attempt = await draftDeckOnce(c.env, basePrompt, templateId, imageByRef, null);
    if (!attempt.ok) {
      attempt = await draftDeckOnce(
        c.env,
        basePrompt,
        templateId,
        imageByRef,
        attempt.error,
      );
    }
    if (!attempt.ok) {
      return c.json({ error: `AI drafting failed: ${attempt.error}` }, 502);
    }
    return c.json({ deck: attempt.deck });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, msg.includes("not configured") ? 503 : 502);
  }
});
