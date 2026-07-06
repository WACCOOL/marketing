import { useEffect, useRef, useState } from "react";
import {
  getSyncRecord,
  isActiveSync,
  listSyncIssues,
  listSyncRecords,
  refreshSyncOptions,
  repushDroppedProperty,
  type FieldIssue,
  type HubspotSyncStatus,
  type RecordDetail,
  type SyncRecord,
} from "../../lib/hubspotSync.js";
import { HubspotSummary } from "./HubspotSummary.js";

const POLL_MS = 5000;

type Tab = "records" | "errors" | "summary";

/** SAP -> HubSpot sync review dashboard: every payload, every error, the rollups. */
export function HubspotSync() {
  const [tab, setTab] = useState<Tab>("records");
  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>HubSpot Sync</h2>
        <div className="muted">
          Every SAP payload the Deals/Quotes and Companies Lambdas forward is
          captured here with its push outcome — so you can inspect the raw JSON,
          see exactly which fields failed and why, and find which fields cause the
          most problems.
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <TabButton active={tab === "records"} onClick={() => setTab("records")}>
          Records
        </TabButton>
        <TabButton active={tab === "errors"} onClick={() => setTab("errors")}>
          Errors
        </TabButton>
        <TabButton active={tab === "summary"} onClick={() => setTab("summary")}>
          Summary
        </TabButton>
      </div>

      {tab === "records" && <RecordsTab />}
      {tab === "errors" && <ErrorsTab />}
      {tab === "summary" && <HubspotSummary />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={active ? "" : "secondary"}
      onClick={onClick}
      style={{ padding: "6px 14px" }}
    >
      {children}
    </button>
  );
}

/* ------------------------------- Records tab ------------------------------- */

function RecordsTab() {
  const [rows, setRows] = useState<SyncRecord[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [objectType, setObjectType] = useState("");
  const [status, setStatus] = useState("");
  const [issues, setIssues] = useState("");
  const [q, setQ] = useState("");

  async function load(opts: { spinner?: boolean } = {}) {
    if (opts.spinner) setLoading(true);
    setErr(null);
    try {
      setRows(
        await listSyncRecords({
          objectType: objectType || undefined,
          status: status || undefined,
          q: q || undefined,
          hasProblems: issues === "1",
        }),
      );
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      if (opts.spinner) setLoading(false);
    }
  }

  useEffect(() => {
    void load({ spinner: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectType, status, issues]);

  const hasActive = rows.some((r) => isActiveSync(r.status));
  const loadRef = useRef<() => void>();
  loadRef.current = () => void load();
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => loadRef.current?.(), POLL_MS);
    return () => clearInterval(id);
  }, [hasActive]);

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="secondary" onClick={() => void load({ spinner: true })} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Refresh
        </button>
        <Select label="Object" value={objectType} onChange={setObjectType}
          options={[["", "All"], ["deals", "Deals"], ["companies", "Companies"]]} />
        <Select label="Status" value={status} onChange={setStatus}
          options={[["", "All"], ["succeeded", "Succeeded"], ["partial", "Partial"], ["held", "Held"], ["failed", "Failed"], ["captured", "Captured"]]} />
        <Select label="Issues" value={issues} onChange={setIssues}
          options={[["", "All"], ["1", "Has skipped fields"]]} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load({ spinner: true });
          }}
          className="row"
          style={{ gap: 6, alignItems: "center" }}
        >
          <input
            placeholder="Search quote / account #"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 200 }}
          />
          <button className="secondary" type="submit">Search</button>
        </form>
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Object</th>
              <th>Key</th>
              <th>Status</th>
              <th>Problems</th>
              <th>Delivered by</th>
              <th>Received</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <RecordRow key={r.id} row={r} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 16 }}>
                  No records yet. Captured SAP payloads will appear here once the
                  Lambdas start forwarding.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecordRow({ row }: { row: SyncRecord }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      setLoading(true);
      setErr(null);
      try {
        setDetail(await getSyncRecord(row.id));
      } catch (e) {
        setErr(formatErr(e));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <>
      <tr>
        <td>{row.objectType}</td>
        <td style={{ fontFamily: "var(--mono, monospace)", fontSize: 12 }}>
          {row.dedupKey ?? "—"}
          {row.receiptCount > 1 && (
            <span className="muted" style={{ fontSize: 11 }}> ×{row.receiptCount}</span>
          )}
        </td>
        <td><StatusPill status={row.status} /></td>
        <td className="muted" style={{ fontSize: 12 }}>
          {row.problemCount > 0 ? `${row.problemCount} field${row.problemCount === 1 ? "" : "s"}` : "—"}
        </td>
        <td className="muted" style={{ fontSize: 12 }}>{row.deliveredBy ?? "—"}</td>
        <td className="muted" style={{ fontSize: 12 }}>{new Date(row.createdAt).toLocaleString()}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="secondary" onClick={() => void toggle()} style={{ padding: "4px 10px" }}>
            {open ? "Hide" : "View JSON"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ background: "var(--panel-3)" }}>
            {loading && <div className="muted row" style={{ gap: 8, padding: 8 }}><span className="spinner" /> Loading…</div>}
            {err && <div className="alert error" style={{ margin: 8 }}>{err}</div>}
            {detail && (
              <div className="col" style={{ gap: 12, padding: "8px 4px" }}>
                {detail.record.lambdaError && (
                  <div className="alert error" style={{ margin: 0 }}>{detail.record.lambdaError}</div>
                )}
                {detail.issues.length > 0 && (
                  <div>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                      {detail.issues.length} field issue{detail.issues.length === 1 ? "" : "s"}:
                    </div>
                    <table>
                      <thead>
                        <tr><th>Object</th><th>Property</th><th>Value</th><th>Category</th><th>Reason</th></tr>
                      </thead>
                      <tbody>
                        {detail.issues.map((i) => (
                          <IssueCells key={i.id} issue={i} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Raw payload:</div>
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: 360,
                      overflow: "auto",
                      fontSize: 12,
                      background: "var(--panel)",
                      padding: 12,
                      borderRadius: "var(--radius, 8px)",
                    }}
                  >
                    {JSON.stringify(detail.payload, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* -------------------------------- Errors tab ------------------------------- */

function ErrorsTab() {
  const [rows, setRows] = useState<FieldIssue[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [objectType, setObjectType] = useState("");
  const [category, setCategory] = useState("");
  const [action, setAction] = useState("");
  const [property, setProperty] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setRows(
        await listSyncIssues({
          objectType: objectType || undefined,
          category: category || undefined,
          property: property || undefined,
          action: action || undefined,
        }),
      );
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectType, category, action]);

  async function onRefreshOptions() {
    setBusy(true);
    setErr(null);
    setActionMsg(null);
    try {
      await refreshSyncOptions();
      setActionMsg("HubSpot dropdown options refreshed from HubSpot.");
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  // Re-push only re-sends the dropped rows for ONE property, so it needs a
  // concrete object type. Use the Object filter if set, else infer it from the
  // dropped rows currently shown (e.g. a program_level filter → all companies).
  const prop = property.trim();
  const droppedRows = rows.filter((r) => r.action === "dropped");
  const droppedObjectTypes = [...new Set(droppedRows.map((r) => r.objectType))];
  const effectiveObjectType =
    objectType === "companies" || objectType === "deals"
      ? objectType
      : droppedObjectTypes.length === 1 &&
          (droppedObjectTypes[0] === "companies" || droppedObjectTypes[0] === "deals")
        ? droppedObjectTypes[0]!
        : "";
  const canRepush = prop !== "" && effectiveObjectType !== "" && droppedRows.length > 0;
  const repushHint = !prop
    ? "Type a property name and click Filter first."
    : droppedRows.length === 0
      ? "No dropped rows shown for this property."
      : effectiveObjectType === ""
        ? "Set Object to Companies or Deals (the shown drops span multiple types)."
        : "";

  async function onRepush() {
    if (!canRepush) return;
    setBusy(true);
    setErr(null);
    setActionMsg(null);
    try {
      const r = await repushDroppedProperty({ objectType: effectiveObjectType, property: prop });
      setActionMsg(
        r.optionsCached
          ? `Re-pushed ${prop}: ${r.pushed} fixed, ${r.stillUnmatched} still unmatched` +
              (r.errors ? `, ${r.errors} errors` : "") +
              ` (of ${r.total}).`
          : `No cached options for "${prop}" yet — click "Refresh HubSpot options" first.`,
      );
      await load();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="secondary" onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Refresh
        </button>
        <Select label="Object" value={objectType} onChange={setObjectType}
          options={[["", "All"], ["deals", "Deals"], ["line_items", "Line items"], ["companies", "Companies"]]} />
        <Select label="Category" value={category} onChange={setCategory}
          options={[["", "All"], ["enum_mismatch", "Dropdown mismatch"], ["unmapped_field", "Unmapped field"], ["assoc_not_found", "Association missing"], ["missing_required", "Missing required"], ["other", "Other"]]} />
        <Select label="Action" value={action} onChange={setAction}
          options={[["", "All"], ["dropped", "Dropped (needs review)"], ["normalized", "Auto-fixed"], ["unmapped", "Unmapped"], ["assoc_missing", "Assoc missing"], ["auto_created", "Rep code auto-created"], ["derived", "Stage/close date derived"]]} />
        <form
          onSubmit={(e) => { e.preventDefault(); void load(); }}
          className="row"
          style={{ gap: 6, alignItems: "center" }}
        >
          <input placeholder="Property name" value={property} onChange={(e) => setProperty(e.target.value)} style={{ width: 180 }} />
          <button className="secondary" type="submit">Filter</button>
        </form>
      </div>

      <div className="card row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => void onRefreshOptions()} disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          Refresh HubSpot options
        </button>
        <button
          onClick={() => void onRepush()}
          disabled={busy || !canRepush}
          title={canRepush ? `Re-push only the ${prop} field for its dropped rows` : repushHint}
        >
          {busy ? <span className="spinner" /> : null}
          {prop ? `Re-push dropped ${prop} (this field only)` : "Re-push dropped field (this field only)"}
        </button>
        {actionMsg && <span className="muted" style={{ fontSize: 13 }}>{actionMsg}</span>}
        {!actionMsg && !canRepush && repushHint && (
          <span className="muted" style={{ fontSize: 13 }}>{repushHint}</span>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Object</th>
              <th>Property</th>
              <th>Value</th>
              <th>Category</th>
              <th>Reason</th>
              <th>Key</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td>{i.objectType}</td>
                <td style={{ fontFamily: "var(--mono, monospace)", fontSize: 12 }}>{i.property}</td>
                <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }} title={i.rawValue ?? ""}>{i.rawValue ?? "—"}</td>
                <td><CategoryTag category={i.category} action={i.action} /></td>
                <td className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{i.reason ?? "—"}</td>
                <td className="muted" style={{ fontSize: 12, fontFamily: "var(--mono, monospace)" }}>{i.dedupKey ?? "—"}</td>
                <td className="muted" style={{ fontSize: 12 }}>{new Date(i.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 16 }}>
                  No field issues recorded.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IssueCells({ issue }: { issue: FieldIssue }) {
  return (
    <tr>
      <td>{issue.objectType}</td>
      <td style={{ fontFamily: "var(--mono, monospace)", fontSize: 12 }}>{issue.property}</td>
      <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }} title={issue.rawValue ?? ""}>{issue.rawValue ?? "—"}</td>
      <td><CategoryTag category={issue.category} action={issue.action} /></td>
      <td className="muted" style={{ fontSize: 12 }}>{issue.reason ?? "—"}</td>
    </tr>
  );
}

/* --------------------------------- shared --------------------------------- */

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "auto" }}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function CategoryTag({ category, action }: { category: string; action: string | null }) {
  const color =
    category === "unmapped_field"
      ? "var(--muted)"
      : category === "assoc_not_found"
        ? "var(--warn)"
        : action === "normalized" || action === "auto_created" || action === "derived"
          ? "var(--good)"
          : "var(--bad)";
  return (
    <span className="tag" style={{ borderColor: color, color, fontSize: 11 }}>
      {action ?? category}
    </span>
  );
}

function StatusPill({ status }: { status: HubspotSyncStatus }) {
  const map: Record<HubspotSyncStatus, { label: string; color: string; spin?: boolean }> = {
    captured: { label: "Captured", color: "var(--muted)", spin: true },
    received: { label: "Received", color: "var(--muted)", spin: true },
    pushing: { label: "Pushing", color: "var(--accent)", spin: true },
    succeeded: { label: "Done", color: "var(--good)" },
    partial: { label: "Partial", color: "var(--warn)" },
    held: { label: "Held", color: "var(--accent)" },
    failed: { label: "Failed", color: "var(--bad)" },
    skipped: { label: "Skipped", color: "var(--muted)" },
  };
  const s = map[status];
  return (
    <span
      className="tag"
      style={{ borderColor: s.color, color: s.color, display: "inline-flex", alignItems: "center", gap: 6 }}
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
