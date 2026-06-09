import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  type S3ServiceException,
} from "@aws-sdk/client-s3";
import { normalizeFixtureKey, type FixtureMount } from "@wac/shared";

/**
 * Offline picker-thumbnail baker.
 *
 * Renders each fixture's GLB to a small PNG once, in a headless browser, and
 * stores it at `appshot/thumb/{key}.png` — the exact key the web picker serves
 * via `fixtureThumbUrl()`. This moves the 3D form preview OFF the page (the old
 * per-tile WebGL didn't scale past the browser's ~16 live-context cap) to a
 * cheap pre-baked <img>.
 *
 * Cheap to run: the GLB is the lightweight Blender *geometry* export (cached per
 * fixture in R2), and the GLB→PNG step is a single offscreen WebGL frame via the
 * web app's real `FixtureScene` (reused through the `dist-harness` build), so the
 * baked still matches the editor's framing exactly — no Cycles render.
 */

const THUMB_PREFIX = "appshot/thumb";
const GLB_PREFIX = "appshot/glb";
/** Square px size for the baked thumbnail. */
const THUMB_PX = 256;

export interface BakeFixture {
  /** Registry fixture_key (one per .blend); also the thumb/GLB cache key. */
  fixtureKey: string;
  /** Mount used to pick the default camera pose. */
  mount: FixtureMount;
}

export interface BakeDeps {
  s3: S3Client;
  bucket: string;
  /** Deployed API origin, e.g. https://marketing.gowac.cc (no trailing slash). */
  apiBaseUrl: string;
  /** ADMIN_API_TOKEN — authorizes the headless GLB-export trigger. */
  adminToken: string;
  concurrency: number;
}

export interface BakeStats {
  baked: number;
  skipped: number;
  failed: number;
}

/** Run an async worker over items with a bounded concurrency pool. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const n = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (cursor < items.length) {
        await worker(items[cursor++]!);
      }
    }),
  );
}

function isNotFound(e: unknown): boolean {
  const name = (e as S3ServiceException)?.name;
  return name === "NotFound" || name === "NoSuchKey";
}

async function r2Exists(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

async function r2GetBytes(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = out.Body as
      | { transformToByteArray(): Promise<Uint8Array> }
      | undefined;
    if (!body?.transformToByteArray) return null;
    return await body.transformToByteArray();
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/**
 * Get the fixture's GLB bytes — from R2 if already exported, else trigger the
 * (cached) Blender export via the admin API and read it back.
 */
async function ensureGlb(
  deps: BakeDeps,
  fixtureKey: string,
): Promise<Uint8Array | null> {
  const key = `${GLB_PREFIX}/${normalizeFixtureKey(fixtureKey)}.glb`;
  const cached = await r2GetBytes(deps.s3, deps.bucket, key);
  if (cached && cached.byteLength > 0) return cached;

  const res = await fetch(`${deps.apiBaseUrl}/api/appshot/glb`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${deps.adminToken}`,
    },
    body: JSON.stringify({ sku: fixtureKey }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`glb export failed (${res.status}): ${detail}`);
  }
  // The export wrote the GLB to R2; read it back.
  return await r2GetBytes(deps.s3, deps.bucket, key);
}

/** Repo root, from this file's location (dist/index.js or src/ under tsx). */
function workspaceRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..", "..");
}

/** Load the single-file render harness, building it on demand if missing. */
async function loadHarnessHtml(): Promise<string> {
  const root = workspaceRoot();
  const htmlPath =
    process.env.WAC_HARNESS_HTML ??
    path.join(root, "apps", "web", "dist-harness", "thumb-harness.html");
  if (!existsSync(htmlPath)) {
    console.log(
      "[bake] harness not built — running `pnpm --filter @wac/web build:harness`…",
    );
    const r = spawnSync("pnpm", ["--filter", "@wac/web", "build:harness"], {
      cwd: root,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      throw new Error(
        "failed to build the thumbnail harness — run `pnpm --filter @wac/web build:harness` manually",
      );
    }
  }
  if (!existsSync(htmlPath)) {
    throw new Error(`harness HTML not found at ${htmlPath}`);
  }
  return await readFile(htmlPath, "utf8");
}

/** Render one fixture's GLB to a PNG in the harness page and store it in R2. */
async function bakeOne(
  deps: BakeDeps,
  // playwright Page — typed loosely to avoid a hard type dep at module scope.
  page: { evaluate: <R, A>(fn: (a: A) => R | Promise<R>, arg: A) => Promise<R> },
  fx: BakeFixture,
): Promise<void> {
  const glb = await ensureGlb(deps, fx.fixtureKey);
  if (!glb || glb.byteLength === 0) throw new Error("no GLB available");

  const dataUrl = await page.evaluate(
    async (args: { b64: string; mount: string; size: number }) => {
      const g = globalThis as Record<string, unknown>;
      const render = g.renderFixtureThumb as
        | ((b64: string, mount: string, size: number) => Promise<string>)
        | undefined;
      if (!render) throw new Error("harness render fn missing");
      return render(args.b64, args.mount, args.size);
    },
    { b64: Buffer.from(glb).toString("base64"), mount: fx.mount, size: THUMB_PX },
  );

  const pngB64 = dataUrl.split(",", 2)[1];
  if (!pngB64) throw new Error("render returned no image data");
  const key = `${THUMB_PREFIX}/${normalizeFixtureKey(fx.fixtureKey)}.png`;
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.bucket,
      Key: key,
      Body: Buffer.from(pngB64, "base64"),
      ContentType: "image/png",
    }),
  );
}

/**
 * Bake picker thumbnails for the given fixtures. Idempotent: any fixture that
 * already has a thumbnail in R2 is skipped, so re-runs are cheap and only the
 * gaps are filled. A fixture whose GLB export or render fails is logged and
 * left without a thumbnail (the picker shows its placeholder) — it never blocks
 * the others.
 */
export async function bakeThumbnails(
  deps: BakeDeps,
  fixtures: BakeFixture[],
): Promise<BakeStats> {
  const stats: BakeStats = { baked: 0, skipped: 0, failed: 0 };

  // Cheap HEADs first so we don't spin up a browser when nothing needs baking.
  const missing: BakeFixture[] = [];
  await runPool(fixtures, Math.max(8, deps.concurrency), async (fx) => {
    const key = `${THUMB_PREFIX}/${normalizeFixtureKey(fx.fixtureKey)}.png`;
    if (await r2Exists(deps.s3, deps.bucket, key)) stats.skipped++;
    else missing.push(fx);
  });
  console.log(
    `[bake] ${stats.skipped} already have a thumbnail, ${missing.length} to bake`,
  );
  if (missing.length === 0) return stats;

  const html = await loadHarnessHtml();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const pageCount = Math.min(Math.max(1, deps.concurrency), missing.length, 4);
    const pages = await Promise.all(
      Array.from({ length: pageCount }, async () => {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "load" });
        await page.waitForFunction(
          () =>
            (globalThis as Record<string, unknown>).__thumbHarnessReady === true,
          undefined,
          { timeout: 60_000 },
        );
        return page;
      }),
    );

    let cursor = 0;
    await Promise.all(
      pages.map(async (page) => {
        while (cursor < missing.length) {
          const fx = missing[cursor++]!;
          try {
            await bakeOne(deps, page, fx);
            stats.baked++;
            console.log(`  baked  ${fx.fixtureKey}`);
          } catch (e) {
            stats.failed++;
            console.error(`  FAIL   ${fx.fixtureKey}: ${(e as Error).message}`);
          }
        }
      }),
    );
  } finally {
    await browser.close();
  }
  return stats;
}
