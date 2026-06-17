import { useEffect, useRef, useState } from "react";
import { listSources } from "@wac/shared";
import {
  isActiveIngestion,
  listIngestions,
  reprocessIngestion,
  type IngestionResponse,
  type IngestionStatus,
} from "../../lib/ingest.js";

const POLL_MS = 4000;

/** Recent ingestions across every source, with auto-refresh while any is active. */
export function DataIngestions() {
  const [rows, setRows] = useState<IngestionResponse[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<string>("");

  async function load(opts: { spinner?: boolean } = {}) {
    if (opts.spinner) setLoading(true);
    setErr(null);
    try {
      setRows(await listIngestions(sourceFilter || undefined));
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      if (opts.spinner) setLoading(false);
    }
  }

  useEffect(() => {
    void load({ spinner: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter]);

  const hasActive = rows.some((r) => isActiveIngestion(r.status));

  // Quietly refresh while anything is queued/processing so freshly-finished
  // ingestions resolve without a manual reload (mirrors the Render Queue).
  const loadRef = useRef<() => void>();
  loadRef.current = () => {
    void load();
  };
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => loadRef.current?.(), POLL_MS);
    return () => clearInterval(id);
  }, [hasActive]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function reprocessOne(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await reprocessIngestion(id);
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
        <h2>Data Ingestions</h2>
        <div className="muted">
          Marketing data files land here from Power Automate (Open Orders,
          Territory) and manual admin uploads (Pricing). Each row is one received
          file: its parse status, row counts, and any errors. Re-run a stored
          file with Reprocess.
        </div>
      </div>

      <div className="card row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="secondary"
          onClick={() => void load({ spinner: true })}
          disabled={loading}
        >
          {loading ? <span className="spinner" /> : null}
          Refresh
        </button>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Source
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            style={{ width: "auto" }}
          >
            <option value="">All</option>
            {listSources().map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {hasActive && (
          <span className="muted row" style={{ gap: 6, fontSize: 12 }}>
            <span className="spinner" />
            Processing — this list refreshes automatically.
          </span>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>File</th>
              <th>Delivered by</th>
              <th>Status</th>
              <th>Rows</th>
              <th>Received</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = expanded.has(r.id);
              const hasDetail = !!r.error || (r.errorCount ?? 0) > 0;
              return (
                <RowGroup
                  key={r.id}
                  row={r}
                  open={open}
                  hasDetail={hasDetail}
                  busy={busy}
                  onToggle={() => toggleExpanded(r.id)}
                  onReprocess={() => void reprocessOne(r.id)}
                />
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 16 }}>
                  No ingestions yet. Files pushed in by Power Automate or uploaded
                  through the Pricing page will appear here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowGroup({
  row,
  open,
  hasDetail,
  busy,
  onToggle,
  onReprocess,
}: {
  row: IngestionResponse;
  open: boolean;
  hasDetail: boolean;
  busy: boolean;
  onToggle: () => void;
  onReprocess: () => void;
}) {
  const counts = formatCounts(row);
  return (
    <>
      <tr>
        <td>
          {row.sourceLabel}
          {row.variantLabel ? (
            <div className="muted" style={{ fontSize: 11 }}>{row.variantLabel}</div>
          ) : null}
        </td>
        <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
          {row.originalName ?? "—"}
        </td>
        <td className="muted" style={{ fontSize: 12 }}>
          {row.deliveredBy ?? "—"}
        </td>
        <td>
          <StatusPill status={row.status} />
        </td>
        <td className="muted" style={{ fontSize: 12 }}>
          {counts}
        </td>
        <td className="muted" style={{ fontSize: 12 }}>
          {new Date(row.createdAt).toLocaleString()}
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          {hasDetail && (
            <button
              className="secondary"
              onClick={onToggle}
              style={{ padding: "4px 10px", marginRight: 8 }}
            >
              {open ? "Hide" : "Details"}
            </button>
          )}
          <button
            className="secondary"
            onClick={onReprocess}
            disabled={busy}
            style={{ padding: "4px 10px" }}
          >
            Reprocess
          </button>
        </td>
      </tr>
      {open && hasDetail && (
        <tr>
          <td colSpan={7} style={{ background: "var(--panel-3)" }}>
            {row.error && (
              <div className="alert error" style={{ margin: "8px 0" }}>
                {row.error}
              </div>
            )}
            {row.errors && row.errors.length > 0 && (
              <div style={{ padding: "4px 0 8px" }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                  {row.errorCount ?? row.errors.length} row error
                  {(row.errorCount ?? row.errors.length) === 1 ? "" : "s"}
                  {" "}(showing first {row.errors.length}):
                </div>
                <ul style={{ margin: 0, fontSize: 12 }}>
                  {row.errors.map((e, i) => (
                    <li key={i}>
                      Row {e.rowIndex}: {e.messages.join("; ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function formatCounts(row: IngestionResponse): string {
  if (row.rowCount == null) return "—";
  const parts = [`${row.rowCount} parsed`];
  if (row.closedCount != null && row.closedCount > 0) {
    parts.push(`${row.closedCount} closed`);
  }
  if (row.errorCount != null && row.errorCount > 0) {
    parts.push(`${row.errorCount} errors`);
  }
  return parts.join(" · ");
}

function StatusPill({ status }: { status: IngestionStatus }) {
  const map: Record<IngestionStatus, { label: string; color: string; spin?: boolean }> = {
    received: { label: "Received", color: "var(--muted)", spin: true },
    queued: { label: "Queued", color: "var(--warn)", spin: true },
    processing: { label: "Processing", color: "var(--accent)", spin: true },
    succeeded: { label: "Done", color: "var(--good)" },
    failed: { label: "Failed", color: "var(--bad)" },
    skipped: { label: "Skipped", color: "var(--muted)" },
  };
  const s = map[status];
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
