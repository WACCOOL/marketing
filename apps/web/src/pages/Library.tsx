import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, apiBlob } from "../lib/api.js";
import { listJobs, type JobResponse } from "../lib/jobs.js";

interface AssetFile {
  format: string;
  r2_key: string;
  bytes: number;
}
interface Asset {
  id: string;
  owner_id: string;
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

const QUEUE_POLL_MS = 4000;

const HIGHLIGHT_STYLE: CSSProperties = {
  background: "color-mix(in srgb, var(--accent) 14%, transparent)",
};

export function Library() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [q, setQ] = useState("");
  const [tool, setTool] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Deep link from a finalize confirmation / future "render ready" email:
  // /library?job=<id> highlights that job's queue row, or — once it has
  // finished — its produced asset row.
  const [searchParams] = useSearchParams();
  const highlightJobId = searchParams.get("job");

  async function load(opts: { spinner?: boolean } = {}) {
    if (opts.spinner) setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (tool) params.set("tool", tool);
      const [assetsRes, jobsRes] = await Promise.all([
        api<{ assets: Asset[] }>(
          "/api/assets" + (params.toString() ? "?" + params.toString() : ""),
        ),
        listJobs().catch(() => [] as JobResponse[]),
      ]);
      setAssets(assetsRes.assets);
      setJobs(jobsRes);
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

  // A queued/rendering job has no asset yet; surface it as "in the queue" and
  // drop it once it succeeds (the produced asset shows in the table below) or
  // once its assetId already appears in the loaded assets.
  const assetIds = new Set(assets.map((a) => a.id));
  const queueJobs = jobs.filter((j) => {
    if (tool && j.tool !== tool) return false;
    if (q && !j.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (j.status === "queued" || j.status === "running") return true;
    if (j.status === "failed") return true;
    return false; // succeeded -> represented by its asset row
  });
  const queueJobsToShow = queueJobs.filter(
    (j) => !(j.assetId && assetIds.has(j.assetId)),
  );
  const hasActive = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );

  // Resolve the deep-linked job to the row we should highlight: its queue row
  // while pending, or its produced asset row once it has finished.
  const highlightedJob = highlightJobId
    ? jobs.find((j) => j.jobId === highlightJobId)
    : undefined;
  const highlightAssetId = highlightedJob?.assetId ?? null;

  // Scroll the highlighted row into view the first time it renders (reset when
  // the deep link itself changes).
  const scrolledFor = useRef<string | null>(null);
  const highlightRow = (el: HTMLTableRowElement | null) => {
    if (el && highlightJobId && scrolledFor.current !== highlightJobId) {
      scrolledFor.current = highlightJobId;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  // While a render is queued/rendering, refresh quietly so a finished render
  // appears (and the queue entry clears) without the user lifting a finger.
  const loadRef = useRef<() => void>();
  loadRef.current = () => {
    void load();
  };
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => loadRef.current?.(), QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [hasActive]);

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

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Asset Library</h2>
        <div className="muted">
          Every generated UTM / short link / QR is saved here, scoped to your
          visibility (internal users see all internal assets; reps see their
          own + explicit shares).
        </div>
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
        <select value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="">All tools</option>
          <option value="qr">QR</option>
          <option value="utm">UTM batch</option>
          <option value="appimage">App image</option>
          <option value="ppt">PPT</option>
          <option value="layout">Layout</option>
        </select>
        <button onClick={() => void load({ spinner: true })} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Search
        </button>
      </div>
      {err && <div className="alert error">{err}</div>}
      {queueJobsToShow.length > 0 && (
        <div className="card col" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Render queue</h3>
            {hasActive && (
              <span className="muted row" style={{ gap: 6, fontSize: 12 }}>
                <span className="spinner" />
                Rendering in the background — finished renders drop in below.
              </span>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Tool</th>
                <th>Status</th>
                <th>Queued</th>
              </tr>
            </thead>
            <tbody>
              {queueJobsToShow.map((j) => (
                <tr
                  key={j.jobId}
                  ref={j.jobId === highlightJobId ? highlightRow : undefined}
                  style={
                    j.jobId === highlightJobId ? HIGHLIGHT_STYLE : undefined
                  }
                >
                  <td>{j.name}</td>
                  <td>{j.tool}</td>
                  <td>
                    <StatusPill status={j.status} />
                    {j.status === "failed" && j.error ? (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {j.error}
                      </div>
                    ) : null}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {new Date(j.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Tool</th>
              <th>Tags</th>
              <th>Files</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr
                key={a.id}
                ref={a.id === highlightAssetId ? highlightRow : undefined}
                style={a.id === highlightAssetId ? HIGHLIGHT_STYLE : undefined}
              >
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
              </tr>
            ))}
            {assets.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
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

function StatusPill({ status }: { status: JobResponse["status"] }) {
  const map: Record<string, { label: string; color: string; spin?: boolean }> = {
    queued: { label: "Queued", color: "var(--warn)", spin: true },
    running: { label: "Rendering", color: "var(--accent)", spin: true },
    failed: { label: "Failed", color: "var(--bad)" },
    succeeded: { label: "Done", color: "var(--good)" },
  };
  const s = map[status] ?? { label: status, color: "var(--muted)" };
  return (
    <span
      className="tag"
      style={{
        borderColor: s.color,
        color: s.color,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {s.spin ? <span className="spinner" style={{ width: 10, height: 10 }} /> : null}
      {s.label}
    </span>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
