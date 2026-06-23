import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { zipSync } from "fflate";
import {
  encodeCampaignValue,
  parseTaggedUrl,
  type HubspotCampaign,
} from "@wac/shared";
import { api, apiBlob } from "../lib/api.js";
import { useVocab } from "../lib/vocab.js";

const QR_OPTS = {
  errorCorrectionLevel: "H" as const,
  margin: 1,
  color: { dark: "#000000", light: "#ffffff" },
};

/** Render a QR for `data` as an SVG string (client-side, no network/auth). */
async function qrSvg(data: string): Promise<string> {
  return QRCode.toString(data, { type: "svg", ...QR_OPTS });
}

/** Render a QR for `data` as PNG bytes (client-side, via a data URL). */
async function qrPngBytes(data: string): Promise<Uint8Array<ArrayBuffer>> {
  const dataUrl = await QRCode.toDataURL(data, {
    type: "image/png",
    width: 512,
    ...QR_OPTS,
  });
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(s: string): string {
  const cleaned = s
    .replace(/[\/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "qr";
}

interface ServerRow {
  id: string;
  slug: string;
  destination_url: string;
  owner_id: string;
  owner_email: string | null;
  scan_count: number;
  created_at: string;
  updated_at: string;
  shortUrl: string;
  assetId: string | null;
  name: string | null;
  project: string | null;
  formats: string[];
}

/** Row hydrated with the UTM fields parsed off the tagged destination URL. */
interface ViewRow extends ServerRow {
  destination: string; // base URL with utm_* stripped
  source: string;
  medium: string;
  campaign: string;
  content: string;
}

interface EditDraft {
  name: string;
  project: string;
  destination: string;
  source: string;
  medium: string;
  campaign: string; // encoded HubSpot value
  content: string;
}

/**
 * Bulk-edit draft. A field is applied to every selected row as soon as it has
 * a value — no separate "enable this field" checkbox. Empty string means "leave
 * as-is". `content` additionally supports an explicit clear sentinel.
 */
interface BulkDraft {
  name: string;
  project: string;
  destination: string;
  source: string;
  medium: string;
  campaign: string;
  content: string;
}

const emptyBulkDraft: BulkDraft = {
  name: "",
  project: "",
  destination: "",
  source: "",
  medium: "",
  campaign: "",
  content: "",
};

// Sentinel for the bulk "clear content" choice (distinct from "" = no change).
const CLEAR_CONTENT = "\u0000clear";

const FILTER_KEYS = [
  "name",
  "project",
  "destination",
  "campaign",
  "source",
  "medium",
  "content",
  "slug",
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type ColFilters = Record<FilterKey, string>;
const emptyFilters: ColFilters = {
  name: "",
  project: "",
  destination: "",
  campaign: "",
  source: "",
  medium: "",
  content: "",
  slug: "",
};

export function UtmQr() {
  const { vocab, campaigns, err: vocabErr } = useVocab();

  const [serverRows, setServerRows] = useState<ServerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDraft, setBulkDraft] = useState<BulkDraft>(emptyBulkDraft);

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<ColFilters>(emptyFilters);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await api<{ shortLinks: ServerRow[] }>("/api/short-links");
      setServerRows(res.shortLinks);
      // Drop selections that no longer exist after a delete/refresh.
      setSelected((prev) => {
        const live = new Set(res.shortLinks.map((r) => r.slug));
        const next = new Set<string>();
        for (const s of prev) if (live.has(s)) next.add(s);
        return next;
      });
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  // Hydrate each row with parsed UTM fields. The tagged `destination_url` is
  // the source of truth — it round-trips through buildTaggedUrl on every save,
  // so this view always shows the actual values that get sent to analytics.
  const rows: ViewRow[] = useMemo(
    () =>
      serverRows.map((r) => {
        const parsed = parseTaggedUrl(r.destination_url);
        return {
          ...r,
          destination: parsed.destination,
          source: parsed.source ?? "",
          medium: parsed.medium ?? "",
          campaign: parsed.campaign ?? "",
          content: parsed.content ?? "",
        };
      }),
    [serverRows],
  );

  const campaignByValue = useMemo(() => {
    const m = new Map<string, HubspotCampaign>();
    for (const c of campaigns) m.set(encodeCampaignValue(c), c);
    return m;
  }, [campaigns]);

  // Render the encoded campaign value as the human-readable HubSpot name when
  // we recognise it; fall back to the raw encoded value otherwise so legacy /
  // hand-crafted links still display something useful.
  function campaignLabel(encoded: string): string {
    if (!encoded) return "";
    return campaignByValue.get(encoded)?.name ?? encoded;
  }

  // Distinct values present in the loaded rows for each column, used to power
  // the column-filter dropdowns. Sorted alphabetically.
  const colOptions = useMemo(() => {
    const dedupe = (vals: Iterable<string>) =>
      [...new Set([...vals].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return {
      project: dedupe(rows.map((r) => r.project ?? "")),
      campaign: dedupe(rows.map((r) => r.campaign)),
      source: dedupe(rows.map((r) => r.source)),
      medium: dedupe(rows.map((r) => r.medium)),
      content: dedupe(rows.map((r) => r.content)),
    };
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      // Per-column filters: substring-match each non-empty filter against the
      // matching column value.
      for (const key of FILTER_KEYS) {
        const f = filters[key].trim().toLowerCase();
        if (!f) continue;
        let v = "";
        switch (key) {
          case "name":
            v = (r.name ?? "").toLowerCase();
            break;
          case "project":
            v = (r.project ?? "").toLowerCase();
            break;
          case "destination":
            v = r.destination.toLowerCase();
            break;
          case "campaign":
            v = (
              r.campaign +
              " " +
              campaignLabel(r.campaign)
            ).toLowerCase();
            break;
          case "source":
            v = r.source.toLowerCase();
            break;
          case "medium":
            v = r.medium.toLowerCase();
            break;
          case "content":
            v = r.content.toLowerCase();
            break;
          case "slug":
            v = r.slug.toLowerCase();
            break;
        }
        if (!v.includes(f)) return false;
      }

      // Global search: every column AND the full tagged URL (every utm_* param
      // is in there verbatim, so e.g. searching `utm_content=aia` works).
      if (q) {
        const haystack = [
          r.name ?? "",
          r.project ?? "",
          r.destination,
          r.destination_url,
          r.shortUrl,
          r.slug,
          r.campaign,
          campaignLabel(r.campaign),
          r.source,
          r.medium,
          r.content,
        ]
          .join(" \u0001 ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });
  }, [rows, filters, search, campaignByValue]);

  function clearFilters() {
    setFilters(emptyFilters);
    setSearch("");
  }

  function toggleSelected(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }
  function toggleSelectAllVisible() {
    setSelected((prev) => {
      const visibleSlugs = filteredRows.map((r) => r.slug);
      const allSelected =
        visibleSlugs.length > 0 &&
        visibleSlugs.every((s) => prev.has(s));
      const next = new Set(prev);
      if (allSelected) {
        for (const s of visibleSlugs) next.delete(s);
      } else {
        for (const s of visibleSlugs) next.add(s);
      }
      return next;
    });
  }
  const allVisibleSelected =
    filteredRows.length > 0 &&
    filteredRows.every((r) => selected.has(r.slug));

  function startEdit(r: ViewRow) {
    setEditingSlug(r.slug);
    setEditDraft({
      name: r.name ?? "",
      project: r.project ?? "",
      destination: r.destination,
      source: r.source,
      medium: r.medium,
      campaign: r.campaign,
      content: r.content,
    });
  }
  function cancelEdit() {
    setEditingSlug(null);
    setEditDraft(null);
  }

  async function saveEdit() {
    if (!editingSlug || !editDraft) return;
    const original = rows.find((r) => r.slug === editingSlug);
    if (!original) return;

    // Diff against the original row so unchanged columns are omitted from the
    // patch — keeps server-side validation surface area minimal and means
    // bulk-edit and inline-edit go through the exact same code path.
    const patch: Record<string, unknown> = {};
    if (editDraft.name !== (original.name ?? ""))
      patch.name = editDraft.name;
    if (editDraft.project !== (original.project ?? ""))
      patch.project = editDraft.project === "" ? null : editDraft.project;
    if (editDraft.destination !== original.destination)
      patch.destination = editDraft.destination;

    const fields: Record<string, unknown> = {};
    if (editDraft.source !== original.source) fields.source = editDraft.source;
    if (editDraft.medium !== original.medium) fields.medium = editDraft.medium;
    if (editDraft.campaign !== original.campaign)
      fields.campaign = editDraft.campaign;
    if (editDraft.content !== original.content)
      fields.content = editDraft.content === "" ? null : editDraft.content;
    if (Object.keys(fields).length > 0) patch.fields = fields;

    if (Object.keys(patch).length === 0) {
      cancelEdit();
      return;
    }

    setBusy(true);
    setErr(null);
    try {
      await api(`/api/short-links/${encodeURIComponent(editingSlug)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      cancelEdit();
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  function buildBulkPatch(d: BulkDraft): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (d.name) patch.name = d.name;
    if (d.project) patch.project = d.project;
    if (d.destination) patch.destination = d.destination;
    const fields: Record<string, unknown> = {};
    if (d.source) fields.source = d.source;
    if (d.medium) fields.medium = d.medium;
    if (d.campaign) fields.campaign = d.campaign;
    if (d.content === CLEAR_CONTENT) fields.content = null;
    else if (d.content) fields.content = d.content;
    if (Object.keys(fields).length > 0) patch.fields = fields;
    return patch;
  }

  async function applyBulkEdit() {
    if (selected.size === 0) return;
    const patch = buildBulkPatch(bulkDraft);
    if (Object.keys(patch).length === 0) {
      setErr("Set at least one field to apply.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{
        okCount: number;
        errorCount: number;
        results: { slug: string; ok: boolean; error?: string }[];
      }>("/api/short-links/bulk", {
        method: "POST",
        body: JSON.stringify({ slugs: [...selected], patch }),
      });
      if (res.errorCount > 0) {
        const firstErr = res.results.find((r) => !r.ok);
        setErr(
          `${res.errorCount} of ${selected.size} failed${firstErr ? `: ${firstErr.slug} — ${firstErr.error ?? "unknown"}` : ""}`,
        );
      }
      setBulkOpen(false);
      setBulkDraft(emptyBulkDraft);
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    const n = selected.size;
    if (
      !confirm(
        `Delete ${n} short link${n === 1 ? "" : "s"} and ${n === 1 ? "its" : "their"} saved QR asset${n === 1 ? "" : "s"}? Already-printed QR codes pointing to ${n === 1 ? "it" : "them"} will stop working.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{
        okCount: number;
        errorCount: number;
        results: { slug: string; ok: boolean; error?: string }[];
      }>("/api/short-links/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ slugs: [...selected] }),
      });
      if (res.errorCount > 0) {
        const firstErr = res.results.find((r) => !r.ok);
        setErr(
          `${res.errorCount} of ${n} failed${firstErr ? `: ${firstErr.slug} — ${firstErr.error ?? "unknown"}` : ""}`,
        );
      }
      setSelected(new Set());
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function exportSelected(kind: "xlsx" | "svg" | "png") {
    if (selected.size === 0) return;
    setBusy(true);
    setErr(null);
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      if (kind === "xlsx") {
        // Excel is data-only, so the server builds it (no QR rendering needed).
        const blob = await apiBlob("/api/short-links/export-xlsx", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slugs: [...selected] }),
        });
        saveBlob(blob, `utm-qr-${stamp}.xlsx`);
        return;
      }

      // SVG / PNG: generate the QR for every selected row's short URL client-
      // side and bundle into one zip. Every row gets a file regardless of
      // whether a saved asset exists.
      const chosen = rows.filter((r) => selected.has(r.slug));
      const files: Record<string, Uint8Array> = {};
      const used = new Set<string>();
      const enc = new TextEncoder();
      for (const r of chosen) {
        const base = sanitizeFilename(r.name || r.slug);
        let filename = `${base}.${kind}`;
        let n = 2;
        while (used.has(filename)) filename = `${base}-${n++}.${kind}`;
        used.add(filename);
        files[filename] =
          kind === "svg"
            ? enc.encode(await qrSvg(r.shortUrl))
            : await qrPngBytes(r.shortUrl);
      }
      const zipped = zipSync(files, { level: 6 });
      saveBlob(
        new Blob([new Uint8Array(zipped)], { type: "application/zip" }),
        `utm-qr-${kind}-${stamp}.zip`,
      );
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyShortUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API can fail on insecure origins / sandboxed iframes; fall
      // back to a textarea trick so users still get the copy.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* swallow */
      }
      ta.remove();
    }
  }

  async function downloadQr(
    shortUrl: string,
    format: "svg" | "png",
    name: string,
  ) {
    setErr(null);
    try {
      const filename = `${sanitizeFilename(name)}.${format}`;
      if (format === "svg") {
        const svg = await qrSvg(shortUrl);
        saveBlob(
          new Blob([svg], { type: "image/svg+xml" }),
          filename,
        );
      } else {
        const bytes = await qrPngBytes(shortUrl);
        saveBlob(new Blob([bytes], { type: "image/png" }), filename);
      }
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  const hasSelection = selected.size > 0;

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>UTM &amp; QR</h2>
        <div className="muted">
          Every editable short link + saved QR. Inline-edit any column;
          select multiple rows to bulk-edit or delete. The QR encodes the short
          link, so changing UTM fields here updates analytics on every existing
          printed code without reprinting.
        </div>
      </div>

      {vocabErr && (
        <div className="alert error">Vocab load failed: {vocabErr}</div>
      )}
      {err && <div className="alert error">{err}</div>}

      <div
        className="card col"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          boxShadow: "0 6px 16px rgba(0,0,0,0.35)",
        }}
      >
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Search every column + the full tagged URL…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 260 }}
          />
          <button
            className="secondary"
            onClick={clearFilters}
            disabled={
              !search && Object.values(filters).every((v) => v === "")
            }
          >
            Clear filters
          </button>
          <button
            className="secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? <span className="spinner" /> : null}
            Refresh
          </button>
        </div>

        {hasSelection && (
          <div
            className="row"
            style={{
              gap: 8,
              flexWrap: "wrap",
              borderTop: "1px solid var(--border)",
              paddingTop: 12,
            }}
          >
            <div className="muted">
              {selected.size} selected
            </div>
            <button onClick={() => setBulkOpen((v) => !v)} disabled={busy}>
              {bulkOpen ? "Close bulk edit" : "Bulk edit"}
            </button>
            <select
              className="secondary"
              value=""
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value as "" | "xlsx" | "svg" | "png";
                e.currentTarget.value = "";
                if (v) void exportSelected(v);
              }}
              style={{ width: "auto", cursor: "pointer" }}
              aria-label="Download selected"
            >
              <option value="">Download…</option>
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="svg">QR SVGs (.zip)</option>
              <option value="png">QR PNGs (.zip)</option>
            </select>
            <button
              className="secondary"
              onClick={() => void deleteSelected()}
              disabled={busy}
              style={{ color: "var(--bad)", borderColor: "var(--bad)" }}
            >
              Delete selected
            </button>
            <button
              className="secondary"
              onClick={() => setSelected(new Set())}
              disabled={busy}
            >
              Clear selection
            </button>
          </div>
        )}

        {hasSelection && bulkOpen && (
          <BulkEditPanel
            draft={bulkDraft}
            onChange={setBulkDraft}
            vocab={vocab}
            campaigns={campaigns}
            onApply={() => void applyBulkEdit()}
            busy={busy}
            count={selected.size}
          />
        )}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ minWidth: 1500 }}>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    style={{ width: "auto" }}
                    aria-label="Select all visible"
                  />
                </th>
                <th>Name</th>
                <th>Project</th>
                <th>Short URL</th>
                <th>QR</th>
                <th>Destination URL</th>
                <th>Campaign</th>
                <th>Source</th>
                <th>Medium</th>
                <th>Content</th>
                <th>Slug</th>
                <th style={{ textAlign: "right" }}>Views</th>
                <th />
              </tr>
              <tr className="filter-row">
                <th />
                <th>
                  <FilterInput
                    value={filters.name}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, name: v }))
                    }
                  />
                </th>
                <th>
                  <FilterSelect
                    value={filters.project}
                    options={colOptions.project}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, project: v }))
                    }
                  />
                </th>
                <th />
                <th />
                <th>
                  <FilterInput
                    value={filters.destination}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, destination: v }))
                    }
                  />
                </th>
                <th>
                  <FilterSelect
                    value={filters.campaign}
                    options={colOptions.campaign}
                    optionLabel={(v) => campaignLabel(v)}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, campaign: v }))
                    }
                  />
                </th>
                <th>
                  <FilterSelect
                    value={filters.source}
                    options={colOptions.source}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, source: v }))
                    }
                  />
                </th>
                <th>
                  <FilterSelect
                    value={filters.medium}
                    options={colOptions.medium}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, medium: v }))
                    }
                  />
                </th>
                <th>
                  <FilterSelect
                    value={filters.content}
                    options={colOptions.content}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, content: v }))
                    }
                  />
                </th>
                <th>
                  <FilterInput
                    value={filters.slug}
                    onChange={(v) =>
                      setFilters((f) => ({ ...f, slug: v }))
                    }
                  />
                </th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const isEditing = editingSlug === r.slug;
                const d = isEditing ? editDraft : null;
                return (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.slug)}
                        onChange={() => toggleSelected(r.slug)}
                        style={{ width: "auto" }}
                        aria-label={`Select ${r.slug}`}
                      />
                    </td>
                    <td>
                      {isEditing && d ? (
                        <input
                          value={d.name}
                          onChange={(e) =>
                            setEditDraft({ ...d, name: e.target.value })
                          }
                        />
                      ) : (
                        <>
                          {r.name ?? <span className="muted">—</span>}
                          {r.owner_email && (
                            <div className="muted" style={{ fontSize: 11 }}>
                              by {r.owner_email}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {isEditing && d ? (
                        <input
                          value={d.project}
                          onChange={(e) =>
                            setEditDraft({ ...d, project: e.target.value })
                          }
                          placeholder="(none)"
                        />
                      ) : (
                        r.project ?? <span className="muted">—</span>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <div className="row" style={{ gap: 4 }}>
                        <a
                          href={r.shortUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: 12 }}
                        >
                          {r.shortUrl}
                        </a>
                        <CopyButton
                          onCopy={() => copyShortUrl(r.shortUrl)}
                        />
                      </div>
                    </td>
                    <td>
                      <div
                        className="row"
                        style={{ gap: 8, alignItems: "center" }}
                      >
                        <QrThumbnail data={r.shortUrl} />
                        <div className="col" style={{ gap: 2 }}>
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              void downloadQr(
                                r.shortUrl,
                                "svg",
                                r.name ?? r.slug,
                              );
                            }}
                            style={{ fontSize: 11 }}
                          >
                            SVG
                          </a>
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              void downloadQr(
                                r.shortUrl,
                                "png",
                                r.name ?? r.slug,
                              );
                            }}
                            style={{ fontSize: 11 }}
                          >
                            PNG
                          </a>
                        </div>
                      </div>
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      {isEditing && d ? (
                        <input
                          value={d.destination}
                          onChange={(e) =>
                            setEditDraft({ ...d, destination: e.target.value })
                          }
                        />
                      ) : (
                        <span
                          className="preview"
                          style={{
                            display: "block",
                            padding: "4px 6px",
                            fontSize: 12,
                          }}
                          title={r.destination}
                        >
                          {r.destination}
                        </span>
                      )}
                    </td>
                    <td>
                      {isEditing && d ? (
                        <select
                          value={d.campaign}
                          onChange={(e) =>
                            setEditDraft({ ...d, campaign: e.target.value })
                          }
                        >
                          <option value="">— pick —</option>
                          {campaigns.map((c) => (
                            <option
                              key={encodeCampaignValue(c)}
                              value={encodeCampaignValue(c)}
                            >
                              {c.name}
                            </option>
                          ))}
                          {/* Preserve a legacy/unknown campaign value so the
                              dropdown reflects what's actually on the URL. */}
                          {d.campaign &&
                            !campaignByValue.has(d.campaign) && (
                              <option value={d.campaign}>
                                {d.campaign} (unknown)
                              </option>
                            )}
                        </select>
                      ) : (
                        <span title={r.campaign}>
                          {campaignLabel(r.campaign) || (
                            <span className="muted">—</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      {isEditing && d ? (
                        <select
                          value={d.source}
                          onChange={(e) =>
                            setEditDraft({ ...d, source: e.target.value })
                          }
                        >
                          <option value="">— pick —</option>
                          {vocab.source.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                          {d.source &&
                            !vocab.source.includes(d.source) && (
                              <option value={d.source}>{d.source}</option>
                            )}
                        </select>
                      ) : (
                        r.source || <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {isEditing && d ? (
                        <select
                          value={d.medium}
                          onChange={(e) =>
                            setEditDraft({ ...d, medium: e.target.value })
                          }
                        >
                          <option value="">— pick —</option>
                          {vocab.medium.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          {d.medium &&
                            !vocab.medium.includes(d.medium) && (
                              <option value={d.medium}>{d.medium}</option>
                            )}
                        </select>
                      ) : (
                        r.medium || <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {isEditing && d ? (
                        <select
                          value={d.content}
                          onChange={(e) =>
                            setEditDraft({ ...d, content: e.target.value })
                          }
                        >
                          <option value="">— none —</option>
                          {vocab.content.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                          {d.content &&
                            !vocab.content.includes(d.content) && (
                              <option value={d.content}>{d.content}</option>
                            )}
                        </select>
                      ) : (
                        r.content || <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <code style={{ fontSize: 12 }}>{r.slug}</code>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {r.scan_count.toLocaleString()}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {isEditing ? (
                        <div className="row" style={{ gap: 4 }}>
                          <button
                            onClick={() => void saveEdit()}
                            disabled={busy}
                            style={{ padding: "4px 10px" }}
                          >
                            Save
                          </button>
                          <button
                            className="secondary"
                            onClick={cancelEdit}
                            disabled={busy}
                            style={{ padding: "4px 10px" }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          className="secondary"
                          onClick={() => startEdit(r)}
                          style={{ padding: "4px 10px" }}
                        >
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={13} className="muted" style={{ padding: 16 }}>
                    {rows.length === 0
                      ? "No short links yet — generate one from the UTM Builder."
                      : "No rows match the current filters."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="filter…"
      style={{ padding: "4px 6px", fontSize: 12 }}
    />
  );
}

function FilterSelect({
  value,
  options,
  optionLabel,
  onChange,
}: {
  value: string;
  options: string[];
  optionLabel?: (v: string) => string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ padding: "4px 6px", fontSize: 12 }}
    >
      <option value="">all</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {optionLabel ? optionLabel(o) : o}
        </option>
      ))}
    </select>
  );
}

function BulkEditPanel({
  draft,
  onChange,
  vocab,
  campaigns,
  onApply,
  busy,
  count,
}: {
  draft: BulkDraft;
  onChange: (d: BulkDraft) => void;
  vocab: { source: string[]; medium: string[]; content: string[] };
  campaigns: HubspotCampaign[];
  onApply: () => void;
  busy: boolean;
  count: number;
}) {
  const set = (key: keyof BulkDraft, value: string) =>
    onChange({ ...draft, [key]: value });
  const dirty = Object.values(draft).some((v) => v !== "");

  return (
    <div
      className="col"
      style={{
        gap: 12,
        borderTop: "1px solid var(--border)",
        paddingTop: 12,
      }}
    >
      <div className="muted">
        Set any field below to apply that value to all {count} selected row
        {count === 1 ? "" : "s"}. Fields left blank stay as-is.
      </div>
      <div className="grid-3" style={{ gap: 12 }}>
        <div>
          <label>Name</label>
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="(leave blank for no change)"
          />
        </div>
        <div>
          <label>Project</label>
          <input
            value={draft.project}
            onChange={(e) => set("project", e.target.value)}
            placeholder="(leave blank for no change)"
          />
        </div>
        <div>
          <label>Destination URL</label>
          <input
            value={draft.destination}
            onChange={(e) => set("destination", e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div>
          <label>Campaign</label>
          <select
            value={draft.campaign}
            onChange={(e) => set("campaign", e.target.value)}
          >
            <option value="">— no change —</option>
            {campaigns.map((c) => (
              <option
                key={encodeCampaignValue(c)}
                value={encodeCampaignValue(c)}
              >
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Source</label>
          <select
            value={draft.source}
            onChange={(e) => set("source", e.target.value)}
          >
            <option value="">— no change —</option>
            {vocab.source.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Medium</label>
          <select
            value={draft.medium}
            onChange={(e) => set("medium", e.target.value)}
          >
            <option value="">— no change —</option>
            {vocab.medium.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Content</label>
          <select
            value={draft.content}
            onChange={(e) => set("content", e.target.value)}
          >
            <option value="">— no change —</option>
            <option value={CLEAR_CONTENT}>— clear content —</option>
            {vocab.content.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <button onClick={onApply} disabled={busy || !dirty}>
          {busy ? <span className="spinner" /> : null}
          Apply to {count}
        </button>
      </div>
    </div>
  );
}

function CopyButton({ onCopy }: { onCopy: () => Promise<void> | void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn"
      title={copied ? "Copied!" : "Copy short URL"}
      aria-label="Copy short URL"
      onClick={async () => {
        await onCopy();
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}

// Module-level cache so we only encode each short URL once across renders /
// filtering / pagination.
const qrThumbCache = new Map<string, string>();

function QrThumbnail({ data }: { data: string }) {
  const [src, setSrc] = useState<string | null>(
    () => qrThumbCache.get(data) ?? null,
  );

  useEffect(() => {
    const cached = qrThumbCache.get(data);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    // Render the QR client-side from the short URL it encodes. This is the same
    // data the saved QR encodes, needs no auth/network, and never shows the
    // blank-box failure mode the authed image fetch could.
    QRCode.toString(data, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((svg) => {
        if (cancelled) return;
        const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
        qrThumbCache.set(data, uri);
        setSrc(uri);
      })
      .catch(() => {
        /* thumbnail is non-critical */
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (!src) {
    return (
      <div
        style={{
          width: 48,
          height: 48,
          background: "#fff",
          borderRadius: 4,
        }}
      />
    );
  }
  return (
    <img
      src={src}
      alt="QR"
      style={{
        width: 48,
        height: 48,
        background: "#fff",
        borderRadius: 4,
        padding: 2,
      }}
    />
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
