import { useState } from "react";
import { api, apiBlob } from "../lib/api.js";

interface ParseResp {
  rows: Array<{
    ok: boolean;
    row: Record<string, string> | null;
    errors: string[];
    taggedUrl?: string;
    rowIndex: number;
  }>;
  okCount: number;
  errorCount: number;
}

interface GenResp {
  ok: boolean;
  assetId?: string;
  qrName?: string;
  slug?: string;
  shortUrl?: string;
  taggedUrl?: string;
  errors?: string[];
}

interface ResultRow {
  qrName: string;
  project: string;
  link: string;
  taggedUrl: string;
  shortUrl: string;
  errors: string[];
}

export function Bulk() {
  const [filename, setFilename] = useState("");
  const [parsed, setParsed] = useState<ParseResp | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onUpload(file: File) {
    setErr(null);
    setParsed(null);
    setResults([]);
    setFilename(file.name);
    const data = await fileToBase64(file);
    try {
      const res = await api<ParseResp>("/api/bulk/parse", {
        method: "POST",
        body: JSON.stringify({ data, filename: file.name }),
      });
      setParsed(res);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function onGenerate() {
    if (!parsed) return;
    setBusy(true);
    setErr(null);
    setResults([]);
    try {
      const okRows = parsed.rows.filter((r) => r.ok && r.row);
      // Create a parent batch asset so all child QR assets link to one parent.
      const { parentAssetId } = await api<{ parentAssetId: string }>(
        "/api/bulk/start",
        {
          method: "POST",
          body: JSON.stringify({
            name: filename || "Bulk upload",
            rowCount: okRows.length,
          }),
        },
      );

      setProgress({ done: 0, total: okRows.length });
      const collected: ResultRow[] = [];

      for (const r of okRows) {
        const row = r.row as Record<string, string>;
        try {
          const g = await api<GenResp>("/api/bulk/generate-row", {
            method: "POST",
            body: JSON.stringify({ parentAssetId, row }),
          });
          collected.push({
            qrName: row.qrName ?? "",
            project: row.project ?? "",
            link: row.link ?? "",
            taggedUrl: g.taggedUrl ?? r.taggedUrl ?? "",
            shortUrl: g.shortUrl ?? "",
            errors: g.errors ?? [],
          });
        } catch (e) {
          collected.push({
            qrName: row.qrName ?? "",
            project: row.project ?? "",
            link: row.link ?? "",
            taggedUrl: r.taggedUrl ?? "",
            shortUrl: "",
            errors: [formatErr(e)],
          });
        }
        setProgress({ done: collected.length, total: okRows.length });
        setResults([...collected]);
      }
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function onExport(format: "results" | "dynamic-qr") {
    if (results.length === 0) return;
    try {
      const blob = await apiBlob("/api/bulk/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format,
          rows: results.map((r) => ({
            qrName: r.qrName,
            project: r.project,
            link: r.link,
            taggedUrl: r.taggedUrl,
            shortUrl: r.shortUrl,
          })),
        }),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bulk-${format}-${Date.now()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Bulk Import</h2>
        <div className="muted">
          Upload a UTM Generator.xlsx/CSV file. We'll validate every row, build
          tagged URLs + short links + QRs server-side, and export a results
          sheet (or the dynamic-QR import template).
        </div>
      </div>

      <div className="card col">
        <div>
          <label>Upload .xlsx / .csv</label>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
            }}
          />
        </div>

        {parsed && (
          <>
            <div className="alert good">
              Parsed {parsed.rows.length} rows · {parsed.okCount} OK ·{" "}
              {parsed.errorCount} with errors
            </div>
            {parsed.errorCount > 0 && (
              <details>
                <summary className="muted">Show row errors</summary>
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows
                      .filter((r) => !r.ok)
                      .map((r) => (
                        <tr key={r.rowIndex}>
                          <td>{r.rowIndex + 2}</td>
                          <td>{r.errors.join("; ")}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </details>
            )}
            <button onClick={onGenerate} disabled={busy || parsed.okCount === 0}>
              {busy ? <span className="spinner" /> : null}
              Generate {parsed.okCount} short links + QRs
            </button>
            {busy && (
              <div className="muted">
                {progress.done} / {progress.total}…
              </div>
            )}
          </>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}

      {results.length > 0 && (
        <div className="card col">
          <div className="row">
            <button className="secondary" onClick={() => onExport("results")}>
              Download results sheet (.xlsx)
            </button>
            <button className="secondary" onClick={() => onExport("dynamic-qr")}>
              Export to dynamic-QR template (.xlsx)
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>QR name</th>
                <th>Project</th>
                <th>Short URL</th>
                <th>Tagged URL</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td>{r.qrName}</td>
                  <td>{r.project}</td>
                  <td>
                    {r.shortUrl ? (
                      <a href={r.shortUrl} target="_blank" rel="noreferrer">
                        {r.shortUrl}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <span className="preview" style={{ display: "block" }}>
                      {r.taggedUrl}
                    </span>
                  </td>
                  <td>
                    {r.errors.length === 0 ? (
                      <span className="good">ok</span>
                    ) : (
                      <span className="alert error">{r.errors.join("; ")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
