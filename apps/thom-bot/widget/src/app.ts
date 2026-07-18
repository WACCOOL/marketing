/**
 * The public Thom chat widget controller (framework-free).
 *
 * Wires together: the start-of-chat warning banner, the streaming transcript
 * (markdown prose + product/family/layout cards + citation chips), the composer,
 * Turnstile → session-token minting, and session-only localStorage history. It
 * talks exclusively to same-origin /api/* (served by the same Worker), so there
 * is no CORS and no auth beyond the Turnstile-minted session token.
 */
import { el } from "./dom.js";
import { renderCard, renderCitations } from "./cards.js";
import { renderMarkdown } from "./markdown.js";
import { chatStream } from "./stream.js";
import { fetchConfig } from "./config.js";
import { renderChallenge, mintSession } from "./turnstile.js";
import {
  clearHistory,
  getSessionId,
  loadHistory,
  saveHistory,
  toRequestHistory,
} from "./session.js";
import type { Card, Citation, Turn } from "./types.js";

/** EXACT required disclaimer copy. Do not edit without product sign-off. */
export const WARNING_COPY =
  "Thom is an AI assistant and can make mistakes. Answers, including specs, " +
  "compatibility, and availability, aren't guaranteed. Please confirm anything " +
  "important with WAC Group or your sales rep before you rely on it.";

const EXAMPLES = [
  "What's the lumen output and CRI of SKU 2095?",
  "I need a warm-dim 3-inch downlight for a damp bathroom.",
  "What's the cutout size for the Aurora trimless downlight?",
];

/** Post a message up to the host page (embed.js listens). */
function postToParent(msg: Record<string, unknown>): void {
  try {
    window.parent?.postMessage({ source: "thom-widget", ...msg }, "*");
  } catch {
    /* not embedded / blocked — ignore */
  }
}

export class ThomWidget {
  private root: HTMLElement;
  private siteKey: string;
  private sessionId: string;
  private turnstileSiteKey = "";
  private sessionToken: string | null = null;
  private turns: Turn[] = [];
  private busy = false;
  private abort: AbortController | null = null;

  private listEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private challengeEl!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.siteKey = new URLSearchParams(location.search).get("site_key") ?? "";
    this.sessionId = getSessionId(this.siteKey);
    this.turns = loadHistory(this.siteKey, this.sessionId);
  }

  async mount(): Promise<void> {
    this.buildChrome();
    this.renderTurns();
    postToParent({ type: "thom:ready" });
    const cfg = await fetchConfig();
    this.turnstileSiteKey = cfg.turnstileSiteKey;
    // Warm a session up front so the first send is instant (best-effort).
    if (this.turnstileSiteKey) void this.ensureSession().catch(() => {});
  }

  // --- chrome ---------------------------------------------------------------

  private buildChrome(): void {
    const header = el("header", { class: "thom-head" }, [
      el("div", { class: "thom-brand" }, [
        el("span", { class: "thom-logo", "aria-hidden": "true", text: "◆" }),
        el("div", {}, [
          el("strong", { text: "Thom" }),
          el("span", { class: "thom-muted thom-brand-sub", text: "WAC Group lighting assistant" }),
        ]),
      ]),
      el("div", { class: "thom-head-actions" }, [
        this.button("New chat", "thom-btn-ghost", () => this.newChat()),
        this.iconButton("✕", "Close chat", () => postToParent({ type: "thom:close" })),
      ]),
    ]);

    this.listEl = el("div", { class: "thom-scroll", role: "log", "aria-live": "polite" });

    this.inputEl = el("textarea", {
      class: "thom-input",
      rows: 1,
      placeholder: "Ask about a product, spec, or recommendation…",
      "aria-label": "Message Thom",
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send(this.inputEl.value);
      }
    });
    this.sendEl = this.button("Send", "thom-btn-primary thom-send", () => void this.send(this.inputEl.value));
    this.sendEl.setAttribute("aria-label", "Send message");

    const composer = el("div", { class: "thom-composer" }, [this.inputEl, this.sendEl]);

    this.challengeEl = el("div", { class: "thom-challenge", hidden: true });

    this.root.replaceChildren(el("div", { class: "thom-widget" }, [header, this.listEl, this.challengeEl, composer]));
  }

  private button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", { class: `thom-btn ${cls}`, type: "button", text: label });
    b.addEventListener("click", onClick);
    return b;
  }

  private iconButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", { class: "thom-btn thom-btn-icon", type: "button", "aria-label": label, title: label, text: glyph });
    b.addEventListener("click", onClick);
    return b;
  }

  // --- rendering ------------------------------------------------------------

  private warningBanner(): HTMLElement {
    return el("div", { class: "thom-warning", role: "note" }, [WARNING_COPY]);
  }

  private renderTurns(): void {
    const nodes: (Node | null)[] = [this.warningBanner()];
    if (this.turns.length === 0) {
      nodes.push(
        el("div", { class: "thom-empty" }, [
          el("h2", { text: "Ask Thom anything about WAC Group products" }),
          el("p", { class: "thom-muted", text: "Specs, spec sheets, install manuals, lighting design, or a competitor match." }),
          el(
            "div",
            { class: "thom-examples" },
            EXAMPLES.map((ex) => {
              const b = el("button", { class: "thom-example", type: "button", text: ex });
              b.addEventListener("click", () => void this.send(ex));
              return b;
            }),
          ),
        ]),
      );
    } else {
      for (let i = 0; i < this.turns.length; i++) {
        const turn = this.turns[i];
        if (!turn) continue;
        const streaming = this.busy && i === this.turns.length - 1 && turn.role === "assistant";
        nodes.push(this.turnView(turn, streaming));
      }
    }
    this.listEl.replaceChildren(...nodes.filter(Boolean) as Node[]);
    this.scrollToBottom();
  }

  private turnView(turn: Turn, streaming: boolean): HTMLElement {
    if (turn.role === "assistant" && streaming && !turn.text) {
      return el("div", { class: "thom-turn assistant" }, [
        el("div", { class: "thom-bubble thom-thinking", text: "Thom is thinking…" }),
      ]);
    }
    const bubble = el("div", { class: `thom-bubble${turn.error ? " thom-error" : ""}` });
    if (turn.role === "assistant") {
      const md = el("div", { class: "thom-text thom-md" });
      md.innerHTML = renderMarkdown(turn.text); // pre-sanitized in markdown.ts
      bubble.appendChild(md);
    } else {
      bubble.appendChild(el("div", { class: "thom-text", text: turn.text }));
    }
    if (turn.cards) for (const c of turn.cards) bubble.appendChild(renderCard(c));
    if (turn.citations && turn.citations.length) bubble.appendChild(renderCitations(turn.citations));
    return el("div", { class: `thom-turn ${turn.role}` }, [bubble]);
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => this.listEl.scrollTo({ top: this.listEl.scrollHeight, behavior: "smooth" }));
  }

  // --- session / turnstile --------------------------------------------------

  /** Ensure we hold a valid session token, minting one via Turnstile if needed. */
  private async ensureSession(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    if (!this.turnstileSiteKey) throw new Error("Thom isn't configured yet.");
    this.challengeEl.hidden = false;
    try {
      const token = await renderChallenge(this.challengeEl, this.turnstileSiteKey);
      const session = await mintSession(token, this.turnstileSiteKey);
      this.sessionToken = session;
      return session;
    } finally {
      this.challengeEl.hidden = true;
    }
  }

  // --- actions --------------------------------------------------------------

  private persist(): void {
    saveHistory(this.siteKey, this.sessionId, this.turns);
  }

  newChat(): void {
    this.abort?.abort();
    this.abort = null;
    this.busy = false;
    this.turns = [];
    clearHistory(this.siteKey, this.sessionId);
    this.inputEl.value = "";
    this.renderTurns();
  }

  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.busy) return;
    this.inputEl.value = "";
    this.busy = true;
    this.setComposerEnabled(false);

    // Bounded history from PRIOR turns (before we push the new pair).
    const history = toRequestHistory(this.turns);
    this.turns.push({ role: "user", text: message }, { role: "assistant", text: "" });
    this.renderTurns();

    let session: string;
    try {
      session = await this.ensureSession();
    } catch (e) {
      this.failLastAssistant(e instanceof Error ? e.message : String(e));
      return;
    }

    await this.runStream({ message, session, history }, /* allowRechallenge */ true);
  }

  private async runStream(
    req: { message: string; session: string; history: { role: "user" | "assistant"; content: string }[] },
    allowRechallenge: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    let rechallenge = false;

    await chatStream(
      req,
      {
        onDelta: (delta) => this.updateLastAssistant((t) => ({ ...t, text: t.text + delta })),
        onCards: (cards: Card[]) => this.updateLastAssistant((t) => ({ ...t, cards })),
        onCitations: (citations: Citation[]) => this.updateLastAssistant((t) => ({ ...t, citations })),
        onDone: () => {
          this.busy = false;
          this.abort = null;
          this.setComposerEnabled(true);
          this.persist();
        },
        onError: (err) => {
          // Expired / invalid session → drop it and re-challenge once.
          if (err.status === 401 && allowRechallenge) {
            rechallenge = true;
            return;
          }
          this.failLastAssistant(this.errorText(err));
        },
      },
      controller.signal,
    );

    if (rechallenge) {
      this.sessionToken = null;
      try {
        const session = await this.ensureSession();
        await this.runStream({ ...req, session }, /* allowRechallenge */ false);
      } catch (e) {
        this.failLastAssistant(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // Stream ended without done/error (dropped) — clear busy defensively.
    if (this.busy) {
      this.busy = false;
      this.abort = null;
      this.setComposerEnabled(true);
      this.persist();
    }
  }

  private errorText(err: { status?: number; error: string }): string {
    if (err.status === 503) return "Thom isn't available right now. Please try again later.";
    if (err.status === 429) return err.error || "You've hit the usage limit for now. Please try again in a bit.";
    if (err.status === 403) return "This chat isn't available on this site.";
    return `Sorry, something went wrong (${err.error || "unknown error"}).`;
  }

  private updateLastAssistant(fn: (t: Turn) => Turn): void {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t && t.role === "assistant") {
        this.turns[i] = fn(t);
        break;
      }
    }
    this.renderTurns();
  }

  private failLastAssistant(text: string): void {
    this.updateLastAssistant(() => ({ role: "assistant", text, error: true }));
    this.busy = false;
    this.abort = null;
    this.setComposerEnabled(true);
    this.persist();
  }

  private setComposerEnabled(on: boolean): void {
    this.inputEl.disabled = !on;
    this.sendEl.disabled = !on;
    if (on) this.inputEl.focus();
  }
}
