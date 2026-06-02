import { useEffect, useState } from "react";
import { api, apiBlob } from "../lib/api.js";

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

export function Library() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [q, setQ] = useState("");
  const [tool, setTool] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (tool) params.set("tool", tool);
      const res = await api<{ assets: Asset[] }>(
        "/api/assets" + (params.toString() ? "?" + params.toString() : ""),
      );
      setAssets(res.assets);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
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
            if (e.key === "Enter") void load();
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
        <button onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Search
        </button>
      </div>
      {err && <div className="alert error">{err}</div>}
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
              <tr key={a.id}>
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

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
