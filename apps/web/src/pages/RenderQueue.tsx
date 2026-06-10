import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  bulkDeleteJobs,
  deleteJob,
  listJobs,
  stopJob,
  STOP_REASON,
  type JobResponse,
} from "../lib/jobs.js";

const QUEUE_POLL_MS = 4000;

const HIGHLIGHT_STYLE: CSSProperties = {
  background: "color-mix(in srgb, var(--accent) 14%, transparent)",
};

// Jobs that belong in the queue view. Succeeded jobs are represented by their
// produced asset over in the Asset Library, so they drop out of the queue.
const QUEUE_STATUSES: JobResponse["status"][] = ["queued", "running", "failed"];

function isActive(status: JobResponse["status"]): boolean {
  return status === "queued" || status === "running";
}

export function RenderQueue() {
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [searchParams] = useSearchParams();
  const highlightJobId = searchParams.get("job");

  async function load(opts: { spinner?: boolean } = {}) {
    if (opts.spinner) setLoading(true);
    setErr(null);
    try {
      const all = await listJobs();
      const queue = all.filter((j) => QUEUE_STATUSES.includes(j.status));
      setJobs(queue);
      // Drop selections that no longer exist after a refresh/clear.
      setSelected((prev) => {
        const live = new Set(queue.map((j) => j.jobId));
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

  const hasActive = jobs.some((j) => isActive(j.status));

  // While a render is queued/rendering, refresh quietly so finished renders
  // clear out (and the queue empties) without the user lifting a finger.
  const loadRef = useRef<() => void>();
  loadRef.current = () => {
    void load();
  };
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => loadRef.current?.(), QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [hasActive]);

  // Scroll the deep-linked row into view the first time it renders.
  const scrolledFor = useRef<string | null>(null);
  const highlightRow = (el: HTMLTableRowElement | null) => {
    if (el && highlightJobId && scrolledFor.current !== highlightJobId) {
      scrolledFor.current = highlightJobId;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

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
      const ids = jobs.map((j) => j.jobId);
      const all = ids.length > 0 && ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (all) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      return next;
    });
  }
  const allSelected =
    jobs.length > 0 && jobs.every((j) => selected.has(j.jobId));
  const hasSelection = selected.size > 0;

  async function clearOne(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await deleteJob(id);
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function stopOne(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await stopJob(id);
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearSelected() {
    if (selected.size === 0) return;
    const n = selected.size;
    if (!confirm(`Clear ${n} render${n === 1 ? "" : "s"} from the queue?`)) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await bulkDeleteJobs([...selected]);
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
        <h2>Render Queue</h2>
        <div className="muted">
          Heavy generation jobs (3D app shots, image renders) run in the
          background. Stop a render that is still going, or clear finished /
          failed entries. Successful renders drop into your Asset Library.
        </div>
      </div>

      <div className="card row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          className="secondary"
          onClick={() => void load({ spinner: true })}
          disabled={loading}
        >
          {loading ? <span className="spinner" /> : null}
          Refresh
        </button>
        {hasActive && (
          <span className="muted row" style={{ gap: 6, fontSize: 12 }}>
            <span className="spinner" />
            Rendering in the background — this list refreshes automatically.
          </span>
        )}
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
          <button
            className="secondary"
            onClick={() => void clearSelected()}
            disabled={busy}
            style={{ color: "var(--bad)", borderColor: "var(--bad)" }}
          >
            Clear selected
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
              <th>Name</th>
              <th>Tool</th>
              <th>By</th>
              <th>Status</th>
              <th>Queued</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr
                key={j.jobId}
                ref={j.jobId === highlightJobId ? highlightRow : undefined}
                style={j.jobId === highlightJobId ? HIGHLIGHT_STYLE : undefined}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(j.jobId)}
                    onChange={() => toggleSelected(j.jobId)}
                    style={{ width: "auto" }}
                    aria-label={`Select ${j.name}`}
                  />
                </td>
                <td>{j.name}</td>
                <td>{j.tool}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {j.ownerEmail ?? "—"}
                </td>
                <td>
                  <StatusPill status={j.status} error={j.error} />
                  {j.status === "failed" &&
                  j.error &&
                  j.error !== STOP_REASON ? (
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {j.error}
                    </div>
                  ) : null}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {new Date(j.createdAt).toLocaleString()}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {editHrefForJob(j) && (
                    <a href={editHrefForJob(j)!} style={{ marginRight: 8 }}>
                      <button className="secondary">Edit</button>
                    </a>
                  )}
                  {isActive(j.status) ? (
                    <button
                      className="secondary"
                      onClick={() => void stopOne(j.jobId)}
                      disabled={busy}
                      style={{
                        padding: "4px 10px",
                        color: "var(--bad)",
                        borderColor: "var(--bad)",
                      }}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      className="secondary"
                      onClick={() => void clearOne(j.jobId)}
                      disabled={busy}
                      style={{ padding: "4px 10px" }}
                    >
                      Clear
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 16 }}>
                  Nothing in the render queue. Queue a render from the 3D
                  App-Shot, Cam Solve, or Image Generator tools.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({
  status,
  error,
}: {
  status: JobResponse["status"];
  error: string | null;
}) {
  const stopped = status === "failed" && error === STOP_REASON;
  const map: Record<string, { label: string; color: string; spin?: boolean }> = {
    queued: { label: "Queued", color: "var(--warn)", spin: true },
    running: { label: "Rendering", color: "var(--accent)", spin: true },
    failed: { label: "Failed", color: "var(--bad)" },
    succeeded: { label: "Done", color: "var(--good)" },
  };
  const s = stopped
    ? { label: "Stopped", color: "var(--muted)" as string, spin: false }
    : map[status] ?? { label: status, color: "var(--muted)" };
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

/** Reopen a 3D render's editor with its fixture/scene/settings restored. */
function editHrefForJob(j: {
  jobId: string;
  params?: Record<string, unknown> | null;
}): string | null {
  const params = j.params as { mode?: string; shot?: { editor?: string } } | null | undefined;
  if (params?.mode !== "shot3d") return null;
  const editor = params.shot?.editor === "camsolve" ? "/cam-solve" : "/app-shot";
  return `${editor}?restore=${encodeURIComponent(j.jobId)}`;
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
