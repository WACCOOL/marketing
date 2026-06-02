import { Hono } from "hono";
import { z } from "zod";
import * as XLSX from "xlsx";
import {
  DYNAMIC_QR_EXPORT_HEADERS,
  processBulkRow,
  toDynamicQrExportRow,
} from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";
import { createShortLink, shortLinkUrl } from "../shortlinks.js";
import { renderQr } from "../qr.js";
import { autoTags, createAsset } from "../assets.js";

export const bulkRoutes = new Hono<AppBindings>();

/**
 * Parse an uploaded .xlsx/.csv and return normalised rows for preview.
 * The SPA hands the parsed rows back to /bulk/generate-row one at a time.
 *
 * Why per-row: server-side QR rendering is CPU-heavy and the Workers FREE
 * plan caps each invocation at 10 ms CPU. One QR per request keeps us under
 * that, and gives the UI a smooth progress bar.
 */
const ParseSchema = z.object({
  /** base64-encoded xlsx/csv */
  data: z.string().min(1),
  filename: z.string().min(1),
});

bulkRoutes.post("/parse", requireAuth, async (c) => {
  const parsed = ParseSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const bytes = Uint8Array.from(atob(parsed.data.data), (ch) => ch.charCodeAt(0));
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]!];
  if (!sheet) return c.json({ error: "no sheets in workbook" }, 400);
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });

  // Normalise to our canonical row shape using forgiving header mapping.
  const out = rawRows.map((raw, idx) => {
    const norm: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const lc = k.trim().toLowerCase();
      switch (lc) {
        case "project":
          norm.project = v;
          break;
        case "qr code name":
        case "qr_code_name":
        case "qrname":
        case "qr name":
          norm.qrName = v;
          break;
        case "link":
        case "destination":
        case "url":
        case "destination url":
        case "website url":
          norm.link = v;
          break;
        case "utm_source":
        case "source":
          norm.source = v;
          break;
        case "utm_medium":
        case "medium":
          norm.medium = v;
          break;
        case "utm_campaign":
        case "campaign":
          norm.campaign = v;
          break;
        case "utm_content":
        case "content":
          norm.content = v;
          break;
      }
    }
    return processBulkRow(norm, idx);
  });

  return c.json({
    rows: out,
    okCount: out.filter((r) => r.ok).length,
    errorCount: out.filter((r) => !r.ok).length,
  });
});

const GenerateRowSchema = z.object({
  /** Parent batch asset id (created by /bulk/start) so child assets link up. */
  parentAssetId: z.string().uuid(),
  row: z.object({
    project: z.string().optional().default(""),
    qrName: z.string().min(1),
    link: z.string().url(),
    source: z.string().min(1),
    medium: z.string().min(1),
    campaign: z.string().min(1),
    content: z.string().optional().default(""),
  }),
  brand: z.string().optional(),
});

bulkRoutes.post("/start", requireAuth, async (c) => {
  const parsed = z
    .object({
      name: z.string().min(1),
      rowCount: z.number().int().nonnegative(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const sb = userSupabase(c.env, c.get("jwt"));
  const parent = await createAsset(
    c.env,
    sb,
    {
      ownerId: user.id,
      tool: "utm",
      name: `${parsed.data.name} (bulk)`,
      tags: autoTags({ tool: "utm", extra: ["batch:bulk"] }),
      metadata: { rowCount: parsed.data.rowCount },
    },
    [],
  );
  return c.json({ parentAssetId: parent.assetId });
});

bulkRoutes.post("/generate-row", requireAuth, async (c) => {
  const parsed = GenerateRowSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const sb = userSupabase(c.env, c.get("jwt"));

  const processed = processBulkRow(parsed.data.row, 0);
  if (!processed.ok || !processed.taggedUrl || !processed.row) {
    return c.json({ ok: false, errors: processed.errors });
  }

  const slRes = await createShortLink(c.env, sb, {
    destinationUrl: processed.taggedUrl,
    ownerId: user.id,
  });
  if (!slRes.ok) {
    return c.json({
      ok: false,
      errors: [
        "short link create failed: " +
          ("conflict" in slRes ? "conflict" : slRes.error),
      ],
    });
  }
  const shortUrl = shortLinkUrl(c.env, slRes.row.slug);
  const { svg, png } = await renderQr(shortUrl);

  const child = await createAsset(
    c.env,
    sb,
    {
      ownerId: user.id,
      tool: "qr",
      name: processed.row.qrName,
      parentAssetId: parsed.data.parentAssetId,
      tags: autoTags({
        tool: "qr",
        campaign: processed.row.campaign,
        source: processed.row.source,
        medium: processed.row.medium,
        content: processed.row.content,
        brand: parsed.data.brand,
        project: processed.row.project,
        extra: ["batch:bulk"],
      }),
      metadata: {
        qrName: processed.row.qrName,
        project: processed.row.project,
        destination: processed.row.link,
        taggedUrl: processed.taggedUrl,
        shortUrl,
        slug: slRes.row.slug,
      },
    },
    [
      { format: "svg", body: svg, contentType: "image/svg+xml" },
      { format: "png", body: png, contentType: "image/png" },
      { format: "url", body: processed.taggedUrl },
    ],
  );

  return c.json({
    ok: true,
    assetId: child.assetId,
    qrName: processed.row.qrName,
    slug: slRes.row.slug,
    shortUrl,
    taggedUrl: processed.taggedUrl,
  });
});

const ExportSchema = z.object({
  format: z.enum(["results", "dynamic-qr"]),
  rows: z.array(
    z.object({
      qrName: z.string(),
      project: z.string().optional().default(""),
      link: z.string().optional().default(""),
      taggedUrl: z.string().optional().default(""),
      shortUrl: z.string().optional().default(""),
      folder: z.string().optional().default(""),
    }),
  ),
});

bulkRoutes.post("/export", requireAuth, async (c) => {
  const parsed = ExportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const wb = XLSX.utils.book_new();

  if (parsed.data.format === "results") {
    const headers = [
      "PROJECT",
      "QR CODE NAME",
      "LINK",
      "TAGGED URL",
      "SHORT URL",
    ];
    const data = parsed.data.rows.map((r) => ({
      PROJECT: r.project ?? "",
      "QR CODE NAME": r.qrName,
      LINK: r.link ?? "",
      "TAGGED URL": r.taggedUrl ?? "",
      "SHORT URL": r.shortUrl ?? "",
    }));
    const ws = XLSX.utils.json_to_sheet(data, { header: headers });
    XLSX.utils.book_append_sheet(wb, ws, "Results");
  } else {
    // Dynamic-QR platform import template — uses the SHORT URL as the website
    // so the existing platform can be loaded in parallel during migration.
    const exportRows = parsed.data.rows.map((r) =>
      toDynamicQrExportRow({
        qrName: r.qrName,
        shortLink: r.shortUrl || r.taggedUrl,
        folder: r.folder,
      }),
    );
    const data = exportRows.map((r) => ({
      "QR Name (mandatory)": r.qrName,
      "Website URL": r.websiteUrl,
      "Add to Watchlist": r.addToWatchlist,
      Folder: r.folder,
    }));
    const ws = XLSX.utils.json_to_sheet(data, {
      header: [...DYNAMIC_QR_EXPORT_HEADERS],
    });
    XLSX.utils.book_append_sheet(wb, ws, "Import");
  }

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Response(buf, {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="bulk-${parsed.data.format}-${Date.now()}.xlsx"`,
    },
  });
});
