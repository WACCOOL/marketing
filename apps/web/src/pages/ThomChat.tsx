import { Fragment, useEffect, useRef, useState } from "react";
import {
  Bot,
  Boxes,
  ExternalLink,
  FileText,
  Globe,
  History,
  Loader2,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  chatStream,
  deleteConversation,
  getConversation,
  listConversations,
  type Card,
  type Citation,
  type ConversationSummary,
  type FamilyCard,
  type LayoutCard,
  type ProductCard,
} from "../lib/thom.js";

interface Turn {
  role: "user" | "assistant";
  text: string;
  cards?: Card[];
  citations?: Citation[];
  error?: boolean;
}

const EXAMPLES = [
  "What's the lumen output and CRI of SKU 2095?",
  "I need a warm-dim 3-inch downlight for a damp bathroom — what do you recommend?",
  "What's the cutout size for the Aurora trimless downlight?",
  "A client wants something like a Lutron Ketra — what WAC product is closest?",
];

// Persist the active conversation so navigating away and back doesn't lose it.
const STORAGE_KEY = "thom.activeConversation.v1";
interface Persisted {
  turns: Turn[];
  conversationId: string | null;
}
function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

/** Compact relative time for history rows ("just now", "3h ago", "2d ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}

/** Immutably replace the most recent assistant turn (the in-progress one). */
function updateLastAssistant(turns: Turn[], fn: (t: Turn) => Turn): Turn[] {
  const next = turns.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const turn = next[i];
    if (turn && turn.role === "assistant") {
      next[i] = fn(turn);
      break;
    }
  }
  return next;
}

export function ThomChat() {
  const persisted = loadPersisted();
  const [turns, setTurns] = useState<Turn[]>(persisted?.turns ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    persisted?.conversationId ?? null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // Holds the in-flight stream so New chat / unmount can cancel it.
  const abortRef = useRef<AbortController | null>(null);

  // History drawer.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Persist across navigation / remount.
  useEffect(() => {
    try {
      if (turns.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ turns, conversationId }));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // storage full / unavailable — non-fatal
    }
  }, [turns, conversationId]);

  function newChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setTurns([]);
    setConversationId(null);
    setInput("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryBusy(true);
    try {
      setConversations(await listConversations());
    } catch {
      setConversations([]);
    } finally {
      setHistoryBusy(false);
    }
  }

  async function loadConversation(id: string) {
    // Abort any in-flight stream before swapping the transcript out.
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    try {
      const { conversationId: id2, turns: loaded } = await getConversation(id);
      setTurns(loaded);
      setConversationId(id2);
      setHistoryOpen(false);
    } catch {
      // leave the drawer open so the user can retry
    }
  }

  async function removeConversation(id: string) {
    if (!window.confirm("Delete this conversation? This can't be undone.")) return;
    try {
      await deleteConversation(id);
      setConversations((cs) => cs.filter((c) => c.id !== id));
      if (id === conversationId) newChat();
    } catch {
      // no-op — the row stays; user can retry
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    // User turn + an empty in-progress assistant turn we stream deltas into.
    setTurns((t) => [...t, { role: "user", text: message }, { role: "assistant", text: "" }]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    await chatStream(
      message,
      conversationId,
      {
        onMeta: (id) => setConversationId(id),
        onDelta: (delta) =>
          setTurns((t) =>
            updateLastAssistant(t, (turn) => ({ ...turn, text: turn.text + delta })),
          ),
        onCards: (cards) =>
          setTurns((t) => updateLastAssistant(t, (turn) => ({ ...turn, cards }))),
        onCitations: (citations) =>
          setTurns((t) => updateLastAssistant(t, (turn) => ({ ...turn, citations }))),
        onDone: () => {
          setBusy(false);
          abortRef.current = null;
        },
        onError: (err) =>
          setTurns((t) =>
            updateLastAssistant(t, () => ({
              role: "assistant",
              text:
                err.status === 503
                  ? "Thom isn't configured yet (no API key)."
                  : `Sorry — something went wrong (${err.error ?? "unknown error"}).`,
              error: true,
            })),
          ),
      },
      controller.signal,
    );
    // If the stream ended without a done/error (e.g. dropped), clear busy.
    setBusy(false);
    abortRef.current = null;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <div className="thom">
      {historyOpen && (
        <>
          <div className="thom-history-scrim" onClick={() => setHistoryOpen(false)} />
          <aside className="thom-history" aria-label="Conversation history">
            <div className="thom-history-head">
              <strong>Chat history</strong>
              <button
                className="thom-history-close"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close history"
              >
                <X size={16} />
              </button>
            </div>
            <div className="thom-history-list">
              {historyBusy ? (
                <div className="thom-history-empty">
                  <Loader2 size={16} className="spin" /> Loading…
                </div>
              ) : conversations.length === 0 ? (
                <div className="thom-history-empty">No past conversations yet.</div>
              ) : (
                conversations.map((conv) => (
                  <div
                    key={conv.id}
                    className={`thom-history-item${conv.id === conversationId ? " active" : ""}`}
                  >
                    <button
                      className="thom-history-open"
                      onClick={() => void loadConversation(conv.id)}
                    >
                      <span className="thom-history-title">{conv.title}</span>
                      <span className="thom-history-meta muted">
                        {relativeTime(conv.createdAt)} · {conv.messageCount} message
                        {conv.messageCount === 1 ? "" : "s"}
                      </span>
                    </button>
                    <button
                      className="thom-history-del"
                      onClick={() => void removeConversation(conv.id)}
                      aria-label="Delete conversation"
                      title="Delete conversation"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        </>
      )}
      <header className="thom-head">
        <div className="thom-head-row">
          <div className="thom-title">
            <Bot size={20} /> <span>Thom</span>
          </div>
          <div className="thom-head-actions">
            <button className="secondary thom-new" onClick={() => void openHistory()}>
              <History size={14} /> History
            </button>
            {turns.length > 0 && (
              <button className="secondary thom-new" onClick={newChat}>
                <Plus size={14} /> New chat
              </button>
            )}
          </div>
        </div>
        <p className="muted">Your WAC Group lighting expert — products, specs, manuals, and recommendations.</p>
      </header>

      <div className="thom-scroll" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="thom-empty">
            <Bot size={40} className="thom-empty-icon" />
            <h2>Ask Thom anything about WAC Group products</h2>
            <p className="muted">Specs, spec sheets, install manuals, lighting design, or a competitor match.</p>
            <div className="thom-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="thom-example" onClick={() => void send(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, i) => (
            <TurnView
              key={i}
              turn={turn}
              streaming={busy && i === turns.length - 1 && turn.role === "assistant"}
            />
          ))
        )}
      </div>

      <div className="thom-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about a product, spec, or recommendation…  (Enter to send, Shift+Enter for a new line)"
          rows={2}
          disabled={busy}
        />
        <button className="primary thom-send" onClick={() => void send(input)} disabled={busy || !input.trim()}>
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

function TurnView({ turn, streaming = false }: { turn: Turn; streaming?: boolean }) {
  // An in-progress assistant turn with no text yet → show the thinking bubble
  // (kept until the first token arrives).
  if (turn.role === "assistant" && streaming && !turn.text) {
    return (
      <div className="thom-turn assistant">
        <div className="thom-bubble thom-thinking">
          <Loader2 size={16} className="spin" /> Thom is thinking…
        </div>
      </div>
    );
  }
  return (
    <div className={`thom-turn ${turn.role}`}>
      <div className={`thom-bubble${turn.error ? " thom-error" : ""}`}>
        {turn.role === "assistant" ? (
          <div className="thom-text thom-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
                // Tables scroll in their own container so a wide spec table
                // never overflows the chat column.
                table: ({ children }) => (
                  <div className="thom-table-wrap">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {turn.text}
            </ReactMarkdown>
            {streaming && <span className="thom-cursor" aria-hidden="true" />}
          </div>
        ) : (
          <div className="thom-text">{turn.text}</div>
        )}
        {turn.cards?.map((c, i) =>
          // Cards logged before the family feature have no `kind` — default to
          // the product view so old conversations still render.
          c.kind === "layout" ? (
            <LayoutCardView key={`layout:${i}`} card={c} />
          ) : c.kind === "family" ? (
            <FamilyCardView key={`family:${c.family}:${i}`} card={c} />
          ) : (
            <CardView key={`product:${c.sku}:${i}`} card={c} />
          ),
        )}
        {turn.citations && turn.citations.length > 0 && (
          <div className="thom-citations">
            {turn.citations.map((cite, i) => (
              <a
                key={`${cite.document_id}-${i}`}
                className="thom-cite"
                href={cite.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                title={cite.title ?? cite.doc_type}
              >
                {cite.kind === "web" ? <Globe size={12} /> : <FileText size={12} />}
                {cite.title ?? cite.doc_type}
                {cite.page != null ? ` p.${cite.page}` : ""}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FamilyCardView({ card }: { card: FamilyCard }) {
  const extra = card.member_count - card.members.length;
  const subhead = [card.brand, card.category].filter(Boolean).join(" · ");
  return (
    <div className="thom-card thom-family-card">
      {card.image_url && (
        <img className="thom-card-img" src={card.image_url} alt={card.family} loading="lazy" />
      )}
      <div className="thom-card-body">
        <div className="thom-card-head">
          <strong>
            <Boxes size={14} /> {card.family}
          </strong>
          <span className="muted">
            System{subhead ? ` · ${subhead}` : ""} · {card.member_count} component
            {card.member_count === 1 ? "" : "s"}
          </span>
        </div>
        <div className="thom-family-members">
          {card.members.map((m) => {
            const label = (
              <>
                <strong>{m.sku}</strong>
                {m.name ? ` · ${m.name}` : ""}
                {m.role ? <span className="muted"> · {m.role}</span> : null}
              </>
            );
            return m.pdp_url ? (
              <a
                key={m.sku}
                className="thom-family-member"
                href={m.pdp_url}
                target="_blank"
                rel="noreferrer"
              >
                {label}
              </a>
            ) : (
              <span key={m.sku} className="thom-family-member">
                {label}
              </span>
            );
          })}
          {extra > 0 && <span className="thom-family-more muted">+{extra} more</span>}
        </div>
      </div>
    </div>
  );
}

function LayoutCardView({ card }: { card: LayoutCard }) {
  const { summary: s, plan, space } = card;
  const title = card.product.name ?? card.product.sku ?? card.product.family ?? "Layout";
  const kindLabel =
    card.layoutKind === "track" ? "Track layout" : card.layoutKind === "linear" ? "Linear layout" : "Grid layout";

  // Summary chips — only show the ones that apply to this layout kind.
  const chips: { label: string; value: string }[] = [];
  if (s.headCount > 0) chips.push({ label: "Heads", value: String(s.headCount) });
  if (s.runs != null && s.headsPerRun != null)
    chips.push({ label: "Layout", value: `${s.runs} run × ${s.headsPerRun}` });
  if (s.headSpacingFt != null) chips.push({ label: "Spacing", value: `${s.headSpacingFt.toFixed(1)} ft` });
  if (s.totalTrackFt != null && s.totalTrackFt > 0)
    chips.push({ label: "Track", value: `${s.totalTrackFt.toFixed(0)} ft` });
  if (s.avgFc > 0) chips.push({ label: "Avg", value: `${s.avgFc.toFixed(1)} fc` });
  if (s.uniformity > 0) chips.push({ label: "Avg:min", value: s.uniformity.toFixed(2) });
  if (s.totalWatts > 0) chips.push({ label: "Watts", value: `${s.totalWatts.toFixed(0)} W` });
  if (s.circuits != null) chips.push({ label: "Circuits", value: String(s.circuits) });
  if (s.transformerCount != null && s.transformerCount > 0)
    chips.push({ label: "Transformers", value: String(s.transformerCount) });

  // Group BOM lines by role for the table.
  const groups = new Map<string, LayoutCard["bom"]["lines"]>();
  for (const l of card.bom.lines) {
    const g = groups.get(l.role) ?? [];
    g.push(l);
    groups.set(l.role, g);
  }

  return (
    <div className="thom-card thom-layout-card">
      <div className="thom-card-body">
        <div className="thom-card-head">
          <strong>
            <Boxes size={14} /> {title}
          </strong>
          <span className="muted">
            {kindLabel} · {space.lengthFt}×{space.widthFt} ft · {space.mountingHeightFt} ft mount
          </span>
        </div>

        {chips.length > 0 && (
          <div className="thom-layout-chips">
            {chips.map((c) => (
              <span key={c.label} className="thom-layout-chip">
                <span className="muted">{c.label}</span> {c.value}
              </span>
            ))}
          </div>
        )}

        {plan && <LayoutPlanSvg plan={plan} space={space} />}

        {card.bom.lines.length > 0 && (
          <table className="thom-layout-bom">
            <tbody>
              {[...groups.entries()].map(([role, lines]) => (
                <Fragment key={role}>
                  <tr className="thom-layout-bom-role">
                    <td colSpan={3}>{role}</td>
                  </tr>
                  {lines.map((l, i) => (
                    <tr key={`${role}-${i}`}>
                      <td className="thom-layout-bom-sku">{l.sku ?? "—"}</td>
                      <td>{l.description}</td>
                      <td className="thom-layout-bom-qty">{l.qty}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}

        {card.warnings.length > 0 && (
          <ul className="thom-layout-warnings">
            {card.warnings.map((w, i) => (
              <li key={i} className="muted">
                {w}
              </li>
            ))}
          </ul>
        )}
        <p className="thom-layout-note muted">Estimate — verify in AGi32 / Ventrix.</p>
      </div>
    </div>
  );
}

/** Top-down room plan drawn from normalized 0..1 coords: heatmap rects,
 *  track runs (thick lines), and head dots. Pure React SVG — no external libs,
 *  no dangerouslySetInnerHTML. */
function LayoutPlanSvg({
  plan,
  space,
}: {
  plan: NonNullable<LayoutCard["plan"]>;
  space: LayoutCard["space"];
}) {
  const W = 260;
  const aspect = space.lengthFt > 0 && space.widthFt > 0 ? space.lengthFt / space.widthFt : 1;
  const H = Math.max(120, Math.min(360, W * aspect));
  const hm = plan.heatmap;
  const span = hm ? Math.max(1e-6, hm.max - hm.min) : 1;

  return (
    <svg className="thom-layout-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Top-down layout plan">
      {/* heatmap */}
      {hm &&
        hm.values.map((row, r) =>
          row.map((v, c) => {
            const op = 0.06 + 0.5 * ((v - hm.min) / span);
            return (
              <rect
                key={`h-${r}-${c}`}
                x={(c / hm.cols) * W}
                y={(r / hm.rows) * H}
                width={W / hm.cols + 0.5}
                height={H / hm.rows + 0.5}
                fill="var(--accent)"
                opacity={op}
              />
            );
          }),
        )}
      {/* room outline */}
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} fill="none" stroke="var(--border)" strokeWidth={1} />
      {/* track runs */}
      {plan.runs.map((run, i) => (
        <line
          key={`run-${i}`}
          x1={run.x1 * W}
          y1={run.y1 * H}
          x2={run.x2 * W}
          y2={run.y2 * H}
          stroke="var(--text)"
          strokeWidth={2.5}
          strokeLinecap="round"
          opacity={0.5}
        />
      ))}
      {/* heads */}
      {plan.heads.map((h, i) => (
        <circle key={`d-${i}`} cx={h.x * W} cy={h.y * H} r={3.2} fill="var(--accent)" />
      ))}
    </svg>
  );
}

function CardView({ card }: { card: ProductCard }) {
  return (
    <div className="thom-card">
      {card.image_url && <img className="thom-card-img" src={card.image_url} alt={card.name ?? card.sku} loading="lazy" />}
      <div className="thom-card-body">
        <div className="thom-card-head">
          <strong>{card.name ?? card.sku}</strong>
          <span className="muted">
            {card.sku}
            {card.brand ? ` · ${card.brand}` : ""}
          </span>
        </div>
        {card.key_specs.length > 0 && (
          <ul className="thom-specs">
            {card.key_specs.map((s) => (
              <li key={s.label}>
                <span className="muted">{s.label}</span> {s.value}
              </li>
            ))}
          </ul>
        )}
        <div className="thom-card-links">
          {card.pdp_url && (
            <a className="thom-chip" href={card.pdp_url} target="_blank" rel="noreferrer">
              <ExternalLink size={12} /> View product
            </a>
          )}
          {card.downloads.map((d) => (
            <a key={d.url} className="thom-chip" href={d.url} target="_blank" rel="noreferrer">
              <FileText size={12} /> {d.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
