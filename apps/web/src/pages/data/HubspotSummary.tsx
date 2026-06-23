import { useEffect, useState } from "react";
import { getSyncSummary, type SyncSummary } from "../../lib/hubspotSync.js";

/** Summary tab — "which fields cause the most problems" + status/trend rollups. */
export function HubspotSummary() {
  const [data, setData] = useState<SyncSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getSyncSummary()
      .then((s) => live && setData(s))
      .catch((e) => live && setErr(formatErr(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="muted row" style={{ gap: 8 }}>
        <span className="spinner" /> Loading summary…
      </div>
    );
  }
  if (err) return <div className="alert error">{err}</div>;
  if (!data) return null;

  const fieldMax = Math.max(1, ...data.topFields.map((f) => f.n));
  const valueMax = Math.max(1, ...data.topValues.map((v) => v.n));
  const trendMax = Math.max(1, ...data.dailyTrend.map((d) => d.n));

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div className="card" style={{ flex: "1 1 360px", minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>Top problem fields</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Fields generating the most issues (dropped/normalized dropdowns,
            unmapped fields, association misses).
          </div>
          {data.topFields.length === 0 ? (
            <div className="muted">No issues recorded yet.</div>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {data.topFields.map((f, i) => (
                <Bar
                  key={`${f.objectType}.${f.property}.${f.category}.${i}`}
                  label={`${f.property}`}
                  sub={`${f.objectType} · ${f.category}`}
                  n={f.n}
                  pct={(f.n / fieldMax) * 100}
                />
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ flex: "1 1 360px", minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>Top problem values</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            The specific incoming values to fix at the source — or to seed a
            mapping for in Phase 2.
          </div>
          {data.topValues.length === 0 ? (
            <div className="muted">No issues recorded yet.</div>
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {data.topValues.map((v, i) => (
                <Bar
                  key={`${v.objectType}.${v.property}.${v.rawValue}.${i}`}
                  label={v.rawValue ?? "—"}
                  sub={`${v.objectType} · ${v.property}`}
                  n={v.n}
                  pct={(v.n / valueMax) * 100}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="row" style={{ gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div className="card" style={{ flex: "1 1 280px", minWidth: 260 }}>
          <h3 style={{ marginTop: 0 }}>Records by status</h3>
          <table>
            <thead>
              <tr>
                <th>Object</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Count</th>
              </tr>
            </thead>
            <tbody>
              {data.statusCounts.map((s, i) => (
                <tr key={i}>
                  <td>{s.objectType}</td>
                  <td>{s.status}</td>
                  <td style={{ textAlign: "right" }}>{s.n}</td>
                </tr>
              ))}
              {data.statusCounts.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted" style={{ padding: 12 }}>
                    No records yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ flex: "1 1 360px", minWidth: 320 }}>
          <h3 style={{ marginTop: 0 }}>Problems — last 30 days</h3>
          {data.dailyTrend.length === 0 ? (
            <div className="muted">No issues in the last 30 days.</div>
          ) : (
            <div
              className="row"
              style={{ gap: 3, alignItems: "flex-end", height: 120, marginTop: 8 }}
            >
              {data.dailyTrend.map((d) => (
                <div
                  key={d.day}
                  title={`${d.day}: ${d.n}`}
                  style={{
                    flex: 1,
                    minWidth: 4,
                    height: `${Math.max(2, (d.n / trendMax) * 100)}%`,
                    background: "var(--accent)",
                    borderRadius: "var(--radius-sm, 3px)",
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Bar({
  label,
  sub,
  n,
  pct,
}: {
  label: string;
  sub: string;
  n: number;
  pct: number;
}) {
  return (
    <div className="col" style={{ gap: 2 }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8, fontSize: 13 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label}>
          {label}
          <span className="muted" style={{ fontSize: 11 }}> · {sub}</span>
        </span>
        <span style={{ fontWeight: 600 }}>{n}</span>
      </div>
      <div style={{ background: "var(--panel-3)", borderRadius: 4, height: 8 }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--accent)",
            borderRadius: 4,
          }}
        />
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
