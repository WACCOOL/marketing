import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PptDeckSchema, PPT_GENERATED_BY, type PptDeck } from "@wac/shared";
import { fetchImageBuffer, readWithCap } from "./fetchImage.js";
import type { GenerateRequest, GenerationResult, GeneratedFile } from "./server.js";

/**
 * PPT Generator engine (PRD §8). Fills an admin-uploaded .pptx template from a
 * structured deck (PptDeckSchema): python-pptx (python/build_deck.py) does the
 * placeholder filling so fonts/colors/layouts always come from the template,
 * LibreOffice headless converts to PDF, and poppler renders a PNG thumbnail.
 * On dev hosts without LibreOffice/poppler the PDF/thumbnail steps degrade to
 * warnings — the .pptx itself always ships.
 */

export interface PptDeps {
  sb: SupabaseClient;
  s3: S3Client;
  bucket: string;
}

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Slide images are normalized (and capped) before they go into the deck so a
// 12000px hero shot can't balloon the .pptx.
const MAX_IMAGE_EDGE = 3000;

// Slide videos are embedded as-is (no transcode in the container); the cap and
// timeout bound what one deck can pull in. Mirrors fetchImage.ts's URL guards.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 60_000;
// Accepted video content-types -> tmp-file extension (quicktime ships fine in
// an .mp4-named part; python-pptx embeds bytes + the declared mimeType).
const VIDEO_CONTENT_TYPES = new Map<string, "mp4" | "webm">([
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["video/quicktime", "mp4"],
]);

const BUILD_TIMEOUT_MS = 60_000;
const SOFFICE_TIMEOUT_MS = 120_000;
const INTROSPECT_TIMEOUT_MS = 30_000;
// How much trailing stderr to fold into a thrown error.
const STDERR_TAIL_CHARS = 2000;

// ---------------------------------------------------------------------------
// Subprocess + filesystem helpers
// ---------------------------------------------------------------------------

interface RunOptions {
  timeoutMs: number;
  /** Written to the child's stdin, then closed. */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Spawn detached and kill the whole process group on timeout. LibreOffice
   * forks helpers that a plain child.kill() would orphan.
   */
  killGroup?: boolean;
}

interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a command, capture stdout/stderr, and hard-kill on timeout. Rejects
 * on spawn errors (notably ENOENT, which callers use to detect a missing
 * binary on dev hosts). */
function runCommand(
  cmd: string,
  args: string[],
  opts: RunOptions,
): Promise<RunOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      detached: opts.killGroup === true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (opts.killGroup && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    // A child that exits before reading all of stdin emits EPIPE here; the
    // close handler still reports the real outcome.
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.end(opts.stdin ?? "");
  });
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

function stderrTail(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > STDERR_TAIL_CHARS
    ? trimmed.slice(-STDERR_TAIL_CHARS)
    : trimmed;
}

/**
 * Directory holding the python-pptx scripts. PPT_SCRIPTS_DIR (default
 * /app/python — the Container image's WORKDIR is /app) wins; when that doesn't
 * exist we're on a dev host running dist/server.js, so fall back to
 * apps/generator/python relative to this module.
 */
async function resolveScriptsDir(): Promise<string> {
  const configured = process.env.PPT_SCRIPTS_DIR || "/app/python";
  try {
    if ((await fs.stat(configured)).isDirectory()) return configured;
  } catch {
    // fall through to the dev path
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../python");
}

/** Parse a python script's single-JSON-object stdout contract. */
function parseScriptJson(
  script: string,
  out: RunOutput,
): Record<string, unknown> {
  if (out.timedOut) {
    throw new Error(`${script} timed out; stderr: ${stderrTail(out.stderr)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    throw new Error(
      `${script} exited ${out.code} without valid JSON; stderr: ${stderrTail(out.stderr)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (out.code !== 0 || obj.ok !== true) {
    const err = obj.error as { code?: string; message?: string } | undefined;
    throw new Error(
      `${script} failed: ${err?.message ?? "unknown error"}` +
        (out.stderr.trim() ? `; stderr: ${stderrTail(out.stderr)}` : ""),
    );
  }
  return obj;
}

async function downloadFromR2(
  s3: S3Client,
  bucket: string,
  key: string,
  destPath: string,
): Promise<void> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) throw new Error(`R2 object has no body: ${key}`);
  const bytes = await out.Body.transformToByteArray();
  await fs.writeFile(destPath, Buffer.from(bytes));
}

// ---------------------------------------------------------------------------
// Deck assembly
// ---------------------------------------------------------------------------

interface SpecImage {
  path: string;
  width: number;
  height: number;
  caption?: string;
}

interface SpecVideo {
  path: string;
  mimeType: string;
  caption?: string;
}

interface FetchedVideo {
  buffer: Buffer;
  mimeType: string;
  ext: "mp4" | "webm";
}

/**
 * Video fetch with the same URL guards as fetchImageBuffer: https-only, an
 * allowed content-type (mp4/webm/quicktime), a byte cap, and a timeout. No
 * decode/transcode — python-pptx embeds the bytes verbatim.
 */
export async function fetchVideoBuffer(url: string): Promise<FetchedVideo> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid video URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`video URL must use https (got ${parsed.protocol}): ${url}`);
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
    headers: { accept: "video/*" },
  });
  if (!res.ok) {
    throw new Error(`fetch failed ${res.status} ${res.statusText}: ${url}`);
  }

  const rawType = (res.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (rawType && !VIDEO_CONTENT_TYPES.has(rawType)) {
    throw new Error(
      `URL did not return a supported video (content-type: ${rawType}; ` +
        `allowed: ${[...VIDEO_CONTENT_TYPES.keys()].join(", ")}): ${url}`,
    );
  }
  const mimeType = rawType || "video/mp4";
  const lenHeader = res.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > MAX_VIDEO_BYTES) {
    throw new Error(`video exceeds maxBytes (${MAX_VIDEO_BYTES}): ${url}`);
  }

  const buffer = await readWithCap(res, MAX_VIDEO_BYTES, url, "video");
  return { buffer, mimeType, ext: VIDEO_CONTENT_TYPES.get(mimeType) ?? "mp4" };
}

/**
 * Fetch every slide image/video through the shared URL guards and write it
 * into the job tmpdir. Images are normalized via sharp (PNG when they carry
 * alpha, JPEG otherwise; long edge capped); videos are embedded byte-for-byte.
 * Returns the deck's slides with images rewritten to local {path, width,
 * height, caption} and video to local {path, mimeType, caption} for the
 * python build spec. AI-drafting leftovers (fields.imagePrompt and each
 * image's `prompt`) are dropped here — they're builder plumbing, not content.
 */
async function localizeMedia(
  deck: PptDeck,
  tmp: string,
): Promise<{ id: string; layout: string; fields: Record<string, unknown> }[]> {
  let imageN = 0;
  let videoN = 0;
  const slides = [];
  for (const slide of deck.slides) {
    const fields: Record<string, unknown> = { ...slide.fields };
    delete fields.imagePrompt;
    if (slide.fields.images && slide.fields.images.length > 0) {
      const localized: SpecImage[] = [];
      for (const image of slide.fields.images) {
        const fetched = await fetchImageBuffer(image.url);
        const pipeline = sharp(fetched.buffer).resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, {
          fit: "inside",
          withoutEnlargement: true,
        });
        const { data, info } = fetched.hasAlpha
          ? await pipeline.png().toBuffer({ resolveWithObject: true })
          : await pipeline.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
        const file = path.join(tmp, `img-${imageN++}.${fetched.hasAlpha ? "png" : "jpg"}`);
        await fs.writeFile(file, data);
        localized.push({
          path: file,
          width: info.width,
          height: info.height,
          ...(image.caption ? { caption: image.caption } : {}),
        });
      }
      fields.images = localized;
    }
    if (slide.fields.video) {
      const video = slide.fields.video;
      const fetched = await fetchVideoBuffer(video.url);
      const file = path.join(tmp, `video-${videoN++}.${fetched.ext}`);
      await fs.writeFile(file, fetched.buffer);
      const localized: SpecVideo = {
        path: file,
        mimeType: fetched.mimeType,
        ...(video.caption ? { caption: video.caption } : {}),
      };
      fields.video = localized;
    }
    slides.push({ id: slide.id, layout: slide.layout, fields });
  }
  return slides;
}

interface PptTemplateRow {
  r2_key: string;
  version: number;
  layout_map: Record<string, string> | null;
}

/**
 * Build a deck from an admin template (the `ppt` tool's async job path).
 * Returns the server's GenerationResult: always the .pptx, plus the PDF and
 * PNG thumbnail when LibreOffice/poppler are available.
 */
export async function runPptGenerator(
  req: GenerateRequest,
  deps: PptDeps,
): Promise<GenerationResult> {
  const parsed = PptDeckSchema.safeParse(req.params);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid ppt deck params: ${detail}`);
  }
  const deck = parsed.data;
  // replaceAssetId is job plumbing (overwrite-on-edit), not deck content: keep
  // it out of the build spec and the stored metadata.deck, and surface it on
  // the result so the server updates the existing asset instead of creating
  // a new one.
  const { replaceAssetId, ...deckContent } = deck;

  const { data, error } = await deps.sb
    .from("ppt_templates")
    .select("r2_key, version, layout_map")
    .eq("id", deck.templateId)
    .maybeSingle();
  if (error) throw new Error(`ppt template lookup failed: ${error.message}`);
  if (!data) throw new Error(`template not found: ${deck.templateId}`);
  const row = data as PptTemplateRow;

  // Fail fast on unmapped layouts so the job error names the fix instead of a
  // python traceback naming a missing layout.
  const layoutMap = row.layout_map ?? {};
  const missing = [...new Set(deck.slides.map((s) => s.layout))].filter(
    (layout) => !layoutMap[layout],
  );
  if (missing.length > 0) {
    throw new Error(
      `template has no mapping for layout(s): ${missing.join(", ")} — map them in PPT Templates admin`,
    );
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wac-ppt-"));
  try {
    const templatePath = path.join(tmp, "template.pptx");
    await downloadFromR2(deps.s3, deps.bucket, row.r2_key, templatePath);

    const outPath = path.join(tmp, "deck.pptx");
    const spec = {
      templatePath,
      layoutMap,
      outPath,
      slides: await localizeMedia(deck, tmp),
    };

    const scriptsDir = await resolveScriptsDir();
    const built = parseScriptJson(
      "build_deck.py",
      await runCommand("python3", [path.join(scriptsDir, "build_deck.py")], {
        timeoutMs: BUILD_TIMEOUT_MS,
        stdin: JSON.stringify(spec),
      }),
    );
    const warnings: string[] = Array.isArray(built.warnings)
      ? built.warnings.filter((w): w is string => typeof w === "string")
      : [];

    const files: GeneratedFile[] = [
      {
        format: "pptx",
        body: await fs.readFile(outPath),
        contentType: PPTX_CONTENT_TYPE,
      },
    ];

    // PDF via LibreOffice headless. An isolated profile under /tmp keeps
    // concurrent conversions (and a read-only container HOME) from wedging it.
    const pdfPath = path.join(tmp, "deck.pdf");
    let havePdf = false;
    try {
      const profile = `lo-profile-${req.jobId.replace(/[^a-zA-Z0-9-]/g, "")}`;
      const out = await runCommand(
        "soffice",
        [
          "--headless",
          "--norestore",
          "--nolockcheck",
          `-env:UserInstallation=file:///tmp/${profile}`,
          "--convert-to",
          "pdf",
          "--outdir",
          tmp,
          outPath,
        ],
        {
          timeoutMs: SOFFICE_TIMEOUT_MS,
          env: { ...process.env, HOME: "/tmp" },
          killGroup: true,
        },
      );
      if (out.timedOut) {
        throw new Error(`PDF conversion timed out; stderr: ${stderrTail(out.stderr)}`);
      }
      havePdf = await fs.stat(pdfPath).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!havePdf) {
        throw new Error(
          `LibreOffice produced no PDF (exit ${out.code}); stderr: ${stderrTail(out.stderr)}`,
        );
      }
      files.push({
        format: "pdf",
        body: await fs.readFile(pdfPath),
        contentType: "application/pdf",
      });
    } catch (e) {
      // Dev hosts without LibreOffice still get a valid .pptx.
      if (!isEnoent(e)) throw e;
      warnings.push("PDF export skipped: LibreOffice not available");
    }

    // PNG thumbnail of page 1 via poppler. Cosmetic — never fails the job.
    if (havePdf) {
      try {
        const out = await runCommand(
          "pdftoppm",
          ["-png", "-f", "1", "-l", "1", "-scale-to", "800", pdfPath, path.join(tmp, "thumb")],
          { timeoutMs: INTROSPECT_TIMEOUT_MS },
        );
        // pdftoppm names its output thumb-1.png / thumb-01.png depending on
        // the page-count padding, so find it rather than guess.
        const thumb = (await fs.readdir(tmp)).find(
          (f) => f.startsWith("thumb") && f.endsWith(".png"),
        );
        if (out.code === 0 && !out.timedOut && thumb) {
          files.push({
            format: "png",
            body: await fs.readFile(path.join(tmp, thumb)),
            contentType: "image/png",
          });
        } else {
          warnings.push(`thumbnail skipped: pdftoppm failed (exit ${out.code})`);
        }
      } catch (e) {
        if (!isEnoent(e)) throw e;
        warnings.push("thumbnail skipped: poppler not available");
      }
    }

    return {
      files,
      metadata: {
        deck: deckContent,
        templateId: deck.templateId,
        templateVersion: row.version,
        warnings,
        generatedBy: PPT_GENERATED_BY,
      },
      ...(replaceAssetId ? { replaceAssetId } : {}),
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Template introspection (sync /ppt-introspect route)
// ---------------------------------------------------------------------------

/**
 * Download a template from R2 and run python/introspect.py over it. Returns
 * the script's JSON contract ({ok, slideWidthEmu, slideHeightEmu, layouts,
 * suggestedMap} | {ok: false, error}); throws only on transport-level failures
 * (R2 download, missing python3, no JSON on stdout).
 */
export async function introspectPptTemplate(
  r2Key: string,
  deps: Pick<PptDeps, "s3" | "bucket">,
): Promise<Record<string, unknown>> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wac-ppt-introspect-"));
  try {
    const templatePath = path.join(tmp, "template.pptx");
    await downloadFromR2(deps.s3, deps.bucket, r2Key, templatePath);

    const scriptsDir = await resolveScriptsDir();
    const out = await runCommand(
      "python3",
      [path.join(scriptsDir, "introspect.py"), templatePath],
      { timeoutMs: INTROSPECT_TIMEOUT_MS },
    );
    if (out.timedOut) {
      throw new Error(`introspect.py timed out; stderr: ${stderrTail(out.stderr)}`);
    }
    try {
      // Relay the script's JSON verbatim — including its {ok:false, error}
      // shape — so the admin UI sees one contract.
      return JSON.parse(out.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(
        `introspect.py exited ${out.code} without valid JSON; stderr: ${stderrTail(out.stderr)}`,
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
