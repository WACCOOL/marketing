import { useEffect, useState } from "react";
import {
  getConversation,
  listConversations,
  type AdminConversation,
  type AdminMessage,
} from "../lib/thomAdmin.js";

/**
 * Chats (admin) — every Thom conversation on both surfaces: internal users
 * (by email) and the public bubble (grouped by anonymous session). Tool
 * RESULTS are not shown (they can carry raw CRM payloads); what Thom searched
 * for is shown per answer.
 */

const PAGE = 50;

export function ThomChats() {
  const [days, setDays] = useState(30);
  const [surface, setSurface] = useState<"all" | "internal" | "public">("all");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<AdminConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<AdminMessage[] | null>(null);
  const [threadErr, setThreadErr] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setErr(null);
    listConversations({ days, surface, limit: PAGE, offset })
      .then((r) => {
        if (stale) return;
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => !stale && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [days, surface, offset]);

  useEffect(() => {
    if (!openId) return;
    let stale = false;
    setThread(null);
    setThreadErr(null);
    getConversation(openId)
      .then((r) => !stale && setThread(r.messages))
      .catch((e) => !stale && setThreadErr(e instanceof Error ? e.message : String(e)));
    return () => {
      stale = true;
    };
  }, [openId]);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Chats</h1>
          <div className="muted">Every Thom conversation, internal and public. Admin only.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select value={surface} onChange={(e) => { setSurface(e.target.value as typeof surface); setOffset(0); }}>
            <option value="all">All surfaces</option>
            <option value="internal">Internal</option>
            <option value="public">Public bubble</option>
          </select>
          <select value={days} onChange={(e) => { setDays(Number(e.target.value)); setOffset(0); }}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {err && <div className="alert error">Load failed: {err}</div>}

      <div className="card col" style={{ gap: 0 }}>
        {loading ? (
          <div className="muted" style={{ padding: 12 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>
            No conversations in this window.
            {surface !== "internal" &&
              " (Public-bubble logging requires the THOM_LOG secrets — see the deploy notes.)"}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Title / first question</th>
                <th style={{ textAlign: "right" }}>Questions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setOpenId(openId === c.id ? null : c.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmt(c.updated_at)}</td>
                  <td>
                    {c.scope === "internal" ? (
                      c.user_email ?? "internal user"
                    ) : (
                      <span className="tag">public{c.site_key ? ` · ${c.site_key}` : ""}</span>
                    )}
                  </td>
                  <td>{c.title ?? "(untitled)"}</td>
                  <td style={{ textAlign: "right" }}>{c.questions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {total > PAGE && (
          <div className="row" style={{ justifyContent: "space-between", padding: 10 }}>
            <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </button>
            <span className="muted">
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <button className="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              Older
            </button>
          </div>
        )}
      </div>

      {openId && (
        <div className="card col" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>Conversation</strong>
            <button className="secondary" onClick={() => setOpenId(null)}>Close</button>
          </div>
          {threadErr && <div className="alert error">{threadErr}</div>}
          {!thread && !threadErr && <div className="muted">Loading…</div>}
          {thread?.map((m) => (
            <div key={m.id} className="col" style={{ gap: 4 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                {m.role === "user" ? "Visitor" : "Thom"} · {fmt(m.created_at)}
                {m.model ? ` · ${m.model}` : ""}
              </div>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  background: m.role === "user" ? "var(--accent-soft)" : "var(--panel)",
                  border: "1px solid var(--border, rgba(0,0,0,0.08))",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                {m.content ?? ""}
              </div>
              {m.tool_calls && m.tool_calls.length > 0 && (
                <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                  {m.tool_calls.map((tc, i) => (
                    <span key={i} className="tag" title={JSON.stringify(tc.input)}>
                      {tc.name}
                      {typeof tc.input?.query === "string" ? `: “${tc.input.query}”` : ""}
                    </span>
                  ))}
                </div>
              )}
              {m.product_cards && m.product_cards.length > 0 && (
                <div className="muted" style={{ fontSize: 11 }}>
                  Products shown: {m.product_cards.map((p) => p.name ?? p.sku).join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
