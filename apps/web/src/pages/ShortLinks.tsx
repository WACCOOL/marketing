import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Row {
  id: string;
  slug: string;
  destination_url: string;
  scan_count: number;
  created_at: string;
  updated_at: string;
  shortUrl: string;
}

export function ShortLinks() {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    setErr(null);
    try {
      const res = await api<{ shortLinks: Row[] }>("/api/short-links");
      setRows(res.shortLinks);
    } catch (e) {
      setErr(formatErr(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function saveEdit(slug: string) {
    try {
      await api(`/api/short-links/${encodeURIComponent(slug)}`, {
        method: "PATCH",
        body: JSON.stringify({ destinationUrl: draft }),
      });
      setEditing(null);
      setDraft("");
      void load();
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Short Links</h2>
        <div className="muted">
          The QR encodes the short link, so changing the destination here
          updates where every existing printed QR points — instantly, no
          reprinting.
        </div>
      </div>
      {err && <div className="alert error">{err}</div>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Short URL</th>
              <th>Destination</th>
              <th>Scans</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href={r.shortUrl} target="_blank" rel="noreferrer">
                    {r.shortUrl}
                  </a>
                </td>
                <td>
                  {editing === r.slug ? (
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      style={{ minWidth: 360 }}
                    />
                  ) : (
                    <span className="preview" style={{ display: "block" }}>
                      {r.destination_url}
                    </span>
                  )}
                </td>
                <td>{r.scan_count}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {new Date(r.updated_at).toLocaleString()}
                </td>
                <td>
                  {editing === r.slug ? (
                    <div className="row">
                      <button onClick={() => saveEdit(r.slug)}>Save</button>
                      <button
                        className="secondary"
                        onClick={() => {
                          setEditing(null);
                          setDraft("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="secondary"
                      onClick={() => {
                        setEditing(r.slug);
                        setDraft(r.destination_url);
                      }}
                    >
                      Edit destination
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No short links yet — generate one from the UTM Builder.
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
