import { useEffect, useMemo, useState } from "react";
import { getAnalytics, type AnalyticsBundle, type DailyRow } from "../lib/thomAdmin.js";

/**
 * Analytics (admin) — how much Thom is used, how that changes over time, and
 * what people search for. Data comes from the turn log (thom_conversations /
 * thom_messages) via the 0057 RPCs.
 */

const SERIES = [
  { key: "internal_questions" as const, label: "Internal", cssVar: "--chart-1" },
  { key: "public_questions" as const, label: "Public", cssVar: "--chart-2" },
];

export function ThomAnalytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setData(null);
    setErr(null);
    getAnalytics(days)
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [days]);

  const totals = useMemo(() => {
    const daily = data?.daily ?? [];
    const sum = (k: keyof DailyRow) => daily.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    return {
      conversations: sum("internal_conversations") + sum("public_conversations"),
      questions: sum("internal_questions") + sum("public_questions"),
      publicConversations: sum("public_conversations"),
      peakInternalUsers: Math.max(0, ...daily.map((r) => Number(r.internal_users ?? 0))),
    };
  }, [data]);

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Analytics</h1>
          <div className="muted">Thom usage across both surfaces. Admin only.</div>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {err && <div className="alert error">Load failed: {err}</div>}
      {!data && !err && <div className="muted">Loading…</div>}

      {data && (
        <>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <StatTile label="Questions asked" value={totals.questions} />
            <StatTile label="Conversations" value={totals.conversations} />
            <StatTile label="Public sessions" value={totals.publicConversations} />
            <StatTile label="Peak daily internal users" value={totals.peakInternalUsers} />
          </div>

          <div className="card col" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>Questions per day</strong>
              <span className="row" style={{ gap: 12 }}>
                {SERIES.map((s) => (
                  <span key={s.key} className="row" style={{ gap: 5, alignItems: "center" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: `var(${s.cssVar})` }} />
                    <span className="muted" style={{ fontSize: 12 }}>{s.label}</span>
                  </span>
                ))}
              </span>
            </div>
            <DailyChart daily={data.daily} />
          </div>

          <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div className="card col" style={{ gap: 8, flex: "1 1 320px" }}>
              <strong>Top searches</strong>
              {data.topQueries.length === 0 ? (
                <div className="muted">No searches yet.</div>
              ) : (
                <BarList
                  rows={data.topQueries.slice(0, 15).map((q) => ({
                    label: q.query,
                    value: Number(q.hits),
                    hint: q.public_hits > 0 ? `${q.public_hits} from the public bubble` : undefined,
                  }))}
                />
              )}
            </div>

            <div className="card col" style={{ gap: 8, flex: "1 1 320px" }}>
              <strong>Top products shown</strong>
              {data.topProducts.length === 0 ? (
                <div className="muted">No product cards yet.</div>
              ) : (
                <table>
                  <thead>
                    <tr><th>Product</th><th style={{ textAlign: "right" }}>Times shown</th></tr>
                  </thead>
                  <tbody>
                    {data.topProducts.slice(0, 15).map((p) => (
                      <tr key={p.sku}>
                        <td>{p.name ?? p.sku}</td>
                        <td style={{ textAlign: "right" }}>{Number(p.hits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="card col" style={{ gap: 8 }}>
            <strong>Words people search with</strong>
            {data.topWords.length === 0 ? (
              <div className="muted">Nothing yet.</div>
            ) : (
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {data.topWords.map((w) => (
                  <span key={w.word} className="tag" title={`${w.hits} searches`}>
                    {w.word} <span className="muted">{w.hits}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="card col" style={{ gap: 2, padding: "12px 16px", minWidth: 150 }}>
      <span style={{ fontSize: 26, fontWeight: 700 }}>{value.toLocaleString()}</span>
      <span className="muted" style={{ fontSize: 12 }}>{label}</span>
    </div>
  );
}

/** Two-series line chart with a crosshair tooltip. Hand-rolled SVG on the app
 *  tokens (validated pair --chart-1/--chart-2), baseline 0, recessive grid. */
function DailyChart({ daily }: { daily: DailyRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const PAD = { l: 34, r: 12, t: 10, b: 22 };
  const n = daily.length;
  const max = Math.max(1, ...daily.map((r) => Math.max(Number(r.internal_questions), Number(r.public_questions))));
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const path = (key: (typeof SERIES)[number]["key"]) =>
    daily.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(Number(r[key])).toFixed(1)}`).join(" ");
  const ticks = [0, Math.ceil(max / 2), max];
  const fmtDay = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div style={{ position: "relative", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", minWidth: 480, display: "block" }}
        role="img"
        aria-label="Questions per day, internal and public"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="currentColor" opacity={0.08} />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted, #888)">{t}</text>
          </g>
        ))}
        {[0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => n > 0 && a.indexOf(v) === i).map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted, #888)">
            {daily[i] ? fmtDay(daily[i]!.day) : ""}
          </text>
        ))}
        {SERIES.map((s) => (
          <path key={s.key} d={path(s.key)} fill="none" stroke={`var(${s.cssVar})`} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {hover != null && daily[hover] && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" opacity={0.25} />
            {SERIES.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(Number(daily[hover]![s.key]))}
                r={4}
                fill={`var(${s.cssVar})`}
                stroke="var(--panel)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </svg>
      {hover != null && daily[hover] && (
        <div
          className="card"
          style={{
            position: "absolute",
            top: 4,
            left: `min(${(x(hover) / W) * 100}%, calc(100% - 170px))`,
            padding: "6px 10px",
            fontSize: 12,
            pointerEvents: "none",
            boxShadow: "var(--shadow-2, 0 4px 14px rgba(0,0,0,0.15))",
          }}
        >
          <div style={{ fontWeight: 600 }}>{fmtDay(daily[hover]!.day)}</div>
          <div>Internal: {daily[hover]!.internal_questions}</div>
          <div>Public: {daily[hover]!.public_questions}</div>
          <div className="muted">{daily[hover]!.internal_users} internal users</div>
        </div>
      )}
    </div>
  );
}

/** Horizontal bar list (labels in ink, bars in the accent series color). */
function BarList({ rows }: { rows: { label: string; value: number; hint?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="col" style={{ gap: 6 }}>
      {rows.map((r) => (
        <div key={r.label} title={r.hint} className="col" style={{ gap: 2 }}>
          <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
            <span className="muted">{r.value}</span>
          </div>
          <div style={{ height: 6, borderRadius: 4, background: "var(--accent-soft)" }}>
            <div
              style={{
                width: `${(r.value / max) * 100}%`,
                height: "100%",
                borderRadius: 4,
                background: "var(--chart-1)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
