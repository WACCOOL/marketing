import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { diffFamilyCopies } from "@wac/shared";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

/**
 * Family summary pages: a PIM family (zzfamily) groups sibling PPIDs (e.g.
 * CALLIOPE's four products). This page compiles the members + variants,
 * shows each member's romance copy inline with the differences highlighted
 * (shared sentences render muted; per-product differences stand out), and
 * generates an approvable family-level summary.
 */

interface FamilyEntry {
  family: string;
  count: number;
  brands: string[];
  categories: string[];
  image: string | null;
}

interface ContentRow {
  id: string;
  ppid: string;
  sku: string;
  field: string;
  existing_value: string | null;
  ai_value: string | null;
  approved_value: string | null;
  status: string;
  flagged: boolean;
  updated_at: string;
}

interface FamilyMember {
  ppid: string;
  name: string;
  brand: string | null;
  category: string | null;
  primary_image_url: string | null;
  variant_count: number;
  romance: ContentRow | null;
  existing_romance: string | null;
}

interface FamilyDetail {
  family: string;
  summary: ContentRow | null;
  members: FamilyMember[];
}

export function Families() {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [families, setFamilies] = useState<FamilyEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FamilyDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const params = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const res = await api<{ families: FamilyEntry[] }>(
        `/api/product-info/families${params}`,
      );
      setFamilies(res.families);
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

  async function open(family: string) {
    setSelected(family);
    setDetail(null);
    setErr(null);
    try {
      const res = await api<FamilyDetail>(
        `/api/product-info/family/${encodeURIComponent(family)}`,
      );
      setDetail(res);
      setSummaryDraft(res.summary?.approved_value ?? res.summary?.ai_value ?? "");
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function generateSummary() {
    if (!selected) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ content: ContentRow[] }>(
        "/api/product-info/family-summary",
        { method: "POST", body: JSON.stringify({ family: selected }) },
      );
      const row = res.content[0] ?? null;
      setDetail((d) => (d ? { ...d, summary: row } : d));
      setSummaryDraft(row?.ai_value ?? "");
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function approveSummary() {
    if (!detail?.summary || !summaryDraft.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ content: ContentRow }>(
        `/api/product-info/${detail.summary.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ action: "approve", approved_value: summaryDraft }),
        },
      );
      setDetail((d) => (d ? { ...d, summary: res.content } : d));
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  if (user?.role === "rep") {
    return (
      <div className="card">
        <h2>Families</h2>
        <p className="muted">This tool is available to internal users only.</p>
      </div>
    );
  }

  // Inline romance copies with shared-vs-different highlighting.
  const copies =
    detail?.members.map(
      (m) => m.romance?.approved_value ?? m.romance?.ai_value ?? m.existing_romance ?? "",
    ) ?? [];
  const withCopy = copies.map((c, i) => ({ copy: c, index: i })).filter((c) => c.copy);
  const diffs = diffFamilyCopies(withCopy.map((c) => c.copy));
  const diffByMember = new Map(withCopy.map((c, n) => [c.index, diffs[n]!]));

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Families</h2>
        <div className="muted">
          PIM families group sibling product pages (PPIDs). Compare each
          member's romance copy inline — shared sentences are muted, the
          per-product differences stand out — and generate a family-level
          summary that compiles the whole line-up.
        </div>
      </div>

      <div className="card row" style={{ gap: 8 }}>
        <input
          placeholder="Search families…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load();
          }}
          style={{ flex: 1 }}
        />
        <button onClick={() => void load()} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Search
        </button>
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="row" style={{ gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="card" style={{ flex: 1, minWidth: 300, maxWidth: 440 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 56 }} />
                <th>Family</th>
                <th>Pages</th>
              </tr>
            </thead>
            <tbody>
              {families.map((f) => (
                <tr
                  key={f.family}
                  onClick={() => void open(f.family)}
                  style={{
                    cursor: "pointer",
                    ...(selected === f.family ? { background: "var(--panel)" } : {}),
                  }}
                >
                  <td>
                    {f.image ? (
                      <img
                        src={f.image}
                        alt=""
                        loading="lazy"
                        style={{ width: 48, height: 48, objectFit: "contain", background: "#fff", borderRadius: 4 }}
                      />
                    ) : (
                      <div style={{ width: 48, height: 48 }} />
                    )}
                  </td>
                  <td>
                    {f.family}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {[f.brands.join(", "), f.categories.join(" · ")]
                        .filter(Boolean)
                        .join(" — ")}
                    </div>
                  </td>
                  <td>{f.count}</td>
                </tr>
              ))}
              {families.length === 0 && !loading && (
                <tr>
                  <td colSpan={3} className="muted">
                    No families match. (Families come from the PIM — re-sync
                    products if this is empty.)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="col" style={{ flex: 2, minWidth: 380, gap: 16 }}>
            {!detail && (
              <div className="card muted">
                <span className="spinner" /> Loading {selected}…
              </div>
            )}
            {detail && (
              <>
                <div className="card col" style={{ gap: 8 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <h3 style={{ margin: 0 }}>
                      {detail.family}{" "}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                        {detail.members.length} product page
                        {detail.members.length === 1 ? "" : "s"} ·{" "}
                        {detail.members.reduce((n, m) => n + m.variant_count, 0)} variants
                      </span>
                    </h3>
                    {detail.summary?.status === "approved" && (
                      <span className="tag" style={{ color: "var(--good)" }}>
                        summary approved
                      </span>
                    )}
                  </div>
                  <strong>Family summary</strong>
                  <textarea
                    rows={6}
                    value={summaryDraft}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    placeholder="Generate a family-level summary compiled from every member product and its variants."
                  />
                  <div className="row" style={{ gap: 8 }}>
                    <button disabled={busy} onClick={() => void generateSummary()}>
                      {busy ? <span className="spinner" /> : null}
                      {detail.summary ? "Regenerate" : "Generate"} summary
                    </button>
                    {detail.summary && (
                      <button
                        disabled={busy || !summaryDraft.trim()}
                        onClick={() => void approveSummary()}
                      >
                        Approve
                      </button>
                    )}
                  </div>
                </div>

                {detail.members.map((m, i) => {
                  const sentences = diffByMember.get(i);
                  return (
                    <div className="card row" key={m.ppid} style={{ gap: 12, alignItems: "flex-start" }}>
                      {m.primary_image_url && (
                        <img
                          src={m.primary_image_url}
                          alt={m.name}
                          style={{
                            width: 84,
                            height: 84,
                            objectFit: "contain",
                            background: "#fff",
                            borderRadius: 6,
                          }}
                        />
                      )}
                      <div className="col" style={{ flex: 1, gap: 4 }}>
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <strong>{m.name}</strong>
                          <span className="muted" style={{ fontSize: 12 }}>
                            PPID {m.ppid} · {m.variant_count} variant
                            {m.variant_count === 1 ? "" : "s"}
                          </span>
                        </div>
                        {sentences ? (
                          <p style={{ margin: 0, lineHeight: 1.5 }}>
                            {sentences.map((sent, n) => (
                              <Fragment key={n}>
                                {sent.common ? (
                                  <span className="muted">{sent.text}</span>
                                ) : (
                                  <mark
                                    style={{
                                      background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                                      color: "inherit",
                                      borderRadius: 3,
                                      padding: "0 2px",
                                    }}
                                  >
                                    {sent.text}
                                  </mark>
                                )}{" "}
                              </Fragment>
                            ))}
                          </p>
                        ) : (
                          <span className="muted">No romance copy yet.</span>
                        )}
                        <div className="row" style={{ gap: 10, fontSize: 13 }}>
                          <Link to={`/product-info/romance?ppid=${encodeURIComponent(m.ppid)}`}>
                            Edit romance
                          </Link>
                          <Link to={`/product-info/seo?ppid=${encodeURIComponent(m.ppid)}`}>
                            Edit SEO
                          </Link>
                          <Link to={`/product-info/normalization?ppid=${encodeURIComponent(m.ppid)}`}>
                            Normalization
                          </Link>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
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
