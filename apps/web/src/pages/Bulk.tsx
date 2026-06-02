import { useState } from "react";
import { encodeCampaignValue, type HubspotCampaign } from "@wac/shared";
import { api, apiBlob } from "../lib/api.js";
import { useVocab } from "../lib/vocab.js";

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

type Mode = "file" | "paste" | "urls";

/** Canonical header order assumed when pasted data has no recognizable header. */
const PASTE_DEFAULT_HEADERS = [
  "PROJECT",
  "QR CODE NAME",
  "LINK",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
];

const HEADER_TOKENS = new Set(
  [
    "project",
    "qr code name",
    "qr_code_name",
    "qrname",
    "qr name",
    "link",
    "destination",
    "url",
    "destination url",
    "website url",
    "utm_source",
    "source",
    "utm_medium",
    "medium",
    "utm_campaign",
    "campaign",
    "utm_content",
    "content",
  ].map((s) => s.toLowerCase()),
);

export function Bulk() {
  const { vocab, campaigns, loading: vocabLoading } = useVocab();
  const [mode, setMode] = useState<Mode>("file");
  const [filename, setFilename] = useState("");
  const [parsed, setParsed] = useState<ParseResp | null>(null);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Paste-mode state.
  const [pasteText, setPasteText] = useState("");

  // URL-list mode state (shared params applied to every URL).
  const [urlText, setUrlText] = useState("");
  const [ulProject, setUlProject] = useState("");
  const [ulNamePrefix, setUlNamePrefix] = useState("");
  const [ulSource, setUlSource] = useState("");
  const [ulMedium, setUlMedium] = useState("");
  const [ulCampaign, setUlCampaign] = useState<HubspotCampaign | null>(null);
  const [ulContent, setUlContent] = useState("");

  function resetResults(label: string) {
    setErr(null);
    setParsed(null);
    setResults([]);
    setFilename(label);
  }

  async function onDownloadTemplate() {
    setErr(null);
    try {
      const { buildBulkTemplate } = await import("../lib/template.js");
      const blob = await buildBulkTemplate({
        source: vocab.source,
        medium: vocab.medium,
        content: vocab.content,
        campaigns,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "WAC-bulk-import-template.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function onUpload(file: File) {
    resetResults(file.name);
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

  async function onParsePaste() {
    const rows = parsePastedTsv(pasteText);
    if (rows.length === 0) {
      setErr("Nothing to parse — paste rows copied from Excel first.");
      return;
    }
    resetResults("Pasted rows");
    try {
      const res = await api<ParseResp>("/api/bulk/parse-rows", {
        method: "POST",
        body: JSON.stringify({ rows }),
      });
      setParsed(res);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function onParseUrlList() {
    const urls = urlText
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (urls.length === 0) {
      setErr("Add at least one URL (one per line).");
      return;
    }
    if (!ulSource || !ulMedium || !ulCampaign) {
      setErr("Pick a source, medium, and campaign to apply to every URL.");
      return;
    }
    const prefix = ulNamePrefix.trim() || ulProject.trim() || "QR";
    const rows = urls.map((link, i) => ({
      project: ulProject.trim(),
      qrName: `${prefix} ${i + 1}`,
      link,
      utm_source: ulSource,
      utm_medium: ulMedium,
      utm_campaign: encodeCampaignValue(ulCampaign),
      utm_content: ulContent,
    }));
    resetResults(ulProject.trim() ? `URL list — ${ulProject.trim()}` : "URL list");
    try {
      const res = await api<ParseResp>("/api/bulk/parse-rows", {
        method: "POST",
        body: JSON.stringify({ rows }),
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
          Build tagged URLs + short links + QRs in bulk. Upload a spreadsheet,
          paste rows straight from Excel, or hand us a list of URLs to tag with
          one shared set of UTM parameters. Every row is validated server-side
          before anything is generated.
        </div>
      </div>

      <div className="card col">
        <div className="row" role="tablist" style={{ gap: 8 }}>
          <button
            className={mode === "file" ? "" : "secondary"}
            onClick={() => setMode("file")}
          >
            Upload file
          </button>
          <button
            className={mode === "paste" ? "" : "secondary"}
            onClick={() => setMode("paste")}
          >
            Paste from Excel
          </button>
          <button
            className={mode === "urls" ? "" : "secondary"}
            onClick={() => setMode("urls")}
          >
            List of URLs
          </button>
        </div>

        {mode === "file" && (
          <>
            <div>
              <label>Start from a template</label>
              <div className="row" style={{ alignItems: "center", gap: 12 }}>
                <button
                  className="secondary"
                  onClick={onDownloadTemplate}
                  disabled={vocabLoading}
                >
                  {vocabLoading ? <span className="spinner" /> : null}
                  Download blank template (.xlsx)
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Includes dropdowns for source, medium, campaign &amp; content,
                  pre-filled with the current controlled vocab.
                </span>
              </div>
            </div>
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
          </>
        )}

        {mode === "paste" && (
          <>
            <div>
              <label>Paste rows copied from Excel</label>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={8}
                placeholder={
                  "Paste cells straight from Excel (tab-separated).\n" +
                  "Include the header row if you have one, otherwise columns are read in this order:\n" +
                  PASTE_DEFAULT_HEADERS.join(" \u2192 ")
                }
                style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
              />
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                The campaign column accepts the campaign <strong>name</strong>{" "}
                (as shown in the template dropdown).
              </div>
            </div>
            <button onClick={onParsePaste} disabled={!pasteText.trim()}>
              Parse pasted rows
            </button>
          </>
        )}

        {mode === "urls" && (
          <>
            <div className="muted" style={{ fontSize: 12 }}>
              Paste a list of destination URLs (one per line). Every URL gets the
              same project + UTM parameters below.
            </div>
            <div>
              <label>Destination URLs (one per line)</label>
              <textarea
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                rows={8}
                placeholder={"https://waclighting.com/products/abc\nhttps://waclighting.com/products/xyz"}
                style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
              />
            </div>
            <div className="grid-2">
              <div>
                <label>Project (optional)</label>
                <input
                  value={ulProject}
                  onChange={(e) => setUlProject(e.target.value)}
                  placeholder="HD Expo 2026"
                />
              </div>
              <div>
                <label>QR name prefix (optional)</label>
                <input
                  value={ulNamePrefix}
                  onChange={(e) => setUlNamePrefix(e.target.value)}
                  placeholder="defaults to project; names become 'prefix 1', 'prefix 2'…"
                />
              </div>
            </div>
            <div className="grid-3">
              <div>
                <label>Campaign (HubSpot)</label>
                <select
                  value={ulCampaign ? encodeCampaignValue(ulCampaign) : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setUlCampaign(
                      campaigns.find((c) => encodeCampaignValue(c) === v) ?? null,
                    );
                  }}
                >
                  <option value="">— pick a campaign —</option>
                  {campaigns.map((c) => (
                    <option key={encodeCampaignValue(c)} value={encodeCampaignValue(c)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Source</label>
                <select value={ulSource} onChange={(e) => setUlSource(e.target.value)}>
                  <option value="">— pick —</option>
                  {vocab.source.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Medium</label>
                <select value={ulMedium} onChange={(e) => setUlMedium(e.target.value)}>
                  <option value="">— pick —</option>
                  {vocab.medium.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid-2">
              <div>
                <label>Content (optional)</label>
                <select value={ulContent} onChange={(e) => setUlContent(e.target.value)}>
                  <option value="">— none —</option>
                  {vocab.content.map((cv) => (
                    <option key={cv} value={cv}>
                      {cv}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button onClick={onParseUrlList} disabled={vocabLoading || !urlText.trim()}>
              Tag {urlText.split(/\r?\n/).filter((u) => u.trim()).length || ""} URLs
            </button>
          </>
        )}

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

/** Parse tab-separated rows pasted from Excel into header-keyed objects. */
function parsePastedTsv(text: string): Record<string, string>[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const firstCells = lines[0]!.split("\t").map((c) => c.trim());
  const looksLikeHeader = firstCells.some((c) => HEADER_TOKENS.has(c.toLowerCase()));
  const headers = looksLikeHeader ? firstCells : PASTE_DEFAULT_HEADERS;
  const dataLines = looksLikeHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    const cells = line.split("\t");
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? "").trim();
    });
    return obj;
  });
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
