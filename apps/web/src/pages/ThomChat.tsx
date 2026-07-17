import { useEffect, useRef, useState } from "react";
import { Bot, Boxes, ExternalLink, FileText, Globe, Loader2, Plus, Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  sendChat,
  type Card,
  type Citation,
  type FamilyCard,
  type ProductCard,
  type ChatResponse,
} from "../lib/thom.js";
import type { ApiError } from "../lib/api.js";

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

export function ThomChat() {
  const persisted = loadPersisted();
  const [turns, setTurns] = useState<Turn[]>(persisted?.turns ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    persisted?.conversationId ?? null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

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
    setTurns([]);
    setConversationId(null);
    setInput("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setTurns((t) => [...t, { role: "user", text: message }]);
    setBusy(true);
    try {
      const res: ChatResponse = await sendChat(message, conversationId);
      setConversationId(res.conversationId);
      setTurns((t) => [
        ...t,
        { role: "assistant", text: res.answer, cards: res.cards, citations: res.citations },
      ]);
    } catch (e) {
      const err = e as ApiError;
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          text:
            err?.status === 503
              ? "Thom isn't configured yet (no API key)."
              : `Sorry — something went wrong (${err?.error ?? "unknown error"}).`,
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <div className="thom">
      <header className="thom-head">
        <div className="thom-head-row">
          <div className="thom-title">
            <Bot size={20} /> <span>Thom</span>
          </div>
          {turns.length > 0 && (
            <button className="secondary thom-new" onClick={newChat}>
              <Plus size={14} /> New chat
            </button>
          )}
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
          turns.map((turn, i) => <TurnView key={i} turn={turn} />)
        )}
        {busy && (
          <div className="thom-turn assistant">
            <div className="thom-bubble thom-thinking">
              <Loader2 size={16} className="spin" /> Thom is thinking…
            </div>
          </div>
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

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className={`thom-turn ${turn.role}`}>
      <div className={`thom-bubble${turn.error ? " thom-error" : ""}`}>
        {turn.role === "assistant" ? (
          <div className="thom-text thom-md">
            <ReactMarkdown
              components={{
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {turn.text}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="thom-text">{turn.text}</div>
        )}
        {turn.cards?.map((c, i) =>
          // Cards logged before the family feature have no `kind` — default to
          // the product view so old conversations still render.
          c.kind === "family" ? (
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
