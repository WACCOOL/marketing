import { type CSSProperties, Fragment, useEffect, useState } from "react";
import { zipSync } from "fflate";
import { Link } from "react-router-dom";
import { api, apiBlob } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

interface AssetFile {
  format: string;
  r2_key: string;
  bytes: number;
}
interface Asset {
  id: string;
  owner_id: string;
  owner_email: string | null;
  tool: string;
  name: string;
  org_visibility: "internal" | "private";
  tags: string[];
  metadata_json: Record<string, unknown>;
  parent_asset_id: string | null;
  version: number;
  created_at: string;
  asset_files: AssetFile[];
}

// Smallest transfer first: there's no server-side thumbnailing, so the browser
// downloads the full-res file and scales it to ~48px. SVG ranks high so QR
// assets (svg + png) render crisp vectors.
const THUMB_FORMAT_PRIORITY = ["avif", "webp", "svg", "png", "jpeg", "jpg"];

function pickThumbFormat(files: AssetFile[]): string | null {
  for (const fmt of THUMB_FORMAT_PRIORITY) {
    if (files.some((f) => f.format === fmt)) return fmt;
  }
  return null;
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
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "asset";
}

/** Admin view of everything in the library. */
export function Library() {
  return (
    <AssetGallery
      title="Asset Library"
      blurb="Every generated asset across all tools, scoped to your visibility. Admin view."
    />
  );
}

/** Where an asset's "Edit" link should reopen, when it was a 3D render. */
function editHref(a: Asset): string | null {
  const jobId = (a.metadata_json as { jobId?: unknown })?.jobId;
  if (typeof jobId !== "string" || !a.tags.includes("shot3d")) return null;
  const editor = a.tags.includes("editor:camsolve") ? "/cam-solve" : "/app-shot";
  return `${editor}?restore=${encodeURIComponent(jobId)}`;
}

export function AssetGallery(props: {
  title: string;
  blurb: string;
  /** Fix the gallery to one tool (hides the tool dropdown). */
  tool?: string;
}) {
  const { user } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [q, setQ] = useState("");
  const [tool, setTool] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareOpen, setShareOpen] = useState<string | null>(null);

  async function load(opts: { spinner?: boolean } = {}) {
    if (opts.spinner) setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (props.tool) params.set("tool", props.tool);
      else if (tool) params.set("tool", tool);
      const assetsRes = await api<{ assets: Asset[] }>(
        "/api/assets" + (params.toString() ? "?" + params.toString() : ""),
      );
      setAssets(assetsRes.assets);
      // Drop selections that no longer exist after a delete/refresh.
      setSelected((prev) => {
        const live = new Set(assetsRes.assets.map((a) => a.id));
        const next = new Set<string>();
        for (const id of prev) if (live.has(id)) next.add(id);
        return next;
      });
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      if (opts.spinner) setLoading(false);
    }
  }
  useEffect(() => {
    void load({ spinner: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download(asset: Asset, format: string) {
    setErr(null);
    try {
      // Plain <a href> navigation can't carry the Authorization header the API
      // requires, so fetch the bytes with the authenticated helper and save the
      // resulting blob via a temporary object URL.
      const blob = await apiBlob(`/api/assets/${asset.id}/files/${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${asset.name || asset.id}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => {
      const ids = assets.map((a) => a.id);
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        for (const id of ids) next.delete(id);
      } else {
        for (const id of ids) next.add(id);
      }
      return next;
    });
  }
  const allSelected =
    assets.length > 0 && assets.every((a) => selected.has(a.id));
  const hasSelection = selected.size > 0;

  async function downloadSelected() {
    if (selected.size === 0) return;
    setBusy(true);
    setErr(null);
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      const chosen = assets.filter((a) => selected.has(a.id));
      const files: Record<string, Uint8Array> = {};
      const used = new Set<string>();
      for (const a of chosen) {
        const base = sanitizeFilename(a.name || a.id);
        for (const f of a.asset_files) {
          let filename = `${base}.${f.format}`;
          let n = 2;
          while (used.has(filename)) filename = `${base}-${n++}.${f.format}`;
          used.add(filename);
          const blob = await apiBlob(`/api/assets/${a.id}/files/${f.format}`);
          files[filename] = new Uint8Array(await blob.arrayBuffer());
        }
      }
      const zipped = zipSync(files, { level: 6 });
      saveBlob(
        new Blob([new Uint8Array(zipped)], { type: "application/zip" }),
        `assets-${stamp}.zip`,
      );
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    const isAdmin = user?.role === "admin";
    const deletable = assets.filter(
      (a) => selected.has(a.id) && (isAdmin || a.owner_id === user?.id),
    );
    const skipped = selected.size - deletable.length;
    if (deletable.length === 0) {
      setErr("You can only delete assets you created (admins can delete any).");
      return;
    }
    const n = deletable.length;
    if (
      !confirm(
        `Delete ${n} asset${n === 1 ? "" : "s"}?${skipped > 0 ? ` (${skipped} skipped — created by someone else.)` : ""} This permanently removes ${n === 1 ? "its" : "their"} stored files and cannot be undone.`,
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
        results: { id: string; ok: boolean; error?: string }[];
      }>("/api/assets/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ ids: deletable.map((a) => a.id) }),
      });
      if (res.errorCount > 0) {
        const firstErr = res.results.find((r) => !r.ok);
        setErr(
          `${res.errorCount} of ${n} failed${firstErr ? `: ${firstErr.id} — ${firstErr.error ?? "unknown"}` : ""}`,
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

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>{props.title}</h2>
        <div className="muted">{props.blurb}</div>
      </div>
      <div className="card row">
        <input
          placeholder="Search name, tags, metadata…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load({ spinner: true });
          }}
        />
        {!props.tool && (
          <select value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">All tools</option>
            <option value="qr">QR</option>
            <option value="utm">UTM batch</option>
            <option value="appimage">App image</option>
            <option value="ppt">PPT</option>
            <option value="layout">Layout</option>
          </select>
        )}
        <button onClick={() => void load({ spinner: true })} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Search
        </button>
      </div>
      {hasSelection && (
        <div
          className="card row"
          style={{
            gap: 8,
            flexWrap: "wrap",
            position: "sticky",
            top: 0,
            zIndex: 5,
            boxShadow: "0 6px 16px rgba(0,0,0,0.35)",
          }}
        >
          <div className="muted">{selected.size} selected</div>
          <button onClick={() => void downloadSelected()} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            Download (.zip)
          </button>
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
      {err && <div className="alert error">{err}</div>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  style={{ width: "auto" }}
                  aria-label="Select all"
                />
              </th>
              <th style={{ width: 56 }} />
              <th>Name</th>
              <th>Tool</th>
              <th>Tags</th>
              <th>Files</th>
              <th>Created</th>
              <th>Created by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => {
              // Only the owner (or an admin) can manage shares — matches the
              // asset_shares RLS write policy.
              const canShare = user && (a.owner_id === user.id || user.role === "admin");
              return (
                <Fragment key={a.id}>
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(a.id)}
                        onChange={() => toggleSelected(a.id)}
                        style={{ width: "auto" }}
                        aria-label={`Select ${a.name || a.id}`}
                      />
                    </td>
                    <td>
                      <AssetThumbnail asset={a} />
                    </td>
                    <td>{a.name}</td>
                    <td>{a.tool}</td>
                    <td>
                      {a.tags.map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))}
                    </td>
                    <td>
                      {a.asset_files.map((f) => (
                        <a
                          key={f.format}
                          href={`/api/assets/${a.id}/files/${f.format}`}
                          style={{ marginRight: 8 }}
                          onClick={(e) => {
                            e.preventDefault();
                            void download(a, f.format);
                          }}
                        >
                          {f.format}
                        </a>
                      ))}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {new Date(a.created_at).toLocaleString()}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {a.owner_email ?? "—"}
                      {user && a.owner_id === user.id ? " (you)" : ""}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {editHref(a) && (
                        <Link to={editHref(a)!} style={{ marginRight: 8 }}>
                          <button className="secondary">Edit</button>
                        </Link>
                      )}
                      {canShare && (
                        <button
                          className="secondary"
                          onClick={() =>
                            setShareOpen(shareOpen === a.id ? null : a.id)
                          }
                        >
                          Share
                        </button>
                      )}
                    </td>
                  </tr>
                  {shareOpen === a.id && (
                    <tr>
                      <td colSpan={9} style={{ background: "var(--panel)" }}>
                        <SharePanel assetId={a.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {assets.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  No assets match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Module-level cache of fetched thumbnail object URLs, keyed by `${id}:${format}`,
// so re-renders / re-filters don't refetch the same bytes. These URLs live for
// the lifetime of the page (revoking them would break still-mounted <img>s).
const thumbUrlCache = new Map<string, string>();

function AssetThumbnail({ asset }: { asset: Asset }) {
  const format = pickThumbFormat(asset.asset_files);
  const cacheKey = format ? `${asset.id}:${format}` : null;
  const [src, setSrc] = useState<string | null>(() =>
    cacheKey ? thumbUrlCache.get(cacheKey) ?? null : null,
  );

  useEffect(() => {
    if (!format || !cacheKey) return;
    const cached = thumbUrlCache.get(cacheKey);
    if (cached) {
      setSrc(cached);
      return;
    }
    let cancelled = false;
    apiBlob(`/api/assets/${asset.id}/files/${format}`)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        thumbUrlCache.set(cacheKey, url);
        setSrc(url);
      })
      .catch(() => {
        // thumbnail is non-critical
      });
    return () => {
      cancelled = true;
    };
  }, [asset.id, format, cacheKey]);

  const boxStyle: CSSProperties = {
    width: 48,
    height: 48,
    borderRadius: 4,
    background: "#fff",
    objectFit: "contain",
  };

  if (!format) {
    const label = asset.asset_files[0]?.format ?? "—";
    return (
      <div
        className="muted"
        style={{
          ...boxStyle,
          background: "var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          textTransform: "uppercase",
        }}
        title={label}
      >
        {label}
      </div>
    );
  }

  if (!src) return <div style={boxStyle} />;
  return <img src={src} alt={asset.name || "asset"} style={boxStyle} />;
}

/**
 * §2 sharing: explicit per-user grants (asset_shares) that make an asset
 * visible to a rep. Owner/admin only — enforced by RLS, mirrored in the UI.
 */
function SharePanel({ assetId }: { assetId: string }) {
  const [shares, setShares] = useState<
    { user_id: string; email: string; granted_at: string }[]
  >([]);
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await api<{ shares: typeof shares }>(
        `/api/assets/${assetId}/shares`,
      );
      setShares(res.shares);
    } catch (e) {
      setErr(formatErr(e));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  async function add() {
    const target = email.trim().toLowerCase();
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/assets/${assetId}/shares`, {
        method: "POST",
        body: JSON.stringify({ email: target }),
      });
      setEmail("");
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/assets/${assetId}/shares/${userId}`, {
        method: "DELETE",
      });
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 8, padding: 8 }}>
      <strong>Shared with</strong>
      {err && <div className="alert error">{err}</div>}
      {shares.length === 0 && (
        <span className="muted">
          Not shared with anyone. Internal users already see internal assets;
          shares grant access to specific reps.
        </span>
      )}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {shares.map((s) => (
          <span key={s.user_id} className="tag">
            {s.email}{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void remove(s.user_id);
              }}
              title={`Remove ${s.email}`}
            >
              ×
            </a>
          </span>
        ))}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <input
          placeholder="rep@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
        />
        <button onClick={() => void add()} disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          Share
        </button>
      </div>
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
