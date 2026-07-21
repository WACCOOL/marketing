import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { isUnverifiedFeedback } from "@wac/shared/thom/feedback";
import {
  getAnalytics,
  listFeedback,
  type AnalyticsBundle,
  type AnalyticsSurface,
  type DailyRow,
  type FeedbackDailyRow,
  type FeedbackItem,
} from "../lib/thomAdmin.js";
import { errorMessage } from "../lib/api.js";

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
  const [surface, setSurface] = useState<AnalyticsSurface>("all");
  const [data, setData] = useState<AnalyticsBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setData(null);
    setErr(null);
    getAnalytics(days, surface)
      .then((d) => !stale && setData(d))
      .catch((e) => !stale && setErr(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [days, surface]);

  const totals = useMemo(() => {
    const daily = data?.daily ?? [];
    const sum = (k: keyof DailyRow) => daily.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const withInternal = surface !== "public";
    const withPublic = surface !== "internal";
    return {
      conversations:
        (withInternal ? sum("internal_conversations") : 0) +
        (withPublic ? sum("public_conversations") : 0),
      questions:
        (withInternal ? sum("internal_questions") : 0) +
        (withPublic ? sum("public_questions") : 0),
      publicConversations: withPublic ? sum("public_conversations") : 0,
      peakInternalUsers: withInternal
        ? Math.max(0, ...daily.map((r) => Number(r.internal_users ?? 0)))
        : 0,
    };
  }, [data, surface]);

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Analytics</h1>
          <div className="muted">Thom usage across both surfaces. Admin only.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select value={surface} onChange={(e) => setSurface(e.target.value as AnalyticsSurface)}>
            <option value="all">All surfaces</option>
            <option value="internal">Internal</option>
            <option value="public">Public bubble</option>
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={180}>Last 6 months</option>
            <option value={365}>Last year</option>
          </select>
        </div>
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
            <FeedbackTiles totals={data.feedbackTotals ?? { up: 0, down: 0, unverified: 0 }} />
          </div>

          <div className="card col" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>Questions per day</strong>
              <span className="row" style={{ gap: 12 }}>
                {SERIES.filter((s) =>
                  surface === "all" ? true : surface === "internal" ? s.key === "internal_questions" : s.key === "public_questions",
                ).map((s) => (
                  <span key={s.key} className="row" style={{ gap: 5, alignItems: "center" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: `var(${s.cssVar})` }} />
                    <span className="muted" style={{ fontSize: 12 }}>{s.label}</span>
                  </span>
                ))}
              </span>
            </div>
            <DailyChart daily={data.daily} surface={surface} />
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
            <strong>Data sources used</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              Where Thom's answers came from: cited documents and the tools it called.
            </div>
            {data.sources.length === 0 ? (
              <div className="muted">Nothing yet.</div>
            ) : (
              <BarList rows={data.sources.map((s) => ({ label: s.source, value: s.hits }))} />
            )}
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

          <div className="card col" style={{ gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>Feedback per day</strong>
              <span className="row" style={{ gap: 12 }}>
                {[
                  { label: "Thumbs up", cssVar: "--chart-1" },
                  { label: "Thumbs down", cssVar: "--chart-2" },
                ].map((s) => (
                  <span key={s.label} className="row" style={{ gap: 5, alignItems: "center" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: `var(${s.cssVar})` }} />
                    <span className="muted" style={{ fontSize: 12 }}>{s.label}</span>
                  </span>
                ))}
              </span>
            </div>
            <FeedbackChart daily={data.feedbackDaily ?? []} />
          </div>

          <FeedbackList days={days} surface={surface} />
        </>
      )}
    </div>
  );
}

function FeedbackTiles({ totals }: { totals: { up: number; down: number; unverified: number } }) {
  const rated = totals.up + totals.down;
  // Positive rate over VERIFIED rows only (unverified excluded), with the
  // denominator shown so 3-vote days don't read as trends.
  const rate = rated > 0 ? `${Math.round((totals.up / rated) * 100)}%` : "–";
  return (
    <>
      <StatTile label="Feedback received" value={rated + totals.unverified} />
      <div className="card col" style={{ gap: 2, padding: "12px 16px", minWidth: 150 }}>
        <span style={{ fontSize: 26, fontWeight: 700 }}>{rate}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          Positive rate{rated > 0 ? ` (of ${rated.toLocaleString()} rated)` : ""}
        </span>
      </div>
    </>
  );
}

/** Compact two-series (up/down) daily line chart — small sibling of
 *  DailyChart on the same validated token pair. */
function FeedbackChart({ daily }: { daily: FeedbackDailyRow[] }) {
  const series = [
    { key: "up" as const, cssVar: "--chart-1" },
    { key: "down" as const, cssVar: "--chart-2" },
  ];
  const W = 720;
  const H = 140;
  const PAD = { l: 34, r: 12, t: 10, b: 22 };
  const n = daily.length;
  if (n === 0) return <div className="muted">No feedback yet.</div>;
  const max = Math.max(1, ...daily.flatMap((r) => series.map((s) => Number(r[s.key]))));
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const path = (key: "up" | "down") =>
    daily.map((r, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(Number(r[key])).toFixed(1)}`).join(" ");
  const fmtDay = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", minWidth: 480, display: "block" }}
        role="img"
        aria-label="Feedback per day, thumbs up and thumbs down"
      >
        {[0, max].map((t) => (
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
        {series.map((s) => (
          <path key={s.key} d={path(s.key)} fill="none" stroke={`var(${s.cssVar})`} strokeWidth={2} strokeLinejoin="round" />
        ))}
      </svg>
    </div>
  );
}

const FEEDBACK_PAGE = 50;

/**
 * Browsable feedback list. PLAIN-TEXT RULE (F15): question/answer snapshots
 * and reasons are visitor-typed or probe text — rendered ONLY as plain React
 * children inside pre-wrap blocks, NEVER through ReactMarkdown or any
 * HTML/markdown renderer.
 */
function FeedbackList({ days, surface }: { days: number; surface: AnalyticsSurface }) {
  const [rating, setRating] = useState<"all" | "up" | "down">("all");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => setOffset(0), [days, surface, rating]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setErr(null);
    listFeedback({ days, surface, rating, limit: FEEDBACK_PAGE, offset })
      .then((r) => {
        if (stale) return;
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => !stale && setErr(errorMessage(e)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [days, surface, rating, offset]);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong>Feedback</strong>
        <select value={rating} onChange={(e) => setRating(e.target.value as typeof rating)}>
          <option value="all">All</option>
          <option value="up">Thumbs up</option>
          <option value="down">Thumbs down</option>
        </select>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Public reasons are visitor-typed free text and may contain contact info typed by the
        visitor. Treat as customer data.
      </div>
      {err && <div className="alert error">Load failed: {err}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="muted">No feedback in this window.</div>
      ) : (
        <div className="col" style={{ gap: 0 }}>
          {items.map((f) => {
            const unverified = isUnverifiedFeedback(f);
            const open = openId === f.id;
            return (
              <div key={f.id} className="col" style={{ gap: 6, padding: "8px 0", borderTop: "1px solid var(--border, rgba(0,0,0,0.08))" }}>
                <div
                  className="row"
                  style={{ gap: 8, alignItems: "center", cursor: "pointer", flexWrap: "wrap" }}
                  onClick={() => setOpenId(open ? null : f.id)}
                >
                  <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{fmt(f.created_at)}</span>
                  <span className="tag">{f.surface === "internal" ? f.user_email ?? "internal" : `public${f.site_key ? ` · ${f.site_key}` : ""}`}</span>
                  {f.rating === 1 ? (
                    <ThumbsUp size={14} style={{ color: "var(--chart-1)", flex: "none" }} />
                  ) : (
                    <ThumbsDown size={14} style={{ color: "var(--chart-2)", flex: "none" }} />
                  )}
                  {unverified && (
                    <span className="muted" style={{ fontSize: 11 }}>unverified, visitor-supplied text</span>
                  )}
                  <span style={{ flex: 1, minWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.question_text}
                  </span>
                  {f.reason && (
                    <span className="muted" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.reason}
                    </span>
                  )}
                </div>
                {open && (
                  <div className="col" style={{ gap: 6 }}>
                    {/* Plain text only (F15) — no markdown rendering for snapshots. */}
                    <div style={{ whiteSpace: "pre-wrap", background: "var(--accent-soft)", borderRadius: 8, padding: "8px 10px" }}>
                      {f.question_text}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", background: "var(--panel)", border: "1px solid var(--border, rgba(0,0,0,0.08))", borderRadius: 8, padding: "8px 10px", maxHeight: 320, overflowY: "auto" }}>
                      {f.answer_text}
                    </div>
                    {f.reason && (
                      <div className="muted" style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>Reason: {f.reason}</div>
                    )}
                    {(f.tool_calls.length > 0 || f.doc_types.length > 0) && (
                      <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                        {f.tool_calls.map((tc, i) => (
                          <span key={`t-${i}`} className="tag">{tc.name}</span>
                        ))}
                        {f.doc_types.map((d) => (
                          <span key={`d-${d}`} className="tag">{d}</span>
                        ))}
                      </div>
                    )}
                    {f.conversation_id && (
                      <Link to={`/thom-chats?open=${encodeURIComponent(f.conversation_id)}`} style={{ fontSize: 12 }}>
                        Open in Chats
                      </Link>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {total > FEEDBACK_PAGE && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - FEEDBACK_PAGE))}>
            Newer
          </button>
          <span className="muted">
            {offset + 1}–{Math.min(offset + FEEDBACK_PAGE, total)} of {total}
          </span>
          <button className="secondary" disabled={offset + FEEDBACK_PAGE >= total} onClick={() => setOffset(offset + FEEDBACK_PAGE)}>
            Older
          </button>
        </div>
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
function DailyChart({ daily, surface }: { daily: DailyRow[]; surface: AnalyticsSurface }) {
  const series = SERIES.filter((s) =>
    surface === "all" ? true : surface === "internal" ? s.key === "internal_questions" : s.key === "public_questions",
  );
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const PAD = { l: 34, r: 12, t: 10, b: 22 };
  const n = daily.length;
  const max = Math.max(1, ...daily.flatMap((r) => series.map((s) => Number(r[s.key]))));
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
        {series.map((s) => (
          <path key={s.key} d={path(s.key)} fill="none" stroke={`var(${s.cssVar})`} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {hover != null && daily[hover] && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" opacity={0.25} />
            {series.map((s) => (
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
          {surface !== "public" && <div>Internal: {daily[hover]!.internal_questions}</div>}
          {surface !== "internal" && <div>Public: {daily[hover]!.public_questions}</div>}
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
